/** 씬 프롬프트의 **줄** — 씬 하나가 프롬프트를 여러 곳에 나눠 넣는다 (사용자 결정 2026-11-11, 시안 `docs/scene-lines-mockup3.html`).
 *
 *  ★★줄 구성은 **카드가 정한다** (`SceneCard.dest`·`SceneCard.lines`). 카드의 씬 전부가 같은 줄을 갖고,
 *    씬은 줄마다 블록만 든다 (첫 줄은 `Slot.blocks`, 나머지는 `Slot.lineBlocks[줄 id]`). 화면은 표다 (씬 = 행, 줄 = 열).
 *    예: 「캐릭터 1은 여성, 2는 남성」인 씬 세트에서 씬마다 베이스 · 캐릭터 1 · 캐릭터 2 에 따로 지시한다.
 *    처음(2026-11-10)에는 씬마다 줄을 따로 들었는데, 씬마다 넣을 곳을 고르는 UI 가 복잡하고 자리를 많이 쓴다는 지적으로 바꿨다.
 *  ★넣을 곳은 셋이다. 베이스(`"base"`) · 캐릭터 번호(`"#1"` …, **탭의 켜진 캐릭터 차례**, 순차 생성이어도 같다) · 캐릭터 전원(`"all"`).
 *    캐릭터를 id 가 아니라 번호로 가리키는 것은 덱에 저장한 씬 카드를 다른 탭에 얹어도 맞게 하려는 것이다.
 *    옛 씬 그룹의 `sceneDest`(캐릭터 id)는 열 때 카드의 첫 줄로 옮긴다 (`legacyDest`).
 *  ★가리킨 캐릭터가 탭에 없으면 첫 줄은 **베이스로 떨어지고**(조용히 사라지지 않게, 옛 규칙 그대로) 나머지 줄은 **안 들어간다**.
 *  ★씬 하나를 「카드의 줄 + 그 씬의 블록」으로 합친 모양이 `LinedCell` 이다 (`joinCell`). 생성 · 그림의 `env.cell` · 조수의 보기가 이 모양을 쓴다.
 *  ★순수 계산만 둔다 — 생성(`store/gen` 의 `queueGroup`)과 화면(`panels/SceneCells`)이 같은 판정을 쓴다. */
import { compileBlocks, type Block } from "./blocks.ts";

/** 카드의 줄 하나 (첫 줄 뒤의 것) — 넣을 곳만 든다. 블록은 씬이 든다 */
export type LineDef = { id: string; dest: string };
/** 카드의 줄 구성 — 첫 줄의 넣을 곳(없으면 베이스)과 그 뒤의 줄들 */
export type LineSet = { dest?: string; lines?: LineDef[] };
/** 씬이 든 것 — 첫 줄의 블록과 줄마다의 블록 */
export type CellBlocks = { blocks?: Block[]; lineBlocks?: Record<string, Block[]> };

/** 줄 하나를 합친 모양 — 넣을 곳과 그 씬의 블록 */
export type SceneLine = { id: string; dest: string; blocks: Block[] };
/** 씬 하나를 합친 모양 — 첫 줄(`blocks`·`dest`)과 그 뒤의 줄들. 그림의 `env.cell` 이 이 모양이다 */
export type LinedCell = { blocks?: Block[]; dest?: string; lines?: SceneLine[] };

/** 캐릭터 번호 (1부터). 번호가 아니면 0 */
export const destIndex = (dest: string | undefined): number => {
  const m = /^#(\d+)$/.exec(dest ?? "");
  return m ? Number(m[1]) : 0;
};

/** 그 줄이 **누구에게** 가나 — 탭의 켜진 캐릭터 중 자리 목록(0부터) · `"base"` · `null`(안 들어감).
 *  ★번호는 **탭의 켜진 캐릭터 차례**다. 순차 생성이어도 그 장 안에서 다시 세지 않는다 (사용자 결정 2026-11-11):
 *    1=여성 · 2=남성으로 나눠 적었으면 남성 그림에는 「캐릭터 2」 줄만 들어가야 한다.
 *  ★「전원」은 켜진 사람이 한 명이어도 그 사람이다.
 *  @param n 탭의 켜진 캐릭터 수
 *  @param main 첫 줄인가 — 가리킨 사람이 탭에 없으면 베이스로 떨어진다 */
export function lineTarget(dest: string | undefined, n: number, main: boolean): "base" | number[] | null {
  if (!dest || dest === "base") return "base";
  if (dest === "all" && n > 0) return Array.from({ length: n }, (_, i) => i);
  const k = destIndex(dest);
  if (k >= 1 && k <= n) return [k - 1];
  return main ? "base" : null;
}

/** 카드의 줄 전부 — 첫 줄(id `""`)이 맨 앞이다 */
export const columnsOf = (set: LineSet): LineDef[] => [{ id: "", dest: set.dest ?? "base" }, ...(set.lines ?? [])];

/** 그 씬의 그 줄 블록 — 첫 줄은 `blocks` */
export const blocksAt = (cell: CellBlocks, id: string): Block[] => (id ? (cell.lineBlocks?.[id] ?? []) : (cell.blocks ?? []));

/** 카드의 줄과 씬의 블록을 합친다 — 생성 · `env.cell` · 조수의 보기가 이 모양을 쓴다 */
export function joinCell(set: LineSet, cell: CellBlocks): LinedCell {
  const out: LinedCell = { blocks: cell.blocks ?? [] };
  if (set.dest && set.dest !== "base") out.dest = set.dest;
  if (set.lines?.length) out.lines = set.lines.map((l) => ({ id: l.id, dest: l.dest, blocks: cell.lineBlocks?.[l.id] ?? [] }));
  return out;
}

/** 합친 모양의 씬들을 카드의 줄과 씬의 블록으로 가른다 — 옛 모양(씬마다 줄을 들던 것)·덱 카드·그림의 `env.cell` 을 읽을 때.
 *  ★첫 줄의 넣을 곳은 첫 씬의 것이다. 넣을 곳이 같은 줄은 한 줄로 모은다 (줄 id 는 처음 본 것을 쓴다).
 *  ★한 씬에 같은 넣을 곳이 둘이면 블록을 이어 붙인다 — 아무것도 버리지 않는다. */
export function splitCells<C extends LinedCell>(cells: C[]): { set: LineSet; cells: (Omit<C, "dest" | "lines"> & CellBlocks)[] } {
  const main = cells[0]?.dest ?? "base";
  const lines: LineDef[] = [];
  const idOf = (dest: string, prefer?: string): string => {
    const hit = lines.find((l) => l.dest === dest);
    if (hit) return hit.id;
    const id = prefer && !lines.some((l) => l.id === prefer) ? prefer : newLineId();
    lines.push({ id, dest });
    return id;
  };
  const out = cells.map((c) => {
    const { dest: _d, lines: _l, ...rest } = c;
    let blocks: Block[] = [];
    const lb: Record<string, Block[]> = {};
    for (const [i, l] of linesOf(c).entries()) {
      if (l.dest === main) blocks = [...blocks, ...l.blocks];
      else {
        const id = idOf(l.dest, i ? c.lines?.[i - 1]?.id : undefined);
        lb[id] = [...(lb[id] ?? []), ...l.blocks];
      }
    }
    return { ...rest, blocks, ...(Object.keys(lb).length ? { lineBlocks: lb } : null) };
  });
  const set: LineSet = {};
  if (main !== "base") set.dest = main;
  if (lines.length) set.lines = lines;
  return { set, cells: out };
}

/** 씬의 줄을 전부 (합친 모양) — 첫 줄(씬의 블록)이 맨 앞이다 */
export const linesOf = (c: LinedCell): { dest: string; blocks: Block[]; main: boolean }[] => [
  { dest: c.dest ?? "base", blocks: c.blocks ?? [], main: true },
  ...(c.lines ?? []).map((l) => ({ dest: l.dest, blocks: l.blocks, main: false })),
];

/** 씬 하나를 그 장의 프롬프트에 나눠 넣는다 — 베이스는 탭의 베이스 뒤에, 캐릭터는 그 사람의 프롬프트 뒤에 줄 차례대로.
 *  @param chars 그 장에 실리는 캐릭터
 *  @param all 탭의 켜진 캐릭터 전부 (번호를 세는 기준). 순차 생성은 한 장에 한 명만 실리므로 따로 넘긴다.
 *    ★자리는 **같은 객체인지**로 찾는다 — `chars` 는 `all` 에서 고른 것이어야 한다.
 *  ★가리킨 사람이 탭에는 있는데 이 장에 없으면(순차 생성의 다른 사람 그림) 그 줄은 이 장에 안 들어간다. 첫 줄이어도 베이스로 떨어지지 않는다. */
export function placeScene<C extends { prompt: string }>(
  cell: LinedCell, prompt: string, chars: C[], all: C[] = chars,
): { prompt: string; chars: C[] } {
  const base: string[] = [prompt];
  const per: string[][] = chars.map((ch) => [ch.prompt]);
  for (const l of linesOf(cell)) {
    const text = compileBlocks(l.blocks);
    if (!text) continue;
    const to = lineTarget(l.dest, all.length, l.main);
    if (to === "base") base.push(text);
    else if (to)
      for (const k of to) {
        const i = chars.indexOf(all[k]);
        if (i >= 0) per[i].push(text);
      }
  }
  // ★앞 조각이 이미 쉼표로 끝나면 쉼표를 또 붙이지 않는다 — `compileBlocks` 와 같은 규칙 (원문 그대로 내는 블록은 `girl,` 로 끝날 수 있다)
  const join = (xs: string[]) =>
    xs.filter(Boolean).reduce((acc, part) => (acc ? acc + (/,\s*$/.test(acc) ? " " : ", ") + part : part), "");
  return {
    prompt: join(base),
    // ★안 붙은 사람은 그대로 둔다 (같은 객체) — 붙은 사람만 새 프롬프트를 갖는다
    chars: chars.map((ch, i) => (per[i].length > 1 ? { ...ch, prompt: join(per[i]) } : ch)),
  };
}

/** 옛 씬 그룹의 `sceneDest` 를 줄의 넣을 곳으로 — 캐릭터 id 는 **켜진 캐릭터 중 차례**로.
 *  ★그 캐릭터가 꺼졌거나 없으면 베이스다 (그때도 생성은 베이스로 넣고 있었다) */
export function legacyDest(dest: string | undefined, chars: { id: string; on?: boolean }[]): string {
  if (!dest || dest === "base" || dest === "all") return dest ?? "base";
  if (destIndex(dest)) return dest;
  const k = chars.filter((c) => c.on).findIndex((c) => c.id === dest);
  return k >= 0 ? `#${k + 1}` : "base";
}

/** 줄을 더할 때 고를 수 있는 넣을 곳 — 카드에서 아직 안 쓴 것. 캐릭터 번호는 켜진 캐릭터 수까지(적어도 둘) */
export function freeDests(set: LineSet, n: number): string[] {
  const used = new Set(columnsOf(set).map((l) => l.dest));
  const all = ["base", ...Array.from({ length: Math.max(2, n) }, (_, i) => `#${i + 1}`), "all"];
  return all.filter((d) => !used.has(d));
}

/** 줄 id — 카드 안에서만 유일하면 된다 (블록 목록 자리 이름이 씬 id 를 함께 든다) */
export const newLineId = () => "ln_" + Math.random().toString(36).slice(2, 8);

/** 줄의 블록 목록 자리 이름 — 첫 줄은 씬의 자리 그대로(`scene-<id>`), 나머지는 그 뒤에 줄 id */
export const lineZone = (zone: string, lineId: string) => (lineId ? `${zone}~${lineId}` : zone);

/** 카드에 줄을 더한다 */
export const addLineDef = (set: LineSet, dest: string): LineDef[] => [...(set.lines ?? []), { id: newLineId(), dest }];

/** 카드에서 줄을 뺀다 — 그 줄의 블록도 씬마다 뺀다 */
export function dropLineDef<C extends CellBlocks>(set: LineSet, cells: C[], id: string): { lines: LineDef[] | undefined; cells: C[] } {
  const lines = (set.lines ?? []).filter((l) => l.id !== id);
  return {
    lines: lines.length ? lines : undefined,
    cells: cells.map((c) => {
      if (!c.lineBlocks || !(id in c.lineBlocks)) return c;
      const { [id]: _drop, ...rest } = c.lineBlocks;
      return { ...c, lineBlocks: Object.keys(rest).length ? rest : undefined };
    }),
  };
}

/** 다른 카드의 씬을 이 카드로 들인다 (씬을 카드 사이로 옮길 때). 줄은 **넣을 곳으로** 맞춘다.
 *  ★블록이 든 줄의 넣을 곳이 이 카드에 없으면 그 줄을 카드에 더한다 — 옮겼다고 프롬프트가 조용히 사라지면 안 된다. */
export function adoptCell(set: LineSet, cell: LinedCell): { set: LineSet; cell: CellBlocks } {
  const cols = columnsOf(set);
  const lines = [...(set.lines ?? [])];
  let blocks: Block[] = [];
  const lb: Record<string, Block[]> = {};
  for (const l of linesOf(cell)) {
    let col = cols.find((c) => c.dest === l.dest) ?? lines.find((c) => c.dest === l.dest);
    if (!col) {
      if (!l.blocks.length) continue;
      col = { id: newLineId(), dest: l.dest };
      lines.push(col);
    }
    if (col.id) lb[col.id] = [...(lb[col.id] ?? []), ...l.blocks];
    else blocks = [...blocks, ...l.blocks];
  }
  return {
    set: { ...set, ...(lines.length ? { lines } : null) },
    cell: { blocks, ...(Object.keys(lb).length ? { lineBlocks: lb } : null) },
  };
}
