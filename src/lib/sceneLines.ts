/** 씬 프롬프트의 **줄** — 씬 하나가 프롬프트를 여러 곳에 나눠 넣는다 (사용자 결정 2026-11-10, 시안 `docs/scene-lines-mockup.html` 의 B).
 *
 *  ★★줄마다 넣을 곳(`dest`)이 있다. 첫 줄은 씬의 블록(`Slot.blocks` · `Slot.dest`)이고, 그 뒤는 `Slot.lines` 다.
 *    예: 「캐릭터 1은 여성, 2는 남성」인 씬 세트에서 씬마다 베이스 · 캐릭터 1 · 캐릭터 2 에 따로 지시한다.
 *  ★줄은 **씬마다 따로**다 (사용자 선택: 카드에서 한 번에 정하는 쪽이 아니라).
 *  ★넣을 곳은 셋이다. 베이스(`"base"`) · 캐릭터 번호(`"#1"` …, **그 장에 실린 캐릭터의 차례**) · 캐릭터 전원(`"all"`).
 *    캐릭터를 id 가 아니라 번호로 가리키는 것은 덱에 저장한 씬 카드를 다른 탭에 얹어도 맞게 하려는 것이다.
 *    옛 씬 그룹의 `sceneDest`(캐릭터 id)는 열 때 번호로 옮긴다 (`legacyDest`).
 *  ★가리킨 캐릭터가 그 장에 없으면 첫 줄은 **베이스로 떨어지고**(조용히 사라지지 않게, 옛 규칙 그대로) 나머지 줄은 **안 들어간다**.
 *  ★순수 계산만 둔다 — 생성(`store/gen` 의 `queueGroup`)과 화면(`panels/SceneLines`)이 같은 판정을 쓴다. */
import { compileBlocks, type Block } from "./blocks.ts";

export type SceneLine = { id: string; dest: string; blocks: Block[] };

/** 줄을 든 씬 — `Slot` · 덱 씬 카드의 칸 · 그림의 `env.cell` 이 다 이 모양을 갖는다 */
export type LinedCell = { blocks?: Block[]; dest?: string; lines?: SceneLine[] };

/** 캐릭터 번호 (1부터). 번호가 아니면 0 */
export const destIndex = (dest: string | undefined): number => {
  const m = /^#(\d+)$/.exec(dest ?? "");
  return m ? Number(m[1]) : 0;
};

/** 그 줄이 이 장의 **어디로** 가나 — 캐릭터 자리 목록(0부터) · `"base"` · `null`(안 들어감).
 *  @param n 그 장에 실린 캐릭터 수
 *  @param seq 순차 생성 — 한 장에 한 명뿐이라 「전원」이 곧 그 사람이다
 *  @param main 첫 줄인가 — 가리킨 곳이 없으면 베이스로 떨어진다 */
export function lineTarget(dest: string | undefined, n: number, seq: boolean, main: boolean): "base" | number[] | null {
  if (!dest || dest === "base") return "base";
  // ★「전원」은 둘 이상일 때만 뜻이 있다 (한 명이면 그 사람을 고르는 것과 같다). 화면도 그때만 선택지를 낸다
  if (dest === "all" && (n > 1 || (seq && n > 0))) return Array.from({ length: n }, (_, i) => i);
  const k = destIndex(dest);
  if (k >= 1 && k <= n) return [k - 1];
  return main ? "base" : null;
}

/** 씬의 줄을 전부 — 첫 줄(씬의 블록)이 맨 앞이다 */
export const linesOf = (c: LinedCell): { dest: string; blocks: Block[]; main: boolean }[] => [
  { dest: c.dest ?? "base", blocks: c.blocks ?? [], main: true },
  ...(c.lines ?? []).map((l) => ({ dest: l.dest, blocks: l.blocks, main: false })),
];

/** 씬 하나를 그 장의 프롬프트에 나눠 넣는다 — 베이스는 탭의 베이스 뒤에, 캐릭터는 그 사람의 프롬프트 뒤에 줄 차례대로 */
export function placeScene<C extends { prompt: string }>(
  cell: LinedCell, prompt: string, chars: C[], seq: boolean,
): { prompt: string; chars: C[] } {
  const base: string[] = [prompt];
  const per: string[][] = chars.map((ch) => [ch.prompt]);
  for (const l of linesOf(cell)) {
    const text = compileBlocks(l.blocks);
    if (!text) continue;
    const to = lineTarget(l.dest, chars.length, seq, l.main);
    if (to === "base") base.push(text);
    else if (to) for (const i of to) per[i].push(text);
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

/** 새 줄의 넣을 곳 — 그 씬에서 아직 안 쓴 캐릭터 번호 중 가장 앞. 다 썼으면 그다음 번호 */
export function nextDest(c: LinedCell, n: number): string {
  const used = new Set(linesOf(c).map((l) => l.dest));
  for (let k = 1; k <= Math.max(1, n); k++) if (!used.has(`#${k}`)) return `#${k}`;
  return `#${Math.max(1, n) + 1}`;
}

/** 줄 id — 씬 안에서만 유일하면 된다 (블록 목록 자리 이름이 씬 id 를 함께 든다) */
export const newLineId = () => "ln_" + Math.random().toString(36).slice(2, 8);

/** 줄의 블록 목록 자리 이름 — 첫 줄은 씬의 자리 그대로(`scene-<id>`), 나머지는 그 뒤에 줄 id */
export const lineZone = (zone: string, lineId: string) => `${zone}~${lineId}`;

/** 줄 하나를 더한다 — 넣을 곳은 `nextDest` */
export function addLine(c: LinedCell, n: number): { id: string; lines: SceneLine[] } {
  const id = newLineId();
  return { id, lines: [...(c.lines ?? []), { id, dest: nextDest(c, n), blocks: [] }] };
}
