import { Fragment, useEffect, useRef, useState } from "react";
import { useI18n } from "../i18n";
import { Icon } from "../components/Icon";
import { EditableName } from "../components/EditableName";
import { DropLine } from "../components/DropLine";
import { FolderOpenButton } from "../components/FolderOpenButton";
import { Help } from "../components/Tip";
import { api } from "../lib/backend";
import { moveTo } from "../lib/moveTo";
import { useReorder } from "../lib/useReorder";
import { useFiles } from "../store/files";
import { toast } from "../store/toast";
import { useUi } from "../store/ui";
import { Hint, Line, Sec, box, dropFocus, num, on } from "../panels/censor/ui";
import { NO_ADJUST, hasAdjust, withRatio } from "./model";
import { thumbOf, type Layer } from "./pixels";
import { FX_AMT, FX_KINDS, FX_SEEDED, newSeed, type Fx, type FxKind } from "./fx";
import { curPage, mergeBelow, pageView, primaryOf, saveName, useEditor, whereOf, type Doc } from "./store";
import { CanvasSizeDialog, ImageSizeDialog } from "./dialogs";
import { BubbleKindIcon } from "./comicUi";
import { bendable, comicTiers, defaultTail, hasTails, pageLabel, pageLayers, pageOfLayer, panelNumbers, panelPts, pointInPoly, type BubbleMeta, type Tier } from "./comic";
import { SfxSection } from "./SfxSection";
import { retryComicFonts, useComicFonts } from "./comicFonts";

/** 오른쪽 기둥 — 레이어 · 변형 · 보정 · 캔버스 · 저장 위치. 검열의 오른쪽 기둥과 같은 조각(`Sec`·`Line`·`box`)으로 그린다.
 *  ★★만화 캔버스는 **레이어와 저장만** 고정으로 둔다 (목업 v2 · 설계 8-5): 용지 · 읽는 방향 · 안내선 · 캔버스 크기 · 여러 페이지 내보내기는
 *    무대 머리의 「페이지」 메뉴로, 저장 형식과 위치는 저장 버튼 옆 메뉴로 갔다. 컷 생성 칸은 왼쪽 패널(공통 · 컷 편집)로 갔다.
 *    고른 레이어의 칸(변형 · 보정 · 효과 · 말풍선 꼬리 · 효과음)은 고른 것이 있을 때만 선다 */
export function Side({ doc }: { doc: Doc }) {
  const t = useI18n((s) => s.t);
  const s = useEditor();
  /** 으뜸(마지막에 고른 것). 여럿을 골랐으면(`many`) 변형·보정 칸은 접고 개수만 말한다 — 한 레이어의 값을 보여 주면 무엇을 고치는지 알 수 없다 */
  const sel = doc.layers.find((l) => l.id === primaryOf(doc)) ?? null;
  const many = doc.sel.length > 1;
  const adj = sel && !many ? sel.adj : NO_ADJUST;
  const [dlg, setDlg] = useState<"canvas" | "image" | null>(null);
  /** 만화 캔버스는 고른 것이 없으면 레이어 칸만 (변형·보정·효과는 고른 것이 있을 때만) */
  const bare = !!doc.comic && !sel;

  return (
    <div
      data-editor-side
      style={{ width: doc.comic ? 262 : 280, flexShrink: 0, display: "flex", flexDirection: "column", gap: "var(--sp-4)", minHeight: 0 }}
    >
      <div style={{ flex: 1, minHeight: 0, overflowY: "auto", display: "flex", flexDirection: "column", gap: "var(--sp-5)", paddingRight: 2 }}>
        {/* ── 레이어 ── */}
        <Sec label={t("editor.layers")} help={t("editor.layersHint")}>
          <LayerList doc={doc} />
          <div style={{ display: "flex", gap: "var(--sp-2)" }}>
            <IconBtn mark="editor-layer-add" tip={t("editor.addLayer")} onClick={() => s.addLayer()}>{Icon.plus}</IconBtn>
            <IconBtn mark="editor-layer-dup" tip={t("editor.dupLayer")} disabled={!sel} onClick={() => s.dupLayer()}>{Icon.duplicate}</IconBtn>
            <IconBtn mark="editor-layer-merge" tip={t("editor.mergeDown")} disabled={!sel || !mergeBelow(doc)} onClick={() => s.mergeDown()}>{Icon.merge}</IconBtn>
            <span style={{ flex: 1 }} />
            <IconBtn mark="editor-layer-del" tip={t("editor.delLayer")} disabled={!sel} onClick={() => s.removeLayer()} danger>{Icon.trash}</IconBtn>
          </div>
        </Sec>

        {/* ── 만화 캔버스: 고른 컷 · 고른 말풍선 · 컷에 든 그림 (설계 5·6번) ── */}
        {doc.comic && sel && !many && <ComicSections doc={doc} sel={sel} />}
        {/* 효과음 — 고른 효과음을 고치거나, 효과음 도구만 들었으면 새 효과음의 글을 고른다 (설계 7번) */}
        {doc.comic && !many && (sel?.sfx || (s.tool === "sfx" && !sel?.bubble && !sel?.panel)) && <SfxSection sel={sel?.sfx ? sel : null} />}

        {/* ── 변형 ── 컷(꼭짓점으로 고친다)·말풍선(몸통·꼬리 손잡이)은 무대에서만 고친다 */}
        {!(sel && !many && (sel.panel || sel.bubble)) && !bare && (
        <Sec label={sel && !many ? `${sel.name} · ${t("editor.transform")}` : t("editor.transform")}>
          {!sel && <Hint>{t("editor.noLayer")}</Hint>}
          {sel && many && <span data-editor-many><Hint>{t("editor.selectedN", { n: doc.sel.length })}</Hint></span>}
          {sel && !many && (
            <>
              <Line label={t("editor.pos")}>
                <NumIn mark="editor-x" value={Math.round(sel.x)} onCommit={(v) => s.patchLayer(sel.id, { x: v })} />
                <span style={{ color: "var(--ink-ghost)" }}>×</span>
                <NumIn mark="editor-y" value={Math.round(sel.y)} onCommit={(v) => s.patchLayer(sel.id, { y: v })} />
              </Line>
              <Line label={t("editor.dims")}>
                {/* ★글자 레이어는 언제나 비율대로 늘고, 늘린 만큼 글꼴 크기가 된다 (`settleText`) */}
                <NumIn mark="editor-w" value={Math.round(sel.w)} min={1} onCommit={(v) => { s.patchLayer(sel.id, s.ratioLock || sel.text || sel.sfx ? { w: v, h: withRatio(sel.w, sel.h, v) } : { w: v }); if (sel.text) s.settleText(sel.id); if (sel.sfx) s.settleSfx(sel.id); }} />
                <span style={{ color: "var(--ink-ghost)" }}>×</span>
                <NumIn mark="editor-h" value={Math.round(sel.h)} min={1} onCommit={(v) => { s.patchLayer(sel.id, s.ratioLock || sel.text || sel.sfx ? { h: v, w: withRatio(sel.h, sel.w, v) } : { h: v }); if (sel.text) s.settleText(sel.id); if (sel.sfx) s.settleSfx(sel.id); }} />
                <button
                  data-editor-ratio
                  onMouseDown={dropFocus}
                  onClick={() => s.setRatioLock(!s.ratioLock)}
                  data-tip={t("editor.ratio")}
                  style={{ ...box, ...(s.ratioLock ? on : {}), marginLeft: "auto", display: "inline-flex", alignItems: "center", gap: 4, padding: "2px 6px" }}
                >
                  {s.ratioLock ? Icon.lock : Icon.unlock}
                  {t("editor.ratio")}
                </button>
              </Line>
              <Line label={t("editor.rotate")}>
                <NumIn mark="editor-rot" value={Math.round(sel.rot)} onCommit={(v) => s.patchLayer(sel.id, { rot: ((v % 360) + 360) % 360 })} suffix="°" />
                <button data-editor-rot90 onMouseDown={dropFocus} onClick={() => s.rotate90()} style={{ ...box, display: "inline-flex", alignItems: "center", gap: 4, padding: "2px 8px" }}>
                  {Icon.rotateCw}90°
                </button>
                <button data-editor-fliph onMouseDown={dropFocus} onClick={() => s.flip("h")} data-tip={t("editor.flipH")} style={{ ...box, display: "grid", padding: "3px 6px" }}>{Icon.flipH}</button>
                <button data-editor-flipv onMouseDown={dropFocus} onClick={() => s.flip("v")} data-tip={t("editor.flipV")} style={{ ...box, display: "grid", padding: "3px 6px" }}>{Icon.flipV}</button>
              </Line>
              <Line label={t("editor.opacity")}>
                <input
                  type="range"
                  data-editor-layer-opacity
                  min={0}
                  max={100}
                  value={sel.opacity}
                  onChange={(e) => s.patchLayer(sel.id, { opacity: Number(e.target.value) }, true)}
                  onPointerDown={() => s.markBefore()}
                  style={{ flex: 1 }}
                />
                <span style={num}>{sel.opacity}</span>
              </Line>
            </>
          )}
        </Sec>
        )}

        {/* ── 보정 — 레이어의 속성이라 슬라이더 값이 **언제나** 걸린다 (사용자 지시 2026-09-22: 「적용」 없음, 초기화만).
             말풍선에도 걸린다 (사용자 결정 2026-09-28). 컷은 그 안의 그림을 골라서 건다 ── */}
        {!(sel && !many && sel.panel) && !bare && (
        <div style={{ display: "flex", flexDirection: "column", gap: "var(--sp-2)" }}>
          <span style={{ display: "flex", alignItems: "center", gap: "var(--sp-2)", fontSize: "var(--text-xs)", fontWeight: "var(--w-semi)", color: "var(--ink-soft)" }}>
            {t("editor.adjust")}
            <Help tip={t("editor.adjustHint")} />
            <span style={{ flex: 1 }} />
            <button data-editor-adjust-reset disabled={!sel || many || !hasAdjust(adj)} onClick={() => s.resetAdjust()} style={{ ...box, padding: "1px 8px", fontSize: "var(--text-3xs)", color: "var(--ink-faint)" }}>
              {t("editor.reset")}
            </button>
          </span>
          {(
            [
              ["bri", "editor.brightness", -100, 100],
              ["con", "editor.contrast", -100, 100],
              ["sat", "editor.saturation", -100, 100],
              ["hue", "editor.hue", -180, 180],
            ] as const
          ).map(([key, label, lo, hi]) => (
            <Line key={key} label={t(label)}>
              <input
                type="range"
                data-editor-adjust={key}
                min={lo}
                max={hi}
                value={adj[key]}
                disabled={!sel || many}
                onPointerDown={() => s.markBefore()}
                onChange={(e) => s.setAdjust({ [key]: Number(e.target.value) }, true)}
                style={{ flex: 1 }}
              />
              <span style={num}>{adj[key]}</span>
            </Line>
          ))}
        </div>
        )}

        {/* ── 효과 — 보정과 같은 규칙이다 (레이어의 속성, 언제나 걸림) ── */}
        {!(sel && !many && sel.panel) && !bare && <FxSection sel={sel} many={many} n={doc.sel.length} />}

        {/* ── 캔버스 (보통 캔버스만 — 만화는 「페이지」 메뉴) ── */}
        {!doc.comic && (
        <Sec label={`${t("editor.canvas")}  ${doc.w} × ${doc.h}`}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "var(--sp-2)" }}>
            <button data-editor-canvas-size onClick={() => setDlg("canvas")} style={{ ...box, display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 6 }}>
              {Icon.fitBox}{t("editor.canvasSize")}
            </button>
            <button data-editor-image-size onClick={() => setDlg("image")} style={{ ...box, display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 6 }}>
              {Icon.scaling}{t("editor.imageSize")}
            </button>
          </div>
        </Sec>
        )}
      </div>

      {/* ── 저장 (스크롤 밖, 맨 아래 고정) ──
          ★일괄 변환의 오른쪽 기둥과 **같은 차례·모양**이다 (사용자 지시 2026-09-22): 형식이 위, 저장 위치 아래에 저장될 폴더와 「폴더 열기」.
          ★만화 캔버스는 저장될 이름 한 줄 + 저장 버튼 옆 메뉴에 같은 칸을 넣는다 (목업 v2) */}
      {doc.comic ? (
        <ComicSave doc={doc} />
      ) : (
        <div style={{ flexShrink: 0, display: "flex", flexDirection: "column", gap: "var(--sp-3)", borderTop: "1px solid var(--line)", paddingTop: "var(--sp-3)" }}>
          <SaveWhere doc={doc} />
          <SaveButton />
        </div>
      )}

      {dlg === "canvas" && <CanvasSizeDialog doc={doc} onClose={() => setDlg(null)} />}
      {dlg === "image" && <ImageSizeDialog doc={doc} onClose={() => setDlg(null)} />}
    </div>
  );
}

/** 저장 형식 · 저장 위치 (저장될 폴더 · 폴더 열기) — 보통 캔버스는 기둥에, 만화 캔버스는 저장 버튼 옆 메뉴에 선다 */
function SaveWhere({ doc }: { doc: Doc }) {
  const t = useI18n((s) => s.t);
  const editLast = useUi((st) => st.editLast);
  const setEditLast = useUi((st) => st.setEditLast);
  const pick = async () => {
    try {
      const r = await api<{ dir: string | null }>("/api/files/pick-dir", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ start: doc.src?.path ? doc.src.path.replace(/[\\/][^\\/]*$/, "") : editLast.dest || "" }),
      });
      if (r.dir) setEditLast({ dest: r.dir });
    } catch (e) {
      toast(String(e), "warn");
    }
  };
  /** 원본 자리가 없는 문서 — 저장 자리 셈(`whereOf`)이 「저장 폴더 지정」으로 고정한다 */
  const noHome = !doc.src;
  const where = whereOf(doc, editLast);
  const mode = where.mode;
  const whereDest = "dest" in where ? where.dest : "";
  const needDest = mode === "folder";
  /** 지금 옵션으로 **저장될 폴더** — 일괄 변환과 같은 창구(`/api/tools/convert-dest`, 변환이 쓰는 함수)에 물어 절대 경로로
   *  보여 준다 (사용자 지시 2026-09-22: 일괄 변환과 같은 모양). 자리를 모르면 비운다 — 틀린 자리를 보여 주는 것보다 낫다 */
  const [saveDir, setSaveDir] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    if (mode !== "overwrite" && !whereDest) {
      setSaveDir(null);
      return;
    }
    void api<{ dir: string | null }>("/api/tools/convert-dest", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        items: doc.src ? [{ name: doc.src.name, rel: doc.src.rel, path: doc.src.path }] : [],
        mode,
        dest: mode === "folder" ? whereDest : "",
      }),
    })
      .then((r) => alive && setSaveDir(r.dir))
      .catch(() => alive && setSaveDir(null));
    return () => {
      alive = false;
    };
  }, [doc.src, mode, whereDest]);
  return (
    <>
      <Sec label={t("tools.format")}>
        <div style={{ display: "flex", gap: "var(--sp-2)" }}>
          {(["png", "webp"] as const).map((f) => (
            <button key={f} data-editor-fmt={f} onMouseDown={dropFocus} onClick={() => setEditLast({ fmt: f })} style={{ ...box, flex: 1, ...(editLast.fmt === f ? on : {}) }}>
              {f === "png" ? "PNG" : "WebP (Lossless)"}
            </button>
          ))}
        </div>
        {!doc.comic && <Hint><span data-editor-save-name>{t("tools.preview", { s: saveName(doc, editLast.fmt) })}</span></Hint>}
      </Sec>
      <Sec label={t("tools.dest")} help={t("tools.destHint")}>
        <select
          data-editor-dest-mode
          value={mode}
          disabled={noHome}
          onChange={(e) => setEditLast({ mode: e.target.value as "overwrite" | "sub" | "folder" })}
          style={{ ...box, width: "100%" }}
        >
          <option value="overwrite">{t("tools.destOverwrite")}</option>
          <option value="sub">{t("tools.destSub")}</option>
          <option value="folder">{t("tools.destFolder")}</option>
        </select>
        {/* ★막힌 이유는 막힌 칸 **바로 아래** (사용자 지적 2026-09-22: 멀리 적혀 있어 왜 안 바뀌는지 알 수 없었다) */}
        {noHome && <Hint>{t("editor.noHome")}</Hint>}
        {mode === "overwrite" && <Hint>{t("tools.destOverwriteHint")}</Hint>}
        {needDest && (
          <button data-editor-dest-pick onClick={() => void pick()} style={{ ...box, width: "100%", textAlign: "left", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {editLast.dest || t("tools.destPick")}
          </button>
        )}
        {needDest && !editLast.dest && <Hint>{t("editor.needDest")}</Hint>}
        {/* 지금 옵션으로 저장될 폴더 + 「폴더 열기」 — 일괄 변환의 `data-convert-save-dir` 와 같은 줄 */}
        {saveDir && (
          <div data-editor-save-dir style={{ display: "flex", alignItems: "center", gap: "var(--sp-2)", minWidth: 0 }}>
            <span
              data-tip={saveDir}
              style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                       fontSize: "var(--text-2xs)", color: "var(--ink-soft)", direction: "rtl", textAlign: "left" }}
            >
              {saveDir}
            </span>
            <FolderOpenButton
              data-editor-open-dir
              tip={t("tools.openFolder")}
              onClick={() => void useFiles.getState().openDir(saveDir).catch((e) => toast(String(e), "warn"))}
            />
          </div>
        )}
      </Sec>
    </>
  );
}

/** 저장 버튼 — 보통 캔버스는 한 장, 만화 캔버스는 페이지마다 한 장씩 (`store.save`) */
function SaveButton({ grow }: { grow?: boolean }) {
  const t = useI18n((s) => s.t);
  const s = useEditor();
  return (
    <button
      data-editor-save
      disabled={s.busy}
      onClick={() => void s.save()}
      style={{
        width: grow ? undefined : "100%",
        flex: grow ? 1 : undefined,
        padding: "var(--sp-2) 0",
        borderRadius: "var(--r-2)",
        border: "1px solid var(--accent)",
        background: "var(--accent)",
        color: "#fff",
        fontSize: "var(--text-xs)",
        fontWeight: "var(--w-semi)",
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        gap: 6,
        opacity: s.busy ? 0.6 : 1,
      }}
    >
      {Icon.save}{t("editor.save")}
    </button>
  );
}

/** 만화 캔버스의 저장 — 저장될 이름 한 줄(`1화_p01.png ~ p02.png`) + 저장 버튼 · 옆 메뉴(형식 · 저장 위치) (목업 v2) */
function ComicSave({ doc }: { doc: Doc }) {
  const t = useI18n((s) => s.t);
  const editLast = useUi((st) => st.editLast);
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
  const where = whereOf(doc, editLast);
  const blocked = where.mode === "folder" && !editLast.dest;
  return (
    <div ref={ref} style={{ flexShrink: 0, display: "flex", flexDirection: "column", gap: "var(--sp-2)", borderTop: "1px solid var(--line)", paddingTop: "var(--sp-3)", position: "relative" }}>
      <span data-editor-save-name style={{ fontSize: "var(--text-2xs)", color: "var(--ink-faint)", fontFamily: "var(--font-mono)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {saveName(doc, editLast.fmt)}
      </span>
      {blocked && <Hint>{t("editor.needDest")}</Hint>}
      <div style={{ display: "flex", gap: "var(--sp-2)" }}>
        <SaveButton grow />
        <button
          data-editor-save-more
          onMouseDown={dropFocus}
          onClick={() => setOpen((v) => !v)}
          data-tip={t("editor.saveMore")}
          style={{ ...box, ...(open ? on : {}), width: 34, display: "grid", placeItems: "center", padding: 0 }}
        >
          {Icon.chevronDown12}
        </button>
      </div>
      {open && (
        <div
          data-editor-save-menu
          style={{ position: "absolute", right: 0, bottom: "100%", marginBottom: 6, zIndex: 20, width: 280, padding: "var(--sp-4)", display: "flex", flexDirection: "column", gap: "var(--sp-4)",
                   background: "var(--bg)", border: "1px solid var(--line)", borderRadius: "var(--r-3)", boxShadow: "0 8px 28px rgba(0,0,0,.5)" }}
        >
          <SaveWhere doc={doc} />
        </div>
      )}
    </div>
  );
}

/** 레이어 목록 — **위가 앞**이다 (스토어는 아래가 먼저). 차례 바꾸기는 앱의 것 하나(`useReorder`)다 — 탭·블록과 같은 끌기라
 *  끼움선(`DropLine`)도 같은 부품이다 (사용자 지시 2026-09-22).
 *  ★잔상(`DragGhost`)은 **안 그린다** (사용자 지적 2026-09-22: 커서를 따라오는 줄이 놓일 자리를 가려 어디에 놓이는지 알 수 없었다).
 *    끌리는 줄은 제자리에서 흐려지고, 놓일 자리는 끼움선 하나로 말한다 (포토샵의 레이어 판과 같다).
 *  ★줄은 눌러서 고르는 자리이기도 해서 `tapSafe` 로 잡는다 — 문턱을 넘기 전에는 클릭(고르기)·더블클릭(이름 고치기)이 산다 */
/** 효과 이름 — ★키를 이어 만들지 않는다 (지침 「i18n 키를 문자열로 이어 만들지 않는다」) */
const FX_LABEL = {
  glitch: "editor.fxGlitch",
  crt: "editor.fxCrt",
  vhs: "editor.fxVhs",
  chroma: "editor.fxChroma",
  film: "editor.fxFilm",
  bloom: "editor.fxBloom",
  halftone: "editor.fxHalftone",
  pixel: "editor.fxPixel",
  vignette: "editor.fxVignette",
} as const satisfies Record<FxKind, string>;
/** 효과 — 칸에는 효과 이름만 둔다 (사용자 지시 2026-10-25: 미리보기 그림을 뺐다). 누르면 걸리고 다시 누르면 빠진다. **여럿을 겹쳐 건다**
 *  (사용자 지시 2026-09-28) — 걸린 것마다 아래에 강도 한 줄 (무작위가 드는 것은 다시 섞기). 한꺼번에 떼는 것은 보정과 같이 머리의 「초기화」다.
 *  ★강도 줄의 차례가 **입히는 차례**다 (위가 먼저). 줄 앞 손잡이로 끌어 바꾼다 (사용자 지시 2026-10-25: 칸의 차례 번호 대신) —
 *    레이어 목록과 같은 `useReorder` · `moveTo` · `DropLine` 이고 잔상은 안 그린다. 한 번 옮기는 것이 되돌리기 한 걸음이다 */
function FxSection({ sel, many, n }: { sel: Layer | null; many: boolean; n: number }) {
  const t = useI18n((st) => st.t);
  const s = useEditor();
  const list = sel && !many ? (sel.fx ?? []) : [];
  const toggle = (k: FxKind) =>
    s.setFx(list.some((f) => f.kind === k) ? list.filter((f) => f.kind !== k) : [...list, { kind: k, amt: FX_AMT, seed: newSeed() }]);
  const patch = (k: FxKind, p: Partial<Fx>, live = false) => s.setFx(list.map((f) => (f.kind === k ? { ...f, ...p } : f)), live);
  const rowsRef = useRef<HTMLDivElement | null>(null);
  const { register, handleProps, dragIdx, overIdx } = useReorder(list.length, (from, to) => s.setFx(moveTo(list, from, to)), { within: rowsRef });
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--sp-2)" }}>
      <span style={{ display: "flex", alignItems: "center", gap: "var(--sp-2)", fontSize: "var(--text-xs)", fontWeight: "var(--w-semi)", color: "var(--ink-soft)" }}>
        {t("editor.fx")}
        <Help tip={t("editor.fxHint")} />
        <span style={{ flex: 1 }} />
        <button data-editor-fx-reset disabled={!list.length} onClick={() => s.setFx(null)} style={{ ...box, padding: "1px 8px", fontSize: "var(--text-3xs)", color: "var(--ink-faint)" }}>
          {t("editor.reset")}
        </button>
      </span>
      {!sel && <Hint>{t("editor.noLayer")}</Hint>}
      {sel && many && <Hint>{t("editor.selectedN", { n })}</Hint>}
      {sel && !many && (
        <>
          <div data-editor-fx-grid style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: "var(--sp-2)" }}>
            {FX_KINDS.map((k) => {
              const cur = list.some((f) => f.kind === k);
              return (
                <button
                  key={k}
                  data-editor-fx={k}
                  data-on={cur ? "" : undefined}
                  onMouseDown={dropFocus}
                  onClick={() => toggle(k)}
                  style={{ ...box, ...(cur ? on : {}), minWidth: 0, padding: "4px 6px", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}
                >
                  {t(FX_LABEL[k])}
                </button>
              );
            })}
          </div>
          {list.length > 0 && (
            // ★줄 사이 간격은 줄의 위아래 여백으로 준다 — 품의 gap 이면 끼움선(높이 0)도 칸으로 쳐서 간격이 두 배가 되고, 선이 틈 가운데에 안 온다
            <div ref={rowsRef} data-editor-fx-rows style={{ display: "flex", flexDirection: "column", margin: "-3px 0" }}>
              {list.map((f, i) => (
                <Fragment key={f.kind}>
                  <DropLine on={dragIdx != null && overIdx === i} />
                  <div ref={register(i)} data-editor-fx-row={f.kind} style={{ display: "flex", alignItems: "center", gap: 4, padding: "3px 0", opacity: dragIdx === i ? 0.35 : 1 }}>
                    {/* 하나뿐이면 바꿀 차례가 없다 */}
                    {list.length > 1 && (
                      <span data-editor-fx-grip={f.kind} {...handleProps(i)} style={{ ...handleProps(i).style, display: "grid", color: "var(--ink-faint)" }}>
                        {Icon.grip}
                      </span>
                    )}
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <Line label={t(FX_LABEL[f.kind])}>
                        <input
                          type="range"
                          data-editor-fx-amount={f.kind}
                          min={0}
                          max={100}
                          value={f.amt}
                          onPointerDown={() => s.markBefore()}
                          onChange={(e) => patch(f.kind, { amt: Number(e.target.value) }, true)}
                          style={{ flex: 1, minWidth: 0 }}
                        />
                        <span style={num}>{f.amt}</span>
                        {FX_SEEDED.includes(f.kind) && (
                          <button
                            data-editor-fx-reseed={f.kind}
                            data-tip={t("editor.fxReseed")}
                            onMouseDown={dropFocus}
                            onClick={() => patch(f.kind, { seed: newSeed() })}
                            style={{ ...box, display: "grid", padding: "3px 5px" }}
                          >
                            {Icon.dice}
                          </button>
                        )}
                      </Line>
                    </div>
                  </div>
                </Fragment>
              ))}
              <DropLine on={dragIdx != null && overIdx === list.length} />
            </div>
          )}
        </>
      )}
    </div>
  );
}

function LayerList({ doc }: { doc: Doc }) {
  const t = useI18n((s) => s.t);
  const s = useEditor();
  const listRef = useRef<HTMLDivElement | null>(null);
  /** ★★만화 캔버스는 **페이지마다** 묶인다 (설계 4번 · 목업 v2) — 페이지 머리를 눌러 접고 편다. 처음에는 지금 페이지만 펴 있다 */
  const cur = curPage(doc);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const isOpen = (pid: string) => open[pid] ?? pid === cur;
  const pages = doc.comic ? doc.comic.pages : [null];
  /** 줄 전부 (접힌 페이지 것까지, 화면 차례) — 끌어 옮긴 차례는 이것에서 셈한다 */
  const all = pages.flatMap((pid) => listRows(pid ? pageView(doc, pid) : doc));
  const rows = doc.comic ? all.filter((l) => isOpen(pageOf(l))) : all;
  function pageOf(l: Layer): string {
    return doc.comic ? pageOfLayer(l, doc.comic.pages) : "";
  }
  /** 화면 차례(위가 0)의 틈 번호로 받아 스토어 차례(아래가 먼저)로 넘긴다 — 셈은 앱 공통 `moveTo`.
   *  ★접힌 페이지의 줄은 안 보이므로 보이는 줄의 틈을 **전부의 틈**으로 옮겨 셈한다. 페이지를 넘겨 끌어도 레이어는 제 페이지에 남는다 (`comicStack`) */
  const move = (from: number, to: number) => {
    const f = all.indexOf(rows[from]);
    const tt = to < rows.length ? all.indexOf(rows[to]) : all.indexOf(rows[rows.length - 1]) + 1;
    s.orderLayers(moveTo(all, f, tt).map((l) => l.id).reverse());
  };
  const { register, handleProps, dragIdx, overIdx } = useReorder(rows.length, move, { tapSafe: true, within: listRef });

  // ★만화 캔버스는 묶음으로 보인다 — 페이지 › 말풍선 · 효과음 · 컷(그 컷에 든 그림이 아래로 들여 쓰인다) · 그 밖 (설계 4번 · 목업 v2).
  //   차례는 스토어가 묶음대로 맞춰 두므로(`comicStack`) 줄 사이에 머리만 끼우면 된다. 보통 레이어는 제가 든 묶음에 보인다 (`comicTiers`)
  const view = (l: Layer) => (doc.comic ? pageView(doc, pageOf(l)) : doc);
  const GROUP_OF = { bubble: "bubble", sfx: "sfx", panel: "panel", base: "other" } as const satisfies Record<Tier, string>;
  const GROUP_KEY = { bubble: "editor.groupBubbles", sfx: "editor.groupSfx", panel: "editor.groupPanels", other: "editor.groupOther" } as const;
  const tiersOf = new Map<string, Map<string, Tier>>();
  const groupOf = (l: Layer) => {
    const pid = pageOf(l);
    if (!tiersOf.has(pid)) tiersOf.set(pid, comicTiers(view(l).layers));
    return GROUP_OF[tiersOf.get(pid)!.get(l.id) ?? "base"];
  };
  const numsOf = (l: Layer) => (doc.comic ? panelNumbers(view(l).layers, doc.comic.dir, doc.h) : null);
  const head = (g: "bubble" | "sfx" | "panel" | "other", l: Layer) => {
    const pl = view(l).layers;
    const n = g === "bubble" ? pl.filter((x) => x.bubble).length : g === "sfx" ? pl.filter((x) => x.sfx).length : g === "panel" ? pl.filter((x) => x.panel).length : pl.filter((x) => groupOf(x) === "other").length;
    return (
      <div data-editor-layer-group={g} style={{ display: "flex", alignItems: "center", gap: 6, padding: "4px var(--sp-2) 2px", paddingLeft: doc.comic ? 18 : undefined, fontSize: "var(--text-3xs)", color: "var(--ink-faint)", letterSpacing: ".02em" }}>
        {t(GROUP_KEY[g])}
        <span style={{ flex: 1 }} />
        {n}
      </div>
    );
  };
  const pageHead = (pid: string, i: number) => (
    <button
      key={`pg-${pid}`}
      data-editor-layer-page={i + 1}
      data-on={pid === cur ? "" : undefined}
      onMouseDown={dropFocus}
      onClick={() => setOpen((o) => ({ ...o, [pid]: !isOpen(pid) }))}
      style={{ display: "flex", alignItems: "center", gap: 6, width: "100%", padding: "5px var(--sp-2) 3px", fontSize: "var(--text-2xs)", fontWeight: "var(--w-semi)",
               color: pid === cur ? "var(--ink)" : "var(--ink-soft)", borderTop: i ? "1px solid var(--line)" : undefined, textAlign: "left" }}
    >
      <span style={{ display: "grid", color: "var(--ink-faint)" }}>{isOpen(pid) ? Icon.chevronDown12 : Icon.chevronRight12}</span>
      {pageLabel(i)}
      <span style={{ flex: 1 }} />
      <span style={{ fontWeight: "var(--w-normal)", color: "var(--ink-faint)", fontSize: "var(--text-3xs)" }}>{t("editor.layersN", { n: pageLayers(doc.layers, doc.comic!.pages, pid).length })}</span>
    </button>
  );
  let shown = -1;
  return (
    <div ref={listRef} data-editor-layers style={{ display: "flex", flexDirection: "column", maxHeight: doc.comic ? 460 : 220, overflowY: "auto" }}>
      {doc.comic
        ? doc.comic.pages.map((pid, pi) => (
          <Fragment key={pid}>
            {pageHead(pid, pi)}
            {isOpen(pid) && all.filter((l) => pageOf(l) === pid).map((l) => {
              shown++;
              const i = shown;
              const prev = rows[i - 1];
              const nums = numsOf(l);
              const newGroup = i === 0 || !prev || pageOf(prev) !== pid || groupOf(prev) !== groupOf(l);
              return (
                <Fragment key={l.id}>
                  {newGroup && head(groupOf(l), l)}
                  <DropLine on={dragIdx != null && overIdx === i} />
                  <LayerRow
                    no={l.panel ? nums?.get(l.id) : undefined}
                    sub={l.panel ? t("editor.panelImages", { n: doc.layers.filter((x) => x.clip === l.id && !x.draw).length }) : undefined}
                    indent={!!l.clip && !l.panel ? 2 : 1}
                    rowRef={register(i)}
                    l={l}
                    selected={doc.sel.includes(l.id)}
                    dim={dragIdx === i}
                    hp={handleProps(i)}
                    onSelect={(e) => (e.ctrlKey || e.metaKey ? s.toggleSelect(l.id) : s.selectLayer(l.id))}
                    onToggle={() => s.toggleLayer(l.id)}
                    onRename={(v) => s.renameLayer(l.id, v)}
                    tipOn={t(l.on ? "editor.layerHide" : "editor.layerShow")}
                  />
                </Fragment>
              );
            })}
          </Fragment>
        ))
        : rows.map((l, i) => (
          <Fragment key={l.id}>
            <DropLine on={dragIdx != null && overIdx === i} />
            <LayerRow
              rowRef={register(i)}
              l={l}
              selected={doc.sel.includes(l.id)}
              dim={dragIdx === i}
              hp={handleProps(i)}
              // ★Ctrl+클릭은 고른 것에 넣고 빼기, 그냥 누르면 그것 하나만 (사용자 지시 2026-09-22)
              onSelect={(e) => (e.ctrlKey || e.metaKey ? s.toggleSelect(l.id) : s.selectLayer(l.id))}
              onToggle={() => s.toggleLayer(l.id)}
              onRename={(v) => s.renameLayer(l.id, v)}
              tipOn={t(l.on ? "editor.layerHide" : "editor.layerShow")}
            />
          </Fragment>
        ))}
      <DropLine on={dragIdx != null && overIdx === rows.length} />
      {!all.length && <Hint>{t("editor.noLayers")}</Hint>}
    </div>
  );
}

/** 목록의 줄 차례 — 위가 앞(스토어 차례를 뒤집은 것). 만화 캔버스는 **한 페이지씩** 부르고, 컷 묶음만 **컷 번호 차례**로 보인다
 *  (컷의 쌓임 차례는 겹칠 때만 뜻이 있고, 목록에서 찾는 것은 번호다). 컷 위에 둔 레이어는 컷 묶음 맨 위에 온다.
 *  끌어 바꾸면 이 차례가 스토어로 간다 */
function listRows(doc: Doc): Layer[] {
  const rows = [...doc.layers].reverse();
  if (!doc.comic) return rows;
  const nums = panelNumbers(doc.layers, doc.comic.dir, doc.h);
  const tiers = comicTiers(doc.layers);
  const panels = rows.filter((l) => l.panel).sort((a, b) => (nums.get(a.id) ?? 0) - (nums.get(b.id) ?? 0));
  const inPanel = (l: Layer) => !l.panel && !l.bubble && !l.sfx && !!l.clip && panels.some((p) => p.id === l.clip);
  const freeIn = (g: Tier) => (l: Layer) => !l.panel && !inPanel(l) && tiers.get(l.id) === g;
  return [
    ...rows.filter((l) => tiers.get(l.id) === "bubble"),
    ...rows.filter((l) => tiers.get(l.id) === "sfx"),
    ...rows.filter(freeIn("panel")),
    ...panels.flatMap((p) => [p, ...rows.filter((l) => inPanel(l) && l.clip === p.id)]),
    ...rows.filter(freeIn("base")),
  ];
}

type Handle = ReturnType<ReturnType<typeof useReorder>["handleProps"]>;

function LayerRow({
  l, selected, dim, hp, rowRef, onSelect, onToggle, onRename, tipOn, no, indent, sub,
}: {
  l: Layer;
  /** 컷 번호 (읽는 차례) — 컷 줄에만 */
  no?: number;
  /** 들여 쓰는 단 — 만화 캔버스는 페이지 아래(1), 컷에 든 그림은 그 컷 아래(2) */
  indent?: number;
  /** 컷 줄의 덧말 (「그림 N」) */
  sub?: string;
  selected: boolean;
  /** 끌리는 중 — 제자리에서 흐려진다 */
  dim?: boolean;
  /** 끌기 손잡이(`useReorder.handleProps`) */
  hp: Handle;
  rowRef: (el: HTMLElement | null) => void;
  onSelect: (e: React.PointerEvent) => void;
  onToggle: () => void;
  onRename: (v: string) => void;
  tipOn: string;
}) {
  const tPanel = (n?: number) => useI18n.getState().t("editor.panelNo", { n: n ?? "" });
  return (
    <div
      ref={rowRef}
      data-editor-layer={l.id}
      data-on={selected ? "" : undefined}
      data-text={l.text ? "" : undefined}
      {...hp}
      onPointerDown={(e) => {
        if ((e.target as HTMLElement).closest("button, input")) return;
        onSelect(e);
        hp.onPointerDown(e);
      }}
      style={{
        ...hp.style,
        display: "flex",
        alignItems: "center",
        gap: "var(--sp-2)",
        padding: "3px var(--sp-2)",
        paddingLeft: indent ? 8 + indent * 12 : undefined,
        margin: "1px 0",
        borderRadius: "var(--r-2)",
        border: `1px solid ${selected ? "var(--accent)" : "transparent"}`,
        background: selected ? "var(--accent-bg)" : "var(--bg)",
        opacity: dim ? 0.35 : l.on ? 1 : 0.55,
      }}
    >
      <button data-editor-layer-toggle onClick={onToggle} data-tip={tipOn} style={{ display: "grid", color: l.on ? "var(--ink-soft)" : "var(--ink-ghost)" }}>
        {l.on ? Icon.dotOn : Icon.dotOff}
      </button>
      {/* 컷은 번호, 말풍선은 종류 아이콘, 나머지는 그림 썸네일 */}
      {l.panel ? (
        <span data-editor-layer-no={no} style={{ width: 18, height: 18, borderRadius: "50%", background: "var(--line)", color: "var(--ink-soft)", fontSize: 10, display: "grid", placeItems: "center", fontVariantNumeric: "tabular-nums", flexShrink: 0 }}>{no}</span>
      ) : l.bubble ? (
        <span style={{ width: 44, height: 30, borderRadius: 3, flexShrink: 0, background: "#fff", display: "grid", placeItems: "center", color: "#111" }}>
          <BubbleKindIcon kind={l.bubble.kind} w={30} h={20} />
        </span>
      ) : (
        <img
          src={thumbOf(l.cv)}
          alt=""
          draggable={false}
          style={{ width: 44, height: 30, borderRadius: 3, flexShrink: 0, background: "conic-gradient(#3a3a44 25%, #2a2a32 0 50%, #3a3a44 0 75%, #2a2a32 0) 0 0/8px 8px" }}
        />
      )}
      {/* 글자 레이어 표식 — 원문에서 굽는 레이어라는 것이 목록에서 보인다 */}
      {l.text && <span style={{ display: "grid", color: "var(--ink-faint)", flexShrink: 0 }}>{Icon.typeT12}</span>}
      {/* 컷의 이름은 읽는 차례 번호다 (고칠 이름이 아니다) */}
      {l.panel ? (
        <span style={{ flex: 1, minWidth: 0, fontSize: "var(--text-2xs)", color: "var(--ink)" }}>
          {tPanel(no)}<small style={{ marginLeft: 6, color: "var(--ink-faint)" }}>{sub}</small>
        </span>
      ) : (
        <EditableName name={l.name} onRename={onRename} mark="editor-layer" style={{ flex: 1, minWidth: 0, fontSize: "var(--text-2xs)" }} />
      )}
    </div>
  );
}

/** 숫자 칸 — 적고 Enter·밖을 누르면 한 번에 반영 (매 글자마다 이력을 적지 않는다) */
function NumIn({ value, onCommit, min, mark, suffix }: { value: number; onCommit: (v: number) => void; min?: number; mark: string; suffix?: string }) {
  const [text, setText] = useState(String(value));
  const [edit, setEdit] = useState(false);
  useEffect(() => {
    if (!edit) setText(String(value));
  }, [value, edit]);
  const commit = () => {
    setEdit(false);
    const v = Number(text);
    if (!Number.isFinite(v)) return setText(String(value));
    const next = min !== undefined ? Math.max(min, Math.round(v)) : Math.round(v);
    if (next !== value) onCommit(next);
  };
  return (
    <span style={{ position: "relative", display: "inline-flex", alignItems: "center" }}>
      <input
        data-num={mark}
        value={text}
        onFocus={() => setEdit(true)}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.currentTarget as HTMLInputElement).blur();
          if (e.key === "Escape") { setText(String(value)); setEdit(false); (e.currentTarget as HTMLInputElement).blur(); }
        }}
        style={{ ...box, width: 62, textAlign: "right", fontVariantNumeric: "tabular-nums", padding: "2px 6px", paddingRight: suffix ? 16 : 6 }}
      />
      {suffix && <span style={{ position: "absolute", right: 6, fontSize: "var(--text-3xs)", color: "var(--ink-ghost)", pointerEvents: "none" }}>{suffix}</span>}
    </span>
  );
}

function IconBtn({ children, tip, onClick, disabled, danger, mark }: { children: React.ReactNode; tip: string; onClick: () => void; disabled?: boolean; danger?: boolean; mark: string }) {
  return (
    <button
      data-act={mark}
      onClick={onClick}
      disabled={disabled}
      data-tip={tip}
      style={{ ...box, display: "grid", placeItems: "center", padding: "4px 8px", color: disabled ? "var(--ink-ghost)" : danger ? "var(--err-ink)" : "var(--ink-soft)" }}
    >
      {children}
    </button>
  );
}

/** 만화 캔버스의 기둥 칸 — 고른 것에 따라 하나가 선다.
 *  컷: 테두리 없음 · 그림 수 (컷 생성은 왼쪽 패널의 컷 편집). 말풍선: 꼬리(개수 · 추가 · 밑동 폭 · 휨) · 글(여백 · 줄 간격). 그림: 든 컷 (넣기 · 빼기, 같은 페이지의 컷) */
function ComicSections({ doc, sel }: { doc: Doc; sel: Layer }) {
  const t = useI18n((s) => s.t);
  const s = useEditor();
  const pv = doc.comic ? pageView(doc, pageOfLayer(sel, doc.comic.pages)) : doc;
  const nums = panelNumbers(pv.layers, doc.comic!.dir, doc.h);
  const panels = pv.layers.filter((l) => l.panel);

  if (sel.panel) {
    const kids = doc.layers.filter((l) => l.clip === sel.id && !l.draw).length;
    return (
      <Sec label={`${t("editor.panelNo", { n: nums.get(sel.id) ?? "" })} · ${t("editor.panelImages", { n: kids })}`}>
        <Line label={t("editor.border")}>
          <button
            data-editor-panel-noborder
            onMouseDown={dropFocus}
            onClick={() => s.setPanelBorder(sel.id, !sel.panel!.noBorder)}
            style={{ ...box, ...(sel.panel.noBorder ? on : {}), padding: "2px 10px" }}
          >
            {t("editor.noBorder")}
          </button>
        </Line>
      </Sec>
    );
  }

  if (sel.bubble) {
    const b = sel.bubble;
    const tails = hasTails(b.kind) ? b.tails : [];
    const first = tails[0];
    const patch = (p: Partial<BubbleMeta>, live = false) => s.patchBubble(sel.id, p, live);
    return (
      <>
        {hasTails(b.kind) && (
          <Sec label={`${t("editor.tails")} · ${t("editor.tailsN", { n: tails.length })}`} help={t("editor.tailsHint")}>
            <div style={{ display: "flex", gap: "var(--sp-2)" }}>
              <button
                data-editor-tail-add
                onMouseDown={dropFocus}
                onClick={() => {
                  // 하나 더 — 있던 꼬리의 반대쪽 (두 사람이 같이 말할 때)
                  const base = defaultTail(b.body, doc.comic!.dir === "rtl" ? (tails.length % 2 ? "rtl" : "ltr") : tails.length % 2 ? "ltr" : "rtl", b.size);
                  patch({ tails: [...b.tails, base] });
                }}
                style={{ ...box, display: "inline-flex", alignItems: "center", gap: 4, padding: "2px 8px" }}
              >
                {Icon.tailAdd}{t("editor.tailAdd")}
              </button>
              {tails.length > 0 && (
                <button data-editor-tail-clear onMouseDown={dropFocus} onClick={() => patch({ tails: [] })} style={{ ...box, padding: "2px 8px" }}>
                  {t("editor.tailClear")}
                </button>
              )}
            </div>
            {first && bendable(b.kind) && (
              <>
                <Line label={t("editor.tailWidth")}>
                  <input
                    type="range"
                    data-editor-tail-width
                    min={4}
                    max={Math.max(60, Math.round(b.size * 2))}
                    value={Math.round(first.w)}
                    onPointerDown={() => s.markBefore()}
                    onChange={(e) => patch({ tails: b.tails.map((q) => ({ ...q, w: Number(e.target.value) })) }, true)}
                    style={{ flex: 1 }}
                  />
                  <span style={num}>{Math.round(first.w)}</span>
                </Line>
                <Line label={t("editor.tailBend")}>
                  <input
                    type="range"
                    data-editor-tail-bend
                    min={-Math.round(b.size * 3)}
                    max={Math.round(b.size * 3)}
                    value={Math.round(first.bend)}
                    onPointerDown={() => s.markBefore()}
                    onChange={(e) => patch({ tails: b.tails.map((q, i) => (i === 0 ? { ...q, bend: Number(e.target.value) } : q)) }, true)}
                    style={{ flex: 1 }}
                  />
                  <span style={num}>{Math.round(first.bend)}</span>
                </Line>
              </>
            )}
          </Sec>
        )}
        <Sec label={t("editor.bubbleText")}>
          <Line label={t("editor.pad")}>
            <input type="range" data-editor-bubble-pad min={0} max={Math.round(b.size * 2)} value={Math.round(b.pad)} onPointerDown={() => s.markBefore()} onChange={(e) => patch({ pad: Number(e.target.value) }, true)} style={{ flex: 1 }} />
            <span style={num}>{Math.round(b.pad)}</span>
          </Line>
          <Line label={t("editor.lineGap")}>
            <input type="range" data-editor-bubble-linegap min={90} max={200} value={Math.round(b.lineGap * 100)} onPointerDown={() => s.markBefore()} onChange={(e) => patch({ lineGap: Number(e.target.value) / 100 }, true)} style={{ flex: 1 }} />
            <span style={num}>{b.lineGap.toFixed(2)}</span>
          </Line>
        </Sec>
      </>
    );
  }

  // 그림 — 어느 컷에 들었나 (넣으면 그 컷을 가득 채우게 놓인다). 같은 페이지의 컷만
  if (!sel.text && !sel.sfx && panels.length) {
    const inside = panels.find((p) => pointInPoly({ x: sel.x + sel.w / 2, y: sel.y + sel.h / 2 }, panelPts(p, p.panel!.pts)));
    const ordered = [...panels].sort((a, b) => (nums.get(a.id) ?? 0) - (nums.get(b.id) ?? 0));
    return (
      <Sec label={t("editor.inPanel")} help={t("editor.inPanelHint")}>
        <select
          data-editor-clip
          value={sel.clip ?? ""}
          onChange={(e) => s.setClip(sel.id, e.target.value || null)}
          style={{ ...box, width: "100%" }}
        >
          <option value="">{t("editor.inPanelNone")}</option>
          {ordered.map((p) => (
            <option key={p.id} value={p.id}>
              {t("editor.panelNo", { n: nums.get(p.id) ?? "" })}{p.id === inside?.id && !sel.clip ? ` · ${t("editor.inPanelHere")}` : ""}
            </option>
          ))}
        </select>
      </Sec>
    );
  }
  return null;
}

/** 만화 글꼴 상태 — 받는 중이면 진행, 못 받았으면 이유와 다시 받기 (다 받았으면 아무것도 안 그린다, 설계 9-3). 「페이지」 메뉴에 선다 */
export function ComicFontStatus() {
  const t = useI18n((s) => s.t);
  const st = useComicFonts((s) => s.status);
  if (!st || (st.ready && !st.downloading)) return null;
  if (st.downloading) {
    const pct = st.total ? Math.round((st.got / st.total) * 100) : 0;
    return <span data-editor-fonts-state="downloading"><Hint>{t("editor.fontsDownloading", { p: pct })}</Hint></span>;
  }
  if (!st.error) return null;
  return (
    <div data-editor-fonts-state="error" style={{ display: "flex", alignItems: "center", gap: "var(--sp-2)" }}>
      <span data-tip={st.error} style={{ flex: 1, minWidth: 0, fontSize: "var(--text-2xs)", color: "var(--ink-faint)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {t("editor.fontsFailed")}
      </span>
      <button data-editor-fonts-retry onMouseDown={dropFocus} onClick={() => void retryComicFonts()} style={{ ...box, padding: "1px 8px" }}>{t("editor.fontsRetry")}</button>
    </div>
  );
}
