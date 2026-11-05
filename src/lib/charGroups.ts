/** 캐릭터 프롬프트 그룹 (사용자 결정 2026-11-05). 카드 수십 개를 접어 두고 쓰기 위한 묶음이다.
 *
 *  ★★그룹은 자기 스위치를 들지 않는다. 그룹 온오프는 안의 카드 스위치를 한꺼번에 바꾸는 것이라
 *    (`store/gen` 의 `toggleGroupCapped`), 생성·순차 생성·장 수·비용은 전처럼 카드의 `on` 만 본다.
 *  ★★`chars` 는 언제나 **그룹 차례 → 그룹 밖 카드** 순서로 평평하게 놓인다. `chars` 의 차례가 곧
 *    `characterPrompts[]` 의 차례라, 화면에 보이는 차례와 나가는 차례가 어긋나면 안 된다. */

export type CharGroup = { id: string; name: string };

type Item = { id: string; group?: string };

/** 카드를 그룹 차례대로 다시 놓는다. 없는 그룹을 가리키는 카드는 그룹 밖으로 나온다 */
export function arrangeChars<T extends Item>(chars: T[], groups: CharGroup[]): T[] {
  const known = new Set(groups.map((g) => g.id));
  const clean = chars.map((c) => (c.group && !known.has(c.group) ? { ...c, group: undefined } : c));
  return [...groups.flatMap((g) => clean.filter((c) => c.group === g.id)), ...clean.filter((c) => !c.group)];
}

/** 카드를 옮길 곳. `near` 는 그 카드의 앞뒤(그 카드의 그룹으로 들어간다), `group` 은 그 그룹의 맨 뒤다 (`null` 이면 그룹 밖) */
export type CharPlace = { near: string; after: boolean } | { group: string | null };

/** 옮긴 목록. ★`arrangeChars` 를 거쳐야 최종 차례가 된다 */
export function placeChar<T extends Item>(chars: T[], id: string, to: CharPlace): T[] {
  const me = chars.find((c) => c.id === id);
  if (!me) return chars;
  const rest = chars.filter((c) => c !== me);
  if ("group" in to) return [...rest, { ...me, group: to.group ?? undefined }];
  const at = rest.findIndex((c) => c.id === to.near);
  if (at < 0) return chars;
  const out = rest.slice();
  out.splice(to.after ? at + 1 : at, 0, { ...me, group: rest[at].group });
  return out;
}
