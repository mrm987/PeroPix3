/** 씬 세트 카드 층으로의 이전 — **사용자 데이터를 건드리는 자리**라 따로 떼어 시험한다.
 *
 *  옛 세트 탭은 씬(`cells`)을 **직접** 들었다. 카드 층이 생기면서 그것을 **카드 한 장**으로
 *  감싼다 (사용자 결정 2026-08-11). 열면 지금까지와 똑같이 보인다.
 *
 *  ★공통 접두(`prefix`)도 여기서 카드로 옮겨 주고 있었는데, **그 기능 자체가 걷혔다**
 *    (사용자 지시 2026-08-21). 그래서 옛 탭의 그 값은 **버린다** — 같은 것을 붙이려면
 *    베이스 프롬프트의 블록을 쓴다 (창구가 하나가 된다).
 *
 *  ★**씬 번호(`cellSeq`)는 탭에 그대로 둔다.** 카드로 내리면 두 카드의 `c1` 이 같은 결과를
 *    물어 한 카드의 그림이 다른 카드에 나타난다 (결과는 `cell_id` 로만 묶인다 — `takesOf`).
 *  ★**이미 옮긴 탭은 손대지 않는다** — 두 번 감싸면 카드 안에 카드가 생긴다.
 */

/** 이전 대상이 되는 옛 탭의 모습 (필요한 필드만) */
type OldSetTab = {
  kind: string;
  name: string;
  cards?: unknown;
  cells?: unknown[];
  /** ★걷힌 기능. 타입에만 남겨 **버린다는 것을 드러낸다** (옛 파일에는 아직 들어 있다) */
  prefix?: string;
  [k: string]: unknown;
};

/** 감쌀 것이 있으면 새 탭을, 없으면 `null` (호출부가 `changed` 를 안 세워도 되게) */
export function wrapSetTabInCard(tab: OldSetTab): Record<string, unknown> | null {
  if (tab.kind !== "sceneGroup") return null;
  if (Array.isArray(tab.cards)) return null; // 이미 옮겼다
  // ★`prefix` 는 여기서 **떨어져 나간다** (기능이 걷혔다). 옛 파일을 열어도 카드에 안 붙는다
  const { cells, prefix: _dropped, ...rest } = tab;
  return {
    ...rest,
    cards: [
      {
        id: "k1",
        // 카드 이름은 탭 이름을 물려받는다 — 옛 탭은 곧 씬 세트 하나였다
        name: tab.name,
        cells: Array.isArray(cells) ? cells : [],
      },
    ],
    cardSeq: 1,
  };
}

// ── 카드 잠금 = 씬 잠금의 묶음 (사용자 지시 2026-10-28) ─────────────────────────────
//
// ★카드는 잠금을 **따로 들지 않는다.** 카드 버튼은 그 카드의 씬을 한꺼번에 잠그고 켜는 것이고,
//   카드가 잠겼다는 것은 **씬이 전부 잠겼다**는 뜻이다. 그래서 카드를 잠근 뒤 씬 하나를 켜면 카드 잠금이
//   저절로 풀린다 — 「전부 잠그고 몇 개만 켜기」가 이 버튼의 쓰임이다.
//   예전에는 카드가 `locked` 를 따로 들어 씬 버튼은 켜진 채로 보였고, 씬을 켜도 생성에서 빠졌다.

type LockCell = { locked?: boolean };
type LockCard<C extends LockCell> = { cells: C[]; locked?: boolean };

/** 카드가 잠겼나 — 씬이 하나라도 있고 **전부** 잠겼으면. 빈 카드는 잠긴 것이 아니다 */
export function cardLocked(card: { cells: LockCell[] }): boolean {
  return card.cells.length > 0 && card.cells.every((c) => c.locked);
}

/** 카드의 씬을 전부 잠그거나(`on`) 전부 켠다 */
export function lockCard<K extends LockCard<C>, C extends LockCell>(card: K, on: boolean): K {
  return { ...card, cells: card.cells.map((c) => ({ ...c, locked: on || undefined })) };
}

/** 옛 카드 잠금(`card.locked`)을 씬 잠금으로 옮긴다 — 읽을 때 한 번. 옮길 것이 없으면 같은 카드를 돌려준다.
 *  ★생성 결과가 같다: 옛 잠긴 카드는 씬이 무엇이든 전부 빠졌으므로, 씬을 전부 잠그면 똑같이 빠진다 */
export function liftCardLock<K extends LockCard<C>, C extends LockCell>(card: K): K {
  if (!("locked" in card)) return card;
  const { locked, ...rest } = card;
  return (locked ? lockCard(rest as K, true) : rest) as K;
}
