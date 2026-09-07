"""조수 한 명 = **대화 내내 사는 세션 하나** — 어느 CLI 든 바깥에서는 같게 보인다.

    start_turn(글)   놀고 있으면 한 턴 시작
    steer(글)        ★도는 **도중에** 끼어들기 — 되면 True
    interrupt()      ★그 턴만 멈춘다 (프로세스는 살려 둔다)

★왜 세션인가 (사용자 결정 2026-08-15): 예전에는 **턴마다 프로세스를 새로 띄웠다.** 그래서
  도중에 끼어들 수도 없고, 「중단」이 프로세스를 죽여 대화가 통째로 끊겼다. 두 CLI 다
  오래 사는 방식을 지원하는 것을 실측으로 확인하고 옮겼다:

    코덱스     `codex app-server` (JSON-RPC) — `turn/steer` · `turn/interrupt`
    클로드 코드 `--input-format stream-json` — 도는 도중에 넣은 줄이 그 턴에 반영됐다
               (실측: 14.0초에 넣고 17.1초에 반응, `result` 는 한 번)

★흘러나오는 것을 여기서 옮겨 적지 않는다 — 그대로 화면에 넘기고 `src/lib/codexStream.ts`·
  `llm.ts` 가 wire 조각으로 바꾼다 (`cliagent` 와 같은 역할 분담).

★**턴의 끝은 언제나 `turn_end`** 다. CLI 마다 알리는 방식이 다르지만(코덱스는
  `turn/completed`, 클로드는 `result`) 화면이 볼 것은 하나여야 한다.
"""
from __future__ import annotations

import asyncio
import contextlib
import json
import os
from pathlib import Path
from typing import Any, Awaitable, Callable

import cliagent
import codexapp

Emit = Callable[[dict], Awaitable[None]]


class Session:
    """CLI 한 명. ★한 번에 하나만 산다 (화면이 하나라 둘이 앱을 만지면 뒤엉킨다)."""

    kind = ""

    def __init__(self, exe: str, cwd: Path, backend: str, emit: Emit):
        self.exe = exe
        self.cwd = cwd
        self.backend = backend
        self.emit = emit
        #: 어느 대화의 조수인가 (화면의 대화 id). ★**세션은 대화 단위다** —
        #  이것 없이 "이어붙임 번호가 비었으면 아무거나"로 고르면, 「새 대화」를 눌러도
        #  앞 대화의 세션을 그대로 물려받아 **옛 이야기가 이어진다.**
        self.chat = ""
        #: 저쪽이 들고 있는 대화 번호 — 화면이 대화 파일에 함께 저장한다
        self.session_id = ""
        self.busy = False
        #: ★★앱 밖 도구(파일·셸·웹)를 허용하나 — 설정에서 오고 `_ensure` 가 깃발로 옮긴다
        #  (사용자 결정 2026-09-07, 기본 켬). 세션이 이미 떠 있으면 다음 세션부터 먹는다.
        self.open = True
        #: ★우리가 일부러 닫는 중인가 — 그때의 죽음은 **사고가 아니다**.
        #  안 가리면 CLI 를 바꾸거나 다른 대화로 옮길 때 화면에 까닭 없는 오류가 번쩍인다
        #  (실측 2026-08-15: 코덱스 → 클로드로 바꾸는 순간 `exit` 이 화면으로 갔다).
        self.closing = False

    async def close(self) -> None: ...

    async def start_turn(self, prompt: str, system: str) -> None: ...

    async def steer(self, text: str) -> bool:
        """도는 도중에 끼워 넣는다. 못 하면 False (부른 쪽이 줄을 세운다)."""
        return False

    async def interrupt(self) -> None: ...


class CodexSession(Session):
    """`codex app-server` 한 벌 (`codexapp.py` 머리 주석에 프로토콜 설명)."""

    kind = "codex"

    def __init__(self, exe: str, cwd: Path, backend: str, emit: Emit):
        super().__init__(exe, cwd, backend, emit)
        self.rpc: codexapp.Rpc | None = None
        self.turn_id = ""
        self._loop = asyncio.get_running_loop()

    def _note(self, msg: dict) -> None:
        """저쪽 스레드에서 불린다 — 서버 루프로 넘겨 순서대로 내보낸다.

        ★서버가 내려가는 중이면 넘길 자리가 없다 (닫힌 루프). 조용히 흘린다."""
        with contextlib.suppress(RuntimeError):
            self._loop.call_soon_threadsafe(lambda: asyncio.ensure_future(self._forward(msg)))

    #: 화면이 쓰는 알림만 내보낸다 — **나머지는 안 보낸다.**
    #  ★그대로 흘리면 글자 조각(`item/agentMessage/delta`)이 쏟아진다: 실측 2026-08-15,
    #    답 하나에 138건. 거기에 살림 알림(`mcpServer/startupStatus/updated` 24건 등)이 더해져,
    #    끊겼을 때 되돌려 줄 버퍼(2000줄)가 **정작 필요한 줄을 밀어내고 조각으로 찬다.**
    #  ★조각을 안 쓰는 까닭: 우리는 글자 단위로 안 그린다. 완성된 항목만 줄이 된다.
    PASS = {"item/started", "item/completed", "turn/started", "turn/completed", "turn/failed"}

    async def _forward(self, msg: dict) -> None:
        method = msg.get("method")
        if method:
            if str(method) in self.PASS:
                await self.emit({"type": str(method), **(msg.get("params") or {})})
            # ★턴의 끝은 우리가 한 가지 이름으로 알린다 (클래스 머리 주석)
            if method == "turn/completed":
                self.busy = False
                self.turn_id = ""
                await self.emit({"type": "turn_end", "code": 0})
            return
        t = msg.get("type")
        if t == "stderr":
            await self.emit(msg)
        elif t == "gone":
            # 프로세스가 죽었다 — 돌던 턴이 있으면 끝을 알려 화면이 안 멈추게 한다
            self.rpc = None
            if self.closing:
                return  # 우리가 닫았다 — 화면에 알릴 일이 아니다
            if self.busy:
                self.busy = False
                await self.emit({"type": "turn_end", "code": msg.get("code") or -1})
            await self.emit({"type": "exit", "code": msg.get("code") or -1})

    async def _ensure(self, system: str) -> None:
        if self.rpc and self.rpc.alive and self.session_id:
            return
        self.rpc = codexapp.Rpc(self.exe, self.cwd, self._note)
        await self.rpc.start()
        await self.rpc.call("initialize", {"clientInfo": {
            "name": "peropix", "title": "PeroPix", "version": "3.0"}})
        cfg = codexapp.thread_config(self.backend, open=self.open)
        params: dict[str, Any] = {"cwd": str(self.cwd), "config": cfg}
        if system:
            params["developerInstructions"] = system
        if self.session_id:
            # 앱을 껐다 켠 뒤 — 그 대화를 이어 연다
            r = await self.rpc.call("thread/resume", {**params, "threadId": self.session_id})
        else:
            r = await self.rpc.call("thread/start", params)
        tid = (r.get("thread") or {}).get("id") or r.get("threadId") or ""
        if not tid:
            raise RuntimeError(f"대화를 못 열었습니다: {json.dumps(r, ensure_ascii=False)[:200]}")
        self.session_id = tid

    async def start_turn(self, prompt: str, system: str) -> None:
        await self._ensure(system)
        assert self.rpc is not None
        # ★이어붙임 번호는 **우리가 알려 준다.** 화면이 대화 파일에 함께 저장해야 앱을 껐다
        #   켜도 이어진다 (알림에서 캐내게 두면 이어 여는 경우에 안 온다)
        await self.emit({"type": "session", "id": self.session_id})
        params: dict[str, Any] = {"threadId": self.session_id,
                                  "input": [{"type": "text", "text": prompt}]}
        if self.model:
            params["model"] = self.model
        if self.effort:
            params["effort"] = self.effort
        self.busy = True
        try:
            # ★턴 번호는 **이 답**에 들어 있다 — 알림을 뒤질 일이 없다
            r = await self.rpc.call("turn/start", params, timeout=60)
        except Exception:
            self.busy = False
            raise
        self.turn_id = (r.get("turn") or {}).get("id") or ""

    async def steer(self, text: str) -> bool:
        if not (self.rpc and self.rpc.alive and self.busy and self.turn_id):
            return False
        await self.rpc.call("turn/steer", {
            "threadId": self.session_id, "expectedTurnId": self.turn_id,
            "input": [{"type": "text", "text": text}]}, timeout=60)
        return True

    async def interrupt(self) -> None:
        if self.rpc and self.rpc.alive and self.turn_id:
            with contextlib.suppress(Exception):
                await self.rpc.call("turn/interrupt",
                                    {"threadId": self.session_id, "turnId": self.turn_id},
                                    timeout=30)

    async def close(self) -> None:
        self.closing = True
        if self.rpc:
            await self.rpc.stop()
            self.rpc = None


class ClaudeSession(Session):
    """클로드 코드 — **대화 내내 사는 프로세스 하나**에 줄 단위 JSON 을 써 넣는다.

    ★`--input-format stream-json` 이 핵심이다 (실측 2026-08-15):

        사용자 말   {"type":"user","message":{"role":"user","content":[{"type":"text","text":…}]}}
        중단       {"type":"control_request","request_id":"…","request":{"subtype":"interrupt"}}

      끼어들기는 **그 턴 안에서** 처리된다 (14.0초에 넣고 17.1초에 반응, `result` 는 한 번).
      중단은 `control_response{success}` 가 오고 그 턴이 `result` 로 끝나는데,
      **프로세스는 살아 있어** 곧바로 다음 말이 통했다 (같은 세션 번호).

    ★프로세스를 띄우는 요령은 `codexapp.Rpc` 와 같다 — 자기 스레드에서 자기 루프
      (uvicorn 이 `--reload` 로 뜨면 윈도우에서 SelectorEventLoop 라 자식을 못 띄운다).
      그쪽은 JSON-RPC 짝 맞추기가 있고 여기는 없다는 것만 다르다."""

    kind = "claude-code"

    def __init__(self, exe: str, cwd: Path, backend: str, emit: Emit):
        super().__init__(exe, cwd, backend, emit)
        self.proc: asyncio.subprocess.Process | None = None
        self._loop: asyncio.AbstractEventLoop | None = None
        self._up = asyncio.Event()
        self._main = asyncio.get_running_loop()
        self._req = 0
        #: 방금 우리가 끊었나 — 그때의 `result` 는 **오류가 아니다**
        self._interrupted = False

    @property
    def alive(self) -> bool:
        return self.proc is not None and self.proc.returncode is None

    def _hand(self, ev: dict) -> None:
        # ★서버가 내려가는 중이면 넘길 자리가 없다 — 워커 스레드에서 예외를 뿜지 않게
        with contextlib.suppress(RuntimeError):
            self._main.call_soon_threadsafe(lambda: asyncio.ensure_future(self._forward(ev)))

    async def _forward(self, ev: dict) -> None:
        sid = ev.get("session_id")
        if sid and str(sid) != self.session_id:
            self.session_id = str(sid)
            # 코덱스와 **같은 이름**으로 알린다 — 화면이 한 가지만 알면 되게
            await self.emit({"type": "session", "id": self.session_id})
        t = ev.get("type")
        # ★중단으로 끝난 턴은 오류가 아니다 — 저쪽은 `is_error` 를 켜서 준다
        if t == "result" and self._interrupted:
            ev = {**ev, "is_error": False, "result": ""}
            self._interrupted = False
        if t != "control_response":  # 우리끼리 주고받은 것은 화면에 안 보낸다
            await self.emit(ev)
        if t == "result":
            self.busy = False
            await self.emit({"type": "turn_end", "code": 0})
        elif t == "gone":
            self.proc = None
            if self.closing:
                return  # 우리가 닫았다 — 화면에 알릴 일이 아니다
            if self.busy:
                self.busy = False
                await self.emit({"type": "turn_end", "code": ev.get("code") or -1})
            await self.emit({"type": "exit", "code": ev.get("code") or -1})

    def _thread(self, args: list[str]) -> None:
        loop = asyncio.ProactorEventLoop() if os.name == "nt" else asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        self._loop = loop
        try:
            loop.run_until_complete(self._serve(args))
        finally:
            asyncio.set_event_loop(None)
            loop.close()
            self._loop = None

    async def _serve(self, args: list[str]) -> None:
        self.proc = await asyncio.create_subprocess_exec(
            self.exe, *args, cwd=str(self.cwd),
            env={**os.environ, "MCP_TIMEOUT": "1800000"},
            stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE)
        self._main.call_soon_threadsafe(self._up.set)
        assert self.proc.stdout is not None

        async def eat_err():
            assert self.proc is not None and self.proc.stderr is not None
            async for line in self.proc.stderr:
                t = line.decode("utf-8", "replace").rstrip()
                if t:
                    self._hand({"type": "stderr", "text": t})

        err = asyncio.create_task(eat_err())
        async for raw in self.proc.stdout:
            line = raw.decode("utf-8", "replace").strip()
            if not line.startswith("{"):
                continue
            try:
                self._hand(json.loads(line))
            except Exception:
                continue
        await self.proc.wait()
        err.cancel()
        self._hand({"type": "gone", "code": self.proc.returncode})

    async def _ensure(self, system: str) -> None:
        if self.alive:
            return
        cfg = cliagent.mcp_config(self.cwd.parent, self.backend)
        # ★깃발은 `cliagent.argv` 가 정본이다 (도구 잠금이 거기 있다). 여기서는 **입력 방식만**
        #   덧붙인다 — 그래야 잠금 규칙이 한 곳에 남는다.
        args = cliagent.Runner().argv(cfg, system, self.session_id, self.model, self.effort, open=self.open)
        args += ["--input-format", "stream-json"]
        self._up = asyncio.Event()
        import threading

        threading.Thread(target=self._thread, args=(args,), daemon=True,
                         name="claude-code").start()
        await asyncio.wait_for(self._up.wait(), 30)

    def _write(self, text: str) -> None:
        if not (self.alive and self._loop):
            raise RuntimeError("클로드 코드가 떠 있지 않습니다")

        def go():
            assert self.proc is not None and self.proc.stdin is not None
            self.proc.stdin.write(text.encode("utf-8"))

        self._loop.call_soon_threadsafe(go)

    @staticmethod
    def _say(text: str) -> str:
        return json.dumps({"type": "user", "message": {
            "role": "user", "content": [{"type": "text", "text": text}]}},
            ensure_ascii=False) + "\n"

    async def start_turn(self, prompt: str, system: str) -> None:
        await self._ensure(system)
        self.busy = True
        if self.session_id:
            await self.emit({"type": "session", "id": self.session_id})
        try:
            self._write(self._say(prompt))
        except Exception:
            self.busy = False
            raise

    async def steer(self, text: str) -> bool:
        if not (self.alive and self.busy):
            return False
        self._write(self._say(text))
        return True

    async def interrupt(self) -> None:
        if not (self.alive and self.busy):
            return
        self._req += 1
        self._interrupted = True
        self._write(json.dumps({"type": "control_request", "request_id": f"req_{self._req}",
                                "request": {"subtype": "interrupt"}}) + "\n")

    async def close(self) -> None:
        self.closing = True
        p = self.proc
        if p and p.returncode is None:
            with contextlib.suppress(Exception):
                p.terminate()


#: 모델·강도는 두 세션이 같은 이름으로 든다 (`Session` 을 가볍게 두려고 밖에서 붙인다)
Session.model = ""  # type: ignore[attr-defined]
Session.effort = ""  # type: ignore[attr-defined]


def make(kind: str, exe: str, cwd: Path, backend: str, emit: Emit) -> Session:
    return (CodexSession if kind == "codex" else ClaudeSession)(exe, cwd, backend, emit)
