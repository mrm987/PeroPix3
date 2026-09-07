"""플러그인 — `<앱 뿌리>/plugins/<id>/` 를 읽어 백엔드에 붙인다 (설계: `docs/plugin-design.md`).

★ComfyUI 커스텀 노드와 같은 모양이다 (사용자 결정 2026-09-07 — 자유도 우선, 상한은 ComfyUI):
  **같은 프로세스에 import** 하고, 라우터를 `/plug/<id>/` 에, `web/`·`ext/` 를 정적으로 붙인다.
  격리하지 않는다 — 플러그인 코드는 앱 모듈(`workspace`·`cards`·`nai`)을 그대로 import 해 쓴다.
★한 플러그인의 예외는 **그 플러그인만** 죽인다 (목록에 `error` 로 남는다). 백엔드는 계속 뜬다.
★여기는 읽어서 붙이는 것뿐이다. 설치·삭제는 사용자가 누를 때만 돈다 (설계 문서 3단계).

`plugin.json`:

    {
      "id": "tag-roll",            폴더 이름과 같아야 한다 (소문자·숫자·-·_)
      "name": "Tag Roll",
      "version": "1.0.0",
      "server": "server.py",       (선택) `router: APIRouter` 를 내놓는다 → /plug/<id>/…
                                   플러그인 안의 다른 모듈은 `from . import x` 로 (폴더가 패키지다)
      "web": "web",                (선택) 캔버스 폴더 (index.html) → /plug/<id>/web/
      "ext": "ext/main.js",        (선택) 앱 페이지 안에서 돌 JS (문자열 또는 목록) → /plug/<id>/ext/…
      "contributes": { ... }       (선택) 기여 지점 — 화면이 읽는다 (2단계)
    }
"""
from __future__ import annotations

import importlib.util
import json
import re
import sys
import traceback
from dataclasses import dataclass, field
from pathlib import Path

from fastapi import APIRouter, FastAPI
from fastapi.staticfiles import StaticFiles

ID_RE = re.compile(r"^[a-z0-9][a-z0-9_-]*$")


@dataclass
class Plugin:
    id: str
    dir: Path
    name: str = ""
    version: str = ""
    #: 캔버스 주소 (`/plug/<id>/web/`) — 비면 캔버스가 없다 (버튼만 두는 플러그인)
    web: str = ""
    #: 앱 페이지 안에서 돌 JS 주소들 (`/plug/<id>/ext/<파일>`)
    ext: list[str] = field(default_factory=list)
    contributes: dict = field(default_factory=dict)
    #: 못 읽었으면 까닭. 비면 정상
    error: str = ""

    def info(self) -> dict:
        return {
            "id": self.id, "name": self.name or self.id, "version": self.version,
            "web": self.web, "ext": self.ext, "contributes": self.contributes,
            "error": self.error, "dir": str(self.dir),
        }


def _read_manifest(d: Path) -> dict:
    m = json.loads((d / "plugin.json").read_text(encoding="utf-8"))
    if not isinstance(m, dict):
        raise ValueError("plugin.json 은 객체여야 합니다")
    pid = str(m.get("id") or "")
    if pid != d.name:
        raise ValueError(f"id 「{pid}」 가 폴더 이름 「{d.name}」 과 다릅니다")
    if not ID_RE.match(pid):
        raise ValueError(f"id 「{pid}」 — 소문자·숫자·-·_ 만 됩니다")
    return m


def _inside(d: Path, rel: str) -> Path:
    """플러그인 폴더 **안**의 자리만 받는다 — 밖을 가리키면 오류"""
    p = (d / rel).resolve()
    if d.resolve() not in p.parents and p != d.resolve():
        raise ValueError(f"「{rel}」 은 플러그인 폴더 밖입니다")
    return p


def _load_one(app: FastAPI, d: Path) -> Plugin:
    p = Plugin(id=d.name, dir=d)
    try:
        m = _read_manifest(d)
        p.name = str(m.get("name") or d.name)
        p.version = str(m.get("version") or "")
        p.contributes = m.get("contributes") if isinstance(m.get("contributes"), dict) else {}

        # ★★플러그인 폴더 자체는 `sys.path` 에 넣지 않는다 (실측 2026-09-07, 게스트 QA): 앞에 넣었더니 플러그인의
        #   `server.py` 가 백엔드의 `server` 모듈을 가려, 리로드 워커가 `server:app` 을 그쪽에서 찾다 죽었다
        #   (`Attribute "app" not found in module "server"`). 플러그인 안의 모듈은 **패키지 상대 import**
        #   (`from . import x`) 로 쓴다 — 아래 `submodule_search_locations` 가 플러그인 폴더를 패키지 자리로 준다.
        # ★`_lib`(설치 때 pip 으로 격리 설치한 의존성)은 **뒤에** 붙인다 — 앱이 이미 가진 패키지(fastapi 등)를
        #   플러그인 것이 덮으면 백엔드 전체가 흔들린다. 앱에 없는 것만 거기서 온다.
        lib = d / "_lib"
        if lib.is_dir() and str(lib) not in sys.path:
            sys.path.append(str(lib))

        if m.get("server"):
            src = _inside(d, str(m["server"]))
            if not src.is_file():
                raise ValueError(f"server 「{m['server']}」 가 없습니다")
            name = "peropix_plugin_" + d.name.replace("-", "_")
            spec = importlib.util.spec_from_file_location(name, src, submodule_search_locations=[str(d)])
            if spec is None or spec.loader is None:
                raise ValueError(f"「{src.name}」 을 모듈로 못 읽습니다")
            mod = importlib.util.module_from_spec(spec)
            sys.modules[name] = mod
            spec.loader.exec_module(mod)
            router = getattr(mod, "router", None)
            if router is not None:
                if not isinstance(router, APIRouter):
                    raise ValueError("`router` 는 fastapi.APIRouter 여야 합니다")
                app.include_router(router, prefix=f"/plug/{d.name}")

        if m.get("web"):
            web = _inside(d, str(m["web"]))
            if not web.is_dir():
                raise ValueError(f"web 「{m['web']}」 폴더가 없습니다")
            app.mount(f"/plug/{d.name}/web", StaticFiles(directory=str(web), html=True), name=f"plug-{d.name}-web")
            p.web = f"/plug/{d.name}/web/"

        ext = m.get("ext")
        if ext:
            files = [ext] if isinstance(ext, str) else list(ext)
            dirs: dict[Path, None] = {}
            for f in files:
                fp = _inside(d, str(f))
                if not fp.is_file():
                    raise ValueError(f"ext 「{f}」 가 없습니다")
                dirs[fp.parent] = None
                p.ext.append(f"/plug/{d.name}/ext/{fp.name}")
            if len(dirs) != 1:
                raise ValueError("ext 파일은 한 폴더에 모여 있어야 합니다")
            (ext_dir,) = dirs
            app.mount(f"/plug/{d.name}/ext", StaticFiles(directory=str(ext_dir)), name=f"plug-{d.name}-ext")
    except Exception as e:  # noqa: BLE001 — 플러그인 하나가 백엔드를 못 죽인다
        p.error = f"{type(e).__name__}: {e}"
        print(f"[plugins] {d.name}: {p.error}", flush=True)
        traceback.print_exc()
    return p


def load_all(app: FastAPI, root: Path) -> list[Plugin]:
    """`root` 아래 폴더를 이름 차례로 읽어 붙인다. 폴더가 없으면 만든다 (사용자가 열어 넣는 자리다)."""
    try:
        root.mkdir(parents=True, exist_ok=True)
    except OSError:
        return []
    out: list[Plugin] = []
    for d in sorted(root.iterdir()):
        if not d.is_dir() or d.name.startswith((".", "_")):
            continue
        if not (d / "plugin.json").is_file():
            continue
        out.append(_load_one(app, d))
    if out:
        ok = [p.id for p in out if not p.error]
        bad = [p.id for p in out if p.error]
        print(f"[plugins] loaded {ok}" + (f" · failed {bad}" if bad else ""), flush=True)
    return out
