import { composing } from "../lib/ime";
import { useEffect, useRef, useState } from "react";
import { TYPE } from "../styles/type";
import { useUi, flashStyle, useFlashAt } from "../store/ui";
import { useI18n } from "../i18n";
import { useCards, type AnyCard, type CardKind } from "../store/cards";
import { uniqueName } from "../lib/uniqueName";
import { useDrag, useDragSource, useDropZone, dragSourceStyle, type DragImage, type SectionThumb } from "./dragStore";
import { DropVeil } from "./DropVeil";
import { CardEditor } from "./CardEditor";
import { saveCardWithThumb } from "./saveCard";
import { normThumb, thumbUrl } from "../store/prompt";
import { artBackground } from "./CardArt";
import { BANNER_BG, BANNER_SCRIM, COVER_CUT, COVER_STEP } from "./banner";
import { FittedImg } from "./FittedImg";
import { Icon } from "../components/Icon";
import { ask } from "../store/ask";
import { useGen } from "../store/gen";

/** 오른쪽 패널의 **카드덱** — 스타일·캐릭터·씬 세트를 여기서 꺼내고 여기에 저장한다.
 *
 *  ★예전에는 우하단 손패를 눌러 **전체 화면 덱**을 띄웠다 (사용자 지시 2026-08-16으로 옮김).
 *    덱이 화면을 덮으면 무엇에 적용하는지가 안 보이고, 끌어다 놓으려면 덱을 먼저 닫아야 했다.
 *    상시 패널이면 **왼쪽 프롬프트를 보면서** 끌어다 놓을 수 있다.
 *  ★같은 정보에 창구가 둘이 되지 않게, 손패와 전체 화면 덱은 함께 걷었다.
 *
 *  두 방향 다 여기서 된다:
 *    꺼내기  카드를 끌어 프롬프트·씬으로 (`dir: "apply"`)
 *    저장    프롬프트 카드·씬 세트 머리를 끌어 이 줄에 놓으면 덱에 들어간다 (`dir: "save"`)
 */
const KINDS: CardKind[] = ["styles", "characters", "posesets"];

export function DeckPanel({
  onAsk,
  onImageDrop,
  onEditThumb,
}: {
  /** 같은 id 의 카드가 이미 있을 때 — 덮을지 새로 추가할지 묻는다 */
  onAsk: (a: {
    kind: CardKind;
    card: AnyCard;
    existing: AnyCard;
    thumb: SectionThumb | null;
  }) => void;
  /** 생성물을 덱에 놓으면 어느 카드의 그림으로 쓸지 고른다 */
  /** 생성물을 카드에 놓으면 **그 카드의 그림**이 된다 */
  onImageDrop: (kind: CardKind, card: AnyCard, img: DragImage) => void;
  /** 카드 편집기에서 **그림 자리를 다시 잡는다** — 위치 잡는 창은 `App` 이 든다 */
  onEditThumb: (kind: CardKind, card: AnyCard) => void;
}) {
  // ★스크롤로 밀려 안 보이는 카드는 그림을 못 받는다 — 각 카드 존을 이 칸으로 자른다
  //   (사용자 지시 2026-08-19: "해당 카드가 받을 수 있게 노출된 상태일 때만")
  const view = useRef<HTMLDivElement | null>(null);
  const t = useI18n((s) => s.t);
  /** ★셀렉터에서 **새 객체를 만들지 않는다** — 매 호출 새 참조를 돌려주면 React 가 무한
   *  렌더로 본다 (페로픽스파이 `ParamsPanel` 주석의 그 함정). 원시값만 따로 고른다. */
  const nStyles = useCards((s) => s.styles.length);
  const nChars = useCards((s) => s.characters.length);
  const nSets = useCards((s) => s.posesets.length);
  const counts: Record<CardKind, number> = { styles: nStyles, characters: nChars, posesets: nSets };
  /** ★★종류마다 **탭**이다 (사용자 지시 2026-08-19) — 셋을 한 줄에 쌓아 두면 카드가 늘수록
   *  아래 것이 안 보이고, 접었다 폈다로 관리하게 된다. 한 번에 한 종류만 본다. */
  /** 어느 덱을 보고 있나 — ★**저장되는 작업 상태**다 (`useUi.view.tab`, 사용자 지시 2026-08-22).
   *  새로고침하면 「스타일」로 되돌아가 있었다. */
  const tab = useUi((u) => (u.view.tab["deck"] as CardKind | undefined) ?? "styles");
  const setTab = (k: CardKind) => useUi.getState().setView("tab", "deck", k as never);
  /** 편집기가 열려 있는 카드의 id (없으면 닫힘). ★카드 **사본이 아니라 id** 를 든다 —
   *  그림 위치를 잡고 돌아왔을 때 옛 값이 화면에 남지 않게 (아래 ★주) */
  const [editing, setEditing] = useState<string | null>(null);
  const editList = useCards((s) => s[tab]) as AnyCard[];
  /** 카드를 끌기 시작하면 **그 종류의 탭으로 옮긴다** — 안 보이는 탭에는 놓을 수가 없다
   *  (캐릭터 섹션이 접혀 있으면 못 넣던 것과 같은 문제, `PromptSections`) */
  const dragKind = useDrag((s) => (s.drag?.dir === "save" ? (s.drag.kind as CardKind) : null));
  useEffect(() => {
    if (dragKind && KINDS.includes(dragKind)) setTab(dragKind);
  }, [dragKind]);
  /** ★★끌고 있는 동안 **덱 전체**가 어둠 위로 올라온다 (사용자 지적 2026-08-20:
   *  "드롭영역 전체가 밝아져야하는데, 개별 카드만 밝아져"). 안쪽 줄만 올리면 탭 줄·폴더 칩이
   *  어두운 채라 「여기가 받는 자리」로 안 읽힌다. 그림 끌기(`image`)도 이 패널이 받는다. */
  const spot = useDrag((s) => s.drag?.dir === "save" || s.drag?.dir === "image");
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        minHeight: 0,
        ...(spot ? { position: "relative" as const, zIndex: 31, background: "var(--bg)" } : {}),
      }}
    >
      <div style={{ display: "flex", gap: 2, padding: "var(--sp-2) var(--sp-3) 0", flexShrink: 0 }}>
        {KINDS.map((k) => {
          const on = tab === k;
          return (
            <button
              key={k}
              data-deck-tab={k}
              onClick={() => setTab(k)}
              style={{
                flex: 1,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                gap: 4,
                padding: "4px var(--sp-2)",
                borderRadius: "var(--r-2) var(--r-2) 0 0",
                border: "1px solid var(--line)",
                borderBottomColor: on ? "transparent" : "var(--line)",
                background: on ? "var(--surface)" : "transparent",
                color: on ? "var(--ink)" : "var(--ink-dim)",
                fontSize: "var(--text-2xs)",
                fontWeight: on ? "var(--w-semi)" : "var(--w-normal)",
              }}
            >
              {t(`cards.short.${k}`)}
              <span style={{ color: "var(--ink-ghost)", fontVariantNumeric: "tabular-nums" }}>{counts[k]}</span>
            </button>
          );
        })}
      </div>
      <div ref={view} style={{ flex: 1, minHeight: 0, overflowY: "auto", background: "var(--surface)" }}>
        {/* ★★`key` 로 **종류마다 새로 만든다** (사용자 지적 2026-08-19: 서브탭이 공용이었다) —
            React 는 같은 자리의 같은 컴포넌트를 **재활용**해서, 종류를 바꿔도 폴더 선택이
            그대로 따라왔다. */}
        <Section
          key={tab}
          kind={tab}
          onAsk={onAsk}
          onImageDrop={onImageDrop}
          onEdit={(c) => setEditing(c.id)}
          view={view}
        />
      </div>
      {/* ★★**배치했을 때의 모습 그대로** 열어 고친다 (사용자 지시 2026-08-20).
          ★목록에서 **id 로 다시 찾는다** — 편집기가 카드 사본을 들고 있으면, 그림 위치를
            잡고 돌아왔을 때 옛 값이 화면에 남는다. */}
      {editing && (() => {
        const card = (useCards.getState()[tab] as AnyCard[]).find((c) => c.id === editing);
        return card ? (
          <CardEditor
            kind={tab}
            card={editList.find((c) => c.id === editing) ?? card}
            onClose={() => setEditing(null)}
            onEditThumb={onEditThumb}
          />
        ) : null;
      })()}
    </div>
  );
}

function Section({
  kind,
  onAsk,
  onImageDrop,
  onEdit,
  view,
}: {
  kind: CardKind;
  view: React.RefObject<HTMLDivElement | null>;
  /** 연필 — 카드 편집기를 연다 */
  onEdit: (card: AnyCard) => void;
  onAsk: (a: {
    kind: CardKind;
    card: AnyCard;
    existing: AnyCard;
    thumb: SectionThumb | null;
  }) => void;
  /** 생성물을 카드에 놓으면 **그 카드의 그림**이 된다 */
  onImageDrop: (kind: CardKind, card: AnyCard, img: DragImage) => void;
}) {
  const t = useI18n((s) => s.t);
  const all = useCards((s) => s[kind]) as AnyCard[];
  const remove = useCards((s) => s.remove);
  /** ★★종류 안의 **서브탭 = 폴더** (사용자 지시 2026-08-19). 빈 값이 뿌리다.
   *  ★목록은 **카드에서 뽑는다** — 폴더는 카드에 적힌 값이라 따로 저장할 것이 없다.
   *    새로 만든 빈 폴더만 화면이 잠깐 들고 있는다 (`extra`), 카드가 들어가면 그때부터 자동이다. */
  const [extra, setExtra] = useState<string[]>([]);
  const [adding, setAdding] = useState<string | null>(null);
  const folders = [...new Set(["", ...all.map((c) => c.folder ?? ""), ...extra])];
  const [folder, setFolder] = useState("");
  const here = folders.includes(folder) ? folder : "";
  const cards = all.filter((c) => (c.folder ?? "") === here);

  /** 빈 카드를 만들고 **바로 편집기를 연다** — 만들어 놓고 어디로 갔는지 찾게 하지 않는다.
   *  ★씬 세트는 **칸 하나를 얹어** 만든다. 빈 채로 두면 갓 만든 카드가 「씬이 없는 카드」로
   *    떠서 고장처럼 보인다 (칸을 더 넣고 빼는 것은 편집기가 한다). */
  const addCard = async () => {
    /* ★★덱 카드도 **같은 이름 규칙**이다 (사용자 지시 2026-08-27) — 겹치면 번호가 붙는다.
       예전에는 여기만 규칙이 없어서 「새 스타일」이 몇 장이고 그대로 쌓였다.
       ★겹침은 **그 종류 안에서** 본다 (스타일끼리·캐릭터끼리) — 종류가 다르면 섞일 일이 없다. */
    const base = kind === "styles" ? t("cards.newStyle") : kind === "characters" ? t("cards.newChar") : t("cards.newSet");
    const name = uniqueName(base, (useCards.getState()[kind] ?? []).map((c) => c.name));
    const blank =
      kind === "styles"
        ? { name, base: [], uc: [] }
        : kind === "characters"
          ? { name, prompt: [], uc: [] }
          : { name, cells: [{ name: t("slots.newName"), blocks: [] }] };
    const saved = await useCards.getState().save(kind, { ...blank, folder: here }).catch(() => null);
    if (saved) onEdit(saved);
  };
  // ★저장 — 손패가 하던 것을 그대로 옮겼다 (그쪽 주석): 같은 id 가 이미 있으면 **묻는다**.
  //   조용히 덮으면 그 카드를 쓰는 다른 워크스페이스까지 바뀌고, 언제나 새로 추가만 하면
  //   같은 이름이 끝없이 쌓인다.
  const save = useDropZone({
    id: "deckpanel-" + kind,
    kind,
    dir: "save",
    prio: 10,
    onDrop: (d) => {
      const card = d.card;
      if (!card) return;
      // ★★있는 카드인지는 **이름으로** 본다 (사용자 지시 2026-08-19) — id 로 보던 때는
      //   같은 이름이 폴더 안에 얼마든지 쌓였다. 지금 열어 둔 폴더 안에서만 찾는다.
      const existing = useCards
        .getState()
        [kind].find((c) => (c.folder ?? "") === here && c.name === card.name);
      if (existing) onAsk({ kind, card: { ...card, folder: here }, existing, thumb: d.thumb ?? null });
      else void saveCardWithThumb(kind, { ...card, id: undefined, folder: here }, d.thumb ?? null);
    },
  });
  // ★★그림은 **카드 한 장 한 장**이 받는다 (`PanelCard`), 섹션이 아니다.
  //   예전에는 섹션이 받아 종류당 하나인 「덱 커버」가 됐는데, 그것을 그리던 손패가
  //   화면에서 빠진 뒤로 보여 주는 곳이 없어 **성공하고도 눈에는 아무 일도 없었다.**
  //   그 계통은 2026-08-19 에 통째로 걷었다 (사용자 지시: 죽은 것은 그때그때 정리).
  const over = save.over;

  return (
    <div
      ref={save.ref}
      data-deck-section={kind}
      data-over={over ? "1" : "0"}
      style={{ position: "relative", minHeight: "100%" }}
    >
      {/* ★표시는 앱 공통이다 (`DropVeil`) — 물들이고 무슨 일이 일어나는지 적는다.
          올리는 것은 **덱 전체**이고(위 `spot`), 여기서는 겹만 얹는다 */}
      {save.active && <DropVeil over={over} label={t("cards.dropDeck")} name="deck" />}
        {/* ★서브탭 — 폴더처럼 쓴다. 카드를 여기 끌어다 놓으면 **그 폴더로 옮겨진다** */}
        <div style={{ display: "flex", flexWrap: "wrap", gap: 3, padding: "var(--sp-2) var(--sp-3) 0" }}>
          {folders.map((f) => (
            <FolderTab
              key={f || "-"}
              kind={kind}
              folder={f}
              label={f || t("cards.rootFolder")}
              on={here === f}
              n={all.filter((c) => (c.folder ?? "") === f).length}
              onPick={() => setFolder(f)}
              /* ★뿌리는 못 지운다 — 폴더가 아니라 「폴더 밖」이다 */
              onDelete={
                f
                  ? () =>
                      void (async () => {
                        const n = all.filter((c) => (c.folder ?? "") === f).length;
                        if (
                          n &&
                          !(await ask({
                            title: t("cards.folderDeleteConfirm", { name: f, n }),
                            body: t("cards.folderDeleteBody"),
                            ok: t("common.delete"),
                            cancel: t("common.cancel"),
                          }))
                        )
                          return;
                        // ★카드는 **안 지운다** — 뿌리로 올린다 (폴더는 정리용 이름일 뿐이다)
                        for (const c of all.filter((x) => (x.folder ?? "") === f))
                          await useCards.getState().save(kind, { ...c, folder: "" });
                        setExtra((x) => x.filter((v) => v !== f));
                        setFolder("");
                      })()
                  : undefined
              }
            />
          ))}
          {adding === null ? (
            <button
              data-deck-newfolder
              onClick={() => setAdding("")}
              data-tip={t("cards.newFolder")}
              style={{ ...subTab, color: "var(--ink-faint)" }}
            >
              {Icon.plus}
            </button>
          ) : (
            <input
              autoFocus
              data-deck-newfolder-input
              value={adding}
              onChange={(e) => setAdding(e.target.value)}
              onBlur={() => {
                const v = adding.trim();
                if (v && !folders.includes(v)) {
                  setExtra((x) => [...x, v]);
                  setFolder(v);
                }
                setAdding(null);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !composing(e)) (e.target as HTMLInputElement).blur();
                if (e.key === "Escape") setAdding(null);
              }}
              placeholder={t("cards.newFolder")}
              style={{ ...subTab, width: 90, background: "var(--panel)", color: "var(--ink)" }}
            />
          )}
        </div>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(84px, 1fr))",
            gap: "var(--sp-3)",
            padding: "var(--sp-3) var(--sp-4) var(--sp-4)",
          }}
        >
          {cards.map((c) => (
              <PanelCard
              key={c.id}
              kind={kind}
              card={c}
              view={view}
              onDelete={() => remove(kind, c.id)}
              onImageDrop={onImageDrop}
              onEdit={onEdit}
            />
          ))}
          {/* ★★**빈 카드를 만들어 편집기를 연다** (사용자 지시 2026-08-20). 지금까지는
              끌어다 놓아야만 카드가 생겨서, 처음부터 손으로 쓰는 길이 없었다.
              ★만드는 자리는 **지금 보고 있는 폴더**다 — 만들고 나서 옮기게 하지 않는다.
              ★이름이 겹치면 저장이 `(1)` 을 붙여 새 카드로 넣는다 (`cards.save`). */}
          <button
            data-deck-newcard={kind}
            onClick={() => void addCard()}
            data-tip={t("cards.newCard")}
            style={{
              display: "grid",
              placeItems: "center",
              gap: 2,
              aspectRatio: "3 / 4",
              borderRadius: "var(--r-3)",
              border: "1px dashed var(--line)",
              color: "var(--ink-faint)",
              fontSize: "var(--text-2xs)",
            }}
          >
            {Icon.plus}
            {t("cards.newCard")}
          </button>
        </div>
    </div>
  );
}

const subTab: React.CSSProperties = {
  padding: "2px var(--sp-2)",
  borderRadius: "var(--r-1)",
  border: "1px solid var(--line)",
  background: "transparent",
  color: "var(--ink-dim)",
  fontSize: "var(--text-2xs)",
  display: "inline-flex",
  alignItems: "center",
  gap: 3,
};

/** 서브탭 한 칸 — 누르면 그 폴더를 보고, **카드를 끌어다 놓으면 그리로 옮긴다**.
 *  ★옮기는 것도 **적용 끌기와 같은 몸짓**이다 (`dir: "apply"`) — 카드에 끌기가 하나뿐이라
 *    새 몸짓을 만들면 무엇이 무엇인지 알 수 없다. */
function FolderTab({
  kind,
  folder,
  label,
  on,
  n,
  onPick,
  onDelete,
}: {
  kind: CardKind;
  folder: string;
  label: string;
  on: boolean;
  n: number;
  onPick: () => void;
  /** 없으면 지우는 단추가 안 뜬다 (뿌리) */
  onDelete?: () => void;
}) {
  const t = useI18n((s) => s.t);
  const zone = useDropZone({
    id: `deck-folder-${kind}-${folder}`,
    kind,
    prio: 30,
    onDrop: (d) => {
      const c = d.card as AnyCard | undefined;
      if (!c?.id || (c.folder ?? "") === folder) return;
      void useCards.getState().save(kind, { ...c, folder });
    },
  });
  return (
    // ★★지우는 단추는 **칩 안에** 있다 (사용자 지시 2026-08-19: 씬 세트 탭과 같은 모양).
    //   칩 밖에 붙이면 탭 사이 간격이 벌어져 어느 칩의 단추인지 흐려진다 (`CanvasTabs` 와 같다).
    // ★드롭존은 `div` 를 잡는다 (`useDropZone` 의 ref 형이 그렇다).
    <div
      ref={zone.ref}
      data-deck-folder={folder}
      onClick={onPick}
      style={{
        ...subTab,
        cursor: "pointer",
        background: zone.over ? "var(--accent-bg)" : on ? "var(--panel)" : "transparent",
        borderColor: zone.over || on ? "var(--accent)" : "var(--line)",
        color: on ? "var(--ink)" : "var(--ink-dim)",
        fontWeight: on ? "var(--w-semi)" : "var(--w-normal)",
      }}
    >
      {label}
      <span style={{ color: "var(--ink-ghost)", fontVariantNumeric: "tabular-nums" }}>{n}</span>
      {onDelete && (
        <button
          data-deck-folder-del={folder}
          data-tip={t("cards.folderDelete")}
          onClick={(e) => {
            e.stopPropagation();
            onDelete();
          }}
          style={{ color: "var(--ink-faint)", padding: 0, display: "grid" }}
        >
          {Icon.close12}
        </button>
      )}
    </div>
  );
}

/** 덱의 카드 한 장 — 끌면 프롬프트·씬에 적용된다 */
function PanelCard({
  onEdit,
  kind,
  card,
  view,
  onDelete,
  onImageDrop,
}: {
  kind: CardKind;
  card: AnyCard;
  view: React.RefObject<HTMLDivElement | null>;
  onDelete: () => void;
  onImageDrop: (kind: CardKind, card: AnyCard, img: DragImage) => void;
  /** 연필 — **카드 편집기**를 연다 (`CardEditor`) */
  onEdit: (card: AnyCard) => void;
}) {
  const t = useI18n((s) => s.t);
  const startDrag = useDragSource();
  const me = useDrag((s) => s.drag?.card?.id === card.id);
  const [hover, setHover] = useState(false);
  const fv = normThumb(card.thumb);
  /** ★생성물을 이 카드에 떨구면 **이 카드의 그림**이 된다 (사용자 결정 2026-08-19).
   *  ★`clip` 으로 **덱 칸에 보이는 만큼만** 받는다 — 스크롤로 밀려 안 보이는 카드가
   *    자기 자리에서 계속 받으면, 덱 밖에 떨군 것이 엉뚱한 카드에 걸린다. */
  const drop = useDropZone({
    id: "deckcard-" + card.id,
    kind: "image",
    dir: "image",
    prio: 20,
    clip: view,
    onDrop: (d) => d.img && onImageDrop(kind, card, d.img),
  });

  /* ★★조수가 만들거나 고친 카드를 **강조한다** (`lib/agentAt` 의 `card:<id>`).
     예전에는 `reveal` 만 부르고 **읽는 곳이 없어** 덱만 열리고 어느 카드인지 몰랐다
     (사용자 지적 2026-08-25: *"강조 효과가 존재하는 프롬프트창만 강조"*). */
  const card_ = useFlashAt<HTMLDivElement>(`card:${card.id}`);
  return (
    <div
      /* ★두 자리가 같은 요소를 부른다 — 떨괴 받는 자리(`drop`)와 조수가 고친
           카드로 데려가는 자리(`card_`). 한쪽만 달면 다른 한쪽이 조용히 안 돈다. */
      ref={(el) => {
        drop.ref.current = el;
        card_.ref.current = el;
      }}
      data-deck-card={card.id}
      data-over={drop.over ? "1" : "0"}
      // ★지우기 단추는 **끌기에서 비켜 간다** — pointerdown 의 기본 동작 막기가 호환 click 을
      //   삼켜서, 안 비키면 단추가 통째로 죽는다 (CLAUDE.md 「잊기 쉬운 것」)
      onPointerDown={(e) => {
        if ((e.target as HTMLElement).closest("[data-card-del],[data-card-rename]")) return;
        startDrag(e, { dir: "apply", kind, card });
      }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        position: "relative",
        aspectRatio: "3 / 4",
        borderRadius: "var(--r-3)",
        overflow: "hidden",
        /* ★잘린 자리에 드러나는 **단색** — 배너 오른쪽과 같은 색이다 (`BANNER_BG`) */
        background: BANNER_BG,
        ...flashStyle(card_.on),
        border: `1px solid ${drop.over ? "var(--accent)" : "var(--line)"}`,
        cursor: "grab",
        opacity: me ? 0.35 : 1,
        transform: hover ? "translateY(-2px)" : undefined,
        boxShadow: hover ? "0 4px 12px rgba(0,0,0,0.3)" : undefined,
        transition: "transform 0.14s ease, box-shadow 0.14s ease",
        ...dragSourceStyle,
      }}
    >
      {/* ★★배너와 **같은 3단**이다 — 그림 → 중간 단 → 오른쪽 단색.
          다만 경계는 **수직**이고 단색 띠는 **얇다** (사용자 지시 2026-08-20).
          이름은 배너처럼 **밝은 쪽**에 앉고, 오른쪽 단색 위에 단추가 뜬다. */}
      <div
        style={{
          position: "absolute",
          inset: 0,
          maskImage: COVER_CUT,
          WebkitMaskImage: COVER_CUT,
          background: artBackground(card.color),
        }}
      >
        {/* 덱 오버레이와 **같은 그림**이다 — 배너·커버가 공유하는 고정 썸네일(tid) */}
        {fv && <FittedImg url={thumbUrl(useGen.getState().base, fv)} w={110} h={146} view={fv.face} />}
        {/* 중간 단 — 잘리기 전 구간을 한 번 어둡게 눕힌다 (배너와 같은 값) */}
        <div style={{ position: "absolute", inset: 0, background: COVER_STEP }} />
      </div>
      {/* 이름이 그림 위에서도 읽히게 — 배너와 같은 스크림 */}
      <div style={{ position: "absolute", inset: 0, pointerEvents: "none", background: BANNER_SCRIM }} />
      {/* ★그림을 받는 자리도 **같은 표시**다 (`DropVeil`) */}
      {drop.active && <DropVeil over={drop.over} label={t("cards.dropThumb")} name="thumb" />}
      <div
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          bottom: 0,
          /* ★이름은 배너와 같이 **왼쪽 아래·밝은 쪽**에 앉는다. 바탕은 위의 스크림이 깐다 */
          padding: "10px 5px 4px",
          color: "#fff",
          /* ★★**보조 글자 토큰으로 올렸다** (사용자 지시 2026-08-22: *"카드덱에 표시되는 카드
               이름이 폰트가 너무 작음"*). 0.62rem(≈10px)은 화면의 어느 글자보다도 작아서,
               토큰 밖의 값이면서 읽기도 어려웠다. `--text-2xs`(12px)는 이 앱이 힌트·메타에
               쓰는 **가장 작은 글자**라, 더 줄일 자리가 아니라는 뜻이기도 하다.
             ★칸이 84px 이라 그만큼 **일찍 말줄임**된다. 이름을 더 보이려면 두 줄로 풀어야
               하는데 그건 칸 모양이 달라지는 일이라 여기서 하지 않았다. */
          /* ★★**세 자리의 카드 이름을 하나로 맞췄다** (사용자 지시 2026-08-25).
             프롬프트는 13.8/bold, 덱은 12/semi, 씬은 12.8/bold 로 갈려 있었다 —
             같은 카드인데 화면마다 다른 물건으로 보였다.
             ★칸이 84px 이라 **말줄임이 조금 일찍** 온다. 이름을 더 보이려면 칸을 넓히거나
               두 줄로 푸는 쪽이지, 이 자리만 글자를 줄이는 쪽이 아니다. */
          ...TYPE.cardName,
          lineHeight: 1.2,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {/* ★이름을 **칸 안에서** 고치던 입력칸은 걷었다 (사용자 지시 2026-08-20) —
            이름도 내용도 **편집기 하나**에서 고친다. 창구가 둘이면 어디서 고쳤는지가 흐려진다. */}
        {card.name}
      </div>
      {/* ★★끌기 손잡이 아이콘을 걷고 그 자리에 **지우기**를 뒀다 (사용자 지시 2026-08-19).
          카드는 통째로 잡아 끄는 것이라 손잡이가 없어도 끌리는 줄 알고, 지우는 방법은
          **우클릭뿐이라 보이지 않았다.** 보이는 단추가 하나 필요한 자리였다. */}
      {hover && (
        <button
          data-card-rename={card.id}
          data-tip={t("cards.edit")}
          onPointerDown={(e) => e.stopPropagation()}
          /* ★★**편집기를 연다** (사용자 지시 2026-08-20) — 예전에는 이름만 그 자리에서
             고쳤다. 카드에 무엇이 들었는지 볼 길이 없어, 꺼내 놓아 보고 되돌리는 수밖에
             없었다. 지금은 **배치했을 때의 모습 그대로** 열려 내용까지 고친다 (`CardEditor`). */
          onClick={(e) => {
            e.stopPropagation();
            onEdit(card);
          }}
          style={{
            position: "absolute",
            top: 3,
            right: 25,
            display: "grid",
            placeItems: "center",
            width: 18,
            height: 18,
            borderRadius: "var(--r-1)",
            background: "rgba(10,14,20,0.55)",
            color: "#fff",
          }}
        >
          {Icon.pencil}
        </button>
      )}
      {hover && (
        <button
          data-card-del={card.id}
          data-tip={t("common.delete")}
          onClick={(e) => {
            e.stopPropagation();
            void (async () => {
              if (
                await ask({
                  title: t("cards.deleteConfirm", { name: card.name }),
                  body: t("common.toTrash"),
                  ok: t("common.delete"),
                  cancel: t("cards.cancel"),
                })
              )
                onDelete();
            })();
          }}
          style={{
            position: "absolute",
            top: 3,
            right: 3,
            display: "grid",
            placeItems: "center",
            width: 18,
            height: 18,
            borderRadius: "var(--r-1)",
            background: "rgba(10,14,20,0.55)",
            color: "#fff",
          }}
        >
          {Icon.close12}
        </button>
      )}
    </div>
  );
}
