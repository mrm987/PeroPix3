/** 이미지 편집 — 열어 둔 캔버스를 **재실행 뒤에도** 남긴다 (사용자 지시 2026-09-22).
 *
 *  · 레이어 픽셀 → `PUT /api/edit/px/<캔버스>/<키>` (PNG 한 장씩). 레이어 캔버스는 불변이라(`pixels.ts` 머리)
 *    **한 번 올린 것은 다시 안 올린다** — 캔버스 객체에 키를 매어 둔다 (`keyOf`·`uploaded`).
 *  · 나머지(이름·크기·레이어 메타·원본 자리·고른 것·보기) → `PUT /api/edit/state` (통째로, 작다).
 *  · `keep` 에 지금 쓰는 키(현재 레이어 + 이력이 든 것)를 적어 보내면 서버가 나머지 픽셀을 지운다 —
 *    이력이 20걸음이라 디스크도 그 언저리에서 멈춘다. 닫힌 캔버스의 폴더는 서버가 휴지통으로 보낸다.
 *  · 이력은 남기지 않는다. 바뀔 때마다 1초 뒤 한 번 적으므로 **마지막 1초 안의 편집은 잃을 수 있다.**
 *  ★★켜서 다 읽기 전에는 적지 않는다 (`store.ts` 의 `hydrated`) — 빈 상태로 덮어쓰면 남긴 것이 전부 휴지통으로 간다. */
import { emptyHist, type LayerMeta } from "./model";
import { getPx, loadState, putPx, putState, type PersistDoc } from "./io";
import type { Layer } from "./pixels";
import type { Doc } from "./store";

const keyOf = new WeakMap<HTMLCanvasElement, string>();
const uploaded = new WeakSet<HTMLCanvasElement>();
let seq = 0;
const newKey = () => `p${Date.now().toString(36)}${(seq++).toString(36)}`;

const metaOf = (l: Layer): LayerMeta => {
  const { cv: _cv, ...meta } = l;
  void _cv;
  return meta;
};

const blobOf = (cv: HTMLCanvasElement) =>
  new Promise<Blob>((ok, no) => cv.toBlob((b) => (b ? ok(b) : no(new Error("toBlob"))), "image/png"));

type Snapshot = () => { docs: Doc[]; cur: string | null };

let timer = 0;
let running = false;
let again = false;

/** 바뀌었다 — 1초 뒤 한 번 적는다 (그 사이 또 바뀌면 그때부터 다시 1초) */
export function scheduleFlush(get: Snapshot): void {
  if (timer) clearTimeout(timer);
  timer = window.setTimeout(() => {
    timer = 0;
    void flush(get);
  }, 1000);
}

async function flush(get: Snapshot): Promise<void> {
  if (running) {
    again = true;
    return;
  }
  running = true;
  try {
    const { docs, cur } = get();
    const keep: Record<string, string[]> = {};
    const out: PersistDoc[] = [];
    for (const d of docs) {
      const keys = new Set<string>();
      const layers = [];
      for (const l of d.layers) {
        let k = keyOf.get(l.cv);
        if (!k) {
          k = newKey();
          keyOf.set(l.cv, k);
        }
        // ★픽셀을 먼저, 상태는 나중에 — 상태가 없는 파일을 가리키는 순간이 없게
        if (!uploaded.has(l.cv)) {
          await putPx(d.id, k, await blobOf(l.cv));
          uploaded.add(l.cv);
        }
        keys.add(k);
        layers.push({ ...metaOf(l), px: k });
      }
      for (const snap of [...d.hist.past, ...d.hist.future]) {
        for (const l of snap.layers) {
          const k = keyOf.get(l.cv);
          if (k) keys.add(k);
        }
      }
      keep[d.id] = [...keys];
      out.push({ id: d.id, name: d.name, w: d.w, h: d.h, sel: d.sel, src: d.src, dirty: d.dirty, view: d.view, layers });
    }
    await putState({ docs: out, cur, keep });
  } catch (e) {
    console.warn("[editor] 캔버스를 남기지 못했다", e);
  } finally {
    running = false;
    if (again) {
      again = false;
      scheduleFlush(get);
    }
  }
}

/** 켤 때 — 남겨 둔 캔버스를 되살린다. 픽셀을 못 읽은 레이어는 빼고 연다 (통째로 잃지 않게) */
export async function loadDocs(): Promise<{ docs: Doc[]; cur: string | null }> {
  const st = await loadState();
  const docs: Doc[] = [];
  for (const p of st.docs ?? []) {
    const layers: Layer[] = [];
    for (const l of p.layers ?? []) {
      try {
        const cv = await getPx(p.id, l.px);
        const { px: _px, ...meta } = l;
        void _px;
        keyOf.set(cv, l.px);
        uploaded.add(cv);
        layers.push({ ...meta, cv });
      } catch (e) {
        console.warn(`[editor] 레이어 픽셀을 못 읽었다 (${p.name} / ${l.name})`, e);
      }
    }
    docs.push({
      id: p.id, name: p.name, w: p.w, h: p.h, layers,
      sel: layers.some((l) => l.id === p.sel) ? p.sel : (layers[layers.length - 1]?.id ?? null),
      src: p.src ?? null, hist: emptyHist(), dirty: !!p.dirty, view: p.view ?? { fit: true, zoom: 1 },
    });
  }
  return { docs, cur: st.cur ?? null };
}
