/** 워크스페이스가 가리킨 NAI 계정 → **실제로 쓸** 계정 id (순수 함수, `store/accounts` 가 쓴다).
 *
 *  ★없거나 지워졌으면 **첫 계정**, 계정이 하나도 없으면 "". 백엔드 `accounts.resolve` 와 같은 규칙이다 —
 *    두 쪽이 다르면 화면이 보여 주는 잔액과 실제로 쓰는 토큰이 갈린다. */
export function resolveAccount(id: string | null | undefined, items: { id: string }[]): string {
  if (id && items.some((a) => a.id === id)) return id;
  return items[0]?.id ?? "";
}
