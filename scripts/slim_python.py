# -*- coding: utf-8 -*-
"""꾸러미에 들어갈 파이썬을 **줄인다** — 꾸러미를 만들 때 한 번 돈다 (2026-08-27).

★★**왜 하나** — 실측으로, 한동안 쉬었다 앱을 켜면 백엔드가 뜨는 데 **8.8초**가 걸렸다
  (바로 다시 켜면 1.0초). 파일 캐시가 식으면 부팅이 **낱개 파일 354개**를 회전 디스크에서
  흩어진 채 다시 읽기 때문이다. 용량은 7.5MB 뿐인데 **여는 횟수**가 시간이었다.

두 가지를 한다:
  1. **안 쓰는 꾸러미를 뺀다** — `onnxruntime` 을 pip 로 깔 때 딸려 온 곁가지다.
     쓰지 않는 것을 확인했다: 소스에서 그것을 부르는 자리가 주석·pytest 설정·벤치마크
     스크립트뿐이었고, 임포트를 막아 놓고 **검열 추론과 서버 임포트가 그대로 되는 것**을
     확인했다 (2026-08-27).
  2. **순수 파이썬 꾸러미를 zip 한 덩이로 묶는다** — 표준 라이브러리가 이미 그 방식이다
     (`python311.zip`). 낱개 수백 개가 파일 하나가 되면 여는 횟수가 그만큼 준다.

★★**묶는 것은 「순수한 것」뿐이다.** 하나라도 `.py`·`.pyc`·`.pyi`·`py.typed` 가 아닌 것이
  들어 있으면 그 꾸러미는 그대로 둔다. 까닭:
    · `.pyd`·`.dll` 은 zip 에서 못 읽는다 (OS 가 파일을 요구한다).
    · 데이터 파일을 `__file__` 로 여는 코드가 흔하다 (`certifi` 의 `cacert.pem` 이 그렇다).
      zip 안에서는 그 경로가 실재하지 않아 **조용히 깨진다.**
★`__init__.py` 가 없는 폴더(네임스페이스 꾸러미)도 그대로 둔다 — zipimport 가 못 다룬다.
★**점으로 시작하는 폴더는 문서다** — `fastapi/.agents/skills/*.md` 처럼 조수용 안내가 들어
  있다. 실행에 안 읽히므로 순수 판정에서 빼고, 묶을 때도 안 담는다 (그래서 함께 사라진다).
★zip 에는 **`.pyc` 만** 담는다. zipimport 는 캐시를 못 남기므로, `.py` 를 담으면 켤 때마다
  다시 컴파일한다. `python311.zip` 도 같은 이유로 `.pyc` 만 들어 있다.
"""
from __future__ import annotations

import compileall
import shutil
import sys
import zipfile
from pathlib import Path

#: 우리 실행 경로에 없는 곁가지 (2026-08-27 확인)
#: ★★**pip 계열은 빼지 않는다** (2026-09-12 실측). 플러그인이 `requirements.txt` 를 가지고 있으면
#:   앱이 **번들 파이썬의 pip 으로** 그 의존성을 깐다 (`plugins.install`). pip 을 걷어낸 배포본에서는
#:   그 설치가 「의존성 설치에 실패했습니다」로 끝났다 — 태그 굴리기(duckdb)가 아예 안 깔렸다.
DROP = ["sympy", "mpmath", "pkg_resources", "_distutils_hack"]
#: 이것만 들어 있으면 「순수」하다
PURE_SUFFIX = {".py", ".pyc", ".pyi"}
PURE_NAME = {"py.typed"}
SKIP_SUFFIX = {".dist-info", ".egg-info", ".egg-link", ".pth"}


def _utf8_out() -> None:
    """★★**내는 글자를 UTF-8 로 못 박는다** (실측 2026-08-27, 릴리즈가 여기서 죽었다).

    GitHub 러너의 파이썬은 표준 출력을 **cp1252** 로 잡는다. 그 자리에 한글을 찍으면
    `UnicodeEncodeError` 로 스크립트가 끝나고, 워크플로는 「파이썬 줄이기 실패」만 남긴다 —
    정작 줄이기는 잘 되고 있었는데 **말하다가 죽은 것**이다.
    ★`errors="replace"` 를 함께 둔다: 어떤 콘솔이든 여기서 다시 죽지 않게.
    """
    for s in (sys.stdout, sys.stderr):
        try:
            s.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass


def pure(d: Path) -> bool:
    """이 폴더를 zip 에 담아도 되나 — 위 ★★주의 규칙."""
    if not (d / "__init__.py").exists():
        return False
    for f in d.rglob("*"):
        if f.is_dir():
            continue
        if f.parent.name == "__pycache__":
            continue
        if any(part.startswith(".") for part in f.relative_to(d).parts[:-1]):
            continue  # 점 폴더 = 문서 (위 ★주)
        if f.suffix in PURE_SUFFIX or f.name in PURE_NAME:
            continue
        return False
    return True


def bundle(sp: Path, zpath: Path) -> tuple[list[Path], int]:
    """순수한 꾸러미를 `zpath` 한 덩이로 묶고, 원본 폴더는 지운다.

    ★★**담을 것만 컴파일한다** (실측 2026-08-27, 이것 때문에 첫 판이 헛돌았다).
      처음에는 site-packages 를 **통째로** 컴파일했는데, `legacy=True` 는 `.pyc` 를 소스
      **옆에** 만들므로 zip 에 안 담는 꾸러미(numpy·PIL·onnxruntime…)에도 `.pyc` 가 한 벌씩
      생겼다 - 실측 **1,039개 21MB**. 곁가지 93MB 를 빼고도 배포 zip 이 132MB 그대로였던
      까닭이다: 뺀 만큼 `.pyc` 로 도로 채웠다.
    ★`legacy=True` 자체는 그대로 둔다 - zip 안의 배치가 `foo/bar.pyc` 라야 zipimport 가 읽는다.
    """
    picked = [d for d in sorted(sp.iterdir()) if d.is_dir() and d.name != "__pycache__" and pure(d)]
    for d in picked:
        # ★`workers=1` — 0(=CPU 전부)은 **멀티프로세스**라, 이 모듈을 임포트해서 쓰는
        #   쪽에서 `__main__` 보호 없이 부르면 그대로 터진다 (판정이 잡았다).
        #   묶는 것은 수백 개뿐이라 병렬이 필요 없다.
        compileall.compile_dir(str(d), quiet=2, legacy=True, force=True, workers=1)

    files = 0
    with zipfile.ZipFile(zpath, "w", zipfile.ZIP_DEFLATED) as z:
        for d in picked:
            for f in d.rglob("*.pyc"):
                if f.parent.name == "__pycache__":
                    continue
                z.write(f, f.relative_to(sp).as_posix())
                files += 1
    for d in picked:
        shutil.rmtree(d, ignore_errors=True)
    return picked, files


def main() -> int:
    _utf8_out()
    py = Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else Path(sys.executable).parent
    sp = py / "Lib" / "site-packages"
    if not sp.is_dir():
        print(f"[줄이기] site-packages 가 없다: {sp}")
        return 1

    # ── 1. 곁가지 빼기 ────────────────────────────────────────────
    freed = 0
    for name in DROP:
        for d in list(sp.glob(name)) + list(sp.glob(name + "-*")):
            if d.is_dir():
                freed += sum(f.stat().st_size for f in d.rglob("*") if f.is_file())
                shutil.rmtree(d, ignore_errors=True)
            elif d.is_file():
                freed += d.stat().st_size
                d.unlink()
    # ★★**`.pth` 찌꺼기도 함께 치운다.** `setuptools` 를 빼면 `distutils-precedence.pth` 가
    #   남아, 파이썬이 **켤 때마다** `_distutils_hack` 을 못 찾겠다는 자취를 뱉는다
    #   (실측 2026-08-27 — 로그가 그 소리로 덮였다).
    for f in sp.glob("*.pth"):
        body = f.read_text(encoding="utf-8", errors="replace")
        if any(name in body for name in DROP):
            f.unlink()
            print(f"[줄이기] 찌꺼기 치움 — {f.name}")
    print(f"[줄이기] 곁가지 뺌 — {freed / 1048576:.0f}MB")

    # ── 2. 순수 꾸러미를 zip 으로 ─────────────────────────────────
    zpath = py / "deps.zip"
    picked, files = bundle(sp, zpath)
    print(f"[줄이기] zip 한 덩이 — 꾸러미 {len(picked)}개 · 모듈 {files}개 · "
          f"{zpath.stat().st_size / 1048576:.1f}MB")
    print("        " + ", ".join(d.name for d in picked))

    # ── 3. 그 zip 을 경로에 올린다 ────────────────────────────────
    # ★`._pth` 의 경로는 **python.exe 옆** 기준이다. `python311.zip` 바로 뒤에 둔다.
    pth = next(py.glob("python3*._pth"), None)
    if not pth:
        print("[줄이기] ._pth 를 못 찾았다 — zip 이 경로에 안 올라간다")
        return 1
    lines = pth.read_text(encoding="utf-8").splitlines()
    if "deps.zip" not in lines:
        at = next((i for i, l in enumerate(lines) if l.strip().endswith(".zip")), -1)
        lines.insert(at + 1, "deps.zip")
        pth.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(f"[줄이기] {pth.name} 에 deps.zip 등록")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
