import { create } from "zustand";
import { useSub } from "./sub";
import { currentAccountId } from "./accounts";
import { toast } from "./toast";
import { t } from "../i18n";
import { judge, type MeterCond } from "../lib/anlasMeter";

/** 실제로 청구된 Anlas. **잔액 차이로 잰다** (사용자 지시 2026-08-18: "실제 청구 알수있는 방향으로").
 *
 *  까닭과 판정 규칙은 `lib/anlasMeter.ts` 머리에 있다. 여기는 **언제 재고 무엇을 들고
 *  있는가**만 맡는다: 큐에 넣기 직전에 기준선을 적고(`arm`), 배치가 온전히 끝나면
 *  잔액을 다시 물어 뺀다(`settle`).
 *
 *  ★★**계정마다 따로 잰다** (사용자 결정 2026-09-02, 다중 계정). 잔액이 계정 것이니 기준선도
 *    계정 것이다 — 한 계정이 재는 중이라고 다른 계정의 배치를 못 재면 안 된다. `arm` 은 지금
 *    워크스페이스의 계정에 걸고, `settle` 은 끝난 **차선의 계정**으로 부른다 (`store/queue`).
 *  ★★**어긋남은 「보여 줄 값」이 아니라 결함이다** (사용자 정정 2026-08-18:
 *    *"항상 예상 anlas가 정확해야함"*). 그래서 화면에 「예상 N, 실제 M」 을 나란히 띄우지
 *    않는다 — 그렇게 두면 틀린 계산이 **정상 상태처럼** 보인다. 맞을 때는 아무 일도 없고,
 *    틀렸을 때만 **경고 한 번 + 콘솔에 조건 전부**를 남겨 우리가 식을 고치게 한다.
 *  ★여기는 **재기만 한다.** `lib/anlas.ts` 의 계산식은 자동으로 안 고친다 — 무엇이 틀렸는지
 *    사람이 보고 고쳐야 같은 실수가 다시 안 난다.
 *  ★★**잴 수 없으면 아무 말도 하지 않는다.** 틀린 숫자를 보여 주는 것이 안 보여 주는
 *    것보다 나쁘다.
 */

type Armed = { before: number; est: number; cond: MeterCond };

type S = {
  /** 계정 id → 재는 중인 배치. 끝나면 `settle()` 이 소비한다 */
  armed: Record<string, Armed>;
  /** 지금 워크스페이스의 계정에 기준선을 건다 */
  arm: (est: number, cond: MeterCond) => void;
  /** 잴 수 없게 됐다 (보내지 못함·취소·일부 실패). `account` 를 안 주면 지금 계정 */
  disarm: (account?: string) => void;
  /** 그 계정의 배치가 **성공으로** 끝났다. 잔액을 다시 물어 실제를 낸다 */
  settle: (account?: string) => Promise<void>;
};

/** ★NAI 잔액이 곧바로 안 바뀔 수 있어 **한 번만** 더 물어본다. 끝없이 재시도하지 않는다 */
const RECHECK_MS = 1500;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** 재는 중에 같은 계정이 또 걸리면 앞 배치의 소모가 뒤의 기준선에 섞인다. 그때는 아예 안 잰다 */
const measuring = new Set<string>();

export const useAnlasMeter = create<S>((set, get) => ({
  armed: {},

  arm(est, cond) {
    const acc = currentAccountId();
    // 잔액을 모르면(토큰 없음·통신 실패) 기준선이 없다. 재지 않는다
    const before = useSub.getState().subs[acc]?.anlas;
    const armed = { ...get().armed };
    if (!acc || measuring.has(acc) || typeof before !== "number") {
      delete armed[acc];
      set({ armed });
      return;
    }
    // ★기준선은 **화면에 보이던 잔액**이다. 여기서 새로 물으면 그 왕복이 생성 버튼을 늦추고,
    //   무엇보다 우리가 방금 보낸 생성 요청과 경쟁해 어느 쪽이 먼저 반영됐는지 알 수 없게 된다.
    //   앱은 배치가 끝날 때마다 잔액을 다시 물으므로(`queue.ts` 의 `job_done`) 이 값은 보통
    //   최신이다. 그 사이 밖에서 충전·소모가 있었다면 이번 회차만 어긋나게 나온다.
    armed[acc] = { before, est, cond };
    set({ armed });
  },

  disarm(account) {
    const acc = account || currentAccountId();
    if (!(acc in get().armed)) return;
    const armed = { ...get().armed };
    delete armed[acc];
    set({ armed });
  },

  async settle(account) {
    const acc = account || currentAccountId();
    const armed = get().armed[acc];
    if (!armed) return;
    get().disarm(acc);
    measuring.add(acc);
    try {
      let after = (await useSub.getState().load(acc))?.anlas ?? null;
      // 값이 그대로면 아직 반영 전일 수 있다. **딱 한 번** 더 본다
      if (after === armed.before) {
        await wait(RECHECK_MS);
        after = (await useSub.getState().load(acc))?.anlas ?? after;
      }
      const v = judge(armed.before, after, armed.est);
      if (!v.ok) return; // ★잴 수 없었다. 화면에도 콘솔에도 남기지 않는다
      if (v.match) return; // 맞았다 = 정상. 아무 일도 일어나지 않는다
      // ★★여기 왔다는 것은 **요금 계산이 틀렸다는 뜻**이다. 사용자는 화면의 숫자를 믿고
      //   눌렀으므로 알려 줘야 하고(실제로 돈이 다르게 나갔다), 우리는 고쳐야 한다.
      //   무엇이 걸려 있었는지를 함께 찍는다 — 그것이 어느 조건에서 틀리는지의 단서다.
      console.error("[anlas] 요금 계산이 실제 청구와 다릅니다", {
        account: acc, est: armed.est, actual: v.actual, before: armed.before, after, ...armed.cond,
      });
      toast(t("gen.costWrong", { e: armed.est, a: v.actual }), "warn");
    } finally {
      measuring.delete(acc);
    }
  },
}));
