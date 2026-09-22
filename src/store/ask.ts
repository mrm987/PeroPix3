import { create } from "zustand";

/** 확인 창 — **약속(Promise)으로 답을 돌려준다** (10단계).
 *
 *  ★브라우저 `confirm` 을 안 쓰는 이유: 창 밖에서 뜨는 OS 대화상자라 앱의 글꼴·테마·언어와
 *    따로 놀고, Tauri 의 장식 없는 창에서는 **엉뚱한 자리에** 뜬다. 무엇보다 스타일을 못 준다.
 *  ★쓰는 쪽은 `if (await ask(...))` 한 줄이면 된다 — 콜백을 넘기게 하면 호출부가 두 겹이 된다.
 */
type Req = {
  id: number;
  title: string;
  body?: string;
  ok: string;
  cancel: string;
  /** 되돌릴 수 없는 일 — 확인 버튼이 빨갛다 */
  danger?: boolean;
  /** ★갈래가 둘 이상인 물음 (`askPick`) — 첫 것이 기본(Enter). 없으면 확인·취소 둘뿐 */
  options?: { key: string; label: string }[];
  resolve: (v: boolean | string) => void;
};

type S = { cur: Req | null; answer: (v: boolean | string) => void; push: (r: Req) => void };

let seq = 1;

export const useAsk = create<S>((set, get) => ({
  cur: null,
  push: (r) => set({ cur: r }),
  answer(v) {
    const c = get().cur;
    if (!c) return;
    set({ cur: null });
    c.resolve(v);
  },
}));

export function ask(opts: {
  title: string;
  body?: string;
  ok: string;
  cancel: string;
  danger?: boolean;
}): Promise<boolean> {
  return new Promise((resolve) => {
    useAsk.getState().push({ id: seq++, ...opts, resolve: (v) => resolve(v === true) });
  });
}

/** 갈래를 고르는 물음 — 고른 갈래의 `key`, 취소면 null. 「이미지 편집으로 보내기」의 새 문서 / 레이어로 추가가 쓴다
 *  (사용자 결정 2026-09-22). `ask` 와 같은 창이고 단추만 갈래 수만큼이다. */
export function askPick(opts: {
  title: string;
  body?: string;
  options: { key: string; label: string }[];
  cancel: string;
}): Promise<string | null> {
  return new Promise((resolve) => {
    useAsk.getState().push({
      id: seq++, title: opts.title, body: opts.body, ok: opts.options[0]?.label ?? "", cancel: opts.cancel, options: opts.options,
      resolve: (v) => resolve(typeof v === "string" ? v : null),
    });
  });
}
