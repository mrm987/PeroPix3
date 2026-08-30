import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "../i18n";
import { dupSet, makeBlock, parseSegs, type Block } from "../lib/blocks";
import { useReorder } from "../lib/useReorder";
import { moveTo } from "../lib/moveTo";
import { useTagDrag, type Spot } from "./useTagDrag";
import { getZone, registerZone, type BlockZone } from "./blockZones";
import { TagDragLayer } from "./TagDragLayer";
import { BlockRow } from "./BlockRow";
import { itemToBlock } from "../store/blockLib";
import { dropUndo, pushUndo } from "../lib/undo";
import { useDrag, useDragSource, useDropZone } from "../cards/dragStore";
import { DragGhost } from "../cards/DragGhost";

/** 블록 시퀀스 — **블록의 위치가 곧 프롬프트의 위치**다.
 *
 *  순서 변경은 그립(⠿) 드래그. 드래그 중에는
 *   - 원본이 흐려지고(고스트),
 *   - 놓일 자리에 굵은 액센트 선이 자리를 벌리며 나타난다.
 *  포인터 이벤트 기반이라 WebView2 의 파일 드롭 핸들러와 충돌하지 않는다 (useReorder.ts).
 *
 *  ★**태그 칩도 같은 방식으로 끈다** (useTagDrag) — 블록 안에서도, 블록 사이로도.
 *    칩 하나하나를 블록 모양으로 만든 까닭이 이것이다 (사용자 2026-08-07).
 *
 *  ★★**블록을 고치는 자리는 앱에 이것 하나다** (사용자 지적 2026-08-20:
 *    *"네가 실제로 동일한 컴포넌트를 쓰는게 아니고 복제해서 만드니까 불일치가 계속 생김"*).
 *    씬 칸은 예전에 `SlotBlock` 이라는 **따로 만든 부품**이었는데, 칩 끌기·서랍 드롭존·
 *    드래그 표시·중복 검사를 각자 한 벌씩 들고 있어 조작이 계속 어긋났다.
 *    이제 씬 칸은 **이 목록의 `single` 모드**다 — 배선이 한 벌뿐이라 어긋날 자리가 없다.
 *
 *  `single` 이 바꾸는 것은 넷뿐이다:
 *    1. 블록이 **하나뿐**이다 — 「+ 블록」도, 블록 사이 끼우기도 없다.
 *    2. 머리(이름·색·켜고끄기·삭제)를 안 그린다 (`BlockRow bare`) — 칸 이름은 줄 머리에 있다.
 *    3. 서랍에서 받으면 **태그가 뒤에 붙는다** (블록을 더하는 게 아니라).
 *    4. `clamp` 를 주면 넘치는 만큼 자르고 `+n` 으로 알린다 (씬 줄이 접혀 있을 때). */
export function BlockList({
  blocks,
  onChange,
  libZone,
  single,
  fill,
  open,
  id,
  clamp,
  bg,
  autoEdit,
  onMore,
  onOpen,
  onDone,
  onNext,
  onTab,
}: {
  blocks: Block[];
  onChange: (b: Block[]) => void;
  /** 저장소에서 끌어온 블록을 받을 자리인가 — **화면에서 유일한 id** 를 준다.
   *  ★목록이 여럿이라(베이스·UC·캐릭터마다·씬 칸마다) id 가 겹치면 엉뚱한 곳에 떨어진다 */
  libZone?: string;
  /** 블록이 **하나뿐인** 자리인가 (씬 칸). 위 머리 주석의 넷이 달라진다 */
  single?: boolean;
  /** ★씬 머리처럼 **칸이 먼저 정해진 자리** — 그 칸을 채운다 (`BlockBody` 의 `fill`) */
  fill?: boolean;
  /** `fill` 인 자리에서 **펼쳐져 있나** — `false` 면 글 상자도 닫는다 (`BlockBody` 의 `open`) */
  open?: boolean;
  /** `single` 일 때 이 자리를 가리키는 이름 — `data-slot-block` 으로 나간다 */
  id?: string;
  /** 자리가 좁아 **잘라 보여 주는** 상태인가. 넘치는 칩 수를 `+n` 으로 낸다 */
  clamp?: boolean;
  /** `+n` 뒤에 깔 바탕 — 잘린 칩 위에 뜨므로 줄 바탕과 같아야 글자가 읽힌다 */
  bg?: string;
  /** 떠오르자마자 글 상자를 연다 (`Tab` 으로 건너온 씬 칸) */
  autoEdit?: boolean;
  /** `+n` 을 눌렀다 — 치려는 게 아니라 **다 보려는** 것이다 */
  onMore?: () => void;
  /** 글 상자가 열렸다 — 잘라 보여 주던 부모가 **자리를 내준다** */
  onOpen?: () => void;
  /** Enter 로 편집을 끝냈다 (씬 줄은 도로 접는다) */
  onDone?: () => void;
  /** Shift+Enter — `single` 에서는 새 블록 대신 **다음 칸**으로 간다 */
  onNext?: () => void;
  /** Tab — 옆 칸으로 */
  onTab?: (dir: 1 | -1) => void;
}) {
  const t = useI18n((s) => s.t);
  const startDrag = useDragSource();
  // ★존은 **언제나 등록한다** — 조건부 훅은 규칙 위반이고, 끄는 중이 아니면 판정도 안 돈다
  const zone = useDropZone({
    id: `blocklib-${libZone ?? "none"}`,
    kind: "blocklib",
    onDrop: (d) => {
      if (!libZone || !d.item) return;
      const got = itemToBlock(d.item);
      // ★`single` 은 블록을 더할 수 없다 — 태그를 **뒤에 붙인다**
      if (!single) {
        pushUndo(t("common.undoBlockAdd"), () => onChange(blocks), libZone);
        return onChange([...blocks, got]);
      }
      const b = blocks[0];
      if (b) onChange([{ ...b, tags: [...b.tags, ...got.tags] }]);
    },
  });
  /* ★★블록을 **다른 카드로 옮긴다** (사용자 지시 2026-08-28: *"프롬프트 블록도 카드에서
       카드로 옮겨지게"*). 끄는 동작은 서랍에 넣는 것과 같은 것(`dir: "save"`)이고 **어디에
       놓느냐**만 다르다 — 서랍이면 사본이 들어가고 원본은 그대로, 다른 목록이면 옮겨진다.
     ★출발한 목록에서 빼는 것은 명부(`blockZones`)를 거친다 — 칩을 카드 너머로 옮길 때와
       같은 길이다 (`moveTag` 의 ★★주). 빼는 것을 **먼저** 한다.
     ★씬 칸(`single`)에 놓으면 그 하나에 태그가 붙는다 — 서랍에서 받을 때와 같은 규칙. */
  const moveIn = useDropZone({
    id: `blockmove-${libZone ?? "none"}`,
    kind: "blocklib",
    dir: "save",
    onDrop: (d) => {
      const b = d.block;
      if (!libZone || !b || !d.srcZone || d.srcZone === libZone) return;
      const from = getZone(d.srcZone);
      if (!from) return;
      from.onChange(from.blocks.filter((x) => x.id !== b.id));
      if (single) {
        const me = blocks[0];
        if (me) onChange([{ ...me, tags: [...me.tags, ...b.tags] }]);
        return;
      }
      /* ★★**놓은 자리에 끼운다** (사용자 지시 2026-08-30: 다른 카드로 옮길 때도 정확한 자리를
         고를 수 있게). 끝에 붙이던 것을, 놓는 순간의 포인터로 틈을 재서 그 자리에 넣는다 —
         같은 목록 안의 순서 바꾸기와 같은 셈이다. */
      const p = useDrag.getState().pos;
      const g = crossGap(p.x, p.y);
      const next = blocks.slice();
      next.splice(g, 0, b);
      onChange(next);
    },
  });
  /** 포인터가 이 목록의 몇 번째 틈에 있나 (0..n) — 줄의 세로 중앙을 기준으로 (`useReorder.gapAt` 과 같다) */
  const crossGap = (x: number, y: number) => {
    const rows = box.current ? [...box.current.querySelectorAll<HTMLElement>(":scope [data-block-row]")] : [];
    let gap = 0;
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i].getBoundingClientRect();
      gap = y < r.top + r.height / 2 ? i : i + 1;
      if (y < r.top + r.height) break;
    }
    void x;
    return gap;
  };
  /** 다른 카드의 블록이 **이 목록 위에** 있는 동안의 틈 — 그 줄에만 끼움선을 긋는다.
   *  ★목록 전체를 밝히면 「갈아 끼운다」로 읽힌다 (사용자 지적 2026-08-30) — 자리 하나만 보인다. */
  const crossPos = useDrag((s) => (s.over === `blockmove-${libZone ?? "none"}` && s.drag?.srcZone !== libZone ? s.pos : null));
  const crossOver = useMemo(() => (crossPos && !single ? crossGap(crossPos.x, crossPos.y) : null), [crossPos, single]);
  /** 지금 끌리는 블록이 **이 목록에서** 나왔나 — 제 자리는 받을 자리로 안 빛난다 */
  const fromMe = useDrag((s) => s.drag?.srcZone === libZone);
  const dup = dupSet(blocks);
  /** 갓 만들어진 블록 — 뜨자마자 편집 상태가 된다 */
  const [editId, setEditId] = useState<string | null>(null);
  /** Enter 로 딸려 만들어진 블록들. 비운 채 Esc 로 나가면 도로 거둔다 */
  const auto = useRef(new Set<string>());

  const move = (from: number, to: number) => onChange(moveTo(blocks, from, to));

  /* ★★**명부에 올린다** — 다른 카드에서 끌어온 칩이 이 목록을 고칠 수 있어야 한다
     (`blockZones`). 상자에 담으므로 아래 `zoneBox.current` 는 언제나 최신이다. */
  const zoneBox = useRef<BlockZone>({ blocks, onChange, single });
  zoneBox.current = { blocks, onChange, single };
  useEffect(() => (libZone ? registerZone(libZone, zoneBox) : undefined), [libZone]);

  /** 칩 하나를 옮긴다 — 같은 블록 안·다른 블록·**다른 카드**.
   *
   *  ★★카드를 넘을 때는 **양쪽을 각각 고친다** (사용자 지시 2026-08-24). 두 목록은 서로 다른
   *    자리에 살아서(캐릭터마다·씬 칸마다) 한 번의 `onChange` 로는 닿지 않는다 — 빼는 쪽은
   *    내 `onChange`, 넣는 쪽은 명부에서 꺼낸 그쪽 `onChange` 다.
   *  ★★**빼는 것을 먼저** 한다. 거꾸로 하면 그 사이에 실패했을 때 **칩이 양쪽에 다 있다** —
   *    없어지는 것보다야 낫지만 사용자는 왜 둘이 됐는지 알 수 없다.
   *  ★넣는 쪽이 블록 하나짜리(씬 칸)면 그 하나에 붙는다 — 서랍에서 블록을 받을 때와 같은 규칙.
   *  ★열쇠 없는 목록은 명부에 없다 → **끌어낼 수는 있어도 받지는 못한다.** 그때는 아무 일도
   *    안 일어난다 (칩이 사라지지 않는다). */
  const moveTag = (from: Spot, to: Spot) => {
    const cross = !!to.list && to.list !== libZone;
    const dst = cross ? getZone(to.list!) : null;
    if (cross && !dst) return; // 받을 수 없는 자리 — 그대로 둔다

    const n = blocks.map((b) => ({ ...b, tags: b.tags.slice() }));
    const [tag] = n[from.block].tags.splice(from.index, 1);
    if (!tag) return;

    if (dst) {
      onChange(n); // 먼저 뺀다 (위 ★주)
      const m = dst.blocks.map((b) => ({ ...b, tags: b.tags.slice() }));
      // ★블록이 하나뿐인 자리(씬 칸)는 그 하나가 목적지다
      const bi = dst.single ? 0 : Math.min(Math.max(to.block, 0), m.length - 1);
      if (!m[bi]) return; // 빈 목록에는 넣을 블록이 없다
      const at = to.index < 0 ? m[bi].tags.length : Math.min(to.index, m[bi].tags.length);
      m[bi].tags.splice(at, 0, tag);
      dst.onChange(m);
      return;
    }

    // -1 은 "그 블록의 끝" (접힌 블록에 떨어뜨린 경우)
    let at = to.index < 0 ? n[to.block].tags.length : to.index;
    if (to.block === from.block && at > from.index) at--;
    if (to.block === from.block && at === from.index) return; // 제자리
    n[to.block].tags.splice(at, 0, tag);
    onChange(n);
  };

  /** 목록의 상자 — 받는 자리 셋(`zone`·`moveIn`)과 순서 바꾸기의 `within` 이 함께 쓴다 */
  const box = useRef<HTMLDivElement>(null);
  const { register, handleProps, dragIdx, overIdx, ghost } = useReorder(blocks.length, move, { within: box });
  /** ★★손잡이 끌기 **하나**가 순서 바꾸기·서랍 넣기·다른 카드로 옮기기를 다 맡는다 (사용자 지시
   *  2026-08-30: 이름을 끌어야 저장되는 것이 비직관적이었다). 누르는 순간 두 제스처를 함께 시작한다 —
   *  목록 안에서 놓으면 순서가 바뀌고(`useReorder`), 밖(서랍·다른 카드)에서 놓으면 그쪽 받는 자리가
   *  받는다(`dragStore`). 제 목록의 받는 자리는 제 것을 거절하므로 둘이 겹치지 않는다. */
  const grip = (i: number, b: Block) => {
    const h = handleProps(i);
    return {
      ...h,
      onPointerDown: (e: React.PointerEvent) => {
        h.onPointerDown(e);
        startDrag(e, { dir: "save", kind: "blocklib", block: b, srcZone: libZone });
      },
    };
  };
  const tag = useTagDrag(moveTag);
  const replace = (i: number, b: Block) => onChange(blocks.map((x, j) => (j === i ? b : x)));

  /** Shift+Enter — 이 블록을 반영하면서 **바로 뒤에** 새 블록을 만들고 거기로 넘어간다.
   *
   *  ★★**커서 뒤의 글이 새 블록으로 옮겨 간다** (사용자 지시 2026-08-22:
   *    *"해당 위치부터 뒤에있는 텍스트 전체를 새로 만든 블록으로 이동"*). 예전에는 통째로
   *    반영하고 **빈** 블록을 만들었다 — 길게 친 프롬프트를 나중에 갈라 놓을 길이 없었다.
   *  ★가르는 자리의 쉼표·빈칸은 **양쪽에서 떼어 낸다.** 그 쉼표는 두 태그를 잇던 것이라
   *    갈라진 뒤에는 어느 쪽에도 속하지 않는다.
   *  ★`single`(씬 칸)에서는 만들 자리가 없다 — **가르지 않고** 통째로 반영하고 옆 칸으로
   *    넘긴다 (`onNext`). 여기서 갈랐다가는 뒤쪽 글이 갈 곳이 없어 통째로 사라진다.
   *  ★되돌리기는 **여기서만** 담는다 (「그때의 목록으로」). 글 상자 쪽에서도 담으면 한 걸음에
   *    두 칸이 쌓여 Ctrl+Z 를 두 번 눌러야 한다. */
  const enterAt = (i: number, b: Block, splitAt?: number) => {
    if (single) {
      pushUndo(t("common.undoText"), () => onChange(blocks), libZone);
      replace(i, b);
      onNext?.();
      return;
    }
    const src = b.src ?? "";
    const at = Math.min(Math.max(splitAt ?? src.length, 0), src.length);
    const head = src.slice(0, at).replace(/[\s,]+$/, "");
    const tail = src.slice(at).replace(/^[\s,]+/, "");
    const nb = makeBlock(t("block.newBlock"), [], {
      open: true,
      color: b.color,
      tags: parseSegs(tail),
      src: tail,
    });
    // ★이것도 블록이 하나 느는 것이다. ★Esc 로 물러나면 `cancelAt` 이 이 칸을 도로 버린다
    //   (뒤쪽 글이 옮겨 왔으면 비지 않으므로 안 거둔다 — 그게 맞다)
    pushUndo(t("common.undoBlockAdd"), () => onChange(blocks), libZone);
    auto.current.add(nb.id);
    const n = blocks.slice();
    n[i] = { ...b, tags: parseSegs(head), src: head };
    n.splice(i + 1, 0, nb);
    onChange(n);
    setEditId(nb.id);
  };

  /** Esc — Enter 로 딸려 나온 빈 블록이면 도로 거둔다 (안 그러면 꼬리에 빈 칸이 남는다) */
  const cancelAt = (i: number) => {
    if (single) return onDone?.();
    const b = blocks[i];
    if (!auto.current.has(b.id) || b.tags.length) return;
    auto.current.delete(b.id);
    /* ★★담아 둔 「블록 추가」 칸을 **도로 버린다** — 그 블록은 지금 사라지므로, 남겨 두면
         `Ctrl+Z` 가 없어진 그것을 되살린다. 이 길은 사용자가 물러난 것이라 되돌릴 일이 없다. */
    dropUndo();
    onChange(blocks.filter((_, j) => j !== i));
  };

  /** 잘려 안 보이는 칩이 몇 개인가 — ★칩은 **다 그려 두고** 넘치는 것만 잘린다
   *  (`overflow: hidden`). 자리를 실제로 차지해 봐야 셀 수 있으므로 지우지 않고 재기만
   *  한다. 그래서 잘린 칩도 **끌 수 있고 서랍 드롭도 받는다** — 진짜 블록 그대로다. */
  const [over, setOver] = useState(0);
  const tagKey = blocks.map((b) => b.tags.map((x) => `${x.t}${x.w ?? ""}`).join("|")).join("//");
  useLayoutEffect(() => {
    const el = box.current;
    if (!el || !clamp) return setOver(0);
    const measure = () => {
      const h = el.clientHeight;
      const kids = [...el.querySelectorAll<HTMLElement>("[data-chip]")];
      // ★1px 은 봐준다 — 소수점 높이에서 마지막 줄이 통째로 잘린 것처럼 세어진다
      setOver(kids.filter((k) => k.offsetTop + k.offsetHeight > h + 1).length);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
    // ★태그를 **글로 굳혀** 의존한다 — 배열은 다시 그릴 때마다 새것이라, 그대로 걸면
    //   측정을 붙였다 뗐다 한다
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clamp, tagKey]);

  return (
    <div
      ref={(el) => {
        box.current = el;
        (zone.ref as React.MutableRefObject<HTMLDivElement | null>).current = el;
        (moveIn.ref as React.MutableRefObject<HTMLDivElement | null>).current = el;
      }}
      data-block-list={libZone}
      data-slot-block={single ? id : undefined}
      style={{
        display: "flex",
        flexDirection: "column",
        // ★`fill` 이면 품이 준 자리를 그대로 아래로 흘린다 (`BlockBody` 의 `fill` 주석)
        ...(fill ? { flex: 1, minHeight: 0 } : {}),
        // 저장소에서 끄는 중에만 자리를 알린다 — 1단계 점선, 2단계(지금 떼면 여기) 실선
        // ★다른 카드에서 오는 **블록**은 여기서 안 밝힌다 — 끼울 줄 하나에만 선을 긋는다
        //   (`crossOver`). 목록 전체를 칠하면 갈아 끼우는 것처럼 보였다 (사용자 지적 2026-08-30).
        //   ★씬 칸(`single`)은 블록 하나에 태그가 붙는 자리라 전처럼 통째로 밝힌다.
        ...(libZone && (zone.active || (moveIn.active && !fromMe && single))
          ? {
              borderRadius: "var(--r-3)",
              outline: `1px ${zone.over || moveIn.over ? "solid" : "dashed"} var(--accent)`,
              outlineOffset: 3,
              background: zone.over || moveIn.over ? "var(--accent-bg)" : "transparent",
            }
          : null),
        /* ★자리가 좁으면 **자른다** — 줄 높이는 오른쪽 썸네일이 정하는 것이라 늘릴 수 없다.
           `+n` 이 그 위에 뜨고, 누르면 부모가 자리를 내준다 */
        ...(clamp ? { position: "relative", flex: 1, minWidth: 0, minHeight: 0, overflow: "hidden" } : null),
      }}
    >
      {blocks.map((b, i) => (
        /* ★★**여기서도 자리를 흘려야 한다** (실측 2026-08-28). 이 층에 아무 규칙이 없어서
           위(목록 뿌리)가 아무리 커도 아래(블록 줄·입력칸)로 그 크기가 안 내려갔다 —
           입력칸만 한 줄로 남던 까닭이다. 표시를 넣어 보고서야 이 층이 보였다. */
        <div
          key={b.id}
          style={fill ? { flex: 1, minHeight: 0, display: "flex", flexDirection: "column" } : undefined}
        >
          {!single && (
            <DropLine active={(dragIdx != null && overIdx === i && i !== dragIdx && i !== dragIdx + 1) || crossOver === i} />
          )}
          {/* ★★표식이 곧 **놓을 자리의 목록**이다 — 칩 끌기가 화면 전체에서 이것을 훑어
              카드 너머의 줄까지 찾는다 (`useTagDrag` 의 ★주). */}
          <div
            data-block-row
            ref={register(i)}
            style={fill ? { flex: 1, minHeight: 0, display: "flex", flexDirection: "column" } : undefined}
          >
            <BlockRow
              block={b}
              bare={single}
              fill={fill}
              open={open}
              zone={libZone}
              dup={dup}
              dragging={dragIdx === i}
              autoEdit={editId === b.id || (!!single && !!autoEdit)}
              /* ★★**갈라져 나온 블록은 커서가 갈린 지점에 선다** (사용자 지시 2026-08-24).
                 옮겨 온 글의 **맨 앞**이 곧 그 지점이다 — 맨 뒤에 세우면 방금 치던 자리에서
                 멀어져, 이어 치려면 글 전체를 거슬러 올라와야 한다.
                 ★`auto` 에는 `Shift+Enter` 로 생긴 것만 든다 (`enterAt`). `+` 로 만든 빈 블록은
                   글이 없어 앞뒤가 같은 자리라 이 값을 줄 필요가 없다. */
              autoCaret={auto.current.has(b.id) ? 0 : undefined}
              /* ★★**켜고끄기만** 담는다 (사용자 지시 2026-08-22). 이 길은 칩 편집·가중치도
                 함께 지나는데, 그것들은 `BlockBody` 가 이미 담고 있어 두 번 담기면 `Ctrl+Z` 를
                 두 번 눌러야 한 걸음이 물러난다. */
              onChange={(nb) => {
                if (nb.on !== b.on) pushUndo(t("common.undoBlockOn"), () => onChange(blocks), libZone);
                replace(i, nb);
              }}
              onRemove={() => {
                pushUndo(t("common.undoBlockRemove"), () => onChange(blocks), libZone);
                onChange(blocks.filter((_, j) => j !== i));
              }}
              onEnter={(nb, at) => enterAt(i, nb, at)}
              onCancel={() => cancelAt(i)}
              onDone={onDone}
              onOpen={onOpen}
              onTab={onTab}
              /* ★끌기는 **손잡이** 하나다 (위 `grip` 의 ★★주) — 머리는 누르면 접고 펼 뿐이다 */
              gripProps={grip(i, b)}
              tagDrag={{
                handle: (ci, label) => tag.handle(i, ci, label),
                draggingIndex: tag.from?.block === i ? tag.from.index : null,
                justDragged: tag.justDragged,
              }}
            />
          </div>
        </div>
      ))}

      {!single && (
        <>
          <DropLine active={(dragIdx != null && overIdx === blocks.length && dragIdx !== blocks.length - 1) || crossOver === blocks.length} />
          <div style={{ display: "flex", gap: "var(--sp-2)", marginLeft: 16, marginTop: 6 }}>
            <button
              data-block-add
              onClick={() => {
                pushUndo(t("common.undoBlockAdd"), () => onChange(blocks), libZone);
                onChange([...blocks, makeBlock(t("block.newBlock"), [], { open: true })]);
              }}
              style={addBtn}
            >
              {t("block.add")}
            </button>
          </div>
        </>
      )}

      {clamp && over > 0 && (
        <button
          data-slot-more={id}
          onClick={(e) => {
            e.stopPropagation();
            onMore?.();
          }}
          style={{
            position: "absolute",
            right: 0,
            bottom: 0,
            padding: "1px 6px 1px 12px",
            borderRadius: "var(--r-1)",
            /* 잘린 칩 위에 뜨므로 왼쪽을 흐리게 빼서 글자가 겹쳐 읽히지 않게 한다 */
            background: `linear-gradient(90deg, transparent, ${bg ?? "var(--surface)"} 45%)`,
            color: "var(--ink-faint)",
            fontSize: "var(--text-2xs)",
            fontFamily: "var(--font-mono)",
          }}
        >
          +{over}
        </button>
      )}

      {/* 커서를 따라오는 고스트 — 포인터 방식은 브라우저가 잔상을 만들어 주지 않는다 */}
      {ghost && dragIdx != null && blocks[dragIdx] && (
        <DragGhost
          x={ghost.x}
          y={ghost.y}
          anchor="exact"
          style={{ width: ghost.w, borderRadius: "var(--r-3)" }}
        >
          <BlockRow
            block={{ ...blocks[dragIdx], open: false }}
            dup={dup}
            onChange={() => {}}
            onRemove={() => {}}
          />
        </DragGhost>
      )}

      <TagDragLayer tag={tag} />
    </div>
  );
}

const addBtn: React.CSSProperties = {
  fontSize: "var(--text-2xs)",
  color: "var(--ink-dim)",
  border: "1px dashed var(--line)",
  borderRadius: "var(--r-1)",
  padding: "2px 10px",
};

/** 놓일 자리 표시 — 자리를 벌려 아래 블록이 밀리므로 어디로 가는지 눈에 보인다. */
function DropLine({ active }: { active: boolean }) {
  return (
    <div
      style={{
        height: active ? 18 : 4,
        transition: "height 0.08s",
        display: "flex",
        alignItems: "center",
      }}
    >
      {active && (
        <div
          style={{
            width: "100%",
            height: 3,
            borderRadius: 2,
            background: "var(--accent)",
            boxShadow: "0 0 0 3px var(--accent-bg)",
          }}
        />
      )}
    </div>
  );
}
