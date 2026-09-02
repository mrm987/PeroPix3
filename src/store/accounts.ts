import { create } from "zustand";
import { api } from "../lib/backend";
import { resolveAccount } from "../lib/accountPick";
import { useHealth } from "./health";
import { useWs } from "./workspace";

/** NAI 계정 **여럿** (사용자 결정 2026-09-02) — 목록은 백엔드가 정본이다 (`backend/accounts.py`).
 *
 *  ★까닭은 **할당량**이다: Opus 무료 구간이 계정마다 따로라, 계정을 나눠 두면 한쪽이 바닥나도
 *    다른 쪽으로 계속 뽑는다. 계정 수만큼 **동시에** 뽑히도록 큐도 계정별 차선이다.
 *  ★**워크스페이스가 계정을 고른다** (`spec.account`). 잔액·요금·큐 표시는 전부 그 계정 것을 본다.
 *    가리키는 계정이 지워졌으면 **첫 계정**으로 떨어진다 (`resolveAccount`) — 백엔드도 같은 규칙이다.
 *  ★토큰 값은 어느 응답에도 안 실린다 — 여기는 `id`·이름뿐이다. 이름은 자동 번호(「API n」)로
 *    태어나고 사용자가 고친다. */
export type Account = { id: string; name: string; env?: boolean };

type S = {
  items: Account[];
  loaded: boolean;
  load: () => Promise<Account[]>;
  /** 계정 추가 — 서버가 토큰을 검사한다 (401 이면 거절, 그 밖의 실패는 경고만). */
  add: (token: string, name?: string) => Promise<{ id: string; name: string; warning?: string }>;
  rename: (id: string, name: string) => Promise<void>;
  /** 토큰 갈아 끼우기 — id 는 그대로라 워크스페이스의 선택이 안 끊긴다 */
  replaceToken: (id: string, token: string) => Promise<{ warning?: string }>;
  remove: (id: string) => Promise<void>;
};

// 해석 규칙은 순수 함수 하나다 (`lib/accountPick`) — 판정이 그것을 직접 부른다
export { resolveAccount };

/** 지금 워크스페이스의 계정 id (해석 뒤). ★화면 밖(액션·요청 조립)에서 부르는 함수다 — 훅은 `useCurrentAccount`. */
export function currentAccountId(): string {
  return resolveAccount(useWs.getState().spec?.account, useAccounts.getState().items);
}

/** 지금 워크스페이스의 계정 (훅). ★워크스페이스가 바뀌어도, 목록이 바뀌어도 따라온다. */
export function useCurrentAccount(): Account | null {
  const picked = useWs((s) => s.spec?.account);
  const items = useAccounts((s) => s.items);
  const id = resolveAccount(picked, items);
  return items.find((a) => a.id === id) ?? null;
}

/** 목록이 바뀐 뒤 — 토큰 유무를 맞추고, 새로 생긴 계정의 잔액을 묻는다 (순환 참조라 늦게 읽는다) */
async function afterChange(items: Account[]) {
  useHealth.getState().setHasToken(items.length > 0);
  const { useSub } = await import("./sub");
  void useSub.getState().loadAll();
}

export const useAccounts = create<S>((set, get) => ({
  items: [],
  loaded: false,

  async load() {
    try {
      const r = await api<{ items: Account[] }>("/api/accounts");
      set({ items: r.items ?? [], loaded: true });
      return get().items;
    } catch {
      set({ loaded: true });
      return get().items;
    }
  },

  async add(token, name = "") {
    const r = await api<{ id: string; name: string; warning?: string }>("/api/accounts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token, name }),
    });
    const items = await get().load();
    void afterChange(items);
    return r;
  },

  async rename(id, name) {
    if (!name.trim()) return;
    await api(`/api/accounts/${encodeURIComponent(id)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: name.trim() }),
    });
    await get().load();
  },

  async replaceToken(id, token) {
    const r = await api<{ warning?: string }>(`/api/accounts/${encodeURIComponent(id)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    });
    const items = await get().load();
    void afterChange(items);
    return r;
  },

  async remove(id) {
    await api(`/api/accounts/${encodeURIComponent(id)}`, { method: "DELETE" });
    const items = await get().load();
    void afterChange(items);
  },
}));
