import { useEffect, useRef, useState } from "react";
import { useUi, type PluginFrame } from "../store/ui";
import { HEAD, PAN0, defaultFrame, raiseFrame, type Pan } from "../lib/pluginFrames";
import { useI18n } from "../i18n";
import { Icon } from "../components/Icon";
import { fresh, useThemeName, type PluginInfo } from "../lib/pluginHost";

/** 플러그인 캔버스 — 설치된 플러그인을 **자유 배치 프레임**으로 띄운다 (사용자 결정 2026-09-09, 시안 `docs/design/plugins-canvas/`).
 *
 *  ★탭(2026-09-08)을 걷고 캔버스로 바꿨다. 프레임은 캔버스 좌표(배율 1 기준)로 `useUi.view.frame` 에, 화면 이동·배율은
 *    `useUi.view.pan["plugins"]` 에 저장된다. 꺼내 두지 않은 플러그인은 `view.hide` 가 true 다 (탭 때와 같은 열쇠).
 *  ★프레임 안은 플러그인 페이지(iframe, 백엔드 오리진)다. 머리(이름·판·딱지·새로고침·기본 크기·접기·닫기)와 크기 손잡이는 앱이 그린다.
 *  ★★프레임은 **진짜 브라우저 창**이다 (사용자 결정 2026-09-10). iframe 이 프레임을 채우고, 크기를 바꾸면 페이지가 창을 늘리듯
 *    다시 흐른다. 앱은 확대·축소 같은 브라우저에 없는 손질을 하지 않는다 (한때 있던 `fit: "scale"` 은 글자가 깨져 걷었다).
 *    창의 단추는 창을 다루는 것만 둔다 (새로고침·기본 크기·접기·닫기). 제작자용(브라우저에서 열기·GitHub)은 관리 화면에 있다.
 *  ★★iframe 의 `color-scheme` 을 **앱 테마에 맞춘다** — 그러면 페이지가 `prefers-color-scheme` 으로 앱 테마를 받고, 테마를
 *    바꾸면 새로고침 없이 따라온다 (실측 2026-09-10). 브라우저가 OS 테마를 알려 주는 것과 같은 자리다. 배색을 선언한 페이지
 *    (`color-scheme: dark light`, `_app/base.css` 가 해 준다)는 투명이 유지돼 앱 바탕이 비치고, 선언 안 한 페이지는 크롬에서와
 *    같이 흰 바탕으로 그려진다.
 *  ★입력 규칙: **오른쪽·가운데 단추 끌기 = 화면 이동**(어디서 시작하든, 사용자 지시 2026-09-10) · 바탕 왼쪽 끌기도 이동 ·
 *    바탕 휠 = 확대 · 프레임 머리 끌기 = 창 옮기기 · 스페이스 + 끌기 = 프레임 **위에서도** 이동.
 *    ★플러그인 페이지(iframe) 위에서 누른 것은 **앱에 오지 않는다** (다른 오리진이라 그 문서가 받는다) — 그 자리에서
 *      화면을 옮기려면 스페이스를 눌러 덮개를 띄운다. 오른쪽·가운데 끌기는 바탕과 창 머리·테두리에서 듣는다.
 *    iframe 위의 마우스·휠은 플러그인에 그대로 간다. 끄는 동안만 iframe 의 pointer-events 를 끊는다 — 안 그러면 iframe 이
 *    움직임을 삼켜 끌기가 끊긴다.
 *  ★★창은 두 갈래다 (사용자 결정 2026-09-10). **반응형 앱 창**(기본)은 크기를 바꿀 수 있고, 공통 스타일의 골격
 *    (`header`/`main`/`footer`)을 쓰면 본문만 커진다. **설계 크기 창**(`canvas.resize: false`)은 크기 손잡이가 없고
 *    언제나 규격의 크기로 뜬다 — 배치가 한 크기로 짜인 그림판·게임판용이다.
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
  /** 프레임마다의 새로고침 횟수 — 주소에 실어 다시 읽게 한다 (브라우저의 새로고침) */
  const [reloads, setReloads] = useState<Record<string, number>>({});
  /** iframe 의 color-scheme 을 여기 맞춘다 (위 ★★주) */
  const themeName = useThemeName();
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
    const f = drag && liveFrame?.id === p.id ? liveFrame.f : frames[p.id] ?? spots.get(p.id) ?? defaultFrame(p);
    // ★설계 크기 창은 저장된 크기가 있어도 규격대로 — 규격이 바뀌면 바로 따라온다
    return p.canvas.resize ? f : { ...f, w: p.canvas.width, h: p.canvas.height + HEAD };
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
      onPointerDown={(e) => {
        // 오른쪽(2)·가운데(1) 단추는 **어디서 눌러도** 화면 이동 — 창 머리·테두리 위에서도 된다
        if (e.button === 1 || e.button === 2) {
          e.preventDefault();          // 가운데 단추의 자동 스크롤을 막는다
          startPan(e);
          return;
        }
        if (e.target === e.currentTarget && e.button === 0) startPan(e);
      }}
      onContextMenu={(e) => e.preventDefault()}   // 오른쪽 끌기가 메뉴를 띄우지 않게
      onAuxClick={(e) => e.preventDefault()}
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
          return (
            <div
              key={p.id}
              data-plugin-frame={p.id}
              data-fold={f.fold ? "" : undefined}
              onPointerDownCapture={(e) => { if (e.button === 0) raiseFrame(p.id, f); }}   // 오른쪽·가운데는 화면 이동이므로 순서를 안 바꾼다
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
                  // ★왼쪽 단추만 창을 옮긴다 — 오른쪽·가운데는 그대로 뿌리로 올라가 **화면 이동**이 된다
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
                  {/* ★창의 단추는 **창을 다루는 것만** 둔다 (사용자 지시 2026-09-10: 브라우저에서 열기·GitHub 는 앱 상자에 필요 없다).
                      제작자용 두 가지는 관리 화면의 설치된 줄로 옮겼다. */}
                  <button data-plugin-frame-reload={p.id} data-tip={t("plugins.reload")} onClick={() => setReloads((r) => ({ ...r, [p.id]: Date.now() }))} style={iconBtn}>
                    {Icon.refresh}
                  </button>
                  {p.canvas.resize && (f.w !== p.canvas.width || f.h !== p.canvas.height + HEAD) && (
                    <button
                      data-plugin-frame-reset={p.id}
                      data-tip={t("plugins.resetSize")}
                      onClick={() => setFrame(p.id, { ...f, w: p.canvas.width, h: p.canvas.height + HEAD })}
                      style={iconBtn}
                    >
                      {Icon.restore}
                    </button>
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
                    // ★기동 표식(`fresh`)은 캐시된 옛 페이지를 막고, 새로고침 횟수는 그 자리에서 다시 읽게 한다
                    src={`${base}${p.web}${fresh(p.web)}${reloads[p.id] ? `&r=${reloads[p.id]}` : ""}`}
                    style={{
                      position: "absolute",
                      inset: 0,
                      width: "100%",
                      height: "100%",
                      border: "none",
                      background: "transparent",
                      colorScheme: themeName, // ★앱 테마를 페이지에 알린다 (위 ★★주)
                      pointerEvents: dragging || space ? "none" : "auto",
                    }}
                  />
                )}
              </div>
              {/* 크기 손잡이 — 오른쪽 아래, 최소 크기까지만 */}
              {!f.fold && p.canvas.resize && (
                <span
                  data-plugin-frame-resize={p.id}
                  onPointerDown={(e) => {
                    if (e.button !== 0) return;   // 오른쪽·가운데는 뿌리로 올려 보낸다 (화면 이동)
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
