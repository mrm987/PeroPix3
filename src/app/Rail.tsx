import { useI18n } from "../i18n";
import { PanelCollapseButton } from "../components/PanelCollapseButton";

/** 접힌 패널 자리에 남는 36px 레일.
 *  ★완전히 사라지면 어디서 다시 여는지 잃어버린다 (ui-guide.md 5절). */
export function Rail({
  side,
  label,
  onExpand,
  footer,
  dot,
  tip,
  icon,
}: {
  side: "left" | "right";
  label: string;
  onExpand: () => void;
  /** ★접어 둬도 남아야 하는 것 — 생성 버튼이 그렇다 (페로픽스파이와 같다). 레일 맨 아래에 선다 */
  footer?: React.ReactNode;
  /** ★접힌 채로 알릴 것 — `busy`(도는 중)·`done`(끝났는데 아직 안 봄).
   *  ★★접어 두면 화면에 아무 흔적이 없어서, 끝난 줄 모르고 지나친다 (사용자 지시 2026-08-26).
   *    ★도는 중까지 함께 내는 까닭: 접는 순간 「일하는 중」 표시가 사라져 **멈춘 것처럼**
   *      보인다 (같은 날 지적). 레일에 점 하나만 있어도 살아 있는지가 보인다. */
  dot?: "busy" | "done" | null;
  /** 버튼의 툴팁. 없으면 「펼치기」 (앱 밖 창으로 분리된 동안은 「메인으로 되돌리기」) */
  tip?: string;
  /** 버튼의 아이콘. 없으면 셰브런 (앱 밖 창으로 분리된 동안은 분리 아이콘) */
  icon?: React.ReactNode;
}) {
  const t = useI18n((s) => s.t);
  return (
    <aside
      style={{
        width: 36,
        flexShrink: 0,
        background: "var(--bg)",
        [side === "left" ? "borderRight" : "borderLeft"]: "1px solid var(--line)",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
      }}
    >
      {/* ★`title` 이다 — `data-tip` 으로 넘기면 버려진다 (`PanelCollapseButton` 의 프롭) */}
      <PanelCollapseButton side={side} collapsed onClick={onExpand} title={tip ?? t("panel.expand", { name: label })} icon={icon} />
      <div
        style={{
          writingMode: "vertical-rl",
          marginTop: "var(--sp-2)",
          fontSize: "var(--text-2xs)",
          color: "var(--ink-dim)",
          letterSpacing: "0.08em",
          userSelect: "none",
        }}
      >
        {label}
      </div>
      {dot && (
        <span
          data-rail-dot={dot}
          /* ★도는 중이면 **깜빡이고**(`.think-dot`), 끝난 것이면 가만히 있다 —
             기다리는 것과 확인할 것은 성격이 다르다 */
          className={dot === "busy" ? "think-dot" : undefined}
          style={{
            marginTop: "var(--sp-2)",
            width: 6,
            height: 6,
            borderRadius: "50%",
            background: dot === "busy" ? "var(--ink-faint)" : "var(--accent)",
            flexShrink: 0,
          }}
        />
      )}
      {footer && (
        <>
          <span style={{ flex: 1 }} />
          <div style={{ width: "100%" }}>{footer}</div>
        </>
      )}
    </aside>
  );
}
