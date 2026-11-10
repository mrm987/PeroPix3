import { useCallback, useRef, useState } from "react";
import { locate } from "../lib/floatWin";

/** 태그 칩 하나가 놓일 자리 — 어느 목록의 몇 번째 블록, 그 안의 몇 번째 칸인가.
 *  `index === -1` 은 **그 블록의 끝**이다 (접힌 블록에 떨어뜨렸을 때).
 *
 *  ★`list` 는 그 목록의 `libZone` 이다. **끌어낸 곳과 다를 수 있다** — 카드를 넘어 옮기기
 *    (사용자 지시 2026-08-24). 비어 있으면 열쇠가 없는 목록이라 받지 못한다. */
export type Spot = { block: number; index: number; list?: string };

/** 칩을 끌어 자리를 옮긴다 — 같은 블록 안에서도, 다른 블록으로도, **다른 카드로도**.
 *
 *  ★블록 순서 변경(`useReorder`)과 같은 포인터 방식이다. 이유도 같다 — WebView2 가
 *    HTML5 드래그를 파일 드롭으로 가로챈다.
 *  ★칩 위치는 **끌고 있는 동안 실시간으로 잰다**. 삽입 표시가 레이아웃을 밀지 않도록
 *    화면 좌표에 떠 있는 막대로 그리므로, 재는 값이 흔들리지 않는다.
 *  ★★**놓을 자리는 화면 전체를 훑어서 찾는다** (`[data-block-row]`). 등록부를 두면 카드
 *    사이를 오갈 때 낡은 칸이 남고, 애초에 **다른 목록의 줄은 내 등록부에 없다.**
 *    칩을 `[data-chip]` 으로 훑는 것과 같은 이유이고(칩은 지웠다 만들었다 한다),
 *    씬 줄이 카드를 넘어 옮길 때 쓰는 방식과도 같다 (`useLaneReorder` 의 ★주).
 *  ★★한 목록 안일 때는 **y 만 보면 됐지만** 화면 전체를 보면 **x 도 봐야 한다** — 좌우로
 *    멀리 떨어진 목록도 높이만 맞으면 잡히기 때문이다. 그래서 사각형까지의 거리로 고른다. */
export function useTagDrag(onMove: (from: Spot, to: Spot) => void) {
  const start = useRef<{ from: Spot; label: string; x: number; y: number } | null>(null);
  const overRef = useRef<Spot | null>(null);
  /** 방금 끌기가 끝났나 — 끌고 난 뒤의 클릭이 "텍스트로 편집"을 열지 않게 */
  const endedAt = useRef(-1e9);

  const [from, setFrom] = useState<Spot | null>(null);
  const [label, setLabel] = useState("");
  /** 끼울 자리에 세우는 막대 (화면 좌표) */
  const [bar, setBar] = useState<{ x: number; y: number; h: number } | null>(null);
  /** 접힌 블록이 받을 때 — 막대 대신 그 줄 전체를 두른다 */
  const [box, setBox] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const [ghost, setGhost] = useState<{ x: number; y: number } | null>(null);
  /** 표시들이 그려질 창 — 커서가 있는 창이다. 칩은 앱 밖 창으로 넘어갈 수 있다 (`lib/floatWin`) */
  const [win, setWin] = useState<Window | null>(null);
  /** 끌기가 시작된 창. 포인터 좌표는 언제나 이 창 기준으로 온다 */
  const src = useRef<Window | null>(null);

  /** 사각형까지의 거리 — 안에 있으면 0 */
  const distTo = (r: DOMRect, x: number, y: number) =>
    Math.hypot(Math.max(r.left - x, 0, x - r.right), Math.max(r.top - y, 0, y - r.bottom));

  /** ★★그 줄이 사는 **층** — 화면을 덮는 창(모달)이 있으면 그 창이다.
   *
   *  화면 전체를 훑게 되면서 생긴 문제를 막는다: 카드 편집 창은 `position: fixed; inset: 0`
   *  으로 화면을 덮는데, 그 창 안에서 끌던 칩을 창 바깥(어두운 바탕) 근처에 놓으면 **그 아래
   *  가려져 있는 좌 패널의 줄**이 잡혀서 칩이 안 보이는 데로 사라진다. 시작한 층 안의 줄만 받는다.
   *  ★시작할 때 **한 번만** 잰다 — 후보 줄마다 계산된 스타일을 물으면 끌 때마다 비싸다. */
  const layerOf = (el: HTMLElement): Element => {
    for (let n: HTMLElement | null = el; n; n = n.parentElement) {
      if (getComputedStyle(n).position === "fixed") return n;
    }
    return el.ownerDocument.body;
  };
  const layer = useRef<Element | null>(null);

  /** 포인터 아래의 자리. 칩이 행 우선으로 놓이므로 **앞선 칩의 수**가 곧 끼울 자리다. */
  const spotAt = useCallback((x0: number, y0: number) => {
    const loc = locate(src.current ?? window, x0, y0);
    if (!loc) return null;
    const { x, y } = loc;
    const doc = loc.win.document;
    /* ★모달 안에서 시작한 끌기는 그 모달 밖으로 못 나간다. 평범한 화면에서 시작했으면 다른 창의 줄도 받는다 */
    const lay = layer.current;
    if (lay && lay.ownerDocument !== doc && lay !== lay.ownerDocument.body) return null;
    let row: HTMLElement | null = null;
    let best = 24; // 블록 사이 틈(DropLine)만큼은 가까운 줄로 쳐 준다
    for (const el of doc.querySelectorAll<HTMLElement>("[data-block-row]")) {
      if (lay && lay.ownerDocument === doc && !lay.contains(el)) continue;
      const d = distTo(el.getBoundingClientRect(), x, y);
      if (d < best || (d === 0 && !row)) {
        best = d;
        row = el;
        if (d === 0) break;
      }
    }
    if (!row) return null;

    /* 그 줄이 **어느 목록의 몇 번째**인가 — 목록을 거슬러 올라가 그 안에서 센다.
       ★번호를 표식으로 적어 두지 않는 이유: 블록은 지웠다 만들었다 하는 것이라 적어 두면
         낡은 번호가 남는다 (칩을 훑는 것과 같은 사정). DOM 순서가 곧 블록 순서다. */
    const listEl = row.closest<HTMLElement>("[data-block-list]");
    const list = listEl?.dataset.blockList || undefined;
    const siblings = listEl
      ? [...listEl.querySelectorAll<HTMLElement>("[data-block-row]")]
      : [row];
    const bi = Math.max(0, siblings.indexOf(row));

    const chips = Array.from(row.querySelectorAll<HTMLElement>("[data-chip]"));
    const area = row.querySelector<HTMLElement>("[data-chips]");

    // 접힌 블록 — 칩이 아예 안 그려져 있다. 통째로 받아 **끝에** 붙인다
    if (!area) {
      const r = row.getBoundingClientRect();
      return {
        spot: { block: bi, index: -1, list },
        box: { x: r.left, y: r.top, w: r.width, h: r.height },
      };
    }

    let idx = 0;
    let mark: DOMRect | null = null;
    for (const el of chips) {
      const r = el.getBoundingClientRect();
      // 윗줄에 있으면 무조건 앞 · 같은 줄이면 가운데를 넘겼을 때만 앞
      if (y > r.bottom || (y >= r.top && x > r.left + r.width / 2)) idx++;
    }
    if (chips.length) mark = chips[Math.min(idx, chips.length - 1)].getBoundingClientRect();

    const a = area.getBoundingClientRect();
    const at = mark
      ? { x: idx < chips.length ? mark.left - 2 : mark.right + 1, y: mark.top, h: mark.height }
      : { x: a.left, y: a.top, h: Math.max(14, Math.min(20, a.height)) };
    return { spot: { block: bi, index: idx, list }, bar: at };
  }, []);

  const reset = useCallback(() => {
    start.current = null;
    layer.current = null;
    overRef.current = null;
    setFrom(null);
    setBar(null);
    setBox(null);
    setGhost(null);
    setWin(null);
  }, []);

  const handle = useCallback(
    (block: number, index: number, tagLabel: string) => ({
      onPointerDown: (e: React.PointerEvent) => {
        if (e.button !== 0) return;
        e.stopPropagation();
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        // ★받을 수 있는 층을 여기서 한 번 정한다 (위 `layerOf` 의 ★주)
        layer.current = layerOf(e.currentTarget as HTMLElement);
        src.current = (e.currentTarget as HTMLElement).ownerDocument.defaultView;
        start.current = { from: { block, index }, label: tagLabel, x: e.clientX, y: e.clientY };
      },
      onPointerMove: (e: React.PointerEvent) => {
        const s = start.current;
        if (!s) return;
        // ★몇 픽셀 움직이기 전에는 끌기로 치지 않는다 — 칩을 그냥 누르면 텍스트 편집이 열린다
        if (!from) {
          if (Math.abs(e.clientX - s.x) + Math.abs(e.clientY - s.y) < 5) return;
          setFrom(s.from);
          setLabel(s.label);
        }
        const hit = spotAt(e.clientX, e.clientY);
        overRef.current = hit?.spot ?? null;
        setBar(hit?.bar ?? null);
        setBox(hit?.box ?? null);
        const at = locate(src.current ?? window, e.clientX, e.clientY);
        setWin(at?.win ?? null);
        setGhost(at ? { x: at.x + 10, y: at.y + 12 } : null);
      },
      onPointerUp: (e: React.PointerEvent) => {
        (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
        const s = start.current;
        const to = overRef.current;
        const active = from != null;
        reset();
        if (!active) return;
        endedAt.current = performance.now();
        if (s && to) onMove(s.from, to);
      },
      onPointerCancel: reset,
      style: { cursor: "grab", touchAction: "none" as const },
    }),
    [from, spotAt, onMove, reset],
  );

  return {
    handle,
    from,
    label,
    bar,
    box,
    ghost,
    /** ★★창은 **값이 아니라 함수로** 내준다 (사용자 지적 2026-11-10: 칩을 끌자 화면이 통째로 멈췄다).
     *  이 객체는 `TagDragLayer` 의 props 로 가는데, React 개발 빌드는 바뀐 props 를 세 단계까지 훑는다
     *  (`logComponentRender`). 창을 값으로 두면 그 창의 프레임까지 읽다가 다른 출처 iframe(플러그인 페이지)에서
     *  SecurityError 가 나고, 그 뒤로 React 가 아예 그리지 못한다. 함수는 이름만 적고 안을 훑지 않는다. */
    win: () => win,
    /** 끌고 난 직후의 클릭인가 (텍스트 편집이 딸려 열리는 것을 막는다) */
    justDragged: () => performance.now() - endedAt.current < 250,
  };
}
