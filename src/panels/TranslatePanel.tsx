import { useEffect, useState } from "react";
import { Icon } from "../components/Icon";
import { useI18n } from "../i18n";
import { toast } from "../store/toast";
import { LANGS, translateText, useTranslate, type Lang } from "../store/translate";

/** 번역 창 — **작고, 떠 있고, 닫을 때까지 남는다** (사용자 지시 2026-08-29).
 *
 *  · 위에 목적지 말 셋(「→ 영어」「→ 한국어」「→ 일본어」). 원어는 서버가 알아본다. 고른 말과
 *    같은 말을 치면 **그대로** 나온다 — 뒤집지 않는다 (사용자 지적 2026-08-29).
 *  · 치는 대로 번역한다 (0.4초 뜸). 결과는 복사 단추로 가져간다 — 프롬프트에 **넣어 주지
 *    않는다**: 어느 블록의 어느 자리인지 이 창은 모른다.
 *  · `App` 이 **생성 모드일 때만** 그린다. 열림 상태는 스토어에 남는다 (`useTranslate`).
 *  ★모달이 아니다 — 뒤를 가리지 않고, 프롬프트를 고치면서 옆에 두고 본다. 그래서 **왼쪽
 *    패널 바로 오른쪽**(가운데 칸의 왼쪽 위)에 띄운다 (사용자 지시 2026-08-29: 오른쪽 아래는
 *    너무 멀었다). */
export function TranslatePanel() {
  const t = useI18n((s) => s.t);
  const open = useTranslate((s) => s.open);
  const text = useTranslate((s) => s.text);
  const target = useTranslate((s) => s.target);
  const { setOpen, setText, setTarget } = useTranslate.getState();
  const [out, setOut] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  useEffect(() => {
    if (!open) return;
    const q = text.trim();
    if (!q) {
      setOut("");
      setErr("");
      return;
    }
    setBusy(true);
    const id = window.setTimeout(() => {
      translateText(q, target)
        .then((s) => {
          setOut(s);
          setErr("");
        })
        .catch((e) => setErr(String(e)))
        .finally(() => setBusy(false));
    }, 400);
    return () => window.clearTimeout(id);
  }, [open, text, target]);

  if (!open) return null;

  return (
    <div
      data-translate-panel
      style={{
        position: "absolute",
        left: "var(--sp-3)",
        top: "var(--sp-3)",
        zIndex: 45,
        width: 320,
        maxWidth: "calc(100% - 2 * var(--sp-4))",
        display: "flex",
        flexDirection: "column",
        gap: "var(--sp-2)",
        padding: "var(--sp-3)",
        background: "var(--panel)",
        border: "1px solid var(--line-strong)",
        borderRadius: "var(--r-3)",
        boxShadow: "0 8px 28px rgba(0,0,0,0.28)",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: "var(--sp-2)" }}>
        <span style={{ color: "var(--accent-ink)", display: "grid" }}>{Icon.globe}</span>
        <b style={{ fontSize: "var(--text-xs)" }}>{t("translate.title")}</b>
        <span style={{ flex: 1 }} />
        {/* 목적지 말 — 「→ 한국어」 꼴로, 그 말로 바꾼다는 뜻을 화살표가 말한다 */}
        {LANGS.map((l: Lang) => {
          const on = target === l;
          return (
            <button
              key={l}
              data-translate-target={l}
              data-on={on ? "" : undefined}
              onClick={() => setTarget(l)}
              style={{
                padding: "1px var(--sp-2)",
                borderRadius: "var(--r-1)",
                fontSize: "var(--text-2xs)",
                border: `1px solid ${on ? "var(--accent)" : "var(--line)"}`,
                color: on ? "var(--accent-ink)" : "var(--ink-faint)",
                background: on ? "var(--accent-bg)" : "transparent",
              }}
            >
              {"→ " + t(`translate.lang.${l}`)}
            </button>
          );
        })}
        <button
          data-translate-close
          onClick={() => setOpen(false)}
          data-tip={t("common.close")}
          style={{ display: "grid", color: "var(--ink-faint)", marginLeft: "var(--sp-1)" }}
        >
          {Icon.close12}
        </button>
      </div>

      <textarea
        data-translate-input
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={t("translate.placeholder")}
        rows={3}
        autoFocus
        style={{
          width: "100%",
          resize: "none",
          padding: "var(--sp-2)",
          borderRadius: "var(--r-2)",
          border: "1px solid var(--line)",
          background: "var(--bg)",
          color: "var(--ink)",
          fontSize: "var(--text-prompt)",
          lineHeight: 1.5,
        }}
      />

      <div
        data-translate-out
        style={{
          minHeight: "3.2em",
          padding: "var(--sp-2)",
          borderRadius: "var(--r-2)",
          background: "var(--code-bg)",
          color: err ? "var(--warn)" : out ? "var(--ink)" : "var(--ink-faint)",
          fontSize: "var(--text-prompt)",
          lineHeight: 1.5,
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
        }}
      >
        {err || out || (busy ? t("translate.busy") : t("translate.empty"))}
      </div>

      <div style={{ display: "flex", justifyContent: "flex-end" }}>
        <button
          data-translate-copy
          disabled={!out}
          onClick={() => void navigator.clipboard?.writeText(out).then(() => toast(t("act.copied")))}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: "var(--sp-2)",
            padding: "3px var(--sp-3)",
            borderRadius: "var(--r-2)",
            border: "1px solid var(--line)",
            background: "var(--panel)",
            color: out ? "var(--ink-soft)" : "var(--ink-ghost)",
            fontSize: "var(--text-2xs)",
          }}
        >
          {Icon.copy}
          {t("act.copy")}
        </button>
      </div>
    </div>
  );
}
