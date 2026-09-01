import { useState } from "react";
import { api } from "../lib/backend";
import { useI18n } from "../i18n";

/** **MCP 연동** — 바깥 에이전트(클로드 코드 등)가 이 앱의 도구를 그대로 쓰게 하는 자리
 *  (사용자 결정 2026-08-31).
 *
 *  ★★도구도 지침도 **내부 조수와 한 벌**이다 (`backend/mcp_stdio.py`) — 여기서 따로
 *    보여 주거나 고르게 하지 않는다. 이 화면이 하는 일은 **설정을 건네주는 것** 하나다.
 *  ★설정은 백엔드가 짓는다 (`/api/mcp/config`) — 파이썬·스크립트 경로·포트·열쇠를
 *    화면이 짐작하면 배포판과 저장소에서 갈리고, 한쪽만 고쳐진다. */
export function McpSettings() {
  const t = useI18n((s) => s.t);
  const [conf, setConf] = useState("");
  const [err, setErr] = useState("");
  const [copied, setCopied] = useState(false);

  /* ★★**설정을 화면이 짓지 않는다** — 파이썬 경로·스크립트 경로·포트·열쇠를 전부 백엔드가
     안다 (`/api/mcp/config`). 화면이 짐작해 조립하면 배포판(동봉 파이썬)과 저장소에서
     갈리고, 한쪽만 고쳐진다.
     ★**누를 때 부른다** — 이 창구를 부르는 순간 고정 열쇠가 처음 만들어지므로, MCP 를
       안 쓰는 사용자에게는 열쇠 자체가 생기지 않는다. */
  const copy = async () => {
    setErr("");
    try {
      const r = await api<{ json: string }>("/api/mcp/config");
      setConf(r.json);
      await navigator.clipboard.writeText(r.json);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (e) {
      setErr(String(e));
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--sp-2)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: "var(--sp-2)" }}>
        <b style={{ fontSize: "var(--text-xs)", color: "var(--ink-soft)" }}>{t("settings.mcpTitle")}</b>
        <span style={{ flex: 1 }} />
        <button
          data-mcp-copy
          onClick={() => void copy()}
          style={{
            padding: "3px var(--sp-3)",
            fontSize: "var(--text-2xs)",
            border: "1px solid var(--line)",
            borderRadius: "var(--r-1)",
            color: copied ? "var(--accent-ink)" : "var(--ink)",
          }}
        >
          {copied ? t("settings.mcpCopied") : t("settings.mcpCopy")}
        </button>
      </div>
      <span style={{ fontSize: "var(--text-2xs)", color: "var(--ink-faint)", lineHeight: 1.6 }}>
        {t("settings.mcpHint")}
      </span>
      {conf && (
        <pre
          data-mcp-config
          style={{
            margin: 0,
            maxHeight: 160,
            overflow: "auto",
            padding: "var(--sp-2)",
            background: "var(--surface2)",
            border: "1px solid var(--line)",
            borderRadius: "var(--r-1)",
            fontSize: "var(--text-2xs)",
            fontFamily: "var(--font-mono)",
            whiteSpace: "pre",
            userSelect: "text",
          }}
        >
          {conf}
        </pre>
      )}
      {err && <span style={{ fontSize: "var(--text-2xs)", color: "var(--err-ink)" }}>{err}</span>}
    </div>
  );
}

