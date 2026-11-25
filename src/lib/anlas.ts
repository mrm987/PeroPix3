/** Anlas 소모량 — 정본은 `docs/nai-web-reference.md` 9절 (공홈 번들 추출).
 *
 *  ★서버를 부르지 않는다. 순수 계산이라 값이 바뀔 때마다 왕복할 이유가 없다.
 *  ★예전 구현은 `ceil(픽셀/1MP × 20)` 이라는 **근사식**이었다 — 공홈 식이 아니라 실제
 *    청구와 어긋났다. 특히 steps 를 나중에 곱해서 28 을 넘는 순간부터 크게 틀렸다.
 *  ★비용은 **정렬된 해상도**로 세야 한다 (`alignTo64`) — 부르는 쪽에서 정렬해 넘긴다. */
import { alignTo64 } from "./align.ts";
import { caps } from "./naiModels.ts";

/** 공홈 `getPrice` 상수 */
const C_BASE = 2.951823174884865e-6;
const C_STEP = 5.753298233447344e-7;
/** Opus 무료 판정 상한 (공홈 `eZ`) */
const FREE_PIXELS = 1048576;
const FREE_STEPS = 28;
/** 한 장이 이 값을 넘으면 공홈은 생성 버튼을 막는다 (`g.dZ`) */
export const MAX_PER_IMAGE = 140;
/** 캐릭터 참조는 **장당** 개당 5 (Opus 무관) */
const REF_PER_IMAGE = 5;
/** vibe 인코딩은 개당 2 **고정** — 해상도와 무관하고 요청당 한 번이다 */
const VIBE_ENCODE = 2;
/** ★켜진 vibe 가 **4개를 넘으면** 초과분 개당 +2 (요청당 한 번).
 *
 *  공홈 번들(2026-08-18 내려받음)의 정의가 이것이다:
 *  `tW = 2; function tK(e){ return Math.max(0, e - 4) * tW }` — `e` 는 **켜진(enabled) 수**다.
 *  그래서 4개까지 0, 5개면 2, 7개면 6 이다.
 *  ★한때 이 값이 5 였다 (감사 D13). 문턱이 하나 어긋나 5개째가 공짜로 보였다.
 *  ★기준이 「구워지지 않은 수」가 아니라 **「켜진 수」**인 것도 함께 고친 자리다 (v2 가 그랬다) —
 *    구워 둔 것도 슬롯은 차지하므로 초과분에 들어간다. */
const VIBE_FREE_SLOTS = 4;

export type CostInput = {
  /** ★모델 id — **V5 는 배율이 1.5다.** 빠뜨리면 표시가 실제의 2/3 가 된다 */
  model?: string;
  width: number;
  height: number;
  steps: number;
  /** 티어 3 이상 */
  opus: boolean;
  /** ★★Opus 무료 **잔량이 바닥났나** (`subscription.usage.isNegative`).
   *  V5 부터 무료가 유한하다 — 바닥나면 무료가 꺼지고 정상 과금된다.
   *  ★`opusUsageLimit` 능력이 있는 모델(V5·custom)에만 걸린다. */
  opusExhausted?: boolean;
  /** ★**아직 안 구운** 바이브 수. 구워 둔 것은 다시 돈이 들지 않는다 */
  uncachedVibes: number;
  /** 지금 **켜져 있는** 바이브 수 — 4개 초과분에 요금이 붙는다 (구워 둔 것도 센다) */
  activeVibes?: number;
  refCount: number;
  /** 지금 인페인트(mask 를 실어 보내는 요청)인가 — ★켜져 있으면 바이브 비용이 통째로 0 이다 */
  inpaint?: boolean;
  /** i2i 강도. 인페인트면 `inpaintImg2ImgStrength`, 베이스 그림이 없으면 1 */
  strength: number;
  /** 이번에 만들 장 수 */
  count: number;
};

export type Cost = {
  perImage: number;
  total: number;
  free: boolean;
  encoding: number;
  /** ★한 장이 상한을 넘어 공홈이라면 생성이 막히는 상태 */
  overLimit: boolean;
};

/** 업스케일 값 — 픽셀 수 **구간**으로 정해진다 (공홈 `g`/`f`).
 *
 *  ★생성 요금과 **다른 산식**이다 — steps 도 강도도 안 본다.
 *  ★★**2026-08-21 재배포로 표가 통째로 바뀌었다** (문서 「NAI Diffusion V5」 절):
 *    상한 1MP → **3MP** · 값 1~7 → **1~4** · **Opus 무료 구간 없어짐** ·
 *    훑는 방향도 반대다(**처음 걸리는 구간**이 답. 옛 표는 마지막이 남았다).
 *    옛 기대값을 되살리지 말 것 — 백엔드(`nai.upscale_cost`)에도 같은 표가 있다.
 *  ★**-1 이면 못 한다** (공홈은 `-3`. 우리는 "알 수 없음/불가"를 음수 하나로 통일한다). */
const UPSCALE_TABLE: [number, number][] = [
  [1048576, 1],
  [1747627, 2],
  [2446678, 3],
  [3145728, 4],
];
export const UPSCALE_MAX_PX = 3145728;

/** ★`opus` 인자를 남긴다 — 지금은 값에 영향이 없지만 부르는 쪽이 여럿이고,
 *  무료가 되살아나면 여기 한 줄로 돌아온다. */
export function upscaleCost(width: number, height: number, _opus: boolean): number {
  const px = width * height;
  for (const [limit, c] of UPSCALE_TABLE) if (px <= limit) return c;
  return -1;
}

export function anlasCost(i: CostInput): Cost {
  // ★실제로 나가는 해상도로 센다 — 화면 값이 64 배수가 아니면 청구가 어긋난다
  const px = alignTo64(i.width) * alignTo64(i.height);

  // ★★**우리 구조에서는 「무료」가 곧 「전부 공짜」다** (감사 D12, 2026-08-18 공홈 번들 대조).
  //
  //   공홈은 요청 **하나**(`n_samples` 장)에서 **한 장만** 무료다:
  //     `eZ(e) && tier>=3 && active(sub) && !n && (v -= 1)`   ← `v = e.n_samples`
  //   그런데 우리는 NAI 에 **`n_samples: 1` 로 한 장씩** 보낸다 (`backend/nai.py:315`).
  //   요청마다 그 한 장이 깎이므로 배치의 **모든 장**이 무료가 되는 것이 맞다.
  //
  //   ★v2 는 여기서 틀렸다 — `total = per_sample * max(0, count-1)` 로 `n_samples-1` 을
  //     **배치 장 수**에 그대로 적용해 한 장 빼고 전부 과금했다 (`backend.py:4719-4726`).
  //     v2 도 한 장씩 보냈으므로(`backend.py:1613`) 표시가 과다 계상이었다.
  //     되돌리지 말 것. 근거는 「몇 장을 한 요청에 담느냐」 하나뿐이라, 언젠가 여러 장을
  //     한 요청으로 보내게 되면 **그때는 공홈처럼 한 장만 깎아야** 한다.
  //
  // ★★**참조비는 언제나 나가고, Opus 무료와 독립이다** (사용자 확인 2026-08-18).
  //   무료 판정이 보는 것은 **Opus·픽셀·steps 셋뿐**이다 — vibe 도 캐릭터 참조도 안 본다.
  //   Opus·832x1216·28step·참조 1개 = **5** (기본 0 + 참조 5).
  //   ★여기에 `refCount === 0` 을 넣지 말 것. 공홈 `eZ()` 의 `!characterRef` 를 보고 한 번
  //     넣었다가 참조 하나에 25 가 되어 되돌렸다 (`anlas.test.ts` 에 판정이 있다).
  // ★★공홈 원문: `D = PE(model).opusUsageLimit && (usage?.isNegative ?? false)` 이고
  //   무료 차감이 `… && !D` 다. 퍼센트가 낮다고 미리 끄지 않는다 — **바닥났을 때만**이다.
  const cap = caps(i.model ?? "");
  // ★고정 설정 모델(V5 Full Medium)은 화면의 스텝과 무관하게 **고정 스텝으로 나간다** (`ModelCaps.fixed`)
  const steps = cap.fixed?.steps ?? i.steps;
  const spent = !!i.opusExhausted && cap.opus_usage_limit;
  const free = i.opus && !spent && px <= FREE_PIXELS && steps <= FREE_STEPS;

  // ★★모델 배율 — **V5 는 1.5배**다 (공홈 `Jg(model)===v5 && (M *= 1.5)`, 2026-08-21).
  //   식은 v4/v4.5/XL 과 같고 **곱하기 하나만** 다르다. 배율을 빼면 V5 표시가 실제의 2/3 가 된다.
  //   ★Medium 은 **식이 따로다** (공홈 번들 `b2fe159` 2026-11-25): 화면 스텝과 무관하게 23 스텝으로 세고
  //     1.75 로 나누며 **올림하지 않는다** (`ModelCaps.anlas_formula`). 832x1216 이면 15 다.
  //     그 전 번들(`b0f9d00`)은 스텝 항에만 1/1.06521739 를 곱하고 올림했다 (17). 되돌리지 말 것.
  const mult = cap.anlas_multiplier;
  const f = cap.anlas_formula;
  const perSample = (f ? (C_BASE * px + C_STEP * px * f.steps) / f.divisor : Math.ceil(C_BASE * px + C_STEP * px * steps)) * mult;
  // 강도 계수 — 베이스 그림이 있을 때만 걸린다. 바닥은 2 다
  const y = i.strength < 1 ? i.strength : 1;
  // ★공홈의 `I` — **언제나 계산한다.** 무료는 값을 0 으로 만드는 것이 아니라 장 수(`v`)에서
  //   1을 빼는 것이라(`I > g.dZ ? -3 : I*v`), 무료 구간에서도 상한 판정이 살아 있어야 한다
  const perSampleCost = Math.max(Math.ceil(perSample * y), 2);
  const base = free ? 0 : perSampleCost;

  // 캐릭터 참조는 **장당** 붙는다 (무료 판정과 무관)
  const perImage = base + REF_PER_IMAGE * Math.max(0, i.refCount);

  // ★★**캐릭터 참조가 하나라도 있거나 인페인트면 바이브 비용은 통째로 0** 이다.
  //   공홈 호출부가 그 셋을 한 조건으로 묶어 두었다:
  //     `vibes.length>0 && encodedVibes && !hasCharRefs && !mask && (인코딩 합 + tK(켜진 수))`
  //   지금 v3 에서는 화면이 vibe 와 참조를 배타로 두어 참조 쪽은 저절로 0 이 되지만,
  //   **인페인트 + vibe 는 함께 나갈 수 있다** — 그 조합이 값을 부풀리던 자리다 (감사 D13).
  const vibeFree = i.refCount > 0 || !!i.inpaint;
  // vibe 인코딩·초과 슬롯은 **요청당 한 번**이지 장당이 아니다
  const over = Math.max(0, (i.activeVibes ?? 0) - VIBE_FREE_SLOTS);
  const encoding = vibeFree ? 0 : Math.max(0, i.uncachedVibes) * VIBE_ENCODE + over * VIBE_ENCODE;

  return {
    perImage,
    total: perImage * i.count + encoding,
    free: perImage === 0 && encoding === 0,
    encoding,
    // ★상한 판정은 **기본 생성비**로 한다 — 번들의 `I > g.dZ ? -3 : I*v` 에서 `I` 가
    //   `max(ceil(per_sample*y), 2)` 이고, 캐릭터 참조비는 거기 안 들어간다.
    //   ★무료라고 건너뛰지 않는다 — 공홈도 `I` 를 언제나 재서 견준다 (감사 D12).
    overLimit: perSampleCost > MAX_PER_IMAGE,
  };
}
