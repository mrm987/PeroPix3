#!/bin/bash
# PeroPix — 맥 꾸러미 (애플 실리콘 · macOS 14 이상). `scripts/portable.ps1` 의 맥 짝이다.
#
# ★★담는 것은 윈도우 꾸러미의 `app/` 과 같다: backend(판정 빼고) · plug-app · 가장 가벼운 검열 모델 ·
#   version.json · 함께 가는 파이썬. 자리만 `PeroPix.app/Contents/Resources` 다 (`src-tauri/src/backend.rs` 의 맥 `inner`).
#   ★한쪽 목록을 고치면 다른 쪽도 함께 본다 — 두 스크립트가 같은 것을 담아야 두 판이 같게 돈다.
# ★★차례가 곧 안전이다: 빌드 → Resources 에 담기 → .pyc 굽기 → 서명 → 묶기.
#   서명한 뒤에는 `.app` 안을 건드리지 않는다 (한 파일만 바뀌어도 봉인이 깨진다). 앱도 안에 쓰지 않는다
#   (데이터는 `~/Library/Application Support/PeroPix`, 백엔드는 `.pyc` 를 안 쓴다).
# ★서명은 ad-hoc 이다 (애플 개발자 계정이 없다, 이슈 #1). 받은 사람은 처음 한 번 「그래도 열기」를 누른다.
# ★묶기는 `ditto` 다 — 실행 권한과 링크를 지킨다. 앱이 업데이트를 풀 때도 `ditto` 다 (`backend/update.py`).
# ★맥 창 설정은 `src-tauri/tauri.macos.conf.json` 에 있다. 창 목록은 기본 설정 위에 **통째로 바뀌므로**
#   기본 설정(`tauri.conf.json`)의 창 값을 고치면 그쪽에도 같이 적는다.
#
# 쓰는 법: bash scripts/macos-package.sh   → _dist/PeroPix-<버전>-macos-arm64.zip
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
DIST="$ROOT/_dist"
CACHE="$DIST/cache"
VERSION=$(node -p "require('$ROOT/src-tauri/tauri.conf.json').version")

# ★파이썬은 python-build-standalone 의 것이다 (이슈 #1). 윈도우의 임베드 판과 같은 3.11 계열.
#   ★올릴 때는 판·이름·해시를 함께 바꾼다 — 해시는 그 릴리즈 자산의 sha256 이다.
PY_TAG="20261021"
PY_NAME="cpython-3.11.17+${PY_TAG}-aarch64-apple-darwin-install_only_stripped.tar.gz"
PY_SHA="1d1335d9d526bc37061af3fe72b0edd88056d7e7d9488eb631946b10b4ab97bb"

if [[ $(uname -s) != Darwin || $(uname -m) != arm64 ]]; then
  echo "[맥] 애플 실리콘 맥에서만 묶습니다" >&2
  exit 1
fi
mkdir -p "$CACHE"

# ── 파이썬 ─────────────────────────────────────────────────────────
PYHOME="$DIST/mac-python"
PY="$PYHOME/python"
if [[ ! -x "$PY/bin/python3" ]]; then
  TGZ="$CACHE/$PY_NAME"
  if [[ ! -f "$TGZ" ]]; then
    echo "[맥] 파이썬 내려받기"
    curl --fail --location --retry 3 -o "$TGZ" \
      "https://github.com/astral-sh/python-build-standalone/releases/download/${PY_TAG}/${PY_NAME//+/%2B}"
  fi
  echo "$PY_SHA  $TGZ" | shasum -a 256 -c -
  rm -rf "$PYHOME"
  mkdir -p "$PYHOME"
  tar -xzf "$TGZ" -C "$PYHOME"
  echo "[맥] 의존성 설치"
  "$PY/bin/python3" -m pip install --disable-pip-version-check --no-cache-dir -r "$ROOT/backend/requirements.txt"
fi
"$PY/bin/python3" -c 'import fastapi, PIL, pydantic, uvicorn, onnxruntime, msgpack'

# ── 앱 ─────────────────────────────────────────────────────────────
(cd "$ROOT" && npx tauri build --bundles app)
APP="$ROOT/src-tauri/target/release/bundle/macos/PeroPix.app"
RES="$APP/Contents/Resources"
test -x "$APP/Contents/MacOS/peropix"

ditto "$PY" "$RES/python"
ditto "$ROOT/backend" "$RES/backend"
# ★판정과 `__pycache__` 는 뺀다 (윈도우 꾸러미와 같은 규칙)
find "$RES/backend" \( -name '__pycache__' -o -name 'test_*.py' \) -prune -exec rm -rf {} +
# ★플러그인은 담지 않는다 — 앱과 함께 가는 것은 공통 자산뿐이다 (`portable.ps1` 의 ★★주)
ditto "$ROOT/plug-app" "$RES/plug-app"
test -f "$RES/plug-app/base.css" || { echo "[맥] plug-app 이 담기지 않았습니다" >&2; exit 1; }
# ★검열은 가장 가벼운 모델 하나만 (`portable.ps1` 과 같다)
mkdir -p "$RES/models/censor"
MODEL=$(ls -Sr "$ROOT"/models/censor/*.onnx | head -1)
cp "$MODEL" "$RES/models/censor/"
echo "[맥] 검열 모델: $(basename "$MODEL")"
for n in LICENSE THIRD-PARTY.md; do
  if [[ -f "$ROOT/$n" ]]; then cp "$ROOT/$n" "$RES/"; fi
done
# ★버전을 파일로 남긴다 — 업데이트가 「지금 무엇을 쓰고 있나」를 이걸로 안다 (`backend/server.py` 의 `APP_VERSION`)
printf '{"version": "%s", "built": "%s"}\n' "$VERSION" "$(date +%F)" > "$RES/version.json"

# ★★`.pyc` 를 미리 굽는다 — 앱은 `.app` 안에 쓰지 않으므로(`PYTHONDONTWRITEBYTECODE`) 안 구워 두면 켤 때마다
#   전부 다시 읽는다. 원본 시각을 안 보는 꼴(`unchecked-hash`)로 굽는다.
#   ★표준 라이브러리에는 일부러 틀린 문법의 시험 파일이 섞여 있어 몇 개는 실패한다 — 그 파일만 굽지 않을 뿐이다.
"$RES/python/bin/python3" -m compileall -q -j 0 --invalidation-mode unchecked-hash "$RES/python/lib" "$RES/backend" >/dev/null \
  || echo "[맥] 일부 .pyc 를 굽지 못했습니다 (그 파일만 켤 때 다시 읽는다)"

# ── 서명 ───────────────────────────────────────────────────────────
xattr -cr "$APP"
codesign --force --deep --sign - --timestamp=none "$APP"
codesign --verify --deep --strict "$APP"

# ── 묶기 ───────────────────────────────────────────────────────────
# ★이름은 앱이 고르는 이름과 같아야 한다 (`backend/update.py` 의 `full_asset_name`)
ZIP="$DIST/PeroPix-$VERSION-macos-arm64.zip"
rm -f "$ZIP"
ditto -c -k --norsrc --noextattr --keepParent "$APP" "$ZIP"
# ★풀어서 서명이 그대로인지 본다 — 앱의 업데이트가 푸는 방식과 같다
CHECK=$(mktemp -d)
ditto -x -k "$ZIP" "$CHECK"
codesign --verify --deep --strict "$CHECK/PeroPix.app"
rm -rf "$CHECK"
echo "[맥] $ZIP ($(du -h "$ZIP" | cut -f1))"
