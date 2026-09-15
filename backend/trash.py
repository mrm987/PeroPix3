"""휴지통 — **지우면 진짜 없어지되, 되돌릴 수는 있게** (사용자 결정 2026-08-05).

    지움 →  <뿌리>/.trash/<파일 이름>   +  <뿌리>/.trash/index.jsonl 에 한 줄
    되돌림 → 원래 자리로 (그 사이 같은 이름이 생겼으면 번호를 붙인다)
    비움  →  **앱을 켤 때** 24시간 지난 것

★왜 종료가 아니라 시작인가: 강제 종료·크래시에서는 종료 처리가 안 돌아 휴지통이 영영 남는다.
  시작은 반드시 한 번 돈다.
★왜 유예를 두는가: 생성물은 Anlas 가 든 원본이다. "지우고 껐다 켰는데 필요했다" 를 한 번은
  살릴 수 있어야 한다. 파일 관리에서 `.trash` 를 열어 직접 꺼내거나 비울 수도 있다.
★★**파일은 평평하게, 경로는 장부에** (사용자 지시 2026-08-23).
  예전에는 `<지운 시각>/<원래 상대경로>` 로 폴더를 통째로 다시 지어서, 휴지통을 열면
  한 장을 보려고 폴더를 대여섯 겹 파고 들어가야 했다 — 윈도우 휴지통도 파일만 늘어놓고
  원래 자리는 따로 적어 둔다. 우리도 그렇게 한다:
    · 파일은 `.trash/` 바로 아래에 **원래 이름 그대로** (겹치면 번호를 붙인다)
    · 원래 자리·지운 시각은 `index.jsonl` 한 줄에
  ★★비우는 판정도 **장부의 시각**으로 한다 — 옮긴 파일은 mtime 이 **원본 시각 그대로**라
    그것으로 세면 옛날에 만든 그림이 버리자마자 사라진다.
  ★옛 묶음 폴더(`<지운 시각>/…`)도 그대로 되돌아가고 비워진다 — 이미 버려 둔 것이 있다.

★★**지우는 창구는 전부 여기를 지난다** (사용자 결정 2026-08-18, `docs/v2-port-audit.md` D7).
  예전에는 캔버스의 `Del` 만 휴지통을 썼고 파일 관리·갤러리·바이브 캐시는 바로 지웠다.
  뿌리가 저마다 다르므로(`workspaces/<ws>` · `workspaces` · `gallery` · `data/cards` …)
  **뿌리를 받는 함수**(`*_at`)가 본체이고, 워크스페이스용 `send`·`restore` 는 그 껍데기다.

★★**폴더도 담는다** (같은 결정). `shutil.move` 는 폴더를 통째로 옮기므로 담는 쪽은 파일과
  같고, 되돌릴 때도 같은 상대경로로 돌아온다. 이것이 없으면 파일 관리의 폴더 삭제
  (`rmtree`)만 되돌릴 수 없는 구멍으로 남는다.
"""
from __future__ import annotations

import json
import re
import shutil
import sys
import time
from datetime import datetime
from pathlib import Path

TRASH = ".trash"
#: 휴지통 장부 — 원래 자리와 지운 시각이 여기 적힌다 (머리 주석)
INDEX = "index.jsonl"
KEEP_HOURS = 24
#: 묶음 폴더 이름 (`send_at` 이 찍는다). 옛 자리 이전이 이것으로 새 묶음을 가려낸다
STAMP = re.compile(r"^\d{8}_\d{6}$")


def trash_root(base: Path) -> Path:
    """그 뿌리의 휴지통. ★워크스페이스는 **자기 안**에 둔다 (사용자 지시 2026-08-08) —
    워크스페이스를 지우면 휴지통도 함께 사라지고, `workspaces/` 를 열면 워크스페이스만 보인다."""
    return base / TRASH


def _inside(base: Path, rel: str) -> Path | None:
    """뿌리 안의 경로로 풀어 준다. **밖을 가리키면 None** (`files.under` 와 같은 규칙)."""
    rel = (rel or "").strip().strip("/")
    if not rel:
        return None
    b = base.resolve()
    p = (b / rel).resolve()
    if p == b or b not in p.parents:
        return None
    return p


#: 잠긴 파일은 대개 곧 풀린다 — 이 간격(초)으로 다시 해 본다 (`_hard_move` 의 ★★주).
#: ★예산을 넉넉히 잡으면 **안 풀리는 잠금**에서 삭제가 몇 초씩 멈춘다 (실측: 1.55초짜리
#:   예산이 재귀와 겹쳐 9.4초가 됐다). 앱이 쥔 손잡이는 밀리초 단위로 풀리므로 이 정도면 된다.
RETRY = (0.05, 0.1, 0.2)
#: 지우기 확인은 더 짧게 — 옮기기가 이미 한 차례 기다린 뒤다
RETRY_RM = (0.05, 0.1)


def _free(dst: Path) -> Path:
    """같은 이름이 있으면 **덮지 않고** 번호를 붙인다 — 생성물은 Anlas 가 든 원본이다.
    ★폴더에도 그대로 먹는다 (`suffix` 가 빈 문자열일 뿐이다)."""
    n = 1
    while dst.exists():
        dst = dst.with_name(f"{dst.stem}_{n}{dst.suffix}")
        n += 1
    return dst


# ── 뿌리를 받는 본체 ──────────────────────────────────────────────
def read_index(root: Path) -> list[dict]:
    """휴지통 장부 — `{file(원래 자리), at(휴지통 안 이름), ts(지운 시각)}` 줄들.
    ★깨진 줄은 건너뛴다. 장부가 없어도 빈 목록이다 (옛 휴지통은 장부가 없다)."""
    f = root / INDEX
    if not f.is_file():
        return []
    out = []
    for line in f.read_text(encoding="utf-8", errors="replace").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            row = json.loads(line)
        except Exception:
            continue
        if isinstance(row, dict) and row.get("at"):
            out.append(row)
    return out


def _write_index(root: Path, rows: list[dict]) -> None:
    tmp = root / (INDEX + ".tmp")
    tmp.write_text("".join(json.dumps(r, ensure_ascii=False) + "\n" for r in rows), encoding="utf-8")
    tmp.replace(root / INDEX)


def _gone(p: Path) -> bool:
    """지우고 **정말 없어졌는지** 돌려준다 (`_hard_move` 의 ★★주)."""
    for wait in RETRY_RM:
        if not p.exists():
            return True
        try:
            if p.is_dir():
                shutil.rmtree(p, ignore_errors=True)
            else:
                p.unlink(missing_ok=True)
        except OSError:
            pass
        if not p.exists():
            return True
        time.sleep(wait)
    return not p.exists()


def _hard_move(src: Path, dst: Path) -> bool:
    """휴지통으로 옮기고 **원래 자리를 비운다.** 비웠으면 True.

    ★★**`shutil.move` 를 그대로 쓰면 안 된다** (사용자 지적 2026-09-15: *"삭제해도 워크스페이스가
      그자리에 있고 그 안에 트래시 폴더가 생김 · 재실행하면 폴더가 남아서 계속 되살아남"*).
      윈도우에서는 폴더 안의 파일 **하나만 열려 있어도** 이름 바꾸기가 거부된다 — 앱이 그림을
      읽거나 썸네일을 굽는 중이면 늘 그렇다. 그러면 `shutil.move` 는 **복사한 뒤 지우기**로
      물러나는데, 복사는 되고 지우기가 `PermissionError` 로 터진다. 그 예외가 그대로 올라가
      **워크스페이스가 휴지통과 원래 자리 양쪽에 남는다** — 목록은 폴더를 보고 만들어지므로
      지운 것이 앱을 다시 켤 때마다 되살아난다.
      (재현: 워크스페이스 안의 그림 하나를 연 채 `Store.delete` → 예외, 양쪽에 그대로.)
    ★잠금은 대개 몇백 밀리초짜리다. 그래서 **먼저 몇 번 더 해 본다** (`RETRY`).
    ★그래도 막히면 **내용을 하나씩** 옮긴다 — 막힌 파일 하나가 나머지 전부를 붙잡지 않게.
    ★마지막까지 못 비우면 **거짓을 돌려준다.** 조용히 성공한 척하지 않는다 —
      부르는 쪽이 사용자에게 알린다.
    """
    for wait in RETRY:
        try:
            src.rename(dst)
            return True
        except OSError:
            time.sleep(wait)
    if src.is_dir():
        # 내용을 한 겹씩 내려가며 옮기고, 끝에 껍데기를 지운다
        dst.mkdir(parents=True, exist_ok=True)
        for item in list(src.iterdir()):
            _hard_move(item, _free(dst / item.name))
        return _gone(src)
    try:
        shutil.copy2(src, dst)
    except OSError:
        return False
    return _gone(src)


def send_at(base: Path, rels: list[str]) -> dict:
    """고른 것을 휴지통으로 **옮긴다**. 되돌릴 수 있게 (원래 경로, 휴지통 안 이름)을 돌려준다.

    ★파일도 폴더도 받는다. ★휴지통 자신은 못 지운다 — 지우면 되돌릴 자리가 사라진다.
    ★★평평하게 둔다 (머리 주석) — 원래 자리는 `index.jsonl` 이 기억한다.
    ★★`left` 는 **휴지통에는 담겼는데 원래 자리를 못 비운 것**이다 (`_hard_move` 의 ★★주).
      빈 목록이면 전부 깨끗이 옮겨진 것이다 — 부르는 쪽은 이것을 보고 사용자에게 알린다."""
    root = trash_root(base)
    moved, missing, rows, left = [], [], [], []
    now = datetime.now().isoformat(timespec="seconds")
    for rel in rels:
        src = _inside(base, rel)
        if src is None or not src.exists() or src == root.resolve() or root.resolve() in src.parents:
            missing.append(rel)
            continue
        root.mkdir(parents=True, exist_ok=True)
        # ★장부와 이름이 겹치면 장부를 덮어쓴다 — 그 한 이름만 비켜 간다
        name = src.name if src.name != INDEX else f"_{src.name}"
        dst = _free(root / name)
        # ★★원래 자리를 반드시 비운다 (`_hard_move` 의 ★★주)
        if not _hard_move(src, dst):
            left.append(rel)
        if not dst.exists():
            missing.append(rel)
            continue
        rows.append({"file": rel, "at": dst.name, "ts": now})
        moved.append({"file": rel, "at": dst.name})
    if rows:
        _write_index(root, read_index(root) + rows)
    # ★`left` 는 **옮기기는 했는데 원래 자리가 안 비워진 것**이다 — 부르는 쪽이 알려 준다
    return {"moved": moved, "missing": missing, "left": left}


def restore_at(base: Path, entries: list[dict]) -> dict:
    """휴지통에서 **원래 자리로**. ★그 사이 같은 이름이 생겼으면 덮지 않고 번호를 붙인다.

    ★`pairs` 로 **어디서 어디로** 갔는지 함께 준다 — 이름이 바뀌었을 때 곁장부(별표·캐시 키)를
      새 경로로 따라 보내려면 부르는 쪽이 짝을 알아야 한다."""
    root = trash_root(base)
    back, missing, pairs = [], [], []
    taken: set[str] = set()
    for e in entries:
        rel = str(e.get("file", ""))
        at = _inside(root, str(e.get("at", "")))
        dst_base = _inside(base, rel)
        if at is None or not at.exists() or dst_base is None:
            missing.append(rel)
            continue
        dst = _free(dst_base)
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.move(str(at), str(dst))
        now = dst.relative_to(base.resolve()).as_posix()
        back.append(now)
        pairs.append({"file": rel, "to": now})
        taken.add(str(e.get("at", "")))
        # ★옛 묶음 폴더에서 꺼낸 것이면 **빈 껍데기를 치운다** (지금 것은 평평해서 껍데기가
        #   없다). 묶음 폴더와 휴지통 자신까지 올라가되, 비어 있지 않으면 그 자리에서 멈춘다
        d, top = at.parent, root.resolve()
        while top in d.parents:
            try:
                d.rmdir()
            except OSError:
                break
            d = d.parent
    if taken:
        # ★되돌린 줄은 장부에서 뺀다 — 남겨 두면 비우기가 없는 파일을 찾아 헤맨다
        rows = [r for r in read_index(root) if r.get("at") not in taken]
        if root.is_dir():
            _write_index(root, rows)
    return {"restored": back, "missing": missing, "pairs": pairs}


def sweep_at(base: Path, hours: int = KEEP_HOURS) -> list[str]:
    """그 뿌리의 휴지통에서 오래된 것을 비운다. 지운 이름을 돌려준다 (로그용).

    ★★판정은 **장부의 시각**이다 (머리 주석). 옮긴 파일의 mtime 은 **원본이 만들어진 때**라,
      그것으로 세면 예전에 만든 그림이 버리자마자 사라진다.
    ★장부에 없는 것은 안 건드린다 — 사람이 직접 넣어 둔 것일 수 있다.
    ★옛 묶음 폴더(`<지운 시각>/…`)는 예전 규칙대로 폴더 시각으로 비운다."""
    root = trash_root(base)
    if not root.is_dir():
        return []
    cutoff = time.time() - hours * 3600
    gone = []

    rows, keep = read_index(root), []
    for r in rows:
        try:
            old = datetime.fromisoformat(str(r.get("ts", ""))).timestamp() <= cutoff
        except Exception:
            old = False
        p = root / str(r.get("at", ""))
        if not old:
            keep.append(r)
            continue
        try:
            if p.is_dir():
                shutil.rmtree(p)
            elif p.exists():
                p.unlink()
            gone.append(p.name)
        except OSError:
            keep.append(r)
    if len(keep) != len(rows):
        _write_index(root, keep)

    # 옛 묶음 폴더 — 이름이 `20260823_101500` 꼴인 것만 (사람이 만든 폴더는 안 건드린다)
    for batch in root.iterdir():
        if not batch.is_dir() or not STAMP.match(batch.name):
            continue
        try:
            if batch.stat().st_mtime > cutoff:
                continue
            shutil.rmtree(batch)
            gone.append(batch.name)
        except OSError:
            continue
    return gone


def send_os(paths: list[Path]) -> list[Path]:
    """**앱 바깥의 파일**을 OS 휴지통으로 보낸다. 보낸 것만 돌려준다.

    ★★왜 따로 있나: 이 모듈의 휴지통은 **뿌리 안**의 것만 다룬다 (장부가 상대경로다).
      그런데 일괄 변환은 탐색기에서 끌어다 놓은 **아무 자리의 파일**도 받는다 —
      그것을 덮어쓸 때 원본을 앱 안으로 끌고 들어오면 사용자는 자기 폴더에서 파일이
      사라진 것으로만 보이고, 앱을 지우면 함께 사라진다. **사용자가 아는 자리**로 보낸다.
    ★win32 밖에서는 아무것도 안 한다 (빈 목록) — 부르는 쪽이 그때는 덮어쓰지 않는다.
      조용히 지우는 길을 만들지 말 것: 되돌릴 수 없는 삭제가 된다.
    ★`SHFileOperationW` 의 `FOF_ALLOWUNDO` 가 「휴지통으로」다. 목록은 NUL 로 잇고
      **끝을 하나 더** 둔다 (그 API 의 규약)."""
    if sys.platform != "win32" or not paths:
        return []
    import ctypes
    from ctypes import wintypes

    class SHFILEOPSTRUCTW(ctypes.Structure):
        _fields_ = [
            ("hwnd", wintypes.HWND),
            ("wFunc", wintypes.UINT),
            ("pFrom", wintypes.LPCWSTR),
            ("pTo", wintypes.LPCWSTR),
            ("fFlags", ctypes.c_uint16),
            ("fAnyOperationsAborted", wintypes.BOOL),
            ("hNameMappings", ctypes.c_void_p),
            ("lpszProgressTitle", wintypes.LPCWSTR),
        ]

    NUL = chr(0)  # ★목록 구분자 — 소스에 날바이트를 넣지 않는다
    FO_DELETE, FOF_ALLOWUNDO, FOF_NOCONFIRMATION, FOF_SILENT, FOF_NOERRORUI = 3, 0x40, 0x10, 0x4, 0x400
    joined = NUL.join(str(p) for p in paths) + NUL + NUL
    op = SHFILEOPSTRUCTW(
        None, FO_DELETE, joined, None,
        FOF_ALLOWUNDO | FOF_NOCONFIRMATION | FOF_SILENT | FOF_NOERRORUI, False, None, None,
    )
    try:
        rc = ctypes.windll.shell32.SHFileOperationW(ctypes.byref(op))
    except Exception as e:
        print(f"[trash] OS 휴지통으로 못 보냈습니다 ({e})")
        return []
    if rc != 0:
        print(f"[trash] OS 휴지통이 거절했습니다 (코드 {rc})")
        return []
    return [p for p in paths if not p.exists()]


# ── 워크스페이스 껍데기 ───────────────────────────────────────────
def send(store, ws: str, files: list[str]) -> dict:
    """워크스페이스 안의 그림을 휴지통으로 (캔버스의 `Del`)."""
    return send_at(store.dir_of(ws), files)


def restore(store, ws: str, entries: list[dict]) -> dict:
    return restore_at(store.dir_of(ws), entries)


def listing(base: Path, limit: int = 50) -> list[dict]:
    """휴지통에 **지금 들어 있는 것** — 최근에 버린 것부터 (선결 조건 3-9, 2026-08-24).

    ★★왜 필요한가: 되살리기(`restore_at`)는 **지울 때 받은 항목**(`{file, at}`)을 그대로
      요구한다. 화면은 그것을 손에 쥐고 있다가 「되돌리기」에 넘기지만, 조수는 그 자리에
      없었으므로 **목록이 없으면 영영 되살릴 수 없다.**
    ★장부에 있어도 파일이 이미 없으면(비웠거나 사람이 꺼냄) 뺀다 — 못 되살릴 것을 보여
      주면 조수가 「되살렸습니다」라고 말하게 된다.
    ★`file`·`at` 을 그대로 실어 준다: 조수가 되살릴 때 **고른 줄을 그대로** 넘기면 된다."""
    root = trash_root(base)
    out = []
    for row in reversed(read_index(root)):
        at = _inside(root, str(row.get("at", "")))
        if at is None or not at.exists():
            continue
        out.append({
            "file": row.get("file"),      # 원래 자리 (되살아날 곳)
            "at": row.get("at"),          # 휴지통 안 이름 — 되살리기가 요구하는 값
            "ts": row.get("ts"),          # 버린 시각 (24시간 뒤 자동으로 비워진다)
        })
        if len(out) >= max(1, limit):
            break
    return out


def sweep(ws_root: Path, hours: int = KEEP_HOURS) -> list[str]:
    """**앱을 켤 때** 오래된 것을 비운다.

    ★휴지통이 워크스페이스마다 있으므로 전부 훑고, `workspaces/` 자체의 휴지통
      (파일 관리·워크스페이스 삭제가 쓴다)도 함께 본다."""
    if not ws_root.exists():
        return []
    gone = [f"{TRASH}/{b}" for b in sweep_at(ws_root, hours)]
    for ws_dir in ws_root.iterdir():
        if not ws_dir.is_dir() or ws_dir.name == TRASH:
            continue
        gone += [f"{ws_dir.name}/{b}" for b in sweep_at(ws_dir, hours)]
        # ★**빈 휴지통만 남은 껍데기**도 치운다 (사용자 지적 2026-09-15). `rmdir` 은 완전히 빈
        #   폴더만 지우므로, 안이 다 비워진 뒤에도 `.trash` 한 겹 때문에 지운 워크스페이스가
        #   목록에 계속 섰다. ★내용이 조금이라도 남은 휴지통은 건드리지 않는다 — 되살릴 것이 있다.
        t = trash_root(ws_dir)
        if t.is_dir() and not any(t.iterdir()) and [x for x in ws_dir.iterdir()] == [t]:
            try:
                t.rmdir()
            except OSError:
                pass
        try:
            ws_dir.rmdir()  # 통째로 비었으면 껍데기도 치운다
        except OSError:
            pass
    return gone
