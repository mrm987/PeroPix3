import { Icon } from "./Icon";

/** 폴더 트리의 **맨 윗줄** — 그 트리가 무엇의 트리인지 말하는 자리.
 *
 *  ★★사용자 지적 2026-08-23: *"파일관리의 최상단 workspaces 라는 폴더가 들여쓰기가 되어
 *    있어서 상위 트리처럼 안 보임"*. 예전에는 아래 폴더 줄과 **같은 모양**이었고, 접기
 *    화살표 자리만큼 들여쓰여 있어서 형제 폴더 하나로 읽혔다.
 *  ★그래서 **머리글처럼** 그린다: 들여쓰지 않고, 글자를 굵게 두고, 아래로 선을 하나 긋는다.
 *    자기 아래의 폴더들이 한 단 들어가 보이는 것이 트리의 뜻이다.
 *  ★★파일 관리와 자동검열이 **같은 이것**을 쓴다 (사용자 지시: 검열 쪽도 동일하게).
 *    두 벌로 두면 한쪽만 고쳐져 같은 트리가 화면마다 다르게 보인다.
 *
 *  @param on 지금 이 자리를 보고 있나 (안 넘기면 고르는 자리가 아니다 — 검열 쪽이 그렇다)
 *  @param over 무언가를 이 위로 끌고 왔나
 */
export function TreeRoot({
  label,
  count,
  on,
  over,
  ...rest
}: {
  label: string;
  count?: number;
  on?: boolean;
  over?: boolean;
} & React.HTMLAttributes<HTMLDivElement>) {
  const pick = on !== undefined;
  return (
    <div
      data-tree-root={label}
      {...rest}
      style={{
        display: "flex",
        alignItems: "center",
        gap: "var(--sp-2)",
        // ★들여쓰지 않는다 — 아래 폴더 줄이 한 단 들어가야 위아래 관계가 보인다
        padding: "3px var(--sp-2) 5px",
        marginBottom: 3,
        borderBottom: "1px solid var(--line)",
        fontSize: "var(--text-2xs)",
        fontWeight: "var(--w-semi)",
        color: on ? "var(--ink)" : "var(--ink-soft)",
        background: over ? "var(--accent-bg)" : undefined,
        cursor: pick ? "pointer" : "default",
        ...rest.style,
      }}
    >
      <span style={{ display: "grid", color: on ? "var(--accent-ink)" : "var(--ink-faint)" }}>{Icon.folderOpen}</span>
      <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {label}
      </span>
      {!!count && (
        <span style={{ color: "var(--ink-faint)", fontWeight: "var(--w-norm)", fontVariantNumeric: "tabular-nums" }}>
          {count}
        </span>
      )}
    </div>
  );
}
