import { useI18n } from "../i18n";
import type { ReactNode } from "react";
import { TitleBar } from "./TitleBar";
import { BottomNav } from "./BottomNav";
import { Rail } from "./Rail";
import { ResizeHandle } from "../components/ResizeHandle";
import { PanelCollapseButton } from "../components/PanelCollapseButton";
import { useUi } from "../store/ui";
import { useLlm } from "../store/llm";

/* ★기둥·틀은 **가장 어두운 바탕**(`--bg`)이다 — 페로픽스파이는 `.params-panel` 에
   바탕색이 아예 없어 body 의 `--bg` 가 그대로 비친다 (실측 2026-08-04). 밝은 톤(`--panel`)은
   그 위에 놓이는 **상자**(섹션·입력·카드)만 갖는다. 우리는 정반대로 기둥을 밝게 칠하고
   있어서 화면이 통째로 밝은 판 하나로 보였다. */
/** 앱 셸 — 좌 패널 / 캔버스 / 우 패널 + 상단 타이틀바 + 하단 네비.
 *
 *  ★모드 전환에도 각 화면의 상태가 살아남도록 **전부 마운트한 채 display 로 숨긴다**
 *    (ui-guide.md 5절). 패널 폭·스크롤·선택이 보존된다. */
export function Shell({
  left,
  right,
  center,
  centerKeep,
  titleLeft,
  titleRight,
  navRight,
  /** ★좌 패널 **스크롤 밖**에 고정되는 자리 (생성 푸터). 접어도 `leftFooterCompact` 로 남는다 */
  leftFooter,
  leftFooterCompact,
  /** ★탭 줄은 **세 기둥 위 전체 폭**이다 (사용자 지시 2026-08-04 — 페로픽스파이 싱글 모드 구성).
   *  가운데 기둥 안에 두면 프롬프트가 탭 **옆**에 있어 공통처럼 읽힌다. 위로 올리면
   *  좌·가운데·우가 전부 **그 서브 탭의 내용**으로 읽힌다. */
  tabs,
  /** ★그 화면에 **없는 기둥**은 레일도 안 남긴다 — 열 것이 없는 레일은 막다른 길이다 */
  hideLeft,
  hideRight,
  /** ★AI 채팅 — **맨 바깥 왼쪽 기둥**이다. 모드와 무관하게 늘 있다 (설계: ui-guide 7절) */
  ai,
  /** 패널 머리글 — **모드마다 다르다.** 안에 든 것과 머리글이 어긋나면
   *  (갤러리인데 "프롬프트"라고 적혀 있으면) 사용자가 지금 무엇을 보는지 알 수 없다. */
  leftLabel,
  rightLabel,
  /** 좌 패널 머리 **오른쪽**에 얹는 것 (블록 저장소 단추). 접기 단추 왼편에 붙는다 */
  leftHeaderRight,
  /** 좌 패널 **옆**에 붙는 서랍 — 덮지 않고 나란히 선다 (블록 저장소) */
  leftDrawer,
}: {
  left: ReactNode;
  right: ReactNode;
  center: ReactNode;
  /** 가운데 칸에 **모드와 무관하게 늘 매달아 두는 것** — 모드를 오가도 떼지 않는 화면 (플러그인 캔버스). 숨김은 그쪽이 맡는다 */
  centerKeep?: ReactNode;
  leftLabel: string;
  rightLabel: string;
  leftHeaderRight?: ReactNode;
  leftDrawer?: ReactNode;
  titleLeft?: ReactNode;
  titleRight?: ReactNode;
  navRight?: ReactNode;
  leftFooter?: ReactNode;
  leftFooterCompact?: ReactNode;
  tabs?: ReactNode;
  hideLeft?: boolean;
  hideRight?: boolean;
  ai?: ReactNode;
}) {
  const {
    leftWidth: leftWidths,
    rightWidth: rightWidths,
    mode,
    leftCollapsed: leftFolds,
    rightCollapsed: rightFolds,
    setLeftWidth,
    setRightWidth,
    toggleLeft,
    toggleRight,
    commitLayout,
    aiWidth,
    aiCollapsed,
    setAiWidth,
    toggleAi,
  } = useUi();
  /* ★양옆 폭은 **모드마다 따로**다 (`store/ui` 의 `PanelWidths` ★★주). 같은 자리에
     다른 것이 놓이므로 알맞은 폭도 다르다 — 갤러리의 폴더 트리와 생성의 옵션 패널. */
  const leftWidth = leftWidths[mode];
  const rightWidth = rightWidths[mode];
  // ★접힘도 모드마다 따로다 (`PanelFolds` 의 ★★주) — 갤러리의 그림 정보와 생성의 카드덱
  const leftCollapsed = leftFolds[mode];
  const rightCollapsed = rightFolds[mode];
  const t = useI18n((s) => s.t);
  /** 접힌 레일의 점 — 도는 중인가 · 접어 둔 사이에 끝났는가 (`Rail` 의 `dot`) */
  const aiBusy = useLlm((s) => s.sending);
  const aiUnread = useLlm((s) => s.unread);
  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column" }}>
      <TitleBar left={titleLeft} right={titleRight} />

      {/* ★AI 기둥은 **탭 행 바깥**이다 (사용자 지시 2026-08-08). 탭 행 아래에 두면
          싱글/멀티에 속한 것처럼 보이는데, 대화는 탭이 아니라 **워크스페이스** 것이다.
          갤러리 모드의 좌측 기둥처럼 타이틀바 밑부터 하단바 위까지 세로로 다 쓴다. */}
      <div style={{ flex: 1, display: "flex", minHeight: 0 }}>
        {ai &&
          (aiCollapsed ? (
            /* ★★접어 두면 화면에 흔적이 없다 — 점 하나로 「도는 중」과 「끝났다」를 알린다
                 (사용자 지시 2026-08-26). 펴면 사라진다 (`useUi.toggleAi`). */
            <Rail
              side="left"
              label={t("ai.title")}
              onExpand={toggleAi}
              dot={aiBusy ? "busy" : aiUnread ? "done" : null}
            />
          ) : (
            <>
              <section
                style={{
                  width: aiWidth,
                  flexShrink: 0,
                  minWidth: 0,
                  display: "flex",
                  flexDirection: "column",
                  background: "var(--bg)",
                  borderRight: "1px solid var(--line)",
                }}
              >
                <PanelHeader side="left" title={t("ai.title")} onCollapse={toggleAi} />
                {ai}
              </section>
              <ResizeHandle
                width={aiWidth}
                setWidth={setAiWidth}
                onCommit={commitLayout}
                min={260}
                max={520}
                side="left"
              />
            </>
          ))}

        {/* 탭 행부터 아래로는 **AI 오른쪽**에서만 흐른다 */}
        <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
          {tabs && (
            <div
              data-tabs-row
              // ★여백·테두리는 **탭 줄 자신이** 갖는다 (두 층의 선이 서로 다르다)
              style={{ flexShrink: 0, background: "var(--bg)" }}
            >
              {tabs}
            </div>
          )}

          <main style={{ flex: 1, display: "flex", minHeight: 0 }}>
        {hideLeft ? null : leftCollapsed ? (
          <Rail side="left" label={leftLabel} onExpand={toggleLeft} footer={leftFooterCompact} />
        ) : (
          <>
            <section
              style={{
                width: leftWidth,
                flexShrink: 0,
                minWidth: 0,
                display: "flex",
                flexDirection: "column",
                background: "var(--bg)",
                borderRight: "1px solid var(--line)",
              }}
            >
              <PanelHeader
                side="left"
                title={leftLabel}
                onCollapse={toggleLeft}
                extra={leftHeaderRight}
              />
              {/* ★푸터는 스크롤 **밖**이다 — 안에 있으면 프롬프트를 내릴 때 생성 버튼이
                  같이 밀려 올라간다 (페로픽스파이 `params-footer` 와 같은 자리) */}
              {/* ★표식이 있어야 「설정 불러오기」가 **보던 자리를 고정**할 수 있다
                  (`lib/keepScroll`) — 불러오면 접힌 묶음이 펴지고 내용이 늘어 화면이 움직인다 */}
              <div
                data-left-scroll
                style={{ flex: 1, minHeight: 0, overflowY: "auto", display: "flex", flexDirection: "column" }}
              >
                {left}
              </div>
              {leftFooter}
            </section>
            {/* ★서랍은 패널을 **덮지 않는다** — 덮으면 끌어다 놓을 자리가 가려진다 */}
            {leftDrawer}
            <ResizeHandle
              width={leftWidth}
              setWidth={setLeftWidth}
              onCommit={commitLayout}
              min={300}
              max={640}
              side="left"
            />
          </>
        )}

        {/* ★`position: relative` — 번역 창(`TranslatePanel`)이 이 칸의 왼쪽 위, 곧 왼쪽 패널
            바로 오른쪽에 붙는다 (사용자 지시 2026-08-29) */}
        <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", position: "relative" }}>
          {center}
          {centerKeep}
        </div>

        {hideRight ? null : rightCollapsed ? (
          <Rail side="right" label={rightLabel} onExpand={toggleRight} />
        ) : (
          <>
            <ResizeHandle
              width={rightWidth}
              setWidth={setRightWidth}
              onCommit={commitLayout}
              min={220}
              max={420}
              side="right"
            />
            <section
              style={{
                width: rightWidth,
                flexShrink: 0,
                minWidth: 0,
                display: "flex",
                flexDirection: "column",
                background: "var(--bg)",
                /* ★끌고 있을 때의 강조는 **덱 줄 자신**이 한다 (`DeckPanel` 의 ★주) —
                   어둠 위로 올라와 밝게 남는 방식이라 여기서 테두리를 그리지 않는다 */
                borderLeft: "1px solid var(--line)",
              }}
            >
              <PanelHeader side="right" title={rightLabel} onCollapse={toggleRight} />
              <div style={{ flex: 1, minHeight: 0, overflowY: "auto" }}>{right}</div>
            </section>
          </>
        )}
          </main>
        </div>
      </div>

      <BottomNav right={navRight} />
    </div>
  );
}

/** 패널 머리 — ★접기 버튼은 **안쪽(가운데 쪽) 가장자리**에 둔다 (사용자 지시 2026-08-04).
 *  바깥 끝(앱의 좌우 끝)에 두면 창 조작 버튼처럼 보여 무엇을 접는 것인지 헷갈린다.
 *  좌 패널은 오른쪽 끝, 우 패널은 왼쪽 끝 — 접히는 방향과 버튼 자리가 같아진다. */
function PanelHeader({
  side,
  title,
  onCollapse,
  extra,
}: {
  side: "left" | "right";
  title: string;
  onCollapse: () => void;
  /** 접기 버튼 **왼편**에 붙는 것 — 패널 고유의 단추 (블록 저장소 등) */
  extra?: ReactNode;
}) {
  const t = useI18n((s) => s.t);
  const btn = (
    <PanelCollapseButton
      side={side}
      collapsed={false}
      onClick={onCollapse}
      /* ★★`data-tip` 으로 넘기면 **그 값이 버려진다** (2026-08-19 조작 테스트에서 잡았다) —
         이 컴포넌트가 받는 것은 `title` 이고, 하이픈이 든 프롭은 타입 검사도 안 걸린다.
         그래서 툴팁이 이름 없는 「 접기」(앞에 빈칸)로 떴다. */
      title={t("panel.collapse", { name: title })}
    />
  );
  return (
    <div
      style={{
        height: 32,
        flexShrink: 0,
        display: "flex",
        alignItems: "center",
        borderBottom: "1px solid var(--line)",
      }}
    >
      {side === "right" && btn}
      <b
        style={{
          flex: 1,
          padding: "0 var(--sp-4)",
          fontSize: "var(--text-xs)",
          color: "var(--ink-soft)",
          textAlign: side === "left" ? "left" : "right",
        }}
      >
        {title}
      </b>
      {extra}
      {side === "left" && btn}
    </div>
  );
}
