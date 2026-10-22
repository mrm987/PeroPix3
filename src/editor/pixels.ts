/** 이미지 편집 — **픽셀을 만지는 곳** (캔버스 API). 계산은 `model.ts`, 상태는 `store.ts`.
 *
 *  ★레이어 픽셀은 **불변**으로 다룬다: 획 하나·보정 적용·합치기는 언제나 **새 캔버스**를 만든다. 이력(`Hist`)이
 *    옛 캔버스를 그대로 들고 있으므로 되돌리기는 참조를 바꾸는 것으로 끝난다.
 *  ★합성은 **문서 좌표계**에서 한다 — 레이어의 변형(자리·크기·회전·반전)은 그릴 때 `ctx` 변환으로 건다 (비파괴). */
import { adjustOps, centerOf, filterOf, floodFill, hexRgb, layoutText, rad, textBaseline, type LayerMeta, type Rect, type Size, type TextMeta, type Xform } from "./model";
import { bodyFor, bubbleBounds, bubbleShape, panelPts, wrapLines, type BubbleMeta, type ComicMeta, type PanelMeta, type Pt } from "./comic";
import { SFX_FALLBACK, layoutSfx, primaryFamily, sfxBounds, type Glyph, type SfxMeta } from "./sfx";
import { FX_AMT, applyFx, applyFxList, fxListKey, liveFx, type Fx, type FxKind } from "./fx";
import { canvasFilterOk, colorPixels } from "../lib/canvasFilter";

export type Layer = LayerMeta & { cv: HTMLCanvasElement };

export function makeCanvas(w: number, h: number): HTMLCanvasElement {
  const cv = document.createElement("canvas");
  cv.width = Math.max(1, Math.round(w));
  cv.height = Math.max(1, Math.round(h));
  return cv;
}

export function cloneCanvas(src: HTMLCanvasElement): HTMLCanvasElement {
  const cv = makeCanvas(src.width, src.height);
  cv.getContext("2d")!.drawImage(src, 0, 0);
  return cv;
}

export function canvasFrom(img: ImageBitmap): HTMLCanvasElement {
  const cv = makeCanvas(img.width, img.height);
  cv.getContext("2d")!.drawImage(img, 0, 0);
  return cv;
}

/** 캔버스를 넓힐 때의 「빈 자리」 — 새 크기를 색으로 채우고 **지금 캔버스 자리(`hole`)만 비운** 캔버스 */
export function fillAround(w: number, h: number, color: string, hole: Rect): HTMLCanvasElement {
  const cv = makeCanvas(w, h);
  const g = cv.getContext("2d")!;
  g.fillStyle = color;
  g.fillRect(0, 0, cv.width, cv.height);
  g.clearRect(hole.x, hole.y, hole.w, hole.h);
  return cv;
}

/** 긋는 중인 획 — 레이어 원본 크기의 캔버스에 **불투명 100%** 로 모아 두고, 그릴 때 한 번에 불투명도를 건다.
 *  ★도장을 찍을 때마다 불투명도를 걸면 겹치는 자리가 진해진다 (포토샵의 획 단위 불투명도와 다르다). */
export type Stroke = { cv: HTMLCanvasElement; alpha: number; erase: boolean };

/** 레이어의 변형을 `ctx` 에 건다 — 이 뒤로는 레이어 원본 상자(-w/2..w/2)에 그리면 된다 */
function applyXform(ctx: CanvasRenderingContext2D, l: Xform) {
  const c = centerOf(l);
  ctx.translate(c.x, c.y);
  ctx.rotate(rad(l.rot));
  ctx.scale(l.flipH ? -1 : 1, l.flipV ? -1 : 1);
}

/* ── 효과 ───────────────────────────────────────────────────────── */

/** 효과를 입힌 사본 — 원본 캔버스마다 최근 몇 벌을 들고 있다 (같은 캔버스를 두 레이어가 나눠 쓸 수 있다) */
const fxDone = new WeakMap<HTMLCanvasElement, Map<string, HTMLCanvasElement>>();
/** 캔버스마다 가장 최근에 다 된 것 — 새 것이 셈 중일 때 대신 보여 준다 */
const fxLast = new WeakMap<HTMLCanvasElement, HTMLCanvasElement>();
/** 워커에 맡길 차례를 기다리는 것 (캔버스마다 가장 최근 것 하나만) · 맡겨 둔 캔버스 */
const fxWant = new WeakMap<HTMLCanvasElement, Fx[]>();
const fxBusy = new WeakSet<HTMLCanvasElement>();
const fxListeners = new Set<() => void>();
/** 워커가 효과를 다 셈하면 불린다 — 무대가 다시 그린다 */
export function onFxReady(f: () => void): () => void {
  fxListeners.add(f);
  return () => void fxListeners.delete(f);
}
const FX_KEEP = 3;
let worker: Worker | null = null;
let workerBroken = false;
let nextJob = 1;
const jobs = new Map<number, (buf: ArrayBuffer) => void>();

function fxWorker(): Worker | null {
  if (worker || workerBroken) return worker;
  try {
    worker = new Worker(new URL("./fxWorker.ts", import.meta.url), { type: "module" });
    worker.onmessage = (e: MessageEvent<{ id: number; data: ArrayBuffer }>) => {
      const done = jobs.get(e.data.id);
      jobs.delete(e.data.id);
      done?.(e.data.data);
    };
    // ★워커가 죽으면 그 자리에서 셈한다 (느려도 그림은 맞다)
    worker.onerror = () => {
      workerBroken = true;
      worker = null;
      jobs.clear();
      fxListeners.forEach((f) => f());
    };
  } catch {
    workerBroken = true;
    worker = null;
  }
  return worker;
}

function keepFx(cv: HTMLCanvasElement, key: string, out: HTMLCanvasElement) {
  let m = fxDone.get(cv);
  if (!m) fxDone.set(cv, (m = new Map()));
  m.delete(key);
  m.set(key, out);
  while (m.size > FX_KEEP) m.delete(m.keys().next().value!);
  fxLast.set(cv, out);
}

function fxCanvasOf(w: number, h: number, data: Uint8ClampedArray): HTMLCanvasElement {
  const out = makeCanvas(w, h);
  out.getContext("2d")!.putImageData(new ImageData(new Uint8ClampedArray(data.buffer as ArrayBuffer, data.byteOffset, data.length), w, h), 0, 0);
  return out;
}

function pumpFx(cv: HTMLCanvasElement, wk: Worker) {
  if (fxBusy.has(cv)) return;
  const fx = fxWant.get(cv);
  if (!fx) return;
  fxWant.delete(cv);
  fxBusy.add(cv);
  const data = cv.getContext("2d")!.getImageData(0, 0, cv.width, cv.height).data;
  const id = nextJob++;
  jobs.set(id, (buf) => {
    fxBusy.delete(cv);
    keepFx(cv, fxListKey(fx), fxCanvasOf(cv.width, cv.height, new Uint8ClampedArray(buf)));
    pumpFx(cv, wk);
    fxListeners.forEach((f) => f());
  });
  wk.postMessage({ id, data: data.buffer, w: cv.width, h: cv.height, fx }, [data.buffer]);
}

/** 레이어 픽셀에 효과(목록, 건 차례대로)를 입힌 것. `live`(무대)면 워커에 맡기고 다 될 때까지 앞의 결과(없으면 원본)를 준다 —
 *  ★저장·합치기·미리보기는 `live` 없이 불러 **그 자리에서** 셈한 정확한 것을 받는다 */
export function withFx(cv: HTMLCanvasElement, list: readonly Fx[] | null | undefined, live = false): HTMLCanvasElement {
  const fx = liveFx(list);
  if (!fx.length) return cv;
  const key = fxListKey(fx);
  const hit = fxDone.get(cv)?.get(key);
  if (hit) {
    fxLast.set(cv, hit);
    return hit;
  }
  const wk = live ? fxWorker() : null;
  if (!wk) {
    const data = cv.getContext("2d")!.getImageData(0, 0, cv.width, cv.height).data;
    const out = fxCanvasOf(cv.width, cv.height, applyFxList(data, cv.width, cv.height, fx));
    keepFx(cv, key, out);
    return out;
  }
  fxWant.set(cv, fx);
  pumpFx(cv, wk);
  return fxLast.get(cv) ?? cv;
}

/** 효과 칸의 작은 미리보기 — 레이어를 칸 크기로 줄여 입힌다 (크기에 매인 값이 짧은 변에 비례하므로 모양이 같다) */
const fxThumbs = new WeakMap<HTMLCanvasElement, Map<string, string>>();
export function fxThumb(cv: HTMLCanvasElement, kind: FxKind | null, w: number, h: number): string {
  const key = `${kind}:${w}x${h}`;
  let m = fxThumbs.get(cv);
  if (!m) fxThumbs.set(cv, (m = new Map()));
  const had = m.get(key);
  if (had) return had;
  const k = Math.max(w / cv.width, h / cv.height);
  const small = makeCanvas(w, h);
  const g = small.getContext("2d")!;
  g.drawImage(cv, (w - cv.width * k) / 2, (h - cv.height * k) / 2, cv.width * k, cv.height * k);
  const out = kind ? fxCanvasOf(w, h, applyFx(g.getImageData(0, 0, w, h).data, w, h, { kind, amt: FX_AMT, seed: 7 })) : small;
  const url = out.toDataURL("image/png");
  m.set(key, url);
  return url;
}

/** 보정을 **픽셀로** 입힌 사본 — `ctx.filter` 를 못 쓰는 웹뷰(맥, `lib/canvasFilter` 머리 주석)에서만 쓴다.
 *  ★레이어 픽셀은 불변이라(머리 주석) 캔버스마다 마지막 보정 하나를 들고 있으면 된다 (효과의 `fxDone` 과 같은 이유) */
const adjDone = new WeakMap<HTMLCanvasElement, { key: string; out: HTMLCanvasElement }>();
function withAdjust(cv: HTMLCanvasElement, a: LayerMeta["adj"]): HTMLCanvasElement {
  const key = filterOf(a);
  const hit = adjDone.get(cv);
  if (hit?.key === key) return hit.out;
  const data = cv.getContext("2d")!.getImageData(0, 0, cv.width, cv.height).data;
  colorPixels(data, adjustOps(a));
  const out = fxCanvasOf(cv.width, cv.height, data);
  adjDone.set(cv, { key, out });
  return out;
}

/** 레이어 하나를 문서 좌표계의 `ctx` 에 그린다 (불투명도·보정·효과·긋는 중인 획까지).
 *  ★보정(`l.adj`)·효과(`l.fx`)는 레이어의 속성이라 **언제나** 건다 — 합치기·저장이 이 함수를 거치므로 그때 픽셀에 굽힌다.
 *    효과를 먼저 입히고 보정(CSS 필터)은 그 위에 건다. 긋는 중인 획은 놓은 뒤에 효과가 입혀진다 */
export function drawLayer(ctx: CanvasRenderingContext2D, l: Layer, opt?: { stroke?: Stroke | null; clip?: Pt[] | null; live?: boolean }) {
  const px = withFx(l.cv, l.fx, opt?.live);
  ctx.save();
  // ★컷에 든 그림 — 그 컷 모양(문서 좌표)으로 자른다. 변형을 걸기 **전에** 건다 (컷은 문서 좌표다)
  if (opt?.clip?.length) {
    ctx.beginPath();
    opt.clip.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    ctx.closePath();
    ctx.clip();
  }
  ctx.globalAlpha = l.opacity / 100;
  const f = filterOf(l.adj);
  if (f && canvasFilterOk()) ctx.filter = f;
  // ★`ctx.filter` 를 못 쓰면(맥) 보정을 픽셀로 입힌 사본을 그린다
  const pic = f && !canvasFilterOk() ? withAdjust(px, l.adj) : px;
  applyXform(ctx, l);
  const st = opt?.stroke;
  if (st?.erase) {
    // ★지우개는 **레이어 안에서만** 지워야 한다 — 미리보기도 사본에서 지워서 그린다
    const tmp = cloneCanvas(pic);
    const g = tmp.getContext("2d")!;
    g.globalCompositeOperation = "destination-out";
    g.globalAlpha = st.alpha;
    g.drawImage(st.cv, 0, 0);
    ctx.drawImage(tmp, -l.w / 2, -l.h / 2, l.w, l.h);
  } else {
    ctx.drawImage(pic, -l.w / 2, -l.h / 2, l.w, l.h);
    if (st) {
      ctx.globalAlpha = (l.opacity / 100) * st.alpha;
      ctx.drawImage(st.cv, -l.w / 2, -l.h / 2, l.w, l.h);
    }
  }
  ctx.restore();
}

/** 문서를 통째로 합성한다. `scale` 은 화면 배율 (저장은 1). `sel` 레이어에만 긋는 중인 획을 얹고, `skip` 은 안 그린다
 *  (글자를 고치는 동안 그 레이어 — 글 상자가 그 자리에 떠 있어 겹치면 두 번 보인다) */
export function composite(
  doc: Size & { layers: Layer[] },
  out: HTMLCanvasElement,
  scale = 1,
  opt?: { sel?: string | null; stroke?: Stroke | null; skip?: string | null; live?: boolean },
) {
  const w = Math.max(1, Math.round(doc.w * scale));
  const h = Math.max(1, Math.round(doc.h * scale));
  if (out.width !== w || out.height !== h) {
    out.width = w;
    out.height = h;
  }
  const ctx = out.getContext("2d")!;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, w, h);
  ctx.save();
  ctx.scale(w / doc.w, h / doc.h);
  for (const l of doc.layers) {
    if (!l.on || l.id === opt?.skip) continue;
    drawLayer(ctx, l, { stroke: l.id === opt?.sel ? opt?.stroke : null, clip: clipOf(doc.layers, l), live: opt?.live });
  }
  ctx.restore();
}

/** 그 그림이 든 컷의 모양 (문서 좌표). 컷에 안 들었거나 컷이 없어졌으면 null */
export function clipOf(layers: Layer[], l: LayerMeta): Pt[] | null {
  if (!l.clip) return null;
  const p = layers.find((x) => x.id === l.clip && x.panel);
  return p?.panel ? panelPts(p, p.panel.pts) : null;
}

/* ── 글자 ───────────────────────────────────────────────────────── */

export const fontOf = (t: TextMeta) => `${t.bold ? "bold " : ""}${t.size}px ${t.font}`;

let probe: CanvasRenderingContext2D | null = null;
/** 글자 상자의 크기와 줄 자리 — 글 상자(편집 중)와 굽기가 **같은 셈**을 쓴다.
 *  `baseline` 은 줄 위에서 기준선까지 — 글꼴의 올림·내림 높이(주 글꼴의 것, CSS 가 줄 상자에 쓰는 값과 같다)로 셈한다 */
export function textLayout(t: TextMeta) {
  if (!probe) probe = makeCanvas(1, 1).getContext("2d")!;
  probe.font = fontOf(t);
  const lines = t.value.split("\n");
  const ms = lines.map((s) => probe!.measureText(s));
  const L = layoutText(t, ms.map((m) => m.width));
  return { lines, ...L, baseline: textBaseline(L.lineH, ms[0].fontBoundingBoxAscent, ms[0].fontBoundingBoxDescent) };
}

/** 글자 레이어의 픽셀 — 원문·글꼴·크기·색·정렬로 새로 굽는다 (빈 글이면 여백만큼의 빈 캔버스).
 *  ★기준선은 alphabetic 을 글 상자(CSS)와 같은 자리에 둔다 — `top` 으로 그리면 편집 중보다 위로 올라간다 (사용자 지적 2026-09-22) */
export function renderText(t: TextMeta): HTMLCanvasElement {
  const L = textLayout(t);
  const cv = makeCanvas(L.w, L.h);
  const g = cv.getContext("2d")!;
  g.font = fontOf(t);
  g.fillStyle = t.color;
  g.textBaseline = "alphabetic";
  L.lines.forEach((s, i) => g.fillText(s, L.xs[i], L.pad + i * L.lineH + L.baseline));
  return cv;
}

/** 글자 레이어를 **원문·글꼴에서 다시 굽는다** — 상자를 늘려 둔 비율(`w / sw`)은 글꼴 크기로 옮기고 가운데는 그 자리에 둔다.
 *  손잡이를 놓을 때(`store.settleText`)와 켜서 되살릴 때(`persist.loadDocs`)가 **같은 것**을 쓴다 — 굽는 셈이 바뀌면 남겨 둔
 *  레이어도 다시 켤 때 새 셈을 따른다 (사용자 지적 2026-09-22: 기준선을 고친 뒤에도 전에 구운 픽셀이 그대로 보였다).
 *  글자 레이어가 아니면 null */
export function rebakeText(l: Layer): Pick<Layer, "text" | "cv" | "sw" | "sh" | "w" | "h" | "x" | "y"> | null {
  if (!l.text) return null;
  const text: TextMeta = { ...l.text, size: Math.max(1, Math.round(l.text.size * (l.w / l.sw))) };
  const cv = renderText(text);
  const c = centerOf(l);
  return { text, cv, sw: cv.width, sh: cv.height, w: cv.width, h: cv.height, x: c.x - cv.width / 2, y: c.y - cv.height / 2 };
}

/** 그 글을 그 글꼴로 그릴 수 있게 글꼴을 **먼저 싣는다** — 캔버스는 안 실린 글꼴을 기다리지 않고 대체 글꼴로 그려 버린다.
 *  번들 글꼴 둘(Gothic A1·Noto Sans KR)은 유니코드 구간별로 쪼개져 있어 **그 글의 글자**로 불러야 필요한 조각이 실린다 */
export const ensureFont = (t: TextMeta): Promise<void> =>
  document.fonts.load(fontOf(t), t.value || " ").then(() => undefined, () => undefined);

/* ── 만화 페이지: 컷 · 말풍선 ───────────────────────────────────── */

/** 컷 테두리 — 레이어 상자 크기의 캔버스에 다각형 **안쪽으로** 그린다 (그림을 자르는 자리와 선의 바깥 변이 같다).
 *  「테두리 없음」이면 빈 캔버스 */
export function bakePanel(meta: PanelMeta, w: number, h: number, page: Pick<ComicMeta, "border" | "color">): HTMLCanvasElement {
  const cv = makeCanvas(w, h);
  if (meta.noBorder || page.border <= 0) return cv;
  const g = cv.getContext("2d")!;
  g.beginPath();
  meta.pts.forEach(([u, v], i) => (i ? g.lineTo(u * cv.width, v * cv.height) : g.moveTo(u * cv.width, v * cv.height)));
  g.closePath();
  g.save();
  g.clip();
  g.lineJoin = "miter";
  g.lineWidth = page.border * 2;
  g.strokeStyle = page.color;
  g.stroke();
  g.restore();
  return cv;
}

/** 말풍선 글 — 가로쓰기는 줄, 세로쓰기는 **세로 줄(열)** 이다. 글 상자 크기(`tw`×`th`)와 줄마다의 글.
 *  풍선에 맞춤이면 몸통 안쪽 폭(세로쓰기는 높이)에서 줄을 바꾼다 */
export function bubbleText(b: BubbleMeta) {
  if (!probe) probe = makeCanvas(1, 1).getContext("2d")!;
  const font = fontOf({ ...b, value: b.value });
  probe.font = font;
  const measure = (s: string) => probe!.measureText(s).width;
  const lineH = Math.ceil(b.size * b.lineGap);
  const k = b.kind === "narration" ? 1 : b.kind === "shout" ? 1.55 : b.kind === "thought" ? 1.5 : Math.SQRT2;
  const innerW = Math.max(b.size, (b.body.w - b.pad * 2) / k);
  const innerH = Math.max(b.size, (b.body.h - b.pad * 2) / k);
  const adv = Math.ceil(b.size * 1.04);
  if (b.vertical) {
    const cap = Math.max(1, Math.floor(innerH / adv));
    // 풍선에 맞춤이면 한 열이 몸통 높이를 넘지 않게 글자 수로 자른다
    const cols = b.fit === "box"
      ? b.value.split("\n").flatMap((s) => {
          const cs = [...s];
          if (!cs.length) return [""];
          const out: string[] = [];
          for (let i = 0; i < cs.length; i += cap) out.push(cs.slice(i, i + cap).join(""));
          return out;
        })
      : b.value.split("\n");
    const most = Math.max(1, ...cols.map((c) => [...c].length));
    return { font, lines: cols, lineH, adv, tw: lineH * Math.max(1, cols.length), th: adv * most, asc: 0, desc: 0, widths: undefined as number[] | undefined };
  }
  const lines = b.fit === "box" ? wrapLines(b.value, innerW, measure) : b.value.split("\n");
  const ms = lines.map((s) => probe!.measureText(s || " "));
  const tw = Math.ceil(Math.max(b.size * 2, ...ms.map((m) => m.width)));
  return { font, lines, lineH, adv, tw, th: lineH * Math.max(1, lines.length), asc: ms[0].fontBoundingBoxAscent, desc: ms[0].fontBoundingBoxDescent, widths: ms.map((m) => m.width) };
}

/** 글에 맞춤이면 몸통을 글에 맞춰 다시 잰다 (가운데는 그 자리) — 풍선에 맞춤이면 그대로 */
export function fitBubble(b: BubbleMeta): BubbleMeta {
  if (b.fit !== "text") return b;
  const L = bubbleText(b);
  const s = bodyFor(b.kind, L.tw, L.th, b.pad);
  const cx = b.body.x + b.body.w / 2;
  const cy = b.body.y + b.body.h / 2;
  return { ...b, body: { x: cx - s.w / 2, y: cy - s.h / 2, w: s.w, h: s.h } };
}

/** 말풍선을 굽는다 → 레이어 상자(`bubbleBounds`)와 그 크기의 캔버스.
 *  ★선을 먼저 모두 긋고 채움을 선 없이 덮는다 — 몸통과 꼬리가 이음매 없는 한 외곽선이 된다 (선은 안쪽 반이 덮이므로 두 배로 긋는다).
 *  `hideText` 는 글을 고치는 동안 (글 상자가 그 자리에 떠 있다) */
export function bakeBubble(b: BubbleMeta, hideText = false): { box: Rect; cv: HTMLCanvasElement } {
  const box = bubbleBounds(b);
  const cv = makeCanvas(box.w, box.h);
  const g = cv.getContext("2d")!;
  g.translate(-box.x, -box.y);
  const sh = bubbleShape(b);
  const paths = [sh.body, ...sh.tails].map((d) => new Path2D(d));
  g.lineJoin = "round";
  g.strokeStyle = b.line;
  g.fillStyle = b.fill;
  if (b.stroke > 0) {
    g.lineWidth = b.stroke * 2;
    if (sh.dash) g.setLineDash([b.stroke * 3, b.stroke * 2.6]);
    for (const p of paths) g.stroke(p);
    g.setLineDash([]);
  }
  for (const p of paths) g.fill(p);
  for (const [x, y, r] of sh.dots) {
    g.beginPath();
    g.arc(x, y, r, 0, Math.PI * 2);
    g.fill();
    if (b.stroke > 0) {
      g.lineWidth = b.stroke;
      g.stroke();
    }
  }
  if (!hideText && b.value) {
    const L = bubbleText(b);
    const cx = b.body.x + b.body.w / 2;
    const cy = b.body.y + b.body.h / 2;
    g.font = L.font;
    g.fillStyle = b.color;
    if (b.vertical) {
      // 세로쓰기 — 오른쪽 열부터, 글자마다 가운데에
      g.textAlign = "center";
      g.textBaseline = "middle";
      L.lines.forEach((col, i) => {
        const x = cx + L.tw / 2 - L.lineH / 2 - i * L.lineH;
        [...col].forEach((ch, j) => g.fillText(ch, x, cy - L.th / 2 + (j + 0.5) * L.adv));
      });
    } else {
      g.textAlign = "left";
      g.textBaseline = "alphabetic";
      const base = textBaseline(L.lineH, L.asc, L.desc);
      L.lines.forEach((s, i) => {
        const lw = L.widths?.[i] ?? 0;
        const x = b.align === "left" ? cx - L.tw / 2 : b.align === "right" ? cx + L.tw / 2 - lw : cx - lw / 2;
        g.fillText(s, x, cy - L.th / 2 + i * L.lineH + base);
      });
    }
  }
  return { box, cv };
}

/* ── 만화 페이지: 효과음 ─────────────────────────────────────────── */

/** 그 글자가 주 글꼴에 **있나** — 캔버스는 없는 글자를 말없이 대체 글꼴로 그리므로, 두 기본 글꼴(고정폭·세리프)을
 *  뒤에 붙여 잰 폭이 **둘 다** 기본 글꼴만의 폭과 같으면 없는 것이다 (설계 9-2 ★★: 한국어 효과음 글꼴에 빠진 음절이 있다) */
const hasGlyphCache = new Map<string, boolean>();
export function hasGlyph(ch: string, family: string): boolean {
  if (!family || !ch.trim()) return true;
  const key = `${family}\u0000${ch}`;
  const hit = hasGlyphCache.get(key);
  if (hit !== undefined) return hit;
  if (!probe) probe = makeCanvas(1, 1).getContext("2d")!;
  const w = (f: string) => {
    probe!.font = `64px ${f}`;
    return probe!.measureText(ch).width;
  };
  const q = `'${family.replace(/'/g, "")}'`;
  const has = w(`${q}, monospace`) !== w("monospace") || w(`${q}, serif`) !== w("serif");
  // 글꼴을 아직 안 받았으면 「없다」로 나온다 — 받은 뒤 다시 재야 하므로 그때는 적어 두지 않는다
  if (has || document.fonts.check(`64px ${q}`, ch)) hasGlyphCache.set(key, has);
  return has;
}
/** 글꼴을 새로 받았으면 잰 것을 버린다 (`comicFonts` 가 부른다) */
export const forgetGlyphs = () => hasGlyphCache.clear();

const sfxFont = (m: SfxMeta, size: number, font: string) => `${m.bold ? "bold " : ""}${size}px ${font}`;

/** 효과음의 글자 배치 — 글자마다 주 글꼴에 없으면 대체 글꼴로 (`sfx.SFX_FALLBACK`) */
export function sfxGlyphs(m: SfxMeta): Glyph[] {
  if (!probe) probe = makeCanvas(1, 1).getContext("2d")!;
  const fam = primaryFamily(m.font);
  return layoutSfx(
    m,
    (ch, size, font) => {
      probe!.font = sfxFont(m, size, font);
      return probe!.measureText(ch).width;
    },
    (ch, font) => (hasGlyph(ch, fam) ? font : SFX_FALLBACK),
  );
}

/** 대체 글꼴로 그린 글자들 — 화면이 알린다 (설계 9-2: 굵기·모양이 달라지므로) */
export const sfxSubstituted = (m: SfxMeta): string[] => [...new Set(sfxGlyphs(m).filter((g) => g.font === SFX_FALLBACK && g.ch.trim()).map((g) => g.ch))];

/** 효과음을 굽는다 → 상자(원점 기준)와 그 크기의 캔버스.
 *  ★네 번 나눠 긋는다 — 그림자 → 바깥 외곽선 → 안쪽 외곽선 → 채움. 층마다 **글 전체**를 한 번에 그려서 이웃 글자의 외곽선이 한 덩어리가 된다 */
export function bakeSfx(m: SfxMeta): { box: Rect; cv: HTMLCanvasElement } {
  const glyphs = sfxGlyphs(m);
  const box = sfxBounds(m, glyphs);
  const cv = makeCanvas(box.w, box.h);
  const g = cv.getContext("2d")!;
  g.translate(-box.x, -box.y);
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.lineJoin = "round";
  g.miterLimit = 2;
  const skew = Math.tan((m.skew * Math.PI) / 180);
  const each = (fn: (gl: Glyph) => void, dx = 0, dy = 0) => {
    for (const gl of glyphs) {
      if (!gl.ch.trim()) continue;
      g.save();
      g.translate(gl.x + dx, gl.y + dy);
      g.rotate((gl.rot * Math.PI) / 180);
      g.transform(1, 0, skew, 1, 0, 0);
      g.font = sfxFont(m, gl.size, gl.font);
      fn(gl);
      g.restore();
    }
  };
  const inner = m.inner * m.size;
  const outer = m.outer * m.size;
  if (m.shadow > 0) {
    const d = m.shadow * m.size;
    g.fillStyle = m.shadowColor;
    g.strokeStyle = m.shadowColor;
    g.lineWidth = (inner + outer) * 2;
    each((gl) => {
      if (g.lineWidth > 0) g.strokeText(gl.ch, 0, 0);
      g.fillText(gl.ch, 0, 0);
    }, d, d);
  }
  if (outer > 0) {
    g.strokeStyle = m.outerColor;
    g.lineWidth = (inner + outer) * 2;
    each((gl) => g.strokeText(gl.ch, 0, 0));
  }
  if (inner > 0) {
    g.strokeStyle = m.innerColor;
    g.lineWidth = inner * 2;
    each((gl) => g.strokeText(gl.ch, 0, 0));
  }
  if (m.fill2 && glyphs.some((gl) => gl.ch.trim())) {
    // 위 → 아래 그라데이션 — 글 전체 상자에 걸친다 (글자마다 따로면 줄무늬가 된다).
    // 채움만 따로 판에 그리고 그 모양 안(`source-in`)에 그라데이션을 부은 뒤 얹는다
    const top = Math.min(...glyphs.map((gl) => gl.y - gl.size / 2)) - box.y;
    const bot = Math.max(...glyphs.map((gl) => gl.y + gl.size / 2)) - box.y;
    const tmp = makeCanvas(box.w, box.h);
    const t = tmp.getContext("2d")!;
    t.translate(-box.x, -box.y);
    t.textAlign = "center";
    t.textBaseline = "middle";
    t.fillStyle = "#000";
    for (const gl of glyphs) {
      if (!gl.ch.trim()) continue;
      t.save();
      t.translate(gl.x, gl.y);
      t.rotate((gl.rot * Math.PI) / 180);
      t.transform(1, 0, skew, 1, 0, 0);
      t.font = sfxFont(m, gl.size, gl.font);
      t.fillText(gl.ch, 0, 0);
      t.restore();
    }
    t.setTransform(1, 0, 0, 1, 0, 0);
    t.globalCompositeOperation = "source-in";
    const grad = t.createLinearGradient(0, top, 0, bot);
    grad.addColorStop(0, m.fill);
    grad.addColorStop(1, m.fill2);
    t.fillStyle = grad;
    t.fillRect(0, 0, tmp.width, tmp.height);
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.drawImage(tmp, 0, 0);
  } else {
    g.fillStyle = m.fill;
    each((gl) => g.fillText(gl.ch, 0, 0));
  }
  return { box, cv };
}

/** 획을 레이어에 **굽는다** → 새 캔버스 */
export function bakeStroke(l: Layer, st: Stroke): HTMLCanvasElement {
  const cv = cloneCanvas(l.cv);
  const g = cv.getContext("2d")!;
  g.globalCompositeOperation = st.erase ? "destination-out" : "source-over";
  g.globalAlpha = st.alpha;
  g.drawImage(st.cv, 0, 0);
  return cv;
}

/** 원본 픽셀의 네 변에 투명한 픽셀을 덧붙인다 (`model.growFor` 의 `pad`) */
export function padCanvas(src: HTMLCanvasElement, pad: { l: number; t: number; r: number; b: number }): HTMLCanvasElement {
  const cv = makeCanvas(src.width + pad.l + pad.r, src.height + pad.t + pad.b);
  cv.getContext("2d")!.drawImage(src, pad.l, pad.t);
  return cv;
}

/** 위 레이어를 아래 레이어의 **원본 픽셀 공간**에 그려 넣는다 → 아래 레이어의 새 캔버스.
 *  아래 레이어의 변형은 그대로 두고, 위 레이어는 문서 좌표로 그린 것을 아래의 역변환으로 받는다. */
export function mergeInto(below: Layer, top: Layer, clip?: Pt[] | null): HTMLCanvasElement {
  const cv = cloneCanvas(below.cv);
  const g = cv.getContext("2d")!;
  const c = centerOf(below);
  g.translate(below.sw / 2, below.sh / 2);
  g.scale(below.sw / below.w, below.sh / below.h);
  g.scale(below.flipH ? -1 : 1, below.flipV ? -1 : 1);
  g.rotate(-rad(below.rot));
  g.translate(-c.x, -c.y);
  drawLayer(g, top, { clip });
  return cv;
}

/** 원본 픽셀 자체를 다른 크기로 (「이미지 크기」가 원본을 줄일 때) */
export function resample(src: HTMLCanvasElement, w: number, h: number): HTMLCanvasElement {
  const cv = makeCanvas(w, h);
  const g = cv.getContext("2d")!;
  g.imageSmoothingQuality = "high";
  g.drawImage(src, 0, 0, cv.width, cv.height);
  return cv;
}

/** 페인트통 — 레이어 **원본 좌표** `(x, y)` 에서 이어진 같은 색을 `color` 로 채운다 → 새 캔버스.
 *  누른 자리가 레이어 밖이거나 바뀐 것이 없으면 null (그때는 걸음도 안 적는다) */
export function bucketFill(l: Layer, x: number, y: number, color: string, tol: number): HTMLCanvasElement | null {
  if (x < 0 || y < 0 || x >= l.sw || y >= l.sh) return null;
  const cv = cloneCanvas(l.cv);
  const g = cv.getContext("2d")!;
  const img = g.getImageData(0, 0, cv.width, cv.height);
  if (!floodFill(img.data, cv.width, cv.height, x, y, [...hexRgb(color), 255], tol)) return null;
  g.putImageData(img, 0, 0);
  return cv;
}

/* ── 붓 ─────────────────────────────────────────────────────────── */

const rgbaOf = (hex: string, a: number) => {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  const n = m ? parseInt(m[1], 16) : 0;
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
};

/** 도장 하나 — 지름 `d`, 경도 `hard`(0~1: 1 이면 가장자리가 딱 떨어진다) */
export function stamp(ctx: CanvasRenderingContext2D, x: number, y: number, d: number, hard: number, color: string) {
  const r = Math.max(0.5, d / 2);
  if (hard >= 0.99) ctx.fillStyle = rgbaOf(color, 1);
  else {
    const g = ctx.createRadialGradient(x, y, r * Math.max(0, hard), x, y, r);
    g.addColorStop(0, rgbaOf(color, 1));
    g.addColorStop(1, rgbaOf(color, 0));
    ctx.fillStyle = g;
  }
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
}

/** 두 점 사이를 도장으로 잇는다 — 간격은 지름의 15% (틈이 안 보이는 값) */
export function strokeTo(
  ctx: CanvasRenderingContext2D,
  from: { x: number; y: number } | null,
  to: { x: number; y: number },
  d: number,
  hard: number,
  color: string,
) {
  if (!from) return stamp(ctx, to.x, to.y, d, hard, color);
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dist = Math.hypot(dx, dy);
  const step = Math.max(0.75, d * 0.15);
  const n = Math.max(1, Math.ceil(dist / step));
  for (let i = 1; i <= n; i++) stamp(ctx, from.x + (dx * i) / n, from.y + (dy * i) / n, d, hard, color);
}

/* ── 내보내기·미리보기 ──────────────────────────────────────────── */

/** 문서 크기 그대로 PNG data URL (저장·i2i·인페인트가 받는다) */
export function exportDataUrl(doc: Size & { layers: Layer[] }): string {
  const cv = makeCanvas(doc.w, doc.h);
  composite(doc, cv, 1);
  return cv.toDataURL("image/png");
}

/** 레이어 목록의 작은 미리보기 — 캔버스가 같으면 다시 안 굽는다 */
const thumbs = new WeakMap<HTMLCanvasElement, string>();
export function thumbOf(cv: HTMLCanvasElement, w = 44, h = 30): string {
  const had = thumbs.get(cv);
  if (had) return had;
  const t = makeCanvas(w, h);
  const g = t.getContext("2d")!;
  const k = Math.min(w / cv.width, h / cv.height);
  const dw = cv.width * k;
  const dh = cv.height * k;
  g.drawImage(cv, (w - dw) / 2, (h - dh) / 2, dw, dh);
  const url = t.toDataURL("image/png");
  thumbs.set(cv, url);
  return url;
}

/** 캔버스가 비어 있는가 (레이어를 다 지웠는지 등) — 알파만 본다 */
export function isBlank(cv: HTMLCanvasElement): boolean {
  const g = cv.getContext("2d")!;
  const d = g.getImageData(0, 0, cv.width, cv.height).data;
  for (let i = 3; i < d.length; i += 4) if (d[i]) return false;
  return true;
}
