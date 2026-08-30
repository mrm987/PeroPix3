import { create } from "zustand";
import { api, type TrashEntry } from "../lib/backend";
import { usePrompt, defaultBase, defaultUc, type Char, type Thumb } from "./prompt";
import { t } from "../i18n";
import { toast, undoToast } from "./toast";
import { withBusy } from "./busy";
import { clearUndo, dropUndoZone, pushUndo } from "../lib/undo";
import { uniqueName } from "../lib/uniqueName";
import { makeBlock, parseSegs, type Block } from "../lib/blocks";
import { wrapSetTabInCard } from "../lib/sceneCards";
export { takesOf, takesOfScene, dedupeByFile, type Rec } from "../lib/takes";
import { dedupeByFile, takesOf } from "../lib/takes";
import type { Rec } from "../lib/takes";
import { moveTo } from "../lib/moveTo";
import { planDelete, type DelPlan, type DelTarget } from "../lib/delPlan";
export type { DelPlan, DelTarget } from "../lib/delPlan";
// ★**형만** 가져온다 — `gen.ts` 가 이 파일을 부르므로 값으로 가져오면 순환이 된다
import type { GenParams } from "./gen";

/** 워크스페이스 = 작업 상태 + 생성 이미지 저장소의 단위 (schema.md).
 *  카드·블록 저장소는 공용이라 여기 없다. */

/** 탭이 들고 있는 프롬프트 — ★**서브 탭마다 스타일·캐릭터가 다르다** (사용자 결정 2026-08-03).
 *  v2 의 "캐릭터 리스트 프리셋"을 이것이 대신한다: 조합을 파일로 저장하는 대신
 *  탭에 얹어 두고 탭째로 쓴다. */
/** ★★**그 그림을 뽑을 때의 화면 구조** — 생성할 때 레코드에 남긴다 (`gen.ts` 의 `env`).
 *
 *  「새 탭으로 복제」의 근거다. PNG 메타데이터에는 **합쳐진 문자열**만 남아서 스타일 카드·
 *  블록 나눔·캐릭터 카드를 못 되살린다. 그래서 구조는 여기 따로 남긴다 —
 *  **그 뒤에 탭을 고치거나 지워도** 그때 환경 그대로 복제된다 (사용자 지시 2026-08-19).
 *
 *  ★담는 것은 **`generateAll` 이 읽는 것 전부**여야 한다 (회귀 `lib/cloneEnv.test.ts` 가 맞댄다).
 *  ★그림 바이트는 안 담는다 — 구조뿐이라 작고, 값(설정·시드·바이브)은 PNG 메타데이터에 있다.
 *  ★목록에는 안 실린다 (`server.py` 의 `_light`). 복제할 때 한 장씩 가져간다. */
export type ShotEnv = {
  prompt: TabPrompt;
  /** 씬 프롬프트가 베이스로 가나 캐릭터로 가나 */
  sceneDest?: string;
  cell: { name: string; blocks: Block[] };
};

export type TabPrompt = {
  base: Block[];
  baseUc: Block[];
  style?: { ref: string | null; name: string; color: [string, string]; thumb?: Thumb | null };
  /** 스타일 카드를 쓰고 있는가 (없으면 켜진 것 — `store/prompt` 의 `styleOn`) */
  styleOn?: boolean;
  /** ★★**NAI 캐릭터 프롬프트**다. 워크스페이스의 「탭」과 **다른 것**이라 이름도 그대로
   *  `chars` 다 (`shared/terms.json` 의 character · `docs/terms.md`).
   *  ★2026-08-24 개명이 여기까지 밀고 들어와 `tabs?: Char[]` 로 바뀌어 있었다. 저장 파일과
   *    백엔드(`agent._set_prompt`)는 줄곧 `chars` 였으므로 **타입만 거짓말을 하고 있었고**,
   *    그 탓에 이 값을 읽으려는 코드가 타입 오류를 만났다 (적대 검토 2026-08-24). */
  chars?: Char[];
};

/** 슬롯(세트 탭의 칸) — v2 의 슬롯 그대로. `locked` 는 생성에서 뺀다.
 *
 *  ★**프롬프트와 같은 자료형**이다 (사용자 지시 2026-08-07): 포즈 하나가 싱글의 캐릭터 카드처럼
 *    **블록 목록**을 들고, 블록을 계속 덧붙여 쓴다. 그래서 조작도 그쪽과 같다 —
 *    칩 드래그·칩 휠 가중치·Enter 로 다음 블록·태그 자동완성이 전부 그대로 먹는다.
 *  ★옛 형식(`tags`·`extra` 문자열)은 **읽을 때 한 번** 블록으로 옮긴다 (`slotBlocks`).
 *    자료형에는 남겨 두지 않는다 — 두 벌을 들고 있으면 어느 쪽이 진짜인지 알 수 없다. */
export type Slot = {
  id: string;
  name: string;
  blocks: Block[];
  /** 접어 두면 머리만 남는다 (블록과 같은 규칙) */
  open?: boolean;
  locked?: boolean;
};

/** 옛 슬롯을 블록으로 — ★칸 하나는 **블록 하나**다 (`slotBlock`, 2026-08-20).
 *
 *  ★옛 「공통(tags) / 추가(extra)」 두 칸은 **이어 붙여 한 블록**으로 옮긴다. 예전에는
 *    `extra` 를 "카드에 안 담기는 블록"으로 살려 두었는데, 그 갈래를 걷어냈으므로
 *    (칸에 블록이 하나뿐이라 담고 말고를 가를 자리가 없다) 그대로 이어 적는다.
 *    ★아무것도 잃지 않는다 — 태그는 전부 넘어오고, 카드에 담기는 범위만 넓어진다. */
export function slotBlocks(c: {
  blocks?: Block[];
  tags?: string;
  extra?: string;
}): Block[] {
  if (Array.isArray(c.blocks)) return c.blocks;
  const tags = [...parseSegs(c.tags ?? ""), ...parseSegs(c.extra ?? "")];
  return tags.length ? [makeBlock("", [], { open: true, tags })] : [];
}

/** 씬 세트 카드 — **탭에 얹는 단위** (사용자 결정 2026-08-11).
 *
 *  씬 칸(옛 이름 「타임라인」)은 **그릇**이고, 그 위에 이 카드를 얹는다. 카드가 씬(`cells`)을
 *  담고, 공통 접두는 **카드의 것**이다 (탭이 아니라) — 카드마다 다른 접두를 쓰기 때문이다.
 *
 *  ★**씬 번호(`cellSeq`)는 카드가 아니라 탭이 발급한다.** 결과 레코드는 `cell_id` 로만
 *    묶이므로(`takesOf`), 카드마다 번호를 새로 매기면 두 카드의 `c1` 이 같은 결과를 물어
 *    **한 카드의 그림이 다른 카드에 나타난다.** 번호는 탭 안에서 유일해야 한다. */
export type SceneCard = {
  id: string;
  name: string;
  /** 덱의 씬 세트 카드에서 왔으면 그 id (없으면 이 탭에서 만든 것) */
  srcId?: string;
  /** 배너 그라데이션. ★지금은 **종류가 정한다** (`cards/kindColor`) — 저장된 값은 옛 자국이다 */
  color?: [string, string];
  /** ★카드째 잠근다 — 옛 「전체 잠금」이 이 자리로 왔다 (사용자 결정 2026-08-11).
   *  잠긴 카드의 씬은 생성에서 빠진다. 씬 하나하나의 `locked` 와 **함께** 걸린다. */
  /** ★머리에 거는 그림 (사용자 지시 2026-08-21) — 프롬프트 섹션 배너와 **같은 물건**이다.
   *  바이트는 공용 저장소에 하나뿐이고(`/api/pin/<tid>`) 여기 담는 것은 「어느 것을 어떻게
   *  볼지」뿐이다 (schema.md 1-1절). ★덱의 씬 세트 카드와는 다른 자리다 — 저장할 때
   *  카드가 자기 것으로 한 벌 갖는다. */
  thumb?: Thumb;
  /** 카드째 접혔나 — ★머리를 누르면 바뀐다. 화면 상태지만 탭에 남겨 껐다 켜도 유지된다 */
  folded?: boolean;
  locked?: boolean;
  cells: Slot[];
};

/** ★★갈래가 **하나**다 (사용자 확인 2026-08-24: *"현재 개발단계이고 그런 워크스페이스는 없음"*).
 *  예전에는 `kind: "single"` 갈래가 함께 있었고 `migrate` 가 그것을 씬 탭으로 옮겼다 —
 *  싱글은 2026-08-11 에 없어졌고 저장 파일에도 남은 것이 없어 그 계보를 통째로 걷었다.
 *  ★`kind: "sceneGroup"` 리터럴은 남는다 — 저장 파일에 이미 적혀 있고, 코드 곳곳의 가드가 그것을 본다. */
export type SceneGroup =
  | {
      id: string;
      kind: "sceneGroup";
      name: string;
      /** 얹어 둔 씬 세트 카드들. 옛 탭은 `cells` 를 직접 들었다 (`migrate` 가 감싼다) */
      cards: SceneCard[];
      /** 씬 번호 발급기 — ★**절대 줄지 않고, 탭 하나에 하나다.** 지운 번호는 결번으로 둔다.
       *  결과를 씬 id 로 묶으므로, 번호를 물려주면 **옛 결과가 새 씬에 달라붙는다.**
       *  없으면(옛 세션) 지금 있는 씬의 최대 번호 + 1 로 본다. */
      cellSeq?: number;
      /** 카드 번호 발급기 — 같은 이유로 줄지 않는다 */
      cardSeq?: number;
      prompt?: TabPrompt;
      /** ★**자기 id 가 박힌 레코드만** 갖는다. 새로 만든 탭에 붙는다 — 이름 폴백이 없으면
       *  같은 이름의 옛 탭 결과를 물고 오지 않는다 (아래 `takesOf` 주석). */
      idOnly?: boolean;
      /** 어느 캐릭터의 포즈세트인가. 옛 세트 탭에는 없다 (`migrate` 가 채운다) */
      tabId?: string;
      /** ★씬 프롬프트가 **payload 의 어디로 들어가나** — `"base"`(top-level prompt) ·
       *  캐릭터 id(`characterPrompts[]`) · `"all"`(**켜진 캐릭터 전원**). 없으면 base 다.
       *  ★`"all"` 은 v2 의 `promptTarget === "char"` 다 (`backend.py:2803-2833`).
       *    켜진 캐릭터가 둘 이상일 때만 뜻이 있어, 화면도 그때만 선택지를 낸다.
       *  ★**탭에 하나뿐이다** (사용자 결정 2026-08-11): 카드마다 두지 않는다. 캐릭터가 둘인
       *    것은 "한 이미지에 두 사람"이지 "카드마다 다른 사람"이 아니다. */
      sceneDest?: string;
    };

/** ★워크스페이스의 묶음 층 — 프롬프트(생김새·그림체)를 든다 (사용자 결정 2026-08-04).
 *  ★★화면 이름은 「탭」이다 (사용자 결정 2026-08-18). 식별자만 `chars` 로 남는다
 *    (`Spec.chars` 주석에 까닭을 적어 뒀다).
 *
 *  포즈세트 탭은 **슬롯만** 갖는다. 같은 인물로 여러 포즈세트를 돌리는 것이 멀티의 쓰임이라,
 *  프롬프트가 포즈세트마다 따로면 인물을 고칠 때마다 세트 수만큼 고쳐야 한다
 *  (페로픽스파이 `Character.base` 와 같은 자리).
 *  ★싱글은 그대로 **탭이** 프롬프트를 갖는다 — 거기엔 캐릭터 층이 없다. */
/** 화면 이름 「탭」 (`Spec.chars` 주석 참조 — 식별자만 `char` 로 남는다).
 *
 *  ★★프롬프트도 생성 옵션도 **이 층이 든다** (사용자 지시 2026-08-22). 세트가 아니다 —
 *    한 탭 아래의 세트들은 같은 인물의 다른 포즈 묶음이라, 세트마다 수치가 갈리면
 *    인물을 손볼 때 세트 수만큼 같은 값을 고쳐야 한다. */
export type WsTab = {
  id: string;
  name: string;
  /** ★이 탭에서 **마지막으로 보던 씬 그룹** (사용자 지시 2026-08-30) — 탭을 떠날 때 적고
   *  (`switchTab`), 돌아오면 그것을 연다. 없거나 지워졌으면 첫 씬 그룹. 문서가 아니라 보는
   *  자리지만 `activeTab`·`activeSceneGroup` 과 같은 사정으로 워크스페이스에 함께 남는다. */
  lastSceneGroup?: string;
  prompt?: TabPrompt;
  /** ★★**그 탭의 생성 옵션** (사용자 지시 2026-08-22). 모델·크기·steps·cfg·시드·프리셋…
   *  전부 여기 담긴다. 예전에는 앱 전역이라, 다른 탭에서 만지다 돌아오면 **앞 탭의 값을
   *  물고 있어 같은 탭인데 결과가 달라졌다.**
   *  ★담고 꺼내는 것은 `store/gen` 이 한다 (거기 ★★주) — 이 파일은 칸만 든다.
   *  ★없으면 지금 값을 그대로 쓴다 (옛 워크스페이스·새 탭). 처음 떠날 때 담긴다. */
  gen?: GenParams;
};

/** 세트 탭의 **모든 씬** — 카드 순서대로 편다.
 *  ★`tab.cells` 를 직접 읽던 자리는 전부 이걸로 온다. 카드 층이 생겨도 "이 탭의 씬 목록"이
 *    필요한 곳(장 수 세기·번호 매기기·큐)은 하나도 안 바뀌기 때문이다. */
/** ★★`patchSceneGroup` 이 **저장해 주는 필드** — 여기 없는 이름은 버린다 (선결 조건 3-3).
 *
 *  막는 것은 **정체성**이다: `id`·`kind` 를 덮으면 그 세트의 그림이 통째로 안 보이고
 *  (결과를 `scene_group_id` 로 묶는다), `tabId` 를 덮으면 세트가 남의 탭 밑으로 순간이동한다
 *  (옮기는 것은 순서·프롬프트가 함께 걸린 일이라 전용 창구가 맡는다).
 *
 *  ★`cellSeq`·`cardSeq` 는 **넣는다.** 발급기가 줄면 안 된다는 규칙은 그대로지만
 *    (`SceneGroup.cellSeq` 주석), 화면에 「다음 번호」를 사람이 정하는 칸이 있어
 *    (`SceneLane` 의 `onSeq`) 여기서 막으면 그 기능이 조용히 죽는다.
 *    **조수가 못 만지게 하는 것은 이 자리가 아니라 액션의 인자 목록**이다 — 이 목록은
 *    「저장해도 되는가」를, 액션 쪽은 「조수가 정해도 되는가」를 답한다.
 *  ★필드를 새로 더하면 **여기도 함께** 더한다. 안 그러면 저장이 조용히 안 된다. */
const SET_PATCHABLE = new Set([
  "name", "cards", "prompt", "idOnly", "sceneDest", "cellSeq", "cardSeq",
]);

export const allCells = (tab: Extract<SceneGroup, { kind: "sceneGroup" }>): Slot[] =>
  tab.cards.flatMap((k) => k.cells);

/** 씬 하나와 그것이 속한 카드 — **생성은 카드의 접두가 필요하다** */
export const allScenes = (
  tab: Extract<SceneGroup, { kind: "sceneGroup" }>,
): { card: SceneCard; cell: Slot }[] =>
  tab.cards.flatMap((k) => k.cells.map((c) => ({ card: k, cell: c })));

/** 그 씬이 든 카드를 찾는다 (없으면 null) */
export const cardOfCell = (
  tab: Extract<SceneGroup, { kind: "sceneGroup" }>,
  cellId: string,
): SceneCard | null => tab.cards.find((k) => k.cells.some((c) => c.id === cellId)) ?? null;

export type Spec = {
  version: number;
  /** 낱말 이전이 어디까지 왔나 — **`version` 과 다른 것이다.**
   *  ★★찍는 곳이 백엔드뿐이면 앱이 만든 파일에 표가 없어, 다음 부팅의 이전이 **v1 로 보고
   *    자리를 맞바꾼다** (실사고 2026-08-27: 씬 그룹이 버려져 씬 카드가 통째로 사라졌다).
   *    그래서 `newSpec` 이 처음부터 찍는다. 값은 `backend/migrate_terms.py` 의
   *    `SPEC_VERSION` 과 같아야 한다.
   *  ★옛 파일에는 없다 — 그쪽은 이전이 **모양으로** 알아본다 (같은 파일의 ★★주). */
  specVersion?: number;
  id: string;
  name: string;
  /** ★레거시 — 예전엔 워크스페이스가 프롬프트를 하나만 들었다. 지금은 **탭이 든다**.
   *  옛 워크스페이스를 열 때 탭에 아직 프롬프트가 없으면 여기서 씨앗을 얻는다 (`migrate`). */
  prompt: TabPrompt;
  params: Record<string, unknown>;
  /** 큰 그림을 **어떻게 보는가** (사용자 지시 2026-08-24: *"비율은 워크스페이스 단위로
   *  유저가 정해둔거 항상 고정"*).
   *  ★없으면 「꽉차게」다 — 옛 워크스페이스도 지금까지와 같이 뜬다 (이전이 필요 없다).
   *  ★`zoom` 은 **원본 해상도 대비 배율**이다 (`1` = 100%). 「꽉차게」일 때는 안 쓰이지만,
   *    껐다 켰을 때 그 값으로 돌아가도록 **지워지지 않고 남는다**. */
  preview?: { fit: boolean; zoom: number };
  sceneGroups: SceneGroup[];
  activeSceneGroup: string;
  /** 이 워크스페이스의 묶음 층. 옛 워크스페이스에는 없다 (`migrate` 가 만든다).
   *
   *  ★★**화면에서는 이것을 「탭」이라 부른다** (사용자 결정 2026-08-18). 위쪽 탭 줄의 `+` 가
   *    만드는 것이 이 층이라, 예전 이름(「캐릭터」)으로는 한 화면에서 「캐릭터」가 두 가지를
   *    가리켰다 (아래 NAI 캐릭터 프롬프트와). 문구는 `i18n` 의 `chars.*` 에 있다.
   *  ★★**코드 식별자도 같은 낱말이다** (2026-08-24 개명 + 1회 이전). 여기 있던 「식별자는
   *    바꾸지 않는다」는 그 이전의 결정이라 걷었다 — 지금은 `spec.tabs`(탭)·`spec.sceneGroups`(세트)이고,
   *    저장 파일은 `backend/migrate_terms.py` 가 부팅 때 한 번 옮긴다. 옛 열쇠 폴백은 없다.
   *  ★이 층과 헷갈리면 안 되는 「캐릭터」가 둘 더 있다. 그 둘은 그대로 「캐릭터」다:
   *    NAI 캐릭터 프롬프트(`store/prompt.ts` 의 `chars`, 화면은 `cards.charN` 등) ·
   *    덱의 캐릭터 카드(`cards.short.characters`). */
  tabs?: WsTab[];
  activeTab?: string;
  /** ★★**비파괴 선별** — 지움과 별표 두 갈래다. 별표는 2026-08-22 에 사용자 지시로
   *  걷었다가 2026-08-25 에 되살렸다 (*"씬 히스토리에서 별표 표시하는 거랑 별표만 보기
   *  기능 다시 되살려 줘"*). 갤러리(보관함)의 별표와는 **다른 것**이다 — 그쪽은 서버가
   *  들고(`keep.py`) 워크스페이스를 넘나든다.
   *  ★★**지운 그림의 목록(`deleted`)은 걷었다** (사용자 결정 2026-08-28). 「파일이 없다」는 사실을
   *    경로로 베껴 적은 것이라 spec 이 덮어써지면 손으로 다시 채워야 했다 — 지금은 서버가 파일이
   *    없는 줄을 목록에서 빼고 준다 (`Store.live_records`). 옛 파일의 것은 `migrate` 가 뗀다. */
  selection: { starred?: string[] };
};

export type WsInfo = { name: string; id?: string | null; updatedAt?: string | null };

type S = {
  list: WsInfo[];
  current: string;
  /** 열어 둔 워크스페이스 이름들 (탭 줄). 내용은 활성 것만 메모리에 있다 */
  openWs: string[];
  spec: Spec | null;
  records: Rec[];
  loading: boolean;

  init: () => Promise<void>;
  close: () => void;
  open: (name: string) => Promise<void>;
  /** 탭을 닫는다. 활성 탭을 닫으면 옆 탭으로, 마지막이면 게이트로 */
  closeWs: (name: string) => Promise<void>;
  create: (name?: string) => Promise<void>;
  rename: (name: string) => Promise<void>;
  /** 게이트 목록의 이름변경 — 열려 있지 않은 워크스페이스도 받는다 */
  renameWs: (old: string, name: string) => Promise<void>;
  remove: (name: string) => Promise<void>;
  save: () => Promise<void>;
  addRecord: (r: Rec) => void;

  /** 별표를 여러 장 한 번에 켜고 끈다 (파일은 안 건드린다) */
  setStars: (files: string[], on: boolean) => void;
  /** 별표를 그때 상태로 되돌린다 — **되돌리기 로그가 담아 둔 길**이다 (`lib/undo`).
   *  화면에서 직접 부르지 않는다.
   *  ★옛 이름은 `undoSelection` 이었다. 그때는 이 파일이 자기 스택을 들고 있었는데,
   *    스택이 둘이면 부르는 쪽이 순서를 정하게 되고 그것이 곧 엉뚱한 것이 되살아나는 길이었다
   *    (사용자 지시 2026-08-22 로 전역 로그 하나가 됐다 — `lib/undo` 머리 ★★주). */
  restoreStars: (before: string[]) => void;
  /** 휴지통에서 **도로 꺼낸다** — `deleteFiles` 의 되돌리기. 줄도 도로 넣는다 (`before` 의 차례로). */
  restoreFiles: (trashed: TrashEntry[], before: Rec[]) => Promise<void>;
  /** 별표를 켜고 끈다 (씬 히스토리) — ★갤러리의 별표와 다른 자리다 */
  toggleStar: (file: string) => void;
  isStarred: (file: string) => boolean;
  /** 「새 탭으로 복제」 — 그림 한 장을 **씬 하나짜리 새 탭**으로 옮긴다 (원본은 그대로).
   *  돌려주는 것은 그림이 앉은 자리(새 파일 · 그 씬의 id). 만들 수 없으면 null.
   *
   *  ★★**갤러리 그림도 이 자리를 쓴다** (사용자 지시 2026-08-19:
   *    *"슬롯에서 복제할때랑 동일한 로직 사용해"*). 다른 것은 셋뿐이다 —
   *    파일이 보관함에 있고(`from`), 구조를 찾아볼 자리가 **그 그림의 출처**이며(`origin`),
   *    출처를 모르면 씬을 메타데이터에서 받는다(`scene`).
   *
   *  @param o.excludeNo 「파일 이름에서 씬 번호 빼기」 — 보통 생성과 **같은 규칙**으로 짓는다
   *  @param o.apply 새 탭으로 옮겨 **간 뒤에** 부른다 (그 그림의 설정을 편집기에 얹는 자리).
   *    `structure` 는 **구조를 되살렸는가** — 거짓이면 부르는 쪽이 메타데이터로 세워야 한다
   *  @param o.from `keep` 이면 원본이 보관함에 있다 (서버가 거기서 집어 온다)
   *  @param o.origin 구조(`env`)를 찾아볼 자리. 보관함 그림은 출처가 다른 워크스페이스일 수 있다
   *  @param o.scene 구조를 못 찾았을 때 쓸 씬 (메타데이터의 `slot_prompt`)
   *  @param o.seed 레코드가 없는 그림의 시드 (메타데이터에서 읽은 값) */
  cloneToNewTab: (
    file: string,
    o: {
      excludeNo: boolean;
      apply?: (found: { structure: boolean }) => void;
      from?: "keep";
      origin?: { ws: string; file: string } | null;
      scene?: { name?: string; blocks: Block[] };
      seed?: number;
      /** ★다중 선택 복제 (사용자 지시 2026-08-29) — 첫 장이 세운 **같은 씬**에 테이크로 쌓인다 */
      extraFiles?: string[];
    },
  ) => Promise<{ file: string; cell: string } | null>;
  /** ★지우기 = **휴지통으로 이동**. 파일이 실제로 자리에서 없어지고, `Ctrl+Z` 로 되돌아온다.
   *  비우는 것은 앱을 켤 때 (24시간 지난 것) — `backend/trash.py` 머리 주석. */
  deleteFiles: (files: string[], opts?: { undo?: boolean }) => Promise<void>;
  activeSceneGroup: () => SceneGroup | undefined;
  setActiveSceneGroup: (id: string) => void;
  /** 그 탭(`chars`)의 생성 옵션을 담아 둔다 (`store/gen` 이 부른다) */
  stashGen: (tabId: string, params: GenParams) => void;
  /** 큰 그림 보기 설정을 고친다 (워크스페이스에 남는다) */
  setPreview: (patch: Partial<NonNullable<Spec["preview"]>>) => void;
  /** 셀은 이름만(빈 태그) 또는 이름+태그로 준다 — 포즈세트 카드가 후자다 */
  addSceneGroup: (name: string, cells: (string | { name: string; tags?: string; blocks?: Block[] })[]) => void;
  /** 씬 자리가 바뀌면 **파일 이름의 씬 번호도 따라간다** (사용자 지시 2026-08-24).
   *  ★한 번에 하나만 돈다 — 자세한 것은 구현부의 ★★주. */
  renumberSet: (groupId: string) => Promise<void>;
  closeSet: (id: string) => void;
  renameSceneGroup: (id: string, name: string) => void;

  /** ★**무엇이 사라지나** — 부작용 없는 계산 (`lib/delPlan`). 확인 창·승인 카드의 문구가 이걸 쓴다 */
  planRemove: (target: DelTarget) => DelPlan;
  /** ★★**삭제 한 벌** — 그림 모으기 → 휴지통 → 대상 제거 → 되돌리기 로그 비우기.
   *
   *  ★**묻지 않는다.** 묻는 것은 부르는 쪽이다 (화면은 확인 창, 조수는 승인 카드) —
   *    여기서 `ask()` 를 부르면 조수 경로에서 창이 **둘** 뜬다 (`delPlan.ts` 머리 주석).
   *  ★막힌 것(마지막 탭·세트)과 없는 것은 **실행하지 않고 까닭을 돌려준다** — 예전 스토어
   *    함수들은 그냥 `return` 이라 조수가 성공으로 알았다 (선결 조건 3-2). */
  removeAt: (target: DelTarget) => Promise<{ ok: true; plan: DelPlan } | { ok: false; blocked: NonNullable<DelPlan["blocked"]> }>;

  /** 탭의 필드를 갈아 끼운다 (슬롯 목록·공통 접두).
   *  ★예전엔 SlotStrip 이 `useWs.setState` 로 스토어를 직접 만졌다 — 저장 예약이 컴포넌트에
   *    흩어져 있어 어디서 무엇이 저장되는지 알 수 없었다. 창구를 여기 하나로 모은다. */
  patchSceneGroup: (id: string, patch: Partial<Extract<SceneGroup, { kind: "sceneGroup" }>>) => void;
  /** 씬을 하나 더한다. `from` 을 주면 그 씬의 복제, `after` 를 주면 **그 카드 안에서** 그 뒤에.
   *  ★번호는 탭의 `cellSeq` 가 발급한다 — 컴포넌트가 id 를 만들지 않고, 카드가 여럿이어도
   *    번호는 탭 안에서 유일하다 (결과가 `cell_id` 로 묶이므로).
   *  ★`cardId` 를 안 주면 **첫 카드**에 붙는다. */
  addSlot: (
    tabId: string,
    opts?: { cardId?: string; after?: number; from?: Slot; name?: string },
  ) => void;

  // ── 씬 세트 카드 (탭에 얹는 단위) ──
  /** 카드를 얹는다. `cells` 를 주면 덱에서 떨군 것, 없으면 씬 하나짜리 새 카드 */
  addCard: (
    tabId: string,
    card?: { name?: string; srcId?: string; color?: [string, string]; cells?: Slot[] },
  ) => void;
  /** 카드를 뺀다. ★확인을 받지 않는다 — `Ctrl+Z` 로 되돌린다 (사용자 결정 2026-08-11) */
  removeCard: (groupId: string, cardId: string) => void;
  /** 카드의 필드를 갈아 끼운다 (이름·씬 목록) */
  setCard: (groupId: string, cardId: string, patch: Partial<SceneCard>) => void;
  /** 씬을 **어느 카드의 어느 자리로든** 옮긴다 — 같은 카드 안이든, 다른 카드로든
   *  (v2 `index.html:11860-12002` 의 슬롯 드래그. 그쪽은 슬롯이 한 줄이라 카드 층이 없었다).
   *  `toIndex` 는 **틈 번호**다 (0..n, `useReorder` 규약과 같다). 음수면 그 카드의 끝. */
  moveScene: (groupId: string, cellId: string, toCardId: string, toIndex: number) => void;
  /** 카드 자체의 순서. `toIndex` 도 **틈 번호**다 */
  moveCard: (groupId: string, cardId: string, toIndex: number) => void;

  // ── 캐릭터 (멀티 전용) ──
  activeTabOf: () => WsTab | undefined;
  switchTab: (id: string) => void;
  addTab: (name?: string) => void;
  renameTab: (id: string, name: string) => void;
  removeTab: (id: string) => void;
  /** ★★**줄에 늘어선 것은 끌어서 차례를 바꾼다** (사용자 지시 2026-08-24).
   *  셋 다 `to` 는 칸이 아니라 **틈 번호**다 (`lib/moveTo` 의 규약, `useReorder` 가 그렇게 준다).
   *  ★`moveSceneGroup` 의 `from`·`to` 는 **지금 탭에 보이는 세트**의 번호다 — 화면에 안 보이는
   *    다른 탭의 세트는 자리가 안 흔들린다 (그쪽 줄의 차례는 그쪽 것이다). */
  moveWs: (from: number, to: number) => void;
  moveTab: (from: number, to: number) => void;
  moveSceneGroup: (from: number, to: number) => void;
  /** 탭을 **다른 워크스페이스로** 옮긴다 (사용자 지시 2026-08-28). 씬 그룹·그림·레코드·썸네일
   *  캐시까지 서버가 함께 옮긴다 (`Store.move_tab`). 받는 쪽은 다음에 열 때 읽는다. */
  moveTabToWs: (tabId: string, to: string) => Promise<void>;
  moveGroupToTab: (groupId: string, toTabId: string) => Promise<void>;
};

/** 새 워크스페이스의 첫 모습.
 *
 *  ★**씬 탭 하나로 시작한다** (싱글 폐기 2026-08-11).
 *  ★모양은 `addSceneGroup` 과 같다 — **카드도 씬도 없이**·`idOnly`.
 *  ★캐릭터도 여기서 만든다. 안 만들면 `migrate` 의 고아 처리가 **탭 이름으로** 하나를
 *    지어내서, 캐릭터 탭에 「새 세트」라고 뜬다. */
/** ★★새로 만드는 탭·워크스페이스의 프롬프트 — **카드가 하나도 없다** (사용자 지시 2026-08-20:
 *  *"그냥 아예 카드도 없어야된다는 뜻. 유저가 +를 눌러야 생김"*).
 *  쓸 것이 있으면 **덱에서 끌어다 쓴다**.
 *  ★`styleOn: false` 를 **명시**한다 — 값이 없으면 「켜짐」으로 읽히는데(옛 워크스페이스가
 *    카드를 잃지 않게 한 규칙, `prompt.load`), 새 것은 꺼진 채로 시작해야 한다. */
const freshPrompt = (): TabPrompt => ({ base: [], baseUc: [], styleOn: false });

/** 탭이 다른 워크스페이스로 **옮겨지는 중**인 워크스페이스 이름 — 그동안 그 spec 의 자동 저장을 멈춘다
 *  (`moveTabToWs`·`save`). 화면은 놓는 즉시 탭을 뺀 임시 상태를 들고 있는데, 그것을 서버에 쓰면
 *  서버가 옮기려는 탭이 파일에서 사라져 옮기기가 실패한다. */
let moveBusy: string | null = null;
/** 멈춰 있는 동안 저장이 들어왔나 — 끝나면 한 번 몰아서 쓴다 */
let saveHeld = false;

/** 지금 워크스페이스를 서버에서 **다시** 읽는다 — 화면이 든 spec 을 버린다 (409 · 옮기기 뒤). */
async function reload(get: () => S, set: (p: Partial<S>) => void): Promise<void> {
  const name = get().current;
  if (!name) return;
  const r = await api<{ spec: Spec | null; records: Rec[] }>(`/api/workspaces/${encodeURIComponent(name)}`);
  if (!r.spec || get().current !== name) return;
  const spec = keepView(migrate(r.spec), get().spec);   // ★보고 있는 탭은 화면이 정본이다 (`keepView`)
  clearUndo();
  set({ spec, records: dedupeByFile(r.records ?? []) });
  usePrompt.getState().load(promptOf(spec, activeGroupOf(spec)));
}

const activeGroupOf = (spec: Spec): SceneGroup | undefined =>
  spec.sceneGroups.find((x) => x.id === spec.activeSceneGroup) ?? spec.sceneGroups[0];

/** 서버가 준 spec 에 **지금 보고 있는 자리**를 얹는다 (`activeTab`·`activeSceneGroup`).
 *
 *  ★★사용자 지적 2026-08-28: *"씬 그룹을 다른 탭에 옮긴 후에 옮긴 탭으로 들어갔는데, 옮기는 게
 *    완료된 후에 강제로 원래 있던 탭이 열림."* 옮기는 동안에는 자동 저장을 멈추므로(`moveBusy`),
 *    그 사이에 바꾼 탭은 **파일에 안 적힌다**. 서버는 파일에 적힌 옛 활성 탭을 그대로 돌려주는데
 *    그것을 통째로 대입하면 화면이 뒤로 끌려간다. 보고 있는 자리는 **화면이 정본**이다.
 *  ★살아 있는 것만 얹는다 — 없어진 것을 가리키면 화면이 빈 채로 뜬다. 세트는 그 탭의 것이어야
 *    한다 (아니면 그 탭의 첫 세트로). */
function keepView(next: Spec, local: Spec | null): Spec {
  if (!local) return next;
  const tabs = next.tabs ?? [];
  const activeTab = tabs.some((c) => c.id === local.activeTab) ? local.activeTab : next.activeTab;
  const mine = next.sceneGroups.filter((x) => x.kind === "sceneGroup" && x.tabId === activeTab);
  const keep = mine.some((x) => x.id === local.activeSceneGroup)
    ? local.activeSceneGroup
    : next.sceneGroups.some((x) => x.id === next.activeSceneGroup)
        && mine.some((x) => x.id === next.activeSceneGroup)
      ? next.activeSceneGroup
      : (mine[0]?.id ?? next.activeSceneGroup);
  if (activeTab === next.activeTab && keep === next.activeSceneGroup) return next;
  return { ...next, activeTab, activeSceneGroup: keep };
}

/** 탭 하나를 뺀 spec — **화면용 임시 상태**다 (`moveTabToWs`). 서버가 같은 규칙으로 만든 spec 이
 *  답으로 오면 그것으로 갈린다. 마지막 탭이면 서버와 같은 모양의 빈 탭·빈 세트를 세운다
 *  (id 만 임시다 — 서버 답이 서버 것으로 바꾼다). */
function withoutTab(
  spec: Spec,
  tabId: string,
  fill: { tab: string; group: string; prompt: TabPrompt },
): Spec {
  const gone = new Set(
    spec.sceneGroups.filter((x) => x.kind === "sceneGroup" && x.tabId === tabId).map((x) => x.id),
  );
  let tabs = (spec.tabs ?? []).filter((c) => c.id !== tabId);
  let sceneGroups = spec.sceneGroups.filter((x) => !gone.has(x.id));
  if (!tabs.length) {
    const tid = "ch_" + Math.random().toString(36).slice(2, 8);
    tabs = [{ id: tid, name: fill.tab, prompt: fill.prompt }];
    sceneGroups = [
      ...sceneGroups,
      {
        id: "tab_" + Math.random().toString(36).slice(2, 8),
        kind: "sceneGroup",
        name: fill.group,
        tabId: tid,
        idOnly: true,
        cards: [],
        cellSeq: 0,
        cardSeq: 0,
      } as SceneGroup,
    ];
  }
  const activeTab = tabs.some((c) => c.id === spec.activeTab) ? spec.activeTab : tabs[0].id;
  const mine = sceneGroups.filter((x) => x.kind === "sceneGroup" && x.tabId === activeTab);
  const activeSceneGroup = sceneGroups.some((x) => x.id === spec.activeSceneGroup)
    ? spec.activeSceneGroup
    : (mine[0]?.id ?? sceneGroups[0]?.id ?? "");
  return { ...spec, tabs, sceneGroups, activeTab, activeSceneGroup };
}

/** 그 세트들 중 **생성 중이거나 큐에 걸린 것**이 있나 (`store/queue` 의 대기 목록).
 *
 *  ★★큐는 **넣을 때의 값**을 들고 간다 (워크스페이스·탭 이름·세트 이름). 그래서 생성 중에
 *    옮기면 도착한 그림이 옛 자리로 저장되고, 워크스페이스를 건너간 경우에는 **떠나온 쪽**에
 *    기록까지 남아 앱 어디에도 안 뜬다. 그래서 **옮기기를 거절한다** (사용자 결정 2026-08-28).
 *  ★큐를 취소해서 풀 수 있는 문제가 아니다 — 이미 NAI 로 나간 한 장은 취소가 안 된다.
 *    끝난 뒤에 옮기면 된다.
 *  ★여기서 보는 것은 **이 창이 넣은 것**이라, 다른 창이 넣은 것은 서버가 막는다
 *    (`backend/server.py` 의 `generating_targets`). 화면 쪽은 **바로 알려 주기 위한** 것이다. */
async function generating(groupIds: Set<string>): Promise<boolean> {
  /* ★값으로 부르면 순환이 된다 (`store/queue` 가 이 파일을 읽는다) — **부를 때** 싣는다
     (`runRenumber` 가 `gen.ts` 를 부르는 방식과 같다). */
  const { useQueue } = await import("./queue");
  const q = useQueue.getState();
  const cur = q.progress.current_cell?.scene_group_id ?? null;
  return q.pending.some((x) => !!x.groupId && groupIds.has(x.groupId)) || (!!cur && groupIds.has(cur));
}

/** 씬 그룹 하나를 **다른 탭 밑으로** 옮긴 spec — **화면용 임시 상태**다 (`moveGroupToTab`).
 *  서버가 같은 규칙으로 만든 spec 이 답으로 오면 그것으로 갈린다 (`Store._move_group_locked`).
 *  ★받는 탭의 **줄 끝**에 세운다 — 끌어다 놓은 것이 어디로 갔는지 눈으로 찾을 수 있어야 한다.
 *  ★그 탭의 마지막 세트였으면 빈 세트를 하나 세운다 (세트가 없는 탭은 생성이 불가능하다). */
function withGroupMoved(spec: Spec, groupId: string, toTabId: string, fillGroup: string): Spec {
  const g = spec.sceneGroups.find((x) => x.id === groupId);
  if (!g || g.kind !== "sceneGroup") return spec;
  const srcTab = g.tabId;
  const rest = spec.sceneGroups.filter((x) => x.id !== groupId);
  let at = rest.length;
  rest.forEach((x, i) => {
    if (x.kind === "sceneGroup" && x.tabId === toTabId) at = i + 1;
  });
  const sceneGroups = [...rest.slice(0, at), { ...g, tabId: toTabId }, ...rest.slice(at)];
  const left = sceneGroups.filter((x) => x.kind === "sceneGroup" && x.tabId === srcTab);
  let fresh = "";
  if (!left.length) {
    fresh = "tab_" + Math.random().toString(36).slice(2, 8);
    sceneGroups.push({
      id: fresh,
      kind: "sceneGroup",
      name: fillGroup,
      tabId: srcTab,
      idOnly: true,
      cards: [],
      cellSeq: 0,
      cardSeq: 0,
    } as SceneGroup);
  }
  const activeSceneGroup =
    spec.activeSceneGroup === groupId && spec.activeTab === srcTab
      ? (left[0]?.id ?? fresh)
      : spec.activeSceneGroup;
  return { ...spec, sceneGroups, activeSceneGroup };
}

/** 개명이 도는 중인가 — ★**한 번에 하나만** (`renumberSet` 의 ★★주) */
let renumBusy = false;
/** 도는 동안 또 들어온 그룹 — 끝나고 한 번만 다시 돈다 */
const renumAgain = new Set<string>();

/** 실제로 서버에 개명을 시키고 화면의 경로를 갈아 끼운다.
 *  ★기록·「지운 것」·**별표**가 전부 경로로 적혀 있다 — 셋을 함께 옮긴다. */
async function runRenumber(
  get: () => S,
  set: (p: Partial<S>) => void,
  groupId: string,
): Promise<void> {
  const { current, spec, records } = get();
  const tab = spec?.sceneGroups.find((x) => x.id === groupId);
  if (!current || !spec || tab?.kind !== "sceneGroup") return;
  /* ★값으로 가져오면 순환이 된다 (`gen.ts` 가 이 파일을 부른다) — **부를 때** 싣는다. */
  const { useGen } = await import("./gen");
  const excludeNo = !!useGen.getState().params.exclude_slot_number;
  const cells = allCells(tab);
  const items = cells.flatMap((c, i) =>
    takesOf(records, { id: tab.id, name: tab.name, idOnly: tab.idOnly }, c).map((r) => ({
      file: r.file,
      cell_no: i + 1,
      cell: c.name,
      exclude_no: excludeNo,
    })),
  );
  if (!items.length) return;
  try {
    /* ★★**여기도 파일을 옮긴다** (사용자 지적 2026-08-28: *"씬 이동에는 이 로직이 안 먹고 있는 것
       같은데? 씬 순서 바꾸는 거"*). 씬 자리가 바뀌면 그 세트의 그림 **전부**가 이름을 바꾼다 —
       실측: 300장이면 이름 바꾸기만 600회 687ms 다 (한 장을 임시 이름으로 비켰다가 제 이름을
       주므로 장당 두 번). 옮기기와 같은 부류의 일이라 같은 잠금을 두른다. */
    const r = await withBusy(t("busy.renumbering"), () =>
      api<{ pairs: { file: string; to: string }[] }>(
      `/api/workspaces/${encodeURIComponent(current)}/renumber`,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ items }) },
    ));
    const moves = new Map(r.pairs.filter((p) => p.file !== p.to).map((p) => [p.file, p.to]));
    if (!moves.size) return;
    const now = get().spec;
    if (!now) return;
    const sel = now.selection;
    set({
      records: get().records.map((x) => (moves.has(x.file) ? { ...x, file: moves.get(x.file)! } : x)),
      spec: {
        ...now,
        // ★별표는 경로로 적혀 있다 — 안 옮기면 조용히 풀린다
        selection: { ...sel, starred: (sel.starred ?? []).map((f) => moves.get(f) ?? f) },
      },
    });
    queueSave(get);
  } catch {
    /* 이름만 옛것으로 남는다 — 자리 이동은 이미 됐다 */
  }
}

const newSpec = (name: string): Spec => ({
  version: 1,
  /* ★★**낱말 이전의 표를 처음부터 찍는다** (실사고 2026-08-27). 찍는 곳이 백엔드의
     `migrate_terms.py` 뿐이라, 앱이 만든 워크스페이스에는 표가 없었다. 그러면 다음에 켤 때
     그 이전이 **v1 로 보고 자리를 맞바꿔** 탭이 씬 그룹 자리로 밀려들어가고 진짜 씬 그룹이
     버려진다 — 화면에서 씬 카드가 통째로 사라졌다.
     ★값은 `backend/migrate_terms.py` 의 `SPEC_VERSION` 과 같아야 한다. 판정이 둘을 맞대 본다. */
  specVersion: 3,
  id: "ws_" + Date.now().toString(36),
  name,
  prompt: { base: [], baseUc: [] },
  params: {},
  sceneGroups: [
    {
      id: "tab_1",
      kind: "sceneGroup",
      name: t("sceneGroup.newSet"),
      idOnly: true,
      tabId: "ch_1",
      /* ★★**씬도 비어 있다** (사용자 지시 2026-08-20). 카드가 없으면 씬 줄이 「씬 세트를
         만들어 시작」 자리를 띄우고, 거기서 `+` 를 눌러야 생긴다 — 프롬프트 카드·덱과
         같은 규칙이다 (*"유저가 +를 눌러야 생김"*). 예전에는 이름 없는 씬 하나가 박힌 채
         시작해서, 쓰는 사람이 **먼저 지우거나 이름부터 고치는 일**을 했다. */
      cards: [],
      cellSeq: 0,
      cardSeq: 0,
    },
  ],
  activeSceneGroup: "tab_1",
  // ★첫 탭도 **「새 탭」**이다 (사용자 지시 2026-08-20) — 새로 만드는 탭과 이름 규칙이
  //   달라서 첫 탭만 「탭 1」이었다. 이름을 짓는 말은 하나면 된다 (`chars.newName`).
  tabs: [{ id: "ch_1", name: t("tab.newName"), prompt: freshPrompt() }],
  activeTab: "ch_1",
  selection: { starred: [] },
});

/** 옛 워크스페이스를 새 구조로 옮긴다 — **탭에 프롬프트가 없으면 spec.prompt 를 씨앗으로.**
 *  ★조용히 버리지 않는다. 예전 워크스페이스의 프롬프트가 사라지면 사용자가 알아챌 방법이 없다. */
function migrate(spec: Spec): Spec {
  let changed = false;
  // ★카드 층 이전 (2026-08-11). 옛 세트 탭은 `cells`·`prefix` 를 **직접** 들었다.
  //   그것을 **카드 한 장**으로 감싼다 — 아무것도 안 잃고, 열면 지금까지와 똑같이 보인다.
  //   ★`cellSeq` 는 **탭에 그대로 둔다** (카드로 내리지 않는다) — 씬 번호는 탭 안에서
  //     유일해야 결과(`cell_id`)가 안 섞인다. 위 `SceneCard` 주석 참조.
  spec = {
    ...spec,
    sceneGroups: spec.sceneGroups.map((tb) => {
      // ★감싸는 규칙은 `lib/sceneCards.ts` 에 있다 — 사용자 데이터를 건드리는 자리라
      //   따로 떼어 회귀 테스트를 붙였다 (`sceneCards.test.ts`)
      const wrapped = wrapSetTabInCard(tb as never);
      if (!wrapped) return tb;
      changed = true;
      return wrapped as unknown as SceneGroup;
    }),
  };
  // ★슬롯을 블록으로 (2026-08-07). 옛 세션은 문자열 태그를 들고 있다 — 열 때 한 번 옮긴다.
  //   ★카드 층이 생기면서 **카드마다** 돈다 (`cells` 는 이제 카드 안에 있다).
  spec = {
    ...spec,
    sceneGroups: spec.sceneGroups.map((tb) => {
      if (tb.kind !== "sceneGroup") return tb;
      let touched = false;
      const cards = tb.cards.map((k) => {
        if (k.cells.every((c) => Array.isArray(c.blocks))) return k;
        touched = true;
        return {
          ...k,
          cells: k.cells.map((c) => ({ ...c, blocks: slotBlocks(c), tags: undefined, extra: undefined })),
        };
      });
      if (!touched) return tb;
      changed = true;
      return { ...tb, cards };
    }),
  };
  const tabs = spec.sceneGroups.map((t) => {
    if (t.prompt) return t;
    changed = true;
    return { ...t, prompt: { base: defaultBase(), baseUc: defaultUc() } };
  });
  // ★캐릭터 층 이전 (2026-08-04). 세트 탭이 들고 있던 프롬프트를 **캐릭터로 올린다** —
  //   탭마다 하나씩 만들어 담으므로 **아무것도 잃지 않는다.** 이름은 그 탭 이름을 쓴다.
  let tabList = spec.tabs ?? [];
  let sets2 = tabs;
  const orphan = sets2.filter((t) => t.kind === "sceneGroup" && !t.tabId);
  if (orphan.length || !tabList.length) {
    const made: WsTab[] = [];
    sets2 = sets2.map((t) => {
      if (t.kind !== "sceneGroup" || t.tabId) return t;
      const c: WsTab = {
        id: "ch_" + Math.random().toString(36).slice(2, 8),
        name: t.name,
        prompt: t.prompt ?? { base: defaultBase(), baseUc: defaultUc() },
      };
      made.push(c);
      return { ...t, tabId: c.id };
    });
    if (made.length) {
      tabList = [...tabList, ...made];
      changed = true;
    }
  }
  if (!tabList.length) {
    tabList = [{ id: "ch_1", name: t("tab.newName"), prompt: { base: defaultBase(), baseUc: defaultUc() } }];
    changed = true;
  }
  /* ★★**세트가 하나도 없는 탭을 두지 않는다** (사용자 지시 2026-08-26: *"세트가 하나도 없으면
       생성이 불가능하기 때문에, 탭과 세트가 하나도 없는 상태가 되면 무조건 기본값을 만들어
       줘야 할 듯"*). 실제로 그런 워크스페이스가 나왔다 (조수가 테스트하다 지운 것으로 보인다).
     ★지우는 창구는 마지막 세트를 막고 있지만(`planRemove` 의 `last_set`), 막는 것과 **고치는
       것**은 다르다 — 이미 그렇게 된 파일은 아무도 되돌려 주지 않았다. 여는 자리에서 메운다.
     ★모양은 새 워크스페이스·새 탭의 세트와 **같다**: 카드 없이 시작한다 (사용자 지시
       2026-08-20). 탭이 생기는 길마다 기본값이 갈리지 않게 여기서도 같은 모양을 쓴다. */
  for (const c of tabList) {
    if (sets2.some((x) => x.kind === "sceneGroup" && (x as { tabId?: string }).tabId === c.id)) continue;
    sets2 = [
      ...sets2,
      {
        id: "tab_" + Math.random().toString(36).slice(2, 8),
        kind: "sceneGroup",
        name: t("sceneGroup.newSet"),
        tabId: c.id,
        idOnly: true,
        cards: [],
        cellSeq: 0,
        cardSeq: 0,
      } as SceneGroup,
    ];
    changed = true;
  }
  const activeTab = spec.activeTab && tabList.some((c) => c.id === spec.activeTab)
    ? spec.activeTab
    : tabList[0].id;
  if (activeTab !== spec.activeTab) changed = true;
  /* ★활성 세트도 **살아 있는 것**을 가리켜야 한다 — 없어진 것을 가리키면 화면이 빈 채로 뜨고,
     생성은 「열려 있는 세트가 없습니다」로 막힌다. 그 탭의 첫 세트로 되돌린다. */
  const mine = sets2.filter((x) => x.kind === "sceneGroup" && (x as { tabId?: string }).tabId === activeTab);
  const activeSceneGroup = spec.activeSceneGroup && sets2.some((x) => x.id === spec.activeSceneGroup)
    ? spec.activeSceneGroup
    : (mine[0]?.id ?? sets2[0]?.id ?? spec.activeSceneGroup);
  if (activeSceneGroup !== spec.activeSceneGroup) changed = true;
  /* ★지운 그림의 목록은 걷었다 (2026-08-28, `Spec.selection` 의 ★★주). 옛 파일에 남은 것은 여기서
     뗀다 — 두면 수십 KB 를 저장마다 끌고 다닌다. */
  let selection = spec.selection ?? { starred: [] };
  if ("deleted" in selection) {
    selection = { starred: selection.starred ?? [] };
    changed = true;
  }
  return changed ? { ...spec, sceneGroups: sets2, tabs: tabList, activeTab, activeSceneGroup, selection } : spec;
}

/** 선별 되돌리기 스택 — **서버에 저장하지 않는다.**
 *
 *  ★spec 안에 넣지 않는 이유: spec 은 통째로 서버에 PUT 되는 것이라, 되돌리기 이력이
 *    끼면 워크스페이스 파일이 이력으로 불어난다. 되돌리기는 이 세션의 것이다.
 *  ★범위는 **숨김(휴지통)뿐이다** (사용자 결정 2026-08-03; 별표는 걷었다 2026-08-22). 태그 입력·슬롯 삭제·탭 닫기는
 *    안 들어간다 — 입력칸에 커서가 있으면 Ctrl+Z 를 브라우저에 넘겨 글자 되돌리기가 살아 있게 한다.
 *  워크스페이스를 옮기면 비운다 (다른 워크스페이스의 파일을 되살리면 안 된다). */
/* ★★옛 전용 스택은 걷어냈다 — 되돌리기는 `lib/undo` 하나로 모였다 (사용자 지시 2026-08-22).
     스택이 둘이면 부르는 쪽이 순서를 정하게 되고, 그 순서가 곧 **엉뚱한 것이 되살아나는** 길이
     된다 (`lib/undo` 머리 ★★주). */

/** 슬롯 id 에서 번호를 읽는다 (`c3` -> 3). 발급기가 없는 옛 탭을 이어 받을 때만 쓴다. */
function maxCellNum(cells: Slot[]): number {
  let max = -1;
  for (const c of cells) {
    const m = /^c(\d+)$/.exec(c.id);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return max;
}

/** 지금 편집기에 있는 것을 담는다 (자리를 떠나기 직전에 부른다).
 *  ★**멀티면 캐릭터에, 싱글이면 탭에** 담는다 — 프롬프트의 주인이 다르다. */
function stash(spec: Spec, groupId: string): Spec {
  const snap = usePrompt.getState().snapshot();
  const tab = spec.sceneGroups.find((t) => t.id === groupId);
  if (tab?.kind === "sceneGroup") {
    const cid = tab.tabId ?? spec.activeTab;
    if (!cid) return spec;
    return { ...spec, tabs: (spec.tabs ?? []).map((c) => (c.id === cid ? { ...c, prompt: snap } : c)) };
  }
  return { ...spec, sceneGroups: spec.sceneGroups.map((t) => (t.id === groupId ? { ...t, prompt: snap } : t)) };
}

/** 그 탭에서 편집기에 꺼내 놓을 프롬프트 — 멀티는 캐릭터 것이다 */
export function promptOf(spec: Spec, tab: SceneGroup | undefined): TabPrompt {
  const fallback = { base: defaultBase(), baseUc: defaultUc() };
  if (!tab) return spec.prompt ?? fallback;
  if (tab.kind === "sceneGroup") {
    const cid = tab.tabId ?? spec.activeTab;
    return (spec.tabs ?? []).find((c) => c.id === cid)?.prompt ?? fallback;
  }
  return tab.prompt ?? fallback;
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;

/** ★밀린 저장을 **지금** 흘려보낸다. 워크스페이스를 바꾸기 전에 반드시 부른다 —
 *  저장은 400ms 디바운스인데 `save()` 는 **터질 때의** current/spec 을 읽는다. 편집 직후
 *  탭을 바꾸면 그 편집이 어디에도 안 써진다 (탭이 생기며 자주 밟게 된 자리). */
async function flushSave(get: () => S) {
  if (!saveTimer) return;
  clearTimeout(saveTimer);
  saveTimer = null;
  await get().save();
}

/** 열어 둔 워크스페이스 이름들 — ★**이름만** 담는다. 내용은 활성 것 하나만 메모리에 있다. */
const TABS_KEY = "peropix.openWs";
const loadTabs = (): string[] => {
  try {
    const v = JSON.parse(localStorage.getItem(TABS_KEY) || "[]");
    return Array.isArray(v) ? v.filter((x) => typeof x === "string").slice(0, 20) : [];
  } catch {
    return [];
  }
};
const saveTabs = (v: string[]) => {
  try {
    localStorage.setItem(TABS_KEY, JSON.stringify(v));
  } catch {
    /* 저장 못 해도 이번 실행에는 그대로 돈다 */
  }
};

/** 마지막으로 **보고 있던** 워크스페이스 — 켜면 여기로 돌아온다 (사용자 지시 2026-08-08).
 *
 *  ★열린 탭 목록(`openWs`)과 **다른 정보**라 키를 따로 둔다. 탭 순서를 안 건드리고
 *    활성만 옮길 수 있어야 하는데, "목록의 마지막 = 활성"으로 겸하면 탭을 누를 때마다
 *    순서가 흔들린다. */
const ACTIVE_KEY = "peropix.activeWs";
const loadActive = (): string => {
  try {
    return localStorage.getItem(ACTIVE_KEY) || "";
  } catch {
    return "";
  }
};
const saveActive = (v: string) => {
  try {
    if (v) localStorage.setItem(ACTIVE_KEY, v);
    else localStorage.removeItem(ACTIVE_KEY);
  } catch {
    /* 저장 못 해도 이번 실행에는 그대로 돈다 */
  }
};

/** 워크스페이스를 갈아 끼우기 **직전**에 부를 것들.
 *
 *  ★★`gen.ts` 가 여기에 「지금 탭의 생성 옵션을 담기」를 매단다. 스토어 구독으로는 못 한다 —
 *    구독은 `spec` 이 **이미 갈린 뒤**에 돌아서, 담으려는 순간에는 담을 자리(옛 spec)가 없다.
 *    그래서 워크스페이스를 옮기면 떠나는 탭의 수치가 통째로 사라졌다 (2026-08-23).
 *  ★두 파일이 서로를 부르므로(순환) `workspace.ts` 는 `gen.ts` 를 **값으로 못 부른다**.
 *    이름을 등록해 두고 부르는 이 길이 그 제약을 지나는 방법이다. */
const beforeWsSwitch: (() => void)[] = [];
export const onBeforeWsSwitch = (fn: () => void) => {
  beforeWsSwitch.push(fn);
};

export const useWs = create<S>((set, get) => ({
  list: [],
  current: "",
  openWs: loadTabs(),
  spec: null,
  records: [],
  loading: true,

  /** 목록을 읽고 **마지막에 보던 워크스페이스를 그대로 연다** (사용자 지시 2026-08-08).
   *
   *  ★첫 화면(고르는 화면)은 없앴다 — 켜면 하던 자리가 바로 보여야 한다. 고르는 창구는
   *    탭 줄의 「+」가 띄우는 모달 하나뿐이다.
   *  ★열어 뒀던 탭 중 **없어진 것은 조용히 뺀다** — 지운 워크스페이스가 탭으로 남으면
   *    눌러도 404 만 난다. */
  async init() {
    const { items } = await api<{ items: WsInfo[] }>("/api/workspaces");
    const alive = new Set(items.map((x) => x.name));
    const tabs = get().openWs.filter((n) => alive.has(n));
    if (tabs.length !== get().openWs.length) saveTabs(tabs);
    set({ list: items, openWs: tabs });

    const want = loadActive();
    // 없어졌으면 옆 탭 → 그것도 없으면 **가장 최근에 고친 것**
    const recent = [...items].sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
    const pick = (alive.has(want) && want) || tabs[tabs.length - 1] || recent[0]?.name || "";
    if (!pick) {
      set({ loading: false }); // 진짜 첫 실행 — 만들 때까지 모달이 뜬다
      return;
    }
    try {
      await get().open(pick);
    } catch {
      set({ loading: false }); // 여는 데 실패해도 앱은 뜬다 (모달에서 다시 고른다)
    }
  },

  /** 열어 둔 워크스페이스가 하나도 없는 상태로 (마지막 탭을 닫았거나 지웠을 때).
   *  ★돌아갈 첫 화면은 없다 — 앱이 빈 셸 + 고르기 모달을 띄운다. */
  close() {
    clearUndo();
    saveActive("");
    set({ current: "", spec: null, records: [] });
  },

  /** 탭을 닫는다. 활성 탭을 닫으면 옆 탭으로, 마지막이면 게이트로.
   *  ★내용은 어차피 활성 것 하나뿐이라 "닫는다"는 목록에서 빼는 것이 전부다. */
  async closeWs(name) {
    const tabs = get().openWs.filter((x) => x !== name);
    saveTabs(tabs);
    set({ openWs: tabs });
    if (get().current !== name) return;
    await flushSave(get); // ★밀린 편집을 먼저 쓴다
    if (tabs.length) await get().open(tabs[tabs.length - 1]);
    else get().close();
  },

  async open(name) {
    if (get().current === name) return;
    // ★떠나기 **전에** 지금 탭의 생성 옵션을 담는다 (`onBeforeWsSwitch` 의 ★★주)
    for (const fn of beforeWsSwitch) fn();
    await flushSave(get); // ★밀린 편집을 먼저 쓴다 (아래 flushSave 주석)
    set({ loading: true });
    const r = await api<{ spec: Spec | null; records: Rec[] }>(
      `/api/workspaces/${encodeURIComponent(name)}`,
    );
    if (!r.spec) {
      /* ★★서버가 spec 을 못 줬다고 **새 spec 을 만들어 그 이름으로 저장하지 않는다** (2026-08-28).
         예전의 `r.spec ?? newSpec(name)` 은 읽기가 한 번만 헛돌아도(파일 교체 순간·잠금) 그
         워크스페이스를 빈 탭 하나로 덮는 길이었다. 만드는 창구는 `create` 하나다. */
      set({ loading: false });
      toast(t("gate.readFailed", { name }), "warn");
      return;
    }
    const spec = migrate(r.spec);
    clearUndo(); // ★다른 워크스페이스의 파일·블록을 되살리면 안 된다
    const tabs = get().openWs.includes(name) ? get().openWs : [...get().openWs, name];
    saveTabs(tabs);
    saveActive(name); // 켤 때 여기로 돌아온다
    // ★같은 경로를 가리키는 줄은 **하나로 접어** 들인다 (`dedupeByFile` 의 ★★주)
    set({ current: name, spec, records: dedupeByFile(r.records ?? []), loading: false, openWs: tabs });
    // ★AI 파일 도구의 기준을 알려 준다 — 백엔드는 어느 워크스페이스를 보고 있는지 모른다
    //   (사용자 지시 2026-08-08: 정리는 워크스페이스 안에서만)
    void api("/api/agent/workspace", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    }).catch(() => {});
    // ★프롬프트는 **탭이** 들고 있다 — 활성 탭의 것을 편집기로 밀어 넣는다
    const tab = spec.sceneGroups.find((t) => t.id === spec.activeSceneGroup) ?? spec.sceneGroups[0];
    usePrompt.getState().load(promptOf(spec, tab));
  },

  async create(input?: string) {
    const base = (input ?? t("gate.newWorkspace")).trim() || t("gate.newWorkspace");
    const name = uniqueName(base, get().list.map((x) => x.name));
    const spec = newSpec(name);
    // 새 워크스페이스는 **빈 채로** 시작한다 — 이전 작업을 물고 오지 않는다
    spec.prompt = freshPrompt();
    await api(`/api/workspaces/${encodeURIComponent(name)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ spec }),
    });
    const { items } = await api<{ items: WsInfo[] }>("/api/workspaces");
    set({ list: items });
    await get().open(name);
  },

  async rename(name) {
    await get().renameWs(get().current, name);
  },

  /** ★게이트 목록의 이름변경이 쓴다 (사용자 지시 2026-08-29) — **아무 워크스페이스나** 받는다.
   *  열려 있지 않은 것은 서버 폴더·목록만 바뀌고, 열려 있으면 탭·현재 이름까지 따라간다. */
  async renameWs(old, name) {
    if (!name.trim() || name === old) return;
    const r = await api<{ name: string }>(
      `/api/workspaces/${encodeURIComponent(old)}/rename`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      },
    );
    const { items } = await api<{ items: WsInfo[] }>("/api/workspaces");
    // ★탭도 새 이름으로 — 옛 이름이 탭에 남으면 눌러도 없는 워크스페이스를 부른다
    const tabs = get().openWs.map((n) => (n === old ? r.name : n));
    saveTabs(tabs);
    if (get().current === old) {
      const spec = get().spec;
      if (spec) spec.name = r.name;
      saveActive(r.name);
      set({ list: items, current: r.name, openWs: tabs });
      await get().save();
    } else {
      set({ list: items, openWs: tabs });
    }
  },

  /** ★워크스페이스 삭제도 **휴지통을 거친다** (사용자 결정 2026-08-18, v2-port-audit D7).
   *  이 앱에서 가장 크게 없어지는 동작인데 예전에는 `rmtree` 라 되돌릴 길이 아예 없었다. */
  async remove(name) {
    // ★열려 있던 탭 줄을 **지우기 전에** 적어 둔다 — 되돌릴 때 폴더만 살아나고 탭이
    //   안 돌아오면 "되돌렸다"고 말해 놓고 화면은 그대로인 상태가 된다
    const hadTabs = get().openWs;
    const r = await api<{ trashed: TrashEntry[] }>(
      `/api/workspaces/${encodeURIComponent(name)}`,
      { method: "DELETE" },
    );
    const { items } = await api<{ items: WsInfo[] }>("/api/workspaces");
    set({ list: items });
    if (r.trashed?.length)
      undoToast(t("common.trashed", { n: 1 }), t("common.undo"), async () => {
        await api("/api/workspaces/restore", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ entries: r.trashed }),
        });
        const back = await api<{ items: WsInfo[] }>("/api/workspaces");
        set({ list: back.items });
        if (hadTabs.includes(name)) {
          saveTabs(hadTabs);
          set({ openWs: hadTabs });
        }
        toast(t("common.restored"));
      });
    // ★지운 것은 탭에서도 뺀다 — 남겨 두면 눌러도 없는 워크스페이스를 부른다
    const tabs = get().openWs.filter((n) => n !== name);
    if (tabs.length !== get().openWs.length) {
      saveTabs(tabs);
      set({ openWs: tabs });
    }
    if (get().current !== name) return;
    if (tabs.length) await get().open(tabs[tabs.length - 1]);
    else get().close();
  },

  async save() {
    const { current, spec } = get();
    if (!current || !spec) return;
    // ★편집기 내용은 **활성 탭에** 담는다 (예전엔 spec.prompt 하나였다).
    //   spec.prompt 는 옛 워크스페이스를 여는 씨앗으로만 남는다 — 여기서 더 쓰지 않는다.
    // ★탭이 서버로 옮겨지는 동안은 쓰지 않는다 — 끝나면 한 번 몰아서 (`moveTabToWs` 의 ★★주)
    if (moveBusy && moveBusy === current) {
      saveHeld = true;
      return;
    }
    const next = stash(spec, spec.activeSceneGroup);
    set({ spec: next });
    try {
      await api(`/api/workspaces/${encodeURIComponent(current)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ spec: next }),
      });
    } catch (e) {
      /* ★★409 = 서버가 「다른 워크스페이스의 내용」이라며 거부했다 (`Store.save` 의 ★★주).
         화면이 든 spec 은 이 워크스페이스 것이 아니므로 버리고 서버 것을 다시 읽는다 —
         그대로 두면 다음 자동 저장이 또 부딪친다. */
      if (e instanceof Error && e.message.startsWith("409")) {
        await reload(get, set);
        toast(t("gate.readBack", { name: current }), "warn");
        return;
      }
      throw e;
    }
  },

  addRecord(r) {
    // ★같은 그림이 두 갈래로 들어온다: (a) 워크스페이스를 열 때 서버가 돌려주는 저장된 기록,
    //   (b) WebSocket `sync` 복원. 큐 스토어의 `seen` 은 **메모리에만** 있어서 새로고침하면
    //   비고, 그러면 서버 기록 위에 복원분이 통째로 겹쳐 쌓였다.
    //   실측(2026-08-03): 6장짜리 탭에서 React 가 `key` 중복을 6건 뱉었다.
    const cur = get().records;
    const at = cur.findIndex((x) => x.file === r.file);
    if (at < 0) return set({ records: [...cur, r] });
    const old = cur[at];
    if (old.ts === r.ts && old.seed === r.seed) return; // 같은 그림 — 그대로 둔다

    /* ★★같은 경로인데 **다른 그림**이다 (사용자 지적 2026-08-20).
       지운 그림은 휴지통으로 **옮겨지므로** 그 이름이 폴더에서 비고, 이름을 다시 쓸 수 있다.
       생성 쪽은 휴지통까지 세어 이름을 안 겹치게 하지만(`Store.next_name`), 휴지통이
       비워진 뒤(24시간)에는 다시 겹칠 수 있다. 그때:
         · 새 레코드를 **버리면** 방금 만든 그림이 화면에 아예 안 뜨고,
         · 옛 그림의 「지움」·「별표」 표식이 **새 그림에 그대로 붙는다.**
       그 자리에 있는 것은 새 그림이므로 레코드를 갈아 끼우고 별표를 뗀다. */
    set({ records: cur.map((x, i) => (i === at ? r : x)) });
    const spec = get().spec;
    if (!spec) return;
    const starred = spec.selection.starred ?? [];
    if (!starred.includes(r.file)) return;
    set({ spec: { ...spec, selection: { ...spec.selection, starred: starred.filter((f) => f !== r.file) } } });
    queueSave(get);
  },

  /** 여러 장을 한 번에 켜고 끈다.
   *
   *  ★한 장씩 `toggle` 을 반복하면 그때마다 spec 이 새로 만들어지고 저장이 예약된다.
   *    20장을 정리하면 스무 번 저장이 나간다. 한 번에 바꾼다. */
  setStars(files, on) {
    const spec = get().spec;
    if (!spec || files.length === 0) return;
    const cur = spec.selection.starred ?? [];
    const touched = new Set(files);
    const next = on
      ? [...cur, ...files.filter((f) => !cur.includes(f))]
      : cur.filter((f) => !touched.has(f));
    if (next.length === cur.length && on) return;
    // ★되돌리는 방법을 **그때 만들어** 로그에 담는다 (`lib/undo`)
    pushUndo(t("common.undoStar"), () => get().restoreStars(cur));
    set({ spec: { ...spec, selection: { ...spec.selection, starred: next } } });
    queueSave(get);
  },

  /** 별표를 그때 상태로 되돌린다 — 로그가 담아 둔 길이다 (직접 부르지 않는다). */
  restoreStars(before) {
    const spec = get().spec;
    if (!spec) return;
    set({ spec: { ...spec, selection: { ...spec.selection, starred: before } } });
    queueSave(get);
  },

  async restoreFiles(trashed, before) {
    const ws = get().current;
    if (!ws || !trashed.length) return;
    /* ★그 사이 같은 이름이 생겼으면 휴지통 쪽이 번호를 붙여 꺼낸다 (`trash.restore_at`) — `pairs` 가
       어디로 갔는지 알려 주므로 줄과 별표를 **새 이름으로** 따라 보낸다 */
    const r = await api<{ pairs: { file: string; to: string }[] }>(
      `/api/workspaces/${encodeURIComponent(ws)}/restore`,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ entries: trashed }) },
    );
    if (get().current !== ws) return;
    const to = new Map(r.pairs.map((p) => [p.file, p.to]));
    const cur = get().records;
    const have = new Set(cur.map((x) => x.file));
    // ★지우기 전 차례를 지킨다 — 되살린 줄은 제자리에, 그 사이 생긴 줄은 뒤에
    const back = before
      .filter((x) => have.has(x.file) || to.has(x.file))
      .map((x) => (to.has(x.file) ? { ...x, file: to.get(x.file)! } : x));
    const inBefore = new Set(before.map((x) => x.file));
    set({ records: [...back, ...cur.filter((x) => !inBefore.has(x.file))] });
    const spec = get().spec;
    const starred = spec?.selection.starred ?? [];
    if (spec && starred.some((f) => to.has(f) && to.get(f) !== f)) {
      set({ spec: { ...spec, selection: { ...spec.selection, starred: starred.map((f) => to.get(f) ?? f) } } });
      queueSave(get);
    }
  },

  /** 「새 탭으로 복제」 — 그림 한 장과 **그 그림의 설정**만 담은 새 탭을 만들고 그리로 옮긴다.
   *
   *  ★**위층(`spec.tabs`, 화면 이름 「탭」)에 만든다.** 아래층(세트)에 더하면 안 된다 —
   *    세트 탭의 프롬프트 주인은 그 위층이라(`promptOf`), 같은 위층 아래에 세트만 늘리면
   *    「그 그림의 설정」이 **지금 보고 있던 세트의 프롬프트를 그대로 덮는다.**
   *    새 위층은 씬 하나짜리 세트를 달고 태어난다(`switchTab`) — 그것이 「1슬롯짜리」다.
   *  ★**순서가 안전장치다**: 옮겨 간 **뒤에** 설정을 얹는다. 거꾸로 하면 `stash` 가 그 설정을
   *    떠나는 탭에 써 넣어 원래 프롬프트가 조용히 사라진다 (`closeSet` 과 같은 종류의 함정). */
  async cloneToNewTab(file, o) {
    const { current, spec, records } = get();
    if (!current || !spec) return null;

    // ★★**그 그림을 뽑을 때의 구조를 그대로 옮긴다** (사용자 지시 2026-08-19:
    //   *"스타일/캐릭터/슬롯 구조 그대로 재현"*). 구조는 **메타데이터에 안 남는다** —
    //   NAI 는 합쳐진 문자열만 저장한다.
    //
    //   ★★그래서 **생성할 때 그때 구조를 레코드에 남긴다** (`gen.ts` 의 `env`).
    //     그것이 있으면 그것이 정본이다 — 그 뒤에 탭을 고치거나 **지웠어도** 그때 환경이 온다.
    //   ★없는 그림(이 기능 전에 만든 것)만 **그 그림이 나온 탭**에서 가져온다.
    //     그때도 지금 보고 있는 탭이 아니라 **레코드가 가리키는 탭**이다 (`tab_id`·`cell_id`).
    // ★구조를 찾아볼 자리 — 워크스페이스 그림은 자기 자신, 보관함 그림은 **그 그림의 출처**다
    //   (`/api/keep/origin`). 출처를 모르는 보관함 그림은 찾아볼 자리가 아예 없다.
    const origin = o.from === "keep" ? (o.origin ?? null) : { ws: current, file };
    const local = origin?.ws === current;
    const rec = local ? records.find((r) => r.file === origin!.file) : undefined;
    const saved = origin
      ? await api<{ env: ShotEnv | null }>(
          `/api/workspaces/${encodeURIComponent(origin.ws)}/env?file=${encodeURIComponent(origin.file)}`,
        ).catch(() => ({ env: null }))
      : { env: null };
    // 편집기 내용을 spec 에 먼저 담는다 — 원본 탭이 지금 보고 있는 탭이면 이게 최신이다
    const cur = stash(spec, spec.activeSceneGroup);
    // ★출처가 **다른 워크스페이스**면 그 탭이 여기 없다 — 지금 보고 있는 탭으로 대신하지 않는다
    //   (그러면 그 그림과 무관한 프롬프트가 「복제」로 온다). 그때는 메타데이터가 세운다.
    const srcTab = local
      ? (cur.sceneGroups.find((x) => x.kind === "sceneGroup" && x.id === rec?.scene_group_id) ??
        cur.sceneGroups.find((x) => x.id === cur.activeSceneGroup))
      : undefined;
    // 스타일·베이스·네거티브·**캐릭터 카드**가 통째로 여기 있다 (`promptOf` — 멀티는 캐릭터 소유)
    const srcPrompt = saved.env?.prompt
      ? structuredClone(saved.env.prompt)
      : srcTab
        ? structuredClone(promptOf(cur, srcTab))
        : null;
    // 그 그림이 나온 **씬과 그 씬이 든 카드**. 못 찾으면 그 탭의 첫 씬
    const fallbackScene =
      srcTab?.kind === "sceneGroup"
        ? (allScenes(srcTab).find((x) => x.cell.id === rec?.cell_id) ?? allScenes(srcTab)[0])
        : undefined;
    /** 남겨 둔 스냅샷이 있으면 그것이, 없으면 그 탭의 씬이 정본이다.
     *  ★둘 다 없는 보관함 그림은 **메타데이터의 씬**을 쓴다 (v2 가 PNG 에 남긴 `slot_prompt`) —
     *    사용자 지적 2026-08-19: 갤러리에서 복제하면 슬롯 프롬프트가 통째로 사라졌다. */
    const srcScene = saved.env
      ? { color: fallbackScene?.card.color, cell: saved.env.cell }
      : fallbackScene
        ? { color: fallbackScene.card.color, cell: fallbackScene.cell }
        : o.scene
          ? { color: undefined, cell: o.scene }
          : undefined;
    const srcDest = saved.env ? saved.env.sceneDest : srcTab?.kind === "sceneGroup" ? srcTab.sceneDest : undefined;

    set({ spec: cur });
    get().addTab(t("tab.cloneName"));
    /* ★★새 탭은 **씬 카드 없이** 시작한다 (`switchTab` 의 ★★주, 2026-08-20). 복제는 그 그림이
       설 씬이 하나 필요하므로 **여기서 만든다.**
       ★없다고 조용히 `return null` 하던 자리다 — 탭만 생기고 프롬프트도 그림도 안 오는
         빈 껍데기가 남았다 (사용자 지적 2026-08-22: *"새 탭으로 복제 안되고 있음"*).
         오류도 토스트도 없어서 무엇이 잘못됐는지 알 수가 없었다. */
    let sp = get().spec;
    let tab = sp?.sceneGroups.find((x) => x.id === sp!.activeSceneGroup);
    if (tab?.kind === "sceneGroup" && !tab.cards.length) {
      get().addCard(tab.id);
      sp = get().spec;
      tab = sp?.sceneGroups.find((x) => x.id === sp!.activeSceneGroup);
    }
    const cell = tab?.kind === "sceneGroup" ? tab.cards[0]?.cells[0] : undefined;
    if (!sp || !tab || tab.kind !== "sceneGroup" || !cell) {
      // ★조용히 돌아가지 않는다 — 여기까지 왔는데 못 만들면 그것이 결함이다
      console.warn("[clone] 새 탭에 씬을 못 만들었다", { tab: tab?.id, kind: tab?.kind });
      return null;
    }

    // 1) 프롬프트 구조 — 스타일·블록·캐릭터 카드 그대로 (새 탭으로 옮긴 **뒤**라 원본이 안 덮인다)
    //    ★구조를 못 찾았으면 **안 건드린다** — 그때는 `apply` 가 메타데이터로 세운다
    if (srcPrompt) usePrompt.getState().load(srcPrompt);
    // 2) 슬롯 구조 — 그 씬을 그대로 옮긴다.
    //    ★`sceneDest`(씬 프롬프트가 베이스로 가나 캐릭터로 가나)도 함께 옮긴다 —
    //      목적지가 다르면 같은 씬이라도 다른 프롬프트가 나간다.
    if (srcScene) {
      get().patchSceneGroup(tab.id, {
        sceneDest: srcDest,
        cards: tab.cards.map((k) =>
          k.id === tab.cards[0]?.id
            ? {
                ...k,
                color: srcScene.color ?? k.color,
                cells: k.cells.map((c) =>
                  c.id === cell.id
                    ? { ...c, name: srcScene.cell.name ?? c.name, blocks: structuredClone(srcScene.cell.blocks ?? []) }
                    : c,
                ),
              }
            : k,
        ),
      });
    }
    // 3) 생성 설정·해상도·시드 — **그 그림의 메타데이터**에서 (구조가 아니라 값이다)
    o.apply?.({ structure: !!srcPrompt });
    // ★`load` 는 저장을 예약하지 않는다 (`prompt.ts` 의 `onEdit` 는 편집에만 붙는다) —
    //   여기서 한 번 흘려보내야 새 탭의 프롬프트가 파일에 남는다
    await get().save();
    const r = await api<{ file: string; record: Rec }>(
      `/api/workspaces/${encodeURIComponent(current)}/copy`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          file,
          /* ★그림이 앉는 자리는 **세트**다 (`CopyBody`). 2026-08-24 개명 뒤에도 여기가
             옛 열쇠(`tab`·`tab_id`)로 남아 있어 서버가 `set` 을 못 받았다.
             ★`tab` 은 이제 **탭 이름**이다 — 저장 경로 한 칸(`멀티/<탭>/<세트>/`)이 된다. */
          scene_group: tab.name,
          scene_group_id: tab.id,
          // ★씬 값을 **넷 다** 싣는다 — 하나라도 비면 그 그림이 어느 씬 것인지 화면이 못 찾는다
          //   (받는 탭은 `idOnly` 라 이름 폴백도 없다, `lib/takes.ts`)
          cell: cell.name,
          cell_id: cell.id,
          cell_no: 1,
          tab: (sp.tabs ?? []).find((c) => c.id === sp.activeTab)?.name ?? null,
          exclude_slot_number: o.excludeNo,
          // ★보관함 그림은 서버가 **보관함에서** 집어 온다. 이 워크스페이스에 레코드가 없으니
          //   시드도 실어 준다 (없으면 0 이 박혀 「같은 시드로 다시」가 헛돈다)
          from_keep: o.from === "keep",
          seed: o.seed,
        }),
      },
    );
    // ★목록을 다시 읽지 않는다 — 서버가 돌려준 레코드 한 줄만 얹으면 화면이 따라온다
    //   (업스케일·「파일로 저장」과 같은 방식)
    get().addRecord(r.record);
    /* ★다중 선택 복제 (사용자 지시 2026-08-29) — 나머지 장도 **같은 씬**으로 보낸다.
       같은 자리라 테이크로 쌓이고, 구조·설정은 첫 장이 이미 세웠다. */
    for (const f of o.extraFiles ?? []) {
      const more = await api<{ file: string; record: Rec }>(
        `/api/workspaces/${encodeURIComponent(current)}/copy`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            file: f,
            scene_group: tab.name,
            scene_group_id: tab.id,
            cell: cell.name,
            cell_id: cell.id,
            cell_no: 1,
            tab: (sp.tabs ?? []).find((c) => c.id === sp.activeTab)?.name ?? null,
            exclude_slot_number: o.excludeNo,
          }),
        },
      );
      get().addRecord(more.record);
    }
    return { file: r.file, cell: cell.id };
  },

  async deleteFiles(files, opts = {}) {
    const { current, spec } = get();
    if (!current || !spec || !files.length) return;
    const r = await api<{ moved: { file: string; at: string }[] }>(
      `/api/workspaces/${encodeURIComponent(current)}/trash`,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ files }) },
    );
    /* ★★**줄을 목록에서 뺀다** — 지운 그림의 목록(`selection.deleted`)은 더 없다 (사용자 결정
       2026-08-28). 파일의 존재가 정본이라 서버가 주는 목록에는 파일이 없는 줄이 애초에 안 들고
       (`Store.live_records`), 화면은 그 규칙을 그 자리에서 따라간다. 되돌리면 줄도 돌아온다. */
    const gone = new Set(files);
    const before = get().records;
    set({ records: before.filter((x) => !gone.has(x.file)) });
    /* ★★**되돌릴 수 없는 삭제의 일부면 항목을 안 남긴다** (`undo: false`, 2026-08-25).
       세트·씬을 지우면서 함께 보낸 그림은, `Ctrl+Z` 로 그림만 되살려 봐야 담길 씬이
       이미 없어 **갈 자리 없는 그림**이 된다 (`removeAt` 의 ★★주).
       ★그림 자체는 휴지통에 있으므로 24시간 안에 꺼낼 수 있다 — 잃는 것은 없다. */
    if (opts.undo !== false)
      pushUndo(t("common.undoImages"), () => void get().restoreFiles(r.moved, before));
  },

  toggleStar(file) {
    get().setStars([file], !get().isStarred(file));
  },

  /** ★`?? []` — 별표가 없던 시절에 저장된 워크스페이스에는 이 칸이 아예 없다 */
  isStarred: (file) => !!get().spec?.selection.starred?.includes(file),

  activeSceneGroup: () => get().spec?.sceneGroups.find((t) => t.id === get().spec!.activeSceneGroup),

  /** 그 탭(`chars`, 화면 이름 「탭」)의 생성 옵션을 담아 둔다.
   *  부르는 쪽은 `store/gen` 의 구독 하나뿐이다. */
  stashGen(tabId, params) {
    const spec = get().spec;
    if (!spec?.tabs) return;
    set({ spec: { ...spec, tabs: spec.tabs.map((c) => (c.id === tabId ? { ...c, gen: params } : c)) } });
    queueSave(get);
  },

  setPreview(patch) {
    const spec = get().spec;
    if (!spec) return;
    // ★기본값은 「꽉차게 · 100%」다 (`Spec.preview` 주석). 없던 워크스페이스도 여기서 갖춰진다
    const cur = spec.preview ?? { fit: true, zoom: 1 };
    set({ spec: { ...spec, preview: { ...cur, ...patch } } });
    queueSave(get);
  },

  setActiveSceneGroup(id) {
    const spec = get().spec;
    if (!spec || spec.activeSceneGroup === id) return;
    // ★떠나는 탭에 지금 편집기 내용을 담고, 오는 탭의 것을 꺼낸다.
    //   이 순서를 지키지 않으면 탭을 옮길 때마다 앞 탭의 프롬프트가 덮인다.
    const stashed = stash(spec, spec.activeSceneGroup);
    const next = stashed.sceneGroups.find((t) => t.id === id);
    set({ spec: { ...stashed, activeSceneGroup: id } });
    usePrompt.getState().load(promptOf(stashed, next));
    queueSave(get);
  },

  addSceneGroup(name, cells) {
    const spec = get().spec;
    if (!spec) return;
    const id = "tab_" + Date.now().toString(36);
    // ★이름이 겹치면 번호를 붙인다 (싱글 탭과 같은 규칙). 탭 이름이 곧 **저장 폴더**라
    //   겹치면 다른 탭의 그림이 같은 폴더에 섞인다.
    const nm = uniqueName(name, spec.sceneGroups.map((x) => x.name));
    const tab: SceneGroup = {
      id,
      kind: "sceneGroup",
      name: nm,
      idOnly: true,
      tabId: spec.activeTab,
      // ★씬은 **카드 한 장**에 담겨 얹힌다 (2026-08-11). 카드 이름은 탭 이름을 물려받는다 —
      //   덱에서 떨군 씬 세트라면 그 카드 이름이 곧 이 탭 이름이라 같은 값이다.
      // ★★씬을 안 주면 **카드도 안 만든다** — 빈 탭은 씬 줄의 「씬 세트 만들기」에서 시작한다
      //   (새 워크스페이스와 같은 모양이다).
      cards: cells.length
        ? [
            {
              id: "k1",
              name: nm,
              cells: cells.map((c, i) =>
                typeof c === "string"
                  ? { id: `c${i}`, name: c, blocks: [] }
                  : { id: `c${i}`, name: c.name, blocks: slotBlocks(c) },
              ),
            },
          ]
        : [],
      cellSeq: cells.length,
      cardSeq: cells.length ? 1 : 0,
      // 새 탭은 **지금 편집기 내용을 물려받는다** — 카드를 떨궈 만든 탭이 빈 프롬프트로
      // 시작하면 바로 생성이 안 돼 한 번 더 손이 간다
      prompt: usePrompt.getState().snapshot(),
    };
    const stashed = stash(spec, spec.activeSceneGroup);
    set({ spec: { ...stashed, sceneGroups: [...stashed.sceneGroups, tab], activeSceneGroup: id } });
    queueSave(get);
  },

  // ── 캐릭터 ──────────────────────────────────────────────
  activeTabOf: () => {
    const sp = get().spec;
    return sp?.tabs?.find((c) => c.id === sp.activeTab);
  },

  switchTab(id) {
    const spec = get().spec;
    if (!spec || spec.activeTab === id) return;
    // ★지금 편집기 내용을 **떠나는 캐릭터에** 담고 옮긴다 (탭 전환과 같은 순서)
    const stashed = stash(spec, spec.activeSceneGroup);
    /* ★★**떠나는 탭에 지금 보던 씬 그룹을 적어 둔다** (사용자 지시 2026-08-30: 탭을 오가면
       마지막으로 보던 씬 그룹이 열려 있게). 기록하는 자리는 여기 하나다 — 어떤 길로 씬 그룹을
       골랐든(선택·새로 만들기·복제) 떠나는 순간의 것이 곧 「마지막으로 보던 것」이다. */
    const tabs = (stashed.tabs ?? []).map((c) =>
      c.id === spec.activeTab ? { ...c, lastSceneGroup: spec.activeSceneGroup } : c,
    );
    // 그 탭의 씬 그룹 중 **마지막으로 보던 것**을 연다 (없으면 첫 것). 하나도 없으면 하나 만든다.
    const mine = stashed.sceneGroups.filter((x) => x.kind === "sceneGroup" && x.tabId === id);
    let next = { ...stashed, tabs, activeTab: id };
    if (mine.length) {
      const last = tabs.find((c) => c.id === id)?.lastSceneGroup;
      next = { ...next, activeSceneGroup: (mine.find((x) => x.id === last) ?? mine[0]).id };
    } else {
      const tid = "tab_" + Date.now().toString(36);
      next = {
        ...next,
        sceneGroups: [
          ...next.sceneGroups,
          {
            id: tid,
            kind: "sceneGroup",
            name: t("sceneGroup.newSet"),
            tabId: id,
            idOnly: true,
            /* ★★**씬 세트 카드 없이 시작한다** (사용자 지적 2026-08-20: *"기본값이 세트카드
               없어야하는데 새탭 만들면 있음"*). 새 워크스페이스(`newSpec`)·새 세트 탭
               (`addSceneGroup([])`)과 **같은 모양**이어야 한다 — 여기만 카드를 얹고 있었다.
               ★탭이 생기는 길이 셋이다(워크스페이스 만들기 · 세트 탭 「+」 · **캐릭터 탭 「+」**).
                 기본값을 바꿀 때는 셋을 함께 본다. */
            cards: [],
            cellSeq: 0,
            cardSeq: 0,
          },
        ],
        activeSceneGroup: tid,
      };
    }
    set({ spec: next });
    usePrompt.getState().load(promptOf(next, next.sceneGroups.find((x) => x.id === next.activeSceneGroup)));
    queueSave(get);
  },

  addTab(name) {
    const spec = get().spec;
    if (!spec) return;
    const bases = (name ?? t("tab.newName")).trim() || t("tab.newName");
    const nm = uniqueName(bases, (spec.tabs ?? []).map((c) => c.name));
    const id = "ch_" + Date.now().toString(36);
    // ★새 캐릭터는 **빈 프롬프트**로 시작한다 — 앞 캐릭터를 물려받으면 둘이 같은 인물이 된다
    const stashed = stash(spec, spec.activeSceneGroup);
    set({
      spec: {
        ...stashed,
        tabs: [...(stashed.tabs ?? []), { id, name: nm, prompt: freshPrompt() }],
      },
    });
    get().switchTab(id);
  },

  renameTab(id, name) {
    const spec = get().spec;
    if (!spec || !name.trim()) return;
    set({
      spec: { ...spec, tabs: (spec.tabs ?? []).map((c) => (c.id === id ? { ...c, name: name.trim() } : c)) },
    });
    queueSave(get);
  },

  /* ── 줄의 차례 바꾸기 (사용자 지시 2026-08-24) ────────────────────────
     ★셈은 `lib/moveTo` **하나**를 쓴다 — 블록·인물·씬이 이미 그것을 쓴다.
     ★어디에 남는가가 셋 다 다르다: 워크스페이스 줄은 **이 컴퓨터의 것**(localStorage)이고,
       탭·세트는 **그 워크스페이스의 것**(`workspace.json`)이다. */

  moveWs(from, to) {
    const next = moveTo(get().openWs, from, to);
    if (next === get().openWs) return;
    saveTabs(next);
    set({ openWs: next });
  },

  moveTab(from, to) {
    const spec = get().spec;
    if (!spec) return;
    const next = moveTo(spec.tabs ?? [], from, to);
    if (next === (spec.tabs ?? [])) return;
    set({ spec: { ...spec, tabs: next } });
    queueSave(get);
  },

  async moveTabToWs(tabId, to) {
    const cur = get().current;
    const spec = get().spec;
    if (!cur || !spec || to === cur || moveBusy) return;
    const tab = (spec.tabs ?? []).find((c) => c.id === tabId);
    if (!tab) return;
    // ★생성 중인 씬이 그 탭에 있으면 옮기지 않는다 (`generating` 의 ★★주)
    const mineIds = new Set(spec.sceneGroups.filter((x) => x.kind === "sceneGroup" && x.tabId === tabId).map((x) => x.id));
    if (await generating(mineIds)) {
      toast(t("busy.generating"), "warn");
      return;
    }
    /* ★마지막 탭을 옮기면 **빈 새 탭이 그 자리에 선다** (사용자 지시 2026-08-28). 모양은 여기서
       준다 — 이름은 이 화면의 언어이고, 빈 프롬프트의 골격은 `addTab` 과 같은 `freshPrompt` 다. */
    const fill = { tab: t("tab.newName"), group: t("sceneGroup.newSet"), prompt: freshPrompt() };
    // ★떠나는 탭의 생성 옵션을 담고, 밀린 편집을 **먼저** 쓴다 — 서버는 파일의 spec 을 읽는다
    for (const fn of beforeWsSwitch) fn();
    await flushSave(get);
    // ★그 사이 화면이 다른 워크스페이스로 갔으면 시작하지 않는다
    if (get().current !== cur || !get().spec) return;
    /* ★★**놓는 즉시 화면에서 뺀다** (사용자 지시 2026-08-28: *"씬이 그렇듯이 시각적으로는 탭 자체가
         즉시 드롭하자마자 이동해야 함"*). 서버는 뒤에서 파일·색인을 옮기고(실측 약 1초), 답이 오면
         그 spec 으로 갈아 끼운다. 실패하면 되돌린다.
       ★★답은 **화면이 아직 이 워크스페이스일 때만** 대입한다 (실사고 2026-08-28: 옮기는 사이 화면이
         받는 쪽으로 넘어가 있었고, 출발 쪽 spec 이 받는 쪽 자리에 대입돼 자동 저장이 그것을 받는 쪽
         이름으로 썼다 — 탭 10개가 사라졌다). 받는 쪽을 보고 있으면 서버 것을 **다시 읽는다** —
         화면이 든 것은 옮기기 전 spec 이라, 그대로 두면 다음 자동 저장이 옮겨 온 탭을 도로 지운다. */
    const before = get().spec!;
    const gone = withoutTab(before, tabId, fill);
    set({ spec: gone });
    if (before.activeTab === tabId) usePrompt.getState().load(promptOf(gone, activeGroupOf(gone)));
    moveBusy = cur;   // ★이 워크스페이스의 자동 저장을 멈춘다 — 임시 상태를 서버에 쓰면 안 된다
    try {
      // ★끝날 때까지 **조작을 잠근다** (`store/busy` 의 ★★주) — 그 사이의 편집은 갈 곳이 없다
      const r = await withBusy(t("busy.movingTab", { name: tab.name }), () =>
        api<{ spec: Spec; records: Rec[]; moved: number }>(
        `/api/workspaces/${encodeURIComponent(cur)}/tabs/${encodeURIComponent(tabId)}/move`,
        { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ to, fill }) },
      ));
      if (get().current === cur) {
        // ★옮기는 동안 사용자가 다른 탭을 열었을 수 있다 — 그 자리를 지킨다 (`keepView` 의 ★★주)
        const next = keepView(migrate(r.spec), get().spec);
        clearUndo();   // ★옮겨 간 블록·그림을 되살리면 안 된다
        set({ spec: next, records: dedupeByFile(r.records ?? []) });
        usePrompt.getState().load(promptOf(next, activeGroupOf(next)));
      } else if (get().current === to) {
        await reload(get, set);
      }
      toast(t("tab.movedTo", { name: tab.name, ws: to, n: r.moved }));
    } catch (e) {
      if (get().current === cur) {
        set({ spec: before });
        usePrompt.getState().load(promptOf(before, activeGroupOf(before)));
      }
      toast(t("tab.moveFailed", { name: tab.name, why: String(e) }), "warn");
    } finally {
      moveBusy = null;
      if (saveHeld) {
        saveHeld = false;
        queueSave(get);
      }
    }
  },

  /** 씬 그룹을 **다른 탭 밑으로** (사용자 지시 2026-08-28). 서버가 그림·색인·썸네일을 그 탭의
   *  폴더로 옮긴다 — 배선과 안전장치는 `moveTabToWs` 와 같다 (놓는 즉시 화면에서 옮기고,
   *  답은 화면이 아직 이 워크스페이스일 때만 대입하며, 그동안 자동 저장을 멈춘다). */
  async moveGroupToTab(groupId, toTabId) {
    const cur = get().current;
    const spec = get().spec;
    if (!cur || !spec || moveBusy) return;
    const g = spec.sceneGroups.find((x) => x.id === groupId);
    if (!g || g.kind !== "sceneGroup" || g.tabId === toTabId) return;
    const toTab = (spec.tabs ?? []).find((c) => c.id === toTabId);
    if (!toTab) return;
    if (await generating(new Set([groupId]))) {
      toast(t("busy.generating"), "warn");
      return;
    }
    // ★그 탭의 마지막 세트면 빈 세트를 세운다 — 이름은 이 화면의 언어다
    const fill = { group: t("sceneGroup.newSet") };
    for (const fn of beforeWsSwitch) fn();
    await flushSave(get);
    if (get().current !== cur || !get().spec) return;
    const before = get().spec!;
    const moved = withGroupMoved(before, groupId, toTabId, fill.group);
    set({ spec: moved });
    clearUndo();   // ★그림의 경로가 바뀐다 — 옛 경로로 되살리면 엉뚱한 것을 부른다
    if (moved.activeSceneGroup !== before.activeSceneGroup)
      usePrompt.getState().load(promptOf(moved, activeGroupOf(moved)));
    moveBusy = cur;
    try {
      // ★끝날 때까지 **조작을 잠근다** (`store/busy` 의 ★★주)
      const r = await withBusy(t("busy.movingGroup", { name: g.name }), () =>
        api<{ spec: Spec; records: Rec[]; moved: number }>(
        `/api/workspaces/${encodeURIComponent(cur)}/scene-groups/${encodeURIComponent(groupId)}/move`,
        { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ to_tab: toTabId, fill }) },
      ));
      if (get().current === cur) {
        /* ★★**보고 있는 탭은 화면이 정본이다** (사용자 지적 2026-08-28: *"옮긴 탭으로 들어갔는데
             옮기는 게 완료된 후에 강제로 원래 있던 탭이 열림"*). 옮기는 동안에는 자동 저장을
             멈추므로 그 사이에 바꾼 탭이 파일에 없다 — 서버 것을 통째로 대입하면 뒤로 끌려간다. */
        const next = keepView(migrate(r.spec), get().spec);
        set({ spec: next, records: dedupeByFile(r.records ?? []) });
        usePrompt.getState().load(promptOf(next, activeGroupOf(next)));
      }
      toast(t("sceneGroup.movedTo", { name: g.name, tab: toTab.name, n: r.moved }));
    } catch (e) {
      if (get().current === cur) {
        set({ spec: before });
        usePrompt.getState().load(promptOf(before, activeGroupOf(before)));
      }
      toast(t("sceneGroup.moveFailed", { name: g.name, why: String(e) }), "warn");
    } finally {
      moveBusy = null;
      if (saveHeld) {
        saveHeld = false;
        queueSave(get);
      }
    }
  },

  moveSceneGroup(from, to) {
    const spec = get().spec;
    if (!spec) return;
    /* ★★**보이는 줄의 차례**를 바꾸는 것이지 `spec.sceneGroups` 전체를 뒤섞는 것이 아니다.
       그 탭의 세트가 놓인 **자리들**을 그대로 두고 내용만 새 차례로 채운다 —
       그래야 다른 탭의 세트가 이 조작에 밀리지 않는다. */
    const at: number[] = [];
    spec.sceneGroups.forEach((x, i) => {
      if (x.kind === "sceneGroup" && x.tabId === spec.activeTab) at.push(i);
    });
    const mine = at.map((i) => spec.sceneGroups[i]);
    const next = moveTo(mine, from, to);
    if (next === mine) return;
    const sceneGroups = spec.sceneGroups.slice();
    at.forEach((i, k) => (sceneGroups[i] = next[k]));
    set({ spec: { ...spec, sceneGroups } });
    queueSave(get);
  },

  removeTab(id) {
    const spec = get().spec;
    if (!spec) return;
    const left = (spec.tabs ?? []).filter((c) => c.id !== id);
    // ★마지막 탭은 지우지 않는다 — 세트가 설 자리가 없어진다
    if (!left.length) return;
    // 그 탭의 포즈세트도 함께 사라진다.
    // ★그림 파일은 **부르는 쪽**(`CanvasTabs` 의 탭 닫기)이 먼저 휴지통으로 보낸다 —
    //   여기서 보내면 어느 그림이 그 탭 것이었는지 묶어 줄 화면 정보가 이미 없다
    const sceneGroups = spec.sceneGroups.filter((x) => !(x.kind === "sceneGroup" && x.tabId === id));
    /* ★보던 탭을 지웠으면 **가장 가까운 탭**으로 (사용자 지시 2026-08-29: *"항상 첫 탭으로
       가던데"*) — 지운 자리의 오른쪽 탭, 끝이었으면 왼쪽. `left` 는 지운 것만 뺀 같은 차례라
       지운 인덱스 자리에 오른쪽 탭이 와 있다. */
    const at = (spec.tabs ?? []).findIndex((c) => c.id === id);
    const nextTab = spec.activeTab === id ? left[Math.min(at, left.length - 1)].id : spec.activeTab;
    const mine = sceneGroups.filter((x) => x.kind === "sceneGroup" && x.tabId === nextTab);
    const activeSceneGroup = sceneGroups.some((x) => x.id === spec.activeSceneGroup)
      ? spec.activeSceneGroup
      : (mine[0]?.id ?? sceneGroups[0].id);
    const next = { ...spec, tabs: left, sceneGroups, activeTab: nextTab, activeSceneGroup };
    set({ spec: next });
    usePrompt.getState().load(promptOf(next, sceneGroups.find((x) => x.id === activeSceneGroup)));
    queueSave(get);
  },

  closeSet(id) {
    const spec = get().spec;
    if (!spec) return;
    const target = spec.sceneGroups.find((x) => x.id === id);
    const ownerTab = target?.kind === "sceneGroup" ? target.tabId : undefined;
    // ★★**그 캐릭터의 마지막 탭은 닫지 않는다.** 옛 규칙(「싱글이 하나도 없는 워크스페이스를
    //   만들지 않는다」)이 싱글 폐기(2026-08-11)와 함께 이 자리로 왔다. 안 막으면 탭을 전부
    //   닫을 수 있고, 그러면 아래 `neighbour` 가 undefined 라 `neighbour.id` 에서 앱이 죽는다
    //   (새 워크스페이스는 탭이 하나라 ×를 한 번만 눌러도 그렇게 됐다).
    //   캐릭터 단위로 세는 이유: 탭이 없는 캐릭터가 활성이면 탭 줄이 비는데, 같은 캐릭터를
    //   다시 눌러도 `switchTab` 가 일찍 반환해 탭을 새로 만들어 주지 않는다.
    const mine = spec.sceneGroups.filter((x) => x.kind === "sceneGroup" && x.tabId === ownerTab);
    if (mine.length <= 1) return;
    /* ★★남는 것은 **세트 목록**이다. 개명 때 이름만 옛것으로 남아(`tabs`) 아래에서
       **탭 목록 자리에 세트를 써 넣고 있었다** — 세트는 지워지지도 않고 탭 줄이 통째로
       망가진다. 이름과 쓰는 자리를 함께 맞춘다. */
    const rest = spec.sceneGroups.filter((t) => t.id !== id);
    const wasActive = spec.activeSceneGroup === id;
    // ★닫으면 **같은 캐릭터에 머문다.** `tabs[0]` 로 가면 남의 캐릭터로 튕긴다
    //   (사용자 지적 2026-08-04, 그때는 싱글↔멀티였다). 같은 캐릭터의 탭 중 **가장 가까운 것**을 연다.
    const wasAt = spec.sceneGroups.findIndex((t) => t.id === id);
    /* ★★**후보에서 지우는 것을 뺀다** (사용자 지적 2026-08-27: *"새 씬 그룹을 만들고
         삭제하니 갑자기 씬이랑 생성된 이미지쪽 UI가 전부 사라짐"*).
       예전에는 `spec.sceneGroups` 에서 골라 **지우는 그것까지 후보**였다. 거리가 0 이라
       늘 자기가 뽑히고, 활성 그룹이 **방금 없앤 id** 를 가리켰다 — 남은 목록(`rest`)에
       없는 값이라 씬 줄도 결과도 그릴 것을 못 찾아 통째로 비었다.
       ★자리(`wasAt`)는 **옛 목록 기준**이 맞다 — 「가장 가까운 것」은 지우기 전의 차례로 잰다. */
    const siblings = rest.filter((t) => t.kind === "sceneGroup" && t.tabId === ownerTab);
    const neighbour =
      siblings.length === 0
        ? rest[0]
        : siblings.reduce((best, t) => {
            const at = spec.sceneGroups.findIndex((x) => x.id === t.id);
            const bestAt = spec.sceneGroups.findIndex((x) => x.id === best.id);
            return Math.abs(at - wasAt) < Math.abs(bestAt - wasAt) ? t : best;
          });
    const nextActive = wasActive ? neighbour.id : spec.activeSceneGroup;
    set({ spec: { ...spec, sceneGroups: rest, activeSceneGroup: nextActive } });
    // ★활성 탭을 닫았으면 **새 탭의 프롬프트를 편집기로 꺼낸다.**
    //   안 하면 편집기 안은 닫힌 탭의 내용 그대로인데 activeSceneGroup 만 바뀌어,
    //   0.4초 뒤 도는 자동 저장이 `stash(spec, activeSceneGroup)` 로 그것을 **옆 탭에 써 넣는다.**
    //   화면상으론 탭 하나를 닫은 것으로만 보여서, 옆 탭을 열기 전엔 유실을 알 수 없다.
    if (wasActive) {
      const next = rest.find((t) => t.id === nextActive);
      usePrompt.getState().load(promptOf(spec, next));
    }
    queueSave(get);
  },

  patchSceneGroup(id, patch) {
    const spec = get().spec;
    if (!spec) return;
    /* ★★**허용 목록 밖은 버린다** (선결 조건 3-3, 2026-08-24). 예전에는 넘어온 것을 그대로
       펼쳐 담아서, `id`·`kind` 를 덮으면 **그 세트의 그림이 통째로 안 보이고**(결과를 `scene_group_id`
       로 묶는다), `cellSeq` 를 낮추면 **옛 그림이 새 씬에 달라붙었다**(발급기는 줄지 않아야
       한다는 규칙이 `SceneGroup.cellSeq` 주석에 있다).
       ★사람의 화면은 정해진 칸만 건드리니 드러나지 않았지만, 조수에게 `apply` 를 여는 순간
         아무 값이나 들어온다. 문지기를 **값이 담기는 자리 하나**에 둔다. */
    const drop = Object.keys(patch).filter((k) => !SET_PATCHABLE.has(k));
    if (drop.length) {
      // ★조용히 버리지 않는다 — 어느 이름이 막혔는지 남겨야 조수가 고칠 수 있다 (계기판)
      console.warn(`[patchSceneGroup] 허용되지 않은 필드를 버립니다: ${drop.join(", ")}`);
    }
    const safe = Object.fromEntries(Object.entries(patch).filter(([k]) => SET_PATCHABLE.has(k)));
    if (!Object.keys(safe).length) return;
    set({
      spec: {
        ...spec,
        sceneGroups: spec.sceneGroups.map((x) => (x.id === id && x.kind === "sceneGroup" ? { ...x, ...safe } : x)),
      },
    });
    queueSave(get);
  },

  addSlot(groupId, opts = {}) {
    const spec = get().spec;
    const tab = spec?.sceneGroups.find((x) => x.id === groupId);
    if (!spec || tab?.kind !== "sceneGroup" || !tab.cards.length) return;
    const card = tab.cards.find((k) => k.id === opts.cardId) ?? tab.cards[0];
    // ★발급기가 없는 옛 탭은 지금 있는 최대 번호 + 1 부터 이어 받는다.
    //   ★탭 전체에서 센다 — 카드마다 세면 두 카드가 같은 번호를 갖는다
    const seq = tab.cellSeq ?? maxCellNum(allCells(tab)) + 1;
    const cell: Slot = opts.from
      ? { ...opts.from, id: `c${seq}`, name: opts.name ?? opts.from.name }
      : {
          id: `c${seq}`,
          /* ★★이름 규칙은 **모든 층이 같다** (사용자 지시 2026-08-27) — 「새 씬」이고,
             겹치면 뒤에 번호가 붙는다 (`lib/uniqueName`). 예전에는 여기만 `씬 {n}` 이라
             첫 번째부터 번호가 붙어 탭·그룹과 모양이 달랐다.
             ★겹침은 **그 그룹 전체**에서 본다 — 씬 이름이 파일 이름에 들어가고
               (`backend/workspace.py` 의 `file_lead`), 한 그룹의 그림이 한 폴더에 모인다.
               카드 안에서만 보면 다른 카드의 씬과 이름이 겹쳐 파일에서 구별이 안 된다. */
          name: opts.name ?? uniqueName(t("slots.newName"), allCells(tab).map((c) => c.name)),
          blocks: [],
        };
    const at = opts.after === undefined ? card.cells.length : opts.after + 1;
    const cells = [...card.cells.slice(0, at), cell, ...card.cells.slice(at)];
    get().patchSceneGroup(groupId, {
      cards: tab.cards.map((k) => (k.id === card.id ? { ...k, cells } : k)),
      cellSeq: seq + 1,
    });
  },

  addCard(groupId, card = {}) {
    const spec = get().spec;
    const tab = spec?.sceneGroups.find((x) => x.id === groupId);
    if (!spec || tab?.kind !== "sceneGroup") return;
    const cseq = (tab.cardSeq ?? tab.cards.length) + 1;
    const seq = tab.cellSeq ?? maxCellNum(allCells(tab)) + 1;
    const cells = card.cells?.length
      ? // 덱에서 떨군 카드 — ★씬 번호는 **이 탭이 새로 발급한다.** 카드에 실려 온 id 를
        //   그대로 쓰면 이미 있는 씬과 겹쳐 결과가 섞인다
        card.cells.map((c, i) => ({ ...c, id: `c${seq + i}` }))
      : [{ id: `c${seq}`, name: uniqueName(t("slots.newName"), allCells(tab).map((c) => c.name)), blocks: [] }];
    get().patchSceneGroup(groupId, {
      cards: [
        ...tab.cards,
        {
          id: `k${cseq}`,
          /* ★★**씬 카드에는 씬 카드의 이름**을 준다 (사용자 지적 2026-08-27) — 여기서
             그룹의 이름말을 빌려 쓰고 있어, 새 카드가 「새 씬 그룹」으로 생겼다.
             ★번호 규칙은 다른 층과 같다 (`lib/uniqueName`): 처음은 맨이름, 겹치면 2, 3… */
          name: card.name ?? uniqueName(t("sceneGroup.newCard"), tab.cards.map((k) => k.name)),
          srcId: card.srcId,
          color: card.color,
          cells,
        },
      ],
      cardSeq: cseq,
      cellSeq: seq + cells.length,
    });
  },

  removeCard(groupId, cardId) {
    const spec = get().spec;
    const tab = spec?.sceneGroups.find((x) => x.id === groupId);
    if (!spec || tab?.kind !== "sceneGroup") return;
    get().patchSceneGroup(groupId, { cards: tab.cards.filter((k) => k.id !== cardId) });
  },

  planRemove(target) {
    const spec = get().spec;
    if (!spec)
      return { kind: target.kind, name: "", files: [], inner: 0, hard: true, zones: [], blocked: "not_found" };
    // ★목록에는 살아 있는 줄만 든다 (`live_records`) — 따로 거를 것이 없다
    return planDelete(spec, get().records, () => false, target);
  },

  async removeAt(target) {
    const plan = get().planRemove(target);
    if (plan.blocked) return { ok: false, blocked: plan.blocked };

    /* ★★**그림을 먼저 보낸다.** 대상이 사라진 뒤에는 어느 그림이 그것이었는지 화면이
       더는 묶어 주지 못한다 (`delPlan.ts` 머리 주석의 ③). 순서가 곧 안전장치다.
       ★★`undo: false` — 이 그림들은 **되돌릴 수 없는 삭제의 일부**다. 되돌리기 항목을
         남기면 `Ctrl+Z` 가 그림만 되살리는데, 그때는 담길 씬이 이미 없어 **갈 자리 없는
         그림**이 된다 (2026-08-22 사용자 지적의 정체가 이것이다).
         ★대신 그림 자체는 휴지통에서 24시간 안에 꺼낸다 (`list_trash`·`restore_files`). */
    if (plan.files.length) await get().deleteFiles(plan.files, { undo: false });

    if (target.kind === "tab") get().removeTab(target.id);
    else if (target.kind === "sceneGroup") get().closeSet(target.id);
    else if (target.kind === "sceneCard") get().removeCard(target.groupId, target.cardId);
    else {
      const spec = get().spec;
      const set = spec?.sceneGroups.find((x) => x.id === target.groupId);
      if (set?.kind !== "sceneGroup") return { ok: false, blocked: "not_found" };
      get().patchSceneGroup(target.groupId, {
        cards: set.cards.map((k) => ({ ...k, cells: k.cells.filter((c) => c.id !== target.cellId) })),
      });
    }

    /* ★★**지운 자리의 되돌리기만 뺀다** (사용자 정정 2026-08-25).
       예전에는 여기서 `clearUndo()` 로 **로그를 통째로 비웠다**(2026-08-22). 그러면 지운
       것과 **상관없는 사용자 편집까지** 함께 날아간다 — 특히 조수가 지웠을 때 사용자는
       자기 되돌리기를 예고 없이 잃는다. 2026-08-22 지적의 요지도 *"다른 슬롯에서 지운
       이미지가 복구됨"* 이라 **범위가 틀린 것**이었지, 「전부 비워라」가 아니었다.
       ★자리 목록은 `planRemove` 가 준다 (`lib/delPlan` 의 `zones`).
       ★조수가 고친 자리를 사람의 Ctrl+Z 에서 빼는 것(`dropUndoZone`)과 **같은 장치**다. */
    for (const z of plan.zones) dropUndoZone(z);
    return { ok: true, plan };
  },

  setCard(groupId, cardId, patch) {
    const spec = get().spec;
    const tab = spec?.sceneGroups.find((x) => x.id === groupId);
    if (!spec || tab?.kind !== "sceneGroup") return;
    get().patchSceneGroup(groupId, {
      cards: tab.cards.map((k) => (k.id === cardId ? { ...k, ...patch } : k)),
    });
  },

  /** 씬을 옮긴다 — 카드 안에서도, **카드를 넘어서도** (v2 `index.html:11860-12002`).
   *
   *  ★★**씬 번호(`cell_no`)는 탭 안에서 통째로 센다** (`allCells` — 카드 순서대로 편 자리이고,
   *    `gen.ts generateAll` 이 `order.findIndex(...) + 1` 로 뽑는다). 그래서 옮기면:
   *     - 그 씬의 번호는 **새 자리의 번호**가 되고, 사이에 낀 씬들의 번호도 함께 밀린다
   *     - 카드를 통째로 옮기면 그 카드의 씬 **전부**가 밀린다
   *     - 번호는 **파일 이름 앞**에 붙는 값이라, 이미 만든 그림의 이름은 그대로고
   *       **다음에 만드는 것부터** 새 번호로 저장된다 (이름을 소급해 고치지 않는다)
   *  ★**결과는 안 따라 흔들린다** — 화면이 결과를 묶는 키는 `cell_id` 뿐이고(`takesOf`),
   *    옮겨도 그 값은 안 바뀐다. 그림은 그 씬을 그대로 따라간다.
   *  ★옮긴 씬에는 **받는 카드의 공통 접두**가 걸린다 (접두는 카드의 것이다).
   *  ★마지막 씬을 빼내면 그 카드는 **빈 카드**로 남는다. 지우지 않는다 — 이름·접두가 든
   *    사용자 데이터라, 옮기는 조작이 카드를 말없이 없애면 안 된다. */
  moveScene(groupId, cellId, toCardId, toIndex) {
    const spec = get().spec;
    const tab = spec?.sceneGroups.find((x) => x.id === groupId);
    if (!spec || tab?.kind !== "sceneGroup") return;
    const from = tab.cards.find((k) => k.cells.some((c) => c.id === cellId));
    const to = tab.cards.find((k) => k.id === toCardId);
    if (!from || !to) return;
    const at = from.cells.findIndex((c) => c.id === cellId);
    const cell = from.cells[at];

    if (from.id === to.id) {
      const rest = from.cells.filter((_, i) => i !== at);
      // 틈 번호는 **빼기 전** 목록 기준이라, 뒤쪽으로 옮길 때 한 칸 당긴다 (`useReorder` 와 같다)
      const put = toIndex < 0 ? rest.length : Math.min(rest.length, toIndex > at ? toIndex - 1 : toIndex);
      if (put === at) return; // 제자리
      get().patchSceneGroup(groupId, {
        cards: tab.cards.map((k) =>
          k.id === from.id
            ? { ...k, cells: [...rest.slice(0, put), cell, ...rest.slice(put)] }
            : k,
        ),
      });
      void get().renumberSet(groupId);
      return;
    }

    const put = toIndex < 0 ? to.cells.length : Math.max(0, Math.min(to.cells.length, toIndex));
    get().patchSceneGroup(groupId, {
      cards: tab.cards.map((k) => {
        if (k.id === from.id) return { ...k, cells: k.cells.filter((c) => c.id !== cellId) };
        if (k.id === to.id)
          return { ...k, cells: [...k.cells.slice(0, put), cell, ...k.cells.slice(put)] };
        return k;
      }),
    });
    void get().renumberSet(groupId);
  },

  /** 카드 순서 — 그 카드의 씬 전부가 함께 움직인다 (번호는 위 `moveScene` 주석과 같다) */
  moveCard(groupId, cardId, toIndex) {
    const spec = get().spec;
    const tab = spec?.sceneGroups.find((x) => x.id === groupId);
    if (!spec || tab?.kind !== "sceneGroup") return;
    const at = tab.cards.findIndex((k) => k.id === cardId);
    if (at < 0) return;
    const rest = tab.cards.filter((_, i) => i !== at);
    const put = toIndex < 0 ? rest.length : Math.min(rest.length, toIndex > at ? toIndex - 1 : toIndex);
    if (put === at) return;
    get().patchSceneGroup(groupId, { cards: [...rest.slice(0, put), tab.cards[at], ...rest.slice(put)] });
    // ★카드가 움직이면 그 안의 씬 번호가 통째로 밀린다 (번호는 **탭 안에서 통째로** 센다)
    void get().renumberSet(groupId);
  },

  /** 씬 자리가 바뀌면 **파일 이름의 씬 번호도 따라간다** (사용자 지시 2026-08-24).
   *
   *  ★★**한 번에 하나만 보낸다** (2026-08-27). 예전에는 기다리지 않고 보내서, 빠르게 두 번
   *    끌면 **옛 경로로 만든 계획**이 뒤늦게 적용됐다 — 기록이 없는 파일을 가리켜 그림이
   *    통째로 안 떴다. 도는 중에 또 요청이 오면 **끝난 뒤 한 번만** 다시 돈다.
   *  ★★**별표도 새 경로를 따라간다.** 별표는 파일 경로로 적히는데(`selection.starred`)
   *    예전에는 「지운 것」만 옮겨서, 개명하면 별이 조용히 풀렸다 —
   *    「별표만 보기」에서는 그림이 **사라져 보였다** (사용자 지적 2026-08-27).
   *  ★썸네일 캐시는 **서버가 함께 옮긴다** (`workspace.py` 의 `_move_thumbs`). 안 옮기면
   *    개명한 그림이 전부 다시 구워져 수십 초가 든다 — 그것이 「무겁다」의 정체였다.
   */
  async renumberSet(groupId) {
    if (renumBusy) {
      renumAgain.add(groupId);
      return;
    }
    renumBusy = true;
    try {
      await runRenumber(get, set, groupId);
    } finally {
      renumBusy = false;
      const next = [...renumAgain];
      renumAgain.clear();
      for (const g of next) void get().renumberSet(g);
    }
  },

  renameSceneGroup(id, name) {
    const spec = get().spec;
    if (!spec || !name.trim()) return;
    set({
      spec: { ...spec, sceneGroups: spec.sceneGroups.map((t) => (t.id === id ? { ...t, name } : t)) },
    });
    queueSave(get);
  },
}));

/** 편집이 잦으므로 디바운스 저장 — 매 키 입력마다 파일을 쓰지 않는다. */
function queueSave(get: () => S) {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => get().save(), 400);
}

export const scheduleSave = () => queueSave(useWs.getState as () => S);
