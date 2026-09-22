/** 이미지 편집 — **순수 계산** (DOM 없음). 레이어 변형·좌표 변환·캔버스 크기·이력·저장 이름.
 *  픽셀을 만지는 것은 `pixels.ts`, 상태는 `store.ts`, 화면은 `Editor.tsx`·`Stage.tsx`·`Side.tsx` 다.
 *  ★여기 있는 것은 전부 `node --experimental-strip-types src/editor/model.test.ts` 로 판정한다 (사용자 지시 2026-09-22). */

export type Size = { w: number; h: number };
export type Rect = { x: number; y: number; w: number; h: number };

/** 레이어의 **변형** — 원본 픽셀(`sw`×`sh`)을 문서의 어느 자리에 얼마 크기로, 몇 도 돌려, 뒤집어 놓나.
 *  ★비파괴다: 픽셀은 그대로 두고 그릴 때만 적용한다. 합칠 때(`mergeDown`)와 저장할 때 굽는다. */
export type Xform = { x: number; y: number; w: number; h: number; rot: number; flipH: boolean; flipV: boolean };

export type LayerMeta = Xform & {
  id: string;
  name: string;
  on: boolean;
  /** 0~100 */
  opacity: number;
  /** 원본 픽셀 크기 */
  sw: number;
  sh: number;
};

export const rad = (d: number) => (d * Math.PI) / 180;

/** 레이어 상자의 가운데 (문서 좌표) */
export const centerOf = (l: Xform) => ({ x: l.x + l.w / 2, y: l.y + l.h / 2 });

/** 문서 좌표 → 레이어 **원본 픽셀** 좌표 (변형의 역). 붓이 어느 픽셀에 닿는지가 이것으로 정해진다 */
export function docToLayer(l: Xform & { sw: number; sh: number }, px: number, py: number): { x: number; y: number } {
  const c = centerOf(l);
  const dx = px - c.x;
  const dy = py - c.y;
  const r = -rad(l.rot);
  const rx = dx * Math.cos(r) - dy * Math.sin(r);
  const ry = dx * Math.sin(r) + dy * Math.cos(r);
  const ux = l.flipH ? -rx : rx;
  const uy = l.flipV ? -ry : ry;
  return { x: (ux / l.w + 0.5) * l.sw, y: (uy / l.h + 0.5) * l.sh };
}

/** 레이어 원본 픽셀 좌표 → 문서 좌표 */
export function layerToDoc(l: Xform & { sw: number; sh: number }, sx: number, sy: number): { x: number; y: number } {
  const ux = (sx / l.sw - 0.5) * l.w;
  const uy = (sy / l.sh - 0.5) * l.h;
  const rx = l.flipH ? -ux : ux;
  const ry = l.flipV ? -uy : uy;
  const r = rad(l.rot);
  const c = centerOf(l);
  return { x: c.x + rx * Math.cos(r) - ry * Math.sin(r), y: c.y + rx * Math.sin(r) + ry * Math.cos(r) };
}

/** 레이어의 네 모서리 (문서 좌표, 회전 포함) — 손잡이와 맞춤 판정이 쓴다 */
export function cornersOf(l: Xform): { x: number; y: number }[] {
  const c = centerOf(l);
  const r = rad(l.rot);
  const hw = l.w / 2;
  const hh = l.h / 2;
  return [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]].map(([x, y]) => ({
    x: c.x + x * Math.cos(r) - y * Math.sin(r),
    y: c.y + x * Math.sin(r) + y * Math.cos(r),
  }));
}

/** 그 문서 좌표가 레이어 상자 안인가 (회전을 푼 자리로 본다) */
export function hitLayer(l: Xform & { sw: number; sh: number }, px: number, py: number): boolean {
  const p = docToLayer(l, px, py);
  return p.x >= 0 && p.y >= 0 && p.x <= l.sw && p.y <= l.sh;
}

/** 붓 지름(문서 px)을 원본 픽셀 지름으로. 가로·세로 배율이 다르면 평균을 쓴다 */
export const brushScale = (l: Xform & { sw: number; sh: number }) => (l.sw / l.w + l.sh / l.h) / 2;

/** 새 그림을 문서에 놓는 자리 — 들어가면 **원본 크기로 가운데**, 크면 **맞춰 줄여** 가운데 (사용자가 다시 키울 수 있다) */
export function placeNew(doc: Size, img: Size): Rect {
  const k = Math.min(1, doc.w / img.w, doc.h / img.h);
  const w = Math.round(img.w * k);
  const h = Math.round(img.h * k);
  return { x: Math.round((doc.w - w) / 2), y: Math.round((doc.h - h) / 2), w, h };
}

/** 캔버스 크기 바꾸기 — 기준점(0·0.5·1)에 따라 레이어가 얼마나 밀리나 */
export type Anchor = { ax: 0 | 0.5 | 1; ay: 0 | 0.5 | 1 };
export function canvasShift(from: Size, to: Size, a: Anchor): { dx: number; dy: number } {
  return { dx: Math.round((to.w - from.w) * a.ax), dy: Math.round((to.h - from.h) * a.ay) };
}

/** 이미지 크기 바꾸기 — 문서와 레이어 전부를 같은 비로 (원본 픽셀은 그대로, 변형만 커진다) */
export function scaleXform(l: Xform, sx: number, sy: number): Xform {
  return { ...l, x: l.x * sx, y: l.y * sy, w: l.w * sx, h: l.h * sy };
}

/** 자르기 — 자른 상자가 새 문서의 원점이 된다 */
export function cropShift(l: Xform, r: Rect): Xform {
  return { ...l, x: l.x - r.x, y: l.y - r.y };
}

/** 90° 회전 — 상자의 가운데를 지키며 회전값만 더한다 (0~359 로 접는다) */
export const rotate90 = (l: Xform): Xform => ({ ...l, rot: ((l.rot + 90) % 360 + 360) % 360 });

/** 비율 잠금으로 폭을 고쳤을 때의 높이 (또는 그 반대) */
export const withRatio = (w: number, h: number, nextW: number) => Math.max(1, Math.round((nextW * h) / w));

/** 자르기 상자를 문서 안으로 붙들고 정수로 */
export function normRect(r: Rect, doc: Size): Rect {
  const x0 = Math.max(0, Math.min(doc.w, Math.round(Math.min(r.x, r.x + r.w))));
  const y0 = Math.max(0, Math.min(doc.h, Math.round(Math.min(r.y, r.y + r.h))));
  const x1 = Math.max(0, Math.min(doc.w, Math.round(Math.max(r.x, r.x + r.w))));
  const y1 = Math.max(0, Math.min(doc.h, Math.round(Math.max(r.y, r.y + r.h))));
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/* ── 이력 ──────────────────────────────────────────────────────── */

export type Hist<T> = { past: T[]; future: T[] };
/** 한 문서가 들고 있는 걸음 수. 레이어 픽셀을 한 걸음마다 한 벌씩 들므로 많이 두지 않는다 (1216×832 한 장이 4MB) */
export const HIST_MAX = 20;
export const emptyHist = <T,>(): Hist<T> => ({ past: [], future: [] });

/** 한 걸음 적는다 — 되돌릴 미래는 버린다 (편집기의 보통 규칙) */
export function pushHist<T>(h: Hist<T>, snap: T): Hist<T> {
  return { past: [...h.past.slice(-(HIST_MAX - 1)), snap], future: [] };
}
export function undoHist<T>(h: Hist<T>, cur: T): { h: Hist<T>; snap: T } | null {
  if (!h.past.length) return null;
  const snap = h.past[h.past.length - 1];
  return { h: { past: h.past.slice(0, -1), future: [cur, ...h.future] }, snap };
}
export function redoHist<T>(h: Hist<T>, cur: T): { h: Hist<T>; snap: T } | null {
  if (!h.future.length) return null;
  const [snap, ...rest] = h.future;
  return { h: { past: [...h.past, cur], future: rest }, snap };
}

/* ── 이름·저장 자리 ─────────────────────────────────────────────── */

/** 「레이어 N」 — 있는 이름과 안 겹치는 다음 번호 */
export function nextName(names: string[], base: (n: number) => string): string {
  for (let n = 1; ; n++) {
    const c = base(n);
    if (!names.includes(c)) return c;
  }
}

/** 저장 파일 이름 — 원본 줄기 + `_edit` + 형식. 원본이 없으면 `edit` */
export function saveNameOf(srcName: string | null | undefined, fmt: "png" | "webp"): string {
  const stem = (srcName ?? "").replace(/\.[^.]+$/, "");
  return stem ? `${stem}_edit.${fmt}` : `edit.${fmt}`;
}

/** 원본 파일이 든 폴더 (아웃풋 루트 기준 상대 경로거나 절대 경로). 자리를 모르면 빈 문자열 */
export function dirOf(p: string | undefined): string {
  if (!p) return "";
  const cut = p.replace(/[\\/][^\\/]*$/, "");
  return cut === p ? "" : cut;
}

/** 저장 자리 — 검열·일괄 변환과 같은 세 갈래 (`tools.MODES`).
 *  덮어쓰기는 `{mode}` 만, 하위 output 은 원본 폴더 아래 `output`, 고른 폴더는 그 폴더.
 *  ★원본 자리를 모르는 문서(새 문서·떨군 바이트)는 `sub`·`overwrite` 가 성립하지 않아 `dest` 가 비어 온다 —
 *    화면은 그때 「저장 폴더 지정」만 열어 둔다. */
export function destOf(
  mode: "overwrite" | "sub" | "folder",
  dest: string,
  srcDir: string,
): { mode: "overwrite" } | { mode: "sub" | "folder"; dest: string } {
  if (mode === "overwrite") return { mode };
  if (mode === "folder") return { mode, dest };
  return { mode, dest: srcDir ? `${srcDir}/output`.replace(/^\//, "") : "" };
}
