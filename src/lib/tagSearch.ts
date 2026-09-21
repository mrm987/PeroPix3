import { parseSegs } from "./blocks.ts";
import { tagType } from "./tagData.ts";

/** 태그 집계 — 색인(`backend/tagindex.py` 의 곁파일)에서 태그를 세는 **순수 함수들**.
 *  지금 쓰는 자리는 **갤러리의 작가 거르기** 하나다 (`store/gallery.ts`·`panels/GalleryFolders.tsx`).
 *  ★생성 화면 옆에 있던 태그 검색 서랍은 미완성인 채 잠겨 있다가 걷혔다 (사용자 지시 2026-09-21).
 *   그때 쓰던 「베이스에 붙이기」(`appendToLast`·`hasTag`)도 함께 걷었다.
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
