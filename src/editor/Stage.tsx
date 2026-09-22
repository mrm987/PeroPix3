import { useCallback, useEffect, useRef, useState } from "react";
import { useI18n } from "../i18n";
import { toast } from "../store/toast";
import { useUi } from "../store/ui";
import { canPan, centerPan, clampPan, drawSize, keepCenter, stepZoom, zoomFrom, ZOOM_MAX, ZOOM_MIN, type Pan, type Size } from "../lib/zoomView";
import { brushScale, centerOf, cornersOf, docToLayer, hitLayer, normRect, rad, resizeCursor } from "./model";
import { composite, fontOf, makeCanvas, strokeTo, textLayout, type Layer, type Stroke } from "./pixels";
import { useEditor, type Doc } from "./store";

/** 무대 — 캔버스 한 장을 합성해 보여 주고, 도구에 따라 **누르고 끄는 것**을 받는다.
 *
 *  세 겹이다: 합성 캔버스 · 조작 SVG(손잡이·자르기 상자·붓 커서) · 글 상자(글자를 고치는 동안). 검열 무대(`CensorStage`)와 같은 뼈대다.
 *  ★★획을 긋는 동안은 리액트를 안 거친다 — `strokeRef` 에 모아 두고 프레임마다 `paint()` 가 스토어를 `getState()` 로
 *    읽어 그린다. 손을 떼면 `endStroke` 가 한 걸음 적는다.
 *  ★배율·자리 계산은 전부 `lib/zoomView` (검열·생성 쪽과 같은 함수). `fit` 이면 판 안에 맞추고(작은 그림은
 *    안 키운다), 배율을 정하면 넘치는 만큼 끌어 본다.
 *  ★붓 값은 `useUi.editorBrush` — 브러시와 지우개가 **따로** 기억된다 (사용자 지시 2026-09-22). */
/** 회전 손잡이 위의 커서 — CSS 에 회전 커서가 없어 SVG(굽은 화살표, 검은 테두리에 흰 선)를 그려 넣는다. 가운데가 핫스팟 */
const ROTATE_CURSOR = `url("data:image/svg+xml,${encodeURIComponent(
  "<svg xmlns='http://www.w3.org/2000/svg' width='22' height='22' viewBox='0 0 24 24' fill='none' stroke-linecap='round' stroke-linejoin='round'>"
  + "<path d='M19 12a7 7 0 1 1-2.05-4.95M17 3v4.2h-4.2' stroke='#000' stroke-width='3.6'/>"
  + "<path d='M19 12a7 7 0 1 1-2.05-4.95M17 3v4.2h-4.2' stroke='#fff' stroke-width='1.6'/></svg>",
)}") 11 11, auto`;

export function Stage({ doc }: { doc: Doc }) {
  const t = useI18n((s) => s.t);
  const tool = useEditor((s) => s.tool);
  const ratioLock = useEditor((s) => s.ratioLock);
  const crop = useEditor((s) => s.crop);
  const rev = useEditor((s) => s.rev);
  const textEdit = useEditor((s) => s.textEdit);
  const brushes = useUi((s) => s.editorBrush);
  const brush = tool === "eraser" ? brushes.eraser : brushes.brush;
  const bg = useUi((s) => s.editorBg);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [box, setBox] = useState<Size>({ w: 0, h: 0 });
  const [pan, setPan] = useState<Pan>({ x: 0, y: 0 });
  const [cursor, setCursor] = useState<{ x: number; y: number } | null>(null);
  /** 선택 도구에서 커서 아래에 있는 것의 커서 모양 — 손잡이면 크기·회전 커서, 레이어면 move, 없으면 null (사용자 지시 2026-09-22) */
  const [hoverCur, setHoverCur] = useState<string | null>(null);
  /** 긋는 중 */
  const strokeRef = useRef<{ st: Stroke; last: { x: number; y: number } | null; layer: Layer } | null>(null);
  /** 손잡이를 끄는 중 */
  const dragRef = useRef<{
    kind: "move" | "scale" | "rotate" | "crop" | "pan";
    start: { x: number; y: number };
    layer?: Layer;
    handle?: { sx: -1 | 0 | 1; sy: -1 | 0 | 1 };
    pan0?: Pan;
    rot0?: number;
    ang0?: number;
    /** 이력에 「끌기 전」을 적었나 — 처음 움직일 때 한 번 (클릭만 하고 놓으면 걸음이 안 생긴다) */
    marked?: boolean;
  } | null>(null);
  const rafRef = useRef(0);

  const k = zoomFrom(box, doc, doc.view.fit, doc.view.zoom);
  const fitK = doc.view.fit ? Math.min(k, 1) : k;
  const fitted = { w: Math.max(1, Math.floor(doc.w * fitK)), h: Math.max(1, Math.floor(doc.h * fitK)) };
  const movable = !doc.view.fit && canPan(box, fitted);

  /* ── 판 재기 ── */
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const fit = () => setBox((b) => (b.w === host.clientWidth && b.h === host.clientHeight ? b : { w: host.clientWidth, h: host.clientHeight }));
    const ro = new ResizeObserver(fit);
    ro.observe(host);
    fit();
    return () => ro.disconnect();
  }, []);
  // 캔버스가 바뀌면 가운데에서 시작한다
  useEffect(() => {
    if (box.w && box.h) setPan(centerPan(box, fitted));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc.id, box.w, box.h]);
  useEffect(() => {
    setPan((p) => clampPan(p, box, fitted));
  }, [box.w, box.h, fitted.w, fitted.h]);

  /* ── 그리기 ── */
  const paint = useCallback(() => {
    const cv = canvasRef.current;
    if (!cv) return;
    const s = useEditor.getState();
    const d = s.doc();
    if (!d) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const kk = (cv.clientWidth / d.w) * dpr || 1;
    const st = strokeRef.current?.st ?? null;
    composite(d, cv, kk, { sel: d.sel, stroke: st, skip: s.textEdit?.id ?? null });
  }, []);
  useEffect(() => {
    paint();
  }, [doc, rev, fitted.w, fitted.h, textEdit, paint]);

  /* ── 좌표 ── */
  const toDoc = (e: { clientX: number; clientY: number }) => {
    const el = canvasRef.current;
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * doc.w, y: ((e.clientY - r.top) / r.height) * doc.h };
  };
  const scale = fitted.w / doc.w || 1;
  const sel = doc.layers.find((l) => l.id === doc.sel) ?? null;
  const editing = textEdit ? doc.layers.find((l) => l.id === textEdit.id && l.text) ?? null : null;

  /** 손잡이 자리 (문서 좌표) — 네 모서리·네 변 가운데·회전 손잡이 */
  const handlesOf = (l: Layer) => {
    const c = centerOf(l);
    const r = rad(l.rot);
    const at = (lx: number, ly: number) => ({ x: c.x + lx * Math.cos(r) - ly * Math.sin(r), y: c.y + lx * Math.sin(r) + ly * Math.cos(r) });
    const hw = l.w / 2;
    const hh = l.h / 2;
    const list: { sx: -1 | 0 | 1; sy: -1 | 0 | 1; p: { x: number; y: number } }[] = [];
    for (const sy of [-1, 0, 1] as const) for (const sx of [-1, 0, 1] as const) {
      if (!sx && !sy) continue;
      list.push({ sx, sy, p: at(sx * hw, sy * hh) });
    }
    return { list, rot: at(0, -hh - 26 / scale), top: at(0, -hh) };
  };
  const hitHandle = (l: Layer, p: { x: number; y: number }) => {
    const h = handlesOf(l);
    const tol = 8 / scale;
    if (Math.hypot(h.rot.x - p.x, h.rot.y - p.y) <= tol) return { rotate: true as const };
    for (const x of h.list) if (Math.hypot(x.p.x - p.x, x.p.y - p.y) <= tol) return { handle: x };
    return null;
  };
  /** 그 자리의 맨 앞 레이어 (켜진 것만). ★판정은 화면에 보이는 **상자**다 — 픽셀로 보면 투명한 배경을 누를 때 선택이 풀려
   *  버린다 (사용자 지적 2026-09-22). `only` 로 종류를 거른다 */
  const topLayerAt = (p: { x: number; y: number }, only?: (l: Layer) => boolean) => {
    for (let i = doc.layers.length - 1; i >= 0; i--) {
      const l = doc.layers[i];
      if (l.on && (!only || only(l)) && hitLayer(l, p.x, p.y)) return l;
    }
    return null;
  };

  /* ── 누르기 ── */
  const down = (e: React.PointerEvent) => {
    const s = useEditor.getState();
    const p = toDoc(e);
    if (!p) return;
    // ★가운데 단추·이동 도구는 끌기 — 넘칠 때만 끌 것이 있다
    if ((e.button === 1 || (tool === "pan" && e.button === 0)) && movable) {
      e.preventDefault();
      dragRef.current = { kind: "pan", start: { x: e.clientX, y: e.clientY }, pan0: pan };
      (e.currentTarget as Element).setPointerCapture(e.pointerId);
      return;
    }
    if (e.button !== 0) return;
    e.preventDefault();
    (document.activeElement as HTMLElement | null)?.blur?.();
    if (tool === "pan") return;

    if (tool === "crop") {
      dragRef.current = { kind: "crop", start: p };
      s.setCrop({ x: p.x, y: p.y, w: 0, h: 0 });
      (e.currentTarget as Element).setPointerCapture(e.pointerId);
      return;
    }

    if (tool === "text") {
      // 글자 레이어 위면 그것을 고친다 (고른 것 우선), 아니면 그 자리에 새 글자 레이어
      const hit = sel?.text && sel.on && hitLayer(sel, p.x, p.y) ? sel : topLayerAt(p, (l) => !!l.text);
      if (hit) {
        s.selectLayer(hit.id);
        s.beginTextEdit(hit.id);
      } else s.addText(p);
      return;
    }

    if (tool === "brush" || tool === "eraser" || tool === "bucket") {
      const l = s.layer();
      if (!l) return toast(t("editor.noLayer"), "warn");
      if (!l.on) return toast(t("editor.layerOff"), "warn");
      // ★글자 레이어에는 안 그린다 — 그리면 원문과 어긋난다. 아래와 합치면 보통 레이어가 된다
      if (l.text) return toast(t("editor.textNoPaint"), "warn");
      // 페인트통 — 누른 자리와 이어진 같은 색을 채운다 (한 걸음)
      if (tool === "bucket") { s.fillAt(p); return; }
      const b = tool === "eraser" ? useUi.getState().editorBrush.eraser : useUi.getState().editorBrush.brush;
      const cv = makeCanvas(l.sw, l.sh);
      const st: Stroke = { cv, alpha: b.opacity / 100, erase: tool === "eraser" };
      strokeRef.current = { st, last: null, layer: l };
      (e.currentTarget as Element).setPointerCapture(e.pointerId);
      strokeAt(p);
      return;
    }

    // 선택 도구 — 고른 레이어의 손잡이 → **누른 자리의 맨 앞 레이어**(상자 기준) → 아무 상자도 없으면 선택을 푼다
    // ★사용자 결정 2026-09-22: 앞의 레이어를 누르면 곧바로 그것이 골라진다 (한때 「고른 레이어 안이면 고른 것을 끈다」로
    //   두었다가 되돌렸다). 판정은 화면에 보이는 상자다 — 픽셀로 봤더니 투명한 배경을 누를 때 선택이 풀렸다.
    if (sel) {
      const h = hitHandle(sel, p);
      if (h && "rotate" in h) {
        const c = centerOf(sel);
        dragRef.current = { kind: "rotate", start: p, layer: sel, rot0: sel.rot, ang0: Math.atan2(p.y - c.y, p.x - c.x) };
        (e.currentTarget as Element).setPointerCapture(e.pointerId);
        return;
      }
      if (h && "handle" in h) {
        dragRef.current = { kind: "scale", start: p, layer: sel, handle: h.handle };
        (e.currentTarget as Element).setPointerCapture(e.pointerId);
        return;
      }
    }
    const hit = topLayerAt(p);
    if (hit) {
      if (hit.id !== doc.sel) s.selectLayer(hit.id);
      dragRef.current = { kind: "move", start: p, layer: hit };
      (e.currentTarget as Element).setPointerCapture(e.pointerId);
    } else if (doc.sel) s.selectLayer(null);
  };
  /** 캔버스 **밖**(무대의 빈 바탕)을 눌러도 선택을 푼다 — 안의 빈 자리를 눌렀을 때와 같다 (사용자 지시 2026-09-22).
   *  ★캔버스 위의 누르기도 여기까지 올라오므로 **바탕 자체**를 누른 것만 받는다 */
  const downOutside = (e: React.PointerEvent) => {
    if (e.target !== e.currentTarget || e.button !== 0 || tool !== "select") return;
    if (doc.sel) useEditor.getState().selectLayer(null);
  };

  const strokeAt = (p: { x: number; y: number }) => {
    const sr = strokeRef.current;
    if (!sr) return;
    const ui = useUi.getState().editorBrush;
    const b = sr.st.erase ? ui.eraser : ui.brush;
    const l = sr.layer;
    const lp = docToLayer(l, p.x, p.y);
    const d = b.size * brushScale(l);
    const g = sr.st.cv.getContext("2d")!;
    strokeTo(g, sr.last, lp, d, b.hard, sr.st.erase ? "#ffffff" : ui.brush.color);
    sr.last = lp;
    if (!rafRef.current) rafRef.current = requestAnimationFrame(() => { rafRef.current = 0; paint(); });
  };

  const move = (e: React.PointerEvent) => {
    const p = toDoc(e);
    if (p) setCursor(p);
    const d = dragRef.current;
    const s = useEditor.getState();
    if (d) {
      if (d.kind === "pan" && d.pan0) {
        setPan(clampPan({ x: d.pan0.x + (e.clientX - d.start.x), y: d.pan0.y + (e.clientY - d.start.y) }, box, fitted));
        return;
      }
      if (!p) return;
      if (d.kind === "crop") {
        s.setCrop(normRect({ x: d.start.x, y: d.start.y, w: p.x - d.start.x, h: p.y - d.start.y }, doc));
        return;
      }
      const l = d.layer!;
      // ★처음 움직이는 순간에 「끌기 전」을 적는다 — 그 뒤는 live 패치라 걸음이 하나다
      if (!d.marked) {
        if (Math.hypot(p.x - d.start.x, p.y - d.start.y) * scale < 2) return;
        s.markBefore();
        d.marked = true;
      }
      if (d.kind === "move") {
        s.patchLayer(l.id, { x: l.x + (p.x - d.start.x), y: l.y + (p.y - d.start.y) }, true);
        return;
      }
      if (d.kind === "rotate") {
        const c = centerOf(l);
        let deg = (d.rot0 ?? 0) + ((Math.atan2(p.y - c.y, p.x - c.x) - (d.ang0 ?? 0)) * 180) / Math.PI;
        if (e.shiftKey) deg = Math.round(deg / 15) * 15;
        s.patchLayer(l.id, { rot: ((deg % 360) + 360) % 360 }, true);
        return;
      }
      if (d.kind === "scale" && d.handle) {
        // 회전을 푼 자리에서 반대편 모서리를 붙들고 크기를 잰다
        const c = centerOf(l);
        const r = -rad(l.rot);
        const ux = (p.x - c.x) * Math.cos(r) - (p.y - c.y) * Math.sin(r);
        const uy = (p.x - c.x) * Math.sin(r) + (p.y - c.y) * Math.cos(r);
        const { sx, sy } = d.handle;
        const ox = -sx * (l.w / 2);
        const oy = -sy * (l.h / 2);
        let w = sx ? Math.max(1, Math.abs(ux - ox)) : l.w;
        let h = sy ? Math.max(1, Math.abs(uy - oy)) : l.h;
        // ★글자 레이어는 언제나 비율대로 — 상자를 늘리는 것이 곧 글꼴 크기라(놓을 때 `settleText` 가 다시 굽는다) 한쪽만 늘릴 수 없다
        if (l.text || (ratioLock && sx && sy)) {
          const kk = !sx ? h / l.h : !sy ? w / l.w : Math.max(w / l.w, h / l.h);
          w = l.w * kk;
          h = l.h * kk;
        }
        const ncx = sx ? ox + sx * (w / 2) : 0;
        const ncy = sy ? oy + sy * (h / 2) : 0;
        const rr = rad(l.rot);
        const cx = c.x + ncx * Math.cos(rr) - ncy * Math.sin(rr);
        const cy = c.y + ncx * Math.sin(rr) + ncy * Math.cos(rr);
        s.patchLayer(l.id, { x: cx - w / 2, y: cy - h / 2, w, h }, true);
      }
      return;
    }
    if (strokeRef.current && p) return strokeAt(p);
    if (tool === "select" && p) {
      const h = sel ? hitHandle(sel, p) : null;
      setHoverCur(h ? ("rotate" in h ? ROTATE_CURSOR : resizeCursor(sel!.rot, h.handle)) : topLayerAt(p) ? "move" : null);
    }
  };

  const up = () => {
    const d = dragRef.current;
    if (d) {
      dragRef.current = null;
      if (d.kind === "crop") {
        const c = useEditor.getState().crop;
        if (c && (c.w < 2 || c.h < 2)) useEditor.getState().setCrop(null);
      }
      // 글자 레이어를 늘렸으면 — 늘린 만큼 글꼴 크기를 바꿔 다시 굽는다 (픽셀 확대를 남기지 않는다)
      if (d.kind === "scale" && d.marked && d.layer?.text) useEditor.getState().settleText(d.layer.id);
      return;
    }
    const sr = strokeRef.current;
    if (!sr) return;
    strokeRef.current = null;
    if (rafRef.current) { cancelAnimationFrame(rafRef.current); rafRef.current = 0; }
    useEditor.getState().endStroke(sr.st);
  };

  /* ── 휠: Ctrl 확대·축소 · Alt 붓 크기 (지금 도구의 것) ── */
  useEffect(() => {
    const el = hostRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        const s = useEditor.getState();
        const d = s.doc();
        if (!d) return;
        const from = zoomFrom(box, d, d.view.fit, d.view.zoom);
        const fromK = d.view.fit ? Math.min(from, 1) : from;
        const next = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, stepZoom(fromK, e.deltaY > 0 ? -1 : 1)));
        setPan((p) => keepCenter(p, box, drawSize(d, fromK), drawSize(d, next)));
        s.setView({ fit: false, zoom: next });
        return;
      }
      if (e.altKey) {
        e.preventDefault();
        const which = useEditor.getState().tool === "eraser" ? "eraser" : "brush";
        const ui = useUi.getState();
        const step = (e.shiftKey ? 10 : 1) * (e.deltaY < 0 ? 1 : -1);
        ui.setEditorBrush(which, { size: Math.max(1, Math.min(400, ui.editorBrush[which].size + step)) });
      }
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [box]);

  const bgStyle: React.CSSProperties =
    bg === "light" ? { background: "#4a4a55" }
      : bg === "checker" ? { background: "conic-gradient(#8a8a94 25%, #5c5c66 0 50%, #8a8a94 0 75%, #5c5c66 0) 0 0/16px 16px" }
        : bg.startsWith("#") ? { background: bg }
          : { background: "var(--bg)" };

  const cursorStyle =
    tool === "pan" ? (movable ? "move" : "default")
      : tool === "crop" || tool === "bucket" ? "crosshair"
        : tool === "text" ? "text"
          : tool === "brush" || tool === "eraser" ? "none"
            : hoverCur ?? "default";

  const line = 1.5 / scale;
  const hs = 7 / scale;

  return (
    <div
      ref={hostRef}
      data-editor-stage
      onPointerDown={downOutside}
      style={{ flex: 1, minHeight: 0, position: "relative", overflow: "hidden", border: "1px solid var(--line)", borderRadius: "var(--r-3)", ...bgStyle }}
    >
      <div
        ref={wrapRef}
        style={{
          position: "absolute",
          left: 0,
          top: 0,
          width: fitted.w,
          height: fitted.h,
          transform: `translate(${pan.x}px, ${pan.y}px)`,
          lineHeight: 0,
          userSelect: "none",
          boxShadow: "0 0 0 1px rgba(255,255,255,.06), 0 10px 40px rgba(0,0,0,.55)",
          // 캔버스의 투명한 자리 — 체커. 바깥 배경과 갈라 보이게 (사용자 지시 2026-09-22)
          background: "conic-gradient(#2a2a32 25%, #222229 0 50%, #2a2a32 0 75%, #222229 0) 0 0/16px 16px",
        }}
      >
        <canvas ref={canvasRef} data-editor-canvas style={{ width: "100%", height: "100%", display: "block" }} />
        <svg
          data-editor-overlay
          viewBox={`0 0 ${doc.w} ${doc.h}`}
          style={{ position: "absolute", inset: 0, width: "100%", height: "100%", cursor: cursorStyle, touchAction: "none", overflow: "visible" }}
          onPointerDown={down}
          onPointerMove={move}
          onPointerUp={up}
          onPointerCancel={up}
          onPointerLeave={() => setCursor(null)}
          onContextMenu={(e) => e.preventDefault()}
        >
          {/* 고른 레이어의 상자와 손잡이 — 선택 도구에서만 */}
          {tool === "select" && sel && !crop && (() => {
            const cs = cornersOf(sel);
            const h = handlesOf(sel);
            return (
              <g data-editor-handles>
                <polygon points={cs.map((c) => `${c.x},${c.y}`).join(" ")} fill="none" stroke="var(--accent-ink)" strokeWidth={line} />
                <line x1={h.top.x} y1={h.top.y} x2={h.rot.x} y2={h.rot.y} stroke="var(--accent-ink)" strokeWidth={line} />
                <circle cx={h.rot.x} cy={h.rot.y} r={hs * 0.7} fill="var(--bg)" stroke="var(--accent-ink)" strokeWidth={line} />
                {h.list.map((x) => (
                  <rect key={`${x.sx},${x.sy}`} x={x.p.x - hs / 2} y={x.p.y - hs / 2} width={hs} height={hs} rx={1.5 / scale} fill="var(--bg)" stroke="var(--accent-ink)" strokeWidth={line} />
                ))}
              </g>
            );
          })()}
          {/* 자르기 상자 — 바깥은 어둡게 */}
          {crop && crop.w > 0 && crop.h > 0 && (
            <g data-editor-crop>
              <path
                d={`M0 0H${doc.w}V${doc.h}H0Z M${crop.x} ${crop.y}H${crop.x + crop.w}V${crop.y + crop.h}H${crop.x}Z`}
                fill="rgba(0,0,0,.55)"
                fillRule="evenodd"
              />
              <rect x={crop.x} y={crop.y} width={crop.w} height={crop.h} fill="none" stroke="#fff" strokeWidth={line} strokeDasharray={`${6 / scale} ${4 / scale}`} />
            </g>
          )}
          {/* 붓 커서 */}
          {(tool === "brush" || tool === "eraser") && cursor && (
            <circle
              data-editor-brush
              cx={cursor.x}
              cy={cursor.y}
              r={brush.size / 2}
              fill={tool === "eraser" ? "rgba(255,255,255,.12)" : "rgba(255,255,255,.08)"}
              stroke={tool === "eraser" ? "rgba(255,255,255,.85)" : brushes.brush.color}
              strokeWidth={line}
              style={{ pointerEvents: "none" }}
            />
          )}
        </svg>
        {/* 글 상자 — 글자 레이어를 고치는 동안 그 자리에 뜬다 (그 레이어는 합성에서 뺀다) */}
        {editing && textEdit && <TextEditBox key={editing.id} l={editing} scale={scale} value={textEdit.value} />}
      </div>
    </div>
  );
}

/** 글자 레이어의 글 상자 — 레이어와 **같은 셈**(`textLayout`)으로 크기를 잡아 그 자리에 같은 글꼴로 뜬다.
 *  마무리는 세 갈래다: 밖을 누르거나(`blur`) Ctrl+Enter 면 반영, Esc 면 취소(방금 만든 것이면 레이어를 거둔다).
 *  ★치는 글은 스토어(`textEdit.value`)에 있고 마무리도 스토어(`endTextEdit`)가 한다 — 여기에는 상태도 정리 효과도 없다.
 *    언마운트에는 `onBlur` 이 안 오고(데스크 지침 「잊기 쉬운 것」), 정리 효과에 마무리를 걸면 개발 모드의 이중 마운트가
 *    뜨자마자 「빈 글 반영」을 돌려 방금 만든 레이어를 거둔다 (사용자 지적 2026-09-22: 눌러도 아무것도 안 생겼다). */
function TextEditBox({ l, scale, value }: { l: Layer; scale: number; value: string }) {
  const meta = l.text!;
  const ref = useRef<HTMLTextAreaElement | null>(null);
  useEffect(() => {
    ref.current?.focus({ preventScroll: true });
    ref.current?.select();
  }, []);

  const L = textLayout({ ...meta, value });
  return (
    <textarea
      ref={ref}
      data-editor-text-input
      value={value}
      spellCheck={false}
      onChange={(e) => useEditor.getState().updateTextEdit(e.target.value)}
      onBlur={() => useEditor.getState().endTextEdit(true)}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Escape") { e.preventDefault(); useEditor.getState().endTextEdit(false); }
        if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); useEditor.getState().endTextEdit(true); }
      }}
      onPointerDown={(e) => e.stopPropagation()}
      style={{
        position: "absolute",
        left: l.x * scale,
        top: l.y * scale,
        width: Math.max(L.w, meta.size * 2) * scale,
        height: L.h * scale,
        // ★레이어의 변형(회전·반전)을 글 상자에도 건다 — 안 걸면 돌려 둔 글자가 고치는 동안 0° 로 보인다 (사용자 지적 2026-09-22)
        transform: `rotate(${l.rot}deg) scale(${l.flipH ? -1 : 1}, ${l.flipV ? -1 : 1})`,
        transformOrigin: "center",
        padding: L.pad * scale,
        boxSizing: "border-box",
        margin: 0,
        border: "1px dashed var(--accent-ink)",
        borderRadius: 2,
        background: "transparent",
        color: meta.color,
        font: fontOf({ ...meta, size: meta.size * scale }),
        lineHeight: `${L.lineH * scale}px`,
        textAlign: meta.align,
        whiteSpace: "pre",
        overflow: "hidden",
        resize: "none",
        outline: "none",
        caretColor: "var(--accent-ink)",
        userSelect: "text",
        zIndex: 2,
      }}
    />
  );
}
