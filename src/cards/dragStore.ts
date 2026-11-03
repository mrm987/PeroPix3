import { useEffect, useRef } from "react";
import { create } from "zustand";
import type { AnyCard, CardKind } from "../store/cards";
import type { LibItem } from "../store/blockLib";
import type { Block } from "../lib/blocks";

/** 카드 드래그 — **포인터 이벤트로 직접 구현한다.**
 *
 *  ★HTML5 DnD 를 쓰지 않는 이유는 useReorder.ts 와 같다: Tauri(WebView2)에서
 *    HTML5 드래그를 쓰려면 `dragDropEnabled: false` 가 필요한데, 그러면 파일 드롭을 잃는다.
 *    파일 드롭은 레퍼런스 이미지·i2i 에 필요하므로 드래그 쪽을 포인터로 옮긴다.
 *
 *  드롭 존은 화면에 있는 동안 자기 사각형을 등록하고, 포인터가 움직일 때마다
 *  적중 판정을 한다. 겹치는 존(교체/스택)은 `prio` 가 큰 쪽이 이긴다. */

/** apply = 덱 → 목적지 · save = 섹션 → 핸드 · image = 생성물 → 카드 썸네일·이미지 입력 */
export type DragDir = "apply" | "save" | "image";
/** ★`blocklib` = 블록 저장소 → 블록 목록. 카드와 **같은 판을 쓴다** — 끄는 방식·존 판정이
 *  같아야 하나만 고치면 둘 다 고쳐진다 (드래그 구현을 두 벌 두지 않는다)
 *  ★`imageInput` = 미저장 그림. 파일이 없어 카드 그림(경로로 굳힌다)은 못 되고, 이미지 입력의
 *    베이스·Inference 칸만 받는다. 그 칸들은 `image` 도 함께 받는다 (`useDropZone` 의 `kind` 목록) */
export type ZoneKind = CardKind | "image" | "blocklib" | "keep" | "imageInput";

/** 생성된 이미지 한 장 — 썸네일로 넣을 때 끌고 다니는 것.
 *  ★`url` 은 **썸네일** 주소다 (고스트 92×126, 위치 잡는 창 ≤396px — 원본이 필요 없다).
 *    어느 원본인지는 `ws`+`file` 이 들고 있고, 굳히는 것은 서버가 그 원본에서 한다.
 *  ★미저장 그림(`kind: "imageInput"`)이면 `url` 이 그림 전체의 data URL 이다 (`takeSrc`)
 *  ★`v` 는 그 그림의 레코드 `ts` 다. 원본을 받아 올 때 주소에 싣는다 (`lib/imgUrl` 의 ★★주: 같은 경로에 다른 그림) */
export type DragImage = { ws: string; file: string; url: string; v?: string };

export type Dragging = {
  dir: DragDir;
  kind: ZoneKind;
  /** dir 가 apply·save 일 때 */
  card?: AnyCard;
  /** dir 가 image 일 때 */
  img?: DragImage;
  /** kind 가 keep 일 때 — 보관함에서 끌고 있는 그림들 (폴더 줄이 받는다).
   *  ★★**HTML5 드래그를 쓰지 않는다** (머리 주석): Tauri 가 `dragDropEnabled` 로 그것을
   *    가로채므로 앱 안에서는 `dragstart` 가 안 온다. 끌기는 전부 이 포인터 판을 쓴다. */
  files?: string[];
  /** kind 가 keep 일 때 — 보관함에서 끌고 있는 **폴더** (다른 폴더 줄에 놓으면 그 아래로 들어간다,
   *  사용자 지시 2026-09-06). `files` 와 함께 오지 않는다. */
  folder?: string;
  /** kind 가 blocklib · dir 가 apply 일 때 — 저장소에서 끌어낸 항목 (놓으면 **사본**이 들어간다) */
  item?: LibItem;
  /** kind 가 blocklib · dir 가 save 일 때 — 프롬프트에서 저장소로 끌어온 블록.
   *  ★카드의 역드래그 저장(배너 → 핸드)과 **같은 방향**이라 같은 `dir` 를 쓴다 */
  block?: Block;
  /** `block` 이 **어느 목록에서** 나왔나 (`BlockList` 의 `libZone`). 다른 목록에 놓이면 그쪽이
   *  이 열쇠로 명부(`blockZones`)를 찾아 원본을 뺀다 — 카드에서 카드로 **옮기기**
   *  (사용자 지시 2026-08-28). 서랍에 놓이면 사본만 들어가고 이 값은 안 쓴다. */
  srcZone?: string;
  /** kind 가 characters · dir 가 save 일 때 — 끌고 있는 **프롬프트의 캐릭터 카드** (`Char.id`).
   *  덱에 놓으면 저장이고, 다른 캐릭터 카드에 놓으면 그 자리로 차례가 옮겨진다 (사용자 지시 2026-11-03). */
  charId?: string;
  /** dir 가 save 일 때 — 섹션에 꽂혀 있던 그림. 카드는 **같은 tid 를 가리킬 뿐**이라
   *  바이트가 복사되지 않는다 */
  thumb?: SectionThumb | null;
};

/** prompt 스토어의 Thumb 과 같은 모양. 여기서 import 하면 순환 참조가 된다 */
export type SectionThumb = {
  tid: string;
  banner: { zoom: number; px: number; py: number };
  face: { zoom: number; px: number; py: number };
};

type Zone = {
  id: string;
  /** 받는 끌기의 종류 (여럿일 수 있다) */
  kinds: ZoneKind[];
  dir: DragDir;
  prio: number;
  rect: () => DOMRect | null;
  onDrop: (d: Dragging) => void;
};

type S = {
  drag: Dragging | null;
  pos: { x: number; y: number };
  over: string | null;
  /** 방금 끝난 끌기가 **놓인 존의 id** (안 놓였으면 null). 끌기가 끝난 뒤(`drag === null`)에 읽는다 —
   *  잠깐 펴 줬던 쪽이 「열어 둘지 도로 닫을지」를 이것으로 가른다 (`useDeckPeek` · 이미지 입력 묶음) */
  droppedOn: string | null;
  zones: Zone[];

  begin: (d: Dragging, x: number, y: number) => void;
  move: (x: number, y: number) => void;
  end: () => boolean;
  cancel: () => void;
  addZone: (z: Zone) => () => void;
};

export const useDrag = create<S>((set, get) => ({
  drag: null,
  pos: { x: 0, y: 0 },
  over: null,
  droppedOn: null,
  zones: [],

  begin(d, x, y) {
    set({ drag: d, pos: { x, y }, over: null, droppedOn: null });
    window.addEventListener("scroll", rehit, true);
  },

  move(x, y) {
    const { drag, zones } = get();
    if (!drag) return;
    let hit: Zone | null = null;
    for (const z of zones) {
      if (!z.kinds.includes(drag.kind) || z.dir !== drag.dir) continue;
      const r = z.rect();
      if (!r) continue;
      if (x < r.left || x > r.right || y < r.top || y > r.bottom) continue;
      // 같은 우선순위가 겹치면 **나중에 등록된 것**이 이긴다 — 나중 것이 위에 그려진다
      if (!hit || z.prio >= hit.prio) hit = z;
    }
    set({ pos: { x, y }, over: hit ? hit.id : null });
  },

  /** 손을 뗐다. 드롭이 실제로 일어났으면 true — 덱을 닫을지 판단에 쓴다. */
  end() {
    window.removeEventListener("scroll", rehit, true);
    const { drag, over, zones } = get();
    set({ drag: null, over: null, droppedOn: drag && over ? over : null });
    if (!drag || !over) return false;
    zones.find((z) => z.id === over)?.onDrop(drag);
    return true;
  },

  cancel() {
    window.removeEventListener("scroll", rehit, true);
    set({ drag: null, over: null, droppedOn: null });
  },

  addZone(z) {
    set({ zones: [...get().zones, z] });
    return () => set({ zones: get().zones.filter((x) => x !== z) });
  },
}));

/** ★끄는 동안 무엇이든 스크롤되면 **그 자리에서 다시 잰다.** 판정은 포인터가 움직일 때만 도는데,
 *  끄는 채로 휠을 굴리면 커서는 그대로이고 밑의 칸만 바뀐다 (이미지 입력은 왼쪽 기둥 아래에 있어
 *  굴려 내려가서 놓는다). 안 재면 강조가 옛 칸에 남고 놓으면 옛 칸이 받는다.
 *  ★스크롤은 거품이 안 올라오므로 캡처로 받는다. `begin` 에서 걸고 `end`·`cancel` 에서 뗀다 */
function rehit() {
  const { drag, pos, move } = useDrag.getState();
  if (drag) move(pos.x, pos.y);
}

/** 드롭 존 등록 — 반환한 ref 를 DOM 요소에 붙인다. */
export function useDropZone(opts: {
  id: string;
  /** 받는 끌기의 종류. 여럿이면 목록으로 준다 (이미지 입력 칸은 `image` 와 `imageInput` 을 둘 다 받는다) */
  kind: ZoneKind | ZoneKind[];
  dir?: DragDir;
  prio?: number;
  /** ★**여기 보이는 만큼만** 받는다 (스크롤 되는 목록 안의 존). 준 요소와 겹치는
   *  부분만 유효 영역이 되고, 하나도 안 겹치면 그 존은 없는 것처럼 다뤄진다.
   *
   *  ★없으면 스크롤로 밀려 화면 밖에 있는 칸도 **자기 자리에서는 계속 받는다** —
   *    판정이 순수 사각형 겹침이라 잘려 안 보이는 부분까지 유효해지기 때문이다
   *    (사용자 지시 2026-08-19: "해당 카드가 받을 수 있게 노출된 상태일 때만"). */
  clip?: React.RefObject<HTMLElement | null>;
  onDrop: (d: Dragging) => void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  // onDrop 은 매 렌더 새로 만들어지므로 최신 것을 상자에 담아 둔다
  //  — 등록/해제를 매 렌더 반복하면 드래그 중에 존이 사라진다
  const cb = useRef(opts.onDrop);
  cb.current = opts.onDrop;

  const { id, dir = "apply", prio = 0 } = opts;
  // ★목록은 렌더마다 새로 만들어지므로 글자로 묶어 딸림값에 넣는다 (배열을 넣으면 매 렌더 다시 등록된다)
  const kindKey = ([] as ZoneKind[]).concat(opts.kind).join(",");
  const clip = useRef(opts.clip);
  clip.current = opts.clip;
  useEffect(
    () =>
      useDrag.getState().addZone({
        id,
        kinds: kindKey.split(",") as ZoneKind[],
        dir,
        prio,
        rect: () => {
          const r = ref.current?.getBoundingClientRect();
          if (!r) return null;
          const c = clip.current?.current?.getBoundingClientRect();
          if (!c) return r;
          // 보이는 만큼으로 자른다. 하나도 안 겹치면 없는 존이다
          const left = Math.max(r.left, c.left);
          const right = Math.min(r.right, c.right);
          const top = Math.max(r.top, c.top);
          const bottom = Math.min(r.bottom, c.bottom);
          if (right <= left || bottom <= top) return null;
          return new DOMRect(left, top, right - left, bottom - top);
        },
        onDrop: (d) => cb.current(d),
      }),
    [id, kindKey, dir, prio],
  );

  const over = useDrag((s) => s.over === id);
  const active = useDrag((s) => !!s.drag && kindKey.split(",").includes(s.drag.kind) && s.drag.dir === dir);
  return { ref, over, active };
}

/* ── 포인터 제스처 공통 ─────────────────────────────────────────
 * 끄는 동작(카드 드래그·미리보기 위치 조정)은 전부 이걸 거친다.
 * 여기 모아 두는 이유는 **엣지 케이스가 전부 같기 때문**이다:
 *
 *  1. 기본 동작을 막는다 — 안 막으면 브라우저 네이티브 드래그가 시작되고
 *     그 뒤 pointermove·pointerup 이 오지 않아 화면이 굳는다 (WebView2 실측).
 *  2. **포인터를 캡처한다** — 커서가 영역을 벗어나도 계속 이 제스처가 받는다.
 *     캡처를 안 하면 옆의 다른 조작 영역이 반응하고 커서 모양이 풀린다 (실측 지적).
 *  3. **화면 전체 커서를 고정한다**(html.is-dragging) — 캡처만으로는 커서가 돌아온다.
 *  4. 포인터를 잃거나(pointercancel) 창이 포커스를 잃으면(blur) **취소**로 끝낸다 —
 *     안 그러면 어둠·고스트가 화면에 남는다.
 *  5. 다른 손가락(pointerId)의 이벤트는 무시한다.
 *  6. Esc 로 언제든 취소할 수 있다 (`cancelGesture`).
 */
let activeCancel: (() => void) | null = null;

/** 지금 끌고 있는 중인가 — 휠·Esc 처리에서 본다 */
export const isGestureActive = () => activeCancel !== null;
/** 진행 중인 제스처를 취소로 끝낸다 (Esc 등) */
export const cancelGesture = () => activeCancel?.();

export function pointerGesture(
  e: React.PointerEvent,
  o: { onMove: (ev: PointerEvent) => void; onEnd?: (committed: boolean) => void },
): boolean {
  if (e.button !== 0) return false;
  cancelGesture(); // 앞의 제스처가 남아 있으면 정리하고 시작한다
  e.preventDefault();

  const el = e.currentTarget as HTMLElement;
  const pid = e.pointerId;
  try {
    el.setPointerCapture(pid);
  } catch {
    /* 캡처를 못 해도 window 리스너로 동작한다 */
  }
  document.documentElement.classList.add("is-dragging");

  const move = (ev: PointerEvent) => {
    if (ev.pointerId === pid) o.onMove(ev);
  };
  const finish = (committed: boolean) => {
    if (activeCancel !== cancel) return; // 이미 끝난 제스처
    activeCancel = null;
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    window.removeEventListener("pointercancel", cancel);
    window.removeEventListener("blur", cancel);
    document.documentElement.classList.remove("is-dragging");
    try {
      el.releasePointerCapture(pid);
    } catch {
      /* 이미 풀렸으면 그만이다 */
    }
    o.onEnd?.(committed);
  };
  const up = (ev: PointerEvent) => {
    if (ev.pointerId === pid) finish(true);
  };
  const cancel = () => finish(false);

  activeCancel = cancel;
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
  window.addEventListener("pointercancel", cancel);
  window.addEventListener("blur", cancel);
  return true;
}

/** 드래그를 시작하는 쪽에 붙이는 포인터 핸들러.
 *  ★임계값(4px)을 두는 이유: 클릭도 같은 요소에서 받기 때문이다.
 *    문턱을 넘기 전에는 드래그로 치지 않아 "클릭 = 즉시 적용"이 살아 있다. */
export function useDragSource() {
  return (
    e: React.PointerEvent,
    d: Dragging,
    onDrop?: (dropped: boolean) => void,
    /** 문턱을 안 넘기고 뗐을 때(= 클릭). ★pointerdown 의 preventDefault 가 브라우저의
     *  호환 click 이벤트를 삼키므로, 드래그 출발점의 클릭 동작은 onClick 이 아니라 여기로 받는다 */
    onTap?: () => void,
  ) => {
    const sx = e.clientX;
    const sy = e.clientY;
    let started = false;

    pointerGesture(e, {
      onMove: (ev) => {
        if (!started) {
          if (Math.hypot(ev.clientX - sx, ev.clientY - sy) < 4) return;
          started = true;
          useDrag.getState().begin(d, ev.clientX, ev.clientY);
        }
        useDrag.getState().move(ev.clientX, ev.clientY);
      },
      onEnd: (committed) => {
        if (!started) {
          if (committed) onTap?.();
          return;
        }
        if (!committed) {
          useDrag.getState().cancel();
          return;
        }
        // ★`onDrop?.(end())` 로 쓰지 말 것 — 옵셔널 호출은 콜백이 없으면 **인자도 평가하지 않는다.**
        //   콜백을 넘기지 않는 역드래그 저장이 통째로 무시된다. 두 번 밟은 함정이라 줄을 나눠 둔다:
        //   end() 를 **먼저 부르고**, 그 결과를 콜백에 넘긴다.
        const dropped = useDrag.getState().end();
        onDrop?.(dropped);
      },
    });
  };
}

/** 드래그 출발점에 공통으로 붙이는 스타일 — 네이티브 드래그·선택을 원천에서 막는다.
 *  (`WebkitUserDrag` 는 표준이 아니라 타입에 없어 캐스팅한다) */
export const dragSourceStyle = {
  touchAction: "none",
  userSelect: "none",
  WebkitUserSelect: "none",
  WebkitUserDrag: "none",
} as React.CSSProperties;
