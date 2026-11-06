import { useI18n } from "../i18n";
import { Icon } from "./Icon";

/** 패널 접기/펼치기 버튼 (ui-guide.md 5절 규칙 그대로)
 *
 *  - 버튼은 **패널의 안쪽(가운데 쪽) 가장자리**에 둔다 (사용자 지시 2026-08-04 — 바깥 끝에
 *    두면 창 조작 버튼처럼 보인다). 좌 패널은 오른쪽 끝, 우 패널은 왼쪽 끝.
 *  - 셰브런은 **접히는 방향**을 가리킨다:
 *      좌측 패널 → 펼침 `‹` / 접힘 `›`
 *      우측 패널 → 펼침 `›` / 접힘 `‹`
 *  - 구분선은 펼쳤을 때만 그린다. 접힘 레일은 자기 테두리가 이미 그 픽셀에 있어 겹친다. */
export function PanelCollapseButton({
  side,
  collapsed,
  onClick,
  title,
  icon,
}: {
  side: "left" | "right";
  collapsed: boolean;
  onClick: () => void;
  title?: string;
  /** 셰브런 대신 그릴 것. 앱 밖 창으로 분리된 영역의 레일이 쓴다 */
  icon?: React.ReactNode;
}) {
  const t = useI18n((s) => s.t);
  const pointingLeft = (side === "left" && !collapsed) || (side === "right" && collapsed);
  // 버튼이 안쪽 끝에 서므로 구분선은 **바깥쪽**에 그린다
  const sepSide = side === "left" ? "borderLeft" : "borderRight";
  return (
    <button
      onClick={onClick}
      data-tip={title ?? (collapsed ? t("panel.expand", { name: "" }) : t("panel.collapse", { name: "" }))}
      style={{
        width: 32,
        height: 32,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        color: "var(--ink-dim)",
        flexShrink: 0,
        ...(collapsed ? {} : { [sepSide]: "1px solid var(--line)" }),
      }}
    >
      {icon ?? (pointingLeft ? Icon.chevL : Icon.chevR)}
    </button>
  );
}
