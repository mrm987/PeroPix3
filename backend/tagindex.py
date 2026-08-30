# -*- coding: utf-8 -*-
"""태그 검색 인덱스 — 아웃풋 루트의 그림마다 **긍정 프롬프트 원문**을 곁파일에 모아 둔다
(사용자 지시 2026-08-31: 작가 태그를 섞어 쓰다 보면 어느 작가가 어느 그림체였는지 잊는다 —
생성 화면 옆 서랍에서 태그를 눌러 그 태그가 쓰인 그림을 보고, 바로 프롬프트에 넣는다).

★★여기서는 **태그로 쪼개지 않는다.** 쪼개는 규칙(`N::` 세기, 따옴표·`text:` 보호, 줄바꿈 경계)은
  프런트 `lib/blocks.ts` 의 `parseSegs` 하나다 — 같은 규칙을 파이썬으로 옮겨 두면 창구가 둘이 되고,
  한쪽만 고쳐진다. 그래서 곁파일에는 프롬프트 **원문**만 두고, 태그 집계는 화면이 그 함수로 한다.
★메타 읽기는 `meta.read_raw` 를 그대로 쓰되 **알파 스테가노(7단계)는 건너뛴다** (`stealth=False`) —
  픽셀을 전부 훑는 느린 폴백이라 수천 장에는 못 쓴다. 그런 그림은 「프롬프트 없음」으로 남는다.
★증분이다: mtime·크기가 같은 파일은 다시 읽지 않는다. 옮기거나 지운 파일은 다음 훑기에서 빠진다.
  첫 훑기만 파일 전체를 읽고(실측 규모 4천 장·2.2GB), 그 뒤로는 stat 뿐이다.
★곁파일은 `<루트>/.index/prompts.json` — 점 폴더라 파일 관리 트리에 안 나온다 (`files.tree`).
  네거티브는 넣지 않는다 (사용자 결정 2026-08-31: 긍정 프롬프트 전부, 네거티브 제외).
"""
from __future__ import annotations

import json
import os
import threading
from pathlib import Path
from typing import Callable

import meta
from files import IMG_EXT

INDEX_DIR = ".index"
INDEX_FILE = "prompts.json"

_lock = threading.Lock()
#: 훑기 상태 — 백그라운드 스레드가 갱신한다 (`tagger._dl` 과 같은 꼴)
_st = {"running": False, "done": 0, "total": 0, "error": ""}


def index_path(root: Path) -> Path:
    return root / INDEX_DIR / INDEX_FILE


def load(root: Path) -> dict:
    """곁파일 통째. 없거나 깨졌으면 빈 것 — 예외로 만들지 않는다 (훑기가 새로 만든다)."""
    try:
        d = json.loads(index_path(root).read_text("utf-8"))
    except Exception:
        return {"files": {}}
    return d if isinstance(d, dict) and isinstance(d.get("files"), dict) else {"files": {}}


def status(root: Path) -> dict:
    with _lock:
        st = dict(_st)
    try:
        built = index_path(root).stat().st_mtime
    except OSError:
        built = 0
    return {"running": st["running"], "done": st["done"], "total": st["total"],
            "error": st["error"], "built": built}


def start(root: Path) -> dict:
    """훑기를 **백그라운드로** 시작한다 — 첫 훑기는 몇십 초가 걸리므로 요청을 붙들면 안 된다."""
    with _lock:
        if _st["running"]:
            return status(root)
        _st.update(running=True, done=0, total=0, error="")
    threading.Thread(target=_run, args=(root,), daemon=True).start()
    return status(root)


def _run(root: Path) -> None:
    try:
        build(root)
    except Exception as e:  # noqa: BLE001 — 사유를 화면까지 전한다
        with _lock:
            _st["error"] = str(e)
    finally:
        with _lock:
            _st["running"] = False


def walk(root: Path):
    """루트 아래 그림 전부 — ★점 폴더(`.trash`·`.thumbs`·`.index`)는 안 들어간다."""
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if not d.startswith(".")]
        for f in filenames:
            if Path(f).suffix.lower() in IMG_EXT:
                yield Path(dirpath) / f


def prompts_of(path: Path) -> list[str]:
    """한 장의 긍정 프롬프트 원문들 — 베이스 하나 + 캐릭터 칸마다 하나. 못 읽으면 빈 목록."""
    try:
        data = path.read_bytes()
    except OSError:
        return []
    try:
        m = meta.normalize(meta.read_raw(data, stealth=False)) or {}
    except Exception:
        return []
    out = [m.get("prompt") or ""] + [c.get("prompt") or "" for c in (m.get("characters") or [])]
    return [p for p in out if isinstance(p, str) and p.strip()]


def build(root: Path, read: Callable[[Path], list[str]] = prompts_of) -> dict:
    """훑어서 곁파일을 다시 쓴다. `read` 는 판정이 갈아 끼운다 (실제 읽기 횟수를 센다)."""
    old = load(root)["files"]
    paths = list(walk(root))
    with _lock:
        _st["total"] = len(paths)
        _st["done"] = 0
    files: dict[str, dict] = {}
    for p in paths:
        try:
            st = p.stat()
        except OSError:
            continue
        rel = p.relative_to(root).as_posix()
        prev = old.get(rel)
        if prev and prev.get("m") == st.st_mtime and prev.get("s") == st.st_size:
            files[rel] = prev
        else:
            files[rel] = {"m": st.st_mtime, "s": st.st_size, "p": read(p)}
        with _lock:
            _st["done"] += 1
    out = {"files": files}
    save(root, out)
    return out


def save(root: Path, d: dict) -> None:
    p = index_path(root)
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_suffix(".tmp")
    tmp.write_text(json.dumps(d, ensure_ascii=False), "utf-8")
    tmp.replace(p)   # ★다 쓴 뒤에 이름을 준다 — 반쪽 파일이 안 남게
