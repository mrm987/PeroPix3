/** 검열 무대를 **어떻게 재고 어디를 보고 있나** — 생성 쪽 `store/previewBox` 와 같은 구실이다.
 *
 *  ★★**왜 스토어인가**: 보기 단추(꽉차게·원본·%)는 오른쪽 패널(`CensorSide`)에 있고, 무대
 *    크기와 보고 있는 자리를 아는 것은 무대(`CensorStage`)다. 값이 무대 안의 지역 상태로
 *    갇혀 있으면 단추가 그것을 못 본다 — 생성 쪽이 같은 이유로 겪은 자국이 `previewBox`
 *    머리에 적혀 있다.
 *  ★**배율 자체는 여기 없다.** 그것은 `useCensor` 의 `view` 로 저장되는 설정이고, 여기 있는
 *    것은 「지금 이 장을 재어 보니 이렇더라」뿐이라 장이 바뀌면 사라진다.
 *  ★계산은 전부 `lib/zoomView` 다 (생성 쪽과 같은 순수 함수 · 판정이 붙어 있다).
 */
import { create } from "zustand";
import {
  ZOOM_MAX, ZOOM_MIN, drawSize, keepCenter, stepZoom, zoomFrom,
  type Pan, type Size,
} from "../lib/zoomView";
import { useCensor } from "./censor";

type S = {
  /** 그림의 **실제 크기** (원본 픽셀) */
  nat: Size;
  /** 그림이 놓이는 **판**의 안쪽 크기 */
  box: Size;
  /** 지금 보고 있는 **자리** — ★남기지 않는다 (장이 바뀌면 가운데에서 다시 시작) */
  pan: Pan;
  setNat: (s: Size) => void;
  setBox: (s: Size) => void;
  setPan: (p: Pan | ((p: Pan) => Pan)) => void;
};

export const useCensorView = create<S>((set, get) => ({
  nat: { w: 0, h: 0 },
  box: { w: 0, h: 0 },
  pan: { x: 0, y: 0 },
  // ★같은 크기면 아무 일도 안 한다 — 붓을 끄는 동안 이 값이 바뀌면 프레임마다 화면이 다시 그려진다
  setNat: (nat) => {
    const c = get().nat;
    if (c.w !== nat.w || c.h !== nat.h) set({ nat });
  },
  setBox: (box) => {
    const c = get().box;
    if (c.w !== box.w || c.h !== box.h) set({ box });
  },
  setPan: (p) => set((s) => ({ pan: typeof p === "function" ? p(s.pan) : p })),
}));

/** 배율을 정한다. ★**보고 있던 지점을 붙든다**(`keepCenter`) — 안 그러면 %를 만질 때마다
 *  화면이 왼쪽 위로 튄다. 그래서 자리(`pan`)를 아는 이 자리에 있어야 한다. */
export function setZoom(z: number): void {
  const { nat, box, pan } = useCensorView.getState();
  const view = useCensor.getState().view;
  const next = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z));
  const from = drawSize(nat, zoomFrom(box, nat, view.fit, view.zoom));
  useCensorView.getState().setPan(keepCenter(pan, box, from, drawSize(nat, next)));
  useCensor.getState().tune({ view: { fit: false, zoom: next } });
}

/** 휠(Ctrl) 한 칸 · 단추 한 칸 — 「꽉차게」에서 만지면 **보이던 크기에서** 이어진다 */
export function bumpZoom(d: 1 | -1): void {
  const { nat, box } = useCensorView.getState();
  const view = useCensor.getState().view;
  setZoom(stepZoom(zoomFrom(box, nat, view.fit, view.zoom), d));
}

/** 「꽉차게」로 되돌린다 — 그때의 배율은 판 크기에서 나오므로 저장된 `zoom` 은 그대로 둔다 */
export function setFit(): void {
  useCensor.getState().tune({ view: { ...useCensor.getState().view, fit: true } });
}
