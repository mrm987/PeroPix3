import { useEffect, useState } from "react";
import { useI18n } from "../i18n";
import { useQueue } from "../store/queue";
import { toast } from "../store/toast";

/** **돌고 있는 차선(계정) 전부** — 최종 프롬프트 위에 **한 줄씩 세로로** 쌓인다 (사용자 지시 2026-09-02:
 *  *"3개 돌리고 있으면 3줄을 세로로 쌓아서"*).
 *
 *  ★푸터의 숫자는 **이 워크스페이스의 차선 하나**다 (`GenerateFooter`). 여기는 전체 그림이다 — 다른
 *    워크스페이스의 계정이 도는 것도 보인다. 줄마다 취소가 붙고, **그 차선만** 끊는다 (1안).
 *  ★아무것도 안 돌면 자리를 차지하지 않는다. 차선 정보가 없는 옛 백엔드도 마찬가지다. */
export function QueueLanes() {
  const t = useI18n((s) => s.t);
  const progress = useQueue((s) => s.progress);
  const cancelAll = useQueue((s) => s.cancelAll);
  /** 취소를 눌러 둔 차선 — 다시 못 누르고 「취소 중」으로 보인다. 그 차선이 멈추면 풀린다 */
  const [sent, setSent] = useState<Record<string, boolean>>({});
  const lanes = Object.entries(progress.lanes ?? {}).filter(([, l]) => l.total > l.completed || l.queue_length > 0);
  const laneKey = lanes.map(([id]) => id).join(",");
  useEffect(() => {
    const live = new Set(laneKey.split(",").filter(Boolean));
    setSent((s) => Object.fromEntries(Object.entries(s).filter(([k]) => live.has(k))));
  }, [laneKey]);
  if (!lanes.length) return null;

  const cancel = async (id: string) => {
    if (sent[id]) return;
    setSent((s) => ({ ...s, [id]: true }));
    // ★받았다고 말한다 — NAI 는 나간 한 장을 못 끊으므로 지금 것은 끝까지 나온다 (`GenerateFooter` 와 같은 몸짓)
    toast(t("queue.cancelSent"));
    await cancelAll(id);
  };

  return (
    <div
      data-queue-lanes
      style={{
        flexShrink: 0,
        borderTop: "1px solid var(--line)",
        padding: "var(--sp-2) var(--sp-4)",
        display: "flex",
        flexDirection: "column",
        gap: 2,
        fontSize: "var(--text-2xs)",
      }}
    >
      {lanes.map(([id, l]) => (
        <div key={id} data-queue-lane={id} style={{ display: "flex", alignItems: "center", gap: "var(--sp-2)" }}>
          <span
            style={{ color: "var(--ink-dim)", flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
          >
            {l.name || id}
          </span>
          <b style={{ fontFamily: "var(--font-mono)", color: "var(--accent-ink)", fontVariantNumeric: "tabular-nums" }}>
            {l.completed}/{l.total}
          </b>
          {l.queue_length > 0 && <span style={{ color: "var(--ink-faint)" }}>{t("queue.waiting", { n: l.queue_length })}</span>}
          <button
            data-queue-cancel={id}
            onClick={() => void cancel(id)}
            disabled={!!sent[id]}
            data-tip={t("queue.cancelHint")}
            style={{
              border: "1px solid",
              borderColor: sent[id] ? "var(--line)" : "var(--err)",
              borderRadius: "var(--r-2)",
              padding: "0 var(--sp-2)",
              color: sent[id] ? "var(--ink-ghost)" : "var(--err-ink)",
              background: "var(--panel)",
            }}
          >
            {sent[id] ? t("queue.cancelling") : t("queue.cancel")}
          </button>
        </div>
      ))}
    </div>
  );
}
