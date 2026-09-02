import { create } from "zustand";
import { api } from "../lib/backend";
import { currentAccountId, resolveAccount, useAccounts } from "./accounts";
import { useWs } from "./workspace";

/** NAI 구독 상태 — **계정마다** 하나, 한 곳에서만 읽는다.
 *
 *  ★예전에는 App 의 지역 상태였고 생성 푸터에만 내려갔다. 값이 필요한 자리가 늘면서
 *    (업스케일 값 표시) 넘겨줄 길이 없어졌다 — 같은 정보를 두 곳에 두지 않으려고 스토어로 뺀다.
 *  ★★계정이 여럿이라 **계정 id 로 든다** (사용자 결정 2026-09-02). 화면이 보는 것은 언제나
 *    **지금 워크스페이스의 계정** 것이다 (`useCurrentSub`·`current()`). 다른 계정의 잔액을
 *    같이 띄우지 않는다 — 워크스페이스를 옮기면 그쪽 계정으로 바뀐다.
 *  ★티어 3(Opus)이면 무료 구간이 생긴다. 그 판정을 화면마다 다시 쓰지 않게 `opus()` 를 둔다. */

/** Opus 무료 생성 잔량 (공홈 `subscription.usage`). ★V5 부터 무료가 유한하다 */
export type OpusUsage = {
  /** 남은 비율 0~100 */
  percent: number;
  /** 1% 회복까지 남은 **초** */
  timeUntilNextPercent: number;
  /** 다 쓰고 더 쓴 상태 — ★이러면 무료가 **꺼진다** */
  isNegative: boolean;
};

export type Sub = { tier: number; anlas: number; usage?: OpusUsage | null };

type S = {
  /** 계정 id → 구독. 모르면(토큰 없음·통신 실패) 자리가 없다 */
  subs: Record<string, Sub>;
  set: (id: string, s: Sub | null) => void;
  /** ★**받아 온 값을 그대로 돌려준다.** 스토어를 다시 읽으면, 같은 순간에 도는 다른
   *  `load()` 가 나중에 덮어써서 **내가 물어본 답이 아닌 것**을 읽게 된다
   *  (`queue.ts` 는 `job_done` 마다 부른다). 실제 청구를 재는 쪽이 이 값을 쓴다.
   *  ★`id` 를 안 주면 지금 워크스페이스의 계정이다. */
  load: (id?: string) => Promise<Sub | null>;
  /** 등록된 계정 전부 — 부팅 때, 계정 목록이 바뀐 뒤 */
  loadAll: () => Promise<void>;
  /** 지금 워크스페이스의 계정 것 (화면 밖에서 부르는 함수 — 훅은 `useCurrentSub`) */
  current: () => Sub | null;
  /** 티어 3 이상 + 구독중 — 공홈의 무료 판정 조건. `id` 를 안 주면 지금 계정 */
  opus: (id?: string) => boolean;
};

export const useSub = create<S>((set, get) => ({
  subs: {},
  set: (id, s) => {
    const subs = { ...get().subs };
    if (s) subs[id] = s;
    else delete subs[id];
    set({ subs });
  },
  async load(id) {
    const acc = id || currentAccountId();
    if (!acc) return null;
    try {
      const s = await api<Sub>(`/api/subscription?account=${encodeURIComponent(acc)}`);
      get().set(acc, s);
      return s;
    } catch {
      // 토큰이 없거나 통신이 안 되면 그냥 모르는 상태로 둔다 (앱은 계속 돈다)
      return null;
    }
  },
  async loadAll() {
    const items = useAccounts.getState().items;
    // ★지워진 계정의 값은 버린다 — 남겨 두면 그 계정을 고르던 워크스페이스가 옛 잔액을 본다
    const keep: Record<string, Sub> = {};
    for (const a of items) if (get().subs[a.id]) keep[a.id] = get().subs[a.id];
    set({ subs: keep });
    await Promise.all(items.map((a) => get().load(a.id)));
  },
  current: () => get().subs[currentAccountId()] ?? null,
  opus: (id) => (get().subs[id || currentAccountId()]?.tier ?? 0) >= 3,
}));

/** 지금 워크스페이스의 계정의 구독 (훅). ★워크스페이스·계정 목록·구독 어느 것이 바뀌어도 따라온다. */
export function useCurrentSub(): Sub | null {
  const picked = useWs((s) => s.spec?.account);
  const items = useAccounts((s) => s.items);
  const id = resolveAccount(picked, items);
  return useSub((s) => s.subs[id] ?? null);
}
