import { create } from "zustand";
import { t } from "../i18n";
import { api, backendUrl } from "../lib/backend";
import { CensorRenderer, type CoverSettings, type Scene } from "../lib/censorRender.ts";
import {
  burnBoxes, clearMask, emptyRect, floodErase, isEmpty, makeMask, methodIndex, remap, restore, snapshot, stamp, stroke,
  toRenderBoxes, type Mask, type Patch, type Rect, type Shape,
} from "../lib/censorMask.ts";
import { fileMgrImg } from "../lib/imgUrl";
import type { Dropped } from "../lib/dropImages";

/** 검열. **여러 장을 한 번에** 찾고, 고치고, 가린다 (v2 자동검열 이식).
 *
 *  v2 의 구조를 그대로 옮겼다. 세 탭이 곧 작업 순서다:
 *
 *      검열 전   담고 · 찾는다        모델·대상·문턱을 만지며 미리 본다
 *      검열 중   고친다               찾은 박스를 옮기고 늘리고 돌리고 지우고 더 그린다
 *      검열 후   다시 고친다          저장된 결과에 박스를 더해 다시 저장한다
 *
 *  ★찾기와 가리기는 **따로**다. 자동으로 바로 가려 버리면 잘못 찾은 것을 되돌릴 수 없다.
 *  ★★가리는 일은 **화면이** 한다 (`lib/censorRender.ts`). 렌더러는 한 벌뿐이고,
 *    저장도 그 렌더러가 원본 크기로 구운 것을 올린다 (`/api/censor/apply`).
 *    서버가 그리던 때에는 박스를 1px 옮길 때마다 왕복이 걸려 초당 3~4장이 천장이었다.
 *  ★모델은 **앱에 들어 있다**. 받아 오는 절차가 없다 (backend/censor.py 머리 주석).
 */
export type Box = {
  label: string;
  confidence: number;
  box: [number, number, number, number];
  /** 라디안. 코드가 아니라 사람이 손잡이로 돌린다 */
  rotation?: number;
  /** ★박스마다 다른 방식 (백엔드 `apply_boxes` 가 박스별 `method` 를 읽는다) */
  method?: string;
  passes_threshold?: boolean;
  /** 사람이 끈 것. 목록에는 두고 적용에서만 뺀다 */
  off?: boolean;
  /** 사람이 그린 것 (옛 세션에서 온 값 — 지금은 사람이 박스를 그리지 않는다) */
  manual?: boolean;
};

export type CensorModel = { id: string; file: string; classes: string[]; bytes: number; imgsz: number };

/** 검열할 그림 한 장. 세 갈래로 온다 (백엔드 `CensorSource` 와 같은 계약) */
export type CensorImage = {
  id: string;
  name: string;
  /** 아웃풋 루트 기준 (파일 관리에서 고른 것) */
  rel?: string;
  /** 절대 경로 (Tauri 창에 떨군 것) */
  path?: string;
  /** base64 (브라우저에서 고른 것) */
  data?: string;
  w?: number;
  h?: number;
  /** 목록에 그릴 작은 그림 */
  thumb?: string;
};

export type Tab = "before" | "processing" | "after";
/** ★★검열 중·후의 그리는 도구는 **붓과 지우개** 둘이다 (사용자 지시 2026-09-05: *"인페인트 브러시처럼
 *  사각형 브러시로 칠하고 지우는 형태로"*). 박스를 고르고·옮기고·돌리던 도구는 걷었다 —
 *  편집 대상이 박스 목록이 아니라 **칠한 칸의 격자**(`lib/censorMask`)가 되었기 때문이다.
 *  ★`pan` 은 그리지 않는다 — **확대한 그림을 끌어 옮기는** 도구다 (사용자 결정 2026-09-20).
 *    생성 쪽은 그냥 끌기로 옮기지만 여기서는 끌기가 이미 붓질이라, 도구를 골라서 가른다. */
export type Tool = "brush" | "erase" | "pan";
/** 붓 지름의 천장 (px). 슬라이더와 Alt+휠이 같은 값을 본다 */
export const BRUSH_MAX = 300;

/** 붓을 되돌릴 걸음 수 (인페인트 마스크와 같다) */
const UNDO_MAX = 40;

const KEY = "peropix.censor";

/** 저장하는 것. ★필드를 늘리면 **여기에도 더할 것** (ui.ts `commitLayout` 과 같은 함정) */
type Saved = {
  model: string | null;
  targets: string[];
  labelConf: Record<string, number>;
  conf: number;
  floor: number;
  method: string;
  color: string;
  expand: number;
  feather: number;
  mosaic: number;
  mosaicOpacity: number;
  blur: number;
  steamBright: number;
  steamAlpha: number;
  /** 스팀 「경사」 0~100 — 알파 경사의 시작점을 안쪽으로 당겨 완만하게. 칠한 넓이는 그대로 (사용자 결정 2026-09-06) */
  steamFade: number;
  /** 붓을 끄는 동안 덮개가 옅어지는 정도 — ★모든 방식에 있다 (CensorSide 의 ★★주). 값은 방식마다 따로다 (아래 `methodOpts`) */
  peek: number;
  /** ★★방식마다 따로 두는 값의 보관함 — 넓히기·부드럽게·들춰보기 (사용자 지적 2026-09-06: *"모든 검열방식의
   *  옵션이 전부 각 검열별로 저장되어야함. 지금 일부 수치가 서로 공유함"*). 나머지 옵션은 이름부터 방식 전용이라
   *  (`mosaic*`·`blur`·`color`·`steam*`) 원래 섞이지 않았고, 이 셋만 하나의 값을 모든 방식이 같이 썼다.
   *  ★**지금 방식의 값은 `expand`·`feather`·`peek` 이 정본**이고, 여기에는 다른 방식의 값만 잠들어 있다 —
   *    방식을 바꿀 때 지금 값을 넣고 새 방식의 값을 꺼낸다 (`setMethod`). 저장할 때도 지금 값을 함께 넣는다.
   *  ★처음 가 보는 방식은 지금 값을 그대로 물려받는다 — 옛 저장본(하나의 값)과 이어지고, 그때부터 갈린다. */
  methodOpts: Record<string, { expand: number; feather: number; peek: number }>;
  /** 붓 지름 (px). ★1px 단위 (사용자 지시 2026-09-05: *"8단위로만 되어서 불편. 1단위로"*) */
  brushPx: number;
  /** 붓 모양 — 사각·원 (사용자 지시 2026-09-05: *"원형·사각 다 있는 게 좋을 듯. 네모가 기본"*) */
  brushShape: Shape;
  dest: string;
  /** 저장 자리 — **일괄변환과 같은 세 갈래** (사용자 지시 2026-09-04).
   *  `overwrite` 원본 자리에 · `sub` 첫 그림 아래 `output/` · `folder` 고른 폴더. */
  destMode: "overwrite" | "sub" | "folder";
  /** 얼마로 볼까 — 생성 쪽 `spec.preview` 와 **같은 모양**이고 계산도 같은 `lib/zoomView` 다.
   *  ★**검열은 따로 기억한다** (사용자 결정 2026-09-20). 칠하는 화면이라 크게 보는 배율이
   *    따로 필요하고, 검열은 워크스페이스와 무관한 도구라 그쪽 설정에 얹을 자리가 없다.
   *  ★보고 있던 **자리**(pan)는 안 남긴다 — 생성 쪽과 같은 이유로, 그림마다 다르고 다음에
   *    열었을 때 엉뚱한 구석을 보고 있으면 「왜 이러지」가 된다. */
  view: { fit: boolean; zoom: number };
};

const DEFAULTS: Saved = {
  model: null,
  targets: [],
  labelConf: {},
  conf: 0.3,
  floor: 0.1,
  // ★기본은 **스팀**이다 (v2 의 기본값). 폐기 결정이 없어 그대로 옮겼다
  method: "steam",
  color: "#000000",
  expand: 0,
  feather: 0,
  mosaic: 12,
  mosaicOpacity: 100,
  blur: 20,
  steamBright: 100,
  steamAlpha: 100,
  // ★0 = v2 원문 (100% 가 0.6 까지). 올릴수록 속이 좁아지고 자락이 길어진다
  steamFade: 0,
  peek: 30,
  methodOpts: {},
  // 40px. 젖꼭지 하나를 한두 번에 덮는 크기
  brushPx: 40,
  brushShape: "square",
  dest: "",
  // ★기본은 일괄변환과 같은 `sub` — 원본을 건드리지 않는 쪽이 기본이어야 한다
  destMode: "sub",
  // ★기본은 꽉차게 — 판 안에 다 보이는 것이 검열을 시작하는 자리다
  view: { fit: true, zoom: 1 },
};

function load(): Saved {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const got = JSON.parse(raw);
      // ★옛 이름에서 옮겨 온다 — 스팀 전용이던 「들춰보기」가 공통이 되면서 이름이 바뀌었다
      if (got.peek === undefined && typeof got.steamOpacity === "number") got.peek = got.steamOpacity;
      delete got.steamOpacity;
      // ★옛 붓 반지름(칸, `brush`)은 버린다 — 지름 px(`brushPx`)와 뜻이 달라 옮길 수 없다
      delete got.brush;
      // ★방식별 보관함에 지금 방식의 값이 있으면 그것이 정본이다 (`methodOpts` 의 ★★주)
      const mine = got.methodOpts?.[got.method];
      return { ...DEFAULTS, ...got, ...(mine ?? {}) };
    }
  } catch {}
  return DEFAULTS;
}

/** ★그림 캐시는 **30장까지** (v2 `imgCacheMaxSize`). 떨군 그림은 주소가 없어 서버에서
 *  한 번 받아 와야 하는데, 좌우로 훑을 때마다 다시 받으면 넘기는 리듬이 끊긴다. */
const LRU_MAX = 30;
const srcCache = new Map<string, string>();

function cacheGet(k: string) {
  const v = srcCache.get(k);
  if (v !== undefined) {
    srcCache.delete(k);
    srcCache.set(k, v);
  }
  return v;
}

function cacheSet(k: string, v: string) {
  srcCache.delete(k);
  srcCache.set(k, v);
  while (srcCache.size > LRU_MAX) {
    const oldest = srcCache.keys().next().value!;
    const url = srcCache.get(oldest);
    srcCache.delete(oldest);
    // ★blob 주소는 놓아 주지 않으면 메모리에 계속 남는다
    if (url?.startsWith("blob:")) URL.revokeObjectURL(url);
  }
}

const post = <T,>(path: string, body: unknown) =>
  api<T>(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

/** 그림 하나를 가리키는 세 갈래를 요청 몸통으로 (`CensorSource`) */
const sourceOf = (im: CensorImage) =>
  im.rel ? { rel: im.rel } : im.path ? { path: im.path } : { data: im.data };

/** 절대 경로인가 (드라이브 글자 또는 슬래시로 시작) */
export const isAbsPath = (p: string) => /^(?:[A-Za-z]:[\\/]|[\\/])/.test(p);

/** 그림이 든 폴더 (아웃풋 루트 기준 상대 경로거나 절대 경로). 자리를 모르면 빈 문자열 */
export const dirOf = (im: CensorImage) => {
  const p = im.rel ?? im.path ?? "";
  const cut = p.replace(/[\\/][^\\/]*$/, "");
  return cut === p ? "" : cut;
};

/** 저장 창구에 실어 보낼 자리. ★**첫 그림 아래 `output/`** 은 여기서 정한다 —
 *  한 장씩 오는 서버 창구는 어느 것이 첫 장인지 모른다 (일괄변환은 목록을 통째로 받는다). */
function destOf(s: { destMode: string; dest: string }, list: CensorImage[]) {
  if (s.destMode === "overwrite") return { mode: "overwrite" };
  if (s.destMode === "folder") return { dest: s.dest || undefined };
  const home = list.map(dirOf).find((d) => d !== "");
  return { dest: home === undefined ? undefined : `${home}/output`.replace(/^\//, "") };
}

/** 지금 설정으로 저장되는 **폴더** — 상단 표시용. 덮어쓰기면 null (원본 자리), 아직 갈 곳이 없으면 빈 문자열 */
export function savePathOf(s: { destMode: string; dest: string }, list: CensorImage[]): string | null {
  const d = destOf(s, list);
  return "mode" in d ? null : d.dest ?? "";
}

/** 서버가 돌려준 저장 파일을 목록 항목으로 — 루트 밖(절대 경로)이면 `path`, 안이면 `rel` */
const savedItem = (r: { file: string; name: string }): CensorImage =>
  isAbsPath(r.file) ? { id: `a${seq++}`, name: r.name, path: r.file } : { id: `a${seq++}`, name: r.name, rel: r.file };

/** 루트 밖에 저장된 장은 파일 관리 썸네일이 없다 — 탐색으로 한 번 받아 둔다 */
async function thumbsFor(items: CensorImage[]) {
  const need = items.filter((im) => !im.rel && im.path);
  if (!need.length) return;
  try {
    const r = await post<{ items: { thumb?: string; width?: number; height?: number }[] }>(
      "/api/tools/probe", { items: need.map((im) => ({ name: im.name, path: im.path })) });
    need.forEach((im, i) => { im.thumb = r.items[i]?.thumb || undefined; im.w = r.items[i]?.width; im.h = r.items[i]?.height; });
  } catch {}
}

let seq = 1;

type S = Saved & {
  models: CensorModel[];
  /** 모델 목록을 아직 받는 중 — 화면은 뜨고 「검열 시작」만 잠근다 (사용자 지시 2026-09-06: *"모델 로드중에도
   *  UI를 띄우고 검열 버튼만 못누르게 하든가. 로드중 띄우고"*) */
  modelsLoading: boolean;
  tab: Tab;
  /** 검열 전·중 탭이 다루는 목록 */
  images: CensorImage[];
  /** 검열 후 탭이 다루는 목록 (이번에 저장한 것) */
  after: CensorImage[];
  idx: number;
  afterIdx: number;
  /** 그림별 박스 — **검열 전 탭의 탐지 결과**다. 검열 중으로 넘어가면 `paint` 에 굽는다 */
  boxes: Record<string, Box[]>;
  /** ★★그림별 **칠한 칸의 격자** — 검열 중·후 탭의 편집 대상이자 렌더러에 나가는 것.
   *  칸은 제자리에서 바뀐다 (붓을 끄는 동안 프레임마다 새 배열을 만들지 않는다) */
  paint: Record<string, Mask>;
  /** 지금 그림의 되돌리기 더미 — 한 걸음이 한 획이다. ★획이 손댄 사각형만 떠 둔다 (`Patch`). 그림을 넘기면 비운다 */
  undos: Patch[];
  /** 긋는 동안만 — 획 시작 전의 픽셀 전부. 무대가 이번 획의 델타를 뽑는 근거이고, 손을 떼면 손댄
   *  사각형(`strokeDirty`)만 잘라 되돌리기 더미에 넣는다 */
  strokeBase: { cells: Uint8Array; alpha: Uint8Array } | null;
  /** 긋는 동안 붓이 손댄 사각형 (제자리에서 자란다) */
  strokeDirty: Rect | null;
  sizes: Record<string, { w: number; h: number }>;
  /** 지금 무대에 그릴 원본 주소 (떨군 그림은 서버에서 받아 온 data URL) */
  src: string | null;
  /** 지금 그림의 렌더러. ★무대가 이것으로 **직접 그린다** — 서버를 안 부른다 */
  renderer: CensorRenderer | null;
  /** 그릴 것이 바뀌었다는 표시. 무대가 이 숫자를 보고 다시 그린다 */
  rev: number;
  tool: Tool;
  /** 붓을 끄는 동안. 가린 모습을 옅게 해 아래를 보여 준다 */
  editing: boolean;
  scanning: boolean;
  busy: boolean;
  /** 여러 장을 도는 동안의 진행 (전체 검열 · 일괄 저장) */
  progress: { done: number; total: number; what: "scan" | "save" } | null;
  /** ★「전체 검열」을 한 번 돌렸나. 안 돌린 채로 검열 중 탭에 들어가면 문턱 미달·꺼 둔 박스가
   *  그대로 편집 대상이 되어 무엇을 가리는지 알 수 없다 (v2 도 그때까지 탭을 숨겼다) */
  staged: boolean;
  error: string | null;

  loadModels: () => Promise<void>;
  setModel: (file: string) => void;
  setTab: (t: Tab) => void;
  set: (patch: Partial<S>) => void;
  /** 설정 하나를 바꾼다. 저장하고, 필요하면 다시 찾거나 다시 그린다 */
  tune: (patch: Partial<Saved>, redo?: "scan" | "draw") => void;
  toggleTarget: (label: string) => void;
  setLabelConf: (label: string, v: number) => void;

  addImages: (items: Dropped[]) => Promise<void>;
  toggleRel: (rel: string, name: string) => void;
  removeImage: (i: number) => void;
  clearImages: () => void;
  clearAfter: () => void;
  select: (i: number) => void;
  step: (d: number) => void;

  scan: () => Promise<void>;
  scanAll: () => Promise<void>;
  saveAll: () => Promise<void>;
  saveOne: () => Promise<void>;
  cancelProcessing: () => void;

  cur: () => CensorImage | undefined;
  curBoxes: () => Box[];
  putBoxes: (b: Box[]) => void;
  toggleBox: (i: number) => void;
  /** 지금 그림의 비트맵. 없으면 만든다 (크기를 아직 모르면 null) */
  curMask: () => Mask | null;
  /** 한 획의 시작 — 획 전 픽셀을 얼려 두고 「들춰보기」를 켠다. 비트맵이 없으면 거짓 */
  strokeBegin: () => boolean;
  /** 붓이 지나는 자리. `last` 가 있으면 거기서 이어 긋는다. ★다시 그리지 않는다 — 무대가 그 자리에서 그린다 */
  strokeAt: (at: { x: number; y: number }, last: { x: number; y: number } | null, erase: boolean) => void;
  /** 한 획의 끝 — 손댄 사각형을 되돌리기 더미에 넣고 제 해상도로 다시 그리게 한다 */
  strokeEnd: () => void;
  /** 그 자리와 이어진 덩어리를 통째로 지운다 (우클릭). 한 걸음으로 되돌린다 */
  eraseBlob: (at: { x: number; y: number }) => void;
  undoPaint: () => void;
  clearPaint: () => void;
  /** 검열 방식을 바꾼다 — ★**검열 중·후에는 칠한 칸 전부**에 건다 */
  setMethod: (m: string) => void;
  /** 다시 그리라고 알린다. `heavy` 면 재료 캐시까지 버린다 (설정이 바뀌었을 때) */
  bump: (heavy?: "layers" | "all") => void;
};

let scanTimer: ReturnType<typeof setTimeout> | null = null;
let scanSeq = 0;

export const useCensor = create<S>((set, get) => ({
  ...load(),
  models: [],
  modelsLoading: false,
  tab: "before",
  images: [],
  after: [],
  idx: -1,
  afterIdx: -1,
  boxes: {},
  paint: {},
  undos: [],
  strokeBase: null,
  strokeDirty: null,
  sizes: {},
  src: null,
  renderer: null,
  rev: 0,
  tool: "brush",
  editing: false,
  scanning: false,
  busy: false,
  progress: null,
  staged: false,
  error: null,

  set: (patch) => set(patch as S),

  cur() {
    const s = get();
    return s.tab === "after" ? s.after[s.afterIdx] : s.images[s.idx];
  },

  curBoxes() {
    const im = get().cur();
    return im ? (get().boxes[im.id] ?? []) : [];
  },

  putBoxes(b) {
    const im = get().cur();
    if (!im) return;
    set({ boxes: { ...get().boxes, [im.id]: b } });
    get().bump();
  },

  async loadModels() {
    set({ modelsLoading: true });
    let r: { models: CensorModel[] };
    try {
      r = await api<{ models: CensorModel[] }>("/api/censor/models");
    } catch (e) {
      set({ modelsLoading: false, error: String(e) });
      return;
    }
    const first = r.models[0];
    const keep = r.models.some((m) => m.file === get().model);
    const model = keep ? get().model : (first?.file ?? null);
    const classes = r.models.find((m) => m.file === model)?.classes ?? [];
    const targets = get().targets.filter((t) => classes.includes(t));
    set({
      models: r.models,
      modelsLoading: false,
      model,
      // ★처음엔 **전부** 대상이다. 켜는 것을 잊어 아무것도 안 찾는 일이 없게
      targets: targets.length ? targets : classes,
      labelConf: fillConf(get().labelConf, classes, get().conf),
    });
  },

  setModel(file) {
    // ★모델마다 **클래스 이름이 다르다** (기본 nipples… / XL nipple·female face…).
    //   바꾸면 대상 목록도 그 모델 것으로 갈아 끼워야 한다. 안 그러면 아무것도 안 찾는다
    const classes = get().models.find((m) => m.file === file)?.classes ?? [];
    set({ model: file, targets: classes, labelConf: fillConf(get().labelConf, classes, get().conf), error: null });
    save(get());
    void get().scan();
  },

  setTab(t) {
    if (t === get().tab) return;
    set({ tab: t, undos: [], renderer: null, src: null, error: null });
    const s = get();
    if (t === "after") s.select(s.afterIdx >= 0 ? s.afterIdx : 0);
    else s.select(s.idx >= 0 ? s.idx : 0);
  },

  tune(patch, redo) {
    set(patch as S);
    save(get());
    if (redo === "scan" && get().tab === "before") void get().scan();
    if (redo === "draw") {
      /* ★버릴 캐시를 **바뀐 값에 맞춰** 고른다. 「부드럽게」만 구름 무늬까지 다시 만들고,
         나머지는 재료만 다시 만든다. 이 구분이 슬라이더를 끄는 손맛을 정한다. */
      const keys = Object.keys(patch);
      const heavy = keys.includes("feather") ? "all" : "layers";
      get().bump(heavy);
    }
  },

  toggleTarget(label) {
    const t = get().targets;
    get().tune({ targets: t.includes(label) ? t.filter((x) => x !== label) : [...t, label] }, "scan");
  },

  setLabelConf(label, v) {
    get().tune({ labelConf: { ...get().labelConf, [label]: v } }, "scan");
  },

  async addImages(items) {
    if (!items.length) return;
    const base = await backendUrl();
    // 목록에 그릴 작은 그림·크기는 서버가 준다. 앱에는 경로만 오므로 화면이 못 읽는다
    let probed: { thumb?: string; width?: number; height?: number }[] = [];
    try {
      const r = await post<{ items: { thumb?: string; width?: number; height?: number }[] }>(
        "/api/tools/probe",
        { items: items.map((it) => ({ name: it.name, rel: it.rel, path: it.path, data: it.data })) },
      );
      probed = r.items;
    } catch {}
    const cur = get().images;
    const have = new Set(cur.map((x) => x.rel ?? x.path ?? x.name));
    const add: CensorImage[] = [];
    items.forEach((it, i) => {
      const key = it.rel ?? it.path ?? it.name;
      if (have.has(key)) return;
      have.add(key);
      add.push({
        id: `c${seq++}`,
        name: it.name,
        rel: it.rel,
        path: it.path,
        data: it.data,
        thumb: probed[i]?.thumb || (it.rel ? undefined : undefined),
        w: probed[i]?.width,
        h: probed[i]?.height,
      });
    });
    if (!add.length) return;
    void base;
    const images = [...cur, ...add];
    // 담은 것이 늘면 「전체 검열」을 다시 돌려야 한다. 새 장에는 아직 박스가 없다
    set({ images, staged: false });
    if (get().tab === "before") get().select(images.indexOf(add[0]));
  },

  /** 파일 트리 격자에서 누르면 목록에 담고, 다시 누르면 뺀다 */
  toggleRel(rel, name) {
    const at = get().images.findIndex((x) => x.rel === rel);
    if (at >= 0) return get().removeImage(at);
    void get().addImages([{ name, rel }]);
  },

  removeImage(i) {
    const s = get();
    if (s.tab === "after") return;
    const images = s.images.filter((_, n) => n !== i);
    const idx = images.length ? Math.min(s.idx > i ? s.idx - 1 : s.idx, images.length - 1) : -1;
    set({ images, idx: -1 });
    // ★인덱스를 한 번 -1 로 떨어뜨린 뒤 다시 고른다. 같은 번호에 다른 그림이 오면
    //   select 가 "이미 그 자리"라고 보고 아무것도 안 한다
    if (idx >= 0) get().select(idx);
    else set({ src: null, renderer: null, idx: -1 });
  },

  clearImages() {
    scanSeq++;
    set({ images: [], idx: -1, src: null, renderer: null, boxes: {}, scanning: false, staged: false, error: null });
  },

  select(i) {
    const s = get();
    const list = s.tab === "after" ? s.after : s.images;
    if (i < 0 || i >= list.length) return set({ src: null, renderer: null, undos: [] });
    const im = list[i];
    set(s.tab === "after" ? { afterIdx: i } : { idx: i });
    // 되돌리기는 그림마다다 — 넘기면 비운다 (다른 그림의 칸을 이 그림에 되돌려 넣지 않게)
    set({ undos: [], renderer: null, error: null });
    // ★그림을 **비트맵으로** 들여야 캔버스가 그린다. 주소만으로는 못 그린다
    void loadRenderer(im).then(({ src, renderer, size }) => {
      // 넘기는 사이에 다른 장으로 갔으면 버린다
      if (get().cur()?.id !== im.id) return;
      set({ src, renderer, rev: get().rev + 1 });
      if (size && !get().sizes[im.id]) set({ sizes: { ...get().sizes, [im.id]: size } });
    }).catch((e) => {
      if (get().cur()?.id === im.id) set({ error: String(e) });
    });
    prefetch(list, i);
    if (s.tab === "before" && !get().boxes[im.id]) void get().scan();
  },

  step(d) {
    const s = get();
    const list = s.tab === "after" ? s.after : s.images;
    const at = s.tab === "after" ? s.afterIdx : s.idx;
    const next = at + d;
    if (next >= 0 && next < list.length) s.select(next);
  },

  async scan() {
    const s = get();
    const im = s.cur();
    if (!im || s.tab !== "before" || !s.model) return;
    if (!s.targets.length) return set({ boxes: { ...s.boxes, [im.id]: [] } });
    if (scanTimer) clearTimeout(scanTimer);
    const mine = ++scanSeq;
    set({ scanning: true });
    scanTimer = setTimeout(() => {
      void (async () => {
        try {
          const r = await post<{ detections: Box[]; width: number; height: number }>("/api/censor/detect", {
            ...sourceOf(im),
            model: s.model,
            targets: s.targets,
            label_conf: s.labelConf,
            default_conf: s.conf,
            // ★문턱 미달도 받아 온다. 화면의 「낮은 신뢰도 숨김」이 다시 거른다.
            //   문턱을 올렸다 내릴 때마다 다시 찾지 않아도 된다
            return_all: true,
          });
          if (mine !== scanSeq) return;
          set({
            boxes: { ...get().boxes, [im.id]: r.detections },
            sizes: { ...get().sizes, [im.id]: { w: r.width, h: r.height } },
            error: null,
          });
        } catch (e) {
          if (mine === scanSeq) set({ error: String(e) });
        } finally {
          if (mine === scanSeq) set({ scanning: false });
        }
      })();
    }, 250);
  },

  /** 전체 검열. 담아 둔 것을 **전부 찾아** 검열 중 탭으로 넘긴다 (v2 `runBatchCensor`).
   *
   *  ★이미 찾아 둔 장은 **다시 찾지 않는다.** v2 는 전부 새로 돌려서, 검열 전 탭에서
   *    꺼 둔 오탐이 되살아났다 (장당 0.4초·XL 은 4초라 기다림도 그만큼 길었다). */
  async scanAll() {
    const s = get();
    if (s.busy || !s.images.length || !s.model) return;
    if (!s.targets.length) return set({ error: t("censor.needTarget") });
    set({ busy: true, error: null, progress: { done: 0, total: s.images.length, what: "scan" } });
    const boxes = { ...s.boxes };
    const sizes = { ...s.sizes };
    const paint = { ...s.paint };
    for (let i = 0; i < s.images.length; i++) {
      const im = s.images[i];
      try {
        if (!boxes[im.id]) {
          const r = await post<{ detections: Box[]; width: number; height: number }>("/api/censor/detect", {
            ...sourceOf(im),
            model: s.model,
            targets: s.targets,
            label_conf: s.labelConf,
            default_conf: s.conf,
            return_all: true,
          });
          boxes[im.id] = r.detections;
          sizes[im.id] = { w: r.width, h: r.height };
        }
        boxes[im.id] = boxes[im.id].filter((b) => !b.off && passes(b, s.labelConf, s.conf));
        /* ★★찾은 박스를 **격자에 굽는다** — 검열 중 탭이 고치는 것은 박스가 아니라 이 격자다
           (붓·지우개, 사용자 지시 2026-09-05). 구운 뒤로는 찾은 것과 칠한 것을 가르지 않는다.
           ★★**언제나 새로 굽는다** (사용자 지적 2026-09-05: *"취소를 누르고 다시 검열을 누르면
             이전 편집 상태가 그대로 나옴. 검열 시작을 눌러도 YOLO 가 체크한 박스만 살리고 모두
             초기화"*). 전에는 격자가 있으면 그대로 두어 손본 것을 남겼는데, 그것이 「편집 상태가
             보존되는 문제」였다. 탐지 결과(`boxes`)만 살고 칠한 것은 여기서 버려진다. */
        const sz = sizes[im.id];
        if (sz) paint[im.id] = burnBoxes(makeMask(sz.w, sz.h), boxes[im.id], s.method);
      } catch (e) {
        boxes[im.id] = boxes[im.id] ?? [];
        set({ error: String(e) });
      }
      set({ progress: { done: i + 1, total: s.images.length, what: "scan" } });
    }
    set({ boxes, sizes, paint, busy: false, progress: null, staged: true });
    get().setTab("processing");
  },

  /** 일괄 저장. ★**박스가 0개인 장도 저장한다**. 결과 폴더가 원본 묶음의 대역이 되어야 한다 */
  async saveAll() {
    const s = get();
    if (s.busy || !s.images.length) return;
    set({ busy: true, error: null, progress: { done: 0, total: s.images.length, what: "save" } });
    const made: CensorImage[] = [];
    const saved = new Set<string>();
    for (let i = 0; i < s.images.length; i++) {
      const im = s.images[i];
      try {
        /* ★★**화면이 굽는다.** 지금 보고 있지 않은 장도 여기서 원본 크기로 한 장 그린다
           (`renderOne`). 서버는 받은 바이트를 적기만 한다 — 렌더러가 한 벌이라
           보고 있던 그림과 저장본이 갈릴 수 없다. */
        const blob = await renderOne(im, sceneOf(get().paint[im.id]), coverOf(get()));
        const r = await post<{ file: string; name: string }>("/api/censor/apply", {
          ...sourceOf(im),
          name: im.name,
          ...destOf(get(), s.images),
          image: await blobToBase64(blob),
        });
        made.push(savedItem(r));
        saved.add(im.id);
      } catch (e) {
        set({ error: String(e) });
      }
      set({ progress: { done: i + 1, total: s.images.length, what: "save" } });
    }
    await thumbsFor(made);
    /* ★★**저장한 장의 편집 상태는 버린다** (사용자 지적 2026-09-04: *"검열 편집하고 난 다음에
       같은 이미지 한 번 더 돌렸는데 이전에 작업했던 편집 정보가 남아 있었음"*).
       `scanAll` 은 `boxes[id]` 가 있으면 탐지를 건너뛰고 `paint[id]` 가 있으면 굽기를 건너뛰므로,
       남겨 두면 **다음 판이 지난번에 손본 것으로 시작한다.** ★빈 배열로 두면 안 된다 —
       `[]` 도 값이라 그 건너뛰기에 걸린다. 열쇠를 **지운다.** */
    const kept = { ...get().boxes };
    const keptPaint = { ...get().paint };
    for (const im of s.images) {
      delete kept[im.id];
      delete keptPaint[im.id];
    }
    /* ★★**저장한 장은 검열 전 목록에서 뺀다** (사용자 지적 2026-09-06: *"검열중에서 전체저장을
       하면 검열 완료에 이번에 검열한 것만 뜨게"*). 남겨 두면 다음에 몇 장을 더 담아 「검열 시작」을
       누를 때 **지난번 것까지 다시 찾고 다시 저장한다** — 검열 후 탭에 옛 장이 또 뜨고, 폴더에는
       `_censored_2` 가 쌓인다. 저장에 실패한 장만 남겨 다시 돌릴 수 있게 한다. */
    const images = get().images.filter((im) => !saved.has(im.id));
    set({ after: made, afterIdx: -1, images, idx: images.length ? 0 : -1, busy: false, progress: null, staged: false, boxes: kept, paint: keptPaint, undos: [] });
    get().setTab("after");
  },

  /** 검열 후 목록을 비운다 — 파일은 그대로다. 결과를 다 봤으면 다음 판을 깨끗한 화면에서 (사용자 지시 2026-09-06) */
  clearAfter() {
    const s = get();
    const paint = { ...s.paint };
    for (const im of s.after) delete paint[im.id];
    set({ after: [], afterIdx: -1, paint, undos: [], error: null });
    if (s.tab === "after") set({ src: null, renderer: null });
  },

  /** 검열 후 탭에서 한 장을 다시 저장한다 (v2 `saveAfterEdit`) */
  async saveOne() {
    const s = get();
    const im = s.cur();
    if (!im || s.busy) return;
    const scene = sceneOf(s.paint[im.id]);
    if (!scene.boxes.length) return set({ error: t("censor.needBox") });
    set({ busy: true, error: null });
    try {
      // ★지금 보고 있는 장이라 렌더러가 이미 있다. 그것으로 원본 크기 한 장을 굽는다
      const r0 = s.renderer;
      const blob = r0 ? await r0.renderFull(scene, coverOf(s)) : await renderOne(im, scene, coverOf(s));
      const r = await post<{ file: string; name: string }>("/api/censor/apply", {
        ...sourceOf(im),
        name: im.name,
        ...destOf(s, [im]),
        image: await blobToBase64(blob),
      });
      const made = savedItem(r);
      await thumbsFor([made]);
      // ★빈 것으로 두지 않고 **열쇠를 지운다** (`saveAll` 의 ★★주)
      const rest = { ...get().paint };
      delete rest[im.id];
      set({ after: [...get().after, made], paint: rest, undos: [] });
      get().select(get().after.length - 1);
    } catch (e) {
      set({ error: String(e) });
    } finally {
      set({ busy: false });
    }
  },

  cancelProcessing() {
    // ★취소하면 칠한 것을 **무조건 버린다** (사용자 지시 2026-09-05). 탐지 결과는 남는다
    set({ tab: "before", undos: [], paint: {}, staged: false, error: null });
    get().select(get().idx >= 0 ? get().idx : 0);
  },

  toggleBox(i) {
    const s = get();
    s.putBoxes(s.curBoxes().map((b, n) => (n === i ? { ...b, off: !b.off } : b)));
  },

  curMask() {
    const s = get();
    const im = s.cur();
    if (!im) return null;
    const have = s.paint[im.id];
    if (have) return have;
    const sz = s.sizes[im.id];
    if (!sz) return null;
    const m = makeMask(sz.w, sz.h);
    set({ paint: { ...s.paint, [im.id]: m } });
    return m;
  },

  strokeBegin() {
    const m = get().curMask();
    if (!m) return false;
    // ★한 획이 한 걸음 — 긋기 **전에** 지금 픽셀을 얼려 둔다. 손을 뗄 때 손댄 자리만 잘라 더미에 넣는다
    set({ strokeBase: { cells: new Uint8Array(m.cells), alpha: new Uint8Array(m.alpha) }, strokeDirty: emptyRect(), editing: true });
    return true;
  },

  strokeAt(at, last, erase) {
    const s = get();
    const m = s.curMask();
    if (!m) return;
    /* ★붓은 **지금 고른 방식**을 픽셀에 적는다. 그래서 방식을 바꿔 가며 칠하면 자리마다 방식이
       다르다 — 박스 시절의 「고른 박스만 다른 방식」이 하던 일을 붓이 자연스럽게 한다. */
    const v = erase ? 0 : methodIndex(s.method);
    const dirty = s.strokeDirty ?? undefined;
    if (last) stroke(m, last, at, s.brushPx, v, s.brushShape, dirty);
    else stamp(m, at.x, at.y, s.brushPx, v, s.brushShape, dirty);
    // ★여기서 다시 그리지 않는다 — 픽셀은 제자리에서 바뀌었고, 무대가 `paint()` 로 그 자리에서 그린다
  },

  strokeEnd() {
    const s = get();
    const m = s.curMask();
    // ★손댄 사각형의 **획 전 픽셀**을 한 걸음으로. 아무것도 안 건드렸으면 걸음도 없다
    const p = m && s.strokeBase && s.strokeDirty ? snapshot(m, s.strokeBase.cells, s.strokeBase.alpha, s.strokeDirty) : null;
    const undos = p ? [...s.undos.slice(-(UNDO_MAX - 1)), p] : s.undos;
    // 손을 떼면 덮개를 다시 진하게, 그리고 제 해상도로 한 번 더 굽게 (`rev`)
    set({ editing: false, strokeBase: null, strokeDirty: null, undos, rev: s.rev + 1 });
  },

  eraseBlob(at) {
    const s = get();
    const m = s.curMask();
    if (!m || !m.cells[at.y * m.w + at.x]) return;
    s.strokeBegin();
    floodErase(m, at.x, at.y, get().strokeDirty ?? undefined);
    s.strokeEnd();
  },

  undoPaint() {
    const s = get();
    const m = s.curMask();
    const prev = s.undos[s.undos.length - 1];
    if (!m || !prev || prev.x1 > m.w || prev.y1 > m.h) return;
    restore(m, prev);
    set({ undos: s.undos.slice(0, -1) });
    s.bump();
  },

  clearPaint() {
    const s = get();
    const m = s.curMask();
    if (!m || isEmpty(m)) return;
    s.strokeBegin();
    // ★손댄 자리 = 켜져 있던 자리 전부 (`bounds`). 되돌리면 그 사각형이 그대로 돌아온다
    const dirty = get().strokeDirty;
    if (dirty) Object.assign(dirty, m.bounds);
    clearMask(m);
    get().strokeEnd();
  },

  /** ★★방식을 바꾸면 **지금 칠한 칸에 전부 걸린다** (사용자 지시 2026-08-23).
   *
   *  칸은 칠할 때의 방식을 **자기가 들고 있다** (`strokeAt` — 자리마다 다르게 할 수 있어야
   *  하므로). 그래서 방식 단추가 「다음에 칠할 것」에만 걸리면, 화면은 그대로인 채 단추만
   *  옮겨 간다 — 박스 시절에 한 번 밟은 함정이다.
   *  ★검열 전 탭에서는 안 건다 — 거기 박스는 아직 「찾은 것」이고, 방식은 다음 검열의 값이다.
   *  ★자리마다 따로 두는 길은 그대로다 — 전체를 바꾼 뒤에 다른 방식으로 그 자리만 덧칠한다. */
  setMethod(m) {
    const s = get();
    if (s.tab === "processing") {
      /* ★★검열 중이면 **모든 그림**의 칸에 건다 (v2 `censorMethod.onchange`, 카탈로그 5039).
         지금 그림만 바꾸면 앞서 찾아 둔 나머지는 **옛 방식으로 저장된다** — 저장하고 나서야
         드러나는 조용한 회귀라, 카탈로그가 그 함정을 따로 적어 두었다. */
      for (const im of s.images) {
        const g = s.paint[im.id];
        if (g) remap(g, methodIndex(m));
      }
    } else if (s.tab === "after" && s.cur()) {
      // ★검열 후에는 **지금 그림만** — 이미 저장된 다른 장을 건드릴 이유가 없다 (v2 와 같다)
      const g = s.curMask();
      if (g) remap(g, methodIndex(m));
    }
    // ★검열 전 탭에서는 박스에 안 건다 — 거기 박스는 「찾은 것」이고 방식은 다음 검열의 값이다
    /* ★★넓히기·부드럽게·들춰보기는 방식마다 따로다 (`methodOpts` 의 ★★주) — 지금 값을 재우고 새 방식의 값을 깨운다.
       처음 가는 방식이면 지금 값을 물려받는다. `feather` 가 바뀌므로 구름 무늬까지 다시 만든다 (`tune` 의 heavy). */
    const cur = { expand: s.expand, feather: s.feather, peek: s.peek };
    const methodOpts = { ...s.methodOpts, [s.method]: cur };
    s.tune({ method: m, methodOpts, ...(methodOpts[m] ?? cur) }, "draw");
  },

  /** 다시 그리라고 알린다. 무대가 `rev` 를 보고 캔버스를 새로 그린다.
   *
   *  ★★여기서 **아무것도 계산하지 않는다.** 박스를 끄는 동안 일어나는 일은 숫자 하나가
   *    오르는 것뿐이고, 실제 그리기는 무대가 `CensorRenderer` 로 그 자리에서 한다.
   *  ★`heavy` 는 캐시를 어디까지 버릴지다:
   *      (없음)   모양만 바뀌었다 — 재료를 그대로 쓴다 (가장 잦고, 가장 싸다)
   *      layers   방식·모자이크·흐리기·색·넓히기가 바뀌었다 — 재료를 다시 만든다
   *      all      「부드럽게」가 바뀌었다 — 구름 무늬까지 다시 만든다
   */
  bump(heavy) {
    const r = get().renderer;
    if (r && heavy === "all") r.invalidateAll();
    else if (r && heavy === "layers") r.invalidate();
    set({ rev: get().rev + 1 });
  },
}));

/** 이 박스가 **문턱을 넘었나.** ★저장된 `passes_threshold` 를 그대로 믿지 않는다.
 *  찾은 뒤에 클래스별 문턱을 고쳤으면 그 값은 옛것이다. 지금 설정으로 다시 판정한다. */
export const passes = (b: Box, labelConf: Record<string, number>, conf: number) =>
  !!b.manual || b.confidence >= (labelConf[b.label] ?? conf);

/** 새 클래스에는 지금 문턱을 채워 준다 (v2 는 0.3 을 박아 뒀다. 여기서는 공통 문턱을 쓴다) */
function fillConf(cur: Record<string, number>, classes: string[], base: number) {
  const out = { ...cur };
  for (const c of classes) if (!(c in out)) out[c] = base;
  return out;
}

function save(s: Saved) {
  const { model, targets, labelConf, conf, floor, method, color, expand, feather, mosaic,
    mosaicOpacity, blur, steamBright, steamAlpha, steamFade, peek, brushPx, brushShape, dest, destMode, view } = s;
  // ★지금 방식의 값을 보관함에도 넣어 적는다 — 다음에 열 때 방식마다 제 값으로 시작한다
  const methodOpts = { ...s.methodOpts, [method]: { expand, feather, peek } };
  try {
    localStorage.setItem(KEY, JSON.stringify({ model, targets, labelConf, conf, floor, method,
      color, expand, feather, mosaic, mosaicOpacity, blur, steamBright, steamAlpha, steamFade, peek, brushPx, brushShape, dest, destMode, methodOpts, view }));
  } catch {}
}

/** 가리는 방법 한 벌. **화면과 저장이 같은 값을 지난다** (렌더러가 한 벌이므로) */
export function coverOf(s: Saved): CoverSettings {
  return {
    method: s.method,
    color: s.color,
    expand: s.expand,
    feather: s.feather,
    mosaic: s.mosaic,
    mosaicOpacity: s.mosaicOpacity,
    blur: s.blur,
    steamBright: s.steamBright,
    steamAlpha: s.steamAlpha,
    steamFade: s.steamFade,
  };
}

/** 무대에 그릴 주소. 아웃풋 안의 그림은 그대로 가리키고, 밖의 것은 서버에서 한 번 받는다.
 *
 *  ★떨군 그림은 **원본 그대로** 온다 (`/api/censor/image`). 줄여 받으면 저장할 때 그 크기로
 *    구워져 원본보다 작은 그림이 나온다. */
async function resolveSrc(im: CensorImage): Promise<{ src: string; size?: { w: number; h: number } }> {
  const hit = cacheGet(im.id);
  if (hit) return { src: hit, size: im.w && im.h ? { w: im.w, h: im.h } : undefined };
  if (im.rel) {
    /* ★★**바이트를 받아 `blob:` 주소로 쓴다.** 백엔드는 화면과 다른 오리진이라, 그 주소를
       그대로 캔버스에 그리면 캔버스가 **오염**되어 `toBlob` 이 막힌다 — 즉 저장이 통째로
       안 된다 (실측 2026-08-23). `crossOrigin="anonymous"` 로도 되지만, 같은 주소를
       한쪽은 켜고 한쪽은 끄면 **브라우저 캐시가 어긋나 그림이 아예 안 뜬다** (이것도 실측).
       blob 주소는 언제나 같은 오리진이라 그 함정이 처음부터 없다. */
    const res = await fetch(fileMgrImg(await backendUrl(), im.rel));
    if (!res.ok) throw new Error(`그림을 못 읽었습니다 (${res.status})`);
    const src = URL.createObjectURL(await res.blob());
    cacheSet(im.id, src);
    return { src };
  }
  const r = await post<{ image: string; width: number; height: number }>("/api/censor/image", sourceOf(im));
  cacheSet(im.id, r.image);
  im.w = r.width;
  im.h = r.height;
  return { src: r.image, size: { w: r.width, h: r.height } };
}

/** 그 그림의 **렌더러**를 만든다 (비트맵을 들여야 캔버스가 그린다).
 *
 *  ★`decode()` 를 기다린다 — 안 기다리고 그리면 첫 프레임이 빈 캔버스로 나간다. */
async function loadRenderer(im: CensorImage) {
  const { src, size } = await resolveSrc(im);
  const el = new Image();
  el.src = src;
  await el.decode();
  const w = size?.w ?? el.naturalWidth;
  const h = size?.h ?? el.naturalHeight;
  return { src, size: { w, h }, renderer: new CensorRenderer(el, w, h) };
}

/** 저장할 때 쓰는 렌더러 — 일괄 저장은 **화면에 없는 장**도 구워야 한다.
 *  ★들고 있지 않는다. 한 장 굽고 버린다 (수십 장의 비트맵을 동시에 쥐면 메모리가 는다). */
export async function renderOne(im: CensorImage, scene: Scene, s: CoverSettings) {
  const { renderer } = await loadRenderer(im);
  return await renderer.renderFull(scene, s);
}

/** 렌더러에 줄 것 — 스팀용 사각형과 비트맵 (`censorRender.Scene`) */
export function sceneOf(m: Mask | undefined): Scene {
  return { boxes: toRenderBoxes(m), mask: m ?? null };
}

/** 캔버스가 구운 것을 서버가 받을 수 있는 base64 로 */
export async function blobToBase64(b: Blob): Promise<string> {
  const buf = new Uint8Array(await b.arrayBuffer());
  let bin = "";
  for (let i = 0; i < buf.length; i += 0x8000) {
    bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

/** 좌우 세 장을 미리 받아 둔다 (v2 `prefetchCensorImages`) */
function prefetch(list: CensorImage[], at: number) {
  for (let d = 1; d <= 3; d++) {
    for (const i of [at + d, at - d]) {
      const im = list[i];
      if (!im || srcCache.has(im.id)) continue;
      void resolveSrc(im).then(({ src }) => {
        // 브라우저 캐시에도 올려 둔다. 넘기는 순간 다시 내려받지 않게
        const img = new Image();
        img.src = src;
      });
    }
  }
}
