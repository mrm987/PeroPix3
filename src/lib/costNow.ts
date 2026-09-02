/** **지금 누르면 얼마인가** — 화면 상태에서 Anlas 값을 낸다 (2026-08-24).
 *
 *  ★★**창구를 하나로 두려고 뽑았다.** 이 조립(모델·나가는 크기·Opus 잔량·바이브·참조·
 *    인페인트 강도)은 `GenerateFooter` 안에만 있었는데, **조수의 승인 카드도 같은 값**이
 *    필요해졌다 (자동 승인이 「Anlas 가 나가는가」로 갈린다 — 사용자 결정 2026-08-24).
 *    베껴 두면 푸터에 보이는 값과 승인 카드에 뜨는 값이 조용히 갈린다.
 *
 *  ★산식 자체는 여기 없다 — 그것은 `lib/anlas.ts` 하나다. 여기는 **어느 값을 넘기는지**만 안다.
 *  ★훅이 아니라 함수다: 화면은 그리는 중에, 액션은 아무 때나 부른다.
 */

import { anlasCost, type Cost } from "./anlas.ts";
import { modelCaps, useGen } from "../store/gen";
import { useImageInput } from "../store/imageInput";
import { useSub } from "../store/sub";
import { allScenes, useWs } from "../store/workspace";
import { useUi } from "../store/ui";

/** 지금 세트에서 **한 바퀴에 나가는 장 수** — 잠긴 씬·잠긴 카드는 빠진다.
 *
 *  ★★세는 규칙이 `gen.ts generateAll` 과 **같아야** 한다 (`!cell.locked && !card.locked`).
 *    한때 씬 잠금만 세어 푸터가 실제보다 많이 세고 비용도 부풀었다. */
export function slotsNow(): number {
  const tab = useWs.getState().activeSceneGroup();
  if (tab?.kind !== "sceneGroup") return 1;
  return allScenes(tab).filter((x) => !x.cell.locked && !x.card.locked).length;
}

/** 한 바퀴가 실제로 만드는 장 수 = 잠기지 않은 씬 × 슬롯당 장수.
 *  ★★`perSlot` 을 빼먹으면 조수가 "10장"이라고 해 놓고 30장이 나간다 (시뮬레이션 구멍 B). */
export const countNow = (rounds = 1): number =>
  slotsNow() * useUi.getState().perSlot * Math.max(1, rounds);

/** 지금 설정으로 `rounds` 바퀴 돌 때의 값. ★`free` 가 참이면 **돈이 안 나간다**. */
export function costNow(rounds = 1): Cost {
  const params = useGen.getState().params;
  const img = useImageInput.getState();
  // ★지금 워크스페이스의 **계정** 것이다 — 계정마다 티어·Opus 잔량이 다르다 (`store/sub`)
  const sub = useSub.getState().current();
  const cap = modelCaps(params.model);
  // ★해상도 칸이 아니라 **나가는 크기**로 센다 (Focused 인페인트는 서버가 1MP 로 키운다)
  const size = img.costSize();
  const usage = (sub?.tier ?? 0) >= 3 ? (sub?.usage ?? null) : null;
  return anlasCost({
    model: params.model,
    width: size.width,
    height: size.height,
    steps: params.steps,
    opus: (sub?.tier ?? 0) >= 3,
    opusExhausted: !!usage?.isNegative,
    // ★그 모델이 지원하지 않으면 안 나간다 — 능력표로 막아야 보내는 것과 표시가 같아진다
    uncachedVibes: cap.vibe && img.vibeOn ? img.vibes.filter((v) => !v.encoded).length : 0,
    activeVibes: cap.vibe && img.vibeOn ? img.vibes.length : 0,
    refCount: cap.char_ref && img.refOn ? img.refs.length : 0,
    inpaint: img.costInpaint(),
    strength: img.costStrength(),
    count: countNow(rounds),
  });
}
