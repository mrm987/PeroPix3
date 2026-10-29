/** 블록 모델과 컴파일 — 목업(peropix-block-editor.html)에서 이식.
 *
 *  ★가중치는 **태그에만** 있다 (2026-08-01 결정).
 *    목업에는 블록 가중치(제목 휠)가 있었지만, 쓰임이 불분명하고 곱셈이 혼란스러워 걷어냈다.
 *    필요해지면 되살릴 수 있으나, 되살릴 땐 "왜 태그 가중치로는 안 되는가"를 먼저 답할 것.
 *  ★NAI 가중치 문법은 `n::tag::` 가 정본이다 (갤러리 392건 중 63.5%).
 *    `{}` `[]` 는 구형이라 만들지 않는다.
 */

import { guardedRanges, isGuarded } from "./naiText.ts";

export type Tag = {
  t: string;
  w: number | null;
  /** ★★**앞 칩과 한 묶음** — `0.95::a, b::` 처럼 가중치 하나를 함께 쓴다 (사용자 지시 2026-10-29: 같은 가중치
   *  묶기는 버튼으로 켜는 별도 기능, 묶인 것은 화면에도 묶여 보이게). 가중치가 앞 칩과 같을 때만 뜻이 있다
   *  (`joined`). 묶음 단위로 다루는 것은 전부 `tagRuns` 하나를 거친다. */
  g?: boolean;
};

export type BlockColor = "blue" | "teal" | "purple" | "amber" | "red" | "green" | null;

export type Block = {
  id: string;
  label: string;
  color: BlockColor;
  /** 끄면 컴파일에서 빠진다 */
  on: boolean;
  open: boolean;
  tags: Tag[];
  /** ★★**들어온 글 그대로** — 붙여넣거나 친 글, 메타데이터에서 되살린 글이다.
   *
   *  칩을 하나도 안 건드렸으면 조립하지 않고 **이것을 그대로 NAI 에 보낸다**
   *  (`compileBlock`). NAI 는 글자를 그대로 받는 쪽이라, 뜻이 같아도 표기가 달라지면
   *  같은 시드에서 다른 그림이 나온다 — 실제로 그 대조에서 이 대화가 시작됐다.
   *  ★**두 번째 편집 창구가 아니다.** 값은 언제나 `tags` 가 정본이고, 여기 것은
   *    `parseSegs(src)` 가 `tags` 와 **똑같을 때만** 쓰인다 (`untouched`). 어긋나는 순간
   *    버려지므로 「어느 쪽이 진짜인가」가 생기지 않는다. 맞춰 주는 장치를 만들지 말 것.
   *  ★칩을 고치면 자동으로 안 맞게 되어 정식 문법으로 다시 쓰인다. 글 상자에서 친 글은
   *    **친 그대로가 새 원문**이 된다 (`BlockBody`). */
  src?: string;
};

export const COLORS: BlockColor[] = [null, "blue", "teal", "purple", "amber", "red", "green"];

export const COLOR_HEX: Record<string, string> = {
  blue: "#4a90d9",
  teal: "#2aa198",
  purple: "#9b6dd6",
  amber: "#d8a34f",
  red: "#d9736a",
  green: "#58a86c",
};

let seq = 0;
export const newId = () => `b${Date.now().toString(36)}${(seq++).toString(36)}`;

export function makeBlock(label: string, tags: string[] = [], opt: Partial<Block> = {}): Block {
  return {
    id: newId(),
    label,
    color: null,
    on: true,
    open: false,
    tags: tags.map((t) => ({ t, w: null })),
    ...opt,
  };
}

/** 소수점 둘째 자리까지. 1.20 -> "1.2" */
export const fmtW = (w: number) => String(Math.round(w * 100) / 100);

/** 실효 가중치 = 태그 가중치. 1 이면 null (문법을 붙이지 않는다) */
export function effW(x: Tag): number | null {
  if (x.w == null) return null;
  const e = Math.round(x.w * 100) / 100;
  return e === 1 ? null : e;
}

/** ★★강조를 **닫는** `::` 를 만드는 유일한 자리.
 *
 *  ★★**앞이 숫자로 끝나면 공백을 하나 넣는다.** 안 넣으면 NAI 가 닫는 `::` 를
 *    **여는 것**으로 읽는다 — 파서가 `::` 앞에서 숫자를 되찾기 때문이다
 *    (공홈 `/-?\d*\.?\d*$/`). 그래서 `0.8::artist:dishwasher1910::` 는
 *    「0.8 로 열고 … **1910 으로 다시 연다**」가 되고, 그 뒤가 전부 1910배로 조건화돼
 *    잠재값이 터진다 → **초록 노이즈만 나온다** (실측 2026-08-21, 이분 탐색으로 확인).
 *  ★`.` 나 `-` 로 끝나도 같다 — 그때는 가중치가 **0** 으로 잡힌다.
 *  ★공홈도 같은 처방을 쓴다: 편집기가 `emphasisError3` 로 **「`숫자 ::` 처럼 띄우라」**고 알린다.
 *  ★필요할 때만 넣는다 — 늘 넣으면 공홈이 내보내는 문자열과 달라진다. */
const closeEmph = (inner: string) => (/[-.\d]$/.test(inner) ? `${inner} ::` : `${inner}::`);

/** ★묶음(`g`)은 **안 견준다** — 묶음을 몰랐던 때 저장한 칩에는 `g` 가 없어서, 견주면 묶어 친 원문이
 *  전부 「고친 것」이 되어 보내는 글이 바뀐다. 묶음만 바꾸는 조작(묶기 버튼)은 원문을 지운다 (`groupAll`). */
const sameTags = (a: Tag[], b: Tag[]) =>
  a.length === b.length && a.every((x, i) => x.t === b[i].t && (x.w ?? null) === (b[i].w ?? null));

/** 들어온 글을 그대로 써도 되는가 — **다시 읽어 지금 칩과 같은지**로만 판정한다.
 *  ★「고쳤다」를 따로 기억하지 않는다. 기억해 두면 고치는 자리마다 지우는 것을 잊어
 *    옛 글자가 조용히 나간다. 매번 다시 읽는 편이 싸고 틀릴 데가 없다. */
export const untouched = (bl: Block): boolean =>
  bl.src != null && sameTags(parseSegs(bl.src), bl.tags);

/** ★★화면과 편집이 보는 칩 — 원문을 그대로 보내는 블록은 **원문의 묶음**까지 읽는다.
 *  보내는 글이 원문이므로, 화면도 원문이 묶은 대로 보여야 한다 (묶음을 몰랐던 때 저장한 칩에는 `g` 가 없다).
 *  ★칩을 고치는 자리는 전부 이것에서 시작한다 — `block.tags` 에서 시작하면 고치는 순간 묶음이 풀린다. */
export function liveTags(bl: Block): Tag[] {
  if (bl.src == null) return bl.tags;
  const p = parseSegs(bl.src);
  return sameTags(p, bl.tags) ? p : bl.tags;
}

/** `i` 번째 칩이 앞 칩과 한 묶음인가 — 표시(`g`)가 있어도 **가중치가 같지 않으면 아니다**
 *  (가중치를 하나만 바꾸거나 칩을 옮기면 표시가 남아도 묶음은 끝난다). */
export const joined = (tags: Tag[], i: number): boolean => {
  if (i <= 0 || !tags[i]?.g) return false;
  const e = effW(tags[i]);
  return e != null && e === effW(tags[i - 1]);
};

/** 칩 줄을 **묶음 단위로** — `[from, to)`. 묶이지 않은 칩은 하나짜리 묶음이다.
 *  ★보내는 글·글 상자·화면이 이것 하나로 묶음을 정한다. 셋이 따로 정하면 보이는 것과 보내는 것이 갈린다. */
export function tagRuns(tags: Tag[]): { from: number; to: number }[] {
  const out: { from: number; to: number }[] = [];
  for (let i = 0; i < tags.length; i++) {
    if (joined(tags, i) && out.length) out[out.length - 1].to = i + 1;
    else out.push({ from: i, to: i + 1 });
  }
  return out;
}

/** `g` 를 정리한다 — 뜻이 없는 표시(맨 앞 · 가중치가 다름 · 가중치 없음)는 떼어 낸다.
 *  ★남겨 두면 나중에 가중치가 우연히 같아질 때 묶으려 한 적 없는 칩이 묶인다. */
export function tidyGroups(tags: Tag[]): Tag[] {
  return tags.map((x, i) => (x.g && !joined(tags, i) ? { t: x.t, w: x.w } : x));
}

/** 이 블록에 **묶을 수 있는 자리**가 있나 — 가중치가 같은 칩이 묶이지 않은 채 이어진 곳 */
export function canGroup(tags: Tag[]): boolean {
  return tags.some((x, i) => i > 0 && !joined(tags, i) && effW(x) != null && effW(x) === effW(tags[i - 1]));
}

/** 묶음이 하나라도 있나 */
export const hasGroup = (tags: Tag[]): boolean => tags.some((_, i) => joined(tags, i));

/** 묶기 버튼 — 묶을 자리가 있으면 **가중치가 같은 칩이 이어진 곳을 전부** 묶고, 없으면 전부 푼다.
 *  ★★원문(`src`)을 지운다. 묶음은 `untouched` 가 안 견주므로(`sameTags` 의 ★주), 원문을 남기면
 *    묶음을 바꿔도 원문이 그대로 나가 버튼이 아무 일도 안 한 것이 된다. */
export function groupAll(bl: Block): Block {
  const tags = liveTags(bl);
  const next = canGroup(tags)
    ? tags.map((x, i) => (i > 0 && effW(x) != null && effW(x) === effW(tags[i - 1]) ? { ...x, g: true } : x))
    : tags.map((x) => ({ t: x.t, w: x.w }));
  const { src: _drop, ...rest } = bl;
  return { ...rest, tags: next };
}

/** `i` 번째 칩의 가중치를 바꾼다 — ★묶음 안의 칩이면 **묶음 전체**가 함께 바뀐다 (가중치가 하나뿐이다).
 *  가중치를 지우면(1) 묶음도 끝난다. */
export function setWeight(tags: Tag[], i: number, w: number | null): Tag[] {
  const r = tagRuns(tags).find((x) => i >= x.from && i < x.to) ?? { from: i, to: i + 1 };
  return tidyGroups(tags.map((x, j) => (j >= r.from && j < r.to ? { ...x, w } : x)));
}

/** `i` 번째 칩을 뺀다 — ★묶음의 **첫 칩**을 빼면 다음 칩이 묶음의 머리가 된다.
 *  그냥 빼면 다음 칩의 표시가 그 앞의 다른 칩을 가리켜, 가중치가 같으면 엉뚱한 칩과 묶인다. */
export function takeTag(tags: Tag[], i: number): { tag: Tag | undefined; rest: Tag[] } {
  const tag = tags[i];
  if (!tag) return { tag, rest: tags.slice() };
  const rest = tags.slice();
  rest.splice(i, 1);
  if (!joined(tags, i) && joined(tags, i + 1)) rest[i] = { t: rest[i].t, w: rest[i].w };
  return { tag: { t: tag.t, w: tag.w }, rest };
}

/** `at` 자리에 칩을 끼운다 — ★묶음 **안**(묶인 두 칩 사이)에 놓으면, 가중치가 같을 때 그 묶음에 들어가고
 *  다르면 묶음이 거기서 갈린다. 묶음 밖에 놓은 칩은 혼자다. */
export function putTag(tags: Tag[], at: number, tag: Tag): Tag[] {
  const out = tags.slice();
  const inside = joined(tags, at);
  const e = effW(tag);
  out.splice(at, 0, inside && e != null && e === effW(tags[at]) ? { ...tag, g: true } : { t: tag.t, w: tag.w });
  return tidyGroups(out);
}

/** ★★가중치 숫자 앞의 **하이픈 닮은 글자**를 `-` 로 (사용자 지적 2026-10-13: 갤러리에서 복제하니
 *  `‑1::artist collaboration::` 의 `‑1` 이 따로 칩이 됐다). 붙여 온 프롬프트에 U+2011(안 깨지는 붙임표)·
 *  빼기 기호(U+2212) 같은 것이 섞여 오면 파서가 숫자를 가중치로 못 읽고, 손대지 않은 블록은 그 글자를
 *  그대로 NAI 로 보냈다 (공홈도 `-?\d*\.?\d*::` 의 ASCII `-` 만 읽는다).
 *  ★한 글자를 한 글자로 바꾼다 — 자리(`parseSpans` 의 start·end)가 그대로 맞는다.
 *  ★가중치 자리(낱말 앞 + 숫자 + `::`)만 바꾼다. 태그 안의 붙임표(`close‑up`)는 건드리지 않는다. */
const weightDash = (str: string): string =>
  str.replace(/(^|[,\s])[\u2010-\u2013\u2212\uFE63\uFF0D](?=\d+(?:\.\d+)?::)/g, "$1-");

/** 글이 끝나는 시점의 세기 — 1(=null)이 아니면 뒤에 오는 블록으로 **번진다**.
 *  ★`::` 는 짝이 아니라 갈아 끼우는 값이라, 안 되돌린 채 끝나면 다음 블록의 태그까지
 *    그 세기에 걸린다 (`compileBlocks` 가 쉼표로 이어 붙인다). */
const endWeight = (str: string): number | null => {
  str = weightDash(str);
  const re = /(^|[,\s])(-?\d+(?:\.\d+)?)::|::/g;
  let w: number | null = null;
  let m: RegExpExecArray | null;
  while ((m = re.exec(str))) {
    const n = m[2] !== undefined ? parseFloat(m[2]) : NaN;
    w = Number.isNaN(n) || n === 1 ? null : n;
  }
  return w;
};

/** 칩 줄을 글로 — 묶음(`tagRuns`)마다 `0.95::a, b::` · 혼자인 칩은 `0.95::a::` · 가중치가 없으면 `a`.
 *  `starts[i]` 는 `i` 번째 칩이 글에서 시작하는 자리다 (묶음의 머리는 가중치 숫자 앞).
 *  ★★칩은 **보이는 대로** 쓴다. 따로 보이는 칩은 가중치가 같아도 따로 쓰고, 묶음은 묶어서 쓴다 (사용자 지시
 *    2026-10-29: *"보이는거랑 보내지는게 일치하도록 해줘. 묶는걸 바꾸기만해도 결과 이미지가 달라짐"*).
 *    예전에는 칩을 고친 블록만 같은 가중치를 저절로 묶어 보내서, 화면과 보내는 글이 달랐다.
 *    글 상자(`serializeBlock`)·보내는 글(`compileBlock`)·커서 자리(`caretAfterTag`)가 이것 하나를 쓴다. */
function layoutTags(tags: Tag[]): { text: string; starts: number[] } {
  let text = "";
  const starts: number[] = [];
  for (const r of tagRuns(tags)) {
    if (text) text += ", ";
    starts[r.from] = text.length;
    const e = effW(tags[r.from]);
    // 묶음 안의 칩은 `숫자::` 뒤에서 `, ` 로 이어진다
    const head = text.length + (e != null ? fmtW(e).length + 2 : 0);
    let off = 0;
    for (let i = r.from; i < r.to; i++) {
      if (i > r.from) starts[i] = head + off;
      off += tags[i].t.length + 2;
    }
    const inner = tags.slice(r.from, r.to).map((x) => x.t).join(", ");
    text += e != null ? `${fmtW(e)}::${closeEmph(inner)}` : inner;
  }
  return { text, starts };
}

/** 블록 하나를 NAI 프롬프트 문자열로.
 *  ★손대지 않은 블록은 **들어온 글 그대로** 낸다 (`Block.src` 주석).
 *  ★고친 블록은 보이는 대로 쓴다 (`layoutTags`). 글 상자에 보이는 글과 같다. */
export function compileBlock(bl: Block): string {
  const tags = bl.tags.filter((x) => x.t.trim());
  if (!tags.length) return "";

  if (untouched(bl)) {
    const raw = weightDash(bl.src!.trim());
    // ★세기를 안 되돌린 채 끝나면 `::` 하나로 막는다 — 그 한 글자 말고는 원문 그대로다
    return endWeight(raw) != null ? `${raw}${/[-.\d]$/.test(raw) ? " ::" : "::"}` : raw;
  }

  return layoutTags(tags).text;
}

/** 켜진 블록만 이어 붙인다.
 *  ★★앞 조각이 **이미 쉼표로 끝나면** 쉼표를 하나 더 붙이지 않는다 (사용자 지적 2026-08-22).
 *    원문을 그대로 내는 블록(`Block.src`)은 사용자가 친 그대로라 `girl,` 처럼 쉼표로
 *    끝날 수 있는데, 거기에 `", "` 를 더하면 `girl,, ` 가 된다. */
export function compileBlocks(blocks: Block[]): string {
  return blocks
    .filter((b) => b.on)
    .map(compileBlock)
    .filter(Boolean)
    .reduce((acc, part) => (acc ? acc + (/,\s*$/.test(acc) ? " " : ", ") + part : part), "");
}

/** 씬 칸 하나 = **블록 하나** (사용자 결정 2026-08-20).
 *
 *  ★★씬 칸은 예전에 목록이었다. 그러다 줄 안이 좁아 글 상자로 바꾸면서
 *    **저장은 목록, 편집은 한 줄**로 갈라졌다 — 그래서 씬 칸은 칩도 가중치 휠도
 *    못 썼고, 블록이 둘 이상인 카드를 얹으면 첫 편집에 이름·색·온오프가 조용히 뭉개졌다.
 *    이제 **칸에 블록은 하나뿐**이다 — 그래서 머리(이름·색·켜고끄기)를 그리지 않고
 *    칩만 남긴다. 칸 이름은 줄 머리에 이미 있어 블록 라벨은 **빈다**
 *    (같은 이름을 두 곳에 두면 어느 쪽이 진짜인지 모른다).
 *  ★여러 개가 오면 **켜진 것만 이어 붙인다** — 꺼진 블록은 화면에 안 보이던 것이라
 *    살려 내면 안 적은 태그가 갑자기 나타난다 (지금까지 `compileBlocks` 가 보여 주던 것과 같다).
 *  ★id 는 **칸이 준다** — 매번 새로 발급하면 다시 그릴 때마다 블록이 바뀐 것으로 읽힌다. */
export function slotBlock(blocks: Block[] | undefined, id: string): Block {
  const on = (blocks ?? []).filter((b) => b.on);
  if (on.length === 1) return { ...on[0], label: "", open: true };
  return {
    id: on[0]?.id ?? id,
    label: "",
    color: null,
    on: true,
    open: true,
    // ★블록마다의 묶음은 그대로 둔다 — 각 블록의 첫 칩은 앞 블록의 칩과 묶이지 않는다
    tags: on.flatMap((b) => liveTags(b).map((x, i) => (i ? x : { t: x.t, w: x.w }))),
  };
}

/** 칸에 다시 담는다 — ★저장본은 언제나 **하나짜리 목록**이다 */
export const slotBlocksOf = (b: Block): Block[] => [{ ...b, label: "", on: true, open: true }];

/** 텍스트를 태그 목록으로.
 *
 *  ★★**`::` 는 짝을 맞추는 괄호가 아니다** (공홈 번들 대조 2026-08-21,
 *    `reference/nai-web-2026-08-21/chunks/5196-…` 의 강조 표):
 *
 *      { textSequence: "::", needsBeforeNumber: true,
 *        transformEmphasis: (p, n) => (n === undefined || Number.isNaN(n) ? 1 : n) }
 *
 *    숫자가 앞에 붙은 `N::` 를 만나면 세기가 **N 으로 갈아 끼워지고**, 숫자 없는 `::` 를
 *    만나면 **1 로 돌아간다.** 쌓이지도 곱해지지도 않고, 여는 짝도 닫는 짝도 없다.
 *    그래서 **닫는 `::` 가 없어도 정상이다** — 다음 `N::` 나 글 끝까지 그 세기가 이어진다.
 *
 *    ~~예전에는 `N::(.*?)::` 로 닫는 짝을 찾았다~~ — 공홈에 없는 규칙이라, 닫는 `::` 를
 *    빠뜨린 글에서 **다음 줄의 가중치 숫자를 앞 그룹 안으로 끌고 들어갔다.** 실측:
 *    `1.1::artist:ask (askzy),\n1.2::artist:bee (deadflow),` 가 「`1.2` 라는 이름의 태그가
 *    1.1 세기로」 + 「bee 는 가중치 없음」이 됐다. 칩이 거짓말을 하고 있었다.
 *
 *  ★★**줄바꿈도 태그 경계다** (사용자 지적 2026-08-21). 예전에는 쉼표로만 잘라서
 *    `girl⏎⏎solo` 가 줄바꿈을 품은 **칩 하나**가 됐다. 태그 안에 줄바꿈이 있는 것은
 *    우리 모델에서 뜻이 없다. 가중치 앞에서는 이미 공백을 경계로 인정하고 있었으므로
 *    (`[,\s]`) 같은 함수 안에서 규칙이 어긋나 있던 자리다.
 *    공홈도 공백을 태그 경계로 본다 (`chunks/5196` 의 태그 자동완성 트리거: `/\s/.test(n)`).
 *
 *  ★★가중치 숫자는 **낱말 앞**에서만 시작한다 (앞이 쉼표·공백이거나 글 처음).
 *    그렇지 않으면 **태그 끝의 숫자를 가중치로 뜯어 간다** — `artist:dishwasher1910::foo::`
 *    가 `artist:dishwasher` + `1910::foo::` 로 갈려 태그가 두 동강 난다.
 *    v2 에서 같은 것을 고쳤다 (사용자 지적 2026-08-21: "1910 을 가중치로 안 읽고
 *    태그로 읽게 수정했었음").
 *    ★NAI 서버는 이 규칙이 **없다** — 거기서는 `숫자::` 면 어디서든 연다. 그래서 만들 때는
 *      닫는 `::` 앞에 공백을 넣어 막는다 (`closeEmph`). 읽는 쪽과 쓰는 쪽이 **다른 처방**이다.
 *    ★그래서 `1.2 ::` 처럼 숫자와 `::` 사이가 떨어진 것은 **여는 것이 아니라 되돌리는 것**이다
 *      (공홈도 숫자를 `::` 바로 앞에서만 찾는다). `\s*` 를 넣지 말 것 — 넣으면 우리가 만든
 *      `…1910 ::` 를 다시 읽을 때 1910 으로 열어 버린다. */
export function parseSegs(str: string): Tag[] {
  return parseSpans(str).map(({ t, w, g }) => (g ? { t, w, g } : { t, w }));
}

/** 태그마다 **원문에서의 자리**까지 낸다 — 칩을 눌러 글 상자를 열 때 커서를 놓는 데 쓴다
 *  (`caretAfterTag`). 규칙은 `parseSegs` 와 같은 것 하나다. */
export function parseSpans(str: string): (Tag & { start: number; end: number })[] {
  str = weightDash(str);
  const out: (Tag & { start: number; end: number })[] = [];
  /** 여는 자리(`낱말경계 + 숫자 + ::`) 또는 되돌리는 자리(맨 `::`) */
  const re = /(^|[,\s])(-?\d+(?:\.\d+)?)::|::/g;
  /** 지금 세기 — `::` 를 만날 때마다 갈아 끼운다 (스택이 아니다) */
  let w: number | null = null;
  let cur = 0;
  let m: RegExpExecArray | null;

  /* ★★**NAI 가 글자로 그리는 자리는 안 자른다** (사용자 지적 2026-08-28: *"우리는 쉼표가
       칩으로 분할해버림"*). 따옴표 짝과 `text:` 절이 그렇다 — 그 안의 쉼표는 구분자가 아니라
       **그려질 글자**다. 규칙은 `lib/naiText` 에 있고, 정본은 백엔드(`naitext.py`)다. */
  const guard = guardedRanges(str);

  /** ★쉼표와 **줄바꿈** 둘 다에서 자른다 — 단, 지켜야 할 구간 안에서는 안 자른다
   *  ★★한 구간(`숫자::` 에서 다음 `::` 까지)에서 나온 칩들은 **한 묶음**이다 (`Tag.g`) — `0.95::a, b::` 는
   *    가중치 하나를 둘이 함께 쓴다. 화면이 그 묶음을 그대로 보여야 보내는 글과 같다. */
  const plain = (from: number, to: number) => {
    let first = true;
    const push = (s: number, e: number) => {
      const seg = str.slice(s, e);
      const t = seg.trim();
      if (!t) return;
      const at = s + seg.indexOf(t);
      out.push({ t, w, start: at, end: at + t.length, ...(!first && w != null ? { g: true } : null) });
      first = false;
    };
    let start = from;
    for (let i = from; i < to; i++) {
      const c = str[i];
      if ((c === "," || c === "\n") && !isGuarded(guard, i)) {
        push(start, i);
        start = i + 1;   // 자른 구분자 한 글자
      }
    }
    push(start, to);
  };

  while ((m = re.exec(str))) {
    // ★지켜야 할 구간 안의 `::` 는 세기 표시가 아니라 그려질 글자다
    if (isGuarded(guard, m.index)) continue;
    const opening = m[2] !== undefined;
    // 경계 글자(쉼표·공백)는 구분자라 앞 구간에 남겨 둔다 — `plain` 이 어차피 잘라 낸다
    plain(cur, opening ? m.index + m[1].length : m.index);
    const n = opening ? parseFloat(m[2]) : NaN;
    w = Number.isNaN(n) || n === 1 ? null : n;
    cur = re.lastIndex;
  }
  plain(cur, str.length);
  return out;
}

/** 블록을 텍스트 편집용으로 직렬화. 파싱의 역이라 왕복해도 같은 결과가 나온다.
 *  ★손대지 않았으면 **들어온 글 그대로** 보여 준다 — 글 상자를 열어 보기만 해도 줄바꿈이
 *    쉼표로 바뀌어 있으면, 사용자는 자기가 맞춰 둔 모양을 잃은 줄 안다. */
export function serializeBlock(bl: Block): string {
  if (untouched(bl)) return bl.src!;
  return layoutTags(bl.tags).text;
}

/** 칩을 눌러 글 상자를 열 때 **그 태그의 쉼표 뒤**에 놓을 커서 자리와, 그때 펼칠 글.
 *
 *  ★태그 **끝**에 놓으면 치는 글자가 그 태그에 달라붙는다 (사용자 지적 2026-08-19).
 *    칩을 누르는 것은 거기서부터 **이어 적으려는** 것이라, 자리는 다음 태그가 시작하는 곳이다.
 *  ★한 태그가 한 조각이라(`serializeBlock`) 앞부분 길이 + `", "` 가 정확히 그 자리다.
 *  ★마지막 태그면 이어 붙일 쉼표가 없다 — 하나 만들어 준다. 안 치고 나가면 빈 조각이라
 *    `parseSegs` 가 버리므로 블록은 그대로다.
 */
export function caretAfterTag(bl: Block, i: number): { at: number; text: string } {
  // ★원문을 그대로 보여 주는 블록은 **원문에서의 자리**로 놓는다 — 조립한 글 기준으로
  //   세면 줄바꿈이 쉼표로 바뀐 만큼 커서가 밀린다
  if (untouched(bl)) {
    const spans = parseSpans(bl.src!);
    const next = spans[i + 1];
    if (next) return { at: next.start, text: bl.src! };
    /* ★★마지막 태그면 이어 적을 자리를 만들어 주는데, 원문이 **이미 쉼표로 끝나면**
       하나 더 붙이지 않는다 (사용자 지적 2026-08-22: `girl,` 로 저장한 뒤 칩을 누를
       때마다 쉼표가 하나씩 늘었다). 빠진 것만 채운다. */
    const raw = bl.src!;
    const tail = /,\s*$/.test(raw) ? (/\s$/.test(raw) ? "" : " ") : ", ";
    return { at: raw.length + tail.length, text: raw + tail };
  }
  // ★묶음 안에서는 다음 칩의 이름 앞, 묶음 끝이면 다음 묶음의 가중치 숫자 앞이다 (`layoutTags` 의 `starts`)
  const { text, starts } = layoutTags(bl.tags);
  if (i < bl.tags.length - 1) return { at: starts[i + 1], text };
  return { at: text.length + 2, text: `${text}, ` };
}

/** 켜진 블록들에서 중복 태그를 찾는다 (계기판 — 고치지 않고 표시만 한다).
 *  ★★`against` 를 주면 **그 목록에도 있는 태그**까지 낸다 (사용자 지시 2026-10-12: 네거티브에 있는 태그를
 *    포지티브에 적었을 때도 표시). 같은 섹션의 Prompt ↔ Undesired Content 를 서로 넘긴다 (`SectionBody`).
 *    기준은 중복과 같다 — 켜진 블록만, 대소문자·앞뒤 공백 무시. */
export function dupSet(blocks: Block[], against?: Block[]): Set<string> {
  const keys = (bs: Block[]) =>
    bs.filter((b) => b.on).flatMap((b) => b.tags.map((x) => x.t.trim().toLowerCase()).filter(Boolean));
  const seen = new Set<string>();
  const dup = new Set<string>();
  for (const k of keys(blocks)) {
    if (seen.has(k)) dup.add(k);
    else seen.add(k);
  }
  if (against) for (const k of keys(against)) if (seen.has(k)) dup.add(k);
  return dup;
}

/** 가중치 강조 수준 → 칩 색 세기 (사용자 요청: 칩 상태에서도 강조가 보이게).
 *  0 = 보통, 양수 = 강조, 음수 = 억제 */
/** 칩 색 — **부호**와 **세기(0~1)**.
 *
 *  ★★**부호가 색을 가른다** (사용자 지시 2026-08-30: 양수면 파랑, 음수면 빨강 — 예전에는 1 미만
 *    (0.2 같은 낮춤)도 빨강이라 음수 가중치와 섞여 헷갈렸다).
 *  ★★**세기는 값이 오를수록 한결같이 진해진다** (같은 날 두 번째 지시: "0 에서 흐리고 상승할수록
 *    진하게"). 예전의 「1 에서 먼 만큼」은 0.2 와 1.5 가 같은 진하기라 이상했다. 이제 |w| / 2 —
 *    0 근처는 흐리고 2 에서 가장 진하다 (그 위는 같다). 가중치가 없으면(1·null) 색이 없다.
 *    ★맨 아래는 0.1 로 받친다 — 0.05 같은 값도 「걸려 있다」는 것은 보여야 한다. */
export function weightTone(w: number | null): { sign: 0 | 1 | -1; s: number } {
  if (w == null || w === 1) return { sign: 0, s: 0 };
  const s = Math.min(1, Math.max(0.1, Math.abs(w) / 2));
  return { sign: w < 0 ? -1 : 1, s };
}
