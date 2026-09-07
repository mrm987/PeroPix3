# 공식 플러그인

앱과 함께 배포되는 플러그인이 여기 산다 (`plugins-official/<id>/`). 포터블 꾸러미는 이 폴더를 `app/` 안에 그대로 담고,
앱의 플러그인 모드 → 관리 탭의 「설치」가 그 사본을 사용자 영역 `plugins/<id>/` 로 복사한다. 네트워크가 없어도 되고,
업데이트는 앱과 함께 온다.

- 플러그인의 모양(`plugin.json`·`server.py`·`web/`·`ext/`·`requirements.txt`)은 `docs/plugin-design.md` 3절.
- 남의 플러그인은 여기 두지 않는다. 코드는 제작자 저장소에 있고, 목록 저장소 `mrm987/peropix-plugins` 의 `index.json` 에
  `{id, repo, tag}` 만 오른다 (ComfyUI 레지스트리와 같은 꼴 — 라이선스도 제작자 것). 앱은 그 목록을 `plugin_registry`
  설정(기본: 목록 저장소의 raw 주소)에서 받아 번들 목록과 합친다. 여기 폴더로 있는 것은 이미 번들이라 목록에 적지 않는다.
- 플러그인은 앱과 같은 권한으로 돈다. 격리하지 않는다 (`CLAUDE.md` 「자유도가 안전보다 앞이다」).
