import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "../i18n";
import { DropLine } from "../components/DropLine";
import { useGen } from "../store/gen";
import { usePrompt } from "../store/prompt";
import { runningPendingId, useQueue } from "../store/queue";
import { LANE_MAX, LANE_MIN, useUi } from "../store/ui";
import { allCells, useWs, takesOfScene, type Rec, type SceneCard, type Slot } from "../store/workspace";
import { newestFirst } from "../lib/takes";
import { applyCard } from "../lib/applyCard";
import { TYPE } from "../styles/type";

import { imgUrl, thumbUrlOf } from "../lib/imgUrl";
import { Icon } from "../components/Icon";
import { Dropdown } from "../components/Dropdown";
import { Ratio, RATIO_LANDSCAPE, RATIO_PORTRAIT } from "../components/Ratio";
import { kindColor } from "../cards/kindColor";
import { slotBlock, slotBlocksOf } from "../lib/blocks";
import { BlockList } from "../blocks/BlockList";
import { DropVeil } from "../cards/DropVeil";
import { useDragSource, useDropZone } from "../cards/dragStore";
import { askThumb } from "../cards/thumbAsk";
import { FittedImg } from "../cards/FittedImg";
import { useThumbView } from "./PromptSections";
import { DragGhost } from "../cards/DragGhost";
import { useLaneReorder, type LaneDrop } from "../lib/useReorder";
import { useSceneFocus } from "../store/sceneFocus";
import { removeTakes, stepScene, stepTake, visibleTakes } from "../lib/sceneTakes";
import { clearUndo, undoLast } from "../lib/undo";
// ★`t` 는 **모듈 것**을 쓴다 — 이 파일 안에서 `t` 는 이벤트 대상 이름으로 자주 가려진다
import { t as tr } from "../i18n";
import { toast } from "../store/toast";
import { useRename } from "../components/useRename";
import { ask } from "../store/ask";
import { usePreviews, withPreviews, isPreviewFile } from "../store/previews";
import { BANNER_BG, bannerEmptyFill } from "../cards/banner";

/** 드롭다운 **목록 항목**의 색 — 팝업은 브라우저가 따로 그리므로 색을 직접 준다
 *  (다크 모드에서 밝은 글자가 밝은 바탕에 얹히던 자리, 사용자 지적 2026-08-22). */
/** 씬 칸 — **그릇**이고, 그 위에 **씬 세트 카드**를 얹는다 (사용자 결정 2026-08-11).
 *
 *  ★층이 셋이다: 씬 칸(평면) → 카드(둥근 카드) → 씬(줄). 그릇이 둥글고 카드가 납작하면
 *    층이 뒤집혀 읽히므로, 올라온 것은 **언제나 카드**다.
 *  ★눈금 줄은 **그릇 것**이라 카드가 몇 장이든 하나로 이어진다 — 그것이 "카드가 얹혀 있다"를
 *    눈으로 만든다. 숫자는 그 줄의 **몇 번째 장**이고, 축에 이름을 붙이지 않는다
 *    (「회차」는 다른 뜻으로 읽힌다 — 사용자 지적).
 *  ★씬의 프롬프트는 **줄 머리 안**에 산다. 왼쪽 패널에 슬롯 목록을 따로 두면 같은 씬이
 *    두 곳에 있게 되어, 이름·자물쇠가 겹친다.
 *
 *  설계 정본은 `docs/timeline-mockup.html` (합의된 화면). */

/** ★칸은 **정사각**이고 크기는 연속값이다 (사용자 지시 2026-08-14).
 *  예전에는 폭을 생성 해상도 비율에서 뽑았는데, 해상도를 크게 잡으면 칸이 그만큼 길어져
 *  줄이 통째로 망가졌다 (1536×640 이면 칸 하나가 336px). 그림은 잘라서 보여 준다.
 *  ★3단 버튼도 없앴다. Ctrl+휠 한 번에 12% 씩 움직인다 (`store/ui` 의 LANE_MIN·LANE_MAX). */
const ZOOM = 1.12;
const GAP = 6;

export function SceneLane() {
  const t = useI18n((s) => s.t);
  const base = useGen((g) => g.base);
  const { records, current: ws, activeSceneGroup, isStarred, toggleStar,
    patchSceneGroup, setCard, addCard, removeCard, addSlot, moveScene, moveCard } = useWs();
  const pending = useQueue((s) => s.pending);
  const laneSize = useUi((u) => u.laneSize);
  /** 씬을 아래에 두나 오른쪽에 두나 — 무대를 그리는 것은 `Canvas`, 켜고 끄는 것은 여기다 */
  const laneSide = useUi((u) => u.laneSide);
  /** ★★**세로 모드에서는 줄이 통째로 90° 돈다** (사용자 지시 2026-08-22).
   *
   *    아래에 있을 때   씬은 세로로 쌓이고, 한 씬의 장들이 **가로로** 흐른다
   *    오른쪽에 있을 때 씬은 **세로 기둥**이 되어 **오른쪽으로** 늘어서고, 장들이 아래로 쌓인다
   *
   *  ★세로용 컴포넌트를 따로 만들지 않는다 — 같은 것에 **축만 넘긴다**(`vert`). 두 벌이면
   *    고칠 때마다 맞춰야 하고, 한쪽만 고쳐진 채로 남는다.
   *  ★머리 크기는 **모드마다 따로 기억한다** (`laneHeadW` 폭 · `laneHeadH` 높이) — 한 값을
   *    나눠 쓰면 한쪽에서 끈 것이 다른 쪽을 엉뚱하게 두껍게 만든다. */
  const vert = laneSide === "right";
  /** 씬 머리의 **그 축 크기** — 아래 모드면 폭, 세로 모드면 높이 */
  const headw = useUi((u) => (vert ? u.laneHeadH : u.laneHeadW));
  /** 전역 키 임자는 한 번만 매다므로(`window`) 축은 ref 로 읽는다 */
  const vertRef = useRef(vert);
  vertRef.current = vert;
  /** 미저장 그림 — ★저장된 것과 **같은 목록**에 얹는다 (`store/previews.ts`) */
  const previews = usePreviews((s) => s.items);
  const startDrag = useDragSource();
  // ★씬 프롬프트 목적지 — 켜져 있는 캐릭터만 고를 수 있다 (꺼진 캐릭터는 payload 에 없다)
  const chars = usePrompt((s) => s.chars).filter((c) => c.on);
  const tab = activeSceneGroup();

  /** 지금 보고 있는 씬과 장 — ★프리뷰가 다른 컴포넌트라 스토어로 나눠 갖는다 */
  const focus = useSceneFocus();
  /** 씬 세트 카드를 받는 자리 — **줄 전체**다. 놓으면 카드가 아래에 하나 더 붙는다 */
  const setDrop = useDropZone({
    id: "lane-setzone",
    kind: "posesets",
    prio: 5,
    /* ★★꽂는 규칙은 **공용 함수 하나**다 (`lib/applyCard`, 2026-08-24) — 조수가
       «저장해 둔 포즈세트 올려줘» 를 받을 때 **같은 것**을 부른다. */
    onDrop: (d) => {
      if (d.card) applyCard("posesets", d.card as never);
    },
  });

  /** ★★씬을 고르면 **그 씬의 맨 앞(최신) 장**이 함께 골라진다 (사용자 지시 2026-08-19).
   *  씬만 고르고 그림이 안 골라지면 큰 자리가 비어, 한 번 더 눌러야 뭔가 보였다.
   *  ★파일을 **딱 집어** 넘긴 경우(썸네일 클릭)는 그대로 둔다. */
  const setFocus = (f: { cell: string; file: string | null }) => {
    const cell = tab?.kind === "sceneGroup" ? allCells(tab).find((c) => c.id === f.cell) : undefined;
    const takes = cell ? [...takesOfCell(cell)].sort(newestFirst) : [];
    // ★★**그 씬에 없는 파일은 고른 것이 아니다** (조작 테스트에서 잡았다 2026-08-19).
    //   씬 id 는 탭·워크스페이스마다 다시 `c0` 부터 나가므로, 앞 화면에서 고른 파일이
    //   같은 id 의 다른 씬에 그대로 얹혀 **아무것도 안 골라진 상태**가 됐다 —
    //   그러면 「씬을 고르면 맨 앞 장이 함께 골라진다」가 그 씬에서만 조용히 안 돌았다.
    if (f.file && takes.some((r) => r.file === f.file)) return focus.focus(f.cell, f.file);
    focus.focus(f.cell, takes[0]?.file ?? null);
  };
  /** 손으로 고른 것 — ★**스토어에 산다** (`store/sceneFocus`). 큰 그림 아래 삭제 단추도
   *  같은 것을 봐야 해서 올렸다 (사용자 지시 2026-08-22). 규칙(`selected`·풀기)도 거기 있다. */
  const picked = useSceneFocus((s) => s.picked);
  const selected = useMemo(() => new Set(picked), [picked]);

  const [expandedId, setExpandedId] = useState<string | null>(null);
  /** ★★펼치면서 **곧장 치려는** 것인가 (사용자 지시 2026-08-19: 한 번 눌러 바로 친다).
   *  씬 칸은 이제 블록이라 펼치면 **칩**이 보인다 — 그런데 요약 글자를 누른 것은 거기서부터
   *  적으려는 것이라, 그때만 글 상자를 열어 커서를 넣는다. 머리를 눌러 편 것은 보려는 것이다. */
  const [typingId, setTypingId] = useState<string | null>(null);
  const expand = (id: string | null, typing = false) => {
    setExpandedId(id);
    setTypingId(typing ? id : null);
  };

  /** ★★**글 상자 밖을 누르면 편집이 끝난다** (사용자 지시 2026-08-18).
   *  예전에는 닫는 길이 그 씬의 머리를 다시 누르는 것뿐이라 어디를 눌러도 펼친 채였다.
   *
   *  ★`pointerdown` 을 **잡기 단계**(capture)로 듣는다 — 씬 줄의 가로 스크롤도, 칩 드래그도
   *    pointerdown 에서 시작하므로 버블을 기다리면 그것들이 먼저 삼킨다.
   *  ★★예외는 **글 상자 자신뿐**이다. 처음에는 그 씬 줄(`[data-scene]`) 전체를 예외로 뒀는데,
   *    그러면 **같은 씬의 결과를 골라도 편집이 안 끝났다** (사용자 지적 2026-08-19).
   *    머리를 눌러도 닫힌다 — 내 처리가 먼저 돌아 `null` 이 되고, 뒤이은 머리의 토글은
   *    그 시점에 「펼쳐져 있음」이라 다시 `null` 을 넣는다. 다른 씬을 누르면 그 씬이 열린다. */
  useEffect(() => {
    if (!expandedId) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as HTMLElement | null;
      /* ★★**열려 있는 그 칸**일 때만 비켜 간다. 접힌 줄에도 같은 블록이 있으므로
         (`clamp`) 그냥 `[data-slot-block]` 으로 보면 **다른 씬을 눌러도 안 닫힌다.** */
      if (t?.closest("[data-slot-block]")?.getAttribute("data-slot-block") === expandedId) return;
      /* ★★서랍에서 블록을 끌어오는 중이면 닫지 않는다. 닫으면 받는 자리가 그 자리에서
         **사라져** 아예 놓을 수 없다 — 끌기는 서랍 쪽 `pointerdown` 으로 시작한다. */
      if (t?.closest("[data-block-drawer]")) return;
      expand(null);
    };
    document.addEventListener("pointerdown", onDown, true);
    return () => document.removeEventListener("pointerdown", onDown, true);
  }, [expandedId]);
  /** 이름을 그 자리에서 고치는 중인 씬 — ★**줄이 아니라 여기**가 들고 있다.
   *  Tab 으로 다음 씬의 이름 칸으로 건너뛰려면 누가 열려 있는지를 한 곳이 알아야 한다. */
  const [editingName, setEditingName] = useState<string | null>(null);
  /* ★「고른 것을 한 번에 강화」는 걷었다 (사용자 지시 2026-08-22) — 강화는 큰 그림 아래
     줄에서 **보고 있는 한 장**에 건다 (`Canvas` 의 `SceneActions`). */
  const scrollRef = useRef<HTMLDivElement>(null);
  /** PIP 가 그 안에서만 움직이도록 가두는 상자 (줄 영역) */
  const boxRef = useRef<HTMLDivElement>(null);
  /** ★보이는 자리만 그리려고 재 두는 값 (사용자 지시 2026-08-14).
   *  칸이 560px 까지 커지고 한 줄에 수십 장이 붙으므로, 다 그리면 화면이 무거워진다. */
  const [view, setView] = useState({ x: 0, w: 0 });   // x = 그 축의 스크롤, w = 그 축의 보이는 길이
  /** 머리 폭 손잡이를 잡은 자리 */
  const grip = useRef<{ x: number; w: number } | null>(null);

  /** ★씬·카드를 **줄 전체에서** 끈다 (v2 `index.html:11860-12002`, `docs/v2-port-audit.md` D2).
   *  예전에는 카드 안에서만 순서가 바뀌어, 씬을 다른 카드로 옮기거나 카드끼리 자리를 바꿀
   *  방법이 아예 없었다. 옮긴 뒤 번호가 어떻게 되는지는 `workspace.moveScene` 주석에 있다. */
  const tabIdNow = tab?.id;
  const lane = useLaneReorder({
    scrollRef,
    vert,
    onMoveScene: (cellId, cardId, index) => {
      if (tabIdNow) moveScene(tabIdNow, cellId, cardId, index);
    },
    onMoveCard: (cardId, index) => {
      if (tabIdNow) moveCard(tabIdNow, cardId, index);
    },
  });

  // 스크롤·크기가 바뀌면 보이는 구간을 다시 잰다 (rAF 로 한 번만)
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    let raf = 0;
    const measure = () => {
      raf = 0;
      const x = vert ? el.scrollTop : el.scrollLeft;
      const w = vert ? el.clientHeight : el.clientWidth;
      setView((v) => (v.x === x && v.w === w ? v : { x, w }));
    };
    const onScroll = () => { if (!raf) raf = requestAnimationFrame(measure); };
    measure();
    el.addEventListener("scroll", onScroll, { passive: true });
    const ro = new ResizeObserver(onScroll);
    ro.observe(el);
    return () => {
      el.removeEventListener("scroll", onScroll);
      ro.disconnect();
      if (raf) cancelAnimationFrame(raf);
    };
  }, [vert]);

  /** ★슬롯 자리를 잡아 **좌우로 끈다** (사용자 지시 2026-08-14).
   *
   *  세로는 휠로 쉬운데 가로가 어려웠다. 사진 격자처럼 잡아 끌면 옆으로 넘어간다.
   *  ★4px 을 넘게 움직였을 때만 끄는 것으로 본다. 그보다 작으면 그냥 클릭이라
   *    장을 고르는 조작이 죽으면 안 된다.
   *  ★줄 머리는 뺀다. 거기에는 프롬프트 칸과 단추가 있어 끌면 안 된다.
   *  ★끌기로 판정되는 순간 **포인터를 잡는다**(`setPointerCapture`). 안 잡으면 줄 밖으로
   *    나가는 순간 바깥 UI 가 포인터를 받아, 끌던 것이 끊기고 거기 글자가 선택된다
   *    (사용자 지적 2026-08-15). 잡는 것은 **판정된 뒤**다: 누르자마자 잡으면 클릭의
   *    대상이 바뀌어 장을 고르는 조작이 어긋난다. */
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    let from: { x: number; y: number; sx: number; sy: number } | null = null;
    let moved = false;
    let held = -1;   // 잡고 있는 pointerId (없으면 -1. id 는 0 일 수 있다)
    const down = (e: PointerEvent) => {
      const t = e.target as HTMLElement;
      if (e.button !== 0) return;
      // ★그립은 비켜 간다 — 순서를 바꾸려고 잡은 것이 줄 스크롤로 새면 안 된다.
      // ★★**생성물 칸(`[data-take]`)도 비켜 간다** — 카드 커버로 끌어내는 출발점이라
      //   여기서 잡으면 그림을 끄는 동안 줄이 함께 밀린다 (사용자 지적 2026-08-18).
      //   ★이 리스너는 **네이티브**라 React 핸들러의 `stopPropagation` 으로는 못 막는다
      //     (네이티브 전파가 React 의 합성 이벤트보다 먼저 지나간다). 여기서 걸러야 한다.
      if (t.closest("[data-scene-head], [data-card-grip], [data-take], input, textarea, select, [contenteditable='true']")) return;
      from = { x: e.clientX, y: e.clientY, sx: el.scrollLeft, sy: el.scrollTop };
      moved = false;
    };
    const move = (e: PointerEvent) => {
      if (!from) return;
      // ★버튼이 떨어졌으면 여기서 끝낸다. `pointerup` 을 못 받는 경우가 있는데
      //   (브라우저 기본 그림 끌기가 포인터를 가져가면 그렇다) 그대로 두면
      //   **버튼을 안 눌러도 마우스를 움직이는 것만으로 줄이 따라 움직인다.**
      if ((e.buttons & 1) === 0) { up(); return; }
      const dx = e.clientX - from.x;
      const dy = e.clientY - from.y;
      if (!moved && Math.abs(dx) + Math.abs(dy) < 4) return;
      if (!moved) {
        moved = true;
        held = e.pointerId;
        try { el.setPointerCapture(e.pointerId); } catch { /* 이미 놓쳤으면 그냥 간다 */ }
        // 끌리는 동안 바깥 글자가 선택되지 않게
        el.style.userSelect = "none";
      }
      // 글자 선택·기본 끌기를 막는다. 이 시점에는 클릭을 이미 삼키기로 한 뒤다
      e.preventDefault();
      el.style.cursor = "grabbing";
      el.scrollLeft = from.sx - dx;
      el.scrollTop = from.sy - dy;
    };
    const up = () => {
      from = null;
      el.style.cursor = "";
      el.style.userSelect = "";
      if (held >= 0) {
        try { el.releasePointerCapture(held); } catch { /* 이미 놓였으면 그만 */ }
        held = -1;
      }
      // ★표식을 **다음 차례에** 지운다. 클릭은 손을 떼자마자 같은 차례에 오므로 그때는
      //   아직 살아 있어 삼켜지고, 그 뒤로는 깨끗해진다.
      //   ★안 지우면 끌고 난 다음의 **진짜 클릭 한 번이 통째로 죽는다** (실측 2026-08-14:
      //     끈 뒤에 다른 장을 눌러도 안 골라졌다). 끌기가 클릭 이벤트를 안 내는 경우가 있다.
      setTimeout(() => { moved = false; }, 0);
    };
    // ★끌었으면 그 뒤의 클릭을 삼킨다. 안 그러면 손을 뗀 자리의 장이 골라진다
    const click = (e: MouseEvent) => {
      if (!moved) return;
      moved = false;
      e.stopPropagation();
      e.preventDefault();
    };
    // ★기본 그림 끌기를 막는다. 시작되면 포인터 이벤트가 끊겨 끌기도 클릭도 어긋난다.
    //   ★`pointerdown` 에서 preventDefault 로 막지 말 것. 그러면 호환 click 이 사라져
    //     장을 고르는 조작이 통째로 죽는다 (CLAUDE.md 의 잊기 쉬운 것)
    const noDrag = (e: DragEvent) => e.preventDefault();
    el.addEventListener("dragstart", noDrag);
    el.addEventListener("pointerdown", down);
    // 포인터를 뺏겼으면 끌기도 거기서 끝난다 (창을 벗어나거나 다른 창으로 갔을 때)
    el.addEventListener("lostpointercapture", up);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    el.addEventListener("click", click, true);
    return () => {
      el.removeEventListener("dragstart", noDrag);
      el.removeEventListener("pointerdown", down);
      el.removeEventListener("lostpointercapture", up);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      el.removeEventListener("click", click, true);
    };
  }, []);

  /** 휠 — **어디에 얹혀 있나로 갈린다.**
   *
   *      Ctrl(⌘) + 휠            칸 크기
   *      썸네일 영역 위          **좌우** 스크롤 (그림 사이 배경까지 그 영역이다)
   *      그 밖(머리·씬 이름)     평소대로 위아래
   *
   *  ★★썸네일은 **가로로** 늘어서므로 그 위에서 위아래로 굴리는 것은 뜻이 없다
   *    (사용자 지시 2026-08-21). 한 줄에 수십 장이 놓이는 자리라 좌우가 기본 동작이어야 한다.
   *  ★**네이티브 리스너로 붙인다.** React 의 `onWheel` 은 뿌리에 passive 로 달려서
   *    `preventDefault()` 가 안 먹고, 그러면 Ctrl+휠이 웹뷰 **확대**로 새어 나가고
   *    좌우 전환도 세로 스크롤과 함께 일어난다. */
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        const cur = useUi.getState().laneSize;
        useUi.getState().setLaneSize(e.deltaY < 0 ? cur * ZOOM : cur / ZOOM);
        return;
      }
      // 이미 가로로 굴리고 있으면(터치패드·Shift) 브라우저에 맡긴다
      if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
      const t = e.target as HTMLElement | null;
      const onTakes = !!t?.closest?.("[data-scene-takes]");
      /* ★★세로 모드에서는 **정반대**다 (사용자 지시 2026-08-22):
           그림 위     장이 아래로 쌓이므로 **위아래가 곧 그 방향** — 가로채지 않는다
           그 밖       씬이 오른쪽으로 늘어서므로 **좌우로** 굴린다 */
      if (vert) {
        if (onTakes) return;
        if (el.scrollWidth - el.clientWidth <= 0) return;
        e.preventDefault();
        el.scrollLeft += e.deltaY;
        return;
      }
      if (!onTakes) return;
      // ★가로로 넘칠 것이 없으면 **가로채지 않는다** — 안 그러면 그림이 몇 장 없을 때
      //   썸네일 위에서 휠이 통째로 죽어(위아래도 안 된다) 줄이 멈춘 것처럼 보인다
      if (el.scrollWidth - el.clientWidth <= 0) return;
      e.preventDefault();
      el.scrollLeft += e.deltaY;
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [vert]);

  /** ★★**고른 장은 언제나 보인다** (사용자 지시 2026-08-21).
   *
   *  ★칸은 **다 그리지 않는다** — 보이는 구간 앞뒤 두 칸씩만 그린다(`SceneRow` 의 `from`/`to`).
   *    그래서 `scrollIntoView` 를 쓸 수 없다: 화면 밖의 장은 **요소가 아예 없다.**
   *    대신 자리를 **계산**한다 — 칸은 `머리폭 + 8 + 번호 × (칸 + 틈)` 에 선다.
   *  ★왼쪽 여백은 **줄 머리만큼** 둔다 — 머리가 `sticky` 라 그 밑으로 들어가면 가려진다.
   *  ★세로는 요소로 한다 (줄 자체는 언제나 그려진다). */
  const focusCell = focus.cell;
  const focusFile = focus.file;
  /* ★★골라 둔 대기 칸이 사라졌는데 **아직 아무것도 안 고른 상태로 남아 있으면** 놓는다
       (안 그러면 빈 화면에 갇힌다).
     ★평소에는 여기까지 오지 않는다 — 그림이 나오는 순간 `queue.consumePending` 이
       **나온 장으로 옮겨** 주기 때문이다 (사용자 지적 2026-08-23: 완료되면 선택이 풀렸다).
       여기 남은 것은 그림 없이 사라진 경우(취소·실패)를 위한 마지막 방어선이다. */
  const focusPending = focus.pending;
  useEffect(() => {
    if (!focusPending) return;
    if (pending.some((q) => q.id === focusPending)) return;
    /* ★그림 없이 사라진 경우(취소·실패)의 **마지막 방어선**이다 — 빈 화면에 갇히지 않게 놓는다.
       ★그림이 나온 경우는 여기까지 오지 않는다: `store/queue` 의 `render` 가 그림이 도착하는
         그 자리에서 **보고 있는 씬인지**만 보고 옮겨 준다 (대기 장부와 무관하다). */
    useSceneFocus.getState().focus(useSceneFocus.getState().cell, null);
  }, [focusPending, pending]);

  /* ★★**고른 것이 바뀔 때만** 굴린다 (사용자 지시 2026-08-22).
       예전에는 `pending`·`laneSize`·`headw` 도 딸림값이라, **생성이 끝나 큐가 줄기만 해도**
       줄이 저 혼자 굴러갔다 (*"생성 완료시 슬롯을 강제 스크롤"*).
       나머지 값은 굴릴 이유가 아니라 **자리를 셈할 재료**일 뿐이므로 ref 로 읽는다. */
  const scrollBits = useRef({ pending, headw, laneSize, vert, groupId: tab?.id });
  scrollBits.current = { pending, headw, laneSize, vert, groupId: tab?.id };
  useEffect(() => {
    const el = scrollRef.current;
    /* ★★**「생성 중」 칸을 골랐을 때도 굴린다** (사용자 지적 2026-08-25: *"생성 중인 걸 휠로
         전환해서 선택했을 때 씬 슬롯 자동 스크롤을 안 해 줌"*).
       대기 칸에는 **파일이 없다** — 예전에는 `focusFile` 이 비면 통째로 물러나서, 휠로
       대기 칸에 닿는 순간 줄이 멈춘 채였다. 고를 수 있는 것은 둘이므로 둘 다 받는다. */
    if (!el || !focusCell || (!focusFile && !focusPending)) return;
    const { pending, headw, laneSize, vert, groupId } = scrollBits.current;
    const waiting = pending.filter((p) => p.groupId === groupId && p.cellId === focusCell).length;
    const cw = Math.min(LANE_MAX, Math.max(LANE_MIN, laneSize));
    const step = cw + GAP;
    /* ★셈은 폴백이다 (아래 ★★주) — 대기 칸은 줄의 **앞쪽**에 늦게 넣은 것부터 선다 */
    let slot = 0;
    if (focusFile) {
      const at = visibleTakes(focusCell).findIndex((r) => r.file === focusFile);
      if (at < 0) return;
      slot = waiting + at;
    } else {
      const at = pending
        .filter((p) => p.groupId === groupId && p.cellId === focusCell)
        .findIndex((p) => p.id === focusPending);
      if (at < 0) return;
      slot = waiting - 1 - at;   // 줄은 뒤집어 그린다 (`SceneRow` 의 `waits`)
    }
    const lead = headw + 8 + slot * step;

    // ★장이 늘어서는 축 — 줄 머리에 가리지도, 끝으로 넘치지도 않게
    const pos = vert ? el.scrollTop : el.scrollLeft;
    const size = vert ? el.clientHeight : el.clientWidth;
    /* ★★**그려져 있으면 실제 자리를 잰다** (사용자 지적 2026-08-25: *"세로 모드일 때는
         현재 선택된 이미지가 경계선에 걸려 있어도 온전하게 보이게 스크롤을 안 해 줌"*).
       셈으로만 잡던 자리가 세로 모드에서 어긋났다 — 그 모드에서는 **카드 배너**(`HEAD_H`)가
       씬 머리 위에 한 줄 더 눕는데 셈에는 그 높이가 없어서, 늘 그만큼 덜 굴렀다.
       ★배너 높이를 셈에 더하는 대신 **재는 쪽**으로 갔다: 자리를 정하는 것은 레이아웃이고
         셈은 그것을 옮겨 적은 사본이라, 배치가 바뀔 때마다 또 어긋난다.
       ★잴 수 없을 때(멀리 있는 장은 요소가 아예 없다 — 위 ★주)만 셈으로 물러선다. */
    /* ★대기 칸은 `data-pending-cell` 로 선다 — 파일이 없으니 열쇠가 다르다 */
    const node = el.querySelector<HTMLElement>(
      focusFile
        ? `[data-take="${CSS.escape(focusFile)}"]`
        : `[data-pending-cell="${CSS.escape(focusPending!)}"]`,
    );
    const box = el.getBoundingClientRect();
    const r = node?.getBoundingClientRect();
    const at0 = r ? (vert ? r.top - box.top + el.scrollTop : r.left - box.left + el.scrollLeft) : lead;
    const span = r ? (vert ? r.height : r.width) : cw;
    let next = pos;
    if (at0 < pos + headw) next = at0 - headw - 8;
    else if (at0 + span > pos + size) next = at0 + span - size + 8;
    if (next !== pos) {
      if (vert) el.scrollTop = next;
      else el.scrollLeft = next;
    }
    // ★씬이 늘어서는 축 — 그 씬이 화면 밖이면 끌어온다 (씬 자체는 언제나 그려진다)
    const row = el.querySelector<HTMLElement>(`[data-scene="${CSS.escape(focusCell)}"]`);
    if (row) {
      const r = row.getBoundingClientRect();
      const b = el.getBoundingClientRect();
      if (vert) {
        if (r.left < b.left) el.scrollLeft -= b.left - r.left;
        else if (r.right > b.right) el.scrollLeft += r.right - b.right;
      } else {
        if (r.top < b.top) el.scrollTop -= b.top - r.top;
        else if (r.bottom > b.bottom) el.scrollTop += r.bottom - b.bottom;
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
    // ★대기 칸도 딸림값이다 — 안 넣으면 휠로 그리 옮겨도 줄이 안 움직인다
  }, [focusCell, focusFile, focusPending]);

  /* ★★탭을 옮기면 **그 탭 몫으로 담아 두고**, 돌아오면 그대로 되살린다
       (사용자 지시 2026-08-22). 예전에는 비웠는데, 돌아왔을 때 보던 장을 다시 찾아
       눌러야 했다. 담고 되살리는 규칙은 `store/sceneFocus` 하나에 있다. */
  /* ★★메모 열쇠는 **워크스페이스까지** 갖는다 (사용자 보고 2026-08-28: 한동안 안 열었던 다른
     워크스페이스에 들어가면 깨진 그림이 떴다). 세트 id 는 워크스페이스마다 `tab_1` 처럼 같은
     씨앗에서 시작해 **서로 겹치므로**, id 만으로 담으면 다른 워크스페이스에서 보던 장이
     되살아나 이 워크스페이스에 **없는 파일**을 가리킨다. */
  const focusKey = tab ? `${ws}/${tab.id}` : undefined;
  /** ★★**처음 뜰 때는 놓지 않는다** (사용자 지적 2026-08-19: 인페인트에 들어갔다 나오면
   *  고른 것이 풀려 있었다). 마스크 편집기는 캔버스 자리를 통째로 차지해서 이 줄이 **언마운트**
   *  되고, 돌아올 때 다시 마운트된다 — 그때마다 이 효과가 돌아 골라 둔 장을 지웠다.
   *  탭이 **실제로 바뀐 때만** 놓는다. */
  const lastTab = useRef(focusKey);
  useEffect(() => {
    if (lastTab.current === focusKey) return;
    const prev = lastTab.current;
    lastTab.current = focusKey;
    // ★고른 것은 `switchTab` 이 함께 푼다 (`store/sceneFocus`)
    useSceneFocus.getState().switchTab(prev, focusKey);
    clearUndo();   // ★없어진 블록·그림을 되살리려 들면 안 된다
  }, [focusKey]);

  // Del = 숨김(휴지통) · Ctrl+Z = 되돌리기 · Esc = 선택 해제 (멀티 무대의 규칙 그대로)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable) return;
      if (e.key === "Escape" && picked.length) return useSceneFocus.getState().setPicked([]);
      if (e.key === "Delete" || e.key === "Backspace") {
        /* ★★고른 **한 장**도 Del 로 지운다 (사용자 지시 2026-08-19), 여러 장을 골랐으면
           **전부**. 지운 뒤에는 **오른쪽 장**으로 옮겨 간다 (없으면 왼쪽) — 줄은 최신이
           왼쪽이라 오른쪽이 '그 다음으로 옛것'이다.
           ★규칙은 `lib/sceneTakes.removeTakes` **하나**다 — 큰 그림 아래 삭제 단추도 같은
             것을 부른다. 나눠 적었더니 키와 단추의 동작이 갈렸다 (사용자 지적 2026-08-21). */
        if (removeTakes().length) e.preventDefault();
        return;
      }
      /* ★★고른 장이 있으면 **방향키로 장을 넘긴다** (사용자 지시 2026-08-21).
         예전에는 브라우저 기본대로 줄이 **스크롤**됐다 — 그림을 견주려고 방향키를 눌렀는데
         화면만 밀렸다. 아무것도 안 골랐을 때는 평소대로 스크롤이다.
         ★★**장이 늘어선 방향의 키**다 (사용자 지시 2026-08-22): 아래 모드는 좌우,
           세로 모드는 위아래.
         ★★**직각 방향은 씬을 오간다** (사용자 지시 2026-08-28: *"방향키 위아래로 하면 씬 간에
           전환되게 해 줘. 세로 모드에선 반대로 작동하고"*). 씬이 늘어선 방향이 곧 그 축이다 —
           아래 모드는 씬이 위아래로 쌓이고, 세로 모드는 좌우로 선다. 두 축이 언제나 직각이라
           외울 것이 하나뿐이다: **장은 장이 늘어선 쪽으로, 씬은 씬이 늘어선 쪽으로.** */
      const vert = vertRef.current;
      const fwd = vert ? "ArrowDown" : "ArrowRight";
      const back = vert ? "ArrowUp" : "ArrowLeft";
      const nextScene = vert ? "ArrowRight" : "ArrowDown";
      const prevScene = vert ? "ArrowLeft" : "ArrowUp";
      if (e.key === fwd || e.key === back || e.key === nextScene || e.key === prevScene) {
        /* ★★★**우리가 맡은 키는 브라우저에게 안 넘긴다** (사용자 지적 2026-08-28:
             *"씬 전환은 잘 되는데 그냥 상하 누르면 원래 조금씩 스크롤되던 게 같이 먹는다"*).
           앞 판은 **한 칸 옮겼을 때만** 막았다. 그래서 옮길 자리가 없을 때(줄의 끝, 씬의 끝)
           브라우저 기본 동작이 그대로 살아나 화면이 조금씩 밀렸다 — 옮겨지지도 않고 밀리기만
           하니 「같이 먹는다」로 보인다.
           ★막는 기준은 **성공 여부가 아니라 임자**다: 씬을 고른 상태면 이 네 키는 줄의 것이다.
             아무것도 안 골랐을 때만 평소대로 브라우저에 넘긴다 (위 ★★주의 규칙 그대로). */
        if (!useSceneFocus.getState().cell) return;
        e.preventDefault();
        if (e.key === fwd || e.key === back) stepTake(e.key === fwd ? 1 : -1);
        else stepScene(e.key === nextScene ? 1 : -1);
        return;
      }
      if ((e.ctrlKey || e.metaKey) && (e.key === "z" || e.key === "Z")) {
        /* ★★**로그 하나만 본다** (사용자 지시 2026-08-22: *"컨트롤+z를 했을 때 사용자의
             기대는 마지막에 수정한 걸 되돌리는거임"*). 예전에는 스택이 둘이라 `칩 || 선별`
             순서로 물었고, 그래서 방금 그림을 지웠어도 **칩이 먼저** 되돌아갔다.
           ★전역 키 임자는 여기 하나다 — 두 곳에서 window 에 매달면 등록 순서에 따라
             **둘 다** 돌아 두 걸음이 한 번에 되돌아간다.
           ★되돌린 것의 **이름을 알린다** — 갈래가 여럿이라 안 알리면 무엇이 돌아왔는지 모른다. */
        const what = undoLast();
        if (what) {
          e.preventDefault();
          toast(tr("common.undone", { what }));
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [picked]);

  /** ★★**훅은 이른 반환보다 위에 둔다** — 아래 `tab?.kind !== "sceneGroup"` 에서 빠지므로,
   *  그 밑에 두면 탭을 옮길 때마다 훅 개수가 달라져 **화면이 통째로 죽는다**
   *  (*"Rendered fewer hooks than expected"*). 사용자 실측 2026-08-25: 워크스페이스·탭을
   *  바꾸면 UI 가 안 그려졌다. 같은 함정을 `StyleSection` 이 먼저 밟았다.
   *
   *  서버가 지금 만들고 있는 씬 — 이 세트의 것일 때만 쓴다 (`store/queue` 의 `current_cell`) */
  /** ★「별표만 보기」 — 훅이라 **이른 반환보다 위**에 둔다 (바로 위 ★★주) */
  const starOnly = useUi((u) => u.laneStarOnly);
  /** 칸별 **그리는 중인 그림** — 훅이라 이른 반환보다 위에 둔다 */
  const steps = useQueue((q) => q.steps);
  /** 지금 그리고 있는 **대기 칸의 번호**.
   *  ★★셈하는 규칙은 `store/queue.runningPendingId` **하나**다 (큰 그림도 같은 답을 본다).
   *  ★★**구독해서 읽는다.** `getState()` 로만 읽으면 진행이 바뀌어도 다시 안 그려
   *    「생성 중」이 영영 안 뜬다 (사용자 지적 2026-08-14). 고르개가 스토어가 바뀔 때마다
   *    돌고, 값이 그대로면 리액트는 다시 그리지 않는다. */
  const runId = useQueue(() => runningPendingId(tab?.id));

  if (tab?.kind !== "sceneGroup") return null;

  /** ★「캐릭터 전원」은 **켜진 캐릭터가 둘 이상일 때만** 낸다 (사용자 결정) —
   *  한 명이면 그 사람을 고르는 것과 같아서 뜻이 없다. */
  const canAll = chars.length > 1;
  // ★고른 캐릭터가 꺼지거나 지워졌으면 base 로 되돌린다 — 없는 곳으로 보내면 조용히 사라진다.
  //   ★판정이 `gen.ts generateAll` 과 **같아야** 화면에 뜬 것과 실제로 나가는 것이 안 갈린다
  //   (회귀 `lib/sceneDest.test.ts` 가 두 파일의 규칙 줄을 대조한다).
  const dest =
    tab.sceneDest === "all" && canAll
      ? "all"
      : chars.some((c) => c.id === tab.sceneDest)
        ? tab.sceneDest!
        : "base";

  const h = Math.min(LANE_MAX, Math.max(LANE_MIN, laneSize));
  const w = h;
  const queued = pending.filter((p) => p.groupId === tab.id);

  /** 그 씬의 결과 (숨긴 것 제외).
   *  ★갈 씬이 없는 결과는 **첫 씬**이 받는다 (`takesOfScene`, v2 이식 — 감사 D6)
   *  ★미저장 그림도 **같은 목록**에서 같은 규칙으로 갈린다 (`withPreviews`) — 저장 여부는
   *    칸의 생김새만 가르고, 어느 씬 것인지는 여전히 `takesOf` 가 판정한다.
   *  ★「별표만 보기」는 여기서 한 번만 건다. 별표는 파일 경로로 저장되므로 **미저장 그림은
   *    별표를 달 수 없고**, 그래서 거르면 함께 빠진다 (별표는 거르는 장치다). */
  const cells = allCells(tab);
  const all = withPreviews(records, ws, previews);
  const takesOfCell = (c: Slot) =>
    takesOfScene(all, tab, cells, c).filter((r) => !starOnly || isStarred(r.file));
  /** ★「정리」 — **이 씬 그룹의 미저장 그림 전부**를 버린다 (사용자 지시 2026-08-30: 한 장에
   *  딸린 단추가 아니라 씬 헤더의 별표 옆). 어느 씬에 속하는지는 줄과 같은 창구(`takesOfScene`)로
   *  센다 — 갈 씬이 없는 결과는 첫 씬이 받으므로(감사 D6) `cell_id` 로 직접 거르면 빠진다.
   *  ★확인창을 거친다 — 미저장 그림은 메모리에만 있어 되돌릴 수 없다. */
  const staleFiles = cells
    .flatMap((c) => takesOfScene(all, tab, cells, c))
    .map((r) => r.file)
    .filter(isPreviewFile);
  const sweepPreviews = async () => {
    const n = staleFiles.length;
    if (!n) return;
    if (
      !(await ask({
        title: t("scenes.sweepAsk", { n }),
        body: t("scenes.sweepBody"),
        ok: t("common.delete"),
        cancel: t("common.cancel"),
      }))
    )
      return;
    for (const f of staleFiles) usePreviews.getState().drop(f);
    const fx = useSceneFocus.getState();
    if (fx.file && staleFiles.includes(fx.file)) fx.focus(fx.cell, null);
    toast(t("scenes.swept", { n }));
  };
  /** 별을 단 장이 **몇 개인가** — 거르기 전 목록에서 센다 (거른 뒤에 세면 늘 전부다).
   *  ★단추에 적어 두는 까닭: 0 이면 눌러도 화면이 비므로, 누르기 전에 알아야 한다. */
  const starCount = cells.reduce(
    (n, c) => n + takesOfScene(all, tab, cells, c).filter((r) => isStarred(r.file)).length,
    0,
  );

  /** 카드마다 **앞선 카드들의 씬 수**.
   *  ★줄 앞 번호는 **탭 안에서 통째로** 센다 — 그 값이 곧 파일 이름 앞의 번호이기 때문이다
   *    (`gen.ts generateAll` 의 `cell_no` 는 `allCells(tab)` 에서의 자리다. CLAUDE.md:
   *    "행 앞 번호(001)는 파일 이름 앞의 번호와 같다"). 카드마다 1 로 되돌아가면 씬을
   *    다른 카드로 옮겼을 때 화면의 번호와 저장되는 번호가 갈린다. */
  const offsets: number[] = [];
  tab.cards.reduce((n, k) => (offsets.push(n), n + k.cells.length), 0);

  /** 끌고 있는 것 — ★잔상은 브라우저가 안 그려 주므로 우리가 그린다 (`useReorder` 머리 주석).
   *  ★이름표 하나로는 무엇을 들고 있는지 약해서 **그 모습**을 그린다 (사용자 지시 2026-08-18):
   *    씬이면 그 씬의 최신 장과 이름, 카드면 그 카드의 배너. */
  const dragCard = lane.drag?.kind === "card" ? tab.cards.find((k) => k.id === lane.drag!.id) : null;
  const dragCell = lane.drag?.kind === "scene" ? cells.find((c) => c.id === lane.drag!.id) : null;
  /** 레코드는 만든 차례대로 쌓이므로 **마지막이 최신**이다 (줄은 그것을 뒤집어 왼쪽에 둔다) */
  const dragTake = dragCell ? takesOfCell(dragCell).at(-1) : undefined;

  /** 여러 장 고르기 (사용자 지시 2026-08-22).
   *
   *      Ctrl(⌘) + 클릭   **하나씩** 넣고 뺀다
   *      Shift + 클릭     **지금 보고 있는 장부터 누른 장까지** 전부
   *
   *  ★범위는 **그 씬 안에서**만 잡는다 — 지금 보는 장이 다른 씬이면 어디서 어디까지인지
   *    정할 수가 없다. 그때는 누른 것 하나만 넣는다.
   *  ★차례는 **화면에 보이는 그대로**여야 한다 (`visibleTakes`) — 저장 차례로 세면
   *    눈에 보이는 사이의 것과 실제로 들어가는 것이 갈린다.
   *  ★미저장(파일 없는 그림)은 뺀다 — 고른 것에 걸리는 일이 전부 파일 경로를 보낸다. */
  const pick = (file: string, cellId: string, range: boolean) => {
    const f = useSceneFocus.getState();
    const next = new Set(f.picked);
    /* ★★**처음 고를 때는 보고 있던 장도 함께 담는다** — 하나만 골라도 「그것과 지금 보는 것」
       둘이다 (사용자 지시 2026-08-22). 예전에는 이것을 **쓸 때** 더했는데(`selected`),
       이제 **고른 장이 큰 자리로 올라오므로** 그때 더하면 보던 장이 밀려나 사라진다.
       담는 시점을 여기로 옮기면 목록이 곧 정본이 되어, 뺄 때(토글)도 어긋나지 않는다. */
    if (!next.size && f.file) next.add(f.file);
    if (!range) next.has(file) ? next.delete(file) : next.add(file);
    else {
      const list = visibleTakes(cellId).filter((r) => !r.preview).map((r) => r.file);
      const to = list.indexOf(file);
      const from = f.cell === cellId && f.file ? list.indexOf(f.file) : -1;
      if (to < 0) return;
      if (from < 0) next.add(file);
      else for (let i = Math.min(from, to); i <= Math.max(from, to); i++) next.add(list[i]);
    }
    f.setPicked([...next]);
    /* ★★**마지막에 누른 장을 큰 자리에 띄운다** (사용자 지시 2026-08-22). 여러 장을 고르는
       중에도 방금 누른 것이 보여야 무엇을 담고 있는지 눈으로 따라갈 수 있다.
       ★`focus` 는 고른 것을 **안 푼다** (`store/sceneFocus` 의 ★주) — 그래서 여기서 부를 수 있다. */
    f.focus(cellId, file);
  };

  /** 이름 칸을 열고 닫는다 — ★닫는 쪽은 **자기 것일 때만** 닫는다.
   *  Tab 으로 옮기면 새 칸을 연 **뒤에** 옛 칸의 blur 가 오므로, 그냥 null 로 밀면
   *  방금 연 칸이 다시 닫힌다. */
  const onEditName = (id: string, v: boolean) =>
    setEditingName((cur) => (v ? id : cur === id ? null : cur));

  /** ★씬 사이 `Tab` 이동 (v2 `index.html:11809-11832`).
   *
   *  v2 는 슬롯마다 이름·태그 칸이 늘 떠 있어서 **같은 종류의 칸끼리** 건너뛰었다.
   *  3.0 은 이름은 더블클릭, 태그는 펼쳤을 때만 뜨므로 **그 칸을 열면서** 옮긴다.
   *  ★한 바퀴 돈다 (v2 와 같다) — 마지막에서 Tab 이면 첫 씬으로.
   *  ★카드를 가로질러 센다: 화면에 보이는 순서가 곧 이 순서다. */
  const stepField = (cellId: string, dir: 1 | -1, what: "name" | "text") => {
    const flat = tab.cards.flatMap((k) => k.cells);
    const i = flat.findIndex((c) => c.id === cellId);
    if (i < 0 || flat.length < 2) return;
    const next = flat[(i + dir + flat.length) % flat.length];
    if (what === "name") {
      setEditingName(next.id);
      return;
    }
    // ★건너뛴 자리는 **곧장 치는** 자리다 — 태그를 이어 적어 나가는 흐름이라
    //   거기서 칩을 한 번 더 눌러야 하면 조작이 끊긴다.
    expand(next.id, true);
  };

  return (
    <div
      data-scene-lane
      /* ★`minWidth: 0` 이 없으면 **가로로 넘칠 때 스크롤이 아니라 통째로 커진다**.
         칸이 넓어지자 씬 줄이 오른쪽 기둥을 뚫고 나갔다 (사용자 지적 2026-08-14).
         flex 자식의 기본 `min-width: auto` 가 내용 폭만큼 늘어나기 때문이다. */
      /* ★★세로 모드에서는 **머리줄이 왼쪽에 세로로 선다** (사용자 지시 2026-08-22) —
         줄이 좁아 가로 머리줄이 높이를 통째로 먹는다. 그래서 뿌리의 방향부터 바뀐다. */
      style={{
        flex: 1,
        minHeight: 0,
        minWidth: 0,
        display: "flex",
        flexDirection: vert ? "row" : "column",
      }}
    >
      {/* ★머리줄 — 그릇의 것이다. 카드 이름은 카드 배너가 말한다.
          ★★**세로 모드에서는 왼쪽에 세로로 선다** (사용자 지시 2026-08-22): 글도 세로쓰기다.
            좁은 줄에서 가로 머리줄은 높이를 통째로 먹는데, 여기 담긴 것은 몇 개 안 된다.
            ★`writing-mode: vertical-rl` 안에서는 **flex 축도 함께 돈다** — `row` 가 곧
              위에서 아래다. 그래서 안쪽 배치는 손대지 않는다 (빈 자리 채우기 `flex: 1` 도 그대로).
            ★자리가 모자라면 접힌다 (`flexWrap`) — 옆 칸으로 넘어간다. */}
      <div
        data-scene-lane-head
        style={{
          flexShrink: 0,
          display: "flex",
          alignItems: "center",
          gap: "var(--sp-3)",
          background: "var(--panel)",
          ...(vert
            ? {
                writingMode: "vertical-rl" as const,
                minWidth: 30,
                flexWrap: "wrap" as const,
                columnGap: 2,
                padding: "var(--sp-4) 3px var(--sp-3)",
                borderLeft: "1px solid var(--line)",
                borderRight: "1px solid var(--line)",
              }
            : {
                height: 30,
                padding: "0 var(--sp-3) 0 var(--sp-4)",
                borderTop: "1px solid var(--line)",
                borderBottom: "1px solid var(--line)",
              }),
        }}
      >
        {/* ★★씬을 **오른쪽으로 보내는** 모드 (사용자 지시 2026-08-22) — 큰 그림과 씬을
            가운데에서 좌우로 양분한다. 세로로 긴 그림을 크게 보며 뽑기 위한 것이다.
            ★★자리는 **「씬」 바로 왼쪽**이다 (사용자 지시 2026-08-22) — 머리줄 끝에 두었더니
              눈에 안 띄었다. 맨 앞이라야 무엇을 보는 화면인지와 함께 읽힌다.
            ★★모양은 **해상도 고르기의 비율 사각형과 같은 것**이다 (`components/Ratio`,
              사용자 지시 2026-08-22) — 같은 뜻(가로냐 세로냐)을 두 곳에서 다르게 그리지 않는다.
            ★**지금 상태**를 그린다 (아래에 있으면 가로, 오른쪽에 있으면 세로).
            ★★**버튼 껍데기를 입힌다** (사용자 지시 2026-08-29: *"엄청 중요하고 자주 쓰는
              버튼인데 버튼같이 안 생겨서 존재를 모르는 것 같음"*) — 테두리·면을 주고 올리면
              강조색이 돈다 (`globals.css` 의 `.lane-side-btn`). 한때 「강조하지 않는다」였는데
              그 결정은 켜짐/꺼짐으로 오독되는 색을 막자는 것이었고, 껍데기는 그와 무관하다.
              상태를 가르는 것은 여전히 아이콘 하나다. */}
        <button
          data-lane-side={laneSide}
          className="lane-side-btn"
          onClick={() => useUi.getState().setLaneSide(vert ? "bottom" : "right")}
          data-tip={t(vert ? "canvas.laneToBottom" : "canvas.laneToRight")}
          style={{
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            width: 26,
            height: 26,
            flexShrink: 0,
            borderRadius: "var(--r-1)",
            border: "1px solid var(--line)",
            background: "var(--panel)",
          }}
        >
          <Ratio {...(vert ? RATIO_PORTRAIT : RATIO_LANDSCAPE)} max={13} />
        </button>
        <b style={{ fontSize: "var(--text-2xs)", color: "var(--ink-dim)" }}>{t("scenes.title")}</b>
        {/* ★씬 프롬프트가 payload 의 **어디로 들어가나** — 왼쪽 컨테이너 이름(베이스 프롬프트 /
            캐릭터 프롬프트)을 그대로 가리킨다. ★탭에 **하나뿐**이다 (사용자 결정)
            ★★상자도 목록도 **우리가 그린다** (`components/Dropdown`). 2026-08-22 에는 `<select>` 를
              투명하게 겹쳐 두고 상자만 그렸는데(폭이 가장 긴 항목에 맞춰 벌어지고, 화살표 방향을
              못 바꿔서), 2026-08-30 에 목록까지 우리 것으로 바꿨다 — 브라우저 목록은 항목 여백을
              못 주고 세로 모드에서는 목록까지 세로로 섰다. 폭은 **고른 것**에 맞고, 화살표는
              언제나 아래다. */}
        <label
          style={{
            display: "flex",
            alignItems: "center",
            gap: "var(--sp-2)",
            fontSize: "var(--text-2xs)",
            color: "var(--ink-faint)",
          }}
        >
          {t("scenes.destLabel")}
          {/* ★★**목록도 우리가 그린다** (`components/Dropdown`, 사용자 지시 2026-08-30) — 브라우저
              기본 목록은 항목 여백을 못 주고, 세로 모드에서는 목록까지 세로로 섰다.
              ★`all` 은 두 명부터만 낸다 (위 `canAll` 주석) — v2 의 `promptTarget === "char"`.
              ★캐릭터 이름이 비어 있으면 화면에 뜨는 이름을 그대로 쓴다 (사용자 지적 2026-08-19) */}
          <Dropdown
            mark="scene-dest"
            vert={vert}
            tip={t("scenes.destHint")}
            value={dest}
            onChange={(v) => patchSceneGroup(tab.id, { sceneDest: v })}
            options={[
              { value: "base", label: t("scenes.destBase") },
              ...(canAll ? [{ value: "all", label: t("scenes.destAll") }] : []),
              ...chars.map((c, i) => ({
                value: c.id,
                label: t("scenes.destChar", { name: c.name || t("cards.charN", { n: i + 1 }) }),
              })),
            ]}
          />
        </label>
        {/* ★★**별표 단추는 맨 끝**이다 (사용자 지시 2026-08-25: *"별표만 보기를 그냥 우측
            끝으로 옮겨"*). 앞에 붙여 두면 세로 모드의 좁은 머리에서 옆 글자와 겹쳐 읽힌다.
            ★가르는 것(모드·이름·목적지)과 **거르는 것**을 양 끝으로 떼어 놓는 셈이기도 하다.
            ★`writing-mode` 안에서는 flex 축도 함께 도므로 이 한 줄이 두 모드를 다 맡는다. */}
        <span style={{ flex: 1 }} />
        {/* ★★**별표만 보기** (2026-08-22 에 걷었다가 사용자 지시로 되살렸다 2026-08-25).
            뽑은 장이 수십이 되면 마음에 든 것을 다시 찾는 데 시간이 든다 — 별을 달아 두고
            그것만 본다.
            ★거르는 중에는 **개수를 안 적는다** — 「전체 보기 (3)」 은 3장이 전부라는 말로 읽힌다.
            ★★거르기는 `visibleTakes` **하나**가 한다 — 줄과 큰 그림이 같은 목록을 봐야
              휠로 넘길 때 걸러진 장이 큰 그림에 뜨지 않는다. */}
        <button
          data-star-filter
          data-on={starOnly ? "" : undefined}
          onClick={() => useUi.getState().setLaneStarOnly(!starOnly)}
          /* ★글자는 **툴팁으로 내렸다** (사용자 지시 2026-08-25: *"별표만 보기는 텍스트 없이
             별모양만"*). 개수도 여기 붙는다 — 0 이면 눌러도 화면이 비므로 누르기 전에 알아야
             하는데, 머리줄은 세로 모드에서 특히 좁다. */
          data-tip={starOnly ? t("canvas.starAll") : `${t("canvas.starOnly")} (${starCount})`}
          style={{
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            width: 22,
            height: 22,
            borderRadius: "var(--r-1)",
            border: `1px solid ${starOnly ? "var(--warn)" : "transparent"}`,
            color: starOnly ? "var(--warn)" : "var(--ink-faint)",
          }}
        >
          {starOnly ? Icon.star12On : Icon.star12}
        </button>
        {/* ★정리 — 별표 **오른쪽**. 이 씬 그룹에 미저장 그림이 있을 때만 선다 (사용자 지시 2026-08-30).
            빗자루다 — 한 장을 버리는 지우개·파일을 지우는 휴지통과 다른 일이다. */}
        {staleFiles.length > 0 && (
          <button
            data-sweep-previews
            onClick={() => void sweepPreviews()}
            data-tip={t("scenes.sweepHint", { n: staleFiles.length })}
            style={{
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              width: 22,
              height: 22,
              borderRadius: "var(--r-1)",
              border: "1px solid transparent",
              color: "var(--warn)",
            }}
          >
            {Icon.broom}
          </button>
        )}
        {/* ★칸 크기는 **Ctrl + 휠**로 바꾼다 (사용자 지시 2026-08-14). 버튼 셋이
            차지하던 자리를 돌려주고, 손이 줄 위에 있는 채로 바로 조절된다.
            ★안내 문구를 두지 않는다 (사용자 지시 2026-08-19) — 휠로 조절되는 것은
              적어 두지 않아도 안다. 지금 크기도 칸을 보면 보인다. */}
      </div>

      <div
        ref={boxRef}
        style={{
          flex: 1,
          minHeight: 0,
          minWidth: 0,
          position: "relative",
          display: "flex",
          /* ★★씬 세트를 끌고 있으면 **줄 전체**가 어둠 위로 올라온다 (사용자 지적 2026-08-20).
             스크롤 칸만 올리면 머리 손잡이·여백이 어두운 채라 영역으로 안 읽힌다. */
          ...(setDrop.active ? { zIndex: 31, background: "var(--bg)" } : {}),
        }}
      >
      {/* ★줄 머리 크기 손잡이. 머리는 왼쪽에 붙어 있으므로(sticky left:0) 손잡이는
          스크롤과 무관하게 늘 같은 자리에 선다.
          ★★**세로 모드에서는 여기 두지 않는다** (사용자 지적 2026-08-22: 손잡이가 실제
            머리와 다른 데 있었다). 세로 모드의 머리는 카드 배너 아래에서 시작하고 그
            배너는 같이 굴러가므로, 줄 상자 기준의 고정 좌표로는 절대 안 맞는다.
            대신 **머리의 아래 모서리 안쪽**에 둔다 (`SceneRow`) — 붙어 다니니 어긋날 수 없다. */}
      {!vert && (
      <div
        data-head-grip="col"
        onPointerDown={(e) => {
          (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
          grip.current = { x: e.clientX, w: headw };
        }}
        onPointerMove={(e) => {
          const g = grip.current;
          if (!g) return;
          useUi.getState().setLaneHeadW(g.w + (e.clientX - g.x));
        }}
        onPointerUp={() => { grip.current = null; useUi.getState().commitLayout(); }}
        onPointerCancel={() => { grip.current = null; }}
        style={{ position: "absolute", left: headw - 3, top: 0, bottom: 0, width: 7, zIndex: 6, cursor: "col-resize" }}
      />
      )}
      {/* ★★씬 세트 카드는 **이 줄이 받는다** (사용자 지시 2026-08-19).
          예전에는 캔버스에 고정 크기 판을 띄웠는데, 씬이 사는 자리와 다른 데다 받는 넓이가
          화면 크기에 매여 있었다. 이제 **씬 줄 그대로가 받는 자리**다 — 줄이 늘고 줄면 받는
          자리도 같이 변한다.
          ★놓으면 **아래에 카드가 하나 더 붙는다** — 탭을 새로 만들거나 있는 것을 갈아
            끼우지 않는다 (카드를 겹쳐 쌓는 것이 이 화면의 문법이다). */}
      <div
        ref={(el) => {
          scrollRef.current = el;
          // ★드롭존의 ref 는 **객체**다 (`useDropZone`) — 여기서는 스크롤 ref 와 둘 다 걸어야 해서
          //   콜백 ref 로 받아 손으로 채운다
          (setDrop.ref as React.MutableRefObject<HTMLDivElement | null>).current = el;
        }}
        data-lane-scroll
        data-set-drop={setDrop.over ? "over" : setDrop.active ? "on" : undefined}
        style={{
          flex: 1,
          minHeight: 0,
          minWidth: 0,
          overflow: "auto",
          /* ★올리는 것은 **줄 전체**다 (위 `boxRef`) — 물들이는 것은 카드 위에 뜨는
             겹이 한다 (`data-set-drop-hint`), 바탕을 칠하면 카드에 가린다 */
          background: "var(--bg)",
          /* ★★**머리에서 한 칸 띄운다** (사용자 지시 2026-08-26: *"세로 모드일 때 씬 카드가
             씬 헤드랑 딱 붙어 있음. 가로 모드일 때처럼 간격 벌려 줘"*).
             아래 모드에서는 카드 배너가 머리줄 **아래로 이어져** 한 기둥으로 읽히는데,
             세로 모드에서는 머리가 옆에 서므로 그냥 두면 두 덩이가 맞붙는다. */
          ...(vert ? { paddingLeft: GAP } : null),
        }}
      >
        {!tab.cards.length ? (
          <Empty onAdd={() => addCard(tab.id)} />
        ) : (
          <div
            style={
              // ★세로 모드에서는 카드가 **오른쪽으로** 늘어선다 (씬 기둥이 그 안에 선다)
              vert
                ? { height: "max-content", minHeight: "100%", display: "flex", alignItems: "stretch" }
                : {
                    width: "max-content",
                    minWidth: "100%",
                    /* ★카드가 왼쪽 벽에 붙지 않게 한 뼘 (사용자 지시 2026-08-28).
                       ★`box-sizing: border-box` 라 `minWidth: 100%` 와 겹쳐도 가로줄이
                         새로 생기지 않는다 (`styles/globals.css` 의 전역 규칙). */
                    paddingLeft: 8,
                  }
            }
          >
            {/* ★눈금 줄(1·2·3…)을 걷었다 (사용자 지시 2026-08-19) — 몇 번째 장인지는
                세어서 쓸 일이 없고, 줄마다 자리를 하나씩 먹고 있었다. */}
            {tab.cards.map((card, ci) => (
              <Fragment key={card.id}>
              {/* ★카드를 끌 때 놓일 자리 — **레이아웃을 안 밀도록** 높이 0 위에 띄운다
                  (CLAUDE.md: 칸 사이에 끼워 넣으면 방금 잰 좌표가 어긋난다) */}
              <DropLine on={lane.drop?.kind === "card" && lane.drop.index === ci} vert={vert} />
              <CardGroup
                vert={vert}
                card={card}
                groupId={tab.id}
                offset={offsets[ci]}
                gripOf={lane.gripProps}
                drop={lane.drop}
                dragId={lane.drag?.id ?? null}
                only={card.cells.length === 1}
                w={w}
                h={h}
                focus={focus}
                picked={selected}
                onFocus={setFocus}
                onPick={pick}
                onPickPending={(cellId, id) => useSceneFocus.getState().focusPending(cellId, id)}
                takes={takesOfCell}
                stepOf={(id) => steps[id] ?? ""}
                isStarred={isStarred}
                onStar={toggleStar}
                queuedOf={(cellId) => queued.filter((p) => p.cellId === cellId)}
                /* ★★**서버가 말하는 씬**의 대기 칸에 「생성 중」을 붙인다 (2026-08-25).
                   예전에는 `queued[0]`(내 목록의 맨 앞)을 찍었는데, 배치가 겹치면 그 순서가
                   실제 진행과 어긋나 **엉뚱한 칸에 「생성 중」이 뜨고 그림은 「대기 중」 칸에
                   나타났다** (사용자 실측). 무엇을 만드는지는 서버가 안다.
                   ★★규칙은 `store/queue.runningPendingId` **하나**다 — 큰 그림도 같은 답을
                     봐야 한다 (안 그러면 줄과 큰 자리가 서로 다른 칸을 「생성 중」으로 안다). */
                firstWaiting={runId}
                view={view}
                headw={headw}
                base={base}
                ws={ws}
                onPatch={(patch) => setCard(tab.id, card.id, patch)}
                onRemove={() => removeCard(tab.id, card.id)}
                onAddScene={() => addSlot(tab.id, { cardId: card.id })}
                /* ★씬 복제 — 태그·잠금까지 그대로 베껴 **바로 뒤에** 꽂는다 (v2 `duplicateSlot`).
                   번호는 탭의 발급기가 새로 준다 (`addSlot` 주석) */
                onDuplicate={(from, i) =>
                  addSlot(tab.id, {
                    cardId: card.id,
                    after: i,
                    from,
                    name: t("slots.copyOf", { name: from.name }),
                  })
                }
                onSeq={(n) => patchSceneGroup(tab.id, { cellSeq: n })}
                nextSeq={tab.cellSeq ?? 1}
                expandedId={expandedId}
                typingId={typingId}
                onExpand={expand}
                editingName={editingName}
                onEditName={onEditName}
                onStepField={stepField}
                onDragSave={(e) =>
                  startDrag(e, {
                    dir: "save",
                    kind: "posesets",
                    card: {
                      id: "",
                      name: card.name,
                      color: kindColor("posesets"),
                      cells: card.cells.map((c) => ({ name: c.name, blocks: c.blocks })),
                    },
                  }, undefined, () => setCard(tab.id, card.id, { folded: !card.folded }))
                }
                folded={!!card.folded}
                onFold={() => setCard(tab.id, card.id, { folded: !card.folded })}
              />
              </Fragment>
            ))}
            {/* 맨 끝에 놓을 때 */}
            <DropLine on={lane.drop?.kind === "card" && lane.drop.index === tab.cards.length} vert={vert} />

            {/* ★세로 모드에서는 카드가 오른쪽으로 늘어서므로 「카드 추가」도 **맨 오른쪽 기둥**이다 */}
            <div
              style={
                vert
                  ? { borderLeft: "1px dashed var(--line)", minHeight: "100%", flexShrink: 0, display: "flex" }
                  : { borderTop: "1px dashed var(--line)", minWidth: "100%" }
              }
            >
              <button
                data-add-card
                onClick={() => addCard(tab.id)}
                style={{
                  // ★글자를 **위로** 붙인다 — 기둥이 길어 가운데면 화면 밖에 놓인다
                  //   (사용자 지적 2026-08-22). 「씬 추가」와 같은 규칙이다.
                  ...(vert
                    ? {
                        display: "flex",
                        flexDirection: "column" as const,
                        alignItems: "center",
                        justifyContent: "flex-start",
                        width: 58,
                        padding: "var(--sp-3) var(--sp-2)",
                        textAlign: "center" as const,
                        whiteSpace: "normal" as const,
                        wordBreak: "keep-all" as const,
                      }
                    : {
                        position: "sticky" as const,
                        left: 0,
                        display: "inline-flex",
                        alignItems: "center",
                        padding: "var(--sp-3) var(--sp-5)",
                      }),
                  gap: "var(--sp-2)",
                  color: "var(--ink-faint)",
                  fontSize: "var(--text-2xs)",
                }}
              >
                {Icon.plus}
                {t("scenes.addCard")}
              </button>
            </div>
          </div>
        )}
      </div>
      {/* ★★표시는 **공통**이다 (`DropVeil`) — 영역이 밝아지고, 그 위에 오면 물들면서
          무슨 일이 일어나는지 알약으로 적는다 (사용자 지시 2026-08-20: 강조 방식 통일). */}
      {setDrop.active && <DropVeil over={setDrop.over} label={t("scenes.addCard")} name="set" />}
      </div>

      {/* ★★고른 것을 알리는 **막대는 없다** (사용자 지시 2026-08-22:
          *"n장 선택 이 ui 자체를 없애"*). 무엇을 골랐는지는 칸의 테두리가 말하고,
          지우면 몇 장이 가는지는 삭제 단추의 안내가 말한다. */}

      {/* 커서를 따라오는 잔상 — **무엇을 들고 있나**. 놓일 자리는 `DropLine` 이 따로 말한다.
          ★줄을 통째로 띄우지 않는다 (v2 는 슬롯이 짧아 그럴 수 있었다). 씬 한 줄은 화면 폭만큼
            길어서 통째로 띄우면 뒤가 다 가려 어디에 놓는지가 안 보인다 — 그림 한 칸과 이름으로
            줄인다 (덱 카드 고스트를 작게 그리는 이유와 같다, `DragLayer`). */}
      {lane.ghost && (dragCard || dragCell) && (
        <DragGhost x={lane.ghost.x} y={lane.ghost.y}>
          {dragCard ? (
            /* 카드 배너를 줄여 놓은 것 — 카드 머리와 같은 재료를 쓴다 (`bannerEmptyFill`) */
            <div
              data-lane-ghost
              style={{
                position: "relative",
                width: 208,
                height: HEAD_H,
                borderRadius: "var(--r-2)",
                overflow: "hidden",
                background: BANNER_BG,
                border: "1px solid var(--line)",
              }}
            >
              <div
                style={{
                  position: "absolute",
                  inset: 0,
                  background: bannerEmptyFill(kindColor("posesets")),
                }}
              />
              <div
                style={{
                  position: "absolute",
                  inset: 0,
                  background: "linear-gradient(180deg, rgba(0,0,0,0) 20%, rgba(0,0,0,0.5) 100%)",
                }}
              />
              <span
                style={{
                  position: "absolute",
                  left: 9,
                  top: "50%",
                  transform: "translateY(-50%)",
                  display: "flex",
                  alignItems: "baseline",
                  gap: "var(--sp-3)",
                  color: "#fff",
                  textShadow: "0 1px 2px rgba(0,0,0,0.75)",
                }}
              >
                <b style={{ ...TYPE.cardName }}>{dragCard.name}</b>
              </span>
            </div>
          ) : (
            <div
              data-lane-ghost
              style={{
                display: "flex",
                alignItems: "center",
                gap: "var(--sp-3)",
                maxWidth: 240,
                padding: "4px var(--sp-4) 4px 4px",
                borderRadius: "var(--r-2)",
                border: "1px solid var(--accent)",
                background: "var(--panel)",
              }}
            >
              {/* 그림이 없는 씬이면 빈 칸 그대로 — 줄에서 보던 모습과 같다 */}
              <span
                style={{
                  flexShrink: 0,
                  width: 34,
                  height: 34,
                  borderRadius: "var(--r-1)",
                  overflow: "hidden",
                  background: "var(--bg)",
                  border: "1px solid var(--line)",
                  display: "block",
                }}
              >
                {dragTake && (
                  <img
                    src={takeSrc(dragTake, base, ws, true)}
                    alt=""
                    draggable={false}
                    style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
                  />
                )}
              </span>
              <span
                style={{
                  minWidth: 0,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                  fontSize: "var(--text-2xs)",
                  color: "var(--ink)",
                }}
              >
                {dragCell!.name}
              </span>
            </div>
          )}
        </DragGhost>
      )}

    </div>
  );
}

/** 한 장의 주소 — ★**미저장이면 파일이 없으므로 data URL 이다** (`store/previews.ts`).
 *  서버 주소를 만들면 조용히 깨진 그림이 된다 (파일 이름이 표식이라 404 조차 아니다).
 *  ★규칙을 한 곳에 둔다 — 줄의 칸 · PIP · 끄는 잔상이 같은 판정을 써야 한다. */
export function takeSrc(r: Rec, base: string, ws: string, thumb: boolean): string {
  if (r.preview) return `data:image/${r.preview.fmt};base64,${r.preview.b64}`;
  // ★`ts` 를 주소에 싣는다 — 같은 경로에 다른 그림이 와도 옛 캐시가 안 나온다 (`imgUrl.ts` 의 ★★주)
  return thumb ? thumbUrlOf(base, ws, r.file, r.ts) : imgUrl(base, ws, r.file, r.ts);
}

/** 비었을 때 — ★그릇만 있는 상태. 여기서는 씬을 못 만든다 (씬은 카드에 속한다) */
function Empty({ onAdd }: { onAdd: () => void }) {
  const t = useI18n((s) => s.t);
  return (
    <div
      style={{
        height: "100%",
        minHeight: 130,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: "var(--sp-4)",
        color: "var(--ink-faint)",
        fontSize: "var(--text-2xs)",
        textAlign: "center",
      }}
    >
      <div style={{ lineHeight: 1.7 }}>{t("scenes.emptyHint")}</div>
      <button
        data-add-card
        onClick={onAdd}
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: "var(--sp-2)",
          padding: "var(--sp-3) var(--sp-6)",
          border: "1px dashed var(--accent-line)",
          borderRadius: "var(--r-3)",
          background: "var(--accent-bg)",
          color: "var(--accent-ink)",
          fontSize: "var(--text-xs)",
          fontWeight: "var(--w-semi)",
        }}
      >
        {Icon.plus}
        {t("scenes.addCardFirst")}
      </button>
    </div>
  );
}

type GroupProps = {
  /** 세로 모드인가 — 씬이 세로 기둥이 되어 오른쪽으로 늘어선다 (`SceneLane` 의 ★★주) */
  vert: boolean;
  card: SceneCard;
  /** 이 카드가 든 탭 — 머리에 건 그림을 어디에 적을지 (`askThumb`) */
  groupId: string;
  /** 앞선 카드들의 씬 수 — 줄 앞 번호가 탭 전체에서 이어지게 (`offsets` 주석) */
  offset: number;
  /** 씬·카드 그립에 펴 넣을 것 (`useLaneReorder`) */
  gripOf: ReturnType<typeof useLaneReorder>["gripProps"];
  /** 지금 놓일 자리 — 그 틈에 막대를 그린다 */
  drop: LaneDrop | null;
  /** 끌고 있는 것의 id (씬이든 카드든) — 그 줄을 흐리게 */
  dragId: string | null;
  only: boolean;
  w: number;
  h: number;
  focus: { cell: string; file: string | null; pending: string | null };
  picked: Set<string>;
  onFocus: (f: { cell: string; file: string | null }) => void;
  /** 여러 장 고르기 — `range` 면 **지금 보는 장부터 이 장까지** (`SceneLane` 의 `pick`) */
  onPick: (file: string, cellId: string, range: boolean) => void;
  /** ★만들어지는 중인 칸을 고른다 — 프리뷰는 빈 화면이 된다 */
  onPickPending: (cellId: string, id: string) => void;
  takes: (c: Slot) => Rec[];
  /** 그 칸에 그리는 중인 중간 그림 (없으면 빈 문자열) — `store/queue` 의 `steps` */
  stepOf: (cellId: string) => string;
  /** 별표 — ★갤러리(보관함)의 별표와 다른 것이다 (`store/workspace` 의 `selection`) */
  isStarred: (f: string) => boolean;
  onStar: (f: string) => void;
  queuedOf: (cellId: string) => { id: string }[];
  firstWaiting: string | null;
  /** 스크롤 컨테이너의 보이는 구간 (가로). 이 밖의 칸은 안 그린다 */
  view: { x: number; w: number };
  /** 줄 머리 폭 (사용자가 끄는 값) */
  headw: number;
  base: string;
  ws: string;
  onPatch: (patch: Partial<SceneCard>) => void;
  onRemove: () => void;
  onAddScene: () => void;
  /** 씬 복제 — 그 씬을 그대로 베껴 바로 뒤에 꽂는다 (v2 슬롯 복제) */
  onDuplicate: (from: Slot, index: number) => void;
  onSeq: (n: number) => void;
  nextSeq: number;
  /** 펼쳐 둔 씬 id — ★한 번에 하나만 펼친다. 여럿 펼치면 다시 줄 높이가 제각각이 된다 */
  expandedId: string | null;
  /** 그 칸을 **치려고** 편 것인가 (요약 클릭·Tab 이동). 머리를 눌러 편 것은 아니다 */
  typingId: string | null;
  onExpand: (id: string | null, typing?: boolean) => void;
  /** 이름을 고치는 중인 씬 — ★줄이 아니라 **그릇**이 든다 (Tab 으로 건너뛰기 때문에) */
  editingName: string | null;
  onEditName: (id: string, v: boolean) => void;
  /** `Tab` 으로 옆 씬의 같은 칸으로 (v2 index.html:11809-11832) */
  onStepField: (cellId: string, dir: 1 | -1, what: "name" | "text") => void;
  /** 배너 역드래그 — 덱에 씬 세트 카드로 저장 */
  onDragSave: (e: React.PointerEvent) => void;
  /** 카드째 접혔나 — ★머리를 누르면 바뀐다 (전용 단추를 두지 않는다) */
  folded: boolean;
  onFold: () => void;
};

/** 씬 세트 머리의 높이 — ★절반으로 줄였다 (사용자 지적 2026-08-16: 56 은 너무 두꺼웠다) */
const HEAD_H = 28;
/** ★자르지 않고 **끝만 부드럽게 뺀다** — 잘라 두면 줄 가운데서 뚝 끊긴 것처럼 보인다 */
const HEAD_FADE = "linear-gradient(90deg, #000 0 72%, transparent 100%)";

/** 씬 세트 카드 하나 — ★스타일·캐릭터 카드와 **같은 생김새**다 (둥근 모서리 + 그라데이션 배너).
 *  ★`overflow: hidden` 을 주지 않는다 — 주면 스크롤 컨테이너가 새로 생겨서 줄 머리의
 *    `position: sticky; left: 0` 이 씬 칸이 아니라 **이 카드**에 붙는다. */
function CardGroup(p: GroupProps) {
  const t = useI18n((s) => s.t);
  /* ★★색은 **종류가 정한다** (사용자 결정 2026-08-20) — 카드에 박힌 옛 색도 안 본다.
     예전에는 이름을 해시해서 뽑았고, 새 세트는 이름이 늘 「새 세트」라 언제나 같은 색인데
     기본 씬 세트만 다른 색이 되어 있었다. 카드끼리 가르는 것은 **그림**이 한다. */
  const grad = kindColor("posesets");
  /** 이름을 그 자리에서 고치는 중 — `null` 이면 아니다 (프롬프트 카드와 같은 방식) */
  /** 이름 고치기 — ★규칙은 **앱에 하나**다 (`useRename`): 단추를 다시 누르면 저장하고 끝 */
  const rename = useRename(p.card.name, (v) => p.onPatch({ name: v }));
  /** ★블록과 **같은 포인터 드래그**로 순서를 바꾼다 — HTML5 드래그를 쓰면 안의 칩을
   *  끄는 순간 씬이 딸려 끌리고, WebView2 가 그걸 파일 드롭으로 가로챈다.
   *  ★판은 **줄 전체**다 (`useLaneReorder`) — 카드를 넘어 씬을 옮길 수 있어야 하고,
   *    같은 하나로 카드 자체의 자리도 바꾼다 */
  const cardGrip = p.gripOf("card", p.card.id);
  /** ★★머리에 **그림을 걸 수 있다** (사용자 지시 2026-08-21) — 프롬프트 섹션 배너와 같은
   *  몸짓이다: 생성물을 끌어다 놓으면 자리 잡는 창이 뜨고, 고른 자리가 카드에 남는다.
   *  ★그림 바이트는 굽지 않는다 — 창구는 `askThumb` 하나이고 굳히는 것은 `App` 이 한다. */
  const headThumb = useThumbView(p.card.thumb ?? null);
  const headDrop = useDropZone({
    id: `scene-card-thumb-${p.card.id}`,
    kind: "image",
    dir: "image",
    prio: 6,
    onDrop: (d) =>
      d.img && askThumb({ type: "scene-card", groupId: p.groupId, cardId: p.card.id, img: d.img }),
  });
  /** 「씬 추가」 — **한 번만 만들고 방향만 가른다.**
   *
   *  ★★자리는 **두 모드가 같다**: 씬들 **뒤**다 (아래 모드는 아래, 세로 모드는 오른쪽).
   *    한 번 카드 맨 위로 올렸다가 되돌렸다 — 통일성이 어긋났다 (사용자 지적 2026-08-22).
   *  ★★글자는 **위로 붙인다** (사용자 지적 2026-08-22). 세로 모드에서는 기둥이 길어서
   *    가운데 정렬이면 글자가 화면 한참 아래에 놓여 안 보인다.
   *  ★두 벌로 적지 말 것 — 한쪽만 고쳐진 채로 남는다 (실제로 이 자리를 옮기다 아래 모드의
   *    단추를 통째로 잃었다). */
  const addScene = (
      <div
        style={{
          ...(p.vert
            ? { borderLeft: "1px dashed var(--line)", minHeight: "100%", flexShrink: 0, display: "flex" }
            : { borderTop: "1px dashed var(--line)", minWidth: "100%" }),
        }}
      >
        <button
          data-add-scene={p.card.id}
          onClick={p.onAddScene}
          style={{
            // ★세로 모드에서는 카드가 가로로 안 굴러가므로 붙들 필요가 없다
            ...(p.vert
              ? {
                  // ★글자를 **위로** 붙인다 — 기둥이 길어 가운데면 화면 밖에 놓인다
                  display: "flex",
                  flexDirection: "column" as const,
                  alignItems: "center",
                  justifyContent: "flex-start",
                  width: 58,
                  padding: "var(--sp-3) var(--sp-2)",
                  textAlign: "center" as const,
                  whiteSpace: "normal" as const,
                  wordBreak: "keep-all" as const,
                }
              : {
                  position: "sticky" as const,
                  left: 0,
                  display: "inline-flex",
                  alignItems: "center",
                  padding: "var(--sp-3) var(--sp-5)",
                }),
            gap: "var(--sp-2)",
            color: "var(--ink-faint)",
            fontSize: "var(--text-2xs)",
          }}
        >
          {Icon.plus}
          {t("scenes.addScene")}
        </button>
      </div>
  );

  /** 이 카드 안에서 씬이 놓일 자리 (없으면 null) */
  const sceneAt =
    p.drop?.kind === "scene" && p.drop.cardId === p.card.id ? p.drop.index : null;
  return (
    <div
      data-scene-card={p.card.id}
      style={{
        // ★세로 모드에서는 카드가 **세로로 꽉 차고** 폭은 안에 든 기둥만큼이다
        ...(p.vert
          ? { minHeight: "100%", display: "flex", flexDirection: "column", flexShrink: 0 }
          : { minWidth: "100%" }),
        /* ★위아래로 **숨 쉴 자리**를 둔다 (사용자 지시 2026-08-20: 씬 머리줄과 카드가
           딱 붙어 있었다). 카드는 둥근 상자라, 붙어 있으면 머리줄의 선과 모서리가
           한 덩어리로 읽힌다. */
        margin: p.vert ? "var(--sp-2) var(--sp-4) var(--sp-2) 0" : "var(--sp-2) 0 var(--sp-4)",
        border: "1px solid var(--line)",
        borderRadius: "var(--r-4)",
        background: "var(--surface)",
      }}
    >
      {/* 배너 — ★그림 자리다. 값 넣는 칸을 얹지 않는다 (`cards/banner.ts` 규격 그대로).
          ★배너를 우하단 핸드로 끌면 **씬 세트 카드로 덱에 저장**된다 (역드래그).
            칸 하나가 곧 블록 하나라 그대로 담긴다 (`slotBlock`). */}
      <div
        // ★머리를 누르면 **카드째 접힌다** (사용자 지적 2026-08-16: 씬 세트가 안 접혔다).
        //   끌면 덱에 저장하는 역드래그다 — 4px 문턱으로 가른다 (`useDragSource` 의 `onTap`).
        onPointerDown={(e) => {
          if ((e.target as HTMLElement).closest("button")) return;
          p.onDragSave(e);
        }}
        style={{
          cursor: "grab",
          // ★세로 모드에서는 카드가 세로 기둥이라 배너가 그 **폭**을 다 쓴다
          ...(p.vert ? { width: "100%", flexShrink: 0 } : { minWidth: "100%" }),
          // ★높이를 절반으로 (사용자 지적 2026-08-16: 56 은 너무 두꺼웠다)
          height: HEAD_H,
          background: BANNER_BG,
          // ★접히면 머리가 카드의 **마지막 조각**이다 — 아래 모서리도 둥글어야 하고
          //   아래 테두리는 없어야 한다 (안 그러면 좌우 하단이 각지고 선이 남는다)
          borderRadius: p.folded ? "11px" : "11px 11px 0 0",
          borderBottom: p.folded ? undefined : "1px solid var(--line)",
        }}
      >
        <div
          style={{
            /* ★★폭은 **줄 머리와 같은 값**이어야 한다 (사용자 지적 2026-08-19).
               상수 302 로 박혀 있었는데 줄 머리는 사용자가 끄는 값이라(`laneHeadW`, 기본 286),
               그림이 끝나는 자리와 아래 줄들의 경계가 어긋나 **가운데서 잘린 것처럼** 보였다.
               ★세로 모드에서는 카드가 가로로 안 굴러가므로 붙들 필요가 없다 — 폭을 다 쓴다.
               ★★다만 **`position` 을 없애면 안 된다** (사용자 지적 2026-08-22: 배너가 화면
                 오른쪽을 통째로 덮었다). 안쪽 그림이 `position:absolute; inset:0` 이라
                 **여기가 그 기준**인데, `static` 이 되면 기준을 저 위 상자(`boxRef`,
                 `position:relative`)에서 찾아 줄 전체로 퍼진다. 붙들지 않되 기준은 남긴다. */
            ...(p.vert
              ? { position: "relative" as const, width: "100%" }
              : { position: "sticky" as const, left: 0, width: p.headw }),
            height: HEAD_H,
            overflow: "hidden",
            // ★세로 모드에서는 배너가 카드 **위**에 눕는다 — 둥근 모서리도 위 두 곳이다
            borderRadius: p.vert
              ? (p.folded ? "11px" : "11px 11px 0 0")
              : (p.folded ? "11px 0 0 11px" : "11px 0 0 0"),
          }}
        >
          {/* ★★그림은 **끝까지 이어진다** (사용자 지적 2026-08-16).
              덱 카드는 좁아서 240px 에서 비스듬히 잘리는 것이 곧 모양이지만, 이 머리는
              줄 전체 폭이라 그 자리에서 잘리면 **가운데서 뚝 끊긴 것처럼** 보였다.
              그래서 여기서는 자르지 않고(`BANNER_CUT` 미사용) 오른쪽 끝을 부드럽게 뺀다. */}
          <div
            ref={headDrop.ref}
            style={{
              position: "absolute",
              inset: 0,
              pointerEvents: "none",
              maskImage: HEAD_FADE,
              WebkitMaskImage: HEAD_FADE,
              // 그림이 있으면 그림이, 없으면 지금까지처럼 카드 색이 깔린다
              background: headThumb ? undefined : bannerEmptyFill(grad),
              outline: headDrop.over ? "2px solid var(--accent)" : undefined,
              outlineOffset: -2,
            }}
          >
            {headThumb && (
              <FittedImg url={headThumb.url} w={p.headw} h={HEAD_H} view={headThumb} />
            )}
          </div>
          {/* ★어둡게 눕히는 겹도 **같은 마스크**를 쓴다 — 안 그러면 그림은 사라졌는데 이 겹만
              끝에서 뚝 끊겨 세로 이음매가 보인다 (사용자 지적 2026-08-19) */}
          <div
            style={{
              position: "absolute",
              inset: 0,
              pointerEvents: "none",
              maskImage: HEAD_FADE,
              WebkitMaskImage: HEAD_FADE,
              background: "linear-gradient(180deg, rgba(0,0,0,0) 20%, rgba(0,0,0,0.5) 100%)",
            }}
          />
          <div
            style={{
              position: "absolute",
              left: 11,
              top: "50%",
              transform: "translateY(-50%)",
              display: "flex",
              alignItems: "baseline",
              gap: "var(--sp-3)",
              color: "#fff",
              textShadow: "0 1px 2px rgba(0,0,0,0.75)",
            }}
          >
            {/* ★카드 순서 그립 — 머리 누르기(접기)·머리 끌기(덱에 저장)와 뜻이 달라 **전용 손잡이**를
                둔다. 셋을 한 자리에 얹으면 무엇이 될지 알 수 없다 */}
            <span
              data-card-grip={p.card.id}
              {...cardGrip}
              style={{ ...cardGrip.style, display: "grid", alignSelf: "center", color: "rgba(255,255,255,0.78)" }}
            >
              {Icon.grip}
            </span>
            {/* ★★이름을 **카드 안에서** 고친다 (사용자 지시 2026-08-19) — 프롬프트 카드·덱 카드와
                같은 방식이다 (두 번 누르거나 연필 단추, 다시 누르면 저장하고 끝난다). */}
            {!rename.editing ? (
              <b
                onDoubleClick={(e) => {
                  e.stopPropagation();
                  rename.toggle();
                }}
                style={{ ...TYPE.cardName, cursor: "text" }}
              >
                {p.card.name}
              </b>
            ) : (
              <input
                data-card-name={p.card.id}
                {...rename.inputProps}
                style={{
                  width: 130,
                  background: "rgba(0,0,0,0.45)",
                  border: "1px solid rgba(255,255,255,0.5)",
                  borderRadius: "var(--r-1)",
                  padding: "0 4px",
                  color: "#fff",
                  ...TYPE.cardName,
                  fontWeight: "var(--w-bold)",
                }}
              />
            )}
          </div>
          {/* ★잠금은 **카드째**다 — 옛 「전체 잠금」이 이 자리로 왔다 (사용자 결정) */}
          <div
            style={{
              position: "absolute",
              right: 5,
              top: "50%",
              transform: "translateY(-50%)",
              display: "flex",
              alignItems: "center",
              gap: 2,
            }}
          >
            <button
              data-card-rename={p.card.id}
              data-tip={t("cards.rename")}
              onPointerDown={(e) => e.stopPropagation()}
              {...rename.btnProps}
              style={bannerBtn}
            >
              {Icon.pencil}
            </button>
            <button
              data-card-lock={p.card.id}
              onClick={() => p.onPatch({ locked: !p.card.locked })}
              data-tip={t("scenes.lockCard")}
              style={{ ...bannerBtn, color: p.card.locked ? "var(--warn)" : "rgba(255,255,255,0.72)" }}
            >
              {/* ★블록의 켜기/끄기와 **같은 모양**이다 (사용자 지시 2026-08-16) —
                  "이번 생성에서 뺀다"는 뜻이 같으므로 생김새도 같아야 한다.
                  ★잠김 = **꺼짐**이다 (자물쇠와 반대로 읽히지 않게) */}
              {p.card.locked ? Icon.dotOff : Icon.dotOn}
            </button>
            <button
              data-card-remove={p.card.id}
              /* ★★**생성물이 화면에서 사라지는 삭제는 전부 묻는다** (사용자 지시 2026-08-19).
                 카드를 빼면 그 안의 씬이 통째로 빠지므로, 씬 하나를 지우는 것보다 범위가 넓다.
               ★★**그림도 함께 휴지통으로 보내고, 되돌리기는 주지 않는다**
                 (사용자 지시 2026-08-22: *"카드 삭제도 마찬가지. … 카드는 들고있는게 많아서
                 그냥 지우면 복구 안해주는 쪽으로 처리."*).
                 예전에는 파일이 남아 **앱에서 볼 길이 없는 그림**이 쌓였고, 게다가 지운 뒤
                 `Ctrl+Z` 를 누르면 카드가 아니라 **엉뚱한 것**이 되살아났다
                 (사용자 지적: *"카드 말고 다른 슬롯에서 지운 이미지가 복구됨"*).
                 그래서 로그를 비운다 — 되돌릴 수 없는 일 뒤에 로그가 남아 있으면 그런 일이 난다. */
              /* ★★**한 벌은 스토어에 있다** (`removeAt`, 2026-08-24) — 그림 모으기·휴지통·
                   로그 비우기가 전부 그리로 갔다. 여기서는 **묻기만** 한다.
                   조수도 같은 함수를 부르고, 묻는 방식만 승인 카드로 다르다. */
              onClick={() => {
                const target = { kind: "sceneCard" as const, groupId: p.groupId, cardId: p.card.id };
                void (async () => {
                  const plan = useWs.getState().planRemove(target);
                  if (plan.blocked) return;
                  if (
                    plan.files.length &&
                    !(await ask({
                      title: t("scenes.removeCardConfirm", { name: p.card.name, c: plan.inner, n: plan.files.length }),
                      body: t("scenes.removeConfirmBody"),
                      ok: t("common.delete"),
                      cancel: t("common.cancel"),
                    }))
                  )
                    return;
                  await useWs.getState().removeAt(target);
                })();
              }}
              data-tip={t("scenes.removeCard")}
              style={bannerBtn}
            >
              {Icon.close12}
            </button>
          </div>
        </div>
      </div>

      {/* ★접으면 머리만 남는다 */}
      {p.folded ? null : (
      <>
      {/* ★공통 접두는 **걷었다** (사용자 지시 2026-08-21). 프롬프트에 실려 나가는 값이
          카드 머리에 한 줄로만 보여서, 어느 씬에 무엇이 붙는지 화면에서 따라가기 어려웠다.
          같은 것을 붙이려면 **베이스 프롬프트의 블록**을 쓴다 (창구가 하나가 된다). */}
      {/* ★세로 모드에서는 씬이 **오른쪽으로** 늘어선다 (기둥 하나가 씬 하나) */}
      <div
        style={
          p.vert
            ? { flex: 1, minHeight: 0, display: "flex", alignItems: "stretch" }
            : undefined
        }
      >
        {p.card.cells.map((c, i) => (
          <Fragment key={c.id}>
            <DropLine on={sceneAt === i} vert={p.vert} />
            <SceneRow {...p} cell={c} index={i} grip={p.gripOf("scene", c.id)} />
          </Fragment>
        ))}
        {/* 이 카드의 **끝**에 놓을 때 — ★★자리는 **마지막 씬 바로 뒤**이지 「씬 추가」 뒤가
            아니다 (사용자 지적 2026-08-28: *"맨 아래로 옮길 때 씬 추가 뒤에 표시된다"*).
            ★같은 까닭으로 **줄 안쪽**에 둔다: 밖에 두면 세로 모드에서 기둥 줄 바깥이라
            아무 데도 안 보였다 (*"가장 끝으로 옮기려 하면 표시가 안 뜬다"*).
            ★축도 함께 넘긴다 — 안 넘기면 세로 모드에서 가로 막대가 그려진다. */}
        <DropLine on={sceneAt !== null && (sceneAt < 0 || sceneAt >= p.card.cells.length)} vert={p.vert} />
        {p.vert && addScene}
      </div>
      {!p.vert && addScene}
      </>
      )}
      {/* ★접힌 카드에는 줄이 없어 **언제나 끝**이다 — 그때만 이 자리에 표시한다
          (`useLaneReorder` 의 `index: -1`) */}
      {p.folded && <DropLine on={sceneAt !== null} vert={p.vert} />}
    </div>
  );
}

/** 씬 한 줄 — 머리에 **그 씬의 프롬프트**(블록 편집기), 오른쪽에 그 씬의 장들 */
function SceneRow(
  p: GroupProps & {
    cell: Slot;
    index: number;
    grip: ReturnType<ReturnType<typeof useLaneReorder>["gripProps"]>;
  },
) {
  const t = useI18n((s) => s.t);
  /** 생성물을 카드 커버로 끄는 출발점 (`dir: "image"`). 덱·손패·프롬프트 배너가 받는다 */
  const startTakeDrag = useDragSource();
  const c = p.cell;
  const expanded = p.expandedId === c.id;
  /** ★★이 칸의 블록 — **하나뿐**이다 (`slotBlock`). 여럿이 든 옛 카드를 얹었으면
   *  켜진 것들을 이어 붙여 보여 준다. */
  const blk = slotBlock(c.blocks, c.id);
  /** 세로 모드의 머리 높이 손잡이를 잡은 자리 */
  const headGrip = useRef<{ y: number; h: number } | null>(null);
  /** ★줄은 **최신이 왼쪽**이다 (사용자 지시 2026-08-14, 싱글 히스토리 줄과 같은 규칙).
   *  방금 나온 것을 찾아 눈이 끝까지 갈 이유가 없다. 대기 칸도 같은 규칙이라
   *  **새로 넣은 큐가 맨 왼쪽**이고, 지금 만드는 중인 것은 결과 바로 옆에 선다.
   *  ★★결과의 자리는 **`ts` 가 정한다** (`newestFirst`) — 도착한 차례를 뒤집어 쓰면
   *    경로에 따라 순서가 갈린다 (사용자 지적 2026-08-19). 대기 칸은 우리가 넣은 차례가
   *    곧 만들 차례라 그대로 뒤집는다. */
  const takes = [...p.takes(c)].sort(newestFirst);
  const waits = [...p.queuedOf(c.id)].reverse();
  /** 보이는 구간의 칸 번호. 앞뒤로 2칸씩 더 그려 스크롤이 끊겨 보이지 않게 한다 */
  // ★세로 모드에서는 장이 **아래로** 쌓이므로 걸음도 높이다
  const STEP = (p.vert ? p.h : p.w) + GAP;
  const total = waits.length + takes.length;
  const from = p.view.w
    ? Math.max(0, Math.floor((p.view.x - p.headw - 8) / STEP) - 2)
    : 0;
  /* ★아직 재기 전(첫 프레임)에는 **앞쪽 한 줌만** 그린다. 예전에는 전부(`total`) 그렸는데,
     장이 수백인 씬에서는 그 한 프레임에 썸네일을 수백 장 부르게 된다 (`lazy` 를 걷어낸 뒤로는
     실제로 전부 나간다). 재고 나면 바로 아래 구간으로 좁혀진다 — 자리는 `lead`·`tail` 이 지킨다. */
  const to = p.view.w
    ? Math.min(total, Math.ceil((p.view.x + p.view.w - p.headw - 8) / STEP) + 2)
    : Math.min(total, 24);
  const lead = from > 0 ? from * STEP - GAP : 0;
  const tail = total - to > 0 ? (total - to) * STEP - GAP : 0;
  const patchCell = (patch: Partial<Slot>) =>
    p.onPatch({ cells: p.card.cells.map((x) => (x.id === c.id ? { ...x, ...patch } : x)) });

  return (
    <div
      data-scene={c.id}
      onClick={() => p.onFocus({ cell: c.id, file: p.focus.cell === c.id ? p.focus.file : null })}
      style={{
        display: "flex",
        alignItems: "stretch",
        /* ★줄 두께는 **썸네일이 정한다** (사용자 지시 2026-08-11). 프롬프트가 길다고 줄이
           늘어나면 줄마다 두께가 달라져 눈이 훑을 기준을 잃는다. 그래서 블록은
           **펼쳤을 때만** 자리를 차지한다 — 접혀 있을 때는 한 줄 요약이다.
           ★세로 모드에서는 그 두께가 **폭**이고, 기둥은 세로로 꽉 찬다. */
        ...(p.vert
          ? {
              flexDirection: "column" as const,
              flexShrink: 0,
              /* ★★**세로 모드에서는 펼쳐도 폭이 그대로다** (사용자 지적 2026-08-28:
                 *"씬 프롬프트 입력란을 클릭하면 보이는 가로폭을 안 지키고 가로로 길게
                 늘어난다"*). 가로 모드에서 펼치면 **아래로** 자라는데(`minHeight`),
                 세로에서 같은 규칙을 쓰면 **옆으로** 자라 옆 기둥들을 밀어낸다.
                 기둥은 이미 세로로 꽉 차 있으므로 편집기는 그 안에서 아래로 흐르면 된다. */
              width: p.w + 12,
              borderRight: "1px solid var(--line-soft)",
            }
          : {
              ...(expanded ? { minHeight: p.h + 12 } : { height: p.h + 12 }),
              borderBottom: "1px solid var(--line-soft)",
            }),
        // ★끌고 있는 줄은 흐리게 — 자리는 지킨 채다 (칩 드래그와 같은 규칙, CLAUDE.md)
        opacity: p.dragId === c.id ? 0.4 : c.locked || p.card.locked ? 0.62 : 1,
      }}
    >
      <div
        data-scene-head
        /* ★머리를 누르면 펴진다. 단추·입력칸은 비켜 간다 — 안 비키면 잠금·삭제가 죽는다.
           ★★**머리 아무 데나 눌러도 곧장 칠 수 있다** (사용자 지적 2026-08-28: *"정확히
             「클릭해서 입력」 글자를 눌러야만 편집이 뜨는데, 보기에는 윗부분 전체가 입력
             공간이다"*). 예전에는 여기서 **펴기만** 했다 — 「머리를 눌러 편 것은 보려는
             것」이라는 구분이었는데, 씬 머리는 그 자체가 입력칸처럼 보이므로 그 구분이
             오히려 걸림돌이었다. 이제 글자든 빈 자리든 같은 자리다. */
        onClick={(e) => {
          if ((e.target as HTMLElement).closest("button, input, textarea, [data-head-action]")) return;
          p.onExpand(expanded ? null : c.id, true);
        }}
        style={{
          cursor: "pointer",
          position: "sticky",
          zIndex: 2,
          flexShrink: 0,
          // ★머리는 시작 쪽에 붙는다 — 아래 모드면 왼쪽, 세로 모드면 위. 크기는 같은 값이다
          ...(p.vert
            ? { top: 0, height: p.headw, borderBottom: "1px solid var(--line)" }
            : { left: 0, width: p.headw, borderRight: "1px solid var(--line)" }),
          /* ★★**강조는 「고른 씬」이 아니라 「지금 치고 있는 칸」이다** (사용자 지시
             2026-08-28: *"이미지만 선택했는데 머리가 선택된 것처럼 표시된다. 이미지를
             고르면 이미지 테두리만 강조하고, 저기는 프롬프트 편집할 때만"*).
             그림을 고르면 초점(`focus.cell`)이 그 씬으로 오는데, 그것까지 강조하면
             「입력칸이 열렸다」와 「그 씬을 보고 있다」가 같은 모습이 된다. */
          background: expanded ? "var(--accent-bg)" : "var(--surface)",
          display: "flex",
          flexDirection: "column",
          gap: 4,
          padding: "6px var(--sp-3)",
          overflow: "hidden",
        }}
      >
        {/* ★★세로 모드의 머리 크기 손잡이는 **여기**다 (사용자 지적 2026-08-22).
            줄 상자 기준의 고정 좌표로 두면 카드 배너 높이만큼 어긋나고, 배너는 같이
            굴러가므로 어떤 값으로도 안 맞는다. 머리에 붙여 두면 어긋날 수가 없다. */}
        {p.vert && (
          <div
            data-head-grip="row"
            onPointerDown={(e) => {
              (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
              headGrip.current = { y: e.clientY, h: p.headw };
            }}
            onPointerMove={(e) => {
              const g = headGrip.current;
              if (!g) return;
              useUi.getState().setLaneHeadH(g.h + (e.clientY - g.y));
            }}
            onPointerUp={() => { headGrip.current = null; useUi.getState().commitLayout(); }}
            onPointerCancel={() => { headGrip.current = null; }}
            onClick={(e) => e.stopPropagation()}
            style={{ position: "absolute", left: 0, right: 0, bottom: -3, height: 7, zIndex: 3, cursor: "row-resize" }}
          />
        )}
        {/* ★★세로 모드에서는 머리가 좁다 — **줄바꿈을 허용**하고 이름은 줄여서 넣는다
            (사용자 지적 2026-08-22: 글자가 머리 밖으로 튀어나갔다). */}
        <span
          style={{
            display: "flex",
            alignItems: "center",
            gap: 5,
            minWidth: 0,
            ...(p.vert ? { flexWrap: "wrap" as const, rowGap: 2 } : null),
          }}
        >
          <span
            {...p.grip}
            onClick={(e) => e.stopPropagation()}
            style={{ color: "var(--ink-faint)", display: "grid", ...p.grip.style }}
          >
            {Icon.grip}
          </span>
          {/* ★번호는 **탭 안에서 통째로** 센다 — 파일 이름 앞에 붙는 번호와 같은 값이라야
              한다 (`offsets` 주석 · `gen.ts` 의 `cell_no`). 카드마다 1 로 되돌아가면
              씬을 다른 카드로 옮겼을 때 화면과 저장 이름이 갈린다 */}
          <span style={{ fontFamily: "var(--font-mono)", fontSize: "calc(11px * var(--text-scale))", color: "var(--ink-ghost)" }}>
            {String(p.offset + p.index + 1).padStart(3, "0")}
          </span>
          <NameCell
            id={c.id}
            name={c.name}
            editing={p.editingName === c.id}
            onEditing={(v) => p.onEditName(c.id, v)}
            onRename={(v) => patchCell({ name: v })}
            onTab={(dir) => p.onStepField(c.id, dir, "name")}
          />
          {/* ★그림 수를 적지 않는다 (사용자 지시 2026-08-19) — 오른쪽에 그 그림들이 그대로
              늘어서 있어서 세어 줄 이유가 없다 */}
          <button
            data-scene-lock={c.id}
            onClick={(e) => {
              e.stopPropagation();
              patchCell({ locked: !c.locked });
            }}
            data-tip={t("slots.lock")}
            style={{ ...iconBtn, color: c.locked ? "var(--warn)" : "var(--ink-faint)" }}
          >
            {/* 블록의 켜기/끄기와 같은 모양 (카드 잠금 주석 참조) */}
            {c.locked ? Icon.dotOff : Icon.dotOn}
          </button>
          {/* ★복제 — 태그를 조금씩 바꿔 가며 비교하는 것이 씬의 쓰임이라, 베껴 놓고
              고치는 길이 있어야 한다 (v2 슬롯 머리의 복제 단추 그대로) */}
          <button
            data-scene-duplicate={c.id}
            onClick={(e) => {
              e.stopPropagation();
              p.onDuplicate(c, p.index);
            }}
            data-tip={t("slots.duplicate")}
            style={iconBtn}
          >
            {Icon.duplicate}
          </button>
          {!p.only && (
            <button
              data-scene-remove={c.id}
              /* ★★그림이 든 씬은 **묻고 지우며, 그림도 함께 휴지통으로 보낸다**
                 (사용자 지시 2026-08-19 묻기 · 2026-08-22 함께 지우기: *"씬 삭제하면 거기에있는
                 이미지도 삭제"*). 묶는 키는 `cell_id` 다.
                 ★되돌리기는 주지 않는다 — 카드 삭제와 같다 (위 ★★주). 그래서 로그를 비운다. */
              /* ★한 벌은 스토어의 `removeAt` 이다 (씬카드 삭제와 같은 자리) */
              onClick={(e) => {
                e.stopPropagation();
                const target = { kind: "scene" as const, groupId: p.groupId, cellId: c.id };
                void (async () => {
                  const plan = useWs.getState().planRemove(target);
                  if (plan.blocked) return;
                  if (
                    plan.files.length &&
                    !(await ask({
                      title: t("scenes.removeConfirm", { name: c.name, n: plan.files.length }),
                      body: t("scenes.removeConfirmBody"),
                      ok: t("common.delete"),
                      cancel: t("common.cancel"),
                    }))
                  )
                    return;
                  await useWs.getState().removeAt(target);
                })();
              }}
              data-tip={t("slots.remove")}
              style={iconBtn}
            >
              {Icon.close12}
            </button>
          )}
        </span>
        {/* ★★프롬프트 쪽과 **같은 블록**이다 (사용자 결정 2026-08-20) — 칸 하나가 블록
            하나라(`slotBlock`) 머리는 안 그리고 칩만 남긴다. 칩 클릭으로 글 상자, 칩 휠로
            가중치, 칩 끌기로 자리 옮기기, 서랍에서 끌어다 놓으면 태그가 뒤에 붙는다.
            ★★**접혀 있어도 이것 하나다.** 다른 것은 **높이뿐**이다(`clamp`) — 넘치는 만큼
              자르고 `+n` 으로 알린다. 한 판 앞에서는 접힌 줄에 모양만 같은 칩을 따로 그렸는데,
              끌 수도 서랍에서 받지도 못하는 **다른 물건**이었다 (사용자 지적 2026-08-20:
              *"그냥 비슷하게 생긴건 최악임"*). 통일은 생김새가 아니라 **조작**이다.
            ★글 상자가 열리면 줄이 **스스로 자리를 낸다**(`onOpen`) — 잘린 채로 치면 안 보인다. */}
        <div
          /* ★★여기서 클릭을 멈춘다 — 안 멈추면 줄 머리의 「눌러 접기」가 뒤이어 돈다.
             ★대신 줄이 하던 **「씬을 고르면 맨 앞 장도 고른다」를 여기서 직접 한다.**
               안 하면 프롬프트 자리를 눌러 씬을 골랐을 때 큰 자리가 빈 채다
               (조작 테스트에서 잡았다 2026-08-19). */
          onClick={(e) => {
            e.stopPropagation();
            p.onFocus({ cell: c.id, file: p.focus.cell === c.id ? p.focus.file : null });
            /* ★★**빈 자리를 눌러도 입력이 열린다** (사용자 지적 2026-08-28: *"정확히
               「클릭해서 입력」 글자를 눌러야만 편집이 뜨는데, 보기에는 윗부분 전체가
               입력 공간이다"*). 칩·글 상자를 누른 것은 그쪽이 알아서 처리하므로 비켜 간다. */
            const t = e.target as HTMLElement;
            if (!t.closest("[data-slot-block]")) p.onExpand(c.id, true);
          }}
          /* ★`display: contents` 였다 — 상자가 없으니 **빈 자리가 아예 없었다.**
             자리를 차지해야 그 자리를 누를 수 있다 (`flex: 1` 로 머리의 남은 만큼). */
          style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}
        >
          <BlockList
            /* ★★블록을 고치는 자리는 앱에 **이것 하나**다 (사용자 지적 2026-08-20:
               *"동일한 컴포넌트를 쓰는게 아니고 복제해서 만드니까 불일치가 계속 생김"*).
               씬 칸은 그 목록의 `single` 모드일 뿐이라, 칩 끌기·서랍 드롭·중복 표시가
               프롬프트 쪽과 **같은 배선**을 지난다. */
            single
            /* ★머리 칸을 다 쓴다 — 글자만이 아니라 **그 칸 아무 데나** 눌러 칠 수 있게
               (사용자 지적 2026-08-28). `BlockBody` 의 `fill` 주석 참조. */
            fill
            /* ★접히면 글 상자도 닫힌다 — 초점이 안 빠지는 길이 있어서 필요하다
               (`BlockBody` 의 `open` ★★주) */
            open={expanded}
            id={c.id}
            blocks={[blk]}
            onChange={(b) => patchCell({ blocks: slotBlocksOf(b[0] ?? blk) })}
            libZone={`scene-${c.id}`}
            clamp={!expanded}
            bg={expanded ? "var(--accent-bg)" : "var(--surface)"}
            autoEdit={p.typingId === c.id}
            /* 칩을 눌러 글 상자가 열렸다 — 그 자리를 내준다 (`clamp` 해제) */
            onOpen={() => p.onExpand(c.id)}
            // `+n` 은 치려는 게 아니라 **다 보려는** 것이다 — 펴기만 한다
            onMore={() => p.onExpand(c.id)}
            // ★`Enter` 로 끝내면 도로 접는다 · `Shift+Enter`·`Tab` 은 **옆 씬**으로
            onDone={() => p.onExpand(null)}
            onNext={() => p.onStepField(c.id, 1, "text")}
            onTab={(dir) => p.onStepField(c.id, dir, "text")}
          />
        </div>
      </div>

      {/* ★이 상자가 곧 **썸네일 영역**이다 — `flex: 1` 이라 마지막 그림 뒤의 빈 자리까지
          여기 들어간다. 아래 모드에서는 그 위의 휠이 **좌우 스크롤**이 된다 (`onWheel`);
          세로 모드에서는 장이 아래로 쌓이므로 휠을 안 가로챈다. */}
      <div
        data-scene-takes
        style={{
          flex: 1,
          display: "flex",
          alignItems: "center",
          gap: GAP,
          ...(p.vert
            ? { flexDirection: "column" as const, padding: "8px 6px 0" }
            : { padding: "6px 0 6px 8px" }),
        }}
      >
        {!takes.length && !waits.length && (
          <span style={{ fontSize: "var(--text-2xs)", color: "var(--ink-ghost)" }}>
            {t("scenes.noneYet")}
          </span>
        )}
        {/* ★보이는 구간 앞뒤는 **빈 자리**로 때운다 (사용자 지시 2026-08-14).
            폭을 그대로 채워야 스크롤 길이와 눈금이 안 어긋난다. flex 의 gap 때문에
            빈 자리 하나가 간격 하나를 더 만들므로 그만큼 뺀다. */}
        {lead > 0 && <div style={{ ...(p.vert ? { height: lead } : { width: lead }), flexShrink: 0 }} />}
        {waits.slice(from, to).map((q) => {
          /* ★★**만들어지는 중인 칸도 고를 수 있다** (사용자 지시 2026-08-22).
               나올 자리를 미리 잡아 두고 기다리기 위한 것이다. 고르면 프리뷰는 **빈 화면**이고,
               파일이 있어야 하는 단추 줄은 아예 안 뜬다 (`SceneActions` 가 `file` 로 갈린다).
             ★고른 표시는 **테두리를 채운 선으로** 낸다 — 점선은 「아직 없다」는 뜻으로 남긴다. */
          const on = p.focus.pending === q.id;
          const run = q.id === p.firstWaiting;
          return (
            <button
              key={q.id}
              data-pending-cell={q.id}
              /* ★지금 만들고 있는 칸인가 — 서버가 알려 준 것이다 (`current_cell`).
                 회귀·QA 가 이 표식으로 「생성 중이 맞는 자리에 붙었나」를 잰다 */
              data-run={run ? "" : undefined}
              /* ★★**클릭을 여기서 멈춘다** (사용자 지적 2026-08-23: *"생성 중인 이미지도
                   선택 가능하게 고쳤다는데 선택이 안 된다"*). 고르기 자체는 되고 있었는데,
                   그 click 이 씬 줄(`[data-scene]`)까지 올라가면 줄의 `onFocus` 가 뒤이어
                   돌아 `focus(cell, null)` 로 **방금 고른 것을 그 자리에서 지웠다**
                   (`store/sceneFocus` 의 `focus` 는 `pending: null` 을 함께 놓는다).
                 ★같은 함정을 이 파일에서 세 번째 밟았다 — 칸을 새로 만들면 **줄까지
                   올라가는 click 을 먼저 생각한다.** */
              onClick={(e) => {
                e.stopPropagation();
                p.onPickPending(c.id, q.id);
              }}
              style={{
                flexShrink: 0,
                width: p.w,
                height: p.h,
                borderRadius: "var(--r-1)",
                border: `2px ${on ? "solid" : "dashed"} ${on || run ? "var(--accent)" : "var(--line)"}`,
                /* ★★**바탕은 `backgroundColor` 로 칠한다** (사용자 지적 2026-08-26:
                     *"스트리밍 중에 해당 이미지를 선택하면 썸네일이 사라진다"*).
                   `background` 는 줄임 표기라 **`backgroundImage` 를 함께 지운다.**
                   리액트는 바뀐 칸만 다시 먹이므로, 고르기가 켜지는 순간 이 한 줄만 다시
                   먹히면서 깔아 둔 중간 그림이 통째로 날아갔다. 줄임 표기와 낱개 표기를
                   같은 자리에 섞지 말 것. */
                backgroundColor: on ? "var(--accent-bg)" : "var(--bg)",
                display: "grid",
                placeItems: "center",
                fontSize: "calc(11px * var(--text-scale))",
                cursor: "pointer",
                color: on || run ? "var(--accent-ink)" : "var(--ink-faint)",
                /* ★★**그리는 중인 그림을 칸에 깐다** (사용자 지시 2026-08-26). NAI 가 흘려 준
                   중간 프레임이다 (`store/queue` 의 `steps`) — 기다리는 동안 무엇이 나오고
                   있는지가 보이고, 잘못 가고 있으면 일찍 끊을 수 있다.
                   ★글자는 그 위에 남는다 (「생성 중」) — 아직 끝난 것이 아니기 때문이다. */
                /* ★**잘라 채우지 않는다** (사용자 지적 2026-08-26: *"비율이 깨진다"*).
                   칸의 가로세로비는 씬 줄이 정하고 그림의 비는 해상도가 정해서 둘이 다르다 —
                   `cover` 면 그 차이만큼 잘려 나가 다른 그림처럼 보인다. */
                /* ★★★**지금 그리는 칸에만 깐다** (사용자 지적 2026-08-28: *"다중 생성했을 때
                     스트리밍 썸네일이 같은 씬에 걸려 있는 모든 생성 대기 썸네일에 표시됨"*).
                   중간 프레임은 **씬 단위로** 온다(`steps[cellId]`) — 그 씬의 대기 칸이 여럿이면
                   전부 같은 값을 읽어 **한 그림이 여러 칸에 깔렸다.** 실제로 그리고 있는 칸은
                   하나뿐이고, 그것이 `run`(서버가 말하는 `current_cell`)이다. */
                backgroundImage: run && p.stepOf(c.id) ? `url(${p.stepOf(c.id)})` : "none",
                backgroundSize: "contain",
                backgroundRepeat: "no-repeat",
                backgroundPosition: "center",
                // ★글자를 흰색으로 바꾸는 것도 **그림이 깔린 칸에만** (바로 위 ★★★주)
                ...(run && p.stepOf(c.id)
                  ? { color: "#fff", textShadow: "0 1px 3px rgba(0,0,0,0.8)" }
                  : null),
              }}
            >
              {run ? t("slots.running") : t("slots.queued")}
            </button>
          );
        })}
        {takes.slice(Math.max(0, from - waits.length), Math.max(0, to - waits.length)).map((r) => {
          const sel = p.picked.has(r.file);
          const cur = p.focus.cell === c.id && p.focus.file === r.file;
          /** ★미저장 — 파일이 없는 그림이다 (자동 저장 끔). 칸 자리는 저장된 것과 **같고**,
           *  다른 것은 셋뿐이다: 그림을 data URL 로 그린다 · 「미저장」 표가 붙는다 ·
           *  별표를 못 켠다 (별표는 파일 경로로 저장되므로 없는 파일을 담으면 안 된다). */
          const un = r.preview ?? null;
          return (
            <button
              key={r.file}
              data-take={r.file}
              data-take-unsaved={un ? "" : undefined}
              // ★★**생성물을 끌면 카드 그림(커버)이 된다** — 덱·손패·프롬프트 배너가 받는다
              //   (`dir: "image"` 드롭존들). 싱글 캔버스를 걷을 때 이 출발점이 함께 사라져
              //   드래그가 통째로 죽어 있었다 (사용자 지적 2026-08-18).
              // ★클릭(선택)은 `onClick` 이 아니라 **`onTap`** 으로 받는다 — pointerdown 의
              //   `preventDefault` 가 브라우저의 호환 click 을 삼킨다 (CLAUDE.md 「잊기 쉬운 것」).
              // ★미저장은 **못 끈다.** 파일이 없어서 커버로 쓸 수 없다 (받는 쪽이 경로를 쓴다).
              onPointerDown={(e) => {
                // ★★별표는 **여기서 비켜 간다** (사용자 지적 2026-08-19). 끌기가 pointerdown 에서
                //   기본 동작을 막아 **호환 click 을 삼키는** 바람에 별표의 onClick 이 통째로
                //   안 왔다 (CLAUDE.md 「잊기 쉬운 것」의 그 자리다). 블록 머리의 단추들이
                //   같은 이유로 한 번 죽었던 것과 같은 함정이다.
                if ((e.target as HTMLElement).closest("[data-take-star]")) return;
                const tap = () => {
                  // ★미저장은 **여러 장 고르기에서 뺀다.** 고른 것에 걸리는 일(휴지통·강화)이
                  //   전부 파일 경로를 서버로 보내는 것이라, 섞이면 조용히 실패한다.
                  //   버리는 것도 저장하는 것도 큰 그림 아래 줄에서 한다 (`SceneActions`)
                  if (!un && (e.ctrlKey || e.metaKey)) p.onPick(r.file, c.id, false);
                  else if (!un && e.shiftKey) p.onPick(r.file, c.id, true);
                  else {
                    /* ★★**그냥 누르면 여러 장 고르기가 풀린다** (사용자 지시 2026-08-22).
                       ★푸는 것은 **여기서** 한다 — 수식키가 없다는 것을 아는 자리가 여기뿐이다.
                         스토어의 `focus` 에 넣었더니 씬 줄의 click(수식키와 무관하게 올라온다)이
                         Ctrl·Shift 클릭 직후에 그것을 불러 **고르자마자 풀렸다.** */
                    useSceneFocus.getState().setPicked([]);
                    p.onFocus({ cell: c.id, file: r.file });
                  }
                };
                if (un) return tap();
                e.stopPropagation();
                startTakeDrag(
                  e,
                  { dir: "image", kind: "image", img: { ws: p.ws, file: r.file, url: takeSrc(r, p.base, p.ws, true) } },
                  undefined,
                  tap,
                );
              }}
              style={{
                position: "relative",
                flexShrink: 0,
                width: p.w,
                height: p.h,
                borderRadius: "var(--r-1)",
                /* ★★고른 장이 **한눈에** 보여야 한다 (사용자 지적 2026-08-19: 2px 테두리로는
                   어느 것을 보고 있는지 안 보였다). 테두리를 굵히고, 바깥에 어두운 링을
                   둘러 밝은 그림에서도 테두리가 묻히지 않게 한다. 자리는 안 밀린다
                   (`box-shadow` 는 레이아웃을 안 건드린다). */
                border: `2px solid ${sel ? "var(--warn)" : cur ? "var(--accent)" : "transparent"}`,
                boxShadow: cur
                  ? "0 0 0 2px var(--accent), 0 0 0 4px rgba(0,0,0,0.55)"
                  : sel
                    ? "0 0 0 2px var(--warn), 0 0 0 4px rgba(0,0,0,0.55)"
                    : undefined,
                overflow: "hidden",
                background: "var(--surface2)",
                padding: 0,
                lineHeight: 0,
              }}
            >
              <img
                src={takeSrc(r, p.base, p.ws, true)}
                alt=""
                draggable={false}
                /* ★★**`loading="lazy"` 를 안 쓴다** (사용자 지적 2026-08-28: *"탭 이동할 때마다
                     씬에 놓인 썸네일들이 렌더가 안 돼. 커서를 한 번 올려주면 그때 렌더돼"*).
                   이 줄은 **이미 보이는 구간만 그린다**(위 `from`·`to`) — 그리는 것이 곧 보이는
                   것이라 미룰 것이 없는데, `lazy` 는 그 위에서 요청을 한 번 더 미뤘다. 칸이
                   새로 서는 순간(탭 전환)에는 브라우저가 「나중에」로 잡아 두고, 마우스가
                   지나가 검사가 다시 돌 때에야 받아 왔다. 서버는 멀쩡했다 (실측: 그 세션의
                   썸네일 요청 17건이 전부 200 — **요청 자체가 늦게 나갔다**).
                   ★격자로 수백 장을 펴 놓는 화면(갤러리·파일 관리·자동검열)은 구간을 안 나누므로
                     거기서는 `lazy` 가 그대로 필요하다. */
                decoding="async"
                style={{ width: "100%", height: "100%", objectFit: "cover", display: "block", opacity: sel ? 0.6 : 1 }}
              />
              {un ? (
                /* ★「미저장」이 칸에서 바로 보여야 한다 (v2 는 파일명 자리에 `미저장` 을 넣었다 —
                    `index.html:12156`). 우리 칸에는 파일명 줄이 없으므로 아래에 작은 표로 얹는다. */
                <span
                  style={{
                    position: "absolute",
                    left: 0,
                    right: 0,
                    bottom: 0,
                    padding: "1px 3px",
                    background: "rgba(0,0,0,0.55)",
                    color: "var(--warn)",
                    fontSize: "calc(10px * var(--text-scale))",
                    lineHeight: 1.4,
                    textAlign: "center",
                    letterSpacing: "0.02em",
                  }}
                >
                  {t("scenes.unsaved")}
                </span>
              ) : (
                /* ★★**썸네일 위의 별** (2026-08-22 에 걷었다가 되살렸다 2026-08-25).
                   ★평소에는 **안 보이고**(`opacity: 0`), 커서를 올리거나 별이 달려 있을 때만
                     보인다 — 늘 떠 있으면 수십 장이 별 밭이 된다 (`.thumb-star` 규칙).
                   ★12px 은 썸네일 위에서 작았다 → 18px (사용자 지시 2026-08-18).
                   ★미저장 그림에는 안 붙는다 — 별표는 **파일 경로**로 저장되므로 아직
                     파일이 아닌 것에는 달 자리가 없다 (위 갈래가 그것을 가른다). */
                <span
                  data-take-star={r.file}
                  onClick={(e) => {
                    e.stopPropagation();
                    p.onStar(r.file);
                  }}
                  style={{
                    position: "absolute",
                    right: 2,
                    top: 1,
                    display: "grid",
                    color: p.isStarred(r.file) ? "var(--warn)" : "rgba(255,255,255,0.8)",
                    opacity: p.isStarred(r.file) ? 1 : 0,
                    /* ★★**어두운 받침을 깐다** (사용자 지적 2026-08-27: *"별표한 게 너무
                       안 보임. 일러스트 위에 있어서 일러스트랑 섞여서 보여"*). 그림자만으로는
                       밝거나 주황빛인 그림 위에서 별이 묻힌다 — 그림이 무엇이든 **뒤가 어두우면**
                       읽힌다. 별 자체는 색으로 켜짐/꺼짐을 말한다 (`--warn` 대 흰색).
                     ★값은 **갤러리와 같은 것**이다 (`panels/Gallery` 의 `.thumb-star`) —
                       그쪽에는 처음부터 받침이 있었고 여기만 빠져 있었다. 같은 자리에 선
                       같은 표식이라 모양이 갈리면 안 된다. */
                    padding: "1px 2px",
                    borderRadius: 3,
                    background: "rgba(10,14,20,0.55)",
                  }}
                  className="thumb-star"
                >
                  {p.isStarred(r.file) ? Icon.star18On : Icon.star18}
                </span>
              )}
            </button>
          );
        })}
        {tail > 0 && <div style={{ ...(p.vert ? { height: tail } : { width: tail }), flexShrink: 0 }} />}
      </div>
    </div>
  );
}

/** 이름 — 더블클릭으로 그 자리 편집 (한 번 클릭은 줄 고르기).
 *
 *  ★열려 있는 것이 누구인지는 **그릇이 든다** (`editingName`) — `Tab` 으로 옆 씬의 이름 칸으로
 *    건너뛰려면 한 곳이 알아야 하기 때문이다. 여기서 들고 있으면 자기 것만 열고 닫을 수 있다. */
function NameCell({
  id,
  name,
  editing,
  onEditing,
  onRename,
  onTab,
}: {
  /** 조작 테스트가 잡는 손잡이 */
  id: string;
  name: string;
  editing: boolean;
  onEditing: (v: boolean) => void;
  onRename: (v: string) => void;
  onTab: (dir: 1 | -1) => void;
}) {
  const t = useI18n((s) => s.t);
  /** ★규칙은 **앱에 하나**다 (`useRename`): 단추를 다시 누르면 저장하고 끝난다.
   *  ★다만 여닫는 상태는 **줄이 들고 있다** — `Tab` 으로 옆 씬의 이름 칸으로 건너뛰려면
   *    누가 열려 있는지를 한 곳이 알아야 한다.
   *  ★★연필 단추를 **여기서** 단다. 줄 쪽에 따로 두면 그 단추가 훅을 못 봐서 「다시 누르면
   *    끝」을 흉내 내게 되고, 그게 곧 자리마다 다른 동작이 된다 (사용자 지적 2026-08-20). */
  const rename = useRename(name, onRename, { editing, setEditing: onEditing });

  return (
    <>
      {rename.editing ? (
        <input
          data-scene-name={id}
          {...rename.inputProps}
          onKeyDown={(e) => {
            // ★고친 값을 **먼저 넣고** 옮긴다 (v2 index.html:11809-11820 과 같은 이동).
            //   뒤따라 오는 blur 는 이미 연 다음 칸을 닫지 않는다 (`onEditName` 주석)
            if (e.key === "Tab") {
              e.preventDefault();
              rename.commit();
              onTab(e.shiftKey ? -1 : 1);
              return;
            }
            rename.inputProps.onKeyDown(e);
          }}
          style={{
            flex: 1,
            minWidth: 0,
            background: "var(--panel)",
            border: "1px solid var(--accent)",
            borderRadius: "var(--r-1)",
            padding: "0 4px",
            fontSize: "var(--text-xs)",
          }}
        />
      ) : (
        <span
          onDoubleClick={(e) => {
            e.stopPropagation();
            rename.toggle();
          }}
          style={{
            flex: 1,
            minWidth: 0,
            fontSize: "var(--text-xs)",
            color: "var(--ink)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            userSelect: "none",
          }}
        >
          {name}
        </span>
      )}
      {/* ★★단추 차례는 앱 전체에서 하나다: **이름변경 · 온오프(잠금) · 삭제** */}
      <button data-scene-rename={id} {...rename.btnProps} data-tip={t("cards.rename")} style={iconBtn}>
        {Icon.pencil}
      </button>
    </>
  );
}

const bannerBtn: React.CSSProperties = {
  display: "grid",
  placeItems: "center",
  width: 18,
  height: 18,
  borderRadius: "var(--r-1)",
  color: "rgba(255,255,255,0.72)",
};

const iconBtn: React.CSSProperties = {
  display: "grid",
  placeItems: "center",
  width: 17,
  height: 17,
  borderRadius: "var(--r-1)",
  color: "var(--ink-faint)",
  flexShrink: 0,
};
