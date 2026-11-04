"""블록 저장소 — 프롬프트 블록 하나를 이름·분류와 함께 보관한다.

★카드와 같은 **공용** 저장소다 (`cards.py` 머리 참조). 워크스페이스가 가르는 것은 작업
  상태와 생성 이미지뿐이고, 카드와 블록은 어디서나 같은 것을 쓴다 (목업 `peropix-block-editor`
  의 「블록 저장소」 주석이 정본).

★**파일 하나에 목록으로 둔다** — 카드처럼 항목마다 파일을 가르지 않는다.
  항목이 태그 몇 개짜리로 작고, 서랍이 열릴 때 **언제나 전부** 보이기 때문이다.
  카드가 파일을 가르는 까닭(항목마다 썸네일·개별 갱신)이 여기엔 없다.

    <앱 데이터>/blocks.json   { "items": [ {id, cat, label, color, tags:[{t,w}]} ] }
"""
from __future__ import annotations

import json
import time
from datetime import datetime
from pathlib import Path

from durable import write_synced


class BlockLib:
    def __init__(self, path: Path):
        self.path = path
        path.parent.mkdir(parents=True, exist_ok=True)

    # ── 읽기·쓰기 ─────────────────────────────────────────────
    def list(self) -> list[dict]:
        if not self.path.exists():
            return []
        try:
            data = json.loads(self.path.read_text(encoding="utf-8"))
        except Exception:
            # ★깨진 파일을 지우지 않는다 — 사용자가 모은 것이라 손으로 살릴 여지를 남긴다
            return []
        items = data.get("items") if isinstance(data, dict) else data
        return [x for x in (items or []) if isinstance(x, dict) and x.get("id")]

    def _write(self, items: list[dict]) -> None:
        tmp = self.path.with_suffix(".tmp")
        write_synced(tmp, json.dumps({"items": items}, ensure_ascii=False, indent=2))
        tmp.replace(self.path)

    @staticmethod
    def new_id() -> str:
        return f"blk_{int(time.time() * 1000):x}"

    # ── CRUD ──────────────────────────────────────────────────
    def save(self, item: dict) -> dict:
        """id 가 있으면 그 자리를 갈아 끼우고, 없으면 **맨 앞에** 넣는다.

        ★맨 앞이다 — 방금 저장한 것이 서랍 위에 보여야 "들어갔다"를 눈으로 안다."""
        item = dict(item)
        item["id"] = item.get("id") or self.new_id()
        item["updatedAt"] = datetime.now().isoformat(timespec="seconds")
        items = self.list()
        for i, x in enumerate(items):
            if x.get("id") == item["id"]:
                items[i] = item
                break
        else:
            items.insert(0, item)
        self._write(items)
        return item

    def delete(self, bid: str) -> None:
        items = [x for x in self.list() if x.get("id") != bid]
        self._write(items)

    def reorder(self, ids: list[str]) -> list[dict]:
        """준 순서대로 다시 늘어놓는다. **목록에 없는 id 는 무시하고**, 빠진 것은 뒤에 남긴다
        (다른 창에서 그새 저장한 항목이 사라지지 않게)."""
        items = self.list()
        by_id = {x["id"]: x for x in items}
        out = [by_id.pop(i) for i in ids if i in by_id]
        out.extend(x for x in items if x["id"] in by_id)
        self._write(out)
        return out
