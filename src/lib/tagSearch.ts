import { makeBlock, parseSegs, type Block } from "./blocks.ts";
import { tagType } from "./tagData.ts";

/** 태그 검색 — 인덱스(`backend/tagindex.py` 의 곁파일)에서 태그를 집계하는 **순수 함수들**
 *  (사용자 지시 2026-08-31). 스토어·화면은 `store/tagsearch.ts`·`blocks/TagDrawer.tsx`.
 *
 *  ★★쪼개는 규칙은 `parseSegs` **하나**다 — 곁파일에는 프롬프트 원문만 있고, 백엔드는 쪼개지
 *    않는다 (`tagindex.py` 머리 ★★주). 세기(`1.2::artist:foo::`)는 벗기고 이름만 센다.
 *  ★같은 태그의 표기 차이(대소문자·밑줄/띄어쓰기)는 하나로 모은다 — 사전(`tagData`)과 같은
 *    규칙이다. 보여 주고 넣는 표기는 **처음 만난 원문**이다 (지어내지 않는다). */
export type IndexEntry = { m: number; s: number; p: string[] };
export type TagHit = { t: string; files: string[] };

const norm = (s: string) => s.toLowerCase().replace(/_/g, " ").trim();

/** 태그 → 그 태그가 쓰인 파일들(**최신순**). 한 장에 같은 태그가 두 번 있어도 한 번만 센다. */
export function tallyTags(files: Record<string, IndexEntry>): Map<string, TagHit> {
  const map = new Map<string, TagHit>();
  const order = Object.keys(files).sort((a, b) => files[b].m - files[a].m);
  for (const rel of order) {
    const seen = new Set<string>();
    for (const p of files[rel].p) {
      for (const { t } of parseSegs(p)) {
        const key = norm(t);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        const hit = map.get(key);
        if (hit) hit.files.push(rel);
        else map.set(key, { t: t.trim(), files: [rel] });
      }
    }
  }
  return map;
}

/** 작가 태그인가 — `artist:` 접두가 있거나, 사전이 작가로 아는 이름이다 */
export const isArtist = (tag: string): boolean =>
  /^artist:/i.test(tag) || tagType(tag.replace(/^artist:\s*/i, "")) === "artist";

/** 검색어·「작가만」으로 거르고 **많이 쓴 순**으로 */
export function filterTags(map: Map<string, TagHit>, query: string, artistOnly: boolean): TagHit[] {
  const q = norm(query);
  const out: TagHit[] = [];
  for (const [key, hit] of map) {
    if (q && !key.includes(q)) continue;
    if (artistOnly && !isArtist(hit.t)) continue;
    out.push(hit);
  }
  return out.sort((a, b) => b.files.length - a.files.length || a.t.localeCompare(b.t));
}

/** 베이스에 이미 있는가 (표기 차이는 같은 것으로) */
export const hasTag = (blocks: Block[], tag: string): boolean =>
  blocks.some((b) => b.tags.some((x) => norm(x.t) === norm(tag)));

/** 베이스 **맨 아래** — 마지막 블록의 끝에 붙인다 (사용자 결정 2026-08-31). 블록이 없으면 하나 만든다. */
export function appendToLast(blocks: Block[], tag: string): Block[] {
  if (!blocks.length) return [makeBlock("", [tag])];
  return blocks.map((b, i) => (i === blocks.length - 1 ? { ...b, tags: [...b.tags, { t: tag, w: null }] } : b));
}
