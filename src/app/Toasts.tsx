import { useToast } from "../store/toast";

/** 토스트 자리 — **오른쪽 아래**. 생성 푸터(왼쪽 아래)·모드바와 겹치지 않는 유일한 구석이다. */
export function Toasts() {
  const items = useToast((s) => s.items);
  if (!items.length) return null;
  return (
    <div
      data-toasts
      style={{
        position: "fixed",
        right: 16,
        bottom: 64,
        zIndex: 95,
        display: "flex",
        flexDirection: "column",
        alignItems: "flex-end",
        gap: 6,
        pointerEvents: "none",
      }}
    >
      {items.map((x) => (
        <div
          key={x.id}
          data-toast={x.kind}
          style={{
            background: x.kind === "warn" ? "var(--err)" : "var(--panel)",
            color: x.kind === "warn" ? "#fff" : "var(--ink)",
            border: `1px solid ${x.kind === "warn" ? "var(--err)" : "var(--line)"}`,
            borderRadius: "var(--r-2)",
            boxShadow: "0 6px 18px rgba(0,0,0,0.28)",
            padding: "var(--sp-2) var(--sp-4)",
            fontSize: "var(--text-2xs)",
            maxWidth: 340,
            display: "flex",
            alignItems: "center",
            gap: "var(--sp-3)",
          }}
        >
          <span>{x.text}</span>
          {/* ★단추가 있으면 누를 수 있어야 한다 — 바깥 상자가 `pointerEvents: none` 이라
              여기서 되살린다 (글자 쪽은 그대로 통과시켜 뒤를 가리지 않는다). */}
          {x.action && (
            <button
              data-toast-action
              onClick={x.action.run}
              style={{
                pointerEvents: "auto",
                background: "transparent",
                border: "1px solid var(--accent)",
                borderRadius: "var(--r-1)",
                color: "var(--accent-ink)",
                padding: "2px var(--sp-2)",
                fontSize: "var(--text-2xs)",
                whiteSpace: "nowrap",
                cursor: "pointer",
              }}
            >
              {x.action.label}
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
