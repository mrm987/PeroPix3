import { useState } from "react";
import { api } from "../lib/backend";
import { useI18n } from "../i18n";

/** **MCP 연동** — 바깥 에이전트(클로드 코드 등)가 이 앱의 도구를 그대로 쓰게 하는 자리
 *  (사용자 결정 2026-08-31).
 *
 *  ★★도구도 지침도 **내부 조수와 한 벌**이다 (`backend/mcp_stdio.py`) — 여기서 따로
 *    보여 주거나 고르게 하지 않는다. 이 화면이 하는 일은 **붙여 넣을 것을 건네주는 것** 하나다.
 *  ★설정은 백엔드가 짓는다 (`/api/mcp/config`) — 파이썬·스크립트 경로·포트·열쇠를
 *    화면이 짐작하면 배포판과 저장소에서 갈리고, 한쪽만 고쳐진다.
 *  ★★**다음에 무엇을 할지는 누른 뒤에 말한다** (사용자 지적 2026-08-31: *"복사를 누르면
 *    JSON 이 나오는데 다음 행동을 모르겠다"*). 미리 다 적어 두면 읽지 않고, 정작 복사한
 *    뒤에는 안내가 없었다. 그래서 설명은 한 줄로 줄이고, **고른 방식에 맞는 안내**를 아래에 띄운다. */
type Conf = { json: string; command: string };

export function McpSettings() {
  const t = useI18n((s) => s.t);
  const [conf, setConf] = useState<Conf | null>(null);
  const [mode, setMode] = useState<"cmd" | "json" | null>(null);
  const [err, setErr] = useState("");

  /** ★**누를 때 받아 온다** — 이 창구를 부르는 순간 고정 열쇠가 처음 만들어지므로,
   *    MCP 를 안 쓰는 사용자에게는 열쇠 자체가 생기지 않는다. */
  const copy = async (which: "cmd" | "json") => {
    setErr("");
    try {
      const r = conf ?? (await api<Conf>("/api/mcp/config"));
      setConf(r);
      await navigator.clipboard.writeText(which === "cmd" ? r.command : r.json);
      setMode(which);
    } catch (e) {
      setErr(String(e));
      setMode(null);
    }
  };

  const btn: React.CSSProperties = {
    padding: "3px var(--sp-3)",
    fontSize: "var(--text-2xs)",
    border: "1px solid var(--line)",
    borderRadius: "var(--r-1)",
    color: "var(--ink)",
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--sp-3)" }}>
      <span style={{ fontSize: "var(--text-2xs)", color: "var(--ink-soft)", lineHeight: 1.6 }}>
        {t("settings.mcpHint")}
      </span>

      <div style={{ display: "flex", gap: "var(--sp-2)" }}>
        <button data-mcp-copy="cmd" onClick={() => void copy("cmd")} style={btn}>
          {t("settings.mcpCopyCmd")}
        </button>
        <button data-mcp-copy="json" onClick={() => void copy("json")} style={btn}>
          {t("settings.mcpCopyJson")}
        </button>
      </div>

      {/* ★복사한 **그 방식**에 맞는 다음 행동만 말한다 */}
      {mode && conf && (
        <div data-mcp-next style={{ display: "flex", flexDirection: "column", gap: "var(--sp-2)" }}>
          <span style={{ fontSize: "var(--text-2xs)", color: "var(--accent-ink)", lineHeight: 1.6 }}>
            {t(mode === "cmd" ? "settings.mcpNextCmd" : "settings.mcpNextJson")}
          </span>
          <pre
            data-mcp-config
            style={{
              margin: 0,
              maxHeight: 180,
              overflow: "auto",
              padding: "var(--sp-2)",
              background: "var(--surface2)",
              border: "1px solid var(--line)",
              borderRadius: "var(--r-1)",
              fontSize: "var(--text-2xs)",
              fontFamily: "var(--font-mono)",
              whiteSpace: "pre-wrap",
              wordBreak: "break-all",
              userSelect: "text",
            }}
          >
            {mode === "cmd" ? conf.command : conf.json}
          </pre>
          <span style={{ fontSize: "var(--text-2xs)", color: "var(--ink-faint)", lineHeight: 1.6 }}>
            {t("settings.mcpNote")}
          </span>
        </div>
      )}

      {err && <span style={{ fontSize: "var(--text-2xs)", color: "var(--err-ink)" }}>{err}</span>}
    </div>
  );
}
