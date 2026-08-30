import { create } from "zustand";
import { api, type TrashEntry } from "../lib/backend";
import { useWs } from "./workspace";
import { useUi } from "./ui";
import { t, useI18n } from "../i18n";
import { toast, undoToast } from "./toast";
import { useCli } from "./cli";
import { codexWire } from "../lib/codexStream";
import { noteCliRun } from "../lib/cliCursor";
import type { AgentAt } from "../lib/agentAt";

/** LLM 채팅 — **반복 작업을 대신 시키는 창구** (3.0 의 목표 중 하나, ui-guide 7절).
 *
 *  ★키는 백엔드에만 있다 (`/api/llm/*`). 여기서는 주고받는 모양만 안다.
 *  ★**도구는 백엔드 것이다** (`/api/agent/*`, `backend/agent.py`). AI 는 화면을 조작하지 않고
 *    **데이터(카드·워크스페이스 파일)** 를 만진다 — 그래서 앱이 꺼져 있어도 같은 도구가 돈다.
 *    바뀐 것은 `data_changed` 로 알려 화면이 다시 읽는다.
 *  ★스트리밍은 안 쓴다. 도구 루프는 어차피 한 번에 받아야 하고, 중간 글자보다
 *    "무슨 도구를 썼는지"가 더 중요하다 (그것은 줄로 보여 준다).
 *  ★저장하는 것은 **`wire` 하나뿐**이다. 화면 줄은 거기서 파생시킨다(`linesOf`) —
 *    같은 것을 두 벌로 담으면 둘이 어긋난다 (`backend/chats.py` 머리 주석). */

/** 공급자에 보내는 정본 모양 (앤트로픽 기준 — backend/llm.py 머리 주석) */
type Part =
  | { type: "text"; text: string }
  /** ★★**오류 조각** — 화면·저장에만 있고 **공급자에게는 안 나간다** (`forProvider` 가 거른다).
   *  사용자 지시 2026-08-30: 오류가 앱을 다시 켜면 사라져 확인할 수 없었다 — 대화에 남긴다. */
  | { type: "error"; text: string }
  | {
      type: "tool_use";
      id: string;
      name: string;
      input: Record<string, unknown>;
      /** ★공급자가 준 원본 조각 — **손대지 않고 그대로 돌려준다.**
       *  생각하는 모델(제미나이 3 계열)은 함수 호출에 `thoughtSignature` 를 실어 보내고,
       *  그것이 빠진 채 되돌아오면 400 을 낸다. 우리가 이름·인자만 뽑아 다시 만들면
       *  그 서명이 사라진다 (`backend/llm.py` 의 `_to_gemini` 주석). */
      raw?: unknown;
    }
  | { type: "tool_result"; tool_use_id: string; content: string }
  /** ★★조수가 **본** 그림 (2026-08-24, `read_image`).
   *
   *  ★`tool_result` 안이 아니라 **그 뒤의 사용자 메시지**에 실린다 — OpenAI 규격은
   *    `tool` 역할 메시지에 글자만 받기 때문이다 (오픈라우터가 그 규격이다).
   *    세 규격(앤트로픽·OpenAI·제미나이)에서 다 도는 공통 분모가 이것뿐이다.
   *  ★공급자별 모양으로 옮기는 것은 **백엔드**가 한다 (`backend/llm.py`). */
  | { type: "image"; mime: string; b64: string };

export type Wire = { role: "user" | "assistant"; content: Part[] };

/** 화면에 그리는 한 줄 */
export type Line =
  | { kind: "user"; text: string }
  | { kind: "ai"; text: string }
  /** ★`at` 이 있으면 **고친 줄**이다 — 읽기 줄과 다른 얼굴로 그리고, 누르면 그 자리를 연다
   *  (`lib/agentAt.ts`). 없으면 읽기만 한 것이다. */
  | { kind: "tool"; name: string; note: string; ok: boolean; at?: AgentAt }
  | { kind: "error"; text: string };

/** ★공급자는 **정확한 이름**으로 고른다 (사용자 지시 2026-08-08: "호환은 적을 필요 없음").
 *  목록·라벨·호출명 예시는 **백엔드가 정본**이다 — 규격을 아는 쪽이 거기라서. */
export type ProviderInfo = { id: string; label: string; hint: string; hasKey: boolean };
/** 공급자가 알려 준 모델 하나. `in` 은 백만 토큰당 입력 단가(오픈라우터만) */
export type ModelInfo = {
  id: string;
  label?: string;
  in?: number;
  vision?: boolean;
  /** ★추론 단계는 **모델이 알려 준다** — 모델마다 다르므로 코드에 박지 않는다 */
  efforts?: string[];
  effortDefault?: string;
  /** 끌 수 없는 모델(제미나이·그록·Qwen 등) — 끄기 칸을 감춘다 */
  reasoningLocked?: boolean;
};
export type LlmConfig = {
  provider: string;
  /** 지금 공급자의 모델 (공급자마다 따로 기억한다) */
  model: string;
  models: Record<string, string>;
  /** 지금 공급자의 추론 강도. 빈 값이면 모델 기본값 */
  effort: string;
  hasKey: boolean;
  providers: ProviderInfo[];
  /** 요청 창구(디스코드). ★백엔드가 정본이다 — 화면에 주소를 박지 않는다 */
  support: string;
};

export type ChatInfo = { id: string; title: string; updatedAt: string; turns: number;
  /** 어디서 시작했는지 — 대화는 전역이지만 출처는 보인다 */ workspace?: string };

/** AI 가 사용자에게 던진 물음 — 답할 때까지 도구가 기다린다 (`ask_user`).
 *  ★내장 AskUserQuestion 은 이 환경에서 못 쓴다(stdin 이 닫혀 있다). 그래서 우리 도구로 만든다. */
export type Ask = {
  question: string;
  header?: string;
  options: { label: string; description?: string }[];
  /** 여러 개를 함께 고르는 물음인가 (사용자 지시 2026-08-08) */
  multi?: boolean;
  /** 고른 것을 돌려주는 길 — 화면이 부른다. 하나든 여럿이든 배열로 넘긴다 */
  answer: (labels: string[]) => void;
};

/** **승인 요청** — 조수가 되돌릴 수 없는 일을 하기 전에 대화 안에 뜬다 (2026-08-24).
 *
 *  ★★모달 확인 창(`store/ask`)이 아니라 **여기**인 이유 (사용자 결정): 클로드 코드가 파일
 *    삭제 전에 승인을 받는 것과 같은 모양이다. 왕복이 한 번이고, **대화에 남아** 무엇을
 *    승인했는지 나중에 되짚을 수 있다 — 모달은 누르고 나면 흔적이 없다.
 *  ★기제는 `Ask` 와 같다: **답할 때까지 도구가 기다린다.** 새로 만들지 않고 한 벌 더 쓴다.
 *  ★조수가 잊을 수 있는 것이 없다 — 토큰을 조수에게 쥐여 주는 방식(2판)을 이것으로 바꿨다. */
export type Confirm = {
  /** 무엇을 하려는가 — 한 줄 */
  title: string;
  /** 무엇이 사라지나·얼마가 드나 (액션의 `preview` 가 만든다) */
  body?: string;
  /** ★되돌릴 수 없는 일인가 — 빨갛게 그리고, 「자동 승인」에서도 묻는다 */
  hard?: boolean;
  answer: (okay: boolean) => void;
};

/** 한 번의 물음에 도구를 몇 번까지 이어 쓰나 — 무한 루프를 막는 울타리 */
const MAX_ROUNDS = 12;

/** 지침은 **백엔드가 정본**이다 (`/api/agent/system`) — BYOK 와 CLI 가 같은 것을 쓴다.
 *  못 받아 오면 이 한 줄로 버틴다 (없는 도구를 시키지 않는 것이 중요하다). */
let SYSTEM = "You are the assistant inside PeroPix 3.0, an image generation app. Work on the user's data with the tools.";

/** 지침을 **지금 표시 언어로** 받아 둔다 — 답이 그 언어로 나와야 한다 (사용자 지시 2026-08-12).
 *  ★언어를 바꾸면 다시 받는다. 안 그러면 앱은 일본어인데 조수만 한국어로 답한다. */
export async function loadSystemPrompt() {
  try {
    const r = await api<{ system: string }>(
      `/api/agent/system?lang=${encodeURIComponent(useI18n.getState().locale)}`,
    );
    if (r.system) SYSTEM = r.system;
  } catch {
    /* 백엔드가 아직 안 떴을 수 있다 — 다음에 다시 부른다 */
  }
}
useI18n.subscribe((s, prev) => {
  // ★CLI 는 이어 붙일 때 지침을 다시 안 준다(세션이 갈라진다) — 바뀐 언어는 **새 대화부터** 먹는다
  if (s.locale !== prev.locale) void loadSystemPrompt();
});

/** 저장된 대화(wire)를 화면 줄로 — **파생이지 별도 상태가 아니다.** */
/** ★★오류를 **대화에 남긴다** (사용자 지시 2026-08-30: 앱을 다시 켜면 사라져 확인할 수 없었다).
 *  ★그래도 **공급자에게는 안 보낸다** — 다음 턴에 그 글이 문맥으로 되돌아가면 또 걸린다
 *    (`forProvider` 가 거른다). 화면과 저장(`wire`)에만 있는 조각이다. */
function noteError(text: string) {
  const wire: Wire[] = [
    ...useLlm.getState().wire,
    { role: "assistant", content: [{ type: "error", text }] },
  ];
  useLlm.setState({ wire, lines: linesOf(wire), error: "" });
}

/** 공급자에게 보낼 대화 — 오류 조각을 뺀다 (그것만 든 메시지는 통째로) */
export function forProvider(wire: Wire[]): Wire[] {
  return wire
    .map((m) => ({ ...m, content: m.content.filter((b) => b.type !== "error") }))
    .filter((m) => m.content.length > 0);
}

export function linesOf(wire: Wire[]): Line[] {
  const out: Line[] = [];
  const names = new Map<string, string>(); // tool_use id → 도구 이름
  for (const m of wire) {
    for (const b of m.content) {
      // ★빈 글은 안 그린다 — 조수의 말은 **시작할 때 자리만 잡고** 내용은 나중에 채운다
      //   (`codexStream.ts` 의 `slot`). 그 사이의 빈 줄이 화면에 보이면 안 된다.
      if (b.type === "text") {
        if (b.text.trim()) out.push({ kind: m.role === "user" ? "user" : "ai", text: b.text });
      }
      else if (b.type === "error") out.push({ kind: "error", text: b.text });
      else if (b.type === "tool_use") names.set(b.id, b.name);
      else if (b.type === "tool_result") {
        let ok = true;
        let note = "";
        let at: AgentAt | undefined;
        try {
          const d = JSON.parse(b.content) as
            { error?: string; cancelled?: boolean; did?: string; at?: AgentAt };
          if (d?.error) {
            ok = false;
            note = String(d.error);
          } else if (d?.cancelled) {
            ok = false;
            note = t("ai.declined");
          } else if (d?.did) {
            at = (d as { at?: AgentAt }).at;
            // ★★**무엇을 바꿨는지 성공했을 때도 보여 준다** (사용자 지시 2026-08-08).
            //   예전엔 성공하면 도구 **이름만** 떴다 — `create_card` 만으로는 무엇이 생겼는지
            //   알 수 없어서, 사용자가 "되돌려" 라고 말할 근거가 화면에 없었다.
            //   바꾸는 도구가 `did` 를 돌려준다 (`backend/agent.py` Tools 머리 주석).
            note = String(d.did);
          }
        } catch {
          /* 도구가 문자열을 돌려준 것 — 성공으로 본다 */
        }
        out.push({ kind: "tool", name: names.get(b.tool_use_id) ?? "tool", note, ok, at });
      }
    }
  }
  return out;
}

/** 목록에 보일 이름 — 첫 사용자 발화의 앞부분 */
const titleOf = (wire: Wire[]) => {
  for (const m of wire)
    if (m.role === "user")
      for (const b of m.content) if (b.type === "text") return b.text.slice(0, 60);
  return "";
};

/** 첫 턴에만 지침 끝에 붙는 한 줄 — **이름부터 짓고 시작하라**.
 *
 *  ★★사용자 지시 2026-08-25: *"이름짓기를 왜 API 키로 호출함? 지금 대화하는 ai가 지어야지."*
 *    한때 이름 하나를 위해 BYOK 로 따로 한 번 더 불렀다. 그러면 CLI 로 도는 사용자에게는
 *    **대화하는 쪽과 다른 모델**이 이름을 지었고, 호출도 하나 더 들었다.
 *  ★★호출을 늘리지 않는 길은 **첫 턴 안에서 시키는 것**이다 (사용자 지시: *"그냥 처음에
 *    그걸 먼저 하고 작업 시작하라고 하면 되는 거 아님?"*). 클로드 코드도 이 모양이다.
 *  ★**이름이 없을 때만** 붙인다 — 매 턴 붙이면 지침이 턴마다 달라져 프롬프트 캐시가 깨진다.
 *    CLI 는 애초에 첫 턴에만 지침을 받는다 (`cliagent.argv` 의 `--append-system-prompt`).
 *  ★안 불러도 대화는 그대로 돈다 — 그때는 목록 이름이 첫 발화로 남는다 (`titleOf`). */
const NAME_FIRST =
  "\n\n[first turn] This chat has no name yet. Before anything else, call `name_chat` " +
  "with a short title (about 20 characters) saying what the chat is about, " +
  "in the user's language. Then do the work.";

type S = {
  cfg: LlmConfig | null;
  /** 지금 열려 있는 대화 */
  id: string;
  /** 이 대화의 이름 — 비면 아직 안 지어진 것이다 (`name_chat` 액션이 채운다) */
  title: string;
  wire: Wire[];
  lines: Line[];
  list: ChatInfo[];
  sending: boolean;
  /** 도는 중에 사용자가 더 건 말 — 이 턴이 끝나는 대로 한 턴으로 묶어 이어 처리한다.
   *  ★줄은 이미 화면에 올라가 있다. 여기 있는 것은 **아직 CLI 에 안 보낸 글**뿐이다. */
  queued: string[];
  error: string;
  /** 지금 화면에 떠 있는 물음 (없으면 null) */
  ask: Ask | null;
  /** 지금 떠 있는 **승인 요청** — 되돌릴 수 없는 일 앞에서 뜬다 (`Confirm` 주석) */
  confirm: Confirm | null;
  /** CLI 턴에서 저쪽이 들고 있는 대화 id — 다음 턴에 `--resume` 으로 이어 붙인다 */
  cliSession: string | null;
  /** 이 대화의 CLI 세션이 저쪽에 **없다** — 열 때 확인한다.
   *  ★사용자가 말을 걸어 실패를 겪고 나서 알게 되지 않도록 (사용자 지시 2026-08-12) */
  cliSessionGone: boolean;
  /** ★★**접어 둔 사이에 답이 끝났다** (사용자 지시 2026-08-26: *"AI 채팅창 접어놓은 상태에서
   *  답변 완료되면 dot 찍어줘"*). 접힌 레일에 점 하나로 알린다 — 접어 두고 다른 일을 하다가
   *  끝난 줄 모르고 지나치는 자리다.
   *  ★**펴면 사라진다** (`useUi.openAi`) — 읽었다는 뜻이다.
   *  ★저장하지 않는다: 앱을 껐다 켜면 그 대화는 이미 지난 것이다. */
  unread: boolean;
  setUnread: (v: boolean) => void;
  /** ★★이 턴이 **언제 시작했나** (ms). 화면이 들면 패널을 접었다 펼 때마다 0 부터
   *  다시 세어 **막 시작한 것처럼** 보인다 (사용자 지적 2026-08-26: 접었다 폈더니
   *  일하는 중 표시가 사라졌다). 시각은 턴의 것이므로 턴을 아는 곳이 든다. */
  turnAt: number;

  /** 지금 공급자가 주는 모델 목록. ★설정 화면과 채팅 칩이 **같은 것**을 본다 —
   *  두 곳에서 따로 받아 오면 한쪽만 갱신돼 서로 다른 목록을 보여 준다 */
  models: ModelInfo[];
  modelsErr: string;
  modelsLoading: boolean;
  loadModels: (provider?: string) => Promise<void>;

  loadConfig: () => Promise<void>;
  saveConfig: (c: Partial<LlmConfig> & { key?: string }) => Promise<void>;
  /** 앱을 켤 때 — 마지막 대화를 되살린다 */
  restore: () => Promise<void>;
  refreshList: () => Promise<void>;
  open: (id: string) => Promise<void>;
  newChat: () => void;
  /** 조수가 지은 이름을 받는다 (`name_chat` 액션) — 창구는 여기 하나다 */
  setTitle: (name: string) => void;
  remove: (id: string) => Promise<void>;
  send: (text: string) => Promise<void>;
  /** 한 턴을 실제로 돌린다 — 사용자 줄은 이미 올라가 있다고 본다 (`send`·`drain` 전용) */
  run: (text: string) => Promise<void>;
  stop: () => void;
};

/** 백엔드가 내주는 도구 명세 (MCP 모양). 한 번 받아 두고 쓴다 */
type ToolSpec = { name: string; description: string; inputSchema: Record<string, unknown> };
let specs: ToolSpec[] = [];
let abort = false;
const newId = () => "chat_" + Date.now().toString(36);

export const useLlm = create<S>((set, get) => ({
  cfg: null,
  models: [],
  modelsErr: "",
  modelsLoading: false,
  id: newId(),
  title: "",
  wire: [],
  lines: [],
  list: [],
  sending: false,
  queued: [],
  error: "",
  ask: null,
  confirm: null,
  cliSession: null,
  cliSessionGone: false,
  unread: false,
  setUnread: (v) => set({ unread: v }),
  turnAt: 0,

  async loadConfig() {
    try {
      // 지침도 함께 받아 둔다 (두 경로가 같은 것을 쓰게 · 지금 표시 언어로)
      void loadSystemPrompt();
      set({ cfg: await api<LlmConfig>("/api/llm/config") });
    } catch {
      /* 백엔드가 아직 안 떴을 수 있다 — 다음에 다시 부른다 */
    }
  },

  async loadModels(provider) {
    const pid = provider ?? get().cfg?.provider;
    if (!pid) return;
    /* ★★**옛 목록을 먼저 비운다** (사용자 지적 2026-08-30: 키 없는 오픈라우터로 바꿨는데 목록이
       보였다). 예전에는 응답이 올 때까지 이전 공급자의 목록이 그대로 남아, 그 사이에 그것이
       새 공급자의 목록처럼 보였다. 공급자가 다르면 옛 목록은 어차피 쓸 수 없다. */
    set({ models: [], modelsLoading: true, modelsErr: "" });
    try {
      const r = await api<{ models: ModelInfo[]; error?: string; fixed?: boolean }>(
        `/api/llm/models?provider=${encodeURIComponent(pid)}`,
      );
      set({ models: r.models ?? [], modelsErr: r.error ?? (r.fixed ? t("settings.modelFixed") : "") });
      /* ★★고른 모델이 없으면 **목록의 첫 항목**을 고른다 (사용자 지적 2026-08-30: 힌트(gpt-5-mini)가
         고른 것처럼 보였는데 실제로는 빈 값이라 「모델이 선택되지 않았다」가 떴다). 목록은
         백엔드가 추천 순(최신이 앞)으로 주므로 첫 항목이 곧 기본값이다. */
      const c = get().cfg;
      if (c && c.provider === pid && !c.model && r.models?.length) await get().saveConfig({ model: r.models[0].id });
    } catch (e) {
      set({ models: [], modelsErr: String((e as Error).message ?? e) });
    } finally {
      set({ modelsLoading: false });
    }
  },

  async saveConfig(c) {
    const cur = get().cfg;
    const next = await api<LlmConfig>("/api/llm/config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: c.provider ?? cur?.provider ?? "",
        // ★모델은 **그 공급자 것**이다. 공급자만 바꿀 때는 안 보낸다 (저쪽 모델을 덮지 않게)
        model: c.model ?? "",
        // ★추론 강도도 **보낼 때만** 바뀐다 (빈 문자열은 "모델 기본값"이라는 뜻이라 유효한 값이다)
        ...(c.effort === undefined ? {} : { effort: c.effort }),
        // ★키는 **보낼 때만** 바뀐다 (undefined 면 그대로 둔다)
        ...(c.key === undefined ? {} : { key: c.key }),
      }),
    });
    set({ cfg: next });
  },

  async refreshList() {
    try {
      set({ list: (await api<{ items: ChatInfo[] }>("/api/chats")).items });
    } catch {
      /* 목록이 없어도 대화는 된다 */
    }
  },

  async restore() {
    // ★되살리는 동안 사용자가 먼저 움직였으면 **덮지 않는다.** 목록을 받아 오는 사이에
    //   「새 대화」를 누르거나 말을 걸면, 뒤늦게 도착한 옛 대화가 화면을 되살려 버렸다
    //   (실측 2026-08-08: 진짜 앱 테스트에서 지난 대화의 도구 줄이 통째로 되돌아왔다).
    const mine = get().id;
    await get().refreshList();
    if (get().id !== mine || get().wire.length || get().sending) return;
    const last = get().list[0];
    if (last) await get().open(last.id);
  },

  async open(id) {
    // ★턴이 도는 중에는 안 연다 — 돌던 응답이 **그 대화에 붙는다**
    if (get().sending) return;
    // ★★**가져오는 사이에 화면이 움직였으면 덮지 않는다.** 위의 검사는 **보내기 전**의
    //   상태일 뿐이라, 그 사이 사용자가 말을 걸면 늦게 도착한 옛 대화가 **진행 중인 턴을
    //   덮어 버린다** (실측 2026-08-15: 사용자 발화가 통째로 사라지고 그 자리에 사흘 전
    //   대화가 들어와 있었다. 그 턴은 카드까지 만들었는데 화면에는 흔적이 없었다).
    //   아래 `cliSessionGone` 은 같은 함정을 이미 막고 있었는데 정작 본체가 안 막고 있었다.
    //   ★견주는 것은 **길이가 아니라 그 배열 자체**다 — 사용자가 목록에서 다른 대화를
    //   고르는 것(이때는 이미 내용이 들어 있다)까지 막으면 안 된다.
    const before = get().wire;
    try {
      const d = await api<{ id: string; title?: string; wire: Wire[]; session?: string }>(
        `/api/chats/${id}`,
      );
      if (get().sending || get().wire !== before) return;
      // ★세션 id 도 되살린다 — 이게 없으면 이어 열 때마다 CLI 가 첫 메시지부터 시작한다
      set({
        id: d.id,
        title: d.title ?? "",
        wire: d.wire ?? [],
        lines: linesOf(d.wire ?? []),
        error: "",
        ask: null,
        confirm: null,
        cliSession: d.session || null,
        cliSessionGone: false,
      });
      // ★열자마자 확인한다 — claude 는 기본 30일이 지난 기록을 지운다. 없어진 것을
      //   모르고 말을 걸면 한 마디도 못 하고 죽는데, 그때는 까닭이 안 보인다.
      if (d.session) {
        const gone = await api<{ exists: boolean }>(
          `/api/cli/session/${d.session}?agent=${encodeURIComponent(useCli.getState().agent)}`,
        )
          .then((r) => !r.exists)
          .catch(() => false); // 못 물어봤으면 있다고 친다 — 멀쩡한 대화를 막지 않는다
        // ★그 사이 사용자가 다른 대화로 갔으면 덮지 않는다 (restore 와 같은 함정)
        if (gone && get().id === d.id) set({ cliSessionGone: true });
      }
    } catch {
      /* 지워졌을 수 있다 — 새 대화로 둔다 */
      get().newChat();
    }
  },

  setTitle(name) {
    if (!name.trim()) return;
    set({ title: name.trim() });
    void save(get());
  },

  newChat() {
    // ★턴이 도는 중에는 안 바꾼다 — 돌던 응답이 **새 대화에 붙는다** (2026-08-08 확인)
    if (get().sending) return;
    // ★CLI 세션도 함께 끊는다 — 안 그러면 새 대화인데 저쪽은 옛 맥락을 들고 있다
    set({ id: newId(), title: "", wire: [], lines: [], error: "", ask: null, confirm: null, cliSession: null,
          cliSessionGone: false, queued: [] });
  },

  /** ★대화 삭제도 **휴지통을 거친다** (사용자 결정 2026-08-18, v2-port-audit D7). */
  async remove(id) {
    const r = await api<{ trashed: TrashEntry[] }>(`/api/chats/${id}`, { method: "DELETE" });
    await get().refreshList();
    if (get().id === id) get().newChat();
    if (r.trashed?.length)
      undoToast(t("common.trashed", { n: 1 }), t("common.undo"), async () => {
        await api("/api/chats/restore", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ entries: r.trashed }),
        });
        await get().refreshList();
        toast(t("common.restored"));
      });
  },

  async send(text) {
    if (!text.trim()) return;
    const push = (m: Wire) => {
      const wire = [...get().wire, m];
      set({ wire, lines: linesOf(wire) });
    };
    push({ role: "user", content: [{ type: "text", text }] });
    /* ★이름은 조수가 첫 턴에 `name_chat` 으로 붙인다 (`NAME_FIRST`) */
    // ★★**도는 중에도 말을 걸 수 있다** (사용자 지시 2026-08-15).
    //   CLI 는 **그 턴 안으로 곧바로 들어간다**(`mode: "steer"`). 못 받는 경우에만 줄을
    //   세웠다가 턴이 끝나는 대로 이어서 보낸다 (`drain`).
    if (get().sending) {
      void save(get());
      if (useCli.getState().engine === "cli") {
        const r = await cliPost(text, get()).catch(() => null);
        if (r?.mode === "steer") return; // 도는 턴에 들어갔다 — 줄 세울 것 없다
      }
      set({ queued: [...get().queued, text] });
      return;
    }
    await get().run(text);
  },

  /** 한 턴을 실제로 돌린다 — `send` 와 `drain` 이 함께 쓴다 (사용자 줄은 이미 올라가 있다). */
  async run(text) {
    abort = false;
    const push = (m: Wire) => {
      const wire = [...get().wire, m];
      set({ wire, lines: linesOf(wire) });
      saveSoon(); // ★턴 도중의 줄도 파일에 남는다 (`saveSoon` 머리 주석)
    };
    set({ sending: true, error: "", turnAt: Date.now() });
    // ★★**말을 건 그 자리에서 저장한다** (사용자 지적 2026-08-15). 예전에는 턴이 끝나야
    //   저장해서, 도는 중에 앱을 다시 켜면 그 대화가 **목록에 아예 없었다.** 그러면
    //   「마지막 대화 복구」가 엉뚱한 옛 대화를 열고, 오늘 한 일이 사흘 전 대화에 붙는다.
    void save(get());

    // ★로컬 CLI 로 도는 턴 — 도구 루프를 **저쪽이** 돈다. 우리는 흘러오는 것을 옮겨 적을 뿐이다
    if (useCli.getState().engine === "cli") {
      try {
        const r = await cliPost(text, get());
        // ★이 턴의 번호를 받아 적어 둔다 — 소켓이 **한 줄도 못 받고** 끊겨도, 붙을 때
        //   "그 턴의 놓친 줄"을 되받을 수 있다 (`lib/cliCursor.ts`)
        if (r?.run) noteCliRun(r.run);
      } catch (e) {
        noteError(String((e as Error).message ?? e));
        set({ sending: false });
        void save(get());
      }
      return; // 끝은 `turn_end` 가 알린다 (cliEvent)
    }

    try {
      for (let round = 0; round < MAX_ROUNDS; round++) {
        if (abort) break;
        // ★도구 명세는 **백엔드가 정본**이다 (CLI 경로와 같은 것을 쓴다)
        if (!specs.length) specs = (await api<{ tools: ToolSpec[] }>("/api/agent/tools")).tools ?? [];
        const r = await api<{
          text?: string;
          tools?: { id: string; name: string; input: Record<string, unknown>; raw?: unknown }[];
          error?: string;
        }>("/api/llm/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            system: SYSTEM + (get().title ? "" : NAME_FIRST),
            messages: forProvider(get().wire),
            tools: specs.map((t) => ({ name: t.name, description: t.description, schema: t.inputSchema })),
          }),
        });

        if (r.error) {
          // ★오류는 대화에 **남기되** 공급자에게는 안 돌아간다 (`noteError` 의 ★★주)
          noteError(r.error);
          break;
        }

        const calls = r.tools ?? [];
        const parts: Part[] = [];
        if (r.text) parts.push({ type: "text", text: r.text });
        for (const c of calls)
          parts.push({ type: "tool_use", id: c.id, name: c.name, input: c.input, raw: c.raw });
        push({ role: "assistant", content: parts });
        if (!calls.length) break;

        // 도구 실행 — ★백엔드가 **데이터**를 만진다 (화면 조작이 아니다)
        const results: Part[] = [];
        /** ★★도구가 돌려준 **그림** — 도구 결과 **다음에** 따로 붙인다 (아래 ★★주) */
        const shots: { file: string; mime: string; b64: string }[] = [];
        for (const c of calls) {
          const out = await api<Record<string, unknown>>("/api/agent/call", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name: c.name, input: c.input }),
          }).catch((e) => ({ error: String((e as Error).message ?? e) }));
          const body = { ...(out ?? { ok: true }) } as Record<string, unknown>;
          /* ★★**그림을 못 받는 모델에는 안 싣는다** (설계 2-7). 모델 목록이 `vision` 을
             실어 주는데(`backend/llm.py` 의 `input_modalities`) 아무도 안 보고 있었다 —
             그대로 보내면 **400** 이 나고, 조수는 왜 실패했는지 모른다.
             ★대신 무엇을 봤어야 하는지 **글로 알려 준다**: 조수가 메타데이터로 갈아탈 수 있게. */
          const cur = get().models.find((m) => m.id === get().cfg?.model);
          if (Array.isArray(body.images) && cur && cur.vision === false) {
            const names = (body.images as { file: string }[]).map((x) => x.file);
            delete body.images;
            body.images_skipped = names;
            body.note = "지금 모델은 그림을 못 봅니다. read_image 대신 read_image_meta 로 "
              + "프롬프트를 읽거나, 설정에서 그림을 보는 모델로 바꿔 주세요.";
          }
          /* ★★**그림은 `tool_result` 안에 넣지 않는다** (2026-08-24).
             앤트로픽은 받지만 **OpenAI 규격은 `tool` 역할 메시지에 글자만** 받는다 —
             오픈라우터가 그 규격이라 우리 기본 공급자에서 깨진다. 세 규격(앤트로픽·
             OpenAI·제미나이)에서 다 도는 공통 분모는 **도구 결과 뒤에 사용자 메시지로
             붙이는 것**이라, 여기서는 빼 두고 아래에서 따로 싣는다.
             ★본문에서 빼는 또 다른 까닭: 같은 바이트를 두 번 실으면 컨텍스트가 두 배가 된다. */
          const got = body.images as { file: string; mime: string; b64: string }[] | undefined;
          if (Array.isArray(got)) {
            shots.push(...got);
            delete body.images;
            body.images_shown = got.map((x) => x.file);
          }
          results.push({
            type: "tool_result",
            tool_use_id: c.id,
            content: JSON.stringify(body),
          });
        }
        push({ role: "user", content: results });
        if (shots.length) {
          /* ★그림을 **사용자 메시지로** 붙인다. 백엔드가 공급자별 모양으로 옮긴다
             (`backend/llm.py`) — 여기서는 규격을 하나만 안다. */
          push({
            role: "user",
            content: [
              { type: "text", text: `[${shots.map((x) => x.file).join(", ")}]` },
              ...shots.map((x) => ({ type: "image" as const, mime: x.mime, b64: x.b64 })),
            ],
          });
        }
      }
    } catch (e) {
      noteError(String((e as Error).message ?? e));
    } finally {
      endTurn();
      void save(get());
      drain();
    }
  },

  stop() {
    abort = true;
    // ★멈추라고 했으면 **쌓아 둔 말도 버린다** — 안 그러면 멈춘 직후에 저절로 또 돈다
    set({ queued: [] });
    if (useCli.getState().engine !== "cli") {
      set({ sending: false });
      return;
    }
    // ★★CLI 는 **`sending` 을 여기서 끄지 않는다.** 이제 중단은 프로세스를 죽이는 게 아니라
    //   그 턴만 멈추는 것이고, 멈췄다는 것은 `turn_end` 가 알린다. 여기서 미리 끄면
    //   아직 흘러나오는 줄이 "안 도는 중"에 붙는다.
    //   ★단 **멈출 것이 없었으면** `turn_end` 도 안 온다 (화면과 서버가 어긋난 경우).
    //   그때는 여기서 풀어 준다 — 안 그러면 「일하는 중」에 영영 갇힌다.
    void api<{ stopped?: boolean }>("/api/cli/stop", { method: "POST" })
      .then((r) => {
        if (!r?.stopped) set({ sending: false });
      })
      .catch(() => set({ sending: false }));
  },
}));

/** 도는 중에 쌓인 말을 이어서 처리한다 — 턴이 끝나는 자리에서만 부른다.
 *
 *  ★여러 줄이 쌓였으면 **한 턴으로 묶는다.** 하나씩 돌리면 CLI 를 그만큼 다시 띄우게 되고
 *    (매번 프로세스 하나), 사용자가 이어서 적은 말은 대개 한 뭉치의 요청이다.
 *  ★줄은 이미 화면에 올라가 있다 (`send` 가 먼저 올린다) — 여기서 또 올리지 않는다. */
function drain() {
  const s = useLlm.getState();
  if (!s.queued.length) return;
  useLlm.setState({ queued: [] });
  if (useCli.getState().engine === "cli") {
    void s.run(s.queued.join("\n\n"));
    return;
  }
  // ★★API 는 CLI 와 사정이 다르다. 도구 루프가 **우리 안에서** 돌고 매 바퀴 `wire` 를
  //   통째로 보내므로, 도는 중에 친 말을 **그 루프가 이미 집어 간다.** 그런데도 여기서 또
  //   돌리면 같은 말을 두 번 시키는 셈이라 답이 두 번 나온다.
  //   그래서 **아직 답이 안 나갔을 때만** 한 턴 더 돈다 — 대화가 「답 없는 사용자 말」로
  //   끝났는가로 가른다. 도구 결과도 `role:"user"` 지만 글이 아니므로 헷갈리지 않는다.
  const last = s.wire[s.wire.length - 1];
  if (last?.role === "user" && last.content.some((c) => c.type === "text")) void s.run("");
}

/** CLI 가 흘려보내는 stream-json 한 줄을 받아 **wire 조각**으로 옮긴다.
 *
 *  ★도구 이름에서 `mcp__peropix__` 접두를 뗀다 — 화면에는 우리 도구 이름만 보여야 한다.
 *  ★끝은 `exit` 이 알린다. `result` 는 세션 id 를 준다 (다음 턴 `--resume`). */
export function cliEvent(ev: Record<string, any>, agent = "claude-code") {
  const st = useLlm.getState();
  const push = (m: Wire) => {
    const wire = [...useLlm.getState().wire, m];
    useLlm.setState({ wire, lines: linesOf(wire) });
    saveSoon(); // ★CLI 가 흘려보내는 줄도 그 자리에서 남긴다
  };
  const strip = (n: string) => n.replace(/^mcp__peropix__/, "");

  // ★코덱스는 **모양이 다르다** (`thread.started`·`item.completed` …). 어느 CLI 인지는
  //   백엔드가 실어 보내므로 짐작하지 않는다. 끝(`exit`)·`stderr`·`error` 는 우리가 만든
  //   것이라 양쪽이 같다 — 그래서 아래 공통 처리로 흘려보낸다.
  if (agent === "codex" && !COMMON.has(String(ev.type))) {
    codexEvent(ev, push);
    return;
  }

  if (ev.type === "system" && ev.subtype === "init") {
    if (ev.session_id) useLlm.setState({ cliSession: String(ev.session_id) });
    return;
  }
  if (ev.type === "assistant") {
    const blocks = (ev.message?.content ?? []) as Record<string, any>[];
    const parts: Part[] = [];
    for (const b of blocks) {
      if (b.type === "text" && b.text?.trim()) parts.push({ type: "text", text: b.text });
      else if (b.type === "tool_use")
        parts.push({ type: "tool_use", id: String(b.id), name: strip(String(b.name)), input: b.input ?? {} });
    }
    if (parts.length) push({ role: "assistant", content: parts });
    return;
  }
  if (ev.type === "user") {
    const blocks = (ev.message?.content ?? []) as Record<string, any>[];
    const parts: Part[] = [];
    for (const b of blocks) {
      if (b.type !== "tool_result") continue;
      const body = Array.isArray(b.content)
        ? b.content.map((c: Record<string, any>) => c.text ?? "").join("")
        : String(b.content ?? "");
      // ★도구가 실패했는지는 `is_error` 가 말해 준다 — 본문을 짐작하지 않는다
      parts.push({
        type: "tool_result",
        tool_use_id: String(b.tool_use_id),
        content: b.is_error ? JSON.stringify({ error: body.slice(0, 300) }) : body,
      });
    }
    if (parts.length) push({ role: "user", content: parts });
    return;
  }
  if (ev.type === "result") {
    if (ev.session_id) useLlm.setState({ cliSession: String(ev.session_id) });
    if (ev.is_error) useLlm.setState({ error: String(ev.result ?? "CLI 오류") });
    return;
  }
  if (ev.type === "error") {
    useLlm.setState({ error: String(ev.text ?? "") });
    return;
  }
  // ★CLI 가 뱉은 말을 **버리지 않는다** (사용자 지적 2026-08-11). 예전에는 `stderr` 를
  //   아예 안 받아서, 죽어도 화면에 "코드 -1 로 끝났습니다" 만 남고 **왜인지 알 길이 없었다.**
  //   (`CLAUDE.md` 「실패를 조용히 넘기지 않는다」 — 그때도 아무 일이 안 일어나 원인을 못 찾았다)
  if (ev.type === "stderr") {
    const line = String(ev.text ?? "").trim();
    if (line) cliErr = [...cliErr, line].slice(-8);
    return;
  }
  // ★이어붙임 번호는 **백엔드가 알려 준다** (`agentsession`) — CLI 마다 캐낼 자리가 다르다
  if (ev.type === "session") {
    if (ev.id) useLlm.setState({ cliSession: String(ev.id) });
    return;
  }
  // ★★**턴의 끝은 `turn_end` 다.** 프로세스가 죽는 것(`exit`)과 다르다 — 이제 프로세스는
  //   대화 내내 살아 있고, 「중단」도 그 턴만 멈춘다 (사용자 지시 2026-08-15).
  if (ev.type === "turn_end" || ev.type === "exit") {
    endTurn();
    if (ev.code && ev.code !== 0 && !st.error) {
      const why = cliErr.join("\n");
      useLlm.setState({
        error: t("ai.cliExit", { code: String(ev.code) }) + (why ? "\n" + why : ""),
      });
    }
    cliErr = [];
    codexOpen = new Set();
    codexSlots = new Map();
    void save(useLlm.getState());
    // ★도는 중에 쌓인 말이 있으면 이어서 처리한다 (사용자 지시 2026-08-15)
    drain();
    return;
  }
}

/** CLI 에 말을 거는 자리 — **여기 하나뿐이다** (새 턴이든 도는 턴에 끼워 넣기든 같은 창구).
 *  백엔드가 `mode` 로 무엇이 됐는지 알려 준다: `start` 새 턴 · `steer` 도는 턴에 들어감 ·
 *  `busy` 못 끼워 넣음(부른 쪽이 줄을 세운다). */
function cliPost(text: string, s: S) {
  return api<{ run?: string; mode?: string; session?: string }>("/api/cli/run", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      prompt: text,
      system: SYSTEM + (s.title ? "" : NAME_FIRST),
      exe: useCli.getState().exe ?? "",
      // ★어느 CLI 인지 실어 보낸다 — 실행 깃발도 흘러오는 모양도 서로 다르다
      agent: useCli.getState().agent,
      // ★★세션을 고르는 열쇠는 **대화 id** 다. 이것 없이 이어붙임 번호로만 고르면
      //   「새 대화」를 눌러도 (번호가 비어 있으니) 앞 대화의 세션을 물려받는다
      chat: s.id,
      resume: s.cliSession ?? "",
      model: useCli.getState().model,
      effort: useCli.getState().effort,
    }),
  });
}

/** 우리가 만들어 넣는 이벤트 — CLI 가 무엇이든 모양이 같다 (`backend/agentsession.py`) */
const COMMON = new Set(["stderr", "exit", "error", "turn_end", "session"]);

/** 이번 턴에 이미 「도구 부름」 줄을 낸 항목 — 코덱스는 `item.started` 와 `item.completed` 가
 *  같은 id 로 두 번 오므로, 결과 줄만 뒤에 붙이려고 들고 있는다. */
let codexOpen = new Set<string>();

/** 자리를 잡아 둔 항목 → 그 줄의 자리 (`codexStream.ts` 의 `slot`).
 *  ★턴이 끝나면 비운다 — 다음 턴의 항목 번호와 섞이면 엉뚱한 줄을 갈아 끼운다. */
let codexSlots = new Map<string, number>();

/** 코덱스가 흘려보낸 한 줄을 받아 적는다 — 옮기는 규칙은 `lib/codexStream.ts` 가 갖는다
 *  (순수 함수라 저쪽이 실제로 뱉은 기록으로 확인할 수 있다). 여기서는 스토어에 앉힐 뿐이다. */
function codexEvent(ev: Record<string, any>, push: (m: Wire) => void) {
  const out = codexWire(ev, codexOpen);
  if (out.error) useLlm.setState({ error: out.error });
  if (out.unknown) console.debug("[codex] 모르는 항목", out.unknown, ev);
  if (!out.wire.length) return;
  // ★자리를 잡아 둔 항목은 **그 자리를 갈아 끼운다** — 뒤에 덧붙이면 글이 흘러나오는 동안
  //   사용자가 친 말이 이 말보다 앞으로 간다 (`codexStream.ts` 의 `slot` 주석)
  if (out.slot) {
    const at = codexSlots.get(out.slot);
    const wire = [...useLlm.getState().wire];
    if (at !== undefined && at < wire.length) {
      wire[at] = out.wire[0];
    } else {
      codexSlots.set(out.slot, wire.length);
      wire.push(out.wire[0]);
    }
    useLlm.setState({ wire, lines: linesOf(wire) });
    return;
  }
  for (const m of out.wire) push(m);
}

/** CLI 가 뱉은 마지막 몇 줄 — 죽었을 때 **왜인지** 보여 주려고 들고 있는다.
 *  ★스토어에 안 넣는다: 대화와 함께 저장될 값이 아니고, 다음 턴에 공급자로 되돌아가면 안 된다
 *    (`useLlm.error` 를 대화에 안 담는 것과 같은 이유). */
let cliErr: string[] = [];

/** **곧 저장한다** — 턴 도중의 줄을 잃지 않기 위한 자리 (사용자 지적 2026-08-25:
 *  *"ai가 작업중 남기는 로그들이 다른 세션을 켰다가 돌아오거나 새로고침 등을 하면 전부
 *  사라짐. 로그를 남기는 순간부터 세션에 계속 남아 있어야 함."*).
 *
 *  ★예전에는 **턴이 끝나야** 저장했다 (`run` 의 `finally`·CLI 의 `turn_end`). 도구를 열 번
 *    부르는 긴 턴에서 새로고침하거나 다른 대화를 열면 그 열 줄이 통째로 없어졌다 —
 *    화면에만 있었고 파일에는 없었다.
 *  ★**0.5초로 묶는다.** 줄마다 PUT 을 던지면 긴 턴에서 저장이 수십 번 돈다. 묶어도
 *    「남기는 순간부터 남아 있다」는 지켜진다 — 잃는 폭이 최대 0.5초다. */
let saveTimer: ReturnType<typeof setTimeout> | null = null;
function saveSoon() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    void save(useLlm.getState());
  }, 500);
}

/** **턴이 끝났다** — 끝을 알리는 자리는 여기 하나다 (API 도 CLI 도 이리로 온다).
 *
 *  ★★접어 둔 사이에 끝났으면 **점을 남긴다** (사용자 지시 2026-08-26). 접어 두고 다른 일을
 *    하다가 답이 끝난 줄 모르고 지나치는 자리다 — 펴면 사라진다 (`useUi.openAi`).
 *  ★펴 놓고 보고 있었으면 점을 안 찍는다: 이미 본 것이다. */
function endTurn() {
  useLlm.setState({
    sending: false,
    unread: useLlm.getState().unread || useUi.getState().aiCollapsed,
  });
}

/** 한 턴이 끝날 때마다 통째로 저장한다 — 대화는 길어야 수십 줄이라 부분 저장이 필요 없다 */
async function save(s: S) {
  if (!s.wire.length) return;
  try {
    await api(`/api/chats/${s.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        wire: s.wire,
        // ★지어진 이름이 있으면 그것이다 — 첫 발화 자르기는 조수가 안 불렀을 때의 폴백이다
        title: s.title || titleOf(s.wire),
        session: s.cliSession ?? "",
        // ★어디서 시작했는지 — 목록 라벨용 (백엔드가 첫 저장 때만 박는다)
        workspace: useWs.getState().current,
      }),
    });
    await useLlm.getState().refreshList();
  } catch {
    /* 저장이 실패해도 화면의 대화는 그대로 이어진다 */
  }
}
