"""보조 도구 — **이미 있는 그림을 손보는** 일 (9단계).

여기 오는 그림은 **밖에서 온 것일 수 있다.** 그래서 세 갈래로 받는다 (`_read`):

    path  절대 경로 — 앱 창에 떨군 파일 (Tauri 가 경로를 준다)
    rel   아웃풋 루트 기준 상대 경로 — 파일 관리에서 고른 것
    data  base64 — 경로가 없는 곳(브라우저)에서 떨군 파일

★규칙 하나는 어디서 오든 같다: **원본을 지우지 않는다.** 변환은 새 파일을 만든다.
★같은 이름이 있으면 덮지 않고 번호를 붙인다.
"""
from __future__ import annotations

import base64
import binascii
import io
from pathlib import Path

from PIL import Image

import files as files_mod
import meta as meta_mod
import trash

Item = dict  # {"name": str, "path"?: str, "rel"?: str, "data"?: base64}

#: EXIF 리더의 미리보기 / 변환 목록의 작은 칸. ★**서버가 줄여서 준다** — 앱(Tauri)에는 경로만
#  오고 그 파일을 가리킬 주소가 없어서, 줄이지 않으면 화면에 그림을 못 띄운다.
PREVIEW_MAX = 320
LIST_THUMB = 96

#: 화면이 이미 다른 칸으로 보여 주는 tEXt 청크 — 「그 밖」 목록에서 뺀다 (index.html:25822)
SHOWN_CHUNKS = {"Comment", "prompt", "workflow", "peropix",
                "vibe_data", "cache_key", "model", "strength", "info_extracted"}


def _read(root: Path, it: Item) -> tuple[bytes, Path | None]:
    """그림의 바이트와 **원본 자리**(있으면). 자리를 아는 것만 `원본 옆에` 저장할 수 있다."""
    if it.get("rel"):
        p = files_mod.under(root, it["rel"])
        return p.read_bytes(), p
    if it.get("path"):
        p = Path(it["path"])
        return p.read_bytes(), p
    if it.get("data"):
        raw = it["data"]
        if "," in raw[:64]:  # data:image/png;base64,....
            raw = raw.split(",", 1)[1]
        try:
            return base64.b64decode(raw), None
        except (binascii.Error, ValueError) as e:
            raise ValueError("base64 를 못 읽었습니다") from e
    raise ValueError("그림이 비었습니다")


def _src_of(root: Path, it: Item) -> Path | None:
    """이 그림의 **원본 자리** (모르면 None). ★바이트를 안 읽는다 — 저장 폴더를 미리 정하는 데만 쓴다."""
    try:
        if it.get("rel"):
            return files_mod.under(root, it["rel"])
        if it.get("path"):
            return Path(it["path"])
    except Exception:
        return None
    return None


def _thumb(data: bytes, max_side: int) -> str:
    """줄인 그림을 data URL 로. 못 읽으면 빈 문자열 (그림이 아니어도 예외로 만들지 않는다)."""
    try:
        with Image.open(io.BytesIO(data)) as im:
            return thumb_image(im, max_side)
    except Exception:
        return ""


def thumb_image(im: Image.Image, max_side: int) -> str:
    """이미 연 그림을 줄여 data URL 로. 태거처럼 그림을 이미 들고 있는 자리가 쓴다.

    ★★**알파를 떼지 않는다** (사용자 지적 2026-09-06: *"투명 이미지가 생성 직후랑 갤러리 등에서는
      정상적으로 표시되는데, exif 리더의 썸네일이나 검열모드 등에서는 누끼 경계 부분이 노이즈가
      엄청 심해짐"*). 투명 PNG 는 알파가 0 에 가까운 픽셀의 RGB 에 쓰레기 값이 들어 있다 — 브라우저는
      알파를 곱해 가리지만, `convert("RGB")` 로 알파를 떼면 그 값이 그대로 드러나 경계가 색 노이즈로
      덮인다. 갤러리 썸네일(`thumbs.derive`)이 그렇듯 알파를 남긴 WebP 로 준다."""
    small = keep_alpha(im)
    small.thumbnail((max_side, max_side), Image.LANCZOS)
    buf = io.BytesIO()
    small.save(buf, format="WEBP", quality=80)
    return "data:image/webp;base64," + base64.b64encode(buf.getvalue()).decode("ascii")


def keep_alpha(im: Image.Image) -> Image.Image:
    """저장·전송용 모드로 — 알파가 있으면 RGBA, 없으면 RGB. ★`convert("RGB")` 로 알파를 떼지 않는다 (위 ★★주)"""
    if im.mode in ("RGB", "RGBA"):
        return im
    has_alpha = "A" in im.getbands() or (im.mode == "P" and "transparency" in im.info)
    return im.convert("RGBA" if has_alpha else "RGB")


def probe(root: Path, items: list[Item]) -> dict:
    """목록에 보여 줄 것만 — 작은 썸네일 · 파일 크기 · 해상도. ★**읽기만 한다.**

    변환 목록이 이걸 쓴다 (v2 `file-item-thumb`·`file-item-meta`). 한 장이 깨져도
    나머지는 그대로 준다 — 목록에서 그 줄만 이름으로 남는다."""
    out = []
    for it in items:
        row: dict = {"name": it.get("name") or ""}
        try:
            data, _ = _read(root, it)
            with Image.open(io.BytesIO(data)) as im:
                row["width"], row["height"] = im.size
            row["bytes"] = len(data)
            row["thumb"] = _thumb(data, LIST_THUMB)
        except Exception as e:
            row["error"] = str(e)
        out.append(row)
    return {"items": out}


#: 앱 창에 떨군 파일을 통째로 들여올 때의 한계. ★그림 한 장·바이브 파일 한 개면 충분하고,
#  상한이 없으면 실수로 떨군 큰 파일 하나가 그대로 메모리에 올라온다.
READ_MAX = 24 * 1024 * 1024
#: 글로 읽어 줄 것 (`.naiv4vibe` 는 JSON 이다). 그 밖은 base64 로 준다
TEXT_EXT = {".naiv4vibe", ".json", ".txt"}


def read_dropped(root: Path, it: Item) -> dict:
    """앱 창에 **떨군 파일 하나**를 화면이 쓸 수 있는 모양으로 준다.

    ★왜 서버가 하나: Tauri 는 창에 떨어진 파일을 가로채 **경로만** 준다 (`lib/dropImages.ts`
      머리 주석). 화면에는 그 경로를 열 수단이 없어서, 안 거치면 앱에서는 떨구기가
      통째로 안 되고 브라우저에서만 된다.
    ★글 파일은 `text`, 그림은 `data`(base64) 로 준다. 둘 다 아니면 그림으로 시도한다."""
    p = Path(it.get("path") or "")
    if not p.is_file():
        raise ValueError("파일을 찾을 수 없습니다")
    if p.stat().st_size > READ_MAX:
        raise ValueError("파일이 너무 큽니다")
    raw = p.read_bytes()
    if p.suffix.lower() in TEXT_EXT:
        return {"name": p.name, "text": raw.decode("utf-8", "replace")}
    return {"name": p.name, "data": base64.b64encode(raw).decode("ascii")}


def _free(d: Path, stem: str, ext: str) -> Path:
    """빈 자리를 찾아 준다 — 덮어쓰지 않는다."""
    cand = d / f"{stem}.{ext}"
    n = 2
    while cand.exists():
        cand = d / f"{stem}_{n}.{ext}"
        n += 1
    return cand


#: 저장 자리 — 화면의 「저장 위치」와 같은 세 갈래 (사용자 지시 2026-08-23)
#:   overwrite  원본을 **대체**한다 (원본은 휴지통으로)
#:   sub        **첫 그림이 있는 폴더 아래**에 `output/` 을 하나 만들어 전부 거기
#:   folder     고른 폴더에 모은다 (`dest` — 윈도우 폴더 찾기로 고른 **절대 경로**일 수 있다)
MODES = ("overwrite", "sub", "folder")
#: 「첫 이미지 하위에 output 폴더를 만들어 저장」이 만드는 폴더 이름
SUB_DIR = "output"


def retire(root: Path, paths: list[Path]) -> bool:
    """★검열 저장도 같은 규칙을 쓴다 (`server.censor_apply` 의 덮어쓰기).
    돌려주는 것은 **다 물러났는가** — 거짓이면 부르는 쪽이 덮어쓰기를 멈춘다."""
    _retire(root, paths)
    return not any(p.exists() for p in paths)


def _retire(root: Path, paths: list[Path]) -> None:
    """덮어쓰기에 밀려나는 옛 파일을 **휴지통으로** (지우지 않는다).

    ★★뿌리 **안**이면 앱 휴지통, **밖**이면 OS 휴지통이다.
      예전에는 전부 앱 휴지통에 넣으려고 `relative_to(root)` 를 불렀는데, 탐색기에서
      끌어다 놓은 그림은 뿌리 밖이라 거기서 `ValueError` 가 났다 — 그래서 **덮어쓰기가
      늘 실패했다** (사용자 지적 2026-08-24: *"덮어쓰기 선택시 항상 실패"*).
      바깥 파일을 앱 안으로 끌고 들어오지도 않는다: 사용자 폴더에서 파일이 사라진 것으로만
      보이고, 앱을 지우면 함께 사라진다.
    ★OS 휴지통이 없는 자리(win32 밖)에서는 **아무것도 안 물러난다** — 부르는 쪽이 그것을
      보고 덮어쓰기를 그만둔다 (조용히 지우지 않는다)."""
    inside, outside = [], []
    for p in paths:
        try:
            inside.append(str(p.relative_to(root)))
        except ValueError:
            outside.append(p)
    if inside:
        trash.send_at(root, inside)
    if outside:
        sent = trash.send_os(outside)
        left = [p for p in outside if p not in sent and p.exists()]
        if left:
            raise ValueError("옛 파일을 휴지통으로 못 보내 덮어쓰지 않았습니다")


def dest_dir(root: Path, items: list[Item], mode: str, dest: str = "") -> Path | None:
    """이 설정으로 돌리면 결과가 **어느 폴더**에 쓰이나 — 만들지는 않는다.

    ★★변환(`convert`)과 화면의 「저장될 위치」 표시가 **같은 함수**를 본다 (사용자 지시 2026-09-07:
      「자동 폴더 열기」 대신 지금 옵션으로 저장될 위치와 폴더 열기 단추). 따로 셈하면 보여 준 자리와
      실제로 쓴 자리가 갈린다. 모르면 None (자리를 모르는 그림뿐인데 폴더도 안 골랐을 때)."""
    if mode == "folder":
        if not dest:
            return None
        p = Path(dest)
        return p if p.is_absolute() else files_mod.under(root, dest)
    first = next((_src_of(root, it) for it in items if _src_of(root, it)), None)
    if first is None:
        return None
    return first.parent / SUB_DIR if mode == "sub" else first.parent


def convert(
    root: Path,
    items: list[Item],
    fmt: str = "png",
    quality: int = 95,
    strip_metadata: bool = False,
    prefix: str | None = None,
    start: int = 1,
    pad: int = 3,
    dest: str = "",
    open_folder: bool = False,
    mode: str = "sub",
) -> dict:
    """변환 + (원하면) 일괄 이름 바꾸기.

    저장 자리는 `mode` 가 정한다 (위 `MODES`). `folder` 는 아웃풋 루트 아래 `dest` 폴더에
    모은다 — 브라우저에서 떨군 것처럼 **원본 자리를 모르는** 경우의 유일한 방법이다.

    ★★`overwrite` 만이 **원본을 없앤다.** 그래도 지우지 않고 **휴지통으로 보낸다**
      (`backend/trash.py`) — 이 모듈의 나머지가 지키는 「원본을 지키다」와 같은 뜻이고,
      잘못 눌렀을 때 되돌릴 길이 있어야 한다. 형식을 바꿔 덮으면 확장자가 달라지므로
      **옛 파일은 휴지통으로 가고 새 확장자의 파일이 그 자리에 선다.**
    ★이름 번호는 **받은 차례**를 따른다 (v2 `generateNewFilename`: `<접두><번호>.<확장자>`,
      자릿수 0 이면 그대로). 정렬을 여기서 바꾸지 않는다 — 목록을 정한 것은 화면이다.
    """
    if mode not in MODES:
        raise ValueError("모르는 저장 자리입니다")
    # ★★`dest` 는 `folder` 에서만 뜻이 있다. 조용히 무시하면 「폴더를 골랐는데 딴 데 저장됐다」가
    #   되므로 여기서 거절한다 (부르는 쪽이 갈래에 맞게 비워 보낸다).
    if dest and mode != "folder":
        raise ValueError("저장 폴더는 「저장 폴더 지정」에서만 씁니다")
    # ★★내는 형식은 **PNG·WebP 둘뿐**이다 (사용자 결정 2026-08-23) — 공홈과 같다.
    #   JPG 는 **읽기만** 한다 (밖에서 온 그림). 낼 때 쓰면 투명이 사라지고 픽셀이 뭉개진다.
    fmt = (fmt or "png").lower()
    if fmt not in ("png", "webp"):
        raise ValueError("지원하지 않는 형식입니다")

    # ★자리는 `dest_dir` 이 정한다 (화면의 「저장될 위치」와 같은 함수).
    #   `folder`: 고른 경로가 **절대 경로**면 그대로 — 윈도우 폴더 찾기로 고른 것이라 아웃풋 루트 밖일 수
    #   있다 (`files.pick_dir` 의 ★주). `sub`: **첫 그림이 있는 폴더 아래에 하나만** (사용자 지시 2026-08-23) —
    #   예전에는 그림마다 자기 폴더 밑에 `output/` 을 만들어 결과가 폴더마다 흩어졌다.
    out_dir: Path | None = None
    if mode in ("folder", "sub"):
        out_dir = dest_dir(root, items, mode, dest)
        if out_dir is not None:
            out_dir.mkdir(parents=True, exist_ok=True)

    results = []
    for i, it in enumerate(items):
        name = it.get("name") or f"image_{i + 1}"
        try:
            data, src = _read(root, it)
            if strip_metadata:
                blob = meta_mod.strip(data, fmt, quality)
            else:
                # ★메타데이터를 **옮겨 준다** — 그림만 남고 설정을 잃으면 재생성이 끊긴다
                raw = meta_mod.read_raw(data)
                import io

                with Image.open(io.BytesIO(data)) as im:
                    chunks = dict(im.info)
                blob = meta_mod.write(data, raw, fmt, quality, chunks)

            # ★자리를 모르는 것(브라우저 드롭)은 `folder` 로만 받을 수 있다
            if mode == "folder":
                d = out_dir
            elif src is None:
                raise ValueError("저장할 폴더를 정해 주세요")
            elif mode == "sub":
                d = out_dir  # 첫 그림 아래에 만들어 둔 그 폴더 (위)
            else:  # overwrite
                d = src.parent
            if d is None:
                raise ValueError("저장할 폴더를 정해 주세요")
            ext = fmt
            if prefix is not None:
                num = str(start + i).zfill(max(0, pad))
                stem = f"{prefix}{num}"
            else:
                stem = Path(name).stem
            if mode == "overwrite" and src is not None:
                # ★★옛 파일을 **휴지통으로** 보내고 그 자리에 쓴다. 이름을 함께 바꾸면
                #   새 이름으로 서고, 그 자리에 다른 파일이 있으면 그것도 함께 물러난다.
                dst = d / f"{stem}.{ext}"
                gone = [p for p in {src, dst} if p.exists()]
                if gone:
                    _retire(root, gone)
                dst.write_bytes(blob)
                results.append({"name": name, "saved": dst.name, "dir": str(dst.parent),
                                "replaced": True, "ok": True})
                continue
            dst = _free(d, stem, ext)
            dst.write_bytes(blob)
            results.append({"name": name, "saved": dst.name, "dir": str(dst.parent), "ok": True})
        except Exception as e:  # 한 장이 깨져도 나머지는 간다
            # ★★**까닭이 빈 예외가 있다** (인자 없이 만든 예외 · `MemoryError`). 그대로 실으면
            #   화면에 「실패」만 뜨고 무엇이 막혔는지 알 길이 없다 — 클래스 이름으로라도 채운다.
            # ★로그에도 남긴다: 화면의 한 줄은 사용자가 옮겨 적어 줘야 하지만 로그는 파일에 남아
            #   (`logs/peropix.log`) 다음 제보 때 앞뒤를 맞출 수 있다.
            why = str(e) or e.__class__.__name__
            print(f"[변환] 실패 {name}: {why}", flush=True)
            results.append({"name": name, "error": why, "ok": False})

    # ★「완료 후 폴더 열기」 (v2 `convertOpenFolder`). 여는 것은 **방금 우리가 쓴 자리**뿐이라
    #   사용자가 준 경로를 그대로 여는 창구를 새로 열지 않는다 (files.open_dir 주석).
    if open_folder:
        for r in results:
            if r["ok"]:
                files_mod.open_dir(Path(r["dir"]))
                break
    return {"results": results, "ok": sum(1 for r in results if r["ok"])}


def read_meta(root: Path, it: Item) -> dict:
    """EXIF 리더 — **읽기만.** 파일을 저장하지도, 고치지도 않는다.

    내부 형식(`meta.normalize`)에 화면이 쓰는 셋을 얹어 준다:

        kind     형식 배지 (nai · peropix · comfyui · vibe · custom)
        preview  줄인 그림 — 앱에는 경로만 와서 화면이 원본을 가리킬 주소가 없다
        extra    우리가 다른 칸으로 안 보여 주는 tEXt 청크 (v2 「Raw Metadata」)

    ★`full` 을 켜면 **원본 바이트**(`data`)와 바이브 인코딩(`vibe.data`)도 얹는다 —
      드롭 가져오기가 그것으로 베이스 이미지·바이브를 만든다.
    """
    data, _ = _read(root, it)
    raw = meta_mod.read_raw(data)
    out = meta_mod.normalize(raw) or {}
    info: dict = {}
    try:
        with Image.open(io.BytesIO(data)) as im:
            info = {k: v for k, v in im.info.items() if isinstance(v, (str, int, float))}
            if out.get("width") is None:
                out["width"] = im.width
            if out.get("height") is None:
                out["height"] = im.height
    except Exception:
        pass
    out["kind"] = meta_mod.kind_of(raw, info)
    out["preview"] = _thumb(data, PREVIEW_MAX)
    out["bytes"] = len(data)
    if out["kind"] == "vibe":
        out["vibe"] = {
            "model": str(info.get("model") or ""),
            "strength": str(info.get("strength") or ""),
            "info_extracted": str(info.get("info_extracted") or ""),
        }
    # ★★`full` 은 **드롭 가져오기**가 켠다 (EXIF 리더는 안 켠다).
    #   앱(Tauri)에는 경로만 와서 화면에 원본 바이트가 없는데, 떨군 그림을 베이스 이미지나
    #   바이브로 넣으려면 그 바이트가 있어야 한다. `preview` 는 320px JPEG 이라 못 쓴다.
    #   ★재인코딩하지 않고 **파일 그대로** 준다 (v2 `fileToBase64` 와 같다) — 다시 구우면
    #     바이브 캐시 키가 달라져 이미 구워 둔 인코딩을 못 알아본다.
    if it.get("full"):
        out["data"] = base64.b64encode(data).decode("ascii")
        # ★바이브 캐시 PNG 는 tEXt 에 **인코딩 자체**를 들고 있다 — 그것을 그대로 쓰면
        #   다시 굽지 않아 Anlas 가 안 나간다 (`vibe.py` 의 `put`).
        if out["kind"] == "vibe":
            out["vibe"]["data"] = str(info.get("vibe_data") or "")
    # ★500자에서 자른다 — 화면에 통째로 쏟으면 읽을 수 없다 (v2 도 같은 자리에서 잘랐다)
    out["extra"] = {k: str(v)[:500] for k, v in info.items() if k not in SHOWN_CHUNKS}
    return out
