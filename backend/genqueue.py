"""생성 큐 + WebSocket 브로드캐스트 — v2 `backend.py:2296-2430, 4592-4681` 이식.

★★**차선(lane)은 계정 하나에 하나다** (사용자 결정 2026-09-02, 다중 NAI 계정). 계정이 여럿이면
  차선 수만큼 **동시에** 뽑히고, 한 차선 안에서는 예전과 같이 **한 번에 하나만** 돈다 — 진행률
  회계(completed/total)·취소 플래그·「지금 생성 중인 칸」이 전부 그 전제라서다. NAI 429 도
  계정마다 따로 센다. ★한 차선의 동시성을 1보다 크게 바꾸지 말 것.
  ★계정을 고르는 것은 워크스페이스다 (`spec.account`). 큐는 **넣을 때의 계정**을 그대로 들고
    간다 — 대기 중에 워크스페이스의 계정을 바꿔도 이미 넣은 것은 옮기지 않는다 (사용자 결정 1안).

★여기 든 방어 셋은 전부 **실사용 사고를 겪고** 들어간 것이다 (docs/v2-port-plan.md):

  1. `_unregister` 의 **identity 확인** — 재연결로 새 소켓이 슬롯을 차지한 뒤 구 소켓
     핸들러가 무조건 지우면, 새 연결이 브로드캐스트 명단에서 빠져 이후 아무것도 못 받는다.
  2. `broadcast` 의 **스냅샷 순회** — await 중 다른 코루틴이 연결·해제로 dict 를 바꾸면
     RuntimeError 로 브로드캐스트가 통째로 죽어 image/job_done 이 누락된다.
  3. `add_completed_image` 가 **사본을 저장** — 저장 뒤에 progress 등을 덧붙이므로,
     원본을 그대로 넣으면 복원분에 그때그때의 진행률이 섞여 들어간다.
"""
from __future__ import annotations

import asyncio
import uuid
from collections import deque
from typing import Any

#: 재연결·새로고침 복원 상한. v2 와 같은 값.
RECENT_LIMIT = 500
#: CLI 한 턴이 흘리는 줄 수 상한. 실측 2026-08-15: 도구를 16번 쓴 턴이 33줄이었다
RECENT_CLI_LIMIT = 2000


class Lane:
    """계정 하나의 줄 — 대기 잡·지금 도는 잡·진행률 회계가 **여기** 산다."""

    def __init__(self, lane_id: str, name: str = "") -> None:
        self.id = lane_id
        self.name = name
        self.queue: deque[dict] = deque()
        self.current_job: dict | None = None
        #: ★★**지금 만들고 있는 씬** (`{scene_group_id, cell_id}`) — 화면의 「생성 중」 표시가 이것을 본다.
        #:  예전에는 화면이 **자기 대기 목록의 첫 칸**을 「생성 중」으로 찍었는데, 배치가 겹치면
        #:  그 순서가 실제 진행과 어긋나 **엉뚱한 칸에 「생성 중」이 뜨고 그림은 「대기 중」 칸에
        #:  나타났다** (사용자 실측 2026-08-25). 무엇을 만드는지는 **여기가 정본**이다.
        self.current_cell: dict | None = None
        self.current_job_id: str | None = None
        self.cancel_current = False
        self.is_processing = False
        self.completed_images = 0
        self.total_images = 0

    # ── 큐 ──
    def add_job(self, request: Any, count: int) -> str:
        job_id = str(uuid.uuid4())[:8]
        self.queue.append({"id": job_id, "request": request, "count": count, "lane": self})
        self.total_images += count
        return job_id

    def get_next_job(self) -> dict | None:
        return self.queue.popleft() if self.queue else None

    def clear_queue(self) -> tuple[int, int]:
        """대기 큐만 비운다 — **현재 작업은 유지한다.**"""
        jobs = len(self.queue)
        images = sum(j["count"] for j in self.queue)
        self.queue.clear()
        return jobs, images

    def cancel_current_job(self) -> None:
        self.cancel_current = True

    def cancel_all(self) -> tuple[int, int, bool]:
        """★**취소는 하나다** — 대기 중인 것을 전부 걷어낸다 (사용자 결정 2026-08-18).

        NAI 는 요청이 나간 한 장을 중간에 못 끊는다. 그러니 멈출 수 있는 것은
        「아직 안 보낸 것」뿐이고, 그것은 두 군데에 나뉘어 있다:

          1. 대기 잡 (`self.queue`) — 아직 시작도 안 한 배치
          2. **돌고 있는 잡의 남은 장** — v3 는 배치 전체를 잡 **하나**로 넣으므로
             잡이 시작되면 1번은 비어 있다. 여기를 안 건드리면 아무것도 안 멈춘다

        돌려주는 셋째 값(`running`)은 **지금 NAI 로 나간 한 장이 아직 오는 중인가**다.
        화면은 그것으로 대기 칸을 몇 개 남길지 정한다.
        """
        jobs, images = self.clear_queue()
        running = self.is_processing
        if running:
            self.cancel_current_job()
        return jobs, images, running

    def busy(self) -> bool:
        return self.is_processing or bool(self.queue)

    def progress(self) -> dict:
        return {
            "completed": self.completed_images,
            "total": self.total_images,
            "queue_length": len(self.queue),
            "current_cell": self.current_cell,
            "name": self.name,
        }

    def status(self) -> dict:
        return {
            "queue_length": len(self.queue),
            "current_job_id": self.current_job_id,
            "is_processing": self.is_processing,
            "queued_jobs": [{"id": j["id"], "count": j["count"]} for j in self.queue],
            "completed_images": self.completed_images,
            "total_images": self.total_images,
            "name": self.name,
        }


class GenerationQueue:
    def __init__(self) -> None:
        #: 계정 id → 차선. ★지운 계정의 차선도 **돌던 것은 끝까지 돈다** — 토큰은 잡이 든 요청이 아니라
        #  서버가 그때그때 계정에서 꺼내므로, 지워진 계정은 첫 계정으로 떨어진다 (`accounts.resolve`)
        self.lanes: dict[str, Lane] = {}

        #: client_id → WebSocket
        self.clients: dict[str, Any] = {}

        #: 재연결 동기화용. seq 는 1부터 증가한다.
        self.recent_images: list[dict] = []
        self.image_sequence = 0

        #: ★CLI 조수가 흘리는 것도 **번호를 달아 남긴다** (2026-08-15).
        #  예전에는 그냥 쏘고 말아서, 소켓이 잠깐만 끊겨도 그 사이 줄이 영영 사라졌다.
        #  하필 끝을 알리는 `exit` 이 사라지면 화면은 「일하는 중…」에서 영원히 멈춘다 —
        #  일은 다 끝났는데도. 실제로 그렇게 카드가 만들어진 줄 모르고 기다린 적이 있다.
        #  ★버퍼는 **한 턴 것만** 담는다 (`start_cli_run` 이 비운다). 지난 턴을 남기면
        #    재연결한 화면에 옛 대화의 줄이 되살아난다.
        self.cli_run: str = ""
        self.cli_events: list[dict] = []
        self.cli_sequence = 0

    # ── 차선 ──
    def lane(self, lane_id: str, name: str = "") -> Lane:
        """그 계정의 차선 — 없으면 만든다. 이름은 부를 때마다 최신으로 맞춘다 (개명이 따라오게)."""
        ln = self.lanes.get(lane_id)
        if ln is None:
            ln = self.lanes[lane_id] = Lane(lane_id, name)
        elif name:
            ln.name = name
        return ln

    def add_job(self, request: Any, count: int, lane_id: str = "", lane_name: str = "") -> str:
        return self.lane(lane_id, lane_name).add_job(request, count)

    def all_jobs(self) -> list[dict]:
        """대기 중인 잡과 **지금 도는 잡** 전부 (차선 순서)."""
        out: list[dict] = []
        for ln in self.lanes.values():
            out.extend(ln.queue)
            if ln.current_job:
                out.append(ln.current_job)
        return out

    def cancel_all(self, lane_id: str | None = None) -> tuple[int, int, bool]:
        """차선 하나(`lane_id`)를, 없으면 **전부** 취소한다. 셋째 값은 「아직 올 장이 있는 차선이 있나」."""
        lanes = [self.lanes[lane_id]] if lane_id and lane_id in self.lanes else (
            [] if lane_id else list(self.lanes.values()))
        jobs = images = 0
        running = False
        for ln in lanes:
            j, i, r = ln.cancel_all()
            jobs += j
            images += i
            running = running or r
        return jobs, images, running

    def get_status(self) -> dict:
        lanes = list(self.lanes.values())
        return {
            "queue_length": sum(len(ln.queue) for ln in lanes),
            "is_processing": any(ln.is_processing for ln in lanes),
            "queued_jobs": [{"id": j["id"], "count": j["count"], "account": ln.id}
                            for ln in lanes for j in ln.queue],
            "completed_images": sum(ln.completed_images for ln in lanes),
            "total_images": sum(ln.total_images for ln in lanes),
            "lanes": {ln.id: ln.status() for ln in lanes},
            "image_sequence": self.image_sequence,
            "cli_run": self.cli_run,
            "cli_sequence": self.cli_sequence,
        }

    # ── 복원 ──
    def add_completed_image(self, image_data: dict) -> None:
        """완료된 그림을 기록한다. seq 를 **원본에도** 부여하고 **사본을** 보관한다."""
        self.image_sequence += 1
        image_data["seq"] = self.image_sequence
        self.recent_images.append(dict(image_data))
        if len(self.recent_images) > RECENT_LIMIT:
            self.recent_images.pop(0)

    def get_images_since(self, last_seq: int) -> list[dict]:
        return [i for i in self.recent_images if i.get("seq", 0) > last_seq]

    # ── CLI 조수 스트림 복원 ──
    def start_cli_run(self, run_id: str) -> None:
        """새 턴이 시작됐다 — 버퍼를 비우고 번호를 1부터 다시 센다."""
        self.cli_run = run_id
        self.cli_events = []
        self.cli_sequence = 0

    def add_cli_event(self, agent: str, event: dict) -> dict:
        """번호를 붙여 남기고, **내보낼 메시지를 돌려준다** (그림 쪽과 같은 요령)."""
        self.cli_sequence += 1
        msg = {"type": "cli", "run": self.cli_run, "seq": self.cli_sequence,
               "agent": agent, "event": event}
        self.cli_events.append(msg)
        if len(self.cli_events) > RECENT_CLI_LIMIT:
            self.cli_events.pop(0)
        return msg

    def get_cli_since(self, run_id: str, last_seq: int) -> list[dict]:
        """★**같은 턴일 때만** 돌려준다. 화면이 모르는 턴의 줄을 밀어 넣으면
        엉뚱한 대화에 남의 줄이 붙는다."""
        if not run_id or run_id != self.cli_run:
            return []
        return [e for e in self.cli_events if e.get("seq", 0) > last_seq]

    # ── 소켓 ──
    def _unregister(self, client_id: str, ws: Any) -> None:
        """★이 슬롯이 **아직 이 소켓을 가리킬 때만** 해제한다 (위 주석 1번)."""
        if self.clients.get(client_id) is ws:
            self.clients.pop(client_id, None)

    async def broadcast(self, data: dict) -> None:
        """★**스냅샷을 순회한다** (위 주석 2번)."""
        dead: list[tuple[str, Any]] = []
        for client_id, ws in list(self.clients.items()):
            try:
                await ws.send_json(data)
            except Exception:
                dead.append((client_id, ws))
        for client_id, ws in dead:
            self._unregister(client_id, ws)

    def progress(self) -> dict:
        """전체 합계 + 차선별. ★합계는 **옛 화면**이 그대로 읽는 모양이다 (`completed/total/queue_length`).
        `current_cell` 은 차선이 여럿이면 뜻이 없으므로 화면은 `lanes` 를 본다 — 첫 차선 것만 실어 둔다."""
        lanes = list(self.lanes.values())
        first = next((ln.current_cell for ln in lanes if ln.current_cell), None)
        return {
            "completed": sum(ln.completed_images for ln in lanes),
            "total": sum(ln.total_images for ln in lanes),
            "queue_length": sum(len(ln.queue) for ln in lanes),
            # ★없으면 `None` — 화면은 그때만 옛 방식(맨 앞 대기 칸)으로 물러선다
            "current_cell": first,
            "lanes": {ln.id: ln.progress() for ln in lanes},
        }


def generating_targets(q: Any) -> set[tuple[str, str]]:
    """지금 **큐에 있거나 만들고 있는** (워크스페이스, 씬 그룹 id) 들 — 모든 차선을 본다.

    ★★**큐는 넣을 때의 값을 그대로 들고 간다** — 워크스페이스·탭 이름·세트 이름·id 가 요청에
      박혀 있다 (`store/gen.ts` 의 `generateAll`). 그래서 생성 중에 그 탭·세트를 옮기면 도착한
      그림이 **옛 자리로** 저장된다: 같은 워크스페이스면 옛 탭 폴더에, 워크스페이스를 건너간
      경우에는 **떠나온 워크스페이스**에 기록까지 남아 앱 어디에도 안 뜬다.
    ★★그래서 **옮기기를 거절한다** (사용자 결정 2026-08-28). 큐를 취소해서 풀 수 있는 문제가
      아니다 — *"nai api는 요청 보낸 거 취소 안 됨"* (사용자). 이미 나간 한 장은 어차피 온다.
      끝난 뒤에 옮기면 된다.
    ★대기 중인 잡과 **지금 도는 잡**을 함께 본다. ★차선이 없는 옛 모양(`queue`·`current_job`)도 받는다."""
    if hasattr(q, "all_jobs"):
        jobs = q.all_jobs()
    else:
        jobs = list(getattr(q, "queue", []))
        if getattr(q, "current_job", None):
            jobs.append(q.current_job)
    out: set[tuple[str, str]] = set()
    for j in jobs:
        qb = j.get("request")
        base = getattr(qb, "base", None)
        if base is None:
            continue
        ws = str(getattr(base, "workspace", "") or "")
        gids = {getattr(base, "scene_group_id", None)}
        for it in (getattr(qb, "items", None) or []):
            if isinstance(it, dict) and it.get("scene_group_id"):
                gids.add(it["scene_group_id"])
        for g in gids:
            if ws and g:
                out.add((ws, str(g)))
    return out


async def _run_one(q: GenerationQueue, ln: Lane, process_job) -> None:
    """차선 하나에서 잡 하나를 끝까지 돌린다. ★한 차선에 이것이 동시에 둘 돌면 안 된다 (`run_loop` 가 지킨다)."""
    job = ln.get_next_job()
    if not job:
        return
    ln.is_processing = True
    ln.current_job = job
    ln.current_job_id = job["id"]
    ln.cancel_current = False
    try:
        await process_job(job)
    except Exception as e:  # 한 잡이 죽어도 루프는 계속 돈다
        print(f"[queue] job {job['id']} 실패: {e}")
        # ★남은 장은 안 나온다 — 총량을 완료에 맞춰 화면의 「돌고 있음」이 영영 안 남게 한다 (진행률도 실어 준다)
        ln.total_images = ln.completed_images
        await q.broadcast({"type": "job_error", "job_id": job["id"], "account": ln.id, "error": str(e),
                           "progress": q.progress()})
    ln.is_processing = False
    ln.current_job = None
    ln.current_cell = None
    ln.current_job_id = None
    ln.cancel_current = False


async def run_loop(q: GenerationQueue, process_job) -> None:
    """큐 처리 루프. ★차선마다 **하나만** 돈다 — 차선이 여럿이면 그만큼 나란히 돈다."""
    tasks: dict[str, asyncio.Task] = {}
    while True:
        for ln in list(q.lanes.values()):
            t = tasks.get(ln.id)
            if (t is None or t.done()) and ln.queue and not ln.is_processing:
                tasks[ln.id] = asyncio.create_task(_run_one(q, ln, process_job))
        await asyncio.sleep(0.1)
