"""씬 프롬프트의 줄 — 카드가 줄 구성을 갖고 씬은 줄마다 블록을 든다 (`src/lib/sceneLines.ts` 와 같은 규칙).

★카드: `dest`(첫 줄의 넣을 곳, 없으면 베이스) · `lines`([{id, dest}], 첫 줄 뒤의 줄들).
★씬: `blocks`(첫 줄) · `lineBlocks`({줄 id: 블록}).
★「합친 모양」은 씬 하나에 줄을 붙여 놓은 것이다 — `{blocks, dest?, lines?: [{id, dest, blocks}]}`.
  그림의 `env.cell` · 조수가 주고받는 씬이 이 모양이다.
"""
from __future__ import annotations

import uuid
from typing import Any


def _new_id() -> str:
    return "ln_" + uuid.uuid4().hex[:6]


def join_cell(card: dict, cell: dict) -> dict:
    """카드의 줄과 씬의 블록을 합친다 (`joinCell`)."""
    out: dict[str, Any] = {"blocks": cell.get("blocks") or []}
    if card.get("dest") and card["dest"] != "base":
        out["dest"] = card["dest"]
    lb = cell.get("lineBlocks") or {}
    if card.get("lines"):
        out["lines"] = [{"id": l.get("id"), "dest": l.get("dest"), "blocks": lb.get(l.get("id")) or []} for l in card["lines"]]
    return out


def split_cells(cells: list[dict]) -> tuple[dict, list[dict]]:
    """합친 모양의 씬들을 카드의 줄 구성과 씬의 블록으로 가른다 (`splitCells`).

    ★첫 줄의 넣을 곳은 첫 씬의 것이다. 넣을 곳이 같은 줄은 한 줄로 모은다. 아무것도 버리지 않는다."""
    main = (cells[0].get("dest") if cells else None) or "base"
    lines: list[dict] = []

    def id_of(dest: str, prefer: str | None) -> str:
        for l in lines:
            if l["dest"] == dest:
                return l["id"]
        lid = prefer if prefer and all(l["id"] != prefer for l in lines) else _new_id()
        lines.append({"id": lid, "dest": dest})
        return lid

    out = []
    for c in cells:
        rest = {k: v for k, v in c.items() if k not in ("dest", "lines")}
        blocks: list = []
        lb: dict[str, list] = {}
        joined = [(c.get("dest") or "base", c.get("blocks") or [], None)]
        joined += [(x.get("dest") or "base", x.get("blocks") or [], x.get("id")) for x in c.get("lines") or []]
        for d, bl, lid in joined:
            if d == main:
                blocks = blocks + bl
            else:
                i = id_of(d, lid)
                lb[i] = lb.get(i, []) + bl
        rest["blocks"] = blocks
        if lb:
            rest["lineBlocks"] = lb
        out.append(rest)
    card: dict[str, Any] = {}
    if main != "base":
        card["dest"] = main
    if lines:
        card["lines"] = lines
    return card, out
