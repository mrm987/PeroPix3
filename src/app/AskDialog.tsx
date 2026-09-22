import { useEffect } from "react";
import { useAsk } from "../store/ask";

/** 확인 창 — `store/ask.ts` 의 답을 화면으로 받는다.
 *  ★`Esc` = 취소, `Enter` = 확인. 손이 키보드에 있을 때 마우스로 옮기지 않게 한다. */
export function AskDialog() {
  const cur = useAsk((s) => s.cur);
  const answer = useAsk((s) => s.answer);

  useEffect(() => {
    if (!cur) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") answer(false);
      if (e.key === "Enter") answer(cur.options ? cur.options[0].key : true);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [cur, answer]);

  if (!cur) return null;
  return (
    <div
      data-ask
      onPointerDown={(e) => e.target === e.currentTarget && answer(false)}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 96,
        background: "rgba(6,8,12,0.62)",
        display: "grid",
        placeItems: "center",
        padding: "var(--sp-6)",
      }}
    >
      <div
        style={{
          background: "var(--bg)",
          border: "1px solid var(--line)",
          borderRadius: "var(--r-4)",
          padding: "var(--sp-5)",
          width: "min(400px, 92vw)",
          display: "flex",
          flexDirection: "column",
          gap: "var(--sp-4)",
        }}
      >
        <b style={{ fontSize: "var(--text-md)" }}>{cur.title}</b>
        {cur.body && (
          <span style={{ fontSize: "var(--text-2xs)", color: "var(--ink-faint)", lineHeight: 1.6 }}>
            {cur.body}
          </span>
        )}
        <div style={{ display: "flex", gap: "var(--sp-2)", justifyContent: "flex-end" }}>
          <button data-ask-cancel onClick={() => answer(false)} style={btn}>
            {cur.cancel}
          </button>
          {/* ★갈래 물음이면 단추가 갈래 수만큼 — 첫 것이 기본 (Enter) */}
          {cur.options
            ? cur.options.map((o, i) => (
                <button
                  key={o.key}
                  data-ask-pick={o.key}
                  autoFocus={i === 0}
                  onClick={() => answer(o.key)}
                  style={i === 0 ? { ...btn, background: "var(--accent)", borderColor: "var(--accent)", color: "#fff" } : btn}
                >
                  {o.label}
                </button>
              ))
            : (
              <button
                data-ask-ok
                autoFocus
                onClick={() => answer(true)}
                style={{
                  ...btn,
                  background: cur.danger ? "var(--err)" : "var(--accent)",
                  borderColor: cur.danger ? "var(--err)" : "var(--accent)",
                  color: "#fff",
                }}
              >
                {cur.ok}
              </button>
            )}
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
