/** Danbooru 태그 사전 — 페로픽스파이(`ui/src/tags/tagData.ts`)에서 이식.
 *
 *  `public/tags.json` 68,427개(2026-01-18 시점)를 **한 번** 읽어 첫 글자 인덱스를 만들고,
 *  `startsWith` → 모자라면 `includes` 두 단계로 찾는다.
 *
 *  ★사전은 **읽기만 한다.** 코드가 고치지 않는다.
 *  ★한국어 별칭은 없다 — 공개된 한국어 단부루 태그 데이터셋이 없다(2026-08-07 조사,
 *    일본어·중국어는 있다). 필요해지면 별도 파일로 얹되 이 파일은 그대로 둔다. */

export type TagEntry = {
  label: string;
  value: string;
  count: number;
  /** general | artist | character | copyright | meta */
  type: string;
  category: number;
  aliases?: string[];
  _lower?: string;
};

/** NAI 가 쓰는데 단부루 사전에는 없는 것들 — **파일 하나로 뺐다** (`public/tags-extra.json`).
 *
 *  ★★2026-08-24 까지는 이 자리에 목록을 **코드로 박아 두었다.** 그런데 조수의 `search_tags`
 *    (`backend/agent.py`)는 `tags.json` **파일만** 읽어서, 여기 얹은 V5 태그와 `nsfw`/`sfw` 를
 *    「없다」고 판단했다 — 같은 정보에 창구가 둘로 갈린 자리였다.
 *    이제 **프런트와 백엔드가 같은 두 파일**을 읽는다 (`tags.json` + `tags-extra.json`).
 *  ★`tags.json`(단부루 덤프)은 **손대지 않는다.** 우리가 더하는 것만 따로 둔다.
 *  ★`count` 가 0 인 것은 사용량 자료가 없다는 뜻이다 — 지어내지 않는다.
 */

/** 검색용 표기 — ★**밑줄과 띄어쓰기를 같은 것으로 본다.**
 *
 *  ★★단부루 사전은 `high_complexity` 꼴이고 V5 새 태그는 `high complexity` 꼴이다.
 *    예전에는 화면이 질의의 띄어쓰기를 밑줄로 바꿔 던졌는데(`word.replace(/ /g,"_")`),
 *    그러면 **띄어쓰기 표기의 태그는 영영 안 걸린다.** 한쪽으로 맞추는 자리를 여기 하나로 둔다. */
const norm = (s: string) => s.toLowerCase().replace(/_/g, " ");

let ALL: TagEntry[] = [];
let INDEX: Record<string, TagEntry[]> = {};
let loaded = false;
let loading: Promise<void> | null = null;

export const tagsLoaded = () => loaded;

let TYPE: Map<string, string> | null = null;
/** 사전이 아는 태그의 종류 (`artist`·`character`…). 모르면 undefined.
 *  ★태그 검색 서랍의 「작가만」 거르기용 (`lib/tagSearch`) — 접두 없이 적은 작가 이름을 알아본다 */
export function tagType(tag: string): string | undefined {
  if (!loaded) return undefined;
  if (!TYPE) {
    TYPE = new Map();
    for (const e of ALL) TYPE.set(norm(e.value), e.type);
  }
  return TYPE.get(norm(tag));
}

/** 한 번만 읽는다. 파일이 없어도 위 넷은 언제나 제안된다. */
export function loadTags(): Promise<void> {
  if (loaded) return Promise.resolve();
  if (loading) return loading;
  loading = (async () => {
    const grab = async (url: string): Promise<TagEntry[]> => {
      try {
        const res = await fetch(url);
        return res.ok ? ((await res.json()) as TagEntry[]) : [];
      } catch {
        return []; /* 사전이 없어도 앱은 돈다 — 자동완성만 빠진다 */
      }
    };
    // ★★두 파일이 **정본**이다. 백엔드의 `search_tags` 도 같은 둘을 읽는다 (위 ★★주)
    const [tags, EXTRA] = await Promise.all([grab("/tags.json"), grab("/tags-extra.json")]);
    const index: Record<string, TagEntry[]> = {};
    const seen = new Set<string>();
    for (const t of tags) {
      t._lower = norm(t.label);
      seen.add(t._lower);
      (index[t._lower[0]] ||= []).push(t);
    }
    // ★중복 검사도 **같은 표기**로 — `seen` 은 정규화된 것이라 여기만 날것이면 걸리지 않는다
    const extra = EXTRA.filter((t) => !seen.has(norm(t.label)));
    for (const t of extra) {
      t._lower = norm(t.label);
      (index[t._lower[0]] ||= []).unshift(t); // 앞에 넣어 먼저 보이게
    }
    ALL = [...extra, ...tags];
    INDEX = index;
    loaded = true;
  })().catch(() => {});
  return loading;
}

/** 두 단계 검색: 첫 글자 인덱스(앞부터 일치) → 모자라면 전체(포함).
 *  `pred` 를 주면 그것을 통과한 항목만 센다 (종류로 거를 때). */
function scan(q: string, max: number, out: TagEntry[], pred?: (t: TagEntry) => boolean) {
  for (const t of INDEX[q[0]] ?? []) {
    if (out.length >= max) return;
    if (t._lower!.startsWith(q) && (!pred || pred(t)) && !out.includes(t)) out.push(t);
  }
  for (const t of ALL) {
    if (out.length >= max) return;
    if (t._lower!.includes(q) && (!pred || pred(t)) && !out.includes(t)) out.push(t);
  }
}

/** ★★NAI 가 **종류를 접두어로** 가르는 표기 — `artist:이름` (사용자 지적 2026-08-28:
 *  *"`artist:` 이렇게 치고 나서 뒤에 작가명 치는데, 자동완성이 안 되어서 불편함"*).
 *  사전의 작가 이름에는 그 접두어가 없다 (`dairi`, `ruu_(tksymkw)` …). 홑콜론이 낱말 글자라
 *  `artist:dai` 가 통째로 질의가 되고, 그 글자열을 가진 항목은 하나도 없어 목록이 비었다.
 *  ★네 종류가 사전의 `type` 과 이름이 같다 — 그래서 표를 따로 두지 않는다. */
const TYPE_PREFIX = /^(artist|character|copyright|meta):(.*)$/i;

/** 종류 접두어를 붙인 사본 — 사전 항목은 그대로 둔다 (읽기만 한다) */
const prefixed = (t: TagEntry, type: string): TagEntry => ({
  ...t,
  label: `${type}:${t.label}`,
  value: `${type}:${t.value}`,
});

export function searchTags(
  query: string,
  max = 15,
  opt?: { /** 작가 결과에 `artist:` 를 달까 (`useUi.artistPrefix`) — 기본 켬 */ artistPrefix?: boolean },
): TagEntry[] {
  if (!query || query.length < 2) return [];
  const out: TagEntry[] = [];
  // ① 글자 그대로 — `meta:novel era` 처럼 콜론이 이름의 일부인 태그가 먼저다
  scan(norm(query), max, out);
  /* ★★**작가는 언제나 `artist:` 를 달고 나간다** (사용자 지시 2026-08-28: *"아티스트 이름으로
       분류된 태그 입력하면 자동으로 앞에 artist: 붙여 주면 좋겠음"*). 접두어를 안 치고 `dai` 로
       찾아 골라도 `artist:dairi` 가 들어간다 — 목록에 보이는 글자가 곧 들어갈 글자다.
     ★사전 항목 자체는 안 건드린다 — 사본을 낸다.
     ★설정으로 끌 수 있다 (`useUi.artistPrefix`) — 접두어 없이 쓰는 사람도 있다. */
  if (opt?.artistPrefix !== false)
    for (let i = 0; i < out.length; i++)
      if (out[i].type === "artist" && !out[i].value.startsWith("artist:")) out[i] = prefixed(out[i], "artist");
  // ② 접두어 뒤의 이름으로 **그 종류만** 뒤진다. 넣을 값에는 접두어를 도로 붙인다 —
  //    고르는 순간 `artist:` 가 사라지면 사용자가 친 뜻이 바뀐다
  const m = TYPE_PREFIX.exec(query);
  if (m && m[2].length >= 2 && out.length < max) {
    const type = m[1].toLowerCase();
    const found: TagEntry[] = [];
    scan(norm(m[2]), max - out.length, found, (t) => t.type === type);
    for (const t of found) {
      const p = prefixed(t, type);
      if (out.some((x) => x.value === p.value)) continue;
      out.push(p);
    }
  }
  return out;
}

export function formatCount(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "K";
  return String(n);
}

/** 넣을 때 언더바를 띄어쓰기로 — NAI 프롬프트는 띄어쓰기를 쓴다.
 *  ★`^_^` `>_<` 같은 얼굴 태그의 언더바는 남긴다. */
export const underscoresToSpaces = (tag: string) =>
  tag.replace(/_/g, (_m, i: number, s: string) => {
    const before = s[i - 1];
    const after = s[i + 1];
    if (before === "^" || after === "^" || (before && after && /[><;:=]/.test(before + after)))
      return "_";
    return " ";
  });

/** 커서가 놓인 '지금 낱말'. 쉼표·줄바꿈·괄호·콜론이 경계다.
 *  검색에는 커서 **앞부분만** 쓰고, 갈아 끼울 범위는 낱말 뒤 공백까지 먹는다. */
export function currentWord(value: string, cursor: number) {
  // 어퍼스트로피도 태그 글자다 (`another's` 처럼 쓰는 태그가 있다)
  const isTagChar = (c: string) => /[\p{L}\p{N}_\-\s']/u.test(c);
  let start = cursor;
  while (start > 0) {
    const ch = value[start - 1];
    if (ch === ":") {
      // ★★홑콜론은 **태그 글자**다 (`meta:novel era` · `honkai:_star_rail`).
      //   예전에는 경계라서, 콜론을 친 뒤에 고르면 앞의 `meta:` 가 남아
      //   `meta:meta:novel era` 가 됐다 (사용자 지적 2026-08-21).
      // ★★단 `::` 는 **강조 문법**이라 경계다 — 안 그러면 `1.5::fee` 가 통째로
      //   한 낱말이 되어, 고르는 순간 강조 문법이 지워진다.
      // ★★경계로 두는 것**만**으로 충분하다. 한때 강조 구간 안에서 자동완성을 통째로
      //   껐는데(`inEmphasis`), `-0.8::feet::` 처럼 강조 안에 태그를 쓰는 것이 흔해서
      //   되돌렸다 (사용자 지적 2026-08-21). 경계가 있으면 안쪽 낱말만 갈리므로
      //   `1.5::` 는 그대로 남는다.
      if (value[start - 2] === ":" || value[start] === ":") break;
      start--;
      continue;
    }
    if (",\n\r{}[]()".includes(ch) || !isTagChar(ch)) break;
    start--;
  }
  let end = cursor;
  while (end < value.length && (value[end] === " " || value[end] === "\t")) end++;
  const head = value.substring(start, cursor);
  const lead = head.length - head.trimStart().length;
  return { word: head.trim(), start: start + lead, end, fullStart: start };
}
