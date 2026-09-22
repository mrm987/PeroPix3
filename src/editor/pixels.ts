/** 이미지 편집 — **픽셀을 만지는 곳** (캔버스 API). 계산은 `model.ts`, 상태는 `store.ts`.
 *
 *  ★레이어 픽셀은 **불변**으로 다룬다: 획 하나·보정 적용·합치기는 언제나 **새 캔버스**를 만든다. 이력(`Hist`)이
 *    옛 캔버스를 그대로 들고 있으므로 되돌리기는 참조를 바꾸는 것으로 끝난다.
 *  ★합성은 **문서 좌표계**에서 한다 — 레이어의 변형(자리·크기·회전·반전)은 그릴 때 `ctx` 변환으로 건다 (비파괴). */
import { centerOf, filterOf, floodFill, hexRgb, layoutText, rad, textBaseline, type LayerMeta, type Rect, type Size, type TextMeta, type Xform } from "./model";

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

/** 레이어 하나를 문서 좌표계의 `ctx` 에 그린다 (불투명도·보정·긋는 중인 획까지).
 *  ★보정(`l.adj`)은 레이어의 속성이라 **언제나** 건다 — 합치기·저장이 이 함수를 거치므로 그때 픽셀에 굽힌다 */
export function drawLayer(ctx: CanvasRenderingContext2D, l: Layer, opt?: { stroke?: Stroke | null }) {
  ctx.save();
  ctx.globalAlpha = l.opacity / 100;
  const f = filterOf(l.adj);
  if (f) ctx.filter = f;
  applyXform(ctx, l);
  const st = opt?.stroke;
  if (st?.erase) {
    // ★지우개는 **레이어 안에서만** 지워야 한다 — 미리보기도 사본에서 지워서 그린다
    const tmp = cloneCanvas(l.cv);
    const g = tmp.getContext("2d")!;
    g.globalCompositeOperation = "destination-out";
    g.globalAlpha = st.alpha;
    g.drawImage(st.cv, 0, 0);
    ctx.drawImage(tmp, -l.w / 2, -l.h / 2, l.w, l.h);
  } else {
    ctx.drawImage(l.cv, -l.w / 2, -l.h / 2, l.w, l.h);
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
  opt?: { sel?: string | null; stroke?: Stroke | null; skip?: string | null },
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
    drawLayer(ctx, l, l.id === opt?.sel ? { stroke: opt?.stroke } : undefined);
  }
  ctx.restore();
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

/** 획을 레이어에 **굽는다** → 새 캔버스 */
export function bakeStroke(l: Layer, st: Stroke): HTMLCanvasElement {
  const cv = cloneCanvas(l.cv);
  const g = cv.getContext("2d")!;
  g.globalCompositeOperation = st.erase ? "destination-out" : "source-over";
  g.globalAlpha = st.alpha;
  g.drawImage(st.cv, 0, 0);
  return cv;
}

/** 위 레이어를 아래 레이어의 **원본 픽셀 공간**에 그려 넣는다 → 아래 레이어의 새 캔버스.
 *  아래 레이어의 변형은 그대로 두고, 위 레이어는 문서 좌표로 그린 것을 아래의 역변환으로 받는다. */
export function mergeInto(below: Layer, top: Layer): HTMLCanvasElement {
  const cv = cloneCanvas(below.cv);
  const g = cv.getContext("2d")!;
  const c = centerOf(below);
  g.translate(below.sw / 2, below.sh / 2);
  g.scale(below.sw / below.w, below.sh / below.h);
  g.scale(below.flipH ? -1 : 1, below.flipV ? -1 : 1);
  g.rotate(-rad(below.rot));
  g.translate(-c.x, -c.y);
  drawLayer(g, top);
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
