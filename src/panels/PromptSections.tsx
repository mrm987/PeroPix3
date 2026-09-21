import { useEffect } from "react";
import { useI18n } from "../i18n";
import { Icon } from "../components/Icon";
import { BlockList } from "../blocks/BlockList";
import { BannerBtn, SectionCard } from "../blocks/SectionCard";
import {
  usePrompt,
  ucHasContent,
  thumbFromCard,
  thumbUrl,
  type Char,
  type Thumb,
} from "../store/prompt";
import type { DragImage } from "../cards/dragStore";
import { toggleCharCapped, useGen } from "../store/gen";
import { useUi } from "../store/ui";
import { useDropZone, useDragSource, useDrag } from "../cards/dragStore";
import { flashStyle, useFlashAt } from "../store/ui";
import { TYPE } from "../styles/type";
import { applyCard, dropStyleCard } from "../lib/applyCard";
import { zoneIcon } from "../cards/CardArt";
import { DropVeil } from "../cards/DropVeil";
import type { Block } from "../lib/blocks";
import type { CharCard, StyleCard } from "../store/cards";
import { pickStyleOpts } from "../lib/styleOpts";
import { PromptOptsBar } from "./PromptOpts";

/** 프롬프트 섹션들 — 스타일(공통) 하나 + 캐릭터 여럿.
 *  NAI 요청 구조 그대로다: 공통 `prompt/uc` 한 벌 + `characterPrompts[]`. */


/** 섹션이 위쪽(App)에 되돌리는 것 — 썸네일 위치를 잡는 창은 화면 맨 위에 떠야 한다.
 *  원본 이미지 정보만 넘긴다. 축소 사본 저장은 위치를 정한 뒤(App)에 한다 */
export type SectionProps = { onThumb: (section: string, img: DragImage) => void };

/** 저장된 Thumb 을 배너에 그릴 형태로 — 배너용 보는 방식(banner)을 쓴다 */
export function useThumbView(thumb: Thumb | null) {
  const base = useGen((s) => s.base);
  if (!thumb) return null;
  return { url: thumbUrl(base, thumb), ...thumb.banner };
}

/** 배너를 **생성물 드롭 대상**으로 만든다 — 끌어다 놓으면 위치 잡는 창이 뜬다.
 *  ★섹션은 픽셀을 갖지 않고 "어느 파일을 어떻게 볼지"만 갖는다 (Thumb). */
function useThumbDrop(section: string, onAsk: (img: DragImage) => void) {
  const zone = useDropZone({
    id: `thumb-${section}`,
    kind: "image",
    dir: "image",
    prio: 5,
    onDrop: (d) => d.img && onAsk(d.img),
  });
  return zone;
}

/* ── 스타일 섹션 = Base ───────────────────────────────────────── */
export function StyleSection({ onThumb }: SectionProps) {
  /* ★★훅은 **이른 반환보다 위**에 둔다 (`hooksInJsx` 와 같은 함정, 2026-08-25 에 밟았다).
     아래에 「카드를 뺐으면 단추만」 갈래가 있어서, 그 뒤에 훅을 두면 렌더마다 훅 개수가
     달라져 **화면이 통째로 죽는다** (*"Rendered fewer hooks than expected"*).
     ★열쇠는 `lib/agentAt` 이 만드는 말과 같아야 한다: `prompt:base`. */
  const base_ = useFlashAt<HTMLDivElement>("prompt:base");
  const t = useI18n((s) => s.t);
  const { base, baseUc, style, styleOn, setStyleOn, update, setStyle } = usePrompt();
  /** 접힘은 **저장되는 작업 상태**다 (`useUi.view.fold`) — 탭을 옮겨도 새로고침해도 남는다 */
  const folded = useUi((u) => u.view.fold);
  const toggleFold = (id: string) => useUi.getState().setView("fold", id, !useUi.getState().view.fold[id]);
  const startDrag = useDragSource();

  const { ref, over, active } = useDropZone({
    id: "sec-style",
    kind: "styles",
    /* ★★꽂는 규칙은 **공용 함수 하나**다 (`lib/applyCard`, 2026-08-24) — 조수가
       «저장해 둔 그 그림체로» 를 받을 때 **같은 것**을 부른다. 여기 규칙을 되살리지 말 것:
       두 벌이 되면 끌어다 놓은 것과 조수가 꽂은 것이 달라진다. */
    onDrop: (d) => void dropStyleCard(d.card as StyleCard),
  });
  const img = useThumbDrop("base", (di) => onThumb("base", di));
  /** ★★훅은 **JSX 안에서 부르지 않는다** (사용자 지적 2026-08-19: 스타일 카드를 빼면 화면이
   *  통째로 멈췄다). 아래에 「카드를 뺐으면 단추만」 갈래가 생기면서, JSX 안에 있던 이 훅이
   *  그때는 안 돌아 **훅 개수가 렌더마다 달라졌다** — React 가 그 자리에서 죽는다. */
  const thumbView = useThumbView(style.thumb);

  /** ★스타일 카드를 끌기 시작하면 **접힌 것을 편다** (사용자 지적 2026-08-19: 둘 다 접혀
   *  있으면 아예 못 넣었다). 캐릭터 섹션과 같은 규칙 — 놓을 자리가 보여야 놓는다. */
  useEffect(() => {
    if (active && folded["base"]) toggleFold("base");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  // ★뺀 상태 — 캐릭터가 없을 때와 **같은 모양의 추가 단추**다 (`PromptPanel` 의 「캐릭터 추가」)
  // ★★**이 자리도 카드를 받는다** (사용자 지적 2026-08-20: 카드가 없으면 스타일 카드를
  //   떨굴 수가 없었다). 드롭존의 ref 는 카드에만 붙어 있어서, 카드를 뺀 화면에는 받는
  //   요소가 아예 없었다 — 끌어와도 아무 일이 없다. 단추를 감싼 칸이 그 자리를 대신한다.
  if (!styleOn)
    return (
      <div
        ref={ref}
        style={{
          marginBottom: "var(--sp-5)",
          borderRadius: "var(--r-3)",
          /* ★어둠 위로 올리는 것은 **묶음 전체**다 (`Category` 의 `spot`) — 여기서는
             빈 자리를 **밝은 판**으로 바꾸기만 한다 (밝힐 내용이 없는 자리라서) */
        }}
      >
        <button
          data-add-style
          onClick={() => setStyleOn(true)}
          style={{
            width: "100%",
            padding: "var(--sp-3)",
            border: "1px dashed var(--line)",
            borderRadius: "var(--r-3)",
            fontSize: "var(--text-2xs)",
            /* ★여기는 **밝힐 내용이 없는 빈 자리**라 판 자체가 밝아진다. 그 위에 오면
               다른 자리와 **같은 알약**이 뜬다 (`DropVeil` 과 같은 말투) */
            color: over ? "var(--accent-on)" : "var(--ink-faint)",
            fontWeight: over ? "var(--w-semi)" : "var(--w-normal)",
            background: active ? (over ? "var(--accent)" : "var(--surface)") : "transparent",
            boxShadow: active ? "0 2px 10px rgba(0,0,0,0.35)" : undefined,
          }}
        >
          {over ? t("cards.dropStyleNew") : t("cards.addStyle")}
        </button>
      </div>
    );

  return (
    /* ★★**조수가 고친 자리를 강조한다** (사용자 지적 2026-08-25: *"스타일·캐릭터·씬을
       눌렀는데 하단의 생성 설정쪽을 강조함"*). 프롬프트 섹션에는 강조 표식이 **아예 없어서**
       `openAt` 이 갈 곳을 못 찾고 `params`(생성 설정)로 떨어졌다.
       ★열쇠는 `lib/agentAt` 이 만드는 것과 **같은 말**이어야 한다: `prompt:base`. */
    <div ref={base_.ref} style={flashStyle(base_.on)}>
    <SectionCard
      innerRef={(el) => {
        ref.current = el;
        img.ref.current = el;
      }}
      name={style.name}
      /* ★스타일 카드에는 이름 바꾸기가 아예 없었다 (사용자 지적 2026-08-19) */
      onRename={(v) => setStyle({ ...style, name: v })}
      renameTip={t("cards.rename")}
      /* ★★스타일 카드도 **뺄 수 있다** (사용자 지시 2026-08-19) — 캐릭터 카드와 같은 자리에
         같은 단추다. 빼면 베이스 프롬프트·UC 가 안 나가고, 그 자리에 「추가」가 선다.
         ★적어 둔 블록은 **안 지운다** — 되돌리면 그대로 있어야 한다 (`setStyleOn` 주석). */
      bannerActions={
        <BannerBtn title={t("cards.removeStyle")} onClick={() => setStyleOn(false)}>
          {Icon.close12}
        </BannerBtn>
      }
      gradient={style.color}
      thumb={thumbView}
      overlay={
        active ? (
          <DropVeil over={over} label={t("cards.dropStyle")} name="style" />
        ) : img.active ? (
          <DropVeil over={img.over} label={t("cards.dropThumb")} name="thumb" />
        ) : null
      }
      zone="thumb-base"
      folded={!!folded["base"]}
      onFold={() => toggleFold("base")}
      hoverLift
      outline={
        active ? (over ? "solid" : "dashed") : img.active ? (img.over ? "solid" : "dashed") : "none"
      }
      onBannerPointerDown={(e) =>
        startDrag(e, {
          dir: "save",
          kind: "styles",
          // ★프롬프트가 되는 넷을 함께 담는다 (`lib/styleOpts`)
          card: { id: style.ref ?? "", name: style.name, color: style.color, base, uc: baseUc,
                  opts: pickStyleOpts(useGen.getState().params) },
          thumb: style.thumb,
        }, undefined, () => toggleFold("base"))
      }
    >
      <SectionBody
        id="base"
        prompt={base}
        uc={baseUc}
        onPrompt={(b) => update("base", () => b)}
        onUc={(b) => update("baseUc", () => b)}
        /* ★★프롬프트가 되는 설정들은 **글 칸 하단**에 붙는다 (`PromptOpts` 의 ★주) —
           공홈과 같은 자리이고, 스타일 카드가 담는 것도 이 넷이다 (`lib/styleOpts`). */
        footer={(showUc) => <PromptOptsBar uc={showUc} />}
      />
    </SectionCard>
    </div>
  );
}

/* ── 캐릭터 섹션 ──────────────────────────────────────────────── */
export function CharSection({
  ch,
  index,
  last,
  onThumb,
}: { ch: Char; index: number; /** 맨 아래 카드인가 — 아래 단추를 흐리게 한다 */ last: boolean } & SectionProps) {
  const t = useI18n((s) => s.t);
  const { updateChar, swapChar, removeChar, renameChar, stepChar } = usePrompt();
  const folded = useUi((u) => u.view.fold);
  const toggleFold = (id: string) => useUi.getState().setView("fold", id, !useUi.getState().view.fold[id]);
  const startDrag = useDragSource();
  const active = useDrag((s) => s.drag?.kind === "characters" && s.drag.dir === "apply");

  /* ★★**받는 자리는 둘이다: 교체 · 새로 추가** (2026-09-15 에 스택이 빠졌다).
     2026-08-20 에 교체를 걷으면서 든 근거 *"새로 추가하고 옛 카드를 지우는 것과 결과가 같다"* 는
     틀렸다 — 새로 추가하면 차례가 맨 뒤로 가고 자리 좌표도 새로 잡히는데, 교체는 **그 자리
     그대로** 사람만 갈린다 (`swapChar` 의 ★주).
     ★★한때 카드 위 1/3 이 **스택**(순차 생성 대기줄)이었다. 순차 생성이 모드로 바뀌면서
       (`usePrompt.seqChars`) 그 자리가 필요 없어졌고, 카드 전체가 교체를 받는다 —
       반쪽만 받던 때보다 겨냥하기 쉽다. */
  const swap = useDropZone({
    id: `sec-char-${ch.id}-swap`,
    kind: "characters",
    prio: 2,
    onDrop: (d) => {
      const c = d.card as CharCard;
      swapChar(ch.id, {
        ref: c.id,
        name: c.name,
        color: c.color,
        prompt: c.prompt,
        uc: c.uc,
        thumb: thumbFromCard(c.thumb),
      });
    },
  });

  const img = useThumbDrop(ch.id, (di) => onThumb(ch.id, di));
  /** ★훅은 JSX 안에서 부르지 않는다 (`StyleSection` 의 같은 주석 — 갈래가 생기면 그 자리에서 죽는다) */
  const thumbView = useThumbView(ch.thumb);

  /** ★★캐릭터 카드를 끌기 시작하면 **접힌 것을 편다** (사용자 지시 2026-08-19).
   *  접으면 배너만 남고, 놓는 자리(위=스택·아래=교체)가 그 안에서 반씩 나뉘어 손톱만 해진다 —
   *  사실상 못 넣는 상태였다. 편 채로 두는 것이 맞다: 어디에 놓는지가 보여야 한다. */
  useEffect(() => {
    if (active && folded[ch.id]) toggleFold(ch.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  /* ★★강조 열쇠는 **id 와 이름 둘 다** 본다 — 조수는 사람이 부르는 **이름**으로 자리를
     가리키는데(`edit_style_card`·`edit_character` 가 내는 `at.area`), 화면이 아는 것은 id 다.
     ★훅을 두 번 부르지 않는다: `||` 로 이으면 뒤엣것이 **조건부 호출**이 된다. */
  const char_ = useFlashAt<HTMLDivElement>([`prompt:${ch.id}`, `prompt:${ch.name}`]);
  const name = ch.name || t("cards.charN", { n: index + 1 });
  return (
    <>
      {/* ★조수가 이 인물을 고쳤으면 여기를 강조한다 (`lib/agentAt` 의 `prompt:<id>`) */}
      <div ref={char_.ref} style={flashStyle(char_.on)}>
      <SectionCard
        innerRef={(el) => (img.ref.current = el)}
        name={name}
        gradient={ch.color}
        thumb={thumbView}
        zone={`thumb-${ch.id}`}
        folded={!!folded[ch.id]}
        onFold={() => toggleFold(ch.id)}
        dim={!ch.on}
        outline={
          active ? "dashed" : img.active ? (img.over ? "solid" : "dashed") : "none"
        }
        onBannerPointerDown={(e) =>
          startDrag(e, {
            dir: "save",
            kind: "characters",
            card: { id: ch.ref ?? "", name, color: ch.color, prompt: ch.prompt, uc: ch.uc },
            thumb: ch.thumb,
          }, undefined, () => toggleFold(ch.id))
        }
        /* ★이름은 **카드 안에서** 고친다 (사용자 지시 2026-08-19) — 시스템 `prompt()` 창을
           띄우던 자리다. 연필 단추는 `SectionCard` 가 스스로 단다. */
        onRename={(v) => renameChar(ch.id, v)}
        renameTip={t("cards.rename")}
        /* ★★차례 바꾸기는 **위아래 단추**이고, 자리는 **이름변경 앞**이다
           (사용자 지시 2026-08-21).
           끌기로 만들었다가 걷었다: 배너를 끄는 것은 이미 **덱에 저장**이라
           (`onBannerPointerDown`) 같은 몸짓이 두 가지 뜻을 갖게 된다.
           ★자리 좌표는 인물이 들고 다니므로 따로 옮기는 코드를 두지 말 것. */
        bannerLead={
          <>
            <BannerBtn
              title={t("cards.moveCharUp")}
              off={index === 0}
              mark="data-char-up"
              onClick={() => stepChar(ch.id, -1)}
            >
              {Icon.chevronUp12}
            </BannerBtn>
            <BannerBtn
              title={t("cards.moveCharDown")}
              off={last}
              mark="data-char-down"
              onClick={() => stepChar(ch.id, 1)}
            >
              {Icon.chevronDown12}
            </BannerBtn>
          </>
        }
        bannerActions={
          <>
            {/* ★아이콘은 언제나 SVG (CLAUDE.md) — 여기는 `● ○ × ✎` 글자를 쓰고 있었다 */}
            <BannerBtn
              title={ch.on ? t("block.toggleOff") : t("block.toggleOn")}
              /* ★켜기는 모델 상한에 막힌다 (V4.5 6명 · V5 32명). 끄기는 언제나 된다 */
              onClick={() => toggleCharCapped(ch.id)}
            >
              {ch.on ? Icon.dotOn : Icon.dotOff}
            </BannerBtn>
            <BannerBtn title={t("cards.removeChar")} onClick={() => removeChar(ch.id)}>
              {Icon.close12}
            </BannerBtn>
          </>
        }
        hoverLift
        overlay={
          // ★카드 전체가 **교체**를 받는다 (위 ★★주). 표시는 앱 전체 공통이다 (`DropVeil`)
          active ? (
            <DropVeil innerRef={swap.ref} over={swap.over} label={t("cards.dropSwap")} name="swap" />
          ) : img.active ? (
            <DropVeil over={img.over} label={t("cards.dropThumb")} name="thumb" />
          ) : null
        }
      >
        <SectionBody
          id={ch.id}
          prompt={ch.prompt}
          uc={ch.uc}
          onPrompt={(b) => updateChar(ch.id, "prompt", () => b)}
          onUc={(b) => updateChar(ch.id, "uc", () => b)}
        />
      </SectionCard>
      </div>
    </>
  );
}

/** 캐릭터 카드를 **새 슬롯으로** 받는 자리 — 같이 등장하는 인원이 는다.
 *  캐릭터 드래그 중에만 나타난다. */
export function JoinZone() {
  const t = useI18n((s) => s.t);
  const { ref, over, active } = useDropZone({
    id: "char-join",
    kind: "characters",
    prio: 1,
    onDrop: (d) => applyCard("characters", d.card as CharCard),
  });
  if (!active) return null;
  return (
    <div
      ref={ref}
      data-zone="join"
      style={{
        position: "relative",
        margin: "0 0 var(--sp-5)",
        height: 46,
        borderRadius: 12,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontSize: "var(--text-2xs)",
        fontWeight: "var(--w-bold)",
        boxSizing: "border-box",
        /* ★★여기는 **아직 아무것도 없는 자리**라 밝힐 내용이 없다 — 그래서 판 자체가
           밝다 (사용자 지시 2026-08-20: 어둡게 덮는 방식을 쓰지 않는다).
           어둠 위에 뜬 밝은 칸이 곧 「여기에 새로 넣는다」다. */
        gap: "var(--sp-2)",
        color: over ? "var(--accent-on)" : "var(--ink)",
        background: over ? "var(--accent)" : "var(--surface)",
        boxShadow: "0 2px 10px rgba(0,0,0,0.35)",
      }}
    >
      {zoneIcon.add(20)}
      {/* ★그 위에 오면 **무슨 일이 일어나는지** 적는다 — 다른 자리와 같은 말투다 */}
      {over && <span style={{ fontSize: "var(--text-xs)" }}>{t("cards.dropJoin")}</span>}
    </div>
  );
}

/* ── 조각 ─────────────────────────────────────────────────────── */


/** 섹션 본문 — Prompt / Undesired Content 탭 짝 + 블록 목록.
 *  ★UC 에 내용이 있으면 탭 이름이 빨개진다 (v2.x 동작 계승). */
export function SectionBody({
  id,
  prompt,
  uc,
  onPrompt,
  onUc,
  footer,
}: {
  id: string;
  prompt: Block[];
  uc: Block[];
  onPrompt: (b: Block[]) => void;
  onUc: (b: Block[]) => void;
  /** 글 칸 **아래에 붙는 줄**. 지금 보고 있는 탭을 받아 내용을 고른다 (스타일 섹션의 프리셋 띠) */
  footer?: (showUc: boolean) => React.ReactNode;
}) {
  const t = useI18n((s) => s.t);
  /** `Prompt`/`UC` 중 무엇을 보고 있나 — **저장되는 작업 상태**다 (`useUi.view.tab`) */
  const tab = useUi((u) => u.view.tab[id] ?? "p");
  const setTab = (sec: string, v: "p" | "u") => useUi.getState().setView("tab", sec, v);
  const ucFull = ucHasContent(uc);
  const showUc = tab === "u";

  return (
    <>
      <div style={{ display: "flex", gap: "var(--sp-5)", marginLeft: 10 }}>
        <Tab on={!showUc} onClick={() => setTab(id, "p")}>
          {t("prompt.tabPrompt")}
        </Tab>
        <Tab on={showUc} onClick={() => setTab(id, "u")} full={ucFull}>
          {t("prompt.tabUc")}
        </Tab>
      </div>
      {/* ★존 id 에 **지금 보고 있는 탭**을 넣는다 — 프롬프트와 UC 는 같은 자리에 겹쳐
          뜨므로, id 가 같으면 UC 를 보는 중에 프롬프트 쪽으로 떨어질 수 있다 */}
      <BlockList
        blocks={showUc ? uc : prompt}
        onChange={showUc ? onUc : onPrompt}
        libZone={`${id}-${showUc ? "uc" : "p"}`}
      />
      {footer?.(showUc)}
    </>
  );
}

function Tab({
  on,
  full,
  onClick,
  children,
}: {
  on: boolean;
  full?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  const t = useI18n((s) => s.t);
  return (
    <button
      onClick={onClick}
      data-tip={full ? t("prompt.ucHasContent") : undefined}
      style={{
        padding: "2px 1px 3px",
        /* ★★**딱지 층이 아니다** (사용자 지적 2026-08-25: *"왜 카드의 프롬프트, UC
             컨텐츠 텍스트가 이 층위에 묶인 거 같지? 얘들은 원래 더 컸는데"*).
             크기를 계층으로 옮길 때 0.72rem(≈11.5px) 을 `--text-3xs` 로 보냈는데,
             그 층은 딱지(● CLI · 머리글)라 이후 조절을 그대로 따라가 작아졌다.
             이것은 **고를 수 있는 것의 이름**이므로 곁들이는 값(`meta`) 크기를 쓴다. */
        fontSize: TYPE.meta.fontSize,
        fontWeight: on ? "var(--w-bold)" : "var(--w-normal)",
        color: full ? "var(--uc-c)" : on ? "var(--ink)" : "var(--ink-soft)",
        borderBottom: `2px solid ${on ? (full ? "var(--uc-c)" : "var(--accent)") : "transparent"}`,
      }}
    >
      {children}
    </button>
  );
}
