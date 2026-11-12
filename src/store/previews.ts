import { create } from "zustand";
import { api } from "../lib/backend";
import { localTs, type Rec } from "../lib/takes";
import type { Dropped } from "../lib/dropImages";

/** **미저장 그림** — 「자동 저장」을 껐을 때 나온 결과 (v2 `auto_save` 이식 2026-08-18).
 *
 *  ★v2 에는 이것만을 위한 화면이 **없다**. 미저장 그림도 저장된 것과 **같은 슬롯 카드**에
 *    들어가고, 파일명 자리가 「미저장」이 되며 「파일로 저장」 단추가 뜰 뿐이다
 *    (`index.html:12140-12185`). 3.0 도 같다 — 씬 줄의 **같은 칸**에 들어간다.
 *  ★★**디스크에 기록을 남기지 않는다.** `Rec` 는 파일 경로를 전제로 하고 그 목록은
 *    `records.jsonl` 에 쌓이는데, 미저장 그림에는 파일이 없다. 그래서 메모리에만 둔다.
 *  ★★**F5 로 새로고침해도 남는다** (사용자 결정 2026-11-12). 백엔드 프로세스의 메모리에 같은 목록의
 *    사본을 두고(`/api/previews`) 부팅 때 돌려받는다. 백엔드는 화면을 새로 읽어도 살아 있고, 앱을 끄면
 *    함께 내려가므로 재실행에서는 사라진다. 디스크에는 여전히 아무것도 안 쓴다.
 *  ★묶는 창구는 여전히 `takesOf` 하나다. 이 스토어가 하는 일은 **목록에 얹는 것**뿐이고
 *    (`withPreviews`), 어느 씬 것인지 판정하는 것은 `takesOf` 가 한다.
 */

/** 미저장 그림의 `file` 자리에 들어가는 표식.
 *  ★진짜 경로와 섞이면 안 되므로 경로에 못 쓰는 글자(`:`)를 일부러 넣었다 —
 *    `workspace.safe_name` 이 걸러 내는 글자라 실제 파일이 이 이름을 가질 수 없다. */
export const PREVIEW_PREFIX = "preview:";

/** 문자열만 들고 있는 자리(선택 집합 등)의 판정 — 레코드가 있으면 `r.preview` 를 본다 */
export const isPreviewFile = (file: string) => file.startsWith(PREVIEW_PREFIX);

/** 저장할 때 필요한 것 — ★**서버가 생성 때 쓴 값 그대로** 돌려준다 (`_generate_one`).
 *  화면이 저장 시점의 상태로 다시 만들면, 그 사이 씬 이름을 고쳤을 때 번호열이 갈린다
 *  (`workspace.file_lead` 는 이름마다 따로 센다). */
type SaveHint = {
  /** ★**탭 이름**이다 — 저장 경로의 한 칸(`output/<탭>/<세트>/`).
   *  2026-08-24 개명 뒤에도 옛 이름(`char`)으로 읽고 보내고 있었다. 서버는 `tab` 으로
   *  주고 `tab` 으로 받으므로 **늘 비어 있었고**, 「파일로 저장」이 탭 폴더를 빠뜨렸다. */
  tab: string | null;
  cell_no: number | null;
  exclude_slot_number: boolean;
};

export type PreviewTake = Rec & {
  /** 어느 워크스페이스 것인가 — `records` 와 달리 워크스페이스를 옮겨도 안 비워진다 */
  ws: string;
  preview: { b64: string; fmt: string };
  save: SaveHint;
  /** ★★**뽑을 때의 화면 구조** (`gen.ts` 의 `env`) — 파일로 저장할 때 그대로 돌려보낸다.
   *  ★저장 시점의 화면에서 새로 짜면 안 된다: 그 사이 프롬프트를 고쳤으면 **다른 그림의
   *    구조**가 붙는다. 그래서 서버가 생성 응답에 실어 준 것을 여기 들고 있다가 되돌린다.
   *  ★이것이 없으면 나중에 저장한 그림에서 「설정 불러오기」를 눌렀을 때 캐릭터 카드가
   *    통째로 사라지고 `#1`·`#2` 로 다시 만들어진다 (사용자 지적 2026-08-24). */
  env?: Record<string, unknown> | null;
  /** 인퍼런스였으면 그 참조와 배치. `env` 와 같은 이유로 들고 있다가 되돌린다 (설정 불러오기가 참조를 되살린다) */
  inference?: Record<string, unknown> | null;
  /** 별표 — 저장된 그림은 `selection.starred` 에 경로로 적히지만 이것에는 경로가 없어 여기 든다.
   *  「저장」하면 `saveTake` 가 새 경로로 옮겨 적는다. */
  starred?: boolean;
};

type S = {
  items: PreviewTake[];
  /** 서버가 보낸 미리보기 한 장을 담는다 (`image_preview` 브로드캐스트 · 단발 생성 응답) */
  add: (m: Record<string, any>) => PreviewTake;
  /** 미리보기를 버린다 (파일이 아니라 메모리에서 없어질 뿐이다) */
  drop: (file: string) => void;
  /** 여러 장을 버리고 **도로 넣는 함수**를 돌려준다 — `Del`·삭제 버튼의 되돌리기가 부른다
   *  (`lib/sceneTakes.removeTakes`). 저장된 그림이 휴지통을 거쳐 `Ctrl+Z` 로 돌아오는 것과 같게 한다. */
  discard: (files: string[]) => () => void;
  /** 여러 장의 별표를 켜고 끄고 **도로 되돌리는 함수**를 돌려준다 (`workspace.setStars` 의 되돌리기) */
  star: (files: string[], on: boolean) => () => void;
  /** **파일로 저장** — 보통 생성과 같은 이름 규칙을 쓴다 (`/api/save-preview`).
   *  성공하면 그 미리보기는 목록에서 빠지고, 진짜 레코드가 그 자리를 잇는다. */
  save: (file: string) => Promise<Rec>;
};

let seq = 1;
/** ★표식이 이번 화면 실행마다 겹치지 않게 한다 — F5 로 돌려받은 `preview:1` 과 새로 만든 `preview:1` 이 같으면 안 된다 */
const RUN = Math.random().toString(36).slice(2, 7);

export const usePreviews = create<S>((set, get) => ({
  items: [],

  add(m) {
    const take: PreviewTake = {
      // ★저장된 그림과 **같은 자**로 찍는다 — 줄에서 나란히 서야 한다 (`lib/takes.localTs`)
      ts: (m.ts as string) || localTs(),
      file: `${PREVIEW_PREFIX}${RUN}-${seq++}`,
      scene_group: String(m.scene_group ?? ""),
      cell: (m.cell as string) ?? null,
      scene_group_id: (m.scene_group_id as string) ?? null,
      cell_id: (m.cell_id as string) ?? null,
      seed: Number(m.seed ?? 0),
      enhance_of: (m.enhance_of as string) ?? null,
      ws: String(m.workspace ?? ""),
      preview: { b64: String(m.b64 ?? ""), fmt: String(m.fmt ?? "png") },
      env: (m.env as Record<string, unknown>) ?? null,
      inference: (m.inference as Record<string, unknown>) ?? null,
      save: {
        tab: (m.tab as string) ?? null,
        cell_no: m.cell_no == null ? null : Number(m.cell_no),
        exclude_slot_number: !!m.exclude_slot_number,
      },
    };
    set({ items: [...get().items, take] });
    return take;
  },

  drop(file) {
    set({ items: get().items.filter((x) => x.file !== file) });
  },

  discard(files) {
    const gone = new Set(files);
    const taken = get().items.filter((x) => gone.has(x.file));
    set({ items: get().items.filter((x) => !gone.has(x.file)) });
    return () => {
      // ★그 사이 같은 것이 돌아와 있으면 두 번 넣지 않는다
      const have = new Set(get().items.map((x) => x.file));
      set({ items: [...get().items, ...taken.filter((x) => !have.has(x.file))] });
    };
  },

  star(files, on) {
    const touched = new Set(files);
    const before = new Map(get().items.filter((x) => touched.has(x.file)).map((x) => [x.file, !!x.starred]));
    set({ items: get().items.map((x) => (touched.has(x.file) ? { ...x, starred: on } : x)) });
    return () => set({ items: get().items.map((x) => (before.has(x.file) ? { ...x, starred: before.get(x.file) } : x)) });
  },

  async save(file) {
    const it = get().items.find((x) => x.file === file);
    if (!it) throw new Error(file);
    const r = await api<{ ok: boolean; file: string; record: Rec }>("/api/save-preview", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workspace: it.ws,
        b64: it.preview.b64,
        fmt: it.preview.fmt,
        scene_group: it.scene_group,
        scene_group_id: it.scene_group_id,
        cell: it.cell,
        cell_id: it.cell_id,
        cell_no: it.save.cell_no,
        tab: it.save.tab,
        exclude_slot_number: it.save.exclude_slot_number,
        enhance_of: it.enhance_of,
        seed: it.seed,
        // ★뽑을 때의 구조를 그대로 돌려보낸다 (위 `env` 의 ★주)
        env: it.env ?? null,
        inference: it.inference ?? null,
      }),
    });
    // ★파일이 된 **뒤에** 미리보기를 버린다. 먼저 버리면 저장이 실패했을 때 그림이 사라진다
    get().drop(file);
    return r.record;
  },
}));

/* ── 백엔드 사본 (F5 새로고침용, 위 머리 주석) ─────────────────────────────
   ★스토어가 바뀔 때마다 **달라진 것만** 보낸다. 별표처럼 그림이 그대로면 바이트는 빼고 보낸다.
   ★보내는 순서를 지킨다 — 넣기와 빼기가 엇갈려 도착하면 지운 그림이 되살아난다. */
let mirrored = new Map<string, PreviewTake>();
let chain: Promise<unknown> = Promise.resolve();

usePreviews.subscribe((s) => {
  const now = new Map(s.items.map((x) => [x.file, x]));
  const put: Record<string, unknown>[] = [];
  const drop: string[] = [];
  for (const [f, x] of now) {
    const old = mirrored.get(f);
    if (old === x) continue;
    if (old && old.preview === x.preview) {
      const { preview: _bytes, ...meta } = x;
      put.push(meta);
    } else put.push(x);
  }
  for (const f of mirrored.keys()) if (!now.has(f)) drop.push(f);
  mirrored = now;
  if (!put.length && !drop.length) return;
  const body = JSON.stringify({ put, drop });
  chain = chain
    .then(() => api("/api/previews/sync", { method: "POST", headers: { "Content-Type": "application/json" }, body }))
    .catch(() => {});
});

let restored = false;
/** 부팅 때 한 번 — 백엔드가 들고 있던 미저장 그림을 돌려받는다 (`App.tsx`). 앱을 새로 켰으면 빈 목록이 온다 */
export async function restorePreviews(): Promise<void> {
  if (restored) return;
  restored = true;
  try {
    const r = await api<{ items: PreviewTake[] }>("/api/previews");
    const have = new Set(usePreviews.getState().items.map((x) => x.file));
    const back = (r.items ?? []).filter((x) => !have.has(x.file));
    if (!back.length) return;
    // ★받은 것은 이미 백엔드에 있으므로 다시 보내지 않는다
    for (const x of back) mirrored.set(x.file, x);
    usePreviews.setState({ items: [...back, ...usePreviews.getState().items] });
  } catch {
    /* 못 받아도 앱은 뜬다 — 그때는 예전처럼 비어 있을 뿐이다 */
  }
}

/** 그 미저장 그림 (파일이면 없다) */
export const previewOf = (file: string): PreviewTake | undefined =>
  isPreviewFile(file) ? usePreviews.getState().items.find((x) => x.file === file) : undefined;

/** 미저장 그림을 밖으로 보낼 때 붙이는 이름 — 보관함·보조도구 목록에 이 이름으로 뜬다 */
export const previewName = (p: PreviewTake): string => `${p.cell || "image"}_${p.seed}.${p.preview.fmt}`;

/** ★★보조도구(Tagger·검열·일괄 변환·이미지 편집)로 보낼 한 장 — 파일이면 경로, **미저장이면 데이터**를 싣는다
 *  (사용자 지시 2026-09-30: 저장하지 않고 되는 기능은 다 켠다 · 저장 버튼 말고는 어디서도 저장하지 않는다).
 *  ★받는 쪽은 밖에서 떨군 그림과 같은 갈래로 읽는다 (`Dropped.data`, 서버 `tools._read`). */
export function droppedOf(ws: string, file: string): Dropped {
  const pv = previewOf(file);
  return pv
    ? { name: previewName(pv), data: `data:image/${pv.preview.fmt};base64,${pv.preview.b64}` }
    : { name: file.split("/").pop() ?? file, rel: `${ws}/${file}` };
}

/** 저장된 결과 + 미저장 그림을 **한 목록으로** 만든다.
 *
 *  ★섞는 자리를 여럿 두지 않는다 — 씬 줄과 큰 그림이 같은 목록을 봐야 휠로 넘기는 순서가
 *    줄과 어긋나지 않는다. 묶는 판정 자체는 그대로 `takesOf` 가 한다.
 *  ★미저장은 **뒤에 붙는다** — 방금 나온 것이므로 줄에서는 맨 왼쪽에 선다 (줄은 뒤집는다). */
export function withPreviews(records: Rec[], ws: string, previews: PreviewTake[]): Rec[] {
  if (!previews.length) return records;
  const mine = previews.filter((p) => p.ws === ws);
  return mine.length ? [...records, ...mine] : records;
}
