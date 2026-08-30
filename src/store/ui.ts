import { create } from "zustand";
import { PICK_DROP, type MetaPick } from "../lib/metaApply";
import { useEffect, useRef } from "react";

/** 모드 = 하단 네비의 자리. v2.x 의 모드 전환이 여기로 온다.
 *  싱글·세트는 모드가 아니라 캔버스 탭이므로 여기 없다. */
export type ModeId = "generate" | "gallery" | "censor" | "utility";

export const MODES: { id: ModeId; label: string; color: string }[] = [
  { id: "generate", label: "생성", color: "var(--mode-single)" },
  { id: "gallery", label: "갤러리", color: "var(--mode-gallery)" },
  { id: "censor", label: "자동검열", color: "var(--mode-censor)" },
  { id: "utility", label: "보조 도구", color: "var(--mode-utility)" },
];

const KEY = "peropix.ui";

/** 설정 창의 좌측 탭. ★`app/Settings.tsx` 가 이 이름을 그대로 쓴다 — 여는 자리마다
 *  다른 이름을 쓰면 "어느 탭이 열리나"가 흩어진다. */
export type SettingsTabId = "general" | "look" | "llm" | "keys";


/** 본문 폰트 — 넷을 번들해 두고 고른다 (styles/fonts.css). 비교해 보려고 넣은 것이다. */
export type FontId = "pretendard" | "spoqa" | "gothic" | "noto";

export const FONTS: { id: FontId; label: string; stack: string }[] = [
  { id: "pretendard", label: "Pretendard", stack: "'Pretendard Variable', Pretendard" },
  { id: "spoqa", label: "Spoqa Han Sans", stack: "'Spoqa Han Sans Neo'" },
  { id: "gothic", label: "Gothic A1", stack: "'Gothic A1'" },
  { id: "noto", label: "Noto Sans KR", stack: "'Noto Sans KR'" },
];

/** 고른 폰트를 `--font-sans` 에 꽂는다. ★폴백은 언제나 뒤에 붙인다 —
 *  번들이 아직 안 실렸을 때 글자가 사라지지 않게. */
/** 글자 크기 배율을 `<html>` 에 꽂는다 — `--text-*` 토큰 전부가 곱한다 (tokens.css 의 ★주) */
export function applyTextScale(n: number) {
  document.documentElement.style.setProperty("--text-scale", String(n));
}

export function applyFont(id: FontId) {
  const f = FONTS.find((x) => x.id === id) ?? FONTS[0];
  document.documentElement.style.setProperty(
    "--font-sans",
    `${f.stack}, "Segoe UI", "Malgun Gothic", sans-serif`,
  );
}

/** 양옆 패널의 폭 — **모드마다 따로**다.
 *
 *  ★★사용자 지적 2026-08-23: *"갤러리 좌측 폴더 트리 너비가 생성의 생성 옵션 패널 너비랑
 *    동기화되어 있음. 독립적으로 작동하게"*. 두 모드가 같은 자리에 **다른 것**을 놓는다 —
 *    왼쪽이 생성에서는 프롬프트·생성 옵션이고 갤러리에서는 폴더 트리다. 알맞은 폭도 서로
 *    다른데 값을 하나로 두어, 한쪽에서 넓히면 다른 쪽도 따라 넓어졌다.
 *  ★AI 패널은 **모드와 무관하게 늘 같은 것**이라 하나로 둔다 (`aiWidth`). */
export type PanelWidths = Record<ModeId, number>;

type Persisted = {
  leftWidth: PanelWidths;
  /** AI 채팅 패널 — ★**기본은 접힌 레일**이다 (ui-guide 7절: LLM 은 선택 사항) */
  aiWidth: number;
  aiCollapsed: boolean;
  rightWidth: PanelWidths;
  leftCollapsed: boolean;
  rightCollapsed: boolean;
  /** 무대에 한 줄로 몇 장을 놓나. ★**1이면 라이트박스**가 된다 — 한 장이 무대를 다 쓴다.
   *  크기 슬라이더를 따로 두지 않는다: 크기는 열 수에서 나온다 (하나의 정보에 하나의 창구). */
  cols: number;
  /** 씬 칸의 칸 크기 3단 (0 작게 · 1 보통 · 2 크게). ★썸네일 슬라이더를 따로 두지 않는다 */
  /** 씬 칸 한 변의 길이(px). ★3단 고정이 아니라 **연속값**이다 (사용자 지시 2026-08-14).
   *  Ctrl+휠로 조절하고, 한 번에 12% 씩 움직인다. */
  laneSize: number;
  /** 씬 줄 머리의 폭(px). 경계를 끌어 바꾼다 */
  laneHeadW: number;
  /** 씬 칸 높이 — 사용자가 손잡이로 정한다 */
  laneHeight: number;
  /** 생성 화면을 끄고 **슬롯만 모아 본다** — 선별 뒤 확인용 (사용자 결정 2026-08-04) */
  curated: boolean;
  /** ★슬롯당 몇 장 만드나 (페로픽스파이 `countPerSlot`). 한 번에 여러 장을 뽑아
   *  고르는 것이 멀티의 본래 쓰임이라, 1장씩 돌리면 같은 일을 여러 번 해야 한다. */
  perSlot: number;
  /** ★★**조수의 작업을 자동 승인한다** (사용자 결정 2026-08-24).
   *
   *  켜면 승인 카드를 안 띄우고 바로 실행한다. 끄면(기본) 되돌릴 수 있는 일까지 전부 묻는다.
   *  ★칸이 **둘인** 까닭: 이 앱에는 되돌릴 수 있는 것과 없는 것이 섞여 있다. 일상 작업은
   *    안 끊기게 하되 정말 위험한 것만 남기려면 아래 `agentAskHard` 가 함께 있어야 한다. */
  agentAuto: boolean;
  /** ★★**되돌릴 수 없는 것은 언제나 묻는다** (기본 켬). `agentAuto` 를 켜도 이건 남는다.
   *
   *  「되돌릴 수 없는 것」은 셋이다 — 카드 삭제·씬 삭제(그 자리의 되돌리기가 함께 빠진다)와
   *  **Anlas 가 나가는 생성**. ★★생성은 「생성이니까 무조건」이 아니라 **돈이 나가느냐**로
   *  가른다 (사용자 결정): Opus 무료 범위 안이면 통과시킨다. 판정은 `lib/anlas.ts` 의
   *  비용 계산을 그대로 쓴다 — 새 규칙을 만들면 두 벌이 되어 반드시 갈린다. */
  agentAskHard: boolean;
  /** ★큐가 다 끝나면 알린다 — 여러 장을 돌려 놓고 다른 일을 하다 놓치는 것을 막는다 */
  notifyDone: boolean;
  /** ★끝났을 때 **소리로도** 알린다 (v2 `notifySoundOnComplete`). 화면을 안 보고 있을 때 쓴다 */
  notifySound: boolean;
  /** 알림음 크기 1~100 (v2 `notifySoundVolume`, 기본 50) */
  notifyVolume: number;
  font: FontId;
  /** 글자 크기 배율 (0.8~1.5) — 앱 안의 모든 글자 토큰에 곱한다 (사용자 지시 2026-08-29) */
  textScale: number;
  /** 드롭 가져오기 시트의 체크 상태 — 다시 열어도 그대로 (사용자 지시 2026-08-30) */
  importPick: MetaPick;
  /** 태그 자동완성을 켜 두나 (v2 `tagAutocompleteToggle`). 끄면 목록이 아예 안 뜬다 —
   *  Enter·Esc 도 블록 것으로 되돌아간다 (`TagSuggest.onKeyDown`) */
  tagSuggest: boolean;
  /** 자동완성에서 **작가**를 고르면 앞에 `artist:` 를 단다 (사용자 지시 2026-08-28).
   *  ★끌 수 있다 — 접두어 없이 쓰는 사람도 있다. 끄면 사전 이름 그대로 들어간다. */
  artistPrefix: boolean;
  /** 가중치 강조 색 (칩·글 상자 둘 다) — 끄면 평범한 글자로 보인다 */
  weightHl: boolean;
  /** 파일 관리의 보기 — 썸네일 격자 / 이름·크기·수정일 목록 (v2 `fmViewThumbnail`·`fmViewList`) */
  fmView: "grid" | "list";
  /** 변환이 끝나면 저장한 폴더를 연다 (v2 `convertOpenFolder`, 기본 켬) */
  /** ★★**그리는 중인 그림을 보여 줄까** (사용자 지시 2026-08-26, 기본 켬).
   *  NAI 가 생성 중에 흘려 주는 프레임을 대기 칸과 큰 그림에 깐다.
   *  ★**결과는 달라지지 않는다** — 보는 방식만 달라진다. 그래서 생성 옵션(`gen.params`)이
   *    아니라 화면 설정에 둔다: 탭마다 갈릴 값이 아니고, 그림에도 안 남는다. */
  streamPreview: boolean;
  convertOpenFolder: boolean;
  /** 씬 줄의 PIP — 칸에 커서를 올리면 그 장이 떠 있는 창에 크게 뜬다 (v2 `pipModeEnabled`) */
  /** ★인핸스 창을 **마지막에 쓴 강도로** 연다 (v2 `enhanceLast`, index.html:24045).
   *  열 때마다 3 으로 되돌아가면 같은 값을 매번 다시 맞춰야 한다. 배율은 여기 없다 —
   *  그것은 원본 크기가 정한다 (`lib/enhance.ts`). */
  enhanceLast: { mag: number; adv: boolean; strength: number; noise: number };
  /** ★★**일괄 변환의 마지막 설정** (사용자 지시 2026-08-26). 열 때마다 기본값으로 되돌아가면
   *  같은 값을 매번 다시 맞춰야 한다 — 인핸스(`enhanceLast`)와 같은 사정이다.
   *  ★남기는 것은 **설정뿐**이다. 목록·진행·결과는 그 판에서 끝나는 값이라 안 남긴다.
   *  ★`start`(시작 번호)도 남긴다 — 이어서 번호를 매기는 흐름이 흔하다. 되돌리려면
   *    사용자가 그 칸에 1 을 적으면 된다 (코드가 대신 정하지 않는다). */
  convertLast: {
    fmt: string;
    strip: boolean;
    ren: boolean;
    prefix: string;
    start: number;
    pad: number;
    /** 저장 자리 — ★세 갈래다 (사용자 지시 2026-08-23). 「원본 옆에」는 걷었다:
     *  같은 폴더에 번호 붙은 사본이 쌓여 원본과 뒤섞였다. */
    mode: "overwrite" | "sub" | "folder";
    dest: string;
  };
  /** 해상도 탭(가로·세로·정방)마다 **마지막에 고른 크기** (사용자 지시 2026-08-22).
   *  탭을 누르면 목록만 갈리는 게 아니라 **그 크기가 바로 걸린다** — 세로로 뽑다가
   *  가로로 옮길 때 목록에서 한 번 더 고르지 않아도 된다. */
  sizeLast: Record<"landscape" | "portrait" | "square", [number, number]>;
  /** ★★씬 줄을 **어디에 두나** (사용자 지시 2026-08-22).
   *
   *  `bottom` 은 지금까지의 모습 — 큰 그림 아래에 가로로 눕는다.
   *  `right` 는 **세로 모드** — 큰 그림과 씬을 가운데에서 좌우로 양분한다. 세로로 긴 그림을
   *  뽑을 때 아래에 줄이 누우면 그림이 그만큼 작아지는데, 옆으로 보내면 높이를 다 쓴다. */
  laneSide: "bottom" | "right";
  /** 세로 모드에서 **씬 머리의 높이** — 아래 모드의 `laneHeadW`(폭)에 해당한다.
   *  ★값을 같이 쓰지 않는다: 폭과 높이는 다른 것이라, 한 모드에서 끌면 다른 모드가
   *    엉뚱하게 두꺼워진다 (한 창구가 두 가지를 뜻하게 된다). */
  laneHeadH: number;
  /** ★★**작업 상태** — 화면을 어떻게 펴 두었나 (사용자 지시 2026-08-22).
   *
   *  새로고침해도, 탭을 옮겨도 **그대로 남는다.** 예전에는 카테고리 접힘이 모듈 변수에만
   *  있었고(새로고침에 사라짐) 섹션 접힘·`Prompt`/`UC` 탭은 프롬프트 스토어에 있다가
   *  `load()` 가 통째로 비웠다(탭을 옮길 때마다 기본값). 「내가 펴 둔 대로」가 자꾸 풀렸다.
   *  ★값은 **화면 것**이지 문서가 아니다 — 그래서 워크스페이스 파일이 아니라 여기 산다.
   *  ★열쇠는 자리 이름이다: 카테고리 id · 섹션 id(`base` 또는 캐릭터 id). */
  view: {
    /** 좌·우 기둥의 **카테고리** 접힘 (`panels/Category` 의 `id`) */
    cat: Record<string, boolean>;
    /** 프롬프트 **섹션** 접힘 (스타일 카드·캐릭터 카드) */
    fold: Record<string, boolean>;
    /** 섹션마다 `Prompt` 를 보고 있나 `Undesired Content` 를 보고 있나 */
    tab: Record<string, "p" | "u">;
  };
  /** 세로 모드일 때 씬 쪽의 폭 (`bottom` 일 때의 `laneHeight` 에 해당) */
  laneWidth: number;
};

/** 모드마다 같은 값으로 시작한다. 넓히기 시작하면 그때부터 갈린다 */
const widths = (n: number): PanelWidths =>
  Object.fromEntries(MODES.map((m) => [m.id, n])) as PanelWidths;

const DEFAULTS: Persisted = {
  leftWidth: widths(380),
  aiWidth: 320,
  aiCollapsed: true,
  rightWidth: widths(260),
  leftCollapsed: false,
  rightCollapsed: false,
  cols: 4,
  laneSize: 96,
  laneHeadW: 286,
  laneHeight: 302,
  curated: false,
  perSlot: 1,
  agentAuto: false,
  agentAskHard: true,
  notifyDone: true,
  notifySound: false,
  notifyVolume: 50,
  font: "pretendard",
  textScale: 1,
  importPick: PICK_DROP,
  tagSuggest: true,
  artistPrefix: true,
  weightHl: true,
  fmView: "grid",
  streamPreview: true,
  convertOpenFolder: true,
  // v2 `enhanceLast` 의 초기값 그대로 (magnitude 3 = strength 0.5 · noise 0)
  enhanceLast: { mag: 3, adv: false, strength: 0.5, noise: 0 },
  convertLast: { fmt: "png", strip: false, ren: false, prefix: "image", start: 1, pad: 3,
                 mode: "sub", dest: "" },
  // 기본은 각 방향의 기본 해상도 (`SIZE_PRESETS` 의 ✦ 표시)
  sizeLast: { landscape: [1216, 832], portrait: [832, 1216], square: [1024, 1024] },
  laneSide: "bottom",
  laneWidth: 420,
  laneHeadH: 132,
  view: { cat: {}, fold: {}, tab: {} },
};

export const COLS_MIN = 1;
export const COLS_MAX = 12;

function load(): Persisted {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const got = JSON.parse(raw);
      /* ★옛 저장본은 숫자 하나였다 — 모드마다 그 값으로 채워 시작한다.
         화면이 갑자기 달라지지 않으면서 그때부터 따로 움직인다. */
      for (const k of ["leftWidth", "rightWidth"] as const) {
        if (typeof got[k] === "number") got[k] = widths(got[k]);
      }
      return { ...DEFAULTS, ...got };
    }
  } catch {}
  return DEFAULTS;
}

type S = Persisted & {
  mode: ModeId;
  setMode: (m: ModeId) => void;
  /** 캐릭터 배치 판을 펴 놓았나 (큰 그림 위에 겹친다 — `panels/CharPositioner`).
   *
   *  ★**저장하지 않는다** — 켜 둔 채로 앱을 켜면
   *    그림이 막에 덮여 있어 무엇이 잘못됐는지 알 수 없다.
   *  ★공홈도 화면 상태로 둔다(`n9.VD`). 켜 둘 수 있는 조건이 깨지거나(`use_coords` 를 끄거나,
   *    인물이 모자라거나) 하면 **스스로 닫힌다** — 닫는 자리는 `ScenePreview` 다. */
  positioning: boolean;
  setPositioning: (v: boolean) => void;
  setLaneSize: (n: number) => void;
  setLaneHeadW: (n: number) => void;
  setLaneHeight: (n: number) => void;
  setLeftWidth: (w: number) => void;
  setAiWidth: (w: number) => void;
  toggleAi: () => void;
  /** ★★**AI 패널을 연다** (접혀 있으면 편다). 토글과 다르다 — 승인 카드처럼 **반드시 보여야
   *  하는 것**이 뜰 때 쓰는 창구다 (`lib/approve`). 토글로 부르면 열린 것을 닫아 버린다. */
  openAi: () => void;
  setRightWidth: (w: number) => void;
  setCols: (n: number) => void;
  setCurated: (v: boolean) => void;
  setPerSlot: (n: number) => void;
  /** 자동 승인 두 칸 — ★한 창구로 받는다 (두 값이 함께 움직이는 한 벌이라) */
  setAgentApproval: (p: { agentAuto?: boolean; agentAskHard?: boolean }) => void;
  setNotifyDone: (v: boolean) => void;
  setNotifySound: (v: boolean) => void;
  setNotifyVolume: (v: number) => void;
  setTagSuggest: (v: boolean) => void;
  setArtistPrefix: (v: boolean) => void;
  setWeightHl: (v: boolean) => void;
  setFmView: (v: "grid" | "list") => void;
  setConvertOpenFolder: (v: boolean) => void;
  setEnhanceLast: (v: { mag: number; adv: boolean; strength: number; noise: number }) => void;
  /** 일괄 변환의 마지막 설정을 얹는다 (한 칸씩 바뀐다) */
  setConvertLast: (v: Partial<Persisted["convertLast"]>) => void;
  setStreamPreview: (v: boolean) => void;
  /** 그 방향에서 마지막에 고른 크기를 적어 둔다 */
  setSizeLast: (dir: "landscape" | "portrait" | "square", wh: [number, number]) => void;
  setLaneSide: (v: "bottom" | "right") => void;
  setLaneHeadH: (n: number) => void;
  /** 작업 상태 한 칸을 적어 둔다 (`view` 주석) */
  setView: <K extends keyof S["view"]>(kind: K, id: string, v: S["view"][K][string]) => void;
  setLaneWidth: (n: number) => void;
  setFont: (f: FontId) => void;
  setTextScale: (n: number) => void;
  setImportPick: (p: MetaPick) => void;
  /** 설정 창 — 열려 있으면 그 탭, 닫혀 있으면 null.
   *  ★상태를 스토어에 두는 이유: 여는 자리가 셋이다 (타이틀바 톱니 · AI 채팅의 엔진 칩 ·
   *    토큰 없이 생성을 누를 때). 프롭으로 내리면 생성 푸터까지 세 겹을 지나야 한다. */
  settingsTab: SettingsTabId | null;
  openSettings: (tab: SettingsTabId) => void;
  closeSettings: () => void;
  toggleLeft: () => void;
  toggleRight: () => void;
  /** 방금 바뀐 자리들 — 키를 담아 두고 잠깐 뒤 스스로 지운다 */
  /** 씬 히스토리를 **별표만** 보여 주나 (2026-08-22 에 걷었다가 2026-08-25 에 되살렸다).
   *
   *  ★**저장하지 않는다** — 거르는 상태로 앱을 켜면 그림이 사라진 것처럼 보인다.
   *  ★스토어에 두는 까닭은 **줄과 큰 그림이 다른 컴포넌트**라서다 (`sceneFocus` 와 같은
   *    사정). 줄만 거르면 휠로 넘길 때 걸러진 장이 큰 그림에 떠서 둘이 어긋난다. */
  laneStarOnly: boolean;
  setLaneStarOnly: (v: boolean) => void;
  flashes: string[];
  /** 그중 **그 자리로 데려갈** 것 (`reveal(..., scroll)`) */
  flashScroll: string[];
  /** ★**바꿨으면 보여 준다.** 접힌 패널을 펴고 그 자리를 잠깐 강조한다 (사용자 지시 2026-08-13).
   *  말없이 값만 바뀌면 사용자는 자기가 고른 것을 잃은 줄 안다. */
  /** @param scroll 그 자리로 **데려갈지**. ★★기본은 **아니오**다 (사용자 지시 2026-08-22:
   *  *"좌측 패널에 이미지 넣을 때 빼고는 자동스크롤 아예 안되게 다 빼"*).
   *  값이 밖에서 바뀔 때마다 화면이 움직이면, 무엇이 바뀌었는지 오히려 못 본다.
   *  ★켜는 자리는 **좌측 패널에 그림을 넣을 때 하나뿐**이다 (`ImageActions` 의 `base`) —
   *    그림이 어디로 들어갔는지는 보여 줘야 한다. 새 자리에 함부로 켜지 말 것. */
  reveal: (side: "left" | "right", key: string, scroll?: boolean) => void;
  /** 드래그가 끝났을 때만 저장한다 — 매 프레임 localStorage 를 때리지 않는다. */
  commitLayout: () => void;
};

/** 씬 칸 한 변의 한계.
 *
 *  ★위쪽은 **썸네일 해상도**가 정한다 (사용자 지시 2026-08-14). 썸네일은 긴 변 512px 로
 *    굽는다(`backend/thumbs.py MAX_SIDE`). 그보다 크게 키우면 늘려 그리게 되어 흐려진다.
 *    원본으로 갈아 끼우는 길도 만들어 봤지만 쓰지 않기로 했다 (스크롤할 때마다 큰 파일을
 *    받게 되어, 보이는 칸만 그리는 최적화와 정면으로 부딪힌다). */
export const LANE_MIN = 40;
export const LANE_MAX = 256;
/** 씬 줄 머리(그 씬의 프롬프트) 폭의 한계 */
export const HEAD_MIN = 150;
export const HEAD_MAX = 560;

export const useUi = create<S>((set, get) => ({
  ...load(),
  mode: "generate",
  setMode: (m) => set({ mode: m }),
  positioning: false,
  setPositioning: (v) => set({ positioning: v }),
  setLaneSize: (n) => set({ laneSize: Math.min(LANE_MAX, Math.max(LANE_MIN, Math.round(n))) }),
  setLaneHeadW: (n) => set({ laneHeadW: Math.min(HEAD_MAX, Math.max(HEAD_MIN, Math.round(n))) }),
  setLaneHeight: (n) => set({ laneHeight: Math.max(84, Math.round(n)) }),
  /** 세로 모드의 씬 폭 — ★**칸 하나만 남을 만큼까지 줄인다** (사용자 지시 2026-08-22).
   *  머리가 좁아지면 글이 줄바꿈으로 접히고, 그래도 모자라면 잘린다 — 큰 그림을 넓게 쓰려고
   *  줄이는 것이라 여기서 막지 않는다. */
  setLaneWidth: (n) => set({ laneWidth: Math.max(96, Math.round(n)) }),
  // 세로 모드의 머리 높이 — 프롬프트 칩 한두 줄이 들어갈 만큼은 있어야 한다
  setLaneHeadH: (n) => set({ laneHeadH: Math.min(420, Math.max(72, Math.round(n))) }),
  setView: (kind, id, v) => {
    const cur = get().view;
    if (cur[kind][id] === v) return;   // 같은 값이면 저장을 안 부른다
    set({ view: { ...cur, [kind]: { ...cur[kind], [id]: v } } });
    get().commitLayout();
  },
  setLaneSide: (v) => {
    set({ laneSide: v });
    get().commitLayout();
  },
  // ★지금 보고 있는 모드의 몫만 바꾼다 (`PanelWidths` 의 ★★주)
  setLeftWidth: (w) => set({ leftWidth: { ...get().leftWidth, [get().mode]: w } }),
  setAiWidth: (w) => set({ aiWidth: w }),
  toggleAi: () => {
    const open = get().aiCollapsed;   // 지금 접혀 있으면 이번에 펴는 것이다
    set({ aiCollapsed: !get().aiCollapsed });
    /* ★★**펴면 점이 사라진다** — 읽었다는 뜻이다 (`llm.unread`, 사용자 지시 2026-08-26).
       ★스토어를 가로질러 부른다: 점을 지우는 자리가 둘이면(여기·`openAi`) 한쪽만 고치게 된다. */
    if (open) void import("./llm").then((m) => m.useLlm.getState().setUnread(false));
    get().commitLayout();
  },
  openAi: () => {
    if (!get().aiCollapsed) return;
    set({ aiCollapsed: false });
    void import("./llm").then((m) => m.useLlm.getState().setUnread(false));
    get().commitLayout();
  },
  setRightWidth: (w) => set({ rightWidth: { ...get().rightWidth, [get().mode]: w } }),
  setCols: (n) => {
    set({ cols: Math.min(COLS_MAX, Math.max(COLS_MIN, Math.round(n))) });
    get().commitLayout();
  },
  setCurated: (v) => set({ curated: v }),
  setNotifyDone: (v) => {
    set({ notifyDone: v });
    get().commitLayout();
  },
  setNotifySound: (v) => {
    set({ notifySound: v });
    get().commitLayout();
  },
  setNotifyVolume: (v) => {
    set({ notifyVolume: Math.min(100, Math.max(1, Math.round(v))) });
    get().commitLayout();
  },
  // ★**상한이 없다** (사용자 결정 2026-08-18, v2 도 무제한이었다 — `index.html:9452` 의
  //   `repeatCount` 는 `min="1"` 뿐이다). 잠깐 12 로 막아 뒀던 자리인데, 큐가 길어지는 것은
  //   이제 취소 버튼 하나가 감당한다. ★막는 것은 여전히 셋이다: 음수·0·소수
  setPerSlot: (n) => {
    set({ perSlot: Math.max(1, Math.round(n)) });
    get().commitLayout();
  },
  setAgentApproval: (p) => {
    set(p);
    get().commitLayout();
  },
  setTagSuggest: (v) => {
    set({ tagSuggest: v });
    get().commitLayout();
  },
  setArtistPrefix: (v) => {
    set({ artistPrefix: v });
    get().commitLayout();
  },
  setWeightHl: (v) => {
    set({ weightHl: v });
    get().commitLayout();
  },
  setFmView: (v) => {
    set({ fmView: v });
    get().commitLayout();
  },
  setConvertOpenFolder: (v) => {
    set({ convertOpenFolder: v });
    get().commitLayout();
  },
  setEnhanceLast: (v) => {
    set({ enhanceLast: v });
    get().commitLayout();
  },
  /** ★한 칸씩 바뀌므로 **덮어쓰지 않고 얹는다** */
  setStreamPreview: (v) => {
    set({ streamPreview: v });
    get().commitLayout();
  },
  setConvertLast: (v) => {
    set({ convertLast: { ...get().convertLast, ...v } });
    get().commitLayout();
  },
  setSizeLast: (dir, wh) => {
    const cur = get().sizeLast[dir];
    if (cur && cur[0] === wh[0] && cur[1] === wh[1]) return;   // 같은 값이면 저장을 안 부른다
    set({ sizeLast: { ...get().sizeLast, [dir]: wh } });
    get().commitLayout();
  },
  setFont: (f) => {
    applyFont(f);
    set({ font: f });
    get().commitLayout();
  },
  setImportPick: (p) => {
    set({ importPick: p });
    get().commitLayout();
  },
  setTextScale: (n) => {
    const v = Math.min(1.5, Math.max(0.8, Math.round(n * 20) / 20));   // 5% 눈금, 80~150%
    applyTextScale(v);
    set({ textScale: v });
    get().commitLayout();
  },
  settingsTab: null,
  openSettings: (tab) => set({ settingsTab: tab }),
  closeSettings: () => set({ settingsTab: null }),
  toggleLeft: () => {
    set({ leftCollapsed: !get().leftCollapsed });
    get().commitLayout();
  },
  toggleRight: () => {
    set({ rightCollapsed: !get().rightCollapsed });
    get().commitLayout();
  },
  laneStarOnly: false,
  setLaneStarOnly: (v) => set({ laneStarOnly: v }),
  flashes: [],
  flashScroll: [],
  reveal: (side, key, scroll = false) => {
    const patch = side === "left" ? { leftCollapsed: false } : { rightCollapsed: false };
    set({
      ...patch,
      flashes: [...new Set([...get().flashes, key])],
      // ★★**그 자리로 데려갈지는 부르는 쪽이 정한다** (사용자 지시 2026-08-21).
      //   베이스 그림이 해상도를 바꾼 것처럼 **한 자리**가 바뀌면 데려가는 편이 낫지만,
      //   설정 불러오기는 **여러 자리가 한꺼번에** 바뀌어 화면이 튀는 것으로만 보인다.
      flashScroll: scroll ? [...new Set([...get().flashScroll, key])] : get().flashScroll,
    });
    get().commitLayout();
    // ★스스로 꺼진다 — 강조가 남아 있으면 다음에 바뀐 것과 구별이 안 된다
    setTimeout(
      () =>
        set({
          flashes: get().flashes.filter((k) => k !== key),
          flashScroll: get().flashScroll.filter((k) => k !== key),
        }),
      2200,
    );
  },
  commitLayout: () => {
    // ★★레이아웃만이 아니라 **저장해야 하는 것 전부**를 적는다. 예전에는 목록에서
    //   `notifyDone`·`perSlot`·`curated` 가 빠져 있어, 켜 놓아도 껐다 켜면 기본값으로
    //   돌아갔다 (감사 2026-08-16). 필드를 늘리면 **여기에도 더할 것.**
    const { leftWidth, rightWidth, leftCollapsed, rightCollapsed, cols, laneSize, laneHeadW,
      laneHeight, font, textScale, importPick, aiWidth, aiCollapsed,
      notifyDone, notifySound, notifyVolume, perSlot, curated, agentAuto, agentAskHard,
      tagSuggest, artistPrefix, weightHl, fmView, streamPreview, convertOpenFolder, enhanceLast, convertLast, sizeLast,
      laneSide, laneWidth, laneHeadH, view } = get();
    try {
      localStorage.setItem(
        KEY,
        JSON.stringify({
          leftWidth,
          rightWidth,
          leftCollapsed,
          rightCollapsed,
          cols,
          laneSize,
          laneHeadW,
          laneHeight,
          font,
          textScale,
          importPick,
          aiWidth,
          aiCollapsed,
          notifyDone,
          notifySound,
          notifyVolume,
          perSlot,
          curated,
          agentAuto,
          agentAskHard,
          tagSuggest,
          artistPrefix,
          weightHl,
          fmView,
          streamPreview,
          convertOpenFolder,
          enhanceLast,
          convertLast,
          sizeLast,
          laneSide,
          laneWidth,
          laneHeadH,
          view,
        }),
      );
    } catch {}
  },
}));

/** 방금 바뀐 자리인가 — 강조 스타일을 붙일 때 쓴다.
 *  ★모양은 한 곳에서만 정한다 (`flashStyle`) — 자리마다 다르게 강조하면 학습 대상이 된다. */
export const useFlash = (key: string) => useUi((s) => s.flashes.includes(key));

/** 방금 바뀐 자리인가 — **강조 + 그 자리로 데려가기**를 한 벌로 준다.
 *
 *  ★★사용자 지시 2026-08-25: *"AI 가 수정한 걸 클릭했을 때는 강조 + 자동 스크롤.
 *    정확한 위치를 유저가 모르기 때문에 **AI 수정본만** 자동 스크롤을 켠다."*
 *  ★자동 스크롤의 기본은 여전히 **끔**이다 (사용자 지시 2026-08-22). 켜지는 것은 부르는
 *    쪽이 `reveal(..., true)` 로 청한 것뿐이고(`flashScroll`), 조수의 수정 자리를 여는
 *    `lib/agentAt` 이 그렇게 부른다. 값이 저절로 바뀌는 자리는 켜지지 않는다.
 *  ★`nearest` 라 이미 보이는 자리면 화면이 안 흔들린다.
 *  ★열쇠를 여럿 받는다 — 조수는 사람이 부르는 **이름**으로 가리키는데 화면이 아는 것은
 *    id 라, 둘 중 무엇이 와도 같은 자리를 열어야 한다 (`prompt:<id>` · `prompt:<이름>`).
 *  ★한 창구로 둔다: 자리마다 따로 적으면 새로 만드는 자리가 스크롤을 빠뜨린다. */
export function useFlashAt<T extends HTMLElement>(key: string | string[]) {
  const keys = Array.isArray(key) ? key : [key];
  const on = useUi((s) => keys.some((k) => k && s.flashes.includes(k)));
  const ref = useRef<T>(null);
  useEffect(() => {
    if (!on) return;
    const want = useUi.getState().flashScroll;
    if (keys.some((k) => k && want.includes(k)))
      ref.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [on]);
  return { on, ref };
}

/** 강조 — 액센트 테두리 + 옅은 바탕. 레이아웃을 밀지 않도록 **outline** 을 쓴다 */
export const flashStyle = (on: boolean): React.CSSProperties =>
  on
    ? {
        outline: "2px solid var(--accent)",
        outlineOffset: 3,
        borderRadius: "var(--r-2)",
        background: "var(--accent-bg)",
        transition: "outline-color 0.2s, background 0.2s",
      }
    : {};
