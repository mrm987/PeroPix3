"""윈도우 배포판에서 **연결 하나가 끊겼다고 서버가 손님 받기를 통째로 멈추지 않게** 한다.

★★무슨 일이 있었나 (사용자 제보 2026-11-21, v3.7.15 설치본):
  갤러리 썸네일이 전부 깨지고, 새로 읽자 「백엔드가 뜨지 않았습니다」. 백엔드 프로세스는 살아서
  이벤트 루프가 놀고 있는데 8770 을 듣는 소켓이 없었다 (`py-spy dump` 실측).
★★원인은 표준 라이브러리다. 배포판은 리로드가 없어 uvicorn 이 `ProactorEventLoop` 를 쓰는데,
  그 루프의 손님 받기(`BaseProactorEventLoop._start_serving` 의 `loop`)는 받은 연결에서 `OSError` 가
  하나라도 나면 **듣는 소켓을 닫고 끝낸다.** 손님이 받기 전에 끊고 나가면(WinError 64,
  `ERROR_NETNAME_DELETED`) 그렇게 된다. 썸네일 수십 장을 한꺼번에 받다 화면이 요청을 거두는 순간이 그때다.
  ★재현: 배포판 파이썬 3.11.9 에서 루프가 바쁜 동안 연결을 RST 로 끊으면 그 자리에서 듣기가 죽는다.
    3.14 의 같은 코드도 그대로다.
★고치는 자리는 `IocpProactor.accept` 다. 받은 연결이 **그 연결만의 사정**(`_GONE`)으로 실패하면
  그것만 버리고 다음 연결을 다시 기다린다. 듣는 소켓 자체가 망가진 오류는 원래대로 올려 보낸다.
  ★루프 종류는 그대로 둔다. Selector 로 바꾸면 루프에서 자식 프로세스를 못 띄운다 (플러그인이 쓸 수 있다).
"""
from __future__ import annotations

import sys

# 받기 전에 손님 쪽에서 끊긴 연결: 그 연결만 버리면 되는 오류
#   64 ERROR_NETNAME_DELETED · 1236 ERROR_CONNECTION_ABORTED
#   10053 WSAECONNABORTED · 10054 WSAECONNRESET · 10057 WSAENOTCONN (`getpeername`)
_GONE = {64, 1236, 10053, 10054, 10057}


def _gone(exc) -> bool:
    return getattr(exc, "winerror", None) in _GONE


def _quiet(loop) -> None:
    """버린 연결마다 표준 라이브러리의 `accept_coro` 가 「Task exception was never retrieved」 를 남긴다.
    ★한 번에 수십 줄씩 쌓여 로그(제보로 오가는 파일)를 덮으므로 **그 경우만** 뺀다. 나머지는 원래 처리기로."""
    if getattr(loop, "_peropix_quiet", False):
        return
    prev = loop.get_exception_handler()

    def handler(lp, ctx):
        task = ctx.get("future")
        coro = task.get_coro() if hasattr(task, "get_coro") else None
        if _gone(ctx.get("exception")) and getattr(coro, "__qualname__", "").endswith("accept.<locals>.accept_coro"):
            return
        if prev is not None:
            prev(lp, ctx)
        else:
            lp.default_exception_handler(ctx)

    loop.set_exception_handler(handler)
    loop._peropix_quiet = True


def install() -> bool:
    """윈도우에서만 건다. 두 번 불러도 한 번만 걸린다."""
    if sys.platform != "win32":
        return False
    from asyncio import windows_events

    proactor = windows_events.IocpProactor
    if getattr(proactor.accept, "_peropix", False):
        return True
    orig = proactor.accept

    def accept(self, listener):
        _quiet(self._loop)
        outer = self._loop.create_future()
        cur = [None]

        def arm():
            inner = orig(self, listener)  # 듣는 소켓이 망가졌으면 여기서 그대로 터진다
            cur[0] = inner
            inner.add_done_callback(done)

        def done(f):
            if outer.done():
                return
            if f.cancelled():
                outer.cancel()
                return
            exc = f.exception()
            if exc is None:
                outer.set_result(f.result())
            elif _gone(exc) and listener.fileno() != -1:
                try:
                    arm()
                except OSError as e:
                    outer.set_exception(e)
            else:
                outer.set_exception(exc)

        def stop(o):
            # 루프가 듣기를 그만두면(`_stop_serving`) 걸어 둔 AcceptEx 도 거둔다
            if o.cancelled() and cur[0] is not None:
                cur[0].cancel()

        outer.add_done_callback(stop)
        arm()
        return outer

    accept._peropix = True
    proactor.accept = accept
    return True
