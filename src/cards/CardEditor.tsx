import { useEffect, useRef, useState } from "react";
import { uniqueName } from "../lib/uniqueName";
import { useI18n } from "../i18n";
import { SectionCard } from "../blocks/SectionCard";
import { DestName, LineChecklist, LineHead, SceneCells } from "../panels/SceneCells";
import { addLineDef, columnsOf, dropLineDef, type LineDef } from "../lib/sceneLines";
import { SectionBody, useThumbView } from "../panels/PromptSections";
import { PromptOptsBar } from "../panels/PromptOpts";
import { useCards, type AnyCard, type CardKind, type CharCard, type PoseCard, type StyleCard } from "../store/cards";
import { normThumb, usePrompt, type Thumb } from "../store/prompt";
import { Icon } from "../components/Icon";
import { kindColor } from "./kindColor";

/** 카드 편집 — **배치했을 때의 모습 그대로** 열어서 고친다 (사용자 지시 2026-08-20:
 *  *"편집을 누르면 모달에 카드를 배치했을 때의 모습이 그대로 뜨면서 편집이 가능하면 좋겠음.
 *  지금처럼 이름만 편집하지말고 내용도 확인하고 수정할 수 있게"*).
 *
 *  ★★**같은 부품으로 그린다** — 배너는 `SectionCard`, 스타일·캐릭터의 몸통은 `SectionBody`,
 *    씬 세트의 칸은 `BlockList single` 이다 (씬 줄과 **같은 부품**이다). 편집기 전용으로 다시 그리면
 *    「덱에서 본 것」과 「꺼내 놓은 것」이 조용히 달라진다 — 실제로 씬 세트에 **블록 목록**을
 *    얹었다가 카드에 없는 물건이 됐다 (사용자 지적 2026-08-20).
 *  ★고친 것은 **바로 저장한다** (350ms 디바운스) — 앱의 다른 편집(라이브러리 모달·씬 줄)이
 *    전부 그렇고, 「저장」 단추를 따로 두면 안 누르고 닫는 사람이 생긴다.
 *  ★그림 위치는 **위치 잡는 창**이 잡는다 (`ThumbDialog`) — 부르는 자리는 `App` 하나다.
 *    여기서는 그 창을 열어 달라고 요청만 한다 (`onEditThumb`). */
export function CardEditor({
  kind,
  card,
  onClose,
  onEditThumb,
}: {
  kind: CardKind;
  card: AnyCard;
  onClose: () => void;
  /** 배너 그림의 자리·크기를 다시 잡는다 (그림이 있는 카드에서만 뜬다) */
  onEditThumb: (kind: CardKind, card: AnyCard) => void;
}) {
  const t = useI18n((s) => s.t);
  const [draft, setDraft] = useState<AnyCard>(card);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ★밖에서 카드가 갈리면(그림 위치를 잡고 돌아왔을 때) 그것을 받는다
  useEffect(() => setDraft(card), [card]);

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [onClose]);

  /** 아직 흘려보내지 않은 마지막 편집 (창을 닫을 때 이것을 지금 저장한다) */
  const pending = useRef<AnyCard | null>(null);

  /** 고친 것을 흘려보낸다 — 창을 닫아도 마지막 편집이 남게 즉시 예약한다 */
  const patch = (p: Partial<AnyCard>) => {
    const next = { ...draft, ...p } as AnyCard;
    setDraft(next);
    pending.current = next;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = null;
      pending.current = null;
      void useCards.getState().save(kind, next).catch(() => {});
    }, 350);
  };
  /** ★★창을 닫을 때 예약된 저장이 남아 있으면 **지금 흘려보낸다.** 그냥 지우면
   *  350ms 안에 닫은 마지막 편집이 사라진다 (예약만 걸고 창이 사라지므로). */
  useEffect(
    () => () => {
      if (!timer.current) return;
      clearTimeout(timer.current);
      const last = pending.current;
      if (last) void useCards.getState().save(kind, last).catch(() => {});
    },
    [kind],
  );

  const thumb = normThumb((draft.thumb ?? null) as Thumb | null);
  const view = useThumbView(thumb);

  return (
    <div
      data-card-editor={draft.id}
      onPointerDown={(e) => e.target === e.currentTarget && onClose()}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 70,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "var(--sp-5)",
        background: "rgba(10,14,19,0.55)",
        backdropFilter: "blur(2px)",
      }}
    >
      <div
        style={{
          width: 460,
          maxHeight: "88vh",
          display: "flex",
          flexDirection: "column",
          borderRadius: "var(--r-4)",
          background: "var(--surface)",
          border: "1px solid var(--line)",
          boxShadow: "0 20px 50px rgba(0,0,0,0.45)",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            flexShrink: 0,
            display: "flex",
            alignItems: "center",
            gap: "var(--sp-2)",
            padding: "var(--sp-3) var(--sp-4)",
            borderBottom: "1px solid var(--line-soft)",
          }}
        >
          <b style={{ flex: 1, fontSize: "var(--text-sm)" }}>{t("cards.editTitle")}</b>
          {/* ★그림 위치는 **그림이 있을 때만** 잡을 수 있다 */}
          {thumb && (
            <button
              data-card-editor-thumb
              onClick={() => onEditThumb(kind, draft)}
              style={btn}
            >
              {t("cards.editThumb")}
            </button>
          )}
          <button data-card-editor-close onClick={onClose} style={{ ...btn, padding: "3px 6px" }}>
            {Icon.close12}
          </button>
        </div>

        <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "var(--sp-4)" }}>
          {/* ★★**꺼내 놓았을 때와 같은 카드**다 — 배너도 블록도 그 부품 그대로다 */}
          <SectionCard
            name={draft.name}
            gradient={kindColor(kind)}
            thumb={view}
            onRename={(v) => patch({ name: v } as Partial<AnyCard>)}
            renameTip={t("cards.rename")}
          >
            {kind === "posesets" ? (
              <PoseBody card={draft as PoseCard} onChange={(p) => patch(p as Partial<AnyCard>)} />
            ) : (
              <SectionBody
                id={`cardedit:${draft.id}`}
                prompt={kind === "styles" ? (draft as StyleCard).base : (draft as CharCard).prompt}
                uc={(draft as StyleCard | CharCard).uc ?? []}
                onPrompt={(b) =>
                  patch((kind === "styles" ? { base: b } : { prompt: b }) as Partial<AnyCard>)
                }
                onUc={(b) => patch({ uc: b } as Partial<AnyCard>)}
                /* ★★스타일 카드는 **프롬프트가 되는 넷**을 자기가 들고 다닌다
                   (`lib/styleOpts`) — 그러니 여기서도 만질 수 있어야 한다
                   (사용자 지적 2026-08-23: 투명 BG 체크가 카드에는 없었다).
                   ★인물 카드에는 안 붙인다 — 그 넷은 그림 전체에 걸리는 것이라
                     인물 하나가 들고 다닐 값이 아니다. */
                footer={
                  kind === "styles"
                    ? (showUc) => (
                        <PromptOptsBar
                          uc={showUc}
                          target={{
                            value: (draft as StyleCard).opts ?? {},
                            onChange: (o) =>
                              patch({ opts: { ...(draft as StyleCard).opts, ...o } } as Partial<AnyCard>),
                          }}
                        />
                      )
                    : undefined
                }
              />
            )}
          </SectionCard>
        </div>
      </div>
    </div>
  );
}

/** 씬 세트의 몸통 — **씬 줄에서 보던 그대로**다.
 *
 *  ★★칸은 씬 표와 **같은 부품**이다 (`SceneCells` — 카드의 줄마다 블록 하나, 사용자 결정 2026-11-11).
 *    그대로 쓰므로 칩 클릭·휠 가중치·자동완성·서랍 드롭이 여기서도 같게 먹는다.
 *    여기만 다르게 그리면 「덱에서 본 것」과 「꺼내 놓은 것」이 조용히 달라진다. */
function PoseBody({
  card,
  onChange,
}: {
  card: PoseCard;
  onChange: (patch: Partial<PoseCard>) => void;
}) {
  const t = useI18n((s) => s.t);
  const cells = card.cells ?? [];
  /** 줄 머리가 가리키는 차례 — 지금 탭에서 켜진 캐릭터 (씬 표와 같다) */
  const chars = usePrompt((s) => s.chars).filter((c) => c.on);
  const cols = columnsOf(card);
  const patch = (i: number, p: Partial<PoseCard["cells"][number]>) => onChange({ cells: cells.map((x, k) => (k === i ? { ...x, ...p } : x)) });
  const retarget = (col: LineDef, dest: string) =>
    col.id
      ? onChange({ lines: (card.lines ?? []).map((l) => (l.id === col.id ? { ...l, dest } : l)) })
      : onChange({ dest: dest === "base" ? undefined : dest });
  return (
    <div style={{ display: "flex", flexDirection: "column", padding: "var(--sp-2) 0" }}>
      {/* ★★줄 구성은 **카드가 정한다** (사용자 결정 2026-11-11, `lib/sceneLines`) — 씬 표의 열 머리와 같은 것을 위에 한 줄로 둔다 */}
      <div data-card-editor-lines style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 4, padding: "var(--sp-1) 10px var(--sp-2)" }}>
        <span style={{ fontSize: "var(--text-2xs)", color: "var(--ink-faint)", marginRight: 2 }}>{t("scenes.lineCol")}</span>
        {cols.map((col) => (
          <span key={col.id || "main"} style={{ display: "flex", border: "1px solid var(--line)", borderRadius: "var(--r-1)" }}>
            <LineHead
              set={card}
              col={col}
              chars={chars}
              onRetarget={(d) => retarget(col, d)}
              onRemove={() => onChange(dropLineDef(card, cells, col.id))}
            />
          </span>
        ))}
        <LineChecklist
          mark={`cardedit-${card.id}`}
          set={card}
          chars={chars}
          onAdd={(d) => onChange({ lines: addLineDef(card, d) })}
          onRemove={(col) => onChange(dropLineDef(card, cells, col.id))}
          icon={Icon.lineAdd}
          style={{ color: "var(--ink-faint)", display: "grid", padding: "0 2px" }}
        />
      </div>
      {cells.map((c, i) => (
        <div key={i} style={{ display: "flex", flexDirection: "column", gap: 3, padding: "var(--sp-2) 10px" }}>
          <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
            <input
              data-card-editor-cell
              value={c.name}
              onChange={(e) => patch(i, { name: e.target.value })}
              style={{
                flex: 1,
                minWidth: 0,
                background: "transparent",
                border: "none",
                padding: 0,
                fontSize: "var(--text-2xs)",
                fontWeight: "var(--w-semi)",
                color: "var(--ink-soft)",
              }}
            />
            {/* ★마지막 한 칸은 못 뺀다 — 씬이 없는 세트는 이 카드가 할 일이 없다 */}
            {cells.length > 1 && (
              <button
                data-card-editor-delcell={i}
                onClick={() => onChange({ cells: cells.filter((_, k) => k !== i) })}
                data-tip={t("cards.removeScene")}
                style={{ color: "var(--ink-faint)", display: "grid", padding: "0 2px" }}
              >
                {Icon.close12}
              </button>
            )}
          </span>
          {/* ★★칸은 씬 표와 **같은 부품**이다 (`SceneCells`) — 칩 클릭·휠 가중치·자동완성·서랍 드롭이 여기서도 같게 먹는다 */}
          <div style={{ border: "1px solid var(--line)", borderRadius: "var(--r-1)", overflow: "hidden" }}>
            <SceneCells
              id={`${card.id}:${i}`}
              zone={`cardedit-${card.id}-${i}`}
              set={card}
              cell={c}
              onChange={(p) => patch(i, p)}
              vert
              expanded
              label={
                cols.length > 1 || cols[0].dest !== "base"
                  ? (col) => (
                      <span style={{ width: 62, flexShrink: 0, padding: "5px 4px", fontSize: "var(--text-2xs)", color: "var(--ink-faint)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                        <DestName dest={col.dest} />
                      </span>
                    )
                  : undefined
              }
            />
          </div>
        </div>
      ))}
      {!cells.length && (
        <span style={{ padding: "var(--sp-3) 10px", fontSize: "var(--text-2xs)", color: "var(--ink-faint)" }}>
          {t("cards.editNoCells")}
        </span>
      )}
      {/* ★★씬을 **여기서 넣고 뺀다** (사용자 지시 2026-08-20: 「새 카드 추가」를 편집 모달로).
          없으면 갓 만든 씬 세트를 늘릴 길이 아예 없어 카드가 한 칸에 갇힌다.
          ★이름 규칙은 씬 줄과 **같은 것**을 쓴다 (`slots.newName`) — 여기서만 다른 이름이
            붙으면 같은 카드가 화면마다 달라 보인다. */}
      <button
        data-card-editor-addcell
        onClick={() => onChange({ cells: [...cells, { name: uniqueName(t("slots.newName"), cells.map((c) => c.name)), blocks: [] }] })}
        style={{
          margin: "var(--sp-2) 10px 0",
          padding: "2px var(--sp-3)",
          borderRadius: "var(--r-1)",
          border: "1px dashed var(--line)",
          color: "var(--ink-dim)",
          fontSize: "var(--text-2xs)",
          justifySelf: "start",
        }}
      >
        {t("cards.addScene")}
      </button>
    </div>
  );
}

const btn: React.CSSProperties = {
  padding: "3px var(--sp-3)",
  borderRadius: "var(--r-2)",
  border: "1px solid var(--line)",
  background: "var(--panel)",
  color: "var(--ink-soft)",
  fontSize: "var(--text-2xs)",
};
