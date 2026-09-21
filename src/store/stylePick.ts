import { create } from "zustand";
import type { StyleOpts, StylePick } from "../lib/styleOpts";

/** 스타일 카드를 프롬프트에 놓았을 때 **무엇을 덮을지 고르는 시트** (사용자 지시 2026-09-21:
 *  *"스타일 카드를 프롬프트에 드롭하면 이미지를 드롭했을 때처럼 덮어쓸 항목을 고르게 해서,
 *  스타일만 바꿀지 생성 옵션까지 바꿀지 사용자가 정한다"*).
 *
 *  ★**약속으로 답을 돌려준다** — 쓰는 쪽은 `const pick = await askStylePick(...)` 한 줄이다
 *    (`store/ask` 와 같은 양식). 취소하면 `null` 이라 아무것도 안 걸린다.
 *  ★★**언제나 띄운다** (사용자 지시 2026-09-21: *"시트는 항상 켜"*). 바뀔 것이 없어도
 *    띄우고, 지금과 같은 값은 **시트에 「지금과 같음」으로 표시한다** — 안 띄우면 그 카드에
 *    무엇이 담겨 있는지 볼 자리가 없어진다.
 *  ★조수는 이 시트를 안 쓴다 (`lib/applyCard` 를 바로 부른다) — 화면이 없는 자리에서
 *    답을 기다리면 영영 안 끝난다.
 */
type Req = {
  id: number;
  name: string;
  opts: StyleOpts | undefined;
  resolve: (p: StylePick | null) => void;
};

type S = {
  cur: Req | null;
  push: (r: Req) => void;
  answer: (p: StylePick | null) => void;
};

let seq = 1;

export const useStylePick = create<S>((set, get) => ({
  cur: null,
  push: (r) => set({ cur: r }),
  answer(p) {
    const c = get().cur;
    if (!c) return;
    set({ cur: null });
    c.resolve(p);
  },
}));

export function askStylePick(name: string, opts: StyleOpts | undefined): Promise<StylePick | null> {
  return new Promise((resolve) => {
    useStylePick.getState().push({ id: seq++, name, opts, resolve });
  });
}
