import type { GenParams } from "../store/gen";

/** 스타일 카드가 함께 담는 **설정** — 두 묶음이다.
 *
 *  ① **프롬프트가 되는 넷** (`PROMPT_OPT_KEYS`) — 생성 옵션 칸에 있지만 서버에서
 *     **실제 프롬프트 문자열이 된다** (`backend/nai.py`):
 *
 *      quality_preset   프롬프트 **뒤**에 붙는 태그 (`QUALITY_PRESETS`)
 *      uc_preset        네거티브 **앞**에 붙는 본문 (`UC_PRESETS`)
 *      transparent_bg   퀄리티 접미사 **앞**에 `transparent background`
 *      furry_mode       프롬프트 **맨 앞**에 `fur dataset, `
 *
 *     ★★이것들이 카드 밖에 남아 있으면 **같은 스타일 카드가 다른 그림을 낸다** —
 *       퀄리티 프리셋을 `none` 으로 두고 만든 스타일을 `standard` 상태에서 꺼내면
 *       없던 퀄리티 태그가 얹힌다 (사용자 지적 2026-08-22).
 *     ★공홈도 이 넷을 **프롬프트 영역**에 둔다 (`docs/nai-web-reference.md` 2절).
 *
 *  ② **생성 옵션 일곱** (`GEN_OPT_KEYS`) — 화면의 「생성 옵션」 묶음 그대로다
 *     (사용자 지시 2026-09-21). 프롬프트에 한 글자도 안 보태고 샘플러와 모델에만 들어간다.
 *
 *     ★★**해상도와 저장 옵션은 안 담는다.** 각각 다른 묶음이고, 스타일이 해상도를 정하는
 *       것은 아니다.
 *     ★★**모델도 담는다.** 모델이 바뀌면 Anlas 단가와 쓸 수 있는 기능(Vibe·Precise
 *       Reference)까지 함께 바뀌지만, 같은 프롬프트라도 모델이 다르면 그림이 아주 달라진다 —
 *       스타일을 되살리는 데 가장 크게 걸리는 값이다. **말없이 바뀌지 않게** 거는 쪽에서
 *       시트를 띄워 고르게 한다 (`store/stylePick`).
 *     ★~~예전에는 이 일곱을 안 담았다~~ — "담으면 카드 드롭이 「프롬프트를 이 스타일로
 *       바꾼다」에서 「화면 여기저기가 바뀐다」로 성질이 달라진다"가 이유였는데, 무엇을 덮을지
 *       사용자가 고르게 되면서 그 이유가 없어졌다.
 *
 *  ★★이 파일은 **스토어를 안 부른다** — 규칙만 둔다. 그래야 회귀 테스트가 값으로 확인한다
 *    (스토어를 부르면 `localStorage` 때문에 node 에서 못 읽는다). 스토어에 읽고 쓰는 것은
 *    쓰는 자리(`panels/PromptSections`·`lib/applyCard`)가 한다.
 */
export type StyleOpts = Partial<
  Pick<
    GenParams,
    | "quality_preset" | "uc_preset" | "transparent_bg" | "furry_mode"
    | "model" | "variety_plus" | "steps" | "cfg" | "cfg_rescale" | "sampler" | "scheduler"
  >
>;

/** ★목록은 **여기 하나**다. 담는 쪽과 거는 쪽이 다른 표를 보면 한쪽만 늘어난다. */
export const PROMPT_OPT_KEYS = ["quality_preset", "uc_preset", "transparent_bg", "furry_mode"] as const;
export const GEN_OPT_KEYS = ["model", "variety_plus", "steps", "cfg", "cfg_rescale", "sampler", "scheduler"] as const;
export const STYLE_OPT_KEYS = [...PROMPT_OPT_KEYS, ...GEN_OPT_KEYS] as const;

/** 카드를 걸 때 무엇을 덮을지 — 시트가 고르게 하고, 조수는 둘 다 켠 채로 부른다 */
export type StylePick = { prompt: boolean; gen: boolean };
export const PICK_BOTH: StylePick = { prompt: true, gen: true };

const KEYS_OF: Record<keyof StylePick, readonly (keyof StyleOpts)[]> = {
  prompt: PROMPT_OPT_KEYS,
  gen: GEN_OPT_KEYS,
};

/** 지금 값에서 **카드에 담을 것만** 골라낸다 (덱에 저장할 때) */
export function pickStyleOpts(params: GenParams): StyleOpts {
  const o: StyleOpts = {};
  for (const k of STYLE_OPT_KEYS) (o as Record<string, unknown>)[k] = params[k];
  return o;
}

/** 카드에 담겨 온 것 중 **실제로 바뀌는 것만** 골라낸다 (스타일 카드를 놓았을 때).
 *
 *  ★★**있는 것만 덮는다.** 옛 카드에는 이 값이 아예 없다 — 없는 것을 기본값으로 메우면
 *    사용자가 잡아 둔 프리셋이 카드 하나 놓을 때마다 말없이 되돌아간다
 *    (`lib/metaApply` 가 지키는 것과 같은 규칙).
 *  ★같은 값이면 안 담는다 — 부르는 쪽이 「바뀐 것이 있나」로 알림 여부를 정한다.
 *  ★`groups` 를 주면 그 묶음만 본다 (시트에서 끈 묶음은 안 덮는다). */
export function styleOptsPatch(
  cur: StyleOpts,
  o: StyleOpts | undefined,
  groups: readonly (keyof StylePick)[] = ["prompt", "gen"],
): StyleOpts {
  const patch: StyleOpts = {};
  if (!o) return patch;
  for (const g of groups)
    for (const k of KEYS_OF[g]) {
      const v = o[k];
      if (v === undefined || v === cur[k]) continue;
      (patch as Record<string, unknown>)[k] = v;
    }
  return patch;
}

/** 시트에 보여 줄 줄 — **담긴 값과 「지금과 같은가」**.
 *
 *  ★★같은 값도 **지우지 않고 표시한다** (사용자 지시 2026-09-21). 빼 버리면 카드에 무엇이
 *    담겨 있는지가 지금 화면 상태에 따라 달라 보인다. */
export function styleOptRows(
  cur: StyleOpts,
  o: StyleOpts | undefined,
  group: keyof StylePick,
): { key: keyof StyleOpts; value: unknown; same: boolean }[] {
  if (!o) return [];
  const rows: { key: keyof StyleOpts; value: unknown; same: boolean }[] = [];
  for (const k of KEYS_OF[group]) {
    const v = o[k];
    if (v === undefined) continue;
    rows.push({ key: k, value: v, same: v === cur[k] });
  }
  return rows;
}
