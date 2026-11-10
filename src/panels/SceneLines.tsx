import { BlockList } from "../blocks/BlockList";
import { Dropdown, type DropdownOption } from "../components/Dropdown";
import { slotBlock, slotBlocksOf } from "../lib/blocks";
import { destIndex, lineTarget, lineZone, type LinedCell, type SceneLine } from "../lib/sceneLines";
import { pushUndo } from "../lib/undo";
import { useI18n } from "../i18n";

/** 넣을 곳 목록의 「줄 빼기」 — 값이 아니라 동작이다 */
const REMOVE = "__remove";

/** 접힌 줄에서 줄 하나가 칩 한 줄을 다 보이는 높이 — 칩 상자 위 여백·테두리 4 + 칩 23 (`BlockBody` 의 `box`).
 *  세로 모드는 이름표가 줄 위에 서므로 이름표 21 + 틈 4 가 더 든다 */
const LINE_H = 27;
const LINE_H_VERT = 52;

/** ★★줄이 둘 이상인 씬의 **머리가 적어도 가져야 할 높이** (접힌 줄). 줄마다 칩 한 줄은 다 보여야 한다 —
 *  모자라면 칩이 아래가 잘린 채 `+n` 으로 세어져, 다 보이는데도 숨은 것처럼 뜬다 (게스트 실측 2026-11-10: 줄 셋에 줄마다 22px).
 *  줄이 하나면 0 이다 (지금까지처럼 줄 두께는 썸네일이 정한다). 머리 위아래 여백 12 · 이름 줄 20 (세로 모드는 접혀 40) · 틈 4 */
export function linesMinHead(n: number, vert: boolean): number {
  if (n <= 1) return 0;
  return vert ? 56 + n * LINE_H_VERT : 36 + n * LINE_H;
}

/** 줄마다 같은 것을 넘기는 블록 목록 설정 (씬 줄이 펴졌나·잘라 보이나·키 이동) */
type ListOpts = Pick<
  Parameters<typeof BlockList>[0],
  "open" | "clamp" | "fill" | "bg" | "onOpen" | "onMore" | "onDone" | "onNext" | "onTab"
>;

/** ★★씬 하나의 **줄들** — 줄마다 넣을 곳(이름표)과 블록 하나 (사용자 결정 2026-11-10, `lib/sceneLines` 머리 주석).
 *  씬 줄(`SceneLane`)과 덱의 씬 카드 편집기(`CardEditor`)가 이것 하나를 쓴다 — 덱에서 본 것과 꺼내 놓은 것이 같아야 한다.
 *  ★첫 줄은 씬의 블록이고(`data-slot-block` 이 씬 id 그대로) 뺄 수 없다. 나머지 줄은 이름표 목록의 「줄 빼기」로 뺀다.
 *  ★블록을 고치는 것은 언제나 `BlockList` 의 `single` 이다 — 줄마다 그 목록이 하나씩 선다. */
export function SceneLines(p: {
  /** 첫 줄을 가리키는 이름 (`data-slot-block`). 나머지 줄은 `<id>:<줄 id>` */
  id: string;
  /** 첫 줄의 블록 목록 자리 (`libZone`). 나머지 줄은 `lineZone` */
  zone: string;
  cell: LinedCell;
  onChange: (patch: Partial<LinedCell>) => void;
  /** 켜진 캐릭터 — 이름표 목록의 이름과 점선 판정 */
  chars: { name: string }[];
  list?: ListOpts;
  /** 첫 줄의 글 상자를 바로 연다 */
  autoEdit?: boolean;
  /** 이 줄의 글 상자를 바로 연다 (방금 더한 줄) */
  autoLine?: string | null;
  /** 세로 모드 — 머리가 좁아 이름표를 줄 위에 둔다 */
  vert?: boolean;
}) {
  const t = useI18n((s) => s.t);
  const n = p.chars.length;
  const lines = p.cell.lines ?? [];
  const clamp = !!p.list?.clamp;

  const options = (dest: string, main: boolean): DropdownOption[] => [
    { value: "base", label: t("scenes.destBase") },
    ...Array.from({ length: Math.max(n, destIndex(dest)) }, (_, i) => ({
      value: `#${i + 1}`,
      label: p.chars[i]?.name ? t("scenes.destCharName", { n: i + 1, name: p.chars[i].name }) : t("scenes.destCharN", { n: i + 1 }),
      short: t("scenes.destCharN", { n: i + 1 }),
    })),
    // ★「전원」은 켜진 캐릭터가 둘 이상일 때만 낸다 — 한 명이면 그 사람을 고르는 것과 같다 (`lineTarget`)
    ...(n > 1 || dest === "all" ? [{ value: "all", label: t("scenes.destAll") }] : []),
    ...(main ? [] : [{ value: REMOVE, label: t("scenes.lineRemove"), sep: true }]),
  ];

  const pick = (lineId: string | null, v: string) => {
    if (lineId === null) return p.onChange({ dest: v === "base" ? undefined : v });
    if (v === REMOVE) {
      pushUndo(t("scenes.lineRemove"), () => p.onChange({ lines }), p.zone);
      const rest = lines.filter((l) => l.id !== lineId);
      return p.onChange({ lines: rest.length ? rest : undefined });
    }
    p.onChange({ lines: lines.map((l) => (l.id === lineId ? { ...l, dest: v } : l)) });
  };

  const row = (key: string, dest: string, main: boolean, body: React.ReactNode) => {
    // ★가리킨 캐릭터가 없으면 점선 — 첫 줄은 베이스로 떨어지고 나머지 줄은 안 들어간다 (`lineTarget`)
    const miss = lineTarget(dest, n, false, false) === null;
    const pill = (
      /* ★★클릭을 여기서 멈춘다 — 목록은 body 에 뜨지만(portal) React 이벤트는 그 위로 올라온다. 안 멈추면 항목을 고른
           클릭이 씬 머리의 「누르면 펴고 친다」에 닿아 줄이 펴지고 글 상자가 열린다 (게스트 실측 2026-11-10) */
      <span data-head-action onClick={(e) => e.stopPropagation()} style={{ display: "flex", alignSelf: "flex-start", fontSize: "var(--text-2xs)" }}>
        <Dropdown
          mark="scene-line-dest"
          value={dest}
          options={options(dest, main)}
          dashed={miss}
          tip={miss ? t(main ? "scenes.destMissMain" : "scenes.destMissLine") : t("scenes.destHint")}
          onChange={(v) => pick(main ? null : key, v)}
        />
      </span>
    );
    const cellBox = <div style={{ minWidth: 0, minHeight: 0, display: "flex", flexDirection: "column", flex: "1 1 auto" }}>{body}</div>;
    /* ★가로 모드는 줄들이 **한 격자**다 — 이름표 칸의 폭이 줄마다 같아야 칩이 한 줄로 가지런히 선다.
       줄 상자는 자리만 잡는다(`display: contents`). 세로 모드는 머리가 좁아 이름표를 줄 위에 둔다 */
    if (!p.vert)
      return (
        <div key={key} data-scene-line={main ? "" : key} style={{ display: "contents" }}>
          {pill}
          {cellBox}
        </div>
      );
    return (
      <div
        key={key}
        data-scene-line={main ? "" : key}
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 4,
          minWidth: 0,
          ...(clamp
            ? { flex: "1 1 0", minHeight: lines.length ? LINE_H_VERT : 0 }
            : { flex: lines.length ? "0 0 auto" : "1 1 auto" }),
        }}
      >
        {pill}
        {cellBox}
      </div>
    );
  };

  const count = 1 + lines.length;
  /* ★★접힌 줄에서는 줄들이 머리를 **나눠 갖고** 넘치는 칩은 잘린다 (`clamp`). 줄마다 칩 한 줄은 다 보이고(`LINE_H`),
     줄이 하나면 지금까지처럼 그 줄이 머리를 다 쓴다 (머리 아무 데나 눌러 칠 수 있게).
     ★접힌 줄에서는 줄 사이 틈을 두지 않는다 — 칩 상자의 여백이 틈이 된다 (`linesMinHead` 의 셈) */
  const grid: React.CSSProperties = {
    display: "grid",
    gridTemplateColumns: "max-content minmax(0, 1fr)",
    gridTemplateRows: count === 1 ? "minmax(0, 1fr)" : clamp ? `repeat(${count}, minmax(${LINE_H}px, 1fr))` : `repeat(${count}, auto)`,
    columnGap: 4,
    rowGap: count > 1 && !clamp ? 3 : 0,
  };
  const main = slotBlock(p.cell.blocks, p.id);
  return (
    <div
      data-scene-lines={p.id}
      style={{
        flex: "1 1 auto",
        minHeight: 0,
        ...(p.vert ? { display: "flex", flexDirection: "column", gap: lines.length && !clamp ? 3 : 0 } : grid),
      }}
    >
      {row(
        "",
        p.cell.dest ?? "base",
        true,
        <BlockList
          single
          {...p.list}
          id={p.id}
          blocks={[main]}
          onChange={(b) => p.onChange({ blocks: slotBlocksOf(b[0] ?? main) })}
          libZone={p.zone}
          autoEdit={p.autoEdit}
        />,
      )}
      {lines.map((l: SceneLine) => {
        const lid = `${p.id}:${l.id}`;
        const blk = slotBlock(l.blocks, lid);
        return row(
          l.id,
          l.dest,
          false,
          <BlockList
            single
            {...p.list}
            id={lid}
            blocks={[blk]}
            onChange={(b) => p.onChange({ lines: lines.map((x) => (x.id === l.id ? { ...x, blocks: slotBlocksOf(b[0] ?? blk) } : x)) })}
            libZone={lineZone(p.zone, l.id)}
            autoEdit={p.autoLine === l.id}
          />,
        );
      })}
    </div>
  );
}
