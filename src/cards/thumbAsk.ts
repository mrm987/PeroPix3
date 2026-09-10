import type { Thumb } from "../store/prompt";
import type { AnyCard, CardKind } from "../store/cards";
import type { DragImage } from "./dragStore";

/** 「그림 자리를 잡는 창」을 **어디서든 열 수 있게** 하는 창구.
 *
 *  ★창(`ThumbDialog`)은 `App` 이 하나만 매달고, 여는 것은 여러 자리다 (프롬프트 섹션 배너 ·
 *    덱 카드 앞면 · **씬 카드 머리**). 앞의 둘은 부모가 콜백을 내려 주지만, 씬 줄은
 *    `Canvas` 안에 props 없이 서 있어 그 방법이 없었다.
 *  ★`prompt.ts` 의 `setPromptSaver` 와 **같은 방식**이다 — 주인이 함수를 등록해 두고
 *    나머지는 그것을 부른다. 상태를 한 벌 더 두지 않으므로 「어느 쪽이 진짜냐」가 안 생긴다.
 */
export type ThumbTarget =
  | { type: "section"; section: string; img: DragImage }
  | { type: "card"; kind: CardKind; card: AnyCard; img: DragImage }
  /** ★이미 붙어 있는 그림의 **자리만 다시 잡는다** (카드 편집기에서 연다) —
   *  새로 굽지 않으므로 `tid` 를 그대로 쓴다 (사용자 지시 2026-08-20) */
  | { type: "card-thumb"; kind: CardKind; card: AnyCard; tid: string; view: Thumb }
  /** 씬 카드 머리 — 탭 안의 카드 한 장에 그림을 건다 (사용자 지시 2026-08-21) */
  | { type: "scene-card"; groupId: string; cardId: string; img: DragImage };

let opener: ((t: ThumbTarget) => void) | null = null;

/** `App` 이 뜰 때 한 번 등록한다 */
export const setThumbAsker = (fn: ((t: ThumbTarget) => void) | null) => {
  opener = fn;
};

/** 아무 데서나 창을 연다. 등록 전이면 아무 일도 안 한다 */
export const askThumb = (t: ThumbTarget) => opener?.(t);
