import { create } from "zustand";

/** 토스트 — **끝난 일을 알리는 한 줄**. (v2 `showToast`, 10단계)
 *
 *  ★알림창(alert)을 쓰지 않는다: 확인을 누르기 전까지 앱이 멈추고, 생성 중에 뜨면 흐름이 끊긴다.
 *  ★**오류는 토스트로 끝내지 않는다.** 사라지는 글자는 놓치면 다시 볼 수 없어서,
 *    되짚어야 하는 것(생성 실패 등)은 자기 자리에 남는다 (`useGen.error` → 생성 푸터).
 *    여기 오는 것은 "됐다"에 가까운 것들이다.
 */
export type Toast = {
  id: number;
  text: string;
  kind: "ok" | "warn";
  /** 한 번 누를 수 있는 단추 — 「되돌리기」가 여기 붙는다 (아래 ★) */
  action?: { label: string; run: () => void };
};

type S = {
  items: Toast[];
  /** 띄운 토스트의 id 를 돌려준다 — 단추를 누른 쪽이 그 줄을 바로 치울 수 있게 */
  show: (text: string, kind?: Toast["kind"], action?: Toast["action"], ms?: number) => number;
  drop: (id: number) => void;
};

let seq = 1;
/** ★단추가 붙은 토스트는 오래 둔다 — 누를 틈이 있어야 한다 (2.6초로는 못 누른다) */
const MS = 2600;
const MS_ACTION = 9000;
/** 읽어야 하는 안내 (두 문장짜리 실패 안내). v2 의 생성 실패 토스트와 같은 길이다 */
export const TOAST_READ_MS = 6000;

export const useToast = create<S>((set, get) => ({
  items: [],
  show(text, kind = "ok", action, ms) {
    const id = seq++;
    set({ items: [...get().items, { id, text, kind, action }] });
    setTimeout(() => get().drop(id), ms ?? (action ? MS_ACTION : MS));
    return id;
  },
  drop: (id) => set({ items: get().items.filter((x) => x.id !== id) }),
}));

/** 컴포넌트 밖(스토어·이벤트)에서 부르는 단축 */
export const toast = (text: string, kind?: Toast["kind"], action?: Toast["action"], ms?: number) =>
  useToast.getState().show(text, kind, action, ms);

/** ★**지운 직후의 되돌리기 창구** (사용자 결정 2026-08-18, v2-port-audit D7).
 *
 *  지우는 화면마다 되돌리기 UI 를 따로 만들면 어디서는 되고 어디서는 안 되는 상태가 생긴다
 *  (캔버스만 `Ctrl+Z` 가 있고 나머지는 없던 것이 그랬다). 창구를 하나로 둔다 —
 *  지운 쪽은 "무엇을 되돌릴지"만 넘기면 된다.
 *
 *  ★누르면 토스트가 바로 사라진다. 두 번 눌러 두 번 되살리는 일이 없어야 한다. */
export function undoToast(text: string, label: string, run: () => void | Promise<void>) {
  let used = false;
  let id = 0;
  id = useToast.getState().show(text, "ok", {
    label,
    run: () => {
      if (used) return;
      used = true;
      useToast.getState().drop(id);
      void run();
    },
  });
}
