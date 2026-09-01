"""PeroPix 도구를 MCP 로 내보내는 **얇은 중계** (stdio 트랜스포트).

클로드 코드 같은 에이전트 CLI 가 이 스크립트를 자식 프로세스로 띄우고 JSON-RPC 로 말한다.
여기서는 아무것도 판단하지 않는다 — 전부 백엔드(`/api/agent/*`)로 넘기고, 백엔드가
기존 WebSocket 으로 화면에 넘긴다 (`agent.py` 머리 주석).

    claude -p --mcp-config <설정> --allowedTools "mcp__peropix__*"

★**stdout 은 프로토콜 전용**이다. 로그는 반드시 stderr 로 — 한 줄이라도 섞이면 연결이 깨진다.
★HTTP 트랜스포트가 아니라 stdio 를 고른 이유: 규격 표면이 작아 조용히 틀릴 자리가 적고,
  클로드 코드가 stdio 서버에 주는 유휴 한계가 더 길다(30분 대 5분) — 사람 확인을 기다리는
  도구가 있으므로 그 편이 맞다.
"""
from __future__ import annotations

import json
import os
import pathlib
import sys
import urllib.error
import urllib.request

# ★★파이프는 **UTF-8 이 아니다.** 윈도우에서 stdout 을 리다이렉트하면 파이썬이 로캘 코드
#   페이지(여기서는 cp949)를 쓰는데, 도구 설명에 든 작대기(U+2014) 하나가 거기 없어서
#   `tools/list` 응답이 통째로 못 나갔다. 에이전트에게는 **도구가 0개**로 보인다.
#   실측 2026-08-15: `'cp949' codec can't encode character '—'` → 코덱스가 곧바로
#   "그 도구는 이 세션에 없다"고 답했다. 글자 하나를 고치는 것으로 때우지 말 것 —
#   설명은 계속 바뀌므로 **트랜스포트를 UTF-8 로 못 박는다.**
for _s in (sys.stdin, sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

def _from_app() -> str:
    """앱이 남긴 **지금 주소**를 읽는다 (`data/mcp-endpoint.json`).

    ★★**포트를 설정에 적어 두면 안 된다** (사용자 지적 2026-08-31). 8770 이 차 있으면 앱은
      빈 번호로 밀려서 뜬다 — 실측으로 설치본이 8770 을 쥔 채 개발판이 51676 으로 떴다.
      그래서 바깥 도구의 설정에는 **안 바뀌는 것**(이 스크립트의 경로)만 두고, 주소는 켤 때마다
      앱이 다시 쓰는 이 파일에서 읽는다.
    ★**내 앱의 파일**을 찾는다 — 이 스크립트가 그 앱 폴더 안에 있으므로 위로 올라가며 본다
      (배포판은 `<뿌리>/app/backend/`, 저장소는 `<뿌리>/backend/`). 여러 벌을 깔아 두어도
      각자 제 것을 읽는다.
    ★못 찾으면 빈 문자열 — 부르는 쪽이 예전 기본값(8770)으로 간다."""
    here = pathlib.Path(__file__).resolve().parent
    for d in (here.parent, here.parent.parent, here.parent.parent.parent):
        f = d / "data" / "mcp-endpoint.json"
        try:
            if f.is_file():
                d_ = json.loads(f.read_text(encoding="utf-8"))
                port, key = int(d_.get("port") or 0), str(d_.get("key") or "")
                if port:
                    return f"http://127.0.0.1:{port}" + (f"/k/{key}" if key else "")
        except Exception as e:
            log("[peropix-mcp] 주소 파일을 못 읽었습니다:", f, e)
    return ""


#: ★환경변수가 있으면 그쪽이 먼저다 — 다른 기계에 붙이거나 시험할 때 쓰는 문
BASE = os.environ.get("PEROPIX_BACKEND") or _from_app() or "http://127.0.0.1:8770"
NAME = "peropix"
VERSION = "3.0.0-dev"
# 클라이언트가 요구한 판을 그대로 돌려준다 (규격: 지원하면 같은 값으로 답한다).
# 안 오면 이 값을 쓴다.
FALLBACK_PROTOCOL = "2025-06-18"


def log(*a) -> None:
    print(*a, file=sys.stderr, flush=True)


def _req(path: str, body: dict | None = None) -> dict:
    # ★★**부를 때마다 다시 본다** — 이 프로세스는 에이전트가 띄워 놓고 오래 산다. 그 사이
    #   앱을 껐다 켜면 포트가 바뀌므로, 시작할 때 한 번 읽은 주소를 붙들면 그때부터 못 붙는다.
    #   ★환경변수로 못 박은 경우에는 그대로 쓴다 (사람이 정한 것을 덮지 않는다).
    global BASE
    if not os.environ.get("PEROPIX_BACKEND"):
        BASE = _from_app() or BASE
    url = BASE + path
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(
        url, data=data, headers={"Content-Type": "application/json"} if data else {}
    )
    # ★`ask_user` 는 사람이 답할 때까지 기다린다 — 여기서 먼저 끊기면 안 된다
    with urllib.request.urlopen(req, timeout=1800) as r:
        return json.loads(r.read().decode("utf-8"))


def send(msg: dict) -> None:
    sys.stdout.write(json.dumps(msg, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def reply(mid, result: dict) -> None:
    send({"jsonrpc": "2.0", "id": mid, "result": result})


def fail(mid, code: int, message: str) -> None:
    send({"jsonrpc": "2.0", "id": mid, "error": {"code": code, "message": message}})


def _down(e: Exception) -> str:
    """앱이 안 떠 있을 때가 대부분이다 — **그렇게 말해 준다.**

    ★읽는 것은 사람이 아니라 에이전트다. 원문 오류(`WinError 10061`)만 주면 무엇을 하라는
      말인지 알 수 없어 엉뚱한 것을 고치려 든다. 영어로 적는 것도 같은 까닭이다."""
    if isinstance(e, (urllib.error.URLError, OSError)):
        return (f"PeroPix is not running (tried {BASE.split('/k/')[0]}). "
                f"Ask the user to start the PeroPix app, then retry. [{e}]")
    return f"PeroPix request failed: {e}"


def _system_prompt() -> str:
    """내부 조수가 받는 그 지침 (`/api/agent/system`)."""
    try:
        return _req("/api/agent/system?lang=ko")["system"]
    except Exception as e:
        log("[peropix-mcp] 지침을 못 받았습니다:", e)
        return "PeroPix 3.0 의 화면을 직접 만지는 도구들입니다. 고치기 전에 get_workspace 로 지금 상태를 확인하세요."


def handle(msg: dict) -> None:
    method = msg.get("method")
    mid = msg.get("id")

    # ★알림(id 없음)에는 **응답하지 않는다**
    if mid is None:
        return

    if method == "initialize":
        want = (msg.get("params") or {}).get("protocolVersion") or FALLBACK_PROTOCOL
        reply(
            mid,
            {
                "protocolVersion": want,
                "capabilities": {"tools": {}},
                "serverInfo": {"name": NAME, "version": VERSION},
                # ★★**지침도 같은 창구에서 받는다** (사용자 지시 2026-08-31: *"별도 구현이
                #   아니라 같은 창구를 쓰는 게 제일 깔끔"*). 도구는 이미 `/api/agent/tools` 로
                #   내부 조수와 한 벌인데 지침만 여기 두 줄로 따로 적혀 있었다 — 그래서 바깥
                #   에이전트는 앱의 규약(캐릭터 칸에는 인물만·base 는 그림체…)을 모른 채 움직였다.
                # ★못 받으면 앱이 아직 안 떴다는 뜻이다 — 짧은 안내로 대신하고 연결은 살린다.
                "instructions": _system_prompt(),
            },
        )
        return

    if method == "ping":
        reply(mid, {})
        return

    if method == "tools/list":
        try:
            reply(mid, {"tools": _req("/api/agent/tools")["tools"]})
        except Exception as e:
            fail(mid, -32603, _down(e))
        return

    if method == "tools/call":
        p = msg.get("params") or {}
        try:
            out = _req("/api/agent/call", {"name": p.get("name"), "input": p.get("arguments") or {}})
        except Exception as e:
            out = {"error": _down(e)}
        bad = bool(out.get("error") or out.get("cancelled"))
        # ★★**그림은 `image` 콘텐츠로 싣는다** (2026-08-24). 예전에는 결과를 통째로 `text`
        #   로 쌌는데, 그러면 `read_image` 의 base64 가 **글자 뭉치**로 들어가 모델이 못 본다.
        #   ★본문에서는 뺀다 — 같은 바이트를 두 번 실으면 컨텍스트가 두 배로 찬다.
        imgs = out.pop("images", None) if isinstance(out, dict) else None
        content: list[dict] = [{"type": "text", "text": json.dumps(out, ensure_ascii=False)}]
        for im in imgs or []:
            content.append({"type": "image", "data": im.get("b64", ""),
                            "mimeType": im.get("mime", "image/webp")})
        reply(mid, {"content": content, "isError": bad})
        return

    fail(mid, -32601, f"Unknown method: {method}")


def main() -> None:
    log(f"[peropix-mcp] 백엔드 {BASE}")
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except Exception as e:
            log("[peropix-mcp] 못 읽은 줄:", e)
            continue
        try:
            handle(msg)
        except Exception as e:  # 여기서 죽으면 연결이 통째로 끊긴다
            log("[peropix-mcp] 처리 실패:", e)
            if msg.get("id") is not None:
                fail(msg["id"], -32603, str(e))


if __name__ == "__main__":
    main()
