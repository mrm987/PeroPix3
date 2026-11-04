"""워크스페이스 저장 — docs/renewal/schema.md 구현.

구조:
    workspaces/<워크스페이스>/
      workspace.json     ← spec (의도. 사람·LLM 이 편집)
      records.jsonl      ← 사실의 색인 (코드만 쓴다, append-only)
      records.db         ← 그림 한 장의 무거운 기록 (`recordsdb` 머리 주석)
      output/<탭>/<씬 그룹>/*.png         ← 생성물 = 원본. 앱이 자동으로 지우지 않는다
      output/.layout                      ← 위 배치로 옮겨졌다는 표식 (`migrate_layout`)
      output/싱글/<탭>/*.png · work/<탭>/<셀>/*.png   ← ★옛 경로. **읽기만** 한다 (아래 out_dir 주석)

★records.jsonl 은 인덱스이지 정본이 아니다. 정본은 PNG 메타데이터다.
  손상되면 이미지 폴더를 훑어 재구축할 수 있어야 한다.
"""
from __future__ import annotations

import contextlib
import copy
import hashlib
import json
import os
import re
import shutil
import threading
import time
import uuid
from contextlib import contextmanager
from datetime import datetime
from pathlib import Path

from durable import write_synced
import rebuild
import recordsdb
import thumbs
import trash

SPEC_NAME = "workspace.json"
#: ★★`workspace.json` 의 **마지막으로 온전했던 사본 한 벌** (`save` 의 ★★주). 읽지 못하면 여기서 되살린다 (`load`).
SPEC_BAK = SPEC_NAME + ".bak"
#: 사본을 새로 뜨는 간격(초) — 자동 저장은 400ms 마다 올 수 있어 저장마다 뜨면 디스크만 닳는다.
#  되살렸을 때 잃는 편집이 이 시간 안쪽이라는 뜻이기도 하다.
SPEC_BAK_EVERY = 60
RECORDS_NAME = "records.jsonl"
#: ★★**무거운 것은 따로 둔다** (사용자 결정 2026-08-22).
#:
#:  `records.jsonl` 은 화면이 워크스페이스를 열 때마다 통째로 읽는 **색인**인데, 한 줄에
#:  `resolved`(그때 NAI 로 나간 페이로드 — 바이브·베이스 그림의 base64)와 `env`(그때의 화면
#:  구조)가 같이 들어 있어 **줄당 평균 15.9KB · 883줄에 13.7MB** 였다 (실측 2026-08-22).
#:  화면이 실제로 쓰는 것은 줄당 **211B** 뿐이라 99%가 읽고 버리는 값이었고, 그래서
#:  「마지막 500줄만 읽는다」는 제한이 걸려 있었다 — 그 제한 때문에 **한 세트가 500칸의
#:  대부분을 먹으면 다른 세트의 그림이 화면에서 사라졌다** (사용자 지적).
#:
#:  ★그림 폴더에는 **아무것도 안 만든다.** 그림 한 장에 파일 하나씩 붙이면 탐색기로 그림을
#:    보는 자리가 지저분해진다 (사용자 지적) — 워크스페이스당 파일 **하나**만 는다.
#:  ★★**지금은 `records.db` 다** (사용자 결정 2026-09-30, `recordsdb` 머리 주석). 이 이름은 옛
#:    곁파일을 옮길 때만 쓴다 (`migrate_records`) — 옮긴 뒤에는 워크스페이스 휴지통으로 간다.
ENV_NAME = "records-env.jsonl"
#: 색인에서 빼고 `records.db` 로 보내는 필드
HEAVY_KEYS = ("resolved", "env", "inference")
#: ★★**별표의 이력** (사용자 결정 2026-08-28). 별표는 `workspace.json` 한 곳에만 적혀서, 그 파일이
#:  덮어써지면(실사고 2026-08-28: 다른 워크스페이스의 spec 이 이 이름으로 저장됐다) 되살릴 재료가
#:  없었다. 저장할 때 별표 목록이 **바뀌었을 때만** 한 줄 덧붙인다 — 되돌릴 때는 마지막 줄을 본다.
#:  ★spec 통째 사본(`.bak/`)을 걷어낸 까닭(`save` 의 ★★주)을 피한다: 타이핑 중 저장에는 별표가
#:    안 바뀌므로 줄이 안 는다.
STARS_NAME = "stars.jsonl"
#: 쪼개기 전 원본을 한 번 남긴다 (지워도 앱은 돈다 — 되살릴 때만 쓴다)
PRESPLIT_NAME = "records-before-split.jsonl"
OUT_DIR = "output"     # 생성물이 사는 곳 (사용자 결정 2026-08-08)
#: ★★옛 배치의 한 겹 — `output/멀티/<탭>/<씬 그룹>/` 이었다 (「싱글/멀티」로 갈리던 시절의 이름).
#:  2026-10-01 에 걷었다 (사용자 결정): 새 그림은 `output/<탭>/<씬 그룹>/` 에 앉고, 옛 그림은 부팅 때
#:  옮긴다 (`migrate_layout`). 이 이름은 그 이전과 옛 경로로 오는 요청(`_legacy_alias`)만 쓴다.
LEGACY_MULTI = "멀티"
#: 그 워크스페이스가 새 배치라는 표식 — `output/` 안의 빈 파일. ★폴더가 있느냐로 판정하면 안 된다:
#:  탭 이름이 「멀티」면 새 배치에서도 `output/멀티/` 가 생긴다.
LAYOUT_MARK = ".layout"
#: 옮기는 동안 옛 폴더를 비켜 두는 이름 — 끊겼다가 다음 부팅에 이어 간다
LAYOUT_TMP = ".멀티-이전중"
# 파생 썸네일 캐시 — 원본에서 자동으로 굽는다. 지워도 다시 생긴다 (thumbs.py 참조)
THUMB_DIR = ".thumbs"
#: 생성물 이름에서 **순번 앞** 구분자 (`file_lead` 의 ★주). 읽을 때는 옛 `_` 도 함께 본다 (`SEQ_SEPS`).
SEQ_SEP = "-"
SEQ_SEPS = re.compile(r"[-_]")

_SAFE =re.compile(r'[<>:"/\\|?*\x00-\x1f]')


def safe_name(s: str, fallback: str = "무제") -> str:
    """폴더명으로 쓸 수 있게. 경로 탈출을 막는 것이 주 목적이다."""
    s = _SAFE.sub("_", (s or "").strip()).strip(". ")
    return s[:80] or fallback


def safe_tag(s: str, max_length: int = 100) -> str:
    """**파일 이름 안에 넣을 이름 조각** — v2 `sanitize_filename`(backend.py:1396) 그대로다.

    글자·숫자·밑줄·하이픈만 남기고(파이썬 `\\w` 는 한글을 포함한다) 공백은 밑줄로 바꾼다.
    ★v2 의 `else "vibe"` 폴백은 **안 가져온다** — 그 함수가 원래 vibe 캐시 이름을 짓던
      것이라 붙은 값이고, 씬 이름에 쓰면 이름 없는 씬이 전부 `vibe` 가 된다.
      여기서는 빈 문자열을 돌려주고, 부르는 쪽이 "이름이 없다"로 다룬다.
    ★v2 는 앞에서 `Path(name).stem` 으로 확장자를 떼는데 **그것도 안 가져온다** — 씬 이름은
      파일 이름이 아니라서, 「1.5배 컷」 같은 이름이 `1` 한 글자로 잘린다 (실측으로 확인).
    ★`next_name` 이 접두로 `glob` 을 돌리므로 `[`·`?` 같은 글자가 남으면 안 된다 —
      위 규칙이 이미 다 걷어낸다."""
    s = re.sub(r"[^\w\s-]", "", (s or "").strip(), flags=re.UNICODE)
    return s.strip().replace(" ", "_")[:max_length]


def file_lead(cell_no: int | None, cell: str | None, exclude_no: bool) -> str:
    """생성물 파일 이름의 **앞 조각** — `<번호>_<씬 이름>` (v2 `backend.py:2737-2746`).

        번호+이름   003_수영복-001.png
        이름만      수영복-001.png        ← 「파일 이름에서 씬 번호 빼기」
        번호만      003-001.png           ← 씬 이름이 비었거나 쓸 수 없는 글자뿐일 때
        없음        001.png               ← 씬이 없는 싱글 탭

    ★순번 앞 구분자는 `-` 다 (`SEQ_SEP`, 사용자 결정 2026-10-01). SillyTavern 의 표정 이미지가
      한 감정의 여러 장을 `joy-1.png` 처럼 점이나 대시로만 알아본다 — 밑줄이면 이름을 바꿔야 했다.
      번호와 이름 사이는 `_` 그대로다. 옛 그림(`수영복_001.png`)은 이름을 안 바꾸고 `next_name` 이 함께 센다.

    ★★「씬 번호 빼기」는 v2 와 같이 **번호만** 뺀다 (사용자 결정 2026-08-18, v2-port-audit D3).
      예전에는 이름이 아예 안 들어가서, 번호를 빼면 그 폴더의 **모든 씬이 한 번호열을 공유**했다
      (`next_name` 이 접두마다 세기 때문이다).
    ★번호는 **순번을 세는 열쇠**이기도 하다 — 이름을 바꾸면 그 씬의 번호열이 1부터 다시
      시작한다. v2 도 같다 (category 에 이름이 들어간다)."""
    tag = safe_tag(cell or "")
    if exclude_no:
        return tag
    no = f"{cell_no:03d}" if cell_no else ""
    return "_".join(x for x in (no, tag) if x)


def unique_name(base: str, used) -> str:
    """새로 서는 이름 — **첫 번째는 그대로, 겹치면 뒤에 2·3…** (사용자 지시 2026-08-28).

    ★규칙의 정본은 화면의 `src/lib/uniqueName.ts` 다 (*"탭, 그룹, 씬, 캐릭터 등등 전부 일관되게"*).
      여기 한 벌이 더 있는 까닭은 **이름을 짓는 자리가 둘**이기 때문이다: 만들 때는 화면이,
      옮길 때는 서버가 짓는다. 규칙이 갈리면 같은 이름이 두 폴더로 갈린다.
    ★비교는 글자 그대로다 — 다듬거나 대소문자를 무시하지 않는다."""
    taken = set(used)
    if base not in taken:
        return base
    n = 2
    while f"{base} {n}" in taken:
        n += 1
    return f"{base} {n}"


class SpecCorrupt(ValueError):
    """`workspace.json` 을 읽지 못하고 되살릴 사본도 없다 (`Store.load`). 서버가 **422** 로 알린다 → 화면이 안내 창을 띄운다."""


def _read_spec(p: Path) -> dict:
    """★깨진 파일은 `ValueError` 로 끝난다 — `JSONDecodeError`·`UnicodeDecodeError` 둘 다 그 자식이다."""
    spec = json.loads(p.read_text(encoding="utf-8"))
    if not isinstance(spec, dict):
        raise ValueError(f"{p.name} 이 객체가 아닙니다")
    return spec


def _write_durable(tmp: Path, target: Path, data: bytes) -> None:
    """임시 파일에 쓰고 **디스크에 내린 뒤** 이름을 바꾼다 (`durable.py` 머리 주석)."""
    write_synced(tmp, data)
    Store._replace(tmp, target)


class SpecMismatch(ValueError):
    """다른 워크스페이스의 spec 을 이 이름으로 쓰려 했다 (`Store.save` 의 ★★주). 서버는 409 로 돌려준다."""


class Store:
    def __init__(self, root: Path):
        #: 방금 옮긴 그림의 옛 이름 → 지금 이름 (위 ★★주)
        #: ★값도 (ws, rel) 이다 — 탭을 다른 워크스페이스로 옮기면 그림이 **다른 폴더**로 간다
        self._moved: dict[tuple[str, str], tuple[str, str]] = {}
        #: 워크스페이스마다 하나 — spec 을 읽고·고치고·쓰는 동안 다른 요청이 끼어들지 못하게
        #  (`locked` 의 ★주). 스레드(`move_tab`)와 루프(`PUT`)가 같은 파일을 동시에 만졌다.
        self._locks: dict[str, threading.RLock] = {}
        self._locks_guard = threading.Lock()
        #: 이 실행에서 **지운 워크스페이스의 id** (`save` 의 ★★주). 뒤늦게 온 저장이 지운
        #  워크스페이스를 도로 만드는 것을 막는다.
        self._buried: dict[str, str] = {}
        #: 워크스페이스마다 사본을 마지막으로 뜬 때 (`time.monotonic`). ★처음 저장은 언제나 뜬다 — 켠 직후의 온전한 판이 남는다
        self._baked: dict[str, float] = {}
        #: **이 실행에서 사본으로 되살린 것** → 그 사본의 `updatedAt`. 부팅 이전 작업이 먼저 되살릴 수도 있어
        #  화면이 그 워크스페이스를 열 때까지 들고 있다가 한 번 건넨다 (`take_recovered`).
        self._recovered: dict[str, str] = {}
        #: ★★그림이 옮겨졌을 때 **워크스페이스 밖**에서 경로를 든 곳을 고치는 자리 (2026-10-01).
        #:  `fn("<ws>/<옛 상대경로>") → "<ws>/<새 상대경로>" | None`. 서버가 단다 (보관함 출처 · 파일 관리 휴지통).
        #:  이 모듈은 그 저장소들을 모른다 — 밖의 뿌리를 아는 것은 서버다.
        self.carry_outside = None
        self.root = root
        self.root.mkdir(parents=True, exist_ok=True)

    @contextmanager
    def locked(self, *wss: str):
        """그 워크스페이스(들)의 spec 을 만지는 동안 잡는다 — **이름순**으로 잡아 둘을 동시에 잡아도 안 엉킨다.

        ★실사고 2026-08-28: 탭 옮기기(`move_tab`, 스레드)가 도는 사이 화면의 자동 저장(`PUT`, 루프)이
          같은 `workspace.json` 을 바꿔치기하다 `PermissionError` 가 났다 — 임시 파일 교체는 그 파일을
          누가 읽고 있으면 거부된다. 읽기·쓰기를 한 줄로 세운다."""
        names = sorted(set(wss))
        with self._locks_guard:
            locks = [self._locks.setdefault(n, threading.RLock()) for n in names]
        for lk in locks:
            lk.acquire()
        try:
            yield
        finally:
            for lk in reversed(locks):
                lk.release()

    @staticmethod
    def _replace(tmp: Path, target: Path) -> None:
        """임시 파일을 제자리로 **바꿔치기** — 윈도우는 그 파일을 누가 읽는 중이면 `WinError 5` 로
        거부한다 (백신·탐색기·우리 자신의 동시 읽기). 잠깐 쉬고 몇 번 더 해 본다 (실측 2026-08-28: 두 번 났다)."""
        for i in range(6):
            try:
                tmp.replace(target)
                return
            except PermissionError:
                if i == 5:
                    raise
                time.sleep(0.05 * (i + 1))

    # ── 워크스페이스 ──────────────────────────────────────────
    #: 방금 옮긴 그림의 **옛 이름 → 지금 이름** (`renumber` 가 적는다).
    #
    #  ★★**왜 들고 있나** (사용자 지적 2026-08-27: *"클릭해서 크게 보는 원본이 안 보이다가
    #    5초 뒤 화면이 깜빡하고 나서 보인다"*). 개명은 파일을 먼저 옮기고, 화면은 그 답을
    #    받고 나서야 경로를 갈아 끼운다 — 그 **틈** 동안 화면은 **옛 경로**로 그림을 부른다.
    #    그때 404 를 주면 `<img>` 는 거기서 끝난다 (스스로 다시 시도하지 않는다). 그래서
    #    경로가 갱신되어 `src` 가 바뀌는 순간에야 뜬다 — 그 「깜빡」이 그것이었다.
    #    ★이미 크게 본 적 있는 그림만 멀쩡했던 까닭도 같다: 그건 웹뷰 캐시에 있었다.
    #  ★한 번 옮긴 것을 또 옮길 수 있으므로 **사슬을 따라간다** (`_current`).
    #  ★캐시일 뿐이라 앱을 껐다 켜면 사라진다 — 그때는 화면도 새 경로를 들고 있다.
    _MOVED_CAP = 20_000

    def _track(self, ws: str, was: Path, now: Path, to_ws: str | None = None) -> None:
        """그 그림이 **지금 어디 있는지** 적어 둔다 (위 ★★주). 옮기는 도중에도 부른다.
        ★`to_ws` 를 주면 **다른 워크스페이스로** 간 것이다 (`move_tab`) — 찾는 쪽이 그 폴더까지 따라간다."""
        dst = to_ws or ws
        self._track_rel(ws, self.rel(ws, was), dst, self.rel(dst, now))

    def _track_rel(self, ws: str, was: str, dst_ws: str, now: str) -> None:
        """같은 것을 **상대경로 문자열로** 적는다 — 폴더째 옮길 때는 장마다 경로를 정규화할 이유가
        없다 (실측 2026-08-28: 400장에서 그 정규화만 403ms 였다)."""
        self._moved[(ws, was)] = (dst_ws, now)
        if len(self._moved) > self._MOVED_CAP:      # 오래된 절반을 버린다
            for k in list(self._moved)[: len(self._moved) // 2]:
                self._moved.pop(k, None)

    def _current(self, ws: str, rel: str) -> tuple[str, str]:
        """옛 이름으로 물어도 **지금 자리**(ws, rel)를 준다 (위 ★★주). 사슬을 따라가되 고리는 끊는다."""
        seen: set[tuple[str, str]] = set()
        cur = (ws, rel)
        while cur not in seen:
            seen.add(cur)
            nxt = self._moved.get(cur)
            if not nxt:
                break
            cur = nxt
        return cur

    def dir_of(self, ws: str) -> Path:
        return self.root / safe_name(ws)

    def list(self) -> list[dict]:
        out = []
        for d in sorted(self.root.iterdir()) if self.root.exists() else []:
            # ★점으로 시작하는 것은 우리 내부 폴더다 — 워크스페이스인 척하면 안 된다
            if not d.is_dir() or d.name.startswith("."):
                continue
            spec = d / SPEC_NAME
            if spec.exists():
                try:
                    s = json.loads(spec.read_text(encoding="utf-8"))
                    out.append({"name": d.name, "id": s.get("id"), "updatedAt": s.get("updatedAt")})
                    continue
                except Exception:
                    pass
            out.append({"name": d.name, "id": None, "updatedAt": None})
        return out

    def load(self, ws: str) -> dict | None:
        p = self.dir_of(ws) / SPEC_NAME
        if not p.exists():
            return None
        try:
            return _read_spec(p)
        except ValueError:
            return self._recover(ws)

    def _recover(self, ws: str) -> dict:
        """깨진 `workspace.json` 을 사본으로 되살린다. 사본도 없거나 깨졌으면 `SpecCorrupt`.

        ★**파일을 고치기 전에 베낀다** — 깨진 원본은 `workspace.json.broken-<시각>` 으로 남는다. 손으로 살릴 여지가 있다.
        ★★읽기가 파일을 고치는 유일한 자리다. `load` 하나에 두어 화면·조수·부팅 이전이 전부 같은 처리를 거친다."""
        d = self.dir_of(ws)
        p = d / SPEC_NAME
        with self.locked(ws):
            try:
                return _read_spec(p)    # ★잠금을 기다리는 동안 다른 요청이 이미 되살렸다
            except ValueError:
                pass
            try:
                spec = _read_spec(d / SPEC_BAK)
            except (OSError, ValueError) as e:
                print(f"[워크스페이스] {ws}: {SPEC_NAME} 이 깨졌는데 되살릴 사본이 없습니다 ({e!r})")
                raise SpecCorrupt(str(p)) from e
            (d / f"{SPEC_NAME}.broken-{datetime.now():%Y%m%d-%H%M%S}").write_bytes(p.read_bytes())
            _write_durable(d / (SPEC_NAME + ".tmp"), p, (d / SPEC_BAK).read_bytes())
            self._recovered[ws] = str(spec.get("updatedAt") or "")
            print(f"[워크스페이스] {ws}: {SPEC_NAME} 이 깨져 사본({spec.get('updatedAt')})으로 되살렸습니다")
            return spec

    def _rebuild_plan(self, ws: str) -> tuple[dict, dict]:
        d = self.dir_of(ws)
        def read_env(r: dict) -> dict | None:
            return recordsdb.get(d, r["key"]).get("env") if r.get("key") else None
        return rebuild.build(ws, self.live_records(ws), read_env, self._last_stars(d))

    def rebuild_preview(self, ws: str) -> dict:
        """다시 만들면 무엇이 돌아오나 — 파일은 안 건드린다. 화면의 안내 문구가 이 수를 쓴다."""
        return self._rebuild_plan(ws)[1]

    def rebuild(self, ws: str) -> dict:
        """깨진 `workspace.json` 을 그림 기록으로 다시 쓴다 (`rebuild.py`).
        ★★**읽히는 파일은 절대 덮어쓰지 않는다** — 이 창구의 재료는 원본보다 언제나 적다.
        ★깨진 원본은 베껴 둔다 (`_recover` 와 같다). 그림·색인은 안 건드린다."""
        d = self.dir_of(ws)
        p = d / SPEC_NAME
        with self.locked(ws):
            if not p.is_file() or self._readable(p):
                raise ValueError(f"{ws}: {SPEC_NAME} 이 깨진 상태가 아닙니다")
            spec, counts = self._rebuild_plan(ws)
            if not counts["images"]:
                raise ValueError(f"{ws}: 다시 만들 그림 기록이 없습니다")
            (d / f"{SPEC_NAME}.broken-{datetime.now():%Y%m%d-%H%M%S}").write_bytes(p.read_bytes())
            spec["updatedAt"] = datetime.now().isoformat(timespec="seconds")
            _write_durable(d / (SPEC_NAME + ".tmp"), p, json.dumps(spec, ensure_ascii=False, indent=2).encode("utf-8"))
            print(f"[워크스페이스] {ws}: 그림 기록으로 다시 만들었습니다 {counts}")
            return counts

    @staticmethod
    def _readable(p: Path) -> bool:
        try:
            _read_spec(p)
            return True
        except ValueError:
            return False

    @staticmethod
    def _last_stars(d: Path) -> list[str]:
        """`stars.jsonl` 의 마지막 줄 — 별표의 이력이다 (`STARS_NAME`)."""
        p = d / STARS_NAME
        if not p.is_file():
            return []
        lines = p.read_bytes().splitlines()
        if not lines:
            return []
        try:
            return [str(f) for f in json.loads(lines[-1].decode("utf-8")).get("starred") or []]
        except ValueError:
            return []

    def take_recovered(self, ws: str) -> str | None:
        """이 워크스페이스를 사본으로 되살렸으면 그 사본의 시각을 **한 번** 돌려준다 — 화면이 알릴 재료다."""
        return self._recovered.pop(ws, None)

    def _keep_spec_copy(self, ws: str) -> None:
        """지금 디스크의 `workspace.json`(방금 읽어 온전함을 확인한 것)을 사본으로 뜬다.
        ★사본을 못 떠도 저장은 막지 않는다 — 사본은 보험이고 저장이 본체다."""
        now = time.monotonic()
        if now - self._baked.get(ws, -SPEC_BAK_EVERY) < SPEC_BAK_EVERY:
            return
        d = self.dir_of(ws)
        try:
            _write_durable(d / (SPEC_BAK + ".tmp"), d / SPEC_BAK, (d / SPEC_NAME).read_bytes())
            self._baked[ws] = now
        except OSError as e:
            print(f"[워크스페이스] {ws}: 사본을 못 떴습니다 ({e!r})")

    def save(self, ws: str, spec: dict) -> dict:
        """작업 상태를 쓴다.

        ★★**쌓이는 백업은 두지 않는다** (사용자 결정 2026-08-25). 한때 여기서 덮어쓰기 직전 내용을
          `.bak/` 에 쌓았는데 두 가지가 틀렸다:
            · **자리가 틀렸다.** 이 함수는 사용자의 자동 저장(400ms 디바운스)·조수·되돌리기가
              **전부 지나는 공통 통로**라, 조수 대비로 넣은 것이 **사용자가 타이핑하는 동안**
              대부분 만들어졌다 (실측: 1초에 세 판 · 워크스페이스 하나에 3.8MB).
            · **꺼낼 창구가 없었다.** 앱에 「백업에서 되돌리기」가 없어 손으로 덮어야 했다.
          ★★**파일이 깨졌을 때 쓸 사본은 한 벌 둔다** (사용자 지시 2026-11-04: *"못 읽었다고 끝내면 복구할
            방법이 없을텐데"*). 위 두 가지를 피한다: 같은 자리에 덮어써서 늘지 않고(`SPEC_BAK`, 1분에 한 번),
            꺼내는 것은 읽기가 알아서 한다 (`_recover`). 조수의 실수를 되돌리는 용도가 아니다.
          ★조수의 실수는 **사전에** 막는다 — 승인 카드(`docs/agent-actions-design.md` 2-5)와
            `apply` 의 허용 목록, 그리고 되돌리기 이력(`backend/agentlog.py`)이 그 일을 한다.
        ★「탭 0개면 거절」 같은 검사도 두지 않는다 — 이 코드에는 **탭 0개인 spec 이 만들어지는
          길이 없다** (`store/workspace.ts` 의 `save` 는 spec 이 없으면 안 보내고, `newSpec` 은
          탭 하나를 갖고 태어나며, `removeTab` 은 마지막 탭을 안 지운다). 일어날 수 없는 것을
          막는 검사는 아무 일도 안 하면서 다음 사람을 헷갈리게 한다.
        ★★**남의 spec 은 이 이름으로 못 쓴다** (실사고 2026-08-28). 탭을 다른 워크스페이스로 끌어
          놓는 사이 화면이 그 워크스페이스로 넘어갔고, 옮기기 응답(출발 쪽 spec)이 **지금 화면의
          spec 자리**에 대입돼 자동 저장이 `qa_test` 의 spec 을 `test` 이름으로 썼다 — 탭 10개가
          탭 1개로 덮였다. 화면 상태가 어떻게 꼬여도 마지막에 서는 문지기가 이것이다: 파일에 이미
          id 가 있고 들어온 spec 의 id 가 다르면 거부한다 (`SpecMismatch` → 409). id 는 워크스페이스를
          만들 때 한 번 찍히고(`newSpec`) 복제하는 길이 없어 오탐이 없다. 백업 대신 **사전 차단**이라는
          결정(2026-08-25)의 연장이다.
        """
        d = self.dir_of(ws)
        with self.locked(ws):
            cur = self.load(ws)
            have, got = (cur or {}).get("id"), spec.get("id")
            if have and got and have != got:
                raise SpecMismatch(f"다른 워크스페이스의 내용입니다 ({got} → {ws}:{have})")
            # ★★**지운 워크스페이스를 저장이 도로 만들지 못하게 한다** (사용자 지적 2026-09-15:
            #   *"재실행하면 폴더가 남아서 계속 되살아남"*). 화면이 밀린 편집을 들고 있다가 삭제
            #   **뒤에** 보내면, 이 함수는 폴더를 만들어 주는 것이 정상 동작이라(새 워크스페이스도
            #   같은 길로 태어난다) 지운 자리에 `workspace.json` 하나짜리 폴더가 도로 선다 —
            #   그러면 목록에 다시 뜨고 사용자는 삭제가 안 먹혔다고 본다.
            #   (실측 2026-09-15: `test2` 를 16:27:33 에 지웠는데 16:28:00 에 `workspace.json` 이
            #    다시 생겼다. 화면 쪽 방어(`store/workspace.ts` 의 `dropPendingSave`)는 **보고 있던
            #    워크스페이스**만 막아 다른 탭·조수·플러그인에서 온 것은 그대로 통과했다.)
            #   ★판정은 **기계적으로 확실한 것만** 쓴다: 폴더가 없고, 들어온 spec 의 id 가 이 실행에서
            #     지운 그 id 와 같으면 **철 지난 저장**이다. 새 워크스페이스는 id 가 새로 찍히므로
            #     같은 이름을 다시 만드는 것은 막히지 않고, 되돌리기로 폴더가 살아나도 통과한다.
            if got and not d.exists() and self._buried.get(str(got)) == ws:
                print(f"[워크스페이스] 지운 '{ws}' 에 뒤늦은 저장이 왔습니다 — 무시합니다")
                return spec
            d.mkdir(parents=True, exist_ok=True)
            spec["updatedAt"] = datetime.now().isoformat(timespec="seconds")
            if cur is not None:
                self._keep_spec_copy(ws)
            # 임시 파일에 쓴 뒤 교체 — 쓰는 중 앱이나 OS 가 죽어도 기존 파일이 남는다
            _write_durable(d / (SPEC_NAME + ".tmp"), d / SPEC_NAME, json.dumps(spec, ensure_ascii=False, indent=2).encode("utf-8"))
            self._note_stars(d, spec)
        return spec

    @staticmethod
    def _note_stars(d: Path, spec: dict) -> None:
        """별표 목록이 마지막 줄과 다르면 `stars.jsonl` 에 덧붙인다 (`STARS_NAME` 의 ★★주).
        ★비교는 **집합**이다 — 경로만 갈아 끼워도(개명·옮기기) 줄이 는다. 그것도 이력이다."""
        starred = (spec.get("selection") or {}).get("starred")
        if not isinstance(starred, list):
            return
        p = d / STARS_NAME
        last: list = []
        if p.is_file():
            try:
                lines = p.read_bytes().splitlines()
                if lines:
                    last = json.loads(lines[-1].decode("utf-8")).get("starred") or []
            except Exception:
                last = []
        elif not starred:
            return                              # 별표가 한 번도 없었다 — 파일을 만들 까닭이 없다
        if set(map(str, last)) == set(map(str, starred)):
            return
        row = {"ts": datetime.now().isoformat(timespec="seconds"), "starred": starred}
        with p.open("ab") as f:
            f.write(json.dumps(row, ensure_ascii=False).encode("utf-8") + b"\n")

    def rename(self, old: str, new: str) -> str:
        a, b = self.dir_of(old), self.dir_of(new)
        if a.exists() and not b.exists():
            a.rename(b)
        return b.name

    def delete(self, ws: str) -> dict:
        """워크스페이스를 **휴지통으로** (사용자 결정 2026-08-18, v2-port-audit D7).

        ★예전에는 `rmtree` 였다 — 이 앱에서 가장 크게 없어지는 동작인데 되돌릴 길이 없었다.
          휴지통은 `workspaces/.trash` 다 (워크스페이스 자신의 것은 함께 담겨 간다)."""
        d = self.dir_of(ws)
        if not d.exists():
            return {"deleted": [], "trashed": []}
        # ★지운 워크스페이스의 id 를 적어 둔다 — 뒤늦은 저장을 가려내는 열쇠다 (`save` 의 ★★주)
        wid = (self.load(ws) or {}).get("id")
        if wid:
            if len(self._buried) > 200:
                self._buried.clear()
            self._buried[str(wid)] = ws
        r = trash.send_at(self.root, [d.name])
        # ★★**자리가 남으면 지운 것이 되살아난다** (사용자 지시 2026-09-15: *"그냥 삭제를 하면
        #   확실하게 해당 폴더가 사라지게 만들어"*). 목록은 폴더를 보고 만들어지므로, 껍데기가
        #   남으면 앱을 다시 켤 때 워크스페이스가 그대로 다시 선다. `trash.send_at` 이 이미
        #   비우려고 애쓰지만(`_hard_move`), **여기서 한 번 더 확인하고** 그래도 남으면
        #   사용자에게 알린다 — 조용히 성공한 척하지 않는다.
        if d.exists():
            shutil.rmtree(d, ignore_errors=True)
        return {"deleted": [m["file"] for m in r["moved"]], "trashed": r["moved"],
                "left": d.exists()}

    def restore_ws(self, entries: list[dict]) -> dict:
        return trash.restore_at(self.root, entries)

    # ── 생성물 ────────────────────────────────────────────────
    def out_dir(self, ws: str, scene_group_name: str, tab_name: str | None = None) -> Path:
        """저장 자리 — **그림이 앉는 슬롯의 자리**를 그대로 따른다.

            <ws>/output/<탭>/<세트>/       <씬번호>_<씬이름>_<순번>.png

        ★★**「멀티」 한 겹을 걷어냈다** (사용자 결정 2026-10-01). 옛 그림은 부팅 때 옮긴다 (`migrate_layout`).
        ★★**「싱글」 갈래를 걷어냈다** (사용자 지시 2026-08-24: *"싱글이라는 개념은 없어졌음.
          싱글에 저장하는 것 자체가 레거시가 남아있는 이슈"*). 2026-08-11 에 싱글 탭이
          없어졌는데 저장 자리만 그 갈래를 들고 있어서, 씬을 못 찾은 그림(강화·옛 경로로 온
          것)이 `싱글/` 로 떨어져 **그림이 나온 자리와 다른 폴더**에 쌓였다.
          이제 갈래가 하나다 — 씬 이름·번호를 모르면 **파일 이름 앞이 비는 것**으로 끝나고,
          폴더는 언제나 그 그림이 속한 탭·세트다.
        ★`output/` 아래로 내린 것은 **워크스페이스 안이 정리되게** 하기 위해서다
          (사용자 지시 2026-08-08). 옛 경로(`싱글/`·`멀티/`·`work/`)의 그림은 **옮기지 않는다** —
          records 의 상대경로와 썸네일 tid 가 통째로 바뀌어 꽂아 둔 커버가 깨진다.
          읽는 쪽은 상대경로를 그대로 쓰므로 옛것도 계속 보인다.
        ★`output/` 을 처음 만드는 워크스페이스에는 새 배치 표식을 함께 둔다 (`LAYOUT_MARK`) — 그래야
          나중에 「멀티」라는 탭이 생겨도 옛 폴더로 오인하지 않는다.
        ★씬 폴더를 만들지 않는다 — 씬은 **파일 이름 앞의 번호**다. 그래야 탐색기에서 한 세트가
          한자리에 모이고 씬 순서대로 정렬된다 (페로픽스파이 `001_이름_00001_.png` 과 같은 취지).
        ★탭·세트 이름이 없으면(옛 세션·이름을 못 받은 경우) 그 칸을 건너뛴다 — 「무제」 같은
          폴더를 지어내면 그 이름의 진짜 세트와 섞인다."""
        p = self.dir_of(ws) / OUT_DIR
        if not p.is_dir():
            p.mkdir(parents=True, exist_ok=True)
            (p / LAYOUT_MARK).touch()
        if tab_name:
            p = p / safe_name(tab_name)
        if scene_group_name:
            p = p / safe_name(scene_group_name)
        p.mkdir(parents=True, exist_ok=True)
        return p

    def next_name(self, d: Path, prefix: str, fmt: str, ws: str | None = None,
                  names: list[str] | None = None, sep: str = SEQ_SEP) -> Path:
        """그 폴더에서 **다음 순번**. 시각이 아니라 순번이라 만든 차례가 그대로 보인다.
        ★번호는 **접두마다 따로** 센다 — 멀티에서 슬롯 1의 3장과 슬롯 2의 3장이
        각각 001~003 이 되어야 슬롯 안에서 몇 번째인지 읽힌다.

        ★★**휴지통에 든 것도 센다** (`ws` 를 준 경우, 사용자 지적 2026-08-20).
          지우면 파일이 `.trash/<시각>/<원래 경로>` 로 **옮겨져** 그 이름이 폴더에서 비고,
          다음 생성이 **같은 경로**를 다시 쓴다. 그런데 앱은 여러 곳에서 **경로를 그림의
          신원**으로 쓴다 — 레코드 중복 판정 · 「지운 것」·「별표」 목록. 그래서 새 그림이
          옛 그림의 표식을 물려받아, 방금 만든 것이 **화면에 아예 안 뜬다.**
          (실측: 씬 삭제 → 이미지 삭제 → 씬 다시 생성 → 1장 생성 → 파일은 생겼는데 안 보임.
           레코드 두 줄의 `file` 이 똑같았다.)
          번호를 건너뛰는 편이 낫다 — 되돌리기(`restore`)로 옛 파일이 제자리에 돌아와도
          이름이 겹치지 않는다.
        ★★구분자는 `-` 로 짓되 옛 `_` 도 센다 (`SEQ_SEP`). 안 세면 옛 그림이 있는 씬이 001 부터
          다시 시작해 `수영복_001.png` 곁에 `수영복-001.png` 가 선다."""
        used = 0
        # ★★모으기는 **한 번만** 할 수 있다 — 여러 장을 이어 지을 때는 부르는 쪽이
        #   목록을 들고 있다가 그대로 넘긴다 (`_names_in` 의 ★★주).
        if names is None:
            names = self._names_in(d, ws)
        for name in names:
            stem = name.rsplit(".", 1)[0]
            if prefix:
                if not stem.startswith(prefix) or stem[len(prefix):len(prefix) + 1] not in ("-", "_"):
                    continue
                rest = stem[len(prefix) + 1:]
            else:
                rest = stem
            part = SEQ_SEPS.split(rest, 1)[0]
            if part.isdigit():
                used = max(used, int(part))
        head = f"{prefix}{sep}" if prefix else ""
        return d / f"{head}{used + 1:03d}.{fmt}"

    def _names_in(self, d: Path, ws: str | None) -> list[str]:
        """그 폴더에서 **이미 쓴 이름들** — 폴더 · 휴지통 · 레코드를 합쳐서.

        ★★**비싸다**: 레코드 전량을 읽는다. 여러 장을 이어 이름 지을 때 파일마다
          다시 부르면 **파일 수의 제곱**이 된다 — 수백 장에서 몇 초가 통째로 들고,
          그동안 백엔드가 막혀 **그림이 안 뜬다** (실측 2026-08-27, 「씬 순서를 바꾸면
          5초 멈춘다」의 절반이 이것이었다). 그래서 `renumber` 는 폴더마다 한 번만
          모아 두고, 자리를 하나 정할 때마다 그 목록에 이름을 더해 간다.
        """
        spots = [d]
        names: list[str] = []
        if ws:
            base = self.dir_of(ws)
            try:
                rel = d.relative_to(base)
            except ValueError:
                rel = None
            if rel is not None:
                troot = trash.trash_root(base)
                # ★옛 묶음 폴더(`<지운 시각>/<원래 경로>`)가 아직 남아 있을 수 있다
                if troot.is_dir():
                    spots += [b / rel for b in troot.iterdir() if b.is_dir()]
                # ★★휴지통이 **평평해진 뒤**로는 원래 자리를 장부가 안다 (`trash` 머리 주석,
                #   2026-08-23). 파일 이름만 보면 다른 폴더에서 버린 같은 이름까지 세므로
                #   **적힌 원래 경로의 폴더가 여기와 같을 때만** 센다.
                here = rel.as_posix()
                for row in trash.read_index(troot):
                    f = str(row.get("file") or "")
                    at = f.rsplit("/", 1)
                    if len(at) == 2 and at[0] == here:
                        names.append(at[1])
                # ★★★**레코드에 적힌 이름도 센다** (사용자 지적 2026-08-24: *"히스토리에 있는
                #   이미지들이 서로 섞이고 여러개가 중복표시되고 하나를 누르면 전부 선택"*).
                #
                #   폴더와 휴지통만 세면 **번호가 되돌아간다**: 지운 그림은 휴지통으로 갔다가
                #   24시간 뒤 비워지고(`trash.sweep`), 그러면 그 이름이 폴더에도 장부에도 없다.
                #   다음 생성이 **같은 경로**를 다시 쓰면 옛 파일을 덮고, 그 경로를 가리키던
                #   **옛 레코드가 새 그림을 가리키게 된다** — 화면은 경로를 그림의 신원으로
                #   쓰므로 한 장이 두 장으로 뜨고, 눌러 고르면 둘 다 잡힌다.
                #   (실측: `output/멀티/복제/새 세트/001_씬_1_582~587.png` 이 08-22 것을
                #    08-24 생성이 그대로 덮었다.)
                #
                #   ★레코드는 **append-only** 라 지워지지 않는다 — 파일이 사라져도 「그 이름을
                #     쓴 적이 있다」는 사실은 남는다. 번호를 건너뛰는 편이 언제나 낫다.
                #   ★같은 폴더의 줄만 센다 (휴지통 장부와 같은 규칙).
                for row in self.records(ws):
                    f = str(row.get("file") or "")
                    at = f.rsplit("/", 1)
                    if len(at) == 2 and at[0] == here:
                        names.append(at[1])
        for spot in spots:
            if not spot.is_dir():
                continue
            # ★접두로 안 거른다 — 거르는 것은 부르는 쪽(`next_name`)의 몫이다
            names += [f.name for f in spot.glob("*")]
        return names

    def rel(self, ws: str, path: Path) -> str:
        return path.relative_to(self.dir_of(ws)).as_posix()

    def store_output(
        self,
        ws: str,
        scene_group_name: str,
        cell: str | None,
        cell_no: int | None,
        tab_name: str | None,
        exclude_no: bool,
        fmt: str,
        data: bytes,
    ) -> str:
        """생성물을 **자리에 앉히고** 상대경로를 돌려준다 — ★이름 규칙의 **유일한 창구**다.

        자리는 `out_dir` 하나가 정한다 (`output/<탭>/<세트>/`). 씬 폴더 대신 **파일 앞
        씬 번호**를 쓰고, 이름은 시각이 아니라 **순번**이다 (`file_lead`).

        부르는 곳이 셋이다 — 평소 생성(`_generate_one`) · 미저장 그림의 「파일로 저장」
        (`/api/save-preview`) · 「새 탭으로 복제」(`copy_to_scene_group`). 두 벌이 되면 번호열이
        갈린다: `next_name` 은 **접두마다 따로** 세므로, 한쪽만 `file_lead` 를 다르게 지으면
        같은 폴더 안에서 번호가 겹치거나 건너뛴다."""
        # ★씬을 몰라도 **자리는 같다** — 비는 것은 파일 이름 앞뿐이다 (`out_dir` 의 ★★주)
        d = self.out_dir(ws, scene_group_name, tab_name)
        lead = file_lead(cell_no, cell, exclude_no)
        path = self.next_name(d, lead, fmt, ws)
        path.write_bytes(data)
        return self.rel(ws, path)


    def renumber(self, ws: str, items: list[dict]) -> dict:
        """씬 자리가 바뀌면 **파일 이름의 씬 번호도 따라간다** (선결 조건 3-8, 2026-08-24).

        `items` 는 `[{file, cell_no, cell, exclude_no}]` — **바뀐 뒤의** 번호·이름이다.
        누가 어느 씬인지는 화면이 안다(`cell_id` 로 묶는다). 여기서는 **이름 규칙**만 안다.

        ★★왜 서버가 하나: 이름 규칙(`file_lead`·`next_name`)이 여기 있다. 프론트에 옮겨
          적으면 생성이 짓는 이름과 개명이 짓는 이름이 갈린다.
        ★★**두 단계로 바꾼다.** 씬 둘이 자리를 맞바꾸면(사용자 예: 미소 ↔ 슬픔) 중간에
          **이름이 겹친다** — 먼저 임시 이름으로 전부 옮기고 나서 제 이름을 준다.
          한 번에 하면 뒤엣것이 앞엣것을 덮거나 `next_name` 이 엉뚱한 번호를 준다.
        ★함께 고치는 것 둘 — 파일 · 색인(`records.jsonl`). 무거운 기록(`records.db`)은 열쇠로
          이어져 있어 안 건드린다 (`_rewrite_paths`). 색인이 빠지면 **그림이 화면에서 사라진다**
          (색인이 없는 경로를 가리킨다).
        ★★**썸네일 캐시도 함께 옮긴다** (실측 2026-08-27). 파생 캐시의 이름은 **경로에서**
          나오므로(`thumbs.flat_name`), 안 옮기면 개명한 그림이 전부 캐시 미스가 되어
          한 장씩 다시 구워진다 — 실측 **한 장 60ms, 600장이면 36초**다. 그동안 화면에
          그림이 안 뜬다. 이것이 「씬 순서를 바꾸면 무겁고 이미지가 안 뜬다」의 정체였다.
          (이름 바꾸기 자체는 600장에 0.4초로 문제가 아니었다.)
        ★꽂아 둔 썸네일(`data/thumbs`)은 그대로 둔다 — `tid` 가 내용에서 나와 경로와 무관하다.
        """
        base = self.dir_of(ws)
        plan: list[tuple[Path, str, str, str]] = []   # (지금 경로, 새 접두, 확장자, 상대경로)
        for it in items:
            rel = str(it.get("file") or "").replace("\\", "/")
            # ★★워크스페이스 **밖으로 못 나간다** — 경로는 조수가 줄 수도 있는 값이다.
            #   ★검사는 **문자열로** 한다 (2026-08-28). 예전에는 파일마다 `resolve()` 를 두 번씩
            #     불렀는데, 윈도우에서 그것만으로 300장에 **855ms** 였다 (실측: 전체 1,158ms 중).
            #     막으려는 것은 `..`·절대경로이고, 그건 문자열로 그대로 가려진다.
            parts = [x for x in rel.split("/") if x not in ("", ".")]
            if not parts or ".." in parts or rel.startswith("/") or ":" in parts[0]:
                continue
            src = base.joinpath(*parts)
            if not src.is_file():
                continue
            lead = file_lead(it.get("cell_no"), it.get("cell"), bool(it.get("exclude_no")))
            # ★이미 그 접두면 손대지 않는다 — 쓸데없이 순번을 흔들지 않는다
            #   (옛 구분자 `_` 로 지은 것도 그 접두다 — 구분자만 바꾸려고 순번을 흔들지 않는다)
            if lead and (src.name.startswith(f"{lead}-") or src.name.startswith(f"{lead}_")):
                continue
            if not lead and not SEQ_SEPS.search(src.stem):
                continue
            plan.append((src, lead, src.suffix.lstrip("."), "/".join(parts)))
        if not plan:
            return {"pairs": []}

        # ① 임시 이름으로 비켜 둔다 (맞바꿈에서 겹치는 것을 막는다)
        # ★★**옮기는 동안에도 옛 이름으로 찾을 수 있어야 한다** (사용자 지적 2026-08-27:
        #   *"깜빡이기 전까지는 크게 보려고 누르면 깨진 표시만 뜬다"*). 이 구간에서 파일은
        #   임시 이름으로 가 있어 **옛 이름도 새 이름도 없다** — 그 몇 초 동안 그림 요청이
        #   전부 404 였다. 그래서 옮길 때마다 **지금 어디 있는지**를 적어 둔다 (`_track`).
        stash: list[tuple[Path, str, str, Path]] = []
        for src, lead, ext, rel in plan:
            tmp = src.with_name(f".renum-{uuid.uuid4().hex[:8]}.{ext}")
            # ★★**옮기기 전에 적는다.** 뒤에 적으면 그 사이(마이크로초)에 온 요청이 아무 데도
            #   못 닿는다. 먼저 적어 두면 찾는 쪽이 사슬을 훑어 **옛 자리든 새 자리든** 잡는다.
            # ★자취도 **문자열로** 적는다 (`_track_rel` 의 ★주) — `rel()` 을 장마다 부르면 그만큼 든다
            self._track_rel(ws, rel, ws, rel.rsplit("/", 1)[0] + "/" + tmp.name if "/" in rel else tmp.name)
            src.rename(tmp)
            stash.append((tmp, lead, ext, src))

        # ② 제 이름을 준다
        # ★★**이름 목록은 폴더마다 한 번만 모은다** (실측 2026-08-27). 파일마다 다시 모으면
        #   레코드 전량을 그때마다 읽어 **파일 수의 제곱**이 된다 (`_names_in` 의 ★★주).
        #   자리를 하나 정할 때마다 그 목록에 이름을 더해 두면, 다시 훑지 않고도 다음 번호가
        #   제대로 나온다 — 훑는 것과 결과가 같다.
        pairs = []
        seen: dict[Path, list[str]] = {}
        for tmp, lead, ext, src in stash:
            # ★`setdefault` 를 쓰면 안 된다 — **둘째 인자를 매번 평가**해서 캐시가 통째로
            #   헛돌았다 (실측 2026-08-27: 600장에서 `_names_in` 이 600번 불렸다).
            names = seen.get(tmp.parent)
            if names is None:
                names = seen[tmp.parent] = self._names_in(tmp.parent, ws)
            dst = self.next_name(tmp.parent, lead, ext, ws, names)
            self._track(ws, src, dst)      # 갈 자리를 **먼저** 적는다 (위 ★★주)
            self._track(ws, tmp, dst)      # 임시 이름으로 물어도 답한다
            tmp.rename(dst)
            names.append(dst.name)
            pairs.append({"file": self.rel(ws, dst), "to": self.rel(ws, dst)})
        # ★짝은 **옛 경로 → 새 경로**여야 한다 (위에서 tmp 를 거쳤으므로 다시 맞춘다)
        for (src, _, _, _), p in zip(plan, pairs):
            p["file"] = self.rel(ws, src)

        moves = {p["file"]: p["to"] for p in pairs}
        self._move_thumbs(ws, moves)
        self._rewrite_paths(ws, moves)
        self._announce(ws, moves)
        return {"pairs": pairs}

    def _move_thumbs(self, ws: str, moves: dict[str, str], dst_ws: str | None = None) -> None:
        """파생 썸네일 캐시를 새 이름으로 따라 옮긴다 (위 ★★주).

        ★캐시일 뿐이라 실패해도 그냥 넘어간다 — 없으면 다음 요청에 다시 구워진다.
          다만 **덮어쓰지 않는다**: 목표 자리에 이미 있으면 그것이 더 새것일 수 있다.
        ★`dst_ws` 를 주면 **다른 워크스페이스로** 간다 (탭 옮기기). 안 주면 제자리다 (개명)."""
        d = self.dir_of(ws) / THUMB_DIR
        t = self.dir_of(dst_ws or ws) / THUMB_DIR
        if not d.is_dir():
            return
        if t is not d:
            t.mkdir(parents=True, exist_ok=True)
        for old, new in moves.items():
            src = d / thumbs.flat_name(old)
            dst = t / thumbs.flat_name(new)
            if not src.is_file() or dst.exists():
                continue
            try:
                src.rename(dst)
            except OSError:
                pass

    #: 색인 줄에서 경로를 꺼낼 때 찾는 조각. ★우리가 `json.dumps` 로 쓰므로 모양이 고정이다.
    _FILE_KEY = '"file": "'

    #: 바이트 판 — 줄 하나가 수십 KB 라 **풀지 않고** 경로만 꺼낸다 (`_rewrite_paths` 의 ★★주)
    _FILE_KEY_B = b'"file": "'

    _KEY_KEY_B = b'"key": "'

    #: 강화·업스케일 결과가 가리키는 **원본의 경로** — 원본이 옮겨지면 함께 고친다
    #  (안 고치면 일괄 강화가 이미 강화한 원본을 못 알아본다: `src/lib/enhance.ts`)
    _ENH_KEY_B = b'"enhance_of": "'

    @classmethod
    def _enh_of_bytes(cls, raw: bytes) -> bytes | None:
        i = raw.find(cls._ENH_KEY_B)
        if i < 0:
            return None
        i += len(cls._ENH_KEY_B)
        j = raw.find(b'"', i)
        return raw[i:j] if j > 0 else None

    @classmethod
    def _key_of_bytes(cls, raw: bytes) -> bytes | None:
        """줄에서 **열쇠**만 꺼낸다 (없으면 `None` — 이전 전의 옛 줄이다)."""
        i = raw.find(cls._KEY_KEY_B)
        if i < 0:
            return None
        i += len(cls._KEY_KEY_B)
        j = raw.find(b'"', i)
        return raw[i:j] if j > 0 else None

    @classmethod
    def _file_of_bytes(cls, raw: bytes) -> bytes | None:
        i = raw.find(cls._FILE_KEY_B)
        if i < 0:
            return None
        i += len(cls._FILE_KEY_B)
        j = raw.find(b'"', i)
        return raw[i:j] if j > 0 else None

    @classmethod
    def _file_of(cls, line: str) -> str | None:
        """색인 한 줄에서 `file` 값만 꺼낸다 — **줄을 통째로 파싱하지 않는다** (아래 ★★주).
        ★경로에는 따옴표·역슬래시가 안 들어간다 (`safe_name` 이 막는다). 그래서 이 정도로 족하다."""
        i = line.find(cls._FILE_KEY)
        if i < 0:
            return None
        j = line.find('"', i + len(cls._FILE_KEY))
        return line[i + len(cls._FILE_KEY):j] if j > 0 else None

    def _rewrite_paths(self, ws: str, moves: dict[str, str], patch: dict | None = None) -> None:
        """색인의 `file` 을 새 경로로 바꾼다 (`renumber`·`move_scene_group`).

        ★`patch` 를 주면 그 줄에 값을 함께 심는다 (세트 이름이 바뀌었을 때).
        ★★`enhance_of`(그 줄이 강화·업스케일한 원본)가 옮겨진 그림을 가리키면 그것도 고친다 (2026-10-01).
          예전에는 `file` 만 고쳐서, 원본을 옮기면 결과 줄이 없는 경로를 가리켰다.
        ★★**무거운 기록(`records.db`)은 안 건드린다** (사용자 승인 2026-08-28). 둘을 잇는 것이
          경로가 아니라 `key` 라, 경로가 바뀌어도 기록은 그대로 맞다 (`append_record` 의 ★★주).
        ★★**바이트로 훑는다**. 바뀌는 줄만 풀고 나머지는 바이트 그대로 흘려 쓴다.

        ★append-only 인 파일을 **통째로 다시 쓰는** 유일한 자리다. 그래서 임시 파일에 쓴 뒤
          바꿔치기한다 — 쓰다 죽어도 앞의 것이 남는다.
        """
        p = self.dir_of(ws) / RECORDS_NAME
        if not p.is_file():
            return
        hit = {k.encode("utf-8") for k in moves}
        tmp = p.with_suffix(p.suffix + ".tmp")
        with p.open("rb") as fin, tmp.open("wb") as fout:
            for raw in fin:
                if not raw.strip():
                    continue
                f = self._file_of_bytes(raw)
                e = self._enh_of_bytes(raw)
                mine = f is not None and f in hit
                if mine or (e is not None and e in hit):
                    try:
                        row = json.loads(raw.decode("utf-8"))
                        if mine:
                            row["file"] = moves[f.decode("utf-8")]
                            if patch:
                                row.update(patch)
                        if e is not None and e in hit:
                            row["enhance_of"] = moves[e.decode("utf-8")]
                        fout.write(json.dumps(row, ensure_ascii=False).encode("utf-8") + b"\n")
                        continue
                    except Exception:
                        pass          # ★못 읽는 줄은 **그대로 둔다** (버리지 않는다)
                fout.write(raw if raw.endswith(b"\n") else raw + b"\n")
        # ★임시 파일을 **바꿔치기**한다 — 지우는 연산을 이 파일에 두지 않는다
        #   (`test_output_safety` 가 그것을 지킨다: 생성물은 사람이 지울 때만 사라진다).
        self._replace(tmp, p)

    def append_record(self, ws: str, rec: dict) -> None:
        """레코드 한 줄. ★무거운 것은 **`records.db` 로 갈라** 적는다 (`recordsdb` 머리 주석).

        ★순서가 안전장치다: **기록을 먼저** 적는다. 거꾸로 하면 그 사이에 죽었을 때
          색인에는 있는데 무거운 것이 없는 그림이 생긴다 (「새 탭으로 복제」가 조용히 빈손이 된다).
          반대로 기록만 남는 것은 해가 없다 — 아무도 안 찾는 줄일 뿐이다.
        ★★**두 줄을 잇는 것은 `key` 다** (사용자 승인 2026-08-28). 예전에는 **경로**로 이었는데,
          그림을 옮기거나 이름을 바꿀 때마다 100MB 곁파일을 통째로 다시 써야 했고(실측 0.44초),
          안 쓰면 이름 재사용 때문에 조용히 어긋났다. 열쇠는 안 바뀌므로 옮길 때 **색인만**
          고치면 된다 (600KB · 0.01초)."""
        d = self.dir_of(ws)
        d.mkdir(parents=True, exist_ok=True)
        heavy = {k: rec[k] for k in HEAVY_KEYS if rec.get(k) is not None}
        key = str(rec.get("key") or uuid.uuid4().hex[:12])
        rec = {**rec, "key": key}
        if heavy:
            with recordsdb.connect(d) as con:
                recordsdb.put(con, key, heavy)
        light = {k: v for k, v in rec.items() if k not in HEAVY_KEYS}
        with (d / RECORDS_NAME).open("a", encoding="utf-8") as f:
            f.write(json.dumps(light, ensure_ascii=False) + "\n")

    def records(self, ws: str, limit: int = 0) -> list[dict]:
        """색인 전체. ★**제한이 없다** (사용자 결정 2026-08-22) — 무거운 것을 따로 뺀 뒤로
        줄당 211B 라 전부 읽어도 싸다. `limit` 은 옛 부르는 쪽을 위해 남겨 둔 것이다.

        ★쪼개지기 전에 적힌 줄이 섞여 있을 수 있다 (마이그레이션 전 · 옛 백업을 되돌린 경우).
          그 줄에는 무거운 것이 그대로 들어 있으므로 **여기서 걷어 낸다** — 부르는 쪽은
          언제나 가벼운 줄만 본다."""
        p = self.dir_of(ws) / RECORDS_NAME
        if not p.exists():
            return []
        lines = p.read_text(encoding="utf-8").splitlines()
        if limit > 0:
            lines = lines[-limit:]
        out = []
        for ln in lines:
            try:
                r = json.loads(ln)
            except Exception:
                continue  # 깨진 줄은 건너뛴다 — 인덱스일 뿐이다
            for k in HEAVY_KEYS:
                r.pop(k, None)
            out.append(r)
        return out

    def live_records(self, ws: str) -> list[dict]:
        """색인 중 **파일이 지금 있는 줄**만 — 화면에 주는 목록은 이것이다 (사용자 결정 2026-08-28).

        ★★예전에는 지운 그림을 spec 의 `selection.deleted` 에 **경로로 적어 두고** 화면이 걸렀다.
          그 목록은 「파일이 없다」는 사실을 베껴 적은 것이라(실측: 1,446개 전부 파일 없음, 어긋남 0),
          spec 이 덮어써지면 1,441건을 손으로 다시 채워야 했다 (실사고 2026-08-28). 파일의 존재가
          정본이면 베낄 것도, 어긋날 것도 없다 — 휴지통에서 꺼내면 그대로 다시 보인다.
        ★★**있는지는 폴더 목록으로 본다** (사용자 결정 2026-09-30). 한 장씩 물으면 그림 10만 장에
          9.5초였다 (실측). 색인에 나오는 폴더마다 목록을 **한 번씩** 읽으면 0.13초다.
          ★윈도우처럼 대소문자를 가리지 않는다 (`normcase`) — 한 장씩 물을 때와 같은 답이다.
        ★부르는 쪽은 스레드로 돈다 (`server.py` 의 규칙)."""
        d = self.dir_of(ws)
        recs = self.records(ws)
        have: set[str] = set()
        seen: set[str] = set()
        for r in recs:
            parent = str(r.get("file") or "").rpartition("/")[0]
            if parent in seen:
                continue
            seen.add(parent)
            try:
                with os.scandir(d / parent if parent else d) as it:
                    for e in it:
                        if e.is_file():
                            have.add(os.path.normcase(f"{parent}/{e.name}" if parent else e.name))
            except OSError:
                continue                  # 폴더째 없다 — 그 안의 줄은 전부 빠진다
        def listed(parent: str) -> None:
            if parent in seen:
                return
            seen.add(parent)
            try:
                with os.scandir(d / parent if parent else d) as it:
                    for e in it:
                        if e.is_file():
                            have.add(os.path.normcase(f"{parent}/{e.name}" if parent else e.name))
            except OSError:
                pass                      # 폴더째 없다 — 그 안의 줄은 전부 빠진다

        def alive(f: str) -> bool:
            if os.path.normcase(f) in have:
                return True
            # ★옛 배치의 경로면 옮겨 간 자리도 본다 (`_legacy_spots` — 이전이 멈춘 사이에도 그림이 남는다)
            for alt in self._legacy_spots(f):
                listed(alt.rpartition("/")[0])
                if os.path.normcase(alt) in have:
                    return True
            return False

        return [r for r in recs if alive(str(r.get("file") or ""))]

    def heavy_of(self, ws: str, file: str) -> dict:
        """그 그림의 **무거운 것**(`HEAVY_KEYS`: `resolved`·`env`·`inference`). 없으면 빈 것.

        ★색인에서 열쇠를 찾고(같은 경로가 여러 번 적혔으면 마지막 것), `records.db` 에서 그 한 장만
          꺼낸다 (`recordsdb` 머리 주석).
        ★★**두 파일을 잇는 것은 `key` 다** (사용자 승인 2026-08-28, `append_record` 의 ★★주).
          경로로 이으면 **비워진 이름을 다른 그림이 다시 가져가** 조용히 어긋난다
          (스트레스 2026-08-28이 잡았다)."""
        key = self.key_of(ws, file)
        return recordsdb.get(self.dir_of(ws), key) if key else {}

    def key_of(self, ws: str, file: str) -> str | None:
        """그 그림의 **열쇠** — 색인에서 찾는다 (없으면 `None`).
        ★색인은 작다 (줄당 약 260B · 그림 10만 장에 24MB, 한 번 훑는 데 33ms)."""
        p = self.dir_of(ws) / RECORDS_NAME
        if not p.exists():
            return None
        want = f'"file": "{file}"'.encode("utf-8")
        last = None
        with p.open("rb") as f:
            for raw in f:
                if want in raw:
                    last = raw            # ★같은 경로가 여럿이면 **마지막 것**이 지금 그림이다
        if last is None:
            return None
        try:
            r = json.loads(last.decode("utf-8"))
        except Exception:
            return None
        k = r.get("key")
        return str(k) if r.get("file") == file and k else None

    # ── 옛 기록 옮기기 (부팅 때) ──────────────────────────────
    #: 무거운 것이 든 줄의 표식 — 키 목록 하나(`HEAVY_KEYS`)에서 뽑는다
    _HEAVY_MARKS = tuple(f'"{k}"'.encode("utf-8") for k in HEAVY_KEYS)

    @staticmethod
    def _old_key(raw: bytes) -> str:
        """열쇠가 없던 옛 줄의 열쇠 — **줄 내용에서** 만든다. 옮기기가 중간에 끊겨 다시 돌아도 같은
        줄은 같은 열쇠를 받는다 (새로 뽑으면 두 판의 기록이 서로 다른 열쇠로 갈린다)."""
        return hashlib.sha1(raw.rstrip(b"\r\n")).hexdigest()[:12]

    @staticmethod
    def _heavy(r: dict) -> dict:
        """줄에서 무거운 것만. ★레퍼런스 그림은 빼고 옮긴다 (`recordsdb.UNRECORDED`)."""
        heavy = {k: r[k] for k in HEAVY_KEYS if r.get(k) is not None}
        if isinstance(heavy.get("resolved"), dict):
            heavy["resolved"] = recordsdb.recorded(heavy["resolved"])
        return heavy

    def _light_line(self, raw: bytes) -> bool:
        """열쇠가 있고 무거운 것이 없는 색인 줄인가 — **풀지 않고** 본다 (이미 새 모양인 줄)."""
        return self._KEY_KEY_B in raw and not any(m in raw for m in self._HEAVY_MARKS)

    def records_todo(self, ws: str) -> int:
        """옮길 옛 모양이 남았으면 그 바이트 수(진행률의 분모), 없으면 0.

        옛 모양은 셋이다: 곁파일(`records-env.jsonl`)이 있다 · 색인에 무거운 것이 섞여 있다 (쪼개기 전) ·
        색인에 열쇠 없는 줄이 있다 (열쇠를 달기 전).
        ★부팅마다 돈다. 색인은 **바이트로** 훑고 의심 가는 줄만 풀어 본다."""
        d = self.dir_of(ws)
        env, idx = d / ENV_NAME, d / RECORDS_NAME
        n = env.stat().st_size if env.is_file() else 0
        if idx.is_file() and self._index_is_old(idx):
            n += idx.stat().st_size
        return n

    def _index_is_old(self, p: Path) -> bool:
        with p.open("rb") as f:
            for raw in f:
                if not raw.strip() or self._light_line(raw):
                    continue
                try:
                    r = json.loads(raw.decode("utf-8"))
                except Exception:
                    continue              # 못 읽는 줄은 고칠 수도 없다
                if isinstance(r, dict) and (not r.get("key") or self._heavy(r)):
                    return True
        return False

    def migrate_records(self, ws: str, tick=None) -> dict:
        """옛 모양을 `records.db` 로 옮긴다 (사용자 결정 2026-09-30).

        ★★부팅 때 **요청을 막고** 돈다 (`server._records_phase`). 옮기는 동안 탭을 다른 워크스페이스로
          옮기거나 워크스페이스를 지우면 기록이 엇갈린다.

        ① 색인을 훑어 경로 → 열쇠를 정한다 (열쇠 없는 줄은 `_old_key`, 같은 경로는 마지막 것)
        ② 곁파일의 줄을 기록으로 — 열쇠가 적힌 줄은 **뒤의 것이 이기고**, 열쇠 없는 줄은 경로로 잇되
           열쇠가 적힌 줄을 못 이긴다. 무거운 것이 없는 줄(이정표·자국)은 건너뛴다.
           옛 `heavy_of` 가 찾던 순서 그대로다.
        ③ 색인에 섞여 있던 무거운 것(쪼개기 전의 줄)도 기록으로 — 곁파일에 같은 열쇠가 있으면 그쪽이
           이긴다 (옛 `heavy_of` 가 곁파일을 먼저 봤다). 색인은 가벼운 줄 + 열쇠로 다시 쓴다.
        ④ 기록을 다시 열어 **옮긴 열쇠가 전부 있는지** 대조한다. 맞을 때만 색인을 바꿔치기하고
           곁파일을 워크스페이스 휴지통으로 보낸다 (24시간 뒤 비워진다).

        ★줄을 버리지 않는다: 못 읽는 곁줄은 `unread` 에, 못 읽는 색인 줄은 색인에 그대로 남는다.
        ★레퍼런스 그림은 옮기지 않는다 (`_heavy`).
        ★중간에 끊겨도 된다 — 곁파일과 옛 색인이 그대로 남아 다음 부팅에 처음부터 다시 돈다.
          열쇠를 줄 내용에서 만들고 같은 열쇠는 덮어쓰므로 두 번 돌아도 결과가 같다.
        ★통째로 읽지 않는다 — 한 줄씩 (사용자 제보 2026-09-30: 곁파일 2.86GB 에서 부팅이 멈췄다).
        ★`tick(바이트)` 로 진행을 알린다 (`records_todo` 가 센 것과 같은 바이트를 센다)."""
        d = self.dir_of(ws)
        env, idx = d / ENV_NAME, d / RECORDS_NAME
        tick = tick or (lambda _n: None)

        # ① 경로 → 열쇠
        by_path: dict[str, str] = {}
        index_old = index_heavy = False
        if idx.is_file():
            with idx.open("rb") as f:
                for raw in f:
                    if not raw.strip():
                        continue
                    if self._light_line(raw):
                        k, fl = self._key_of_bytes(raw), self._file_of_bytes(raw)
                        if k is not None and fl is not None:
                            by_path[fl.decode("utf-8")] = k.decode("utf-8")
                            continue
                    try:
                        r = json.loads(raw.decode("utf-8"))
                    except Exception:
                        continue
                    if not isinstance(r, dict):
                        continue
                    heavy = bool(self._heavy(r))
                    index_heavy = index_heavy or heavy
                    index_old = index_old or heavy or not r.get("key")
                    by_path[str(r.get("file") or "")] = str(r.get("key") or self._old_key(raw))

        want: set[str] = set()        # 옮긴 열쇠 — ④ 에서 대조한다
        keyed: set[str] = set()       # 열쇠가 적힌 곁줄에서 온 것 — 열쇠 없는 곁줄이 못 덮는다
        unread = 0
        tmp = idx.with_suffix(idx.suffix + ".tmp")
        with recordsdb.connect(d) as con:
            # ② 곁파일
            if env.is_file():
                with env.open("rb") as f:
                    for i, raw in enumerate(f, 1):
                        tick(len(raw))
                        if not raw.strip():
                            continue
                        try:
                            r = json.loads(raw.decode("utf-8"))
                        except Exception:
                            r = None
                        if not isinstance(r, dict):
                            recordsdb.keep_unread(con, raw.rstrip(b"\r\n"))
                            unread += 1
                            continue
                        heavy = self._heavy(r)
                        if not heavy:
                            continue
                        if r.get("key"):
                            key = str(r["key"])
                            keyed.add(key)
                        else:
                            key = by_path.get(str(r.get("file") or "")) or self._old_key(raw)
                            if key in keyed:
                                continue
                        recordsdb.put(con, key, heavy)
                        want.add(key)
                        if i % 500 == 0:
                            con.commit()      # ★끊겨도 다시 돌면 같은 결과다 (머리 주석)
            side = set(want)
            # ③ 색인
            if index_old:
                with idx.open("rb") as fin, tmp.open("wb") as fout:
                    for raw in fin:
                        tick(len(raw))
                        if not raw.strip():
                            continue
                        if self._light_line(raw):
                            fout.write(raw if raw.endswith(b"\n") else raw + b"\n")
                            continue
                        try:
                            r = json.loads(raw.decode("utf-8"))
                        except Exception:
                            r = None
                        if not isinstance(r, dict):
                            fout.write(raw if raw.endswith(b"\n") else raw + b"\n")   # 못 읽는 줄은 그대로
                            continue
                        key = str(r.get("key") or self._old_key(raw))
                        heavy = self._heavy(r)
                        if heavy and key not in side:
                            recordsdb.put(con, key, heavy)
                            want.add(key)
                        light = {k: v for k, v in r.items() if k not in HEAVY_KEYS}
                        light["key"] = key
                        fout.write(json.dumps(light, ensure_ascii=False).encode("utf-8") + b"\n")

        # ④ 대조 — 다시 열어서 본다
        missing = want - recordsdb.keys(d)
        if missing:
            raise RuntimeError(f"옮긴 기록 {len(missing)}건이 {recordsdb.NAME} 에 없습니다")
        if index_old:
            if index_heavy:
                # ★원본을 한 번 남긴다 — 이 앱은 사용자 그림 기록을 잃은 적이 있다 (옛 `split_records` 와 같다)
                shutil.copyfile(idx, d / PRESPLIT_NAME)
            self._replace(tmp, idx)
        trashed = False
        if env.is_file():
            trashed = bool(trash.send_at(d, [ENV_NAME])["moved"])
        return {"moved": len(want), "unread": unread, "trashed": trashed}

    def forget(self, ws: str, rels: list[str]) -> int:
        """휴지통에서 **비워진** 그림의 무거운 기록을 뺀다 (사용자 결정 2026-09-30). 뺀 수를 돌려준다.

        ★★색인 줄은 **남긴다.** 이름을 지을 때 「그 이름을 쓴 적이 있다」를 색인으로 세므로
          (`_names_in` 의 ★★★주), 줄을 지우면 비워진 이름을 새 그림이 다시 받는다. 색인 줄은
          가볍고(줄당 약 260B) 무거운 것은 여기서 빠진다.
        ★폴더째 비워졌으면 그 아래 전부다. ★지금 그 자리에 파일이 있으면 건드리지 않는다 (다른 그림이다).
        ★휴지통을 안 거치고 사라진 그림(탐색기에서 옮긴 것)은 모른다 — 되돌아올 수 있으므로 그대로 둔다."""
        d = self.dir_of(ws)
        gone = {r.strip("/") for r in rels if r and r.strip("/")}
        if not gone or not (d / recordsdb.NAME).is_file():
            return 0
        dead: set[str] = set()
        for r in self.records(ws):
            f, k = str(r.get("file") or ""), r.get("key")
            if not f or not k:
                continue
            parts = f.split("/")
            if not any("/".join(parts[:i]) in gone for i in range(1, len(parts) + 1)):
                continue
            if (d / f).exists():
                continue
            dead.add(str(k))
        return recordsdb.forget(d, dead)

    # ── 옛 배치(`output/멀티/…`)를 새 배치로 (사용자 결정 2026-10-01) ─────────
    def layout_todo(self, ws: str) -> bool:
        """옮길 옛 배치가 남았나. ★싸다 — 폴더 두셋을 본다 (부팅이 문을 닫을지 정하는 자리라 먼저 센다).
        ★옮길 것이 없는데 표식도 없으면 **표식만 세운다** — 그래야 나중에 「멀티」라는 탭이 생겨도
          옛 폴더로 오인하지 않는다 (`LAYOUT_MARK`)."""
        out = self.dir_of(ws) / OUT_DIR
        if not out.is_dir() or (out / LAYOUT_MARK).exists():
            return False
        if (out / LEGACY_MULTI).is_dir() or (out / LAYOUT_TMP).is_dir():
            return True
        (out / LAYOUT_MARK).touch()
        return False

    def migrate_layout(self, ws: str) -> dict:
        """옛 배치 `output/멀티/<탭>/<씬 그룹>/` 를 새 배치 `output/<탭>/<씬 그룹>/` 로 옮긴다.

        ★★**폴더째 옮긴다.** 그림 폴더 안에는 색인에 없는 파일도 산다 (일괄 변환·검열 결과의 하위
          `output/`, 사람이 넣은 것). 줄 단위로 옮기면 그것들이 옛 폴더에 남는다.
        ★`output/멀티` 를 먼저 비켜 두고(`LAYOUT_TMP`) 그 안을 `output/` 으로 올린다 — 탭 이름이 「멀티」여도
          제 부모 자리로 들어가는 꼴이 안 된다. 같은 이름이 이미 있으면(옛 `output/싱글` 과 이름이 같은 탭 ·
          끊긴 이전 뒤에 생긴 것) 폴더는 합치고, 겹치는 파일만 번호를 붙인다 (`trash._free`, 덮지 않는다).
        ★★경로를 든 곳을 전부 고친다: 색인(`file`·`enhance_of`, 파일이 없는 줄까지 — 이름 세기가 쓴다) ·
          별표 · 워크스페이스 휴지통 장부 · 썸네일 캐시 · 워크스페이스 밖(`carry_outside`). 편집 캔버스는
          서버가 따로 고친다 (화면이 뜨기 전이라 화면 대신 파일을 고친다). 고치기 전에 원본을 베낀다 (`.bak-layout`).
        ★끊겨도 된다 — 비켜 둔 폴더가 남아 다음 부팅에 이어 가고, 경로 고치기는 옛 경로만 바꾸므로 두 번 돌아도
          같다. 표식은 맨 끝에 세운다.
        돌려주는 것: 옮긴 항목 수 · 이름이 바뀐 것 수 · 고친 색인 줄 수 · 경로 바꾸기(`fn`, `"<ws>/<rel>"` 를 받는다)."""
        d = self.dir_of(ws)
        out = d / OUT_DIR
        head = f"{OUT_DIR}/{LEGACY_MULTI}"
        renamed: dict[str, str] = {}

        def fn(rel: str) -> str | None:
            r = (rel or "").replace("\\", "/")
            if not r.startswith(head + "/"):
                return None
            parts = r.split("/")
            # ★이름이 바뀐 것은 그 자리(또는 그 폴더) 아래 전부가 따라간다
            for i in range(len(parts), 2, -1):
                hit = renamed.get("/".join(parts[:i]))
                if hit:
                    return "/".join([hit, *parts[i:]])
            return f"{OUT_DIR}/{r[len(head) + 1:]}"

        def full(key: str) -> str | None:
            w, _, rel = (key or "").partition("/")
            new = fn(rel) if w == ws else None
            return f"{ws}/{new}" if new else None

        with self.locked(ws):
            if not out.is_dir() or (out / LAYOUT_MARK).exists():
                return {"moved": 0, "renamed": 0, "rows": 0, "fn": full}
            for f in (d / RECORDS_NAME, d / SPEC_NAME, trash.trash_root(d) / trash.INDEX):
                b = f.with_name(f.name + ".bak-layout")
                if f.is_file() and not b.exists():
                    shutil.copy2(f, b)

            # ① 폴더 — 끊긴 이전이 비켜 둔 것이 있으면 **그것만** 이어 간다. 그때 `output/멀티` 가 있다면
            #   「멀티」라는 탭이 이미 올라온 것이다 (옛 폴더는 비켜 둘 때 이름이 바뀌었다) — 다시 올리면 안 된다
            old, tmp = out / LEGACY_MULTI, out / LAYOUT_TMP
            moved = 0
            if not tmp.is_dir() and old.is_dir():
                old.rename(tmp)
            if tmp.is_dir():
                moved += self._lift(d, tmp, out, head, renamed)
                tmp.rmdir()        # ★빈 폴더만 지운다 — 남은 것이 있으면 여기서 멈추고 다음 부팅에 이어 간다

            # ② 색인 — 파일이 없는 줄까지 (이름을 지을 때 「쓴 적 있는 이름」으로 센다)
            rows = self._rewrite_all(ws, fn)
            # ③ 별표
            spec = self.load(ws)
            starred = ((spec or {}).get("selection") or {}).get("starred")
            if isinstance(starred, list):
                now = [fn(str(x)) or x for x in starred]
                if now != starred:
                    spec["selection"]["starred"] = now
                    self.save(ws, spec)
            # ④ 워크스페이스 휴지통 — 되살리면 새 자리로 온다
            trash.remap_index(trash.trash_root(d), fn)
            # ⑤ 썸네일 캐시 — 이름이 경로에서 나온다 (`thumbs.flat_name`). 없으면 다시 구울 뿐이다
            self._move_thumbs(ws, renamed)
            td = d / THUMB_DIR
            old_flat = thumbs.flat_name(head + "/")[:-len(".webp")]
            new_flat = thumbs.flat_name(OUT_DIR + "/")[:-len(".webp")]
            if td.is_dir():
                for t in td.iterdir():
                    if t.is_file() and t.name.startswith(old_flat):
                        to = td / (new_flat + t.name[len(old_flat):])
                        if not to.exists():
                            with contextlib.suppress(OSError):
                                t.rename(to)
            # ⑥ 워크스페이스 밖 (보관함 출처 · 파일 관리 휴지통)
            if self.carry_outside:
                self.carry_outside(full)
            (out / LAYOUT_MARK).touch()
        return {"moved": moved, "renamed": len(renamed), "rows": rows, "fn": full}

    def _lift(self, base: Path, src: Path, dst: Path, head: str, renamed: dict[str, str]) -> int:
        """`src` 안의 것을 `dst` 로 올린다 (`migrate_layout` ①). 같은 이름의 폴더는 안으로 합치고, 겹치는
        파일은 번호를 받는다 — 그때 옛 경로(`head/…`) → 새 경로를 `renamed` 에 적는다."""
        n = 0
        for c in sorted(src.iterdir()):
            t = dst / c.name
            if not t.exists():
                c.rename(t)
                n += 1
            elif c.is_dir() and t.is_dir():
                n += self._lift(base, c, t, f"{head}/{c.name}", renamed)
                c.rmdir()
            else:
                nt = trash._free(t)
                c.rename(nt)
                renamed[f"{head}/{c.name}"] = nt.relative_to(base).as_posix()
                n += 1
        return n

    def _rewrite_all(self, ws: str, fn) -> int:
        """색인의 **모든 줄**에서 `file`·`enhance_of` 를 `fn` 으로 바꾼다 (`migrate_layout` ②). 바꾼 줄 수를 준다.
        ★`_rewrite_paths` 는 정해진 경로 표로 고치고, 이것은 규칙(옛 앞머리)으로 고친다 — 파일이 없는 줄도 바뀐다.
        ★못 읽는 줄은 그대로 둔다. 임시 파일에 쓰고 바꿔치기한다 (`_rewrite_paths` 와 같다)."""
        p = self.dir_of(ws) / RECORDS_NAME
        if not p.is_file():
            return 0
        n = 0
        tmp = p.with_suffix(p.suffix + ".tmp")
        with p.open("rb") as fin, tmp.open("wb") as fout:
            for raw in fin:
                if not raw.strip():
                    continue
                if b"output/" in raw:
                    try:
                        row = json.loads(raw.decode("utf-8"))
                        hit = False
                        for k in ("file", "enhance_of"):
                            new = fn(str(row.get(k) or "")) if row.get(k) else None
                            if new:
                                row[k] = new
                                hit = True
                        if hit:
                            fout.write(json.dumps(row, ensure_ascii=False).encode("utf-8") + b"\n")
                            n += 1
                            continue
                    except Exception:
                        pass
                fout.write(raw if raw.endswith(b"\n") else raw + b"\n")
        self._replace(tmp, p)
        return n

    def thumb_path(self, ws: str, rel: str) -> Path | None:
        """생성물의 **파생 썸네일**. 히스토리 줄·셀 그리드가 이걸 쓴다.

        ★캐시다 — `.thumbs/` 를 통째로 지워도 다음 요청에 다시 구워진다.
          원본이 더 새로우면(같은 경로에 다른 그림) 자동으로 다시 굽는다."""
        src = self.file_path(ws, rel)
        if not src:
            return None
        # ★캐시 이름도 **지금 이름**으로 짓는다 — 옛 이름으로 물어 왔다고 옛 이름의 캐시를
        #   또 만들면 같은 그림의 썸네일이 두 벌이 된다 (`_moved` 의 ★★주).
        cw, crel = self._current(ws, rel)
        alias = self._legacy_alias(crel)
        if alias and src == (self.dir_of(cw) / alias).resolve():
            crel = alias                     # ★옛 경로로 물었다 — 캐시도 새 자리의 이름으로
        return thumbs.derive(src, self.dir_of(cw) / THUMB_DIR / thumbs.flat_name(crel))

    def file_path(self, ws: str, rel: str) -> Path | None:
        """워크스페이스 밖으로 나가는 경로를 막는다.

        ★★**자취를 따라가며 실제로 있는 자리를 준다** (`_moved` 의 ★★주). 개명은 임시 이름을
          거치므로 「옛 이름 → 임시 → 새 이름」의 사슬이 생기고, 그 중 **지금 존재하는 칸**이
          어디인지는 순간마다 다르다. 그래서 한 칸씩 짚어 보고 처음 있는 것을 돌려준다 —
          옮기는 도중에 물어도 답이 나온다."""
        # ★사슬은 **워크스페이스를 넘을 수 있다** (`move_tab`) — 칸마다 그 워크스페이스 안인지 본다
        seen: set[tuple[str, str]] = set()
        cur = (ws, rel)
        while cur not in seen:
            seen.add(cur)
            base = self.dir_of(cur[0]).resolve()
            p = (base / cur[1]).resolve()
            if str(p).startswith(str(base)) and p.exists():
                return p
            nxt = self._moved.get(cur)
            if not nxt:
                break
            cur = nxt
        base = self.dir_of(ws).resolve()
        for alias in self._legacy_spots(rel):
            p = (base / alias).resolve()
            if str(p).startswith(str(base)) and p.exists():
                return p
        return None

    def _announce(self, ws: str, moves: dict[str, str], dst_ws: str | None = None) -> None:
        """옮긴 그림을 **워크스페이스 밖**에 알린다 (`carry_outside`). 실패해도 옮기기는 이미 끝났다 — 적고 넘어간다."""
        if not moves or not self.carry_outside:
            return
        to = dst_ws or ws
        full = {f"{ws}/{a}": f"{to}/{b}" for a, b in moves.items()}
        try:
            self.carry_outside(full.get)
        except Exception as e:
            print(f"[워크스페이스] {ws}: 옮긴 경로를 밖에 알리지 못했습니다 ({e!r})")

    @staticmethod
    def _legacy_alias(rel: str) -> str | None:
        """옛 배치의 경로(`output/멀티/…`)면 **새 배치의 같은 자리**를 준다 (`migrate_layout`).

        ★★앱이 고치지 못하는 곳에 옛 경로가 남는다 — 플러그인의 데이터(만화 제작기 프로젝트), 조수가
          대화에 적어 둔 경로. 이전이 그 그림을 옮겼어도 옛 경로로 물으면 찾아 준다.
        ★`file_path` 가 그 자리에 없을 때만 쓴다 — 새 배치에서도 「멀티」라는 탭이면 `output/멀티/` 가 있다."""
        head = f"{OUT_DIR}/{LEGACY_MULTI}/"
        r = (rel or "").replace("\\", "/")
        return f"{OUT_DIR}/{r[len(head):]}" if r.startswith(head) else None

    @classmethod
    def _legacy_spots(cls, rel: str) -> list[str]:
        """옛 경로가 **지금 있을 수 있는 자리** — 새 배치의 자리, 그리고 이전이 멈춘 사이 비켜 둔 폴더 안
        (`LAYOUT_TMP`, 다음 부팅에 마저 옮긴다). 그 사이에도 그림이 화면에서 빠지지 않게 한다."""
        alias = cls._legacy_alias(rel)
        if not alias:
            return []
        return [alias, f"{OUT_DIR}/{LAYOUT_TMP}/{alias[len(OUT_DIR) + 1:]}"]

    # ── 그림을 다른 자리로 (탭 옮기기·씬 그룹 옮기기가 함께 쓴다) ──
    def _relocate(self, src_ws: str, rows: list[dict], dst_ws: str, tab_name: str,
                  group_name: str | None = None, others: set[str] | None = None) -> dict[str, str]:
        """그 줄들의 그림을 **`<받는 쪽>/output/<탭>/<세트>/`** 로 옮기고, 옛 경로 → 새 경로 표를 준다.

        ★탭을 통째로 옮기는 것(`move_tab`)과 씬 그룹만 옮기는 것(`move_scene_group`)이 여기서는
          **같은 일**이다 — 자리를 정하는 것은 `out_dir` 하나이고, 이름이 겹치면 `next_name` 이
          생성과 같은 규칙으로 번호를 새로 준다.
        ★★**자리가 그대로면 건드리지 않는다.** 같은 워크스페이스에서 **이름이 같은 탭**으로 옮기면
          폴더가 같은데(탭 이름은 겹칠 수 있다), 그때도 옮기면 멀쩡한 파일이 「이미 있다」로 읽혀
          새 번호를 받는다.
        ★옮기기 **전에** 자취를 남긴다 (`_track`) — 화면이 새 경로를 받기까지의 틈을 덮는다.
        ★썸네일 캐시도 따라간다 (없으면 다음 요청에 다시 구워진다 — 실패해도 그만이다).
        ★같은 뿌리 아래라 `rename` 이다 — 바이트를 다시 쓰지 않는다.
        ★`group_name` 을 주면 **그 이름의 폴더 하나로** 모은다 (씬 그룹 옮기기). 안 주면 줄마다
          제가 적힌 세트 이름을 쓴다 (탭 옮기기 — 그 탭의 세트가 여럿이라 줄마다 다르다)."""
        # ★★**한 폴더가 통째로 가면 `rename` 한 번이다** (실측 2026-08-28: 그림 736장을 한 장씩
        #   옮기면 0.4초, 폴더째면 1ms 남짓). 조건은 셋 — 받는 자리가 하나이고, 그 폴더가 아직
        #   없고, 옮길 줄이 **그 폴더의 파일 전부**여야 한다 (색인에 없는 파일까지 따라가되,
        #   남아야 할 파일을 데려가지 않게).
        whole = self._whole_dir_move(src_ws, rows, dst_ws, tab_name, group_name, others)
        if whole is not None:
            return whole
        moves: dict[str, str] = {}
        names: dict[Path, list[str]] = {}
        for r in rows:
            rel = str(r.get("file") or "")
            p = self.file_path(src_ws, rel)
            if not p or not p.is_file():
                continue
            d = self.out_dir(dst_ws, group_name if group_name is not None else str(r.get("scene_group") or ""), tab_name)
            target = d / p.name
            if target.resolve() == p.resolve():
                continue                      # ★같은 자리다 (이름이 같은 탭) — 옮길 것이 없다
            if target.exists():
                # ★이름이 겹치면 같은 접두로 다음 번호를 받는다 (생성과 같은 규칙)
                cut = max(p.stem.rfind("-"), p.stem.rfind("_"))      # 순번 앞 구분자 (옛 `_` 포함)
                lead = p.stem[:cut] if cut > 0 else ""
                got = names.get(d)
                if got is None:
                    got = names[d] = self._names_in(d, dst_ws)
                target = self.next_name(d, lead, p.suffix.lstrip("."), dst_ws, got)
                got.append(target.name)
            self._track(src_ws, p, target, dst_ws)   # ★옮기기 **전에** 적는다 (`renumber` 와 같은 순서)
            p.rename(target)
            moves[rel] = self.rel(dst_ws, target)

        self._move_thumbs(src_ws, moves, dst_ws)
        return moves

    def _whole_dir_move(self, src_ws: str, rows: list[dict], dst_ws: str, tab_name: str,
                        group_name: str | None, others: set[str] | None = None) -> dict[str, str] | None:
        """세트 폴더가 **통째로** 옮겨지는 경우 — `rename` 한 번으로 끝낸다 (위 ★★주). 아니면 `None`.

        ★받는 폴더가 이미 있으면 안 된다 (이름이 겹치는 세트가 그쪽에 있다는 뜻이다) — 그때는
          한 장씩 가면서 `next_name` 이 번호를 새로 준다.
        ★★**그 폴더를 다른 세트와 나눠 쓰면 안 된다** (`others` — 이 워크스페이스 색인의 나머지
          경로). 폴더 이름은 `<탭>/<세트>` 라, 옛 데이터에 같은 이름의 세트가 둘 있으면 한 폴더를
          나눠 쓴다. 그때 통째로 옮기면 **남의 세트 그림까지 데려간다.**
        ★반대로 **색인에 없는 파일·하위 폴더는 함께 간다** (업스케일 결과가 앉는 `output/`,
          사람이 넣어 둔 것). 그 폴더가 그 세트의 자리이므로 거기 있는 것은 그 세트의 것이고,
          두고 가면 **빈 폴더에 남아** 어디서도 안 보이게 된다.
        ★자취(`_track`)는 한 장씩과 똑같이 남긴다 — 화면이 새 목록을 받기 전의 요청을 덮는다."""
        if not rows:
            return None
        # ★판정은 **문자열로** 한다 — 장마다 경로를 정규화하면 그것만으로 수백 ms 다 (`_track_rel` 의 ★주)
        rels = [str(r.get("file") or "").replace("\\", "/") for r in rows]
        if not all(rels):
            return None
        parents = {r.rsplit("/", 1)[0] for r in rels if "/" in r}
        if len(parents) != 1 or len(parents) != len(set(parents)):
            return None                      # 여러 폴더에 흩어져 있다 — 한 장씩
        src_rel = parents.pop()
        src_dir = self.dir_of(src_ws) / src_rel
        if not src_dir.is_dir():
            return None
        gname = group_name if group_name is not None else str(rows[0].get("scene_group") or "")
        if group_name is None and any(str(r.get("scene_group") or "") != gname for r in rows):
            return None                      # 세트 이름이 줄마다 다르다 — 한 장씩
        # ★`out_dir` 로 뿌리를 얻는다 — 받는 쪽에 `output/` 이 처음 생기면 새 배치 표식도 함께 선다
        dst_dir = self.out_dir(dst_ws, "") / safe_name(tab_name) / safe_name(gname)
        if dst_dir == src_dir or dst_dir.exists():
            return None                      # 같은 자리이거나 받는 폴더가 이미 있다
        if others and any(o.startswith(src_rel + "/") for o in others):
            return None                      # 그 폴더를 **다른 세트와 나눠 쓴다** — 한 장씩
        mine = {r.rsplit("/", 1)[1] for r in rels}
        here = {p.name for p in src_dir.iterdir() if p.is_file()}
        if mine - here:
            return None                      # 색인이 가리키는 것이 그 폴더에 없다 — 한 장씩
        dst_rel = self.rel(dst_ws, dst_dir)
        dst_dir.parent.mkdir(parents=True, exist_ok=True)
        moves: dict[str, str] = {}
        for rel in rels:                      # ★옮기기 **전에** 자취를 적는다
            now = f"{dst_rel}/{rel.rsplit('/', 1)[1]}"
            self._track_rel(src_ws, rel, dst_ws, now)
            moves[rel] = now
        src_dir.rename(dst_dir)
        self._move_thumbs(src_ws, moves, dst_ws)
        return moves

    # ── 별표·숨김은 그림을 따라간다 ───────────────────────────
    @staticmethod
    def _carry_selection(spec: dict, moves: dict[str, str]) -> None:
        """별표의 경로를 새 경로로 갈아 끼운다.

        ★★**경로로 적혀 있어서 옮기면 조용히 풀린다** (사용자 지적 2026-08-28: *"씬끼리 옮길 땐
          별표 데이터가 유지되는데, 다른 탭으로 보내면 사라짐"*) — 「별표만 보기」에서 그림이
          사라져 보인다.
        ★개명(`renumber`)에서는 화면이 같은 일을 한다 (`store/workspace.ts` 의 `runRenumber`).
        ★지운 그림의 목록(`deleted`)은 더 없다 — 파일의 존재가 정본이다 (`live_records`)."""
        sel = spec.get("selection")
        if not isinstance(sel, dict) or not moves:
            return
        v = sel.get("starred")
        if isinstance(v, list):
            sel["starred"] = [moves.get(str(f), f) for f in v]

    @staticmethod
    def _hand_selection(src: dict, dst: dict, moves: dict[str, str]) -> None:
        """워크스페이스를 건너갈 때 — 그 그림들의 별표를 **받는 쪽으로 넘긴다**.
        ★주는 쪽에서 빼지 않으면 없는 경로가 남고, 받는 쪽에 넣지 않으면 별이 풀린다."""
        ssel = src.get("selection")
        if not isinstance(ssel, dict) or not moves:
            return
        v = ssel.get("starred")
        if not isinstance(v, list):
            return
        ssel["starred"] = [f for f in v if str(f) not in moves]
        got = [moves[str(f)] for f in v if str(f) in moves]
        if not got:
            return
        dsel = dst.get("selection")
        if not isinstance(dsel, dict):
            dsel = dst["selection"] = {}
        cur = dsel.get("starred") if isinstance(dsel.get("starred"), list) else []
        dsel["starred"] = cur + [g for g in got if g not in cur]

    # ── 씬 그룹을 같은 워크스페이스의 다른 탭으로 ──────────────
    def move_scene_group(self, ws: str, group_id: str, to_tab_id: str, fill: dict | None = None) -> dict:
        """씬 그룹 하나를 **다른 탭 밑으로 옮긴다** (사용자 지시 2026-08-28: *"씬 그룹을 다른 탭에
        넣는 기능도 추가"*). 그림·레코드·썸네일 캐시가 함께 간다.

        ★**탭 옮기기의 축소판이다** — 다른 것은 둘뿐이다: (a) 한 워크스페이스 안이라 id 가 겹칠 일이
          없어 새 id 를 주지 않는다 (한 spec 안에서 이미 유일하다), (b) 색인은 줄이 오갈 곳이
          없어 **경로만 갈아 끼운다** (`_rewrite_paths` — 개명이 쓰는 그 경로).
        ★★파일이 **받는 탭의 폴더로 간다** — 자리는 `output/<탭>/<세트>/` 라 탭이 바뀌면 자리도
          바뀐다. 안 옮기면 탐색기에서는 옛 탭 밑에 있는데 앱에서는 새 탭에 보인다.
        ★★그 탭의 **마지막 세트**를 옮기면 그 자리에 빈 세트를 세운다 — 세트가 하나도 없는 탭은
          생성이 불가능하다 (사용자 지시 2026-08-26, `store/workspace.ts` 의 `migrate` 가 여는
          자리에서 메우는 것과 같은 모양이다). 이름은 화면이 `fill` 로 준다 (화면의 언어다).
        ★받는 탭의 **줄 끝**에 선다 — 끌어다 놓은 것이 어디로 갔는지 눈으로 찾을 수 있어야 한다.
        ★★**받는 탭에 같은 이름의 세트가 있으면 뒤에 번호를 붙인다** (사용자 제안 2026-08-28).
          세트 이름도 폴더라, 그대로 두면 그 세트의 그림과 한 폴더에 섞인다. 이름이 바뀌면
          **색인에 적힌 세트 이름도** 함께 간다 — 폴더와 적힌 이름이 어긋나면 다음 생성이
          또 다른 폴더로 간다."""
        with self.locked(ws):
            return self._move_group_locked(ws, group_id, to_tab_id, fill)

    def _move_group_locked(self, ws: str, group_id: str, to_tab_id: str, fill: dict | None = None) -> dict:
        spec = self.load(ws)
        if not spec:
            raise ValueError("워크스페이스를 찾지 못했습니다")
        groups = spec.get("sceneGroups") or []
        g = next((x for x in groups if x.get("id") == group_id), None)
        if not g:
            raise ValueError("그 씬 그룹이 없습니다")
        to = next((t for t in (spec.get("tabs") or []) if t.get("id") == to_tab_id), None)
        if not to:
            raise ValueError("그 탭이 없습니다")
        src_tab = g.get("tabId")
        if src_tab == to_tab_id:
            raise ValueError("같은 탭입니다")
        own = [x for x in groups if x.get("tabId") == src_tab]
        left = [x for x in own if x.get("id") != group_id]
        if not left and not fill:
            raise ValueError("마지막 세트는 옮길 수 없습니다")

        # ① 그 그룹의 그림 — id 로 묶고, id 가 없는 옛 줄은 세트 이름으로 (`takesOf` 의 폴백과 같다)
        rows_all = self.records(ws)
        mine = [
            r for r in rows_all
            if r.get("scene_group_id") == group_id
            or (not r.get("scene_group_id") and r.get("scene_group") == g.get("name"))
        ]
        # ★그 폴더를 다른 세트와 나눠 쓰는지 보려면 **나머지 줄의 경로**가 필요하다 (`_whole_dir_move`)
        ours = {str(r.get("file") or "") for r in mine}
        others = {str(r.get("file") or "") for r in rows_all} - ours
        # ★이름이 겹치면 뒤에 번호 (사용자 제안 2026-08-28) — 세트 이름도 폴더라, 그대로 두면
        #   받는 탭의 같은 이름 세트와 **한 폴더에 섞인다**
        was = str(g.get("name") or "")
        name = unique_name(was, [str(x.get("name") or "") for x in groups
                                 if x.get("tabId") == to_tab_id and x.get("id") != group_id])
        g["name"] = name
        moves = self._relocate(ws, mine, ws, str(to.get("name") or ""), name, others)
        # ② 경로를 갈아 끼운다 — 같은 워크스페이스라 줄이 오갈 곳이 없고, id 도 그대로다.
        #   ★이름이 바뀌었으면 색인의 세트 이름도 함께 — 폴더와 적힌 이름이 어긋나면 다음 생성이
        #     또 다른 폴더로 간다
        if moves:
            self._rewrite_paths(ws, moves, {"scene_group": name} if name != was else None)
            self._carry_selection(spec, moves)   # ★별표·숨김도 새 경로로 (그 함수의 ★★주)
            self._announce(ws, moves)

        # ③ spec — 받는 탭의 **줄 끝**에 세운다 (줄 차례가 곧 배열 차례다)
        rest = [x for x in groups if x.get("id") != group_id]
        g["tabId"] = to_tab_id
        at = max((i for i, x in enumerate(rest) if x.get("tabId") == to_tab_id), default=len(rest) - 1) + 1
        rest.insert(at, g)
        spec["sceneGroups"] = rest
        new_id = None
        if not left:
            ng = {"id": f"tab_{uuid.uuid4().hex[:8]}", "kind": "sceneGroup",
                  "name": str((fill or {}).get("group") or ""), "tabId": src_tab,
                  "idOnly": True, "cards": [], "cellSeq": 0, "cardSeq": 0}
            spec["sceneGroups"].append(ng)
            new_id = ng["id"]
        # ★보고 있던 세트가 나갔으면 그 탭에 남은 것(없으면 방금 세운 빈 세트)으로
        if spec.get("activeSceneGroup") == group_id and spec.get("activeTab") == src_tab:
            spec["activeSceneGroup"] = left[0]["id"] if left else new_id
        self.save(ws, spec)
        return {"ok": True, "moved": len(moves), "moves": moves, "spec": spec, "records": self.live_records(ws)}

    # ── 탭·씬 그룹 이름 바꾸기 — 그림이 새 이름의 폴더로 따라간다 ─────
    def rename_place(self, ws: str, kind: str, place_id: str, name: str) -> dict:
        """탭(`kind="tab"`)이나 씬 그룹(`kind="sceneGroup"`)의 이름을 바꾸고, 그 그림을
        **새 이름의 폴더로 옮긴다** (사용자 결정 2026-09-29).

        ★★예전에는 이름만 바꿨다. 저장 자리는 이름으로 짓는데(`out_dir`) 이미 만든 그림은 옛 폴더에
          남아, 한 탭의 그림이 두 폴더로 갈렸다. 비워진 옛 이름을 나중에 다른 탭(「복제 3」 같은
          기본 이름)이 다시 받으면 **남의 탭 그림과 한 폴더에 섞였다** (사용자 데이터 실측 2026-09-29:
          한 폴더를 탭 셋이 나눠 썼다).
        ★옮기는 것은 씬 그룹 옮기기와 같은 `_relocate` 다. 그 그룹의 줄을 **어디 있든** 모으므로
          전에 갈려 있던 그림도 이번에 한 폴더로 모인다.
        ★씬 그룹 이름이 바뀌면 색인에 적힌 세트 이름(`scene_group`)도 함께 바꾼다 — id 가 없는
          옛 줄은 그 이름으로 묶인다 (`lib/takes.ts` 의 `takesOf`).
        ★생성 중인지는 부르는 쪽이 본다 (`server.py` 의 `_refuse_if_generating`)."""
        name = str(name or "").strip()
        if not name:
            raise ValueError("이름이 비어 있습니다")
        with self.locked(ws):
            spec = self.load(ws)
            if not spec:
                raise ValueError("워크스페이스를 찾지 못했습니다")
            tabs = spec.get("tabs") or []
            groups = spec.get("sceneGroups") or []
            if kind == "tab":
                place = next((t for t in tabs if t.get("id") == place_id), None)
                if not place:
                    raise ValueError("그 탭이 없습니다")
                targets = [g for g in groups if g.get("tabId") == place_id]
            elif kind == "sceneGroup":
                place = next((g for g in groups if g.get("id") == place_id), None)
                if not place:
                    raise ValueError("그 씬 그룹이 없습니다")
                targets = [place]
            else:
                raise ValueError(f"모르는 대상입니다: {kind}")
            was = str(place.get("name") or "")
            place["name"] = name
            tab_names = {t.get("id"): str(t.get("name") or "") for t in tabs}

            rows_all = self.records(ws)
            files_all = {str(r.get("file") or "") for r in rows_all}
            moves: dict[str, str] = {}
            renamed: set[str] = set()      # 이름이 바뀐 그룹의 줄 — 세트 이름을 새로 적는다
            for g in targets:
                gid = g.get("id")
                # ★id 가 없는 옛 줄은 **그룹의 옛 이름**으로 묶는다. idOnly 그룹은 폴백을 안 쓴다 (`takesOf`)
                gname_was = was if kind == "sceneGroup" else str(g.get("name") or "")
                mine = [
                    r for r in rows_all
                    if r.get("scene_group_id") == gid
                    or (not r.get("scene_group_id") and not g.get("idOnly") and r.get("scene_group") == gname_was)
                ]
                ours = {str(r.get("file") or "") for r in mine}
                if kind == "sceneGroup":
                    renamed |= ours
                moves.update(self._relocate(ws, mine, ws, tab_names.get(g.get("tabId"), ""),
                                            str(g.get("name") or ""), files_all - ours))
            # ★세트 이름은 **옮기지 않은 줄에도** 적는다 — 이미 새 이름의 폴더에 있던 것(이름을
            #   되돌린 경우)도 id 없는 폴백이 새 이름으로 찾아야 한다
            rewrite = {**{f: f for f in renamed}, **moves}
            if rewrite:
                self._rewrite_paths(ws, rewrite, {"scene_group": name} if kind == "sceneGroup" else None)
                self._carry_selection(spec, moves)   # ★별표도 새 경로로 (그 함수의 ★★주)
                self._announce(ws, moves)
            self.save(ws, spec)
            return {"ok": True, "moved": len(moves), "moves": moves, "spec": spec,
                    "records": self.live_records(ws)}

    # ── 탭을 다른 워크스페이스로 ─────────────────────────────
    def move_tab(self, src_ws: str, tab_id: str, dst_ws: str, fill: dict | None = None) -> dict:
        """탭 하나를 **다른 워크스페이스로 옮긴다** — `_move_tab_locked` 를 두 워크스페이스의 잠금 안에서.
        ★잠금 밖에서 돌던 때의 실사고는 `save` 의 ★★주·`locked` 의 ★주."""
        if src_ws == dst_ws:
            raise ValueError("같은 워크스페이스입니다")
        with self.locked(src_ws, dst_ws):
            return self._move_tab_locked(src_ws, tab_id, dst_ws, fill)

    def _move_tab_locked(self, src_ws: str, tab_id: str, dst_ws: str, fill: dict | None = None) -> dict:
        """탭 하나를 **다른 워크스페이스로 옮긴다** — 씬 그룹·그림·레코드·썸네일 캐시가 함께 간다
        (사용자 지시 2026-08-28: *"탭을 끌어다가 다른 워크스페이스에 두면 거기로 옮겨지게"*).

        ★옮기는 것이지 복사가 아니다: 주는 쪽에서는 사라진다. 되돌리려면 도로 끌어오면 된다.
        ★★마지막 탭을 옮기면 **빈 새 탭을 채운다** (사용자 지시 2026-08-28: *"마지막 탭도 옮기면
          그냥 즉시 빈 새 탭 만들어 주면 되는 거 아닌가"*). 모양(이름·빈 프롬프트)은 화면이
          `fill` 로 준다 — 언어도 프롬프트 골격도 화면 것이라 여기서 지어내지 않는다.
          `fill` 이 없으면(옛 화면) 거절한다.
        ★★옮기는 동안에도 옛 자리로 찾을 수 있다 — 개명(`renumber`)과 같은 자취(`_track`)를
          **워크스페이스 너머로** 남긴다. 화면이 새 목록을 받기까지의 틈에 요청이 와도 404 가 아니다.
        ★★**이름이 겹치면 뒤에 번호를 붙인다** (사용자 제안 2026-08-28) — 탭 이름이 곧 저장 폴더라
          (`out_dir`), 같은 이름으로 들어가면 남의 탭 그림과 한 폴더에 섞인다. 규칙은 만들 때와
          같다 (`unique_name`).
        ★★id 가 받는 쪽과 겹치면 **새 id 를 준다** — 탭·씬 그룹·카드·씬 전부. 워크스페이스마다
          `ch_1`·`t_1` 처럼 같은 씨앗에서 번호를 매기므로 겹치는 일이 흔하다. 레코드의
          `scene_group_id`·`cell_id` 도 같은 표로 바꾼다 — 안 바꾸면 그림이 받는 쪽 화면 어디에도
          안 뜬다 (`lib/takes.ts` 는 id 로 묶는다).
        ★파일은 받는 쪽의 `output/<탭>/<세트>/` 로 간다 (`out_dir` 하나가 자리를 정한다).
          이름은 그대로 두되 이미 있으면 `next_name` 으로 번호를 새로 받는다.
        ★색인은 **줄 단위로 옮긴다** — 그 줄을 받는 쪽 끝에 붙이고(경로·id 만 고쳐서),
          주는 쪽에서는 그 줄을 뺀 사본으로 바꿔치기한다 (`_rewrite_paths` 와 같은 방식).
          무거운 기록은 열쇠로 골라 받는 쪽 `records.db` 로 옮긴다. 지우는 파일 연산은 없다 (`test_output_safety`).
        ★같은 뿌리 아래의 폴더끼리라 `rename` 으로 옮긴다 — 바이트를 다시 쓰지 않는다.
        ★속도(실측 2026-08-28, 그림 736장): rename 0.4초 + 색인 재작성. 화면은 이 답을
          기다리지 않고 **놓는 즉시** 탭을 뺀다 (`store/workspace.ts` 의 `moveTabToWs`).
        """
        src = self.load(src_ws)
        dst = self.load(dst_ws)
        if not src or not dst:
            raise ValueError("워크스페이스를 찾지 못했습니다")
        tabs = src.get("tabs") or []
        tab = next((t for t in tabs if t.get("id") == tab_id), None)
        if not tab:
            raise ValueError("그 탭이 없습니다")
        if len(tabs) <= 1 and not fill:
            raise ValueError("마지막 탭은 옮길 수 없습니다")
        groups = [g for g in (src.get("sceneGroups") or []) if g.get("tabId") == tab_id]
        gids = {g.get("id") for g in groups}
        gnames = {g.get("name") for g in groups}

        # ① 받는 쪽과 겹치는 id 는 새로 준다
        used: set[str] = set()
        for t in dst.get("tabs") or []:
            used.add(t.get("id"))
        for g in dst.get("sceneGroups") or []:
            used.add(g.get("id"))
            for c in g.get("cards") or []:
                used.add(c.get("id"))
                for cell in c.get("cells") or []:
                    used.add(cell.get("id"))
        remap: dict[str, str] = {}

        def fresh(old: str | None) -> str | None:
            if old is None:
                return None
            if old not in used:
                used.add(old)
                return old
            n = 2
            while f"{old}-{n}" in used:
                n += 1
            new = f"{old}-{n}"
            used.add(new)
            remap[old] = new
            return new

        tab = copy.deepcopy(tab)
        groups = copy.deepcopy(groups)
        tab["id"] = fresh(tab.get("id"))
        # ★이름이 겹치면 뒤에 번호 (사용자 제안 2026-08-28) — 탭 이름이 곧 폴더라,
        #   그대로 두면 남의 탭 그림과 **한 폴더에 섞인다**
        tab["name"] = unique_name(str(tab.get("name") or ""),
                                  [str(t.get("name") or "") for t in dst.get("tabs") or []])
        for g in groups:
            g["id"] = fresh(g.get("id"))
            g["tabId"] = tab["id"]
            for c in g.get("cards") or []:
                c["id"] = fresh(c.get("id"))
                for cell in c.get("cells") or []:
                    cell["id"] = fresh(cell.get("id"))

        # ② 그 탭의 그림 — id 로 묶고, id 가 없는 옛 줄은 세트 이름으로 (`takesOf` 의 폴백과 같다)
        rows_all = self.records(src_ws)
        mine = [
            r for r in rows_all
            if r.get("scene_group_id") in gids
            or (not r.get("scene_group_id") and r.get("scene_group") in gnames)
        ]
        ours = {str(r.get("file") or "") for r in mine}
        others = {str(r.get("file") or "") for r in rows_all} - ours
        # ③ 파일·썸네일을 받는 쪽 자리로 (`_relocate` — 씬 그룹 옮기기와 같은 일이라 한곳에 있다)
        moves = self._relocate(src_ws, mine, dst_ws, str(tab.get("name") or ""), None, others)

        # ④ 색인·기록 — 색인 줄은 받는 쪽 끝에 붙이고(경로·id 만 고쳐서), 주는 쪽에서는 뺀 사본으로 바꿔치기한다
        #   ★★순서가 안전장치다: 기록을 받는 쪽에 **먼저 베끼고**(`append_record` 와 같은 순서), 색인을
        #     옮긴 **뒤에** 주는 쪽 기록을 뺀다. 그 사이에 멈춰도 어느 쪽 색인이든 제 기록을 찾는다
        #     (남는 것은 아무도 안 찾는 사본뿐이다).
        #   ★★기록은 **열쇠로** 고른다. 경로는 개명으로 바뀌어도 열쇠는 그대로다 (`append_record` 의 ★★주).
        sd = self.dir_of(src_ws)
        dd = self.dir_of(dst_ws)
        dd.mkdir(parents=True, exist_ok=True)
        hit = {k.encode("utf-8") for k in moves}
        by_key: dict[bytes, str] = {}
        for r in mine:
            k, f = r.get("key"), str(r.get("file") or "")
            if k and f in moves:
                by_key[str(k).encode("utf-8")] = moves[f]
        p = sd / RECORDS_NAME
        tmp = p.with_suffix(p.suffix + ".tmp")
        gone: list[bytes] = []          # 받는 쪽에 붙일 줄
        keys: list[str] = []            # 함께 가는 기록의 열쇠
        if p.is_file():
            with p.open("rb") as fin, tmp.open("wb") as fout:
                for line in fin:
                    if not line.strip():
                        continue
                    f = self._file_of_bytes(line)
                    k = self._key_of_bytes(line)
                    to = by_key.get(k) if k else None
                    if to is None and f is not None and f in hit:
                        to = moves[f.decode("utf-8")]
                    if to is not None:
                        try:
                            row = json.loads(line.decode("utf-8"))
                            row["file"] = to
                            # ★강화·업스케일 결과면 원본 경로도 (같은 탭이라 함께 옮겨졌다)
                            if row.get("enhance_of") in moves:
                                row["enhance_of"] = moves[row["enhance_of"]]
                            for k in ("scene_group_id", "cell_id"):
                                if row.get(k) in remap:
                                    row[k] = remap[row[k]]
                            gone.append(json.dumps(row, ensure_ascii=False).encode("utf-8") + b"\n")
                            if row.get("key"):
                                keys.append(str(row["key"]))
                            continue
                        except Exception:
                            pass          # ★못 읽는 줄은 주는 쪽에 **그대로 둔다**
                    fout.write(line if line.endswith(b"\n") else line + b"\n")
            recordsdb.copy(sd, dd, keys)
            with (dd / RECORDS_NAME).open("ab") as fdst:
                fdst.writelines(gone)
            self._replace(tmp, p)
            recordsdb.forget(sd, keys)

        # ⑤ 두 spec — 받는 쪽에 붙이고, 주는 쪽에서 뺀다 (활성 탭·그룹은 `removeTab` 과 같은 규칙)
        self._hand_selection(src, dst, moves)   # ★별표·숨김도 함께 건너간다 (그 함수의 ★주)
        self._announce(src_ws, moves, dst_ws)
        dst.setdefault("tabs", []).append(tab)
        dst.setdefault("sceneGroups", []).extend(groups)
        self.save(dst_ws, dst)
        src["tabs"] = [t for t in tabs if t.get("id") != tab_id]
        src["sceneGroups"] = [g for g in (src.get("sceneGroups") or []) if g.get("id") not in gids]
        if not src["tabs"]:
            # ★마지막 탭이 나갔다 — 화면이 준 모양으로 빈 탭과 빈 씬 그룹을 하나씩 세운다
            nt = {"id": f"ch_{uuid.uuid4().hex[:8]}", "name": str((fill or {}).get("tab") or "")}
            if (fill or {}).get("prompt") is not None:
                nt["prompt"] = fill["prompt"]
            ng = {"id": f"tab_{uuid.uuid4().hex[:8]}", "kind": "sceneGroup",
                  "name": str((fill or {}).get("group") or ""), "tabId": nt["id"], "idOnly": True, "cards": []}
            src["tabs"] = [nt]
            src["sceneGroups"] = [ng]
        if src.get("activeTab") == tab_id:
            src["activeTab"] = src["tabs"][0].get("id")
        if src.get("activeSceneGroup") in gids:
            own = [g for g in src["sceneGroups"] if g.get("tabId") == src.get("activeTab")]
            pick = own[0] if own else (src["sceneGroups"][0] if src["sceneGroups"] else None)
            src["activeSceneGroup"] = pick.get("id") if pick else ""
        self.save(src_ws, src)
        return {"ok": True, "moved": len(moves), "moves": moves, "tab_id": tab["id"], "spec": src,
                "records": self.live_records(src_ws)}

    # ── 새 탭으로 복제 ────────────────────────────────────────
    def copy_to_scene_group(
        self,
        ws: str,
        file: str,
        scene_group_name: str,
        scene_group_id: str | None,
        cell: str | None,
        cell_id: str | None,
        cell_no: int | None,
        tab_name: str | None,
        exclude_no: bool,
        src_path: Path | None = None,
        seed: int | None = None,
        env: dict | None = None,
    ) -> dict:
        """그림 한 장을 **같은 워크스페이스의 다른 탭**으로 복사한다 (원본은 그대로).

        「새 탭으로 복제」가 부르는 자리다 (사용자 결정 2026-08-18). 옛 「다른 탭으로 복제」는
        싱글 폴더에 넣었는데 싱글 탭이 없어져 갈 곳이 사라졌다 — 그 경로를 지우고 이것으로 합쳤다.

        ★옮기지 않고 **복사**한다. 원본이 그대로라 보던 화면·선택이 흐트러지지 않는다.
        ★이름·자리는 `store_output` 하나가 정한다 — 보통 생성과 같은 규칙이라야 받는 씬의
          번호열이 어긋나지 않는다.
        ★레코드에 `scene_group_id`·`cell_id` 를 함께 쓴다 — 받는 세트가 `idOnly` 라 그것이 없으면
          복사해 놓고 화면 어디에도 안 뜬다 (`lib/takes.ts`).

        ★`src_path` 는 **워크스페이스 밖의 원본**이다 (보관함 그림). 갤러리의
          「새 탭으로 복제」도 그림이 슬롯에 앉아야 해서 같은 자리를 쓴다 (사용자 지시
          2026-08-19: *"슬롯에서 복제할때랑 동일한 로직 사용해"*). 그때는 이 워크스페이스에
          그 파일의 레코드가 없으므로 **시드도 밖에서 받는다**(`seed`, 메타데이터에서 읽은 값)."""
        src = src_path or self.file_path(ws, file)
        if not src or not src.is_file():
            raise ValueError("복제할 그림을 찾지 못했습니다")
        old = next(
            (r for r in reversed(self.records(ws, limit=100000)) if r.get("file") == file),
            {},
        )
        fmt = src.suffix.lstrip(".").lower() or "png"
        rel = self.store_output(ws, scene_group_name, cell, cell_no, tab_name, exclude_no, fmt, src.read_bytes())
        # ★`resolved`(그때 나간 페이로드)와 `enhance_of` 는 안 싣는다. resolved 는 바이브·베이스
        #   그림의 base64 가 들어 있어 크고, enhance_of 는 **다른 탭의 파일**을 가리키는
        #   출처 기록이라 옮겨 오면 뜻이 어긋난다 (`/api/save-preview` 와 같은 판단).
        rec = {
            "ts": datetime.now().isoformat(timespec="seconds"),
            "file": rel,
            "scene_group": scene_group_name,
            "cell": cell,
            "scene_group_id": scene_group_id,
            "cell_id": cell_id,
            "enhance_of": None,
            "seed": int(seed if seed is not None else (old.get("seed") or 0)),
            # ★원본의 화면 구조 (`env`) — 부르는 쪽이 찾아 준다 (`server.copy_to_tab`)
            "env": env,
        }
        self.append_record(ws, rec)
        # ★무거운 것은 빼고 준다 (`/api/save-preview` 와 같은 규칙) — 화면은 필요할 때 `/env` 로 가져간다
        return {"ok": True, "file": rel, "record": {k: v for k, v in rec.items() if k not in HEAVY_KEYS}}
