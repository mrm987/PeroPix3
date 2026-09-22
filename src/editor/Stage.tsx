import { useCallback, useEffect, useRef, useState } from "react";
import { useI18n } from "../i18n";
import { toast } from "../store/toast";
import { useUi } from "../store/ui";
import { canPan, centerPan, clampPan, drawSize, keepCenter, stepZoom, zoomFrom, ZOOM_MAX, ZOOM_MIN, type Pan, type Size } from "../lib/zoomView";
import { brushScale, centerOf, cornersOf, docToLayer, hitLayer, normRect, rad } from "./model";
import { composite, makeCanvas, strokeTo, type Layer, type Stroke } from "./pixels";
import { useEditor, type Doc } from "./store";

/** 무대 — 문서 한 장을 합성해 보여 주고, 도구에 따라 **누르고 끄는 것**을 받는다.
 *
 *  세 겹이다: 합성 캔버스 · 조작 SVG(손잡이·자르기 상자·붓 커서). 검열 무대(`CensorStage`)와 같은 뼈대다.
 *  ★★획을 긋는 동안은 리액트를 안 거친다 — `strokeRef` 에 모아 두고 프레임마다 `paint()` 가 스토어를 `getState()` 로
 *    읽어 그린다. 손을 떼면 `endStroke` 가 한 걸음 적는다.
 *  ★배율·자리 계산은 전부 `lib/zoomView` (검열·생성 쪽과 같은 함수). `fit` 이면 판 안에 맞추고(작은 그림은
 *    안 키운다), 배율을 정하면 넘치는 만큼 끌어 본다. */
export function Stage({ doc }: { doc: Doc }) {
  const t = useI18n((s) => s.t);
  const tool = useEditor((s) => s.tool);
  const brush = useEditor((s) => s.brush);
  const ratioLock = useEditor((s) => s.ratioLock);
  const crop = useEditor((s) => s.crop);
  const rev = useEditor((s) => s.rev);
  const bg = useUi((s) => s.editorBg);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [box, setBox] = useState<Size>({ w: 0, h: 0 });
  const [pan, setPan] = useState<Pan>({ x: 0, y: 0 });
  const [cursor, setCursor] = useState<{ x: number; y: number } | null>(null);
  const [hover, setHover] = useState<string | null>(null);
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
  // 문서가 바뀌면 가운데에서 시작한다
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
    composite(d, cv, kk, { sel: d.sel, stroke: st });
  }, []);
  useEffect(() => {
    paint();
  }, [doc, rev, fitted.w, fitted.h, paint]);

  /* ── 좌표 ── */
  const toDoc = (e: { clientX: number; clientY: number }) => {
    const el = canvasRef.current;
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * doc.w, y: ((e.clientY - r.top) / r.height) * doc.h };
  };
  const scale = fitted.w / doc.w || 1;
  const sel = doc.layers.find((l) => l.id === doc.sel) ?? null;

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
  const topLayerAt = (p: { x: number; y: number }) => {
    for (let i = doc.layers.length - 1; i >= 0; i--) {
      const l = doc.layers[i];
      if (l.on && hitLayer(l, p.x, p.y)) return l;
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

    if (tool === "brush" || tool === "eraser") {
      const l = s.layer();
      if (!l) return toast(t("editor.noLayer"), "warn");
      if (!l.on) return toast(t("editor.layerOff"), "warn");
      const cv = makeCanvas(l.sw, l.sh);
      const st: Stroke = { cv, alpha: s.brush.opacity / 100, erase: tool === "eraser" };
      strokeRef.current = { st, last: null, layer: l };
      (e.currentTarget as Element).setPointerCapture(e.pointerId);
      strokeAt(p);
      return;
    }

    // 선택 도구 — 손잡이 → **고른 레이어 안이면 그 레이어** → 아니면 그 자리의 맨 앞 레이어
    // ★★고른 레이어 위에 다른 레이어가 겹쳐 있어도 고른 것을 끈다 (사용자 지적 2026-09-22: 목록에서 골라 두고 무대를
    //   누르면 앞의 레이어로 선택이 바뀌어 버렸다). 꺼진 레이어는 안 보이므로 예외다 — 그때는 보이는 것 중 맨 앞을 고른다.
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
      if (sel.on && hitLayer(sel, p.x, p.y)) {
        dragRef.current = { kind: "move", start: p, layer: sel };
        (e.currentTarget as Element).setPointerCapture(e.pointerId);
        return;
      }
    }
    const hit = topLayerAt(p);
    if (hit) {
      if (hit.id !== doc.sel) s.selectLayer(hit.id);
      dragRef.current = { kind: "move", start: p, layer: hit };
      (e.currentTarget as Element).setPointerCapture(e.pointerId);
    }
  };

  const strokeAt = (p: { x: number; y: number }) => {
    const sr = strokeRef.current;
    if (!sr) return;
    const s = useEditor.getState();
    const l = sr.layer;
    const lp = docToLayer(l, p.x, p.y);
    const d = s.brush.size * brushScale(l);
    const g = sr.st.cv.getContext("2d")!;
    strokeTo(g, sr.last, lp, d, s.brush.hard, sr.st.erase ? "#ffffff" : s.brush.color);
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
        if (ratioLock && sx && sy) {
          const kx = w / l.w;
          const ky = h / l.h;
          const kk = Math.max(kx, ky);
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
      const hit = sel && (hitHandle(sel, p) || hitLayer(sel, p.x, p.y)) ? sel : topLayerAt(p);
      setHover(hit?.id ?? null);
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
      return;
    }
    const sr = strokeRef.current;
    if (!sr) return;
    strokeRef.current = null;
    if (rafRef.current) { cancelAnimationFrame(rafRef.current); rafRef.current = 0; }
    useEditor.getState().endStroke(sr.st);
  };

  /* ── 휠: Ctrl 확대·축소 · Alt 붓 크기 ── */
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
        const step = (e.shiftKey ? 10 : 1) * (e.deltaY < 0 ? 1 : -1);
        useEditor.getState().setBrush({ size: Math.max(1, Math.min(400, useEditor.getState().brush.size + step)) });
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
      : tool === "crop" ? "crosshair"
        : tool === "brush" || tool === "eraser" ? "none"
          : hover ? "move" : "default";

  const line = 1.5 / scale;
  const hs = 7 / scale;

  return (
    <div
      ref={hostRef}
      data-editor-stage
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
          // 문서의 투명한 자리 — 체커. 바깥 배경과 갈라 보이게 (사용자 지시 2026-09-22)
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
              stroke={tool === "eraser" ? "rgba(255,255,255,.85)" : brush.color}
              strokeWidth={line}
              style={{ pointerEvents: "none" }}
            />
          )}
        </svg>
      </div>
    </div>
  );
}
