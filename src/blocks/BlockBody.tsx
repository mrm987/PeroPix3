import { composing } from "../lib/ime";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useI18n } from "../i18n";
import { caretAfterTag, parseSegs, serializeBlock, type Block } from "../lib/blocks";
import { Chip } from "./Chip";
import { pushUndo } from "../lib/undo";
import { toEdit, toStore } from "../lib/softWrap";
import { t as tr } from "../i18n";
import { useTagSuggest } from "./TagSuggest";

/* ★★글 상자가 화면에서만 쓰는 글자 바꾸기는 `lib/softWrap` 에 있다 — **자동완성도 같은 것을
     본다.** 자동완성은 화면의 날것 값을 읽어 낱말을 자르는데, 되돌리지 않고 읽으면
     `close‑`(U+2011)로 사전을 뒤져 아무것도 안 걸린다 (사용자 지적 2026-08-22:
     *"close-up 검색할때 중간에 - 이거 입력하는 순간 자동완성이 중단됨"*). 까닭은 그 파일 머리에. */

/** 칩 끌기 손잡이 — 목록이 들고 있는 것을 이 블록 몫만 받는다 (`useTagDrag`) */
export type TagDrag = {
  handle: (chipIndex: number, label: string) => React.HTMLAttributes<HTMLSpanElement>;
  draggingIndex: number | null;
  justDragged: () => boolean;
};

/** 블록의 **본문** — 칩 줄과, 그것을 눌렀을 때 열리는 글 상자.
 *
 *  ★★**머리가 없다.** 그래서 머리를 그리는 곳(`BlockRow`)과 머리가 없는 곳(씬 칸,
 *    `SlotBlock`)이 **같은 부품**을 쓴다 — 칩 클릭으로 열리는 자리, 커서를 놓는 규칙,
 *    자동완성, Enter·Esc 가 두 벌로 갈리지 않는다 (사용자 지시 2026-08-20: 씬 칸도 블록으로).
 *
 *  ★조작 (앱 전체에서 같다):
 *   - 칩 클릭        = 그 태그의 **쉼표 뒤**에 커서를 놓고 글 상자를 연다
 *   - 빈 자리 클릭   = 맨 뒤에 이어 적는다
 *   - 칩 휠          = 가중치 · 휠 클릭 = 초기화 · 우클릭 = 삭제
 *   - 칩 드래그      = 자리 옮기기 (`tagDrag` 를 준 곳에서만)
 *   - Enter          = 저장하고 끝낸다 (`onDone` 이 있으면 그것까지)
 *   - Shift+Enter    = 저장하고 **다음 것으로** (`onEnter`)
 *   - Tab            = 저장하고 **옆으로** (`onTab` 을 준 곳에서만 — 씬 칸)
 *   - Esc            = 고치던 것을 버리고 끝낸다
 */
export function BlockBody({
  block,
  readOnly,
  onChange,
  dup,
  tagDrag,
  autoEdit,
  autoCaret,
  mark,
  onEnter,
  onCancel,
  onDone,
  onTab,
  onOpen,
  zone,
  fill,
  open,
}: {
  block: Block;
  /** ★★**품이 준 자리를 다 쓴다** (사용자 지적 2026-08-28: *"입력 영역이 머리 영역 전체만큼
   *  커져야 하는데 텍스트 라인만큼만 생긴다"*). 평소에는 글이 늘어난 만큼만 커지는데,
   *  씬 머리처럼 **칸이 먼저 정해진 자리**에서는 그 칸을 채워야 눌러서 칠 수 있다. */
  fill?: boolean;
  /** ★★`fill` 인 자리에서 **품이 아는 「펼쳐져 있나」**. `false` 가 되면 글 상자도 닫는다
   *  (사용자 지적 2026-08-28: *"글 상자가 씬 안쪽 빈 자리를 눌러야만 풀리고, 이미지를
   *  고르거나 바깥을 누르면 안 풀린다"*). 까닭은 **초점이 안 빠지기 때문**이다 — 그림 칩은
   *  `pointerdown` 의 기본 동작을 막아(끌기 때문) 글 상자에서 초점이 나가지 않는다.
   *  그래서 `blur` 를 기다리는 길로는 닫을 수가 없다. */
  open?: boolean;
  /** 보여 주기만 하는 자리 (블록 저장소) — 칩도 글 상자도 안 먹는다 */
  readOnly?: boolean;
  onChange: (b: Block) => void;
  /** 켜진 블록들에서 겹치는 태그 (계기판 — 고치지 않고 표시만) */
  dup?: Set<string>;
  tagDrag?: TagDrag;
  /** 뜨자마자 글 상자를 연다 — 갓 만든 블록 · `Tab` 으로 건너온 씬 칸 ·
   *  접힌 씬 칸의 칩을 누른 경우 */
  autoEdit?: boolean;
  /** 그렇게 열 때 **커서를 놓을 자리**. 안 주면 맨 뒤 (지금까지의 동작).
   *  ★쓰는 자리: `Shift+Enter` 로 갈라져 나온 블록 — 커서는 **갈린 지점**에 서야 한다
   *    (사용자 지시 2026-08-24). 옮겨 온 글의 맨 뒤에 서면 방금 치던 자리에서 멀어진다. */
  autoCaret?: number;
  /** 조작 테스트가 잡는 손잡이 — `data-block-text` 값 */
  mark?: string;
  /** Shift+Enter — 고친 내용과 **가를 자리**를 함께. 한 번에 넘겨야 목록이 두 번 갈리지 않는다.
   *  ★★`splitAt` 뒤의 글은 **새 블록으로 옮겨 간다** (사용자 지시 2026-08-22:
   *    *"쉬프트 엔터를 누를 경우에 해당 위치부터 뒤에있는 텍스트 전체를 새로 만든 블록으로 이동"*).
   *    예전에는 통째로 반영하고 **빈** 블록을 만들었다.
   *  ★가르는 일은 **목록(`BlockList`)이 한다.** 여기서 미리 잘라 보내면 블록을 못 만드는 자리
   *    (씬 칸의 `single`)에서 뒤쪽 글이 통째로 사라진다 — 그래서 **자리만** 넘긴다. */
  onEnter?: (b: Block, splitAt?: number) => void;
  /** Esc — 고치던 것을 버리고 나간다 */
  onCancel?: () => void;
  /** Enter 로 끝냈을 때 뒤따르는 일 (씬 칸은 줄을 접는다) */
  onDone?: () => void;
  /** Tab — 옆 씬의 같은 칸으로 (v2 index.html:11821-11832) */
  onTab?: (dir: 1 | -1) => void;
  /** 글 상자가 열렸다 — 잘라 보여 주던 부모가 **자리를 내준다** */
  onOpen?: () => void;
  /** 이 블록이 사는 **자리**(`BlockList` 의 `libZone`). 되돌리기 항목에 함께 담아,
   *  조수가 그 자리를 고치면 사람의 항목이 버려지게 한다 (`lib/undo` 의 `dropUndoZone`) */
  zone?: string;
}) {
  const t = useI18n((s) => s.t);
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState("");
  const ta = useRef<HTMLTextAreaElement>(null);
  /* ★★자동완성에는 **평범한 글**을 준다 (`toStore`). 안 그러면 사전을 `close‑up`(U+2011)로
       뒤져 하이픈 든 태그가 하나도 안 걸린다. 길이가 안 변하는 치환이라 **커서 자리가 그대로**여서
       그 안의 자리 계산이 전부 그대로 맞는다.
     ★치는 동안에도 유지한다 — 새로 친 빈칸·붙임표도 곧바로 안 깨지는 짝으로 바뀐다. */
  /** ★★치기 직전의 커서 자리 — 값이 갈아 끼워진 뒤 여기로 돌려놓는다 (아래 ★★주) */
  const caretKeep = useRef<{ s: number; e: number } | null>(null);

  /** ★★**글 상자 안의 되돌리기는 우리가 든다** (사용자 지적 2026-08-22:
   *  *"태그 자동완성을 사용한 순간부터 undo가 안됨."*).
   *
   *  자동완성은 값을 **직접 갈아 끼운다.** 글 상자의 `value` 에 대입하면 브라우저가 들고 있던
   *  **자기 되돌리기 이력이 통째로 죽어서**, 그때부터 상자 안의 `Ctrl+Z` 가 아무 일도 안 한다.
   *  전역 로그(`lib/undo`)는 **확정한 뒤**의 것이라 상자 안에서는 돌지 않는다.
   *  ★그래서 상자가 열려 있는 동안의 글을 여기 쌓고, 상자 안의 `Ctrl+Z` 를 직접 받는다.
   *  ★**치는 것은 뭉쳐서** 담는다 (400ms). 한 글자마다 담으면 한 낱말을 물리려고 열 번을
   *    눌러야 한다. 자동완성처럼 한 번에 갈아 끼우는 것은 **언제나** 한 칸으로 담는다.
   *  ★상자를 열 때 비운다 — 지난 판의 글로 돌아가면 안 된다. */
  const textUndo = useRef<{ text: string; at: number }[]>([]);
  const lastPushAt = useRef(0);
  const pushTextUndo = (before: string, force: boolean) => {
    const now = performance.now();
    if (!force && now - lastPushAt.current < 400) return;
    lastPushAt.current = now;
    const el = ta.current;
    textUndo.current.push({ text: before, at: el?.selectionStart ?? before.length });
    if (textUndo.current.length > 50) textUndo.current.shift();
  };
  const ac = useTagSuggest(
    toStore(text),
    (v, caretPlaced) => {
      /* ★★**커서 자리를 적어 둔다** (사용자 지적 2026-08-22: *"단어 중간에 띄어쓰기를 하면
           갑자기 편집 커서가 맨 뒤로 이동함"*).
         `toEdit` 이 빈칸을 NBSP 로, 붙임표를 U+2011 로 바꾸면 글이 **브라우저가 방금 만든
         것과 달라져서**, 리액트가 `value` 를 다시 써 넣는다. 글 상자의 `value` 에 대입하면
         커서는 **맨 뒤로** 간다 (실측: 가운데 3 자리에서 쳤는데 15 로 튐).
         보통 글자는 치환이 없어 값이 같고, 그래서 멀쩡했다 — 빈칸·붙임표에서만 났다. */
      /* ★★자동완성이 **자리를 잡았으면 건드리지 않는다** (사용자 지적 2026-08-22:
           *"태그 완성했을 때 커서가 완성된 태그 뒤의 쉼표 뒤로 가야하는데, 그냥 그자리에
           멈춰있음"*). 그때는 넣은 태그의 쉼표 뒤가 맞는 자리이고, 여기서 되돌리면
           **치기 전 자리로 도로 끌려온다.** 훅이 먼저 등록돼 저쪽이 먼저 돌기 때문에,
           우리가 나중에 덮어쓰는 모양이었다. */
      const el = ta.current;
      caretKeep.current = !caretPlaced && el ? { s: el.selectionStart, e: el.selectionEnd } : null;
      // ★자동완성이 갈아 끼운 것은 **언제나** 한 칸으로 (뭉치면 그 한 번을 못 물린다)
      pushTextUndo(text, !!caretPlaced);
      setText(toEdit(v));
    },
    ta,
  );
  /** ★★**글 상자를 닫으면 자동완성도 접는다** (사용자 지적 2026-08-28: *"자동완성 창이
   *  떠 있던 상태로 다른 데를 눌러 선택을 해제했다가 다시 클릭해 보면, 아무것도 입력 안
   *  했는데 이전에 떴던 자동완성이 다시 뜬다"*).
   *  목록은 글 상자가 사라져도 **뜬 채로 기억되어**, 다음에 열 때 지난 낱말의 후보가
   *  그대로 다시 그려졌다. 글 상자와 목록은 함께 서고 함께 접혀야 한다. */
  useEffect(() => {
    if (!editing) ac.close();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing]);

  /** 편집을 열 때 커서를 놓을 자리. `null` 이면 맨 뒤 */
  const caretAt = useRef<number | null>(null);
  /** Enter·Esc 로 넘어갈 때 뒤따르는 blur 이 한 번 더 반영하지 않게 */
  const skipBlur = useRef(false);

  /** ★★글 상자는 **적은 글이 다 보이게** 커진다 (사용자 지시 2026-08-20).
   *
   *  예전에는 줄 수를 **글자 수로 어림**했다(`rows = 글자수 / 46`). 46 은 어디서도 맞지 않는
   *  숫자였다 — 씬 줄 머리는 사용자가 폭을 끌고(`laneHeadW`), 카드 편집기는 460px 이고,
   *  프롬프트 패널은 또 다르다. 게다가 8줄에서 잘려 **긴 프롬프트는 스크롤해야** 보였다.
   *  이제 **실제로 그려 본 높이**(`scrollHeight`)를 그대로 쓴다.
   *  ★폭이 바뀌면 줄바꿈이 달라지므로 다시 잰다 — 재는 것은 **품(parent)의 폭**이다.
   *    글 상자 자신을 지켜보면 우리가 높이를 고칠 때마다 다시 불려 맴돈다. */
  const fit = () => {
    const el = ta.current;
    if (!el) return;
    /* ★★`fill` 이어도 **글만큼은 키운다** (사용자 지시 2026-08-30: 씬 프롬프트 편집창을 내용 크기만큼).
       예전에는 100% 로 자리를 채우기만 해서, 글이 자리보다 길면 상자 안에서 굴러갔다. 이제
       높이를 글에 맞추고, 자리가 더 크면 `flex: 1` 이 마저 채운다 — 짧은 글은 전처럼 꽉 차고
       긴 글은 상자를 키운다 (씬 칸은 펼치면 `minHeight` 라 따라 자란다). */
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  };
  useLayoutEffect(fit, [text, editing]);

  /** 품이 접었으면 글 상자도 닫는다 (위 `open` 의 ★★주). ★적은 것은 담고 닫는다. */
  useEffect(() => {
    if (!fill || open !== false || !editing) return;
    commitNow();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  /** ★★★**밖을 누르면 닫는다 — `blur` 도, 품이 내려 주는 값도 기다리지 않는다.**
   *
   *  (사용자 지적 2026-08-28, 세 번째: *"여전히 똑같음"*.) 앞선 두 판은 둘 다 **남이 알려
   *  주기를 기다리는** 길이었다.
   *   ① `blur` — 그림 칩·끌기 손잡이는 `pointerdown` 의 기본 동작을 막아서 **초점이 아예
   *      안 빠진다.** 그래서 그림을 고르면 `blur` 가 오지 않는다.
   *   ② 품이 내려 주는 `open` — 씬 줄이 접히는 것과 글 상자가 닫히는 것이 **두 상태**라,
   *      한쪽이라도 어긋나면 그대로 열려 있는다.
   *  이제 **여기서 직접 듣는다.** 잡기 단계(capture)라 아래에서 누가 막아도 먼저 오고,
   *  씬 줄 머리가 풀리는 것과 **같은 장치**다 (`SceneLane` 의 바깥 클릭 처리) — 거기서
   *  잘 도는 것이 확인된 길이다.
   *  ★비켜 가는 것 셋: 글 상자 자신 · 자동완성 목록 · 서랍(끌어다 놓는 중이면 닫으면 안 된다).
   *  ★★**어느 자리든 마찬가지다** (사용자 지적 2026-08-28: *"베이스 프롬프트 쪽도 비슷한
   *    문제 있네. 어딜 누르든 풀려야 하는데 안 풀리는 데가 있음"*). 초점을 막는 표면은
   *    프롬프트 패널에도 그대로 있다 — 칩·끌기 손잡이·단추가 다 그렇다.
   *  ★다만 **접는 것은 씬 머리뿐**이다(`fill`). 프롬프트 패널의 블록은 펼침을 사용자가
   *    따로 정하므로, 글 상자만 닫고 블록은 편 채로 둔다. */
  useEffect(() => {
    if (!editing) return;
    const onDown = (e: PointerEvent) => {
      const el = e.target as HTMLElement | null;
      if (!el) return;
      if (ta.current && (el === ta.current || ta.current.contains(el))) return;
      if (el.closest?.("[data-tag-suggest]") || el.closest?.("[data-block-drawer]")) return;
      /* ★★★**지금 이 순간의 글**로 담는다 (사용자 지적 2026-08-28: *"다른 데 눌러서
         해제하면 편집 취소가 아니고 그대로 저장되어야 함"*).
         듣는 자리는 **한 번만** 매달리는데(`[fill, editing]`), 그 안에서 `commitNow` 를
         곧장 부르면 **매달릴 때의 글**이 담긴다 — 그 시점의 글은 아직 한 글자도 안 친
         원문이라, 밖을 누를 때마다 **친 것이 통째로 되돌려졌다.** 저장처럼 보이지만
         값이 옛것이라 눈에는 「취소」로 보인다.
         ★그래서 **가장 최근 것을 가리키는 상자**(`commitRef`)를 거쳐 부른다. */
      commitRef.current();
      if (fill) onDoneRef.current?.();
    };
    document.addEventListener("pointerdown", onDown, true);
    return () => document.removeEventListener("pointerdown", onDown, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fill, editing]);

  /** ★★값이 갈아 끼워진 **바로 뒤에** 커서를 제자리로 (위 `caretKeep` 의 ★★주).
   *  ★치환은 한 글자를 한 글자로 바꿔 **길이가 안 변하므로** 자리 숫자가 그대로 맞는다.
   *  ★`useLayoutEffect` 여야 한다 — 그려지기 전에 되돌려야 커서가 튀는 것이 안 보인다.
   *  ★적어 둔 것이 있을 때만 손댄다. 편집을 **열 때** 커서를 놓는 자리(`caretAt`)와 겹치면
   *    안 되기 때문이다 — 그쪽은 여기에 아무것도 안 적는다. */
  useLayoutEffect(() => {
    const el = ta.current;
    const keep = caretKeep.current;
    caretKeep.current = null;
    if (!el || !keep) return;
    if (el.selectionStart !== keep.s || el.selectionEnd !== keep.e)
      el.setSelectionRange(keep.s, keep.e);
  }, [text]);
  useEffect(() => {
    const el = ta.current?.parentElement;
    if (!editing || !el) return;
    let w = el.clientWidth;
    const ro = new ResizeObserver(() => {
      if (el.clientWidth === w) return;
      w = el.clientWidth;
      fit();
    });
    ro.observe(el);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing]);

  /** ★★**사라질 때도 반영한다.** React 의 `onBlur` 은 **언마운트에는 오지 않는다**
   *  (CLAUDE.md 의 잊기 쉬운 것). 씬 칸은 글 상자 밖을 누르면 줄이 접혀 상자가 통째로
   *  사라지므로, blur 만 믿으면 **치던 글이 사라진다.** 마지막 값을 여기 들고 있다가
   *  정리할 때 흘려보낸다 — Esc 로 버리고 나간 경우만 뺀다. */
  const live = useRef({ editing: false, text: "", block, onChange, dropped: false });
  live.current.editing = editing;
  live.current.text = text;
  live.current.block = block;
  live.current.onChange = onChange;
  useEffect(
    () => () => {
      const l = live.current;
      if (l.editing && !l.dropped) {
        const out = toStore(l.text);
        l.onChange({ ...l.block, tags: parseSegs(out), src: out });
      }
    },
    [],
  );

  useEffect(() => {
    if (!editing) return;
    const el = ta.current;
    if (!el) return;
    /* ★★**포커스가 화면을 굴리지 못하게 한다** (사용자 지적 2026-08-24: *"엄청 긴 프롬프트
       블록을 편집하려고 클릭했을 때, 클릭한 위치가 아니라 항상 해당 블록 맨 위로
       스크롤되어서 편집 위치가 안 보임"*).
       `focus()` 는 그 요소를 보이게 굴리는데, 글 상자는 적은 글이 다 보이게 커지므로
       (`fit`) **화면보다 길다.** 그러면 브라우저는 **맨 위**를 맞추고, 커서는 한참 아래에
       있어 화면 밖으로 밀린다. 굴리지 않으면 **누른 그 자리가 그대로 남는다** — 누를 수
       있었다는 것은 이미 보이고 있었다는 뜻이다. */
    el.focus({ preventScroll: true });
    // ★★**전체 선택을 하지 않는다** (사용자 지시 2026-08-18). 열자마자 다 잡혀 있으면
    //   뭐든 한 글자 치는 순간 블록이 통째로 지워진다.
    const at = caretAt.current ?? el.value.length;
    el.setSelectionRange(at, at);
    caretAt.current = null;
    /* ★단, **스스로 열린 것**은 보이게 굴린다 (`Tab` 으로 건너온 씬 칸·갓 만들어진 블록).
       그때는 사용자가 그 자리를 보고 있었다는 보장이 없다.
       ★`nearest` 라 이미 보이면 안 움직인다 — 굴리는 것은 정말 화면 밖일 때뿐이다. */
    if (autoEdit) el.scrollIntoView({ block: "nearest" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing]);

  /** @param at 커서를 놓을 글자 자리 (안 주면 맨 뒤)
   *  @param txt 열면서 넣을 글 (안 주면 블록을 그대로 편다) */
  const openText = (at?: number | null, txt?: string) => {
    if (readOnly) return;
    /* ★★**표식들을 열 때 지운다** (사용자 지적 2026-08-19: *"esc로 취소 → 다시 입력하고
       엔터를 누르면 아무 반응 없음"*). `Esc`·`Shift+Enter` 는 표식을 세운 뒤 곧바로
       textarea 를 언마운트하는데, 언마운트에는 React 의 `onBlur` 이 오지 않아 표식이
       **다음 편집까지 살아남았다.** */
    skipBlur.current = false;
    live.current.dropped = false;
    caretAt.current = at ?? null;
    textUndo.current = [];   // ★지난 판의 글로 돌아가면 안 된다
    lastPushAt.current = 0;
    setText(toEdit(txt ?? serializeBlock(block)));
    setEditing(true);
    onOpen?.();
  };

  /** `i` 번째 태그 **뒤에서** 이어 적는다 (`i < 0` 이면 맨 뒤 — 빈 자리를 눌렀을 때) */
  const openAt = (i: number) => {
    if (i < 0) {
      if (!block.tags.length) return openText();
      const last = caretAfterTag(block, block.tags.length - 1);
      return openText(last.at, last.text);
    }
    const { at, text: txt } = caretAfterTag(block, i);
    openText(at, txt);
  };

  // 열어 달라고 하고 뜬 자리 (갓 만들어진 블록 · `Tab` 으로 건너온 씬 칸 · 접힌 줄의 칩)
  useEffect(() => {
    if (autoEdit) openText(autoCaret);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoEdit]);

  /** ★★고친 글도 **되돌리기 로그에 남긴다** (사용자 지적 2026-08-22:
   *  *"텍스트 편집을 했을 때, 엔터 눌러서 확정하면 취소가 안됨"*).
   *  글 상자 **안**에서는 브라우저 기본 되돌리기가 살아 있지만, 확정하고 나면 그것이 사라진다 —
   *  확정이야말로 "마지막에 수정한 것"이므로 로그가 받아야 한다.
   *  ★안 바뀌었으면 담지 않는다. 그냥 눌렀다 나온 것까지 쌓이면 `Ctrl+Z` 가 헛돈다. */
  const logTextEdit = (before: Block, after: Block) => {
    if (before.src === after.src) return;
    pushUndo(tr("common.undoText"), () => onChange(before), zone);
  };

  const commitText = () => {
    if (skipBlur.current) {
      skipBlur.current = false;
      return;
    }
    /* ★★친 글이 **그대로 새 원문**이 된다 (`lib/blocks` 의 `Block.src`).
       칩으로 쪼개 다시 조립하면 줄바꿈·간격이 바뀌어 나가는데, 글 상자는 사용자가
       글자를 직접 다루는 자리라 그 글자가 그대로 NAI 로 가야 한다. */
    const out = toStore(text);
    const after = { ...block, tags: parseSegs(out), src: out };
    logTextEdit(block, after);
    onChange(after);
    setEditing(false);
    /* ★★**칸을 다 쓰는 자리에서는 「편집 끝」을 알린다** (사용자 지적 2026-08-28:
       *"씬 헤드 선택이 해제되면 프롬프트 편집도 같이 풀려야 하는데 안 풀린다.
       둘이 풀리는 조건이 다르다"*). 씬 머리는 **펼침(품이 아는 것)**과 **글 상자
       열림(여기가 아는 것)**이 따로 놀아, 한쪽만 닫히면 모습이 어긋났다.
       ★`fill` 일 때만 알린다 — 프롬프트 패널·카드 편집기는 글 상자를 벗어난다고
         접히면 안 된다 (거기서는 펼침이 사용자가 따로 정하는 상태다). */
    if (fill) onDone?.();
  };

  /** 고친 것을 반영하고 편집을 닫는다 — blur 이 한 번 더 하지 않게 표식을 세운다 */
  const commitNow = (): Block => {
    skipBlur.current = true;
    setEditing(false);
    // ★사라질 때의 반영(`live`)이 **한 번 더 하지 않게** 여기서 바로 내린다 — 이미 담았다
    live.current.editing = false;
    const out = toStore(text);
    const b = { ...block, tags: parseSegs(out), src: out };
    logTextEdit(block, b);
    onChange(b);
    return b;
  };

  /** ★★**늘 최신을 가리키는 상자** — 오래 매달려 있는 듣는 자리가 이것을 거쳐 부른다.
   *  매 렌더 갈아 끼우므로 낡은 글로 담을 일이 없다 (위 바깥 누름 처리의 ★★★주). */
  const commitRef = useRef(commitNow);
  commitRef.current = commitNow;
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;

  /** ★★칩 줄과 글 상자는 **같은 상자**다 (사용자 지적 2026-08-20:
   *  *"블록 텍스트 편집 영역이 실제 보이는 것보다 좁음"*).
   *  글 상자에만 안팎 여백과 테두리가 있었던 탓에, 칩으로 보이던 것보다 **글 쓰는 폭이
   *  14px 좁았다** — 같은 글이 편집으로 들어가는 순간 줄이 하나 더 늘어났다.
   *  테두리는 **투명으로라도 자리를 잡아 둔다** — 있고 없고가 곧 폭 차이다. */
  const box: React.CSSProperties = {
    width: "100%",
    minWidth: 0,
    padding: "3px 6px",
    borderWidth: 1,
    borderStyle: "solid",
    borderRadius: "var(--r-1)",
  };

  return (
    <>
      {editing ? (
        <>
          <textarea
            ref={ta}
            data-block-text={mark ?? ""}
            value={text}
            onChange={ac.onChange}
            // ★붙여넣은 직후에는 자동완성을 안 띄운다 (`useTagSuggest` 의 ★★주)
            onPaste={ac.onPaste}
            onBlur={commitText}
            onKeyDown={(e) => {
              // ★자동완성이 떠 있으면 Enter·Esc·방향키는 **그쪽 것**이다
              if (ac.onKeyDown(e)) return;
              /* ★★**상자 안의 되돌리기는 우리 이력으로 돈다** (위 `textUndo` 의 ★★주).
                 브라우저에 맡기면 자동완성이 값을 갈아 끼운 순간부터 먹통이 된다. */
              if ((e.ctrlKey || e.metaKey) && (e.key === "z" || e.key === "Z")) {
                const prev = textUndo.current.pop();
                if (!prev) return;   // 담아 둔 것이 없으면 브라우저에 맡긴다
                e.preventDefault();
                caretKeep.current = { s: prev.at, e: prev.at };
                lastPushAt.current = 0;   // 되돌린 직후의 타이핑은 새 칸으로 담는다
                setText(prev.text);
                return;
              }
              if (e.key === "Tab" && onTab) {
                e.preventDefault();
                commitNow();
                onTab(e.shiftKey ? -1 : 1);
                return;
              }
              /* ★★`Enter` = **저장하고 끝낸다**, `Shift+Enter` = 저장하고 **다음 것**
                 (사용자 지시 2026-08-19). 예전에는 맨 Enter 가 새 블록을 만들어서,
                 한 블록만 고치려던 사람이 빈 블록을 계속 만들게 됐다. */
              if (e.key === "Enter" && !composing(e)) {
                e.preventDefault();
                // ★고친 내용과 "다음 것"을 **한 번에** 넘긴다 — 따로 부르면 뒤 호출이
                //   앞 호출의 결과를 못 보고 덮어쓴다 (둘 다 같은 목록을 들고 있다)
                if (e.shiftKey && onEnter) {
                  skipBlur.current = true;
                  // ★가를 자리는 **끄기 전에** 읽는다 — 끄면 글 상자가 사라진다
                  const at = ta.current?.selectionStart ?? text.length;
                  setEditing(false);
                  const out = toStore(text);
                  const b = { ...block, tags: parseSegs(out), src: out };
                  /* ★되돌리기는 **목록이 담는다** — 여기서도 담으면 한 걸음에 두 칸이 쌓여
                     Ctrl+Z 를 두 번 눌러야 한다. 목록 쪽 칸은 「그때의 목록으로」라 고친 글까지
                     함께 되돌린다 (`BlockList` 의 `enterAt`). */
                  onEnter(b, at);
                } else if (onDone) {
                  commitNow();
                  onDone();
                } else (e.target as HTMLTextAreaElement).blur();
                return;
              }
              if (e.key === "Escape") {
                e.preventDefault();
                skipBlur.current = true;
                live.current.dropped = true;
                setEditing(false);
                onCancel?.();
                // ★칸을 다 쓰는 자리에서는 **펼침도 함께 접는다** (`commitText` 의 ★★주)
                if (fill) onDone?.();
              }
            }}
            rows={1}
            style={{
              ...box,
              ...(fill ? { flex: 1, minHeight: 0, resize: "none" as const } : {}),
              /* ★★줄 간격을 늘리면 **첫 줄이 반쪽 여백만큼 내려간다.** 그만큼 위 안여백을
                   덜어 첫 줄을 칩 줄과 같은 높이에 세운다 (아래 안여백으로 옮겨 붙인다).
                   ★상자 규격(`box`) 자체는 안 건드린다 — 폭은 두 모습이 같아야 한다. */
              /* ★★위 안여백을 **칩 줄과 같은 3px** 으로 되돌렸다 (사용자 지적 2026-08-22:
                   *"첫줄이 너무 위에 딱붙어있음" · *"커서가 안보여"*).
                   0 으로 두면 첫 줄의 줄 상자가 테두리에 닿아 **커서 윗부분이 잘려** 보인다.
                 ★그 대신 글자 자리가 칩보다 3px 내려간다 — 줄마다 같은 양이라 쌓이지 않고,
                   붙어 보이는 것보다 낫다고 봤다. */
              paddingTop: 3,
              paddingBottom: 3,
              /* ★★좌우도 **칩의 안여백만큼** 더 준다 (실측: 칩의 첫 글자는 줄 왼쪽에서 15px,
                   글은 7px 이었다 — 칩 테두리 1 + 안여백 7 만큼 안으로 들어가 있다).
                   오른쪽도 같이 줘야 **접히는 자리**가 맞는다: 칩의 마지막 글자도 줄 오른쪽에서
                   8px 앞에서 끝나기 때문이다. */
              paddingLeft: 14,
              paddingRight: 14,
              background: "var(--code-bg)",
              borderColor: "var(--accent)",
              // ★★글꼴도 **칩과 같은 것**으로 (사용자 지시 2026-08-21: 칩 쪽이 더 잘 읽힌다).
              //   한때 고정폭이었다 — `::` 와 숫자를 세로로 맞춰 보려던 것인데, 프롬프트는
              //   숫자표가 아니라 **읽는 글**이라 본문 글꼴이 낫다.
              //   ★가중치 숫자만은 칩에서처럼 고정폭이다 (`Chip` 의 `<b>`).
              fontFamily: '"WideSep", var(--font-sans)',
              /* ★★★**칩 줄과 같은 자리에 흐르도록 맞춘 값 셋** (사용자 지시 2026-08-22).
               *
               *  칩을 누르면 줄이 통째로 글 상자로 바뀌는데 두 모습의 흐름이 달라
               *  **같은 태그가 다른 줄에** 있었다 — 그것이 「누를 때 튄다」의 정체다.
               *  헤드리스로 태그마다 줄 번호를 맞대어 세면서 조였다 (표본 4벌 · 태그 41개).
               *
               *  ① **구분자 빈칸만 넓힌다** (`WideSep`, `styles/fonts.css`). 칩은 태그마다
               *     20px 을 더 쓰는데(안여백 7+7 · 테두리 1+1 · 사이 4) 글에서 그 자리는
               *     `, ` 한 조각뿐이라 글이 한 줄에 더 담겼다.
               *     ★`word-spacing` 으로 하면 **태그 안의 빈칸까지** 넓어져 여러 낱말 태그가
               *       그만큼 길어진다 — 그래서 태그 안은 NBSP 로 두고(위 `toEdit`) U+0020 에만
               *       거는 면을 쓴다. 낱말 수와 무관하게 태그마다 **일정하게** 더해진다.
               *     ★쉼표 글자를 넓히는 길도 해 봤다가 걷었다 — 글자 자체가 커져 슬래시처럼 보였다.
               *  ② **줄 간격 2.065** — 칩 줄의 걸음이 26.85px(칩 높이 + 사이 4)이다.
               *     맞추기 전에는 줄마다 7.35px 씩 어긋나 쌓였다.
               *  ③ **안여백** — 아래 ★★주.
               *
               *  실측(줄이 다른 태그 / 태그 41개): 아무것도 안 했을 때 **16개** → 지금 **0개**. */
              fontSize: "var(--text-prompt)",
              lineHeight: 2.065,
              /* ★손잡이를 두지 않는다 — 높이는 **글이 정한다**. 손으로 줄여 놔도
                 다음 글자에 도로 늘어나므로, 있으면 고장으로 읽힌다 */
              resize: "none",
              overflow: "hidden",
            }}
          />
          {/* 목록은 **편집 중에만** — textarea 가 사라져도 떠 있으면 화면에 남는다 */}
          {ac.node}
        </>
      ) : (
        <div
          data-chips
          onClick={(e) => {
            // 칩을 끌고 난 직후의 클릭은 편집을 열지 않는다
            if (tagDrag?.justDragged()) return;
            // ★누른 칩이 있으면 커서를 **그 태그의 쉼표 뒤**에 놓는다 (사용자 지시 2026-08-19).
            //   칩과 글 상자는 배치가 달라 클릭 좌표를 글자 자리로 옮기는 것은 어긋나므로,
            //   "몇 번째 태그를 눌렀나"로 잡는다 — 그 편이 어긋날 일이 없다.
            const box = e.currentTarget;
            const hit = (e.target as HTMLElement).closest("[data-chip]");
            // ★빈 자리를 눌러도 **이어 적는 자리**로 연다 (사용자 지시 2026-08-19)
            openAt(hit ? [...box.querySelectorAll("[data-chip]")].indexOf(hit) : -1);
          }}
          style={{
            ...box,
            // ★테두리는 **투명으로 자리만** 잡는다 — 글 상자와 폭이 어긋나지 않게
            borderColor: "transparent",
            display: "flex",
            flexWrap: "wrap",
            alignContent: "flex-start",
            gap: 4,
            // ★`fill` 이면 품이 준 만큼 — 아니면 한 줄 높이 (위 `fill` 의 ★★주)
            ...(fill ? { flex: 1, minHeight: 0 } : { minHeight: "calc(1.5em + 8px)" }),
            cursor: readOnly ? "inherit" : "text",
          }}
        >
          {block.tags.length === 0 && (
            <span style={{ fontSize: "var(--text-2xs)", color: "var(--ink-faint)" }}>
              {/* ★★빈 자리 문구는 **부품이 정한다** — 부르는 쪽이 넘기면 화면마다 달라진다
                  (사용자 지적 2026-08-20: 씬 칸만 다른 문구였다). 갈리는 기준은 스위치 하나:
                  고칠 수 있으면 「클릭해서 입력」, 보기 전용이면 「비어 있음」이다. */}
              {t(readOnly ? "block.emptySummary" : "block.clickToInput")}
            </span>
          )}
          {block.tags.map((tag, i) => (
            <Chip
              key={i}
              tag={tag}
              readOnly={readOnly}
              dup={!!dup?.has(tag.t.trim().toLowerCase())}
              dragProps={tagDrag?.handle(i, tag.t)}
              dragging={tagDrag?.draggingIndex === i}
              onWeight={(w) => {
                const tags = block.tags.slice();
                tags[i] = { ...tag, w };
                onChange({ ...block, tags });
              }}
              /* ★★가중치도 되돌릴 수 있어야 한다 (사용자 지시 2026-08-22).
                 ★칩이 **한 차례 조절에 한 번만** 불러 준다 — 휠 눈금마다 담으면 원래대로
                   돌아가려고 Ctrl+Z 를 수십 번 눌러야 한다.
                 ★되돌리는 방법은 칩 지우기와 같다: 「이 블록을 지금 모습으로」 하나면 된다. */
              onWeightStart={() => {
                const before = block;
                pushUndo(tr("common.undoWeight"), () => onChange(before), zone);
              }}
              onRemove={() => {
                // ★★확인 없이 사라지는 자리라 **되돌릴 길**을 함께 담는다 (`Ctrl+Z`).
                //   되돌리는 방법은 「이 블록을 지금 모습으로 되돌린다」 하나면 된다.
                const before = block;
                pushUndo(tr("common.undoTag"), () => onChange(before), zone);
                onChange({ ...block, tags: block.tags.filter((_, j) => j !== i) });
              }}
            />
          ))}
        </div>
      )}
    </>
  );
}
