/** 만화 캔버스 — **컷 생성** (설계 `docs/comic-editor-design.md` 8번 · 목업 v2).
 *
 *  ★★컷 하나가 곧 씬 하나다. 생성 흐름을 새로 만들지 않고 **지금 것을 지난다**: 큐(`useQueue.enqueue`) · 시드 규칙(`rounds`) ·
 *    와일드카드(`resolveShot`) · 요금(`anlasCost`) · 계정(`currentAccountId`). 생성 창구(`store/gen.generateAll`)와 같은 조립이다.
 *  · 무엇으로 (설계 8-2): 베이스 = 공통의 화풍 + 그 컷이 고른 배경 + 컷 태그. 캐릭터 프롬프트 = 인물은 공통의 외형 + 그 컷의 칩,
 *    내레이션 · 말풍선은 그 칸에 적은 것 그대로. UC 는 공통의 것.
 *  · 생성 옵션과 참조 그림(Vibe · Precise Reference)은 **캔버스의 것**이다 (사용자 결정 2026-09-28: 캔버스마다 따로. `cutParams` · `useComicInput`).
 *  · 크기: 컷 비율에 맞춘 64 배수, 기본은 Opus 무료 한도 안 (`comic.cutSize`).
 *  · 저장: 워크스페이스에 보통 생성물처럼 — 탭 「만화 편집」 · 씬 그룹 = 캔버스 이름 · 씬 = 「p.01 컷 N」. 캔버스 밖에도 남아 갤러리·파일에서 찾는다.
 *  · 넣기: 큐가 그림을 받으면(`imageTaps`) 씬 그룹 id(`comic_<캔버스>`)와 칸 id(= 컷 레이어 id)로 그 컷을 찾아 넣는다 (`placeTake`).
 *  ★그림이 생기는 자리라 `env`(화면 구조)를 남긴다 (데스크 지침 「그림이 생기는 모든 자리가 구조를 남겨야 한다」). */
import { t } from "../i18n";
import { anlasCost } from "../lib/anlas";
import { compileBlocks } from "../lib/blocks";
import { randomSeed, rounds } from "../lib/seedRounds";
import { resolveShot } from "../lib/wildcards";
import { currentAccountId } from "../store/accounts";
import { useGen, type GenParams } from "../store/gen";
import { CHAR_COLOR, DEFAULT_STYLE_COLOR, type Char } from "../store/prompt";
import { imageTaps, useQueue } from "../store/queue";
import { useSub } from "../store/sub";
import { toast } from "../store/toast";
import { wildcardPools } from "../store/wildcards";
import { useWs } from "../store/workspace";
import {
  bboxOf, castCenter, comicGroupId, comicTiers, cutSize, docOfGroup, genOf, pageLabel, pageOfLayer, panelNumbers, panelPts,
  WHO_BUBBLE, WHO_NARRATION, type CutCast, type CutTake,
} from "./comic";
import { loadItem } from "./io";
import { composite, makeCanvas, type Layer } from "./pixels";
import { makeImageInput, useImageInput, type ImageSnap } from "../store/imageInput";
import { pageView, useEditor, type Doc } from "./store";

/** 컷을 뽑는 생성 옵션. 캔버스가 드는 것(`Doc.gen`, 열쇠는 `comic.COMIC_GEN_KEYS`)은 캔버스 것이고,
 *  나머지(저장 옵션)는 생성 모드 것이다. 해상도는 항목마다 컷 크기로 덮는다 */
export const cutParams = (doc: Doc, gen: GenParams = useGen.getState().params): GenParams => ({ ...gen, ...doc.gen });

/** 만화 캔버스의 참조 그림 한 벌. **지금 캔버스의 것**이 들어 있다 (생성 버튼은 지금 캔버스만 누를 수 있다).
 *  ★캔버스를 옮기면 떠나는 캔버스의 것을 담고 새 캔버스의 것으로 갈아 끼운다. 생성 모드의 탭과 같은 규칙이다 (`store/gen` 의 `tabImages`):
 *    그림 바이트라 파일에 안 적고 메모리에만 둔다. 앱을 다시 켜면 비어 있다 */
export const useComicInput = makeImageInput(() => {
  const s = useEditor.getState();
  const d = s.docs.find((x) => x.id === s.cur);
  return (d ? cutParams(d) : useGen.getState().params).model;
});
const canvasImages = new Map<string, ImageSnap>();
/** 지금 `useComicInput` 에 든 캔버스 (만화 캔버스가 아니면 null) */
let shown: string | null = null;
function syncComicInput() {
  const s = useEditor.getState();
  const id = s.docs.some((d) => d.id === s.cur && d.comic) ? s.cur : null;
  if (id === shown) return;
  if (shown) canvasImages.set(shown, useComicInput.getState().snapshot());
  shown = id;
  // 닫힌 캔버스가 담아 둔 것은 버린다
  for (const k of [...canvasImages.keys()]) if (!s.docs.some((d) => d.id === k)) canvasImages.delete(k);
  useComicInput.getState().load(id ? (canvasImages.get(id) ?? null) : null);
}
useEditor.subscribe(syncComicInput);
syncComicInput();

/** 그 캔버스의 참조 그림 한 벌 (지금 캔버스가 아니면 없다) */
const inputOf = (doc: Doc) => (doc.id === shown ? useComicInput.getState() : null);

/** 컷의 생성 크기 — 컷 상자 비율 (`cutSize`) */
export const sizeOf = (p: Layer) => cutSize(bboxOf(panelPts(p, p.panel!.pts)), !!p.panel!.gen?.big);

/** 그 컷들을 `count` 장씩 뽑을 때의 값 — 컷마다 크기가 달라 컷마다 세어 더한다. `free` 는 전부 무료일 때만.
 *  `inpaint` 면 컷 인페인트다 (마스크가 실리므로 공홈처럼 바이브 값을 안 센다: `lib/anlas`) */
export function cutCost(doc: Doc, panels: Layer[], count: number, strength = 1, inpaint = false) {
  const params = cutParams(doc);
  const sub = useSub.getState().current();
  const opus = (sub?.tier ?? 0) >= 3;
  const usage = opus ? (sub?.usage ?? null) : null;
  // ★거르는 규칙은 `riding` 하나다 (모델 능력 · 묶음 스위치 · 낱장 스위치). 생성 모드의 `lib/costNow` 와 같다
  const ride = inputOf(doc)?.riding() ?? { vibes: [], refs: [] };
  let total = 0;
  let free = true;
  let overLimit = false;
  for (const p of panels) {
    const s = sizeOf(p);
    const c = anlasCost({
      model: params.model, width: s.w, height: s.h, steps: params.steps, opus, opusExhausted: !!usage?.isNegative,
      uncachedVibes: ride.vibes.filter((v) => !v.encoded).length, activeVibes: ride.vibes.length, refCount: ride.refs.length,
      inpaint, strength, count,
    });
    total += c.total;
    free &&= c.free;
    overLimit ||= c.overLimit;
  }
  return { total, free, overLimit };
}

/** 컷의 이름과 번호 — 「p.01 컷 2」 (큐의 씬 이름 · 후보 줄 머리). 번호는 그 페이지 안의 읽는 차례 */
export function cutName(doc: Doc, p: Layer): { name: string; n: number; page: number } {
  const pages = doc.comic?.pages ?? [];
  const pid = pageOfLayer(p, pages);
  const page = Math.max(0, pages.indexOf(pid));
  const n = doc.comic ? (panelNumbers(pageView(doc, pid).layers, doc.comic.dir, doc.h).get(p.id) ?? 0) : 0;
  return { name: t("editor.cutName", { p: pageLabel(page), n }), n, page };
}

/** 그 칸의 이름 — 캐릭터 카드 이름 · 「내레이션」 · 「말풍선」 (카드가 없어졌으면 null) */
export function whoName(doc: Doc, c: CutCast): string | null {
  if (c.who === WHO_NARRATION) return t("editor.narration");
  if (c.who === WHO_BUBBLE) return t("editor.speechBubble");
  const i = doc.comic?.common.chars.findIndex((x) => x.id === c.who) ?? -1;
  if (i < 0) return null;
  return doc.comic!.common.chars[i].name || t("cards.charN", { n: i + 1 });
}

/** 컷 하나의 프롬프트 (설계 8-2) — 베이스 = 화풍 + 배경 + 컷 태그 · 캐릭터마다 = 외형 + 그 컷의 칩 (내레이션·말풍선은 칩 그대로) · UC 는 공통.
 *  ★캐릭터 카드가 없어진 칸은 빠진다 (그 칸의 칩만 떠돌게 두지 않는다). 빈 칸도 빠진다 */
export function cutPrompt(doc: Doc, p: Layer) {
  const c = doc.comic!.common;
  const g = genOf(p.panel);
  const bg = g.bg ? c.bgs.find((b) => b.id === g.bg) : undefined;
  const prompt = [compileBlocks(c.base), bg ? compileBlocks([{ ...bg, on: true }]) : "", compileBlocks(g.blocks)].filter(Boolean).join(", ");
  const chars = g.cast
    .map((x) => {
      const own = compileBlocks(x.blocks);
      if (x.who === WHO_NARRATION || x.who === WHO_BUBBLE) return own ? { key: x.key, prompt: own, uc: "", center: castCenter(x) } : null;
      const ch = c.chars.find((k) => k.id === x.who);
      if (!ch) return null;
      const look = compileBlocks(ch.prompt);
      const text = [look, own].filter(Boolean).join(", ");
      return text ? { key: x.key, prompt: text, uc: compileBlocks(ch.uc), center: castCenter(x) } : null;
    })
    .filter((x): x is NonNullable<typeof x> => !!x);
  return { prompt, uc: compileBlocks(c.uc), chars };
}

/** 그 컷의 화면 구조 — 「설정 불러오기」·「새 탭으로 복제」가 되살리는 `env.prompt` (생성 모드의 탭 프롬프트 모양).
 *  베이스는 화풍 블록 + 배경 블록, 캐릭터 카드는 **이 컷의 칸마다 하나**(외형 블록 + 그 컷의 칩 블록, 자리는 컷 안 자리) */
function envPrompt(doc: Doc, p: Layer) {
  const c = doc.comic!.common;
  const g = genOf(p.panel);
  const bg = g.bg ? c.bgs.find((b) => b.id === g.bg) : undefined;
  const chars: Char[] = g.cast
    .map((x): Char | null => {
      const name = whoName(doc, x);
      if (name === null) return null;
      const ch = c.chars.find((k) => k.id === x.who);
      return {
        id: x.key, ref: ch?.ref ?? null, name, color: CHAR_COLOR, thumb: ch?.thumb ?? null,
        prompt: [...(ch?.prompt ?? []), ...x.blocks], uc: ch?.uc ?? [], on: true, center: castCenter(x),
      };
    })
    .filter((x): x is Char => !!x);
  return {
    base: [...c.base, ...(bg ? [{ ...bg, on: true }] : [])],
    baseUc: c.uc,
    style: { ref: c.style.ref, name: c.style.name, color: DEFAULT_STYLE_COLOR, thumb: c.style.thumb },
    styleOn: true,
    chars,
    seqChars: false,
  };
}

/** 컷들을 큐에 넣는다 — 한 바퀴에 컷 전부, 그것을 `count` 번 (시드 규칙은 생성 창구와 같다).
 *  `extra` 는 컷마다 항목에 얹을 값 (컷 인페인트의 베이스 그림·마스크) */
export async function generateCuts(doc: Doc, ids: string[], count: number, extra?: (p: Layer) => Record<string, unknown>): Promise<void> {
  const ws = useWs.getState().current;
  if (!ws) { toast(t("editor.cutNoWs"), "warn"); return; }
  if (!doc.comic) return;
  const panels = ids.map((id) => doc.layers.find((l) => l.id === id && l.panel)).filter((l): l is Layer => !!l);
  if (!panels.length) return;
  const params = cutParams(doc);
  const shots = new Map(panels.map((p) => [p.id, cutPrompt(doc, p)]));
  // 프롬프트가 통째로 비면 NAI 가 거절한다 — 누르기 전에 막는다
  if (panels.every((p) => { const s = shots.get(p.id)!; return !s.prompt.trim() && !s.chars.length; })) { toast(t("editor.cutEmpty"), "warn"); return; }
  const pools = wildcardPools();
  const items = rounds(Math.max(1, count), params, panels, (p, seed) => ({ ...itemOf(p, seed), ...(extra?.(p) ?? {}) }));
  function itemOf(p: Layer, seed: number) {
    const g = genOf(p.panel);
    const size = sizeOf(p);
    const nm = cutName(doc, p);
    const raw = shots.get(p.id)!;
    const shot = resolveShot(pools, { prompt: raw.prompt, uc: raw.uc, chars: raw.chars.map((c) => ({ id: c.key, prompt: c.prompt, uc: c.uc, center: c.center })) });
    return {
      cell: nm.name,
      cell_id: p.id,
      cell_no: nm.n,
      seed,
      width: size.w,
      height: size.h,
      prompt: shot.prompt,
      negative_prompt: shot.uc,
      // ★컷 안 자리는 곧 그림 안 자리다 (그림이 컷 비율이다) — 좌표를 언제나 쓴다
      characters: shot.chars.map((c) => ({ ...c, use_coord: true })),
      // ★★이 장을 뽑은 화면 구조 — 생성 창구의 `env` 와 같은 모양에 컷 자리를 더한다 (「설정 불러오기」가 그대로 되살린다)
      env: {
        prompt: envPrompt(doc, p),
        cell: { name: nm.name, blocks: g.blocks },
        comic: { doc: doc.id, panel: p.id },
      },
    };
  }
  await useQueue.getState().enqueue(
    {
      ...params,
      ...refPayload(doc),
      workspace: ws,
      account: currentAccountId(),
      tab: t("editor.comicTab"),
      scene_group: doc.name,
      scene_group_id: comicGroupId(doc.id),
      negative_prompt: compileBlocks(doc.comic.common.uc),
      characters: [],
    },
    items,
    1,
  );
  if (params.seed_mode !== "fixed") useEditor.getState().setComicGen(doc.id, "seed", randomSeed());
}

/** 그 캔버스의 참조 그림 조각 (Vibe · Precise Reference). 싣는 것은 `payload` 가 정한다. 베이스 그림 칸은 안 싣는다 (컷 인페인트가 항목마다 싣는다) */
export function refPayload(doc: Doc): Record<string, unknown> {
  const p = inputOf(doc)?.payload();
  return { vibe_transfer: p?.vibe_transfer ?? [], precise_references: p?.precise_references ?? [], normalize_reference_strength: p?.normalize_reference_strength ?? true };
}

/** 컷 인페인트의 베이스 — 그 컷 상자를 잘라 생성 크기로 (말풍선·효과음·컷 테두리는 뺀다) + **컷 모양 마스크**(사각이 아니다, 설계 8번).
 *  ★컷에 든 그림은 컷 모양으로 잘려 합성되므로 컷 레이어는 끈 채로 목록에 둔다 (`clipOf` 가 그 모양을 찾는다)
 *  ★싣는 것은 **그 페이지의** 그 밖 묶음과 컷 묶음뿐이다 (`comicTiers`). 컷 위·말풍선 위에 둔 레이어(래스터화한 말풍선 포함)는 말풍선처럼 뺀다.
 *    컷의 그리기 레이어는 그 컷에 든 것이라 실린다 — 대충 그려 두고 인페인트로 보내는 밑그림이다 */
export function cutBase(doc: Doc, p: Layer): { image: string; mask: string } {
  const size = sizeOf(p);
  const poly = panelPts(p, p.panel!.pts);
  const b = bboxOf(poly);
  const pg = doc.comic ? pageView(doc, pageOfLayer(p, doc.comic.pages)) : doc;
  const full = makeCanvas(doc.w, doc.h);
  const tiers = comicTiers(pg.layers);
  const cuts = new Set(pg.layers.filter((l) => l.panel).map((l) => l.id));
  const under = (l: Layer) => tiers.get(l.id) === "base" || !!l.panel || (!l.bubble && !l.sfx && !!l.clip && cuts.has(l.clip));
  composite({ w: doc.w, h: doc.h, layers: pg.layers.filter(under).map((l) => (l.panel ? { ...l, on: false } : l)) }, full, 1);
  const img = makeCanvas(size.w, size.h);
  const g = img.getContext("2d")!;
  g.fillStyle = "#ffffff";
  g.fillRect(0, 0, size.w, size.h);
  g.imageSmoothingQuality = "high";
  g.drawImage(full, b.x, b.y, b.w, b.h, 0, 0, size.w, size.h);
  const mask = makeCanvas(size.w, size.h);
  const m = mask.getContext("2d")!;
  m.fillStyle = "#000000";
  m.fillRect(0, 0, size.w, size.h);
  m.fillStyle = "#ffffff";
  m.beginPath();
  poly.forEach(([x, y], i) => {
    const px = ((x - b.x) / Math.max(1, b.w)) * size.w;
    const py = ((y - b.y) / Math.max(1, b.h)) * size.h;
    if (i) m.lineTo(px, py);
    else m.moveTo(px, py);
  });
  m.closePath();
  m.fill();
  return { image: img.toDataURL("image/png").split(",")[1], mask: mask.toDataURL("image/png").split(",")[1] };
}

/** 컷만 인페인트한다 — 지금 그 컷에 보이는 것을 베이스로, 컷 모양 안만 다시 그린다. 결과는 그 컷의 새 후보로 돌아온다 */
export async function inpaintCuts(doc: Doc, ids: string[], count: number): Promise<void> {
  const extras = new Map<string, Record<string, unknown>>();
  const strength = useImageInput.getState().baseInpaintStrength ?? 1;
  for (const id of ids) {
    const p = doc.layers.find((l) => l.id === id && l.panel);
    if (!p) continue;
    const { image, mask } = cutBase(doc, p);
    extras.set(id, { base_image: image, base_mode: "inpaint", base_mask: mask, base_inpaint_strength: strength, base_noise: 0 });
  }
  await generateCuts(doc, [...extras.keys()], count, (p) => extras.get(p.id) ?? {});
}

/** 컷 강화의 결과가 돌아올 자리 — 그 캔버스의 그 컷 (강화 창 `EnhanceDialog` 의 `route`) */
export function cutRoute(doc: Doc, p: Layer): Record<string, unknown> {
  const nm = cutName(doc, p);
  return { tab: t("editor.comicTab"), scene_group: doc.name, scene_group_id: comicGroupId(doc.id), cell: nm.name, cell_id: p.id, cell_no: nm.n };
}

/** 빈 컷 — 그림도 없고 대기도 없는 컷 (「빈 컷 전부 생성」이 도는 것). ★그리기 레이어만 든 컷도 빈 컷이다 (밑그림은 그림이 아니다) */
export function emptyCuts(doc: Doc, pending: { groupId?: string | null; cellId?: string | null }[]): Layer[] {
  const group = comicGroupId(doc.id);
  return doc.layers.filter(
    (l) => l.panel && l.on && !doc.layers.some((x) => x.clip === l.id && !x.draw) && !pending.some((q) => q.groupId === group && q.cellId === l.id),
  );
}

/** 큐가 받은 그림 — 만화 캔버스의 컷이면 그 컷에 넣는다. 저장된 그림은 후보로도 남는다 (파일이라 지워지지 않는다) */
async function onCutImage(m: Record<string, unknown>) {
  const docId = docOfGroup(m.scene_group_id as string | null);
  if (!docId) return;
  const st = useEditor.getState();
  const d = st.docs.find((x) => x.id === docId);
  const panelId = String(m.cell_id ?? "");
  if (!d?.layers.some((l) => l.id === panelId && l.panel)) return;
  const file = m.file ? String(m.file) : null;
  const ws = String(m.workspace ?? useWs.getState().current ?? "");
  const name = (file ?? String(m.cell ?? "cut")).split("/").pop()!;
  try {
    const { cv } = await loadItem(file ? { name, rel: `${ws}/${file}` } : { name, data: String(m.b64 ?? "") });
    const take: CutTake | null = file ? { ws, file } : null;
    useEditor.getState().placeTake(docId, panelId, take, cv, name.replace(/\.[^.]+$/, ""));
  } catch (e) {
    toast(t("editor.cutLoadFail", { e: String(e) }), "warn");
  }
}
imageTaps.add((m) => void onCutImage(m));

/** 후보를 누르면 그 그림으로 바꾼다 (한 걸음) */
export async function pickTake(docId: string, panelId: string, take: CutTake): Promise<void> {
  const name = take.file.split("/").pop()!;
  try {
    const { cv } = await loadItem({ name, rel: `${take.ws}/${take.file}` });
    useEditor.getState().placeTake(docId, panelId, take, cv, name.replace(/\.[^.]+$/, ""));
  } catch (e) {
    toast(t("editor.cutLoadFail", { e: String(e) }), "warn");
  }
}
