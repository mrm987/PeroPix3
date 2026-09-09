import { useUi, type PluginFrame } from "../store/ui";
import type { PluginInfo } from "./pluginHost";

/** 플러그인 캔버스의 프레임 셈법 — 캔버스(`panels/PluginCanvas`)·패널(`panels/PluginPanel`)·확장 API(`pluginHost.openCanvas`)가 같이 쓴다 */

/** 프레임 머리 높이 (캔버스 좌표) */
export const HEAD = 32;

export type Pan = { x: number; y: number; z: number };
export const PAN0: Pan = { x: 0, y: 0, z: 1 };

/** 처음 꺼낼 때의 프레임 — 규격의 처음 크기. 자리는 **이미 자리를 가진 프레임 수**만큼 밀리고 맨 앞에 선다.
 *  ★플러그인 차례(index)로 밀면 새로 깐 것이 옛 프레임과 같은 자리·낮은 z 로 겹쳐 뒤에 숨는다 (실측 2026-09-09: camera 위에 hello) */
export function defaultFrame(p: PluginInfo, i: number): PluginFrame {
  const frames = useUi.getState().view.frame;
  const n = Object.keys(frames).length + i;
  const top = Math.max(0, ...Object.values(frames).map((x) => x.z));
  return { x: 40 + n * 32, y: 40 + n * 32, w: p.canvas.width, h: p.canvas.height + HEAD, z: top + 1 + i };
}

/** 지금 보고 있는 화면·배율 */
export function currentPan(): Pan {
  return useUi.getState().view.pan["plugins"] ?? PAN0;
}

/** 프레임을 맨 앞으로 — z 를 가장 큰 값 + 1 로 (다른 값도 함께 적는다) */
export function raiseFrame(id: string, f: PluginFrame) {
  const frames = useUi.getState().view.frame;
  const top = Math.max(0, ...Object.values(frames).map((x) => x.z));
  if (f.z === top && frames[id] === f) return;
  useUi.getState().setView("frame", id, { ...f, z: top + 1 });
}

/** 캔버스에 꺼내 놓고 맨 앞으로 — 지금 보는 화면의 왼쪽 위에 */
export function putOnCanvas(p: PluginInfo, order: number) {
  const ui = useUi.getState();
  const pan = currentPan();
  const f = ui.view.frame[p.id] ?? defaultFrame(p, order);
  ui.setView("hide", p.id, false);
  ui.setView("tab", "plugins", "canvas" as never);
  raiseFrame(p.id, { ...f, x: Math.round((40 - pan.x) / pan.z), y: Math.round((40 - pan.y) / pan.z), fold: false });
}
