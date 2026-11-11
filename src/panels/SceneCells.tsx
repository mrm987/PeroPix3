import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { BlockList } from "../blocks/BlockList";
import { Dropdown, type DropdownOption } from "../components/Dropdown";
import { slotBlock, slotBlocksOf } from "../lib/blocks";
import { blocksAt, columnsOf, freeDests, lineTarget, lineZone, type CellBlocks, type LineDef, type LineSet } from "../lib/sceneLines";
import { observeSize, useWin } from "../lib/floatWin";
import { Icon } from "../components/Icon";
import { CharNo } from "./CharPositioner";
import { useI18n } from "../i18n";

/** 가로 모드의 씬 칸 폭 — 번호 · 이름(두 줄까지) · 버튼 (사용자 결정 2026-11-11, 시안 `docs/scene-lines-mockup3.html`) */
export const SCENE_W = 92;
/** 세로 모드의 씬 칸 높이 — 이름 줄과 버튼 줄. ★줄 이름 칸과 높이가 맞아야 하므로 고정이다 */
export const VERT_NAME_H = 50;
/** 세로 모드에서 접힌 줄 하나의 높이 — 칩 두 줄 (칩 23 · 틈 4 · 입력칸 여백 8) */
export const LINE_H = 60;
/** 가로 모드의 줄 머리 높이 (줄을 나눈 카드만) */
export const LINE_HEAD_H = 26;

/** 줄마다 같은 것을 넘기는 블록 목록 설정 (펴졌나 · 키 이동) */
type ListOpts = Pick<Parameters<typeof BlockList>[0], "bg" | "onOpen" | "onMore" | "onDone">;

/** ★★넣을 곳의 이름 — 캐릭터는 **캐릭터 카드의 번호 원과 같은 원**으로 가리킨다 (사용자 지시 2026-11-11).
 *  이름으로 가리키면 이름을 바꿀 때 무엇이 몇 번인지 헷갈린다. 캐릭터 카드 배너에도 같은 번호가 늘 붙는다 (`PromptSections` 의 `nameTag`). */
export function DestName(p: { dest: string }) {
  const t = useI18n((s) => s.t);
  if (p.dest === "base") return <>{t("scenes.destBase")}</>;
  if (p.dest === "all") return <>{t("scenes.destAll")}</>;
  return (
    /* ★글줄 높이 안에서 가운데 — 원을 글자 크기에 맞춘다 (사용자 지적 2026-11-11: 원이 크고 글과 줄이 안 맞았다).
       `inline-flex` + `vertical-align` 은 글의 기준선을 따라가 원이 아래로 처졌다 */
    <span style={{ display: "flex", alignItems: "center", gap: 3 }}>
      {t("scenes.destChar")}
      <CharNo n={Number(p.dest.slice(1))} size={13} ring={1} />
    </span>
  );
}

/** ★★줄 하나의 머리 — 넣을 곳을 바꾸고 줄을 뺀다 (사용자 결정 2026-11-11). 가로 모드는 열 머리, 세로 모드는 줄 이름 칸이다.
 *  ★고를 수 있는 넣을 곳은 카드에서 아직 안 쓴 것뿐이다 (`freeDests`) — 한 카드에 같은 넣을 곳이 둘이면 어느 줄인지 갈리지 않는다.
 *  ★첫 줄(씬의 블록)은 뺄 수 없다. */
export function LineHead(p: {
  set: LineSet;
  col: LineDef;
  chars: { name: string }[];
  onRetarget: (dest: string) => void;
  onRemove: () => void;
  /** 카드 배너에 놓였나 — 한 칸뿐인 카드는 표 머리 대신 배너에서 고른다 (그림 위라 흰 글자) */
  banner?: boolean;
  /** 세로 모드의 배너 띠 — 글이 세로로 선다 */
  vert?: boolean;
}) {
  const t = useI18n((s) => s.t);
  const main = !p.col.id;
  const n = p.chars.length;
  // ★가리킨 캐릭터가 없으면 점선 — 첫 줄은 베이스로 떨어지고 나머지 줄은 안 들어간다 (`lineTarget`)
  const miss = lineTarget(p.col.dest, n, false) === null;
  const options: DropdownOption[] = [
    { value: p.col.dest, label: <DestName dest={p.col.dest} /> },
    ...freeDests(p.set, n).map((d) => ({ value: d, label: <DestName dest={d} /> })),
    ...(main ? [] : [{ value: REMOVE, label: t("scenes.lineRemove"), sep: true }]),
  ];
  return (
    /* ★클릭을 여기서 멈춘다 — 목록은 body 에 뜨지만(portal) React 이벤트는 그 위로 올라와 씬 칸의 「누르면 친다」에 닿는다 */
    <span data-line-head={p.col.id || "main"} onClick={(e) => e.stopPropagation()} style={{ display: "flex", minWidth: 0, fontSize: "var(--text-2xs)" }}>
      <Dropdown
        mark="scene-line-dest"
        bare
        value={p.col.dest}
        options={options}
        dashed={miss}
        light={p.banner}
        vert={p.vert}
        tip={miss ? t(main ? "scenes.destMissMain" : "scenes.destMissLine") : t("scenes.destHint")}
        onChange={(v) => (v === REMOVE ? p.onRemove() : p.onRetarget(v))}
      />
    </span>
  );
}

/** 넣을 곳 목록의 「제거」 — 값이 아니라 동작이다 */
const REMOVE = "__remove";

/** ★★카드 배너의 「적용 대상 추가」 — 체크 상자 목록으로 적용 대상을 켜고 끈다 (사용자 지시 2026-11-11: 시안처럼 체크 상자로).
 *  켜면 카드의 씬 전부에 빈 줄이 생기고, 끄면 그 줄이 블록과 함께 빠진다 (`Ctrl+Z` 로 되돌린다). 첫 줄은 끌 수 없다.
 *  ★목록은 고른 뒤에도 열려 있다 — 여럿을 한 번에 켜고 끄는 자리다. 밖을 누르거나 Esc 로 닫는다. */
export function LineChecklist(p: {
  set: LineSet;
  chars: { name: string }[];
  onAdd: (dest: string) => void;
  onRemove: (col: LineDef) => void;
  style: React.CSSProperties;
  icon: React.ReactNode;
  mark: string;
}) {
  const t = useI18n((s) => s.t);
  const win = useWin();
  const [at, setAt] = useState<{ x: number; y: number } | null>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const cols = columnsOf(p.set);
  const n = p.chars.length;
  const used = cols.map((c) => c.dest).filter((d) => d !== "base" && d !== "all").map((d) => Number(d.slice(1)));
  const all = ["base", ...Array.from({ length: Math.max(2, n, ...used) }, (_, i) => `#${i + 1}`), "all"];

  useEffect(() => {
    if (!at) return;
    const down = (e: PointerEvent) => {
      const el = e.target as Node;
      if (btn.current?.contains(el) || list.current?.contains(el)) return;
      setAt(null);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") setAt(null);
    };
    const away = () => setAt(null);
    win.document.addEventListener("pointerdown", down, true);
    win.document.addEventListener("keydown", key);
    win.addEventListener("resize", away);
    win.addEventListener("blur", away);
    return () => {
      win.document.removeEventListener("pointerdown", down, true);
      win.document.removeEventListener("keydown", key);
      win.removeEventListener("resize", away);
      win.removeEventListener("blur", away);
    };
  }, [at, win]);
  // 목록을 재고 나서 화면 안으로 민다
  useLayoutEffect(() => {
    const el = list.current;
    if (!at || !el) return;
    const r = el.getBoundingClientRect();
    const x = Math.max(8, Math.min(win.innerWidth - 8 - r.width, at.x));
    const y = at.y + r.height > win.innerHeight - 8 ? Math.max(8, at.y - r.height - 30) : at.y;
    if (x !== at.x || y !== at.y) setAt({ x, y });
  }, [at, win]);

  return (
    <span data-line-add={p.mark} onPointerDown={(e) => e.stopPropagation()} onClick={(e) => e.stopPropagation()} style={{ display: "flex" }}>
      <button
        ref={btn}
        type="button"
        data-line-add-btn
        data-open={at ? "" : undefined}
        data-tip={t("scenes.lineAdd")}
        onClick={() => {
          if (at) return setAt(null);
          const r = btn.current?.getBoundingClientRect();
          if (r) setAt({ x: r.left, y: r.bottom + 4 });
        }}
        style={p.style}
      >
        {p.icon}
      </button>
      {at &&
        createPortal(
          <div
            ref={list}
            data-line-checklist={p.mark}
            style={{
              position: "fixed",
              left: at.x,
              top: at.y,
              zIndex: 8000,
              display: "flex",
              flexDirection: "column",
              minWidth: 190,
              padding: "var(--sp-1)",
              background: "var(--panel)",
              border: "1px solid var(--line)",
              borderRadius: "var(--r-2)",
              boxShadow: "0 8px 24px rgba(0,0,0,0.45)",
            }}
          >
            {all.map((d) => {
              const col = cols.find((c) => c.dest === d);
              const on = !!col;
              // ★첫 줄은 끌 수 없다 — 씬의 블록이 사는 자리다
              const lock = on && !col!.id;
              return (
                <button
                  key={d}
                  type="button"
                  data-line-check={d}
                  data-on={on ? "" : undefined}
                  disabled={lock}
                  onClick={() => (on ? p.onRemove(col!) : p.onAdd(d))}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "var(--sp-3)",
                    padding: "var(--sp-2) var(--sp-3)",
                    borderRadius: "var(--r-1)",
                    fontSize: "var(--text-xs)",
                    color: "var(--ink)",
                    textAlign: "left",
                    whiteSpace: "nowrap",
                    opacity: lock ? 0.5 : 1,
                    cursor: lock ? "default" : "pointer",
                  }}
                  onPointerEnter={(e) => {
                    if (!lock) e.currentTarget.style.background = "var(--accent-bg)";
                  }}
                  onPointerLeave={(e) => {
                    e.currentTarget.style.background = "transparent";
                  }}
                >
                  <span
                    style={{
                      width: 14,
                      height: 14,
                      flexShrink: 0,
                      display: "grid",
                      placeItems: "center",
                      borderRadius: 3,
                      border: `1px solid ${on ? "var(--accent)" : "var(--line)"}`,
                      background: on ? "var(--accent)" : "transparent",
                      color: "#fff",
                    }}
                  >
                    {on && Icon.check}
                  </span>
                  <DestName dest={d} />
                </button>
              );
            })}
          </div>,
          win.document.body,
        )}
    </span>
  );
}

/** ★★씬 하나의 **줄 칸들** — 카드의 줄마다 블록 하나 (사용자 결정 2026-11-11, `lib/sceneLines` 머리 주석).
 *  씬 표(`SceneLane`)와 덱의 씬 카드 편집기(`CardEditor`)가 이것 하나를 쓴다 — 덱에서 본 것과 꺼내 놓은 것이 같아야 한다.
 *  ★블록을 고치는 것은 언제나 `BlockList` 의 `single` 이다. 칸 하나가 곧 입력칸이라 칸 아무 데나 누르면 그 줄을 친다.
 *  ★가로 모드는 칸이 옆으로(폭은 줄마다 `widthOf`), 세로 모드는 아래로(높이는 `heights`) 늘어선다.
 *  ★세로 모드에서 펼친 씬은 칸이 글만큼 자라고, 그 높이를 `onLineHs` 로 알린다 — 카드가 줄 이름 칸과 다른 씬의 칸을 그 높이에 맞춘다. */
export function SceneCells(p: {
  /** 첫 줄을 가리키는 이름 (`data-slot-block`). 나머지 줄은 `<id>:<줄 id>` */
  id: string;
  /** 첫 줄의 블록 목록 자리 (`libZone`). 나머지 줄은 `lineZone` */
  zone: string;
  set: LineSet;
  cell: CellBlocks;
  onChange: (patch: CellBlocks) => void;
  vert?: boolean;
  /** 가로 모드 — 그 줄의 폭 */
  widthOf?: (dest: string) => number;
  /** 세로 모드 — 줄마다 접힌 높이 (펼친 씬이 잰 높이에 맞춘 것) */
  heights?: number[];
  /** 펼쳐 있나 — 접혀 있으면 넘치는 칩을 자르고 `+n` */
  expanded: boolean;
  /** 이 줄의 글 상자를 바로 연다 (`""` 는 첫 줄) */
  typingLine?: string | null;
  /** 줄의 `Tab` — 다음 줄로, 줄 끝이면 다음 씬으로 (부르는 쪽이 정한다) */
  onTab?: (lineId: string, dir: 1 | -1) => void;
  /** 줄의 `Shift+Enter` — 옆 씬의 같은 줄로 */
  onNext?: (lineId: string) => void;
  list?: ListOpts;
  /** 세로 모드에서 펼친 씬의 칸 높이 */
  onLineHs?: (hs: number[] | null) => void;
  /** 칸마다 덧붙이는 것 (가로 모드의 폭 손잡이) */
  extra?: (col: LineDef) => React.ReactNode;
  /** 칸 왼쪽에 세우는 줄 이름 (덱의 씬 카드 편집기 — 줄 이름 칸이 따로 없다) */
  label?: (col: LineDef) => React.ReactNode;
}) {
  const cols = columnsOf(p.set);
  const boxes = useRef<(HTMLDivElement | null)[]>([]);
  const measure = !!p.vert && p.expanded && !!p.onLineHs;
  const onLineHs = useRef(p.onLineHs);
  onLineHs.current = p.onLineHs;
  useEffect(() => {
    if (!measure) return;
    const els = boxes.current.slice(0, cols.length).filter((x): x is HTMLDivElement => !!x);
    const send = () => onLineHs.current?.(els.map((el) => Math.ceil(el.getBoundingClientRect().height)));
    send();
    const ros = els.map((el) => observeSize(el, send));
    return () => {
      ros.forEach((r) => r.disconnect());
      onLineHs.current?.(null);
    };
  }, [measure, cols.length]);

  return (
    <div
      data-scene-lines={p.id}
      /* ★세로 모드는 기둥 폭을 다 쓴다 (`1 1 0`) — 내용 폭(`auto`)으로 두면 글 상자의 기본 폭만큼 기둥 밖으로 넘친다 (게스트 실측 2026-11-11) */
      style={{ display: "flex", flexDirection: p.vert ? "column" : "row", alignItems: "stretch", minWidth: 0, minHeight: 0, flex: p.vert ? "1 1 0" : "0 0 auto" }}
    >
      {cols.map((col, k) => {
        const lid = col.id ? `${p.id}:${col.id}` : p.id;
        const blk = slotBlock(blocksAt(p.cell, col.id), lid);
        const h = p.heights?.[k] ?? LINE_H;
        return (
          <div
            key={col.id || "main"}
            ref={(el) => {
              boxes.current[k] = el;
            }}
            data-scene-line={col.id || "main"}
            style={{
              position: "relative",
              display: "flex",
              flexDirection: p.label ? "row" : "column",
              alignItems: p.label ? "flex-start" : undefined,
              gap: p.label ? 4 : undefined,
              minWidth: 0,
              padding: 2,
              ...(p.vert
                ? { borderTop: "1px solid var(--line-soft)", ...(p.expanded ? { minHeight: LINE_H } : { height: h }) }
                : { width: p.widthOf?.(col.dest) ?? 200, flexShrink: 0, borderLeft: "1px solid var(--line-soft)" }),
            }}
          >
            {p.label?.(col)}
            <BlockList
              single
              fill
              open={p.expanded}
              clamp={!p.expanded}
              {...p.list}
              onTab={p.onTab ? (dir) => p.onTab!(col.id, dir) : undefined}
              onNext={p.onNext ? () => p.onNext!(col.id) : undefined}
              id={lid}
              blocks={[blk]}
              onChange={(b) => {
                const next = slotBlocksOf(b[0] ?? blk);
                if (!col.id) p.onChange({ blocks: next });
                else p.onChange({ lineBlocks: { ...(p.cell.lineBlocks ?? {}), [col.id]: next } });
              }}
              libZone={lineZone(p.zone, col.id)}
              autoEdit={p.typingLine === col.id}
            />
            {p.extra?.(col)}
          </div>
        );
      })}
    </div>
  );
}
