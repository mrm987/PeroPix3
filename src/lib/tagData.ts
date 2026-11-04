/** Danbooru 태그 사전 — 페로픽스파이(`ui/src/tags/tagData.ts`)에서 이식.
 *
 *  `public/tags.json` 79,437개(2026-10-01 목록, `scripts/update-tags.py`)를 **한 번** 읽어 첫 글자 인덱스를 만들고,
 *  `startsWith` → 모자라면 `includes` 두 단계로 찾는다.
 *
 *  ★사전은 **읽기만 한다.** 코드가 고치지 않는다.
 *  ★한글 검색은 `public/tags-ko.json` 을 얹어서 한다 (사용자 결정 2026-11-04, `scripts/update-tags-ko.py`). */

export type TagEntry = {
  label: string;
  value: string;
  count: number;
  /** general | artist | character | copyright | meta */
  type: string;
  category: number;
  aliases?: string[];
  /** 목록에 보이는 한글 이름 (`tags-ko.json` 의 첫 칸) */
  ko?: string;
  /** 한글로 찾았을 때의 이름. 찾은 말이 앞에 온다 (`치파오, 차이나 드레스`) */
  koHit?: string;
  _lower?: string;
};

/** NAI 가 쓰는데 단부루 사전에는 없는 것들 — **파일 하나로 뺐다** (`public/tags-extra.json`).
 *
 *  ★★2026-08-24 까지는 이 자리에 목록을 **코드로 박아 두었다.** 그런데 조수의 `search_tags`
 *    (`backend/agent.py`)는 `tags.json` **파일만** 읽어서, 여기 얹은 V5 태그와 `nsfw`/`sfw` 를
 *    「없다」고 판단했다 — 같은 정보에 창구가 둘로 갈린 자리였다.
 *    이제 **프런트와 백엔드가 같은 두 파일**을 읽는다 (`tags.json` + `tags-extra.json`).
 *  ★`tags.json`(단부루 덤프)은 **손으로 고치지 않는다** (`scripts/update-tags.py` 만 쓴다). 우리가 더하는 것만 따로 둔다.
 *  ★`count` 가 0 인 것은 사용량 자료가 없다는 뜻이다 — 지어내지 않는다.
 */

/** 검색용 표기 — ★**밑줄과 띄어쓰기를 같은 것으로 본다.**
 *
 *  ★★단부루 사전은 `high_complexity` 꼴이고 V5 새 태그는 `high complexity` 꼴이다.
 *    예전에는 화면이 질의의 띄어쓰기를 밑줄로 바꿔 던졌는데(`word.replace(/ /g,"_")`),
 *    그러면 **띄어쓰기 표기의 태그는 영영 안 걸린다.** 한쪽으로 맞추는 자리를 여기 하나로 둔다. */
const norm = (s: string) => s.toLowerCase().replace(/_/g, " ");
/** 친 말의 표기. 사전의 이름은 괄호 앞이 언제나 띄어져 있어 붙여 친 것(`rem(re`)도 띄어서 찾는다 */
const queryNorm = (s: string) => norm(s).replace(/([\p{L}\p{N}])\(/gu, "$1 (");

let ALL: TagEntry[] = [];
let INDEX: Record<string, TagEntry[]> = {};
let loaded = false;
let loading: Promise<void> | null = null;
let KO_RAW: Record<string, string[]> = {};
/** 한글 검색판. ★처음 한글을 칠 때 한 번 만든다 (영어만 쓰면 안 만든다) */
let KO: { t: TagEntry; keys: { word: string; flat: string; parts: string[] }[] }[] | null = null;

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
    const [tags, EXTRA, ko] = await Promise.all([
      grab("/tags.json"),
      grab("/tags-extra.json"),
      // ★없어도 영어 검색은 돈다. 실패하면 `grab` 이 빈 배열을 주고, 배열에는 태그 이름의 키가 없다
      grab("/tags-ko.json") as unknown as Promise<Record<string, string[]>>,
    ]);
    KO_RAW = ko;
    const index: Record<string, TagEntry[]> = {};
    const seen = new Set<string>();
    for (const t of tags) {
      t._lower = norm(t.label);
      t.ko = ko[t.value]?.[0];
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

const HANGUL = /[가-힣ㄱ-ㅎㅏ-ㅣ]/;
const squeeze = (s: string) => s.replace(/ /g, "");

/** 검색할 만큼 쳤나. 영어는 두 글자부터, 한글은 완성된 한 글자부터 (`눈` · `귀` 도 태그가 된다).
 *  ★가중치(`1.5`)를 치는 중에는 찾지 않는다 */
export const queryReady = (q: string) => (q.length >= 2 && !/^-?\d*\.\d*$/.test(q)) || /^[가-힣]$/.test(q);

/** 한글 키워드 검색. ★낱말 시작만 본다 (중간까지 보면 `장발` 에 `심장발작` 이 걸린다).
 *  키워드 전체가 같은 것 → 앞부터 일치 → 낱말 시작 차례이고, 그 안에서는 사전 차례(게시물 수)다.
 *  ★띄어쓰기는 안 가린다 (`긴머리` 로 `긴 머리` 를 찾는다). */
function koScan(q: string, max: number, out: TagEntry[], pred?: (t: TagEntry) => boolean) {
  KO ??= ALL.flatMap((t) => {
    const raw = KO_RAW[t.value];
    if (!raw?.length) return [];
    const keys = [...raw[0].split(", "), ...raw.slice(1)].map((word) => {
      const n = norm(word);
      return { word, flat: squeeze(n), parts: n.split(" ") };
    });
    return [{ t, keys }];
  });
  const flat = squeeze(q);
  const hits: { t: TagEntry; rank: number; word: string }[] = [];
  for (const { t, keys } of KO) {
    if (pred && !pred(t)) continue;
    let rank = 3;
    let word = "";
    for (const k of keys) {
      const r = k.flat === flat ? 0 : k.flat.startsWith(flat) ? 1 : k.parts.some((p) => p.startsWith(flat)) ? 2 : 3;
      if (r < rank) [rank, word] = [r, k.word];
    }
    if (rank < 3) hits.push({ t, rank, word });
  }
  hits.sort((a, b) => a.rank - b.rank);     // ★안정 정렬이라 같은 칸에서는 사전 차례가 남는다
  for (const { t, word } of hits.slice(0, max - out.length)) {
    const rest = (t.ko ?? "").split(", ").filter((w) => w !== word);
    out.push({ ...t, koHit: [word, ...rest].join(", ") });
  }
}

/** 두 단계 검색: 첫 글자 인덱스(앞부터 일치) → 모자라면 전체(포함).
 *  `pred` 를 주면 그것을 통과한 항목만 센다 (종류로 거를 때). */
function scan(q: string, max: number, out: TagEntry[], pred?: (t: TagEntry) => boolean) {
  if (HANGUL.test(q)) koScan(q, max, out, pred);
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
  if (!queryReady(query)) return [];
  const out: TagEntry[] = [];
  // ① 글자 그대로 — `meta:novel era` 처럼 콜론이 이름의 일부인 태그가 먼저다
  scan(queryNorm(query), max, out);
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
  if (m && queryReady(m[2]) && out.length < max) {
    const type = m[1].toLowerCase();
    const found: TagEntry[] = [];
    scan(queryNorm(m[2]), max - out.length, found, (t) => t.type === type);
    for (const t of found) {
      const p = prefixed(t, type);
      if (out.some((x) => x.value === p.value)) continue;
      out.push(p);
    }
  }
  return out;
}

/** 목록에서 강조할 자리 — 친 말과 같은 글자만 켠다. 검색과 같이 대소문자·밑줄·띄어쓰기를 안 가린다 */
export function markParts(text: string, query: string): { s: string; on: boolean }[] {
  const chars = [...squeeze(norm(query.replace(TYPE_PREFIX, "$2")))];
  if (!chars.length) return [{ s: text, on: false }];
  const re = new RegExp(chars.map((c) => c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("[ _]*"), "gi");
  const out: { s: string; on: boolean }[] = [];
  let at = 0;
  for (const m of text.matchAll(re)) {
    if (m.index > at) out.push({ s: text.slice(at, m.index), on: false });
    out.push({ s: m[0], on: true });
    at = m.index + m[0].length;
  }
  if (at < text.length) out.push({ s: text.slice(at), on: false });
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

/** 커서가 놓인 '지금 낱말'. 쉼표·줄바꿈·콜론 둘·이름 밖의 괄호가 경계다.
 *  검색에는 커서 **앞부분만** 쓰고, 갈아 끼울 범위는 낱말 뒤 공백까지 먹는다.
 *
 *  ★★이름 안의 괄호는 태그 글자다 (사용자 지적 2026-11-04: *"괄호를 넣으면 바로 중단되던데"*).
 *    사전의 2만여 개가 `캐릭터명_(작품명)` 꼴인데, 괄호가 늘 경계라서 `(` 를 치는 순간 낱말이 비어 목록이 닫혔다.
 *    경계로 남는 것은 앞에 글자가 없는 여는 괄호(`(long_hair`)와 짝이 없는 닫는 괄호다.
 *  ★★기호는 맞는 태그가 있을 때만 넘어간다 (사용자 결정 2026-11-04). `fate/gr` · `d.va` · `love_live!` 는 통째로 찾고,
 *    맞는 것이 없으면 기호 뒤부터 찾는다 (`source#sm` · `a girl. sm`). 그래서 사전이 낱말 자르기에 관여한다. */
export function currentWord(value: string, cursor: number) {
  // 어퍼스트로피도 태그 글자다 (`another's` 처럼 쓰는 태그가 있다)
  const isTagChar = (c: string) => /[\p{L}\p{N}_\-\s':]/u.test(c);
  let from = cursor;
  while (from > 0) {
    const ch = value[from - 1];
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
      if (value[from - 2] === ":" || value[from] === ":") break;
    } else if (",\n\r{}[]".includes(ch)) break;
    from--;
  }
  // 괄호의 짝은 앞에서부터 봐야 알 수 있다
  const nameStart = (at: number) => {
    let s = at;
    let depth = 0;
    for (let i = at; i < cursor; i++) {
      if (value[i] === "(") {
        if (value.substring(s, i).trim()) depth++;
        else s = i + 1;
      } else if (value[i] === ")") {
        if (depth) depth--;
        else s = i + 1;
      }
    }
    return s;
  };
  const starts = [nameStart(from)];
  for (let i = from; i < cursor; i++)
    if (!isTagChar(value[i]) && value[i] !== "(" && value[i] !== ")") starts.push(nameStart(i + 1));
  const start =
    starts.slice(0, -1).find((s) => searchTags(value.substring(s, cursor).trim(), 1).length) ??
    starts[starts.length - 1];
  let end = cursor;
  while (end < value.length && (value[end] === " " || value[end] === "\t")) end++;
  const head = value.substring(start, cursor);
  const lead = head.length - head.trimStart().length;
  return { word: head.trim(), start: start + lead, end, fullStart: start };
}
