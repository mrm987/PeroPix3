"""PeroPix 3.0 백엔드.

v2.x 의 backend.py 에서 NAI·검열·인프라 계열을 옮겨오는 자리다.
4단계: 워크스페이스 + 저장 (spec/records 분리, work/ · output/).
"""
from __future__ import annotations

import argparse
import asyncio
import binascii
import contextlib
import base64
import io
import json
import math
import os
import time
import traceback
import uuid
from datetime import datetime
from pathlib import Path

# ★★**제 옆의 모듈을 스스로 찾게 한다** (포터블 실측 2026-08-26).
#   임베드 파이썬(`python/python.exe`)은 `._pth` 가 sys.path 를 통째로 정하고, 그때는
#   **스크립트가 있는 폴더가 안 들어간다** — 평범한 파이썬과 다른 점이라 `import censor`
#   에서 곧장 죽었다 (포터블 첫 실행에서 잡았다). 한 줄로 어느 파이썬으로 켜든 같게 만든다.
import sys

if str(Path(__file__).resolve().parent) not in sys.path:
    sys.path.insert(0, str(Path(__file__).resolve().parent))

from fastapi import File, UploadFile, FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from PIL import Image
from pydantic import BaseModel

import censor
import files
import tagger
import tagindex
import imgutil
import keep
import genqueue
import cliagent
import agentsession
import secretstore
import llm as llm_mod
import agent as agent_mod
from agent import App, Tools
from chats import Chats
import meta
import guide as guide_mod
import tools as tools_mod  # ★별칭 필수 — 아래에서 `tools` 라는 이름을 Tools 인스턴스가 가져간다
import translate as translate_mod
import trash
import agentlog
import migrate_terms
import migrate_thumbs
import nai
import update as update_mod
import vibe as vibe_mod
from cards import KINDS, Cards
from blocklib import BlockLib
from wildcards import Wildcards
import thumbs
from thumbs import Pins
from workspace import SpecMismatch, Store, safe_name

# MCP 설정에 적어 줄 **지금 이 서버의 포트** (--port 로 바뀐다)
# ★리로드 모드에서는 워커가 `main()` 을 안 거치고 모듈만 다시 읽는다 — 포트를 환경에서 받는다
CURRENT_PORT = int(os.environ.get("PEROPIX_BACKEND_PORT") or 8770)
def _app_dir() -> Path:
    """앱의 **뿌리** — 사용자 것(`workspaces`·`gallery`·`logs`·`data`)이 사는 자리.

    ★★배포판은 앱 것을 `app/` 안에 모아 둔다 (사용자 지시 2026-08-27: *"유저가 접근하는
      폴더는 한정적인데 너무 다 나와 있는 느낌"*). 그래서 이 파일은 `app/backend/server.py`
      에 있고, 뿌리는 **한 단계 더 위**다. 저장소에서 돌릴 때는 `backend/server.py` 라
      두 단계면 된다 — 폴더 이름으로 가른다.
    ★껍데기도 같은 규칙을 쓴다 (`src-tauri/src/backend.rs` 의 `inner`). 두 곳이 어긋나면
      앱과 백엔드가 서로 다른 창고를 본다."""
    here = Path(__file__).resolve().parent.parent
    return here.parent if here.name == "app" else here


APP_DIR = _app_dir()
#: **앱 것이 사는 자리** — 배포판은 `app/`, 저장소에서는 뿌리와 같다.
#  ★`version.json`·`models/` 처럼 **갈아 끼워지는 것**이 여기 있다 (`censor.MODEL_DIR` 도 같다).
INNER_DIR = Path(__file__).resolve().parent.parent
# ★★**버전은 파일이 정본이다** (`version.json`, 사용자 결정 2026-08-26). 포터블을 묶을 때
#   `scripts/portable.ps1` 이 `tauri.conf.json` 의 버전을 그대로 적어 넣는다 — 업데이트가
#   「지금 무엇을 쓰고 있나」를 이걸로 안다. 소스의 상수는 **개발 중에만** 쓰는 기본값이다.
#   ★손으로 고치지 말 것: 묶을 때마다 덮어써진다.
def _app_version() -> str:
    try:
        # ★`utf-8-sig` — 윈도우 파워셸이 쓰면 BOM 이 붙는다. 그대로 `utf-8` 로 읽으면
        #   json 이 첫 글자에서 걸려 **조용히 개발용 기본값으로 떨어졌다** (실측 2026-08-26).
        return str(json.loads((INNER_DIR / "version.json").read_text("utf-8-sig"))["version"])
    except Exception:
        return "3.0.0-dev"


APP_VERSION = _app_version()


def say(level: str, where: str, msg: str) -> None:
    """로그 한 줄. ★★**적는 자리는 stdout 하나뿐이다** — 껍데기가 그것을 `logs/peropix.log`
    로 흘린다 (`src-tauri/src/backend.rs` 의 `open_log`). 여기서 파일을 열지 않는다.

    ★시각을 앞에 붙인다: 제보를 받았을 때 「언제 그랬나」가 없으면 앞뒤를 못 맞춘다.
      uvicorn 의 기본 형식에는 시각이 없어서, 우리 줄에는 우리가 붙인다.
    """
    print(f"{time.strftime('%H:%M:%S')} {level.upper():5} [{where}] {msg}", flush=True)


say("info", "start", f"PeroPix {APP_VERSION} · {time.strftime('%Y-%m-%d %H:%M:%S')}")
DATA_DIR = APP_DIR / "data"
WS_ROOT = APP_DIR / "workspaces"
# ★옛 이름(`outputs/`)에서 한 번 옮긴다 — 안에 든 것은 생성물이 아니라 **워크스페이스**다
#   (사용자 결정 2026-08-08). tid 해시에 최상위 이름이 안 들어가므로 커버는 안 깨진다.
_OLD_ROOT = APP_DIR / "outputs"
if _OLD_ROOT.exists() and not WS_ROOT.exists():
    # ★실패해도 앱은 떠야 한다 — 폴더를 누가 붙들고 있으면(탐색기·백신·다른 인스턴스)
    #   rename 은 그냥 거부된다. 그때는 **옛 자리로 계속 돈다**. 다음에 다시 시도한다.
    try:
        _OLD_ROOT.rename(WS_ROOT)
        print(f"[워크스페이스] {_OLD_ROOT.name}/ -> {WS_ROOT.name}/ 로 옮김")
    except OSError as e:
        WS_ROOT = _OLD_ROOT
        print(f"[워크스페이스] 옮기지 못했습니다 ({e}). 이번에는 {_OLD_ROOT.name}/ 로 돕니다.")
CONFIG_PATH = DATA_DIR / "config.json"

DATA_DIR.mkdir(parents=True, exist_ok=True)
store = Store(WS_ROOT)
# ★카드는 워크스페이스 밖에 있다 — 어느 워크스페이스에서 만들어도 전부에서 보인다
cards = Cards(DATA_DIR / "cards")
# ★블록 저장소도 카드와 같은 자리다 — 공용이고 워크스페이스를 안 가린다
blocklib = BlockLib(DATA_DIR / "blocks.json")
# ★와일드카드 정의 문서도 같은 자리다. 어느 워크스페이스에서 생성하든 같은 풀을 뽑는다
wildcards = Wildcards(DATA_DIR / "wildcards.txt")
# ★꽂은 그림의 **유일한** 창고. 배너·카드 앞면·덱 커버가 전부 여기를 tid 로 가리킨다
pins = Pins(DATA_DIR / "thumbs")
# ★AI 대화 — 카드와 같은 **공용** 저장소 (워크스페이스를 넘나들며 시킬 수 있다)
# ★AI 대화는 **앱 전체에 하나**다 (사용자 결정 2026-08-08 — 갈랐다가 되돌렸다, chats.py 머리 주석).
#   대신 대화마다 "어디서 시작했는지"를 적어 목록에서 출처가 보인다.
chats = Chats(DATA_DIR / "chats")
# ★Vibe 인코딩 캐시 — **Anlas 가 걸린 자리**다 (vibe.py 머리 주석). 지우면 다시 지불한다.
vibes = vibe_mod.VibeCache(DATA_DIR / "vibe-cache")
# ★앱이 들고 있는 사용자 지침 — 엔진이 무엇이든 **같은 문서**를 본다 (guide.py 머리 주석)
GUIDE = guide_mod.Guide(DATA_DIR / "guide.md")

def _tidy_ws_root() -> None:
    """`workspaces/` 에는 **워크스페이스만** 둔다 (사용자 지시 2026-08-08).

    ★옛 자리에서 한 번 옮긴다: 휴지통은 이름에 워크스페이스가 이미 들어 있어 그대로 옮기고,
      파생 썸네일 캐시는 **다시 구우면 되는 것**이라 지운다. 대화(`data/chats`)는 워크스페이스를
      알 수 없어 옮기지 않는다 — 사용자 결정으로 버린다.
    ★**한 항목이 실패해도 앱은 뜬다.** 폴더를 누가 붙들고 있으면 rename 이 그냥 거부된다 —
      그때는 남겨 두고 다음 부팅에 다시 시도한다 (실측 2026-08-08: WinError 5).
    """
    import shutil as _sh

    old_trash = WS_ROOT / ".trash"
    if old_trash.is_dir():
        for ws_dir in list(old_trash.iterdir()):
            # ★★묶음 폴더(`20260818_101500`)는 **지금 쓰는 휴지통**이다 — 파일 관리와
            #   워크스페이스 삭제가 여기에 담는다 (2026-08-18). 옛 자리는 한 칸 아래가
            #   워크스페이스 이름이었으므로, 묶음 이름이면 건너뛴다. 안 건너뛰면
            #   `workspaces/20260818_101500/` 이라는 없는 워크스페이스가 생긴다.
            if not ws_dir.is_dir() or trash.STAMP.match(ws_dir.name):
                continue
            dst = WS_ROOT / ws_dir.name / ".trash"
            try:
                dst.parent.mkdir(parents=True, exist_ok=True)
                if dst.exists():
                    for batch in list(ws_dir.iterdir()):
                        target = dst / batch.name
                        if not target.exists():
                            _sh.move(str(batch), str(target))
                else:
                    _sh.move(str(ws_dir), str(dst))
                print(f"[휴지통] {ws_dir.name} 을 워크스페이스 안으로 옮김")
            except OSError as e:
                print(f"[휴지통] {ws_dir.name} 을 못 옮겼습니다 ({e}) — 다음에 다시 시도합니다")
        with contextlib.suppress(OSError):
            old_trash.rmdir()

    old_thumbs = WS_ROOT / ".thumbs"
    if old_thumbs.is_dir():
        _sh.rmtree(old_thumbs, ignore_errors=True)  # 파생 캐시 — 다시 구워진다
        if not old_thumbs.exists():
            print("[썸네일 캐시] 최상위 .thumbs 를 비움 (워크스페이스 안에서 다시 구워짐)")

    # ★대화는 다시 전역이다 — 잠깐 워크스페이스 안에 뒀던 것을 되가져온다 (출처를 적어서)
    home = DATA_DIR / "chats"
    for ws_dir in list(WS_ROOT.iterdir()) if WS_ROOT.is_dir() else []:
        moved_from = ws_dir / "chats"
        if not moved_from.is_dir():
            continue
        home.mkdir(parents=True, exist_ok=True)
        for f in list(moved_from.glob("*.json")):
            try:
                d = json.loads(f.read_text(encoding="utf-8"))
                d["workspace"] = d.get("workspace") or ws_dir.name
                (home / f.name).write_text(json.dumps(d, ensure_ascii=False), encoding="utf-8")
                f.unlink()
            except Exception as e:
                print(f"[AI 대화] {f.name} 을 못 옮겼습니다 ({e})")
        with contextlib.suppress(OSError):
            moved_from.rmdir()
        print(f"[AI 대화] {ws_dir.name} 의 대화를 공용으로 되돌림")


_tidy_ws_root()


def _split_records() -> None:
    """색인에 섞여 있는 무거운 것을 곁파일로 옮긴다 (사용자 결정 2026-08-22).

    ★**요청을 받기 전**에 돈다 — 옮기는 도중에 새 그림이 끼어들 수 없다. 그래서 사용자가
      생성 중이어도 앱을 다시 켜기만 하면 되고, 미리 멈출 필요가 없다.
    ★한 워크스페이스가 실패해도 앱은 뜬다 — 남겨 두고 다음 부팅에 다시 시도한다
      (`_tidy_ws_root` 와 같은 규약).
    ★두 번째 부팅부터는 옮길 것이 없어 아무 일도 안 한다."""
    for ws_dir in list(WS_ROOT.iterdir()) if WS_ROOT.is_dir() else []:
        if not ws_dir.is_dir():
            continue
        try:
            n = store.split_records(ws_dir.name)
        except OSError as e:
            print(f"[레코드] {ws_dir.name} 을 못 쪼갰습니다 ({e}) — 다음에 다시 시도합니다")
            continue
        if n:
            print(f"[레코드] {ws_dir.name}: {n}줄의 무거운 값을 records-env.jsonl 로 옮김")


_split_records()

#: ★★**임포트만으로 사용자 데이터를 고치지 않게 하는 스위치** (실사고 2026-08-28).
#   아래 이전들은 모듈을 **임포트하는 것만으로** 돈다 — 그런데 판정 하나가(`test_workspace`)
#   서버를 임포트해서, 판정을 돌린 것만으로 **실제 워크스페이스 전량에 이전이 돌았다.**
#   판정은 이 값을 켜고 임포트한다 (`PEROPIX_SKIP_MIGRATIONS=1`).
_SKIP_MIGRATIONS = bool(os.environ.get("PEROPIX_SKIP_MIGRATIONS"))

# ★★**낱말 이전이 먼저다** (2026-08-24). 아래 이전들은 spec 을 열어 고치는데, 그것들이
#   새 열쇠(`tabs`=탭 · `sets`=세트)를 전제하기 때문이다. 순서를 바꾸면 옛 모양 위에
#   새 규칙을 얹게 된다 (`migrate_terms.py` 머리 주석).
for _line in (migrate_terms.run(WS_ROOT) if not _SKIP_MIGRATIONS else []):
    print(_line)

# ★★색인과 곁파일을 잇는 **열쇠**를 옛 줄에 달아 준다 (사용자 승인 2026-08-28, 한 번만 돈다).
#   그 뒤로는 그림을 옮기거나 이름을 바꿔도 100MB 곁파일을 안 건드린다 (`Store.ensure_keys`).
for _d in sorted(WS_ROOT.iterdir()) if WS_ROOT.is_dir() and not _SKIP_MIGRATIONS else []:
    if _d.is_dir() and not _d.name.startswith("."):
        try:
            _n = store.ensure_keys(_d.name)
            if _n:
                print(f"[열쇠 이전] {_d.name}: {_n}줄")
        except Exception as _e:            # ★한 워크스페이스가 실패해도 앱은 뜬다
            print(f"[열쇠 이전] {_d.name}: 실패 ({_e})")

for _line in (migrate_thumbs.run(cards, store, pins) if not _SKIP_MIGRATIONS else []):
    print(f"[썸네일 이전] {_line}")

# ★휴지통은 **켤 때** 비운다 (종료 때가 아니라 — 강제 종료에서는 안 돈다, trash.py 머리 주석)
# ★★뿌리가 넷이다 (2026-08-18, D7): 워크스페이스(+`workspaces/` 자체) · 보관함 ·
#   바이브 캐시 · 카드 · 대화. 한 곳만 비우면 나머지 휴지통이 영영 쌓인다.
for _batch in (trash.sweep(WS_ROOT) if not _SKIP_MIGRATIONS else []):
    print(f"[휴지통 비움] {_batch}")
for _root in ((DATA_DIR / "cards", DATA_DIR / "chats", DATA_DIR / "vibe-cache") if not _SKIP_MIGRATIONS else ()):
    for _batch in trash.sweep_at(_root):
        print(f"[휴지통 비움] {_root.name}/{_batch}")

app = FastAPI(title="PeroPix Backend", version=APP_VERSION)


@app.middleware("http")
async def _log_errors(request, call_next):
    """터진 것을 **전부 적는다** (사용자 지시 2026-08-27: *"오류 같은 게 생기면 상세 로그를
    남기게 해 놔. 그럼 유저 제보받기 편함"*).

    ★★**무엇을 하다 터졌는지**가 함께 있어야 쓸모가 있다 — 자취만 있으면 어느 창구에서
      난 것인지 되짚어야 한다. 그래서 길과 자취를 한 자리에 적는다.
    ★★**열쇠는 지운다.** 주소 앞머리가 `/k/<이번 실행의 열쇠>` 라, 길을 그대로 적으면
      로그에 열쇠가 남는다. 제보로 오가는 파일이라 더욱 안 된다.
    ★삼키지 않는다 — 적기만 하고 그대로 올려보낸다. 화면이 받던 오류는 그대로 받는다.
    ★400·404 같은 것은 여기 안 걸린다 (예외가 아니라 답이다). 그것까지 적으면 시끄럽다."""
    try:
        return await call_next(request)
    except Exception as e:
        path = request.url.path
        if KEY_PREFIX and path.startswith(KEY_PREFIX):
            path = path[len(KEY_PREFIX):]
        say("error", "api", f"{request.method} {path} → {type(e).__name__}: {e}")
        print(traceback.format_exc(), flush=True)
        raise

#: 이번 실행의 열쇠 — 껍데기가 만들어 넣어 준다 (`src-tauri/src/backend.rs` 의 `backend_key`).
#  ★비어 있으면 문을 안 잠근다: 백엔드를 손으로 띄우는 개발·시험 때가 그렇다.
APP_KEY = os.environ.get("PEROPIX_KEY", "").strip()
#: 잠겼을 때 모든 주소 앞에 붙는 머리. 화면은 `backend_url` 에서 이 값을 통째로 받는다.
KEY_PREFIX = f"/k/{APP_KEY}" if APP_KEY else ""


class KeyGate:
    """열쇠가 맞는 주소만 안으로 들여보낸다 (2026-08-26, 첫 공개 배포 점검).

    ★★**왜 필요한가.** 이 서버는 `127.0.0.1` 에만 붙지만 **브라우저는 로컬 주소로도
      요청을 보낸다.** 포트가 8770 으로 거의 고정이라, 앱을 켜 둔 채 아무 사이트나 열려
      있으면 그 사이트가 우리 API 를 그대로 부를 수 있었다 (실측 2026-08-26:
      `Origin: https://evil.example` 로 프리플라이트를 던지니 `allow-origin: *` 이 왔다).
      그 API 에는 **임의의 실행 파일을 띄우는 길**(`/api/cli/run` 의 `exe`), 생성(돈),
      워크스페이스 버리기, 폴더 경로 흘리기가 다 들어 있다.
    ★★**왜 헤더가 아니라 주소인가.** `<img src=…>` 와 웹소켓은 헤더를 못 싣는다. 주소
      앞머리로 하면 화면이 만드는 모든 주소가 한 번에 덮인다 (전부 `backend_url` 에 경로를
      이어 붙여 만든다).
    ★★**HTTP 미들웨어가 아니라 ASGI 층**이다 — `@app.middleware("http")` 는 웹소켓을
      안 지나간다. 소켓이야말로 진행 상황·생성 결과가 흐르는 통로라 빠지면 안 된다.
    ★맞히려는 쪽이 얻는 것은 403 뿐이다. 몇 번째 글자가 맞았는지 같은 실마리를 안 준다.
    """

    def __init__(self, app_, prefix: str):
        self.app = app_
        self.prefix = prefix

    async def __call__(self, scope, receive, send):
        if not self.prefix or scope["type"] not in ("http", "websocket"):
            return await self.app(scope, receive, send)

        path = scope.get("path", "")
        if path == self.prefix or path.startswith(self.prefix + "/"):
            rest = path[len(self.prefix):] or "/"
            scope = {**scope, "path": rest, "raw_path": rest.encode()}
            return await self.app(scope, receive, send)

        if scope["type"] == "websocket":
            # ★받기 전에 닫는다 — 핸드셰이크를 마치면 그때부터 방송이 흘러간다
            return await send({"type": "websocket.close", "code": 1008})
        await send({"type": "http.response.start", "status": 403,
                    "headers": [(b"content-type", b"text/plain; charset=utf-8")]})
        await send({"type": "http.response.body", "body": "PeroPix: 열쇠가 없습니다".encode()})


# Tauri 는 tauri://localhost 오리진, 개발 중에는 Vite 가 localhost:1420.
# ★오리진은 열어 두되 **문은 위의 열쇠가 잠근다** — 오리진 목록만으로는 프리플라이트를
#   안 타는 요청이 새고, 열쇠는 웹페이지가 알 길이 없어 원리적으로 막힌다.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)
app.add_middleware(KeyGate, prefix=KEY_PREFIX)


# ── 설정 ──────────────────────────────────────────────────────────
def load_config() -> dict:
    if CONFIG_PATH.exists():
        try:
            return json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
        except Exception:
            pass
    return {}


def save_config(cfg: dict) -> None:
    CONFIG_PATH.write_text(json.dumps(cfg, ensure_ascii=False, indent=2), encoding="utf-8")


CONFIG = load_config()

# ★비밀은 **다른 파일**에 산다 (사용자 지시 2026-08-08). 설정 파일은 아무 때나 보여줄 수 있어야
#   하고, 키는 그럴 수 없다. 옛 설정에 섞여 있던 것은 부팅 때 한 번 옮겨 온다.
SECRETS = secretstore.Secrets(DATA_DIR / "secrets.json")
if SECRETS.adopt(CONFIG):
    save_config(CONFIG)


def nai_token() -> str:
    return os.environ.get("NAI_TOKEN") or SECRETS.get("nai_token")


def llm_settings(provider: str = "") -> dict:
    """설정(공급자·모델) + 비밀(키). ★합치는 것은 **부를 때뿐**이다.

    ★키도 모델도 **공급자마다 따로** 산다 — 공급자를 바꿨다고 앞서 넣은 키가 날아가면
      쓰기 어렵다 (화면의 초록 점이 공급자별로 켜지는 것도 이것 때문)."""
    llm = CONFIG.get("llm") or {}
    pid = provider or llm_mod.provider_of(llm)
    return {
        "provider": pid,
        "model": (llm.get("models") or {}).get(pid, ""),
        "effort": (llm.get("efforts") or {}).get(pid, ""),
        "key": SECRETS.get(f"llm_key_{pid}"),
    }


def _migrate_llm() -> None:
    """옛 설정 모양(공급자 하나 · 모델 하나 · 키 하나)을 새 모양으로 한 번 옮긴다.

    ★`openai` 는 예전에 **"OpenAI 호환"** 이라는 뜻이었고 기본 주소가 OpenRouter 였다.
      그대로 두면 OpenAI 로 잘못 붙는다 — 주소를 보고 어느 쪽이었는지 가른다."""
    llm = dict(CONFIG.get("llm") or {})
    if not llm or "models" in llm:
        return
    pid = llm.get("provider") or ""
    if pid == "openai":
        pid = "openai" if "api.openai.com" in (llm.get("baseUrl") or "").lower() else "openrouter"
    if pid not in llm_mod.PROVIDERS:
        pid = llm_mod.DEFAULT_PROVIDER
    CONFIG["llm"] = {"provider": pid, "models": {pid: llm["model"]} if llm.get("model") else {}}
    old_key = SECRETS.get("llm_key")
    if old_key:
        SECRETS.set(f"llm_key_{pid}", old_key)
        SECRETS.set("llm_key", "")
    save_config(CONFIG)


_migrate_llm()


# ── 모델 ──────────────────────────────────────────────────────────
class TokenBody(BaseModel):
    token: str


class RestoreBody(BaseModel):
    """「되돌리기」 — 지울 때 받은 `trashed` 를 그대로 되돌려준다 (trash.py 머리 주석).

    ★모든 되살리기 창구가 **같은 모양**을 쓴다. 창구마다 다른 몸통을 만들면 화면 쪽에서
      "이 화면은 뭘 보내야 하지"가 되살아난다."""

    entries: list[dict] = []
    #: 갤러리 전용 — 지울 때 함께 걷어낸 별표·출처를 되살린다 (`keep.restore`)
    starred: list[str] = []
    sources: dict[str, str] = {}
    #: 바이브 캐시 전용 — 걷어낸 캐시 키 (`vibe.restore`)
    keys: list[str] = []


class GenBody(BaseModel):
    #: ★★**중간 그림을 흘려 볼까** (사용자 지시 2026-08-26, 기본 켬). NAI 가 생성 중에
    #   주는 프레임을 그대로 앱에 넘긴다 (`nai.generate_streaming`). 꺼도 결과는 같다 —
    #   **보는 방식**만 달라진다. 화면이 옵션으로 켜고 끈다.
    stream: bool = True
    # 어디에 저장할지
    workspace: str = "새 작업"
    # ★세트 이름 — 저장 경로 한 칸이 된다 (`docs/terms-plan.md` 의 낱말표)
    #   ★기본값은 **빈 문자열**이다. 예전에는 `"싱글"` 이라, 이름을 안 실어 보내면 그 이름의
    #     폴더가 생겼다 — 싱글 갈래는 없어졌다 (`workspace.out_dir` 의 ★★주).
    scene_group: str = ""
    cell: str | None = None
    # ★슬롯 번호(1부터). 파일 이름 앞에 붙어 **탐색기에서 슬롯 순서**를 만든다
    cell_no: int | None = None
    # 탭 이름 — 저장 경로 한 칸이 된다 (`멀티/<탭>/<세트>/`)
    tab: str | None = None
    # 이 그림이 **어느 그림에서 나왔나** (강화·업스케일·인페인트의 원본 파일).
    # ★**묶는 데 쓰지 않는다.** 결과는 언제나 **각각 별개의 그림**으로 보인다
    #   (사용자 결정 2026-08-13 — v2 의 버전 스택 `1/n` 은 작업할 때 오히려 불편하다).
    #   여기 남기는 것은 출처 기록뿐이다. 화면에서 이 값으로 묶는 코드를 만들지 말 것.
    enhance_of: str | None = None
    # ★강화의 **원본 파일 경로**. 주면 서버가 그 파일을 읽어 베이스 이미지로 쓴다 —
    #   화면이 4.6MB base64 를 실어 보내지 않아도 되고, 배치로 여러 장을 돌릴 수 있다.
    enhance_from: str | None = None
    # 1.0 이면 그대로, 1.5 면 그 배로 키워서 (64 배수로 맞춘다)
    enhance_scale: float = 1.0
    # ★타일 인페인트(Focused) — 원본 좌표계의 **크롭 사각형**. 있으면 그 자리만 잘라 보낸다.
    #   자를 그림은 `base_image` 다 — **파일 경로를 받지 않는다** (사용자 지적 2026-08-20:
    #   갤러리·드롭 그림에는 워크스페이스 경로가 없어 기능이 통째로 막혀 있었다).
    inpaint_rect: dict | None = None
    # ★화면이 결과를 묶는 **진짜 키**. 폴더는 사람이 읽을 수 있게 이름을 그대로 쓰지만,
    #   이름은 바뀌므로 이름으로 묶으면 이름을 고치는 순간 결과가 화면에서 사라진다.
    #   (옛 레코드에는 없다 — 클라이언트가 id 우선·이름 폴백으로 읽는다)
    #   ★★이름은 **`scene_group_id`** 다 — 그림이 쌓이는 자리는 **세트**이기 때문이다 (낱말표).
    #     2026-08-24 개명 때 여기만 옛 이름(`tab_id`)으로 남아, 화면이 보내는 `scene_group_id` 를
    #     받을 자리가 없어 **생성이 통째로 죽었다** (`'GenBody' object has no attribute 'scene_group_id'`).
    #     아래 `tab` 은 **탭 이름**이라 다른 것이다 — 둘을 다시 뒤섞지 말 것.
    scene_group_id: str | None = None
    cell_id: str | None = None
    #: ★★**그 그림을 뽑을 때의 화면 구조** — 「새 탭으로 복제」가 이것으로 환경을 되살린다.
    #:  스타일 카드·베이스/네거티브 블록·캐릭터 카드·그 씬의 블록·카드 공통 접두·씬 목적지.
    #:  ★PNG 메타데이터에는 **합쳐진 문자열**만 남아 구조를 못 되살린다. 그래서 여기 남긴다 —
    #:   나중에 그 탭을 고치거나 지워도 복제는 그때 환경 그대로 나온다 (사용자 지시 2026-08-19).
    #:  ★그림 바이트는 안 들어간다 (구조뿐이라 작다). 서버는 **들고만 있고 해석하지 않는다.**
    env: dict | None = None
    # 프롬프트는 블록 에디터가 컴파일해 넣는다
    prompt: str = ""
    negative_prompt: str = ""
    # ★캐릭터 프롬프트 — `{prompt, uc, center:{x,y}, use_coord}`.
    #   ★예전에는 화면이 계산해 놓고 **보내지 않았고**, 여기에 받을 자리도 없어서
    #     `characterPrompts` 가 늘 비어 나갔다. 이 앱의 핵심 기능이 통째로 안 걸려 있었다.
    characters: list[dict] = []
    # ★vibe 강도 정규화 — 공홈 기본 켜짐. 사용자 토글이라 하드코딩하지 않는다
    normalize_reference_strength: bool = True
    model: str = "nai-diffusion-5-full"
    width: int = 832
    height: int = 1216
    steps: int = 28
    cfg: float = 5.0
    sampler: str = "k_euler_ancestral"
    scheduler: str = "karras"
    seed: int = -1
    cfg_rescale: float = 0.0
    uc_preset: str = "Heavy"
    #: 퀄리티 프리셋 id — "standard" / "light"(V5·custom) / "none"
    quality_preset: str = "standard"
    #: ★옛 필드. 백엔드가 큐를 들고 있어 **판올림 전에 담긴 작업**이 이 모양으로 남아
    #:  있을 수 있다. 새 필드가 없을 때만 옮겨 준다.
    quality_tags: bool | None = None
    variety_plus: bool = False
    #: 투명 배경 (V5 전용). 지원 안 하는 모델에서는 `nai.build_payload` 가 무시한다
    transparent_bg: bool = False
    #: 투명 배경의 알파 모드 — True=Straight / False=Premultiplied (공홈 기본값 Straight)
    straight_alpha: bool = True
    furry_mode: bool = False
    # 저장 옵션 (v2 Save Options)
    #: png | webp — ★**둘뿐**이다 (사용자 결정 2026-08-23). WebP 는 무손실로 쓴다
    save_format: str = "png"
    #: ★옛 설정 호환으로 남긴다. 지금 내는 둘은 품질 값을 안 쓴다 (PNG · 무손실 WebP)
    jpg_quality: int = 95
    strip_metadata: bool = False
    #: 끄면 **파일로 안 남기고 미리보기만** 돌려준다 (v2 `auto_save`)
    auto_save: bool = True
    #: 켜면 파일 이름 앞의 씬 번호를 뺀다 (v2 `exclude_slot_number`)
    exclude_slot_number: bool = False
    # ── 이미지 입력 (5단계) ──
    vibe_transfer: list[dict] = []
    precise_references: list[dict] = []
    base_image: str = ""
    base_mode: str = "img2img"
    base_strength: float = 0.7
    # ★인페인트 슬라이더는 별개다 (기본 1) — `nai.GenRequest.base_inpaint_strength` 주석
    base_inpaint_strength: float = 1.0
    base_noise: float = 0.0
    base_mask: str = ""


class VibeCheckBody(BaseModel):
    """이미 구워 둔 인코딩이 있는지 묻는다. `items` 는 `{image, info_extracted}` 목록."""

    model: str = "nai-diffusion-5-full"
    items: list[dict] = []


class SpecBody(BaseModel):
    spec: dict


class CardBody(BaseModel):
    card: dict


class BlockItemBody(BaseModel):
    item: dict


class BlockOrderBody(BaseModel):
    ids: list[str]


class WildcardBody(BaseModel):
    """와일드카드 정의 문서 전문 (`#이름` 절 + 한 줄 한 후보)"""

    content: str


class PinBody(BaseModel):
    """어느 생성물을 고정 썸네일로 굳힐지. **바이트를 올리지 않는다** — 서버가 원본에서 굽는다."""

    workspace: str
    file: str


class ThumbBody(BaseModel):
    """이미 굳힌 고정 썸네일(tid)을 어디에 어떻게 걸지."""

    tid: str
    view: dict | None = None


# ★썸네일 주소는 **내용이 바뀌면 주소도 바뀐다** (tid 는 원본+mtime+크기에서 나온다).
#   그래서 마음 놓고 오래 캐시해도 된다 — "위치는 그대로 두고 그림만 갈아 끼웠더니
#   옛 그림이 계속 보인다"는 실사용 결함(2026-08-02)이 구조적으로 불가능하다.
IMMUTABLE_IMG = {"Cache-Control": "public, max-age=31536000, immutable"}


# ── 기본 ──────────────────────────────────────────────────────────
class LogLine(BaseModel):
    line: str
    #: `error` · `warn` · `info` — 앞에 붙는 딱지일 뿐, 거르지는 않는다
    level: str = "info"


@app.post("/api/log")
async def log_line(b: LogLine):
    """화면에서 일어난 일을 로그에 적는 자리 (2026-08-27).

    ★왜 백엔드로 보내나 — 배포판에는 개발자 도구가 없어 `console` 이 아무 데도 안 남는다.
      쓰는 사람이 오류를 겪어도 우리에게 보낼 것이 없었다.
    ★★**파일을 직접 안 쓴다.** 찍기만 하면 껍데기가 그것을 `logs/peropix.log` 로 흘린다
      (`src-tauri/src/backend.rs` 의 `open_log`). 로그 자리를 아는 곳이 둘이면 어긋난다.
    ★실패해도 앱은 그대로 간다 — 화면 쪽에서 삼킨다."""
    say(b.level, "ui", b.line[:2000])
    return {"ok": True}


@app.get("/api/health")
async def health():
    # ★버전·요청 창구도 여기서 준다 — 화면에 박아 두면 두 곳이 어긋난다 (감사 C5).
    return {"ok": True, "version": APP_VERSION, "hasToken": bool(nai_token()),
            "support": CONFIG.get("support_url") or agent_mod.SUPPORT_URL,
            # ★★**내가 서 있는 자리**를 알려 준다 (사용자 지시 2026-08-26, 포터블 준비).
            #   포터블은 여러 벌을 다른 폴더에 두고 함께 쓰므로, 화면이 «지금 붙은 백엔드가
            #   내 것인가»를 물을 수 있어야 한다 — 아니면 창은 이쪽인데 데이터는 저쪽이
            #   되고, 그게 조용히 일어난다 (실측 2026-08-08 의 포트 다툼).
            "root": str(APP_DIR), "port": CURRENT_PORT,
            "hasLlm": bool(llm_settings().get("key"))}


# ── 자동 업데이트 ──────────────────────────────────────────────────
# ★★**받아 두는 것까지가 여기 일이다** (`backend/update.py` 머리 주석). 돌고 있는 exe 는
#   덮어쓸 수 없어서, 실제 교체와 재시작은 껍데기(Rust)가 백엔드를 내리고 나서 한다.
@app.get("/api/update/check")
async def update_check():
    """새 판이 있나. ★조용히 실패한다 — 부팅 때 한 번 도는 것이라 시끄러우면 안 된다."""
    return await update_mod.check(APP_VERSION)


#: 지금 받고 있는 일. ★**하나뿐이다** — 취소가 무엇을 끊을지 알아야 하고, 둘이 겹치면
#  나중 것이 앞의 것이 받아 둔 `.update/` 를 지우고 시작한다 (`update.stage` 첫 줄).
_UPDATE_TASK: asyncio.Task | None = None


@app.post("/api/update/stage")
async def update_stage():
    """새 판을 받아 `.update/new/` 에 쌓아 둔다. ★앱 파일은 아직 안 건드린다.

    ★★**따로 떼어 돌린다** (사용자 지적 2026-08-26: *"취소 버튼이 없음. 무조건 끝까지
      받아야함"*). 예전에는 요청 안에서 그대로 기다렸는데, 그러면 **끊을 손잡이가 없다.**
      일감으로 만들어 두면 `/api/update/cancel` 이 그것을 끊는다.
    ★답은 예전과 같다 — 끝까지 기다렸다가 결과를 돌려준다. 화면은 소켓으로 진행을 본다."""
    global _UPDATE_TASK
    if _UPDATE_TASK and not _UPDATE_TASK.done():
        return {"ok": False, "error": "이미 받는 중입니다"}

    async def prog(done: int, total: int) -> None:
        await Q.broadcast({"type": "update_progress", "done": done, "total": total})

    async def unpack() -> None:
        """다 받았고 이제 푼다 — ★화면의 「받는 중」이 「설치 중」으로 넘어가는 지점이다."""
        await Q.broadcast({"type": "update_unpack"})

    _UPDATE_TASK = asyncio.create_task(update_mod.stage(APP_DIR, APP_VERSION, prog, unpack))
    try:
        got = await _UPDATE_TASK
    except asyncio.CancelledError:
        # ★받다 만 것을 치운다 — 다음에 받을 때 `.update/` 가 어중간하면 안 된다
        update_mod.clear(APP_DIR)
        got = {"ok": False, "cancelled": True, "error": "취소했습니다"}
    except Exception as e:
        # ★★**끝났다는 소식은 무슨 일이 있어도 나간다** (2026-08-27). 예전에는 취소만 받아서,
        #   푸는 중에 무엇이 깨지면 예외가 그대로 올라가고 **아래 방송을 건너뛰었다** —
        #   화면은 「받는 중」에서 영영 멈춘다. 실패도 소식이다.
        traceback.print_exc()
        update_mod.clear(APP_DIR)
        got = {"ok": False, "error": f"{type(e).__name__}: {e}"}
    finally:
        _UPDATE_TASK = None
    await Q.broadcast({"type": "update_staged", **got})
    return got


@app.post("/api/update/cancel")
async def update_cancel():
    """받는 중인 것을 끊는다 (사용자 지적 2026-08-26).

    ★끊긴 뒤의 치우기는 **받던 쪽**이 한다 (`update_stage` 의 `except`) — 치우는 자리가
      둘이면 서로 남의 파일을 지운다."""
    if _UPDATE_TASK and not _UPDATE_TASK.done():
        _UPDATE_TASK.cancel()
        return {"ok": True}
    return {"ok": False, "error": "받는 중인 것이 없습니다"}


@app.post("/api/token")
async def set_token(body: TokenBody):
    """토큰 저장·삭제. ★**검사하고 받는다** (backend.py:4470-4500 이식).

    빈 값이면 지운다 (`secretstore.Secrets.set`). 값이 있으면 형태를 먼저 보고,
    그 다음 NAI 에 물어본다 — ★**401 일 때만 막는다.** 그 밖의 응답·타임아웃·
    네트워크 오류는 토큰이 틀렸다는 증거가 아니라서, 저장하고 경고만 남긴다
    (NAI 쪽 일시적 400 으로 멀쩡한 토큰이 등록조차 안 되던 문제)."""
    token = (body.token or "").strip()
    warning = ""
    if token:
        if any(c.isspace() for c in token):
            raise HTTPException(400, "토큰에 공백이 섞여 있습니다. 공백 없이 토큰만 붙여 넣으세요.")
        try:
            token.encode("ascii")
        except UnicodeEncodeError:
            raise HTTPException(400, "토큰에 쓸 수 없는 문자가 있습니다. 다시 복사해 주세요.")
        if not token.startswith("pst-"):
            raise HTTPException(400, "Persistent API Token 이 아닙니다. pst- 로 시작하는 값을 넣어 주세요.")

        import httpx

        try:
            async with httpx.AsyncClient(timeout=15) as client:
                r = await client.get(
                    "https://image.novelai.net/user/subscription",
                    headers={"Authorization": f"Bearer {token}"},
                )
            if r.status_code == 401:
                raise HTTPException(400, "토큰이 만료됐거나 유효하지 않습니다. 새로 발급해 주세요.")
            if r.status_code != 200:
                warning = f"저장했지만 NAI 확인은 못 했습니다 (응답 {r.status_code}). 생성이 되면 문제없습니다."
        except HTTPException:
            raise
        except Exception as e:
            warning = f"저장했지만 NAI 확인은 못 했습니다 ({type(e).__name__}). 인터넷 연결을 확인해 주세요."

    SECRETS.set("nai_token", token)
    return {"ok": True, "hasToken": bool(nai_token()), "warning": warning}


# ── 에이전트 다리 (바깥에서 앱 도구를 부른다) ─────────────────────
class AgentCall(BaseModel):
    name: str
    input: dict = {}


@app.get("/api/agent/system")
async def agent_system(lang: str = ""):
    """★두 경로(BYOK·CLI)가 **같은 지침**을 쓴다 — 두 벌로 두면 곧 어긋난다.

    ★`lang` 은 앱의 표시 언어다 — 답도 그 언어로 나와야 한다 (사용자 지시 2026-08-12).
      안 주면 사용자 말을 따라간다."""
    return {"system": agent_mod.system_prompt(CONFIG.get("support_url", ""), GUIDE.block(), lang)}


class WsNowBody(BaseModel):
    name: str = ""


@app.post("/api/agent/workspace")
async def set_agent_workspace(body: WsNowBody):
    """앱이 **지금 연 워크스페이스**를 알려 준다 — 파일 도구의 기준이 된다.

    ★없으면 도구가 오류로 세운다(코드가 대신 고르지 않는다). 바깥(MCP)에서 부를 때는
    도구 인자로 지정하면 된다."""
    app_cmd.workspace = (body.name or "").strip()
    return {"ok": True, "workspace": app_cmd.workspace}


@app.get("/api/agent/tools")
async def agent_tools():
    """★**언제나 같은 목록**이다. 화면이 붙어 있든 말든 상관없다 —
    앞선 구조는 화면이 올려 준 것에 기대서, 화면이 안 붙으면 도구가 0개가 됐다."""
    return {"tools": tools.specs(), "ready": True}


@app.post("/api/agent/call")
async def agent_call(body: AgentCall):
    return await tools.call(body.name, body.input)


# ── 로컬 에이전트 CLI ─────────────────────────────────────────────
class CliRun(BaseModel):
    prompt: str
    system: str = ""
    exe: str = ""
    #: 어느 CLI 인가 (`cliagent.KNOWN` 의 id). ★비면 실행 파일 이름으로 짐작한다
    agent: str = ""
    #: 어느 대화인가 (화면의 대화 id) — ★세션을 고르는 열쇠다
    chat: str = ""
    # ★저쪽이 들고 있는 대화 id — 있으면 이어 붙인다 (없으면 새 대화)
    resume: str = ""
    #: 비우면 CLI 기본값. 별칭('sonnet'·'opus')도 전체 이름도 받는다
    model: str = ""
    #: 추론 강도 — 비우면 CLI 기본값
    effort: str = ""


@app.get("/api/cli/detect")
async def cli_detect():
    """PATH + 툴체인 폴더 스캔. **공짜다** — 켤 때마다 불러도 된다."""
    return {"items": cliagent.detect(), "busy": bool(_sess and _sess.busy)}


@app.get("/api/cli/session/{sid}")
async def cli_session(sid: str, agent: str = "claude-code"):
    """그 대화를 저쪽이 아직 갖고 있나 — **열 때 미리** 물어 안내하려고 있다.
    ★사용자가 말을 걸어 실패를 겪고 나서 알게 되지 않도록 (사용자 지시 2026-08-12).
    ★두는 자리가 CLI 마다 다르다 — 어느 쪽 번호인지 함께 받는다."""
    return {"exists": cliagent.session_exists(sid, agent)}


#: 지금 살아 있는 조수 한 명 (`agentsession` 머리 주석 — 한 번에 하나다)
_sess: agentsession.Session | None = None


async def _session_for(agent: str, exe: str, backend: str, chat: str,
                       resume: str) -> agentsession.Session:
    """지금 세션을 그대로 쓰거나, 다른 대화·다른 CLI 면 갈아 세운다.

    ★★고르는 열쇠는 **대화 id** 다. 예전에 "이어붙임 번호가 비었으면 아무거나 쓴다"로
      뒀더니, 「새 대화」를 눌러도 (번호가 비어 있으니) 앞 대화의 세션을 그대로 물려받아
      **옛 이야기가 이어졌다.** 번호는 앱을 껐다 켠 뒤 저쪽 대화를 되찾는 데만 쓴다."""
    global _sess
    ok = (
        _sess is not None
        and _sess.kind == agent
        and _sess.exe == exe
        and _sess.chat == chat
    )
    if ok:
        assert _sess is not None
        return _sess
    if _sess is not None:
        # ★★돌던 세션을 닫으면 화면이 「일하는 중」에 갇힌다 — 끝을 알리고 닫는다
        if _sess.busy:
            await Q.broadcast(Q.add_cli_event(_sess.kind, {"type": "turn_end", "code": 0}))
        await _sess.close()

    async def emit(ev: dict):
        # ★화면으로 그대로 흘린다 — 도구 줄·글자를 그리는 것은 화면 몫이다.
        #   ★어느 CLI 인지 함께 실어야 화면이 어느 모양으로 읽을지 안다 (모양이 서로 다르다).
        #   ★★번호를 붙여 **남기고** 내보낸다. 소켓이 잠깐 끊겨도 되받을 수 있어야 한다
        #     (`genqueue` 머리 주석 — 안 그러면 「일하는 중…」에서 영원히 멈춘다).
        await Q.broadcast(Q.add_cli_event(agent, ev))

    # ★워크스페이스가 아니라 **앱 안의 빈 폴더**(`data/agent/`)에서 돌린다
    _sess = agentsession.make(agent, exe, cliagent.work_dir(DATA_DIR), backend, emit)
    _sess.chat = chat
    _sess.session_id = resume
    return _sess


@app.post("/api/cli/run")
async def cli_run(body: CliRun, port: int = 0):
    """말을 건다 — **놀고 있으면 새 턴, 도는 중이면 그 턴에 끼워 넣는다.**

    ★예전에는 도는 중이면 409 로 돌려보냈다. 이제는 창구가 하나다 (사용자 지시 2026-08-15)."""
    exe = body.exe or (cliagent.find(["claude"]) or "")
    if not exe:
        raise HTTPException(400, "CLI 를 못 찾았습니다. 설치하고 다시 스캔해 주세요.")
    agent = body.agent or cliagent.agent_of(exe)
    # ★열쇠 앞머리를 함께 넘긴다 — 조수의 MCP 창구도 같은 문으로 들어온다
    #   (`backend/mcp_stdio.py` 의 `PEROPIX_BACKEND`). 안 붙이면 조수가 403 만 받는다.
    backend = f"http://127.0.0.1:{port or CURRENT_PORT}{KEY_PREFIX}"
    system = body.system or agent_mod.system_prompt(CONFIG.get("support_url", ""), GUIDE.block())
    s = await _session_for(agent, exe, backend, body.chat, body.resume)
    s.model, s.effort = body.model, body.effort

    # 도는 중이면 끼워 넣어 본다 — 되면 새 턴을 열지 않는다
    if s.busy:
        try:
            if await s.steer(body.prompt):
                return {"ok": True, "mode": "steer", "agent": agent, "session": s.session_id}
        except Exception as e:
            traceback.print_exc()
            raise HTTPException(500, f"{type(e).__name__}: {e}") from e
        # 못 끼워 넣는 CLI — 부른 쪽이 줄을 세운다
        return {"ok": True, "mode": "busy", "agent": agent, "session": s.session_id}

    # ★이 턴의 번호 — 끊겼다 붙은 화면이 "내가 시킨 그 턴"의 놓친 줄만 되받게 한다
    run_id = str(uuid.uuid4())[:8]
    Q.start_cli_run(run_id)

    async def go():
        try:
            await s.start_turn(body.prompt, system)
        except Exception as e:
            # ★**종류를 반드시 붙인다** — `str(e)` 가 빈 예외가 있다 (실측 2026-08-12:
            #   리로드 모드의 `NotImplementedError`). 그때 화면에는 까닭 없이 「코드 -1」만
            #   남아서, 고칠 실마리가 하나도 없었다. 로그에도 통째로 남긴다.
            traceback.print_exc()
            why = str(e).strip()
            s.busy = False
            await Q.broadcast(Q.add_cli_event(agent, {
                "type": "error",
                "text": f"{type(e).__name__}: {why}" if why else type(e).__name__,
            }))
            await Q.broadcast(Q.add_cli_event(agent, {"type": "turn_end", "code": -1}))

    asyncio.create_task(go())
    return {"ok": True, "mode": "start", "exe": exe, "agent": agent, "run": run_id}


@app.post("/api/cli/stop")
async def cli_stop():
    """★**그 턴만 멈춘다** — 대화는 살아 있다 (사용자 지시 2026-08-15).
    예전에는 프로세스를 죽여서 이어 붙일 자리까지 함께 날아갔다.

    ★**돌던 게 있었는지 돌려준다.** 없으면 `turn_end` 도 안 오는데, 화면이 그것을 기다리며
      「일하는 중」에 갇힌다 (화면과 서버가 어긋난 경우)."""
    running = _sess is not None and _sess.busy
    if running:
        assert _sess is not None
        await _sess.interrupt()
    return {"ok": True, "stopped": running}


# ── LLM (BYOK) ────────────────────────────────────────────────────
# ★키는 여기서만 산다. 설정 조회는 `hasKey` 만 돌려주고 키 자체는 절대 안 나간다.
class LlmConfigBody(BaseModel):
    provider: str = ""
    model: str = ""
    #: 추론 강도. `None` 이면 그대로 두고, 빈 문자열이면 **끈다**(모델 기본값)
    effort: str | None = None
    # 빈 문자열이면 **그대로 둔다** (설정 화면이 키를 다시 안 보내도 지워지지 않게)
    key: str | None = None


class LlmChatBody(BaseModel):
    system: str = ""
    messages: list[dict]
    tools: list[dict] | None = None
    #: ★기본은 **안 보냄**이다 (llm.chat 주석). 상한을 걸면 thinking 모델이 추론에
    #  다 쓰고 본문이 0자로 잘린다 — 실측으로 밟았다.
    maxTokens: int | None = None


def _llm_view() -> dict:
    v = llm_mod.config_view(
        {"llm": CONFIG.get("llm") or {}}, lambda pid: SECRETS.has(f"llm_key_{pid}")
    )
    # ★요청 창구 주소는 **한 곳뿐**이다 (`agent.SUPPORT_URL`, `config.json` 의 `support_url` 로
    #   바꾼다). 화면에 따로 박으면 주소가 바뀔 때 두 곳을 고쳐야 한다.
    v["support"] = CONFIG.get("support_url") or agent_mod.SUPPORT_URL
    return v


# ── 사용자 지침 ────────────────────────────────────────────────────
# ★AI 도 사람도 **같은 문서**를 통째로 읽고 쓴다 (guide.py 머리 주석).
class GuideBody(BaseModel):
    text: str


@app.get("/api/guide")
async def guide_get():
    return {"text": GUIDE.read(), "max": guide_mod.MAX_CHARS}


@app.put("/api/guide")
async def guide_put(body: GuideBody):
    r = GUIDE.write(body.text)
    if r.get("error"):
        raise HTTPException(400, r["error"])
    return r


@app.get("/api/llm/config")
async def llm_config():
    return _llm_view()


@app.post("/api/llm/config")
async def set_llm_config(body: LlmConfigBody):
    cur = dict(CONFIG.get("llm") or {})
    cur.pop("key", None)  # ★설정 파일에는 키가 **없다** - 비밀 파일로 간다
    pid = body.provider or llm_mod.provider_of(cur)
    if pid not in llm_mod.PROVIDERS:
        raise HTTPException(400, f"모르는 공급자: {pid}")
    cur["provider"] = pid
    models = dict(cur.get("models") or {})
    if body.model.strip():
        models[pid] = body.model.strip()
    cur["models"] = models
    if body.effort is not None:
        efforts = dict(cur.get("efforts") or {})
        efforts[pid] = body.effort.strip()
        cur["efforts"] = efforts
    CONFIG["llm"] = cur
    save_config(CONFIG)
    if body.key is not None and body.key.strip():
        SECRETS.set(f"llm_key_{pid}", body.key)
    if body.key == "":
        SECRETS.set(f"llm_key_{pid}", "")  # 빈 문자열을 **명시적으로** 보내면 지운다
    return _llm_view()


@app.get("/api/llm/models")
async def llm_models(provider: str = ""):
    """★공급자에게 물어본 목록. 코드에 박아 두지 않는다 — 목록은 썩는다.

    ★오픈라우터는 **추천 목록만** 준다 (사용자 결정 2026-08-08) — 명세를 아는 모델만 고르게 한다."""
    return await llm_mod.models(llm_settings(provider))


@app.post("/api/llm/verify")
async def verify_llm(provider: str = ""):
    """★키가 실제로 도는지 눌러서 확인한다 (사용자가 누를 때만 — 공짜가 아니다)."""
    return await llm_mod.verify(llm_settings(provider))


class ChatBody(BaseModel):
    wire: list
    title: str = ""
    session: str = ""
    #: 어디서 시작했는지 — 목록 라벨용. 첫 저장 때만 박힌다 (chats.py)
    workspace: str = ""


@app.get("/api/chats")
async def list_chats():
    return {"items": chats.list()}


@app.get("/api/chats/{cid}")
async def get_chat(cid: str):
    d = chats.get(cid)
    if d is None:
        raise HTTPException(404, "그런 대화가 없습니다.")
    return d


@app.put("/api/chats/{cid}")
async def put_chat(cid: str, body: ChatBody):
    try:
        return chats.put(cid, body.wire, body.title, body.session, body.workspace)
    except ValueError as e:
        raise HTTPException(400, str(e))


@app.delete("/api/chats/{cid}")
async def delete_chat(cid: str):
    """★휴지통을 거친다 — `trashed` 를 화면이 들고 있다가 「되돌리기」로 넘긴다 (D7)."""
    try:
        r = chats.delete(cid)
    except ValueError as e:
        raise HTTPException(400, str(e))
    return {"ok": True, **r}


@app.post("/api/chats/restore")
async def restore_chat(body: RestoreBody):
    return chats.restore(body.entries)


@app.post("/api/llm/chat")
async def llm_chat(body: LlmChatBody):
    return await llm_mod.chat(
        llm_settings(), body.system, body.messages, body.tools, body.maxTokens
    )


@app.get("/api/subscription")
async def subscription():
    import httpx

    token = nai_token()
    if not token:
        raise HTTPException(400, "NAI 토큰이 설정되지 않았습니다.")
    async with httpx.AsyncClient(timeout=20) as client:
        r = await client.get(
            "https://image.novelai.net/user/subscription",
            headers={"Authorization": f"Bearer {token}"},
        )
    if r.status_code != 200:
        raise HTTPException(r.status_code, r.text[:300])
    d = r.json()
    ts = d.get("trainingStepsLeft", {})
    # ★★Opus 무료 생성 **잔량** (2026-08-21 신설). V5 부터 Opus 무료가 유한해졌다 —
    #   바닥나면(`isNegative`) 무료가 꺼지고 정상 과금된다.
    #     percent               남은 비율 0~100
    #     timeUntilNextPercent  1% 회복까지 남은 **초**
    #     isNegative            빚진 상태 (다 쓰고 더 쓴 만큼)
    #   ★그대로 넘긴다 — 뜻을 정하는 계산은 `src/lib/opusUsage.ts` 한 곳이다.
    u = d.get("usage")
    return {
        "tier": d.get("tier"),
        "anlas": ts.get("fixedTrainingStepsLeft", 0) + ts.get("purchasedTrainingSteps", 0),
        "usage": u if isinstance(u, dict) else None,
    }


# ── 워크스페이스 ──────────────────────────────────────────────────
@app.get("/api/workspaces")
async def list_workspaces():
    return {"items": store.list()}


#: 목록에서 빼는 무거운 항목 — 화면은 목록에서 이것들을 안 읽는다.
#: ★2026-08-22 부터 이 값들은 애초에 색인에 없다 (`workspace.ENV_NAME`). 여기는 **안전망**으로
#:   남긴다 — 쪼개기 전에 적힌 줄이나 옛 백업을 되돌린 파일이 섞여도 화면으로 새지 않는다.
HEAVY_REC = ("resolved", "env")


def _light(rec: dict) -> dict:
    return {k: v for k, v in rec.items() if k not in HEAVY_REC}


#: ★★**이벤트 루프에서 하면 안 되는 일** (사용자 지적 2026-08-28: *"앱이 멈춘 것처럼"*).
#  이 서버는 한 프로세스라, `async def` 안에서 **기다리거나 큰 파일을 읽으면 그동안 아무 요청도
#  못 받는다** — 썸네일도 웹소켓도 **다른 워크스페이스에서 돌고 있는 생성**도 함께 선다.
#  다음 둘은 반드시 스레드로 보낸다 (`asyncio.to_thread`):
#    · 워크스페이스 **잠금을 기다리는 것** (`Store.save` — 옮기기가 1~2초 쥐고 있을 수 있다)
#    · **파일을 통째로 읽고 쓰는 것** (색인 `records`, 곁파일 `heavy_of` — 실측 112MB)
#  ★동기(`def`) 핸들러는 FastAPI 가 알아서 스레드로 돌린다 (썸네일이 그래서 멀쩡했다).
#    `async def` 로 적은 것만 이 규칙에 걸린다.
@app.get("/api/workspaces/{ws}")
async def get_workspace(ws: str):
    spec = await asyncio.to_thread(store.load, ws)
    # ★★무거운 것은 목록에서 뺀다 — `resolved`(그때 나간 페이로드, 바이브·베이스 그림의
    #   base64 가 들어 있다)와 `env`(화면 구조 스냅샷)다. **둘 다 화면이 목록에서 안 읽는다.**
    #   필요할 때 한 장씩 `/api/workspaces/{ws}/env` 로 가져간다.
    # ★파일이 없는 줄은 뺀다 (`Store.live_records` 의 ★★주) — 지운 그림의 목록을 따로 두지 않는다
    return {"spec": spec, "records": await asyncio.to_thread(lambda: [_light(r) for r in store.live_records(ws)])}


@app.put("/api/workspaces/{ws}")
async def put_workspace(ws: str, body: SpecBody):
    """★다른 워크스페이스의 spec 이면 **409** — 파일은 그대로다 (`Store.save` 의 ★★주). 화면은 409 를
    받으면 지금 워크스페이스를 서버에서 다시 읽는다 (`store/workspace.ts` 의 `save`)."""
    try:
        # ★잠금을 **스레드에서** 기다린다 (위 ★★주) — 여기서 기다리면 서버가 통째로 선다
        return {"spec": await asyncio.to_thread(store.save, ws, body.spec)}
    except SpecMismatch as e:
        raise HTTPException(409, str(e))


@app.post("/api/workspaces/{ws}/rename")
async def rename_workspace(ws: str, body: dict):
    new = safe_name(str(body.get("name", "")).strip())
    if not new:
        raise HTTPException(400, "이름이 비어 있습니다.")
    return {"name": store.rename(ws, new)}


@app.delete("/api/workspaces/{ws}")
async def delete_workspace(ws: str):
    """★워크스페이스도 휴지통을 거친다 (D7). 예전에는 `rmtree` 라 되돌릴 길이 없었다."""
    return {"ok": True, **store.delete(ws)}


@app.post("/api/workspaces/restore")
async def restore_workspace(body: RestoreBody):
    """★`/api/workspaces/{ws}/restore` 와 다르다 — 저쪽은 그 워크스페이스 **안의 그림**,
    이쪽은 **워크스페이스 자체**를 되살린다."""
    return store.restore_ws(body.entries)


class CopyBody(BaseModel):
    """「새 탭으로 복제」 — 그림 **한 장**이 앉을 자리를 화면이 정해서 보낸다.
    ★씬 값(`cell`·`cell_id`·`cell_no`)을 비우지 말 것 — 없으면 파일 이름 앞의 씬 번호가
      빠져서, 그 세트 안에서 어느 씬 것인지 파일만 보고는 알 수 없다."""

    file: str
    scene_group: str
    scene_group_id: str | None = None
    cell: str | None = None
    cell_id: str | None = None
    cell_no: int | None = None
    tab: str | None = None
    exclude_slot_number: bool = False
    #: ★원본이 **보관함**에 있다 (갤러리에서 복제). 그때는 워크스페이스에 레코드가 없어
    #  시드도 화면이 메타데이터에서 읽어 실어 준다.
    from_keep: bool = False
    seed: int | None = None


@app.get("/api/workspaces/{ws}/env")
async def gallery_env(ws: str, file: str):
    """그 그림을 뽑을 때의 **화면 구조**. 「새 탭으로 복제」가 이것으로 환경을 되살린다.

    ★없을 수 있다 — 이 기능이 생기기 전(2026-08-19)에 만든 그림은 안 남겼다.
      그때는 화면이 **그 그림이 나온 탭**에서 가져간다 (`cloneToNewTab` 의 폴백)."""
    # ★무거운 것은 곁파일에 있다 (`workspace.ENV_NAME` 머리 주석) — 색인을 훑지 않는다
    # ★곁파일은 통째로 읽는다 (실측 112MB) — 루프에서 읽으면 그동안 서버가 선다 (위 ★★주)
    return {"env": (await asyncio.to_thread(store.heavy_of, ws, file)).get("env")}


@app.get("/api/workspaces/{ws}/base")
async def gallery_base(ws: str, file: str):
    """그 그림을 뽑을 때의 **베이스 이미지**(i2i·인페인트). 없으면 전부 빈 값.

    ★★그림에는 안 남는다 — NAI 가 돌려주는 PNG 의 Comment 에 베이스 그림은 없다.
      우리는 보낸 페이로드를 통째로 기록해 두므로(`resolved`) 거기서 꺼낸다
      (사용자 지시 2026-08-22: 「설정 불러오기」가 되살리게 해 달라).
    ★**전처리된 그림**이다 — 해상도에 맞춰 리샘플·레터박스된 것이지 원본 파일이 아니다.
      그대로 다시 뽑으면 같은 결과가 나오고, 그게 이 기능의 목적이다.
    ★따로 낸 까닭: base64 라 무겁다. 「설정 불러오기」를 누를 때만 한 번 가져간다 —
      `/meta` 나 `/env` 에 얹으면 목록을 훑을 때마다 딸려 온다.
    ★강도·노이즈는 페이로드의 **본이름 그대로** 읽는다 (`strength`·`noise`).
      인페인트는 마스크가 함께 있어야 그 모드로 돌아간다."""
    par = ((await asyncio.to_thread(store.heavy_of, ws, file)).get("resolved") or {}).get("parameters") or {}
    img = par.get("image")
    if not isinstance(img, str) or not img:
        return {"image": ""}
    mask = par.get("mask")
    mask = mask if isinstance(mask, str) else ""
    out = {"image": img, "mask": mask, "mode": "inpaint" if mask else "img2img"}
    # ★★슬라이더가 **둘**이다 (`nai.py` 의 인페인트 절): `strength` 는 img2img 슬라이더,
    #   `inpaintImg2ImgStrength` 는 인페인트 슬라이더. 한 값으로 합치지 말 것.
    #   ★인페인트는 `noise` 를 0 으로 눌러 보내므로 그 값을 되살려도 화면 값이 안 어긋난다.
    for key, name in (("strength", "strength"), ("noise", "noise"),
                      ("inpaintImg2ImgStrength", "inpaint_strength")):
        v = par.get(key)
        if isinstance(v, (int, float)) and not isinstance(v, bool):
            out[name] = float(v)
    return out


@app.post("/api/workspaces/{ws}/copy")
async def copy_to_tab(ws: str, body: CopyBody):
    """그림 한 장을 **탭 하나에** 복사한다 (원본은 그대로).

    ★원본은 이 워크스페이스의 그림이거나 **보관함 그림**이다(`from_keep`) — 갤러리의
      「새 탭으로 복제」도 그림이 슬롯에 앉아야 하므로 같은 자리를 쓴다."""
    try:
        src = keep.safe_folder(KEEP_DIR, body.file) if body.from_keep else None
        return store.copy_to_scene_group(ws, body.file, body.scene_group, body.scene_group_id, body.cell,
                                 body.cell_id, body.cell_no, body.tab,
                                 body.exclude_slot_number, src, body.seed)
    except ValueError as e:
        raise HTTPException(404, str(e))


def _refuse_if_generating(ws: str, group_ids: set[str]) -> None:
    """그 세트들 중 하나라도 생성 중이면 거절한다 (`generating_targets` 의 ★★주)."""
    busy = {g for (w, g) in genqueue.generating_targets(Q) if w == ws and g in group_ids}
    if busy:
        raise HTTPException(409, "생성 중인 씬이 있습니다. 끝난 뒤에 옮겨 주세요.")


class MoveTabBody(BaseModel):
    to: str
    #: 마지막 탭을 옮길 때 그 자리에 세울 **빈 탭의 모양** (이름·씬 그룹 이름·빈 프롬프트) — 화면이 준다
    fill: dict | None = None


@app.post("/api/workspaces/{ws}/tabs/{tab_id}/move")
async def move_tab(ws: str, tab_id: str, body: MoveTabBody):
    """탭을 **다른 워크스페이스로** 옮긴다 (`Store.move_tab`). 파일을 옮기므로 스레드로 보낸다."""
    # ★생성 중인 씬이 그 탭에 있으면 옮기지 않는다 (`generating_targets` 의 ★★주)
    spec = store.load(ws) or {}
    _refuse_if_generating(ws, {str(g.get("id")) for g in (spec.get("sceneGroups") or [])
                               if g.get("tabId") == tab_id})
    try:
        return await asyncio.to_thread(store.move_tab, ws, tab_id, body.to, body.fill)
    except ValueError as e:
        raise HTTPException(400, str(e))


class MoveGroupBody(BaseModel):
    to_tab: str
    #: 그 탭의 마지막 세트를 옮길 때 세울 **빈 세트의 이름** — 화면이 준다
    fill: dict | None = None


@app.post("/api/workspaces/{ws}/scene-groups/{group_id}/move")
async def move_scene_group_api(ws: str, group_id: str, body: MoveGroupBody):
    """씬 그룹을 **같은 워크스페이스의 다른 탭으로** (`Store.move_scene_group`). 파일을 옮기므로 스레드로."""
    _refuse_if_generating(ws, {group_id})   # ★생성 중이면 거절 (`generating_targets` 의 ★★주)
    try:
        return await asyncio.to_thread(store.move_scene_group, ws, group_id, body.to_tab, body.fill)
    except ValueError as e:
        raise HTTPException(400, str(e))


class TrashBody(BaseModel):
    files: list[str] = []
    entries: list[dict] = []


@app.post("/api/workspaces/{ws}/trash")
async def trash_files(ws: str, body: TrashBody):
    """지우기 = 휴지통으로 **이동**. 되돌릴 수 있게 자리를 돌려준다 (trash.py 머리 주석)."""
    return trash.send(store, ws, body.files)


@app.post("/api/workspaces/{ws}/restore")
async def restore_files(ws: str, body: TrashBody):
    return trash.restore(store, ws, body.entries)




class RenumberBody(BaseModel):
    """씬 자리가 바뀌었을 때 **바뀐 뒤의** 번호·이름 (선결 조건 3-8).

    ★누가 어느 씬인지는 화면이 안다(`cell_id` 로 묶는다) — 서버는 **이름 규칙**만 안다."""

    items: list[dict] = []


@app.post("/api/workspaces/{ws}/renumber")
async def renumber_files(ws: str, body: RenumberBody):
    """씬 순서가 바뀌면 **파일 이름의 씬 번호도 따라간다** (사용자 지시 2026-08-24).

    ★조수가 시켰든 사람이 끌어다 놓았든 **같은 길**을 지난다 — 화면의 `moveScene` 이 부른다.

    ★★**딴 실에서 돈다** (실측 2026-08-27). 파일을 옮기고 색인을 다시 쓰는 통짜 작업이라
      `async` 안에서 그대로 부르면 **이벤트 루프가 그동안 멈춘다** — 이미 뜬 그림은 멀쩡한데
      새로 받아야 하는 것(큰 그림·아직 안 뜬 썸네일)만 몇 초 동안 안 나오고, 끝나는 순간
      한꺼번에 뜬다. 사용자가 본 「5초 뒤 화면이 한 번 깜빡」이 그것이다."""
    # ★걸린 시간을 남긴다 — 「느리다」는 제보가 오면 여기 숫자부터 본다
    t0 = time.perf_counter()
    got = await asyncio.to_thread(store.renumber, ws, body.items)
    say("info", "renumber", f"{len(got.get('pairs') or [])}장 · {time.perf_counter() - t0:.2f}초")
    return got


# ── 썸네일 ────────────────────────────────────────────────────────

@app.get("/api/thumb/{ws}/{rel:path}")
def get_derived_thumb(ws: str, rel: str):
    """생성물의 **파생 썸네일** — 히스토리 줄·셀 그리드가 쓴다 (원본은 /api/file).

    ★같은 경로에는 늘 같은 그림이다 (생성이 매번 새 파일명을 쓴다). 원본이 바뀌면
      mtime 비교로 다시 굽는다."""
    p = store.thumb_path(ws, rel)
    if not p:
        raise HTTPException(404, "not found")
    return FileResponse(p, media_type="image/webp", headers=IMMUTABLE_IMG)


@app.post("/api/pin")
async def pin_thumb(body: PinBody):
    """생성물을 **고정 썸네일**로 굳힌다 — 배너·카드 앞면·덱 커버가 이 tid 를 함께 쓴다.

    ★바이트를 주고받지 않는다. 예전엔 브라우저가 캔버스로 줄여 base64 로 올렸는데,
      같은 주소를 평범한 <img> 로 먼저 띄운 적이 있으면 CORS 헤더 없는 캐시 항목이
      재사용돼 **조용히 실패**했다 (실사용: "적용을 눌러도 반응이 없다").
      서버가 원본에서 직접 구우면 그 경로 자체가 없다."""
    src = store.file_path(body.workspace, body.file)
    if not src:
        raise HTTPException(404, "원본을 찾을 수 없습니다.")
    tid = pins.pin(src, f"{body.workspace}/{body.file}")
    if not tid:
        raise HTTPException(500, "썸네일을 만들지 못했습니다.")
    return {"tid": tid}


@app.get("/api/pin/{tid}")
async def get_pinned_thumb(tid: str):
    p = pins.path(tid)
    if not p:
        raise HTTPException(404, "not found")
    return FileResponse(p, media_type="image/webp", headers=IMMUTABLE_IMG)


# ── 카드 (공용) ───────────────────────────────────────────────────
@app.get("/api/cards")
async def list_cards():
    return cards.list_all()


@app.put("/api/cards/{kind}")
async def put_card(kind: str, body: CardBody):
    if kind not in KINDS:
        raise HTTPException(400, f"알 수 없는 카드 종류: {kind}")
    try:
        return {"card": cards.save(kind, body.card)}
    except ValueError as e:
        raise HTTPException(400, str(e))


@app.delete("/api/cards/{kind}/{cid}")
async def delete_card(kind: str, cid: str):
    if kind not in KINDS:
        raise HTTPException(400, f"알 수 없는 카드 종류: {kind}")
    try:
        r = cards.delete(kind, cid)
    except ValueError as e:
        raise HTTPException(400, str(e))
    return {"ok": True, **r}


@app.post("/api/cards/restore")
async def restore_card(body: RestoreBody):
    return cards.restore(body.entries)


@app.post("/api/cards/thumb/{kind}/{cid}")
async def set_card_thumb(kind: str, cid: str, body: ThumbBody):
    """카드 앞면 — 이미 굳힌 tid 를 걸기만 한다 (바이트는 /api/pin 이 만든다)."""
    if kind not in KINDS:
        raise HTTPException(400, f"알 수 없는 카드 종류: {kind}")
    if not pins.path(body.tid):
        raise HTTPException(404, f"고정 썸네일이 없습니다: {body.tid}")
    try:
        return {"card": cards.set_thumb(kind, cid, body.tid, body.view)}
    except ValueError as e:
        raise HTTPException(400, str(e))


# ── 블록 저장소 (공용) ────────────────────────────────────────────
@app.get("/api/blocks")
async def list_blocks():
    return {"items": blocklib.list()}


@app.put("/api/blocks")
async def put_block(body: BlockItemBody):
    return {"item": blocklib.save(body.item)}


@app.delete("/api/blocks/{bid}")
async def delete_block(bid: str):
    blocklib.delete(bid)
    return {"ok": True}


@app.post("/api/blocks/order")
async def reorder_blocks(body: BlockOrderBody):
    return {"items": blocklib.reorder(body.ids)}


# ── 와일드카드 정의 문서 (공용) ───────────────────────────────────
# ★서버는 **글을 나르기만 한다.** 문법을 아는 곳은 `src/lib/wildcards.ts` 하나다
#   (`backend/wildcards.py` 머리 주석).
@app.get("/api/wildcards")
async def get_wildcards():
    return {"content": wildcards.read()}


@app.post("/api/wildcards")
async def save_wildcards(body: WildcardBody):
    wildcards.write(body.content)
    return {"ok": True}


# ── 생성 ──────────────────────────────────────────────────────────
def _quality_preset_of(body: GenBody) -> str:
    """퀄리티 프리셋 id — ★**옛 켬/끔 필드도 받아 준다.**

    큐는 백엔드가 들고 있어서, 판올림 전에 담긴 작업이 `quality_tags` 만 들고 남아 있을 수
    있다 (`store/queue.ts`). 새 필드가 없을 때만 옮긴다."""
    if body.quality_preset:
        return body.quality_preset
    if body.quality_tags is None:
        return "standard"
    return "standard" if body.quality_tags else "none"


def _req_of(body: GenBody) -> nai.GenRequest:
    return nai.GenRequest(
        prompt=body.prompt,
        negative_prompt=body.negative_prompt,
        model=body.model,
        width=body.width,
        height=body.height,
        steps=body.steps,
        cfg=body.cfg,
        sampler=body.sampler,
        scheduler=body.scheduler,
        seed=body.seed,
        cfg_rescale=body.cfg_rescale,
        uc_preset=body.uc_preset,
        quality_preset=_quality_preset_of(body),
        variety_plus=body.variety_plus,
        transparent_bg=body.transparent_bg,
        straight_alpha=body.straight_alpha,
        furry_mode=body.furry_mode,
        # ★기본 좌표는 화면 한가운데다 (공홈 `{x:0.5, y:0.5}`). 격자를 쓰면 화면이 실어 보낸다
        characters=[
            nai.CharPrompt(
                prompt=str(c.get("prompt", "")),
                uc=str(c.get("uc", "")),
                center=c.get("center") or {"x": 0.5, "y": 0.5},
                use_coord=bool(c.get("use_coord")),
            )
            for c in (body.characters or [])
        ],
        normalize_reference_strength=body.normalize_reference_strength,
        vibe_transfer=body.vibe_transfer,
        precise_references=body.precise_references,
        base_image=body.base_image,
        base_mode=body.base_mode,
        base_strength=body.base_strength,
        base_inpaint_strength=body.base_inpaint_strength,
        base_noise=body.base_noise,
        base_mask=body.base_mask,
    )


async def _generate_one(body: GenBody) -> dict:
    """한 장을 만들어 저장하고 records 에 남긴다.

    ★★부르는 곳은 **큐 하나뿐**이다 (`_process_job`). 큐를 안 거치는 `/api/generate` 와
      그것을 부르던 `gen.generate` 는 2026-08-24 에 걷었다 — **아무도 안 부른 지 오래였고**,
      「강화·인핸스가 여기로 온다」는 주석만 남아 사실과 어긋나 있었다 (강화도 큐를 쓴다).
      한 장을 만들 일이 다시 생기면 항목 하나짜리 큐로 넣는다: 그래야 취소·진행률·재연결
      복원이 그대로 따라온다."""
    req = _req_of(body)
    # ★강화 — 원본 파일을 읽어 베이스 이미지로 쓴다 (화면이 그림을 실어 보내지 않는다).
    #   ★여기서는 **목표 크기만 잡는다.** 그림을 그 크기로 리샘플하는 것은 조립부가 한다
    #     (`imgutil.preprocess_base_image` — 공통 전송 구간이 모든 베이스 이미지에 건다).
    #     한쪽에서만 하면 두 번 리샘플되거나(화질 손실) 아예 안 된다.
    #   ★목표 크기 = `align64(floor(원본 × 배율))`. 정렬은 가까운 쪽 반올림이다
    #     (1216×832 ×1.5 는 1824×1248 이 아니라 **1856×1280**).
    #   ★고치는 대상은 `body` 가 아니라 **`req`** 다 — `req` 는 이미 만들어졌으므로 `body` 를
    #     고쳐 봐야 페이로드에 안 들어간다. 예전에 그래서 **강화가 조용히 txt2img 로 나갔다.**
    if body.enhance_from:
        src = store.file_path(body.workspace, body.enhance_from)
        if not src:
            raise HTTPException(404, "강화할 그림을 찾지 못했습니다")
        with Image.open(src) as _im:
            w, h = _im.size
        sc = max(1.0, float(body.enhance_scale or 1.0))
        req.base_image = base64.b64encode(src.read_bytes()).decode()
        req.base_mode = "img2img"
        req.base_mask = ""
        req.enhance = True
        req.width = nai.align64(math.floor(w * sc))
        req.height = nai.align64(math.floor(h * sc))

    # ★타일 인페인트 — **잘라낸 조각만** 보내고 결과를 원본 자리에 되붙인다.
    #   정본은 `docs/naia-bgcomp-survey.md` 5절. 없던 것은 「원본 해상도를 지킨 채 일부만
    #   고치는 것」이다: 지금 경로는 원본 전체를 보내고 NAI 가 요청 크기로 **줄여서** 그려
    #   2048×3072 짜리 그림을 고치면 832×1216 축소본이 결과가 된다 (같은 문서 4절).
    #   ★사각형이 없으면 **지금 동작 그대로** 간다 — 옛 세션의 「부분 수정」이 안 바뀐다.
    tile_src: Image.Image | None = None
    tile_rect: tuple[int, int, int, int] | None = None
    if body.inpaint_rect and req.base_image:
        # ★★**화면이 보낸 그림에서 자른다** (사용자 지적 2026-08-20: *"드롭했으면 경로가
        #   확실한 거 아니야? 갤러리는 더 확실하고"*). 예전에는 워크스페이스 파일을 다시
        #   열어 잘랐고, 그래서 **갤러리·드롭으로 넣은 그림에는 기능이 아예 없었다.**
        #   베이스 이미지는 어차피 매 요청에 실려 오므로(`base_image`) 파일을 열 이유가 없다 —
        #   보내는 양도 그대로고, 경로가 없는 그림도 똑같이 된다.
        with Image.open(io.BytesIO(base64.b64decode(req.base_image))) as _b:
            _b.load()
            tile_src = _b.copy()
        x, y, w, h = imgutil.fit_tile_rect(body.inpaint_rect, *tile_src.size)
        if not req.base_mask:
            raise HTTPException(400, "마스크가 없습니다 — 고칠 자리를 칠해 주세요")
        # ★마스크는 **원본 크기**로 받아 여기서 자른다. 자르는 주체가 둘이면 사각형이
        #   어긋났을 때 어디서 틀렸는지 알 수 없다 (조사 문서 5-1절)
        with Image.open(io.BytesIO(base64.b64decode(req.base_mask))) as _m:
            _m.load()
            mask_full = _m.convert("L")
        if mask_full.size != tile_src.size:
            mask_full = mask_full.resize(tile_src.size, Image.NEAREST)
        mask_tile = imgutil.crop_to_base64(mask_full, x, y, w, h)
        if not imgutil.mask_has_white(mask_tile):
            # ★익스텐션은 사각형 밖에 칠한 마스크를 조용히 버린다. 우리는 세운다
            raise HTTPException(400, "사각형 안에 칠한 곳이 없습니다 — 사각형을 옮기거나 더 칠해 주세요")
        req.base_image = imgutil.crop_to_base64(tile_src, x, y, w, h)
        req.base_mask = mask_tile
        req.base_mode = "inpaint"
        # ★조각을 **1MP 로 키워** 보낸다 (공홈 Focused Inpainting 과 같다). 조각 크기 그대로
        #   보내면 작은 그림이 되어 세밀함이 원본만 못하다. 키워 보내야 그 자리가 촘촘해진다.
        #   되붙일 때 원래 크기로 되돌린다 (`paste_tile` 의 w·h).
        req.width, req.height = imgutil.fit_to_1mp(w, h)
        tile_rect = (x, y, w, h)

    # ★vibe 인코딩은 **조립 전에** 한다 — 유료 호출이라 캐시 판정이 여기서 끝나야 한다
    await nai.encode_vibes(req, nai_token(), vibes)
    payload = nai.build_payload(req)
    if body.stream:
        # ★★**중간 그림을 흘린다** — 그리는 동안 보여 주면 기다림이 짧게 느껴지고, 잘못 가고
        #   있으면 일찍 끊을 수 있다. 앞 몇 스텝은 `nai` 가 건너뛴다 (잡음이라 오해를 부른다).
        # ★칸을 지목해 보낸다 — 어느 대기 칸 위에 그릴지는 그 열쇠로 정해진다
        #
        # ★★**받는 자리와 보내는 자리를 끊었다** (사용자 지적 2026-08-26: *"공홈은 비교적
        #   균등한 속도로 변하는데 이 앱은 강약이 있다 — 중간에 멈춰 있다가 갑자기 확 오른다"*).
        #   예전에는 프레임을 받은 그 자리에서 브로드캐스트를 **기다렸다.** 한 장을 부풀려
        #   내보내는 데 드는 시간만큼 NAI 스트림을 안 읽으니, 읽기가 밀렸다가 몰려 들어와
        #   화면이 끊겼다 이었다 했다. 이제 받는 쪽은 **최신 한 장만 놓고** 곧장 돌아가고,
        #   내보내는 것은 딸린 일꾼(`_pump`)이 제 속도로 한다.
        # ★밀리면 **가운데를 버린다** — 늦은 프레임을 굳이 다 보내면 완성본 뒤에까지 밀린다.
        #   버려도 되는 그림이라 그래도 된다 (영상이 프레임을 떨구는 것과 같다).
        latest: list[tuple[bytes, int] | None] = [None]
        woke = asyncio.Event()
        closed = False

        async def _pump() -> None:
            while True:
                await woke.wait()
                woke.clear()
                item, latest[0] = latest[0], None
                if item is None:
                    if closed:
                        return
                    continue
                img, step = item
                try:
                    # ★줄이는 것도 여기서 한다 — 받는 쪽은 아무것도 안 기다려야 한다
                    small = await asyncio.to_thread(imgutil.preview_jpeg, img)
                except Exception as e:
                    print(f"[스트림] 중간 그림을 줄이지 못했습니다 (건너뜀): {e}")
                    continue
                await Q.broadcast({
                    "type": "image_step",
                    "workspace": body.workspace,
                    "scene_group_id": body.scene_group_id, "cell_id": body.cell_id,
                    "step": step,
                    # ★프레임은 그림 **바이트**다 (zip 이 아니다) — 화면이 바로 걸 수 있게 보낸다
                    "mime": "image/jpeg",
                    "b64": base64.b64encode(small).decode("ascii"),
                })

        async def _step(img: bytes, step: int) -> None:
            latest[0] = (img, step)
            woke.set()

        pump = asyncio.create_task(_pump())
        try:
            png, seed = await nai.generate_streaming(payload, nai_token(), _step)
        finally:
            closed = True
            woke.set()
            try:
                await asyncio.wait_for(pump, timeout=5)
            except Exception:
                pump.cancel()
    else:
        png, seed = await nai.generate_with_payload(payload, nai_token())

    # ★인페인트 결과를 **보낸 원본 위에 소프트 마스크로 되붙인다** (7절).
    #   NAI 결과는 마스크 밖도 미세하게 달라져서, 그대로 저장하면 고치지 않은 자리가 바뀐다.
    #   ★합성 실패로 생성을 버리지 않는다 — 그때는 NAI 결과를 그대로 쓰고 콘솔에만 남긴다.
    if payload["action"] == "infill" and req.base_mask:
        try:
            png = imgutil.composite_inpaint(png, payload["parameters"]["image"], req.base_mask)
        except Exception as e:
            print(f"[인페인트] 합성하지 못했습니다 ({e}) — NAI 결과를 그대로 씁니다")

    # ★타일을 원본 자리에 되붙인다 — 합성(위)은 **타일 안에서** 이미 끝났다.
    #   합성한 타일을 붙이므로 타일 테두리에도 원본이 그대로 남아 솔기가 없다
    #   (사용자 결정 2026-08-13: 타일 통째 덮어쓰기가 아니라 소프트 마스크 합성).
    if tile_src is not None and tile_rect is not None:
        try:
            x, y, w, h = tile_rect
            png = imgutil.paste_tile(tile_src, png, x, y, w, h)
            # ★타일 경로에서 `width`·`height` 는 요청 크기가 아니라 **최종 저장 크기**다
            #   (요청 크기는 사각형에서 나온다). 기본값이 원본 크기라 대개 아무 일도 없고,
            #   화면에서 값을 바꿨을 때만 마지막에 한 번 줄이거나 키운다.
            if body.width and body.height and (body.width, body.height) != tile_src.size:
                png = imgutil.resize_png(png, body.width, body.height)
        finally:
            tile_src.close()

    # 저장 자리·이름은 `store.store_output` 하나가 정한다 (그 메서드 주석)
    # ★옛 워크스페이스가 `jpg` 를 들고 있으면 **PNG 로 떨어뜨린다** — 조용히 투명을
    #   잃는 형식으로 저장하지 않는다 (사용자 결정 2026-08-23)
    fmt = body.save_format.lower()
    if fmt not in ("png", "webp"):
        fmt = "png"

    # ★NAI 응답 PNG 에는 원본 tEXt 청크(Source 등)가 들어 있다. 포맷을 바꾸거나 메타데이터를
    #   다시 쓸 때 **그 청크를 넘겨줘야** NAI 공홈이 자기 이미지로 인식한다 (meta.write 참조).
    with Image.open(io.BytesIO(png)) as _im:
        original_chunks = dict(_im.info)

    if body.strip_metadata:
        # ★tEXt 만 지우면 안 된다 — NAI 는 알파 LSB 로 한 벌 더 심는다 (meta.strip)
        data = meta.strip(png, fmt, body.jpg_quality)
    elif fmt == "png":
        data = png  # NAI 원본 그대로가 가장 정확하다 (다시 인코딩하지 않는다)
    else:
        data = meta.write(png, meta.read_raw(png), fmt, body.jpg_quality, original_chunks)

    # ★★**이 그림을 뽑은 화면 구조**는 여기서 한 번 정한다 — 저장하든 미리보기로 돌려주든 같아야 한다.
    #   화면이 실어 준 것이 없고 강화라면(`enhance_from`) **원본의 것을 물려받는다**: 강화는 새 그림이
    #   아니라 그 그림의 다음 판이라 뽑은 구조가 같고, `EnhanceDialog` 는 원본 메타데이터로 페이로드를
    #   짜므로 구조를 실어 주지 않는다.
    #   ★없으면 그 그림에서 「설정 불러오기」를 눌렀을 때 캐릭터 카드가 통째로 사라지고
    #     `#1`·`#2` 로 다시 만들어진다 (사용자 지적 2026-08-24) — 카드는 PNG 에 안 남는다.
    shot_env = body.env or (
        (await asyncio.to_thread(store.heavy_of, body.workspace, body.enhance_from)).get("env")
        if body.enhance_from else None
    )

    # ★자동 저장을 끄면 **파일도 기록도 안 남긴다** — 미리보기로만 돌려준다 (v2 `auto_save`).
    #   골라서 저장하고 싶을 때 쓰는 것이라, 여기서 남기면 그 뜻이 사라진다.
    if not body.auto_save:
        # ★이름을 짓는 데 필요한 것을 **함께** 돌려준다 (`char`·`cell_no`·`exclude_slot_number`).
        #   나중에 「파일로 저장」을 누를 때 화면이 그때 상태로 다시 만들면, 그 사이 씬 이름을
        #   고쳤을 때 번호열이 갈린다 (`file_lead` 는 이름마다 따로 센다).
        return {"ok": True, "file": None, "b64": base64.b64encode(data).decode(),
                # ★미저장도 **서버 시각**으로 준다 — 저장된 것과 같은 자로 줄에 서야 한다
                "ts": datetime.now().isoformat(timespec="seconds"),
                "fmt": fmt, "seed": seed, "bytes": len(data),
                "scene_group": body.scene_group, "cell": body.cell,
                "scene_group_id": body.scene_group_id, "cell_id": body.cell_id,
                "cell_no": body.cell_no, "tab": body.tab,
                "exclude_slot_number": body.exclude_slot_number,
                "enhance_of": body.enhance_of,
                # ★★**화면 구조도 함께 되돌려 준다** (사용자 지적 2026-08-24). 미저장 그림을
                #   나중에 「파일로 저장」하면 그 레코드에 `env` 가 없어서, 그 그림에서
                #   「설정 불러오기」를 눌러도 카드가 안 살아났다.
                #   ★저장할 때 화면의 것을 새로 담으면 안 된다 — 그 사이 프롬프트를 고쳤으면
                #     **다른 그림의 구조**가 붙는다. 그래서 뽑을 때 것을 왕복시킨다
                #     (구조뿐이라 작다. `resolved` 는 base64 가 들어 있어 여전히 안 보낸다).
                "env": shot_env,
                "workspace": body.workspace}

    # ★씬 번호는 탐색기에서 순서를 만들고, **씬 이름**은 그 파일이 무엇인지 알려 준다
    #   (v2 `번호_이름_0000001.png`). 「씬 번호 빼기」는 v2 와 같이 **번호만** 뺀다 —
    #   규칙과 근거는 `workspace.file_lead` 주석 (사용자 결정 2026-08-18, v2-port-audit D3).
    rel = store.store_output(body.workspace, body.scene_group, body.cell, body.cell_no, body.tab,
                             body.exclude_slot_number, fmt, data)

    # ★★시각은 **여기서 한 번** 찍고 화면에도 그대로 보낸다 (사용자 지적 2026-08-19).
    #   화면이 자기 시계로 찍던 때는 `toISOString()`(UTC) 과 여기 지역시각이 섞여서,
    #   방금 만든 그림이 **문자열 비교로 더 옛것**이 되어 줄 오른쪽으로 밀렸다.
    ts = datetime.now().isoformat(timespec="seconds")
    # ★records 는 append-only. resolved 에 그 시점의 완전한 요청을 남겨
    #   나중에 spec 이 바뀌어도 재현·비교가 가능하게 한다.
    store.append_record(
        body.workspace,
        {
            "ts": ts,
            "file": rel,
            "scene_group": body.scene_group,
            "cell": body.cell,
            "scene_group_id": body.scene_group_id,
            "cell_id": body.cell_id,
            "enhance_of": body.enhance_of,
            "seed": seed,
            "resolved": payload,
            # ★위에서 한 번 정한 것을 쓴다 (`shot_env` 의 ★주) — 미저장으로 돌려준 것과 같아야 한다
            "env": shot_env,
        },
    )
    return {"ok": True, "file": rel, "seed": seed, "bytes": len(data), "ts": ts,
            "scene_group": body.scene_group, "cell": body.cell,
            "scene_group_id": body.scene_group_id, "cell_id": body.cell_id,
            "enhance_of": body.enhance_of,
            "workspace": body.workspace}


class UpscaleBody(BaseModel):
    """이미 만든 그림 한 장을 4배로 키운다. **파일 경로만** 싣는다 (바이트는 서버가 읽는다)."""

    workspace: str
    file: str
    #: 버전 뿌리 — 없으면 이 파일이 뿌리다 (강화와 같은 자리를 쓴다)
    enhance_of: str | None = None


@app.post("/api/upscale")
async def upscale_image(body: UpscaleBody):
    """업스케일 (`/ai/upscale`).

    ★결과는 **원본 옆에 새 파일**이고, 강화와 같은 방식으로 **그 그림의 버전**이 된다
      (`enhance_of` = 뿌리). 원본을 갈아 끼우지 않는다.
    ★생성 파이프라인을 타지 않는다 — 프롬프트도 시드도 없는 별개 호출이다.
    ★★2026-08-21 재배포로 **배율을 우리가 못 정한다** — 서버가 정한다 (`nai.upscale`).
      「4배」라는 말을 화면·문구에 새로 박지 말 것."""
    src = store.file_path(body.workspace, body.file)
    if not src or not src.exists():
        raise HTTPException(404, "업스케일할 그림을 찾지 못했습니다")
    with Image.open(src) as im:
        w, h = im.size
    # ★공홈도 이 한계에서 버튼을 막는다. 보내 봐야 거절이라 여기서 끊는다
    if w * h > nai.UPSCALE_MAX_PX:
        raise HTTPException(400, f"3MP 보다 큰 그림은 업스케일할 수 없습니다 ({w}x{h})")

    b64 = base64.b64encode(src.read_bytes()).decode()
    try:
        png = await nai.upscale(b64, w, h, nai_token())
    except RuntimeError as e:
        raise HTTPException(502, str(e))

    # 원본과 **같은 폴더**에 남긴다 — 버전이라 자리가 갈리면 찾기 어렵다.
    # ★접두를 따로 둔다(`up_001.png`) — 세트 탭의 셀 번호(`003_002.png`)와 섞이면
    #   폴더만 보고는 무엇이 무엇인지 알 수 없다.
    path = store.next_name(src.parent, "up", "png")
    path.write_bytes(png)
    rel = store.rel(body.workspace, path)

    # ★색인은 통째로 읽는다 — 무거운 것을 곁파일로 뺀 뒤로 줄당 211B 라 싸다
    rec = next(
        (r for r in await asyncio.to_thread(store.records, body.workspace) if r.get("file") == body.file),
        None,
    )
    new_rec = {
        "ts": datetime.now().isoformat(timespec="seconds"),
        "file": rel,
        "scene_group": (rec or {}).get("scene_group", ""),
        "cell": (rec or {}).get("cell"),
        "scene_group_id": (rec or {}).get("scene_group_id"),
        "cell_id": (rec or {}).get("cell_id"),
        # ★뿌리를 그대로 물려받는다 — 업스케일한 것을 또 키워도 스택이 평평해야 한다
        "enhance_of": body.enhance_of or (rec or {}).get("enhance_of") or body.file,
        "seed": (rec or {}).get("seed", 0),
        # ★★**그때 화면 구조도 물려받는다** (사용자 지적 2026-08-24: 「설정 불러오기」를 하면
        #   캐릭터 카드의 이름·썸네일이 없고 `#1`·`#2` 로만 나온다).
        #   원장은 `env` 하나뿐이라, 여기 없으면 화면은 PNG 메타데이터로 떨어지고
        #   메타데이터에는 **합쳐진 문자열**만 있어 카드가 통째로 사라진다.
        #   업스케일은 프롬프트를 새로 만들지 않으므로 **원본의 것이 곧 이 그림의 것**이다.
        "env": (await asyncio.to_thread(store.heavy_of, body.workspace, body.file)).get("env"),
        "op": "upscale",
    }
    store.append_record(body.workspace, new_rec)
    # ★레코드를 통째로 돌려준다 — 화면이 목록을 다시 읽지 않고 한 줄만 얹으면 된다.
    #   ★단 **무거운 것은 빼고** 준다 (`_light` 와 같은 규칙): 화면은 목록에서 `env` 를 읽지 않고,
    #     필요할 때 `/env` 로 한 장씩 가져간다.
    return {"ok": True, "file": rel, "from": body.file, "size": [w * 4, h * 4],
            "workspace": body.workspace,
            "record": {k: v for k, v in new_rec.items() if k not in HEAVY_REC}}


class SavePreviewBody(BaseModel):
    """미저장 그림(자동 저장 끔)을 **파일로 남긴다** — v2 `/api/save-preview` 이식.

    ★바이트는 화면이 들고 있다가 되돌려 준다 (v2 도 같다). 서버가 붙들고 있으면 안 누른
      미리보기의 몇 MB 가 계속 쌓인다 — 그리고 그것은 재시작으로 조용히 사라진다."""

    workspace: str
    #: 이미 **최종 포맷으로 인코딩된** 바이트다 (`_generate_one` 이 변환까지 마치고 넘겼다)
    b64: str
    fmt: str = "png"
    scene_group: str = ""
    scene_group_id: str | None = None
    cell: str | None = None
    cell_id: str | None = None
    cell_no: int | None = None
    tab: str | None = None
    exclude_slot_number: bool = False
    enhance_of: str | None = None
    seed: int = 0
    #: ★뽑을 때의 화면 구조 — 생성 응답으로 나갔던 것이 그대로 돌아온다 (`_generate_one` 의 ★주).
    #:  저장 시점의 화면에서 새로 짜면 그 사이 프롬프트를 고쳤을 때 다른 그림의 구조가 붙는다.
    env: dict | None = None


@app.post("/api/save-preview")
async def save_preview(body: SavePreviewBody):
    """미저장 그림 한 장을 자리에 앉힌다.

    ★★**이름은 보통 생성과 같은 규칙**이다 (`store.store_output` 하나를 쓴다). 따로 지으면
      같은 폴더 안에서 번호열이 어긋난다.
    ★**다시 인코딩하지 않는다.** 넘어온 바이트는 생성 때 `save_format`·품질까지 적용해
      만든 것이라(`_generate_one`), 여기서 또 만지면 화질이 한 번 더 깎인다.
      (v2 는 원본을 들고 있다가 저장 때 변환했다 — 우리는 그 단계가 이미 끝나 있다.)
    ★`resolved`(그때 나간 페이로드)는 **안 싣는다.** 화면까지 왕복시키기에는 크고
      (바이브·베이스 그림의 base64 가 들어 있다), 재현에 필요한 것은 PNG 안의 NAI
      메타데이터가 이미 들고 있다."""
    try:
        data = base64.b64decode(body.b64)
    except Exception:
        raise HTTPException(400, "미리보기 데이터를 읽지 못했습니다")
    if not data:
        raise HTTPException(400, "미리보기 데이터가 비어 있습니다")

    # ★같은 규칙이다 — 내는 형식은 PNG·WebP 둘뿐 (`GenBody.save_format` 의 ★주)
    fmt = body.fmt.lower()
    if fmt not in ("png", "webp"):
        fmt = "png"

    rel = store.store_output(body.workspace, body.scene_group, body.cell, body.cell_no, body.tab,
                             body.exclude_slot_number, fmt, data)
    rec = {
        "ts": datetime.now().isoformat(timespec="seconds"),
        "file": rel,
        "scene_group": body.scene_group,
        "cell": body.cell,
        "scene_group_id": body.scene_group_id,
        "cell_id": body.cell_id,
        "enhance_of": body.enhance_of,
        "seed": body.seed,
        # ★뽑을 때의 화면 구조 (위 `env` 의 ★주) — 이것이 있어야 「설정 불러오기」가 카드를 되살린다
        "env": body.env,
    }
    store.append_record(body.workspace, rec)
    # ★레코드를 통째로 돌려준다 — 화면이 목록을 다시 읽지 않고 한 줄만 얹으면 된다 (업스케일과 같다).
    #   ★무거운 것은 빼고 준다 (업스케일과 같은 규칙) — 목록은 `env` 를 읽지 않는다.
    return {"ok": True, "file": rel, "record": {k: v for k, v in rec.items() if k not in HEAVY_REC}}


# ── 큐 + WebSocket ────────────────────────────────────────────────
# ★v2 backend.py:2296-2430, 4592-4681 이식. 동시성 1 고정 (genqueue.py 주석 참조).
Q = genqueue.GenerationQueue()
# ★바깥(클로드 코드 CLI 등)이 앱을 만지는 통로. 도구는 화면에 있다 (agent.py).
#   큐의 클라이언트 표를 그대로 쓰므로 **Q 가 만들어진 뒤**에 세운다
# ★도구는 **파일을 만진다** — 화면이 꺼져 있어도 목록이 나오고 실행된다 (agent.py 머리 주석).
#   데이터가 바뀌면 화면에 알리기만 한다 (화면은 다시 읽는다).
def _notify(what: str) -> None:
    asyncio.create_task(Q.broadcast({"type": "data_changed", "what": what}))


app_cmd = App(Q.clients)
# ★★이 이름이 위의 `import tools` 를 **가린다.** 그래서 모듈 쪽은 `tools_mod` 로 부른다.
#   섞이면 `AttributeError` 로 **요청 때** 터진다 — 임포트 시점에는 조용하다.
#   실측 2026-08-18: 이름 변환·EXIF·검열 드롭 썸네일·떨군 파일 읽기 넷이 **첫 커밋부터** 500 이었다.
#   모듈 함수를 직접 부르는 테스트는 이걸 못 잡는다 (`test_tools.py`). HTTP 로 뚫는 판정이 필요하다.
# ★조수의 변경 이력 — 사람의 `Ctrl+Z` 와 **따로** 굴러간다 (`agentlog.py` 머리 주석)
AGENT_LOG = agentlog.AgentLog(DATA_DIR)
tools = Tools(cards, store, files, WS_ROOT, meta, _notify, app_cmd, GUIDE, AGENT_LOG)


class QueueBody(BaseModel):
    """여러 장을 큐에 넣는다. `items` 가 비면 `base` 하나를 `count` 번 만든다."""

    base: GenBody
    #: 셀마다 다른 프롬프트를 줄 때 (세트 탭 전체 생성)
    items: list[dict] = []
    #: 항목당 반복 횟수
    count: int = 1


async def _process_job(job: dict) -> None:
    qb: QueueBody = job["request"]
    job_id = job["id"]
    await Q.broadcast({"type": "job_start", "job_id": job_id, "count": job["count"],
                       "progress": Q.progress()})

    units = qb.items or [{}]
    # ★**한 바퀴씩 돈다** (사용자 지시 2026-08-11): 씬이 여럿이면 위에서부터 한 장씩 만들고,
    #   다 돌면 다시 첫 씬으로 가서 두 번째 장을 만든다. 예전에는 한 씬을 다 만들고 다음으로
    #   넘어가서, 여러 장을 걸어 두면 **마지막 씬은 한참 뒤에야 첫 장이 나왔다.**
    #   한 바퀴가 끝날 때마다 전체를 견줄 수 있어야 중간에 멈추고 고칠지 판단이 선다.
    for _ in range(max(1, qb.count)):
        for unit in units:
            if Q.cancel_current:
                # ★취소는 **다음 장부터** 먹는다 — 이미 NAI 에 돈을 낸 장은 버리지 않는다
                left = Q.total_images - Q.completed_images
                Q.total_images = Q.completed_images
                await Q.broadcast({"type": "job_cancelled", "job_id": job_id,
                                   "cancelled_images": left, "progress": Q.progress()})
                return
            # ★단위(셀)마다 다른 값만 base 위에 덮는다 — 나머지 설정은 공유한다
            one = qb.base.model_copy(update={k: v for k, v in unit.items() if v is not None})
            # ★★**지금 만드는 씬을 알린다** (사용자 실측 2026-08-25). 화면이 자기 대기 목록의
            #   맨 앞을 「생성 중」으로 찍고 있었는데, 배치가 겹치면 그 순서가 실제와 어긋나
            #   **엉뚱한 칸에 「생성 중」이 뜨고 그림은 「대기 중」 칸에 나타났다.**
            Q.current_cell = {"scene_group_id": one.scene_group_id, "cell_id": one.cell_id}
            await Q.broadcast({"type": "job_progress", "job_id": job_id, "progress": Q.progress()})
            try:
                r = await _generate_one(one)
            except Exception as e:
                print(f"[queue] 생성 실패 (job {job_id}, cell={one.cell}): {e}")
                # ★★실패도 **한 장으로 센다** (v2 `backend.py:3178` 의 "에러도 완료로 카운트").
                #   안 세면 `completed < total` 이 영원히 유지돼 큐 줄과 「생성 중」이
                #   안 사라진다 (감사 2026-08-16).
                Q.completed_images += 1
                await Q.broadcast({"type": "image_error", "job_id": job_id, "error": str(e),
                                   "cell": one.cell, "progress": Q.progress()})
                continue
            Q.completed_images += 1
            # ★★자동 저장을 껐으면 **파일이 없다**. 그때는 기록으로 남기는 `image` 가 아니라
            #   미리보기로 보낸다 — 안 가리면 화면이 `file: null` 로 레코드를 만들어
            #   씬 칸에 깨진 칸이 생긴다 (감사 2026-08-16). 되돌려 볼 버퍼에도 안 쌓는다
            #   (몇 MB 짜리 base64 라 500장 버퍼를 금세 채운다).
            if not r.get("file"):
                await Q.broadcast({"type": "image_preview", "job_id": job_id, **r,
                                   "progress": Q.progress()})
                continue
            msg = {"type": "image", "job_id": job_id, **r}
            # ★★**썸네일을 미리 구워 둔다** (사용자 지적 2026-08-26: *"생성 완료 알림이 오고
            #   1초 정도 지나야 이미지가 뜸"*). 화면이 쓰는 것은 원본이 아니라 파생 썸네일인데
            #   (`/api/thumb`), 그것이 **첫 요청 때** 구워졌다 — 열고·디코드하고·LANCZOS 로
            #   줄이고·webp 로 다시 쓰는 값을 **알림을 본 뒤에** 치르는 셈이었다.
            #   ★알림보다 **먼저** 굽는다: 「완료」가 곧 「띄울 수 있다」가 된다.
            #   ★굽다 실패해도 그냥 넘어간다 — 요청 때 다시 구우면 되고(예전 경로 그대로),
            #     여기서 막으면 그림 자체를 못 받는다.
            try:
                await asyncio.to_thread(store.thumb_path, r.get("workspace", ""), r["file"])
            except Exception as e:
                print(f"[queue] 썸네일 미리 굽기 실패 (무시): {e}")
            # ★seq 를 먼저 부여하고(사본 저장), 그 뒤에 progress 를 덧붙인다.
            #   순서를 바꾸면 복원분에 그때그때의 진행률이 섞여 들어간다.
            Q.add_completed_image(msg)
            msg["progress"] = Q.progress()
            await Q.broadcast(msg)

    await Q.broadcast({"type": "job_done", "job_id": job_id, "progress": Q.progress()})
    # ★★큐가 비면 진행률 회계를 0 으로 되돌린다 (v2 `backend.py:3209-3211` 이식).
    #   안 되돌리면 completed/total 이 앱을 켠 뒤로 계속 쌓여서, 다음 배치가 "0/2" 가 아니라
    #   "8/10" 으로 보이고 진행바가 처음부터 80% 에서 시작한다.
    #   ★알림을 보낸 **뒤에** 되돌린다 — 순서를 바꾸면 끝난 배치의 장 수가 0 으로 나간다.
    #   ★`recent_images`·`image_sequence` 는 그대로 둔다 (새로고침 복원의 근거다).
    if not Q.queue:
        Q.completed_images = 0
        Q.total_images = 0


@app.on_event("startup")
async def _start_queue():
    app.state.queue_task = asyncio.create_task(genqueue.run_loop(Q, _process_job))


@app.on_event("shutdown")
async def _stop_queue():
    t = getattr(app.state, "queue_task", None)
    if t:
        t.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await t


@app.post("/api/generate/queue")
async def generate_queue(body: QueueBody):
    n = max(1, len(body.items or [{}])) * max(1, body.count)
    job_id = Q.add_job(body, n)
    await Q.broadcast({"type": "queued", "job_id": job_id, "count": n, "progress": Q.progress()})
    return {"ok": True, "job_id": job_id, "count": n}


@app.post("/api/cancel-queue")
async def cancel_queue():
    """★**취소 창구는 이것 하나다** (사용자 결정 2026-08-18).

    지금 NAI 로 나간 한 장은 그대로 두고(원자적 API 라 못 끊는다) **나머지를 전부** 뺀다.
    예전에는 창구가 둘이었는데(`cancel-current`·`clear-queue`) 어느 쪽도 혼자서는
    배치를 못 멈췄다 — v3 는 배치 전체가 잡 하나라, 잡이 시작되면 대기 큐가 비어 있어
    「큐 비우기」가 지울 것이 없었다 (감사 D5).
    """
    jobs, images, running = Q.cancel_all()
    Q.total_images = max(Q.completed_images, Q.total_images - images)
    await Q.broadcast({"type": "queue_cancelled", "cleared_jobs": jobs,
                       "cleared_images": images,
                       # ★아직 올 것이 몇 장인가 — 화면은 이 수만큼만 대기 칸을 남긴다.
                       #   돌고 있으면 in-flight 한 장, 아니면 하나도 없다
                       "remaining": 1 if running else 0,
                       "progress": Q.progress()})
    return {"ok": True, "cleared_jobs": jobs, "cleared_images": images, "running": running}


@app.get("/api/vibe-cache")
async def vibe_cache_list():
    """구워 둔 vibe 목록 (뷰어용). ★vibe 데이터 자체는 안 내보낸다 — 크고 화면에 쓸 일이 없다."""
    return {"items": vibes.entries()}


@app.post("/api/vibe-cache/restore")
async def vibe_cache_restore(body: RestoreBody):
    """지운 캐시를 되살린다 — ★캐시 키까지 되돌려야 다음 생성이 다시 굽지 않는다 (유료)."""
    return vibes.restore(body.entries, body.keys)


@app.post("/api/vibe-cache/check")
async def vibe_cache_check(body: VibeCheckBody):
    """이 그림들이 **이미 구워져 있나** (v2 backend.py:4653-4685 의 판정 그대로).

    ★화면의 「구워 둠」 배지와 비용(인코딩 개당 2 Anlas)이 여기에 걸려 있다. v2 는 비용
      창구가 이 판정을 겸했는데, 3.0 은 비용을 화면이 계산하므로(의도된 차이) **캐시 여부만**
      돌려준다.
    ★**판정을 화면에 옮겨 적지 말 것.** 키 산식(`cache_key`)도 재사용 판정(`reuse_ok`)도
      여기 하나뿐이다 — 두 벌이 되면 화면은 공짜라고 하는데 실제로는 돈이 나간다.
      그래서 화면은 **인코딩을 들고 있는지 여부와 그 모델·info 만** 보내고(`has_encoded`),
      큰 인코딩 자체는 올리지 않는다.

    돌려주는 것: `keep` 이면 화면이 든 인코딩을 그대로 쓴다. 아니면 `encoded` 가 디스크
    캐시에서 찾은 것이고(없으면 null), 그때 화면은 자기 것을 버린다."""
    out: list[dict] = []
    v4 = "diffusion-4" in body.model
    for it in body.items or []:
        img = str(it.get("image") or "")
        info = float(it.get("info_extracted", 1.0) or 1.0)
        probe: dict = {
            "encoded": "y" if it.get("has_encoded") else "",
            "encoded_model": it.get("encoded_model") or "",
        }
        if it.get("encoded_info_extracted") is not None:
            probe["encoded_info_extracted"] = float(it["encoded_info_extracted"])
        if vibe_mod.reuse_ok(probe, body.model, info):
            out.append({"keep": True, "encoded": None})
            continue
        enc = None
        if v4 and img:
            try:
                key = vibe_mod.cache_key(imgutil.ensure_png_base64(img), body.model, info)
                enc = vibes.get(key)
            except Exception:
                enc = None
        out.append({
            "keep": False,
            "encoded": enc,
            "encoded_model": body.model if enc else None,
            "encoded_info_extracted": info if enc else None,
        })
    return {"items": out}


@app.get("/api/vibe-cache/{name}/data")
async def vibe_cache_detail(name: str):
    """캐시 한 항목을 **그림과 인코딩까지** (v2 `/api/vibe-cache/{filename}`).

    ★그림이 없으면 꺼내 쓸 수 없다 — 생성 때 재인코딩이 빈 그림을 열다 500 으로 죽는다."""
    d = vibes.detail(name)
    if d is None:
        raise HTTPException(404, "없는 캐시 항목")
    return d


@app.delete("/api/vibe-cache/{name}")
async def vibe_cache_delete(name: str):
    """캐시 한 장을 **휴지통으로** (v2 backend.py:4321-, D7).

    ★여기는 Anlas 가 든 자리라 되돌리기가 가장 중요하다 — 캐시 키까지 함께 돌려준다."""
    r = vibes.delete(name)
    if not r:
        raise HTTPException(404, "없는 캐시 항목")
    return r


@app.get("/api/vibe-cache/{name}")
async def vibe_cache_thumb(name: str):
    """캐시 PNG 한 장 (썸네일). 경로 탈출을 막는다."""
    f = vibes.path_of(name)
    if f is None:
        raise HTTPException(404, "없는 캐시 항목")
    return FileResponse(f, media_type="image/png")


@app.get("/api/queue")
async def queue_status():
    return Q.get_status()


@app.websocket("/ws")
async def ws_endpoint(websocket: WebSocket, clientId: str | None = None):
    client_id = clientId or str(uuid.uuid4())[:8]
    await websocket.accept()

    # 같은 id 로 다시 붙으면 옛 소켓을 닫고 자리를 넘겨받는다
    old = Q.clients.get(client_id)
    if old:
        with contextlib.suppress(Exception):
            await old.close()
    Q.clients[client_id] = websocket

    await websocket.send_json({"type": "connected", "client_id": client_id, "status": Q.get_status()})
    try:
        while True:
            data = await websocket.receive_json()
            if data.get("type") == "sync":
                last = int(data.get("last_seq", 0) or 0)
                await websocket.send_json({
                    "type": "sync",
                    "images": Q.get_images_since(last),
                    # ★끊긴 사이 흘러간 CLI 줄도 돌려준다. **자기 턴 것만** 온다
                    "cli": Q.get_cli_since(str(data.get("cli_run") or ""),
                                           int(data.get("cli_seq", 0) or 0)),
                    "status": Q.get_status(),
                })
            elif data.get("type") == "ping":
                await websocket.send_json({"type": "pong"})
            # 앱이 시킨 일을 마치고 돌려준 결과 (생성 큐 등)
            elif data.get("type") == "done":
                app_cmd.resolve(data.get("id", ""), data.get("result"))

    except WebSocketDisconnect:
        pass
    except Exception:
        pass
    finally:
        # ★자기 소켓일 때만 해제 (genqueue._unregister 주석 참조)
        Q._unregister(client_id, websocket)


@app.get("/api/file/{ws}/{rel:path}")
async def get_file(ws: str, rel: str):
    p = store.file_path(ws, rel)
    if not p:
        raise HTTPException(404, "not found")
    return FileResponse(p, media_type="image/png")


# ── 워크스페이스 그림의 메타데이터 ────────────────────────────
# ★훑고 옮기고 지우는 창구는 여기 없다 — 보관함은 `/api/keep/*`, 아웃풋 트리는
#   `/api/files/*` 다. 옛 `/api/gallery/{ws}/folders|images|move|delete` 는 갤러리가
#   보관함으로 옮겨 가며 남은 자국이라 걷어냈다 (`docs/v2-port-audit.md` F절).


def _sent_from_record(ws: str, file: str) -> dict:
    """그 그림을 뽑을 때 **실제로 보낸 값** — `records.jsonl` 의 `resolved` 에서 찾는다.

    ★★NAI 는 `ucPreset`·`qualityToggle` 을 **null 로 비워** 돌려준다. 그래서 프리셋이
      무엇이었는지는 그림만 봐서는 알 수 없고, 지금까지는 네거티브 앞에서 본문을 떼어내
      **짐작**했다 — 사용자 UC 가 마침 Heavy 본문으로 시작하면 안 쓴 프리셋이 Heavy 로 읽혔고,
      본문을 손대 놓았으면 언제나 None 이 됐다 (사용자 지적 2026-08-21).
    ★우리 워크스페이스 그림은 보낸 페이로드를 통째로 기록해 두므로 짐작할 이유가 없다.
      밖에서 가져온 그림에는 기록이 없어 예전처럼 짐작한다."""
    # ★무거운 것은 곁파일에 있다 (`workspace.ENV_NAME` 머리 주석)
    res = store.heavy_of(ws, file).get("resolved") or {}
    par = res.get("parameters") or {}
    out: dict = {}
    m = res.get("model")
    if isinstance(m, str):
        out["model"] = nai.base_model(m)
        # ★프리셋 **이름**은 모델마다 다른 목록에서 나온다 — 그 그림의 모델로 푼다
        pid = par.get("ucPresetId")
        if isinstance(pid, str):
            out["uc_preset"] = nai.uc_preset_name(out["model"], pid)
    q = par.get("qualityPresetId")
    if isinstance(q, str):
        out["quality_preset"] = q
    if "tag_hint_transparent_background" in par:
        out["transparent_bg"] = bool(par.get("tag_hint_transparent_background"))
    return out


def _model_from_record(ws: str, file: str) -> str:
    """그 그림을 뽑을 때 쓴 **모델 id** — `records.jsonl` 의 `resolved.model` 에서 찾는다.

    ★★**NAI 는 모델 id 를 그림에 안 남긴다.** 응답 PNG 의 Comment 에는
      `request_type:"PromptGenerateRequest"` 와 (V5 부터) `model_name:"NovelAI Diffusion V5"`
      만 있고 `model` 키가 없다 — `model_name` 도 Full/Curated 를 못 가른다.
      그래서 「설정 불러오기」가 모델만 못 되살리고 있었다 (2026-08-21 사용자 지적).
    ★우리는 보낸 페이로드를 통째로 기록해 두므로 **우리 워크스페이스 그림은** 되살릴 수 있다.
      밖에서 가져온 그림은 기록이 없어 여전히 빈 값이다 — 그때는 화면 값이 유지된다.
    ★인페인트 결과는 `model` 이 인페인팅 id 라 원본으로 되돌려 준다 (`nai.base_model`)."""
    # ★무거운 것은 곁파일에 있다 (`workspace.ENV_NAME` 머리 주석)
    m = (store.heavy_of(ws, file).get("resolved") or {}).get("model")
    return nai.base_model(m) if isinstance(m, str) else ""


@app.get("/api/gallery/{ws}/meta")
async def gallery_meta(ws: str, file: str):
    """고른 **한 장**의 메타데이터. 목록에서는 안 읽는다 (수백 장이면 그것만으로 몇 초다)."""
    p = store.file_path(ws, file)
    if not p:
        raise HTTPException(404, "not found")

    def read():
        # ★★프리셋은 **기록이 정본**이다 (그림에는 null 로 비워져 온다, `_sent_from_record`).
        sent = _sent_from_record(ws, file)
        m = meta.read(p, sent)
        # ★그림에 모델 id 가 없을 때만 기록에서 채운다 — 그림이 언제나 정본이다
        if m is not None and not m.get("nai_model") and sent.get("model"):
            m["nai_model"] = sent["model"]
        return m

    # ★곁파일 읽기(실측 112MB)와 그림 메타 읽기가 함께 있다 — 루프에서 하면 서버가 선다
    #   (위 「이벤트 루프에서 하면 안 되는 일」 ★★주)
    return {"file": file, "meta": await asyncio.to_thread(read)}


KEEP_DIR = APP_DIR / "gallery"
KEEP_DIR.mkdir(parents=True, exist_ok=True)
# ★보관함의 휴지통도 **켤 때** 비운다 (위 부팅 절과 같은 규칙, D7)
for _batch in trash.sweep_at(KEEP_DIR):
    print(f"[휴지통 비움] gallery/{_batch}")


class KeepSave(BaseModel):
    workspace: str
    file: str
    folder: str = ""
    meta: dict | None = None


class KeepFiles(BaseModel):
    files: list[str] = []
    dest: str = ""


class KeepName(BaseModel):
    """폴더 만들기·지우기·탐색기로 열기 — 이름 하나만 받는다."""

    name: str = ""


class KeepRename(BaseModel):
    file: str
    name: str


class KeepPath(BaseModel):
    """탐색기로 열 자리. ★키 이름을 `/api/files/reveal` 과 **맞춰 둔다** — 화면의
    같은 버튼(`ImageActions`)이 뿌리만 바꿔 두 창구를 그대로 쓴다."""

    path: str = ""


class KeepStar(BaseModel):
    file: str
    on: bool


# ★워크스페이스에 매여 있던 옛 별표를 보관함으로 데려온다 (2026-08-18).
#   갤러리는 워크스페이스를 넘는 화면인데 별표만 `spec.selection.starred` 에 쌓여서,
#   작업을 바꾸면 같은 그림의 별표가 달라졌다. 켤 때 한 번 옮기고 원래 자리에서 뺀다 —
#   **날리지 않는다.** 보관함에 실제로 있는 경로만 옮기므로 워크스페이스 그림의 별표는
#   그대로 남는다 (이름 공간이 다르다).
def _adopt_keep_stars() -> None:
    for _info in store.list():
        _ws = _info["name"]
        _spec = store.load(_ws)
        if not _spec:
            continue
        _mine = (_spec.get("selection") or {}).get("starred") or []
        if not _mine:
            continue
        _took = keep.adopt_stars(KEEP_DIR, _mine)
        if not _took:
            continue
        _spec["selection"]["starred"] = [f for f in _mine if f not in set(_took)]
        store.save(_ws, _spec)
        print(f"[갤러리 별표] {_ws} 에 있던 {len(_took)}개를 보관함으로 옮김")


try:
    _adopt_keep_stars()
except Exception as _e:  # 이전이 실패해도 앱은 떠야 한다
    print(f"[갤러리 별표] 옮기지 못했습니다 (무시하고 계속): {_e!r}")


@app.get("/api/keep/folders")
async def keep_folders():
    return {"folders": keep.folders(KEEP_DIR)}


@app.post("/api/keep/folder")
async def keep_make_folder(body: KeepName):
    try:
        return keep.make_folder(KEEP_DIR, body.name)
    except (ValueError, OSError) as e:
        raise HTTPException(400, str(e))


@app.post("/api/keep/folder/delete")
async def keep_drop_folder(body: KeepName):
    """★빈 폴더만 지운다 (keep.drop_folder 주석)."""
    try:
        return keep.drop_folder(KEEP_DIR, body.name)
    except (ValueError, OSError) as e:
        raise HTTPException(400, str(e))


@app.post("/api/keep/reveal")
async def keep_reveal(body: KeepPath):
    """탐색기에서 연다 — ★파일이면 고른 채로 (files.reveal 을 보관함 뿌리로 쓴다)."""
    try:
        # ★스레드에서 — 블로킹 호출이라 그대로 부르면 이벤트 루프가 멈춘다 (`files_reveal` 주석)
        await asyncio.to_thread(files.reveal, KEEP_DIR, body.path)
        return {"ok": True}
    except (ValueError, OSError) as e:
        raise HTTPException(400, str(e))


@app.get("/api/keep/stars")
async def keep_stars():
    return {"starred": keep.stars(KEEP_DIR)}


@app.post("/api/keep/star")
async def keep_star(body: KeepStar):
    return {"starred": keep.set_star(KEEP_DIR, body.file, body.on)}


# ★한 쪽에 몇 장인가 — v2 는 50 이었다. 60 은 3열·4열 어느 쪽에도 딱 떨어진다
PAGE = 60


@app.get("/api/keep/images")
async def keep_images(folder: str = "", page: int = 1, limit: int = PAGE):
    try:
        return keep.images(KEEP_DIR, folder, page, limit)
    except ValueError as e:
        raise HTTPException(400, str(e))


@app.post("/api/keep/save")
async def keep_save(body: KeepSave):
    """작업 폴더의 그림을 보관함으로 **복사**한다 (원본은 그대로).

    ★이미 보관돼 있으면 **무른다** (`removed: true`). 같은 그림에 보관을 두 번 누르면
      사본이 둘 생기던 것을 고친 것이다 (keep.save 주석).
    ★★`toggle: false` 면 무르지 않는다 — **끌어다 놓기**가 쓴다 (놓았는데 사라지면 안 된다)."""
    src = store.file_path(body.workspace, body.file)
    if not src:
        raise HTTPException(404, "그림을 찾지 못했습니다")
    try:
        return keep.save(
            KEEP_DIR, src, body.folder, body.meta, f"{body.workspace}/{body.file}"
        )
    except ValueError as e:
        raise HTTPException(400, str(e))


class KeepImport(BaseModel):
    """밖에서 떨군 그림을 보관함에 들인다 (사용자 지시 2026-08-25).

    ★`data` 는 **base64 원본 바이트**다 — 화면이 읽은 그대로다. 다시 인코딩하지 않는
      까닭은 PNG 에 박힌 NAI 메타데이터를 살리기 위해서다 (`keep.import_bytes` 주석)."""
    data: str
    name: str = "image.png"
    folder: str = ""


@app.post("/api/keep/import")
async def keep_import(body: KeepImport):
    import base64

    try:
        raw = base64.b64decode(body.data, validate=True)
    except Exception:
        raise HTTPException(400, "그림 데이터를 읽지 못했습니다.")
    if not raw:
        raise HTTPException(400, "그림 데이터가 비어 있습니다.")
    return keep.import_bytes(KEEP_DIR, raw, body.name, body.folder)


@app.post("/api/keep/rename")
async def keep_rename(body: KeepRename):
    try:
        return keep.rename(KEEP_DIR, body.file, body.name)
    except (ValueError, OSError) as e:
        raise HTTPException(400, str(e))


@app.post("/api/keep/delete")
async def keep_delete(body: KeepFiles):
    """★보관함의 삭제도 휴지통을 거친다 (D7) — 별표·출처까지 되돌릴 수 있게 함께 돌려준다."""
    return keep.delete(KEEP_DIR, body.files)


@app.post("/api/keep/restore")
async def keep_restore(body: RestoreBody):
    return keep.restore(KEEP_DIR, body.entries, body.starred, body.sources)


@app.post("/api/keep/move")
async def keep_move(body: KeepFiles):
    return keep.move(KEEP_DIR, body.files, body.dest)


@app.get("/api/keep/thumb/{rel:path}")
def keep_thumb(rel: str):
    """보관함 격자용 **썸네일** (긴 변 512 WebP).

    ★격자에 원본 PNG 를 걸면 수백 장이 뜨는 화면이 그것만으로 무너진다 — 파일 관리·
      캔버스가 이미 쓰던 층을 갤러리도 쓴다 (`docs/v2-port-audit.md` A3, v2 는 512 JPEG
      를 구워 캐시했다: `backend.py:3926-3960`).
    ★캐시는 보관함 안 `.thumbs/` 에 둔다. 점으로 시작하는 것은 목록에서 통째로 빠지므로
      (`keep._visible`) 캐시 webp 가 보관한 그림인 척 뜨지 않는다.
    ★`def` 로 둔다 (`async def` 아님) — LANCZOS 축소는 CPU 일이라 async 안에서 하면
      그동안 서버 전체가 멈춘다. FastAPI 는 `def` 를 스레드풀로 돌린다."""
    try:
        p = keep.safe_folder(KEEP_DIR, rel)
    except ValueError as e:
        raise HTTPException(400, str(e))
    if not p.is_file():
        raise HTTPException(404, "not found")
    # ★여기는 `immutable` 을 안 붙인다 — 보관함은 이름을 바꿀 수 있어서 같은 주소가
    #   다른 그림을 가리킬 수 있다 (생성물은 매번 새 파일명이라 붙여도 됐다).
    t = thumbs.derive(p, KEEP_DIR / keep.THUMB_DIR / thumbs.flat_name(rel))
    return FileResponse(t or p)


@app.get("/api/keep/file/{rel:path}")
async def keep_file(rel: str):
    from fastapi.responses import FileResponse

    p = keep.safe_folder(KEEP_DIR, rel)
    if not p.is_file():
        raise HTTPException(404, "not found")
    return FileResponse(p)


@app.get("/api/keep/meta")
async def keep_meta(file: str):
    p = keep.safe_folder(KEEP_DIR, file)
    if not p.is_file():
        raise HTTPException(404, "not found")
    return {"meta": meta.read(p) or {}}


@app.get("/api/keep/origin")
async def keep_origin(file: str):
    """이 보관 그림이 **어디서 왔나** — 갤러리의 「새 탭으로 복제」가 그때 구조를 찾는 실마리
    (`keep.origin_of` 주석). 모르면 `null`."""
    return {"origin": keep.origin_of(KEEP_DIR, file)}


# ── 보조 도구 ─────────────────────────────────────────────────
# ★셋은 **보는 대상이 다르다**: 갤러리=골라 둔 것 · 파일 관리=아웃풋 폴더 그대로 ·
#   EXIF/변환=밖에서 온 것까지. 그래서 경로 기준도 다르다 (files.py 머리 주석).


class ToolItem(BaseModel):
    """손볼 그림 하나. 셋 중 하나로 온다 — 절대 경로·아웃풋 상대 경로·base64."""

    name: str = ""
    path: str | None = None
    rel: str | None = None
    data: str | None = None
    #: ★`/api/tools/meta` 에서만 뜻이 있다 — 켜면 **원본 바이트**(base64)와 바이브 인코딩까지
    #  함께 준다. 드롭 가져오기가 켠다 (`tools.read_meta` 의 ★주). EXIF 리더는 안 켠다.
    full: bool = False


class ToolConvert(BaseModel):
    items: list[ToolItem] = []
    fmt: str = "png"
    quality: int = 95
    strip_metadata: bool = False
    prefix: str | None = None
    start: int = 1
    pad: int = 3
    dest: str = ""
    open_folder: bool = False
    #: 저장 자리 — `overwrite` · `sub` · `folder` (`tools.MODES`)
    mode: str = "sub"


@app.post("/api/tools/convert")
async def tools_convert(body: ToolConvert):
    """변환·일괄 이름 바꾸기.

    ★★`mode` 가 `overwrite` 일 때만 원본이 자리를 내준다 — 그때도 **지우지 않고
      휴지통으로** 보낸다 (`tools.convert` 의 ★주). 나머지 둘은 새 파일만 만든다."""
    if not body.items:
        raise HTTPException(400, "그림이 없습니다")
    try:
        return tools_mod.convert(
            WS_ROOT,
            [i.model_dump() for i in body.items],
            body.fmt,
            body.quality,
            body.strip_metadata,
            body.prefix,
            body.start,
            body.pad,
            body.dest,
            body.open_folder,
            body.mode,
        )
    except ValueError as e:
        raise HTTPException(400, str(e))


class ToolProbe(BaseModel):
    items: list[ToolItem] = []


@app.post("/api/tools/probe")
async def tools_probe(body: ToolProbe):
    """변환 목록의 썸네일·크기 — ★**서버가 줄여서 준다.** 앱에는 경로만 오므로
    화면이 그 파일을 가리킬 주소가 없다 (`tools.probe` 주석)."""
    return tools_mod.probe(WS_ROOT, [i.model_dump() for i in body.items])


class PickDir(BaseModel):
    """폴더 찾기 창을 띄울 때 **맨 앞에 세울 자리** (첫 그림이 있는 폴더)"""

    start: str = ""


@app.post("/api/files/pick-dir")
def files_pick_dir(body: PickDir):
    """윈도우 **폴더 찾기** 창 (`files.pick_dir` 의 ★주).

    ★`def` 다 (async 아님) — 창이 닫힐 때까지 기다리는 호출이라 스레드풀에서 돌아야
      그동안 서버가 다른 요청을 받는다.
    ★취소하면 `dir: null` — 그때는 부르는 쪽이 아무것도 안 바꾼다."""
    return {"dir": files.pick_dir(body.start)}


@app.post("/api/tools/read")
async def tools_read(body: ToolItem):
    """앱 창에 떨군 파일 하나를 통째로 (`tools.read_dropped` 주석).
    ★저장하지 않는다. 읽어서 돌려주고 끝이다."""
    try:
        return tools_mod.read_dropped(WS_ROOT, body.model_dump())
    except (ValueError, OSError) as e:
        raise HTTPException(400, str(e)) from e


@app.post("/api/tools/meta")
async def tools_meta(body: ToolItem):
    """★**밖에서 가져온 그림**도 읽는다. 저장하지 않는다 — 읽고 버린다."""
    try:
        return {"meta": tools_mod.read_meta(WS_ROOT, body.model_dump())}
    except (ValueError, OSError) as e:
        raise HTTPException(400, str(e))


@app.post("/api/tools/meta-upload")
async def tools_meta_upload(file: UploadFile = File(...)):
    """경로를 모르는 곳(브라우저)에서 떨군 그림 — 바이트를 그대로 받는다."""
    data = await file.read()
    return {"meta": meta.normalize(meta.read_raw(data)) or {}}


# ── 검열 ──────────────────────────────────────────────────────
# ★모델은 **앱에 들어 있다** (models/censor/*.onnx). 받아 오는 경로가 없다 — censor.py 머리 주석.


class CensorSource(BaseModel):
    """검열할 그림 하나. 도구와 같은 세 갈래로 받는다 (밖에서 떨군 것도 된다)."""

    workspace: str | None = None
    file: str | None = None     # 워크스페이스 안 상대 경로
    rel: str | None = None      # 아웃풋 루트 기준
    path: str | None = None     # 절대 경로 (창에 떨군 파일)
    data: str | None = None     # base64


class CensorDetect(CensorSource):
    model: str | None = None
    targets: list[str] | None = None
    label_conf: dict[str, float] = {}
    default_conf: float = 0.25
    return_all: bool = False


class CensorApply(CensorSource):
    """가린 그림을 **화면이 구워서** 올린다.

    ★★가리는 일은 화면이 한다 (`src/lib/censorRender.ts`). 서버는 **받은 바이트를 적을
      뿐**이고, 어떻게 가릴지를 정하는 값(방식·부드럽게·모자이크…)은 여기 오지 않는다.
      까닭은 `backend/censor.py` 끝의 ★★주에 있다 — 렌더러를 두 벌 두지 않기 위해서다."""

    #: 화면이 원본 크기로 구운 PNG (data URL 이거나 맨 base64)
    image: str = ""
    suffix: str = "_censored"
    # ★결과를 둘 폴더 (아웃풋 루트 기준). 비면 원본 옆에 둔다. v2 의 `censored` 폴더 자리다
    dest: str | None = None
    # 밖에서 떨군 그림에는 원본 경로가 없다. 저장할 이름을 화면이 준다
    name: str | None = None


class CensorImage(CensorSource):
    """원본을 **그대로** 돌려준다 (밖에서 떨군 그림은 화면에 주소가 없다).

    ★가리지 않는다. 화면이 이것을 캔버스에 깔고 그 위에 직접 그린다."""

    max_side: int = 0


def _censor_open(b: CensorSource):
    """세 갈래 중 하나로 그림을 연다. 함께 **원본 자리**도 돌려준다 (저장할 곳을 알기 위해)."""
    if b.workspace and b.file:
        p = store.file_path(b.workspace, b.file)
        if not p:
            raise HTTPException(404, "그림을 찾지 못했습니다")
        return Image.open(p), p
    if b.rel:
        try:
            p = files.under(WS_ROOT, b.rel)
        except ValueError as e:
            raise HTTPException(400, str(e))
        if not p.is_file():
            raise HTTPException(404, "그림을 찾지 못했습니다")
        return Image.open(p), p
    if b.path:
        p = Path(b.path)
        if not p.is_file():
            raise HTTPException(404, "그림을 찾지 못했습니다")
        return Image.open(p), p
    if b.data:
        raw = b.data.split(",", 1)[-1]
        return Image.open(io.BytesIO(base64.b64decode(raw))), None
    raise HTTPException(400, "그림이 없습니다")


# ── 태거 (WD eva02) — 그림에서 재현 태그를 뽑는다 (사용자 승인 2026-08-29) ──
class TaggerRun(CensorSource):
    """★검열과 같은 세 갈래다 — 보조도구의 Tagger 탭은 **밖에서 떨군 그림**도 받는다
    (사용자 지시 2026-08-29: *"아무 이미지나 태거 돌리게"*)."""


@app.get("/api/tagger/status")
async def tagger_status():
    """모델이 있나 · 내려받는 중인가 (진행 바이트 포함)."""
    return tagger.status()


@app.post("/api/tagger/cancel")
async def tagger_cancel():
    """받던 것을 그만둔다 (사용자 지시 2026-08-29)."""
    return tagger.cancel_download()


@app.post("/api/tagger/download")
async def tagger_download():
    """모델 내려받기 시작 (백그라운드) — 진행은 status 를 폴링한다."""
    return tagger.start_download()


@app.post("/api/tagger/run")
def tagger_run(body: TaggerRun):
    """태그 뽑기. ★`def` 다 — ONNX 추론이 수 초를 쥔다 (censor 와 같은 규칙).

    `preview` 도 함께 준다 — 밖에서 떨군 그림은 화면에 가리킬 주소가 없다 (EXIF 리더와 같다)."""
    img, _ = _censor_open(body)
    try:
        out = tagger.run(img)
    except RuntimeError as e:
        raise HTTPException(409, str(e))
    out["preview"] = tools_mod.thumb_image(img, tools_mod.PREVIEW_MAX)
    return out


# ── 번역 (v2 번역 모드 이식, 사용자 지시 2026-08-29) — 화면이 못 나가니 여기서 대신 부른다 ──
class TranslateReq(BaseModel):
    text: str
    sl: str = "en"
    tl: str = "ko"


@app.post("/api/translate")
async def translate_text(body: TranslateReq):
    """태그 하나를 번역한다. ★실패는 502 로 말한다 — 원문을 돌려주면 「안 되는데 조용하다」가 된다."""
    try:
        return {"text": await translate_mod.translate(body.text, body.sl, body.tl)}
    except Exception as e:  # noqa: BLE001 — 바깥 서비스라 무엇이 올지 모른다
        raise HTTPException(502, f"번역 실패: {e}")


@app.get("/api/censor/models")
async def censor_models():
    return {"models": censor.models()}


@app.post("/api/censor/detect")
def censor_detect(body: CensorDetect):
    """가릴 곳 찾기. ★그림을 **고치지 않는다** — 좌표만 돌려준다.

    ★`def` 다 (async 아님). ONNX 추론은 장당 0.4초(XL 은 4초)를 CPU 로 쥔다. async 로 두면
      「전체 검열」이 도는 동안 서버 전체가 멈춘다."""
    im, _ = _censor_open(body)
    try:
        dets = censor.detect(
            im, body.model, body.targets, body.label_conf, body.default_conf, body.return_all
        )
    except FileNotFoundError as e:
        raise HTTPException(503, str(e))
    return {"detections": dets, "width": im.width, "height": im.height}


@app.post("/api/censor/image")
def censor_image(body: CensorImage):
    """원본 한 장을 화면에 넘긴다 (떨군 그림·워크스페이스 밖의 그림용).

    ★아웃풋 안의 그림은 이 길로 안 온다 — 화면이 `/api/file` 주소를 바로 가리킨다."""
    im, _ = _censor_open(body)
    w, h = im.width, im.height
    out = im
    if body.max_side and max(w, h) > body.max_side:
        r = body.max_side / max(w, h)
        out = im.resize((max(1, int(w * r)), max(1, int(h * r))), Image.LANCZOS)
    buf = io.BytesIO()
    out.convert("RGB").save(buf, format="WEBP", quality=92)
    return {
        "image": "data:image/webp;base64," + base64.b64encode(buf.getvalue()).decode(),
        "width": w,
        "height": h,
    }


@app.post("/api/censor/apply")
def censor_apply(body: CensorApply):
    """가린 그림을 **새 파일로** 저장한다 (원본은 그대로).

    ★덮어쓰기 경로를 만들지 말 것 — 생성물은 Anlas 가 든 원본이다.
    ★박스가 **0개여도 저장한다.** 일괄 저장에서 "찾은 게 없는 장"이 결과 폴더에서 빠지면
      그 폴더가 원본 묶음의 대역이 되지 못한다 (v2 `completeCensoring` 도 그대로 넘긴다).
    ★★**픽셀은 화면이 그려 보낸다.** 여기서 다시 그리지 않는다 (`CensorApply` 의 ★★주)."""
    _, src = _censor_open(body)
    raw_img = body.image.split(",", 1)[-1] if body.image else ""
    if not raw_img:
        raise HTTPException(400, "그린 그림이 없습니다")
    try:
        rendered = base64.b64decode(raw_img)
    except (binascii.Error, ValueError) as e:
        raise HTTPException(400, f"그림을 못 읽었습니다: {e}")

    # 어디에 둘까. 폴더를 골랐으면 거기, 아니면 원본 옆
    stem = Path(body.name).stem if body.name else (src.stem if src else "censored")
    folder = src.parent if src else WS_ROOT.resolve()
    if body.dest is not None:
        try:
            folder = files.under(WS_ROOT, body.dest)
        except ValueError as e:
            raise HTTPException(400, str(e))
        folder.mkdir(parents=True, exist_ok=True)
    if src is None and not body.name:
        # 갈 곳도 이름도 없다. 옛 계약대로 바이트로 돌려준다
        return {"image": "data:image/png;base64," + base64.b64encode(rendered).decode()}

    dst = folder / f"{stem}{body.suffix}.png"
    n = 2
    while dst.exists():
        dst = folder / f"{stem}{body.suffix}_{n}.png"
        n += 1
    # ★생성 설정을 데려간다 — 검열본에서도 재생성할 수 있어야 한다
    try:
        if src is None:
            raise ValueError("원본 파일이 없다")
        raw = meta.read_raw(src.read_bytes())
        dst.write_bytes(meta.write(rendered, raw, "PNG", 95, dict(Image.open(src).info)))
    except Exception:
        dst.write_bytes(rendered)
    root = WS_ROOT.resolve()
    rel = dst.relative_to(root) if str(dst).startswith(str(root)) else dst
    return {"file": str(rel).replace("\\", "/"), "name": dst.name}


# ── 파일 관리 (아웃풋 폴더 트리) ────────────────────────────────


class FilesMove(BaseModel):
    files: list[str] = []
    dest: str = ""


class FilesName(BaseModel):
    path: str = ""
    name: str = ""


# ── 태그 검색 인덱스 (backend/tagindex.py) — 아웃풋 루트의 긍정 프롬프트 원문 ──────
@app.get("/api/tags/status")
async def tags_status():
    return tagindex.status(WS_ROOT)


@app.post("/api/tags/index")
async def tags_index():
    """아웃풋 루트를 훑어 곁파일을 갱신한다 — 백그라운드. 진행은 `/api/tags/status`."""
    return tagindex.start(WS_ROOT)


@app.get("/api/tags/data")
async def tags_data():
    """곁파일 통째 — 태그 집계는 화면이 한다 (`tagindex` 머리 ★★주). 몇 MB 라 딴 실에서 읽는다."""
    return await asyncio.to_thread(tagindex.load, WS_ROOT)


@app.get("/api/files/tree")
async def files_tree():
    return files.tree(WS_ROOT)


@app.get("/api/files/list")
async def files_list(folder: str = "", page: int = 1, limit: int = PAGE):
    try:
        return files.listdir(WS_ROOT, folder, page, limit)
    except ValueError as e:
        raise HTTPException(400, str(e))


@app.post("/api/files/mkdir")
async def files_mkdir(body: FilesName):
    try:
        return files.mkdir(WS_ROOT, body.path, body.name)
    except (ValueError, OSError) as e:
        raise HTTPException(400, str(e))


@app.post("/api/files/rename")
async def files_rename(body: FilesName):
    try:
        return files.rename(WS_ROOT, body.path, body.name)
    except (ValueError, OSError) as e:
        raise HTTPException(400, str(e))


@app.post("/api/files/move")
async def files_move(body: FilesMove):
    try:
        return files.move(WS_ROOT, body.files, body.dest)
    except (ValueError, OSError) as e:
        raise HTTPException(400, str(e))


@app.post("/api/files/delete")
async def files_delete(body: FilesMove):
    """★파일도 **폴더도** 휴지통을 거친다 (D7). 예전에는 폴더면 `rmtree` 였다."""
    try:
        return files.delete(WS_ROOT, body.files)
    except (ValueError, OSError) as e:
        raise HTTPException(400, str(e))


@app.post("/api/files/restore")
async def files_restore(body: RestoreBody):
    try:
        return files.restore(WS_ROOT, body.entries)
    except (ValueError, OSError) as e:
        raise HTTPException(400, str(e))


@app.post("/api/log/reveal")
async def log_reveal():
    """로그 파일을 탐색기에서 **고른 채로** 연다 (사용자 지시 2026-08-27, 제보용).

    ★자리를 화면에 적어 주지 않고 여기서 연다 — 경로를 읽어 손으로 찾아 들어가게 하면
      제보가 거기서 끊긴다.
    ★스레드에서 돈다 (`files_reveal` 의 ★★주와 같은 까닭)."""
    try:
        d = APP_DIR / "logs"
        d.mkdir(parents=True, exist_ok=True)  # ★손으로 띄운 백엔드에는 아직 없을 수 있다
        await asyncio.to_thread(files.reveal, d, "peropix.log")
        return {"ok": True}
    except Exception as e:
        say("error", "api", f"로그 열기 실패: {type(e).__name__}: {e}")
        raise HTTPException(500, str(e))


@app.post("/api/files/reveal")
async def files_reveal(body: FilesName):
    """탐색기에서 연다 — ★파일이면 고른 채로.

    ★★**스레드에서 돈다** (사용자 지적 2026-08-19: 누르면 앱 전체가 느려졌다).
      탐색기를 띄우는 것은 블로킹 호출이라, `async` 안에서 그대로 부르면 그동안
      **이벤트 루프가 통째로 멈춘다** — 생성 스트림도 진행률도 같이 멈춘다."""
    try:
        await asyncio.to_thread(files.reveal, WS_ROOT, body.path)
        return {"ok": True}
    except (ValueError, OSError) as e:
        raise HTTPException(400, str(e))


@app.get("/api/files/img/{rel:path}")
async def files_img(rel: str):
    try:
        p = files.under(WS_ROOT, rel)
    except ValueError as e:
        raise HTTPException(400, str(e))
    if not p.is_file():
        raise HTTPException(404, "not found")
    return FileResponse(p)


@app.get("/api/files/thumb/{rel:path}")
def files_thumb(rel: str):
    """파일 관리용 썸네일. ★캐시는 **그 워크스페이스 안**에 둔다 (사용자 지시 2026-08-08) —
    `workspaces/` 최상위에는 워크스페이스만 있어야 한다. rel 의 첫 칸이 워크스페이스다."""
    try:
        p = files.under(WS_ROOT, rel)
    except ValueError as e:
        raise HTTPException(400, str(e))
    if not p.is_file():
        raise HTTPException(404, "not found")
    head = rel.replace("\\", "/").split("/", 1)[0]
    t = thumbs.derive(p, WS_ROOT / head / ".thumbs" / thumbs.flat_name(rel))
    return FileResponse(t or p)


def main():
    import uvicorn

    global CURRENT_PORT

    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8770)
    args = ap.parse_args()
    CURRENT_PORT = args.port
    # ★개발 중에는 **파이썬을 고치면 알아서 다시 뜬다** (사용자 지시 2026-08-08).
    #   예전엔 사이드카가 앱과 함께만 떠서, 백엔드를 고치면 앱을 통째로 재실행해야 했다.
    #   ★보는 곳은 `backend/` **하나뿐**이다 — 작업 폴더를 보게 두면 그림이 한 장 생길
    #     때마다 서버가 다시 뜬다.
    #   ★켜지는 것은 `PEROPIX_DEV_RELOAD` 가 있을 때뿐이다 (dev.bat · qa\host.cmd 가 넣는다).
    if os.environ.get("PEROPIX_DEV_RELOAD"):
        here = str(Path(__file__).resolve().parent)
        os.environ["PEROPIX_BACKEND_PORT"] = str(args.port)  # 워커가 읽는다
        print(f"[backend] dev reload on - watching {here}")
        uvicorn.run("server:app", host="127.0.0.1", port=args.port, log_level="info",
                    reload=True, reload_dirs=[here], app_dir=here)
    else:
        # ★★접근 로그는 끈다 — 주소 앞머리에 **이번 실행의 열쇠**가 들어 있어 매 요청마다
        #   로그에 남고(제보로 오가는 파일이다), 썸네일 요청까지 전부 찍혀 정작 봐야 할
        #   오류가 묻힌다. 의미 있는 일은 우리가 `say()` 로 적는다.
        uvicorn.run(app, host="127.0.0.1", port=args.port, log_level="info", access_log=False)


if __name__ == "__main__":
    main()
