import { useEffect, useRef, useState } from "react";
import { useI18n } from "../i18n";
import { Icon } from "../components/Icon";
import { Line, box, dropFocus, on } from "../panels/censor/ui";
import { sizePreview, withRatio, type Anchor, type Fill, type Size } from "./model";
import { composite } from "./pixels";
import { useEditor, type Doc } from "./store";

/** 캔버스 크기 — 목업 ③ 그대로 (사용자 지적 2026-09-22: 생김새가 목업과 많이 달랐다).
 *  왼쪽에 폭·높이(지금 값이 오른쪽에 흐리게) · 빈 자리 · 기준점(3×3 화살표), 오른쪽에 미리보기.
 *  기준점 쪽은 붙어 있고 반대쪽이 늘거나 준다. 넓힌 자리는 「빈 자리」대로 — 투명이면 비워 두고(인페인트로 보낸다),
 *  색이면 그 자리만 칠한 레이어를 맨 아래에 깐다 (`setCanvasSize`). */
export function CanvasSizeDialog({ doc, onClose }: { doc: Doc; onClose: () => void }) {
  const t = useI18n((s) => s.t);
  const [w, setW] = useState(doc.w);
  const [h, setH] = useState(doc.h);
  const [a, setA] = useState<Anchor>({ ax: 0.5, ay: 0.5 });
  const [fill, setFill] = useState<Fill>("transparent");
  /** 비율 유지 (사용자 지시 2026-09-22) — 이미지 크기 창과 같은 단추. ★기본은 꺼짐: 캔버스는 한쪽만 늘리는 일이 잦다 (이미지 크기는 켜짐) */
  const [lock, setLock] = useState(false);
  const ok = () => {
    if (w >= 1 && h >= 1) useEditor.getState().setCanvasSize(Math.round(w), Math.round(h), a, fill);
    onClose();
  };
  return (
    <Modal title={t("editor.canvasSizeTitle")} onOk={ok} onClose={onClose} mark="editor-canvas-dialog" width={460}>
      <div style={{ display: "flex", gap: "var(--sp-6)" }}>
        <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: "var(--sp-2)" }}>
          <Line label={t("editor.width")}>
            <NumField mark="editor-dlg-w" value={w} onChange={(v) => { setW(v); if (lock) setH(withRatio(doc.w, doc.h, v)); }} />
            <span style={unit}>px</span>
            <span data-editor-dlg-was-w style={was}>{doc.w}</span>
          </Line>
          <Line label={t("editor.height")}>
            <NumField mark="editor-dlg-h" value={h} onChange={(v) => { setH(v); if (lock) setW(withRatio(doc.h, doc.w, v)); }} />
            <span style={unit}>px</span>
            <span data-editor-dlg-was-h style={was}>{doc.h}</span>
          </Line>
          <div style={{ display: "flex", justifyContent: "flex-end" }}>
            <button data-editor-dlg-lock onMouseDown={dropFocus} onClick={() => setLock(!lock)} style={{ ...box, ...(lock ? on : {}), padding: "2px 8px" }}>
              {t("editor.ratio")}
            </button>
          </div>
          <Line label={t("editor.fill")}>
            <select data-editor-fill value={fill} onChange={(e) => setFill(e.target.value as Fill)} style={{ ...box, flex: 1, minWidth: 0 }}>
              <option value="transparent">{t("editor.fillNone")}</option>
              <option value="white">{t("editor.fillWhite")}</option>
              <option value="black">{t("editor.fillBlack")}</option>
            </select>
          </Line>
          <Line label={t("editor.anchor")} help={t("editor.anchorHint")}>
            <AnchorGrid a={a} setA={setA} />
          </Line>
        </div>
        <SizePreview doc={doc} to={{ w, h }} a={a} />
      </div>
    </Modal>
  );
}

const unit: React.CSSProperties = { fontSize: "var(--text-2xs)", color: "var(--ink-faint)" };
/** 지금 값 — 줄 오른쪽 끝에 흐리게 */
const was: React.CSSProperties = { marginLeft: "auto", fontSize: "var(--text-2xs)", color: "var(--ink-ghost)", fontVariantNumeric: "tabular-nums" };

const AXES = [0, 0.5, 1] as const;

/** 기준점 3×3 — 고른 칸은 점, 나머지 칸은 **고른 칸에서 그쪽으로** 향하는 화살표 (그쪽으로 늘거나 준다는 뜻) */
function AnchorGrid({ a, setA }: { a: Anchor; setA: (a: Anchor) => void }) {
  return (
    <div data-editor-anchors style={{ display: "grid", gridTemplateColumns: "repeat(3, 26px)", gap: 3 }}>
      {AXES.map((ay) =>
        AXES.map((ax) => {
          const me = a.ax === ax && a.ay === ay;
          const deg = me ? 0 : (Math.atan2(ay - a.ay, ax - a.ax) * 180) / Math.PI + 90;
          return (
            <button
              key={`${ax}-${ay}`}
              data-editor-anchor={`${ax},${ay}`}
              onMouseDown={dropFocus}
              onClick={() => setA({ ax, ay })}
              style={{ ...box, ...(me ? on : {}), width: 26, height: 26, padding: 0, display: "grid", placeItems: "center", color: me ? "var(--accent-ink)" : "var(--ink-ghost)" }}
            >
              {me
                ? <span style={{ width: 5, height: 5, borderRadius: "50%", background: "currentColor" }} />
                : <span style={{ display: "grid", transform: `rotate(${deg}deg)` }}>{Icon.arrowUp12}</span>}
            </button>
          );
        }),
      )}
    </div>
  );
}

const PREV: Size = { w: 210, h: 118 };
const CHECKER = "conic-gradient(#2a2a32 25%, #222229 0 50%, #2a2a32 0 75%, #222229 0) 0 0/10px 10px";

/** 미리보기 — 새 캔버스(점선·체커) 위에 지금 캔버스(합성 그림)를 기준점대로 놓아 보인다. 오른쪽 위는 늘거나 주는 양 */
function SizePreview({ doc, to, a }: { doc: Doc; to: Size; a: Anchor }) {
  const p = sizePreview(doc, to, a, PREV);
  const cvRef = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    const cv = cvRef.current;
    if (cv) composite(doc, cv, p.k * Math.min(2, window.devicePixelRatio || 1));
  }, [doc, p.k]);
  const delta = (n: number) => (n > 0 ? `+${n}` : `${n}`);
  return (
    <div
      data-editor-size-preview
      style={{ position: "relative", width: PREV.w, height: PREV.h, flexShrink: 0, border: "1px solid var(--line)", borderRadius: 3, background: "var(--bg)", overflow: "hidden" }}
    >
      <div style={{ position: "absolute", left: p.next.x, top: p.next.y, width: p.next.w, height: p.next.h, boxSizing: "border-box", border: "1px dashed var(--ink-ghost)", background: CHECKER }} />
      <canvas ref={cvRef} style={{ position: "absolute", left: p.cur.x, top: p.cur.y, width: p.cur.w, height: p.cur.h, outline: "1px solid var(--accent-ink)" }} />
      <span data-editor-size-delta style={{ position: "absolute", right: 6, top: 4, fontSize: 10, color: "var(--ink-faint)", fontVariantNumeric: "tabular-nums" }}>
        {delta(to.w - doc.w)} × {delta(to.h - doc.h)}
      </span>
    </div>
  );
}

/** 이미지 크기 — 문서와 레이어 전부를 같은 비로 (원본 픽셀은 그대로 두고 변형만 바꾼다) */
export function ImageSizeDialog({ doc, onClose }: { doc: Doc; onClose: () => void }) {
  const t = useI18n((s) => s.t);
  const [w, setW] = useState(doc.w);
  const [h, setH] = useState(doc.h);
  const [lock, setLock] = useState(true);
  const ok = () => {
    if (w >= 1 && h >= 1) useEditor.getState().setImageSize(Math.round(w), Math.round(h));
    onClose();
  };
  return (
    <Modal title={t("editor.imageSizeTitle")} onOk={ok} onClose={onClose} mark="editor-image-dialog">
      <Line label={t("editor.dims")}>
        <NumField mark="editor-dlg-w" value={w} onChange={(v) => { setW(v); if (lock) setH(withRatio(doc.w, doc.h, v)); }} />
        <span style={{ color: "var(--ink-ghost)" }}>×</span>
        <NumField mark="editor-dlg-h" value={h} onChange={(v) => { setH(v); if (lock) setW(withRatio(doc.h, doc.w, v)); }} />
        <button data-editor-dlg-lock onMouseDown={dropFocus} onClick={() => setLock(!lock)} style={{ ...box, ...(lock ? on : {}), padding: "2px 8px", marginLeft: "auto" }}>
          {t("editor.ratio")}
        </button>
      </Line>
      <span style={{ fontSize: "var(--text-2xs)", color: "var(--ink-faint)" }}>{t("editor.imageSizeHint")}</span>
    </Modal>
  );
}

function NumField({ mark, value, onChange }: { mark: string; value: number; onChange: (v: number) => void }) {
  return (
    <input
      data-num={mark}
      type="number"
      min={1}
      value={value}
      onChange={(e) => onChange(Math.max(1, Math.round(Number(e.target.value) || 1)))}
      style={{ ...box, width: 72, textAlign: "right", fontVariantNumeric: "tabular-nums" }}
    />
  );
}

/** 작은 창 — 확인 창(`AskDialog`)과 같은 뼈대. Esc 취소 · Enter 적용 */
function Modal({ title, children, onOk, onClose, mark, width = 380 }: { title: string; children: React.ReactNode; onOk: () => void; onClose: () => void; mark: string; width?: number }) {
  const t = useI18n((s) => s.t);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.stopPropagation(); onClose(); }
      if (e.key === "Enter") { e.stopPropagation(); onOk(); }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onOk, onClose]);
  return (
    <div
      data-modal={mark}
      onPointerDown={(e) => e.target === e.currentTarget && onClose()}
      style={{ position: "fixed", inset: 0, zIndex: 90, background: "rgba(6,8,12,0.62)", display: "grid", placeItems: "center", padding: "var(--sp-6)" }}
    >
      <div style={{ background: "var(--bg)", border: "1px solid var(--line)", borderRadius: "var(--r-4)", padding: "var(--sp-5)", width: `min(${width}px, 92vw)`, display: "flex", flexDirection: "column", gap: "var(--sp-4)" }}>
        <b style={{ fontSize: "var(--text-md)" }}>{title}</b>
        {children}
        <div style={{ display: "flex", gap: "var(--sp-2)", justifyContent: "flex-end" }}>
          <button data-modal-cancel onClick={onClose} style={btn}>{t("common.cancel")}</button>
          <button data-modal-ok onClick={onOk} style={{ ...btn, background: "var(--accent)", borderColor: "var(--accent)", color: "#fff" }}>{t("editor.apply")}</button>
        </div>
      </div>
    </div>
  );
}

const btn: React.CSSProperties = {
  border: "1px solid var(--line)",
  borderRadius: "var(--r-2)",
  background: "var(--panel)",
  color: "var(--ink-soft)",
  padding: "var(--sp-2) var(--sp-5)",
  fontSize: "var(--text-xs)",
};
