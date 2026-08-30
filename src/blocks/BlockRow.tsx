import { useI18n } from "../i18n";
import { useRename } from "../components/useRename";
import { COLORS, type Block } from "../lib/blocks";
import { colorHex } from "./Chip";
import { BlockBody, type TagDrag } from "./BlockBody";
import { Icon } from "../components/Icon";

/** 블록 한 줄.
 *
 *  ★조작 문법:
 *   - 그립(⠿) 드래그    = 블록 순서 변경
 *   - 머리 클릭         = 접기/펼치기
 *   - 제목 더블클릭     = 이름 변경
 *   - 색점 클릭         = 색 순환
 *   - 본문(칩 영역) 클릭 = **블록 전체가 텍스트로** 바뀐다
 *   - **칩 드래그       = 태그 자리 옮기기** (다른 블록으로도)
 *   - 칩 휠             = 가중치 / **휠 클릭 = 가중치 초기화** / 우클릭 = 삭제
 *   - 편집 중 Enter        = 고친 것을 저장하고 편집을 끝낸다
 *   - 편집 중 Shift+Enter  = 저장하고 **다음 블록을 만들어 이어서 입력**
 *   - 편집 중 Esc       = 편집만 끝낸다
 *
 *  ★가중치는 태그에만 있다. 블록 가중치는 걷어냈다 (2026-08-01). */
export function BlockRow({
  block,
  bare,
  readOnly,
  dup,
  onChange,
  onRemove,
  onEnter,
  onCancel,
  onDone,
  onOpen,
  onTab,
  autoEdit,
  autoCaret,
  fill,
  open,
  gripProps,
  tagDrag,
  dragging,
  zone,
}: {
  block: Block;
  /** ★**머리를 안 그린다** — 칸이 곧 블록인 자리(씬 칸)다. 몸통만 남는다.
   *  하나뿐인 블록에 켜고끄기·색은 뜻이 없고, 이름은 줄 머리에 이미 있다. */
  bare?: boolean;
  /** ★**내용을 못 고치는 자리** (블록 저장소). 칩·글 상자·색·켜고끄기가 죽는다 —
   *  이름 바꾸기와 지우기는 그대로다 (저장소에서 하는 일이 그 둘이다).
   *  ★고치는 창구는 **프롬프트 쪽 하나**다. 저장소에서도 고치게 하면 어디서 고쳤나가 된다. */
  readOnly?: boolean;
  dup: Set<string>;
  onChange: (b: Block) => void;
  onRemove: () => void;
  /** 저장소로 **끌어 넣기** — 머리를 잡고 서랍에 놓는다 (사용자 지시 2026-08-13).
   *  ★단추가 아니다: 넣는 것도 꺼내는 것도 같은 동작이라야 규칙이 하나로 남는다. */
  /** Enter — 고친 내용과 함께. **한 번에** 넘겨야 목록이 두 번 갈리지 않는다 */
  /** Shift+Enter — 고친 내용과 **가를 자리** (`BlockBody` 의 같은 이름 주석) */
  onEnter?: (b: Block, splitAt?: number) => void;
  /** Esc — 고치던 것을 버리고 나간다 */
  onCancel?: () => void;
  /** Enter 로 편집을 끝냈다 (씬 줄은 도로 접는다) */
  onDone?: () => void;
  /** 글 상자가 열렸다 — 잘라 보여 주던 부모가 자리를 내준다 */
  onOpen?: () => void;
  /** Tab — 옆 칸으로 */
  onTab?: (dir: 1 | -1) => void;
  /** 방금 만들어진 블록 — 뜨자마자 편집 상태로 */
  autoEdit?: boolean;
  /** 그렇게 열 때 커서를 놓을 자리 (`BlockBody` 의 같은 이름) */
  autoCaret?: number;
  /** 품이 준 자리를 다 쓴다 (`BlockBody` 의 `fill`) */
  fill?: boolean;
  /** 품이 아는 「펼쳐져 있나」 (`BlockBody` 의 `open`) */
  open?: boolean;
  gripProps?: React.HTMLAttributes<HTMLSpanElement>;
  /** 칩 끌기 (`useTagDrag`) — 목록이 들고 있는 것을 이 블록 몫만 받는다 */
  tagDrag?: TagDrag;
  dragging?: boolean;
  /** 이 블록이 사는 자리 — 되돌리기가 자리별로 갈린다 (`lib/undo`) */
  zone?: string;
}) {
  const t = useI18n((s) => s.t);
  /** 이름 고치기 — ★규칙은 **앱에 하나**다 (`useRename`): 단추를 다시 누르면 저장하고 끝 */
  const rename = useRename(block.label, (v) => onChange({ ...block, label: v }));

  const summary = block.tags.map((x) => x.t).join(", ") || t("block.emptySummary");

  const body = (
    <BlockBody
      block={block}
      readOnly={readOnly}
      onChange={onChange}
      dup={dup}
      tagDrag={tagDrag}
      autoEdit={autoEdit}
      autoCaret={autoCaret}
      mark={block.id}
      onEnter={onEnter}
      onCancel={onCancel}
      onDone={onDone}
      onOpen={onOpen}
      onTab={onTab}
      zone={zone}
      fill={fill}
      open={open}
    />
  );
  // ★머리가 없는 자리는 **몸통 그대로**다 — 테두리도 접기도 없다 (칸이 곧 블록이다)
  if (bare) return body;

  return (
    <div
      data-block={block.id}
      /* ★★테두리는 **낱개 표기로만** 적는다 (조작 테스트에서 잡은 React 경고 2026-08-19):
         `border` 줄임 표기와 `borderLeft*` 를 한 상자에 섞으면, 다시 그릴 때 어느 쪽이
         나중에 적용되는지가 흔들려 왼쪽 색 띠가 사라지는 식으로 조용히 어긋난다. */
      style={{
        borderWidth: "1px 1px 1px 3px",
        borderStyle: "solid",
        borderColor: `var(--line) var(--line) var(--line) ${colorHex(block.color)}`,
        borderRadius: "var(--r-3)",
        background: "var(--surface)",
        opacity: dragging ? 0.35 : block.on ? 1 : 0.45,
      }}
    >
      {/* 머리 */}
      <div
        data-block-head
        // ★머리는 누르면 **접고 펼 뿐**이다. 끌기(순서·서랍·다른 카드)는 전부 **손잡이**다
        //   (사용자 지시 2026-08-30 — 예전에는 머리를 끌면 서랍에 들어갔는데 비직관적이었고,
        //   그 pointerdown 의 기본 동작 막기가 호환 click 을 삼켜 이름 더블클릭까지 죽였다).
        // ★머리 위의 **누르는 것들**(색·이름 바꾸기·토글·삭제)은 접기에서 비켜 간다.
        onClick={(e) => {
          if ((e.target as HTMLElement).closest("button, [data-head-action]")) return;
          onChange({ ...block, open: !block.open });
        }}
        style={{
          display: "flex",
          alignItems: "center",
          gap: "var(--sp-2)",
          padding: "4px 7px 4px 3px",
          minHeight: 28,
          cursor: "pointer",
        }}
      >
        {/* ★손잡이는 **줄 순서를 바꿀 수 있는 자리에만** 뜬다 (저장소에는 없다) */}
        {gripProps && (
        <span
          {...gripProps}
          onClick={(e) => e.stopPropagation()}
          style={{
            color: "var(--ink-faint)",
            fontSize: "calc(11px * var(--text-scale))",
            lineHeight: 1,
            padding: "0 4px",
            userSelect: "none",
            display: "grid",
            ...(gripProps?.style ?? {}),
          }}
        >
          {Icon.grip}
        </span>
        )}

        {/* ★보기 전용은 색을 **못 고친다** — 왼쪽 띠가 이미 그 색을 말한다 */}
        {!readOnly && (
        <span
          data-head-action
          data-block-color
          onClick={(e) => {
            e.stopPropagation();
            const i = COLORS.indexOf(block.color);
            onChange({ ...block, color: COLORS[(i + 1) % COLORS.length] });
          }}
          data-tip={t("block.color")}
          style={{
            width: 10,
            height: 10,
            flexShrink: 0,
            borderRadius: "50%",
            border: "1px solid var(--line)",
            background: block.color ? colorHex(block.color) : "transparent",
          }}
        />
        )}

        {rename.editing ? (
          <input
            data-block-rename-input
            {...rename.inputProps}
            style={{
              fontSize: "var(--text-xs)",
              fontWeight: "var(--w-bold)",
              background: "var(--surface2)",
              border: "1px solid var(--accent)",
              borderRadius: "var(--r-1)",
              padding: "0 4px",
              width: 110,
            }}
          />
        ) : (
          <b
            /* ★이름 바꾸기는 **단추 하나**로 (더블클릭은 걷었다 — 끌기에 먹혀 오래 죽어 있었다) */
            style={{ fontSize: "var(--text-xs)", whiteSpace: "nowrap", userSelect: "none" }}
          >
            {block.label}
          </b>
        )}

        {/* 접힌 동안만 요약 — 펼치면 정보 중복이라 숨긴다 */}
        {!block.open ? (
          <span
            style={{
              flex: 1,
              minWidth: 0,
              fontSize: "var(--text-2xs)",
              color: "var(--ink-dim)",
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
          >
            {summary}
          </span>
        ) : (
          <span style={{ flex: 1 }} />
        )}

        {/* ★태그 개수를 적지 않는다 (사용자 지시 2026-08-13) — 접혀 있으면 요약이 이미
            보이고 펼치면 칩이 다 보인다. 한 줄에 정보가 너무 많았다 */}
        {/* ★★차례는 앱 전체에서 하나다: **이름변경 · 온오프 · 삭제** (사용자 지시 2026-08-19) */}
        <button
          data-block-rename={block.id}
          {...rename.btnProps}
          data-tip={t("cards.rename")}
          style={{ color: "var(--ink-faint)", padding: "0 2px", display: "grid" }}
        >
          {Icon.pencil}
        </button>
        {/* ★보기 전용에는 켜고끄기가 없다 — 저장소의 블록은 프롬프트에 안 들어가 있다 */}
        {!readOnly && (
        <button
          /* ★표식은 조작 테스트가 잡는 자리다 (아이콘뿐이라 글자로는 못 찾는다) */
          data-block-on={block.id}
          onClick={(e) => {
            e.stopPropagation();
            onChange({ ...block, on: !block.on });
          }}
          data-tip={block.on ? t("block.toggleOff") : t("block.toggleOn")}
          style={{ color: "var(--ink-faint)", padding: "0 2px", display: "grid" }}
        >
          {block.on ? Icon.dotOn : Icon.dotOff}
        </button>
        )}
        <button
          data-block-del={block.id}
          onClick={(e) => {
            e.stopPropagation();
            onRemove();
          }}
          data-tip={t("block.remove")}
          style={{ color: "var(--ink-faint)", padding: "0 2px", display: "grid" }}
        >
          {Icon.close12}
        </button>
      </div>

      {/* 본문 — ★머리가 있든 없든 **같은 부품**이다 (`BlockBody`) */}
      {block.open && <div style={{ padding: "0 8px 7px" }}>{body}</div>}
    </div>
  );
}
