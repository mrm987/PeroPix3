"""파일 관리 — **아웃풋 폴더를 그대로** 다루는 자리 (v2 `보조 도구 › 파일 관리`).

갤러리(`keep.py`)와 헷갈리지 말 것. 둘은 보는 대상이 다르다:

    keep.py     골라 둔 것        <APP>/gallery/           "남길 것만"
    files.py    아웃풋 폴더 전부   outputs/                 "디스크에 있는 그대로"

★여기는 **탐색기**다 — 워크스페이스 경계를 넘어 폴더 트리를 그대로 보여주고, 옮기고,
  이름을 바꾸고, 지운다. 그래서 경로는 워크스페이스가 아니라 **아웃풋 루트 기준**이다.
★한 발짝도 루트 밖으로 못 나간다 (`under`). 밖을 가리키면 즉시 ValueError.
★지우는 것은 **받은 목록만.** 자동 정리·기간 만료를 만들지 말 것 (keep.delete 주석과 같은 이유).
★★지우기는 **휴지통을 거친다** (사용자 결정 2026-08-18, v2-port-audit D7). 폴더도 마찬가지다 —
  예전에는 폴더면 `rmtree` 라 되돌릴 길이 아예 없었다. 휴지통은 `workspaces/.trash` 다
  (경로가 `<워크스페이스>/…` 로 시작하므로 되돌릴 자리가 경로에 그대로 적힌다).
"""
from __future__ import annotations

import os
import shutil
import subprocess
import sys
from pathlib import Path

import trash

IMG_EXT = {".png", ".jpg", ".jpeg", ".webp"}
# 파생 캐시 — 사람이 만든 폴더가 아니다. 트리에 나오면 헷갈리기만 한다
SKIP = {".thumbs", ".thumbnails"}
# 휴지통만은 트리에 보인다 (backend/trash.py)
TRASH_DIR = ".trash"


def under(root: Path, rel: str) -> Path:
    """루트 안의 경로로 풀어 준다. **밖을 가리키면 거절한다.**"""
    base = root.resolve()
    p = (base / (rel or "")).resolve()
    if p != base and base not in p.parents:
        raise ValueError("아웃풋 폴더 밖입니다")
    return p


def _count(d: Path) -> int:
    """그 폴더에 **직접** 든 그림 수 (하위 폴더는 따로 센다)."""
    try:
        return sum(1 for f in d.iterdir() if f.is_file() and f.suffix.lower() in IMG_EXT)
    except OSError:
        return 0


def tree(root: Path) -> dict:
    """폴더 트리 — 재귀. ★빈 폴더도 낸다: 여기서는 **옮길 자리**로 쓴다."""

    def scan(d: Path, prefix: str) -> list[dict]:
        out = []
        try:
            items = sorted(d.iterdir(), key=lambda p: p.name.lower())
        except OSError:
            return out
        for it in items:
            # ★휴지통은 **보여 준다** — 직접 꺼내거나 비울 수 있어야 한다 (trash.py 머리 주석).
            #   나머지 점 폴더(썸네일 캐시 등)는 사람이 만든 것이 아니라 감춘다.
            if not it.is_dir() or it.name in SKIP or (it.name.startswith(".") and it.name != TRASH_DIR):
                continue
            rel = f"{prefix}/{it.name}" if prefix else it.name
            out.append({"name": it.name, "path": rel, "count": _count(it), "children": scan(it, rel)})
        return out

    root.mkdir(parents=True, exist_ok=True)
    return {"count": _count(root), "tree": scan(root, "")}


def listdir(root: Path, rel: str = "", page: int = 1, limit: int = 0) -> dict:
    """그 폴더의 그림 — **하위 폴더는 빼고.** 트리가 이미 계층을 보여주므로 섞을 이유가 없다.

    ★**쪽으로 끊어 준다** (keep.images 와 같은 규칙). `limit=0` 이면 전량."""
    d = under(root, rel)
    if not d.is_dir():
        return {"items": [], "total": 0, "page": 1, "pages": 1}
    files = sorted(
        (p for p in d.iterdir() if p.is_file() and p.suffix.lower() in IMG_EXT),
        key=lambda x: x.name.lower(),
    )
    total = len(files)
    if limit > 0:
        pages = max(1, -(-total // limit))
        page = max(1, min(page, pages))
        files = files[(page - 1) * limit : (page - 1) * limit + limit]
    else:
        pages, page = 1, 1
    base = root.resolve()
    return {
        "items": [
            {
                "file": p.relative_to(base).as_posix(),
                "name": p.name,
                "bytes": p.stat().st_size,
                "mtime": p.stat().st_mtime,
            }
            for p in files
        ],
        "total": total,
        "page": page,
        "pages": pages,
    }


def mkdir(root: Path, parent: str, name: str) -> dict:
    name = (name or "").strip().strip(". ")
    if not name or "/" in name or "\\" in name or ".." in name:
        raise ValueError("폴더 이름이 잘못됐습니다")
    d = under(root, parent) / name
    d.mkdir(parents=True, exist_ok=True)
    return {"path": d.relative_to(root.resolve()).as_posix()}


def rename(root: Path, rel: str, new_name: str) -> dict:
    """이름 바꾸기 — 파일·폴더 둘 다. ★확장자를 빼먹으면 원래 것을 붙인다."""
    p = under(root, rel)
    if not p.exists():
        raise ValueError("없는 항목입니다")
    new_name = (new_name or "").strip()
    if not new_name or "/" in new_name or "\\" in new_name or ".." in new_name:
        raise ValueError("이름이 잘못됐습니다")
    if p.is_file() and not Path(new_name).suffix:
        new_name += p.suffix
    dst = p.with_name(new_name)
    if dst.exists() and dst != p:
        raise ValueError("같은 이름이 이미 있습니다")
    p.rename(dst)
    return {"path": dst.relative_to(root.resolve()).as_posix()}


def move(root: Path, files: list[str], dest: str) -> dict:
    """옮기기. ★같은 이름이 있으면 **덮지 않고** 번호를 붙인다 — 생성물은 Anlas 가 든 원본이다."""
    d = under(root, dest)
    d.mkdir(parents=True, exist_ok=True)
    moved, missing = [], []
    for rel in files:
        try:
            src = under(root, rel)
        except ValueError:
            missing.append(rel)
            continue
        if not src.exists():
            missing.append(rel)
            continue
        target = d / src.name
        n = 1
        while target.exists():
            target = d / f"{src.stem}_{n}{src.suffix}"
            n += 1
        if src.resolve() == target.resolve():
            continue
        shutil.move(str(src), str(target))
        moved.append(target.relative_to(root.resolve()).as_posix())
    return {"moved": moved, "missing": missing}


def delete(root: Path, files: list[str]) -> dict:
    """지우기 = **휴지통으로 이동** (사용자 결정 2026-08-18).

    ★폴더도 통째로 담긴다 — 되돌리면 안에 든 것까지 그대로 돌아온다.
    ★`trashed` 를 함께 돌려준다: 화면이 그것을 들고 있다가 「되돌리기」로 `restore` 에 넘긴다."""
    r = trash.send_at(root, files)
    return {"deleted": [m["file"] for m in r["moved"]], "missing": r["missing"], "trashed": r["moved"]}


def restore(root: Path, entries: list[dict]) -> dict:
    """휴지통에서 원래 자리로 (「되돌리기」)."""
    return trash.restore_at(root, entries)


def _to_front(folder: Path) -> None:
    """열려 있는 탐색기 창을 **앞으로**. 못 찾으면 조용히 넘어간다.

    ★★COM(`Shell.Application`)으로 훑지 않는다 (사용자 지적 2026-08-19: 느렸다) —
      `EnumWindows` 로 **최상위 창만** 훑는다. 창 목록은 수십 개라 눈 깜짝할 새다.
    ★탐색기 창의 제목은 **폴더 이름**이다 (클래스 `CabinetWClass`). 이름만 맞으면 앞으로 낸다.
    ★포커스 제한은 `AttachThreadInput` 으로 넘는다 (v2 와 같은 수법, 다만 창 찾기가 싸다)."""
    if sys.platform != "win32":
        return
    try:
        import ctypes
        from ctypes import wintypes

        u = ctypes.windll.user32
        want = folder.name or str(folder)
        found = []

        @ctypes.WINFUNCTYPE(ctypes.c_bool, wintypes.HWND, wintypes.LPARAM)
        def each(hwnd, _):
            cls = ctypes.create_unicode_buffer(64)
            u.GetClassNameW(hwnd, cls, 64)
            if cls.value != "CabinetWClass":
                return True
            n = u.GetWindowTextLengthW(hwnd)
            buf = ctypes.create_unicode_buffer(n + 1)
            u.GetWindowTextW(hwnd, buf, n + 1)
            if buf.value == want:
                found.append(hwnd)
                return False
            return True

        u.EnumWindows(each, 0)
        if not found:
            return
        hwnd = found[0]
        if u.IsIconic(hwnd):
            u.ShowWindow(hwnd, 9)  # SW_RESTORE
        fore = u.GetForegroundWindow()
        mine = u.GetWindowThreadProcessId(hwnd, None)
        other = u.GetWindowThreadProcessId(fore, None)
        if mine != other:
            u.AttachThreadInput(mine, other, True)
            u.BringWindowToTop(hwnd)
            u.SetForegroundWindow(hwnd)
            u.AttachThreadInput(mine, other, False)
        else:
            u.BringWindowToTop(hwnd)
            u.SetForegroundWindow(hwnd)
    except Exception as e:  # 앞으로 못 내도 창은 열려 있다
        print(f"[reveal] 앞으로 가져오지 못했습니다 ({e})")


def _select_in_explorer(f: Path) -> bool:
    """그 파일을 **고른 채로** 폴더를 연다. 됐으면 True.

    ★★`explorer /select,` 를 쓰지 않는다 (사용자 지적 2026-08-19: 느렸다) — 그것은
      **탐색기 프로세스를 새로 띄우고 창도 새로 만든다.** `SHOpenFolderAndSelectItems` 는
      셸에 직접 부탁하는 것이라 **열려 있는 창을 다시 쓰고** 곧바로 뜬다.
    ★COM 은 **이 스레드에서** 열고 닫는다 (요청은 워커 스레드에서 돈다, `server.files_reveal`)."""
    if sys.platform != "win32":
        return False
    try:
        import ctypes

        ole32 = ctypes.windll.ole32
        shell32 = ctypes.windll.shell32
        ole32.CoInitialize(None)
        try:
            shell32.ILCreateFromPathW.restype = ctypes.c_void_p
            pidl = shell32.ILCreateFromPathW(ctypes.c_wchar_p(str(f)))
            if not pidl:
                return False
            try:
                # (폴더 pidl, 고를 것 수, 고를 것들, 플래그) — 파일 하나면 그 파일의 pidl 로 족하다
                shell32.SHOpenFolderAndSelectItems(ctypes.c_void_p(pidl), 0, None, 0)
            finally:
                shell32.ILFree(ctypes.c_void_p(pidl))
        finally:
            ole32.CoUninitialize()
        return True
    except Exception as e:  # 안 되면 폴더만 여는 쪽으로 떨어진다
        print(f"[reveal] 파일을 고른 채로 열지 못했습니다 ({e})")
        return False


def _open(p: Path, select: bool) -> None:
    """탐색기에서 그 자리를 연다. `select` 면 **그 파일을 고른 채로**.

    ★★`explorer /select,` 는 안 쓴다 — 프로세스와 창을 새로 띄워 눈에 띄게 느렸다
      (`_select_in_explorer` 주석). 셸 API 로 부탁하면 열려 있는 창을 다시 쓴다.
    ★연 뒤 **앞으로 낸다** — 그냥 열면 뒤에서 열린다 (`_to_front`)."""
    target = p if p.is_dir() else p.parent
    if sys.platform == "win32":
        try:
            import ctypes

            ctypes.windll.user32.AllowSetForegroundWindow(-1)  # ASFW_ANY
        except Exception:
            pass
        if not (select and p.is_file() and _select_in_explorer(p)):
            os.startfile(str(target))  # noqa: S606
        _to_front(target)
    elif sys.platform == "darwin":
        subprocess.Popen(["open", "-R", str(p)] if select and p.is_file() else ["open", str(target)])
    else:
        subprocess.Popen(["xdg-open", str(target)])


def reveal(root: Path, rel: str = "") -> None:
    """탐색기에서 그 자리를 연다. ★파일이면 **고른 채로** 연다 (v2 와 같은 동작).

    ★★없는 자리면 **있는 데까지** 올라가 연다 (사용자 지적 2026-08-19: 저장 자리를 여는
      단추가 400 이었다). 저장 폴더는 **첫 그림이 나올 때 생기므로**, 아직 안 만든 씬에서는
      없는 것이 정상이다. 그때 열 것이 없다고 세우는 것보다 워크스페이스 폴더를 열어 주는
      편이 쓸모 있다. ★뿌리 밖으로는 절대 안 나간다 (`under` 가 이미 막는다)."""
    p = under(root, rel)
    while not p.exists() and p != root and root in p.parents:
        p = p.parent
    if not p.exists():
        raise ValueError("없는 항목입니다")
    _open(p, True)


def open_dir(p: Path) -> None:
    """폴더를 연다. ★`reveal` 과 달리 루트 밖도 연다 — 부르는 쪽이 **방금 자기가 쓴 자리**를
    넘길 때만 쓴다 (변환의 「완료 후 폴더 열기」). 사용자가 준 경로를 그대로 넣지 말 것."""
    if p.is_dir():
        _open(p, False)


def pick_dir(start: str = "") -> str | None:
    """윈도우 **폴더 찾기** 창을 띄우고 고른 경로를 돌려준다. 취소하면 `None`.

    ★★**자식 프로세스로 띄운다.** Tk 는 자기 루프를 돌고 메인 스레드를 요구해서, 서버 안에서
      열면 창이 뜨는 동안 서버가 통째로 멈춘다 (그 사이 화면의 다른 요청이 전부 밀린다).
    ★★고른 경로는 **아웃풋 루트 밖일 수 있다** — 그게 이 창을 두는 이유다 (사용자 지시
      2026-08-23: 드롭다운 말고 윈도우 폴더 찾기로). 그래서 `under()` 로 가두지 않는다.
      대신 **사용자가 직접 고른 것만** 이 경로로 들어온다 — 화면이 적어 보낸 문자열은 못 쓴다.
    ★맨 앞에 세울 자리(`start`)는 부르는 쪽이 준다 (첫 그림이 있는 폴더)."""
    code = "\n".join([
        "import sys, tkinter as tk",
        "from tkinter import filedialog",
        # ★창 자체는 숨기고 대화상자만 띄운다. `-topmost` 가 없으면 앱 창 **뒤로** 열려
        #   사용자에게는 그냥 멈춘 것처럼 보인다
        "r = tk.Tk(); r.withdraw(); r.attributes('-topmost', True)",
        "p = filedialog.askdirectory(initialdir=sys.argv[1] or None)",
        "sys.stdout.write(p or '')",
    ])
    try:
        r = subprocess.run([sys.executable, "-c", code, start or ""],
                           capture_output=True, text=True, timeout=300)
    except Exception:
        return None
    out = (r.stdout or "").strip()
    return out or None
