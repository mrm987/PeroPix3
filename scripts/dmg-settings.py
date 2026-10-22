# PeroPix — 맥 설치용 dmg 의 창 (`scripts/macos-package.sh` 가 dmgbuild 에 넘긴다)
#
# ★창에는 앱과 응용 프로그램 폴더 바로가기 둘만 둔다. 앱을 오른쪽으로 끌어 놓으면 설치가 끝난다.
# ★앱은 dmgbuild 가 `ditto` 로 복사한다 — 서명이 그대로 간다 (묶은 뒤 `macos-package.sh` 가 붙여서 다시 본다).
# 쓰는 값: -D app=<PeroPix.app 경로> -D icon=<볼륨 아이콘 .icns>

app = defines["app"]  # noqa: F821 (dmgbuild 가 넣어 준다)

format = "UDZO"
filesystem = "HFS+"
files = [app]
symlinks = {"Applications": "/Applications"}
icon = defines["icon"]  # noqa: F821

window_rect = ((200, 160), (560, 320))
default_view = "icon-view"
icon_size = 112
text_size = 13
# ★확장자 숨기기(`hide_extensions`)를 쓰지 않는다 — 앱 폴더에 Finder 정보가 붙어 서명 확인이 깨진다
#   (`codesign --strict`: "resource fork, Finder information, or similar detritus not allowed", 맥 검사 2026-10-22)
icon_locations = {"PeroPix.app": (150, 140), "Applications": (410, 140)}
