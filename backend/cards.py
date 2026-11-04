"""카드 저장소 — 스타일 / 캐릭터 / 포즈세트.

★워크스페이스와 무관한 **공용** 저장소다 (schema.md).
   워크스페이스가 가르는 것은 작업 상태와 생성 이미지뿐이고,
   카드와 블록 저장소는 어디서나 같은 것을 쓴다.

    <앱 데이터>/cards/
      styles/<id>.json
      characters/<id>.json
      posesets/<id>.json

★그림 바이트는 여기 없다. 카드도 커버도 **공용 고정 썸네일 저장소**(`data/thumbs/<tid>.webp`,
  thumbs.Pins)를 `tid` 로 가리킬 뿐이다. 배너·카드 앞면·덱 커버가 같은 그림을 쓰면
  파일도 하나다 — 예전처럼 목적지마다 따로 굽지 않는다.
"""
from __future__ import annotations

import json
import re
import time
from datetime import datetime
from pathlib import Path

from durable import write_synced

import trash

KINDS = ("styles", "characters", "posesets")

_ID_OK = re.compile(r"^[A-Za-z0-9_-]{1,64}$")


class Cards:
    def __init__(self, root: Path):
        self.root = root
        root.mkdir(parents=True, exist_ok=True)
        for k in KINDS:
            (root / k).mkdir(parents=True, exist_ok=True)

    # ── 경로 ──────────────────────────────────────────────────
    def _dir(self, kind: str) -> Path:
        if kind not in KINDS:
            raise ValueError(f"알 수 없는 카드 종류: {kind}")
        return self.root / kind

    def _path(self, kind: str, cid: str) -> Path:
        # id 는 우리가 발급한다. 외부 입력이 경로가 되지 않게 형식을 검사한다.
        if not _ID_OK.match(cid):
            raise ValueError(f"잘못된 카드 id: {cid}")
        return self._dir(kind) / f"{cid}.json"

    @staticmethod
    def new_id(kind: str) -> str:
        prefix = {"styles": "sty", "characters": "chr", "posesets": "pst"}[kind]
        return f"{prefix}_{int(time.time() * 1000):x}"

    # ── CRUD ──────────────────────────────────────────────────
    def list(self, kind: str) -> list[dict]:
        out = []
        for p in sorted(self._dir(kind).glob("*.json")):
            try:
                out.append(json.loads(p.read_text(encoding="utf-8")))
            except Exception:
                continue  # 깨진 카드는 건너뛴다 — 나머지를 못 쓰게 만들지 않는다
        out.sort(key=lambda c: c.get("updatedAt", ""), reverse=True)
        return out

    def list_all(self) -> dict[str, list[dict]]:
        return {k: self.list(k) for k in KINDS}

    def save(self, kind: str, card: dict) -> dict:
        cid = card.get("id") or self.new_id(kind)
        card["id"] = cid
        card["updatedAt"] = datetime.now().isoformat(timespec="seconds")
        p = self._path(kind, cid)
        tmp = p.with_suffix(".tmp")
        write_synced(tmp, json.dumps(card, ensure_ascii=False, indent=2))
        tmp.replace(p)
        return card

    def delete(self, kind: str, cid: str) -> dict:
        # ★그림은 지우지 않는다 — 같은 tid 를 배너나 덱 커버가 함께 쓰고 있을 수 있다.
        #   공유하는 바이트를 한쪽 사정으로 지우면 다른 쪽이 조용히 깨진다.
        #   고아가 된 고정 썸네일은 수십 KB 짜리라 그냥 두는 편이 싸다.
        # ★★카드도 **휴지통을 거친다** (사용자 결정 2026-08-18, v2-port-audit D7) —
        #   사람이 지은 캐릭터·그림체라, 잘못 눌렀을 때 되돌릴 길이 있어야 한다.
        p = self._path(kind, cid)
        if not p.exists():
            return {"deleted": [], "trashed": []}
        r = trash.send_at(self.root, [f"{kind}/{cid}.json"])
        return {"deleted": [m["file"] for m in r["moved"]], "trashed": r["moved"]}

    def restore(self, entries: list[dict]) -> dict:
        return trash.restore_at(self.root, entries)

    # ── 썸네일 (카드 앞면 = 사용자 생성물) ─────────────────────
    # ★그림 바이트는 여기 없다. 공용 고정 썸네일 저장소(thumbs.Pins)에 하나만 있고,
    #   카드는 그걸 가리키는 `tid` 만 든다 — 배너·덱 커버도 같은 tid 를 가리킬 수 있다.
    def set_thumb(self, kind: str, cid: str, tid: str, view: dict | None = None) -> dict:
        """어느 고정 썸네일을 어떻게 볼지를 카드 JSON 에 적는다.

        ★그림은 **잘라 두지 않는다** — 통째로 두고 zoom/px/py 로 본다.
          카드 앞면과 배너는 비율이 달라서, 한쪽에 맞춰 자르면 다른 쪽이 어그러진다.
        """
        if not _ID_OK.match(cid):
            raise ValueError(f"잘못된 카드 id: {cid}")
        p = self._path(kind, cid)
        card = json.loads(p.read_text(encoding="utf-8")) if p.exists() else {"id": cid}
        card["thumb"] = {"tid": tid, **(view or {})}
        return self.save(kind, card)
