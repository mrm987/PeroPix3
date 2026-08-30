import { composing } from "../lib/ime";
import { TYPE } from "../styles/type";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  currentWord,
  formatCount,
  loadTags,
  searchTags,
  tagsLoaded,
  underscoresToSpaces,
  type TagEntry,
} from "../lib/tagData";
import { useWildcards } from "../store/wildcards";
import { useUi } from "../store/ui";
import { toStore } from "../lib/softWrap";

/** 자동완성이 붙을 수 있는 입력칸 — 여러 줄(블록·슬롯)과 한 줄(공통 접두) 둘 다 */
type Field = HTMLTextAreaElement | HTMLInputElement;

/** 와일드카드 이름 제안을 태그와 **같은 목록**에 실어 나르는 모양.
 *  ★목록을 둘로 만들지 않는다. 같은 자리에 뜨는 것은 하나여야 키 처리도 하나다 (v2 도 그렇다). */
const WC_TYPE = "wildcard";

/** 태그 자동완성 — 페로픽스파이 `TagAutocompleteTextarea` 에서 이식.
 *
 *  거기서는 textarea 를 감싼 컴포넌트였지만, 여기서는 **훅**이다. 블록의 textarea 는
 *  Enter·Esc 에 이미 제 뜻(다음 블록 만들기 / 편집 끝내기)이 있어서, 자동완성이
 *  **먼저 먹을지**를 그 자리에서 판단해야 하기 때문이다 (`onKeyDown` 이 true 를 돌려주면
 *  자동완성이 가져간 것).
 *
 *  ★가중치 조작(Alt+휠·드래그)은 안 가져왔다 — 여기서는 **칩 휠**이 그 일을 한다. */
export function useTagSuggest(
  value: string,
  /** ★`caretPlaced` 는 **이쪽이 커서를 옮겼다**는 뜻이다 (완성해서 넣은 자리).
   *  받는 쪽은 그때 자기 커서 되돌리기를 건너뛴다 — 안 그러면 넣자마자 도로 끌려온다
   *  (사용자 지적 2026-08-22: *"태그 완성했을 때 … 그냥 그자리에 멈춰있음"*). */
  setValue: (v: string, caretPlaced?: boolean) => void,
  ref: React.RefObject<Field | null>,
  /** ★와일드카드 **정의 편집기**용 (v2 `dataset.noTagComma`). 한 줄에 한 후보라 쉼표를 안 붙인다 */
  opt?: { noComma?: boolean },
) {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<TagEntry[]>([]);
  const [sel, setSel] = useState(0);
  const [pos, setPos] = useState<{
    left: number;
    width: number;
    maxH: number;
    /** 아래로 뜰 때 — 커서 줄의 바로 밑 */
    top: number | null;
    /** 위로 뒤집을 때 — **아래쪽 끝**을 커서 줄에 맞춘다 (`dropdownPos` 의 ★★주) */
    bottom: number | null;
  }>({ left: 0, width: 300, maxH: 300, top: 0, bottom: null });
  const list = useRef<HTMLDivElement>(null);
  const last = useRef(value);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** 넣은 뒤 커서를 되돌릴 자리 — controlled 라 우리가 직접 놓아야 한다 */
  const caret = useRef<number | null>(null);

  // 사전은 한 번만 읽는다. 블록이 그려질 때 시작하므로 첫 입력 전에 준비된다
  useEffect(() => {
    loadTags();
  }, []);

  const close = () => setOpen(false);

  const run = () => {
    // ★꺼 두면 목록을 아예 안 띄운다 (v2 `tagAutocompleteToggle`). 그래야 Enter·Esc 가
    //   블록 것(다음 블록 만들기·편집 끝내기)으로 되돌아간다 — `onKeyDown` 은 목록이
    //   떠 있을 때만 가져가므로, 여기서 막는 것으로 끄는 동작이 완결된다.
    if (!useUi.getState().tagSuggest) return close();
    const ta = ref.current;
    if (!ta) return;
    /* ★★**날것 값을 그대로 읽지 않는다** (사용자 지적 2026-08-22: *"close-up 검색할때 중간에
         - 이거 입력하는 순간 자동완성이 중단됨"*).
       글 상자는 접힘을 막으려고 빈칸을 NBSP 로, 붙임표를 U+2011 로 바꿔 들고 있다
       (`lib/softWrap`). 그대로 읽으면 `close‑` 로 사전을 뒤져 **아무것도 안 걸린다.**
       ★딸림값(`value`)을 대신 쓸 수는 없다 — 이 함수는 50ms 뒤에 도는 타이머가 부르는데,
         그 타이머가 붙든 `run` 은 **바뀌기 전 렌더의 것**이라 한 글자 뒤처진다. 화면을 읽되
         되돌리는 것이 맞다.
       ★길이가 안 바뀌는 치환이라 아래 자리 계산(`at`)이 전부 그대로 맞는다. */
    const raw = toStore(ta.value);
    // ★input 의 selectionStart 는 null 일 수 있다 (여러 줄 칸에는 늘 숫자가 온다)
    const at = ta.selectionStart ?? raw.length;

    // ★**와일드카드 이름이 태그 검색보다 먼저다** (v2 `index.html:20450`).
    //   `(?<![A-Za-z0-9_])` 는 앞에 낱말이 붙은 `#` 을 흘려보낸다 (NAI 액션 태그 `source#tag`).
    //   ★사전을 안 기다린다: 풀 이름은 우리 문서에서 오므로 `tags.json` 과 무관하다.
    const wc = raw.substring(0, at).match(/(?<![A-Za-z0-9_])#([A-Za-z0-9_]*)$/);
    if (wc) {
      const q = wc[1].toLowerCase();
      const pools = useWildcards.getState().pools;
      const names = Object.keys(pools)
        .filter((n) => n.startsWith(q))
        .sort()
        .slice(0, 20);
      if (!names.length) return close();
      setItems(
        names.map((n) => ({
          label: "#" + n,
          value: n,
          count: pools[n].length,
          type: WC_TYPE,
          category: -1,
        })),
      );
      setSel(0);
      setPos(dropdownPos(ta));
      setOpen(true);
      return;
    }

    if (!tagsLoaded()) return;
    // 공백 두 번이면 낱말이 끝난 것으로 본다
    if (at >= 2 && raw.substring(at - 2, at) === "  ") return close();
    const { word } = currentWord(raw, at);
    // ★표기를 여기서 바꾸지 않는다 — 밑줄·띄어쓰기를 같게 보는 자리는 `searchTags` 하나다
    //   (예전에는 여기서 띄어쓰기를 밑줄로 바꿔, 띄어쓰기 표기의 태그가 안 걸렸다)
    if (word.length < 2) return close();
    // ★작가에 `artist:` 를 달지는 설정이 정한다 (`useUi.artistPrefix`)
    const found = searchTags(word, 15, { artistPrefix: useUi.getState().artistPrefix });
    if (!found.length) return close();
    setItems(found);
    setSel(0);
    setPos(dropdownPos(ta));
    setOpen(true);
  };

  /** ★★**붙여넣기 직후에는 목록을 안 띄운다** (사용자 지시 2026-08-24:
   *  *"대량으로 붙여넣고 엔터 누르면 입력되면 좋겠는데 자꾸 마지막 단어로 자동완성을 띄워서
   *  불편함"*).
   *
   *  붙여넣은 글의 **마지막 낱말**로 사전을 뒤지는 것은 뜻이 없다 — 그 낱말은 치던 중이 아니라
   *  이미 완성된 글의 일부다. 그런데 목록이 떠 있으면 `Enter` 를 목록이 가져가서
   *  (`onKeyDown`) 블록 확정 대신 **엉뚱한 태그가 끼워진다.**
   *  ★한 번만 삼키고 표식을 지운다 — 이어서 치면 그때는 평소대로 뜬다.
   *  ★`paste` 는 값이 바뀌기 **전에** 오므로 뒤따르는 `change` 하나가 이 붙여넣기의 것이다.
   *    시각으로 재는 이유: 빈 것을 붙여넣어 `change` 가 아예 안 오면 표식이 남아 **다음에
   *    친 글자 하나**를 삼킨다. */
  const pastedAt = useRef(-1e9);
  const onPaste = () => {
    pastedAt.current = performance.now();
  };

  const onChange = (e: React.ChangeEvent<Field>) => {
    const v = e.target.value;
    const deleting = v.length < last.current.length;
    last.current = v;
    setValue(v);
    if (deleting) return close();
    if (performance.now() - pastedAt.current < 100) {
      pastedAt.current = -1e9;
      return close();
    }
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(run, 50);
  };

  /** 쉼표 접미사 규칙 — 뒤에 이미 쉼표가 있으면 안 붙인다 (정의 편집기에서는 언제나 없다) */
  const tailAfter = (end: number): string => {
    if (opt?.noComma) return "";
    if (end < value.length && value[end] === ",")
      return end + 1 < value.length && value[end + 1] !== " " ? " " : "";
    return ", ";
  };

  /** 와일드카드 이름을 넣는다 (v2 `insertWildcardName`).
   *
   *  ★★**언더바를 공백으로 바꾸지 않는다** (태그와 정반대다). `#hair_color` 가
   *    `#hair color` 가 되면 풀을 못 찾는다. `#` 도 그대로 남긴다.
   *  ★커서 뒤에 이어진 이름 글자는 먹고 갈아 끼운다 (가운데서 고쳐 쓸 수 있게). */
  const insertWc = (name: string) => {
    const ta = ref.current;
    if (!ta) return;
    const cursor = ta.selectionStart ?? value.length;
    const m = value.substring(0, cursor).match(/#([A-Za-z0-9_]*)$/);
    if (!m) return;
    const tokenStart = cursor - m[0].length;
    let end = cursor;
    while (end < value.length && /[A-Za-z0-9_]/.test(value[end])) end++;
    const text = "#" + name + tailAfter(end);
    const next = value.substring(0, tokenStart) + text + value.substring(end);
    caret.current = tokenStart + text.length;
    last.current = next;
    setValue(next, true);
    close();
  };

  /** 고른 것을 커서 자리에 넣는다. 뒤에 `, ` 를 붙여 다음 태그로 이어지게 한다 */
  const insert = (tag: TagEntry) => {
    const ta = ref.current;
    if (!ta) return;
    if (tag.type === WC_TYPE) return insertWc(tag.value);
    const { start, end, fullStart } = currentWord(value, ta.selectionStart ?? value.length);
    const lead = value.substring(fullStart, start);
    const tail = tailAfter(end);
    const text = lead + underscoresToSpaces(tag.value) + tail;
    const next = value.substring(0, fullStart) + text + value.substring(end);
    caret.current = fullStart + text.length;
    last.current = next;
    setValue(next, true);   // ★자리는 아래 useLayoutEffect 가 잡는다 (위 주)
    close();
  };

  useLayoutEffect(() => {
    if (caret.current != null && ref.current) {
      const p = caret.current;
      caret.current = null;
      /* ★굴리지 않는다 (`BlockBody` 의 같은 ★★주). 여기서 `focus()` 를 부르는 목적은
         **커서 자리를 되돌리는 것**뿐인데, 글 상자가 화면보다 길면 브라우저가 맨 위를
         맞추면서 방금 치던 자리가 화면 밖으로 밀린다. */
      ref.current.focus({ preventScroll: true });
      ref.current.setSelectionRange(p, p);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  useEffect(() => {
    if (!open) return;
    (list.current?.children[sel] as HTMLElement | undefined)?.scrollIntoView({ block: "nearest" });
  }, [sel, open]);

  /** true = 자동완성이 가져갔다 (블록의 Enter·Esc 로 넘기지 말 것) */
  const onKeyDown = (e: React.KeyboardEvent<Field>): boolean => {
    if (!open || !items.length) return false;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSel((s) => Math.min(s + 1, items.length - 1));
      return true;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      setSel((s) => Math.max(s - 1, 0));
      return true;
    }
    if ((e.key === "Enter" && !composing(e)) || e.key === "Tab") {
      e.preventDefault();
      if (items[sel]) insert(items[sel]);
      return true;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      close();
      return true;
    }
    return false;
  };

  const node =
    open && items.length ? (
      createPortal(
        <div
          ref={list}
          data-tag-suggest
          style={{
            position: "fixed",
            left: pos.left,
            top: pos.top ?? undefined,
            bottom: pos.bottom ?? undefined,
            width: pos.width,
            maxHeight: pos.maxH,
            overflowY: "auto",
            zIndex: 950,
            background: "var(--panel)",
            border: "1px solid var(--line-strong)",
            borderRadius: "var(--r-2)",
            boxShadow: "var(--shadow-3)",
            padding: 3,
          }}
        >
          {items.map((tag, i) => (
            <div
              key={tag.value + i}
              data-tag-item={tag.value}
              onMouseDown={(e) => {
                e.preventDefault(); // 포커스를 뺏지 않는다 — blur 이 편집을 끝내 버린다
                insert(tag);
              }}
              onMouseMove={() => setSel(i)}
              style={{
                display: "flex",
                alignItems: "center",
                gap: "var(--sp-2)",
                padding: "3px 7px",
                borderRadius: "var(--r-1)",
                cursor: "pointer",
                background: i === sel ? "var(--accent-bg)" : undefined,
              }}
            >
              <span
                style={{
                  flex: 1,
                  minWidth: 0,
                  fontSize: "var(--text-2xs)",
                  color: "var(--ink)",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {tag.label}
              </span>
              <span
                style={{
                  flexShrink: 0,
                  ...TYPE.eyebrow,
                  color: TYPE_COLOR[tag.type] ?? "var(--ink-faint)",
                }}
              >
                {tag.type}
              </span>
              <span
                style={{
                  flexShrink: 0,
                  width: 42,
                  textAlign: "right",
                  fontFamily: "var(--font-mono)",
                  fontSize: "var(--text-2xs)",
                  color: "var(--ink-faint)",
                }}
              >
                {formatCount(tag.count)}
              </span>
            </div>
          ))}
        </div>,
        document.body,
      )
    ) : null;

  return { onChange, onPaste, onKeyDown, close, node, open };
}

const TYPE_COLOR: Record<string, string> = {
  artist: "var(--warn)",
  character: "var(--char-c)",
  copyright: "var(--accent-ink)",
  meta: "var(--ink-dim)",
  [WC_TYPE]: "var(--accent-ink)",
};

/** 글 상자의 **모습을 그대로 베낀 거울** — 자동완성이 설 자리를 재는 데 쓴다.
 *
 *  ★★`font` 줄임 표기를 **베끼지 않는다** (사용자 지적 2026-08-28: *"원래는 편집 중인 곳
 *    옆에 정확히 떴는데 지금은 다른 줄에 뜬다"*). `getComputedStyle(el).font` 는 줄임
 *    표기라 브라우저가 **빈 글자를 돌려주는 경우가 있고**, 그러면 거울이 기본 글꼴로
 *    떨어진다. 우리 글 상자는 `WideSep`(구분자 빈칸을 넓힌 글꼴)을 쓰므로, 기본 글꼴로
 *    재면 **줄바꿈 자리가 통째로 달라져** 커서가 몇 줄 아래위로 어긋난다.
 *    그래서 낱개 속성을 하나하나 베낀다 — 줄바꿈을 정하는 것은 전부 여기 있다. */
const MIRROR_COPY = [
  "white-space", "word-wrap", "overflow-wrap", "word-break", "line-break", "hyphens",
  "font-family", "font-size", "font-weight", "font-style", "font-variant", "font-stretch",
  "font-kerning", "font-feature-settings", "font-variation-settings", "font-size-adjust",
  "letter-spacing", "word-spacing", "text-transform", "text-indent", "text-rendering",
  "tab-size", "direction", "line-height",
  "padding-top", "padding-right", "padding-bottom", "padding-left", "box-sizing",
];

/** 커서가 선 줄의 **화면 위치**를 재고, 목록을 그 바로 아래(또는 위)에 놓는다.
 *
 *  ★★위로 뒤집을 때는 **아래쪽 끝을 잡는다**(`bottom`) — 예전에는 「커서에서 304px 위」로
 *    잡았는데, 그것은 목록이 언제나 300px 높이라고 친 값이다. 후보가 두셋이면 목록은
 *    100px도 안 되므로 **커서에서 한참 떨어진 곳**에 떴다 (사용자 지적 2026-08-28:
 *    *"위로 뜰 때는 아예 엄청 먼 곳에 뜬다"*). 아래쪽 끝을 커서 줄에 맞추면 목록이
 *    몇 줄이든 언제나 커서 바로 위에 붙는다.
 *  ★남은 자리에 맞춰 **높이도 줄인다** — 그래야 화면 밖으로 밀려나지 않는다. */
function dropdownPos(ta: Field) {
  const cs = window.getComputedStyle(ta);
  const mirror = document.createElement("div");
  const s = mirror.style;
  s.position = "absolute";
  s.visibility = "hidden";
  s.top = "0";
  s.left = "-9999px";
  for (const k of MIRROR_COPY) s.setProperty(k, cs.getPropertyValue(k));
  // ★테두리는 빼고 **안쪽 폭만** 맞춘다 (`clientWidth` 는 테두리를 뺀 값이다)
  s.border = "0";
  s.width = ta.clientWidth + "px";
  const line = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.2;
  mirror.textContent = ta.value.substring(0, ta.selectionStart ?? ta.value.length);
  /* ★★표식은 **줄칸 높이만 한 빈 상자**다 (사용자 지적 2026-08-28: *"자동완성이 지금
       입력 중인 거랑 한 칸 어긋남"*).
     글자를 담은 표식으로 재면 그 상자의 윗변은 **글자 상자의 위**이지 줄칸의 위가 아니다.
     줄 간격이 2.065 라 그 둘은 반줄 가까이 벌어지고(위아래로 나뉜 여백), 거기에 줄 높이를
     한 번 더 더하니 목록이 반 칸 넘게 내려갔다.
     `vertical-align: top` 인 빈 상자는 **윗변이 줄칸의 윗변에 붙으므로**, 재는 값이 곧
     줄칸의 위아래가 된다. 폭이 0 이라 줄바꿈에는 영향이 없다. */
  const mark = document.createElement("span");
  mark.style.cssText = `display:inline-block;width:0;height:${line}px;vertical-align:top`;
  mirror.appendChild(mark);
  document.body.appendChild(mirror);
  const m = mark.getBoundingClientRect();
  const d = mirror.getBoundingClientRect();
  const x = m.left - d.left;
  const y = m.top - d.top;
  document.body.removeChild(mirror);

  const r = ta.getBoundingClientRect();
  // ★거울에는 테두리가 없으므로 글 상자의 테두리 두께만큼 더해 준다
  const bt = parseFloat(cs.borderTopWidth) || 0;
  const bl = parseFloat(cs.borderLeftWidth) || 0;
  const width = Math.min(340, Math.max(230, r.width));

  let left = r.left + bl + x - ta.scrollLeft;
  if (left + width > window.innerWidth - 10) left = window.innerWidth - width - 10;
  if (left < 10) left = 10;

  /** 커서가 선 줄의 위·아래 끝 (화면 좌표) */
  const lineTop = r.top + bt + y - ta.scrollTop;
  const lineBottom = lineTop + line;
  const below = window.innerHeight - lineBottom - 10;
  const above = lineTop - 10;
  // ★아래가 너무 좁고 위가 더 넓을 때만 뒤집는다 — 어중간하면 아래가 눈에 자연스럽다
  const flip = below < 160 && above > below;
  const maxH = Math.max(80, Math.min(300, flip ? above : below));
  return flip
    ? { left, width, maxH, top: null, bottom: window.innerHeight - lineTop + 4 }
    : { left, width, maxH, top: lineBottom + 4, bottom: null };
}
