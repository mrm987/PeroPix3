/** 스팀(구름) 텍스처 — **순수 계산**이다. 캔버스도 DOM 도 안 쓴다.
 *
 *  ★★★**v2 의 모양으로 되돌렸다** (사용자 결정 2026-09-04: *"그냥 v2 원본이 제일 나은듯 …
 *    형태 자체는 저렇게 퍼지게 두고, 기본적으로 좀 더 넓게 그리게 해서 박스를 90% 이상 가리게"*).
 *    원문은 v2 `index.html` 의 `generateSteamTexture` — **타원 거리 + 3옥타브 가장자리 노이즈 +
 *    `0.6 → 1.15` 알파 경사**다. 아래 계산은 그 순서와 상수를 그대로 옮긴 것이다.
 *
 *  ★★그 사이에 있던 「둥근 사각형 바탕 + 바깥으로만 부푸는 윤곽」은 **걷어냈다.**
 *    박스를 100% 덮으려고 바탕을 사각형으로 잡았는데, 그 바탕이 그대로 비쳐
 *    *"어떻게 조정해도 기본이 네모"* 라는 제보가 왔다 (2026-09-02). 덮는 것은
 *    **모양이 아니라 배율**로 푼다 (`CLOUD_SCALE`).
 *
 *  ★★v2 와 **다른 것은 딱 둘**이다:
 *    1. `CLOUD_SCALE` — 구름을 그만큼 크게 그린다. v2 는 박스의 30% 밖에 못 덮었다.
 *    2. 무늬를 **판 좌표**에서 만든다 (v2 는 박스의 실제 픽셀 좌표였다). v2 는 박스 크기를
 *       조금만 바꿔도 무늬가 통째로 달라졌는데(사용자 지적 2026-09-04: *"비율이 고정되면서
 *       바뀌는 게 아니고 엄청 크게 바뀌는"*), 판을 고정 해상도로 만들어 늘려 쓰면
 *       **크기를 바꿔도 같은 구름이 커지기만 한다.**
 *
 *  ★★★**겹친 박스는 한 덩이로 보인다** (사용자 지시 2026-09-05). 그렇다고 모양을 새로
 *    설계하지는 **않는다** — 거리장으로 다시 짰더니 *"아예 시각적인 느낌이 너무 다름"* 이라는
 *    지적이 왔다. 판은 v2 그대로 두고, **합치는 방법만** 바꾼다:
 *
 *      캔버스에 판을 겹쳐 그리면  알파가 더해져 겹친 자리가 밝은 띠가 된다 (캔버스에는
 *                                 알파를 최대값으로 합치는 수단이 없다)
 *      판을 배열에 모으면          픽셀마다 **더 진한 쪽을 남긴다**(max) — 띠가 안 생기고,
 *                                 두 구름이 이어져 한 덩이로 보인다. 떨어진 것은 그대로 따로다.
 *
 *    합치는 자리는 `censorRender.drawSteam` 이다. 이 파일은 판 한 장까지만 맡는다.
 *
 *  구조 — **재료와 모양을 가른다.** 여기가 빠른 까닭이다:
 *
 *      무늬  씨앗·부드럽게·비율에만 매인다. `plate()` 가 만들어 **캐시**한다.
 *      색    밝기·진하기는 슬라이더라 매 프레임 바뀐다. `plateRGBA()` 가 픽셀당 곱셈 하나로 입힌다.
 */
import { fbm, makeNoise, sdRoundRect, smoothstep } from "./noise.ts";

/** 판의 긴 변 (픽셀). ★비용이 여기 걸린다 — 픽셀마다 노이즈를 여섯 번 돈다.
 *  640 이면 한 장에 약 40ms 이고 (실측 2026-09-04), 캐시되므로 끄는 동안에는 0 이다.
 *  ★이 안에서 **박스가 차지하는 것은 `640 / span`** 이다 — 그만큼이 실제 해상도다. */
const PLATE_MAX = 640;

/** v2 의 `expandRatio` — 판은 구름 박스보다 각 변으로 이만큼 넓다 */
const EXPAND = 0.35;

/** ★★**작은 박스에서의 배율** (곡선의 천장). 큰 박스는 `cloudScale` 이 여기서부터 내린다.
 *
 *  v2 의 타원은 박스에 내접하므로 모서리를 원리상 못 덮는다 — 그래서 **구름 자체를 키운다.**
 *  실측 2026-09-04 — 박스 짧은 변별로 (`steam.test.ts` 의 덮임 판정이 같은 값을 잰다):
 *
 *      짧은 변   배율    덮임 평균
 *       60px    ×1.95      99%
 *      150px    ×1.85      99%
 *      300px    ×1.75      98%
 *      800px    ×1.65      97%
 *     1500px    ×1.60      96%
 *
 *  ★★**큰 박스는 덮임을 조금 내주고 크기를 얻는다.** 고정 배율 2.1 이던 때(덮임 100%)는
 *    큰 박스에서 구름이 화면을 덮었다 (사용자 지적 2026-09-04: *"지금도 좀 큼"*).
 *    더 덮고 싶으면 `CLOUD_SCALE_MIN` 을, 작은 박스까지 함께 키우려면 `CLOUD_SCALE` 을 올린다.
 *  ★구름이 커 보이는 몫은 대부분 **알파 경사(0.6→1.15)의 halo** 다. 더 줄이려면 배율이
 *    아니라 그 경사를 좁혀야 하는데, 그러면 v2 의 부드러운 느낌이 함께 사라진다.
 */
const CLOUD_SCALE = 2.1;

/** ★★**큰 박스에서 내려갈 바닥값.** 곡선의 기울기가 곧 이 값과 천장의 간격이다.
 *
 *  ★1.15 에서 올렸다 (사용자 지적 2026-09-05: *"지금 큰 박스일때 너무 덜가려짐"*).
 *    그때 800px 짜리 박스가 ×1.35 를 받아 덮임이 **평균 89% · 최저 0%** 였다.
 *    실측 — 비율 1.6 · 씨앗 셋 (`steam.test.ts` 의 덮임 판정이 같은 값을 잰다):
 *
 *        배율    덮임 평균 / 최저
 *      ×1.35        89% / 0%
 *      ×1.45        93% / 1%
 *      ×1.55        96% / 9%
 *      ×1.65        97% / 17%
 *      ×2.10       100% / 77%
 *
 *  ★더 덮고 싶으면 이 값을 올린다. 큰 박스에서 구름이 자리를 너무 먹으면 내린다. */
const CLOUD_SCALE_MIN = 1.5;
/** 곡선이 반쯤 내려오는 박스 짧은 변 (원본 픽셀) */
const CLOUD_SCALE_REF = 220;

/** ★★**박스가 클수록 배율을 줄인다** (사용자 제안 2026-09-04: *"박스 크기에 비례해서
 *  배율을 점점 줄여주면?"*).
 *
 *  까닭: 배율이 고정이면 **넘치는 폭도 박스에 비례해 커진다** — 큰 박스에서는 구름이
 *  화면을 덮었다 (지적: *"지금도 좀 큼"*). 곡선을 두면 큰 박스일수록 박스에 붙는다.
 *
 *  ★★**넘치는 폭을 상수로는 못 만든다.** 타원이 사각형 **모서리**를 덮으려면 반지름이
 *    박스 반폭의 √2 배 이상이어야 하는데, 이 비는 박스 크기와 무관하다. 절대 여백(+50px)
 *    으로 묶으면 큰 박스에서 구름이 박스보다 작아져 검열이 아예 안 된다.
 *    그래서 **기울기만 낮춘다** — 큰 박스는 덮임을 내주고 크기를 얻는다.
 *  ★재는 것은 **원본 픽셀의 짧은 변**이다 (화면 배율이 아니라) — 확대해도 구름이 안 변해야 한다. */
export function cloudScale(shortSide: number): number {
  const s = Math.max(0, shortSide);
  return CLOUD_SCALE_MIN
    + (CLOUD_SCALE - CLOUD_SCALE_MIN) * (CLOUD_SCALE_REF / (CLOUD_SCALE_REF + s));
}

/** 배율을 캐시 열쇠로 쓰려고 5% 단위로 뭉갠다 (`bucketAspect` 와 같은 뜻) */
export const bucketScale = (k: number) => Math.round(k * 20) / 20;

/** 그 배율일 때 판을 **박스 크기의 몇 배로 그리나** */
export const spanOf = (k: number) => (1 + 2 * EXPAND) * k;

export type Plate = {
  /** 덮는 정도 0..255 */
  cover: Uint8Array;
  /** 구름의 두께(밝기) 0..255. 밝기 슬라이더가 이 값을 편다 */
  lum: Uint8Array;
  /** 판의 픽셀 크기 */
  pw: number;
  ph: number;
  /** 박스 크기의 몇 배로 그리나 (가로·세로 같다 — v2 의 확장이 각 변 비례라서) */
  span: number;
};

/** 이 판이 무엇으로 만들어졌나 — 캐시 열쇠 */
/** 알파 경사의 끝 — v2 원문 1.15. ★끝은 못 박는다: 여기를 늘리면 칠한 넓이가 넓어진다 (2026-09-06 실측,
 *  사용자: *"그라데이션 경사를 완만하게 하려고 했더니 색칠 영역이 넓어짐"*). 완만함은 **시작점**으로 조절한다 */
export const FADE_END = 1.15;
/** 알파 경사의 시작 (여기까지 100%) — v2 원문 0.6. 「경사」 슬라이더가 여기를 안쪽으로 당긴다 (`fadeStartOf`) */
export const FADE_START = 0.6;

/** 「경사」(0~100) → 경사 시작점. 0 이면 v2 그대로(0.6), 100 이면 0.1 — 칠한 넓이는 같고 100% 인 속만 좁아진다.
 *  ★붓 경계는 u = 1/k (배율 1.5~2.1 → 0.48~0.67) 에 있다. 시작점이 그 안으로 들어가면 칠한 가장자리가 100% 에
 *    못 미치기 시작한다 — 그것이 이 슬라이더의 트레이드오프다 (사용자 결정 2026-09-06: 별도 수치로 조절). */
export function fadeStartOf(grade: number) {
  return FADE_START - (Math.min(100, Math.max(0, grade)) / 100) * 0.5;
}

export type PlateKey = {
  seed: number;
  feather: number;
  aspect: number;
  /** 알파 경사 시작점 (`fadeStartOf`). 없으면 v2 원문 0.6 */
  start?: number;
  /** 구름 배율 — `cloudScale(짧은 변)` 을 `bucketScale` 로 뭉갠 값 */
  scale: number;
  /** 판의 긴 변 (픽셀). 없으면 `PLATE_MAX`.
   *  ★★붓 조각처럼 **작게 그려지는 판은 작게 굽는다** (사용자 지적 2026-09-05: 획이 박스에
   *    닿으면 앱이 멈춘다). 640px 판 하나가 40ms 라, 획 하나에 조각 수십 개면 초 단위가 된다.
   *    128px 이면 25배 싸고, 40px 로 그려질 판에는 그만큼이면 충분하다.
   *  ★렌더러는 128·256 만 쓴다 (`censorRender.steamPlate`) — 구름은 작업 격자(긴 변 340)에만
   *    그려지므로 그 이상은 비용만 든다. */
  res?: number;
};

/** 가로세로비를 **5% 단위로 뭉갠다.** 늘리는 동안 판을 다시 만들지 않기 위한 것이고,
 *  5% 는 눈에 안 띈다 (판을 그 비율로 늘려 쓴다). */
export const bucketAspect = (w: number, h: number) =>
  Math.max(0.05, Math.round((w / Math.max(h, 1e-6)) * 20) / 20);

/** 씨앗·부드럽게·해상도별 **노이즈 밭** — 두께(`lum`)와 가장자리 흔들림(`en`)을 판 픽셀 자리마다.
 *
 *  ★★왜 판과 따로 두나 (2026-09-05, 덮기 실측): 노이즈는 **판 픽셀 좌표**로 계산되고 그 축척
 *    `ns` 는 판의 긴 변(= 해상도)으로 정해지므로, 씨앗·부드럽게·해상도가 같으면 **비율·배율이
 *    달라도 같은 밭의 왼쪽 위 조각**을 읽는 것이다. 판 굽기의 비용은 거의 전부 픽셀당 여섯 번의
 *    노이즈였다 (640px 에 40ms). 붓으로 덮은 사각형은 비율·배율이 획마다 새로 나와 그때마다
 *    판을 구웠는데, 밭을 두면 새 판은 타원 거리 계산뿐이라 몇 ms 다. 결과는 전과 **비트 단위로 같다**.
 *  ★밭은 씨앗 8 × 해상도 3 × 부드럽게 값 만큼 생기므로 개수를 막는다 (오래된 것부터 버린다). */
const fields = new Map<string, { lum: Uint8Array; en: Float32Array }>();
const FIELDS_MAX = 48;

function noiseField(seed: number, feather: number, res: number) {
  const key = `${seed}|${feather}|${res}`;
  const hit = fields.get(key);
  if (hit) return hit;
  const n = makeNoise(seed);
  const ff = 1 + Math.min(50, Math.max(0, feather)) / 25;
  const ns = (res / 2) * ff;
  const lum = new Uint8Array(res * res);
  const en = new Float32Array(res * res);
  for (let py = 0; py < res; py++) {
    for (let px = 0; px < res; px++) {
      const i = py * res + px;
      // ── 구름의 두께 (거의 흰색, 13계조만 흔들린다) ──────────────
      let bn = n(px / ns, py / ns)
        + n((px / ns) * 2, (py / ns) * 2) * 0.5
        + n((px / ns) * 4, (py / ns) * 4) * 0.25;
      bn = 0.5 + ((bn / 1.75 + 1) / 2) * 0.5;
      lum[i] = Math.round(bn * 255);
      // ── 3옥타브 가장자리 노이즈 ──────────────────────────────
      en[i] = n(px / (ns * 0.5) + 50, py / (ns * 0.5) + 50) * 0.5
        + n(px / (ns * 0.25) + 150, py / (ns * 0.25) + 150) * 0.35
        + n(px / (ns * 0.12) + 250, py / (ns * 0.12) + 250) * 0.15;
    }
  }
  if (fields.size >= FIELDS_MAX) fields.delete(fields.keys().next().value!);
  const f = { lum, en };
  fields.set(key, f);
  return f;
}

/** 무늬 판 하나를 만든다. ★비싸다 — 부르는 쪽이 캐시한다 (`censorRender`).
 *
 *  ★아래 상수는 **전부 v2 원문의 값**이다. 하나만 만져도 구름의 성격이 바뀌므로,
 *    바꿀 때는 무엇을 왜 바꾸는지 여기 적는다. */
/** 씨앗 팔레트 전체의 노이즈 밭을 **손이 비었을 때** 미리 굽는다 — 한 번에 하나씩(타이머로 쪼개서).
 *  ★★사용자 제보 2026-09-05: 손을 뗀 멈춤을 잡은 뒤 "이번엔 그리는 도중에 렉". 제 해상도 판(256)에
 *    쓰는 밭은 씨앗마다 처음 한 번 약 20ms 인데, 그것이 획 도중이나 손을 뗀 프레임에 걸리면 그 프레임이
 *    튄다. 검열 중 탭에 들어와 처음 그릴 때 부르면, 첫 획을 긋기 전에 대개 다 구워져 있다.
 *  같은 (부드럽게, 해상도) 조합은 한 번만 예약한다. 이미 있는 밭은 건너뛴다. */
/** 씨앗 팔레트의 크기 (`censorMask.seedOf` 가 이 안에서 고른다) */
export const SEEDS = 8;
const warmed = new Set<string>();
export function warmFields(feather: number, seeds: number, resList: number[]) {
  const tag = `${feather}|${resList.join(",")}`;
  if (warmed.has(tag)) return;
  warmed.add(tag);
  const todo: [number, number][] = [];
  for (const res of resList) for (let seed = 1; seed <= seeds; seed++) todo.push([seed, res]);
  /* ★한가할 때만 (`requestIdleCallback`). 타이머로 돌리면 첫 획을 긋는 프레임 사이에 20ms 짜리 굽기가
     끼어 그 프레임이 튄다 (사용자 제보 2026-09-05: "그리는 도중의 잔렉"). 없는 환경이면 타이머로. */
  const later = (fn: () => void) => {
    const ric = (globalThis as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => void }).requestIdleCallback;
    if (ric) ric(fn, { timeout: 2000 });
    else setTimeout(fn, 50);
  };
  const step = () => {
    const next = todo.shift();
    if (!next) return;
    noiseField(next[0], feather, next[1]);
    later(step);
  };
  later(step);
}

export function plate(key: PlateKey): Plate {
  const { seed, feather } = key;
  const aspect = Math.max(0.05, key.aspect);
  const span = spanOf(Math.max(1, key.scale));

  // 판 크기 — 긴 변이 `res`(없으면 `PLATE_MAX`). 그 안에서 구름 박스는 `1 / (1+2*EXPAND)` 를 차지한다
  const max = Math.max(8, Math.min(PLATE_MAX, key.res ?? PLATE_MAX));
  const tw = Math.max(8, aspect >= 1 ? max : Math.round(max * aspect));
  const th = Math.max(8, aspect >= 1 ? Math.round(max / aspect) : max);
  const ws = tw / (1 + 2 * EXPAND);
  const hs = th / (1 + 2 * EXPAND);
  const expandX = ws * EXPAND;
  const expandY = hs * EXPAND;

  const field = noiseField(seed, feather, max);
  const start = key.start ?? FADE_START;
  // ★「부드럽게」가 하는 일 둘 (v2 그대로): 무늬를 성기게(1x~3x, `noiseField`) · 윤곽 흔들림을 약하게(100%~20%)
  const strength = 1 - Math.min(50, Math.max(0, feather)) / 62.5;

  const rx = ws / 2, ry = hs / 2;
  const cx = tw / 2, cy = th / 2;
  // 판 테두리 — 여기까지는 비우고, 그 바깥 네 배까지 서서히 지운다 (v2 그대로)
  const safe = Math.min(expandX, expandY) * 0.25;
  const fadeEnd = safe * 4;

  const cover = new Uint8Array(tw * th);
  const lum = new Uint8Array(tw * th);

  for (let py = 0; py < th; py++) {
    for (let px = 0; px < tw; px++) {
      const i = py * tw + px;
      const edge = Math.min(px, py, tw - 1 - px, th - 1 - py);
      if (edge < safe) continue;   // 판 테두리는 완전히 투명하다

      // 노이즈 밭에서 같은 자리를 읽는다 (밭은 `max × max`, 판은 그 왼쪽 위 `tw × th`)
      const fi = py * max + px;
      lum[i] = field.lum[fi];

      // ── 덮는 범위 ──────────────────────────────────────────
      // ★타원 거리 — 1 이 구름 박스의 테두리다 (원래 박스는 그 `1/CLOUD_SCALE` 자리에 있다)
      const dx = (px - cx) / rx, dy = (py - cy) / ry;
      const dist = Math.hypot(dx, dy);
      // ★가장자리 노이즈는 **양쪽으로** 민다 (안으로 파이는 것도 v2 의 모양이다)
      const warped = dist + field.en[fi] * 0.25 * strength;

      let a = 0;
      if (warped < start) a = 255;
      else if (warped < FADE_END) {
        const t = (warped - start) / (FADE_END - start);
        a = Math.round((1 - t * t * (3 - 2 * t)) * 255);
      }
      if (edge < fadeEnd) a = Math.round(a * Math.max(0, Math.min(1, (edge - safe) / (fadeEnd - safe))));
      cover[i] = a;
    }
  }
  return { cover, lum, pw: tw, ph: th, span };
}

/** 회색 범위 — **v2 원문 그대로** (`floor(b*230) + floor(bright * floor(b*25))`).
 *  ★230 을 바탕으로 25 단계만 흔든다. 거의 흰색이고, 그것이 이 구름의 원래 성격이다. */
const GRAY_BASE = 230;
const GRAY_RANGE = 25;

/** 덮임·두께에 **밝기·진하기**를 입혀 RGBA 로 만든다. 픽셀당 곱셈이라 슬라이더가 안 걸린다.
 *
 *  ★판 한 장(`Plate`)이든 여러 판을 최대값으로 모은 것이든 똑같이 받는다 — 둘 다
 *    `cover`·`lum` 한 쌍이다.
 *  `out` 을 주면 거기에 쓴다 (매 프레임 새 배열을 만들지 않기 위해). */
export function plateRGBA(
  p: { cover: Uint8Array; lum: Uint8Array }, brightness: number, alpha: number,
  out?: Uint8ClampedArray,
): Uint8ClampedArray {
  const n = p.cover.length;
  const rgba = out && out.length === n * 4 ? out : new Uint8ClampedArray(n * 4);
  const b = Math.min(100, Math.max(0, brightness)) / 100;
  const a = Math.min(100, Math.max(0, alpha)) / 100;
  const base = Math.floor(GRAY_BASE * b);
  const range = Math.floor(GRAY_RANGE * b);
  for (let i = 0; i < n; i++) {
    const g = base + Math.floor((p.lum[i] / 255) * range);
    const o = i * 4;
    rgba[o] = g;
    rgba[o + 1] = g;
    rgba[o + 2] = g;
    rgba[o + 3] = p.cover[i] * a;
  }
  return rgba;
}

// 바탕 계산은 다른 방식(모자이크·흐리기 마스크)이 쓴다 — 여기서는 안 쓴다
void sdRoundRect;
void smoothstep;
void fbm;

/** ── 영역 구름 ──────────────────────────────────────────────────
 *
 *  ★★★붓으로 칠한 **자유 곡선 영역**의 구름 (사용자 지적 2026-09-06: *"칠한 영역이 커질수록 스팀이 좀
 *    튀어. 위아래로 갑자기 비져나갈 때도 있고, 십자 현상도 가끔 나옴. 브러시 경계랑 그 너머로 옅게 퍼진
 *    안개의 경계선이 너무 뚜렷해"*).
 *    사각형 판을 겹쳐 최대값으로 합치는 방식은 **사각형마다 제 크기의 구름**을 찍는다 — 칠한 영역을 덮은
 *    사각형은 크기가 제각각이라, 작은 조각의 짧은 자락이 큰 조각의 긴 자락 위에 얹혀 **속(100%)과 자락의
 *    경계가 계단처럼 서고**, 길쭉한 조각은 제 긴 변만큼 위아래로 뻗쳐 **튀고**, 세로·가로 조각이 겹치면
 *    **십자**가 됐다. 그래서 자유 영역은 판을 겹치지 않고 **영역에서의 거리**로 한 번에 만든다.
 *
 *  v2 판의 셈을 거리로 옮긴 것이다 — 원 하나를 두고 보면 둘이 같다:
 *      v2: 타원 거리 u (0 가운데 · 1 구름 박스 끝), 구름 박스 = 원래 박스 × 배율 k.
 *          warped = u + 노이즈·0.25, u<0.6 → 100%, 0.6~1.15 스무스스텝, 그 밖 0.
 *      여기: R = 영역의 **굵기의 반**(안쪽 거리의 최대), u = (R + 밖거리 − 안거리) / (k·R).
 *          반지름 R 인 원이면 v2 의 u 와 같다. 사각형이면 모서리가 v2 타원보다 더 덮인다 (둥근 사각형).
 *  ★굵기 R 은 영역마다 하나다 — 40px 붓 획은 R=20, 상자는 짧은 변의 반. 배율 k 는 `cloudScale(2R)`.
 *  ★노이즈 파장은 굵기에 매인다 (`noiseScale`) — 판에서는 판 긴 변의 반이었다. 굵기의 배수로 두어
 *    가는 획에 큰 덩어리 노이즈가 얹히지 않게 한다.
 */

/** 1차원 제곱 거리 변환 (Felzenszwalb–Huttenlocher). `f` 는 0(대상)·INF(그 밖) */
function edt1d(f: Float32Array, n: number, d: Float32Array, v: Int32Array, z: Float32Array) {
  let k = 0;
  v[0] = 0;
  z[0] = -Infinity;
  z[1] = Infinity;
  for (let q = 1; q < n; q++) {
    let sx: number;
    for (;;) {
      const vk = v[k];
      sx = ((f[q] + q * q) - (f[vk] + vk * vk)) / (2 * q - 2 * vk);
      if (sx <= z[k] && k > 0) k--;
      else break;
    }
    k++;
    v[k] = q;
    z[k] = sx;
    z[k + 1] = Infinity;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++;
    const vk = v[k];
    d[q] = (q - vk) * (q - vk) + f[vk];
  }
}

/** 상자 흐림 세 번으로 가우시안(σ)을 근사한다 — 분리형·이동합이라 σ 와 무관하게 픽셀당 상수 비용.
 *  가장자리는 끝 값을 늘려 쓴다. σ 가 1 미만이면 아무것도 안 한다 */
export function blurField(a: Float32Array, w: number, h: number, sigma: number) {
  if (sigma < 1) return;
  // 상자 세 번의 분산 3·(m²−1)/12 = σ² → 상자 폭 m
  const m = Math.max(3, Math.round(Math.sqrt((4 * sigma * sigma) / 1 + 1)) | 1);
  const r = m >> 1;
  const tmp = new Float32Array(Math.max(w, h));
  const pass = (len: number, get: (i: number) => number, put: (i: number, v: number) => void) => {
    let sum = 0;
    for (let i = -r; i <= r; i++) sum += get(Math.min(len - 1, Math.max(0, i)));
    for (let i = 0; i < len; i++) {
      tmp[i] = sum / m;
      sum += get(Math.min(len - 1, i + r + 1)) - get(Math.max(0, i - r));
    }
    for (let i = 0; i < len; i++) put(i, tmp[i]);
  };
  for (let n = 0; n < 3; n++) {
    for (let y = 0; y < h; y++) pass(w, (x) => a[y * w + x], (x, v) => { a[y * w + x] = v; });
    for (let x = 0; x < w; x++) pass(h, (y) => a[y * w + x], (y, v) => { a[y * w + x] = v; });
  }
}

/** 2차원 제곱 거리 — 픽셀마다 `inside === target` 인 가장 가까운 픽셀까지. 대상이 없으면 전부 INF */
export function edt(inside: Uint8Array, w: number, h: number, target: number): Float32Array {
  const INF = 1e12;
  const out = new Float32Array(w * h);
  const n = Math.max(w, h);
  const f = new Float32Array(n), d = new Float32Array(n), v = new Int32Array(n), z = new Float32Array(n + 1);
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) f[y] = inside[y * w + x] === target ? 0 : INF;
    edt1d(f, h, d, v, z);
    for (let y = 0; y < h; y++) out[y * w + x] = d[y];
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) f[x] = out[y * w + x];
    edt1d(f, w, d, v, z);
    for (let x = 0; x < w; x++) out[y * w + x] = d[x];
  }
  return out;
}

/** ★★**속을 재는 굵기의 상한** (원본 px). 경계 안쪽의 옅어짐과 가장자리 흔들림이 굵기(R)에 비례해서, 두꺼운
 *  영역은 칠한 안쪽이 듬성듬성 옅어졌다 (실측: 반지름 400 원의 안쪽 8% 가 90% 미만). 이보다 두꺼우면 이 굵기로 잰다. */
export const THICK_CAP = 50;

/** 속을 잴 굵기 — 굵기의 반 `R`(격자 px)을 상한(`THICK_CAP`, 원본 px)으로 자른다 */
export const capThick = (R: number, gridPerImage: number) => Math.min(R, THICK_CAP * gridPerImage);

/** ★★**경계 밖 자락은 굵기와 상관없이 하나다** — 지름 40px 붓 한 획의 자락 (굵기의 반 20px, 원본 px).
 *  사용자 지적 2026-11-19: *"한 획으로 원을 그렸을 때랑, 그 원 내부를 채웠을 때랑, 테두리 경계가 다름"*.
 *  자락을 굵기로 재면 같은 바깥 경계라도 안을 채우는 순간 굵기가 늘어 안개가 더 멀리 간다
 *  (실측: 40px 붓 고리 29px → 안을 채우면 65px, 14px 붓 고리 11px → 65px). 그래서 경계 밖은 칠한 경계까지의
 *  거리만으로 정한다 — 가는 획은 전보다 넓게, 두꺼운 영역 · 큰 상자는 전보다 좁게, 기본 붓 한 획은 그대로다. */
export const HALO_R = 20;

/** 경계 밖 자락의 배율 (`cloudScale` 을 `HALO_R` 의 굵기로) */
export const haloScale = () => cloudScale(2 * HALO_R);

/** 구름이 칠한 경계 밖으로 뻗을 수 있는 최대 거리 — `gridPerImage` 배율의 px (격자를 이만큼 넓혀 잡는다) */
export function haloReach(gridPerImage: number, shift = 0) {
  return (FADE_END + 0.25) * haloScale() * HALO_R * gridPerImage + shift + 2;
}

export type RegionCloud = {
  w: number; h: number;
  /** 굵기의 반 (격자 px) */
  R: number;
  /** 속을 재는 굵기의 반 (격자 px) — `R` 을 상한으로 자른 것 (`capThick`) */
  Rc: number;
  /** 배율 (`cloudScale(2·Rc)`) */
  k: number;
  /** 경계 밖 자락의 길이 단위 (격자 px) — `haloScale() · HALO_R` 을 격자로 옮긴 것. 굵기와 상관없다 */
  halo: number;
  /** 밖거리 − 안거리 (격자 px). 안이면 음수. 안은 흐린 값, 밖은 실제 거리 */
  signed: Float32Array;
  /** 칠한 픽셀(1) — 안과 밖의 셈을 가른다. ★흐린 안쪽 값은 모서리에서 양수가 될 수 있어 부호로는 못 가른다 */
  inside: Uint8Array;
  /** 상자 모양이면 v2 타원의 덮임 셈(u = 타원 거리 / k), 아니면 null — 셈한 u 와 둘 중 큰 쪽을 쓴다 */
  ell: Float32Array | null;
  /** 가장자리 노이즈 밭 (`noiseField` 의 `en`, res×res) — 판과 같은 밭을 읽는다 */
  en: Float32Array;
  res: number;
  /** 격자 px → 밭 px 배율 */
  fieldScale: number;
  /** 윤곽 흔들림 세기 (부드럽게가 클수록 약하다, v2) */
  strength: number;
  /** 경계를 밖으로 미는 몫 (양수 「범위」, 격자 px) */
  shift: number;
  /** 알파 경사 시작점 (`fadeStartOf`) */
  start: number;
};

/** 영역 구름 준비 — 거리장을 만들고 굵기를 잰다. `inside` 는 격자에서 칠해진 픽셀(1).
 *  `thickPx` 를 주면 굵기의 반을 그 값으로 못 박는다 (격자 px). 안 주면 안쪽 거리의 최대 */
export function prepRegion(
  inside: Uint8Array, w: number, h: number, seed: number, feather: number, gridPerImage: number, shift = 0, start = FADE_START,
): RegionCloud {
  const dOut = edt(inside, w, h, 1);
  const dIn = edt(inside, w, h, 0);
  const signed = new Float32Array(w * h);
  let rMax = 0;
  for (let i = 0; i < w * h; i++) {
    const o = Math.sqrt(dOut[i]), n = Math.sqrt(dIn[i]);
    // 안쪽 픽셀은 자기 자리에서 0.5px 만큼 더 안이라 본다 (가장자리 픽셀의 안거리가 0 이 아니게)
    signed[i] = inside[i] ? -(n) : o;
    if (inside[i] && n > rMax) rMax = n;
  }
  const R = Math.max(1, rMax);
  // ★속은 상한으로 자른 굵기로 잰다 (`THICK_CAP`). 흐림 · 상자 타원 · 배율 · 노이즈 파장이 모두 이 값을 쓴다.
  //   경계 밖 자락은 굵기와 상관없다 (`HALO_R`)
  const Rc = Math.max(1, capThick(R, gridPerImage));
  /* ★★거리장의 등고선 모서리를 둥글린다 (사용자 지적 2026-09-06: *"박스는 X 자로 줄어들어. 대각선 부분만 좀 더
     진하게 남아 있음"*). 상자 안쪽 거리는 「가장 가까운 변까지」라 등고선이 모서리가 뾰족한 작은 사각형들이고,
     같은 반지름의 원으로 보면 대각선 쪽이 더 깊어 속이 X 자로 남는다. 부호 있는 거리장을 굵기의 반(σ = R/2)
     으로 흐리면 등고선의 모서리가 둥글어져 상자도 원처럼 줄어든다. 곧은 변에서는 값이 그대로다 (경계 0 유지). */
  blurField(signed, w, h, Rc / 2);
  // ★밖은 흐리지 않은 **실제 거리**로 되돌린다 — 경계 밖 자락은 칠한 경계까지의 거리만으로 정한다 (`HALO_R`).
  //   흐린 값은 둥근 영역의 밖에서 거리를 부풀려(볼록한 꼴) 같은 바깥 경계라도 굵기마다 자락이 달라졌다
  for (let i = 0; i < w * h; i++) if (!inside[i]) signed[i] = Math.sqrt(dOut[i]);
  const k = cloudScale((2 * Rc) / gridPerImage);
  /* ★★**상자 모양이면 v2 타원 거리를 겹친다** (둘 중 큰 쪽). 흐림만으로는 정사각형의 속이 여전히 대각선 쪽이
     더 깊었고(같은 반지름에서 축 117 : 대각선 136), 흐림을 굵기만큼 키우면 변의 덮임이 떨어졌다(255 → 223).
     v2 의 타원(경계 상자에 내접, 짧은 변으로 정규화)을 max 로 겹치면 변 위는 그대로(255)고 모서리만 v2 처럼
     깎여 속이 타원으로 줄어든다 — 찾은 상자·사각 붓 한 점이 여기 든다. 상자 판정: 칠한 픽셀이 경계 상자의 95%
     이상이고 비율 3 이내. 붓 획(둥근 끝·길쭉한 띠·ㄴ 자)은 여기 안 들어 거리장 그대로다.
     ★겹치는 것은 **덮임의 셈(u) 위에서**다 — 타원의 u 는 v2 그대로 `타원 거리 / k` 다. 거리로 겹치면 모서리의 양수
       거리가 경계 밖 자락의 셈(`HALO_R`)을 타서, 큰 상자일수록 모서리가 더 깎였다. */
  let ell: Float32Array | null = null;
  {
    let bx0 = w, by0 = h, bx1 = -1, by1 = -1, n = 0;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (inside[y * w + x]) {
      n++; if (x < bx0) bx0 = x; if (x > bx1) bx1 = x; if (y < by0) by0 = y; if (y > by1) by1 = y;
    }
    const bw = bx1 - bx0 + 1, bh = by1 - by0 + 1;
    if (n > 0 && n >= 0.95 * bw * bh && Math.max(bw, bh) <= 3 * Math.min(bw, bh)) {
      const hw = bw / 2, hh = bh / 2, cx = bx0 + hw, cy = by0 + hh;
      ell = new Float32Array(w * h);
      for (let y = 0; y < h; y++) {
        const dy = (y + 0.5 - cy) / hh;
        for (let x = 0; x < w; x++) {
          const dx = (x + 0.5 - cx) / hw;
          ell[y * w + x] = Math.sqrt(dx * dx + dy * dy) / k;
        }
      }
    }
  }
  const ff = 1 + Math.min(50, Math.max(0, feather)) / 25;
  // 판에서는 ns = 판 긴 변/2 · ff. 판 긴 변 ≈ 구름 박스(2R·k) × (1+2·EXPAND) 의 1.5배로 본다
  const ns = ((2 * Rc * k * (1 + 2 * EXPAND) * 1.5) / 2) * ff;
  const strength = 1 - Math.min(50, Math.max(0, feather)) / 62.5;
  /* ★노이즈는 픽셀마다 새로 셈하지 않고 **판과 같은 밭**을 읽는다 (`noiseField`, 씨앗·부드럽게마다 한 번 굽고
     캐시). 픽셀마다 세 옥타브를 돌리면 200×120 격자에 50ms 였다 — 손을 뗀 프레임이 튄다. 밭의 축척은
     `res/2·ff` 이므로 격자 px 를 그 비로 밭 px 로 옮겨 읽는다 (밭보다 넓으면 거울처럼 접어 이어 붙인다). */
  const res = 256;
  const field = noiseField(seed, feather, res);
  const halo = haloScale() * HALO_R * gridPerImage;
  return { w, h, R, Rc, k, halo, signed, inside, ell, en: field.en, res, fieldScale: ((res / 2) * ff) / ns, strength, shift, start };
}

/** 줄 `y0..y1` 의 덮임을 채운다 (배경 굽기가 몇 줄씩 나눠 부른다). `out` 은 `w*h` */
export function regionCoverRows(c: RegionCloud, y0: number, y1: number, out: Uint8Array) {
  const { w, Rc: R, k, halo, signed, inside, ell, en, res, fieldScale, strength, shift, start } = c;
  const kR = k * R;
  const ub = 1 / k;
  const amp = 0.25 * strength;
  const period = 2 * res;
  // 거울 접기 — 밭 밖으로 나가면 되돌아온다 (경계에서 값이 이어진다)
  const fold = (v: number) => { let m = v % period; if (m < 0) m += period; return m < res ? m : period - 1 - m; };
  for (let y = y0; y < y1; y++) {
    const fy = fold(Math.floor(y * fieldScale)) * res;
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      /* 안은 굵기로 (가운데 0 · 경계 1/k), 밖은 경계에서 이어 **경계까지의 거리**로 (`HALO_R` 의 ★★주).
         경계에서 두 셈이 같은 값(1/k)이라 이어진다 */
      const d = signed[i] - shift;
      let u = inside[i] || d <= 0 ? (R + d) / kR : ub + d / halo;
      if (ell && ell[i] > u) u = ell[i];
      // 노이즈로도 못 넘는 자리는 셈을 건너뛴다 — 깊은 속은 100%, 먼 밖은 0
      if (u >= FADE_END + amp + 0.01) { out[i] = 0; continue; }
      if (u < start - amp - 0.01) { out[i] = 255; continue; }
      const warped = u + en[fy + fold(Math.floor(x * fieldScale))] * amp;
      let a = 0;
      if (warped < start) a = 255;
      else if (warped < FADE_END) {
        const t = (warped - start) / (FADE_END - start);
        a = Math.round((1 - t * t * (3 - 2 * t)) * 255);
      }
      out[i] = a;
    }
  }
}

