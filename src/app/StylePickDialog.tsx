import { useEffect, useState } from "react";
import { useI18n } from "../i18n";
import { Icon } from "../components/Icon";
import { useStylePick } from "../store/stylePick";
import { useGen } from "../store/gen";
import { GEN_OPT_KEYS, PROMPT_OPT_KEYS, styleOptRows, type StyleOpts, type StylePick } from "../lib/styleOpts";

/** 스타일 카드를 놓았을 때 **무엇을 덮을지 고르는 시트** — 그림을 떨궜을 때의 그 목록과 같은 꼴이다
 *  (사용자 지시 2026-09-21). 답은 `store/stylePick` 이 약속으로 돌려준다.
 *
 *  ★★**언제나 뜬다.** 바뀔 것이 없어도 띄우고, 지금과 같은 값은 「지금과 같음」으로 표시한다 —
 *    그러지 않으면 카드에 무엇이 담겨 있는지 볼 자리가 없다.
 *  ★`Esc` = 취소, `Enter` = 걸기 (`AskDialog` 와 같은 규칙).
 *  ★생성 옵션이 안 담긴 **옛 카드**는 그 줄이 잠기고 「담겨 있지 않음」이 뜬다. */
export function StylePickDialog() {
  const cur = useStylePick((s) => s.cur);
  const answer = useStylePick((s) => s.answer);
  const t = useI18n((s) => s.t);
  const params = useGen((g) => g.params);
  const [pick, setPick] = useState<StylePick>({ prompt: true, gen: true });

  // 새 카드를 놓을 때마다 처음 상태로 — 둘 다 켜져 있다
  useEffect(() => {
    if (cur) setPick({ prompt: true, gen: true });
  }, [cur?.id]);

  useEffect(() => {
    if (!cur) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") answer(null);
      if (e.key === "Enter") answer(pick);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [cur, answer, pick]);

  if (!cur) return null;
  const promptRows = styleOptRows(params, cur.opts, "prompt");
  const genRows = styleOptRows(params, cur.opts, "gen");
  const hasGen = genRows.length > 0;
  const nothing = !pick.prompt && !(pick.gen && hasGen);

  return (
    <div
      data-style-pick
      onPointerDown={(e) => e.target === e.currentTarget && answer(null)}
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
          width: "min(440px, 92vw)",
          display: "flex",
          flexDirection: "column",
          gap: "var(--sp-4)",
        }}
      >
        <b style={{ fontSize: "var(--text-md)" }}>{t("style.dropTitle", { name: cur.name })}</b>

        <div style={{ display: "flex", flexDirection: "column", gap: "var(--sp-3)" }}>
          <Group
            k="prompt"
            label={t("style.pickPrompt")}
            on={pick.prompt}
            onToggle={() => setPick((p) => ({ ...p, prompt: !p.prompt }))}
          >
            <Line text={t("style.promptBody")} />
            {promptRows.map((r) => (
              <Line key={r.key} text={label(t, r.key, r.value)} same={r.same} t={t} />
            ))}
            {/* 옛 카드는 넷이 없다 — 그래도 프롬프트 자체는 걸리므로 줄만 안 선다 */}
          </Group>

          <Group
            k="gen"
            label={t("style.pickGen")}
            on={pick.gen && hasGen}
            disabled={!hasGen}
            onToggle={() => setPick((p) => ({ ...p, gen: !p.gen }))}
          >
            {hasGen ? (
              genRows.map((r) => <Line key={r.key} text={label(t, r.key, r.value)} same={r.same} t={t} />)
            ) : (
              <Line text={t("style.noGen")} />
            )}
          </Group>
        </div>

        <div style={{ display: "flex", gap: "var(--sp-2)", justifyContent: "flex-end" }}>
          <button data-style-pick-cancel onClick={() => answer(null)} style={btn}>
            {t("cards.cancel")}
          </button>
          <button
            data-style-pick-ok
            autoFocus
            disabled={nothing}
            onClick={() => answer(pick)}
            style={{
              ...btn,
              background: "var(--accent)",
              borderColor: "var(--accent)",
              color: "var(--accent-on)",
              opacity: nothing ? 0.45 : 1,
            }}
          >
            {t("style.apply")}
          </button>
        </div>
      </div>
    </div>
  );
}

/** 체크 줄 하나 + 그 아래 담긴 값들. 체크 모양은 그림 드롭 시트와 같다 (`app/DropImport`) */
function Group({
  k,
  label,
  on,
  disabled,
  onToggle,
  children,
}: {
  k: string;
  label: string;
  on: boolean;
  disabled?: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <div style={{ opacity: disabled ? 0.55 : 1 }}>
      <button
        data-style-pick-row={k}
        data-on={on ? "" : undefined}
        disabled={disabled}
        onClick={onToggle}
        style={{
          display: "flex",
          alignItems: "center",
          gap: "var(--sp-2)",
          fontSize: "var(--text-xs)",
          color: on ? "var(--ink)" : "var(--ink-faint)",
          cursor: disabled ? "default" : "pointer",
        }}
      >
        <span
          style={{
            display: "grid",
            placeItems: "center",
            width: 18,
            height: 18,
            flexShrink: 0,
            borderRadius: "var(--r-1)",
            border: `1px solid ${on ? "var(--accent)" : "var(--line)"}`,
            background: on ? "var(--accent)" : "transparent",
            color: on ? "var(--accent-on)" : "var(--ink-ghost)",
          }}
        >
          {on ? Icon.check : Icon.close12}
        </span>
        {label}
      </button>
      <div
        style={{
          marginLeft: 26,
          marginTop: "var(--sp-1)",
          display: "flex",
          flexDirection: "column",
          gap: 1,
        }}
      >
        {children}
      </div>
    </div>
  );
}

function Line({ text, same, t }: { text: string; same?: boolean; t?: (k: string) => string }) {
  return (
    <span
      style={{
        fontSize: "var(--text-3xs)",
        color: "var(--ink-faint)",
        display: "flex",
        alignItems: "center",
        gap: "var(--sp-2)",
      }}
    >
      {text}
      {/* ★★지금과 같은 값도 지우지 않고 표시한다 (사용자 지시 2026-09-21) */}
      {same && t && (
        <span data-style-pick-same style={{ color: "var(--ink-ghost)" }}>{t("style.same")}</span>
      )}
    </span>
  );
}

/** 「이름 값」 한 줄. ★이름은 **화면에 이미 있는 이름**을 그대로 쓴다 (생성 옵션 칸의 라벨) */
function label(t: (k: string) => string, key: keyof StyleOpts, v: unknown): string {
  // ★퍼리 모드는 켜고 끄는 값이 아니라 **둘 중 하나**다 (화면도 그렇게 부른다) — 이름만 적는다
  if (key === "furry_mode") return t(v ? "options.modeFurry" : "options.modeAnime");
  const name = t(NAMES[key]);
  const val =
    typeof v === "boolean" ? t(v ? "style.on" : "style.off") : v === "" ? t("style.none") : String(v);
  return `${name} ${val}`;
}

/** 값 이름표 — 화면의 라벨과 **같은 열쇠**를 본다. 여기서 새로 짓지 않는다 */
const NAMES: Record<keyof StyleOpts, string> = {
  quality_preset: "options.qualityPreset",
  uc_preset: "options.ucPreset",
  transparent_bg: "options.transparentBg",
  furry_mode: "options.modeFurry",
  model: "options.model",
  variety_plus: "options.varietyPlus",
  steps: "options.steps",
  cfg: "options.cfg",
  cfg_rescale: "options.cfgRescale",
  sampler: "options.sampler",
  scheduler: "options.scheduler",
};

/** 목록이 늘거나 줄면 이름표도 함께여야 한다 — 빠지면 그 줄이 열쇠 문자열로 뜬다 */
void ([...PROMPT_OPT_KEYS, ...GEN_OPT_KEYS] as const).every((k) => k in NAMES);

const btn: React.CSSProperties = {
  border: "1px solid var(--line)",
  borderRadius: "var(--r-2)",
  background: "var(--panel)",
  color: "var(--ink-soft)",
  padding: "var(--sp-2) var(--sp-5)",
  fontSize: "var(--text-xs)",
};
