import { useState } from "react";
import { api } from "../lib/backend";
import { useI18n } from "../i18n";

/** **MCP 연동** — 바깥 에이전트(클로드 코드·코덱스 등)가 이 앱의 도구를 그대로 쓰게 하는 자리
 *  (사용자 결정 2026-08-31).
 *
 *  ★★도구도 지침도 **내부 조수와 한 벌**이다 (`backend/mcp_stdio.py`) — 여기서 따로
 *    보여 주거나 고르게 하지 않는다. 이 화면이 하는 일은 **건네줄 것을 만들어 주는 것** 하나다.
 *  ★★**등록 명령어를 짓지 않는다** (사용자 지시 2026-08-31: *"정확히 실행되는 명령어일
 *    필요 없고, LLM 에 건네면 통용되는 형태면 된다"*). 도구마다 등록 방법이 다르고 셸마다
 *    따옴표 규칙도 달라, 맞히려 들면 한 도구에만 맞는다 (실측: `claude mcp add-json` 한 줄이
 *    파워셸에서 깨졌다). 대신 **「이 양식대로 연동해 줘」 + 설정**을 준다.
 *  ★값(경로·포트·열쇠)은 백엔드가, 말은 여기(i18n)가 — 언어는 셋이고 값은 하나다.
 *  ★★**다음에 무엇을 할지는 누른 뒤에 말한다** (사용자 지적 2026-08-31) — 미리 다 적어 두면
 *    읽지 않고, 정작 복사한 뒤에는 안내가 없었다. */
export function McpSettings() {
  const t = useI18n((s) => s.t);
  const [text, setText] = useState("");
  const [err, setErr] = useState("");

  /** ★**누를 때 받아 온다** — 이 창구를 부르는 순간 고정 열쇠가 처음 만들어지므로,
   *    MCP 를 안 쓰는 사용자에게는 열쇠 자체가 생기지 않는다. */
  const copy = async () => {
    setErr("");
    try {
      const r = await api<{ json: string }>("/api/mcp/config");
      const out = `${t("settings.mcpAsk")}\n\n${r.json}`;
      setText(out);
      await navigator.clipboard.writeText(out);
    } catch (e) {
      setErr(String(e));
      setText("");
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--sp-3)" }}>
      <span style={{ fontSize: "var(--text-2xs)", color: "var(--ink-soft)", lineHeight: 1.6 }}>
        {t("settings.mcpHint")}
      </span>

      <button
        data-mcp-copy
        onClick={() => void copy()}
        style={{
          alignSelf: "flex-start",
          padding: "3px var(--sp-3)",
          fontSize: "var(--text-2xs)",
          border: "1px solid var(--line)",
          borderRadius: "var(--r-1)",
          color: "var(--ink)",
        }}
      >
        {t("settings.mcpCopy")}
      </button>

      {text && (
        <div data-mcp-next style={{ display: "flex", flexDirection: "column", gap: "var(--sp-2)" }}>
          <span style={{ fontSize: "var(--text-2xs)", color: "var(--accent-ink)", lineHeight: 1.6 }}>
            {t("settings.mcpNext")}
          </span>
          <pre
            data-mcp-config
            style={{
              margin: 0,
              maxHeight: 200,
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
            {text}
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
