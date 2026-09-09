import { useUi, type PluginFrame } from "../store/ui";
import type { PluginInfo } from "./pluginHost";

/** 플러그인 캔버스의 프레임 셈법 — 캔버스(`panels/PluginCanvas`)·패널(`panels/PluginPanel`)·확장 API(`pluginHost.openCanvas`)가 같이 쓴다 */

/** 프레임 머리 높이 (캔버스 좌표) */
export const HEAD = 32;
/** 프레임 사이 틈 */
const GAP = 24;
/** 처음 프레임의 자리 */
const HOME = 40;

export type Pan = { x: number; y: number; z: number };
export const PAN0: Pan = { x: 0, y: 0, z: 1 };

/** 캔버스에서 그 프레임이 실제로 차지하는 높이 (접으면 머리만) */
const heightOf = (f: PluginFrame) => (f.fold ? HEAD : f.h);

/** `w × h` 크기가 **아무 프레임과도 안 겹치는** 첫 자리 — 왼쪽 위부터 오른쪽으로, 줄이 차면 아래로 훑는다.
 *
 *  ★한 자리에 조금씩 밀어 놓는 방식(계단식)은 **프레임 폭이 수백 px 이라 사실상 다 겹친다** — 뒤쪽 프레임이
 *    앞쪽에 완전히 가려 클릭이 앞의 것으로 갔다 (실측 2026-09-10: 카메라 위에 Hello Two 가 얹혀 시나리오가 헛클릭).
 *    창 관리자가 새 창을 빈 자리에 놓는 것과 같은 셈법으로 바꿨다. */
function freeSpot(w: number, h: number, taken: PluginFrame[]): { x: number; y: number } {
  if (taken.length === 0) return { x: HOME, y: HOME };
  const hits = (x: number, y: number) =>
    taken.some((f) => x < f.x + f.w + GAP && x + w + GAP > f.x && y < f.y + heightOf(f) + GAP && y + h + GAP > f.y);
  const x0 = Math.min(...taken.map((f) => f.x));
  const y0 = Math.min(...taken.map((f) => f.y));
  // 격자로 훑는다 — 칸이 크면 빈틈이 남고, 작으면 셈이 는다. 120 은 둘 사이의 타협이다.
  // ★한 줄이 `ROW` 를 넘으면 아랫줄로 접는다 — 한 줄로만 늘어놓으면 「맞춤」 배율이 너무 작아진다 (넷이면 0.35, 접으면 0.56)
  const STEP = 120;
  const ROW = 1200;
  for (let row = 0; row < 40; row++) {
    for (let col = 0; col * STEP <= ROW; col++) {
      const x = x0 + col * STEP, y = y0 + row * STEP;
      if (!hits(x, y)) return { x, y };
    }
  }
  return { x: x0, y: y0 };
}

/** 처음 꺼낼 때의 프레임 — 규격의 처음 크기, 빈 자리에, 맨 앞에.
 *  @param extra 한 번에 여럿을 놓을 때 서로도 안 겹치게 — 앞서 놓기로 한 것들 */
export function defaultFrame(p: PluginInfo, extra: PluginFrame[] = []): PluginFrame {
  const frames = placedFrames();
  const w = p.canvas.width, h = p.canvas.height + HEAD;
  const { x, y } = freeSpot(w, h, [...frames, ...extra]);
  const top = Math.max(0, ...frames.map((f) => f.z), ...extra.map((f) => f.z));
  return { x, y, w, h, z: top + 1 };
}

/** 자리를 가진 프레임들 — ★빈 값을 걸러 낸다 (저장본에 `undefined` 가 섞이면 화면이 통째로 안 그려졌다, 실측 2026-09-10) */
const placedFrames = (): PluginFrame[] => Object.values(useUi.getState().view.frame).filter(Boolean) as PluginFrame[];

/** 지금 보고 있는 화면·배율 */
export function currentPan(): Pan {
  return useUi.getState().view.pan["plugins"] ?? PAN0;
}

/** 프레임을 맨 앞으로 — z 를 가장 큰 값 + 1 로 (다른 값도 함께 적는다) */
export function raiseFrame(id: string, f: PluginFrame) {
  const frames = useUi.getState().view.frame;
  const top = Math.max(0, ...placedFrames().map((x) => x.z));
  if (f.z === top && frames[id] === f) return;
  useUi.getState().setView("frame", id, { ...f, z: top + 1 });
}

/** 캔버스에 꺼내 놓고 맨 앞으로.
 *  ★자리를 처음 받는 것은 **빈 자리**에 놓고, 이미 자리가 있던 것은 그 자리 그대로 되돌린다 — 닫았다 다시 꺼내면
 *    있던 자리로 돌아오는 것이 예상에 맞다 (그때 화면 밖이면 패널의 이름을 눌러 찾아간다). */
export function putOnCanvas(p: PluginInfo) {
  const ui = useUi.getState();
  const f = ui.view.frame[p.id] ?? defaultFrame(p);
  ui.setView("hide", p.id, false);
  ui.setView("tab", "plugins", "canvas" as never);
  raiseFrame(p.id, { ...f, fold: false });
}
