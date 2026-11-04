"""깨진 `workspace.json` 을 **그림 기록으로 복구한다** (사용자 지시 2026-11-04: *"워크스페이스 폴더를 기준으로
저 json 을 다시 생성해 주는 복구 도구"*).

읽는 것: 색인의 줄(씬 그룹·씬의 id 와 이름) · 그림 경로(`output/<탭>/<씬 그룹>/…` 에서 탭 이름) ·
그 그림을 뽑을 때의 구조(`env`: 탭 프롬프트 · 씬 블록 · `sceneDest`).

★★되찾지 못하는 것이 있다: 그림이 한 장도 없는 씬 · 씬 카드 구분(씬 그룹마다 카드 하나) · 카드 그림 · 생성 옵션 ·
  마지막 생성 뒤에 고친 프롬프트. 화면의 안내 문구(`gate.rebuildBody`)가 이것을 그대로 말하므로 **여기를 고치면 그 문구도 고친다.**
★id 를 그대로 쓴다 — 그림은 씬 id 로 묶이므로 (`lib/takes` 의 `takesOf`) 같은 id 면 제자리에 붙는다.
★파일을 쓰는 것은 `Store.rebuild` 다. 여기는 계산만 한다.
"""
from __future__ import annotations

import uuid
from typing import Callable

#: 경로에서 탭 이름을 못 읽는 그림(옛 배치)이 드는 탭
FALLBACK_TAB = "복구"
#: 기록에 이름이 없는 씬
FALLBACK_CELL = "씬"


def _new_id(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex[:8]}"


def _tab_of(file: str) -> str:
    parts = str(file).split("/")
    return parts[1] if len(parts) >= 4 and parts[0] == "output" else FALLBACK_TAB


def _latest_env(recs: list[dict], read_env: Callable[[dict], dict | None]) -> dict | None:
    """★최신 그림부터 본다 — 대개 첫 장에서 끝나므로 그림이 10만 장이어도 다 안 읽는다."""
    for r in reversed(recs):
        env = read_env(r)
        if env:
            return env
    return None


def build(name: str, recs: list[dict], read_env: Callable[[dict], dict | None], starred: list[str]) -> tuple[dict, dict]:
    """`recs` 는 **파일이 지금 있는 줄**, 만든 차례대로다 (`Store.live_records`). → (spec, 안내에 쓸 수)"""
    groups: dict[str, dict] = {}    # 씬 그룹 id(없으면 이름) → {name, recs, cells}
    for r in recs:
        gkey = str(r.get("scene_group_id") or r.get("scene_group") or "")
        g = groups.setdefault(gkey, {"id": r.get("scene_group_id"), "name": "", "recs": [], "cells": {}})
        g["recs"].append(r)
        if r.get("scene_group"):
            g["name"] = r["scene_group"]        # ★최신 줄의 이름이 남는다
        ckey = str(r.get("cell_id") or r.get("cell") or "")
        g["cells"].setdefault(ckey, []).append(r)

    tabs: dict[str, dict] = {}      # 탭 이름 → {id, recs}
    out_groups: list[dict] = []
    no_prompt = 0
    latest: dict | None = None      # 마지막으로 뽑은 그림의 씬 그룹 — 열었을 때 그것이 보인다
    latest_ts = ""
    for g in groups.values():
        gname = g["name"] or FALLBACK_TAB
        tab_name = _tab_of(g["recs"][-1].get("file", ""))
        tab = tabs.setdefault(tab_name, {"id": _new_id("ch"), "recs": []})
        tab["recs"].extend(g["recs"])
        cells = []
        for crecs in g["cells"].values():
            last = crecs[-1]
            env = _latest_env(crecs, read_env)
            cell = (env or {}).get("cell") or {}
            if not cell.get("blocks"):
                no_prompt += 1
            cells.append({
                "id": last.get("cell_id") or _new_id("c"),
                "name": last.get("cell") or cell.get("name") or FALLBACK_CELL,
                "blocks": cell.get("blocks") or [],
            })
        env = _latest_env(g["recs"], read_env)
        out = {
            "id": g["id"] or _new_id("tab"),
            "kind": "sceneGroup",
            "name": gname,
            "tabId": tab["id"],
            "cards": [{"id": "k1", "name": gname, "cells": cells}],
            "cardSeq": 1,
            # ★`cellSeq` 는 안 적는다 — 없으면 화면이 지금 씬의 최대 번호 + 1 로 본다 (`Store.addCard`)
            # ★id 가 없는 옛 줄이 하나라도 있으면 이름으로 묶어야 그 그림이 붙는다 (`takesOf`)
            "idOnly": all(r.get("scene_group_id") and r.get("cell_id") for r in g["recs"]),
        }
        if (env or {}).get("sceneDest") is not None:
            out["sceneDest"] = env["sceneDest"]
        out_groups.append(out)
        ts = str(g["recs"][-1].get("ts") or "")
        if latest is None or ts >= latest_ts:
            latest, latest_ts = out, ts

    out_tabs = []
    for tab_name, tab in tabs.items():
        # ★탭의 레코드는 그룹별로 모였으므로 차례를 다시 맞춘다 — 「마지막으로 뽑은 그림」이 기준이다
        env = _latest_env(sorted(tab["recs"], key=lambda r: str(r.get("ts") or "")), read_env)
        out_tabs.append({"id": tab["id"], "name": tab_name, "prompt": (env or {}).get("prompt") or {"base": [], "baseUc": []}})

    have = {str(r.get("file")) for r in recs}
    stars = [f for f in starred if f in have]
    spec = {
        "version": 1,
        "specVersion": 3,   # ★`migrate_terms.SPEC_VERSION` 과 같아야 한다 — 없으면 낱말 이전이 옛 파일로 본다
        "id": _new_id("ws"),
        "name": name,
        "prompt": {"base": [], "baseUc": []},
        "params": {},
        "sceneGroups": out_groups,
        "activeSceneGroup": latest["id"] if latest else "",
        "tabs": out_tabs,
        "activeTab": latest["tabId"] if latest else "",
        "selection": {"starred": stars},
    }
    counts = {
        "images": len(recs),
        "tabs": len(out_tabs),
        "groups": len(out_groups),
        "cells": sum(len(g["cards"][0]["cells"]) for g in out_groups),
        "noPrompt": no_prompt,
        "stars": len(stars),
    }
    return spec, counts
