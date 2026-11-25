/** 모델 목록과 **능력표** — 화면이 「이 모델에서 되는 것만」 보이게 하는 근거.
 *
 *  정본은 `docs/nai-web-reference.md` 의 「NAI Diffusion V5」 절이고, 공홈 번들의
 *  `PE(model)` 에서 우리가 실제로 쓰는 항목만 추린 것이다 (2026-08-21 전수 대조).
 *
 *  ★★**모델 분기를 이 파일 밖에서 새로 만들지 말 것.** V5 가 오면서 「바이브 되나 ·
 *    스케줄러 고를 수 있나 · Variety+ 되나」가 전부 갈라졌다. 화면 여기저기에
 *    `model.includes("4-5")` 같은 검사를 흩어 두면 하나를 빠뜨렸을 때 **컨트롤은 보이는데
 *    보내지지는 않는** 상태가 된다 — 사용자는 켰다고 믿고 결과만 다르게 나온다.
 *
 *  ★★서버 쪽 사본은 `backend/nai.py` 의 `MODEL_CAPS` 다. 언어가 달라 한 벌로 못 두는 대신
 *    **`backend/test_caps_parity.py` 가 두 파일을 대조**한다 — 한쪽만 고치면 판정이 깨진다.
 */

export type ModelCaps = {
  /** Vibe Transfer */
  vibe: boolean;
  /** Precise Reference (`director_reference_*`) */
  char_ref: boolean;
  /** 인페인트(마스크를 싣는 생성)에도 레퍼런스가 실리나 (공홈 `charRefInpainting`) */
  char_ref_inpaint: boolean;
  /** Fidelity 를 받나 (`characterReferenceFidelity`). 거짓이면 칸을 숨기고 서버가 1 로 보낸다 */
  char_ref_fidelity: boolean;
  /** Strength 슬라이더 끝 (`characterReferenceStrengthMax`). 칸에 적으면 넘겨 넣을 수 있다 */
  char_ref_strength_max: number;
  /** Outfit 레퍼런스와 「Prefer same outfit」 (`outfitReferences`) */
  outfit_refs: boolean;
  /** 스케줄러를 고를 수 있나 — 거짓이면 서버가 karras 로 덮어쓴다 */
  noise_schedule: boolean;
  cfg_rescale: boolean;
  /** Variety+ (`skip_cfg_above_sigma`) */
  cfg_delay: boolean;
  /** 투명 배경 */
  transparency: boolean;
  /** Enhance 가 프롬프트에 `-2::upscaled, blurry::` 를 끼우나 */
  enhance_prompt_add: boolean;
  /** 따옴표 → `teXt:` 자동 조립이 걸리나 (공홈 `PE().text`).
   *  ★★**V5 전용이 아니다** — V4.0·V4.5·V5 모두 참이고 V3 이하만 거짓이다.
   *  ★조립은 서버가 한다 (`backend/naitext.py`) — 화면은 안내 문구에만 쓴다. */
  text: boolean;
  /** 캐릭터 좌표를 격자 밖에 둘 수 있나 */
  freeform_position: boolean;
  max_characters: number;
  cfg_delay_sigma: number;
  /** Opus 무료 생성이 유한한가 (잔량이 바닥나면 과금된다) */
  opus_usage_limit: boolean;
  /** Anlas 배율 — ★V5 는 같은 해상도·스텝에서 V4.5 의 1.5배다 */
  anlas_multiplier: number;
  /** 요금을 **따로 세는 식** — 있으면 `(C_BASE·px + C_STEP·px·steps) / divisor` 이고 올림하지 않는다.
   *  V5 Full Medium 이 `{ steps: 23, divisor: 1.75 }` 다 (공홈 번들 `b2fe159` 2026-11-25. 그 전 `b0f9d00` 은 스텝 항에 `1/1.06521739`) */
  anlas_formula: { steps: number; divisor: number } | null;
  /** 보내기 직전에 덮는 설정 (공홈 `fixedSettings`) — 있으면 스텝·샘플러·UC 프리셋이 고정이고
   *  사용자 UC·캐릭터 UC 가 나가지 않는다. 화면은 그 칸을 숨긴다. 덮는 것은 서버다 (`backend/nai.py` `build_payload`) */
  fixed: { steps: number; sampler: string; uc_preset_id: string } | null;
  /** 고를 수 있는 퀄리티 프리셋 id — **순서가 곧 드롭다운 순서**이고 마지막은 언제나 none.
   *  ★본문(접미사)은 서버 표에만 있다 (`backend/nai.py` `QUALITY_PRESETS`) —
   *    화면은 고를 목록만 알면 되고, 프롬프트를 만드는 것은 서버 한 곳이다. */
  quality_presets: string[];
};

const V45: ModelCaps = {
  vibe: true,
  char_ref: true,
  char_ref_inpaint: true,
  char_ref_fidelity: true,
  char_ref_strength_max: 1,
  outfit_refs: false,
  noise_schedule: true,
  cfg_rescale: true,
  cfg_delay: true,
  transparency: false,
  enhance_prompt_add: true,
  text: true,
  freeform_position: false,
  max_characters: 6,
  cfg_delay_sigma: 58,
  opus_usage_limit: false,
  anlas_multiplier: 1,
  anlas_formula: null,
  fixed: null,
  quality_presets: ["standard", "none"],
};

/** ★★V5 에서 **꺼진 것들**. 공홈 FAQ: 바이브·정밀 참조는 "post-launch additions" 다.
 *  ★정밀 참조는 2026-11 에 들어왔다 (번들 `b2fe159`). 바이브는 아직 없다. */
const V5: ModelCaps = {
  ...V45,
  vibe: false,
  char_ref_inpaint: false,
  char_ref_fidelity: false,
  char_ref_strength_max: 5,
  outfit_refs: true,
  noise_schedule: false,
  cfg_delay: false,
  transparency: true,
  freeform_position: true,
  max_characters: 32,
  opus_usage_limit: true,
  anlas_multiplier: 1.5,
  // ★V5·custom 만 `light` 가 있다 ("very aesthetic, amazing quality, no text")
  quality_presets: ["standard", "light", "none"],
};

/** ★★V5 Full **Medium** (공홈 「Effort: Medium」, 번들 `b0f9d00` 2026-10-12 대조). V5 Full 과 같고 CFG Rescale 만 없으며
 *  스텝 14 · `k_euler_ancestral` · UC 프리셋 heavy 로 고정된다. 사용자 UC 와 캐릭터 UC 는 나가지 않는다. */
const V5_MEDIUM: ModelCaps = {
  ...V5,
  cfg_rescale: false,
  anlas_formula: { steps: 23, divisor: 1.75 },
  fixed: { steps: 14, sampler: "k_euler_ancestral", uc_preset_id: "heavy" },
};

/** 인페인트 모델 → 원본 (표 조회용). ★`INPAINT_MODEL` 을 뒤집어 쓰면 안 된다 — 일대일이 아니다 */
const BASE_MODEL: Record<string, string> = {
  "nai-diffusion-5-full-inpainting": "nai-diffusion-5-full",
  "nai-diffusion-5-full-medium-inpainting": "nai-diffusion-5-full-medium",
  "nai-diffusion-5-curated-inpainting": "nai-diffusion-5-curated",
  "nai-diffusion-4-5-full-inpainting": "nai-diffusion-4-5-full",
  "nai-diffusion-4-5-curated-inpainting": "nai-diffusion-4-5-curated",
  "nai-diffusion-4-full-inpainting": "nai-diffusion-4-full",
  "nai-diffusion-4-curated-inpainting": "nai-diffusion-4-curated-preview",
};

export const MODEL_CAPS: Record<string, ModelCaps> = {
  "nai-diffusion-5-full": V5,
  "nai-diffusion-5-full-medium": V5_MEDIUM,
  "nai-diffusion-5-curated": V5,
  "nai-diffusion-4-5-full": V45,
  "nai-diffusion-4-5-curated": V45,
};

/** ★모르는 모델(= 목록에서 뺀 V4.0 계열)의 능력. 공홈의 V4.0 행 그대로다 */
export const CAPS_FALLBACK: ModelCaps = {
  ...V45,
  char_ref: false,
  enhance_prompt_add: false,
  cfg_delay_sigma: 19,
};

export const baseModel = (model: string): string => BASE_MODEL[model] ?? model;

/** 인페인트에서 **실제로 그리는 모델** (공홈 `el()`) — 서버 `INPAINT_MODEL` 과 같은 표다 (`test_caps_parity.py`).
 *  ★V5 Curated 는 V4.5 Curated 인페인트로 간다. 그래서 그 인페인트의 레퍼런스는 V4.5 규칙을 따른다 (`refCaps`) */
const INPAINT_MODEL: Record<string, string> = {
  "nai-diffusion-5-full": "nai-diffusion-5-full-inpainting",
  "nai-diffusion-5-full-medium": "nai-diffusion-5-full-medium-inpainting",
  "nai-diffusion-5-curated": "nai-diffusion-4-5-curated-inpainting",
  "nai-diffusion-4-5-full": "nai-diffusion-4-5-full-inpainting",
  "nai-diffusion-4-5-curated": "nai-diffusion-4-5-curated-inpainting",
  "custom": "custom",
};
const INPAINT_MODEL_DEFAULT = "nai-diffusion-4-5-curated-inpainting";
export const inpaintModel = (model: string): string =>
  model.endsWith("-inpainting") ? model : (INPAINT_MODEL[model] ?? INPAINT_MODEL_DEFAULT);

/** ★★레퍼런스 규칙을 볼 능력 — 인페인트(마스크가 실리는 생성)면 **그 인페인트 모델**의 것이다 (서버 `nai.ref_model`).
 *  공홈은 인페인트 요청을 인페인트 모델 이름으로 조립하므로 그 모델의 능력으로 거른다 */
export const refCaps = (model: string, masked: boolean): ModelCaps => caps(masked ? inpaintModel(model) : model);

/** 그 모델의 능력. 인페인트 모델도 원본으로 되돌려 조회한다. */
export const caps = (model: string): ModelCaps => MODEL_CAPS[baseModel(model)] ?? CAPS_FALLBACK;

/** ★**V4.5 계열과 V5 계열을 제공한다.**
 *
 *  ★V4.0 은 뺐다 (사용자 결정 2026-08-12). 옛 워크스페이스가 V4.0 id 를 들고 있으면
 *    목록에 없어 빈칸으로 보이므로 화면이 기본값으로 되돌린다 — 조용히 다른 표로
 *    생성되는 것보다 낫다.
 *  ★목록 순서가 곧 드롭다운 순서다. 공홈은 V5 를 「New」로 맨 위에 둔다. */
export const MODELS: [string, string][] = [
  ["nai-diffusion-5-full", "V5 Full"],
  ["nai-diffusion-5-curated", "V5 Curated"],
  ["nai-diffusion-4-5-full", "V4.5 Full"],
  ["nai-diffusion-4-5-curated", "V4.5 Curated"],
];

/** ★★Effort 짝 — **High 모델 → Medium 모델** (공홈 `u()`·`h()`). 모델 칸에는 High 쪽이 보이고,
 *  짝이 있는 모델일 때만 그 옆에 Effort 토글이 선다 (공홈과 같은 자리). Medium 은 목록(`MODELS`)에 없다. */
const MEDIUM_OF: Record<string, string> = { "nai-diffusion-5-full": "nai-diffusion-5-full-medium" };
const HIGH_OF: Record<string, string> = Object.fromEntries(Object.entries(MEDIUM_OF).map(([h, m]) => [m, h]));

/** 모델 칸에 보일 값 — Medium 이면 그 High 쪽 */
export const highModel = (model: string): string => HIGH_OF[model] ?? model;
/** ★★**실제로 나가는 모델** — Precise Reference 가 실리면 Medium 은 High 로 나간다 (공홈 `effortForcedByPreciseReference`:
 *  「Precise Reference needs High effort」). `refs` 는 실리는 레퍼런스 수다 (`store/imageInput` 의 `riding`).
 *  ★보내는 쪽은 서버가 같은 규칙으로 바꾼다 (`backend/nai.py` 의 `EFFORT_HIGH`). 화면은 이것으로 요금·칸·Effort 를 맞춘다 */
export const sentModel = (model: string, refs: number): string => (refs > 0 ? highModel(model) : model);
/** 그 모델의 Effort — 짝이 없으면 null (토글을 안 낸다) */
export const effortOf = (model: string): "medium" | "high" | null =>
  HIGH_OF[model] ? "medium" : MEDIUM_OF[model] ? "high" : null;
/** Effort 를 바꾼 모델 id */
export const withEffort = (model: string, effort: "medium" | "high"): string => {
  const high = highModel(model);
  return effort === "medium" ? (MEDIUM_OF[high] ?? model) : high;
};
/** ★목록에 없는 모델을 기본값으로 되돌리는 검사들이 쓴다 — Medium 도 아는 모델이다 */
export const isKnownModel = (model: string): boolean => MODELS.some(([id]) => id === highModel(model));
