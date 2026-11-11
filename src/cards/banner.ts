/** 배너(카드 그림 자리)의 생김새 — **한 곳에서만 정한다.**
 *
 *  같은 모양이 세 곳에 나온다: 섹션 배너(`SectionCard`) · 위치 잡는 창의 미리보기
 *  (`ThumbDialog`) · 드래그 고스트(`DragLayer`). 값을 나눠 두면 **미리보기에서 잡은 위치와
 *  실물이 달라진다** — 실제로 그렇게 어긋나 있었다 (사용자 지적 2026-08-03).
 *
 *  ★**감쇠(gradient)로 녹이지 않고 잘라낸다.** 감쇠는 끝점에서 기울기가 갑자기 0이 되어
 *    꺾임이 선으로 보였다 (실측: 마지막 3px 가 -8,-5,-11 로 떨어지다 정지). 자른 자리는
 *    그 자체가 의도된 모서리라 그 문제가 없다. 후보 비교는 `design/banner-variants.html` 의 G 안.
 *
 *  ★그림 자리 오른쪽은 `BANNER_BG` 가 **끝까지 이어진다.** 패널을 넓혀도 그림은 안 늘어나고
 *    단색만 늘어나야 하기 때문이다.
 */

/** 그림 자리 폭 (목업 `.bimg`). 패널을 넓혀도 고정이다. */
export const BANNER_IMG_W = 240;

/** 배너 바탕 — 그림 오른쪽으로 이어지는 단색.
 *
 *  ★★**테마를 따른다** (사용자 지적 2026-08-21: 다크에선 너무 밝고 라이트에선 너무 어둡다).
 *    예전에는 `#05070a` 로 박혀 있어서 흰 패널 위에 새까만 띠가 얹혔다. 값은
 *    `styles/tokens.css` 의 `--banner-bg` 하나이고, 여기서는 그것을 가리키기만 한다.
 *  ★이름 글자가 흰색이라 **라이트에서도 어두운 쪽**을 유지한다 (밝게 하면 글자가 안 보인다). */
export const BANNER_BG = "var(--banner-bg)";

/** 계단의 위치. 두 값이 곧 생김새다 — 여기만 바꾸면 세 곳이 함께 바뀐다. */
const CUT_A = "63%"; // 중간 단이 시작하는 곳
const CUT_B = "84%"; // 잘리는 곳
const ANGLE = "112deg";
/** ★★자른 자리를 **머리카락 한 올만큼** 눕힌다 (사용자 지적 2026-08-20: 경계선이 자글거린다).
 *  0 길이로 끊으면 마스크가 픽셀 격자에 그대로 찍혀 **계단이 보인다.** 이건 「감쇠로 녹이는 것」
 *  (머리 주석이 말리는 그것)이 아니라 **안티에일리어싱**이다 — 폭이 1px 안팎이라 선으로
 *  읽히지 않는다. 값은 여기 하나뿐이라 배너·커버가 함께 매끈해진다. */
const EDGE = "0.7%";

/** 그림을 자르는 마스크 */
export const BANNER_CUT =
  `linear-gradient(${ANGLE}, #000 0 ${CUT_B}, transparent calc(${CUT_B} + ${EDGE}))`;

/** 잘리기 전 구간을 한 번 어둡게 눕혀 '단'을 만든다.
 *  ★색은 **바탕과 같은 것**을 쓴다 (`--banner-bg`) — 이 단은 옆의 단색 띠로 이어지는
 *    자리라, 색이 다르면 라이트에서 이음매에 색 차이가 보인다. */
export const BANNER_STEP =
  `linear-gradient(${ANGLE}, transparent 0 ${CUT_A},` +
  ` color-mix(in srgb, var(--banner-bg) 55%, transparent) calc(${CUT_A} + ${EDGE}) ${CUT_B},` +
  ` transparent calc(${CUT_B} + ${EDGE}))`;

/** 그림이 없을 때 — 같은 실루엣에 카드 색만. 두 상태가 이어져 보이게 한다.
 *
 *  ★진하기는 `--banner-a1`(밝은 쪽) · `--banner-a2`(어두운 쪽)가 정한다 — **테마마다 다르다.**
 *    예전에는 `59`·`33` 이 박혀 있어 어두운 바탕에서 색 겹이 도드라졌다.
 *  ★각도는 배너가 눕는 방향을 따른다 — 세로 모드의 세로 띠는 90도 돌린 208도다 (`SceneLane`) */
export const bannerEmptyFill = (gradient: [string, string], angle = 118) =>
  `linear-gradient(${angle}deg,` +
  ` color-mix(in srgb, ${gradient[1]} var(--banner-a1), transparent),` +
  ` color-mix(in srgb, ${gradient[0]} var(--banner-a2), transparent) 78%)`;

/* ── 카드 커버(세로 3:4) ── 같은 3단, 다만 **수직** ────────────────
 *
 *  ★★**맥락은 배너 그대로다** (사용자 지적 2026-08-20): 왼쪽이 그림(밝음)이고 **이름이
 *    거기 앉으며**, 오른쪽이 단색 패널이고 그 위에 단추가 뜬다. 한때 세로로 각도를 돌렸다가
 *    이름이 검은 패널 위로 가는 반대 구성이 됐다 — 그것을 되돌린 자리다.
 *  ★★**경계는 수직이다** (사용자 지시 2026-08-20: *"대각선으로 하지 말고 수직으로.
 *    오른쪽에 세로로 수직"*). 폭이 110px 남짓한 카드에서는 비스듬한 선이 자리를 많이 먹고
 *    자글거린다. 수직선은 픽셀 격자에 그대로 떨어져 **애초에 매끈하다.**
 *  ★★**완전히 검은 띠는 얇게** (같은 지시). 카드 앞면은 그림을 보는 자리라, 단색은
 *    단추가 앉을 만큼만 있으면 된다. 눕히는 일은 그 앞의 중간 단이 맡는다.
 *  ★단의 색·자르는 방식·가장자리 눕힘은 **배너와 같은 값**이다 — 두 자리가 한 식구로 보이게. */
const COVER_ANGLE = "90deg";
/** 중간 단이 시작하는 곳 */
const COVER_A = "80%";
/** 잘리는 곳 — 여기부터 오른쪽이 완전한 단색이다 (얇게) */
const COVER_B = "92%";

/** 그림을 자르는 마스크 */
export const COVER_CUT =
  `linear-gradient(${COVER_ANGLE}, #000 0 ${COVER_B}, transparent calc(${COVER_B} + ${EDGE}))`;

/** 중간 단 */
export const COVER_STEP =
  `linear-gradient(${COVER_ANGLE}, transparent 0 ${COVER_A},` +
  ` color-mix(in srgb, var(--banner-bg) 55%, transparent) calc(${COVER_A} + ${EDGE}) ${COVER_B},` +
  ` transparent calc(${COVER_B} + ${EDGE}))`;

/** 이름이 그림 위에서도 읽히게 하는 아래쪽 스크림 (배너와 같은 값) */
export const BANNER_SCRIM =
  "linear-gradient(180deg, rgba(0,0,0,0) 30%, rgba(0,0,0,0.58) 100%)";
