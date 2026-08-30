"""자동 업데이트 — **받아서 옆에 쌓아 두는 것까지**가 여기 일이다 (사용자 지시 2026-08-26).

★★v2 의 구조를 옮겼다 (`d:/PeroPix/backend.py` 의 `/api/check-patch`·`/api/apply-patch`):
  GitHub 릴리즈의 자산을 보고, 받아서, 앱 폴더에 덮는다. 다른 것이 둘 있다.

  1. **프론트가 실행 파일 안에 박힌다.** v2 는 `index.html` 이 파일이라 화면 수정도 텍스트
     교체였지만, v3 는 화면만 고쳐도 `peropix.exe` 를 갈아야 한다. 그래서 패치에도 exe 가
     들어간다 (그래도 파이썬·모델이 빠져 35MB 대 130MB 다).
  2. **돌고 있는 exe 는 덮어쓸 수 없다.** 그래서 여기서는 **쌓아 두기만** 하고
     (`.update/new/`), 실제 교체와 재시작은 껍데기(Rust)가 한다 — 그쪽은 백엔드를 내리고
     나서 손대므로 파일이 잡혀 있지 않다 (`src-tauri/src/update.rs`).

★★**전체를 받는지 패치를 받는지 사용자에게 안 묻는다** (사용자 지시 2026-08-26:
  *"유저 입장에서는 「이번엔 전체를 받아야 합니다」라는 문구를 볼 필요가 있음?"*).
  단추는 하나이고, 어느 쪽인지는 앱이 정한다. 사용자에게는 받는 양만 숫자로 보인다.

★의존성(파이썬 패키지)·검열 모델이 바뀐 릴리즈는 **전체로 넘긴다** (`requires_full`).
  앱이 pip 를 돌리지 않는다 — 중간에 실패하면 파이썬이 반쯤 갈린 채로 남고 되돌릴 길이 없다.
"""

from __future__ import annotations

import asyncio
import json
import platform
import shutil
import sys
import time
import zipfile
from pathlib import Path
from typing import Any, Callable, Awaitable

import httpx

#: 릴리즈를 보는 곳. ★저장소 이름을 코드에 박는다 — 설정으로 빼면 남의 저장소를 가리켜
#  임의의 zip 을 앱 폴더에 풀 수 있게 된다.
REPO = "mrm987/PeroPix3"
API = f"https://api.github.com/repos/{REPO}/releases/latest"
UA = {"Accept": "application/vnd.github+json", "User-Agent": "PeroPix3-App"}


def parse_version(v: str) -> tuple[int, int, int, int]:
    """`3.0.1` · `v3.0.1` · `3.0.1.2` 를 견주기 좋은 꼴로. ★못 읽으면 (0,0,0,0) — 「가장 낮음」이다.

    ★`-dev` 같은 꼬리는 **떼고 본다** (개발 중 버전이 릴리즈보다 높게 잡히면 안 된다)."""
    out = [0, 0, 0, 0]
    try:
        for i, p in enumerate(v.strip().lstrip("vV").split(".")[:4]):
            out[i] = int("".join(c for c in p if c.isdigit()) or 0)
    except Exception:
        return (0, 0, 0, 0)
    return (out[0], out[1], out[2], out[3])


def full_asset_name(latest: str, system: str = sys.platform, machine: str = platform.machine()) -> str:
    """이 기계가 받을 **전체 zip 의 이름** — `PeroPix-<ver>-win64.zip` · `PeroPix-<ver>-macos-<arch>.zip`.

    ★★한 릴리즈에 윈도우·맥 zip 이 **함께** 올라간다 (macOS 포팅, 이슈 #1). 이름 앞뒤만 보고
      `PeroPix-*.zip` 을 집으면 상대편 것을 받아 앱 폴더에 풀게 된다 — 플랫폼·아키텍처로 고른다.
    ★맥의 arch 는 `platform.machine()` 이 준다 — 애플 실리콘은 `arm64`, 인텔은 `x86_64`."""
    if system == "darwin":
        arch = "arm64" if machine.lower() in ("arm64", "aarch64") else "x86_64"
        return f"PeroPix-{latest}-macos-{arch}.zip"
    return f"PeroPix-{latest}-win64.zip"


async def check(current: str) -> dict[str, Any]:
    """새 버전이 있나 — **받지는 않는다.**

    ★실패를 예외로 올리지 않는다. 업데이트 확인은 **부팅 때 한 번 조용히** 도는 것이라,
      인터넷이 없다고 앱이 시끄러워지면 안 된다 (v2 도 시작 시 오류를 무시했다).
    """
    # ★★**개발판은 확인하지 않는다** (사용자 지시 2026-08-29: *"개발버전에도 계속 업데이트가
    #   뜨는데, dev 버전은 예외로"*). `parse_version("3.0.0-dev")` 는 3.0.0 보다 작아서, 배포판이
    #   3.0.1 이 되자 저장소에서 돌리는 개발판마다 「새 버전」 토스트가 떴다. 저장소 작업본에
    #   배포 zip 을 덮어쓰는 것은 애초에 말이 안 된다.
    if "dev" in current:
        return {"ok": True, "has_update": False, "building": False, "dev": True,
                "current": current, "latest": ""}
    try:
        async with httpx.AsyncClient(timeout=15.0, follow_redirects=True) as c:
            r = await c.get(API, headers=UA)
            if r.status_code != 200:
                return {"ok": False, "error": f"GitHub {r.status_code}"}
            rel = r.json()
            latest = str(rel.get("tag_name", "")).lstrip("vV")
            assets = {a["name"]: a for a in rel.get("assets", [])}
            has = parse_version(latest) > parse_version(current)

            info: dict[str, Any] = {}
            if "patch-info.json" in assets:
                try:
                    ir = await c.get(assets["patch-info.json"]["browser_download_url"])
                    if ir.status_code == 200:
                        info = ir.json()
                except Exception:
                    info = {}

            # ★자산이 아직 안 올라왔으면 **빌드 중**이다 (릴리즈를 만든 직후가 그렇다)
            full = assets.get(full_asset_name(latest))
            # ★패치(`patch-<ver>.zip`)는 **윈도우 전용**이다 — exe 와 백엔드만 담는다. 맥은 늘 전체.
            patch = assets.get(f"patch-{latest}.zip") if sys.platform != "darwin" else None
            if has and not full and not patch:
                return {"ok": True, "has_update": True, "building": True,
                        "current": current, "latest": latest, "url": rel.get("html_url", "")}

            # ★★어느 쪽으로 받을지는 **여기서 정한다** — 사용자에게 안 묻는다.
            #   의존성·모델이 바뀌었거나(`requires_full`), 너무 옛 버전이라 패치가 안 맞으면 전체.
            use_patch = bool(patch) and not info.get("requires_full") and (
                parse_version(current) >= parse_version(str(info.get("patch_from", "0")))
            )
            pick = patch if use_patch else full
            return {
                "ok": True,
                "has_update": has,
                "building": False,
                "current": current,
                "latest": latest,
                "kind": "patch" if use_patch else "full",
                "asset": (pick or {}).get("name", ""),
                "size": (pick or {}).get("size", 0),
                "url": rel.get("html_url", ""),
                "notes": rel.get("body", ""),
            }
    except Exception as e:
        return {"ok": False, "error": str(e)}


#: 받아 둔 것을 쌓는 자리. ★앱 폴더 **안**이다 — 옮길 때 같은 볼륨이라야 이름 바꾸기로 끝난다
STAGE = ".update"


async def stage(
    app_dir: Path,
    current: str,
    on_progress: Callable[[int, int], Awaitable[None]] | None = None,
    on_unpack: Callable[[], Awaitable[None]] | None = None,
) -> dict[str, Any]:
    """새 판을 받아 `.update/new/` 에 풀어 둔다. **앱 파일은 아직 안 건드린다.**

    ★풀어 둔 모습은 **앱 폴더와 같은 배치**다 (`peropix.exe`·`backend/`·`version.json`…).
      껍데기는 그저 그 안의 것을 하나씩 제자리로 옮기면 된다 — 무엇을 지킬지(데이터 폴더)를
      따로 셈하지 않아도 된다. **거기 없는 것은 안 건드리기 때문이다.**
    """
    got = await check(current)
    if not got.get("ok") or not got.get("has_update") or got.get("building"):
        return {"ok": False, "error": "받을 것이 없습니다"}

    async with httpx.AsyncClient(timeout=None, follow_redirects=True) as c:
        r = await c.get(API, headers=UA)
        assets = {a["name"]: a for a in r.json().get("assets", [])}
        a = assets.get(got["asset"])
        if not a:
            return {"ok": False, "error": f"자산이 없습니다: {got['asset']}"}

        stage_dir = app_dir / STAGE
        shutil.rmtree(stage_dir, ignore_errors=True)
        (stage_dir).mkdir(parents=True, exist_ok=True)
        zpath = stage_dir / a["name"]
        total = int(a.get("size") or 0)
        done = 0
        # ★★**흘려 받는다** — 130MB 를 메모리에 통째로 들고 있지 않는다. 진행률도 여기서 나온다.
        async with c.stream("GET", a["browser_download_url"]) as res:
            if res.status_code != 200:
                return {"ok": False, "error": f"내려받기 실패 {res.status_code}"}
            with open(zpath, "wb") as f:
                async for chunk in res.aiter_bytes():
                    f.write(chunk)
                    done += len(chunk)
                    if on_progress:
                        try:
                            await on_progress(done, total)
                        except Exception:
                            pass

    if zpath.stat().st_size < 1000:
        return {"ok": False, "error": "받은 파일이 너무 작습니다"}

    # ★★**여기서부터가 「설치」다** (사용자 지적 2026-08-27: *"다 받은 후에 설치중으로
    #   텍스트가 안 바뀌고 132.3/132.3 에서 멈춰 있다가 완료됨"*). 전체 판은 132MB 를
    #   풀어 350MB 를 쓰는데, 그동안 아무 소식도 안 나가 화면은 받는 중 그대로였다.
    if on_unpack:
        try:
            await on_unpack()
        except Exception:
            pass

    new = stage_dir / "new"
    # ★★**푸는 일은 딴 실로 보낸다.** `extractall` 과 `shutil.move` 는 통짜로 막는 일이라
    #   여기서 그냥 부르면 **백엔드가 그 몇십 초 동안 통째로 멈춘다** — 그림도, 저장도,
    #   방금 보낸 「설치 중」 다음의 어떤 소식도 못 나간다. 업데이트 중에도 앱은 살아 있어야
    #   한다는 것이 2026-08-26 결정이다.
    err = await asyncio.to_thread(_unpack, zpath, new)
    if err:
        return {"ok": False, "error": err}

    zpath.unlink(missing_ok=True)

    return {"ok": True, "kind": got["kind"], "version": got["latest"], "dir": str(new)}


def _unpack(zpath: Path, new: Path) -> str | None:
    """받은 zip 을 `new/` 에 푼다. **딴 실에서 돈다** (위 ★★주). 문제가 있으면 그 까닭을 돌려준다."""
    shutil.rmtree(new, ignore_errors=True)
    new.mkdir(parents=True)
    with zipfile.ZipFile(zpath) as z:
        # ★★zip 밖으로 나가는 경로를 막는다 (`..`·절대경로). 남이 만든 zip 을 푸는 것은
        #   아니지만, 푸는 자리가 **앱 폴더**라 한 번 뚫리면 앱이 통째로 갈린다.
        for m in z.namelist():
            p = (new / m).resolve()
            if not str(p).startswith(str(new.resolve())):
                return f"수상한 경로가 들어 있습니다: {m}"
        z.extractall(new)

    # ★전체 zip 은 `PeroPix/` 한 겹을 쓰고 있다 (`Compress-Archive` 가 폴더째 담는다) —
    #   한 겹이면 벗겨서 **패치와 같은 모습**으로 맞춘다. 껍데기가 갈래를 몰라도 되게.
    # ★★**그 한 겹이 앱 폴더일 때만 벗긴다** (2026-08-27, 판정이 드러낸 지뢰).
    #   예전에는 겉이 하나면 이름을 안 보고 벗겼다. 그러면 언젠가 **백엔드만 담은 패치**를
    #   만드는 날, 겉의 하나가 `backend/` 라서 그것을 벗기고 `server.py` 를 앱 뿌리에
    #   쏟아 놓는다 — 갈아 끼우기가 그대로 실행되어 앱이 통째로 어긋난다.
    #   ★표식은 **앱 폴더에만 있는 것**으로 본다 (`PeroPix.exe`·`version.json`).
    kids = list(new.iterdir())
    looks_like_app = len(kids) == 1 and kids[0].is_dir() and any(
        (kids[0] / m).exists() for m in ("PeroPix.exe", "version.json")
    )
    if looks_like_app:
        inner = kids[0]
        for e in inner.iterdir():
            shutil.move(str(e), str(new / e.name))
        inner.rmdir()
    return None


def clear(app_dir: Path) -> None:
    """받다 만 것을 치운다 — 취소했을 때 부른다 (사용자 지적 2026-08-26).

    ★★**`.update/` 를 통째로 지우지 않는다.** 거기에는 지난번 업데이트가 남긴 `old/` 가
      있을 수 있고, 그것은 **다음에 켤 때 껍데기가 치울 몫**이다 (`src-tauri/src/update.rs`
      의 `sweep`). 지금 우리가 지우면 아직 돌고 있는 실행 파일을 건드리게 된다.
    ★지우는 것은 **이번에 받던 것**뿐이다: 받다 만 zip 과 풀다 만 `new/`.
    """
    stage_dir = app_dir / STAGE
    if not stage_dir.exists():
        return
    shutil.rmtree(stage_dir / "new", ignore_errors=True)
    for f in stage_dir.glob("*.zip"):
        f.unlink(missing_ok=True)
