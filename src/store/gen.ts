import { create } from "zustand";
import { compileBlocks } from "../lib/blocks";
import { backendUrl } from "../lib/backend";
import { usePrompt } from "./prompt";
import { allCells, allScenes, onBeforeWsSwitch, useWs } from "./workspace";
import { useQueue } from "./queue";
import { useImageInput } from "./imageInput";
import { useUi } from "./ui";
import { sizeForBase } from "../lib/baseSize";
import { toast } from "./toast";
import { t } from "../i18n";

// 시드 규칙은 `lib/seedRounds.ts` 하나뿐이다 (거기 머리 주석)
import { randomSeed, rounds, type SeedMode } from "../lib/seedRounds";
// ★와일드카드 추첨은 **장 하나마다** 돈다 (`lib/wildcards.ts` 머리 주석).
//   요청을 만들 때 한 번만 풀면 한 배치가 통째로 같은 태그로 나온다. 기능이 조용히 사라진다.
import { resolveShot } from "../lib/wildcards";
import { wildcardPools } from "./wildcards";
export { randomSeed, rounds, SEED_MODES, type SeedMode } from "../lib/seedRounds";

export type GenParams = {
  model: string;
  width: number;
  height: number;
  steps: number;
  cfg: number;
  sampler: string;
  scheduler: string;
  seed: number;
  /** NAI 의 Guidance Rescale. 0~1 */
  cfg_rescale: number;
  uc_preset: string;
  /** 퀄리티 프리셋 id — `"standard"` / `"light"`(V5·custom) / `"none"`.
   *  ★★공홈이 켬/끔에서 **목록**으로 바뀌어 따라간 것이다 (2026-08-21).
   *    고를 수 있는 값은 모델마다 다르다 (`lib/naiModels.ts` 의 `quality_presets`). */
  quality_preset: string;
  variety_plus: boolean;
  /** 투명 배경 (V5 전용) — 프롬프트에 `transparent background` 가 붙고 알파가 살아 나온다.
   *  ★지원하지 않는 모델에서는 화면에도 안 보이고 서버도 무시한다 (`nai.caps`). */
  transparent_bg: boolean;
  /** 프롬프트 앞에 `fur dataset, ` 를 붙인다 */
  furry_mode: boolean;
  /** 저장 포맷 — png | jpg | webp */
  save_format: string;
  /** JPG/WebP 품질 (1~100) */
  jpg_quality: number;
  /** ★켜면 알파 LSB 스테가노그래피까지 지운다 (backend/meta.strip) */
  strip_metadata: boolean;
  /** ★끄면 **파일로 안 남기고 미리보기만** 한다 (v2 `auto_save`).
   *  마음에 드는 것만 골라 저장하고 싶을 때 쓴다. 끈 동안 만든 것은 **기록에도 안 남는다** —
   *  그래서 씬 칸·갤러리에는 안 뜨고 캔버스의 미리보기 자리에만 뜬다. */
  auto_save: boolean;
  /** ★켜면 파일 이름 앞의 **씬 번호를 뺀다** (v2 `exclude_slot_number`).
   *  번호는 탐색기에서 씬 순서를 만드는 것이라, 순서가 필요 없을 때만 끈다.
   *  ★★**빼는 것은 번호뿐이고 씬 이름은 남는다** (v2 와 같다 — 사용자 결정 2026-08-18,
   *    v2-port-audit D3). 규칙은 `backend/workspace.py` 의 `file_lead` 가 정본이다. */
  exclude_slot_number: boolean;
  /** 시드를 **언제 새로 뽑나** — ★셋 중 하나다 (v2 의 `랜덤/고정/슬롯마다 랜덤` 이관).
   *
   *  ★체크박스 둘로 두지 않는다 (사용자 지적 2026-08-11): 「고정」과 「씬마다 랜덤」을
   *    함께 켜면 무슨 뜻인지 알 수 없다. 배타적 3택이라 그런 상태가 아예 없다.
   *
   *  - `fixed`  숫자칸 그대로. 켜져 있어도 숫자는 남으므로 언제든 되돌아온다
   *  - `round`  **한 바퀴에 시드 하나** — 그 바퀴의 씬들이 같은 조건이라 서로 견줄 수 있다
   *  - `scene`  같은 바퀴 안에서도 씬마다 새로 뽑는다 */
  seed_mode: SeedMode;
  /** 캐릭터 좌표를 **쓰는가** — 끄면 NAI 가 알아서 배치한다 (공홈의 "AI's choice").
   *
   *  ★★공홈과 같이 **요청 하나에 하나**다 (인물마다 켜고 끄지 않는다). 좌표 자체는
   *    꺼져 있어도 인물마다 남아 있고, 여기만 다시 켜면 그 자리로 돌아온다.
   *  ★배치 판에서 인물을 옮기면 **자동으로 켜지고**, 이걸 끄면 배치 판이 닫힌다
   *    (`panels/CharPositioner`). 공홈 `sk()` 와 같은 규칙이다. */
  use_coords: boolean;
};

/** 모델 목록·능력표는 **`lib/naiModels.ts` 하나**다 (그 파일 머리 주석).
 *  화면이 「이 모델에서 되는 것만」 보이게 하는 근거라, 여기 사본을 두지 않는다. */
export { MODELS, caps as modelCaps, type ModelCaps } from "../lib/naiModels";
// ★담아 둔 모델을 검사하려면 값이 **이 모듈 안**에도 있어야 한다 (re-export 만으로는 못 쓴다)
import { MODELS as MODEL_LIST, caps as capsOf } from "../lib/naiModels";

/** v2 의 Size 드롭다운 그대로. ✦ 는 NAI 가 기본 요금으로 처리하는 해상도 */
/** 크기 프리셋 — ★**v2 목록 그대로**다 (`index.html` 의 `sizePreset`, 대조 2026-08-16).
 *  세 번째 값(`★`)은 **NAI 공홈에 있는 것**이라는 표시다 (공홈 v4 프리셋 표).
 *  ★Small·Large·Wallpaper 가 통째로 빠져 있었다 — 옮기다 만 자리였다. */
export const SIZE_PRESETS: { group: string; items: [number, number, boolean][] }[] = [
  { group: "landscape", items: [[1536, 640, false], [1344, 768, false], [1216, 832, true], [1152, 896, false]] },
  { group: "square", items: [[1024, 1024, true]] },
  { group: "portrait", items: [[896, 1152, false], [832, 1216, true], [768, 1344, false], [640, 1536, false]] },
  { group: "small", items: [[768, 512, true], [640, 640, true], [512, 768, true]] },
  { group: "large", items: [[1536, 1024, true], [1472, 1472, true], [1024, 1536, true]] },
  { group: "wallpaper", items: [[1920, 1088, true], [1088, 1920, true]] },
];

/** ★NAI 가 받는 범위. 넘기면 400 이 온다 (v2 enforceNaiLimits, index.html:14476) */
export const NAI_MAX = { steps: 50, cfg: 10 };


/** ★NAI 는 64 배수 해상도만 받는다. 식은 `lib/align.ts` 하나뿐이다 —
 *  화면과 서버가 다른 식을 쓰면 표시 해상도·Anlas 가 실제 청구와 어긋난다. */
export { alignTo64 } from "../lib/align";

/** 베이스 그림을 넣었을 때 **해상도를 그 그림에 맞춘다** — 공홈이 하는 그대로다
 *  (`lib/baseSize` 머리 주석). 잠그지 않는다: 값만 채우고 사용자가 바꿀 수 있다.
 *
 *  ★이 단계가 없으면 전송 직전 리샘플이 **비율을 무시하고 늘려** 그림이 눌린다.
 *    3.0 에 통째로 빠져 있던 자리다 (실측 2026-08-13).
 *  ★바꿨으면 **알린다** — 말없이 숫자가 바뀌면 사용자가 자기가 고른 값을 잃었다고 느낀다. */
export async function fitSizeToBase(b64: string): Promise<void> {
  const size = await new Promise<{ w: number; h: number } | null>((res) => {
    const im = new Image();
    im.onload = () => res({ w: im.naturalWidth, h: im.naturalHeight });
    im.onerror = () => res(null);
    im.src = "data:image/png;base64," + b64;
  });
  if (!size) return;
  const next = sizeForBase(size.w, size.h);
  const cur = useGen.getState().params;
  // ★이미 그 값이면 아무 말도 하지 않는다 — 바뀐 게 없는데 알리면 소음이다
  if (!next || (next.width === cur.width && next.height === cur.height)) return;
  useGen.setState({ params: { ...useGen.getState().params, ...next } });
  // ★바꿨으면 **어디가 바뀌었는지 보여 준다** (사용자 지시 2026-08-13) —
  //   우측 패널을 펴고 해상도 자리를 잠깐 강조한다
  useUi.getState().reveal("right", "size");
  toast(t("imgIn.sizeFitted", { w: String(next.width), h: String(next.height) }));
}

/** 처음 시작할 때의 모델이자, 목록에 없는 모델을 만났을 때 되돌릴 값.
 *
 *  ★**목록의 첫 줄을 가리키지 않는다** — 드롭다운 순서는 「새것이 위」라 바뀌는데,
 *    거기에 매어 두면 새 모델이 나올 때마다 폴백이 조용히 따라 움직인다.
 *  ★V5 Full (사용자 지시 2026-08-23). 그전에는 V4.5 Full 이었다. */
export const DEFAULT_MODEL = "nai-diffusion-5-full";

/** 캐릭터에 좌표 사용 여부를 실어 준다.
 *
 *  ★`use_coords` 는 요청 하나에 하나인데(공홈과 같다) 백엔드는 인물마다 받아
 *    `any(c.use_coord)` 로 다시 모은다 (`backend/nai.py`). 그래서 **전원에게 같은 값**을
 *    준다 — 여기서 갈리면 원장이 둘이 된다. */
const withCoords = <C extends object>(chars: C[], on: boolean): (C & { use_coord: boolean })[] =>
  chars.map((c) => ({ ...c, use_coord: on }));

const DEFAULT_PARAMS: GenParams = {
  model: DEFAULT_MODEL,
  width: 832,
  height: 1216,
  steps: 28,
  cfg: 5,
  sampler: "k_euler_ancestral",
  scheduler: "karras",
  // ★처음부터 **구체적인 숫자**다 — `-1` 이면 재현할 값이 화면에 없다 (페로픽스파이와 같다)
  seed: Math.floor(Math.random() * 4294967295),
  cfg_rescale: 0,
  uc_preset: "Heavy",
  quality_preset: "standard",
  variety_plus: false,
  transparent_bg: false,
  furry_mode: false,
  save_format: "png",
  jpg_quality: 95,
  strip_metadata: false,
  auto_save: true,
  exclude_slot_number: false,
  seed_mode: "round",
  use_coords: false,
};

/** 생성 옵션을 담아 두는 열쇠 — ★**통째로** 담는다 (필드 목록을 따로 적지 않는다).
 *
 *  ★★`useUi` 는 저장할 필드를 손으로 적어 두는데, 필드를 늘리고 목록에 안 더해서
 *    「켜 놓아도 껐다 켜면 기본값」이 된 적이 있다 (감사 2026-08-16). 여기서는 같은 덫을
 *    안 만들려고 **객체를 통째로** 담고, 읽을 때 기본값에 있는 열쇠만 골라 받는다. */
const PARAMS_KEY = "peropix.gen.params.v1";

/** 담아 둔 옵션 — ★기본값에 **있는 열쇠**만, **같은 타입**일 때만 받는다.
 *
 *  ★스키마가 바뀌어도 조용히 깨지지 않는다: 없어진 열쇠(`quality_tags`)는 버려지고,
 *    새로 생긴 열쇠(`quality_preset`)는 기본값이 채운다.
 *  ★목록에서 사라진 모델은 기본 모델로 되돌린다 — 안 그러면 화면은 기본값을 보여 주는데
 *    **보내는 값은 옛 모델**이라 둘이 어긋난다 (`OptionsPanel` 의 폴백과 같은 규칙). */
function loadParams(): GenParams {
  const out: GenParams = { ...DEFAULT_PARAMS };
  try {
    const raw = localStorage.getItem(PARAMS_KEY);
    if (!raw) return out;
    const saved = JSON.parse(raw) as Record<string, unknown>;
    for (const k of Object.keys(DEFAULT_PARAMS) as (keyof GenParams)[]) {
      const v = saved[k];
      if (v !== undefined && typeof v === typeof DEFAULT_PARAMS[k]) {
        (out as Record<string, unknown>)[k] = v;
      }
    }
  } catch {}
  if (!MODEL_LIST.some(([id]) => id === out.model)) out.model = DEFAULT_MODEL;
  return out;
}

type S = {
  params: GenParams;
  set: <K extends keyof GenParams>(k: K, v: GenParams[K]) => void;
  /** 세트 탭에서 지금 보고 있는 셀 (싱글이면 null) */
  cell: string | null;
  setCell: (c: string | null) => void;
  current: string | null;
  select: (file: string | null) => void;
  busy: boolean;
  error: string;
  base: string;
  init: () => Promise<void>;
  generateAll: () => Promise<void>;
};

export const useGen = create<S>((set, get) => ({
  params: loadParams(),
  set: (k, v) => set({ params: { ...get().params, [k]: v } }),
  cell: null,
  setCell: (c) => set({ cell: c }),
  current: null,
  select: (file) => set({ current: file }),
  busy: false,
  error: "",
  base: "",

  async init() {
    set({ base: await backendUrl() });
    watchTabParams();   // ★탭마다 다른 생성 옵션 (위 ★★주 — 최상위에서 매달면 죽는다)
  },

  async generateAll() {
    const ws = useWs.getState();
    const tab = ws.activeSceneGroup();
    if (!tab || tab.kind !== "sceneGroup") return;
    // ★락은 **생성에서 뺀다** (v2 슬롯의 락). 지운 것이 아니라 이번에만 건너뛴다.
    // ★공통 접두는 **카드마다 다르다** (2026-08-11) — 그래서 씬을 카드와 함께 편다.
    const all = allScenes(tab);
    const live = all.filter((x) => !x.cell.locked && !x.card.locked);
    if (!live.length) {
      /* ★눌렀는데 **조용히 아무 일도 안 일어나면** 고장으로 보인다 (v2 `index.html:15905`).
         까닭이 둘이라 말도 둘이다:
           · 씬은 있는데 **전부 잠김** — 잠금을 풀라고 한다.
           · 씬이 **아예 없음** — 새 탭·새 워크스페이스의 기본값이 그렇다(2026-08-20).
             예전에는 기본으로 씬 하나가 박혀 있어 이 경우가 드물었지만, 이제는 **처음 화면**
             이라 아무 말도 없으면 생성 단추가 죽은 것으로 읽힌다. */
      toast(t(all.length ? "gen.allLocked" : "gen.noScenes"), "warn");
      return;
    }

    const raw = usePrompt.getState().compiled();
    const pools = wildcardPools();
    // ★요청 레벨은 **대표값(폴백)** 이다. 실제로 쓰이는 것은 항목마다 다시 뽑은 값이다
    //   (v2 `index.html:16080`).
    const { uc, chars } = resolveShot(pools, raw);
    /** 씬 번호(1부터) — ★카드를 가로질러 **탭 안에서** 센다. 파일 이름 앞에 붙는 번호라
     *  카드마다 1로 되돌아가면 탐색기에서 같은 번호가 여럿이 된다. */
    const order = allCells(tab);
    // ★큐로 보낸다 — 한 장씩 await 하면 중간에 앱을 닫거나 새로고침하면 나머지가 사라진다.
    //   큐는 백엔드가 들고 있어 재연결로 복원된다 (store/queue.ts).
    await useQueue.getState().enqueue(
      {
        ...get().params,
        ...useImageInput.getState().payload(),
        workspace: ws.current,
        tab: ws.activeTabOf()?.name ?? null,
        scene_group: tab.name,
        scene_group_id: tab.id,
        negative_prompt: uc,
        characters: withCoords(chars, get().params.use_coords),
      },
      // ★**바퀴를 여기서 편다** (2026-08-11). 예전에는 씬 목록만 보내고 장 수는 서버가
      //   펼쳤는데(`qb.count`), 그러면 "한 바퀴에 시드 하나"를 표현할 수가 없다.
      //   여기서 펴면 순서와 시드가 둘 다 정확해진다.
      rounds(Math.max(1, useUi.getState().perSlot), get().params, live, ({ cell: c }, seed) => {
        // ★씬 프롬프트가 **payload 의 어디로** 들어가나 — 탭의 선택 하나가 정한다.
        //   `base` 면 top-level prompt 에, 캐릭터 id 면 그 사람의 `characterPrompts[]` 에 붙는다.
        //   ★고른 캐릭터가 목록에 없으면(꺼짐·삭제) base 로 떨어진다 — 조용히 사라지지 않게.
        const scene = compileBlocks(c.blocks);
        // ★목적지는 **셋**이다 — base · 캐릭터 한 명 · **캐릭터 전원**(`"all"`).
        //   「전원」은 v2 의 `promptTarget === "char"` 이다 (`backend.py:2803-2833`): 그쪽은
        //   씬 태그를 **켜진 캐릭터 전부**의 프롬프트에 이어 붙였다.
        //   ★켜진 캐릭터가 **둘 이상일 때만** 뜻이 있다 (한 명이면 그 사람을 고르는 것과 같다) —
        //     화면도 그때만 선택지를 낸다(`SceneLane`). 조건이 깨지면 base 로 떨어진다.
        const dest =
          tab.sceneDest === "all" && raw.chars.length > 1
            ? "all"
            : raw.chars.some((ch) => ch.id === tab.sceneDest)
              ? tab.sceneDest
              : "base";
        const toChar = dest !== "base";
        // ★★**이 장의 추첨**이다. 회차마다·씬마다 따로 뽑히며, 이 한 줄이 와일드카드의
        //   존재 이유다 (`docs/v2-feature-catalog.md:477`: 한 번만 풀면 전 이미지가 굳는다).
        //   ★푸는 것은 **이어 붙인 뒤**다. `#이름` 은 나타날 때마다 따로 뽑히므로 결과가 같고,
        //     접두·캐릭터·씬을 따로 풀던 v2 보다 자리가 하나로 모인다.
        const shot = resolveShot(pools, {
          // 베이스 + 이 씬의 블록들 순서로 잇는다.
          // ★씬도 블록이라 **켜진 블록만** 들어간다 — 프롬프트 쪽과 같은 규칙이다
          // ★카드 공통 접두는 걷었다 (2026-08-21) — 같은 것을 붙이려면 베이스 블록을 쓴다
          prompt: [raw.prompt, toChar ? "" : scene].filter(Boolean).join(", "),
          uc: raw.uc,
          chars: toChar
            ? raw.chars.map((ch) =>
                (dest === "all" || ch.id === dest) && scene
                  ? { ...ch, prompt: [ch.prompt, scene].filter(Boolean).join(", ") }
                  : ch,
              )
            : raw.chars,
        });
        return {
          cell: c.name,
          cell_id: c.id,
          // ★씬 번호(1부터) — 파일 이름 앞에 붙어 탐색기에서 순서를 만든다.
          //   ★잠긴 씬을 뺀 뒤의 순번이 아니라 **탭에서의 자리**여야 번호가 안 흔들린다
          cell_no: order.findIndex((x) => x.id === c.id) + 1,
          seed,
          prompt: shot.prompt,
          negative_prompt: shot.uc,
          characters: withCoords(shot.chars, get().params.use_coords),
          // ★★**이 장을 뽑는 화면 구조를 그대로 남긴다** (사용자 지시 2026-08-19).
          //   「새 탭으로 복제」가 이것으로 환경을 되살린다 — PNG 메타데이터에는 **합쳐진
          //   문자열**만 남아 스타일 카드·블록 나눔·캐릭터 카드를 못 되살리기 때문이다.
          //   ★남겨 두면 나중에 그 탭을 고치거나 지워도 **그때 환경 그대로** 복제된다.
          //   ★여기 담는 것은 **`generateAll` 이 읽는 것 전부**여야 한다 (회귀 `cloneEnv.test.ts`).
          //     그림 바이트는 안 담는다 — 구조뿐이라 작다.
          env: {
            prompt: usePrompt.getState().snapshot(),
            sceneDest: tab.sceneDest,
            cell: { name: c.name, blocks: c.blocks },
          },
        };
      }),
      1,
    );
    if (get().params.seed_mode !== "fixed") get().set("seed", randomSeed());
  },
}));

/* ── 캐릭터 **활성화 수** 상한 ─────────────────────────────────────────────
 *
 *  ★★모델마다 받는 캐릭터 수가 다르다 (V4.5 6명 · V5 32명). 넘겨서 보내면 NAI 가
 *    400 이 아니라 **500** 을 준다 — 사용자는 까닭을 알 수 없다.
 *  ★★막는 자리는 **켜는 순간**이다 (사용자 지시 2026-08-21, v2 와 같은 방식).
 *    예전에는 넘은 채로 두고 「초과분은 무시됩니다」를 띄웠는데, 그대로 생성하면
 *    뒤쪽 캐릭터가 조용히 빠진다. **칸을 만드는 것 자체는 막지 않는다** — 꺼진 채로 들어온다.
 *  ★이 규칙이 여기 있는 이유: 상한은 **모델**이 정하고 모델은 이 스토어가 갖는다.
 *    `prompt.ts` 는 모델을 모른다 (거기서 읽으면 두 스토어가 서로를 가리키게 된다).
 */
export const charLimit = () => capsOf(useGen.getState().params.model).max_characters;

/** 지금 하나 더 켤 수 있나 */
export const canEnableChar = () =>
  usePrompt.getState().chars.filter((c) => c.on).length < charLimit();

/** 켜기 — 상한에 닿으면 켜지 않고 알린다. 끄기는 언제나 된다. */
export function toggleCharCapped(id: string) {
  const p = usePrompt.getState();
  const ch = p.chars.find((c) => c.id === id);
  if (ch && !ch.on && !canEnableChar()) {
    toast(t("gen.charLimitHit", { max: charLimit() }), "warn");
    return;
  }
  p.toggleChar(id);
}

/** ★상한이 **줄어드는 순간**(모델 전환)에 넘은 것을 뒤에서부터 끈다.
 *  넘은 상태 자체를 두지 않으므로 「초과분은 무시됩니다」 같은 경고가 필요 없다. */
export function clampCharsToModel() {
  const limit = charLimit();
  const over = usePrompt.getState().chars.filter((c) => c.on).slice(limit);
  if (!over.length) return 0;
  // ★`setState` 로 직접 갈아 끼우지 말 것 — 스토어 액션을 거쳐야 **저장이 예약된다**
  //   (`prompt.ts` 의 `onEdit`). 직접 쓰면 화면만 바뀌고 워크스페이스에는 안 남는다.
  for (const c of over) usePrompt.getState().toggleChar(c.id);
  toast(t("gen.charLimitClamped", { max: limit, n: over.length }), "warn");
  return over.length;
}

/** ★★**바뀌는 자리가 여럿이라** `set()` 이 아니라 스토어를 구독한다 —
 *  메타데이터 적용(`metaApply`)·베이스 그림 크기 맞춤(`fitSizeToBase`)·이미지 입력도
 *  `params` 를 직접 갈아 끼운다. 한 곳만 잡으면 나머지가 조용히 안 담긴다.
 *  ★250ms 미룬다 — 숫자칸을 타이핑하면 글자마다 바뀐다. */
let saveTimer: ReturnType<typeof setTimeout> | undefined;
/** ★★**생성 옵션은 탭마다 따로다** (사용자 지시 2026-08-22).
 *  ★여기서 「탭」은 **위 줄의 `새 탭`**(`spec.tabs`·`activeTab`)이지, 캔버스 바로 위의
 *    「세트」(`spec.sceneGroups`·`activeTab`)가 아니다. 정본은 `CLAUDE.md` 「워크스페이스 탭」 절.
 *    한 탭 아래의 세트들은 같은 인물의 다른 포즈 묶음이라 수치를 같이 쓴다.
 *
 *  예전에는 앱 전역이라, 다른 탭에서 만지다 돌아오면 **앞 탭의 값을 물고 있어** 같은 탭인데
 *  결과가 달라졌다. 프롬프트는 이미 탭이 들고 있었는데 수치만 전역이었다.
 *
 *  ★담고 꺼내는 것을 **여기서** 한다: `workspace.ts` 는 이 파일을 값으로 못 부른다 (순환) —
 *    거기에는 담아 두는 칸(`SceneGroup.gen`)과 그 칸에 쓰는 길(`stashGen`)만 뒀다.
 *  ★★**최상위에서 매달지 말 것.** 두 파일이 서로를 부르므로, 모듈이 실릴 때 매달면
 *    `useWs` 가 아직 만들어지기 전이라 **앱이 죽는다**
 *    (실측 2026-08-22: `Cannot access 'useWs' before initialization`).
 *    부팅에서 한 번(`init`) 매단다 — 그때는 두 파일이 다 실려 있다.
 *  ★**떠날 때 담고, 와서 꺼낸다.** 담아 둔 것이 없는 탭(옛 워크스페이스·새 탭)은 지금 값을
 *    그대로 쓰고, 처음 떠날 때 담긴다 — 갑자기 값이 바뀌지 않는다.
 *  ★localStorage 는 **새 탭의 출발값**으로 남는다 (마지막으로 쓰던 값). */
let watching = false;
let lastSpot: string | null = null;
function watchTabParams() {
  if (watching) return;
  watching = true;

  /* ★★**워크스페이스를 옮기기 직전**에 지금 탭에 담는다 (사용자 지시 2026-08-23:
     *"워크스페이스는 각각이 개별 작업공간임"*). 아래 구독으로는 못 담는다 — 그때는
     `spec` 이 이미 새 워크스페이스 것으로 갈려 있어서, 담으면 **남의 탭에** 쓰게 된다.
     그래서 예전에는 아예 건너뛰었고, 옮겼다 돌아오면 고친 수치가 사라져 있었다. */
  onBeforeWsSwitch(() => {
    const id = useWs.getState().spec?.activeTab;
    if (id) useWs.getState().stashGen(id, useGen.getState().params);
  });

  useWs.subscribe((s) => {
    const spec = s.spec;
    const id = spec?.activeTab;
    // ★워크스페이스 이름까지 묶는다 — 다른 워크스페이스의 같은 탭 id 에 담으면 안 된다
    const spot = spec && id ? `${s.current ?? ""}::${id}` : null;
    if (spot === lastSpot) return;
    const prev = lastSpot;
    lastSpot = spot;
    const sameWs = !!prev && prev.split("::")[0] === (s.current ?? "");
    if (sameWs) {
      useWs.getState().stashGen(prev.split("::").slice(1).join("::"), useGen.getState().params);
    }
    const tab = spec?.tabs?.find((c) => c.id === id);
    if (tab?.gen) {
      useGen.setState({ params: { ...DEFAULT_PARAMS, ...tab.gen } });
    } else if (!sameWs) {
      /* ★★**워크스페이스가 바뀌었는데 담아 둔 것이 없으면 기본값으로 간다**
         (사용자 지시 2026-08-23: *"생성 옵션 쪽은 워크스페이스 간에 연동되는 게 하나도
         없어야 한다"*). 예전에는 지금 값을 그대로 썼는데, 그러면 시드·시드 모드·모델·
         해상도가 통째로 따라와 다른 작업 공간의 값으로 생성이 나갔다.
         ★같은 워크스페이스 안에서 탭을 옮길 때는 **그대로 둔다** — 거기서는 값이 갑자기
           바뀌지 않는 것이 맞다 (새 탭은 하던 값으로 시작한다). */
      useGen.setState({ params: { ...DEFAULT_PARAMS } });
    }
    if (!sameWs) {
      // ★베이스 그림·바이브·레퍼런스도 워크스페이스를 안 넘는다 (같은 이유)
      useImageInput.getState().resetAll();
    }
  });
}

useGen.subscribe((s, prev) => {
  if (s.params === prev.params) return;
  // ★모델이 바뀌면 상한도 바뀐다 — 줄어든 쪽이면 그 자리에서 초과분을 끈다
  if (s.params.model !== prev.params.model) clampCharsToModel();
  /* ★★**바뀔 때마다 지금 탭에도 담는다** (사용자 지시 2026-08-31).
     예전에는 **탭을 떠날 때만** 담았다. 그래서 탭 하나로만 쓰는 사용자는 담기는 순간이
     아예 없었고, 앱을 껐다 켜면 부팅이 `tab.gen`(마지막으로 떠났을 때의 값)으로
     localStorage 를 덮어 **매번 되돌아갔다** (제보 2026-08-31: *"STEPS, Prompt Guidance,
     Prompt Guidance Rescale 값이 자꾸 초기화됩니다"*). 프롬프트는 이미 자동 저장마다
     담기고 있었다 (`workspace.save` 의 `stash`) — 수치만 빠져 있던 자리다.
     ★**미루지 않고 그 자리에서** 담는다: 파일 쓰기는 `stashGen` 안에서 이미 묶이고
       (`queueSave`, 400ms), 여기서 또 미루면 늦게 깨어나 **남의 탭에** 쓸 수 있다. */
  const tabId = useWs.getState().spec?.activeTab;
  if (tabId) useWs.getState().stashGen(tabId, s.params);
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      localStorage.setItem(PARAMS_KEY, JSON.stringify(useGen.getState().params));
    } catch {}
  }, 250);
});
