"""워크스페이스 저장 — docs/renewal/schema.md 구현.

구조:
    workspaces/<워크스페이스>/
      workspace.json     ← spec (의도. 사람·LLM 이 편집)
      records.jsonl      ← 사실 (코드만 쓴다, append-only)
      output/싱글/<탭>/*.png              ← 생성물 = 원본. 앱이 자동으로 지우지 않는다
      output/멀티/<캐릭터>/<포즈세트>/*.png
      work/<탭>/<셀>/*.png                ← ★옛 경로. **읽기만** 한다 (아래 out_dir 주석)

★records.jsonl 은 인덱스이지 정본이 아니다. 정본은 PNG 메타데이터다.
  손상되면 이미지 폴더를 훑어 재구축할 수 있어야 한다.
"""
from __future__ import annotations

import copy
import json
import re
import threading
import time
import uuid
from contextlib import contextmanager
from datetime import datetime
from pathlib import Path

import thumbs
import trash

SPEC_NAME = "workspace.json"
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
#:  ★성질은 그대로 append-only JSONL 이다: 사람이 읽을 수 있고, 쓰다 죽어도 앞줄은 온전하다.
ENV_NAME = "records-env.jsonl"
#: 색인에서 빼고 곁파일로 보내는 필드
HEAVY_KEYS = ("resolved", "env")
#: ★★**별표의 이력** (사용자 결정 2026-08-28). 별표는 `workspace.json` 한 곳에만 적혀서, 그 파일이
#:  덮어써지면(실사고 2026-08-28: 다른 워크스페이스의 spec 이 이 이름으로 저장됐다) 되살릴 재료가
#:  없었다. 저장할 때 별표 목록이 **바뀌었을 때만** 한 줄 덧붙인다 — 되돌릴 때는 마지막 줄을 본다.
#:  ★spec 통째 사본(`.bak/`)을 걷어낸 까닭(`save` 의 ★★주)을 피한다: 타이핑 중 저장에는 별표가
#:    안 바뀌므로 줄이 안 는다.
STARS_NAME = "stars.jsonl"
#: 쪼개기 전 원본을 한 번 남긴다 (지워도 앱은 돈다 — 되살릴 때만 쓴다)
PRESPLIT_NAME = "records-before-split.jsonl"
OUT_DIR = "output"     # 생성물이 사는 곳 (사용자 결정 2026-08-08)
#: ★그 아래 한 겹. 「싱글/멀티」로 갈리던 시절의 이름이 그대로 남은 것이다 —
#:  갈래는 2026-08-24 에 없어졌고(`out_dir` 의 ★★주) 이름만 **호환을 위해** 둔다.
#:  바꾸면 이미 만든 그림과 새 그림이 두 폴더로 갈린다.
MULTI_DIR = "멀티"
# 파생 썸네일 캐시 — 원본에서 자동으로 굽는다. 지워도 다시 생긴다 (thumbs.py 참조)
THUMB_DIR = ".thumbs"

_SAFE = re.compile(r'[<>:"/\\|?*\x00-\x1f]')


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

        번호+이름   003_수영복_001.png
        이름만      수영복_001.png        ← 「파일 이름에서 씬 번호 빼기」
        번호만      003_001.png           ← 씬 이름이 비었거나 쓸 수 없는 글자뿐일 때
        없음        001.png               ← 씬이 없는 싱글 탭

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
        return json.loads(p.read_text(encoding="utf-8"))

    def save(self, ws: str, spec: dict) -> dict:
        """작업 상태를 쓴다.

        ★★**백업을 두지 않는다** (사용자 결정 2026-08-25). 한때 여기서 덮어쓰기 직전 내용을
          `.bak/` 에 남겼는데 두 가지가 틀렸다:
            · **자리가 틀렸다.** 이 함수는 사용자의 자동 저장(400ms 디바운스)·조수·되돌리기가
              **전부 지나는 공통 통로**라, 조수 대비로 넣은 것이 **사용자가 타이핑하는 동안**
              대부분 만들어졌다 (실측: 1초에 세 판 · 워크스페이스 하나에 3.8MB).
            · **꺼낼 창구가 없었다.** 앱에 「백업에서 되돌리기」가 없어 손으로 덮어야 했다.
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
            d.mkdir(parents=True, exist_ok=True)
            spec["updatedAt"] = datetime.now().isoformat(timespec="seconds")
            # 임시 파일에 쓴 뒤 교체 — 쓰는 중 앱이 죽어도 기존 파일이 남는다
            tmp = d / (SPEC_NAME + ".tmp")
            tmp.write_text(json.dumps(spec, ensure_ascii=False, indent=2), encoding="utf-8")
            self._replace(tmp, d / SPEC_NAME)
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
        r = trash.send_at(self.root, [d.name])
        return {"deleted": [m["file"] for m in r["moved"]], "trashed": r["moved"]}

    def restore_ws(self, entries: list[dict]) -> dict:
        return trash.restore_at(self.root, entries)

    # ── 생성물 ────────────────────────────────────────────────
    def out_dir(self, ws: str, scene_group_name: str, tab_name: str | None = None) -> Path:
        """저장 자리 — **그림이 앉는 슬롯의 자리**를 그대로 따른다.

            <ws>/output/멀티/<탭>/<세트>/       <씬번호>_<씬이름>_<순번>.png

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
        ★`멀티/` 라는 이름도 그 시절의 자국이지만 **그대로 둔다** — 폴더 이름을 바꾸면
          이미 만든 그림과 새 그림이 두 폴더로 갈린다 (`CLAUDE.md` 「저장 경로」 절).
        ★씬 폴더를 만들지 않는다 — 씬은 **파일 이름 앞의 번호**다. 그래야 탐색기에서 한 세트가
          한자리에 모이고 씬 순서대로 정렬된다 (페로픽스파이 `001_이름_00001_.png` 과 같은 취지).
        ★탭·세트 이름이 없으면(옛 세션·이름을 못 받은 경우) 그 칸을 건너뛴다 — 「무제」 같은
          폴더를 지어내면 그 이름의 진짜 세트와 섞인다."""
        p = self.dir_of(ws) / OUT_DIR / MULTI_DIR
        if tab_name:
            p = p / safe_name(tab_name)
        if scene_group_name:
            p = p / safe_name(scene_group_name)
        p.mkdir(parents=True, exist_ok=True)
        return p

    def next_name(self, d: Path, prefix: str, fmt: str, ws: str | None = None,
                  names: list[str] | None = None) -> Path:
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
          이름이 겹치지 않는다."""
        head = f"{prefix}_" if prefix else ""
        used = 0
        # ★★모으기는 **한 번만** 할 수 있다 — 여러 장을 이어 지을 때는 부르는 쪽이
        #   목록을 들고 있다가 그대로 넘긴다 (`_names_in` 의 ★★주).
        if names is None:
            names = self._names_in(d, ws)
        for name in names:
            stem = name.rsplit(".", 1)[0]
            if not stem.startswith(head):
                continue
            part = stem[len(head):].split("_")[0]
            if part.isdigit():
                used = max(used, int(part))
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

        자리는 `out_dir` 하나가 정한다 (`output/멀티/<탭>/<세트>/`). 씬 폴더 대신 **파일 앞
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
        ★함께 고치는 것 셋 — 파일 · 색인(`records.jsonl`) · 곁파일(`records-env.jsonl`).
          하나라도 빠지면 **그림이 화면에서 사라진다** (색인이 없는 경로를 가리킨다).
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
            if lead and src.name.startswith(f"{lead}_"):
                continue
            if not lead and "_" not in src.name:
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
        """색인과 곁파일의 `file` 을 새 경로로 바꾼다 (`renumber`·`move_scene_group`).

        ★`patch` 를 주면 그 줄에 값을 함께 심는다 (세트 이름이 바뀌었을 때).
        ★★**곁파일은 안 건드린다** (사용자 승인 2026-08-28). 두 파일을 잇는 것이 경로가 아니라
          `key` 라, 경로가 바뀌어도 곁파일은 그대로 맞다 (`append_record` 의 ★★주).
          실측: 그림 740장 옮기기가 954ms → 곁파일을 빼면 색인만 남아 훨씬 싸다.
          ★**열쇠가 없는 옛 줄**이 섞여 있으면 그 줄들만 곁파일에서도 고친다 (이전 전의 데이터).
        ★★**바이트로 훑는다**. 줄 하나가 수십 KB 라, 글자로 풀었다가 다시 담으면 바뀌지 않는
          줄에도 그 비용이 든다. 바뀌는 줄만 풀고 나머지는 바이트 그대로 흘려 쓴다.

        ★append-only 인 파일을 **통째로 다시 쓰는** 유일한 자리다. 그래서 임시 파일에 쓴 뒤
          바꿔치기한다 — 쓰다 죽어도 앞의 것이 남는다.

        ★★**바뀌는 줄만 파싱한다** (실측 2026-08-27). 곁파일(`records-env.jsonl`)은 생성
          환경을 통째로 담아 **쉽게 90MB를 넘는다** (개발 워크스페이스 실측 92MB). 예전에는
          모든 줄을 `json.loads` → `json.dumps` 로 굴려 **1.40초**가 들었다 — 그것도 **몇 장을
          옮기든 늘 같은 값**이라, 사용자에게는 「15장이든 100장이든 비슷한 딜레이」로 보였다.
          바뀌는 줄만 굴리면 **0.46초**다 (나머지는 그대로 흘려 쓴다).
        """
        d = self.dir_of(ws)
        hit = {k.encode("utf-8") for k in moves}
        keyless: set[bytes] = set()       # 열쇠가 없어 곁파일도 고쳐야 하는 옛 줄
        names = [RECORDS_NAME]
        while names:
            name = names.pop(0)
            p = d / name
            if not p.is_file():
                continue
            tmp = p.with_suffix(p.suffix + ".tmp")
            with p.open("rb") as fin, tmp.open("wb") as fout:
                for raw in fin:
                    if not raw.strip():
                        continue
                    f = self._file_of_bytes(raw)
                    if f is not None and f in hit:
                        try:
                            row = json.loads(raw.decode("utf-8"))
                            if name == RECORDS_NAME and not row.get("key"):
                                keyless.add(f)     # ★이 줄은 경로로만 이어져 있다
                            row["file"] = moves[f.decode("utf-8")]
                            if patch and name == RECORDS_NAME:
                                row.update(patch)
                            fout.write(json.dumps(row, ensure_ascii=False).encode("utf-8") + b"\n")
                            continue
                        except Exception:
                            pass          # ★못 읽는 줄은 **그대로 둔다** (버리지 않는다)
                    fout.write(raw if raw.endswith(b"\n") else raw + b"\n")
            # ★임시 파일을 **바꿔치기**한다 — 지우는 연산을 이 파일에 두지 않는다
            #   (`test_output_safety` 가 그것을 지킨다: 생성물은 사람이 지울 때만 사라진다).
            self._replace(tmp, p)
            if name == RECORDS_NAME and keyless:
                hit = keyless             # ★옛 줄만 골라 곁파일도 고친다 (위 ★주)
                names.append(ENV_NAME)

    def append_record(self, ws: str, rec: dict) -> None:
        """레코드 한 줄. ★무거운 것은 **곁파일로 갈라** 적는다 (`ENV_NAME` 머리 주석).

        ★순서가 안전장치다: **곁파일을 먼저** 적는다. 거꾸로 하면 그 사이에 죽었을 때
          색인에는 있는데 무거운 것이 없는 그림이 생긴다 (「새 탭으로 복제」가 조용히 빈손이 된다).
          반대로 곁파일만 남는 것은 해가 없다 — 아무도 안 찾는 줄일 뿐이다.
        ★★**두 줄을 잇는 것은 `key` 다** (사용자 승인 2026-08-28). 예전에는 **경로**로 이었는데,
          그림을 옮기거나 이름을 바꿀 때마다 100MB 곁파일을 통째로 다시 써야 했고(실측 0.44초),
          안 쓰면 이름 재사용 때문에 조용히 어긋났다 (`heavy_of` 의 ★★주). 열쇠는 안 바뀌므로
          옮길 때 **색인만** 고치면 된다 (600KB · 0.01초)."""
        d = self.dir_of(ws)
        d.mkdir(parents=True, exist_ok=True)
        heavy = {k: rec[k] for k in HEAVY_KEYS if rec.get(k) is not None}
        key = str(rec.get("key") or uuid.uuid4().hex[:12])
        rec = {**rec, "key": key}
        if heavy:
            with (d / ENV_NAME).open("a", encoding="utf-8") as f:
                f.write(json.dumps({"key": key, "file": rec.get("file"), **heavy}, ensure_ascii=False) + "\n")
        light = {k: v for k, v in rec.items() if k not in HEAVY_KEYS}
        with (d / RECORDS_NAME).open("a", encoding="utf-8") as f:
            f.write(json.dumps(light, ensure_ascii=False) + "\n")

    def records(self, ws: str, limit: int = 0) -> list[dict]:
        """색인 전체. ★**제한이 없다** (사용자 결정 2026-08-22) — 무거운 것을 곁파일로 뺀 뒤로
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
        ★실측 256ms (2,647줄, 존재 검사 한 번씩). 부르는 쪽은 스레드로 돈다 (`server.py` 의 규칙)."""
        d = self.dir_of(ws)
        return [r for r in self.records(ws) if (d / str(r.get("file") or "")).is_file()]

    def heavy_of(self, ws: str, file: str) -> dict:
        """그 그림의 **무거운 것**(`resolved`·`env`). 없으면 빈 것.

        ★찾는 자리는 곁파일이고, **뒤에서부터** 본다 (같은 경로가 여러 번 적혔으면 마지막 것).
        ★파싱하기 전에 **경로 문자열이 그 줄에 있는지**부터 본다 — 줄 하나가 수십 KB 라
          전부 파싱하면 느리다.
        ★★**두 파일을 잇는 것은 `key` 다** (사용자 승인 2026-08-28, `append_record` 의 ★★주).
          경로로 이으면 그림을 옮길 때마다 100MB 를 다시 써야 하고, 안 쓰면 **비워진 이름을 다른
          그림이 다시 가져가** 조용히 어긋난다 (스트레스 2026-08-28이 잡았다).
        ★열쇠가 없는 옛 줄은 **경로로** 찾는다 — 이전(`ensure_keys`)이 돌기 전이나, 옛 백업을
          되돌린 파일이 그렇다.
        ★곁파일에 없으면 색인의 옛 줄을 되짚는다 (쪼개지기 전에 적힌 그림)."""
        d = self.dir_of(ws)
        key = self.key_of(ws, file)
        # ★★**바이트로 훑는다** — 곁파일은 100MB 를 넘는다 (실측 112MB). 글자로 풀어 목록에 담으면
        #   그것만으로 0.5초가 든다. 맞는 줄 **하나만** 풀면 된다.
        want_key = f'"key": "{key}"'.encode("utf-8") if key else None
        want_file = f'"file": "{file}"'.encode("utf-8")
        for name in (ENV_NAME, RECORDS_NAME):
            p = d / name
            if not p.exists():
                continue
            # ★★**무거운 것이 든 줄**만 센다 (마지막이 이긴다). 열쇠는 같은데 내용이 없는 줄이
            #   섞일 수 있다 — 옛 판이 남긴 자국이나 손으로 넣은 줄. 그런 줄이 마지막이라고
            #   해서 진짜 줄을 가리면 안 된다 (실사례 2026-08-28: 되돌린 실험이 남긴 1,022줄).
            by_key = by_file = None
            with p.open("rb") as f:
                for raw in f:
                    if not (b'"env"' in raw or b'"resolved"' in raw):
                        continue
                    if want_key and want_key in raw:
                        by_key = raw
                    elif want_file in raw:
                        by_file = raw
            for raw in (by_key, by_file):
                if raw is None:
                    continue
                try:
                    r = json.loads(raw.decode("utf-8"))
                except Exception:
                    continue
                # ★열쇠가 있는 줄은 **열쇠로만** 잡는다 — 경로가 같아도 남의 줄일 수 있다
                if raw is by_key:
                    if r.get("key") != key:
                        continue
                elif r.get("file") != file or r.get("key"):
                    continue
                got = {k: r[k] for k in HEAVY_KEYS if r.get(k) is not None}
                if got:
                    return got
        return {}

    def key_of(self, ws: str, file: str) -> str | None:
        """그 그림의 **열쇠** — 색인에서 찾는다 (없으면 `None`, 옛 줄이다).
        ★색인은 작다 (실측 600KB · 줄당 211B) — 곁파일(100MB)을 훑는 것과 값이 다르다."""
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

    def ensure_keys(self, ws: str) -> int:
        """옛 줄에 **열쇠를 달아 준다** — 한 번만 돈다 (사용자 승인 2026-08-28).

        색인과 곁파일을 경로로 맞대어 같은 열쇠를 심는다. 그 뒤로는 옮기거나 이름을 바꿔도
        곁파일을 안 건드린다 (`_rewrite_paths`).
        ★**줄을 버리지 않는다** — 못 읽는 줄은 그대로 흘려 쓴다. 임시 파일에 쓰고 바꿔치기한다.
        ★색인에 없는 곁줄(옛 그림의 잔여)은 제 열쇠를 새로 받는다 — 아무도 안 찾지만 버리지 않는다.
        ★이미 다 달려 있으면 아무 파일도 안 쓴다 (0 을 돌려준다)."""
        d = self.dir_of(ws)
        idx, env = d / RECORDS_NAME, d / ENV_NAME
        if not idx.is_file():
            return 0
        rows = idx.read_text(encoding="utf-8").splitlines()
        by_path: dict[str, str] = {}
        out, added = [], 0
        for ln in rows:
            if not ln.strip():
                continue
            try:
                r = json.loads(ln)
            except Exception:
                out.append(ln)
                continue
            if not r.get("key"):
                r["key"] = uuid.uuid4().hex[:12]
                added += 1
            by_path[str(r.get("file") or "")] = str(r["key"])
            out.append(json.dumps(r, ensure_ascii=False))
        env_out, env_added = [], 0
        if env.is_file():
            for ln in env.read_text(encoding="utf-8").splitlines():
                if not ln.strip():
                    continue
                try:
                    r = json.loads(ln)
                except Exception:
                    env_out.append(ln)
                    continue
                if not r.get("key"):
                    r = {"key": by_path.get(str(r.get("file") or "")) or uuid.uuid4().hex[:12], **r}
                    env_added += 1
                env_out.append(json.dumps(r, ensure_ascii=False))
        if not added and not env_added:
            return 0
        with self.locked(ws):
            for p, lines in ((idx, out), (env, env_out)):
                if not lines:
                    continue
                tmp = p.with_suffix(p.suffix + ".tmp")
                tmp.write_text("\n".join(lines) + "\n", encoding="utf-8")
                self._replace(tmp, p)
        return added + env_added

    def split_records(self, ws: str) -> int:
        """색인에 남아 있는 무거운 것을 곁파일로 옮긴다. 옮긴 줄 수를 돌려준다.

        ★**한 번만 돈다.** 무거운 것이 든 줄이 하나도 없으면 아무 일도 안 한다.
        ★원본을 `records-before-split.jsonl` 로 한 번 남긴다 — 이 앱은 사용자 그림 기록을
          잃은 적이 있어(CLAUDE.md) 되돌릴 자리를 둔다. 지워도 앱은 돈다.
        ★임시 파일에 쓰고 rename 한다 — 쓰다 죽어도 옛 파일이 온전하다.
        ★부르는 자리는 **서버가 요청을 받기 전**이다 (`server.py` 부팅) — 그래서 옮기는 도중에
          새 그림이 끼어들 수 없다. 생성 중이어도 앱을 다시 켜기만 하면 된다."""
        d = self.dir_of(ws)
        p = d / RECORDS_NAME
        if not p.exists():
            return 0
        lines = p.read_text(encoding="utf-8").splitlines()
        heavy_lines, light_lines, moved = [], [], 0
        for ln in lines:
            try:
                r = json.loads(ln)
            except Exception:
                light_lines.append(ln)   # 깨진 줄은 손대지 않고 그대로 둔다
                continue
            heavy = {k: r[k] for k in HEAVY_KEYS if r.get(k) is not None}
            if heavy:
                moved += 1
                # ★열쇠로 잇는다 (`append_record` 의 ★★주) — 여기서 처음 달아 준다
                r["key"] = str(r.get("key") or uuid.uuid4().hex[:12])
                heavy_lines.append(
                    json.dumps({"key": r["key"], "file": r.get("file"), **heavy}, ensure_ascii=False))
                r = {k: v for k, v in r.items() if k not in HEAVY_KEYS}
            light_lines.append(json.dumps(r, ensure_ascii=False))
        if not moved:
            return 0

        (d / PRESPLIT_NAME).write_text("\n".join(lines) + "\n", encoding="utf-8")
        env_tmp = d / (ENV_NAME + ".tmp")
        # ★이미 곁파일이 있으면 **앞에 잇는다** — 새로 적힌 줄이 뒤에 와야 마지막 것이 이긴다
        old_env = (d / ENV_NAME).read_text(encoding="utf-8").splitlines() if (d / ENV_NAME).exists() else []
        env_tmp.write_text("\n".join(heavy_lines + old_env) + "\n", encoding="utf-8")
        self._replace(env_tmp, d / ENV_NAME)
        idx_tmp = d / (RECORDS_NAME + ".tmp")
        idx_tmp.write_text("\n".join(light_lines) + "\n", encoding="utf-8")
        self._replace(idx_tmp, p)
        return moved

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
        return None

    # ── 그림을 다른 자리로 (탭 옮기기·씬 그룹 옮기기가 함께 쓴다) ──
    def _relocate(self, src_ws: str, rows: list[dict], dst_ws: str, tab_name: str,
                  group_name: str | None = None, others: set[str] | None = None) -> dict[str, str]:
        """그 줄들의 그림을 **`<받는 쪽>/output/멀티/<탭>/<세트>/`** 로 옮기고, 옛 경로 → 새 경로 표를 준다.

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
                lead = p.stem.rsplit("_", 1)[0] if "_" in p.stem else ""
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
        dst_dir = self.dir_of(dst_ws) / OUT_DIR / MULTI_DIR / safe_name(tab_name) / safe_name(gname)
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
          없어 새 id 를 주지 않는다 (한 spec 안에서 이미 유일하다), (b) 색인·곁파일은 줄이 오갈 곳이
          없어 **경로만 갈아 끼운다** (`_rewrite_paths` — 개명이 쓰는 그 경로).
        ★★파일이 **받는 탭의 폴더로 간다** — 자리는 `output/멀티/<탭>/<세트>/` 라 탭이 바뀌면 자리도
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
        return {"ok": True, "moved": len(moves), "spec": spec, "records": self.live_records(ws)}

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
        ★파일은 받는 쪽의 `output/멀티/<탭>/<세트>/` 로 간다 (`out_dir` 하나가 자리를 정한다).
          이름은 그대로 두되 이미 있으면 `next_name` 으로 번호를 새로 받는다.
        ★색인·곁파일은 **줄 단위로 옮긴다** — 그 줄을 받는 쪽 끝에 붙이고(경로·id 만 고쳐서),
          주는 쪽에서는 그 줄을 뺀 사본으로 바꿔치기한다 (`_rewrite_paths` 와 같은 방식).
          지우는 연산은 없다 (`test_output_safety`).
        ★같은 뿌리 아래의 폴더끼리라 `rename` 으로 옮긴다 — 바이트를 다시 쓰지 않는다.
        ★속도(실측 2026-08-28, 그림 736장): rename 0.4초 + 색인·곁파일 재작성 0.3초. 화면은 이 답을
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

        # ④ 색인·곁파일 — 곁파일을 먼저 (`append_record` 와 같은 순서)
        #   ★★곁파일은 **줄을 통째로 옮긴다** (워크스페이스가 갈리므로 이정표로는 못 따라간다).
        #     같은 워크스페이스 안의 옮기기(`move_scene_group`·`renumber`)와 다른 점이다.
        #   ★바이트로 훑는다 — 곁파일은 100MB를 넘고 줄 하나가 수십 KB 다 (`_rewrite_paths` 의 ★★주).
        #   ★★곁줄은 **열쇠로** 고른다. 같은 워크스페이스 안의 옮기기·개명은 곁파일을 안 건드리므로
        #     (`append_record` 의 ★★주) 거기 적힌 경로는 **옛것일 수 있다** — 경로로 고르면 그 줄을
        #     못 찾아 환경이 주는 쪽에 남는다 (스트레스 2026-08-28이 잡았다). 열쇠가 없는 옛 줄만
        #     경로로 고른다.
        sd = self.dir_of(src_ws)
        dd = self.dir_of(dst_ws)
        dd.mkdir(parents=True, exist_ok=True)
        hit = {k.encode("utf-8") for k in moves}
        by_key: dict[bytes, str] = {}
        for r in mine:
            k, f = r.get("key"), str(r.get("file") or "")
            if k and f in moves:
                by_key[str(k).encode("utf-8")] = moves[f]
        for name in (ENV_NAME, RECORDS_NAME):
            p = sd / name
            if not p.is_file():
                continue
            tmp = p.with_suffix(p.suffix + ".tmp")
            with p.open("rb") as fin, tmp.open("wb") as fout, (dd / name).open("ab") as fdst:
                for line in fin:
                    if not line.strip():
                        continue
                    f = self._file_of_bytes(line)
                    k = self._key_of_bytes(line)
                    to = by_key.get(k) if k else None
                    if to is None and f is not None and f in hit and (k is None or name == RECORDS_NAME):
                        to = moves[f.decode("utf-8")]
                    if to is not None:
                        try:
                            row = json.loads(line.decode("utf-8"))
                            row["file"] = to
                            for k in ("scene_group_id", "cell_id"):
                                if row.get(k) in remap:
                                    row[k] = remap[row[k]]
                            fdst.write(json.dumps(row, ensure_ascii=False).encode("utf-8") + b"\n")
                            continue
                        except Exception:
                            pass          # ★못 읽는 줄은 주는 쪽에 **그대로 둔다**
                    fout.write(line if line.endswith(b"\n") else line + b"\n")
            self._replace(tmp, p)

        # ⑤ 두 spec — 받는 쪽에 붙이고, 주는 쪽에서 뺀다 (활성 탭·그룹은 `removeTab` 과 같은 규칙)
        self._hand_selection(src, dst, moves)   # ★별표·숨김도 함께 건너간다 (그 함수의 ★주)
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
        return {"ok": True, "moved": len(moves), "tab_id": tab["id"], "spec": src,
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
        }
        self.append_record(ws, rec)
        return {"ok": True, "file": rel, "record": rec}
