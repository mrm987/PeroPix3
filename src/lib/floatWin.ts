import { createContext, useContext } from "react";
import { create } from "zustand";
import { getAllWindows, getCurrentWindow, availableMonitors, Window as TauriWindow } from "@tauri-apps/api/window";
import { LogicalPosition, LogicalSize, PhysicalPosition, PhysicalSize } from "@tauri-apps/api/dpi";
import { IS_MAC } from "./platform";
import { logLine } from "./report";

/** 앱 밖 창 — 작업 영역 하나를 새 창으로 분리한다 (사용자 지시 2026-11-06, `docs/floating-windows-review.md`).
 *
 *  ★★창만 늘고 JS 는 메인 하나다. `window.open("about:blank")` 로 빈 창을 받고 메인의 React 가 `createPortal` 로
 *    그 문서에 그린다. 스토어가 그대로 하나이므로 동기화할 것이 없고, 창마다 다른 것은 `window`·`document` 뿐이다.
 *    그래서 전역 객체를 쓰는 코드가 그 창의 것을 쓰게 하는 창구가 여기 있다:
 *      · 화면 안: `useWin()` — 지금 그려지는 창
 *      · 모든 창에서 들을 것: `onEveryWindow` (단축키)
 *      · 창을 넘는 끌기: `locate` (`cards/dragStore`)
 *  ★한 영역은 창 하나다. 스토어가 하나라 같은 영역을 두 창에 띄우거나 창마다 다른 탭을 볼 수 없다.
 *  ★★맥은 창 만드는 법이 다르다 (베타, 사용자 결정 2026-11-06). 메인에 종속시키지 않는 독립 창이고 좌표 단위가 논리 좌표다 (`FloatGeo`).
 *    메인 위에 두는 것은 껍데기가 한다 (`sync_float_levels`). */
export type FloatArea = "ai" | "preview" | "gallery" | "prompt" | "scene";

/** 윈도우는 물리 픽셀이다 (`winstate.rs` 와 같은 이유: 배율이 다른 모니터로 옮겨 다니면 논리 좌표는 다른 곳을 가리킨다).
 *  ★맥은 반대로 논리 좌표다. 맥의 논리 좌표는 모니터 전체에 이어지지만, Tauri 가 주는 물리 좌표는 그 창의 배율을 곱한 값이라
 *    배율이 다른 모니터 사이에서 이어지지 않는다 (tao `macos/window.rs` 의 `outer_position`). */
export type FloatGeo = { x: number; y: number; w: number; h: number; max?: boolean };

export type FloatLive = {
  area: FloatArea;
  win: Window;
  /** 포털이 그려 넣는 곳 — 새 창 문서의 `#root` */
  root: HTMLElement;
  tw: TauriWindow;
  off: (() => void)[];
};

export const FLOAT_OK = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/** 지금 그려지는 창. 포털을 지나도 컨텍스트는 이어지므로 새 창 안의 컴포넌트는 새 창의 `Window` 를 받는다 */
export const WinCtx = createContext<Window>(typeof window === "undefined" ? (undefined as never) : window);
export const useWin = () => useContext(WinCtx);

const KEY = "peropix.float";
type Saved = { out: FloatArea[]; geo: Partial<Record<FloatArea, FloatGeo>> };

function loadSaved(): Saved {
  try {
    const got = JSON.parse(localStorage.getItem(KEY) ?? "{}");
    return { out: Array.isArray(got.out) ? got.out : [], geo: got.geo ?? {} };
  } catch {
    return { out: [], geo: {} };
  }
}

type S = Saved & {
  live: Partial<Record<FloatArea, FloatLive>>;
  /** 마지막으로 포커스된 창. 확인 창·토스트가 여기 뜬다 (`OnActiveWindow`) */
  active: FloatArea | "main";
  /** 앞에 있는 순서 (맨 앞이 먼저). 겹친 곳의 드롭 판정에 쓴다 */
  order: FloatArea[];
};

export const useFloat = create<S>(() => ({ ...loadSaved(), live: {}, active: "main", order: [] }));

function persist() {
  const { out, geo } = useFloat.getState();
  try {
    localStorage.setItem(KEY, JSON.stringify({ out, geo }));
  } catch {
    /* 못 적어도 하던 일에는 지장이 없다 */
  }
}

const lives = () => {
  const { live, order } = useFloat.getState();
  return order.map((a) => live[a]).filter(Boolean) as FloatLive[];
};

/** 열려 있는 창 전부 (메인이 맨 앞) */
export const allWindows = (): Window[] => [window, ...lives().map((l) => l.win)];

/** 이 창이 어느 영역의 것인가 (메인이면 "main") */
export const areaOf = (win: Window | null | undefined): FloatArea | "main" =>
  lives().find((l) => l.win === win)?.area ?? "main";

/** 앱의 창 중 하나라도 포커스를 쥐고 있나 */
export const appHasFocus = () => allWindows().some((w) => w.document.hasFocus());

/** 열린 창 전부를 뒤진다 (모달이 어느 창에 떠 있는지 모를 때) */
export const queryAnyWindow = (selector: string): Element | null => {
  for (const w of allWindows()) {
    const el = w.document.querySelector(selector);
    if (el) return el;
  }
  return null;
};

/** 포커스를 쥔 창의 클립보드에 쓴다. 메인이 포커스를 잃으면 메인의 `navigator.clipboard` 는 거절한다 */
export const copyText = (text: string): Promise<void> => {
  const { active, live } = useFloat.getState();
  const win = active === "main" ? window : live[active]?.win ?? window;
  return win.navigator.clipboard ? win.navigator.clipboard.writeText(text) : Promise.reject(new Error("clipboard"));
};

/** 그 요소가 사는 창의 `ResizeObserver`. 메인 쪽 것은 새 창의 크기 변화를 놓친다 (측정) */
export function observeSize(el: Element, cb: ResizeObserverCallback): ResizeObserver {
  const Ctor = ((el.ownerDocument.defaultView ?? window) as unknown as { ResizeObserver: typeof ResizeObserver }).ResizeObserver;
  const ro = new Ctor(cb);
  ro.observe(el);
  return ro;
}

/* ── 모든 창에서 듣기 ─────────────────────────────────────────────
 * 키는 포커스를 쥔 창의 `window` 로만 온다 (측정). 메인에만 걸어 둔 단축키는 새 창에서 안 먹으므로,
 * 어느 창에서 눌러도 먹어야 하는 것은 여기로 건다. 나중에 열리는 창에도 함께 걸린다. */
type Every = { type: string; fn: EventListener; opts?: boolean | AddEventListenerOptions };
const every = new Set<Every>();

export function onEveryWindow<K extends keyof WindowEventMap>(
  type: K,
  fn: (e: WindowEventMap[K]) => void,
  opts?: boolean | AddEventListenerOptions,
): () => void {
  const l: Every = { type, fn: fn as EventListener, opts };
  every.add(l);
  for (const w of allWindows()) w.addEventListener(type, l.fn, opts);
  return () => {
    every.delete(l);
    for (const w of allWindows()) w.removeEventListener(type, l.fn, opts);
  };
}

/* ── 새 창 문서 준비 ─────────────────────────────────────────────── */

/** `<html>` 의 속성을 그대로 옮긴다. 테마·글꼴·글자 배율·언어·끌기 커서가 전부 여기 있어서, 이것 하나면 그쪽 코드를 안 고친다 */
function mirrorHtml(doc: Document) {
  const from = document.documentElement;
  const to = doc.documentElement;
  for (const a of [...to.attributes]) if (!from.hasAttribute(a.name)) to.removeAttribute(a.name);
  for (const a of from.attributes) if (to.getAttribute(a.name) !== a.value) to.setAttribute(a.name, a.value);
}

const STYLE_SRC = 'link[rel="stylesheet"], style';
let styleSeq = 0;
const styleIds = new WeakMap<Element, string>();

/** 스타일을 옮긴다. 개발 중에는 Vite 가 `<style>` 을 넣고 고칠 때마다 내용을 바꾸므로 달라진 것만 맞춘다 */
function mirrorStyles(doc: Document) {
  const seen = new Set<string>();
  for (const src of document.head.querySelectorAll(STYLE_SRC)) {
    let id = styleIds.get(src);
    if (!id) {
      id = String(++styleSeq);
      styleIds.set(src, id);
    }
    seen.add(id);
    const had = doc.head.querySelector(`[data-mirror="${id}"]`);
    if (!had) {
      const c = doc.importNode(src, true) as Element;
      c.setAttribute("data-mirror", id);
      doc.head.appendChild(c);
    } else if (src.tagName === "STYLE" && had.textContent !== src.textContent) {
      had.textContent = src.textContent;
    }
  }
  for (const c of doc.head.querySelectorAll("[data-mirror]"))
    if (!seen.has(c.getAttribute("data-mirror")!)) c.remove();
}

let mirrors = false;
function watchMain() {
  if (mirrors) return;
  mirrors = true;
  new MutationObserver(() => lives().forEach((l) => mirrorHtml(l.win.document))).observe(document.documentElement, {
    attributes: true,
  });
  new MutationObserver(() => lives().forEach((l) => mirrorStyles(l.win.document))).observe(document.head, {
    childList: true,
    subtree: true,
    characterData: true,
  });
}

function setActive(a: FloatArea | "main") {
  const s = useFloat.getState();
  const order = a === "main" ? s.order : [a, ...s.order.filter((x) => x !== a)];
  if (s.active !== a || order[0] !== s.order[0]) useFloat.setState({ active: a, order });
}

/** 네이티브 창이 생길 때까지 기다린다. `window.open` 은 곧바로 돌아오고 창은 껍데기 쪽에서 조금 뒤에 만들어진다 */
async function waitNative(label: string) {
  for (let i = 0; i < 100; i++) {
    if ((await getAllWindows()).some((w) => w.label === label)) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return false;
}

/** 첫 분리의 크기 (논리 픽셀) */
const FIRST_SIZE: Record<FloatArea, { w: number; h: number }> = {
  ai: { w: 420, h: 760 },
  preview: { w: 900, h: 780 },
  gallery: { w: 1240, h: 800 },
  prompt: { w: 520, h: 860 },
  scene: { w: 1000, h: 420 },
};

/** 처음 분리할 때는 메인의 그 영역 쪽 가장자리에 띄운다 (왼쪽 기둥은 왼쪽, 나머지는 오른쪽). 옆 모니터로 옮기면 그 위치를 기억한다 */
async function firstGeo(area: FloatArea): Promise<FloatGeo> {
  const m = getCurrentWindow();
  const [p, s, scale] = await Promise.all([m.outerPosition(), m.outerSize(), m.scaleFactor()]);
  // ★맥은 논리 좌표로 계산한다 (`FloatGeo`)
  const d = IS_MAC ? scale : 1;
  const k = scale / d;
  const mw = s.width / d;
  const step = Math.round(lives().length * 32 * k);
  const pad = Math.round(40 * k);
  const top = Math.round(48 * k) + step;
  const w = Math.min(Math.round(FIRST_SIZE[area].w * k), mw);
  // ★맥은 메인의 아래쪽 가장자리까지만 쓴다. 넘치면 창 아래쪽이 Dock 뒤로 들어가 입력칸이 가려진다 (CI 의 맥 실측)
  const h = Math.min(Math.round(FIRST_SIZE[area].h * k), s.height / d - (IS_MAC ? top : 0));
  const left = area === "ai" || area === "prompt";
  const px = p.x / d;
  return { x: left ? px + pad + step : px + mw - w - pad - step, y: p.y / d + top, w, h };
}

async function spawn(area: FloatArea, geo: FloatGeo): Promise<boolean> {
  if (useFloat.getState().live[area]) return true;
  // ★창이 뜨는 동안 또 눌러도 하나만 연다
  if (spawning.has(area)) return false;
  spawning.add(area);
  try {
    return await open(area, geo);
  } finally {
    spawning.delete(area);
  }
}

const spawning = new Set<FloatArea>();

async function open(area: FloatArea, geo: FloatGeo): Promise<boolean> {
  const label = `float-${area}`;
  const k = IS_MAC ? 1 : window.devicePixelRatio || 1;
  const win = window.open(
    `about:blank#${label}`,
    label,
    `popup=yes,left=${Math.round(geo.x / k)},top=${Math.round(geo.y / k)},width=${Math.round(geo.w / k)},height=${Math.round(geo.h / k)}`,
  );
  if (!win) {
    logLine("error", "새 창", `${label} 창을 못 열었습니다`);
    return false;
  }
  watchMain();
  const doc = win.document;
  mirrorHtml(doc);
  mirrorStyles(doc);
  const root = doc.createElement("div");
  root.id = "root";
  doc.body.appendChild(root);
  for (const l of every) win.addEventListener(l.type, l.fn, l.opts);
  win.addEventListener("focus", () => setActive(area));
  /* Alt+F4 같은 OS 닫기. 우리 닫기 버튼은 `dockArea` 가 먼저 목록에서 빼므로 여기서 아무 일도 안 일어난다.
     ★★저장은 잠깐 미룬다. 메인을 닫으면 Windows 가 종속 창을 **먼저** 없애서 메인 JS 가 이 사건을 받는다 (측정).
       바로 적으면 분리해 둔 상태가 지워져 다시 켰을 때 안 뜬다. 메인이 닫히는 중이면 이 타이머가 돌기 전에 JS 가 끝난다. */
  win.addEventListener("pagehide", () => {
    if (useFloat.getState().live[area]?.win !== win) return;
    forget(area);
    setTimeout(persist, 800);
  });

  const tw = new TauriWindow(label, { skip: true } as never);
  const live: FloatLive = { area, win, root, tw, off: [] };

  try {
    if (!(await waitNative(label))) throw new Error("창이 만들어지지 않았습니다");
    /* ★맥은 크기를 먼저 맞춘다. 맥의 크기 변경은 왼쪽 아래를 고정하므로, 나중에 하면 맞춰 놓은 위쪽 위치가 밀린다 (CI 의 맥 실측: y 87 → 28) */
    if (IS_MAC) {
      await tw.setSize(new LogicalSize(geo.w, geo.h));
      await tw.setPosition(new LogicalPosition(geo.x, geo.y));
    } else {
      await tw.setPosition(new PhysicalPosition(geo.x, geo.y));
      await tw.setSize(new PhysicalSize(geo.w, geo.h));
    }
    if (geo.max) await tw.maximize();
    await tw.show();
    await tw.setFocus();
    /* ★★창이 제 크기로 뜬 **다음에** 내용을 그린다. 크기가 잡히기 전에 마운트하면 처음 한 번 재는 곳이 틀린 값을 든다
         (실측: AI 입력칸이 좁은 폭으로 재어 창 절반 높이가 됐다). 그동안 메인은 그대로 있어 빈 자리도 안 생긴다. */
    const s = useFloat.getState();
    useFloat.setState({
      live: { ...s.live, [area]: live },
      out: s.out.includes(area) ? s.out : [...s.out, area],
      geo: { ...s.geo, [area]: geo },
      order: [area, ...s.order.filter((a) => a !== area)],
      active: area,
    });
    persist();
    void refreshFrames();
    let t: ReturnType<typeof setTimeout> | undefined;
    const note = () => {
      void refreshFrames();
      clearTimeout(t);
      t = setTimeout(() => void noteGeo(area), 300);
    };
    live.off.push(await tw.onMoved(note), await tw.onResized(note), () => clearTimeout(t));
  } catch (e) {
    logLine("error", "새 창", `${label}: ${String(e)}`);
    // 내용을 그리기 전에 실패했으면 빈 창을 남기지 않는다
    if (!useFloat.getState().live[area]) void tw.destroy().catch(() => {});
    return false;
  }
  return true;
}

/** 크기·위치를 적는다. 최대화된 동안은 깃발만 적고 크기는 그 전 것을 둔다 (되돌릴 크기가 있어야 한다) */
async function noteGeo(area: FloatArea) {
  const l = useFloat.getState().live[area];
  if (!l) return;
  try {
    const [min, full, max, p, s, scale] = await Promise.all([
      l.tw.isMinimized(),
      l.tw.isFullscreen(),
      l.tw.isMaximized(),
      l.tw.outerPosition(),
      l.tw.innerSize(),
      l.tw.scaleFactor(),
    ]);
    if (min || full) return;
    const st = useFloat.getState();
    const old = st.geo[area];
    const d = IS_MAC ? scale : 1;
    const geo = max && old ? { ...old, max: true } : { x: p.x / d, y: p.y / d, w: s.width / d, h: s.height / d, max };
    useFloat.setState({ geo: { ...st.geo, [area]: geo } });
    persist();
  } catch {
    /* 창이 막 닫혔다 */
  }
}

/** 목록에서 뺀다. 포털이 내려가면서 영역이 메인의 원래 위치로 돌아온다 */
function forget(area: FloatArea) {
  const s = useFloat.getState();
  const l = s.live[area];
  l?.off.forEach((f) => f());
  if (l) frames.delete(l.win);
  const { [area]: _gone, ...live } = s.live;
  useFloat.setState({
    live,
    out: s.out.filter((a) => a !== area),
    order: s.order.filter((a) => a !== area),
    active: s.active === area ? "main" : s.active,
  });
}

/* ── 부르는 쪽 ─────────────────────────────────────────────────── */

/** 분리한다. 전에 분리한 적이 있으면 마지막 위치에 뜬다 */
export async function splitArea(area: FloatArea) {
  if (!FLOAT_OK) return;
  const live = useFloat.getState().live[area];
  if (live) return raiseArea(area);
  await spawn(area, useFloat.getState().geo[area] ?? (await firstGeo(area)));
}

/** 닫는다 = 메인의 원래 위치로 돌아온다 */
export function dockArea(area: FloatArea) {
  const l = useFloat.getState().live[area];
  if (!l) return;
  forget(area);
  persist();
  void l.tw.destroy().catch(() => {});
  void getCurrentWindow().setFocus().catch(() => {});
}

export function raiseArea(area: FloatArea) {
  const l = useFloat.getState().live[area];
  if (!l) return;
  setActive(area);
  void l.tw.setFocus().catch(() => {});
}

/** 메인을 앞으로. 메인에서 일어나는 일을 다른 창에서 부를 때 (모드 전환·설정) */
export function raiseMain() {
  if (useFloat.getState().active === "main") return;
  setActive("main");
  void getCurrentWindow().setFocus().catch(() => {});
}

/** 끌기를 놓은 창을 앞으로. 드롭이 띄우는 창(`OnActiveWindow`)이 거기 뜨게 **먼저** 부른다 */
export function raiseWindow(win: Window) {
  const a = areaOf(win);
  if (useFloat.getState().active === a) return;
  if (a === "main") raiseMain();
  else raiseArea(a);
}

let booted = false;
/** 켤 때 — 분리해 둔 창을 다시 연다.
 *  ★메인을 새로 읽어도(`location.reload`) 새 창은 남으므로 먼저 치운다 (측정). 메인 JS 가 새로 떠서 그 창들을 모른다.
 *  ★그 모니터가 없으면 메인으로 돌아온다. */
export async function bootFloats() {
  if (booted || !FLOAT_OK) return;
  booted = true;
  window.addEventListener("focus", () => setActive("main"));
  try {
    for (const w of await getAllWindows()) if (w.label !== "main") await w.destroy();
    const { out, geo } = useFloat.getState();
    if (!out.length) return;
    const mons = await availableMonitors();
    const visible = (g: FloatGeo) =>
      mons.some((m) => {
        const d = IS_MAC ? m.scaleFactor : 1;
        const [x, y, w, h] = [m.position.x / d, m.position.y / d, m.size.width / d, m.size.height / d];
        const head = g.y + 40;
        return g.x + g.w > x && g.x < x + w && head > y && head < y + h;
      });
    const keep = out.filter((a) => geo[a] && visible(geo[a]!));
    useFloat.setState({ out: keep });
    persist();
    for (const a of keep) await spawn(a, geo[a]!);
    void getCurrentWindow().setFocus().catch(() => {});
  } catch (e) {
    logLine("error", "새 창", `복원 실패: ${String(e)}`);
  }
}

/* ── 창을 넘는 좌표 ────────────────────────────────────────────────
 * 포인터를 잡은 창은 창 밖에서도 그 창 기준의 client 좌표를 계속 받는다 (측정). 그것을 물리 픽셀로 옮겨 어느 창 위인지 가린다.
 * ★`screenX` 대신 껍데기가 아는 물리 좌표를 쓴다. 배율이 다른 모니터 사이에서는 `screenX` 의 기준이 흔들린다.
 * ★맥은 논리 좌표로 계산한다 (`FloatGeo`). client 좌표와 단위가 같아 배율을 곱하지 않는다. */
const frames = new Map<Window, { x: number; y: number }>();

/** client 좌표 1 이 화면 좌표로 얼마인가 */
const unit = (w: Window) => (IS_MAC ? 1 : w.devicePixelRatio || 1);
/** 껍데기가 준 위치를 화면 좌표로 */
const screenOf = (p: { x: number; y: number }, w: Window) => (IS_MAC ? { x: p.x / (w.devicePixelRatio || 1), y: p.y / (w.devicePixelRatio || 1) } : p);

/** 창들의 물리 위치를 다시 읽는다. 끌기를 시작할 때와 창이 움직였을 때 */
export async function refreshFrames() {
  const list = lives();
  if (!list.length) return;
  try {
    const [m, ...rest] = await Promise.all([getCurrentWindow().innerPosition(), ...list.map((l) => l.tw.innerPosition())]);
    frames.set(window, screenOf(m, window));
    list.forEach((l, i) => frames.set(l.win, screenOf(rest[i], l.win)));
  } catch {
    /* 창이 막 닫혔다. 아래 `origin` 이 `screenX` 로 대신한다 */
  }
}

function origin(w: Window) {
  const f = frames.get(w);
  if (f) return f;
  const k = unit(w);
  return { x: w.screenX * k, y: w.screenY * k };
}

export type WinPoint = { win: Window; x: number; y: number };

/** `src` 창 기준 좌표가 어느 창의 어디인가. 앱 창 위가 아니면 null. 새 창이 없으면 언제나 `src` 그대로다.
 *  ★새 창은 언제나 메인 위에 있고, 새 창끼리는 포커스 순서로 본다. */
export function locate(src: Window, x: number, y: number): WinPoint | null {
  const list = lives();
  if (!list.length) return { win: src, x, y };
  const so = origin(src);
  const sk = unit(src);
  const px = so.x + x * sk;
  const py = so.y + y * sk;
  for (const w of [...list.map((l) => l.win), window]) {
    const o = origin(w);
    const k = unit(w);
    const cx = (px - o.x) / k;
    const cy = (py - o.y) / k;
    if (cx >= 0 && cy >= 0 && cx < w.innerWidth && cy < w.innerHeight) return { win: w, x: cx, y: cy };
  }
  return null;
}
