import { create } from "zustand";
// ★확장자를 적는다 — 이 모듈은 `cli.test.ts` 가 **node 로 그대로 불러** 확인한다
//   (node 는 Vite 와 달리 확장자를 붙여 주지 않는다). `lib/backend` 는 import 가 없어 여기서 끝난다.
import { api } from "../lib/backend.ts";

/** 로컬 에이전트 CLI — **사용자가 이미 내고 있는 구독을 그대로 쓴다.**
 *
 *  ★탐지는 **공짜**다 (PATH + 툴체인 폴더 스캔). 켤 때마다 불러도 된다.
 *  ★"깔려 있다"와 "몰 수 있다"는 다르다 — 목록에는 다 보이되 `drivable` 인 것만 고를 수 있다.
 *    스트림 파싱이 지금은 클로드 코드 하나뿐이라서다.
 *  ★로그인 여부는 **돌려 봐야 안다.** 그래서 「연결 시험」은 사용자가 누를 때만 돈다
 *    (돈이 든다 — 실측 $0.15). 자동으로 돌리지 않는다. */

export type CliItem = {
  id: string;
  label: string;
  installed: boolean;
  path: string | null;
  drivable: boolean;
  /** 그 CLI 가 받는 모델 이름 — ★목록은 **백엔드가** 준다 (코덱스는 자기 캐시에서 읽는다) */
  models: string[];
};

const KEY = "peropix.engine";
/** ★CLI 도 모델·추론 강도를 고른다 (사용자 지적 2026-08-08 — API 쪽에만 있었다).
 *  `claude --model <별칭|전체이름>` · `claude --effort <단계>` 를 그대로 넘긴다.
 *
 *  ★**언제나 넘긴다 — 기본은 `sonnet` · `high`** (사용자 결정 2026-08-08).
 *    예전엔 "안 넘기면 CLI 기본값"이라는 선택지를 뒀는데, 그 값은 사용자가 **자기 쓰려고**
 *    맞춰 둔 전역 설정(`~/.claude/settings.json`)이라 이 앱의 조수 일과는 상관이 없다
 *    (실제로 `opus[1m]`·`max` 였다 — 카드 정리에 그것을 쓸 이유가 없다).
 *    같은 바이너리·같은 계정을 쓰되 **용도는 갈라야** 해서, 여기서 정하고 사용자가 바꾼다. */
const CLI_EFFORT_DEFAULT = "high";
/** 처음 골라 줄 모델 — ★**목록의 첫 번째가 아니다** (사용자 결정 2026-08-15).
 *  코덱스 목록의 첫 자리는 `gpt-5.6-sol` 인데 사용자 구독으로 고를 수 있는 것이 아니다.
 *  여기 이름이 목록에 없으면 목록의 첫 번째로 물러난다 (저쪽이 모델을 내렸을 때). */
const MODEL_DEFAULT: Record<string, string> = {
  "claude-code": "sonnet",
  codex: "gpt-5.6-terra",
};
/** ★모델은 **CLI 마다 다르다** — 고른 것에 맞춰 따로 기억한다. 하나로 두면 코덱스를
 *  골라 놓고 `sonnet` 이 남아 있게 된다 (코덱스가 못 받는 이름이다). */
const MODEL_KEY = (agent: string) => `peropix.cliModel:${agent}`;
const EFFORT_KEY = "peropix.cliEffort";
const AGENT_KEY = "peropix.cliAgent";
/** 추론 강도 — ★두 CLI 가 **같은 다섯**을 쓴다 (실측: `claude --help` 2026-08-08 ·
 *  코덱스 `models_cache.json` 의 `supported_reasoning_levels` 2026-08-15). */
export const CLI_EFFORTS = ["max", "xhigh", "high", "medium", "low"];
const readStr = (k: string) => {
  try {
    return localStorage.getItem(k) ?? "";
  } catch {
    return "";
  }
};
const writeStr = (k: string, v: string) => {
  try {
    if (v) localStorage.setItem(k, v);
    else localStorage.removeItem(k);
  } catch {
    /* 저장 못 해도 이번 실행에는 그대로 돈다 */
  }
};

type S = {
  /** 어느 엔진으로 대화하나 — API 키(BYOK) 또는 로컬 CLI */
  engine: "api" | "cli";
  /** 모델 이름 (언제나 넘긴다). ★고른 CLI 것이다 */
  model: string;
  /** 추론 강도 (언제나 넘긴다) */
  effort: string;
  /** ★★**앱 밖 도구(파일·셸·웹) 허용** — 기본 켬 (사용자 결정 2026-09-07, 자유도 우선).
   *  끄면 예전 잠금이다: 우리 MCP 도구만 열고 나머지는 이름으로 닫는다 (`backend/cliagent.py`). */
  open: boolean;
  setOpen: (v: boolean) => void;
  setModel: (v: string) => void;
  setEffort: (v: string) => void;
  items: CliItem[];
  scanning: boolean;
  /** 고른 CLI 의 실행 파일 경로 */
  exe: string | null;
  /** 고른 CLI 의 id — ★백엔드가 어느 모양의 깃발을 쓸지 이것으로 정한다 */
  agent: string;
  /** 고른 CLI 가 받는 모델 목록 (탐지 전에는 비어 있다) */
  models: () => string[];
  setEngine: (e: "api" | "cli") => void;
  detect: () => Promise<void>;
  pick: (id: string) => void;
  /** 지금 고른 것이 실제로 돌 수 있는 상태인가 */
  ready: () => boolean;
};

/** ★기본은 **CLI** 다 (사용자 결정 2026-08-08). 구독으로 도는 쪽이라 처음 켠 사람이
 *  키 없이 바로 쓸 수 있고, 토큰 요금도 안 나온다. API 는 골라야 켜진다. */
const load = (): "api" | "cli" => {
  try {
    return localStorage.getItem(KEY) === "api" ? "api" : "cli";
  } catch {
    return "cli";
  }
};

/** ★골라 둔 CLI 는 **껐다 켜도 남는다.** 몰 수 있는 것이 둘이 된 뒤로는 안 그러면
 *  코덱스를 골라도 다음 실행에 클로드 코드로 되돌아간다 (목록의 첫 번째라서). */
const loadAgent = () => readStr(AGENT_KEY) || "claude-code";

/** 아직 탐지 전이거나 모르는 CLI 일 때 돌려줄 빈 목록 — ★**하나를 돌려 써야 한다** (위 주석) */
const NO_MODELS: string[] = [];

/** 고른 CLI 를 자리에 앉힌다 — 경로·id·모델이 **함께** 바뀌어야 한다.
 *
 *  ★모델은 그 CLI 가 받는 이름이어야 한다. 기억해 둔 값이 목록에 없으면(CLI 를 바꿨거나
 *    저쪽이 모델을 내렸거나) 우리 기본값으로, 그것도 없으면 목록의 첫 번째로 물러난다. */
function seat(it: CliItem) {
  writeStr(AGENT_KEY, it.id);
  const kept = readStr(MODEL_KEY(it.id));
  const fallback = MODEL_DEFAULT[it.id] ?? "";
  const model = it.models.includes(kept)
    ? kept
    : it.models.includes(fallback)
      ? fallback
      : (it.models[0] ?? "");
  return { agent: it.id, exe: it.path, model };
}

/** 앱 밖 도구 허용 — ★**끈 것만** 적는다 ("0"). 값이 없으면 켜진 것이다 (기본 켬). */
const OPEN_KEY = "peropix.cliOpen";

export const useCli = create<S>((set, get) => ({
  engine: load(),
  agent: loadAgent(),
  model: readStr(MODEL_KEY(loadAgent())),
  effort: readStr(EFFORT_KEY) || CLI_EFFORT_DEFAULT,
  open: readStr(OPEN_KEY) !== "0",
  setOpen(v) {
    writeStr(OPEN_KEY, v ? "" : "0");
    set({ open: v });
  },
  setModel(v) {
    writeStr(MODEL_KEY(get().agent), v);
    set({ model: v });
  },
  setEffort(v) {
    writeStr(EFFORT_KEY, v);
    set({ effort: v });
  },
  items: [],
  scanning: false,
  exe: null,

  // ★★빈 값은 **고정 상수**여야 한다. 여기서 `?? []` 로 새 배열을 만들면 셀렉터가 매번
  //   다른 것을 돌려주고, zustand v5 는 그것을 "바뀌었다"로 보아 **무한 렌더**에 빠진다
  //   (실측 2026-08-15: AI 탭을 여는 순간 화면이 통째로 사라졌다. CLAUDE.md 「잊기 쉬운 것」).
  models: () => get().items.find((x) => x.id === get().agent)?.models ?? NO_MODELS,

  setEngine(e) {
    try {
      localStorage.setItem(KEY, e);
    } catch {}
    set({ engine: e });
    if (e === "cli" && !get().items.length) void get().detect();
  },

  async detect() {
    set({ scanning: true });
    try {
      const r = await api<{ items: CliItem[] }>("/api/cli/detect");
      const items = r.items ?? [];
      // 기억해 둔 것을 먼저 찾고, 못 쓰면 **몰 수 있는 것 중 깔린 첫 번째**를 잡아 준다
      const usable = (x?: CliItem) => !!x && x.installed && x.drivable;
      const want = items.find((x) => x.id === get().agent);
      const it = usable(want) ? want! : items.find((x) => usable(x));
      set({ items, ...(it ? seat(it) : { exe: null }) });
    } catch {
      set({ items: [] });
    } finally {
      set({ scanning: false });
    }
  },

  pick(id) {
    const it = get().items.find((x) => x.id === id);
    if (it?.installed && it.drivable) set(seat(it));
  },

  ready: () => !!get().exe,
}));
