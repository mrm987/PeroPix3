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


class _FreshStatic(StaticFiles):
    """플러그인 정적 파일(캔버스 페이지·확장 JS)은 **캐시하지 않는다** (`Cache-Control: no-store`).

    ★여기는 일반 브라우저 환경이 아니라 우리가 플러그인을 띄워 주는 환경이다 — 플러그인을 고치거나 업데이트했으면
      앱을 새로고침하든 다시 켜든 **반드시 새 파일**이어야 한다 (사용자 지시 2026-09-08). WebView2 는 검증자 없는
      정적 응답을 어림짐작으로 캐시해, 파일을 바꿔도 옛 페이지가 며칠씩 남았다 (실측: 카메라 페이지 색을 바꿔도 안 바뀜)."""

    async def get_response(self, path, scope):
        r = await super().get_response(path, scope)
        r.headers["Cache-Control"] = "no-store"
        return r

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
    description: str = ""
    #: 꺼진 플러그인 — 폴더는 그대로 두고 **붙이지 않는다** (설정 `plugins_disabled`). 켜고 끄는 것은 다음에 켤 때 적용
    enabled: bool = True
    #: 어디서 왔나 (`_origin.json`: bundled / repo+repo / zip+zip). 폴더에 직접 넣은 것은 None — 화면이 GitHub 링크·출처 표시에 쓴다
    origin: dict | None = None
    #: 매니페스트의 `homepage` (선택) — 있으면 링크는 이것이 우선
    homepage: str = ""
    #: 캔버스 프레임 규격 (`canvas_spec`) — 처음 크기·최소 크기·맞춤 방식
    canvas: dict = field(default_factory=lambda: canvas_spec({}))

    def info(self) -> dict:
        return {
            "id": self.id, "name": self.name or self.id, "version": self.version,
            "web": self.web, "ext": self.ext, "contributes": self.contributes,
            "error": self.error, "dir": str(self.dir), "enabled": self.enabled,
            "origin": self.origin, "homepage": self.homepage, "description": self.description,
            "canvas": self.canvas,
        }


#: 캔버스 프레임 규격의 기본값 — 아무것도 안 적은 플러그인도 흐름 방식 720×480 으로 뜬다 (사용자 결정 2026-09-09)
CANVAS_DEFAULT = {"width": 720, "height": 480, "fit": "flow"}


def canvas_spec(m: dict) -> dict:
    """`plugin.json` 의 `canvas` 를 정리한다 — `{width, height, minWidth, minHeight, fit}`.
    최소 크기를 안 적으면 처음 크기가 최소다 (좁아져서 깨지는 일은 앱이 막는다). `fit` 은 "flow"(기본) | "scale"."""
    c = m.get("canvas") if isinstance(m.get("canvas"), dict) else {}

    def num(k: str, default: float) -> int:
        v = c.get(k)
        return int(v) if isinstance(v, (int, float)) and v > 0 else int(default)

    w, h = num("width", CANVAS_DEFAULT["width"]), num("height", CANVAS_DEFAULT["height"])
    return {
        "width": w, "height": h,
        "minWidth": min(num("minWidth", w), w), "minHeight": min(num("minHeight", h), h),
        "fit": "scale" if c.get("fit") == "scale" else "flow",
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
    p = Plugin(id=d.name, dir=d, origin=_installed_origin(d))
    try:
        m = _read_manifest(d)
        p.name = str(m.get("name") or d.name)
        p.version = str(m.get("version") or "")
        p.description = str(m.get("description") or "")
        p.homepage = str(m.get("homepage") or "")
        p.canvas = canvas_spec(m)
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
            app.mount(f"/plug/{d.name}/web", _FreshStatic(directory=str(web), html=True), name=f"plug-{d.name}-web")
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
            app.mount(f"/plug/{d.name}/ext", _FreshStatic(directory=str(ext_dir)), name=f"plug-{d.name}-ext")
    except Exception as e:  # noqa: BLE001 — 플러그인 하나가 백엔드를 못 죽인다
        p.error = f"{type(e).__name__}: {e}"
        print(f"[plugins] {d.name}: {p.error}", flush=True)
        traceback.print_exc()
    return p


def _skipped(d: Path) -> Plugin:
    """꺼진 플러그인 — 이름·판만 읽고 아무것도 붙이지 않는다. 목록에는 남아야 다시 켤 수 있다."""
    p = Plugin(id=d.name, dir=d, enabled=False, origin=_installed_origin(d))
    m = _manifest_of(d)
    if m:
        p.name, p.version = str(m.get("name") or d.name), str(m.get("version") or "")
        p.description, p.homepage = str(m.get("description") or ""), str(m.get("homepage") or "")
        p.canvas = canvas_spec(m)
    return p


def load_all(app: FastAPI, root: Path, disabled: set[str] | None = None) -> list[Plugin]:
    """`root` 아래 폴더를 이름 차례로 읽어 붙인다. 폴더가 없으면 만든다 (사용자가 열어 넣는 자리다).
    `disabled` 에 든 id 는 붙이지 않고 꺼진 것으로만 목록에 둔다."""
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
        out.append(_skipped(d) if disabled and d.name in disabled else _load_one(app, d))
    if out:
        ok = [p.id for p in out if not p.error]
        bad = [p.id for p in out if p.error]
        print(f"[plugins] loaded {ok}" + (f" · failed {bad}" if bad else ""), flush=True)
    return out


# ── 플러그인 파이썬이 앱에 닿는 창구 ──────────────────────────────────
class _Host:
    """`from plugins import host` — 플러그인 `server.py` 가 앱 액션을 시킬 때 쓴다.

    ★★승인 카드를 지나지 않는다 (`outside=True`, 사용자 결정 2026-09-07: 플러그인은 앱의 규칙 밖에서
      돌고 결과는 플러그인 몫이다). 앱 액션 목록은 `GET /api/agent/tools` 와 같다.
    ★`server.py` 가 켜질 때 `tools`·`app_dir` 를 채운다 — 플러그인이 import 될 때는 이미 차 있다."""

    tools = None
    app_dir: Path | None = None

    async def action(self, name: str, args: dict | None = None) -> dict:
        if self.tools is None:
            raise RuntimeError("앱이 아직 준비되지 않았습니다")
        return await self.tools.call(name, args or {}, outside=True)


host = _Host()


# ── 관리: 목록·설치·삭제 (설계 문서 3단계) ──────────────────────────────
#  ★공식 플러그인은 앱 저장소의 `plugins-official/` 에 있고 배포물에 함께 담긴다 (사용자 결정 2026-09-07).
#    설치 = 그 사본을 `plugins/` 로 복사 — 네트워크가 없어도 되고 업데이트는 앱과 함께 온다.
#  ★남의 플러그인은 제작자 저장소에서 받는다 — 목록 저장소 `peropix-plugins/index.json` 에 `{id, repo, tag}` 만 오르고
#    (`remote_items`), 코드·라이선스는 제작자 것이다 (ComfyUI 레지스트리와 같은 꼴, 사용자 결정 2026-09-08). zip 주소 직접 넣기도 된다.
#  ★설치·삭제는 **사용자가 누를 때만** 돈다. 자동 갱신은 없다 (`CLAUDE.md` 「상한은 ComfyUI」).
#  ★★지우지 않는다: 갈아 끼우는 옛 폴더는 `_old-<id>-<시각>` 으로, 지운 것은 OS 휴지통(안 되면 `_removed-…`)으로.
#    `_` 접두 폴더는 `load_all` 이 건너뛴다.

def _manifest_of(d: Path) -> dict | None:
    try:
        m = json.loads((d / "plugin.json").read_text(encoding="utf-8"))
        return m if isinstance(m, dict) and m.get("id") else None
    except Exception:
        return None


def _entry(m: dict, pid: str, source: str, **extra) -> dict:
    return {
        "id": pid, "name": str(m.get("name") or pid), "version": str(m.get("version") or ""),
        "description": str(m.get("description") or ""), "homepage": str(m.get("homepage") or ""), "source": source, **extra,
    }


def official_list(official: Path) -> list[dict]:
    out: list[dict] = []
    if not official.is_dir():
        return out
    for d in sorted(official.iterdir()):
        m = _manifest_of(d) if d.is_dir() else None
        if m and str(m["id"]) == d.name and ID_RE.match(d.name):
            out.append(_entry(m, d.name, "bundled"))
    return out


REPO_RE = re.compile(r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$")
TAG_RE = re.compile(r"^[A-Za-z0-9_.-]+$")


def remote_items(data) -> list[dict]:
    """목록 파일의 항목을 받을 수 있는 꼴로. 항목은 둘 중 하나다:
    - `{id, repo: "owner/name", tag}` — 제작자 저장소의 태그 (ComfyUI 처럼 코드는 제작자 것, 목록은 주소만.
      사용자 결정 2026-09-08). zip 은 GitHub 의 태그 압축 주소로 만든다 — 폴더 한 겹은 `install` 이 벗긴다.
    - `{id, zip, sha256?}` — 아무 zip 주소.
    `version` 을 안 적으면 태그에서 앞의 `v` 를 뗀 것이다. 둘 다 없는 항목은 버린다."""
    items = data.get("items") if isinstance(data, dict) else data
    out: list[dict] = []
    for it in items or []:
        if not (isinstance(it, dict) and it.get("id") and ID_RE.match(str(it["id"]))):
            continue
        pid = str(it["id"])
        repo, tag = str(it.get("repo") or ""), str(it.get("tag") or "")
        if repo and tag and REPO_RE.match(repo) and TAG_RE.match(tag):
            it = {**it, "version": it.get("version") or re.sub(r"^v", "", tag)}
            out.append(_entry(it, pid, "repo", zip=f"https://github.com/{repo}/archive/refs/tags/{tag}.zip",
                              sha256=str(it.get("sha256") or ""), repo=repo, tag=tag))
        elif it.get("zip"):
            out.append(_entry(it, pid, "zip", zip=str(it["zip"]), sha256=str(it.get("sha256") or "")))
    return out


async def remote_list(url: str) -> list[dict]:
    """원격 목록 — `{"items": [...]}` (`remote_items` 참고)."""
    if not url:
        return []
    import httpx

    import time

    # ★캐시를 비껴간다 — raw.githubusercontent.com 은 몇 분 동안 옛 파일을 주는데(실측 2026-09-08, 게스트가 push 직후의
    #   목록을 못 봤다), 쿼리가 다르면 새로 받는다. 다른 서버는 모르는 쿼리를 무시한다.
    async with httpx.AsyncClient(timeout=10.0, follow_redirects=True) as c:
        r = await c.get(url, params={"_": int(time.time())})
        r.raise_for_status()
        data = r.json()
    return remote_items(data)


def installed_versions(root: Path) -> dict[str, str]:
    out: dict[str, str] = {}
    if root.is_dir():
        for d in root.iterdir():
            if d.is_dir() and not d.name.startswith((".", "_")):
                m = _manifest_of(d)
                if m:
                    out[d.name] = str(m.get("version") or "")
    return out


def _vt(v: str) -> tuple[int, ...]:
    return tuple(int(x) for x in re.findall(r"\d+", v or "")) or (0,)


# ── 출처 — 「같은 플러그인」의 기준은 id 가 아니라 id + 출처다 (사용자 지적 2026-09-08) ──
#  id 만 같으면 새 판으로 보던 규칙은, 목록의 남이 공식 id 를 쓰거나 폴더에 직접 넣은 것과 같은 id 를 쓰면
#  그것을 「업데이트」로 덮어쓰게 했다. 그래서 (1) 공식(번들) id 는 예약 — 목록 항목이 있어도 무시하고,
#  (2) 설치할 때 출처를 `_origin.json` 에 남겨, 업데이트는 **출처가 같을 때만** 제안한다. 폴더에 직접 넣은 것은
#  출처가 없으니 업데이트 제안이 없다. 목록 저장소의 CI 도 같은 규칙으로 등록 자체를 거른다 (두 겹).
ORIGIN_FILE = "_origin.json"


def _origin_of(entry: dict) -> dict:
    """목록 항목의 출처 — 이것이 같아야 같은 플러그인이다"""
    if entry["source"] == "bundled":
        return {"source": "bundled"}
    if entry["source"] == "repo":
        return {"source": "repo", "repo": entry["repo"]}
    return {"source": "zip", "zip": entry["zip"]}


def _installed_origin(d: Path) -> dict | None:
    try:
        o = json.loads((d / ORIGIN_FILE).read_text(encoding="utf-8"))
        return o if isinstance(o, dict) and o.get("source") else None
    except Exception:
        return None


async def _catalog(official: Path, url: str) -> tuple[list[dict], str]:
    """번들 + 원격을 한 목록으로. ★공식 id 는 예약 — 원격에 같은 id 가 있으면 버리고 콘솔에만 남긴다."""
    bundled = official_list(official)
    reserved = {b["id"] for b in bundled}
    remote_error = ""
    try:
        remote = await remote_list(url)
    except Exception as e:  # noqa: BLE001 — 인터넷이 없어도 번들 목록은 보인다
        remote, remote_error = [], f"{type(e).__name__}: {e}"
    kept: list[dict] = []
    seen: set[str] = set()
    for it in remote:
        if it["id"] in reserved:
            print(f"[plugins] 목록의 「{it['id']}」 는 공식 플러그인 id 라 무시합니다 ({it.get('repo') or it.get('zip')})", flush=True)
        elif it["id"] in seen:
            print(f"[plugins] 목록에 「{it['id']}」 가 두 번 있어 뒤의 것은 무시합니다", flush=True)
        else:
            seen.add(it["id"])
            kept.append(it)
    return bundled + kept, remote_error


async def registry(root: Path, official: Path, url: str) -> dict:
    """받을 수 있는 것 전부 — 번들(공식) + 원격. `installed` 는 지금 깔린 판, `update` 는 같은 출처의 더 높은 판이 있는가."""
    items, remote_error = await _catalog(official, url)
    have = installed_versions(root)
    for it in items:
        it["installed"] = have.get(it["id"])
        it["official"] = it["source"] == "bundled"
        origin = _installed_origin(root / it["id"]) if it["installed"] else None
        #: 깔린 것보다 높은 판이 **같은 출처**에 있다 — 화면은 「설치된 플러그인」 줄의 업데이트 단추로 보여 준다
        it["update"] = bool(it["installed"]) and origin == _origin_of(it) and _vt(it["version"]) > _vt(it["installed"] or "")
    return {"items": sorted(items, key=lambda x: x["id"]), "remoteError": remote_error}


async def install(root: Path, official: Path, python: str, *, id: str = "", zip: str = "",
                  sha256: str = "", url: str = "") -> dict:
    """번들 사본을 복사하거나 zip 을 받아 `plugins/<id>/` 에 놓고, `requirements.txt` 가 있으면 `_lib/` 에 pip 으로 넣는다.
    붙는 것은 다음에 켤 때다 (라우터는 켤 때 mount 한다)."""
    import asyncio
    import hashlib
    import shutil
    import subprocess
    import time
    import zipfile

    root.mkdir(parents=True, exist_ok=True)
    src_dir: Path | None = None
    zip_url, want = zip, sha256
    origin: dict = {"source": "zip", "zip": zip_url}
    if id and not zip_url:
        # ★`registry` 와 같은 목록(`_catalog`)에서 고른다 — 공식 id 는 번들, 나머지는 목록 항목 (공식 id 는 예약이라 겹치지 않는다)
        items, remote_error = await _catalog(official, url)
        hit = next((r for r in items if r["id"] == id), None)
        if hit is None:
            return {"ok": False, "error": f"원격 목록을 못 받았습니다: {remote_error}" if remote_error else f"「{id}」 를 목록에서 못 찾았습니다"}
        origin = _origin_of(hit)
        if hit["source"] == "bundled":
            src_dir = official / id
        else:
            zip_url, want = hit["zip"], hit.get("sha256", "")
        # ★출처가 다른 같은 id 가 이미 깔려 있으면 덮지 않는다 — 폴더에 직접 넣은 것·다른 저장소의 것은 별개 플러그인이다
        have = _installed_origin(root / id) if (root / id).is_dir() and _manifest_of(root / id) else None
        if (root / id).is_dir() and _manifest_of(root / id) and have != origin:
            return {"ok": False, "error": f"「{id}」 는 다른 출처로 이미 설치되어 있습니다 ({(have or {}).get('source') or '폴더에 직접 넣음'}). 지우고 다시 설치하십시오"}
    if src_dir is None and not zip_url:
        return {"ok": False, "error": "무엇을 설치할지 없습니다 (id 또는 zip 주소)"}

    stage = root / f"_stage-{int(time.time() * 1000)}"
    shutil.rmtree(stage, ignore_errors=True)
    stage.mkdir(parents=True)
    try:
        if src_dir is not None:
            new = stage / src_dir.name
            shutil.copytree(src_dir, new, ignore=shutil.ignore_patterns("__pycache__", "_lib", ".git"))
        else:
            import httpx

            zpath = stage / "plugin.zip"
            async with httpx.AsyncClient(timeout=None, follow_redirects=True) as c:
                r = await c.get(zip_url)
                r.raise_for_status()
                zpath.write_bytes(r.content)
            if want and hashlib.sha256(zpath.read_bytes()).hexdigest().lower() != want.lower():
                return {"ok": False, "error": "받은 파일의 sha256 이 목록과 다릅니다"}
            un = stage / "unzip"
            un.mkdir()
            with zipfile.ZipFile(zpath) as z:
                # ★zip 밖으로 나가는 경로를 막는다 (`..`·절대경로) — 남이 만든 zip 이다
                for name in z.namelist():
                    p = (un / name).resolve()
                    if un.resolve() not in p.parents and p != un.resolve():
                        return {"ok": False, "error": f"수상한 경로가 들어 있습니다: {name}"}
                z.extractall(un)
            kids = list(un.iterdir())
            new = kids[0] if len(kids) == 1 and kids[0].is_dir() and (kids[0] / "plugin.json").is_file() else un
        m = _manifest_of(new)
        if not m:
            return {"ok": False, "error": "plugin.json 이 없거나 id 가 없습니다"}
        pid = str(m["id"])
        if not ID_RE.match(pid):
            return {"ok": False, "error": f"id 「{pid}」 — 소문자·숫자·-·_ 만 됩니다"}
        if id and pid != id:
            return {"ok": False, "error": f"꾸러미의 id 「{pid}」 가 「{id}」 와 다릅니다"}
        target = root / pid
        if target.exists():
            # ★지우지 않는다 — 옛 것은 `_old-…` 로 물러나고, 사람이 되돌릴 수 있다
            target.rename(root / f"_old-{pid}-{time.strftime('%Y%m%d-%H%M%S')}")
        shutil.move(str(new), str(target))
        # ★출처를 남긴다 — 업데이트는 같은 출처에서만 온다 (`registry` 의 `update`)
        (target / ORIGIN_FILE).write_text(json.dumps(origin, ensure_ascii=False, indent=2), encoding="utf-8")

        pip_log = ""
        req = target / "requirements.txt"
        if req.is_file():
            proc = await asyncio.create_subprocess_exec(
                python, "-m", "pip", "install", "--no-warn-script-location", "--disable-pip-version-check",
                "--target", str(target / "_lib"), "-r", str(req),
                stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            )
            out, _ = await proc.communicate()
            pip_log = out.decode("utf-8", "replace")[-2000:]
            if proc.returncode != 0:
                return {"ok": False, "error": "의존성 설치에 실패했습니다 (플러그인 파일은 놓아 두었습니다)",
                        "pip": pip_log, "id": pid}
        return {"ok": True, "id": pid, "version": str(m.get("version") or ""), "restart": True, "pip": pip_log}
    except Exception as e:  # noqa: BLE001 — 못 받음·못 풂·못 옮김 전부 **답**으로 돌려준다 (창구가 500 을 내지 않게)
        return {"ok": False, "error": f"{type(e).__name__}: {e}"}
    finally:
        shutil.rmtree(stage, ignore_errors=True)


def remove(root: Path, pid: str) -> dict:
    """OS 휴지통으로 보낸다 (안 되면 `_removed-…` 로 이름만 바꾼다). 이미 붙은 라우터는 다음에 켤 때 사라진다."""
    import time

    if not ID_RE.match(pid):
        return {"ok": False, "error": f"id 「{pid}」 가 이상합니다"}
    target = root / pid
    if not target.is_dir():
        return {"ok": False, "error": f"「{pid}」 가 없습니다"}
    import trash

    try:
        if not trash.send_os([target]):
            target.rename(root / f"_removed-{pid}-{time.strftime('%Y%m%d-%H%M%S')}")
    except PermissionError as e:
        # ★★예외를 던지면 안 된다 (실측 2026-09-08): 던진 500 은 CORS 머리가 없어 화면에 「Failed to fetch」 로만
        #   보였다. 폴더가 탐색기 등에 열려 있으면 휴지통도 이름 바꾸기도 거부된다 — 까닭을 답으로 돌려준다.
        return {"ok": False, "error": "폴더가 다른 프로그램(탐색기 등)에 열려 있어 지우지 못했습니다. 닫고 다시 시도하세요.",
                "detail": str(e)}
    except OSError as e:
        return {"ok": False, "error": f"지우지 못했습니다: {type(e).__name__}: {e}"}
    return {"ok": True, "id": pid, "restart": True}
