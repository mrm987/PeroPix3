import { create } from "zustand";

/** 지금 끌고 있는 것을 **놓으면 받을 자리** (사용자 지시 2026-08-28).
 *
 *  ★★갈래가 둘이다: 탭을 **워크스페이스 탭**에 놓으면 그 워크스페이스로 옮겨지고
 *    (*"탭을 끌어다가 다른 워크스페이스에 두면 거기로 옮겨지게"*), 씬 그룹을 **탭**에 놓으면
 *    그 탭 밑으로 옮겨진다 (*"씬 그룹을 다른 탭에 넣는 기능도 추가"*).
 *  ★**하나로 든다** — 한 번에 한 가지만 끌므로 상태도 하나면 된다. 갈래마다 store 를 두면
 *    빛나는 규칙·놓는 규칙이 두 벌로 갈린다.
 *  ★두 컴포넌트가 같이 본다 — 끄는 쪽이 적고, 받는 쪽이 읽어 빛난다. 형제라 한쪽의 상태로는
 *    다른 쪽이 못 본다.
 *  ★차례 바꾸기(`useReorder`)와 **같은 끌기**다 — 손을 뗀 자리가 받을 자리면 차례 대신
 *    옮기기가 된다. 끌기를 두 벌 두지 않는다. */
export type DropTarget = { kind: "ws"; name: string } | { kind: "tab"; id: string };

export const useTabDrop = create<{
  over: DropTarget | null;
  /** 마지막으로 **받을 자리에 놓은** 시각 (`performance.now()`) */
  droppedAt: number;
  set: (v: DropTarget | null) => void;
  markDropped: () => void;
}>((set) => ({
  over: null,
  droppedAt: 0,
  set: (over) => set({ over }),
  markDropped: () => set({ droppedAt: performance.now() }),
}));

/** 방금 놓았나 — 놓은 자리에 **클릭이 따라온다** (실사고 2026-08-28: 그 클릭이 옮기기가 끝나기
 *  전에 받는 쪽을 열어 옮기기 전 상태를 보여 줬고, 옮기기 응답이 엉뚱한 자리에 대입되는 길을
 *  열었다). 받는 자리(워크스페이스 탭·탭)는 이 동안의 클릭을 무시한다. */
/** ★★창은 **150ms** 다 (사용자 지적 2026-08-28: *"매우 빠를 때는 조작을 막는 UI 자체는 안 뜨지만
 *  실제로 조작해 보면 탭 전환 같은 게 안 됨"*). 막으려는 것은 **손을 뗄 때 따라오는 그 클릭**
 *  하나뿐인데(한 프레임 안에 온다), 500ms 로 두었더니 옮기기가 끝난 뒤의 **진짜 클릭까지**
 *  먹었다 — 옮기기가 115ms 로 빨라지면서 그 구간이 그대로 드러났다. */
export const justDropped = (): boolean => performance.now() - useTabDrop.getState().droppedAt < 150;

/** 그 화면 좌표 밑의 **워크스페이스 탭** (없으면 `null`).
 *  ★포인터가 잡혀 있어도(`setPointerCapture`) `elementFromPoint` 는 좌표로 찾으므로 그대로 된다. */
export function wsTabAt(x: number, y: number): DropTarget | null {
  const name = document.elementFromPoint(x, y)?.closest("[data-ws-tab]")?.getAttribute("data-ws-tab");
  return name ? { kind: "ws", name } : null;
}

/** 그 화면 좌표 밑의 **탭** (없으면 `null`) — 씬 그룹을 받을 자리다 */
export function canvasTabAt(x: number, y: number): DropTarget | null {
  const id = document.elementFromPoint(x, y)?.closest("[data-tab]")?.getAttribute("data-tab");
  return id ? { kind: "tab", id } : null;
}
