import { create } from "zustand";
import { api, backendUrl } from "../lib/backend";
import { cliEvent } from "./llm";
import { cliCursor, takeCliSeq } from "../lib/cliCursor";
import { playDoneSound } from "../lib/notifySound";
import { notifyByTitle } from "../lib/titleNotify";
import { useCards } from "./cards";
import { useFiles } from "./files";
import { useSub } from "./sub";
import { useAnlasMeter } from "./anlasMeter";
import { localTs } from "../lib/takes";
import type { Block } from "../lib/blocks";
import { err, nearBy } from "../lib/actions";
import { useSceneFocus } from "./sceneFocus";
import { usePreviews } from "./previews";
import { allCells, useWs } from "./workspace";
import { useUi } from "./ui";
import { toast } from "./toast";
import { t } from "../i18n";

/** 생성 큐 클라이언트 — v2 `index.html:15978-16369` 이식.
 *
 *  ★여기 든 방어는 전부 **실사용 사고를 겪고** 들어간 것이다 (docs/v2-port-plan.md):
 *
 *   1. **client_id 를 localStorage 에 보관**한다. 안 하면 재연결이 새 클라이언트가 되어
 *      서버가 "누가 어디까지 받았는지"를 모른다.
 *   2. **seq 리셋 감지** — 백엔드가 재시작하면 서버 seq 가 1부터 다시 시작한다. 우리가 본
 *      값보다 되돌아갔으면 렌더 집합을 비워야 한다. 안 그러면 새 이미지(seq 1..)가
 *      "이미 본 것"으로 오인되어 **전부 건너뛰어진다.**
 *   3. **중복 렌더 방지** — sync 복원과 라이브 브로드캐스트가 겹치면 같은 seq 가 두 번 온다.
 *      실제로 렌더한 집합으로 판정하므로, 브로드캐스트가 앞서도 복원분을 안 건너뛴다.
 */

/** 차선(계정) 하나의 진행률 — 서버 `Lane.progress()` 그대로 */
export type LaneProgress = {
  completed: number;
  total: number;
  queue_length: number;
  /** ★`workspace` 가 있다 — 복제한 워크스페이스는 씬 그룹 id 가 같아서, 그것만으로는 어느 쪽인지 모른다 */
  current_cell?: { workspace?: string; scene_group_id: string | null; cell_id: string | null } | null;
  /** 계정 이름 — 줄에 적는다 */
  name?: string;
};

export type QueueProgress = {
  completed: number;
  total: number;
  queue_length: number;
  /** ★★**계정별 차선** (사용자 결정 2026-09-02). 계정이 여럿이면 나란히 돈다 — 위 세 값은 그 합계다.
   *  줄은 차선마다 하나씩 그린다 (`GenerateFooter`·`App` 의 `QueueStatus`). 옛 백엔드는 안 준다. */
  lanes?: Record<string, LaneProgress>;
  /** ★★**서버가 지금 만들고 있는 씬** (2026-08-25). 화면의 「생성 중」 표시가 이것을 본다 —
   *  예전에는 화면이 **자기 대기 목록의 맨 앞**을 찍었는데, 배치가 겹치면 그 순서가 실제
   *  진행과 어긋나 **엉뚱한 칸에 「생성 중」이 뜨고 그림은 「대기 중」 칸에 나타났다**
   *  (사용자 실측). 무엇을 만드는지는 서버가 정본이다.
   *  ★옛 백엔드는 안 준다 — 없으면 화면이 옛 방식으로 물러선다. */
  current_cell?: { workspace?: string; scene_group_id: string | null; cell_id: string | null } | null;
};

/** 큐가 지금 어느 상태인가 — v2 `statusText` 이식 (`index.html:16119-16127, 16467-16493`).
 *
 *  ★v2 는 `준비 / 3-8 / 완료! / 실패 / 완료 (일부 실패)` 다섯을 한 줄에 썼다. 우리는
 *    「큐 줄은 돌고 있을 때만 뜬다」(CLAUDE.md, 사용자 지시 2026-08-04)라서 `idle` 은
 *    **줄이 없는 것**으로 나타낸다 — 「준비」라는 글자를 따로 두지 않는다.
 *  ★끝난 상태(`done`·`failed`·`partial`)는 2초 뒤 `idle` 로 돌아간다 (v2 `resetTimer`). */
export type QueuePhase = "idle" | "running" | "done" | "failed" | "partial";

/** ★큐에 넣은 **아직 안 나온 장**. 페로픽스파이는 큐에 넣는 순간 결과 객체를 만들어
 *  `queued` 카드를 띄운다 (`batch.ts start`) — 눌렀는지 알 수 있고 어디에 생길지도 보인다.
 *  우리 레코드는 **완료된 파일**뿐이라 이 목록이 그 자리를 대신한다.
 *  그림이 도착하면 같은 (scene_group_id, cell_id) 의 대기 하나를 지운다. */
export type Pending = {
  id: string;
  groupId: string | null;
  cellId: string | null;
  /** 어느 계정(차선)으로 넣었나 — 계정별 취소·마무리가 **자기 것만** 걷어내는 열쇠 */
  account: string;
  /** ★어느 워크스페이스에 넣었나 (사용자 실측 2026-09-02: 복제한 워크스페이스는 씬 그룹 id 가 같아서
   *  한쪽에서 생성하면 **모든** 워크스페이스에 「생성 중」 칸이 떴다). 화면은 제 워크스페이스 것만 그린다 */
  workspace: string;
};

type S = {
  connected: boolean;
  progress: QueueProgress;
  /** 상태 문구용 — 진행률만으로는 「실패」와 「완료」를 가를 수 없다 */
  phase: QueuePhase;
  pending: Pending[];
  /** ★★**그리는 중인 중간 그림** — 칸별 최신 한 장 (사용자 지시 2026-08-26).
   *
   *  ★열쇠는 **칸**(`cell_id`)이다: 어느 대기 칸 위에 그릴지가 그것으로 정해진다.
   *  ★한 장만 든다 — 프레임은 계속 오고, 지난 것은 볼 일이 없다 (몇백 KB 짜리 base64 라
   *    쌓아 두면 메모리가 는다).
   *  ★그림이 나오면 **지운다** (`consumePending`) — 끝난 칸에 중간 그림이 남으면
   *    완성본 위에 흐린 미리보기가 겹친다. */
  steps: Record<string, string>;
  /** 이미 화면에 반영한 seq — 중복 렌더 방지의 근거 */
  seen: Set<number>;
  lastSeq: number;
  error: string;

  connect: () => Promise<void>;
  enqueue: (base: Record<string, unknown>, items?: Record<string, unknown>[], count?: number) => Promise<void>;
  /** 이 탭의 대기 목록 (슬롯 순서대로). 맨 앞이 **지금 만드는 중**이다 */
  pendingOf: (groupId: string) => Pending[];
  /** ★취소는 **하나**다 — 지금 나간 장만 남기고 나머지를 전부 뺀다 (사용자 결정 2026-08-18).
   *  `account` 를 주면 **그 계정의 차선만** (계정별 취소, 사용자 결정 2026-09-02) */
  cancelAll: (account?: string) => Promise<void>;
};

const KEY = "peropix.ws_client_id";
const EMPTY: QueueProgress = { completed: 0, total: 0, queue_length: 0 };

let sock: WebSocket | null = null;
let seqId = 1;
/** 직전에 돌고 있던 **차선(계정)들** — 멈추는 **그 순간**만 알린다.
 *  ★★차선마다 따로다 (사용자 실측 2026-09-02: 계정 셋을 돌리니 셋째의 완료 알림이 안 왔다). 표식이 하나면
 *    둘째 계정이 끝나며 내린 표식을, 이미 마지막 장이 나가 있던 셋째 계정은 다시 못 세워 알림이 막힌다.
 *  ★차선 정보가 없는 옛 백엔드는 `"*"` 하나로 예전처럼 돈다. */
const busyLanes = new Set<string>();
let retry = 0;
/** 이번 배치의 성공·실패 장 수 (v2 `batchImageCount`·`batchErrorCount`). 끝날 때 문구를 가른다.
 *  ★계정(차선)마다 따로 센다 — 한 계정의 실패가 다른 계정의 「완료」를 「일부 실패」로 만들면 안 된다 */
const batch: Record<string, { ok: number; err: number }> = {};
const bump = (account: string, key: "ok" | "err") => {
  const b = (batch[account] ??= { ok: 0, err: 0 });
  b[key]++;
};
/** 끝난 문구를 잠시 보여 준 뒤 `idle` 로 (v2 `resetTimer`, 2초) */
let phaseTimer: ReturnType<typeof setTimeout> | null = null;
/** 마지막 수신 시각 — 하트비트의 근거 (`performance.now()` 라 시계 변경과 무관하다) */
let lastActivity = 0;
let beat: ReturnType<typeof setInterval> | null = null;

/** ★활동 기반 WS 하트비트 — v2 `index.html:16217-16234` 이식.
 *
 *  25초 동안 아무것도 못 받으면 `ping` 을 던져 보고, 50초까지 감감무소식이면 죽은 연결로
 *  보고 닫는다 (`onclose` 가 재연결을 건다). **소켓이 조용히 죽으면 `onclose` 가 아예
 *  안 와서** 영영 다시 안 붙는다 — 그때는 생성이 끝나도 화면에 아무것도 안 뜬다.
 *  서버는 `ping` 을 받아 `pong` 을 돌려줄 준비가 이미 돼 있다 (`backend/server.py`).
 *
 *  ★프로브는 **`ping` 만** 보낸다. `sync` 를 주기로 보내면 이미 그린 그림이 다시 흘러와
 *    라이브 브로드캐스트와 겹칠 때 같은 카드가 두 번 그려진다. 누락분 복원은 재연결
 *    시점의 `sync` 하나에만 맡긴다. */
function startHeartbeat() {
  if (beat) return;
  beat = setInterval(() => {
    if (!sock || sock.readyState !== WebSocket.OPEN) return;
    const idle = performance.now() - lastActivity;
    if (idle < 25000) return; // 최근 수신 있음
    if (idle > 50000) {
      try {
        sock.close();
      } catch {
        /* 이미 닫힌 소켓 */
      }
      return;
    }
    try {
      sock.send(JSON.stringify({ type: "ping" }));
    } catch {
      /* 보내지 못하면 다음 회차에 50초를 넘겨 닫힌다 */
    }
  }, 20000);
}

/** 중간 그림(`steps`)의 열쇠 — **워크스페이스 + 칸**. 칸 id 는 워크스페이스를 건너 겹치므로 (`Pending.workspace`
 *  의 ★주) 칸만으로 들면 다른 워크스페이스의 지난 프레임이 이 칸 위에 뜬다 (사용자 실측 2026-09-02). */
export const stepKey = (workspace: string, cell: string) => `${workspace}::${cell}`;

/** 지금 붙는 중인가 — `connect()` 가 `await` 를 만나기 **전에** 세우는 표식.
 *  ★소켓이 생기기 전 구간을 이것이 지킨다 (`connect` 의 ★주) */
let connecting = false;

/** **지금 그리고 있는 대기 칸**의 번호 (없으면 `null`).
 *
 *  ★★규칙을 여기 하나에 둔다 (사용자 지적 2026-08-28: *"스트리밍 썸네일이 같은 씬에 걸려
 *    있는 모든 생성 대기 썸네일에 표시됨"*). 중간 그림(`steps`)은 **씬 단위로** 오므로,
 *    「그 씬의 어느 칸이 지금 그려지는가」를 아는 자리가 없으면 그 씬의 대기 칸 전부가
 *    같은 그림을 읽는다. 줄과 큰 그림이 **같은 답**을 봐야 한다.
 *  ★어느 씬인지는 **서버가 말한다**(`current_cell`). 옛 백엔드가 안 줄 때만 맨 앞으로 물러선다. */
export function runningPendingId(groupId: string | null | undefined): string | null {
  const { progress, pending } = useQueue.getState();
  if (!(progress.total > progress.completed)) return null;
  // ★★대기 칸도 **이 워크스페이스 것**만 (사용자 실측 2026-09-02: 씬 그룹·칸 id 가 워크스페이스마다 같아서,
  //   다른 워크스페이스의 대기 칸을 집어 돌려주면 이 화면의 어느 칸과도 안 맞아 「생성 중」이 안 떴다)
  const here = useWs.getState().current;
  const mine = pending.filter((p) => p.groupId === groupId && p.workspace === here);
  // ★★차선(계정)마다 「지금 만드는 씬」이 하나씩이다 (2026-09-02). **이 씬 그룹을 만드는 차선**을 찾는다 —
  //   다른 계정이 다른 워크스페이스를 만드는 중이라고 이 그룹의 맨 앞 칸에 「생성 중」을 찍으면 안 된다.
  //   차선 정보가 없는 옛 백엔드일 때만 맨 앞으로 물러선다.
  const lanes = progress.lanes ? Object.values(progress.lanes) : null;
  const cells = lanes ? lanes.map((l) => l.current_cell) : [progress.current_cell];
  // ★워크스페이스까지 맞아야 한다 — 복제한 워크스페이스는 씬 그룹 id 가 같다 (`Pending.workspace` 의 ★주)
  const cell = cells.find((c) => c && c.scene_group_id === groupId && (!c.workspace || c.workspace === here))?.cell_id ?? null;
  if (cell) return mine.find((p) => p.cellId === cell)?.id ?? null;
  return lanes ? null : (mine[0]?.id ?? null);
}

export const useQueue = create<S>((set, get) => ({
  connected: false,
  progress: EMPTY,
  phase: "idle",
  pending: [],
  steps: {},
  seen: new Set(),
  lastSeq: 0,
  error: "",

  async connect() {
    /* ★★**자리를 먼저 잡고 기다린다** (사용자 지적 2026-08-20: 워크스페이스를 만들다
       `Failed to fetch`). 예전에는 아래 `await` 를 건너 **소켓을 만든 뒤에야** `sock` 이
       채워졌다. 그 사이에 `connect()` 가 한 번 더 불리면(개발 모드의 StrictMode 이중 마운트가
       그렇다) **둘 다 문을 통과해 소켓이 두 개** 생긴다.
       서버는 같은 `clientId` 로 새로 붙으면 옛 소켓을 닫으므로(`server.py` 의 `/ws`),
       닫힌 쪽이 다시 붙고 → 그게 다른 쪽을 닫고 → …가 **끝없이 돈다.**
       실측(2026-08-20 로그): 90분 동안 재연결 **58,120번**, 오류 로그 7.5MB.
       그 소음 속에서 평범한 요청이 간헐적으로 거절돼 `Failed to fetch` 로 보였다. */
    if (connecting) return;
    if (sock && (sock.readyState === WebSocket.OPEN || sock.readyState === WebSocket.CONNECTING)) return;
    connecting = true;
    const base = await backendUrl().catch(() => {
      connecting = false;
      return "";
    });
    if (!base) return;
    const id = localStorage.getItem(KEY) || "";
    const url = base.replace(/^http/, "ws") + "/ws" + (id ? `?clientId=${encodeURIComponent(id)}` : "");

    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch {
      // ★표식을 반드시 내린다 — 여기서 새면 앱이 사는 동안 **다시는 안 붙는다**
      connecting = false;
      return;
    }
    sock = ws;
    connecting = false;

    ws.onopen = () => {
      retry = 0;
      // ★새 연결을 곧바로 「유휴」로 오판하지 않게 여기서 한 번 찍는다
      lastActivity = performance.now();
      startHeartbeat();
      set({ connected: true, error: "" });
      // 붙자마자 **놓친 것부터 달라고 한다** (새로고침·끊김 복원)
      ws.send(JSON.stringify({ type: "sync", last_seq: get().lastSeq, ...cliCursor() }));
    };
    ws.onclose = () => {
      // ★**지금 것이 아니면 아무것도 안 한다** — 옛 소켓이 닫힌 것으로 「끊겼다」를 켜거나
      //   재연결을 걸면, 살아 있는 연결을 두고 다시 붙는 고리가 생긴다 (위 ★주)
      if (sock !== ws) return;
      sock = null;
      set({ connected: false });
      // 지수 백오프 재연결 (최대 10초)
      retry = Math.min(retry + 1, 10);
      setTimeout(() => void get().connect(), Math.min(500 * retry, 10000));
    };
    ws.onmessage = (e) => {
      // 어떤 수신이든 **연결 생존 신호**로 본다 (진행률·브로드캐스트·pong 전부)
      lastActivity = performance.now();
      handle(JSON.parse(e.data), set, get);
    };
  },

  async enqueue(base, items = [], count = 1) {
    // ★보내기 **전에** 자리를 잡는다 — 누른 즉시 카드가 떠야 눌린 것을 안다
    const groupId = (base.scene_group_id as string) ?? null;
    const add: Pending[] = [];
    const units = items.length ? items : [{}];
    // ★대기 칸의 순서는 **서버가 만드는 순서와 같아야 한다** (`server.py` 의 큐 루프).
    //   서버가 한 바퀴씩 도는데 여기서 씬별로 몰아 넣으면, "지금 만드는 중"이 엉뚱한 줄에 뜬다.
    for (let i = 0; i < Math.max(1, count); i++) {
      for (const it of units) {
        // ★칸은 **항목에 없으면 base 에서** 가져온다. 강화처럼 항목이 파일만 들고 오는
        //   경우가 있는데, 그때 null 로 두면 대기 칸이 어느 씬에도 안 뜬다
        //   (사용자 지적 2026-08-14: 눌러도 아무 반응이 없어 보였다)
        add.push({
          id: `p${seqId++}`,
          groupId,
          cellId: ((it.cell_id as string) ?? (base.cell_id as string)) ?? null,
          // ★넣는 쪽이 해석한 계정이다 (`store/gen`·`store/genRemote`) — 서버의 차선과 같은 값
          account: String(base.account ?? ""),
          workspace: String(base.workspace ?? ""),
        });
      }
    }
    set({ pending: [...get().pending, ...add] });
    /* ★생성을 누르면 **방금 넣은 대기 칸(가장 최근 것)** 을 고른다 (사용자 지시 2026-09-03,
       `useUi.focusNewPending`, 기본 끔). 대기 칸은 줄의 앞쪽에 늦게 넣은 것부터 서므로
       `add` 의 마지막이 곧 맨 앞 칸이다. 그림이 나오면 `consumePending` 이 그 장으로 옮긴다.
       ★보고 있는 워크스페이스에 넣은 것일 때만 — 다른 워크스페이스로 보낸 생성(MCP·원격)에
         화면이 끌려가면 안 된다. 칸이 없는 항목(씬 없는 강화)은 고를 자리가 없으니 건너뛴다. */
    const last = add[add.length - 1];
    if (useUi.getState().focusNewPending && last?.cellId && last.workspace === useWs.getState().current) {
      useSceneFocus.getState().focusPending(last.cellId, last.id);
    }
    try {
      await api("/api/generate/queue", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        /* ★★**그리는 중인 그림을 흘려 줄까** (`useUi.streamPreview`, 사용자 지시 2026-08-26).
           서버는 이 값으로 스트리밍 주소를 쓸지 정한다 (`backend/nai.generate_streaming`).
           ★끄면 결과는 그대로고 중간 그림만 안 온다 — **보는 방식**이라 매 요청에 실어 보낸다
             (탭마다 갈릴 값이 아니라 지금 화면 설정이다). */
        body: JSON.stringify({ base: { ...base, stream: useUi.getState().streamPreview }, items, count }),
      });
    } catch (e) {
      // 보내지 못했으면 잡아 둔 자리를 도로 뺀다
      const ids = new Set(add.map((x) => x.id));
      set({ pending: get().pending.filter((x) => !ids.has(x.id)) });
      // ★재려고 적어 둔 기준선도 버린다. 안 버리면 **다음 배치**가 이 기준선으로 재진다
      useAnlasMeter.getState().disarm(String(base.account ?? "") || undefined);
      throw e;
    }
  },
  pendingOf: (groupId) => get().pending.filter((p) => p.groupId === groupId),

  /** ★★**대기 칸을 여기서 비우지 않는다** (감사 D5). 예전 `clear()` 는 부르자마자
   *  `pending` 을 통째로 비웠는데, 서버는 이미 나간 한 장을 끝까지 받아 낸다 —
   *  **카드는 사라지는데 그림은 계속 나오는** 상태가 됐다.
   *  실제로 멈춘 것이 몇 장인지는 서버만 알고, `queue_cancelled` 가 그것을 실어 온다. */
  async cancelAll(account) {
    await api(`/api/cancel-queue${account ? `?account=${encodeURIComponent(account)}` : ""}`, { method: "POST" });
  },
}));

/** 큐가 낸 실패를 **사람 말로** (v2 `formatGenerationError`, `index.html:16245`).
 *  ★그대로 던지면 `HTTP 402` 같은 것만 뜬다 — 무엇을 해야 하는지가 안 보인다. */
function queueErrorText(raw: string): string {
  if (/402/.test(raw)) return t("queue.err402");
  if (/401/.test(raw)) return t("queue.err401");
  if (/429/.test(raw)) return t("queue.err429");
  return t("queue.errOther", { m: raw.slice(0, 120) });
}

type Setter = (p: Partial<S> | ((s: S) => Partial<S>)) => void;

/** ★★조수가 고친 자리는 **사람의 `Ctrl+Z` 에서 뺀다** (사용자 결정 2026-08-24:
 *    *"LLM 이 수정한 걸 Ctrl+Z 로 되돌리면 혼란스러울 것 같다. Ctrl+Z 는 유저 본인이
 *    수정한 것만."*). 담아 둔 되돌리기는 통째 복원이라, 그대로 두면 한 번에 조수의 편집까지
 *    지운다. 조수가 한 일은 조수에게 말해서 되돌린다 (`undo_change`). */
async function dropHumanUndo(zone: string): Promise<void> {
  const { dropUndoZone } = await import("../lib/undo");
  dropUndoZone(zone);
}

/** **고친 것을 디스크에 밀어 넣고 답한다** (사용자 승인 2026-08-25).
 *
 *  ★★조수가 **읽는 자리와 쓰는 자리가 다르다**: `get_workspace` 는 디스크의
 *    `workspace.json` 을 읽는데(`backend/workspace.py`), 화면의 편집은 편집기에 들어가고
 *    디스크로는 **0.4초 디바운스** 뒤에 나간다 (`workspace.queueSave`).
 *    그래서 고친 **직후에 읽으면 옛 값**이 오고, 조수는 그것을 근거로 사용자에게 잘못 말한다
 *    (2026-08-25: 「추가된 상태입니다」라고 답했는데 화면은 그대로였다).
 *  ★그래서 **성공한 변경 뒤에는 저장이 끝나기를 기다린다.** 그 다음 읽기부터는 같은 것을 본다.
 *  ★실패·거절에는 안 부른다 — 바뀐 것이 없다.
 *  ★저장이 실패해도 답은 그대로 낸다 — 화면에는 이미 반영돼 있고, 저장은 다시 예약된다. */
async function flushSpec(out: Record<string, unknown>) {
  if (!out || out.error || out.ok !== true) return;
  try {
    await useWs.getState().save();
  } catch {
    /* 저장이 실패해도 화면은 그대로다 — 다음 저장이 다시 가져간다 */
  }
}

/** ★★**액션 레지스트리를 먼저 본다** (2026-08-24). 등록된 것이면 **승인 → 실행** 을 거친다.
 *
 *  ★여기가 「묻는 자리」다: 규칙(무엇이 사라지나·얼마가 드나)은 스토어와 `lib/costNow` 가
 *    갖고, 화면 버튼은 확인 창으로, 조수는 **승인 카드**로 묻는다 (`docs/…` 2-5).
 *  ★등록되지 않은 이름은 아래 옛 분기로 내려간다 — 프롬프트 편집처럼 아직 옮기지 않은 것들이다.
 */
async function runAction(action: string, args: Record<string, any>, ask = true): Promise<Record<string, unknown>> {
  const [{ getAction }, { askApprove, needsAsk }] = await Promise.all([
    import("../lib/actions"),
    import("../lib/approve"),
  ]);
  await import("../lib/appActions"); // ★등록이 일어나는 자리 — 부르기 전에 실려 있어야 한다
  const def = getAction(action);
  if (def) {
    try {
      const risk = typeof def.confirm === "function" ? await def.confirm(args) : (def.confirm ?? "ask");
      /* ★★**바깥 에이전트(MCP)는 안 묻는다** (사용자 결정 2026-08-31) — 그쪽 클라이언트가
         이미 묻고, 기록도 그쪽 앱에 남는다. 백엔드가 어느 열쇠로 들어왔는지 보고 `ask` 로
         알려 준다 (`backend/server.py` 의 `agent_call`). 앱 안 조수는 그대로 묻는다. */
      if (ask && needsAsk(risk)) {
        const body = def.preview ? await def.preview(args) : undefined;
        /* ★제목은 **사람이 읽는 한 줄**이다 — `desc` 는 LLM 용이라 길고 마크다운이 섞여 있어
           카드가 설명서처럼 보인다 (QA 실측 2026-08-25). */
        const okay = await askApprove({ title: def.title ?? def.id, body, hard: risk === "hard" });
        /* ★★**「대기 중」과 「거절」을 가른다** (QA 실측 2026-08-25). 앞선 승인이 아직 안 끝난
           것을 거절로 말하면 조수가 **사용자가 거절했다**고 전한다 — 사용자는 본 적도 없는데.
           ★`retry: "safe"` 다: 앞의 것이 끝나면 그대로 다시 하면 된다. */
        if (okay === "busy")
          return { error: { code: "blocked", retry: "safe",
                            message: "앞선 승인 요청이 아직 화면에 떠 있습니다. 그것을 먼저 처리해 주세요." } };
        // ★거절은 **오류가 아니다** — 조수가 다시 시도하지 않게 `never` 로 말한다
        if (!okay)
          return { error: { code: "refused", message: "사용자가 승인하지 않았습니다.", retry: "never" } };
      }
      const out = (await def.run(args)) as Record<string, unknown>;
      await flushSpec(out);
      return out;
    } catch (e) {
      return { error: { code: "blocked", message: String((e as Error).message ?? e), retry: "unsafe" } };
    }
  }
  return legacyAction(action, args);
}

/** 아직 레지스트리로 안 옮긴 행동들. ★`generate` 는 등록되어 있지만 **실행 본문은 여기**다 —
 *  프롬프트 조립·시드 규칙이 전부 이 파일에 있어서 옮기면 두 벌이 된다. */
export const runLegacyAction = (action: string, args: Record<string, any>) => legacyAction(action, args);

async function legacyAction(action: string, args: Record<string, any>): Promise<Record<string, unknown>> {
  /* ★★**백엔드 도구의 승인 요청** (사용자 지시 2026-08-25: *"백엔드든 뭐든 동일 규칙"*).
     카드 덮어쓰기·지침·파일 이동은 백엔드가 실행하지만 **묻는 자리는 여기**다 —
     자동 승인 설정도 승인 카드도 앱에 있기 때문이다. 백엔드는 위험도만 정해 넘긴다
     (`backend/agent.py` 의 `TOOL_RISK`·`approve`). */
  if (action === "ask_approve") {
    // ★바깥에서 온 것은 여기까지 오지 않는다 (백엔드가 `approve` 를 건너뛴다)
    const { askApprove, needsAsk } = await import("../lib/approve");
    const risk = (args.risk === "hard" ? "hard" : "ask") as "hard" | "ask";
    // ★자동 승인 설정을 **여기서도 그대로** 본다 — 기준이 두 벌이 되면 안 된다
    if (!needsAsk(risk)) return { okay: true };
    const okay = await askApprove({ title: String(args.title ?? ""), hard: risk === "hard" });
    if (okay === "busy") return { busy: true };
    return { okay: !!okay };
  }

  try {
    if (action === "generate") {
      const { useGen } = await import("./gen");
      const ws = useWs.getState();
      const count = Math.max(1, Math.min(50, Number(args.count) || 1));
      // ★다른 워크스페이스·다른 탭도 넣을 수 있다 (사용자 지시 2026-08-08).
      //   ★화면은 안 옮긴다 — 그쪽 spec 을 읽어 컴파일해서 큐에만 넣는다 (genRemote.ts)
      const target = String(args.workspace ?? "").trim();
      /* ★★도구가 받는 이름은 **`set`** 이다 (`backend/agent.py` 의 generate 스키마).
         여기서 `args.tab` 만 읽고 있어서, 조수가 스키마대로 `set` 을 보내면 **조용히 버려지고**
         활성 세트에 생성됐다 — 오류도 안 나고 Anlas 는 엉뚱한 곳에 나간다 (적대 검토 2026-08-24).
         ★옛 이름 `tab` 도 받아 준다: 입력은 너그럽게, 내보내는 이름은 하나로 (`docs/terms.md`). */
      const wantSet = String(args.set ?? args.tab ?? "").trim();
      if ((target && target !== ws.current) || wantSet) {
        const { queueToWorkspace } = await import("./genRemote");
        return (await queueToWorkspace(target || ws.current, count, wantSet || undefined)) as Record<
          string,
          unknown
        >;
      }
      const tab = ws.activeSceneGroup();
      if (!tab) return { error: "열려 있는 탭이 없습니다." };
      // ★★**`count` 는 「몇 바퀴」다** (싱글 폐기 2026-08-11 이후로는 그것 하나뿐이다).
      //   예전에는 싱글 탭이면 `queueSingle(count)` 로 **count 장**이었는데, 탭이 전부
      //   씬 탭이 되면서 그 갈래가 도달 불가가 됐다. 한 바퀴 = 잠기지 않은 씬 전부이고,
      //   씬 하나짜리 탭(새 워크스페이스의 기본)에서는 옛 싱글과 결과가 같다.
      //   ★한 바퀴가 만드는 장 수는 여기가 아니라 화면의 `슬롯당`(`useUi.perSlot`)이 정한다 —
      //     `generateAll` 이 그 값으로 `rounds` 를 편다. 그래서 아래 `queued` 도 그것을 곱한다.
      if (tab.kind !== "sceneGroup")
        return { error: `'${tab.name}' 탭은 씬 탭이 아니라 생성에 쓸 수 없습니다.` };
      for (let i = 0; i < count; i++) await useGen.getState().generateAll();
      const live = allCells(tab).filter((c) => !c.locked).length;
      /* ★돌려주는 열쇠는 `set` 이다 — 그림이 쌓이는 자리는 **세트**다.
         (도구 인자의 `tab` 은 **탭 이름**이라 다른 것이다 — `shared/terms.json`) */
      return { ok: true, sceneGroup: tab.name, queued: live * count * useUi.getState().perSlot };
    }
    // ★물음은 **답이 올 때까지** 안 끝난다 — 도구가 기다리고 있다
    if (action === "ask_user") {
      const { useLlm } = await import("./llm");
      const options = (args.options ?? []).map((o: Record<string, string>) => ({
        label: String(o.label ?? ""),
        description: o.description ? String(o.description) : undefined,
      }));
      if (!options.length) return { error: "선택지가 없습니다." };
      const multi = !!args.multi;
      return await new Promise((resolve) => {
        useLlm.setState({
          ask: {
            question: String(args.question ?? ""),
            header: args.header ? String(args.header) : undefined,
            options,
            multi,
            answer: (labels: string[]) => {
              useLlm.setState({ ask: null });
              // ★모양을 갈라 준다 — 하나 고른 것과 여럿 고른 것은 다른 답이다
              resolve(multi ? { answers: labels } : { answer: labels[0] ?? "" });
            },
          },
        });
      });
    }

    /* ★★**보고 있는 것을 고친다** — 덱의 카드가 아니라 지금 화면의 프롬프트다.
         사용자 지시 2026-08-24: *"「키키 의상을 바꿔 줘」는 보통 카드가 아니라 지금 씬에
         올려둔 캐릭터를 바꿔 달라는 것이다. 저장은 본인이 따로 한다."*
       ★고친 자리(`at`)와 **고치기 전 값**(`before`)을 함께 돌려준다 — 채팅 줄이 그 자리를
         열고(`lib/agentAt`), 조수가 되돌릴 수 있다(`backend/agentlog.py`). */
    if (action === "edit_current_prompt") {
      const { usePrompt } = await import("./prompt");
      const { makeBlock, parseSegs } = await import("../lib/blocks");
      /* ★★**고칠 자리는 주소로 받는다** (사용자 지적 2026-08-25: *"애초에 풀 경로를 주고
           그걸 고치게 해야 되는 거 아니야? 세트 이름으로만 찾는 게 문제인 것 같은데"*).
         주소는 셋이다: **워크스페이스 → 탭 → 세트.** 조수는 이 셋을 이미 다 받고 있다
         (`get_workspace` 가 세트마다 `id`·`tab` 을, 그 위에 `tabs`·`activeTab` 을 준다).
         ★예전에는 `set` 하나를 **이름으로** 훑어 처음 걸리는 것을 집었다. 「새 세트」 같은
           기본 이름은 탭마다 있으므로 **엉뚱한 탭을 고치고 성공이라 답했다.**
         ★비우면 지금 보고 있는 자리다 — 「지금 이거 고쳐 줘」가 대부분이라 그 길은 남긴다.
         ★대상 세트를 **먼저 연다** — 편집기는 열린 세트의 사본이라 몰래 고칠 길이 없고,
           여는 편이 옳기도 하다 (사용자가 바뀐 자리를 그 자리에서 본다). */
      const wantWs = String(args.workspace ?? "").trim();
      if (wantWs && wantWs !== useWs.getState().current)
        /* ★★**다른 워크스페이스는 고치지 않는다.** 말없이 지금 것을 고치면 조수가 읽은
             자리와 어긋난다. 옮기는 것은 사용자의 일이다 (작업이 통째로 바뀐다). */
        return err(
          "blocked",
          `지금 열린 워크스페이스는 「${useWs.getState().current}」 입니다. ` +
            `「${wantWs}」 를 고치려면 사용자가 그 워크스페이스를 열어야 합니다.`,
          { retry: "never" },
        );

      const wantTab = String(args.tab ?? "").trim();
      const want = String(args.set ?? "").trim();
      if (wantTab || want) {
        const spec0 = useWs.getState().spec;
        const tabs = spec0?.tabs ?? [];
        const all = spec0?.sceneGroups ?? [];
        /* ★탭도 **id 가 먼저**다 — 이름은 사용자가 계속 고치는 값이라 열쇠로 못 쓴다 */
        let tabId = "";
        if (wantTab) {
          const t = tabs.find((c) => c.id === wantTab) ?? tabs.find((c) => c.name === wantTab);
          if (!t)
            return err("not_found", `그런 탭이 없습니다: ${wantTab}`, {
              candidates: nearBy(wantTab, tabs.map((c) => c.name)),
            });
          tabId = t.id;
        }
        const inTab = (x: { tabId?: string }) => !tabId || x.tabId === tabId;
        const byId = all.find((x) => x.id === want);
        const named = all.filter((x) => x.name === want && inTab(x as { tabId?: string }));
        /* ★탭만 주고 세트를 안 주면 **그 탭의 세트**로 본다 (하나뿐일 때만 — 여럿이면 되묻는다) */
        const ofTab = all.filter((x) => x.kind === "sceneGroup" && inTab(x as { tabId?: string }));
        const hit =
          byId ?? (named.length === 1 ? named[0] : !want && ofTab.length === 1 ? ofTab[0] : null);
        if (!hit && (named.length > 1 || (!want && ofTab.length > 1))) {
          /* ★★**고르지 않고 되묻는다.** 어느 것인지는 사용자와 조수만 안다 — 코드가 하나를
               집으면 틀렸을 때 **조용히** 틀린다 (그것이 이번 일이었다). */
          const pool = named.length > 1 ? named : ofTab;
          const where = pool.map(
            (x) =>
              `${tabs.find((c) => c.id === (x as { tabId?: string }).tabId)?.name ?? "?"}/${x.name}#${x.id}`,
          );
          return err("ambiguous", `어느 세트인지 하나로 좁혀지지 않습니다. 세트 id 로 골라 주세요.`, {
            candidates: where,
          });
        }
        if (!hit)
          return err("not_found", `그런 세트가 없습니다: ${want || wantTab}`, {
            candidates: nearBy(want, ofTab.map((x) => x.name)),
          });
        /* ★세트는 **탭에 속한다**(`tabId`). 다른 탭의 세트를 열면서 탭을 안 옮기면
           화면의 윗줄과 아랫줄이 어긋난 채로 남는다 (`workspace.switchTab` 참조). */
        const owner = (hit as { tabId?: string }).tabId;
        if (owner && owner !== useWs.getState().spec?.activeTab) useWs.getState().switchTab(owner);
        useWs.getState().setActiveSceneGroup(hit.id);
      }
      const ws = useWs.getState();
      const spec = ws.spec;
      const set = spec?.sceneGroups.find((x) => x.id === spec?.activeSceneGroup);
      if (!set) return { error: "열려 있는 세트가 없습니다." };

      /* ★★**어느 탭인지 함께 말한다** (사용자 지적 2026-08-25: *"메인 프롬프트를 변경했다고
           했는데 실제론 변경되지 않음"*). 세트 이름만 적으면 **다른 탭의 같은 이름**을 고쳐도
           같은 문장이 나와, 사용자는 어긋난 것을 알아챌 수가 없다. 탭 이름을 앞에 붙이면
           보고 있는 탭과 다른 순간 바로 보인다. */
      const tabName =
        (spec?.tabs ?? []).find((c) => c.id === ((set as { tabId?: string }).tabId ?? spec?.activeTab))
          ?.name ?? "";
      const where = tabName ? `「${tabName}」 탭의 「${set.name}」 세트` : `「${set.name}」 세트`;

      const area = String(args.area ?? "base");
      const label = String(args.label ?? "블록");
      const tags = parseSegs(String(args.tags ?? ""));
      /* ★**씬 칸**은 프롬프트 편집기가 아니라 세트 안에 산다 (`sceneGroups[].cards[].cells`).
         칸 하나에 블록도 하나뿐이라 (`slotBlocksOf`), 이름표 없이 태그만 갈아 끼운다. */
      const wantScene = String(args.scene ?? "").trim();
      if (wantScene) {
        const { slotBlocksOf, makeBlock: mk } = await import("../lib/blocks");
        const cards = (set as { cards?: { id: string; cells: { id: string; name: string; blocks?: Block[] }[] }[] }).cards ?? [];
        let found: { id: string; name: string; blocks?: Block[] } | null = null;
        const next = cards.map((k) => ({
          ...k,
          cells: k.cells.map((c) => {
            if (c.id !== wantScene && c.name !== wantScene) return c;
            found = c;
            const cur = c.blocks?.[0] ?? mk("", [], { open: true, tags: [] });
            return { ...c, blocks: slotBlocksOf({ ...cur, tags }) };
          }),
        }));
        if (!found) return { error: `그런 씬이 없습니다: ${wantScene}` };
        useWs.getState().patchSceneGroup(set.id, { cards: next } as never);
        dropHumanUndo(`scene-${(found as { id: string }).id}`);
        const did = `${where}의 씬 「${(found as { name: string }).name}」을 고침`;
        return {
          ok: true, scene: (found as { name: string }).name, did,
          at: { kind: "prompt" as const, workspace: ws.current ?? undefined,
                tab: spec?.activeTab, sceneGroup: set.id, area: "scene",
                scene: (found as { id: string }).id, label: (found as { name: string }).name },
          before: { sceneGroup: set.id, scene: (found as { id: string }).id, blocks: (found as { blocks?: Block[] }).blocks ?? [] },
          after: { sceneGroup: set.id, scene: (found as { id: string }).id },
        };
      }
      const mode = String(args.mode ?? "add");
      const replace = mode === "replace";
      /** ★★**지우는 길** (사용자 지시 2026-08-26: *"사용자 블록을 안 지우고 우회하는 행동을
       *  계속 함"*). 그럴 수밖에 없었다 — 지우는 창구가 **아예 없었다.** 그래서 조수는
       *  UC 에 반대말을 넣거나 블록을 새로 붙여 **에두르는 수**밖에 못 냈다.
       *  ★되돌릴 수 있다 (`before` 에 원래 블록이 담긴다 → `undo_change`). */
      const drop = mode === "remove";
      /** 지목한 블록 하나 — `get_workspace` 가 블록마다 주는 `id` 다 (`_view`) */
      const wantBlock = String(args.block ?? "").trim();
      /* ★★**이름으로는 못 고른다** (사용자 정정 2026-08-26: *"보통 다 같은 이름임. 블록에
           이름 잘 지정 안 해서"*). 기본 이름이 「새 블록」이라 **거의 모든 블록이 같은 이름**
           이다 — 이름으로 갈아 끼우거나 걷으면 **남의 블록까지 함께 간다.**
         ★한때 「같은 이름은 합친다」로 두었는데, 그 규칙은 이 자리에서 통째로 뭉개는 짓이다.
           걷어냈다. 여럿이면 **고르지 않고 되묻는다** — 후보에 id 와 앞 태그를 실어 주므로
           조수가 그것으로 지목하면 된다 (`block`).
         ★고칠 자리가 둘이면 **두 번 부르면 된다** — 하나는 갈아 끼우고 하나는 걷어낸다. */
      const pickOne = (cur: Block[]): { at: number } | { many: Block[] } | null => {
        if (wantBlock) {
          const at = cur.findIndex((b) => b.id === wantBlock);
          return at >= 0 ? { at } : null;
        }
        const hits = cur.filter((b) => b.label === label);
        if (hits.length > 1) return { many: hits };
        return hits.length === 1 ? { at: cur.indexOf(hits[0]) } : null;
      };
      /** 고른 자리에 새 태그를 넣거나(갈아 끼움) 그 블록을 걷는다. 못 고르면 뒤에 붙인다 */
      const apply = (cur: Block[]): Block[] => {
        const pick = pickOne(cur);
        if (pick && "at" in pick)
          return drop
            ? cur.filter((_, i) => i !== pick.at)
            : cur.map((b, i) => (i === pick.at ? { ...b, tags } : b));
        if (drop) return cur;                       // 걷을 것이 없다 — 그대로 둔다
        return [...cur, makeBlock(label, [], { open: true, tags })];
      };
      /** 하나로 안 좁혀지면 **고르지 않고 되묻는다** — 후보에 id 와 앞 태그를 실어 준다 */
      const tooMany = (cur: Block[]) => {
        const pick = pickOne(cur);
        if (!pick || !("many" in pick)) return null;
        return err(
          "ambiguous",
          `「${label}」 이름의 블록이 ${pick.many.length}개입니다. block 에 블록 id 를 주세요.`,
          {
            what: "block",
            given: label,
            candidates: pick.many.map(
              (b) => `${b.id}: ${b.tags.map((x) => x.t).slice(0, 4).join(", ")}`,
            ),
          },
        );
      };
      const at = {
        kind: "prompt" as const,
        workspace: ws.current ?? undefined,
        tab: spec?.activeTab,
        sceneGroup: set.id,
        area,
        label,
      };
      const verb = drop ? "걷어냄" : replace ? "갈아 끼움" : "더함";

      if (area === "base" || area === "baseUc") {
        const before = usePrompt.getState()[area];
        const many = tooMany(before);
        if (many) return many;
        usePrompt.getState().update(area, apply);
        dropHumanUndo(area === "base" ? "base-p" : "base-uc");
        const what = area === "base" ? "베이스 프롬프트" : "베이스 UC";
        return {
          ok: true, area, label, at,
          did: `${where}의 ${what}에 「${label}」을 ${verb}`,
          before: { sceneGroup: set.id, area, blocks: before },
          after: { sceneGroup: set.id, area, blocks: usePrompt.getState()[area] },
        };
      }

      const [name, part] = area.split(":");
      const field = part === "uc" ? ("uc" as const) : ("prompt" as const);
      let ch = usePrompt.getState().chars.find((c) => c.id === name || c.name === name);
      /* ★**없으면 만든다** (사용자 지시 2026-08-24). 예전에는 「그런 자리가 없습니다」로
         끝나서, 조수가 인물을 더하려면 사람이 먼저 빈 칸을 만들어 줘야 했다.
         ★만든 것은 `created` 로 남긴다 — 되돌릴 때는 블록이 아니라 **그 칸을 지운다.** */
      let created = "";
      if (!ch) {
        created = usePrompt.getState().addChar({ name });
        ch = usePrompt.getState().chars.find((c) => c.id === created);
        if (!ch) return { error: `자리를 만들지 못했습니다: ${area}` };
      }
      const before = ch[field];
      const many = tooMany(before);
      if (many) return many;
      usePrompt.getState().updateChar(ch.id, field, apply);
      dropHumanUndo(`${ch.id}-${field === "uc" ? "uc" : "p"}`);
      const now = usePrompt.getState().chars.find((c) => c.id === ch!.id);
      const what = field === "uc" ? `${ch.name} UC` : ch.name;
      return {
        ok: true, area: ch.name, label, at: { ...at, area: ch.name },
        did: created
          ? `${where}에 캐릭터 「${ch.name}」을 만들고 「${label}」을 ${verb}`
          : `${where}의 ${what}에 「${label}」을 ${verb}`,
        before: { sceneGroup: set.id, area: ch.id, part: field, blocks: before, created },
        after: { sceneGroup: set.id, area: ch.id, part: field, blocks: now?.[field] ?? [] },
      };
    }

    /* ★★**탭·세트·씬 만들기는 앱이 한다** (사용자 지시 2026-08-24: *"앱을 켠 상태로도
         쓸 수 있어야 할 것 같은데"*).

       워크스페이스 설정(`workspace.json`)의 주인은 **화면**이다 — 앱이 통째로 들고 있다가
       통째로 저장하므로, 백엔드가 파일에 끼어들어 쓰면 다음 저장에 덮인다. 그래서
       `edit_current_prompt` 와 같은 길을 쓴다: 조수가 시키고, **앱이 자기 창구로** 만든다.
       그러면 화면도 그 자리에서 따라온다.
       ★새 창구를 만들지 않는다 — 사람이 `+` 를 눌렀을 때와 **같은 함수**를 부른다
         (`addTab`·`addSceneGroup`·`addSlot`). 두 벌이 되면 이름 겹침 처리·번호 발급이 갈린다. */
    if (action === "create_tab") {
      const name = String(args.name ?? "").trim();
      useWs.getState().addTab(name || undefined);
      const spec = useWs.getState().spec;
      // ★`addTab` 은 만들고 **그리로 옮긴다** — 그래서 지금 활성 탭이 방금 만든 것이다
      const made = (spec?.tabs ?? []).find((c) => c.id === spec?.activeTab);
      if (!made) return { error: "탭을 만들지 못했습니다." };
      return {
        ok: true, tab: made.name, tab_id: made.id,
        did: `탭 「${made.name}」 을 만듦`,
        at: { kind: "prompt" as const, workspace: useWs.getState().current ?? undefined, tab: made.id },
      };
    }

    if (action === "create_scene_group") {
      const ws2 = useWs.getState();
      /* ★★**받을 탭을 먼저 연다** (시뮬레이션 구멍 A, 2026-08-24). 세트는 **탭에 속하는데**
         (`SceneGroup.tabId`) 여기는 지금 활성 탭에만 만들고 있었다 — 그래서
         *"키키의 감정별 10종"* 같은 요청이 **남의 탭 밑에** 세트를 만들 수 있었다.
         오류도 안 나고, 사용자는 엉뚱한 탭에서 그것을 발견한다. */
      const wantTab = String(args.tab ?? "").trim();
      if (wantTab) {
        const hit = (ws2.spec?.tabs ?? []).find((c) => c.id === wantTab || c.name === wantTab);
        if (!hit) return { error: `그런 탭이 없습니다: ${wantTab}` };
        if (ws2.spec?.activeTab !== hit.id) ws2.switchTab(hit.id);
      }
      const before = new Set((useWs.getState().spec?.sceneGroups ?? []).map((x) => x.id));
      // ★씬을 안 주면 **빈 세트**다 (사람이 `+` 로 만들 때와 같다). 이름을 주면 그 씬 하나로 연다
      const scenes = (args.scenes as string[] | undefined)?.map((x) => String(x)) ?? [];
      ws2.addSceneGroup(String(args.name ?? "").trim() || t("sceneGroup.newSet"), scenes);
      const spec = useWs.getState().spec;
      const made = (spec?.sceneGroups ?? []).find((x) => !before.has(x.id));
      if (!made) return { error: "씬 그룹을 만들지 못했습니다." };
      return {
        ok: true, sceneGroup: made.name, scene_group_id: made.id,
        did: `씬 그룹 「${made.name}」 을 만듦`,
        at: { kind: "prompt" as const, workspace: useWs.getState().current ?? undefined,
              tab: spec?.activeTab, sceneGroup: made.id },
      };
    }

    if (action === "create_scene") {
      const ws2 = useWs.getState();
      const spec = ws2.spec;
      const want = String(args.set ?? "").trim();
      const set = want
        ? spec?.sceneGroups.find((x) => x.id === want || x.name === want)
        : spec?.sceneGroups.find((x) => x.id === spec?.activeSceneGroup);
      if (!set || set.kind !== "sceneGroup") return { error: "세트를 찾지 못했습니다." };
      /* ★씬은 **카드 안**에 산다. 카드가 하나도 없으면 씬을 놓을 자리가 없으므로 먼저 만든다
         (씬 줄의 「씬 세트 만들기」와 같은 길이다). */
      const name = String(args.name ?? "").trim();
      const had = new Set(allCells(set).map((c) => c.id));
      if (!set.cards.length) ws2.addCard(set.id, name ? { cells: [{ id: "", name, blocks: [] }] } : {});
      else ws2.addSlot(set.id, name ? { name } : {});
      const now = useWs.getState().spec?.sceneGroups.find((x) => x.id === set.id);
      const made = now?.kind === "sceneGroup" ? allCells(now).find((c) => !had.has(c.id)) : undefined;
      if (!made) return { error: "씬을 만들지 못했습니다." };
      return {
        ok: true, scene: made.name, scene_id: made.id, sceneGroup: set.name, scene_group_id: set.id,
        did: `「${set.name}」 씬 그룹에 씬 「${made.name}」 을 만듦`,
        at: { kind: "prompt" as const, workspace: useWs.getState().current ?? undefined,
              tab: useWs.getState().spec?.activeTab, sceneGroup: set.id, scene: made.id, label: made.name },
      };
    }

    /* 되돌리기 — ★조수 전용 통로다. 사람의 `Ctrl+Z` 와 섞지 않는다 (`lib/undo.ts`).
       ★도구 표에 없다 (`backend/agent.py` `_table`) — LLM 이 직접 부르는 것이 아니라
         `undo_change` 가 이력의 `before` 를 그대로 실어 부른다. */
    if (action === "restore_prompt") {
      const { usePrompt } = await import("./prompt");
      const groupId = String(args.set ?? "");
      const hit = useWs.getState().spec?.sceneGroups.find((x) => x.id === groupId);
      if (!hit) return { error: "그 세트가 이미 없습니다." };
      useWs.getState().setActiveSceneGroup(hit.id);
      const area = String(args.area ?? "base");
      const blocks = (args.blocks ?? []) as Block[];
      if (args.scene) {
        const cards = (hit as { cards?: { cells: { id: string }[] }[] }).cards ?? [];
        useWs.getState().patchSceneGroup(hit.id, {
          cards: cards.map((k) => ({
            ...k,
            cells: k.cells.map((c) => (c.id === args.scene ? { ...c, blocks } : c)),
          })),
        } as never);
        return { ok: true };
      }
      if (args.created) {
        usePrompt.getState().removeChar(String(args.created));
        return { ok: true };
      }
      if (area === "base" || area === "baseUc") {
        usePrompt.getState().update(area, () => blocks);
        return { ok: true };
      }
      const ch = usePrompt.getState().chars.find((c) => c.id === area || c.name === area);
      if (!ch) return { error: "그 캐릭터 자리가 이미 없습니다." };
      usePrompt.getState().updateChar(ch.id, args.part === "uc" ? "uc" : "prompt", () => blocks);
      return { ok: true };
    }
    return { error: `모르는 행동: ${action}` };
  } catch (e) {
    return { error: String((e as Error).message ?? e) };
  }
}

function handle(m: Record<string, any>, set: Setter, get: () => S) {
  switch (m.type) {
    case "connected": {
      if (m.client_id) localStorage.setItem(KEY, m.client_id);
      applyStatus(m.status, set, get);
      break;
    }
    case "sync": {
      applyStatus(m.status, set, get);
      for (const im of m.images ?? []) render(im, set, get);
      // ★끊긴 사이 흘러간 CLI 줄 — **순서 그대로** 다시 태운다. 서버가 우리 턴 것만 보낸다
      for (const c of m.cli ?? []) takeCli(c);
      break;
    }
    // ★자동 저장을 껐을 때 — **디스크에 기록을 안 남기고** 메모리에만 담는다.
    //   ★그래도 **자리는 같다**: 씬 줄의 그 씬 칸에 「미저장」 칸으로 들어간다
    //     (v2 `index.html:12146` — 미저장도 저장된 것과 같은 슬롯 카드다).
    case "image_preview": {
      // ★다른 워크스페이스의 미저장 그림은 이 화면의 미리보기에 넣지 않는다 — 대기 칸만 지운다
      //   (`render` 의 ★★주와 같은 까닭, 사용자 실측 2026-09-02)
      if (m.workspace && m.workspace !== useWs.getState().current) {
        consumePending(m, set, get, false);
        takeProgress(m.progress, set);
        bump(String(m.account ?? ""), "ok");
        break;
      }
      const take = usePreviews.getState().add(m);
      /* ★★**보고 있던 대기 칸에 미저장 그림이 나오면 그 그림으로 옮겨 간다** (사용자 지적
         2026-08-30: 자동 저장을 끄면 생성 완료 때 선택이 풀렸다). 저장된 그림은 `consumePending`
         안에서 `m.file` 로 옮기는데, 미저장 그림에는 **서버가 준 파일 이름이 없다** — 화면이
         붙이는 표식(`preview:N`)은 `add()` 가 만들어야 알 수 있다. 그래서 여기서 옮긴다.
         ★판정은 저장된 쪽과 같다: «내가 보고 있는 씬에 나왔는가»뿐이다.
         ★★**반드시 `consumePending` 보다 먼저, 동기로** 한다 (같은 날 두 번째 지적). 처음에는
           동적 import 뒤(비동기)에서 옮겼는데, 그 사이에 대기 칸이 먼저 지워지고
           씬 줄의 마지막 방어선(「대기 칸이 그림 없이 사라지면 놓는다」)이 선택을 풀어 버렸다 —
           그 뒤에 도착한 옮기기는 `pending` 이 이미 비어 아무 일도 못 했다. */
      const f0 = useSceneFocus.getState();
      if (f0.pending && (m.cell_id ?? null) === (f0.cell || null)) f0.focus(f0.cell, take.file);
      // ★대기 칸도 **똑같이** 지운다. 안 지우면 그림이 나왔는데 「생성 중」 칸이 배치가
      //   끝날 때까지 남는다 (`settleBatch` 가 마지막에야 비운다)
      consumePending(m, set, get);
      takeProgress(m.progress, set);
      bump(String(m.account ?? ""), "ok");
      break;
    }
    /* ★★**그리는 중인 그림** (사용자 지시 2026-08-26) — 서버가 NAI 스트림에서 받은 프레임을
       그대로 넘긴다 (`backend/server.py` 의 `image_step`). 그 칸 위에 덮어 그린다. */
    case "image_step": {
      const cell = String(m.cell_id ?? "");
      if (!cell || !m.b64) break;
      // ★다른 워크스페이스의 것은 이 화면과 무관하다 (큐는 앱 전체가 공유한다)
      if (m.workspace && m.workspace !== useWs.getState().current) break;
      /* ★형식은 **서버가 알려 준다** — 중간 그림은 줄여 보내느라 JPEG 이다
         (`imgutil.preview_jpeg`). 옛 서버가 안 실어 주면 예전대로 PNG 로 읽는다. */
      const mime = String(m.mime ?? "image/png");
      // ★열쇠는 워크스페이스 + 칸 (`stepKey` 의 ★주)
      set({ steps: { ...get().steps, [stepKey(String(m.workspace ?? ""), cell)]: `data:${mime};base64,${m.b64}` } });
      break;
    }
    /* ★★**업데이트 진행률·완료** (사용자 지시 2026-08-26). 받는 것은 백엔드가 하고
       (`backend/update.py`), 화면은 그 소식만 받아 막대를 그린다. */
    case "update_progress":
      void import("./update").then(({ useUpdate }) =>
        useUpdate.getState().setProgress(Number(m.done ?? 0), Number(m.total ?? 0)),
      );
      break;
    case "update_unpack":
      // ★다 받았다 — 이제 푸는 중이라고 화면에 알린다 (`store/update` 의 ★★주)
      void import("./update").then(({ useUpdate }) => useUpdate.getState().unpack());
      break;
    case "update_staged":
      // ★취소는 실패가 아니다 — 붉은 줄을 띄우지 않는다 (`useUpdate.finish`)
      void import("./update").then(({ useUpdate }) =>
        useUpdate.getState().finish(!!m.ok, !!m.cancelled),
      );
      break;
    case "image":
      render(m, set, get);
      bump(String(m.account ?? ""), "ok");
      takeProgress(m.progress, set);
      break;
    case "queued":
    case "job_start":
    // ★장마다 온다 — **지금 만드는 씬**을 실어 온다 (`current_cell`)
    case "job_progress":
      takeProgress(m.progress, set);
      break;
    case "job_done": {
      takeProgress(m.progress, set);
      const acc = String(m.account ?? "") || null;
      // ★생성이 끝났으면 **그 계정의 잔액을 다시 묻는다** (v2 `index.html:16429-16432`).
      //   안 물으면 화면의 Anlas 는 앱을 켠 순간 값에 영영 멈춰 있다
      void useSub.getState().load(acc ?? undefined);
      // 대기 잡이 남아 있으면 아직 배치가 안 끝났다 (v2 도 `queue_length === 0` 으로 갈랐다).
      // ★★**그 차선의** 대기다 — 다른 계정이 아직 돌고 있어도 이쪽 배치는 여기서 끝난다
      if (laneLeft(m.progress, acc) === 0) settleBatch(false, acc, set, get);
      break;
    }
    case "job_cancelled": {
      takeProgress(m.progress, set);
      const acc = String(m.account ?? "") || null;
      // ★취소는 **끝난 문구를 안 남긴다** — v2 도 상태를 「준비」로 되돌리기만 했다
      if (laneLeft(m.progress, acc) === 0) settleBatch(true, acc, set, get);
      break;
    }
    // ★취소 — **실제로 멈춘 것만** 걷어낸다 (감사 D5).
    //   `remaining` 은 아직 올 장 수다: 돌고 있었으면 지금 NAI 로 나간 한 장, 아니면 0.
    //   대기 칸은 서버가 만드는 순서 그대로 쌓이므로(`enqueue`), 남길 것은 **맨 앞** 것이다.
    case "queue_cancelled": {
      takeProgress(m.progress, set);
      const keep = Math.max(0, Number(m.remaining ?? 0));
      const acc = String(m.account ?? "") || null;
      const pend = get().pending;
      // ★계정별 취소면 **그 차선의 대기 칸**만 걷어낸다 — 다른 계정의 것은 그대로 돈다
      const mine = acc ? pend.filter((p) => p.account === acc) : pend;
      if (mine.length > keep) {
        const drop = new Set(mine.slice(keep).map((p) => p.id));
        set({ pending: pend.filter((p) => !drop.has(p.id)) });
      }
      // 남은 장이 없으면 여기서 배치가 끝난 것이다 — 돌고 있으면 그 장이 온 뒤
      // `job_cancelled` 가 마무리한다 (거기서도 같은 `settleBatch` 를 부른다)
      if (keep === 0) settleBatch(true, acc, set, get);
      else {
        // 배치 회계만 되돌린다 (v2 `index.html:16542-16544`)
        for (const a of acc ? [acc] : Object.keys(batch)) delete batch[a];
      }
      break;
    }
    // 하트비트 응답 — 받은 것 자체가 생존 신호라 따로 할 일이 없다
    case "pong":
      break;
    // ★AI 가 **데이터를 고쳤다** — 화면은 다시 읽는다. 사용자가 새로고침할 일이 없어야 한다
    case "data_changed":
      if (m.what === "cards") void useCards.getState().load();
      if (m.what === "files") void useFiles.getState().reload();
      break;

    // ★AI 가 시킨 **행동** — 이름 붙은 것만 한다 (도구 목록은 백엔드가 갖는다).
    //   생성은 프롬프트 조립·시드 규칙이 전부 화면에 있어서 여기서 해야 한다
    case "do": {
      void runAction(m.action, m.args ?? {}, m.ask !== false).then((result) =>
        sock?.send(JSON.stringify({ type: "done", id: m.id, result })),
      );
      break;
    }
    // 로컬 CLI 가 흘려보내는 것 — 채팅 스토어가 wire 조각으로 옮긴다
    case "cli":
      takeCli(m);
      break;
    case "image_error":
    case "job_error":
      // ★★큐 실패를 **토스트로 알린다** — 예전에는 `error` 에 담기만 하고 그것을 읽는
      //   화면이 하나도 없어서, 20장이 전부 실패해도 아무 일도 안 일어났다 (감사 2026-08-16).
      set({ error: String(m.error ?? "") });
      toast(queueErrorText(String(m.error ?? "")), "warn");
      bump(String(m.account ?? ""), "err");
      takeProgress(m.progress, set);
      break;
  }
}

/** 브로드캐스트가 실어 온 진행률을 그대로 받는다.
 *  ★남은 것이 있으면 **돌고 있는 중**으로 표시해 둔다 — 멈추는 순간을 잡는 근거다. */
function takeProgress(p: QueueProgress | undefined, set: Setter) {
  if (!p) return;
  const running = p.total > p.completed || p.queue_length > 0;
  // ★돌고 있는 차선마다 표식을 세운다 — 끝은 그 차선의 표식으로만 알린다 (`busyLanes` 의 ★★주)
  if (p.lanes) {
    for (const [id, l] of Object.entries(p.lanes)) if (l.total > l.completed || l.queue_length > 0) busyLanes.add(id);
  } else if (running) busyLanes.add("*");
  set({ progress: p, ...(running ? { phase: "running" as QueuePhase } : {}) });
}

/** 배치가 끝났다 — **브로드캐스트로 오는 끝**을 받는 자리.
 *
 *  ★예전에는 이 청소가 `applyStatus()` 안에만 있었는데 그 함수는 `connected`·`sync` 에서만
 *    돌아서, 취소·실패로 큐가 끝나면 **대기 카드가 유령으로 남고** 완료 알림도 안 울렸다
 *    (감사 A7). v2 는 `job_done`·`job_cancelled` 에서 각각 정리했다
 *    (`index.html:16460, 16483, 16504-16511`). */
/** 그 차선에 **아직 안 시작한 잡**이 몇이나 남았나. 차선 정보가 없으면(옛 백엔드) 전체 대기다 */
function laneLeft(p: QueueProgress | undefined, account: string | null): number {
  if (!p) return 0;
  if (account && p.lanes?.[account]) return p.lanes[account].queue_length ?? 0;
  return p.queue_length ?? 0;
}

/** `account` 가 있으면 **그 차선의** 배치가 끝난 것이다 — 대기 칸·회계·잔액 재기를 그쪽 것만 마무리한다.
 *  없으면(옛 백엔드) 전부다. */
function settleBatch(cancelled: boolean, account: string | null, set: Setter, get: () => S) {
  // ★큐가 다 비면 남은 대기는 **오지 않는다** (취소·실패). 자리를 계속 잡고 있으면 유령이 된다
  const pend = get().pending;
  const rest = account ? pend.filter((p) => p.account !== account) : [];
  if (rest.length !== pend.length) set({ pending: rest });

  let okN = 0;
  let errN = 0;
  for (const a of account ? [account] : Object.keys(batch)) {
    const b = batch[a];
    if (!b) continue;
    okN += b.ok;
    errN += b.err;
    delete batch[a];
  }
  // 취소는 성패를 따지지 않는다 — 그냥 「준비」로 돌아간다
  const phase: QueuePhase = cancelled
    ? "idle"
    : errN > 0 && okN === 0
      ? "failed"
      : errN > 0
        ? "partial"
        : "done";
  const done = okN;
  set({ phase });

  // ★**실제로 청구된 Anlas 를 잰다** (`store/anlasMeter`). 잰다는 것은 잔액 차이다.
  //   ★온전히 끝난 배치에서만 잰다. 취소·실패·일부 실패는 몇 장이 실제로 나갔는지
  //     알 수 없어 숫자가 틀리게 나온다. 그때는 아무 말도 하지 않는다.
  //   ★계정마다 따로 잰다 — 끝난 차선의 계정으로 (`store/anlasMeter` 머리 주석)
  if (phase === "done") void useAnlasMeter.getState().settle(account ?? undefined);
  else useAnlasMeter.getState().disarm(account ?? undefined);

  if (!cancelled) announceDone(done, account);

  if (phaseTimer) clearTimeout(phaseTimer);
  if (phase !== "idle") {
    // ★끝난 문구를 2초만 보여 준다 (v2 `resetTimer`). 그 사이 새로 돌기 시작했으면 그대로 둔다
    phaseTimer = setTimeout(() => {
      if (get().phase === phase) set({ phase: "idle" });
    }, 2000);
  }
}

/** 「다 됐다」를 한 번만 알린다 — **돌다가 멈춘 그 순간**에만.
 *  ★두 경로가 함께 쓴다: 브로드캐스트(`job_done`)와 재접속 복원(`applyStatus`). */
function announceDone(n: number, account: string | null) {
  // ★그 차선이 돌고 있었을 때만 — 차선을 모르면(옛 백엔드·재접속 복원) 세워진 표식 아무거나
  if (account) {
    if (!busyLanes.has(account)) return;
    busyLanes.delete(account);
  } else {
    if (!busyLanes.size) return;
    busyLanes.clear();
  }
  const ui = useUi.getState();
  if (ui.notifyDone) toast(t("queue.allDone", { n }));
  // ★화면을 안 보고 있을 때를 위해 소리로도 알린다 (v2 `notifySoundOnComplete`)
  if (ui.notifySound) void playDoneSound();
  // ★창을 안 보고 있으면 **창 제목**으로도 알린다. v2 에서 **항상 켜져** 있던 알림이라
  //   설정으로 끄지 않는다 (`index.html:17502-17503`)
  notifyByTitle(t("queue.titleDone"));
}

/** CLI 줄 하나를 화면에 태운다 — **실시간분·복원분 공통 창구**.
 *  이미 태운 번호는 `takeCliSeq` 가 거른다 (`lib/cliCursor.ts`). */
function takeCli(m: Record<string, any>) {
  if (!takeCliSeq(String(m.run ?? ""), Number(m.seq ?? 0))) return;
  // ★어느 CLI 가 뱉은 것인지 함께 온다 — 모양이 서로 다르다
  cliEvent(m.event ?? {}, String(m.agent ?? "claude-code"));
}

function applyStatus(status: Record<string, any> | undefined, set: Setter, get: () => S) {
  if (!status) return;
  // ★큐가 다 비면 남은 대기는 **오지 않는다** (취소·오류). 자리를 계속 잡고 있으면 유령이 된다
  const idle = (status.queue_length ?? 0) === 0 && !status.is_processing;
  if (idle && get().pending.length) set({ pending: [] });
  // ★다 끝났으면 한 번만 알린다 — 여러 장 돌려 놓고 다른 일을 하다 놓치는 것을 막는다.
  //   `busyLanes` 로 **돌다가 멈춘 순간**만 잡는다 (가만히 있을 때 계속 울리지 않게).
  //   ★평소의 끝은 `settleBatch` 가 받는다. 이 자리는 **끊겼다 다시 붙었더니 그 사이
  //     끝나 있던** 경우를 위한 것이다 — 알리는 창구는 `announceDone` 하나로 모았다.
  const done = status.completed_images ?? 0;
  const total = status.total_images ?? 0;
  if (idle && total > 0 && done >= total) announceDone(done, null);
  if (idle) busyLanes.clear();
  else busyLanes.add("*");
  // ★★차선도 옮겨 담는다 (사용자 실측 2026-09-02: 재접속 복원이 차선 없이 합계만 넣어서, 나란히 가던
  //   「0/3 · 0/3」이 잠시 뒤 「0/6」으로 합쳐졌다). 상태의 차선은 `Lane.status()` 꼴이라 이름을 맞춘다
  const lanesIn = status.lanes as Record<string, Record<string, any>> | undefined;
  const lanes = lanesIn
    ? Object.fromEntries(
        Object.entries(lanesIn).map(([id, l]) => [
          id,
          { completed: l.completed_images ?? 0, total: l.total_images ?? 0, queue_length: l.queue_length ?? 0,
            current_cell: l.current_cell ?? null, name: l.name },
        ]),
      )
    : undefined;
  set({
    progress: {
      completed: status.completed_images ?? 0,
      total: status.total_images ?? 0,
      queue_length: status.queue_length ?? 0,
      ...(lanes ? { lanes } : {}),
    },
    phase: idle ? "idle" : "running",
  });
  // ★백엔드 재시작 감지 — 서버 seq 가 우리가 본 값보다 **되돌아갔으면** 렌더 집합을 비운다.
  //   안 하면 새 이미지(seq 1..)가 옛 seq 와 충돌해 '이미 본 것'으로 오인되어 전부 건너뛰어진다.
  const srv = status.image_sequence;
  if (typeof srv === "number" && srv < get().lastSeq) {
    set({ seen: new Set(), lastSeq: srv });
  }
}

/** 이 장에 해당하는 대기 하나를 지운다 (같은 슬롯의 맨 앞 것).
 *  ★저장된 그림과 미저장 그림이 **같이 쓴다** — 어느 쪽이든 대기 칸은 하나 줄어야 한다. */
function consumePending(m: Record<string, any>, set: Setter, get: () => S, mine = true) {
  /* ★그 칸의 중간 그림을 놓는다 — 완성본이 왔는데 남겨 두면 그 위에 흐린 미리보기가 겹친다.
     ★★**어느 워크스페이스의 그림이든** 놓는다 (사용자 실측 2026-09-02: 보고 있지 않은 워크스페이스의 그림이
       완성될 때 안 놓으니, 그리로 가면 다음 「생성 중」 칸에 지난 프레임이 떠 있었다). 열쇠가 워크스페이스 +
       칸이라 다른 워크스페이스의 같은 칸 id 것을 잘못 놓을 일은 없다 (`stepKey`). */
  const cell = String(m.cell_id ?? "");
  const sk = stepKey(String(m.workspace ?? useWs.getState().current), cell);
  if (cell && get().steps[sk]) {
    const steps = { ...get().steps };
    delete steps[sk];
    set({ steps });
  }
  /* ★★★**보고 있던 대기 칸에 그림이 나오면, 그 그림으로 옮겨 간다** (사용자 지적 2026-08-26:
     *"여전히 생성 완료되면 선택 해제됨"* — 세 번째다).
     ★판정 기준을 **대기 항목에서 「보고 있는 씬」으로** 옮겼다. 예전에는 «걷히는 대기가
       내가 고른 그것인가»를 물었는데(`consumePending`), 그 물음은 대기 장부가 성할 때만
       답이 나온다 — 대기가 그림보다 **먼저** 걷히는 길이 여럿이고(`settleBatch`·취소·
       `applyStatus` 의 청소), 그 길로 가면 옮길 상대를 잃은 채 선택만 남아 놓아졌다.
     ★지금 묻는 것은 «그림이 **내가 보고 있는 씬**에 나왔는가»뿐이다. 대기 장부와 무관하고,
       화면이 다시 그려지든 말든(컴포넌트가 새로 마운트돼도) 같은 답이 나온다.
     ★대기 칸을 고르고 있을 때만 돈다 — 이미 어떤 장을 보고 있으면 새 그림이 나와도
       **화면을 뺏지 않는다** (사용자가 보던 것을 지키는 규칙 그대로다). */
  const f0 = useSceneFocus.getState();
  if (mine && f0.pending && m.file && (m.cell_id ?? null) === (f0.cell || null)) {
    f0.focus(f0.cell, String(m.file));
  }

  // ★워크스페이스까지 맞춘다 — 씬 그룹·칸 id 는 워크스페이스를 건너 겹친다 (`Pending.workspace` 의 ★주).
  //   서버가 워크스페이스를 안 실어 준 옛 그림(`sync` 복원의 아주 옛 줄)은 예전처럼 id 로만 본다
  const pend = get().pending;
  const wsOf = m.workspace ? String(m.workspace) : null;
  const at = pend.findIndex(
    (p) => p.groupId === (m.scene_group_id ?? null) && p.cellId === (m.cell_id ?? null)
      && (wsOf === null || p.workspace === wsOf),
  );
  if (at < 0) return;
  set({ pending: pend.filter((_, i) => i !== at) });
}

/** 한 장을 화면(워크스페이스 records)에 반영한다. ★같은 seq 는 두 번 반영하지 않는다. */
function render(m: Record<string, any>, set: Setter, get: () => S) {
  const seq = Number(m.seq ?? 0);
  if (seq && get().seen.has(seq)) return;

  const ws = useWs.getState();
  // ★★다른 워크스페이스의 결과는 이 화면의 목록에 안 넣는다 (큐는 앱 전체가 공유한다). 다만 **대기 칸은
  //   지운다** — 예전에는 여기서 그냥 돌아가서, 보고 있지 않은 워크스페이스에 건 배치의 대기 칸이 그림이
  //   나와도 영영 남았다 (사용자 실측 2026-09-02). 그 워크스페이스로 가면 그림은 서버 목록에서 온다.
  if (m.workspace && m.workspace !== ws.current) {
    consumePending(m, set, get, false);
    return;
  }

  ws.addRecord({
    // ★시각은 **서버가 찍은 것**이다 (`_generate_one` 의 `ts`). 화면이 자기 시계로 찍으면
    //   UTC 와 지역시각이 섞여 줄 차례가 어긋난다 (`lib/takes.localTs` 주석)
    ts: (m.ts as string) || localTs(),
    file: m.file,
    scene_group: m.scene_group,
    cell: m.cell ?? null,
    scene_group_id: m.scene_group_id ?? null,
    cell_id: m.cell_id ?? null,
    enhance_of: m.enhance_of ?? null,
    seed: m.seed,
  });

  consumePending(m, set, get);

  if (seq) {
    const seen = new Set(get().seen);
    seen.add(seq);
    set({ seen, lastSeq: Math.max(get().lastSeq, seq) });
  }
}
