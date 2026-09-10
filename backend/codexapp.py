"""코덱스 **app-server** 드라이버 — 대화 내내 사는 프로세스 하나에 말을 건다.

★왜 `codex exec` 를 버렸나 (사용자 결정 2026-08-15): `exec` 는 stdin 을 **EOF 까지 모아**
  한 프롬프트로 쓴다. 그래서 **도는 도중에 끼어들 수가 없다** — 둘째 줄을 보내면 첫 줄과
  합쳐져 한 턴이 된다 (실측). 조정·중단은 `exec` 가 아니라 이쪽 프로토콜에 있다.

★**코덱스 데스크톱 앱이 쓰는 통로가 바로 이것이다** (실측 2026-08-15, 그 앱의 명령줄):

      codex.exe -c features.code_mode_host=true app-server --analytics-default-enabled

  CLI 도움말은 `[experimental]` 이라 적어 두지만, OpenAI 자기네 출시 제품이 쓰는 방식이다.

우리가 쓰는 요청은 다섯뿐이다 (전부 실측으로 확인, v0.147.0):

    initialize      손 맞추기. 구독 인증은 그대로 붙는다 (`account/read` 로 확인)
    thread/start    대화 하나 열기 — 여기서 MCP·모래상자·셸을 정한다
    thread/resume   앱을 껐다 켠 뒤 이어 붙이기
    turn/start      한 턴 시작
    turn/steer      ★**도는 도중에 끼어들기** (같은 턴 안에서 처리된다)
    turn/interrupt  ★그 턴만 멈추기 — 프로세스를 안 죽이므로 대화가 살아남는다

흘러나오는 알림은 `item/started`·`item/completed` 가 본체다. 항목 종류(실측):

    userMessage · reasoning · agentMessage(phase: commentary|final_answer)
    mcpToolCall(server·tool·arguments·result·status) · commandExecution

★모양을 여기서 옮겨 적지 않는다 — 그대로 화면에 넘기고 `src/lib/codexStream.ts` 가
  wire 조각으로 바꾼다 (`cliagent.Runner` 와 같은 역할 분담).
"""
from __future__ import annotations

import asyncio
import contextlib
import json
import os
import threading
import sys
from pathlib import Path
from typing import Any, Callable

import cliagent


def thread_config(backend: str, open: bool = True) -> dict:
    """`thread/start` 에 실어 보내는 설정 — **여기 하나뿐이다.**

    ★`default_tools_approval_mode="approve"` 가 없으면 **도구가 조용히 안 돈다.**
      물어볼 사람이 없어 코덱스가 스스로 취소한다 (`exec` 쪽에서 밟은 것과 같다).
    ★★`open` — **앱 밖 도구를 허용한다** (사용자 결정 2026-09-07, 기본 켬). 켜면 셸을 열고
      모래상자를 푼다 (`danger-full-access`). 클로드 코드의 `bypassPermissions` 와 같은 급이다.
    ★끄면 예전 잠금이다 (사용자 결정 2026-08-15): 셸을 끄고(`features.shell_tool=false` 가
      먹는 것을 실측했다 — 끄기 전에는 시키지도 않은 PowerShell 을 돌렸다) 모래상자는 읽기 전용."""
    spec = cliagent.mcp_spec(backend)
    return {
        "sandbox_mode": "danger-full-access" if open else "read-only",
        "approval_policy": "never",
        "features": {"shell_tool": bool(open)},
        "mcp_servers": {
            "peropix": {
                "command": spec["command"],
                "args": spec["args"],
                "env": spec["env"],
                "default_tools_approval_mode": "approve",
                # 파이썬이 뜨고 백엔드에 도구 목록을 물어 오는 데 걸리는 시간
                "startup_timeout_sec": 30,
            }
        },
    }


class Rpc:
    """app-server 와 주고받는 JSON-RPC 한 벌.

    ★프로세스는 **자기 스레드에서 자기 루프**로 돈다 (`cliagent.Runner` 머리 주석과 같은
      까닭 — uvicorn 이 `--reload` 로 뜨면 윈도우에서 SelectorEventLoop 라 자식을 못 띄운다).
      바깥과는 큐 하나로만 오간다."""

    def __init__(self, exe: str, cwd: Path, on_note: Callable[[dict], None]):
        self.exe = exe
        self.cwd = cwd
        self.on_note = on_note
        self.proc: asyncio.subprocess.Process | None = None
        self._loop: asyncio.AbstractEventLoop | None = None
        self._id = 0
        self._waiting: dict[int, asyncio.Future] = {}
        self._ready = asyncio.Event()
        #: 저쪽 루프가 섰다 (스레드 사이에서 쓰므로 asyncio 가 아니라 threading 것)
        self._loop_up = threading.Event()

    @property
    def alive(self) -> bool:
        return self.proc is not None and self.proc.returncode is None

    # ── 자기 스레드 ──
    def _thread(self) -> None:
        loop = asyncio.ProactorEventLoop() if os.name == "nt" else asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        self._loop = loop
        self._loop_up.set()
        try:
            loop.run_until_complete(self._serve())
        finally:
            asyncio.set_event_loop(None)
            loop.close()
            self._loop = None
            self._loop_up.clear()

    async def _serve(self) -> None:
        self.proc = await asyncio.create_subprocess_exec(
            self.exe, "app-server",
            cwd=str(self.cwd),
            env={**os.environ, "MCP_TIMEOUT": "1800000"},
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        self._ready.set()
        assert self.proc.stdout is not None

        async def eat_err():
            assert self.proc is not None and self.proc.stderr is not None
            async for line in self.proc.stderr:
                t = line.decode("utf-8", "replace").rstrip()
                if t:
                    self.on_note({"type": "stderr", "text": t})

        err = asyncio.create_task(eat_err())
        async for raw in self.proc.stdout:
            line = raw.decode("utf-8", "replace").strip()
            if not line.startswith("{"):
                continue
            try:
                msg = json.loads(line)
            except Exception:
                continue
            mid = msg.get("id")
            if mid is not None and ("result" in msg or "error" in msg):
                fut = self._waiting.pop(mid, None)
                if fut and not fut.done():
                    fut.set_result(msg)
            else:
                # 서버가 먼저 거는 말 (알림 · 우리에게 묻는 요청)
                self.on_note(msg)
        await self.proc.wait()
        err.cancel()
        # ★기다리던 요청을 매달아 두지 않는다 — 프로세스가 죽으면 다 깨운다
        for fut in list(self._waiting.values()):
            if not fut.done():
                fut.set_result({"error": {"message": "app-server 가 끝났습니다"}})
        self._waiting.clear()
        self.on_note({"type": "gone", "code": self.proc.returncode})

    async def start(self) -> None:
        if self.alive:
            return
        self._ready = asyncio.Event()
        self._loop_up.clear()
        await asyncio.to_thread(self._boot)
        await asyncio.wait_for(self._ready.wait(), 30)

    def _boot(self) -> None:
        # ★**돌면서 기다리지 않는다.** 예전엔 `while self._loop is None: pass` 였는데
        #   그동안 CPU 를 한 코어 태운다 (스레드풀 일꾼 하나가 100%로 돈다).
        t = threading.Thread(target=self._thread, daemon=True, name="codex-app-server")
        t.start()
        self._loop_up.wait(30)

    async def call(self, method: str, params: dict | None = None, timeout: float = 120) -> dict:
        """요청 하나. ★**저쪽 루프에 넘겨** 보낸다 — 우리 루프와 다르다."""
        if not self.alive or self._loop is None:
            raise RuntimeError("app-server 가 떠 있지 않습니다")
        self._id += 1
        mid = self._id
        fut: asyncio.Future = self._loop.create_future()
        self._waiting[mid] = fut
        body = json.dumps({"jsonrpc": "2.0", "id": mid, "method": method,
                           "params": params or {}}, ensure_ascii=False) + "\n"

        def write():
            assert self.proc is not None and self.proc.stdin is not None
            self.proc.stdin.write(body.encode("utf-8"))

        self._loop.call_soon_threadsafe(write)
        try:
            msg = await asyncio.wait_for(asyncio.wrap_future(
                asyncio.run_coroutine_threadsafe(_wait(fut), self._loop)), timeout)
        except asyncio.TimeoutError:
            # ★매달아 둔 것을 **걷는다** — 안 걷으면 저쪽 루프에서 영영 기다린다
            self._waiting.pop(mid, None)
            self._loop.call_soon_threadsafe(lambda: fut.cancel() if not fut.done() else None)
            raise
        if "error" in msg:
            raise RuntimeError(str(msg["error"]))
        return msg.get("result") or {}

    async def stop(self) -> None:
        p = self.proc
        if p and p.returncode is None:
            with contextlib.suppress(Exception):
                p.terminate()


async def _wait(fut: asyncio.Future) -> dict:
    return await fut
