# 플러그인 공통 자산 (`/plug/_app/`)

**앱이 플러그인에게 주는 창구다. 플러그인이 아니다.** 백엔드가 이 폴더를 `/plug/_app/` 에 붙이고
(`plugins.mount_shared`), 플러그인 페이지는 같은 오리진이므로 한 줄로 가져다 쓴다.

```html
<link rel="stylesheet" href="/plug/_app/base.css">
<script src="/plug/_app/peropix.js"></script>
```

- `base.css` — 클래스 없이도 앱과 같은 모양이 되는 스타일과 창 골격(`header`/`main`/`footer`). 앱 테마를 따라간다.
- `peropix.js` — 앱 창구(`peropix.call`·`action`·`state`·`toast`·`theme`). 앱 밖에서는 `inApp === false` 로 조용히 논다.

★**앱과 함께 배포된다** (`scripts/portable.ps1`). 앱 판과 짝이 맞아야 하고 인터넷 없이도 있어야 하기 때문이다.
플러그인 코드는 여기 두지 않는다 — 공식 플러그인도 제작자 저장소에 있고 목록으로만 배포한다
(사용자 결정 2026-09-10, `docs/plugin-design.md`).
