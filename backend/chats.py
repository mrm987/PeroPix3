"""AI 대화 저장소 — 앱을 껐다 켜도 하던 이야기가 이어진다 (사용자 요청 2026-08-07).

    <앱 데이터>/chats/<id>.json

★**앱 전체에 하나**다 (사용자 결정 2026-08-08). 한 번 워크스페이스별로 갈랐다가 되돌렸다 —
  "모든 화면에 같은 대화가 뜬다"는 지적의 진짜 원인은 **채팅창이 싱글/멀티 탭 아래에 박혀
  있던 것**이었고, 레이아웃을 고치자 가를 이유가 없어졌다. 전역이면 "워크스페이스2에 큐를
  넣어 줘" 같은 지시가 되고, 턴이 어느 워크스페이스 것인지 따질 일도 사라진다.
★대신 **어디서 시작했는지**(`workspace`)를 적어 둔다 — 목록에서 출처가 보이게. 첫 저장 때
  한 번만 박는다(넘나들어도 시작한 곳이 유지된다).

★**공급자에게 보내는 원본(`wire`)만 저장한다.** 화면에 그리는 줄은 거기서 파생시킨다 —
  같은 것을 두 벌로 담아 두면 둘이 어긋난다 (프론트 `linesOf`).

★오래된 것은 **개수로** 정리한다. 대화는 계속 쌓이는데 지울 창구가 없으면 폴더만 는다.
"""
from __future__ import annotations

import json
import re
import time
from datetime import datetime
from pathlib import Path

import trash
from durable import write_synced

_ID_OK = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
KEEP = 50


class Chats:
    def __init__(self, root: Path):
        self.root = root
        root.mkdir(parents=True, exist_ok=True)

    def _path(self, cid: str) -> Path:
        # id 는 우리가 발급한다. 외부 입력이 경로가 되지 않게 형식을 검사한다.
        if not _ID_OK.match(cid):
            raise ValueError(f"잘못된 대화 id: {cid}")
        return self.root / f"{cid}.json"

    @staticmethod
    def new_id() -> str:
        return f"chat_{int(time.time() * 1000):x}"

    def list(self) -> list[dict]:
        """목록 — **내용은 안 싣는다.** 최근 순.

        ★순서는 **파일 시각(mtime)** 으로 잡는다. `updatedAt` 은 초 단위라 같은 초에 저장된
          둘이 임의 순서가 되고, 그러면 "마지막 대화 복구"가 엉뚱한 것을 연다 (실측으로 밟았다).
        """
        rows = []
        for p in self.root.glob("*.json"):
            try:
                d = json.loads(p.read_text(encoding="utf-8"))
            except Exception:
                continue
            rows.append(
                (
                    p.stat().st_mtime,
                    {
                        "id": d.get("id") or p.stem,
                        "workspace": d.get("workspace") or "",
                        "title": d.get("title") or "",
                        "updatedAt": d.get("updatedAt") or "",
                        "turns": len(d.get("wire") or []),
                    },
                )
            )
        rows.sort(key=lambda r: r[0], reverse=True)
        return [r[1] for r in rows]

    def get(self, cid: str) -> dict | None:
        p = self._path(cid)
        if not p.exists():
            return None
        try:
            return json.loads(p.read_text(encoding="utf-8"))
        except Exception:
            return None

    def put(self, cid: str, wire: list, title: str = "", session: str = "",
            workspace: str = "") -> dict:
        # ★출처는 **첫 저장 때 한 번만** 박는다 — 넘나들며 시켜도 "시작한 곳"이 유지된다
        was = self.get(cid) or {}
        d = {
            "id": cid,
            "title": title[:80],
            "workspace": was.get("workspace") or workspace,
            "updatedAt": datetime.now().isoformat(timespec="seconds"),
            # ★CLI 로 돌 때 저쪽이 들고 있는 대화 id. **대화가 곧 세션**이라 여기 같이 둔다 —
            #   화면 상태에만 두면 패널이 다시 뜨는 순간 끊긴다 (실사용에서 그랬다)
            "session": session,
            "wire": wire,
        }
        p = self._path(cid)
        tmp = p.with_suffix(".tmp")
        write_synced(tmp, json.dumps(d, ensure_ascii=False))
        tmp.replace(p)
        self._trim()
        return {k: d[k] for k in ("id", "title", "workspace", "updatedAt", "session")}

    def delete(self, cid: str) -> dict:
        """★대화도 **휴지통을 거친다** (사용자 결정 2026-08-18, v2-port-audit D7).
        지운 대화는 다시 만들 수 없다 — 잘못 눌렀을 때 되돌릴 길을 둔다."""
        p = self._path(cid)
        if not p.exists():
            return {"deleted": [], "trashed": []}
        r = trash.send_at(self.root, [p.name])
        return {"deleted": [m["file"] for m in r["moved"]], "trashed": r["moved"]}

    def restore(self, entries: list[dict]) -> dict:
        return trash.restore_at(self.root, entries)

    def _trim(self) -> None:
        """최근 KEEP 개만 남긴다 — 오래된 것부터 지운다."""
        files = sorted(self.root.glob("*.json"), key=lambda p: p.stat().st_mtime, reverse=True)
        for p in files[KEEP:]:
            p.unlink(missing_ok=True)
