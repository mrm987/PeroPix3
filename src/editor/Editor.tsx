import { useEffect, useRef, useState } from "react";
import { useI18n } from "../i18n";
import { Icon } from "../components/Icon";
import { FolderOpenButton } from "../components/FolderOpenButton";
import { useImageDrop } from "../lib/dropImages";
import { percent } from "../lib/zoomView";
import { useFiles } from "../store/files";
import { toast } from "../store/toast";
import { useUi } from "../store/ui";
import { isAbsPath } from "../store/censor";
import { box, card, dropFocus, num, on } from "../panels/censor/ui";
import { ImageActions } from "../panels/ImageActions";
import { useConvertQueue } from "../panels/tools/ConvertTool";
import { dirOf } from "./model";
import { saveName, useEditor, whereOf, type Tool } from "./store";
import { Stage } from "./Stage";
import { Side } from "./Side";
import { sendToEditor } from "./sendTo";

/** 이미지 편집 모드 (사용자 지시 2026-09-22, 목업 `docs/image-editor-mockup.html`).
 *
 *  뼈대는 자동검열과 같다: 머리 줄 · 도구 옵션 줄 · (도구 띠 | 무대 + 빠른 줄 | 오른쪽 280px 기둥).
 *  ★문서 탭은 워크스페이스 탭과 같은 어법이다 (네모, 세로 선, 활성은 올라온 면).
 *  ★무대 아래 빠른 줄은 갤러리·크게 보기와 **같은 부품**(`ImageActions`)이라 i2i·인페인트·보내기가 그대로 온다.
 *    그림은 합성 결과를 **누를 때** 굽는다 (`getUrl`) — 매 편집마다 PNG 를 굽지 않는다.
 *  ★★이 모드는 **지연 로드**된다 (`App.tsx` 의 `lazy`) — 픽셀 편집기가 다른 화면의 첫 그림을 늦추지 않게. */
export default function Editor() {
  const t = useI18n((s) => s.t);
  const s = useEditor();
  const doc = s.doc();
  const editLast = useUi((st) => st.editLast);
  const { zone, over } = useImageDrop((items) => void sendToEditor(items));

  /* ── 단축키 ── */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable
        || (el.tagName === "INPUT" && !/^(range|checkbox|radio|button|color)$/.test((el as HTMLInputElement).type)))) return;
      const st = useEditor.getState();
      if (!st.doc()) return;
      if ((e.ctrlKey || e.metaKey) && e.code === "KeyZ") {
        e.preventDefault();
        return e.shiftKey ? st.redo() : st.undo();
      }
      if ((e.ctrlKey || e.metaKey) && e.code === "KeyY") {
        e.preventDefault();
        return st.redo();
      }
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (st.tool === "crop" && st.crop) {
        if (e.key === "Enter") { e.preventDefault(); return st.applyCrop(); }
        if (e.key === "Escape") { e.preventDefault(); return st.setCrop(null); }
      }
      const tools: Record<string, Tool> = { KeyV: "select", KeyB: "brush", KeyE: "eraser", KeyC: "crop", KeyH: "pan" };
      const tool = tools[e.code];
      if (tool) { e.preventDefault(); st.setTool(tool); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  /* ── 저장 자리 표시 (검열 머리 줄과 같은 어법: 읽기만, 정하는 창구는 오른쪽 기둥) ── */
  const srcDir = dirOf(doc?.src?.rel ?? doc?.src?.path);
  const where = doc ? whereOf(doc, editLast) : null;
  const saveLabel = !where ? "" : where.mode === "overwrite" ? t("tools.destOverwrite") : where.dest || t("tools.needDest");
  const openTarget = !where ? "" : where.mode === "overwrite" ? srcDir : where.dest;
  const openSaveDir = async () => {
    try {
      if (isAbsPath(openTarget)) await useFiles.getState().openDir(openTarget);
      else await useFiles.getState().reveal(openTarget);
    } catch (e) {
      toast(String(e), "warn");
    }
  };

  /** 보내기 — 먼저 저장하고 그 파일을 넘긴다 (일괄 변환·검열은 파일을 받는다) */
  const savedItem = async () => {
    const r = await s.save();
    if (!r) return null;
    return isAbsPath(r.file) ? { name: r.name, path: r.file } : { name: r.name, rel: r.file };
  };

  return (
    <div
      {...zone}
      data-editor
      style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column", gap: "var(--sp-3)", padding: "var(--sp-4)", outline: over ? "2px solid var(--accent)" : undefined, outlineOffset: -2 }}
    >
      {/* ── 머리: 문서 탭 · 저장 자리 ── */}
      <div style={{ display: "flex", alignItems: "center", gap: 0, minHeight: 30 }}>
        {s.docs.map((d) => {
          const active = d.id === s.cur;
          return (
            <span
              key={d.id}
              data-editor-doc={d.id}
              data-on={active ? "" : undefined}
              onClick={() => s.setCur(d.id)}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
                padding: "5px var(--sp-3) 5px var(--sp-4)",
                borderRight: "1px solid var(--line)",
                background: active ? "var(--panel)" : "transparent",
                color: active ? "var(--ink)" : "var(--ink-dim)",
                fontSize: "var(--text-xs)",
                fontWeight: active ? "var(--w-semi)" : "var(--w-normal)",
                cursor: "pointer",
                whiteSpace: "nowrap",
                maxWidth: 220,
              }}
            >
              {d.dirty && <span data-editor-dirty style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--accent)", flexShrink: 0 }} />}
              <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{d.name}</span>
              <button
                data-editor-doc-close={d.id}
                onClick={(e) => { e.stopPropagation(); void s.closeDoc(d.id); }}
                data-tip={t("editor.closeDoc")}
                style={{ display: "grid", color: "var(--ink-faint)", padding: 1 }}
              >
                {Icon.close12}
              </button>
            </span>
          );
        })}
        <button data-editor-new onClick={() => s.newDoc()} data-tip={t("editor.newDoc")} style={{ display: "grid", placeItems: "center", width: 30, height: 30, color: "var(--ink-faint)" }}>
          {Icon.plus}
        </button>
        <span style={{ flex: 1 }} />
        {doc && (
          <>
            <span data-editor-save-path title={openTarget} style={{ fontSize: "var(--text-2xs)", color: "var(--ink-faint)", maxWidth: 360, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {saveLabel}
            </span>
            <FolderOpenButton data-editor-open-folder tip={t("editor.openFolder")} disabled={!openTarget} onClick={() => void openSaveDir()} />
          </>
        )}
      </div>

      {!doc && (
        <div style={{ ...card, flex: 1, minHeight: 0, display: "grid", placeItems: "center", background: "var(--bg)", borderColor: over ? "var(--accent)" : "var(--line)" }}>
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: "var(--sp-3)", color: "var(--ink-faint)" }}>
            <span style={{ display: "grid", color: "var(--ink-ghost)" }}>{Icon.images}</span>
            <span style={{ fontSize: "var(--text-xs)", color: "var(--ink-dim)" }}>{t("editor.empty")}</span>
            <button data-editor-new-big onClick={() => s.newDoc()} style={{ ...box, display: "inline-flex", alignItems: "center", gap: 6, padding: "5px var(--sp-4)" }}>
              {Icon.plus}{t("editor.newDoc")}
            </button>
          </div>
        </div>
      )}

      {doc && (
        <>
          <ToolOptions />
          <div style={{ flex: 1, minHeight: 0, display: "flex", gap: "var(--sp-4)" }}>
            <ToolStrip />
            <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: "var(--sp-2)" }}>
              <Stage doc={doc} />
              <ImageActions
                url=""
                getUrl={async () => s.dataUrl()}
                name={saveName(doc, editLast.fmt)}
                dims={{ w: doc.w, h: doc.h }}
                onConvert={async () => {
                  const it = await savedItem();
                  if (!it) return;
                  useConvertQueue.getState().add([it]);
                  useUi.getState().setMode("utility");
                  useUi.getState().setView("tab", "tools", "convert" as never);
                }}
                onCensor={async () => {
                  const it = await savedItem();
                  if (!it) return;
                  const { useCensor } = await import("../store/censor");
                  await useCensor.getState().addImages([it]);
                  useCensor.getState().setTab("before");
                  useUi.getState().setMode("censor");
                }}
                right={
                  <span data-editor-info style={{ fontSize: "var(--text-2xs)", color: "var(--ink-faint)", whiteSpace: "nowrap" }}>
                    {t("editor.layersN", { n: doc.layers.length })}
                  </span>
                }
              />
            </div>
            <Side doc={doc} />
          </div>
        </>
      )}
    </div>
  );
}

const TOOLS: { id: Tool; icon: React.ReactNode; key: "editor.toolSelect" | "editor.toolBrush" | "editor.toolEraser" | "editor.toolCrop" | "editor.toolPan" }[] = [
  { id: "select", icon: Icon.cursor, key: "editor.toolSelect" },
  { id: "brush", icon: Icon.brush, key: "editor.toolBrush" },
  { id: "eraser", icon: Icon.eraser, key: "editor.toolEraser" },
  { id: "crop", icon: Icon.crop, key: "editor.toolCrop" },
  { id: "pan", icon: Icon.move, key: "editor.toolPan" },
];

/** 왼쪽 도구 띠 — 새 자리다 (다른 모드에는 없다). 아래에 되돌리기·다시 실행 */
function ToolStrip() {
  const t = useI18n((s) => s.t);
  const tool = useEditor((s) => s.tool);
  const canUndo = useEditor((s) => s.canUndo());
  const canRedo = useEditor((s) => s.canRedo());
  const st = useEditor.getState();
  const b = (active: boolean, disabled = false): React.CSSProperties => ({
    width: 36,
    height: 34,
    display: "grid",
    placeItems: "center",
    borderRadius: "var(--r-2)",
    border: `1px solid ${active ? "var(--accent)" : "transparent"}`,
    background: active ? "var(--accent-bg)" : "transparent",
    color: disabled ? "var(--ink-ghost)" : active ? "var(--ink)" : "var(--ink-soft)",
  });
  return (
    <div data-editor-tools style={{ ...card, width: 44, flexShrink: 0, display: "flex", flexDirection: "column", alignItems: "center", gap: 2, padding: "var(--sp-2) 0" }}>
      {TOOLS.map((x) => (
        <button key={x.id} data-editor-tool={x.id} onMouseDown={dropFocus} onClick={() => st.setTool(x.id)} data-tip={t(x.key)} style={b(tool === x.id)}>
          {x.icon}
        </button>
      ))}
      <span style={{ width: 24, height: 1, background: "var(--line)", margin: "var(--sp-2) 0" }} />
      <button data-editor-undo onMouseDown={dropFocus} onClick={() => st.undo()} disabled={!canUndo} data-tip={t("editor.undo")} style={b(false, !canUndo)}>{Icon.undo}</button>
      <button data-editor-redo onMouseDown={dropFocus} onClick={() => st.redo()} disabled={!canRedo} data-tip={t("editor.redo")} style={b(false, !canRedo)}>{Icon.redo}</button>
    </div>
  );
}

/** 도구 옵션 줄 — 고른 도구의 값 + 보기 (꽉차게·원본·% · 캔버스 밖 배경) */
function ToolOptions() {
  const t = useI18n((s) => s.t);
  const s = useEditor();
  const doc = s.doc()!;
  const bg = useUi((st) => st.editorBg);
  const setBg = useUi((st) => st.setEditorBg);
  const [bgOpen, setBgOpen] = useState(false);
  const bgRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!bgOpen) return;
    const close = (e: PointerEvent) => {
      if (bgRef.current?.contains(e.target as Node)) return;
      setBgOpen(false);
    };
    document.addEventListener("pointerdown", close, true);
    return () => document.removeEventListener("pointerdown", close, true);
  }, [bgOpen]);

  const tool = s.tool;
  const toolMeta = TOOLS.find((x) => x.id === tool)!;
  const zoomPct = doc.view.fit ? null : percent(doc.view.zoom);
  const bgs: { id: string; label: string; sw: React.CSSProperties }[] = [
    { id: "dark", label: t("editor.bgDark"), sw: { background: "var(--bg)" } },
    { id: "light", label: t("editor.bgLight"), sw: { background: "#4a4a55" } },
    { id: "checker", label: t("editor.bgChecker"), sw: { background: "conic-gradient(#8a8a94 25%,#5c5c66 0 50%,#8a8a94 0 75%,#5c5c66 0) 0 0/8px 8px" } },
  ];
  const isColor = bg.startsWith("#");

  return (
    <div data-editor-opts style={{ display: "flex", alignItems: "center", gap: "var(--sp-4)", minHeight: 28, fontSize: "var(--text-2xs)", color: "var(--ink-soft)" }}>
      <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontWeight: "var(--w-semi)", color: "var(--ink)" }}>
        {toolMeta.icon}{t(toolMeta.key).replace(/\s*\(.*\)$/, "")}
      </span>
      {(tool === "brush" || tool === "eraser") && (
        <>
          <Opt label={t("editor.size")}>
            <input type="range" data-editor-brush-size min={1} max={400} value={s.brush.size} onChange={(e) => s.setBrush({ size: Number(e.target.value) })} style={{ width: 110 }} />
            <span style={num}>{s.brush.size}</span>
          </Opt>
          <Opt label={t("editor.hardness")}>
            <input type="range" data-editor-brush-hard min={0} max={100} value={Math.round(s.brush.hard * 100)} onChange={(e) => s.setBrush({ hard: Number(e.target.value) / 100 })} style={{ width: 90 }} />
            <span style={num}>{Math.round(s.brush.hard * 100)}%</span>
          </Opt>
          <Opt label={t("editor.opacity")}>
            <input type="range" data-editor-brush-opacity min={1} max={100} value={s.brush.opacity} onChange={(e) => s.setBrush({ opacity: Number(e.target.value) })} style={{ width: 90 }} />
            <span style={num}>{s.brush.opacity}%</span>
          </Opt>
          {tool === "brush" && (
            <Opt label={t("editor.color")}>
              <input type="color" data-editor-brush-color value={s.brush.color} onChange={(e) => s.setBrush({ color: e.target.value })} style={{ width: 24, height: 18, padding: 0, border: "1px solid var(--line)", borderRadius: 4, background: "transparent" }} />
            </Opt>
          )}
        </>
      )}
      {tool === "crop" && (
        <>
          <button data-editor-crop-apply disabled={!s.crop} onClick={() => s.applyCrop()} style={{ ...box, ...(s.crop ? on : {}), padding: "2px 10px" }}>{t("editor.cropApply")}</button>
          <button data-editor-crop-cancel disabled={!s.crop} onClick={() => s.setCrop(null)} style={{ ...box, padding: "2px 10px" }}>{t("editor.cropCancel")}</button>
        </>
      )}
      <span style={{ flex: 1 }} />
      <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
        <button data-editor-fit onMouseDown={dropFocus} onClick={() => s.setView({ fit: true })} data-tip={t("editor.fit")} style={{ ...box, ...(doc.view.fit ? on : {}), display: "grid", padding: "3px 6px" }}>{Icon.fitBox}</button>
        <button data-editor-1to1 onMouseDown={dropFocus} onClick={() => s.setView({ fit: false, zoom: 1 })} data-tip={t("editor.oneToOne")} style={{ ...box, ...(zoomPct === 100 ? on : {}), display: "grid", padding: "3px 6px" }}>{Icon.oneToOne}</button>
        <span style={{ width: 1, height: 16, background: "var(--line)", margin: "0 4px" }} />
        <button data-editor-zoom-out onMouseDown={dropFocus} onClick={() => s.setView({ fit: false, zoom: Math.max(0.05, (doc.view.fit ? 1 : doc.view.zoom) / 1.25) })} style={{ ...box, padding: "2px 8px" }}>−</button>
        <span data-editor-zoom style={{ ...num, width: 40, textAlign: "center" }}>{zoomPct === null ? t("editor.fitShort") : `${zoomPct}%`}</span>
        <button data-editor-zoom-in onMouseDown={dropFocus} onClick={() => s.setView({ fit: false, zoom: Math.min(8, (doc.view.fit ? 1 : doc.view.zoom) * 1.25) })} style={{ ...box, padding: "2px 8px" }}>+</button>
        <span style={{ width: 1, height: 16, background: "var(--line)", margin: "0 4px" }} />
        <div ref={bgRef} style={{ position: "relative" }}>
          <button data-editor-bg onMouseDown={dropFocus} onClick={() => setBgOpen((v) => !v)} data-tip={t("editor.outsideBg")} style={{ ...box, ...(bgOpen ? on : {}), display: "grid", padding: "3px 6px" }}>{Icon.checker}</button>
          {bgOpen && (
            <div data-editor-bg-menu style={{ position: "absolute", right: 0, top: "100%", marginTop: 4, zIndex: 20, width: 176, padding: 4, background: "var(--panel)", border: "1px solid var(--line)", borderRadius: "var(--r-2)", boxShadow: "0 8px 28px rgba(0,0,0,.5)" }}>
              <div style={{ padding: "4px 8px 6px", color: "var(--ink-faint)", fontSize: "var(--text-3xs)", letterSpacing: ".04em" }}>{t("editor.outsideBg")}</div>
              {bgs.map((x) => (
                <button key={x.id} data-editor-bg-opt={x.id} onClick={() => { setBg(x.id); setBgOpen(false); }} style={{ ...menuRow, ...(bg === x.id ? { background: "var(--accent-bg)", color: "var(--ink)" } : {}) }}>
                  <span style={{ ...swatch, ...x.sw }} />{x.label}
                  {x.id === "dark" && <span style={{ marginLeft: "auto", color: "var(--ink-ghost)", fontSize: "var(--text-3xs)" }}>{t("editor.bgDefault")}</span>}
                </button>
              ))}
              <label data-editor-bg-opt="color" style={{ ...menuRow, ...(isColor ? { background: "var(--accent-bg)", color: "var(--ink)" } : {}), cursor: "pointer" }}>
                <input type="color" value={isColor ? bg : "#7a3d5a"} onChange={(e) => setBg(e.target.value)} style={{ width: 14, height: 14, padding: 0, border: "1px solid rgba(255,255,255,.18)", borderRadius: 3, background: "transparent" }} />
                {t("editor.bgColor")}
              </label>
            </div>
          )}
        </div>
      </span>
    </div>
  );
}

const menuRow: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  width: "100%",
  padding: "5px 8px",
  borderRadius: "var(--r-1)",
  color: "var(--ink-soft)",
  fontSize: "var(--text-2xs)",
  textAlign: "left",
  background: "transparent",
};
const swatch: React.CSSProperties = { width: 14, height: 14, borderRadius: 3, border: "1px solid rgba(255,255,255,.18)", flexShrink: 0 };

function Opt({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6, color: "var(--ink-faint)" }}>
      {label}
      {children}
    </span>
  );
}
