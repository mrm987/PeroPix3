import { useEffect, useRef, useState } from "react";
import { useUi, type PluginFrame } from "../store/ui";
import { HEAD, PAN0, defaultFrame, raiseFrame, type Pan } from "../lib/pluginFrames";
import { useI18n } from "../i18n";
import { Icon } from "../components/Icon";
import { fresh, type PluginInfo } from "../lib/pluginHost";
import { linkOf } from "../lib/pluginLink";
import { openExternal } from "../lib/openExternal";

/** 플러그인 캔버스 — 설치된 플러그인을 **자유 배치 프레임**으로 띄운다 (사용자 결정 2026-09-09, 시안 `docs/design/plugins-canvas/`).
 *
 *  ★탭(2026-09-08)을 걷고 캔버스로 바꿨다. 프레임은 캔버스 좌표(배율 1 기준)로 `useUi.view.frame` 에, 화면 이동·배율은
 *    `useUi.view.pan["plugins"]` 에 저장된다. 꺼내 두지 않은 플러그인은 `view.hide` 가 true 다 (탭 때와 같은 열쇠).
 *  ★프레임 안은 플러그인 페이지(iframe, 백엔드 오리진)다. 머리(이름·판·딱지·GitHub·접기·닫기)와 크기 손잡이는 앱이 그린다.
 *    `fit: "flow"`(기본) 은 **진짜 브라우저 창** — iframe 이 프레임을 채우고 페이지는 창을 늘리듯 다시 흐른다 (글자는 원래 크기).
 *    `fit: "scale"` 은 설계 폭의 페이지를 프레임 폭에 맞춰 CSS 로 확대·축소 — 글자가 흐려져 고정 그림판만 고른다 (사용자 판정 2026-09-09).
 *  ★입력 규칙 (시안 Spec): 바탕 끌기 = 이동, 바탕 휠 = 확대, 프레임 머리 끌기 = 옮기기, 스페이스 + 끌기 = 프레임 위에서도 이동.
 *    iframe 위의 마우스·휠은 플러그인에 그대로 간다. 끄는 동안만 iframe 의 pointer-events 를 끊는다 — 안 그러면 iframe 이
 *    움직임을 삼켜 끌기가 끊긴다.
 *  ★캔버스에 있는 프레임의 iframe 은 **떼지 않는다** — 접어도 숨기기만 한다 (플러그인 상태를 지키려고, 탭 때의 규칙 그대로). */

const PAD = 24;
const Z_MIN = 0.25;
const Z_MAX = 2;
const clampZ = (z: number) => Math.min(Z_MAX, Math.max(Z_MIN, z));

type Drag =
  | { kind: "pan"; sx: number; sy: number; ox: number; oy: number }
  | { kind: "move"; id: string; sx: number; sy: number; f: PluginFrame }
  | { kind: "size"; id: string; sx: number; sy: number; f: PluginFrame; min: { w: number; h: number } };

export function PluginCanvas({ items, base }: { items: PluginInfo[]; base: string }) {
  const t = useI18n((s) => s.t);
  const hide = useUi((u) => u.view.hide);
  const frames = useUi((u) => u.view.frame);
  const savedPan = useUi((u) => u.view.pan["plugins"]) ?? PAN0;
  /** 끄는 동안의 임시값 — 놓을 때 저장한다 (한 번의 끌기에 저장을 수십 번 부르지 않게) */
  const [livePan, setLivePan] = useState<Pan | null>(null);
  const [liveFrame, setLiveFrame] = useState<{ id: string; f: PluginFrame } | null>(null);
  const [space, setSpace] = useState(false);
  /** 지금 끄는 것 — 상태로 둔다 (있는 동안 iframe 의 pointer-events 를 끊고 window 에서 움직임·놓기를 듣는다) */
  const [drag, setDrag] = useState<Drag | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const pan = livePan ?? savedPan;

  /** 캔버스가 있고 켜진 플러그인 중 꺼내 둔 것 */
  const usable = items.filter((p) => p.web && !p.error && p.enabled !== false);
  const shown = usable.filter((p) => !hide[p.id]);
  /** 아직 자리가 없는 것들에게 **한 번에** 빈 자리를 준다 — 서로도 안 겹치게 앞서 정한 것을 넘긴다 */
  const spots = new Map<string, PluginFrame>();
  for (const p of shown) {
    if (frames[p.id]) continue;
    spots.set(p.id, defaultFrame(p, [...spots.values()]));
  }
  const frameOf = (p: PluginInfo): PluginFrame => {
    if (drag && liveFrame?.id === p.id) return liveFrame.f;
    return frames[p.id] ?? spots.get(p.id) ?? defaultFrame(p);
  };
  const setFrame = (id: string, f: PluginFrame) => useUi.getState().setView("frame", id, f);
  const setPan = (v: Pan) => useUi.getState().setView("pan", "plugins", v);

  // ── 스페이스: 프레임 위에서도 화면을 끌 수 있게 덮개를 띄운다 (글자를 치는 중이면 무시) ──
  useEffect(() => {
    const typing = () => {
      const a = document.activeElement as HTMLElement | null;
      return !!a && (a.tagName === "INPUT" || a.tagName === "TEXTAREA" || a.isContentEditable);
    };
    const down = (e: KeyboardEvent) => { if (e.code === "Space" && !e.repeat && !typing()) { setSpace(true); e.preventDefault(); } };
    const up = (e: KeyboardEvent) => { if (e.code === "Space") setSpace(false); };
    const blur = () => setSpace(false);
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", blur);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", blur);
    };
  }, []);

  // ── iframe 안을 누르면 부모에 이벤트가 안 온다 — 창의 초점이 iframe 으로 넘어가는 blur 로 알아채서 맨 앞으로 ──
  useEffect(() => {
    const onBlur = () => {
      setTimeout(() => {
        const a = document.activeElement;
        const id = a instanceof HTMLIFrameElement ? a.getAttribute("data-plugin-canvas") : null;
        if (!id) return;
        const p = usable.find((x) => x.id === id);
        if (p) raiseFrame(id, frameOf(p));
      }, 0);
    };
    window.addEventListener("blur", onBlur);
    return () => window.removeEventListener("blur", onBlur);
  });

  // ── 휠 = 확대 (커서 자리를 고정). 네이티브로 매다는 까닭은 `blocks/Chip` 의 ★주와 같다 ──
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.deltaY) return;
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const mx = e.clientX - r.left, my = e.clientY - r.top;
      const cur = useUi.getState().view.pan["plugins"] ?? PAN0;
      const nz = clampZ(cur.z * (e.deltaY < 0 ? 1.1 : 1 / 1.1));
      if (nz === cur.z) return;
      setPan({ x: mx - ((mx - cur.x) * nz) / cur.z, y: my - ((my - cur.y) * nz) / cur.z, z: nz });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  // ── 끌기 — pointerdown 을 받은 **그 요소**가 포인터를 잡고(setPointerCapture) 움직임·놓기를 받는다.
  //   ★실측 2026-09-09: 뿌리나 window 에서 듣게 하면 진짜 입력의 pointerup 이 안 와서 임시값이 남았다 (합성 이벤트로는 됐다).
  //   잡은 요소로 오는 것은 브라우저가 보장한다. 끄는 동안 iframe 은 pointer-events: none 이다. ──
  const dragRef = useRef<Drag | null>(null);
  const live = useRef<{ pan: Pan | null; frame: { id: string; f: PluginFrame } | null }>({ pan: null, frame: null });
  const begin = (e: React.PointerEvent, d: Drag) => {
    dragRef.current = d;
    live.current = { pan: null, frame: null };
    setDrag(d);
    try { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); } catch {}
  };
  const startPan = (e: React.PointerEvent) => begin(e, { kind: "pan", sx: e.clientX, sy: e.clientY, ox: pan.x, oy: pan.y });
  const onDragMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    const z = savedPan.z;
    const dx = e.clientX - d.sx, dy = e.clientY - d.sy;
    if (d.kind === "pan") { live.current.pan = { x: d.ox + dx, y: d.oy + dy, z }; setLivePan(live.current.pan); }
    else if (d.kind === "move") { live.current.frame = { id: d.id, f: { ...d.f, x: Math.round(d.f.x + dx / z), y: Math.round(d.f.y + dy / z) } }; setLiveFrame(live.current.frame); }
    else { live.current.frame = { id: d.id, f: { ...d.f, w: Math.max(d.min.w, Math.round(d.f.w + dx / z)), h: Math.max(d.min.h, Math.round(d.f.h + dy / z)) } }; setLiveFrame(live.current.frame); }
  };
  const onDragEnd = () => {
    const d = dragRef.current;
    if (!d) return;
    const l = live.current;
    if (d.kind === "pan") { if (l.pan) setPan(l.pan); }
    else if (l.frame) setFrame(l.frame.id, l.frame.f);
    dragRef.current = null;
    setLivePan(null);
    setLiveFrame(null);
    setDrag(null);
  };
  /** 포인터를 잡는 요소마다 붙인다 */
  const dragProps = { onPointerMove: onDragMove, onPointerUp: onDragEnd, onPointerCancel: onDragEnd };
  const dragging = drag !== null;

  // ── 맞춤: 꺼내 둔 프레임 전부가 보이게 ──
  const fitAll = () => {
    const el = rootRef.current;
    if (!el || shown.length === 0) return;
    const fs = shown.map((p) => frameOf(p)).filter(Boolean);
    const x0 = Math.min(...fs.map((f) => f.x)), y0 = Math.min(...fs.map((f) => f.y));
    const x1 = Math.max(...fs.map((f) => f.x + f.w)), y1 = Math.max(...fs.map((f) => f.y + (f.fold ? HEAD : f.h)));
    const vw = el.clientWidth - PAD * 2, vh = el.clientHeight - PAD * 2;
    const z = clampZ(Math.min(1, vw / (x1 - x0), vh / (y1 - y0)));
    setPan({ x: PAD + (vw - (x1 - x0) * z) / 2 - x0 * z, y: PAD + (vh - (y1 - y0) * z) / 2 - y0 * z, z });
  };
  const zoomBy = (k: number) => {
    const el = rootRef.current;
    if (!el) return;
    const mx = el.clientWidth / 2, my = el.clientHeight / 2;
    const nz = clampZ(pan.z * k);
    setPan({ x: mx - ((mx - pan.x) * nz) / pan.z, y: my - ((my - pan.y) * nz) / pan.z, z: nz });
  };

  // ── 패널에서 줄을 끌어 놓기 ──
  const onDrop = (e: React.DragEvent) => {
    const id = e.dataTransfer.getData("peropix/plugin");
    const p = usable.find((x) => x.id === id);
    const el = rootRef.current;
    if (!p || !el) return;
    e.preventDefault();
    const r = el.getBoundingClientRect();
    const f = frames[id] ?? defaultFrame(p);
    const x = Math.round((e.clientX - r.left - pan.x) / pan.z - f.w / 2), y = Math.round((e.clientY - r.top - pan.y) / pan.z - HEAD / 2);
    useUi.getState().setView("hide", id, false);
    raiseFrame(id, { ...f, x, y, fold: false });
  };

  const iconBtn: React.CSSProperties = { width: 24, height: 24, display: "grid", placeItems: "center", borderRadius: "var(--r-1)", color: "var(--ink-faint)" };

  return (
    <div
      ref={rootRef}
      data-plugin-canvas-root
      data-plugin-zoom-level={pan.z.toFixed(2)}
      onPointerDown={(e) => { if (e.target === e.currentTarget && e.button === 0) startPan(e); }}
      {...dragProps}
      onDragOver={(e) => { if (e.dataTransfer.types.includes("peropix/plugin")) e.preventDefault(); }}
      onDrop={onDrop}
      style={{
        flex: 1,
        minHeight: 0,
        position: "relative",
        overflow: "hidden",
        background: "var(--bg)",
        backgroundImage: "radial-gradient(var(--line) 1px, transparent 1px)",
        backgroundSize: `${24 * pan.z}px ${24 * pan.z}px`,
        backgroundPosition: `${pan.x}px ${pan.y}px`,
        cursor: drag?.kind === "pan" ? "grabbing" : "default",
        userSelect: "none",
      }}
    >
      {/* 왼쪽 위 짧은 조작 힌트 */}
      <div style={{ position: "absolute", left: 14, top: 10, fontSize: "var(--text-3xs)", color: "var(--ink-ghost)", zIndex: 3, pointerEvents: "none" }}>{t("plugins.canvasHint")}</div>

      {shown.length === 0 && (
        <div data-plugin-canvas-empty style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center", fontSize: "var(--text-sm)", color: "var(--ink-dim)", pointerEvents: "none" }}>
          {t(usable.length === 0 ? "plugins.none" : "plugins.emptyCanvas")}
        </div>
      )}

      {/* 캔버스 좌표계 */}
      <div style={{ position: "absolute", left: 0, top: 0, transform: `translate(${pan.x}px, ${pan.y}px) scale(${pan.z})`, transformOrigin: "0 0" }}>
        {shown.map((p) => {
          const f = frameOf(p);
          const official = p.origin?.source === "bundled";
          const link = linkOf({ id: p.id, homepage: p.homepage, origin: p.origin });
          const cw = f.w - 2, ch = f.h - HEAD - 2; // 테두리 1px 씩
          // "scale"(선택): 페이지를 설계 폭으로 두고 프레임 폭에 맞춰 CSS 변환으로 확대·축소. 높이는 흐름. ★기본이 아니다 —
          //   변환 확대는 글자 렌더가 깨진다 (사용자 판정 2026-09-09). 기본 "flow" 는 iframe 이 프레임을 채우는 진짜 창이다.
          const scale = p.canvas.fit === "scale" ? cw / p.canvas.width : 1;
          return (
            <div
              key={p.id}
              data-plugin-frame={p.id}
              data-fold={f.fold ? "" : undefined}
              onPointerDownCapture={() => raiseFrame(p.id, f)}
              style={{
                position: "absolute",
                left: f.x,
                top: f.y,
                width: f.w,
                height: f.fold ? HEAD : f.h,
                zIndex: f.z,
                display: "flex",
                flexDirection: "column",
                boxSizing: "border-box",
                border: "1px solid var(--line)",
                borderRadius: "var(--r-4)",
                background: "var(--panel)",
                boxShadow: "var(--shadow-2)",
                overflow: "hidden",
              }}
            >
              {/* 머리 — 끌어 옮긴다 */}
              <div
                data-plugin-frame-head={p.id}
                onPointerDown={(e) => {
                  if (e.button !== 0 || (e.target as HTMLElement).closest("button")) return;
                  e.preventDefault();
                  begin(e, { kind: "move", id: p.id, sx: e.clientX, sy: e.clientY, f });
                }}
                {...dragProps}
                style={{ display: "flex", alignItems: "center", gap: "var(--sp-3)", height: HEAD - 1, flexShrink: 0, padding: "0 var(--sp-3) 0 var(--sp-5)", borderBottom: f.fold ? "none" : "1px solid var(--line)", cursor: "grab" }}
              >
                <span style={{ width: 18, height: 18, display: "grid", placeItems: "center", borderRadius: "var(--r-1)", background: official ? "var(--accent-bg)" : "var(--line-soft)", color: official ? "var(--accent-ink)" : "var(--ink-soft)", fontSize: "var(--text-3xs)", fontWeight: "var(--w-semi)" as never }}>
                  {(p.name.trim()[0] ?? "?").toUpperCase()}
                </span>
                <span style={{ fontSize: "var(--text-xs)", fontWeight: "var(--w-semi)", color: "var(--ink)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{p.name}</span>
                <span style={{ fontSize: "var(--text-3xs)", color: "var(--ink-faint)", fontFamily: "var(--font-mono)" }}>{p.version}</span>
                {official && <span style={{ padding: "0 6px", fontSize: "var(--text-3xs)", lineHeight: "16px", borderRadius: "var(--r-2)", border: "1px solid var(--mode-plugins)", color: "var(--mode-plugins)" }}>{t("plugins.official")}</span>}
                <span style={{ marginLeft: "auto", display: "inline-flex", gap: 2 }}>
                  {link && (
                    <button data-plugin-frame-link title={link} onClick={() => openExternal(link)} style={iconBtn}>{Icon.external}</button>
                  )}
                  <button data-plugin-frame-fold={p.id} data-tip={t(f.fold ? "plugins.unfold" : "plugins.fold")} onClick={() => setFrame(p.id, { ...f, fold: !f.fold })} style={iconBtn}>
                    {f.fold ? Icon.chevronUp12 : Icon.chevronDown12}
                  </button>
                  <button data-plugin-frame-close={p.id} data-tip={t("plugins.closeFrame")} onClick={() => useUi.getState().setView("hide", p.id, true)} style={iconBtn}>
                    {Icon.close12}
                  </button>
                </span>
              </div>
              {/* 페이지 — 접으면 숨기기만 한다 (iframe 을 떼지 않는다) */}
              <div hidden={!!f.fold} style={{ flex: 1, minHeight: 0, position: "relative", overflow: "hidden", background: "var(--panel)" }}>
                {base && (
                  <iframe
                    data-plugin-canvas={p.id}
                    title={p.name}
                    src={`${base}${p.web}${fresh(p.web)}`} // ★기동 표식 — 캐시된 옛 페이지를 안 받는다 (`pluginHost` 의 BOOT 주)
                    // ★배경을 안 칠한 페이지는 투명해 앱의 `--panel` 이 테마대로 비친다. `colorScheme: "light"` 는 Chromium 이
                    //   요소와 안 문서의 color-scheme 이 다르면 문서를 불투명 흰 판으로 그리는 것을 막는다 (실측 2026-09-08).
                    style={
                      p.canvas.fit === "scale"
                        ? { position: "absolute", left: 0, top: 0, width: p.canvas.width, height: Math.round(ch / scale), transform: `scale(${scale})`, transformOrigin: "0 0", border: "none", background: "transparent", colorScheme: "light", pointerEvents: dragging || space ? "none" : "auto" }
                        : { position: "absolute", inset: 0, width: "100%", height: "100%", border: "none", background: "transparent", colorScheme: "light", pointerEvents: dragging || space ? "none" : "auto" }
                    }
                  />
                )}
              </div>
              {/* 크기 손잡이 — 오른쪽 아래, 최소 크기까지만 */}
              {!f.fold && (
                <span
                  data-plugin-frame-resize={p.id}
                  onPointerDown={(e) => {
                    if (e.button !== 0) return;
                    e.stopPropagation();
                    e.preventDefault();
                    begin(e, { kind: "size", id: p.id, sx: e.clientX, sy: e.clientY, f, min: { w: p.canvas.minWidth, h: p.canvas.minHeight + HEAD } });
                  }}
                  {...dragProps}
                  style={{ position: "absolute", right: 0, bottom: 0, width: 16, height: 16, display: "grid", placeItems: "center", cursor: "nwse-resize", color: "var(--ink-ghost)" }}
                >
                  <svg viewBox="0 0 14 14" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><path d="M13 5L5 13M13 9l-4 4" /></svg>
                </span>
              )}
            </div>
          );
        })}
      </div>

      {/* 스페이스 덮개 — 프레임(iframe) 위에서도 화면을 끈다 */}
      {space && (
        <div
          data-plugin-canvas-space
          onPointerDown={(e) => { if (e.button === 0) startPan(e); }}
          {...dragProps}
          style={{ position: "absolute", inset: 0, zIndex: 20, cursor: dragging ? "grabbing" : "grab" }}
        />
      )}

      {/* 오른쪽 아래: 배율 */}
      <div style={{ position: "absolute", right: 14, bottom: 12, zIndex: 3, display: "flex", alignItems: "center", gap: 2, padding: 3, border: "1px solid var(--line)", borderRadius: "var(--r-3)", background: "var(--panel)" }}>
        <button data-plugin-zoom="out" data-tip={t("plugins.zoomOut")} onClick={() => zoomBy(1 / 1.25)} style={{ ...iconBtn, height: 22, color: "var(--ink-dim)" }}>
          <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M5 12h14" /></svg>
        </button>
        <button data-plugin-zoom="reset" onClick={() => setPan({ ...pan, z: 1 })} style={{ minWidth: 44, height: 22, fontSize: "var(--text-2xs)", color: "var(--ink)", fontFamily: "var(--font-mono)", fontVariantNumeric: "tabular-nums" }}>
          {Math.round(pan.z * 100)}%
        </button>
        <button data-plugin-zoom="in" data-tip={t("plugins.zoomIn")} onClick={() => zoomBy(1.25)} style={{ ...iconBtn, height: 22, color: "var(--ink-dim)" }}>{Icon.plus}</button>
        <span style={{ width: 1, height: 14, background: "var(--line)", margin: "0 3px" }} />
        <button data-plugin-zoom-fit onClick={fitAll} style={{ height: 22, padding: "0 var(--sp-3)", fontSize: "var(--text-2xs)", color: "var(--ink-dim)" }}>{t("plugins.fitAll")}</button>
      </div>
    </div>
  );
}
