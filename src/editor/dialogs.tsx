import { useEffect, useState } from "react";
import { useI18n } from "../i18n";
import { box, on } from "../panels/censor/ui";
import { withRatio, type Anchor } from "./model";
import { useEditor, type Doc } from "./store";

/** 캔버스 크기 — 기준점을 고르면 그쪽은 붙어 있고 반대쪽이 늘거나 줄어든다. 넓힌 자리는 비어 있다 (인페인트로 보낸다) */
export function CanvasSizeDialog({ doc, onClose }: { doc: Doc; onClose: () => void }) {
  const t = useI18n((s) => s.t);
  const [w, setW] = useState(doc.w);
  const [h, setH] = useState(doc.h);
  const [a, setA] = useState<Anchor>({ ax: 0.5, ay: 0.5 });
  const ok = () => {
    if (w >= 1 && h >= 1) useEditor.getState().setCanvasSize(Math.round(w), Math.round(h), a);
    onClose();
  };
  return (
    <Modal title={t("editor.canvasSizeTitle")} onOk={ok} onClose={onClose} mark="editor-canvas-dialog">
      <SizeRow w={w} h={h} setW={setW} setH={setH} lock={false} />
      <div style={{ display: "flex", alignItems: "center", gap: "var(--sp-3)" }}>
        <span style={{ fontSize: "var(--text-2xs)", color: "var(--ink-faint)", width: 52 }}>{t("editor.anchor")}</span>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 26px)", gap: 3 }}>
          {([0, 0.5, 1] as const).map((ay) =>
            ([0, 0.5, 1] as const).map((ax) => (
              <button
                key={`${ax}-${ay}`}
                data-editor-anchor={`${ax},${ay}`}
                onClick={() => setA({ ax, ay })}
                style={{ ...box, ...(a.ax === ax && a.ay === ay ? on : {}), width: 26, height: 26, padding: 0 }}
              />
            )),
          )}
        </div>
        <span style={{ fontSize: "var(--text-2xs)", color: "var(--ink-faint)" }}>{t("editor.anchorHint")}</span>
      </div>
    </Modal>
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
      <SizeRow
        w={w}
        h={h}
        setW={(v) => { setW(v); if (lock) setH(withRatio(doc.w, doc.h, v)); }}
        setH={(v) => { setH(v); if (lock) setW(withRatio(doc.h, doc.w, v)); }}
        lock={lock}
        setLock={setLock}
      />
      <span style={{ fontSize: "var(--text-2xs)", color: "var(--ink-faint)" }}>{t("editor.imageSizeHint")}</span>
    </Modal>
  );
}

function SizeRow({ w, h, setW, setH, lock, setLock }: { w: number; h: number; setW: (v: number) => void; setH: (v: number) => void; lock: boolean; setLock?: (v: boolean) => void }) {
  const t = useI18n((s) => s.t);
  const inp = (v: number, set: (v: number) => void, mark: string) => (
    <input
      data-num={mark}
      type="number"
      min={1}
      value={v}
      onChange={(e) => set(Math.max(1, Math.round(Number(e.target.value) || 1)))}
      style={{ ...box, width: 84, textAlign: "right", fontVariantNumeric: "tabular-nums" }}
    />
  );
  return (
    <div style={{ display: "flex", alignItems: "center", gap: "var(--sp-2)" }}>
      <span style={{ fontSize: "var(--text-2xs)", color: "var(--ink-faint)", width: 52 }}>{t("editor.dims")}</span>
      {inp(w, setW, "editor-dlg-w")}
      <span style={{ color: "var(--ink-ghost)" }}>×</span>
      {inp(h, setH, "editor-dlg-h")}
      {setLock && (
        <button data-editor-dlg-lock onClick={() => setLock(!lock)} style={{ ...box, ...(lock ? on : {}), padding: "2px 8px", marginLeft: "auto" }}>
          {t("editor.ratio")}
        </button>
      )}
    </div>
  );
}

/** 작은 창 — 확인 창(`AskDialog`)과 같은 뼈대. Esc 취소 · Enter 적용 */
function Modal({ title, children, onOk, onClose, mark }: { title: string; children: React.ReactNode; onOk: () => void; onClose: () => void; mark: string }) {
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
      <div style={{ background: "var(--bg)", border: "1px solid var(--line)", borderRadius: "var(--r-4)", padding: "var(--sp-5)", width: "min(380px, 92vw)", display: "flex", flexDirection: "column", gap: "var(--sp-4)" }}>
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
