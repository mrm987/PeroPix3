import { create } from "zustand";
import { compileBlocks, makeBlock, type Block } from "../lib/blocks";
import { t } from "../i18n";
import { kindColor } from "../cards/kindColor";
import { nextCenter, type Center } from "../lib/charPos";
import { moveTo } from "../lib/moveTo";
// ★모델이 자유 배치를 하는지에 따라 「이 자리가 찼나」의 판정이 다르다 (`charPos`).
//   `gen` 과 서로 참조하게 되는데, 함수 안에서만 읽으므로 문제가 없다
//   (`imageInput` ↔ `gen` 이 이미 같은 모양이다).
import { useGen } from "./gen";
import { caps } from "../lib/naiModels";

/** 프롬프트 영역 — NAI 요청 구조 그대로.
 *  ★소유는 워크스페이스다. 여기는 편집 중인 사본이고, 저장은 workspace 스토어가 한다. */

/** 캐릭터 섹션 = NAI 의 `characterPrompts[]` 한 칸.
 *  `ref` 는 어느 카드에서 왔는지의 **출처 표시**다 (schema.md 5절). 동기화하지 않는다 —
 *  과거 생성물의 재현은 records 의 resolved 가 책임진다. */
/** 그림을 어떻게 볼지 — 초점 %(px·py)와 배율 */
export type View = { zoom: number; px: number; py: number };

/** 배너·카드 앞면에 깔리는 그림.
 *  ★**하나의 그림, 여러 개의 보는 방식**이다 (사용자 결정, 2026-08-02).
 *    바이트는 공용 저장소에 하나만 있고(`/api/pin/<tid>`), 배너·카드 앞면·덱 커버가
 *    전부 같은 tid 를 가리킨다. 목적지마다 사본을 따로 굽는 구조로 되돌리지 말 것.
 *  ★배너와 덱 카드 앞면은 비율이 달라 **보는 방식만** 따로 갖는다 (banner·face). */
export type Thumb = {
  /** 고정 썸네일 id — 배너·카드 앞면·덱 커버가 **같은** 그림을 이 하나로 가리킨다.
   *  원본(work/)이 정리돼도 이 그림은 남는다 (서버 thumbs.py 참조). */
  tid: string;
  banner: View;
  face: View;
};

// 인물 사진은 위쪽이 얼굴이라 가운데보다 조금 위를 기본으로 본다
export const defaultView = (): View => ({ zoom: 1, px: 50, py: 35 });

/** 저장된 값을 Thumb 으로 — 평평한 {zoom,px,py} 한 벌만 있는 것도 읽는다 (덱 커버가 그렇다).
 *
 *  ★`tid` 가 없으면 null 이다. 옛 형식({ws,file} · {card})은 서버가 뜰 때 한 번
 *    이전해 준다(backend/migrate_thumbs.py) — 프론트에 옛 경로를 남겨 두지 않는다. */
export function normThumb(t: unknown): Thumb | null {
  if (!t || typeof t !== "object") return null;
  const o = t as Record<string, unknown> & Partial<Thumb>;
  if (typeof o.tid !== "string" || !o.tid) return null;
  const flat =
    typeof o.zoom === "number"
      ? { zoom: o.zoom as number, px: (o.px as number) ?? 50, py: (o.py as number) ?? 35 }
      : null;
  const banner = (o.banner as View) ?? flat ?? defaultView();
  const face = (o.face as View) ?? flat ?? banner;
  return { tid: o.tid, banner, face };
}

/** 고정 썸네일의 주소 — **한 군데서만 만든다.**
 *  ★tid 가 내용에서 나오므로 그림이 바뀌면 주소도 바뀐다. 판 번호(rev)를 붙이지 않는다. */
export const thumbUrl = (base: string, t: Thumb): string => `${base}/api/pin/${t.tid}`;

/** 카드가 들고 있는 그림을 섹션 배너로 — 카드를 꽂으면 그림도 따라온다.
 *  ★같은 tid 를 가리킬 뿐이라 바이트가 복사되지 않는다. */
export const thumbFromCard = (view?: unknown): Thumb | null => normThumb(view ?? null);

export type Char = {
  id: string;
  ref: string | null;
  name: string;
  color: [string, string];
  thumb: Thumb | null;
  prompt: Block[];
  uc: Block[];
  on: boolean;
  /** 화면에서 이 인물이 설 자리 (0~1). **언제나 값이 있다** — 좌표를 안 쓰는 상태는
   *  `center` 를 비우는 것이 아니라 `params.use_coords` 를 끄는 것이다 (공홈과 같다).
   *  ★들어올 때 `charPos.nextCenter` 가 빈 자리를 골라 준다. */
  center: Center;
};

/** 편집 대상 지정 — "base" 는 공통, 그 외는 캐릭터 id */
export type AreaId = "base" | "baseUc";

type S = {
  base: Block[];
  baseUc: Block[];
  style: { ref: string | null; name: string; color: [string, string]; thumb: Thumb | null };
  /** ★스타일 카드를 **쓰고 있는가** (사용자 지시 2026-08-19).
   *
   *  끄면 카드가 화면에서 빠지고 **베이스 프롬프트·UC 도 안 나간다** (`compiled`) —
   *  화면에 없는 것이 조용히 실려 나가면 안 된다. 캐릭터를 지우는 것과 같은 뜻이다.
   *  ★값이 없으면(옛 워크스페이스) **켜진 것**이다. */
  styleOn: boolean;
  chars: Char[];
  /** ★★**순차 생성 모드** (사용자 결정 2026-09-15). 켜면 캐릭터 칸을 한 장에 모아 넣지 않고
   *  **켜 둔 인물을 한 명씩** 차례로 뽑는다 — 「슬롯을 하나씩만 켠 것처럼」이 규칙이다.
   *  ★★탭의 것이다 (사용자 지시: *"탭 안에서는 프롬프트를 공유하기 때문에 그게 자연스러움"*) —
   *    그래서 프롬프트와 같은 자리에 담겨 `TabPrompt` 로 오간다.
   *  ★이 모드에서는 한 장에 한 명이라 **모델의 캐릭터 수 상한이 안 걸린다** (`store/gen` 의 `charLimit`).
   *  ★없으면 꺼진 것이다 (옛 워크스페이스). */
  seqChars: boolean;
  setSeqChars: (v: boolean) => void;
  /* ★★섹션 접힘과 `Prompt`/`UC` 탭은 **여기 없다** — `useUi.view` 로 옮겼다
     (사용자 지시 2026-08-22). 여기 있으면 `load()` 가 탭을 옮길 때마다 통째로 비워서
     「펴 둔 대로」가 자꾸 풀렸다. 문서가 아니라 **보는 방식**이라 화면 쪽에 산다. */
  update: (area: AreaId, fn: (blocks: Block[]) => Block[]) => void;
  updateChar: (id: string, area: "prompt" | "uc", fn: (blocks: Block[]) => Block[]) => void;

  setStyle: (s: { ref: string | null; name: string; color: [string, string]; base?: Block[]; uc?: Block[]; thumb?: Thumb | null }) => void;
  /** 생성물을 배너에 꽂는다. section 은 "base" 또는 캐릭터 id */
  setThumb: (section: string, thumb: Thumb | null) => void;
  addChar: (c: Partial<Char>) => string;
  /** 이 자리의 인물을 **다른 카드로 바꾼다** (사용자 지시 2026-08-24로 되살렸다).
   *
   *  ★★한 번 걷었다가 되돌린 자리다. 걷은 근거였던 *"새로 추가하고 옛 카드를 지우는 것과
   *    결과가 같다"* 는 **틀렸다**: 새로 추가하면 차례가 맨 뒤로 가고 자리 좌표도 새로 잡히는데,
   *    교체는 **그 자리 그대로** 사람만 갈린다 (차례는 `characterPrompts[]` 의 차례라 그림에 남는다).
   *  ★자리·켜짐은 **자리의 것**이라 그대로 둔다 — 갈리는 것은 카드에서 온 값뿐이다. */
  swapChar: (id: string, c: Partial<Char>) => void;
  removeChar: (id: string) => void;
  /** 인물 차례 바꾸기 — ★차례가 곧 `characterPrompts[]` 의 차례다 (`use_order: true`).
   *  NAI 는 앞에 온 인물을 먼저 잡으므로 **누가 몇 번째인가가 그림에 남는다.** */
  stepChar: (id: string, dir: -1 | 1) => void;
  renameChar: (id: string, name: string) => void;
  toggleChar: (id: string) => void;
  /** 배치 판에서 인물을 옮긴다 */
  setCenter: (id: string, center: Center) => void;

  /** 저장된 spec 을 그대로 받는다 — 구버전 세션에는 style·chars·thumb 이 없다 */
  load: (p: {
    base?: Block[];
    baseUc?: Block[];
    style?: { ref: string | null; name: string; color: [string, string]; thumb?: Thumb | null };
    styleOn?: boolean;
    chars?: Char[];
    seqChars?: boolean;
  }) => void;
  setStyleOn: (v: boolean) => void;
  snapshot: () => Pick<S, "base" | "baseUc" | "style" | "styleOn" | "chars" | "seqChars">;
  compiled: () => {
    prompt: string;
    uc: string;
    /** ★`id` 를 함께 낸다 — 씬 프롬프트 목적지가 캐릭터 id 로 가리킨다 (`SceneLane` 의 선택기).
     *  서버는 모르는 키를 무시하므로 그대로 실어 보내도 된다. */
    chars: { id: string; prompt: string; uc: string; center: Center }[];
  };
};

/** ★★색은 **종류마다 하나**다 (`cards/kindColor`, 사용자 결정 2026-08-20).
 *  ~~캐릭터마다 다른 색을 돌려 주던 것~~은 걷었다 — 카드끼리 가르는 것은 **그림**이 한다
 *  (*"바꾸고싶으면 유저가 직접 다른 이미지를 넣으면 됨"*). */
export const DEFAULT_STYLE_COLOR = kindColor("styles");
export const CHAR_COLOR = kindColor("characters");

/** 지금 모델이 자유 배치인가 — 새 인물의 자리를 고를 때 「이 칸이 찼다」의 뜻이 갈린다.
 *  자유 배치는 **거리 0.1**, 격자는 **같은 칸**이다 (`lib/charPos` 머리 주석). */
const freeformNow = () => caps(useGen.getState().params.model).freeform_position;

/** ★★**새 탭의 베이스 프롬프트는 비어 있다** (사용자 지시 2026-08-20).
 *
 *  쓸 것은 **덱에서 끌어다 쓴다** — 탭마다 지우고 시작하지 않아도 된다. 예전에는
 *  `1girl, solo` · 퀄리티 태그가 박힌 채 시작해서, 쓰는 사람이 **먼저 지우는 일**부터 했다.
 *  ★~~「장면」 블록~~은 그 앞에 걷었다 (2026-08-19) — 장면은 씬 줄이 적는 자리다. */
export const defaultBase = (): Block[] => [];

export const defaultUc = (): Block[] => [
  makeBlock(t("block.defaults.base"), ["lowres", "bad anatomy"], { color: "red" }),
];

/** 저장 예약 — 순환 참조를 피하려 workspace 스토어가 여기에 자기 저장 함수를 꽂는다. */
let onEditRaw: (() => void) | null = null;
const onEdit = () => onEditRaw?.();
export const setPromptSaver = (fn: () => void) => {
  onEditRaw = fn;
};

const newId = () => "ch_" + Math.random().toString(36).slice(2, 8);

export const usePrompt = create<S>((set, get) => ({
  base: defaultBase(),
  baseUc: defaultUc(),
  style: { ref: null, name: t("prompt.defaultStyleName"), color: DEFAULT_STYLE_COLOR, thumb: null },
  styleOn: true,
  chars: [],
  seqChars: false,

  setSeqChars: (v) => {
    set({ seqChars: v });
    onEdit();
  },

  update: (area, fn) => {
    set({ [area]: fn(get()[area]) } as Pick<S, AreaId>);
    onEdit();
  },

  updateChar: (id, area, fn) => {
    set({
      chars: get().chars.map((c) => (c.id === id ? { ...c, [area]: fn(c[area]) } : c)),
    });
    onEdit();
  },

  setStyle: (s) => {
    // 스타일 카드는 **Base 블록까지** 교체한다 — 그림체가 곧 공통 프롬프트다
    // ★★카드가 들어오면 **카드가 서 있는 상태가 된다** (사용자 지적 2026-08-20:
    //   카드를 빼 둔 자리에는 스타일 카드를 떨굴 수가 없었다). 내용만 들어오고 카드는
    //   빠져 있는 상태는 뜻이 없다 — 그 내용이 곧 그 카드다.
    set({
      styleOn: true,
      style: { ref: s.ref, name: s.name, color: s.color, thumb: s.thumb ?? null },
      ...(s.base ? { base: s.base } : {}),
      ...(s.uc ? { baseUc: s.uc } : {}),
    });
    onEdit();
  },

  setThumb(section, thumb) {
    if (section === "base") set({ style: { ...get().style, thumb } });
    else set({ chars: get().chars.map((c) => (c.id === section ? { ...c, thumb } : c)) });
    onEdit();
  },

  addChar(c) {
    const chars = get().chars;
    const id = c.id ?? newId();
    set({
      chars: [
        ...chars,
        {
          id,
          ref: c.ref ?? null,
          /* ★★**이름을 실제로 준다** (사용자 지적 2026-08-20: 다른 자리로 옮겼더니 「캐릭터 1」의
             이름이 사라졌다). 「캐릭터 N」은 화면이 빈 이름에 붙여 주던 **표시용 폴백**이라,
             값 자체는 빈 문자열이었다. 이름은 **저장되는 값**이어야 어디로 옮겨도 따라간다. */
          name: c.name || t("cards.charN", { n: chars.length + 1 }),
          color: CHAR_COLOR,
          thumb: c.thumb ?? null,
          prompt: c.prompt ?? [],
          uc: c.uc ?? [],
          on: c.on ?? true,
          /* ★새로 들어오는 인물은 **빈 자리**에 세운다 (공홈 `sw` 사다리 — `lib/charPos`).
             전원을 한가운데 겹쳐 놓으면 좌표를 켜는 순간 셋이 한 칸에 서 있다. */
          center: c.center ?? nextCenter(chars.map((x) => x.center), freeformNow()),
        },
      ],
    });
    onEdit();
    return id;
  },


  swapChar(id, c) {
    set({
      chars: get().chars.map((x) =>
        x.id === id
          ? {
              ...x,
              ref: c.ref ?? null,
              name: c.name ?? x.name,
              color: c.color ?? x.color,
              /* ★그림은 **새 카드의 것으로 갈아 끼운다** — 새 카드에 그림이 없으면 비운다.
                 옛 그림을 남기면 이름만 갈리고 얼굴은 그대로인 카드가 된다. */
              thumb: c.thumb ?? null,
              prompt: c.prompt ?? x.prompt,
              uc: c.uc ?? x.uc,
            }
          : x,
      ),
    });
    onEdit();
  },

  removeChar(id) {
    set({ chars: get().chars.filter((c) => c.id !== id) });
    onEdit();
  },

  /** ★★인물의 차례를 **한 칸** 올리거나 내린다 (사용자 지시 2026-08-21).
   *  차례가 곧 `characterPrompts[]`·`char_captions[]` 의 차례이고 NAI 가 `use_order: true`
   *  로 그 차례를 쓰므로(`backend/nai.py`), 그림에 실제로 남는 값이다.
   *  ★자리 좌표(`center`)는 **인물이 들고 다니는 값**이라 같이 따라간다 — 따로 옮기는 코드를 두지 말 것.
   *  ★끌기로 만들지 않는다: 배너를 끄는 몸짓은 이미 **덱에 저장**이다 (사용자 지적).
   *  ★셈은 `moveTo` 하나뿐이다 — `to` 는 칸이 아니라 **틈** 번호라 아래로 갈 때 `i + 2` 다. */
  stepChar(id, dir) {
    const i = get().chars.findIndex((c) => c.id === id);
    if (i < 0) return;
    const chars = moveTo(get().chars, i, dir < 0 ? i - 1 : i + 2);
    if (chars === get().chars) return;
    set({ chars });
    onEdit();
  },

  renameChar(id, name) {
    set({ chars: get().chars.map((c) => (c.id === id ? { ...c, name } : c)) });
    onEdit();
  },

  toggleChar(id) {
    set({ chars: get().chars.map((c) => (c.id === id ? { ...c, on: !c.on } : c)) });
    onEdit();
  },

  setCenter(id, center) {
    set({ chars: get().chars.map((c) => (c.id === id ? { ...c, center } : c)) });
    onEdit();
  },

  load: (p) => {
    /* ★좌표가 없던 시절의 워크스페이스는 **사다리로 자리를 나눠 준다** (`lib/charPos`).
       전원을 한가운데 두면 배치 판을 처음 여는 순간 마커 셋이 한 점에 겹쳐 있다 —
       새로 만든 워크스페이스와 같은 모습이 되도록 맞춘다.
       ★`center` 가 **있으면 그대로 둔다.** 메타데이터에서 되살릴 때는 그 그림이 실제로
         쓰던 자리라, 없던 그림은 없던 대로(한가운데)여야 한다 (`GalleryMeta` 가 채워 준다). */
    const seated: Center[] = [];
    const chars = (p.chars ?? []).map((c) => {
      const center = c.center ?? nextCenter(seated, freeformNow());
      seated.push(center);
      return {
        ...c,
        color: CHAR_COLOR,
        thumb: normThumb(c.thumb),
        center,
      };
    });
    set({
      // ★★**빈 목록과 「없음」은 다르다** (2026-08-19). 예전에는 빈 목록에도 기본 블록을
      //   채워서, 스타일 카드를 비워 두면 다시 열 때 기본값이 되살아났다. 없을 때만 채운다.
      base: p.base ?? defaultBase(),
      baseUc: p.baseUc ?? defaultUc(),
      style: p.style
        ? { ...p.style, color: DEFAULT_STYLE_COLOR, thumb: normThumb(p.style.thumb) }
        : { ref: null, name: t("prompt.defaultStyleName"), color: DEFAULT_STYLE_COLOR, thumb: null },
      // ★값이 없으면 켜진 것이다 — 옛 워크스페이스가 스타일 카드를 잃으면 안 된다
      styleOn: p.styleOn !== false,
      /* ★옛 인물에는 **이름 해시로 뽑힌 색**이 박혀 있다 — 위에서 종류 색으로 맞춰 뒀다.
         안 맞추면 같은 종류인데 카드마다 색이 다른 화면이 남는다 */
      chars,
      // ★없으면 꺼진 것이다 — 옛 워크스페이스는 지금까지와 같이 한 장에 모아 뽑는다
      seqChars: p.seqChars === true,
    });
  },

  snapshot: () => ({
    base: get().base,
    baseUc: get().baseUc,
    style: get().style,
    styleOn: get().styleOn,
    chars: get().chars,
    seqChars: get().seqChars,
  }),

  /** 스타일 카드를 빼거나 새로 넣는다 (사용자 지시 2026-08-19).
   *
   *  ★★**캐릭터 카드와 같은 규칙이다**: 빼면 내용도 사라지고, 넣으면 **빈 카드**가 생긴다
   *    (사용자 지적 2026-08-19: 추가했더니 빼기 전의 「여름 스타일」이 되살아났다).
   *    「잠깐 꺼 두는 스위치」가 아니라 **카드를 지우고 새로 만드는 것**이다. */
  setStyleOn(v) {
    set({
      styleOn: v,
      style: { ref: null, name: t("prompt.defaultStyleName"), color: DEFAULT_STYLE_COLOR, thumb: null },
      base: [],
      baseUc: [],
    });
    onEdit();
  },

  compiled: () => ({
    // ★스타일 카드를 뺐으면 **베이스도 UC 도 안 나간다** — 화면에 없는 것이 실려 나가면 안 된다
    prompt: get().styleOn ? compileBlocks(get().base) : "",
    uc: get().styleOn ? compileBlocks(get().baseUc) : "",
    chars: get()
      .chars.filter((c) => c.on)
      .map((c) => ({ id: c.id, prompt: compileBlocks(c.prompt), uc: compileBlocks(c.uc), center: c.center })),
  }),
}));

/** UC 에 실제 내용이 있는가 — 탭을 빨갛게 표시하는 판정 (v2.x 동작 계승) */
export const ucHasContent = (blocks: Block[]) =>
  blocks.some((b) => b.on && b.tags.some((x) => x.t.trim()));
