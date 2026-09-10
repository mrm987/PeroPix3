"""갤러리 = **골라 둔 것을 보관하는 곳** (v2 `GALLERY_DIR` 과 같은 자리).

★생성물 전체를 훑는 곳이 아니다 (사용자 지적 2026-08-05). 만든 것 중 **남길 것만** 여기로
  복사해 둔다. 그래서 두 가지가 따라온다:

  1. **워크스페이스를 넘는다.** 덱(스타일·캐릭터·포즈세트)과 같은 층이다 —
     "이번 작업"이 아니라 "내가 모아 둔 것"이라서.
  2. **생성 옵션을 통째로 안고 간다.** 복사할 때 PNG 메타데이터를 그대로 옮기고,
     원본에 없으면 화면이 준 것을 `Comment` 로 써 넣는다. 나중에 그대로 불러 쓸 수 있어야 한다.
  3. **별표도 여기가 든다** (`.peropix.json`, 2026-08-18). 워크스페이스에 매달아 두면
     작업을 바꾸는 순간 같은 그림의 별표가 달라진다 (`docs/v2-port-audit.md` A4).

★원본을 옮기지 않는다 — **복사**다. 작업 폴더의 그림은 그대로 남는다.
★같은 그림에 보관을 두 번 누르면 **무른다** — 사본이 둘 생기지 않는다 (A8).
"""
from __future__ import annotations

import json
import shutil
from datetime import datetime
from pathlib import Path

from PIL import Image
from PIL.PngImagePlugin import PngInfo

import trash

IMG_EXT = {".png", ".jpg", ".jpeg", ".webp"}

# 파생 썸네일 캐시. ★점으로 시작하는 것은 목록에서 통째로 뺀다 (`_visible`) —
# 안 그러면 캐시 webp 가 보관한 그림인 척 격자에 뜬다.
THUMB_DIR = ".thumbs"
# 보관함 곁장부 — 별표와 "이 그림은 어디서 왔나" 표가 여기 산다 (아래 주석)
STATE = ".peropix.json"


def safe_folder(root: Path, folder: str) -> Path:
    """폴더 경로 검증 — 밖으로 나가지 못하게 한다."""
    p = (root / folder).resolve() if folder else root.resolve()
    if not str(p).startswith(str(root.resolve())):
        raise ValueError("폴더 경로가 올바르지 않습니다")
    return p


def _visible(root: Path, p: Path) -> bool:
    """점으로 시작하는 칸이 하나라도 있으면 우리 내부용이다 (캐시·곁장부)."""
    return not any(part.startswith(".") for part in p.relative_to(root).parts)


def _imgs(root: Path, d: Path, deep: bool):
    it = d.rglob("*") if deep else d.glob("*")
    return (f for f in it if f.is_file() and f.suffix.lower() in IMG_EXT and _visible(root, f))


# ── 곁장부 ────────────────────────────────────────────────────────
# ★별표는 **워크스페이스가 아니라 보관함이 든다.** 갤러리는 워크스페이스를 넘는 화면인데
#   별표만 매여 있으면, 작업을 바꾸는 순간 같은 그림의 별표가 달라진다.
# ★"이 그림은 어디서 왔나"(sources)도 같이 든다 — 같은 그림을 두 번 보관하면 사본이 둘
#   생기던 것을 무르는(토글) 근거다. 파일명은 보관 시각이 붙어 매번 달라지므로
#   이름만으로는 판정할 수 없다.


def _state(root: Path) -> dict:
    try:
        d = json.loads((root / STATE).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {"starred": [], "sources": {}}
    return {
        "starred": [x for x in (d.get("starred") or []) if isinstance(x, str)],
        "sources": {k: v for k, v in (d.get("sources") or {}).items() if isinstance(v, str)},
    }


def _put_state(root: Path, st: dict) -> None:
    root.mkdir(parents=True, exist_ok=True)
    tmp = root / (STATE + ".tmp")
    tmp.write_text(json.dumps(st, ensure_ascii=False, indent=1), encoding="utf-8")
    tmp.replace(root / STATE)


def _remap(st: dict, moved: dict[str, str]) -> None:
    """옮기거나 이름을 바꾼 그림의 별표·출처를 새 경로로 따라 보낸다.

    빈 문자열로 매핑하면 **지운 것**이다 (별표·출처에서 뺀다)."""
    st["starred"] = [moved.get(f, f) for f in st["starred"] if moved.get(f, f)]
    st["sources"] = {k: moved.get(v, v) for k, v in st["sources"].items() if moved.get(v, v)}


def stars(root: Path) -> list[str]:
    return _state(root)["starred"]


def set_star(root: Path, file: str, on: bool) -> list[str]:
    st = _state(root)
    cur = [f for f in st["starred"] if f != file]
    if on:
        cur.append(file)
    st["starred"] = cur
    _put_state(root, st)
    return cur


def adopt_stars(root: Path, files: list[str]) -> list[str]:
    """다른 데 쌓여 있던 별표를 보관함으로 데려온다 (워크스페이스에 매여 있던 옛 별표).

    ★보관함에 **실제로 있는 파일만** 받는다. 받은 것을 돌려주므로 부르는 쪽이
      원래 자리에서 뺄 수 있다."""
    st = _state(root)
    have = set(st["starred"])
    took = []
    for f in files:
        if f in have:
            took.append(f)
            continue
        try:
            p = safe_folder(root, f)
        except ValueError:
            continue
        if p.is_file():
            st["starred"].append(f)
            have.add(f)
            took.append(f)
    if took:
        _put_state(root, st)
    return took


def folders(root: Path) -> list[dict]:
    """보관함의 폴더들.

    ★★첫 줄(`""`)은 **뿌리 폴더 그 자체**다 — 뿌리에 놓인 것만 센다 (사용자 지시 2026-09-06:
      *"최상위 gallery 선택하면 하위 폴더의 이미지는 안 보이게"*). 예전에는 「전체」라 하위까지
      셌는데(2026-08-05), 화면의 첫 줄이 「전체」가 아니라 `gallery` 폴더가 된 뒤로(2026-08-23)
      다른 폴더와 같은 규칙이어야 맞다. 숫자도 `images()` 가 보여 주는 것과 같아야 한다."""
    out = [{"path": "", "count": sum(1 for _ in _imgs(root, root, False))}]
    for d in sorted(p for p in root.rglob("*") if p.is_dir() and _visible(root, p)):
        out.append({"path": d.relative_to(root).as_posix(), "count": sum(1 for _ in _imgs(root, d, False))})
    return out


def make_folder(root: Path, name: str) -> dict:
    """보관함 안에 하위 폴더를 만든다 (v2 `POST /api/gallery/folders`)."""
    rel = (name or "").strip().strip("/")
    if not rel:
        raise ValueError("폴더 이름이 필요합니다")
    d = safe_folder(root, rel)
    if d == root.resolve():
        raise ValueError("폴더 이름이 필요합니다")
    if d.exists():
        raise ValueError("이미 있는 폴더입니다")
    d.mkdir(parents=True)
    return {"path": d.relative_to(root.resolve()).as_posix()}


def move_folder(root: Path, name: str, dest: str) -> dict:
    """폴더를 **다른 폴더 아래로** 옮긴다 (사용자 지시 2026-09-06: *"폴더도 드래그해서 옮기면 속한 위치
    바꿀 수 있게"*). `dest` 가 비면 뿌리로. 이름은 그대로고 부모만 바뀐다.

    ★자기 자신이나 자기 하위로는 못 옮긴다 (폴더가 제 안으로 사라진다).
    ★★안에 든 그림의 별표·출처는 **새 경로로 따라 보낸다** — 그림을 옮길 때(`move`)와 같은 규칙.
      안 따라가면 별표가 없는 파일을 가리키고, 「새 탭으로 복제」가 출처를 잃는다."""
    rel = (name or "").strip().strip("/")
    if not rel:
        raise ValueError("보관함 자체는 옮길 수 없습니다")
    src = safe_folder(root, rel)
    if not src.is_dir():
        raise ValueError("없는 폴더입니다")
    d = safe_folder(root, dest)
    if d == src or src in d.parents:
        raise ValueError("폴더를 자기 안으로 옮길 수 없습니다")
    if d == src.parent:
        return {"path": rel}
    d.mkdir(parents=True, exist_ok=True)
    return _relocate(root, src, d / src.name)


def rename_folder(root: Path, name: str, new: str) -> dict:
    """폴더 **이름만** 바꾼다 (사용자 지시 2026-09-10: *"갤러리 폴더 더블클릭하면 이름 변경할 수 있게"*).

    ★**부모는 그대로**다 — 자리를 옮기는 것은 끌어다 놓기(`move_folder`)의 일이고, 창구가
      둘이 되면 어느 쪽이 옮겼는지 흐려진다. 그래서 이름에 `/` 를 넣는 것도 막는다.
    ★안에 든 그림의 별표·출처는 `_relocate` 가 새 경로로 따라 보낸다."""
    rel = (name or "").strip().strip("/")
    leaf = (new or "").strip().strip("/")
    if not rel:
        raise ValueError("보관함 자체는 이름을 바꿀 수 없습니다")
    if not leaf:
        raise ValueError("폴더 이름이 필요합니다")
    if "/" in leaf or "\\" in leaf:
        raise ValueError("이름에 / 는 쓸 수 없습니다")
    src = safe_folder(root, rel)
    if not src.is_dir():
        raise ValueError("없는 폴더입니다")
    tgt = safe_folder(root, (src.parent / leaf).relative_to(root.resolve()).as_posix())
    if tgt == src:
        return {"path": rel}
    return _relocate(root, src, tgt)


def _relocate(root: Path, src: Path, tgt: Path) -> dict:
    """폴더를 `tgt` 자리로 옮기고 **안에 든 그림의 별표·출처를 새 경로로 따라 보낸다.**

    ★자리 옮기기(`move_folder`)와 이름 바꾸기(`rename_folder`)가 **같은 이 함수**를 쓴다 —
      곁장부를 따라 보내는 규칙이 두 벌이 되면 한쪽만 고쳐진다. 안 따라가면 별표가 없는
      파일을 가리키고, 「새 탭으로 복제」가 출처를 잃는다."""
    if tgt.exists():
        raise ValueError("그 자리에 같은 이름의 폴더가 있습니다")
    shutil.move(str(src), str(tgt))
    old_rel = src.relative_to(root.resolve()).as_posix()
    new_rel = tgt.relative_to(root.resolve()).as_posix()
    st = _state(root)
    head = old_rel + "/"
    inside = {f for f in st["starred"] if f.startswith(head)} | {v for v in st["sources"].values() if v.startswith(head)}
    if inside:
        _remap(st, {f: new_rel + "/" + f[len(head):] for f in inside})
        _put_state(root, st)
    return {"path": new_rel}


def drop_folder(root: Path, name: str) -> dict:
    """폴더를 지운다. ★**빈 폴더만** (v2 와 같다) — 안에 그림이 있으면 거절한다.
    그림째 지우는 창구를 따로 두지 않는다: 생성물은 Anlas 가 든 원본이다."""
    rel = (name or "").strip().strip("/")
    if not rel:
        raise ValueError("보관함 자체는 지울 수 없습니다")
    d = safe_folder(root, rel)
    if not d.is_dir():
        raise ValueError("없는 폴더입니다")
    if any(d.iterdir()):
        raise ValueError("비어 있지 않은 폴더입니다")
    d.rmdir()
    return {"path": rel}


def images(root: Path, folder: str = "", page: int = 1, limit: int = 0) -> dict:
    """그림 목록. ★`folder` 가 비면 **뿌리 폴더**, 주면 그 폴더 — 어느 쪽이든 **그 폴더에 놓인 것만**
    (하위 폴더는 안 훑는다. 사용자 지시 2026-09-06, `folders()` 의 ★★주).

    ★**쪽으로 끊어 준다** (v2 `/api/outputs-list` 와 같은 방식, 사용자 결정 2026-08-05).
      수백 장을 한 번에 내려 주면 화면이 그만큼의 DOM 을 만들어야 한다. `limit=0` 이면 전량.
    ★정렬을 먼저 하고 자른다 — 순서가 흔들리면 다음 쪽에 같은 그림이 또 온다."""
    d = safe_folder(root, folder)
    if not d.exists():
        return {"images": [], "total": 0, "page": 1, "pages": 1}
    # ★★정렬 기준은 **파일 시각(mtime) 내림차순** — v2 와 같다 (`backend.py:3903`,
    #   사용자 결정 2026-08-18 · v2-port-audit D9). 파일명 순이면 탐색기로 직접 넣은 그림이
    #   엉뚱한 자리에 끼어든다 (보관 파일명은 우리가 시각을 앞에 붙이지만, 밖에서 온 것은 아니다).
    # ★같은 시각이면 **상대경로**로 한 번 더 가른다 — 쪽을 나눠 받는 화면에서 순서가 흔들리면
    #   다음 쪽에 같은 그림이 또 온다 (아래 주석과 같은 이유). 파일 이름만으로는 모자란다:
    #   폴더가 다르면 같은 이름이 둘 있을 수 있고, 그러면 순서를 파일시스템이 정하게 된다.
    files = sorted(
        _imgs(root, d, False),
        key=lambda x: (x.stat().st_mtime, x.relative_to(root).as_posix()),
        reverse=True,
    )
    total = len(files)
    page, pages, chunk = _slice(files, page, limit)
    return {
        "images": [
            {
                "file": f.relative_to(root).as_posix(),
                "name": f.name,
                "size": f.stat().st_size,
                "mtime": f.stat().st_mtime,
            }
            for f in chunk
        ],
        "total": total,
        "page": page,
        "pages": pages,
    }


def _slice(items: list, page: int, limit: int):
    """정렬된 목록에서 한 쪽을 떼어 준다. ★`limit<=0` 이면 자르지 않는다."""
    if limit <= 0:
        return 1, 1, items
    pages = max(1, -(-len(items) // limit))
    page = max(1, min(page, pages))
    start = (page - 1) * limit
    return page, pages, items[start : start + limit]


def save(root: Path, src: Path, folder: str, meta: dict | None, key: str = "") -> dict:
    """작업 폴더의 그림 하나를 보관함으로 **복사**한다.

    ★PNG 메타데이터를 그대로 옮긴다 — 그것이 "그대로 다시 쓸 수 있다"의 전부다.
      원본에 `Comment` 가 없으면(포맷을 바꿨거나 밖에서 온 그림) 화면이 준 것을 써 넣는다.

    ★★**누르면 언제나 보관이다 — 무르기(토글)는 걷어냈다** (사용자 결정 2026-08-29:
      *"넣기가 빼기로 변하는 게 비직관적. 계속 중복으로 보내는 게 더 직관적"*).
      2026-08-18 의 「두 번 누르면 무른다」를 뒤집은 것이다 — 같은 그림을 또 보관하면
      사본이 하나 더 생기고, 빼는 것은 갤러리의 삭제가 맡는다.
    ★`key`(워크스페이스/파일)는 그대로 적는다 — 출처 추적(`origin_of`, 갤러리 그림의
      「새 탭으로 복제」)이 이 표를 읽는다. 마지막 보관본을 가리킨다."""
    st = _state(root)
    d = safe_folder(root, folder)
    d.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    dst = d / f"{stamp}_{src.stem}.png"
    n = 2
    while dst.exists():
        dst = d / f"{stamp}_{src.stem}_{n}.png"
        n += 1

    with Image.open(src) as im:
        info = dict(im.info)
        has_comment = "Comment" in info
        if src.suffix.lower() == ".png" and (has_comment or not meta):
            # 손대지 않는 것이 가장 정확하다 (다시 인코딩하지 않는다)
            shutil.copy2(src, dst)
            # ★★mtime 은 **보관한 지금**으로 (사용자 결정 2026-08-29: *"드롭한 순간의 시간순으로"*).
            #   copy2 는 원본의 mtime(그림을 생성한 시각)을 보존하는데, 목록은 mtime 내림차순이라
            #   옛 그림을 보관하면 중간에 끼어들었다 — 드롭·재인코딩 갈래는 지금 시각이라 섞였다.
            dst.touch()
        else:
            png = PngInfo()
            for k, v in info.items():
                if isinstance(v, str):
                    png.add_text(k, v)
            if not has_comment and meta:
                png.add_text("Comment", json.dumps(meta, ensure_ascii=False))
            im.convert("RGBA" if im.mode in ("RGBA", "LA") else "RGB").save(dst, format="PNG", pnginfo=png)

    rel = dst.relative_to(root.resolve()).as_posix()
    if key:
        st["sources"][key] = rel
        _put_state(root, st)
    return {"file": rel, "removed": False}


def import_bytes(root: Path, data: bytes, name: str, folder: str = "") -> dict:
    """**밖에서 온 그림**을 보관함에 들인다 (사용자 지시 2026-08-25).

    ★`save` 와 갈리는 점 둘:
      1. 원본이 **작업 폴더의 파일이 아니다.** 떨군 바이트가 곧 원본이라 복사할 자리가 없다.
      2. **출처 표(`sources`)에 안 적는다.** 그 표는 「이 워크스페이스의 이 파일이 보관됐다」를
         담는 것이라, 밖에서 온 그림에는 적을 열쇠가 없다 — 적으면 `origin_of` 가 없는
         워크스페이스를 가리키게 된다. 그래서 되보관 토글도 안 걸린다.

    ★★**바이트를 그대로 쓴다.** 다시 인코딩하면 PNG 에 박힌 NAI 메타데이터가 날아가는데,
      그것이 「나중에 그대로 다시 쓸 수 있다」의 전부다 (`save` 의 ★주와 같은 이유).
      그래서 PNG 가 아닌 것도 확장자만 살려 그대로 둔다 — 화면이 열 수 있으면 된다.
    """
    d = safe_folder(root, folder)
    d.mkdir(parents=True, exist_ok=True)
    stem = Path(name or "image").stem[:60] or "image"
    ext = Path(name or "").suffix.lower()
    if ext not in (".png", ".jpg", ".jpeg", ".webp"):
        ext = ".png"
    stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    dst = d / f"{stamp}_{stem}{ext}"
    n = 2
    while dst.exists():
        dst = d / f"{stamp}_{stem}_{n}{ext}"
        n += 1
    tmp = dst.with_suffix(dst.suffix + ".part")
    tmp.write_bytes(data)
    tmp.replace(dst)      # ★다 쓴 뒤에 이름을 준다 — 반쯤 쓰인 파일이 목록에 안 뜨게
    return {"file": dst.relative_to(root.resolve()).as_posix()}


def origin_of(root: Path, rel: str) -> dict | None:
    """보관한 그림이 **어느 워크스페이스의 어느 파일**에서 왔나 (`sources` 의 거꾸로 보기).

    ★★갤러리의 「새 탭으로 복제」가 이것으로 **그때 화면 구조**를 찾아간다
      (사용자 지시 2026-08-19: *"슬롯에서 복제할때랑 동일한 로직 사용해"*). 구조는 PNG 에
      안 남는다 — 남는 자리는 그 워크스페이스의 레코드(`env`)뿐이라, 출처를 모르면
      합쳐진 문자열 한 덩어리밖에 되돌릴 것이 없다.
    ★밖에서 넣은 그림·출처 표가 지워진 그림은 `None` 이다 (그때는 화면이 메타데이터로 떨어진다)."""
    st = _state(root)
    for key, v in st["sources"].items():
        if v == rel and "/" in key:
            ws, _, f = key.partition("/")
            return {"workspace": ws, "file": f}
    return None


def kept_of(root: Path, keys: list[str]) -> dict[str, str]:
    """"이 그림들이 지금 보관돼 있나" — 화면의 보관 버튼이 켜짐/꺼짐을 그리는 근거."""
    st = _state(root)
    out = {}
    for k in keys:
        rel = st["sources"].get(k)
        if rel and (root / rel).is_file():
            out[k] = rel
    return out


def delete(root: Path, files: list[str]) -> dict:
    """지우기 = **휴지통으로 이동** (사용자 결정 2026-08-18, v2-port-audit D7).

    ★곁장부(별표·출처)도 함께 걷어내되, **되돌릴 수 있게 돌려준다** — 되살린 그림에
      별표가 안 돌아오면 반쪽짜리 되돌리기가 된다."""
    # ★**그림만** 담는다 — 폴더를 지우는 창구는 `drop_folder`(빈 것만) 하나다.
    #   예전 계약(파일이 아니면 조용히 건너뛴다)을 그대로 지킨다.
    r = trash.send_at(root, [f for f in files if (root / f).is_file()])
    gone = [m["file"] for m in r["moved"]]
    st = _state(root)
    starred = [f for f in gone if f in st["starred"]]
    sources = {k: v for k, v in st["sources"].items() if v in set(gone)}
    if gone:
        _remap(st, {f: "" for f in gone})
        _put_state(root, st)
    return {"deleted": gone, "trashed": r["moved"], "starred": starred, "sources": sources}


def restore(root: Path, entries: list[dict], starred: list[str] | None = None,
            sources: dict[str, str] | None = None) -> dict:
    """휴지통에서 원래 자리로. ★별표·출처도 같이 되살린다 (`delete` 가 돌려준 그대로)."""
    r = trash.restore_at(root, entries)
    # ★되살리다 이름이 바뀔 수 있다 (그 사이 같은 이름이 생겼을 때) — 새 경로로 따라 보낸다
    now = {p["file"]: p["to"] for p in r["pairs"]}
    st = _state(root)
    touched = False
    for f in starred or []:
        f2 = now.get(f)
        if f2 and f2 not in st["starred"]:
            st["starred"].append(f2)
            touched = True
    for k, v in (sources or {}).items():
        if now.get(v):
            st["sources"][k] = now[v]
            touched = True
    if touched:
        _put_state(root, st)
    return r


def move(root: Path, files: list[str], dest: str) -> dict:
    d = safe_folder(root, dest)
    d.mkdir(parents=True, exist_ok=True)
    moved, changed = [], {}
    for rel in files:
        p = safe_folder(root, rel)
        if not p.is_file():
            continue
        tgt = d / p.name
        n = 2
        while tgt.exists():
            tgt = d / f"{p.stem}_{n}{p.suffix}"
            n += 1
        p.rename(tgt)
        now = tgt.relative_to(root.resolve()).as_posix()
        moved.append(now)
        changed[rel] = now
    if changed:
        st = _state(root)
        _remap(st, changed)
        _put_state(root, st)
    return {"moved": moved}


def rename(root: Path, file: str, name: str) -> dict:
    """보관한 그림의 이름을 바꾼다 (v2 `PATCH /api/gallery/{filename}`).

    ★폴더는 그대로다 — 옮기는 것은 `move` 의 일이다."""
    new = (name or "").strip()
    if not new:
        raise ValueError("이름이 필요합니다")
    if "/" in new or "\\" in new or ".." in new:
        raise ValueError("이름에 쓸 수 없는 글자가 있습니다")
    p = safe_folder(root, file)
    if not p.is_file():
        raise ValueError("없는 그림입니다")
    if not Path(new).suffix:
        new += p.suffix
    tgt = p.with_name(new)
    if tgt == p:
        return {"file": file}
    if tgt.exists():
        raise ValueError("같은 이름이 이미 있습니다")
    p.rename(tgt)
    now = tgt.relative_to(root.resolve()).as_posix()
    st = _state(root)
    _remap(st, {file: now})
    _put_state(root, st)
    return {"file": now}
