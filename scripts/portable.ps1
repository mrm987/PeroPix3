# PeroPix 3.0 — 포터블 한 벌을 조립한다 (사용자 결정 2026-08-26).
#
# ★★**설치본을 안 만든다.** 이 앱은 데이터가 **앱 폴더 옆**에 쌓이는 구조라
#   (`backend/server.py` 의 `APP_DIR`), 설치 자리가 곧 창고 자리가 된다.
#   MSI 는 Program Files 라 아예 못 쓰고, NSIS 는 %LOCALAPPDATA% 안이라 그림을 꺼내 보기
#   나쁘며, 언인스톨러가 설치 폴더를 통째로 지운다 — 데이터가 그 안에 있다.
# ★★배치는 **두 층**이다 (2026-08-27): 바깥에는 실행 파일·읽을거리와 **사람이 여는 폴더**
#   (`gallery`·`logs`·`workspaces`·`data`, 앱이 처음 쓸 때 생긴다)만 두고, 앱이 도는 데
#   필요한 것은 전부 `app/` 안에 넣는다 (`backend`·`python`·`models`·`webview`·`version.json`).
#   껍데기는 `app/backend/server.py` 와 `backend/server.py` 를 **둘 다** 알아본다
#   (`backend.rs` 의 `inner`·`find_repo_root`) — 저장소에서 개발할 때는 `app/` 이 없다.
#   ★★코드는 이미 이 배치를 전제로 쓰여 있다: `find_repo_root` 가 exe 옆에서
#   위로 올라가며 표식을 찾고, `find_python` 이 `<앱 것이 사는 자리>/python/python.exe`
#   를 먼저 본다. 그러니 포터블은 새 형식이 아니라 **원래 모습대로 담는 일**이다.
#
# 결과: _dist/PeroPix/          (그대로 실행할 수 있는 한 벌)
#       _dist/PeroPix-<버전>-win64.zip
#
# 쓰기: portable.bat  (또는 powershell -File scripts/portable.ps1 [-SkipBuild])
#
# ★★**이 파일은 BOM 이 붙은 UTF-8 이어야 한다. 떼지 말 것.**
#   윈도우 파워셸 5.1(`powershell.exe`)은 BOM 이 없으면 스크립트를 **그 기계의 ANSI
#   코드페이지**로 읽는다. 한국어 윈도우(949)에서는 어쩌다 넘어가지만, 깃헙 러너
#   (1252)에서는 위 주석의 한글이 따옴표를 깨뜨려 **파싱 단계에서 죽는다**
#   (실측 2026-08-26: `Missing closing ')' in expression`). BOM 을 붙이면 5.1 도
#   파워셸 7 도 UTF-8 로 읽는다.

param(
  # 이미 빌드해 둔 exe 를 쓴다 (Rust 빌드가 3분쯤 걸린다)
  [switch]$SkipBuild,
  # 받아 둔 파이썬을 그대로 쓴다 (다시 받지 않고 pip 도 건너뛴다)
  [switch]$SkipPython
)

$ErrorActionPreference = "Stop"
# ★로그로 넘길 때 한글이 깨지지 않게 (윈도우 콘솔 기본 코드페이지가 949 다)
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch {}
$root = Split-Path $PSScriptRoot -Parent
$dist = Join-Path $root "_dist"
$app = Join-Path $dist "PeroPix"
# ★★**앱 것은 `app/` 안에** (사용자 지시 2026-08-27: *"유저가 접근하는 폴더는 한정적인데
#   너무 다 나와 있는 느낌"*). 바깥에 남는 것은 실행 파일·읽을거리와 **사람이 여는 폴더**
#   (`gallery`·`logs`·`workspaces`·`data`)뿐이다. 그 폴더들은 앱이 처음 쓸 때 생긴다.
# ★같은 규칙을 껍데기(`backend.rs` 의 `inner`)와 백엔드(`server.py` 의 `_app_dir`)가 안다.
$inner = Join-Path $app "app"
$cache = Join-Path $dist "_cache"

# ★버전은 **한 곳**에서 온다 (`src-tauri/tauri.conf.json`). 스크립트에 박으면 어긋난다.
$conf = Get-Content (Join-Path $root "src-tauri/tauri.conf.json") -Raw | ConvertFrom-Json
$version = $conf.version
Write-Host "[포터블] PeroPix $version"

if (-not $SkipBuild) {
  Write-Host "[포터블] 릴리스 빌드 (몇 분 걸립니다)"
  Push-Location $root
  # ★`--no-bundle` — msi·nsis 를 안 굽는다. 포터블만 내보내기로 정했으므로(사용자 결정
  #   2026-08-26) 굽는 시간이 통째로 낭비다.
  npm run tauri build -- --no-bundle
  if ($LASTEXITCODE -ne 0) { Pop-Location; throw "빌드 실패" }
  Pop-Location
}

# ★★빌드가 내는 이름은 **Cargo 이름**(`peropix.exe`)이다 — 설치본을 구울 때만
#   `productName` 으로 바뀐다. 받는 사람이 보는 이름은 `PeroPix.exe` 여야 하므로 여기서
#   바꿔 담는다 (릴리즈 워크플로가 쓰던 규칙 그대로다).
$exe = Join-Path $root "src-tauri/target/release/peropix.exe"
if (-not (Test-Path $exe)) { throw "실행 파일이 없습니다: $exe  (먼저 build.bat)" }

# ── 자리 만들기 ────────────────────────────────────────────────────
# ★파이썬은 **남겨 둔다** — 다시 받는 데 시간이 걸린다 (`-SkipPython` 이 이걸 노린다)
$keepPython = $SkipPython -and (Test-Path (Join-Path $inner "python/python.exe"))
if ($keepPython) {
  Get-ChildItem $app -Force | Where-Object { $_.Name -ne "app" } | Remove-Item -Recurse -Force
  Get-ChildItem $inner -Force | Where-Object { $_.Name -ne "python" } | Remove-Item -Recurse -Force
} elseif (Test-Path $app) {
  Remove-Item $app -Recurse -Force
}
New-Item -ItemType Directory -Force -Path $app, $inner, $cache | Out-Null

# ── 파이썬 (임베드 판) ─────────────────────────────────────────────
# ★★v2 가 쓰던 것과 **같은 판**이다 (3.11.9 embed-amd64). 임베드 판은 기본으로
#   site-packages 를 안 읽으므로 `._pth` 의 `#import site` 를 살려야 pip 로 깐 것이 보인다.
if (-not $keepPython) {
  $pyZip = Join-Path $cache "python-3.11.9-embed-amd64.zip"
  if (-not (Test-Path $pyZip)) {
    Write-Host "[포터블] 임베드 파이썬 내려받기"
    Invoke-WebRequest "https://www.python.org/ftp/python/3.11.9/python-3.11.9-embed-amd64.zip" -OutFile $pyZip
  }
  $py = Join-Path $inner "python"
  Expand-Archive $pyZip -DestinationPath $py
  $pth = Join-Path $py "python311._pth"
  (Get-Content $pth) -replace '#import site', 'import site' | Set-Content $pth

  $getPip = Join-Path $cache "get-pip.py"
  if (-not (Test-Path $getPip)) {
    Invoke-WebRequest "https://bootstrap.pypa.io/get-pip.py" -OutFile $getPip
  }
  & (Join-Path $py "python.exe") $getPip --no-warn-script-location
  Write-Host "[포터블] 의존성 설치"
  & (Join-Path $py "python.exe") -m pip install --no-warn-script-location -r (Join-Path $root "backend/requirements.txt")
  if ($LASTEXITCODE -ne 0) { throw "pip 설치 실패" }

  # ★★**깐 뒤에 줄인다** (2026-08-27). 곁가지를 빼고, 순수 파이썬 꾸러미를 zip 한 덩이로
  #   묶는다 — 까닭과 규칙은 `scripts/slim_python.py` 머리에 있다.
  #   실측: 부팅에 읽는 낱개 파일 354개 → 133개, 곁가지 36MB 빠짐.
  # ★`-SkipPython` 으로 파이썬을 남겨 둔 경우에는 **다시 돌리지 않는다** (이미 줄어 있다).
  Write-Host "[포터블] 파이썬 줄이기"
  & (Join-Path $py "python.exe") (Join-Path $root "scripts/slim_python.py") $py
  if ($LASTEXITCODE -ne 0) { throw "파이썬 줄이기 실패" }
}

# ── 앱 ─────────────────────────────────────────────────────────────
Copy-Item $exe -Destination (Join-Path $app "PeroPix.exe")
# ★백엔드는 **소스 그대로** 간다 (파이썬이라 컴파일이 없다). `__pycache__` 는 뺀다 —
#   다른 파이썬 판에서 만든 것이라 쓸모가 없고, 패치 비교만 어지럽힌다.
Copy-Item (Join-Path $root "backend") -Destination $inner -Recurse
Get-ChildItem $app -Recurse -Directory -Filter "__pycache__" | Remove-Item -Recurse -Force
# ★테스트는 빼고 담는다 (배포물이 아니다 — 릴리즈 워크플로가 쓰던 규칙 그대로다)
Get-ChildItem (Join-Path $inner "backend") -Filter "test_*.py" | Remove-Item -Force
# ★★**플러그인은 담지 않는다** (사용자 결정 2026-09-10). 공식이든 아니든 전부 목록에서 받아 깐다 — 담기 시작하면
#   공식 플러그인이 늘 때마다 앱이 그만큼 무거워진다. 앱과 함께 가는 것은 **공통 자산**뿐이다
#   (`plug-app/` → `/plug/_app/`, `base.css`·`peropix.js`) — 플러그인이 아니라 앱이 플러그인에게 주는 창구라
#   앱 판과 짝이 맞아야 하고 인터넷 없이도 있어야 한다.
Copy-Item (Join-Path $root "plug-app") -Destination $inner -Recurse

# ★★검열은 **기본 모델만** 담는다 (사용자 지시 2026-08-26). 무거운 XL(251MB)을 빼면
#   `censor.models()` 가 폴더를 훑어 가벼운 것부터 내므로, 남은 하나가 그대로 기본이 된다
#   — 코드를 고칠 것이 없다.
$censor = Join-Path $inner "models/censor"
New-Item -ItemType Directory -Force -Path $censor | Out-Null
Get-ChildItem (Join-Path $root "models/censor") -Filter "*.onnx" |
  Sort-Object Length | Select-Object -First 1 |
  ForEach-Object { Copy-Item $_.FullName -Destination $censor; Write-Host "[포터블] 검열 모델: $($_.Name) ($([math]::Round($_.Length/1MB))MB)" }

# ★어휘·읽을거리는 있으면 담는다 (없어도 앱은 뜬다)
# ★읽을거리는 **세 언어를 다 담는다** (사용자 결정 2026-08-26) — 본문은 영문이고
#   한국어·일본어는 따로 있다. 받은 사람이 폴더 안에서 바로 고를 수 있어야 한다.
foreach ($n in @("LICENSE", "THIRD-PARTY.md", "README.md", "README.ko.md", "README.ja.md")) {
  $p = Join-Path $root $n
  if (Test-Path $p) { Copy-Item $p -Destination $app }
}

# ★★**버전을 파일로 남긴다** — 업데이트가 「지금 무엇을 쓰고 있나」를 이걸로 안다
#   (`backend/server.py` 의 `APP_VERSION`). 소스의 상수는 개발용 기본값일 뿐이다.
# ★BOM 없이 쓴다 — 파워셸의 `Set-Content -Encoding UTF8` 은 BOM 을 붙이고, 그러면
#   파이썬의 `json.loads` 가 첫 글자에서 걸린다 (실측 2026-08-26: 버전이 조용히 개발값으로
#   떨어졌다). 백엔드도 `utf-8-sig` 로 읽어 견디지만, 애초에 안 붙이는 편이 낫다.
[IO.File]::WriteAllText(
  (Join-Path $inner "version.json"),
  (@{ version = $version; built = (Get-Date -Format "yyyy-MM-dd") } | ConvertTo-Json))

# ★★**사람이 여는 폴더는 빈 채로라도 미리 만들어 둔다** (사용자 지시 2026-08-27:
#   *"처음엔 app 폴더만 있으니까 사용자가 구조를 이해하기 어려울 것 같음"*).
#   앱이 쓸 때 저절로 생기기는 하지만, **푼 직후에 보이는 것**이 곧 설명이다 —
#   무엇이 자기 것이고 어디를 열면 되는지 그림 한 장 없이 알 수 있어야 한다.
# ★`Compress-Archive` 는 빈 폴더를 그대로 담는다 (실측 2026-08-27).
foreach ($n in @("data", "gallery", "logs", "workspaces")) {
  New-Item -ItemType Directory -Force -Path (Join-Path $app $n) | Out-Null
}

# ── 묶기 ───────────────────────────────────────────────────────────
$zip = Join-Path $dist "PeroPix-$version-win64.zip"
if (Test-Path $zip) { Remove-Item $zip }
Compress-Archive -Path $app -DestinationPath $zip
$mb = [math]::Round((Get-Item $zip).Length / 1MB, 1)
$appMb = [math]::Round(((Get-ChildItem $app -Recurse -File | Measure-Object Length -Sum).Sum) / 1MB, 1)
Write-Host ""
Write-Host "[포터블] 완료 — 푼 크기 ${appMb}MB / zip ${mb}MB"
Write-Host "  $app"
# ★배치를 한 줄로 남긴다 — CI 로그만 봐도 모양이 맞는지 보인다
Write-Host ("[포터블] 바깥: " + ((Get-ChildItem $app -Force | Select-Object -ExpandProperty Name) -join " "))
Write-Host ("[포터블] app/: " + ((Get-ChildItem $inner -Force | Select-Object -ExpandProperty Name) -join " "))
Write-Host "  $zip"
