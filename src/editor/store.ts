/** 이미지 편집 — **상태** (문서·레이어·도구·이력). 계산은 `model.ts`, 픽셀은 `pixels.ts`.
 *
 *  ★문서는 **메모리에만** 있다 — 파일이 되는 것은 「저장」뿐이다 (검열과 같다). 앱을 껐다 켜면 비어 있다.
 *  ★★한 번의 편집은 `commit` 한 번이다: 직전 상태(크기·레이어 목록·고른 레이어)를 이력에 적고 바꾼다.
 *    레이어 픽셀은 불변이라(`pixels.ts` 머리) 이력이 든 것은 참조뿐이고, 되돌리기는 그 참조를 도로 놓는 것이다.
 *  ★저장 설정(자리·형식)과 캔버스 밖 배경은 **화면 상태**라 `useUi` 에 산다 (`editLast`·`editorBg`). */
import { create } from "zustand";
import { t } from "../i18n";
import { toast } from "../store/toast";
import { useUi } from "../store/ui";
import { ask } from "../store/ask";
import type { Dropped } from "../lib/dropImages";
import {
  FILL_COLOR, NO_ADJUST, canvasShift, cropShift, destOf, dirOf, emptyHist, growsBeyond, hasAdjust, nextName, placeNew, pushHist,
  redoHist, rotate90 as rot90, saveNameOf, scaleXform, undoHist, type Adjust, type Anchor, type Fill, type Hist, type Rect,
} from "./model";
import { bakeStroke, cloneCanvas, exportDataUrl, fillAround, makeCanvas, mergeInto, type Layer, type Stroke } from "./pixels";
import { loadItem, saveImage } from "./io";

export type Tool = "select" | "brush" | "eraser" | "crop" | "pan";

type Snap = { w: number; h: number; layers: Layer[]; sel: string | null };

export type Doc = {
  id: string;
  /** 탭에 뜨는 이름 — 원본 파일의 줄기, 또는 「새 문서 N」 */
  name: string;
  w: number;
  h: number;
  /** ★아래가 먼저다 (0 = 맨 뒤). 화면 목록은 뒤집어 그린다 (위가 앞) */
  layers: Layer[];
  sel: string | null;
  /** 첫 그림의 자리 — 저장 자리(하위 output·덮어쓰기)와 파일 이름의 근거. 새 문서·떨군 바이트는 null */
  src: { rel?: string; path?: string; name: string } | null;
  hist: Hist<Snap>;
  /** 마지막 저장(또는 열기) 뒤에 손댔나 — 탭의 점과 닫을 때의 물음 */
  dirty: boolean;
  view: { fit: boolean; zoom: number };
};

export type Brush = { size: number; hard: number; opacity: number; color: string };

type S = {
  docs: Doc[];
  cur: string | null;
  tool: Tool;
  brush: Brush;
  ratioLock: boolean;
  /** 자르기 상자 (문서 좌표). 자르기 도구에서 끄는 동안 */
  crop: Rect | null;
  /** 픽셀만 바뀌었을 때 화면이 다시 그리게 — 문서 객체가 안 바뀌는 획 미리보기 뒤 */
  rev: number;
  busy: boolean;

  doc: () => Doc | null;
  layer: () => Layer | null;
  canUndo: () => boolean;
  canRedo: () => boolean;

  openItems: (items: Dropped[], how: "new" | "layer") => Promise<void>;
  newDoc: (w?: number, h?: number) => void;
  closeDoc: (id: string) => Promise<void>;
  setCur: (id: string) => void;
  setTool: (t: Tool) => void;
  setBrush: (p: Partial<Brush>) => void;
  /** 고른 레이어의 보정 — 불투명도와 같은 규칙이다 (`live` 면 이력을 안 적는다, 끌기 전에 `markBefore`) */
  setAdjust: (p: Partial<Adjust>, live?: boolean) => void;
  /** 고른 레이어의 보정을 전부 0 으로 (한 걸음) */
  resetAdjust: () => void;
  setRatioLock: (v: boolean) => void;
  setView: (v: Partial<Doc["view"]>) => void;

  selectLayer: (id: string) => void;
  /** 변형·불투명도를 고친다. `live` 면 이력을 안 적는다 (끄는 중) — 놓을 때 `commit: true` 로 한 번 적는다 */
  patchLayer: (id: string, p: Partial<Layer>, live?: boolean) => void;
  /** 끌기 시작 전의 상태를 이력에 적어 둔다 (live 패치가 그 위에 쌓인다) */
  markBefore: () => void;
  addLayer: () => void;
  dupLayer: () => void;
  mergeDown: () => void;
  removeLayer: () => void;
  /** 레이어 차례를 통째로 (아래가 먼저인 id 목록). 화면 목록의 끌기(`useReorder`)가 새 차례를 셈해 넘긴다 */
  orderLayers: (ids: string[]) => void;
  toggleLayer: (id: string) => void;
  renameLayer: (id: string, name: string) => void;
  /** 획이 끝났다 — 굽고 한 걸음 적는다 */
  endStroke: (st: Stroke) => void;

  undo: () => void;
  redo: () => void;
  /** 캔버스 크기 — 기준점 쪽은 붙어 있고 반대쪽이 늘거나 준다. `fill` 이 색이면 **넓어진 자리만** 칠한 레이어를 맨 아래에 깐다 */
  setCanvasSize: (w: number, h: number, a: Anchor, fill?: Fill) => void;
  setImageSize: (w: number, h: number) => void;
  setCrop: (r: Rect | null) => void;
  applyCrop: () => void;
  rotate90: () => void;
  flip: (axis: "h" | "v") => void;

  /** 합성해 저장한다. 성공하면 저장된 자리 */
  save: () => Promise<{ file: string; name: string } | null>;
  /** 문서 크기 그대로의 PNG data URL (i2i·인페인트·보내기가 받는다) */
  dataUrl: () => string;
};

let seq = 1;
const newId = (p: string) => `${p}${Date.now().toString(36)}${(seq++).toString(36)}`;

const DEFAULT_W = 1216;
const DEFAULT_H = 832;

const docOf = (s: S) => s.docs.find((d) => d.id === s.cur) ?? null;

export const useEditor = create<S>((set, get) => {
  /** 한 걸음 — 직전 상태를 적고 바꾼다 */
  const commit = (fn: (d: Doc) => Partial<Doc> | null) => {
    const d = docOf(get());
    if (!d) return;
    const next = fn(d);
    if (!next) return;
    const snap: Snap = { w: d.w, h: d.h, layers: d.layers, sel: d.sel };
    set((s) => ({
      docs: s.docs.map((x) => (x.id === d.id ? { ...x, ...next, hist: pushHist(x.hist, snap), dirty: true } : x)),
      rev: s.rev + 1,
    }));
  };
  const patchDoc = (id: string, p: Partial<Doc>) =>
    set((s) => ({ docs: s.docs.map((x) => (x.id === id ? { ...x, ...p } : x)), rev: s.rev + 1 }));

  const mkLayer = (cv: HTMLCanvasElement, name: string, at: Rect): Layer => ({
    id: newId("l"), name, on: true, opacity: 100, adj: NO_ADJUST, sw: cv.width, sh: cv.height, cv,
    x: at.x, y: at.y, w: at.w, h: at.h, rot: 0, flipH: false, flipV: false,
  });
  const layerName = (d: Doc | { layers: Layer[] }) => nextName(d.layers.map((l) => l.name), (n) => t("editor.layerN", { n }));

  return {
    docs: [],
    cur: null,
    tool: "brush",
    brush: { size: 24, hard: 0.8, opacity: 100, color: "#ff5a6e" },
    ratioLock: true,
    crop: null,
    rev: 0,
    busy: false,

    doc: () => docOf(get()),
    layer: () => {
      const d = docOf(get());
      return d?.layers.find((l) => l.id === d.sel) ?? null;
    },
    canUndo: () => (docOf(get())?.hist.past.length ?? 0) > 0,
    canRedo: () => (docOf(get())?.hist.future.length ?? 0) > 0,

    async openItems(items, how) {
      if (!items.length) return;
      set({ busy: true });
      try {
        const loaded: { cv: HTMLCanvasElement; name: string; item: Dropped }[] = [];
        for (const item of items) {
          try {
            const r = await loadItem(item);
            loaded.push({ ...r, item });
          } catch (e) {
            toast(t("editor.openFail", { name: item.name, e: String(e) }), "warn");
          }
        }
        if (!loaded.length) return;
        const cur = docOf(get());
        if (how === "layer" && cur) {
          // ★고른 문서 위에 **레이어로** — 큰 그림은 문서에 맞춰 줄여 가운데에 놓는다
          commit((d) => {
            const layers = [...d.layers];
            let sel = d.sel;
            for (const x of loaded) {
              const l = mkLayer(x.cv, x.name.replace(/\.[^.]+$/, ""), placeNew(d, { w: x.cv.width, h: x.cv.height }));
              layers.push(l);
              sel = l.id;
            }
            return { layers, sel };
          });
          return;
        }
        // ★새 문서 하나에 **전부** 넣는다 (사용자 결정 2026-09-22: 여러 장을 보내도 물음은 한 번, 넣는 곳도 한 곳).
        //   크기는 첫 그림이고 나머지는 그 안에 맞춰 놓는다.
        const first = loaded[0];
        const w = first.cv.width;
        const h = first.cv.height;
        const layers: Layer[] = loaded.map((x, i) =>
          mkLayer(x.cv, x.name.replace(/\.[^.]+$/, ""), i === 0 ? { x: 0, y: 0, w, h } : placeNew({ w, h }, { w: x.cv.width, h: x.cv.height })),
        );
        const src = first.item.rel || first.item.path ? { rel: first.item.rel, path: first.item.path, name: first.name } : null;
        const doc: Doc = {
          id: newId("d"), name: first.name.replace(/\.[^.]+$/, ""), w, h, layers,
          sel: layers[layers.length - 1].id, src, hist: emptyHist(), dirty: false, view: { fit: true, zoom: 1 },
        };
        set((s) => ({ docs: [...s.docs, doc], cur: doc.id, crop: null }));
      } finally {
        set({ busy: false });
      }
    },

    newDoc(w = DEFAULT_W, h = DEFAULT_H) {
      const names = get().docs.map((d) => d.name);
      const name = nextName(names, (n) => t("editor.untitledN", { n }));
      const cv = makeCanvas(w, h);
      const l = mkLayer(cv, t("editor.layerN", { n: 1 }), { x: 0, y: 0, w, h });
      const doc: Doc = { id: newId("d"), name, w, h, layers: [l], sel: l.id, src: null, hist: emptyHist(), dirty: false, view: { fit: true, zoom: 1 } };
      set((s) => ({ docs: [...s.docs, doc], cur: doc.id, crop: null }));
    },

    async closeDoc(id) {
      const d = get().docs.find((x) => x.id === id);
      if (!d) return;
      if (d.dirty && !(await ask({ title: t("editor.unsavedClose", { name: d.name }), body: t("editor.unsavedBody"), ok: t("editor.closeAnyway"), cancel: t("common.cancel"), danger: true })))
        return;
      set((s) => {
        const docs = s.docs.filter((x) => x.id !== id);
        const i = s.docs.findIndex((x) => x.id === id);
        const cur = s.cur === id ? (docs[Math.min(i, docs.length - 1)]?.id ?? null) : s.cur;
        return { docs, cur, crop: null };
      });
    },

    setCur: (id) => set({ cur: id, crop: null }),
    setTool: (tool) => set({ tool, crop: tool === "crop" ? get().crop : null }),
    setBrush: (p) => set((s) => ({ brush: { ...s.brush, ...p } })),
    setAdjust(p, live = false) {
      const l = get().layer();
      if (!l) return;
      get().patchLayer(l.id, { adj: { ...l.adj, ...p } }, live);
    },
    resetAdjust() {
      const l = get().layer();
      if (!l || !hasAdjust(l.adj)) return;
      get().patchLayer(l.id, { adj: NO_ADJUST });
    },
    setRatioLock: (v) => set({ ratioLock: v }),
    setView(v) {
      const d = docOf(get());
      if (d) patchDoc(d.id, { view: { ...d.view, ...v } });
    },

    selectLayer(id) {
      const d = docOf(get());
      if (d && d.sel !== id) patchDoc(d.id, { sel: id });
    },
    patchLayer(id, p, live = false) {
      const d = docOf(get());
      if (!d) return;
      const layers = d.layers.map((x) => (x.id === id ? { ...x, ...p } : x));
      if (live) patchDoc(d.id, { layers, dirty: true });
      else commit(() => ({ layers }));
    },
    markBefore() {
      // ★끌기 전에 한 걸음 적어 두고, 끄는 동안은 live 패치 — 놓을 때 또 적지 않는다
      commit((d) => ({ layers: d.layers }));
    },
    addLayer() {
      commit((d) => {
        const l = mkLayer(makeCanvas(d.w, d.h), layerName(d), { x: 0, y: 0, w: d.w, h: d.h });
        const i = d.layers.findIndex((x) => x.id === d.sel);
        const layers = [...d.layers];
        layers.splice(i < 0 ? layers.length : i + 1, 0, l);
        return { layers, sel: l.id };
      });
    },
    dupLayer() {
      commit((d) => {
        const i = d.layers.findIndex((x) => x.id === d.sel);
        if (i < 0) return null;
        const src = d.layers[i];
        const l: Layer = { ...src, id: newId("l"), name: t("editor.copyOf", { name: src.name }), cv: cloneCanvas(src.cv) };
        const layers = [...d.layers];
        layers.splice(i + 1, 0, l);
        return { layers, sel: l.id };
      });
    },
    mergeDown() {
      commit((d) => {
        const i = d.layers.findIndex((x) => x.id === d.sel);
        if (i <= 0) return null;
        const top = d.layers[i];
        const below = d.layers[i - 1];
        const merged: Layer = { ...below, cv: mergeInto(below, top) };
        const layers = d.layers.filter((_, k) => k !== i).map((x) => (x.id === below.id ? merged : x));
        return { layers, sel: below.id };
      });
    },
    removeLayer() {
      commit((d) => {
        const i = d.layers.findIndex((x) => x.id === d.sel);
        if (i < 0) return null;
        const layers = d.layers.filter((_, k) => k !== i);
        const sel = layers[Math.min(i, layers.length - 1)]?.id ?? null;
        return { layers, sel };
      });
    },
    orderLayers(ids) {
      commit((d) => {
        if (ids.length !== d.layers.length) return null;
        const by = new Map(d.layers.map((l) => [l.id, l]));
        const layers = ids.map((id) => by.get(id)).filter((l): l is Layer => !!l);
        if (layers.length !== d.layers.length || layers.every((l, i) => l === d.layers[i])) return null;
        return { layers };
      });
    },
    toggleLayer(id) {
      commit((d) => ({ layers: d.layers.map((x) => (x.id === id ? { ...x, on: !x.on } : x)) }));
    },
    renameLayer(id, name) {
      const d = docOf(get());
      if (!d || !name.trim()) return;
      patchDoc(d.id, { layers: d.layers.map((x) => (x.id === id ? { ...x, name: name.trim() } : x)), dirty: true });
    },
    endStroke(st) {
      commit((d) => {
        const l = d.layers.find((x) => x.id === d.sel);
        if (!l) return null;
        return { layers: d.layers.map((x) => (x.id === l.id ? { ...x, cv: bakeStroke(x, st) } : x)) };
      });
    },

    undo() {
      const d = docOf(get());
      if (!d) return;
      const r = undoHist(d.hist, { w: d.w, h: d.h, layers: d.layers, sel: d.sel });
      if (!r) return;
      patchDoc(d.id, { ...r.snap, hist: r.h, dirty: true });
      set({ crop: null });
    },
    redo() {
      const d = docOf(get());
      if (!d) return;
      const r = redoHist(d.hist, { w: d.w, h: d.h, layers: d.layers, sel: d.sel });
      if (!r) return;
      patchDoc(d.id, { ...r.snap, hist: r.h, dirty: true });
      set({ crop: null });
    },
    setCanvasSize(w, h, a, fill = "transparent") {
      commit((d) => {
        const { dx, dy } = canvasShift(d, { w, h }, a);
        const layers = d.layers.map((l) => ({ ...l, x: l.x + dx, y: l.y + dy }));
        // ★「빈 자리」— 넓어진 자리**만** 색으로 채운 레이어를 맨 아래에 깐다 (지금 캔버스 자리는 비워 두므로 투명 그림의 안쪽은 안 덮는다)
        if (fill !== "transparent" && growsBeyond(d, { w, h }, a)) {
          const cv = fillAround(w, h, FILL_COLOR[fill], { x: dx, y: dy, w: d.w, h: d.h });
          layers.unshift(mkLayer(cv, t("editor.fillLayer"), { x: 0, y: 0, w, h }));
        }
        return { w, h, layers };
      });
    },
    setImageSize(w, h) {
      commit((d) => {
        const sx = w / d.w;
        const sy = h / d.h;
        return { w, h, layers: d.layers.map((l) => ({ ...l, ...scaleXform(l, sx, sy) })) };
      });
    },
    setCrop: (r) => set({ crop: r }),
    applyCrop() {
      const r = get().crop;
      if (!r || r.w < 1 || r.h < 1) return;
      commit((d) => ({ w: r.w, h: r.h, layers: d.layers.map((l) => ({ ...l, ...cropShift(l, r) })) }));
      set({ crop: null });
    },
    rotate90() {
      commit((d) => ({ layers: d.layers.map((l) => (l.id === d.sel ? { ...l, ...rot90(l) } : l)) }));
    },
    flip(axis) {
      commit((d) => ({ layers: d.layers.map((l) => (l.id === d.sel ? { ...l, ...(axis === "h" ? { flipH: !l.flipH } : { flipV: !l.flipV }) } : l)) }));
    },

    async save() {
      const d = docOf(get());
      if (!d || get().busy) return null;
      const editLast = useUi.getState().editLast;
      const where = whereOf(d, editLast);
      if (where.mode !== "overwrite" && !where.dest) {
        toast(t("editor.needDest"), "warn");
        return null;
      }
      set({ busy: true });
      try {
        const r = await saveImage({
          image: get().dataUrl(),
          name: d.src?.name ?? `${d.name}.png`,
          fmt: editLast.fmt,
          mode: where.mode,
          dest: "dest" in where ? where.dest : undefined,
          rel: d.src?.rel,
          path: d.src?.path,
        });
        patchDoc(d.id, { dirty: false });
        toast(t("editor.saved", { name: r.name }));
        return r;
      } catch (e) {
        toast(t("editor.saveFail", { e: String(e) }), "warn");
        return null;
      } finally {
        set({ busy: false });
      }
    },
    dataUrl() {
      const d = docOf(get());
      return d ? exportDataUrl(d) : "";
    },
  };
});

/** 저장 파일 이름 미리보기 (오른쪽 기둥) */
export const saveName = (d: Doc | null, fmt: "png" | "webp") => saveNameOf(d?.src?.name ?? (d ? `${d.name}.png` : null), fmt);

/** 저장 자리 — **화면(오른쪽 기둥·머리 줄)과 저장이 같은 셈**을 쓴다. 원본 자리가 없는 문서(새 문서·떨군 바이트)는
 *  덮어쓰기·하위 output 이 성립하지 않아 설정이 무엇이든 「저장 폴더 지정」이다 */
export const whereOf = (d: Doc, e: { mode: "overwrite" | "sub" | "folder"; dest: string }) =>
  destOf(d.src ? e.mode : "folder", e.dest, dirOf(d.src?.rel ?? d.src?.path));
