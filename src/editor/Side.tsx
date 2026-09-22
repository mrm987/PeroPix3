import { useEffect, useRef, useState } from "react";
import { useI18n } from "../i18n";
import { Icon } from "../components/Icon";
import { EditableName } from "../components/EditableName";
import { api } from "../lib/backend";
import { toast } from "../store/toast";
import { useUi } from "../store/ui";
import { Hint, Line, Sec, box, dropFocus, num, on } from "../panels/censor/ui";
import { withRatio } from "./model";
import { thumbOf, type Layer } from "./pixels";
import { saveName, useEditor, type Doc } from "./store";
import { CanvasSizeDialog, ImageSizeDialog } from "./dialogs";

/** 오른쪽 기둥 — 레이어 · 변형 · 보정 · 캔버스 · 저장 위치. 검열의 오른쪽 기둥과 같은 조각(`Sec`·`Line`·`box`)으로 그린다 */
export function Side({ doc }: { doc: Doc }) {
  const t = useI18n((s) => s.t);
  const s = useEditor();
  const sel = doc.layers.find((l) => l.id === doc.sel) ?? null;
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
  const noHome = !doc.src;
  const mode = noHome ? "folder" : editLast.mode;
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

        {/* ── 보정 ── */}
        <div style={{ display: "flex", flexDirection: "column", gap: "var(--sp-2)" }}>
          <span style={{ display: "flex", alignItems: "center", gap: "var(--sp-2)", fontSize: "var(--text-xs)", fontWeight: "var(--w-semi)", color: "var(--ink-soft)" }}>
            {t("editor.adjust")}
            <span style={{ flex: 1 }} />
            <button data-editor-adjust-apply disabled={!sel || !hasAdjust(s.adjust)} onClick={() => s.applyAdjust()} style={{ ...box, padding: "1px 8px", fontSize: "var(--text-3xs)" }}>
              {t("editor.apply")}
            </button>
            <button data-editor-adjust-reset disabled={!hasAdjust(s.adjust)} onClick={() => s.resetAdjust()} style={{ ...box, padding: "1px 8px", fontSize: "var(--text-3xs)", color: "var(--ink-faint)" }}>
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
                value={s.adjust[key]}
                disabled={!sel}
                onChange={(e) => s.setAdjust({ [key]: Number(e.target.value) })}
                style={{ flex: 1 }}
              />
              <span style={num}>{s.adjust[key]}</span>
            </Line>
          ))}
          {!!sel && <Hint>{t("editor.adjustHint")}</Hint>}
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
            onChange={(e) => setEditLast({ mode: e.target.value as "overwrite" | "sub" | "folder" })}
            style={{ ...box, width: "100%" }}
          >
            <option value="overwrite" disabled={noHome}>{t("tools.destOverwrite")}</option>
            <option value="sub" disabled={noHome}>{t("tools.destSub")}</option>
            <option value="folder">{t("tools.destFolder")}</option>
          </select>
          {mode === "overwrite" && <Hint>{t("tools.destOverwriteHint")}</Hint>}
          {needDest && (
            <button data-editor-dest-pick onClick={() => void pick()} style={{ ...box, width: "100%", textAlign: "left", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {editLast.dest || t("tools.destPick")}
            </button>
          )}
          {needDest && !editLast.dest && <Hint>{noHome ? t("editor.needDestNew") : t("tools.needDest")}</Hint>}
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

const hasAdjust = (a: { bri: number; con: number; sat: number; hue: number }) => !!(a.bri || a.con || a.sat || a.hue);

/** 레이어 목록 — **위가 앞**이다 (스토어는 아래가 먼저). 끌어서 차례를 바꾼다 */
function LayerList({ doc }: { doc: Doc }) {
  const t = useI18n((s) => s.t);
  const s = useEditor();
  const rows = [...doc.layers].reverse();
  const listRef = useRef<HTMLDivElement | null>(null);
  const drag = useRef<{ id: string; y0: number; moved: boolean } | null>(null);
  const [ghost, setGhost] = useState<{ id: string; over: number } | null>(null);

  const indexAt = (clientY: number) => {
    const els = [...(listRef.current?.querySelectorAll<HTMLElement>("[data-editor-layer]") ?? [])];
    for (let i = 0; i < els.length; i++) {
      const r = els[i].getBoundingClientRect();
      if (clientY < r.top + r.height / 2) return i;
    }
    return els.length - 1;
  };

  useEffect(() => {
    const move = (e: PointerEvent) => {
      const d = drag.current;
      if (!d) return;
      if (!d.moved && Math.abs(e.clientY - d.y0) < 5) return;
      d.moved = true;
      setGhost({ id: d.id, over: indexAt(e.clientY) });
    };
    const up = (e: PointerEvent) => {
      const d = drag.current;
      drag.current = null;
      if (!d) return;
      if (d.moved) {
        const over = indexAt(e.clientY);          // 화면 차례 (위가 0)
        const to = doc.layers.length - 1 - over;  // 스토어 차례로
        s.moveLayer(d.id, to);
      }
      setGhost(null);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
  }, [doc.layers.length, s]);

  return (
    <div ref={listRef} data-editor-layers style={{ display: "flex", flexDirection: "column", gap: 2, maxHeight: 220, overflowY: "auto" }}>
      {rows.map((l, i) => (
        <LayerRow
          key={l.id}
          l={l}
          selected={l.id === doc.sel}
          over={ghost?.over === i && ghost.id !== l.id}
          onSelect={() => s.selectLayer(l.id)}
          onToggle={() => s.toggleLayer(l.id)}
          onRename={(v) => s.renameLayer(l.id, v)}
          onGrab={(e) => {
            drag.current = { id: l.id, y0: e.clientY, moved: false };
          }}
          tipOn={t(l.on ? "editor.layerHide" : "editor.layerShow")}
        />
      ))}
      {!rows.length && <Hint>{t("editor.noLayers")}</Hint>}
    </div>
  );
}

function LayerRow({
  l, selected, over, onSelect, onToggle, onRename, onGrab, tipOn,
}: {
  l: Layer; selected: boolean; over: boolean; onSelect: () => void; onToggle: () => void; onRename: (v: string) => void;
  onGrab: (e: React.PointerEvent) => void; tipOn: string;
}) {
  return (
    <div
      data-editor-layer={l.id}
      data-on={selected ? "" : undefined}
      onPointerDown={(e) => {
        if ((e.target as HTMLElement).closest("button, input")) return;
        onSelect();
        onGrab(e);
      }}
      style={{
        display: "flex",
        alignItems: "center",
        gap: "var(--sp-2)",
        padding: "3px var(--sp-2)",
        borderRadius: "var(--r-2)",
        border: `1px solid ${selected ? "var(--accent)" : "transparent"}`,
        background: selected ? "var(--accent-bg)" : "var(--bg)",
        boxShadow: over ? "0 -2px 0 0 var(--accent)" : undefined,
        opacity: l.on ? 1 : 0.55,
        cursor: "grab",
        userSelect: "none",
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
