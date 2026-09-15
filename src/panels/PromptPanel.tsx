import { useI18n } from "../i18n";
import { useState } from "react";
import { compileBlocks, makeBlock } from "../lib/blocks";
import { usePrompt } from "../store/prompt";
import { canEnableChar } from "../store/gen";
import { StyleSection, CharSection, JoinZone, type SectionProps } from "./PromptSections";
import { BlockLibButton } from "../blocks/BlockDrawer";
import { TagSearchButton } from "../blocks/TagDrawer";
import { WildcardButton } from "./WildcardModal";
import { TranslateButton } from "./TranslateButton";
import { OptionsPanel } from "./OptionsPanel";
import { Category } from "./Category";
import { CharPositionToggle, CharStackedWarning } from "./CharPositioner";
import { useDrag } from "../cards/dragStore";
import { QueueLanes } from "./QueueLanes";
import { Icon } from "../components/Icon";

/** 좌측 패널 — 카드형 섹션 안에 블록 시퀀스.
 *  스타일 섹션(= NAI 의 공통 prompt/uc) 하나 + 캐릭터 섹션 여럿(= characterPrompts[]). */
export function PromptPanel({ onThumb }: SectionProps) {
  const { base, baseUc, chars, addChar } = usePrompt();
  /** ★★끌고 있는 동안 **그 묶음 전체**가 어둠 위로 올라온다 (사용자 지적 2026-08-20).
   *  카드마다 올리면 카드 사이 여백이 어두운 채라 「영역」으로 안 읽힌다.
   *  ★그림 끌기(`image`)는 두 묶음 다 받는다 — 카드 배너에 꽂는 그림이라 어느 쪽이든 될 수 있다. */
  const dragKind = useDrag((s) => (s.drag?.dir === "apply" ? s.drag.kind : null));
  const dragImg = useDrag((s) => s.drag?.dir === "image");
  const t = useI18n((s) => s.t);
  const [preview, setPreview] = useState(false);

  return (
    // ★`height: 100%` 가 아니라 `flex: 1` 이다 — 아래에 생성 푸터가 형제로 붙으므로,
    //   100% 를 잡으면 푸터가 화면 밖으로 밀려난다 (실측 2026-08-04)
    <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
      <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "var(--sp-4) var(--sp-4) 0" }}>
        {/* ★그릇 이름은 **payload 의 어느 칸인가**, 카드 이름은 **무엇을 저장하는가**
            (사용자 지시 2026-08-11). 그래서 베이스만 쓰는 사람은 카드를 안 꽂고 그 칸에 바로
            적으면 되고, 스타일을 저장해 두는 사람은 「스타일 카드」로 알아본다.
            ★그릇은 **평면**(이름표만)이고 그 안에 얹히는 **카드가 둥글다** — 씬 칸과 같은 규칙. */}
        {/* ★프롬프트 전체에 걸리는 도구 둘을 여기 모은다 (v2 도 프롬프트 라벨 줄에 있었다):
            와일드카드(랜덤 풀) · 블록 저장소. 카테고리마다 흩뿌리지 않는다 */}
        <Category
          id="p-base"
          spot={dragKind === "styles" || dragImg}
          /* ★★설정을 불러오면 **카드도 통째로 갈린다** — 그 자리도 펴고 강조한다
             (사용자 지적 2026-08-19: 카드가 바뀌는데 강조가 없었다).
             `applyMeta`·설정 불러오기가 `reveal("left", "prompt")` 를 부른다. */
          flashKey="prompt"
          label={t("prompt.baseBox")}
          right={
            <span style={{ display: "inline-flex", alignItems: "center", gap: 2 }}>
              <TranslateButton />
              <WildcardButton />
              <BlockLibButton />
              <TagSearchButton />
            </span>
          }
        >
          <StyleSection onThumb={onThumb} />
        </Category>

        <Category
          id="p-char"
          label={t("prompt.charBox")}
          flashKey="prompt"
          spot={dragKind === "characters" || dragImg}
          /* ★좌표 2택은 **여기** 선다 (사용자 지시 2026-08-21) — 공홈도 캐릭터 프롬프트
             패널에 둔다 (`dg()`). 판 자체는 큰 그림 위에 겹친다 (`Canvas` 의 `ScenePreview`).
             ★★여기에 **더 얹지 않는다** (사용자 지적 2026-09-15: *"캐릭터 프롬프트 텍스트
               표시될 자리가 너무 좁은데"*). 좌표 2택만으로 162px 를 쓰는데 이름 줄 안쪽이
               341px 라(실측), 순차 생성 단추 62px 를 더하니 이름에 남는 자리가 85px 가 되어
               「캐릭터 프롬프트」 94px 가 두 줄로 갈렸다. 순차 생성은 아래 `SeqCharsFrame` 이 맡는다. */
          right={<CharPositionToggle />}
        >
          <SeqCharsFrame>
            <CharStackedWarning />
            {/* ★★인물의 **차례**가 곧 `characterPrompts[]`·`char_captions[]` 의 차례이고
                NAI 가 `use_order: true` 로 그 차례를 쓴다 (`backend/nai.py`) — 그림에 남는 값이다.
                바꾸는 것은 배너의 **위아래 단추**다 (`CharSection`). */}
            {chars.map((ch, i) => (
              <CharSection key={ch.id} ch={ch} index={i} last={i === chars.length - 1} onThumb={onThumb} />
            ))}

            <JoinZone />

            <button
              /* ★자리가 없으면 **꺼진 채로** 만든다 — 칸을 만드는 것은 막지 않고,
                 나가는 수만 모델 상한에 맞춘다 (`store/gen.ts` 의 `canEnableChar`) */
              /* ★★**빈 블록 하나를 깔아 준다** (사용자 지시 2026-09-04). 예전에는 칸만 서고
                 블록이 0개라, 인물을 더한 사람이 「블록 추가」를 한 번 더 눌러야 적을 수 있었다.
                 ★블록 추가 단추가 만드는 것과 **같은 모양**이다 (`BlockList` 의 `data-block-add`) —
                   이름도 「새 블록」이고 펼친 채로 선다. 둘이 다르면 어느 쪽이 진짜인지 헷갈린다. */
              onClick={() => addChar({ on: canEnableChar(), prompt: [makeBlock(t("block.newBlock"), [], { open: true })] })}
              style={{
                width: "100%",
                padding: "var(--sp-3)",
                border: "1px dashed var(--line)",
                borderRadius: "var(--r-3)",
                fontSize: "var(--text-2xs)",
                color: "var(--ink-faint)",
                background: "transparent",
              }}
            >
              {t("cards.addChar")}
            </button>
          </SeqCharsFrame>
        </Category>

        {/* ★생성 옵션이 **프롬프트 바로 아래**에 산다 (사용자 지시 2026-08-16).
            오른쪽 기둥은 카드덱이 쓴다. 묶음마다 이름을 누르면 접힌다. */}
        <div style={{ height: 1, background: "var(--line)", margin: "0 0 var(--sp-4)" }} />
        <OptionsPanel />
      </div>

      {/* ★돌고 있는 계정(차선)마다 한 줄 — 최종 프롬프트 바로 위 (사용자 지시 2026-09-02) */}
      <QueueLanes />

      {/* 최종 프롬프트 미리보기 */}
      <div
        style={{ flexShrink: 0, borderTop: "1px solid var(--line)" }}
      >
        <button
          onClick={() => setPreview((v) => !v)}
          style={{
            width: "100%",
            display: "flex",
            alignItems: "center",
            gap: "var(--sp-2)",
            padding: "var(--sp-2) var(--sp-4)",
            fontSize: "var(--text-2xs)",
            fontWeight: "var(--w-semi)",
            color: "var(--ink-soft)",
          }}
        >
          {t("prompt.finalPrompt")}
          <span style={{ fontWeight: "var(--w-normal)", color: "var(--ink-faint)" }}>
            {t("prompt.chars", { n: compileBlocks(base).length + compileBlocks(baseUc).length })}
          </span>
        </button>
        {preview && (
          <div style={{ padding: "0 var(--sp-4) var(--sp-3)", maxHeight: 220, overflowY: "auto" }}>
            <Pre label={t("prompt.tabPrompt")} text={compileBlocks(base)} />
            <Pre label={t("prompt.tabUc")} text={compileBlocks(baseUc)} accent="var(--uc-c)" />
            {chars
              .filter((c) => c.on)
              .map((c, i) => (
                <Pre
                  key={c.id}
                  label={c.name || t("cards.charN", { n: i + 1 })}
                  text={compileBlocks(c.prompt)}
                />
              ))}
          </div>
        )}
      </div>
    </div>
  );
}

/** 그릇 — 이름표 한 줄 + 그 안의 카드들. ★상자를 그리지 않는다 (평면) */
function Pre({ label, text, accent }: { label: string; text: string; accent?: string }) {
  const t = useI18n((s) => s.t);
  return (
    <div style={{ marginTop: "var(--sp-2)" }}>
      <div style={{ fontSize: "var(--text-2xs)", color: accent ?? "var(--ink-dim)" }}>{label}</div>
      <pre
        style={{
          margin: "2px 0 0",
          padding: "var(--sp-2)",
          background: "var(--code-bg)",
          borderRadius: "var(--r-1)",
          fontFamily: "var(--font-mono)",
          fontSize: "var(--text-2xs)",
          lineHeight: 1.5,
          whiteSpace: "pre-wrap",
          wordBreak: "break-all",
          color: "var(--ink-soft)",
        }}
      >
        {text || t("prompt.empty")}
      </pre>
    </div>
  );
}

/** ★★**순차 생성 모드** (사용자 결정 2026-09-15: *"순차생성 모드를 켜면 … 첫 캐릭터부터
 *  순차적으로 생성"*). 켜면 켜 둔 인물을 한 장에 모으지 않고 **한 명씩** 차례로 뽑는다 —
 *  규칙은 「슬롯을 하나씩만 켠 것처럼」 하나이고, 펴는 자리는 `store/gen` 의 `parties` 다.
 *  ★★값은 **탭의 것**이다 (사용자 지시: 탭 안에서 프롬프트를 공유한다) — 프롬프트와 함께
 *    `TabPrompt` 로 오간다 (`usePrompt.seqChars`).
 *
 *  ★★**켜는 자리가 곧 감싸는 자리다** (사용자 지시 2026-09-15: *"순차생성을 켜면 일반적인
 *    상태가 아니니까 캐릭터 프롬프트 전체를 감싸서 표시해줘"*). 켜면 이 띠가 테두리의 머리가
 *    되어 인물 카드와 「캐릭터 추가」까지 한 덩어리로 두른다 — 평소와 다른 상태라는 것이
 *    카드 하나가 아니라 **묶음 전체**에 걸리기 때문이다.
 *  ★감싸기는 **강조색 테두리 + 옅은 강조색 배경**이다 (사용자 선택) — 갤러리에서 고른 그림을
 *    표시하는 방식과 같다. 앱 안에서 「고른 것·켠 것」의 표현을 하나로 둔다.
 *  ★★꺼진 상태는 **빈 네모**다 (사용자 지적 2026-09-15: *"x를 넣으니까 닫는 버튼같음"*).
 *    프롬프트 옵션 띠의 칩은 꺼지면 `✕` 를 넣지만(`PromptOpts` 의 `Toggle`), 그쪽은 글 칸 옆에
 *    여러 칩이 늘어서는 자리라 사정이 다르다. 여기는 **한 줄에 하나뿐인 네모**라 `✕` 가
 *    「이 줄을 닫는 단추」로 읽힌다. 켬은 체크, 끔은 빈 칸 — 체크박스와 같다. */
function SeqCharsFrame({ children }: { children: React.ReactNode }) {
  const t = useI18n((s) => s.t);
  const on = usePrompt((s) => s.seqChars);
  const setSeqChars = usePrompt((s) => s.setSeqChars);
  return (
    <div
      data-seq-frame={on ? "on" : "off"}
      style={{
        /* ★「캐릭터 추가」 아래 여백을 **여기로 올렸다** — 켜면 그 단추가 테두리 안에 들어가서,
           단추에 붙어 있던 여백이 테두리 안쪽에 갇혀 버린다 */
        marginBottom: "var(--sp-5)",
        borderRadius: "var(--r-3)",
        ...(on
          ? {
              border: "1px solid var(--accent)",
              background: "color-mix(in srgb, var(--accent) 10%, transparent)",
            }
          : null),
      }}
    >
      <button
        data-seq-chars={on ? "on" : "off"}
        onClick={() => setSeqChars(!on)}
        data-tip={t("prompt.seqCharsTip")}
        style={{
          width: "100%",
          display: "flex",
          alignItems: "center",
          gap: "var(--sp-2)",
          padding: on ? "var(--sp-2) var(--sp-3)" : "0 var(--sp-1) var(--sp-2)",
          borderBottom: on ? "1px solid var(--accent-line)" : undefined,
          fontSize: "var(--text-2xs)",
          fontWeight: on ? "var(--w-semi)" : "var(--w-normal)",
          color: on ? "var(--accent-ink)" : "var(--ink-faint)",
          background: "transparent",
        }}
      >
        {/* ★★체크 칸은 **이름 왼쪽**이다 (사용자 지적 2026-09-15: *"순차생성이랑 텍스트랑
            버튼이 너무 먼데"*). 줄 양끝으로 갈라 두니 둘이 한 짝으로 안 읽혔다 — 체크박스처럼
            붙여 둔다. 누르는 자리는 그대로 줄 전체다. */}
        <span
          style={{
            display: "grid",
            placeItems: "center",
            width: 16,
            height: 16,
            flexShrink: 0,
            borderRadius: "var(--r-1)",
            border: `1px solid ${on ? "var(--accent)" : "var(--line)"}`,
            color: on ? "var(--accent-ink)" : "var(--ink-faint)",
          }}
        >
          {on ? Icon.check : null}
        </span>
        {t("prompt.seqChars")}
      </button>
      <div style={on ? { padding: "var(--sp-3)" } : undefined}>{children}</div>
    </div>
  );
}
