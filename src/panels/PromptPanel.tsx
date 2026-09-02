import { useI18n } from "../i18n";
import { useState } from "react";
import { compileBlocks } from "../lib/blocks";
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
             패널에 둔다 (`dg()`). 판 자체는 큰 그림 위에 겹친다 (`Canvas` 의 `ScenePreview`). */
          right={<CharPositionToggle />}
        >
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
            onClick={() => addChar({ on: canEnableChar() })}
            style={{
              width: "100%",
              marginBottom: "var(--sp-5)",
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
