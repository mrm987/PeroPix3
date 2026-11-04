import { useEffect, useRef, useState } from "react";
import { useI18n } from "../i18n";
import { Icon } from "../components/Icon";
import { useImageDrop } from "../lib/dropImages";
import { percent } from "../lib/zoomView";
import { FONTS, useUi } from "../store/ui";
import { isAbsPath } from "../store/censor";
import { box, card, dropFocus, num, on } from "../panels/censor/ui";
import { ImageActions } from "../panels/ImageActions";
import { useConvertQueue } from "../panels/tools/ConvertTool";
import { curPage, saveName, useEditor, type Tool } from "./store";
import { Stage } from "./Stage";
import { ComicFontStatus, Side } from "./Side";
import { sendToEditor } from "./sendTo";
import { CanvasSizeDialog, ExportPagesDialog, ImageSizeDialog, NewCanvasDialog } from "./dialogs";
import { CutLane } from "./ComicPanel";
import { ContiButton } from "./ComicConti";
import { BubbleKindIcon, LayoutThumb } from "./comicUi";
import { BUBBLE_KINDS, LAYOUTS, pageLabel, type BubbleKind } from "./comic";
import { SFX_STYLES, type SfxStyleId } from "./sfx";
import { ensureComicFonts, stackOf, useComicFonts } from "./comicFonts";

/** 이미지 편집 모드 (사용자 지시 2026-09-22, 목업 `docs/image-editor-mockup.html`).
 *
 *  뼈대는 자동검열과 같다: 머리 줄 · 도구 옵션 줄 · (도구 띠 | 무대 + 빠른 줄 | 오른쪽 280px 기둥).
 *  ★캔버스 탭은 워크스페이스 탭과 같은 어법이다 (네모, 세로 선, 활성은 올라온 면). 화면은 「캔버스」, 코드는 `Doc` 이다.
 *  ★남겨 둔 캔버스를 다 읽기 전(`hydrated`)에는 안 그린다 — 빈 화면이 잠깐 떴다가 캔버스가 나타나는 것을 막는다.
 *  ★무대 아래 빠른 줄은 갤러리·크게 보기와 **같은 부품**(`ImageActions`)이라 i2i·인페인트·보내기가 그대로 온다.
 *    그림은 합성 결과를 **누를 때** 굽는다 (`getUrl`) — 매 편집마다 PNG 를 굽지 않는다.
 *  ★★이 모드도 앱을 켤 때 실린다 (`App.tsx`). 남겨 둔 캔버스는 부팅이 뒤에서 되살린다 (`store.hydrate`). */
export default function Editor() {
  const t = useI18n((s) => s.t);
  const s = useEditor();
  const doc = s.doc();
  const hydrated = s.hydrated;
  const editLast = useUi((st) => st.editLast);
  const { zone, over } = useImageDrop((items) => void sendToEditor(items));
  /** 새 캔버스 창 (이미지 / 만화 페이지) */
  const [newOpen, setNewOpen] = useState(false);
  // ★만화 글꼴은 만화 페이지 캔버스가 있을 때 처음 받는다 (설계 9-3) — 만화를 안 쓰면 안 받는다
  const hasComic = s.docs.some((d) => !!d.comic);
  useEffect(() => {
    if (hasComic) void ensureComicFonts();
  }, [hasComic]);

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
      // ★Del — 고른 레이어를 지운다 (사용자 지시 2026-09-22). 되돌리기가 있어 묻지 않는다 (삭제 단추와 같다)
      if (e.key === "Delete" && st.layer()) { e.preventDefault(); void st.removeLayer(); return; }
      // 컷(K)·말풍선(U)·효과음(F)은 만화 페이지에만 있다
      const comic = !!st.doc()?.comic;
      const tools: Record<string, Tool> = { KeyV: "select", KeyB: "brush", KeyE: "eraser", KeyG: "bucket", KeyT: "text", KeyC: "crop", KeyH: "pan", ...(comic ? { KeyK: "panel" as Tool, KeyU: "bubble" as Tool, KeyF: "sfx" as Tool } : {}) };
      const tool = tools[e.code];
      if (tool) { e.preventDefault(); st.setTool(tool); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

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
              {/* 캔버스 종류 — 만화 페이지 · 이미지 (목업 ①의 탭) */}
              <span data-editor-doc-kind={d.comic ? "comic" : "image"} style={{ display: "grid", color: "var(--ink-faint)" }}>{d.comic ? Icon.page12 : Icon.image12}</span>
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
        <button data-editor-new onClick={() => setNewOpen(true)} data-tip={t("editor.newDoc")} style={{ display: "grid", placeItems: "center", width: 30, height: 30, color: "var(--ink-faint)" }}>
          {Icon.plus}
        </button>
        {/* 저장 자리는 오른쪽 기둥의 「저장 위치」 아래에만 있다 (일괄 변환과 같은 모양, 사용자 지시 2026-09-22) — 여기 두 번 적지 않는다 */}
      </div>

      {hydrated && !doc && (
        <div style={{ ...card, flex: 1, minHeight: 0, display: "grid", placeItems: "center", background: "var(--bg)", borderColor: over ? "var(--accent)" : "var(--line)" }}>
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: "var(--sp-3)", color: "var(--ink-faint)" }}>
            <span style={{ display: "grid", color: "var(--ink-ghost)" }}>{Icon.images}</span>
            <span style={{ fontSize: "var(--text-xs)", color: "var(--ink-dim)" }}>{t("editor.empty")}</span>
            <button data-editor-new-big onClick={() => setNewOpen(true)} style={{ ...box, display: "inline-flex", alignItems: "center", gap: 6, padding: "5px var(--sp-4)" }}>
              {Icon.plus}{t("editor.newDoc")}
            </button>
          </div>
        </div>
      )}

      {hydrated && doc && (
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
                  <span data-editor-info style={{ fontSize: "var(--text-2xs)", color: "var(--ink-faint)", whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums" }}>
                    {doc.comic
                      ? t("editor.pageInfo", { p: pageLabel(Math.max(0, doc.comic.pages.indexOf(curPage(doc) ?? ""))), n: doc.comic.pages.length, w: doc.w, h: doc.h })
                      : t("editor.layersN", { n: doc.layers.length })}
                  </span>
                }
              />
              {/* 생성할 컷의 후보 — 무대 아래 줄 (설계 8-4 · 목업 v2) */}
              {doc.comic && <CutLane doc={doc} />}
            </div>
            <Side doc={doc} />
          </div>
        </>
      )}
      {newOpen && <NewCanvasDialog onClose={() => setNewOpen(false)} />}
    </div>
  );
}

type ToolKey = "editor.toolSelect" | "editor.toolBrush" | "editor.toolEraser" | "editor.toolBucket" | "editor.toolText" | "editor.toolCrop" | "editor.toolPan" | "editor.toolPanel" | "editor.toolBubble" | "editor.toolSfx";
const TOOLS: { id: Tool; icon: React.ReactNode; key: ToolKey }[] = [
  { id: "select", icon: Icon.cursor, key: "editor.toolSelect" },
  { id: "brush", icon: Icon.brush, key: "editor.toolBrush" },
  { id: "eraser", icon: Icon.eraser, key: "editor.toolEraser" },
  { id: "bucket", icon: Icon.bucket, key: "editor.toolBucket" },
  { id: "text", icon: Icon.typeT, key: "editor.toolText" },
  { id: "crop", icon: Icon.crop, key: "editor.toolCrop" },
  { id: "pan", icon: Icon.move, key: "editor.toolPan" },
];
/** 만화 페이지에만 붙는 도구 (목업 ①: 도구 띠 가운데 칸) */
const COMIC_TOOLS: { id: Tool; icon: React.ReactNode; key: ToolKey }[] = [
  { id: "panel", icon: Icon.panel, key: "editor.toolPanel" },
  { id: "bubble", icon: Icon.bubble, key: "editor.toolBubble" },
  { id: "sfx", icon: Icon.sfx, key: "editor.toolSfx" },
];

/** 왼쪽 도구 띠 — 새 자리다 (다른 모드에는 없다). 아래에 되돌리기·다시 실행 */
function ToolStrip() {
  const t = useI18n((s) => s.t);
  const tool = useEditor((s) => s.tool);
  const canUndo = useEditor((s) => s.canUndo());
  const canRedo = useEditor((s) => s.canRedo());
  const comic = useEditor((s) => !!s.doc()?.comic);
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
      {comic && (
        <>
          <span style={{ width: 24, height: 1, background: "var(--line)", margin: "var(--sp-2) 0" }} />
          {COMIC_TOOLS.map((x) => (
            <button key={x.id} data-editor-tool={x.id} onMouseDown={dropFocus} onClick={() => st.setTool(x.id)} data-tip={t(x.key)} style={b(tool === x.id)}>
              {x.icon}
            </button>
          ))}
        </>
      )}
      <span style={{ width: 24, height: 1, background: "var(--line)", margin: "var(--sp-2) 0" }} />
      <button data-editor-undo onMouseDown={dropFocus} onClick={() => st.undo()} disabled={!canUndo} data-tip={t("editor.undo")} style={b(false, !canUndo)}>{Icon.undo}</button>
      <button data-editor-redo onMouseDown={dropFocus} onClick={() => st.redo()} disabled={!canRedo} data-tip={t("editor.redo")} style={b(false, !canRedo)}>{Icon.redo}</button>
    </div>
  );
}

/** 도구 옵션 줄 — 고른 도구의 값 + 보기 (꽉차게·원본·% · 캔버스 밖 배경).
 *  ★붓 값은 브러시·지우개가 **따로**다 (`useUi.editorBrush`, 사용자 지시 2026-09-22). 글자 값은 새 글자 레이어의 기본값이면서,
 *    글자 레이어를 골라 두었으면 그 레이어에도 곧바로 걸린다. */
function ToolOptions() {
  const t = useI18n((s) => s.t);
  const s = useEditor();
  const doc = s.doc()!;
  const bg = useUi((st) => st.editorBg);
  const setBg = useUi((st) => st.setEditorBg);
  const brushes = useUi((st) => st.editorBrush);
  const setBrush = useUi((st) => st.setEditorBrush);
  const txt = useUi((st) => st.editorText);
  const setTextUi = useUi((st) => st.setEditorText);
  const which = s.tool === "eraser" ? "eraser" : "brush";
  const b = brushes[which];
  const sel = s.layer();
  // ★글자 옵션은 고른 글자 레이어가 있으면 **그 레이어의 값**을 보여 주고 (사용자 결정 2026-09-22), 없으면 새 글자 레이어의 기본값이다
  const cur = sel?.text ?? txt;
  const setText = (p: Partial<typeof txt>) => {
    setTextUi(p);
    if (sel?.text) s.patchText(sel.id, p);
  };
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
  const toolMeta = [...TOOLS, ...COMIC_TOOLS].find((x) => x.id === tool)!;
  const zoomPct = doc.view.fit ? null : percent(doc.view.zoom);
  const bgs: { id: string; label: string; sw: React.CSSProperties }[] = [
    { id: "dark", label: t("editor.bgDark"), sw: { background: "var(--bg)" } },
    { id: "light", label: t("editor.bgLight"), sw: { background: "#4a4a55" } },
    { id: "checker", label: t("editor.bgChecker"), sw: { background: "conic-gradient(#8a8a94 25%,#5c5c66 0 50%,#8a8a94 0 75%,#5c5c66 0) 0 0/8px 8px" } },
  ];
  const isColor = bg.startsWith("#");

  return (
    /* ★폭이 모자라면 **다음 줄로 내린다**. 한 줄로 두면 칸들이 줄어들며 서로 덮어, 덮인 버튼은 눌리지 않았다 (말풍선 도구의 종류 버튼 다섯) */
    <div data-editor-opts style={{ display: "flex", flexWrap: "wrap", alignItems: "center", columnGap: "var(--sp-4)", rowGap: "var(--sp-2)", minHeight: 28, fontSize: "var(--text-2xs)", color: "var(--ink-soft)" }}>
      <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontWeight: "var(--w-semi)", color: "var(--ink)" }}>
        {toolMeta.icon}{t(toolMeta.key).replace(/\s*\(.*\)$/, "")}
      </span>
      {(tool === "brush" || tool === "eraser") && (
        <>
          <Opt label={t("editor.size")}>
            <input type="range" data-editor-brush-size min={1} max={400} value={b.size} onChange={(e) => setBrush(which, { size: Number(e.target.value) })} style={{ width: 110 }} />
            <span style={num}>{b.size}</span>
          </Opt>
          <Opt label={t("editor.hardness")}>
            <input type="range" data-editor-brush-hard min={0} max={100} value={Math.round(b.hard * 100)} onChange={(e) => setBrush(which, { hard: Number(e.target.value) / 100 })} style={{ width: 90 }} />
            <span style={num}>{Math.round(b.hard * 100)}%</span>
          </Opt>
          <Opt label={t("editor.opacity")}>
            <input type="range" data-editor-brush-opacity min={1} max={100} value={b.opacity} onChange={(e) => setBrush(which, { opacity: Number(e.target.value) })} style={{ width: 90 }} />
            <span style={num}>{b.opacity}%</span>
          </Opt>
          {tool === "brush" && (
            <Opt label={t("editor.color")}>
              <input type="color" data-editor-brush-color value={brushes.brush.color} onChange={(e) => setBrush("brush", { color: e.target.value })} style={colorBox} />
            </Opt>
          )}
        </>
      )}
      {/* 페인트통 — 허용치는 제 것, 색은 브러시와 같은 것(전경색) */}
      {tool === "bucket" && (
        <>
          <Opt label={t("editor.tolerance")}>
            <input type="range" data-editor-bucket-tol min={0} max={255} value={brushes.bucket.tolerance} onChange={(e) => setBrush("bucket", { tolerance: Number(e.target.value) })} style={{ width: 110 }} />
            <span style={num}>{brushes.bucket.tolerance}</span>
          </Opt>
          <Opt label={t("editor.color")}>
            <input type="color" data-editor-brush-color value={brushes.brush.color} onChange={(e) => setBrush("brush", { color: e.target.value })} style={colorBox} />
          </Opt>
        </>
      )}
      {/* 만화 페이지 — 컷 도구 · 말풍선 도구 (고른 말풍선이 있으면 어느 도구든) */}
      {tool === "panel" && doc.comic && <PanelOptions />}
      {(tool === "bubble" || !!sel?.bubble) && doc.comic && <BubbleOptions />}
      {(tool === "sfx" || !!sel?.sfx) && doc.comic && !sel?.bubble && <SfxOptions />}
      {/* 글자 옵션 — 글자 도구일 때, 그리고 **글자 레이어를 골라 두었을 때** (어느 도구든, 사용자 지시 2026-09-22) */}
      {(tool === "text" || !!sel?.text) && (
        <>
          <Opt label={t("editor.font")}>
            <select data-editor-text-font value={cur.font} onChange={(e) => setText({ font: e.target.value })} style={{ ...box, width: 140, padding: "1px 6px" }}>
              {FONTS.map((f) => <option key={f.id} value={f.stack}>{f.label}</option>)}
              <option value="serif">Serif</option>
              <option value="monospace">Monospace</option>
            </select>
          </Opt>
          <Opt label={t("editor.size")}>
            <input
              type="number"
              data-editor-text-size
              min={4}
              max={600}
              value={cur.size}
              onChange={(e) => setText({ size: Math.max(4, Math.min(600, Math.round(Number(e.target.value) || 4))) })}
              style={{ ...box, width: 58, textAlign: "right", fontVariantNumeric: "tabular-nums", padding: "1px 6px" }}
            />
          </Opt>
          <Opt label={t("editor.color")}>
            <input type="color" data-editor-text-color value={cur.color} onChange={(e) => setText({ color: e.target.value })} style={colorBox} />
          </Opt>
          <button data-editor-text-bold onMouseDown={dropFocus} onClick={() => setText({ bold: !cur.bold })} style={{ ...box, ...(cur.bold ? on : {}), padding: "2px 8px", fontWeight: "var(--w-bold)" }}>
            {t("editor.bold")}
          </button>
          <span style={{ display: "inline-flex", gap: 2 }}>
            {(["left", "center", "right"] as const).map((a) => (
              <button
                key={a}
                data-editor-text-align={a}
                onMouseDown={dropFocus}
                onClick={() => setText({ align: a })}
                data-tip={t(a === "left" ? "editor.alignLeft" : a === "center" ? "editor.alignCenter" : "editor.alignRight")}
                style={{ ...box, ...(cur.align === a ? on : {}), display: "grid", padding: "3px 6px" }}
              >
                {a === "left" ? Icon.alignLeft : a === "center" ? Icon.alignCenter : Icon.alignRight}
              </button>
            ))}
          </span>
        </>
      )}
      {tool === "crop" && (
        <>
          <button data-editor-crop-apply disabled={!s.crop} onClick={() => s.applyCrop()} style={{ ...box, ...(s.crop ? on : {}), padding: "2px 10px" }}>{t("editor.cropApply")}</button>
          <button data-editor-crop-cancel disabled={!s.crop} onClick={() => s.setCrop(null)} style={{ ...box, padding: "2px 10px" }}>{t("editor.cropCancel")}</button>
        </>
      )}
      {/* ★오른쪽 끝에 붙이는 것은 빈 칸(spacer)이 아니라 `marginLeft: auto` 다. 줄이 넘치면 빈 칸은 윗줄에 남고 이 묶음만 아랫줄 왼쪽으로 떨어진다 */}
      <span style={{ marginLeft: "auto", display: "inline-flex", alignItems: "center", gap: "var(--sp-4)" }}>
      {/* 만화 캔버스 — 「AI 콘티」(설계 10번) · 「페이지」 메뉴(용지 · 읽는 방향 · 안내선 · 크기 · 내보내기, 설계 8-5) */}
      {doc.comic && <ContiButton doc={doc} />}
      {doc.comic && <PageMenu />}
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
      </span>
    </div>
  );
}

const colorBox: React.CSSProperties = { width: 24, height: 18, padding: 0, border: "1px solid var(--line)", borderRadius: 4, background: "transparent" };

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

/** 「페이지」 메뉴 — 만화 캔버스의 캔버스 값 (설계 8-5: 오른쪽 기둥에서 옮겨 왔다). 읽는 방향 · 안내선 · 캔버스 크기 · 이미지 크기 ·
 *  여러 페이지 내보내기 · 지금 페이지 지우기 · 만화 글꼴 상태. 크기는 **모든 페이지에** 걸린다 (페이지는 모두 캔버스 크기다) */
function PageMenu() {
  const t = useI18n((s) => s.t);
  const s = useEditor();
  const doc = s.doc()!;
  const page = doc.comic!;
  const [open, setOpen] = useState(false);
  const [dlg, setDlg] = useState<"canvas" | "image" | "export" | null>(null);
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: PointerEvent) => {
      if (ref.current?.contains(e.target as Node)) return;
      setOpen(false);
    };
    document.addEventListener("pointerdown", close, true);
    return () => document.removeEventListener("pointerdown", close, true);
  }, [open]);
  const pid = curPage(doc);
  const i = pid ? page.pages.indexOf(pid) : -1;
  const row: React.CSSProperties = { display: "flex", alignItems: "center", gap: "var(--sp-2)", fontSize: "var(--text-2xs)", color: "var(--ink-faint)" };
  const wide: React.CSSProperties = { ...box, display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 6, padding: "4px 8px", fontSize: "var(--text-2xs)" };
  return (
    <div ref={ref} style={{ position: "relative" }}>
      <button data-editor-page-menu onMouseDown={dropFocus} onClick={() => setOpen((v) => !v)} style={{ ...box, ...(open ? on : {}), display: "inline-flex", alignItems: "center", gap: 5, padding: "2px 9px" }}>
        {Icon.page12}{t("editor.page")}
      </button>
      {open && (
        <div
          data-editor-page-pop
          style={{ position: "absolute", right: 0, top: "100%", marginTop: 4, zIndex: 30, width: 280, padding: "var(--sp-4)", display: "flex", flexDirection: "column", gap: "var(--sp-3)",
                   background: "var(--panel)", border: "1px solid var(--line)", borderRadius: "var(--r-2)", boxShadow: "0 8px 28px rgba(0,0,0,.5)" }}
        >
          <div style={{ ...row, color: "var(--ink-soft)", fontVariantNumeric: "tabular-nums" }}>{t("editor.pageSize", { w: doc.w, h: doc.h, n: page.pages.length })}</div>
          <div style={row}>
            <span style={{ width: 56, flexShrink: 0 }}>{t("editor.readDir")}</span>
            <button data-editor-dir="rtl" onMouseDown={dropFocus} onClick={() => s.setComic({ dir: "rtl" })} style={{ ...box, ...(page.dir === "rtl" ? on : {}), padding: "2px 8px" }}>{t("editor.dirRtl")}</button>
            <button data-editor-dir="ltr" onMouseDown={dropFocus} onClick={() => s.setComic({ dir: "ltr" })} style={{ ...box, ...(page.dir === "ltr" ? on : {}), padding: "2px 8px" }}>{t("editor.dirLtr")}</button>
          </div>
          <div style={row}>
            <span style={{ width: 56, flexShrink: 0 }}>{t("editor.guides")}</span>
            <button data-editor-guides-toggle onMouseDown={dropFocus} onClick={() => s.setComic({ guides: !page.guides })} style={{ ...box, ...(page.guides ? on : {}), display: "inline-flex", alignItems: "center", gap: 4, padding: "2px 8px" }}>
              {Icon.fitBox}{t(page.guides ? "editor.guidesOn" : "editor.guidesOff")}
            </button>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "var(--sp-2)" }}>
            <button data-editor-canvas-size onClick={() => { setOpen(false); setDlg("canvas"); }} style={wide}>{Icon.fitBox}{t("editor.canvasSize")}</button>
            <button data-editor-image-size onClick={() => { setOpen(false); setDlg("image"); }} style={wide}>{Icon.scaling}{t("editor.imageSize")}</button>
          </div>
          <button data-editor-export-pages onClick={() => { setOpen(false); setDlg("export"); }} style={wide}>{Icon.pages}{t("editor.exportPagesN", { n: page.pages.length })}</button>
          {pid && (
            <button
              data-editor-page-del
              disabled={page.pages.length <= 1}
              onClick={() => { setOpen(false); void s.removePage(pid); }}
              style={{ ...wide, color: page.pages.length <= 1 ? "var(--ink-ghost)" : "var(--err-ink)" }}
            >
              {Icon.trash}{t("editor.pageDel", { p: pageLabel(i) })}
            </button>
          )}
          <ComicFontStatus />
        </div>
      )}
      {dlg === "canvas" && <CanvasSizeDialog doc={doc} onClose={() => setDlg(null)} />}
      {dlg === "image" && <ImageSizeDialog doc={doc} onClose={() => setDlg(null)} />}
      {dlg === "export" && <ExportPagesDialog doc={doc} onClose={() => setDlg(null)} />}
    </div>
  );
}

/** 컷 도구의 옵션 줄 — 배치(첫 배치를 다시 편다) · 컷 간격(가로·세로) · 테두리 두께 · 색 (목업 ③).
 *  ★페이지 값이다 (`Doc.comic`) — 간격은 자르기선·템플릿이 쓰고, 테두리는 바꾸면 컷 전부가 다시 구워진다 */
function PanelOptions() {
  const t = useI18n((s) => s.t);
  const s = useEditor();
  const page = s.doc()!.comic!;
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: PointerEvent) => {
      if (ref.current?.contains(e.target as Node)) return;
      setOpen(false);
    };
    document.addEventListener("pointerdown", close, true);
    return () => document.removeEventListener("pointerdown", close, true);
  }, [open]);
  return (
    <>
      <div ref={ref} style={{ position: "relative" }}>
        <button data-editor-layout onMouseDown={dropFocus} onClick={() => setOpen((v) => !v)} style={{ ...box, ...(open ? on : {}), padding: "2px 10px" }}>
          {t("editor.layout")}
        </button>
        {open && (
          <div data-editor-layout-menu style={{ position: "absolute", left: 0, top: "100%", marginTop: 4, zIndex: 20, padding: 8, background: "var(--panel)", border: "1px solid var(--line)", borderRadius: "var(--r-2)", boxShadow: "0 8px 28px rgba(0,0,0,.5)", display: "grid", gridTemplateColumns: "repeat(6, 38px)", gap: 6 }}>
            {Object.keys(LAYOUTS).map((k) => (
              <button key={k} data-editor-layout-pick={k} onClick={() => { setOpen(false); void s.applyLayout(k); }} style={{ ...box, width: 38, height: 52, padding: 0, display: "grid", placeItems: "center" }}>
                <LayoutThumb layout={k} w={28} h={40} />
              </button>
            ))}
          </div>
        )}
      </div>
      <Opt label={t("editor.gapX")}>
        <PageNum mark="editor-gap-x" value={page.gapX} onCommit={(v) => s.setComic({ gapX: v })} />
      </Opt>
      <Opt label={t("editor.gapY")}>
        <PageNum mark="editor-gap-y" value={page.gapY} onCommit={(v) => s.setComic({ gapY: v })} />
      </Opt>
      <Opt label={t("editor.border")}>
        <input
          type="range"
          data-editor-border
          min={0}
          max={30}
          value={Math.round(page.border)}
          onPointerDown={() => s.markBefore()}
          onChange={(e) => s.setComic({ border: Number(e.target.value) }, true)}
          style={{ width: 80 }}
        />
        <span style={num}>{Math.round(page.border)}</span>
      </Opt>
      <input type="color" data-editor-border-color value={page.color} onChange={(e) => s.setComic({ color: e.target.value })} style={colorBox} data-tip={t("editor.borderColor")} />
    </>
  );
}

/** 페이지 숫자 칸 — 적고 Enter·밖을 누르면 한 번 반영 */
function PageNum({ value, onCommit, mark }: { value: number; onCommit: (v: number) => void; mark: string }) {
  const [text, setText] = useState(String(Math.round(value)));
  useEffect(() => setText(String(Math.round(value))), [value]);
  const commit = () => {
    const v = Math.max(0, Math.round(Number(text)));
    if (Number.isFinite(v) && v !== Math.round(value)) onCommit(v);
    else setText(String(Math.round(value)));
  };
  return (
    <input
      data-num={mark}
      value={text}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => { if (e.key === "Enter") (e.currentTarget as HTMLInputElement).blur(); }}
      style={{ ...box, width: 44, textAlign: "right", fontVariantNumeric: "tabular-nums", padding: "1px 6px" }}
    />
  );
}

const KIND_KEY: Record<BubbleKind, "editor.kindSpeech" | "editor.kindNarration" | "editor.kindShout" | "editor.kindThought" | "editor.kindWhisper" | "editor.kindWavy" | "editor.kindPhone"> = {
  speech: "editor.kindSpeech", narration: "editor.kindNarration", shout: "editor.kindShout", thought: "editor.kindThought",
  whisper: "editor.kindWhisper", wavy: "editor.kindWavy", phone: "editor.kindPhone",
};

/** 말풍선 도구의 옵션 줄 — 종류 · 글꼴 · 크기 · 가로/세로 · 글에 맞춤/풍선에 맞춤 · 선 두께 · 선 색 · 채움 색 (목업 ①).
 *  ★새로 만들 말풍선의 기본값이면서, 말풍선을 골라 두었으면 **그 말풍선에 곧바로 걸린다** (글자 도구와 같은 규칙) */
function BubbleOptions() {
  const t = useI18n((s) => s.t);
  const s = useEditor();
  const ui = useUi((st) => st.editorBubble);
  const setUi = useUi((st) => st.setEditorBubble);
  const sel = s.layer();
  const b = sel?.bubble;
  const cur = b ?? { ...ui, fit: "text" as const };
  /** `live` 는 슬라이더를 끄는 동안 (끌기 전에 `markBefore` 로 한 걸음) */
  const set = (p: Partial<typeof ui> & { fit?: "text" | "box" }, live = false) => {
    const { fit, ...rest } = p;
    setUi(rest);
    // 종류가 꼬리를 못 가지면(나레이션) 꼬리는 두고 안 그린다 — 다시 바꾸면 돌아온다
    if (b && sel) s.patchBubble(sel.id, { ...rest, ...(fit ? { fit } : {}) }, live);
  };
  return (
    <>
      <span style={{ display: "inline-flex", border: "1px solid var(--line)", borderRadius: "var(--r-2)", overflow: "hidden" }}>
        {BUBBLE_KINDS.map((k, i) => (
          <button
            key={k}
            data-editor-bubble-kind={k}
            onMouseDown={dropFocus}
            onClick={() => set({ kind: k })}
            data-tip={t(KIND_KEY[k])}
            style={{
              display: "grid", placeItems: "center", height: 24, minWidth: 30, padding: "0 5px",
              borderLeft: i ? "1px solid var(--line)" : 0,
              background: cur.kind === k ? "var(--accent-bg)" : "var(--panel)",
              color: cur.kind === k ? "var(--ink)" : "var(--ink-faint)",
              boxShadow: cur.kind === k ? "inset 0 0 0 1px var(--accent)" : undefined,
            }}
          >
            <BubbleKindIcon kind={k} />
          </button>
        ))}
      </span>
      <select data-editor-bubble-font value={cur.font} onChange={(e) => set({ font: e.target.value })} style={{ ...box, width: 120, padding: "1px 6px" }}>
        <FontOptions prefer="text" current={cur.font} />
      </select>
      <input
        type="number"
        data-editor-bubble-size
        min={6}
        max={400}
        value={Math.round(cur.size)}
        onChange={(e) => set({ size: Math.max(6, Math.min(400, Math.round(Number(e.target.value) || 6))) })}
        style={{ ...box, width: 52, textAlign: "right", fontVariantNumeric: "tabular-nums", padding: "1px 6px" }}
      />
      <span style={{ display: "inline-flex", gap: 2 }}>
        <button data-editor-bubble-dir="h" onMouseDown={dropFocus} onClick={() => set({ vertical: false })} style={{ ...box, ...(!cur.vertical ? on : {}), padding: "2px 8px" }}>{t("editor.horizontal")}</button>
        <button data-editor-bubble-dir="v" onMouseDown={dropFocus} onClick={() => set({ vertical: true })} style={{ ...box, ...(cur.vertical ? on : {}), padding: "2px 8px" }}>{t("editor.vertical")}</button>
      </span>
      <span style={{ display: "inline-flex", gap: 2 }}>
        <button data-editor-bubble-fit="text" onMouseDown={dropFocus} onClick={() => set({ fit: "text" })} disabled={!b} style={{ ...box, ...(cur.fit === "text" ? on : {}), padding: "2px 8px" }}>{t("editor.fitText")}</button>
        <button data-editor-bubble-fit="box" onMouseDown={dropFocus} onClick={() => set({ fit: "box" })} disabled={!b} style={{ ...box, ...(cur.fit === "box" ? on : {}), padding: "2px 8px" }}>{t("editor.fitBox")}</button>
      </span>
      <Opt label={t("editor.line")}>
        <input type="range" data-editor-bubble-stroke min={0} max={12} step={0.5} value={cur.stroke} onPointerDown={() => b && s.markBefore()} onChange={(e) => set({ stroke: Number(e.target.value) }, true)} style={{ width: 70 }} />
        <span style={num}>{cur.stroke}</span>
      </Opt>
      <input type="color" data-editor-bubble-line value={cur.line} onChange={(e) => set({ line: e.target.value })} style={colorBox} data-tip={t("editor.lineColor")} />
      <input type="color" data-editor-bubble-fill value={cur.fill} onChange={(e) => set({ fill: e.target.value })} style={colorBox} data-tip={t("editor.fillColor")} />
      <input type="color" data-editor-bubble-color value={cur.color} onChange={(e) => set({ color: e.target.value })} style={colorBox} data-tip={t("editor.textColor")} />
    </>
  );
}

/** 글꼴 고르기의 항목 — 앱 글꼴 넷 + 받아 둔 만화 글꼴 (말풍선은 식자 글꼴이 먼저, 효과음은 효과음 글꼴이 먼저).
 *  ★지금 값이 목록에 없으면(아직 안 받은 만화 글꼴) 그 이름으로 한 줄 둔다 — 고른 값이 조용히 바뀌지 않게 */
function FontOptions({ prefer, current }: { prefer: "text" | "sfx"; current: string }) {
  const t = useI18n((s) => s.t);
  const fonts = useComicFonts((s) => s.status?.fonts ?? NO_FONTS);
  const loaded = useComicFonts((s) => s.loaded);
  const mine = [...fonts].sort((a, b) => (a.category === prefer ? 0 : 1) - (b.category === prefer ? 0 : 1));
  const all = [...FONTS.map((f) => f.stack), ...mine.map(stackOf), "serif"];
  return (
    <>
      {!all.includes(current) && <option value={current}>{current.replace(/'/g, "")}</option>}
      <optgroup label={t("editor.fontsApp")}>
        {FONTS.map((f) => <option key={f.id} value={f.stack}>{f.label}</option>)}
        <option value="serif">Serif</option>
      </optgroup>
      {mine.length > 0 && (
        <optgroup label={loaded ? t("editor.fontsComic") : t("editor.fontsComicLoading")}>
          {mine.map((f) => <option key={f.id} value={stackOf(f)}>{f.label}</option>)}
        </optgroup>
      )}
    </>
  );
}
const NO_FONTS: never[] = [];

const SFX_STYLE_KEY: Record<SfxStyleId, "editor.sfxImpact" | "editor.sfxSpeed" | "editor.sfxShake" | "editor.sfxSweet" | "editor.sfxHorror"> = {
  impact: "editor.sfxImpact", speed: "editor.sfxSpeed", shake: "editor.sfxShake", sweet: "editor.sfxSweet", horror: "editor.sfxHorror",
};

/** 효과음 도구의 옵션 줄 — 스타일 · 글꼴 · 크기 · 채움(그라데이션) · 안쪽 테 · 바깥 테 (설계 7번).
 *  ★새 효과음의 기본값이면서, 효과음을 골라 두었으면 **그 효과음에 곧바로 걸린다** (말풍선 도구와 같은 규칙).
 *  크기는 고른 효과음이면 그것의 px, 아니면 A4 보통 폭 기준의 기본 크기다 */
function SfxOptions() {
  const t = useI18n((s) => s.t);
  const s = useEditor();
  const ui = useUi((st) => st.editorSfx);
  const setUi = useUi((st) => st.setEditorSfx);
  const sel = s.layer();
  const m = sel?.sfx ?? null;
  const curStyle = m ? m.style : ui.style;
  const set = (p: Record<string, unknown>, live = false) => {
    if (m && sel) s.patchSfx(sel.id, p, live);
  };
  return (
    <>
      <span style={{ display: "inline-flex", border: "1px solid var(--line)", borderRadius: "var(--r-2)", overflow: "hidden" }}>
        {SFX_STYLES.map((k, i) => (
          <button
            key={k}
            data-editor-sfx-style={k}
            onMouseDown={dropFocus}
            onClick={() => {
              setUi({ style: k });
              if (m && sel) s.styleSfx(sel.id, k);
            }}
            style={{
              height: 24, padding: "0 8px", borderLeft: i ? "1px solid var(--line)" : 0,
              background: curStyle === k ? "var(--accent-bg)" : "var(--panel)",
              color: curStyle === k ? "var(--ink)" : "var(--ink-faint)",
              boxShadow: curStyle === k ? "inset 0 0 0 1px var(--accent)" : undefined,
            }}
          >
            {t(SFX_STYLE_KEY[k])}
          </button>
        ))}
      </span>
      {m && (
        <select data-editor-sfx-font value={m.font} onChange={(e) => set({ font: e.target.value })} style={{ ...box, width: 130, padding: "1px 6px" }}>
          <FontOptions prefer="sfx" current={m.font} />
        </select>
      )}
      <input
        type="number"
        data-editor-sfx-size
        min={8}
        max={2000}
        value={Math.round(m ? m.size : ui.size)}
        onChange={(e) => {
          const v = Math.max(8, Math.min(2000, Math.round(Number(e.target.value) || 8)));
          if (m) set({ size: v });
          else setUi({ size: v });
        }}
        data-tip={t("editor.size")}
        style={{ ...box, width: 58, textAlign: "right", fontVariantNumeric: "tabular-nums", padding: "1px 6px" }}
      />
      {m && (
        <>
          <Opt label={t("editor.sfxFill")}>
            <input type="color" data-editor-sfx-fill value={m.fill} onChange={(e) => set({ fill: e.target.value })} style={colorBox} />
            <button data-editor-sfx-grad onMouseDown={dropFocus} onClick={() => set({ fill2: m.fill2 ? null : "#888888" })} style={{ ...box, ...(m.fill2 ? on : {}), display: "grid", padding: "3px 6px" }} data-tip={t("editor.sfxGradient")}>
              {Icon.gradient}
            </button>
            {m.fill2 && <input type="color" data-editor-sfx-fill2 value={m.fill2} onChange={(e) => set({ fill2: e.target.value })} style={colorBox} />}
          </Opt>
          <Opt label={t("editor.sfxInner")}>
            <input type="range" data-editor-sfx-inner min={0} max={30} value={Math.round(m.inner * 100)} onPointerDown={() => s.markBefore()} onChange={(e) => set({ inner: Number(e.target.value) / 100 }, true)} style={{ width: 60 }} />
            <input type="color" data-editor-sfx-inner-color value={m.innerColor} onChange={(e) => set({ innerColor: e.target.value })} style={colorBox} />
          </Opt>
          <Opt label={t("editor.sfxOuter")}>
            <input type="range" data-editor-sfx-outer min={0} max={20} value={Math.round(m.outer * 100)} onPointerDown={() => s.markBefore()} onChange={(e) => set({ outer: Number(e.target.value) / 100 }, true)} style={{ width: 60 }} />
            <input type="color" data-editor-sfx-outer-color value={m.outerColor} onChange={(e) => set({ outerColor: e.target.value })} style={colorBox} />
          </Opt>
        </>
      )}
    </>
  );
}
