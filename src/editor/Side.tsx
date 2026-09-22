import { Fragment, useEffect, useRef, useState } from "react";
import { useI18n } from "../i18n";
import { Icon } from "../components/Icon";
import { EditableName } from "../components/EditableName";
import { DropLine } from "../components/DropLine";
import { Help } from "../components/Tip";
import { api } from "../lib/backend";
import { moveTo } from "../lib/moveTo";
import { useReorder } from "../lib/useReorder";
import { toast } from "../store/toast";
import { useUi } from "../store/ui";
import { Hint, Line, Sec, box, dropFocus, num, on } from "../panels/censor/ui";
import { NO_ADJUST, hasAdjust, withRatio } from "./model";
import { thumbOf, type Layer } from "./pixels";
import { saveName, useEditor, whereOf, type Doc } from "./store";
import { CanvasSizeDialog, ImageSizeDialog } from "./dialogs";

/** 오른쪽 기둥 — 레이어 · 변형 · 보정 · 캔버스 · 저장 위치. 검열의 오른쪽 기둥과 같은 조각(`Sec`·`Line`·`box`)으로 그린다 */
export function Side({ doc }: { doc: Doc }) {
  const t = useI18n((s) => s.t);
  const s = useEditor();
  const sel = doc.layers.find((l) => l.id === doc.sel) ?? null;
  const adj = sel?.adj ?? NO_ADJUST;
  const [dlg, setDlg] = useState<"canvas" | "image" | null>(null);
  const editLast = useUi((st) => st.editLast);
  const setEditLast = useUi((st) => st.setEditLast);

  const pick = async () => {
    try {
      const r = await api<{ dir: string | null }>("/api/files/pick-dir", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ start: doc.src?.path ? doc.src.path.replace(/[\\/][^\\/]*$/, "") : "" }),
      });
      if (r.dir) setEditLast({ dest: r.dir });
    } catch (e) {
      toast(String(e), "warn");
    }
  };
  /** 원본 자리가 없는 문서 — 저장 자리 셈(`whereOf`)이 「저장 폴더 지정」으로 고정한다 */
  const noHome = !doc.src;
  const mode = whereOf(doc, editLast).mode;
  const needDest = mode === "folder";

  return (
    <div
      data-editor-side
      style={{ width: 280, flexShrink: 0, display: "flex", flexDirection: "column", gap: "var(--sp-4)", minHeight: 0 }}
    >
      <div style={{ flex: 1, minHeight: 0, overflowY: "auto", display: "flex", flexDirection: "column", gap: "var(--sp-5)", paddingRight: 2 }}>
        {/* ── 레이어 ── */}
        <Sec label={t("editor.layers")} help={t("editor.layersHint")}>
          <LayerList doc={doc} />
          <div style={{ display: "flex", gap: "var(--sp-2)" }}>
            <IconBtn mark="editor-layer-add" tip={t("editor.addLayer")} onClick={() => s.addLayer()}>{Icon.plus}</IconBtn>
            <IconBtn mark="editor-layer-dup" tip={t("editor.dupLayer")} disabled={!sel} onClick={() => s.dupLayer()}>{Icon.duplicate}</IconBtn>
            <IconBtn mark="editor-layer-merge" tip={t("editor.mergeDown")} disabled={!sel || doc.layers.findIndex((l) => l.id === sel.id) <= 0} onClick={() => s.mergeDown()}>{Icon.merge}</IconBtn>
            <span style={{ flex: 1 }} />
            <IconBtn mark="editor-layer-del" tip={t("editor.delLayer")} disabled={!sel} onClick={() => s.removeLayer()} danger>{Icon.trash}</IconBtn>
          </div>
        </Sec>

        {/* ── 변형 ── */}
        <Sec label={sel ? `${sel.name} · ${t("editor.transform")}` : t("editor.transform")}>
          {!sel && <Hint>{t("editor.noLayer")}</Hint>}
          {sel && (
            <>
              <Line label={t("editor.pos")}>
                <NumIn mark="editor-x" value={Math.round(sel.x)} onCommit={(v) => s.patchLayer(sel.id, { x: v })} />
                <span style={{ color: "var(--ink-ghost)" }}>×</span>
                <NumIn mark="editor-y" value={Math.round(sel.y)} onCommit={(v) => s.patchLayer(sel.id, { y: v })} />
              </Line>
              <Line label={t("editor.dims")}>
                <NumIn mark="editor-w" value={Math.round(sel.w)} min={1} onCommit={(v) => s.patchLayer(sel.id, s.ratioLock ? { w: v, h: withRatio(sel.w, sel.h, v) } : { w: v })} />
                <span style={{ color: "var(--ink-ghost)" }}>×</span>
                <NumIn mark="editor-h" value={Math.round(sel.h)} min={1} onCommit={(v) => s.patchLayer(sel.id, s.ratioLock ? { h: v, w: withRatio(sel.h, sel.w, v) } : { h: v })} />
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

        {/* ── 보정 — 레이어의 속성이라 슬라이더 값이 **언제나** 걸린다 (사용자 지시 2026-09-22: 「적용」 없음, 초기화만) ── */}
        <div style={{ display: "flex", flexDirection: "column", gap: "var(--sp-2)" }}>
          <span style={{ display: "flex", alignItems: "center", gap: "var(--sp-2)", fontSize: "var(--text-xs)", fontWeight: "var(--w-semi)", color: "var(--ink-soft)" }}>
            {t("editor.adjust")}
            <Help tip={t("editor.adjustHint")} />
            <span style={{ flex: 1 }} />
            <button data-editor-adjust-reset disabled={!sel || !hasAdjust(adj)} onClick={() => s.resetAdjust()} style={{ ...box, padding: "1px 8px", fontSize: "var(--text-3xs)", color: "var(--ink-faint)" }}>
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
                disabled={!sel}
                onPointerDown={() => s.markBefore()}
                onChange={(e) => s.setAdjust({ [key]: Number(e.target.value) }, true)}
                style={{ flex: 1 }}
              />
              <span style={num}>{adj[key]}</span>
            </Line>
          ))}
        </div>

        {/* ── 캔버스 ── */}
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
      </div>

      {/* ── 저장 (스크롤 밖, 맨 아래 고정) ── */}
      <div style={{ flexShrink: 0, display: "flex", flexDirection: "column", gap: "var(--sp-3)", borderTop: "1px solid var(--line)", paddingTop: "var(--sp-3)" }}>
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
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "var(--sp-2)" }}>
            {(["png", "webp"] as const).map((f) => (
              <button
                key={f}
                data-editor-fmt={f}
                onMouseDown={dropFocus}
                onClick={() => setEditLast({ fmt: f })}
                style={{ ...box, ...(editLast.fmt === f ? on : {}), padding: "3px 0", textAlign: "center", whiteSpace: "nowrap" }}
              >
                {f === "png" ? "PNG" : "WebP (Lossless)"}
              </button>
            ))}
          </div>
          <span data-editor-save-name style={{ fontSize: "var(--text-3xs)", color: "var(--ink-faint)", fontFamily: "var(--font-mono)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {saveName(doc, editLast.fmt)}
          </span>
        </Sec>
        <button
          data-editor-save
          disabled={s.busy}
          onClick={() => void s.save()}
          style={{
            width: "100%",
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
      </div>

      {dlg === "canvas" && <CanvasSizeDialog doc={doc} onClose={() => setDlg(null)} />}
      {dlg === "image" && <ImageSizeDialog doc={doc} onClose={() => setDlg(null)} />}
    </div>
  );
}

/** 레이어 목록 — **위가 앞**이다 (스토어는 아래가 먼저). 차례 바꾸기는 앱의 것 하나(`useReorder`)다 — 탭·블록과 같은 끌기라
 *  끼움선(`DropLine`)도 같은 부품이다 (사용자 지시 2026-09-22).
 *  ★잔상(`DragGhost`)은 **안 그린다** (사용자 지적 2026-09-22: 커서를 따라오는 줄이 놓일 자리를 가려 어디에 놓이는지 알 수 없었다).
 *    끌리는 줄은 제자리에서 흐려지고, 놓일 자리는 끼움선 하나로 말한다 (포토샵의 레이어 판과 같다).
 *  ★줄은 눌러서 고르는 자리이기도 해서 `tapSafe` 로 잡는다 — 문턱을 넘기 전에는 클릭(고르기)·더블클릭(이름 고치기)이 산다 */
function LayerList({ doc }: { doc: Doc }) {
  const t = useI18n((s) => s.t);
  const s = useEditor();
  const rows = [...doc.layers].reverse();
  const listRef = useRef<HTMLDivElement | null>(null);
  /** 화면 차례(위가 0)의 틈 번호로 받아 스토어 차례(아래가 먼저)로 넘긴다 — 셈은 앱 공통 `moveTo` */
  const move = (from: number, to: number) => s.orderLayers(moveTo(rows, from, to).map((l) => l.id).reverse());
  const { register, handleProps, dragIdx, overIdx } = useReorder(rows.length, move, { tapSafe: true, within: listRef });

  return (
    <div ref={listRef} data-editor-layers style={{ display: "flex", flexDirection: "column", maxHeight: 220, overflowY: "auto" }}>
      {rows.map((l, i) => (
        <Fragment key={l.id}>
          <DropLine on={dragIdx != null && overIdx === i} />
          <LayerRow
            rowRef={register(i)}
            l={l}
            selected={l.id === doc.sel}
            dim={dragIdx === i}
            hp={handleProps(i)}
            onSelect={() => s.selectLayer(l.id)}
            onToggle={() => s.toggleLayer(l.id)}
            onRename={(v) => s.renameLayer(l.id, v)}
            tipOn={t(l.on ? "editor.layerHide" : "editor.layerShow")}
          />
        </Fragment>
      ))}
      <DropLine on={dragIdx != null && overIdx === rows.length} />
      {!rows.length && <Hint>{t("editor.noLayers")}</Hint>}
    </div>
  );
}

type Handle = ReturnType<ReturnType<typeof useReorder>["handleProps"]>;

function LayerRow({
  l, selected, dim, hp, rowRef, onSelect, onToggle, onRename, tipOn,
}: {
  l: Layer;
  selected: boolean;
  /** 끌리는 중 — 제자리에서 흐려진다 */
  dim?: boolean;
  /** 끌기 손잡이(`useReorder.handleProps`) */
  hp: Handle;
  rowRef: (el: HTMLElement | null) => void;
  onSelect: () => void;
  onToggle: () => void;
  onRename: (v: string) => void;
  tipOn: string;
}) {
  return (
    <div
      ref={rowRef}
      data-editor-layer={l.id}
      data-on={selected ? "" : undefined}
      data-text={l.text ? "" : undefined}
      {...hp}
      onPointerDown={(e) => {
        if ((e.target as HTMLElement).closest("button, input")) return;
        onSelect();
        hp.onPointerDown(e);
      }}
      style={{
        ...hp.style,
        display: "flex",
        alignItems: "center",
        gap: "var(--sp-2)",
        padding: "3px var(--sp-2)",
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
      <img
        src={thumbOf(l.cv)}
        alt=""
        draggable={false}
        style={{ width: 44, height: 30, borderRadius: 3, flexShrink: 0, background: "conic-gradient(#3a3a44 25%, #2a2a32 0 50%, #3a3a44 0 75%, #2a2a32 0) 0 0/8px 8px" }}
      />
      {/* 글자 레이어 표식 — 붓이 안 먹는 이유가 목록에서 보인다 */}
      {l.text && <span style={{ display: "grid", color: "var(--ink-faint)", flexShrink: 0 }}>{Icon.typeT12}</span>}
      <EditableName name={l.name} onRename={onRename} mark="editor-layer" style={{ flex: 1, minWidth: 0, fontSize: "var(--text-2xs)" }} />
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
