import { useEffect, useRef, useState } from "react";
import { useI18n } from "../i18n";
import { Icon } from "../components/Icon";
import { Help } from "../components/Tip";
import { BlockList } from "../blocks/BlockList";
import { BannerBtn, SectionCard } from "../blocks/SectionCard";
import { SectionBody, useThumbView } from "../panels/PromptSections";
import { PromptOptsBar } from "../panels/PromptOpts";
import { OptionsPanel } from "../panels/OptionsPanel";
import { Category } from "../panels/Category";
import { CharNo } from "../panels/CharPositioner";
import { SeedRow } from "../panels/GenerateFooter";
import { EnhanceDialog } from "../panels/EnhanceDialog";
import { makeBlock, parseSegs, slotBlock, slotBlocksOf, type Block } from "../lib/blocks";
import { backendUrl } from "../lib/backend";
import { thumbUrlOf } from "../lib/imgUrl";
import { currentAccountId } from "../store/accounts";
import { useCards, type CharCard, type StyleCard } from "../store/cards";
import { CHAR_COLOR, DEFAULT_STYLE_COLOR, thumbFromCard } from "../store/prompt";
import { useQueue } from "../store/queue";
import { useGen, type ParamsHost } from "../store/gen";
import { useCurrentSub, useSub } from "../store/sub";
import { useUi } from "../store/ui";
import { useImageInput } from "../store/imageInput";
import { box, dropFocus, on } from "../panels/censor/ui";
import {
  castNumbers, castSpot, comicGroupId, genOf, pageLabel, pageOfLayer, panelsInOrder, WHO_BUBBLE, WHO_NARRATION, WHO_PRESET,
  CAST_NEUTRAL, type ComicChar, type ComicGen, type CutCast, type PanelGen,
} from "./comic";
import { CAST_COLORS } from "./comicUi";
import { cutCost, cutName, cutParams, cutPrompt, emptyCuts, generateCuts, inpaintCuts, cutRoute, pickTake, refPayload, sizeOf, useComicInput, whoName } from "./cutGen";
import { curCut, curPage, pageView, useEditor, type Doc } from "./store";
import type { Layer } from "./pixels";

/** 만화 캔버스의 왼쪽 패널 — 생성 모드의 프롬프트 패널 자리 (설계 8-1 · 목업 v2).
 *
 *  머리 아래 **컷 줄**이 `공통 | p.01 ▾ | 1 2 3 …` 이다. 「공통」에는 만화 한 편이 같이 쓰는 것(화풍 · 캐릭터 카드 · 배경 · 생성 옵션)을
 *  한 번 정해 두고, 컷 번호를 누르면(무대에서 컷을 눌러도 같다) 그 컷에만 있는 것(장면 요약 · 배경 고르기 · 컷 태그 · 캐릭터 프롬프트)을 적는다.
 *  ★공통을 보는 동안에도 무대에서 고른 컷은 컷 줄에 테두리로 남는다 — 생성 버튼이 그 컷을 뽑는다.
 *  ★카드와 블록은 생성 모드와 **같은 부품**이다 (`SectionCard` · `SectionBody` · `BlockList`). 새 부품을 만들지 않는다.
 *  ★여기서 고친 것은 전부 캔버스의 되돌리기 한 걸음이다 (`patchCommon` · `setPanelGen`). 생성 옵션만 이력 밖이다 (`Doc.gen`) */
export function ComicLeft() {
  const doc = useEditor((s) => s.docs.find((d) => d.id === s.cur) ?? null);
  const view = useEditor((s) => s.comicView);
  if (!doc?.comic) return null;
  return (
    <div data-comic-panel style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
      <CutBar doc={doc} view={view} />
      <div data-comic-scroll style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "var(--sp-4) var(--sp-4) 0" }}>
        {view === "common" ? <CommonBody doc={doc} /> : <CutBody doc={doc} />}
      </div>
    </div>
  );
}

/* ── 컷 줄 ─────────────────────────────────────────────────────── */

function CutBar({ doc, view }: { doc: Doc; view: "common" | "cut" }) {
  const t = useI18n((s) => s.t);
  const pending = useQueue((q) => q.pending);
  const pid = curPage(doc)!;
  const pages = doc.comic!.pages;
  const cuts = panelsInOrder(pageView(doc, pid).layers, doc.comic!.dir, doc.h);
  const target = curCut(doc);
  const group = comicGroupId(doc.id);
  const chip = (active: boolean, extra?: React.CSSProperties): React.CSSProperties => ({
    height: 26, minWidth: 28, padding: "0 8px", borderRadius: "var(--r-2)", display: "grid", placeItems: "center", position: "relative", flexShrink: 0,
    border: `1px solid ${active ? "var(--accent)" : "var(--line)"}`, background: active ? "var(--accent-bg)" : "var(--panel)",
    color: active ? "var(--ink)" : "var(--ink-soft)", fontSize: "var(--text-xs)", fontVariantNumeric: "tabular-nums", fontWeight: active ? "var(--w-semi)" : "var(--w-normal)",
    ...extra,
  });
  return (
    <div data-comic-cutbar style={{ height: 40, flexShrink: 0, display: "flex", alignItems: "center", gap: 5, padding: "0 var(--sp-4)", borderBottom: "1px solid var(--line)", overflowX: "auto" }}>
      <button data-comic-common data-on={view === "common" ? "" : undefined} onMouseDown={dropFocus} onClick={() => useEditor.getState().setComicView("common")} style={chip(view === "common", { padding: "0 10px" })}>
        {t("editor.common")}
      </button>
      <span style={{ width: 1, height: 18, background: "var(--line)", margin: "0 4px", flexShrink: 0 }} />
      {/* 페이지 칸 — 지금 고른 컷이 있는 페이지. 고르면 무대가 그 페이지로 가고 그 페이지의 첫 컷을 편다 */}
      <select
        data-comic-page
        value={pid}
        onChange={(e) => {
          const s = useEditor.getState();
          const p = e.target.value;
          s.revealPage(p);
          const d = s.doc();
          const first = d ? panelsInOrder(pageView(d, p).layers, d.comic!.dir, d.h)[0] : undefined;
          if (first) s.selectLayer(first.id);
        }}
        style={{ ...box, height: 26, padding: "0 4px", fontSize: "var(--text-2xs)", fontVariantNumeric: "tabular-nums", flexShrink: 0 }}
      >
        {pages.map((p, i) => <option key={p} value={p}>{pageLabel(i)}</option>)}
      </select>
      {cuts.map((c, i) => {
        const has = doc.layers.some((l) => l.clip === c.id && !l.draw);
        const busy = pending.some((q) => q.groupId === group && q.cellId === c.id);
        const isTarget = target?.id === c.id;
        return (
          <button
            key={c.id}
            data-comic-cut={i + 1}
            data-on={isTarget ? "" : undefined}
            onMouseDown={dropFocus}
            onClick={() => useEditor.getState().selectLayer(c.id)}
            style={chip(isTarget && view === "cut", {
              ...(isTarget && view === "common" ? { boxShadow: "inset 0 0 0 1px rgba(58,123,184,.65)", color: "var(--ink)" } : {}),
              ...(!has && !(isTarget && view === "cut") ? { borderStyle: "dashed", color: "var(--ink-faint)" } : {}),
            })}
          >
            {i + 1}
            {busy && <i style={{ position: "absolute", right: 3, top: 3, width: 5, height: 5, borderRadius: "50%", background: "var(--warn)" }} />}
          </button>
        );
      })}
    </div>
  );
}

/* ── 공통 ─────────────────────────────────────────────────────── */

/** 캔버스의 생성 옵션을 옵션 부품에 넘긴다 (사용자 결정 2026-09-28: 캔버스마다 따로). 부품은 생성 모드와 같은 것이다 */
function useComicHost(doc: Doc): ParamsHost {
  const gen = useGen((s) => s.params);
  return { params: cutParams(doc, gen), set: (k, v) => useEditor.getState().setComicGen(doc.id, k as keyof ComicGen, v as never), input: useComicInput };
}

/** 「공통」 — 베이스 프롬프트(화풍) · 캐릭터 프롬프트(외형) · 배경 · 생성 옵션 (설계 8-1).
 *  ★캐릭터 카드와 배경은 캔버스에 한 벌뿐이다 — 카드 하나가 곧 인물 하나 (같은 인물은 어느 컷에서나 같은 색) */
function CommonBody({ doc }: { doc: Doc }) {
  const t = useI18n((s) => s.t);
  const c = doc.comic!.common;
  const s = useEditor.getState();
  const host = useComicHost(doc);
  /** 배경마다 그것을 쓰는 페이지·컷 — 이름 옆에 (목업 v2 ②) */
  const usage = new Map<string, string>();
  doc.comic!.pages.forEach((pid, pi) => {
    const byBg = new Map<string, number[]>();
    panelsInOrder(pageView(doc, pid).layers, doc.comic!.dir, doc.h).forEach((p, i) => {
      const bg = genOf(p.panel).bg;
      if (bg) byBg.set(bg, [...(byBg.get(bg) ?? []), i + 1]);
    });
    for (const [bg, ns] of byBg) {
      const part = t("editor.bgUse", { p: pageLabel(pi), n: ns.join(" · ") });
      usage.set(bg, usage.has(bg) ? `${usage.get(bg)} · ${part}` : part);
    }
  });
  return (
    <>
      <Category id="c-base" label={t("prompt.baseBox")} right={<CardPick kind="styles" />}>
        <StyleCardC doc={doc} host={host} />
      </Category>
      <Category id="c-char" label={t("prompt.charBox")} right={<CardPick kind="characters" />}>
        <div style={{ display: "flex", flexDirection: "column", marginBottom: "var(--sp-5)" }}>
          {c.chars.map((ch, i) => <CharCardC key={ch.id} ch={ch} i={i} last={i === c.chars.length - 1} />)}
          <button
            data-comic-add-char
            onClick={() =>
              s.patchCommon((cc) => ({ ...cc, chars: [...cc.chars, { id: newKey("c"), ref: null, name: "", thumb: null, prompt: [makeBlock(t("block.newBlock"), [], { open: true })], uc: [] }] }))
            }
            style={dashBtn}
          >
            {t("cards.addChar")}
          </button>
        </div>
      </Category>
      <Category id="c-bg" label={t("editor.backgrounds")}>
        <div data-comic-bgs style={{ marginBottom: "var(--sp-5)" }}>
          <BlockList
            blocks={c.bgs}
            onChange={(b) => s.patchCommon((cc) => ({ ...cc, bgs: b }))}
            libZone={`comic-bg-${doc.id}`}
            noToggle
            tagOf={(b) => usage.get(b.id)}
            addAs={{ label: t("editor.addBg"), name: t("editor.newBg") }}
          />
        </div>
      </Category>
      <div style={{ height: 1, background: "var(--line)", margin: "0 0 var(--sp-4)" }} />
      <OptionsPanel only="gen" host={host} refs={useComicInput} />
    </>
  );
}

/** 베이스 프롬프트 카드 — 생성 모드의 스타일 카드와 같은 카드(이름 · 배너 그림 · Prompt/UC · 프롬프트 옵션 띠) */
function StyleCardC({ doc, host }: { doc: Doc; host: ParamsHost }) {
  const t = useI18n((s) => s.t);
  const c = doc.comic!.common;
  const s = useEditor.getState();
  const folded = useUi((u) => !!u.view.fold["comic-base"]);
  const thumb = useThumbView(c.style.thumb);
  return (
    <div style={{ marginBottom: "var(--sp-5)" }}>
      <SectionCard
        name={c.style.name || t("editor.comicStyle")}
        gradient={DEFAULT_STYLE_COLOR}
        thumb={thumb}
        folded={folded}
        onFold={() => useUi.getState().setView("fold", "comic-base", !folded)}
        onRename={(v) => s.patchCommon((cc) => ({ ...cc, style: { ...cc.style, name: v } }))}
        renameTip={t("cards.rename")}
        hoverLift
      >
        <SectionBody
          id="comic-base"
          prompt={c.base}
          uc={c.uc}
          onPrompt={(b) => s.patchCommon((cc) => ({ ...cc, base: b }))}
          onUc={(b) => s.patchCommon((cc) => ({ ...cc, uc: b }))}
          footer={(showUc) => <PromptOptsBar uc={showUc} host={host} />}
        />
      </SectionCard>
    </div>
  );
}

/** 캐릭터 카드 — 생성 모드와 같은 카드. 켜고 끄기는 없다 (나오는 것은 컷이 고른다). 지우면 그 인물이 든 컷의 칸도 함께 빠진다 */
function CharCardC({ ch, i, last }: { ch: ComicChar; i: number; last: boolean }) {
  const t = useI18n((s) => s.t);
  const s = useEditor.getState();
  const folded = useUi((u) => !!u.view.fold[ch.id]);
  const thumb = useThumbView(ch.thumb);
  const patch = (p: Partial<ComicChar>) => s.patchCommon((cc) => ({ ...cc, chars: cc.chars.map((x) => (x.id === ch.id ? { ...x, ...p } : x)) }));
  const step = (dir: -1 | 1) =>
    s.patchCommon((cc) => {
      const list = [...cc.chars];
      const j = i + dir;
      if (j < 0 || j >= list.length) return cc;
      [list[i], list[j]] = [list[j], list[i]];
      return { ...cc, chars: list };
    });
  const name = ch.name || t("cards.charN", { n: i + 1 });
  return (
    <div style={{ marginBottom: "var(--sp-3)" }}>
      <SectionCard
        name={name}
        gradient={CHAR_COLOR}
        thumb={thumb}
        folded={folded}
        onFold={() => useUi.getState().setView("fold", ch.id, !folded)}
        onRename={(v) => patch({ name: v })}
        renameTip={t("cards.rename")}
        /* ★인물 색 — 무대의 인물 점 테와 같은 색 (같은 인물은 어느 컷에서나 같은 색, 설계 8-1) */
        nameTag={<span data-comic-char-color style={{ width: 10, height: 10, borderRadius: "50%", boxShadow: `inset 0 0 0 2px ${CAST_COLORS[i % CAST_COLORS.length]}`, background: "rgba(12,12,16,.88)" }} />}
        bannerLead={
          <>
            <BannerBtn title={t("cards.moveCharUp")} off={i === 0} mark="data-char-up" onClick={() => step(-1)}>{Icon.chevronUp12}</BannerBtn>
            <BannerBtn title={t("cards.moveCharDown")} off={last} mark="data-char-down" onClick={() => step(1)}>{Icon.chevronDown12}</BannerBtn>
          </>
        }
        bannerActions={
          <BannerBtn title={t("cards.removeChar")} onClick={() => void s.removeComicChar(ch.id)}>
            {Icon.close12}
          </BannerBtn>
        }
        hoverLift
      >
        <SectionBody
          id={ch.id}
          prompt={ch.prompt}
          uc={ch.uc}
          onPrompt={(b) => patch({ prompt: b })}
          onUc={(b) => patch({ uc: b })}
        />
      </SectionCard>
    </div>
  );
}

/** 저장해 둔 카드에서 가져오기 — 스타일은 화풍 카드를 갈아 끼우고(이름 · 그림 · 블록), 캐릭터는 새 인물로 더한다.
 *  ★이미지 편집에는 카드덱이 없어서 끌어다 놓을 곳이 없다 — 그 대신 여기서 고른다 */
function CardPick({ kind }: { kind: "styles" | "characters" }) {
  const t = useI18n((s) => s.t);
  const cards = useCards((c) => (kind === "styles" ? c.styles : c.characters));
  const loaded = useCards((c) => c.loaded);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (open && !loaded) void useCards.getState().load();
    if (!open) return;
    const close = (e: PointerEvent) => {
      if (ref.current?.contains(e.target as Node)) return;
      setOpen(false);
    };
    document.addEventListener("pointerdown", close, true);
    return () => document.removeEventListener("pointerdown", close, true);
  }, [open, loaded]);
  const s = useEditor.getState();
  const pick = (id: string) => {
    setOpen(false);
    const card = cards.find((c) => c.id === id);
    if (!card) return;
    const copy = (b: Block[]) => structuredClone(b);
    if (kind === "styles") {
      const st = card as StyleCard;
      s.patchCommon((cc) => ({ ...cc, style: { ref: st.id, name: st.name, thumb: thumbFromCard(st.thumb) }, base: copy(st.base), uc: copy(st.uc) }));
      return;
    }
    const ch = card as CharCard;
    s.patchCommon((cc) => ({ ...cc, chars: [...cc.chars, { id: newKey("c"), ref: ch.id, name: ch.name, thumb: thumbFromCard(ch.thumb), prompt: copy(ch.prompt), uc: copy(ch.uc) }] }));
  };
  return (
    <div ref={ref} style={{ position: "relative" }}>
      <button
        data-comic-card-pick={kind}
        onMouseDown={dropFocus}
        onClick={() => setOpen((v) => !v)}
        data-tip={t(kind === "styles" ? "editor.pickStyleCard" : "editor.pickCharCard")}
        style={{ ...box, ...(open ? on : {}), display: "grid", placeItems: "center", padding: "2px 6px" }}
      >
        {Icon.cards}
      </button>
      {open && (
        <div
          data-comic-card-menu={kind}
          style={{ position: "absolute", right: 0, top: "100%", marginTop: 4, zIndex: 30, width: 220, maxHeight: 280, overflowY: "auto", padding: 4,
                   background: "var(--panel)", border: "1px solid var(--line)", borderRadius: "var(--r-2)", boxShadow: "0 8px 28px rgba(0,0,0,.5)" }}
        >
          {!cards.length && <div style={{ padding: "6px 8px", fontSize: "var(--text-2xs)", color: "var(--ink-faint)" }}>{t("editor.noCards")}</div>}
          {cards.map((c) => (
            <button
              key={c.id}
              data-comic-card={c.id}
              onClick={() => pick(c.id)}
              style={{ display: "block", width: "100%", textAlign: "left", padding: "5px 8px", borderRadius: "var(--r-1)", fontSize: "var(--text-2xs)", color: "var(--ink-soft)",
                       overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
            >
              {c.folder ? <span style={{ color: "var(--ink-faint)" }}>{c.folder} / </span> : null}
              {c.name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/* ── 컷 편집 ─────────────────────────────────────────────────────── */

/** 컷 편집 — 그 컷에만 있는 것 (설계 8-1): 장면 요약 · 배경 · 컷 태그 · 캐릭터 프롬프트 · 해상도 */
function CutBody({ doc }: { doc: Doc }) {
  const t = useI18n((s) => s.t);
  const p = curCut(doc);
  if (!p) return <div data-comic-no-cut style={{ padding: "var(--sp-5) 0", textAlign: "center", fontSize: "var(--text-2xs)", color: "var(--ink-faint)" }}>{t("editor.noCut")}</div>;
  return <CutFields key={p.id} doc={doc} p={p} />;
}

function CutFields({ doc, p }: { doc: Doc; p: Layer }) {
  const t = useI18n((s) => s.t);
  const s = useEditor.getState();
  const c = doc.comic!.common;
  const g = genOf(p.panel);
  const set = (patch: Partial<PanelGen>) => s.setPanelGen(p.id, patch);
  const pid = pageOfLayer(p, doc.comic!.pages);
  const nums = castNumbers(pageView(doc, pid).layers, doc.comic!.dir, doc.h);
  const size = sizeOf(p);
  const colorOf = (x: CutCast) => {
    const ci = c.chars.findIndex((k) => k.id === x.who);
    return ci >= 0 ? CAST_COLORS[ci % CAST_COLORS.length] : CAST_NEUTRAL;
  };
  const add = (who: string) => {
    const n = g.cast.length;
    const preset = WHO_PRESET[who];
    const blocks: Block[] = preset ? [makeBlock("", [], { open: true, tags: parseSegs(preset), src: preset })] : [];
    set({ cast: [...g.cast, { key: newKey("k"), who, ...castSpot(n, n + 1), blocks }] });
  };
  const label = (k: string, help?: string) => (
    <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: "var(--text-2xs)", color: "var(--ink-faint)" }}>
      {k}{help && <Help tip={help} />}
    </div>
  );
  return (
    <div data-comic-cut-edit={p.id} style={{ display: "flex", flexDirection: "column", gap: "var(--sp-5)", paddingBottom: "var(--sp-5)" }}>
      <div style={fld}>
        {label(t("editor.summary"), t("editor.summaryHint"))}
        <SummaryBox value={g.summary} onCommit={(v) => set({ summary: v })} />
      </div>
      <div style={fld}>
        {label(t("editor.background"))}
        <div data-comic-bg-pick style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
          {c.bgs.map((b) => (
            <button key={b.id} data-comic-bg={b.id} data-on={g.bg === b.id ? "" : undefined} onMouseDown={dropFocus} onClick={() => set({ bg: b.id })} style={pill(g.bg === b.id)}>
              {b.label || t("editor.newBg")}
            </button>
          ))}
          <button data-comic-bg="" data-on={!g.bg ? "" : undefined} onMouseDown={dropFocus} onClick={() => set({ bg: null })} style={{ ...pill(!g.bg), borderStyle: "dashed" }}>
            {t("editor.bgNone")}
          </button>
        </div>
      </div>
      <div style={fld}>
        {label(t("editor.cutTags"))}
        <div data-comic-cut-tags>
          <BlockList single fill id={`cut-${p.id}`} blocks={[slotBlock(g.blocks, `cut-${p.id}`)]} onChange={(b) => set({ blocks: slotBlocksOf(b[0] ?? slotBlock(g.blocks, `cut-${p.id}`)) })} libZone={`cut-${p.id}`} />
        </div>
      </div>
      <div style={fld}>
        {label(t("prompt.charBox"))}
        {g.cast.map((x) => {
          const name = whoName(doc, x) ?? "?";
          const blk = slotBlock(x.blocks, `cast-${x.key}`);
          return (
            <div key={x.key} data-comic-cast={x.key} style={{ border: "1px solid var(--line)", borderRadius: "var(--r-3)", background: "var(--panel)" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "5px 8px", fontSize: "var(--text-xs)", fontWeight: "var(--w-semi)" }}>
                <CharNo n={nums.get(`${p.id}:${x.key}`) ?? 0} size={20} ring={2} color={colorOf(x)} />
                <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{name}</span>
                <button
                  data-comic-cast-del={x.key}
                  onMouseDown={dropFocus}
                  onClick={() => set({ cast: g.cast.filter((y) => y.key !== x.key) })}
                  data-tip={t("editor.castRemove")}
                  style={{ display: "grid", color: "var(--ink-faint)", padding: "0 2px" }}
                >
                  {Icon.close12}
                </button>
              </div>
              <div style={{ padding: "0 8px 8px" }}>
                <BlockList
                  single
                  fill
                  id={`cast-${x.key}`}
                  blocks={[blk]}
                  onChange={(b) => set({ cast: g.cast.map((y) => (y.key === x.key ? { ...y, blocks: slotBlocksOf(b[0] ?? blk) } : y)) })}
                  libZone={`cast-${x.key}`}
                />
              </div>
            </div>
          );
        })}
        {/* ★추가 버튼에는 **언제나** 모든 캐릭터가 있다 — 이미 나온 인물도 다시 넣는다 (사용자 지시 2026-09-28) */}
        <div data-comic-cast-add style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
          {c.chars.map((ch, i) => (
            <button key={ch.id} data-comic-cast-add-who={ch.id} onMouseDown={dropFocus} onClick={() => add(ch.id)} style={addWho}>
              {Icon.plus12}{ch.name || t("cards.charN", { n: i + 1 })}
            </button>
          ))}
          <button data-comic-cast-add-who={WHO_NARRATION} onMouseDown={dropFocus} onClick={() => add(WHO_NARRATION)} style={addWho}>{Icon.plus12}{t("editor.narration")}</button>
          <button data-comic-cast-add-who={WHO_BUBBLE} onMouseDown={dropFocus} onClick={() => add(WHO_BUBBLE)} style={addWho}>{Icon.plus12}{t("editor.speechBubble")}</button>
        </div>
      </div>
      <Category id="c-size" label={t("options.resolution")} defaultFolded right={<span style={{ fontSize: "var(--text-2xs)", color: "var(--ink-faint)", fontFamily: "var(--font-mono)" }}>{t("editor.sizeFromCut")} · {size.w} × {size.h}</span>}>
        <div style={{ display: "flex", alignItems: "center", gap: "var(--sp-3)", fontSize: "var(--text-2xs)", color: "var(--ink-faint)", marginBottom: "var(--sp-4)" }}>
          {size.w} × {size.h}
          <span style={{ flex: 1 }} />
          <button data-editor-cut-big data-tip={t("editor.cutBigHint")} onMouseDown={dropFocus} onClick={() => set({ big: !g.big })} style={{ ...box, ...(g.big ? on : {}), padding: "2px 8px" }}>
            {t("editor.cutBig")}
          </button>
        </div>
      </Category>
    </div>
  );
}

/** 장면 요약 — 프롬프트에 안 들어가는 메모 (AI 가 콘티를 짤 때 적는다). 치는 동안은 제 것, 밖을 누르면 한 걸음으로 반영 */
function SummaryBox({ value, onCommit }: { value: string; onCommit: (v: string) => void }) {
  const [text, setText] = useState(value);
  const ref = useRef<HTMLTextAreaElement | null>(null);
  useEffect(() => setText(value), [value]);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.max(34, el.scrollHeight)}px`;
  }, [text]);
  return (
    <textarea
      ref={ref}
      data-comic-summary
      value={text}
      rows={1}
      spellCheck={false}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => text !== value && onCommit(text)}
      onKeyDown={(e) => {
        if (e.key === "Escape") { setText(value); (e.currentTarget as HTMLTextAreaElement).blur(); }
      }}
      style={{ ...box, width: "100%", resize: "none", padding: "6px 9px", fontSize: "var(--text-xs)", lineHeight: 1.5, color: "var(--ink-soft)", background: "var(--bg)", boxSizing: "border-box", overflow: "hidden" }}
    />
  );
}

/* ── 생성 푸터 ────────────────────────────────────────────────── */

/** 컷 생성 푸터 — 최종 프롬프트 · 장 수 · 시드 · 「컷 N 생성」 · 「빈 컷 전부 생성」 · Anlas (목업 v2).
 *  ★시드 줄은 생성 푸터와 **같은 부품**이다 (`SeedRow`). 값은 캔버스의 것이다 (`Doc.gen`) */
export function ComicFooter({ compact = false }: { compact?: boolean }) {
  const doc = useEditor((s) => s.docs.find((d) => d.id === s.cur) ?? null);
  if (!doc?.comic) return null;
  return <ComicFooterC doc={doc} compact={compact} />;
}

function ComicFooterC({ doc, compact }: { doc: Doc; compact: boolean }) {
  const t = useI18n((s) => s.t);
  const count = useEditor((s) => s.cutCount);
  const pending = useQueue((q) => q.pending);
  const sub = useCurrentSub();
  const [preview, setPreview] = useState(false);
  const host = useComicHost(doc);
  // 참조 그림이 바뀌면 값을 다시 센다
  useComicInput();
  const p = curCut(doc);
  const cost = p ? cutCost(doc, [p], count) : null;
  const size = p ? sizeOf(p) : null;
  const nm = p ? cutName(doc, p) : null;
  const empty = emptyCuts(doc, pending);
  const emptyCost = cutCost(doc, empty, 1);
  const costText = (c: { total: number; free: boolean }) => (c.free ? "FREE" : t("editor.cutCost", { a: c.total }));
  const gen = () => p && void generateCuts(doc, [p.id], count);
  if (compact) {
    return (
      <button data-comic-gen-compact disabled={!p} onClick={gen} data-tip={nm ? t("editor.cutGenN", { n: nm.n }) : undefined}
        style={{ width: 28, height: 28, display: "grid", placeItems: "center", borderRadius: "var(--r-2)", background: "var(--accent)", color: "#fff", opacity: p ? 1 : 0.45 }}>
        {Icon.spark}
      </button>
    );
  }
  const shot = p ? cutPrompt(doc, p) : null;
  return (
    <div data-comic-footer style={{ flexShrink: 0, borderTop: "1px solid var(--line)", padding: "var(--sp-3) var(--sp-4) var(--sp-4)", display: "flex", flexDirection: "column", gap: "var(--sp-3)" }}>
      <button onClick={() => setPreview((v) => !v)} style={{ display: "flex", alignItems: "center", gap: "var(--sp-2)", fontSize: "var(--text-2xs)", fontWeight: "var(--w-semi)", color: "var(--ink-soft)", textAlign: "left" }}>
        {t("prompt.finalPrompt")}
        <span style={{ fontWeight: "var(--w-normal)", color: "var(--ink-faint)" }}>{t("prompt.chars", { n: (shot?.prompt.length ?? 0) + (shot?.uc.length ?? 0) })}</span>
      </button>
      {preview && shot && (
        <div data-comic-final style={{ maxHeight: 200, overflowY: "auto", display: "flex", flexDirection: "column", gap: 4 }}>
          <Pre text={shot.prompt} />
          {shot.chars.map((c) => <Pre key={c.key} label={whoName(doc, genOf(p!.panel).cast.find((x) => x.key === c.key)!) ?? ""} text={c.prompt} />)}
          {shot.uc && <Pre label={t("prompt.tabUc")} text={shot.uc} uc />}
        </div>
      )}
      <div style={{ display: "flex", alignItems: "center", gap: "var(--sp-3)", fontSize: "var(--text-2xs)", color: "var(--ink-faint)" }}>
        {t("editor.cutCount")}
        <span style={{ display: "inline-flex", border: "1px solid var(--line)", borderRadius: "var(--r-2)", overflow: "hidden" }}>
          {[1, 2, 3, 4].map((n, i) => (
            <button key={n} data-editor-cut-count={n} onMouseDown={dropFocus} onClick={() => useEditor.getState().setCutCount(n)}
              style={{ height: 22, minWidth: 26, borderLeft: i ? "1px solid var(--line)" : 0, background: count === n ? "var(--accent-bg)" : "var(--panel)", color: count === n ? "var(--ink)" : "var(--ink-faint)", boxShadow: count === n ? "inset 0 0 0 1px var(--accent)" : undefined }}>
              {n}
            </button>
          ))}
        </span>
      </div>
      <SeedRow host={host} />
      <button
        data-editor-cut-gen
        disabled={!p || !!cost?.overLimit}
        onClick={gen}
        style={{ width: "100%", padding: "9px 0", borderRadius: "var(--r-2)", border: "1px solid var(--accent)", background: "var(--accent)", color: "#fff", fontSize: "var(--text-md)", fontWeight: "var(--w-semi)", opacity: !p || cost?.overLimit ? 0.45 : 1 }}
      >
        {nm ? t("editor.cutGenN", { n: nm.n }) : t("editor.cutGen")}
        {size && cost && <small style={{ fontWeight: "var(--w-normal)", opacity: 0.85, marginLeft: 6 }}>{size.w} × {size.h} · {costText(cost)}</small>}
      </button>
      {cost?.overLimit && <span style={{ fontSize: "var(--text-2xs)", color: "var(--ink-faint)" }}>{t("editor.cutOver")}</span>}
      <button
        data-editor-cut-gen-empty
        disabled={!empty.length || emptyCost.overLimit}
        onClick={() => void generateCuts(doc, empty.map((l) => l.id), 1)}
        style={{ ...box, width: "100%", display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 6, padding: "5px 0", opacity: empty.length ? 1 : 0.55 }}
      >
        {t("editor.cutGenEmpty")}
        <span style={{ minWidth: 16, height: 16, padding: "0 4px", borderRadius: 8, background: "var(--line)", fontSize: 10, display: "grid", placeItems: "center" }}>{empty.length}</span>
        {empty.length > 0 && <small style={{ color: "var(--ink-faint)" }}>{costText(emptyCost)}</small>}
      </button>
      <div style={{ display: "flex", justifyContent: "flex-end", alignItems: "center", gap: 6, fontSize: "var(--text-3xs)", color: "var(--ink-faint)" }}>
        <span data-anlas-balance>
          Anlas <b style={{ fontFamily: "var(--font-mono)", color: "var(--ink-soft)" }}>{sub ? sub.anlas.toLocaleString() : "--"}</b>
        </span>
        <button data-anlas-refresh data-tip={t("gen.anlasRefresh")} onClick={() => void useSub.getState().load(currentAccountId())} style={{ display: "grid", color: "var(--ink-faint)", padding: "0 2px" }}>
          {Icon.refresh12}
        </button>
      </div>
    </div>
  );
}

function Pre({ label, text, uc }: { label?: string; text: string; uc?: boolean }) {
  return (
    <div>
      {label && <div style={{ fontSize: "var(--text-3xs)", color: uc ? "var(--uc-c)" : "var(--ink-dim)" }}>{label}</div>}
      <pre style={{ margin: 0, padding: "var(--sp-2)", background: "var(--code-bg)", borderRadius: "var(--r-1)", fontFamily: "var(--font-mono)", fontSize: "var(--text-3xs)", lineHeight: 1.5, whiteSpace: "pre-wrap", wordBreak: "break-all", color: "var(--ink-soft)" }}>
        {text}
      </pre>
    </div>
  );
}

/* ── 후보 줄 (무대 아래) ─────────────────────────────────────── */

/** 생성할 컷의 후보 — 그 컷에서 생성된 그림이 쌓이고, 누르면 그 컷의 그림이 바뀐다. 쓰는 것에 「사용 중」 (설계 8-4 · 목업 v2).
 *  머리에 그 컷만 다시 그리는 둘(인페인트 · 강화)이 선다. 후보는 파일이라 지워지지 않는다 */
export function CutLane({ doc }: { doc: Doc }) {
  const t = useI18n((s) => s.t);
  const pending = useQueue((q) => q.pending);
  const count = useEditor((s) => s.cutCount);
  const [base, setBase] = useState("");
  const [enhance, setEnhance] = useState(false);
  useEffect(() => {
    void backendUrl().then(setBase);
  }, []);
  const p = curCut(doc);
  const g = p ? genOf(p.panel) : null;
  const cur = p ? (doc.layers.find((l) => l.clip === p.id && l.take)?.take ?? null) : null;
  const waiting = p ? pending.filter((q) => q.groupId === comicGroupId(doc.id) && q.cellId === p.id).length : 0;
  const nm = p ? cutName(doc, p) : null;
  const inpaintCost = p ? cutCost(doc, [p], count, useImageInput.getState().baseInpaintStrength ?? 1, true) : null;
  return (
    <div data-comic-lane style={{ flexShrink: 0, height: 114, border: "1px solid var(--line)", borderRadius: "var(--r-3)", display: "flex", flexDirection: "column", overflow: "hidden" }}>
      <div style={{ height: 28, flexShrink: 0, display: "flex", alignItems: "center", gap: "var(--sp-3)", padding: "0 var(--sp-2) 0 var(--sp-4)", borderBottom: "1px solid var(--line)", fontSize: "var(--text-2xs)", color: "var(--ink-faint)" }}>
        {nm ? <b style={{ color: "var(--ink)", fontWeight: "var(--w-semi)", fontSize: "var(--text-xs)" }}>{nm.name}</b> : null}
        {g && <span>{t("editor.takesN", { n: g.takes.length })}</span>}
        <span style={{ flex: 1 }} />
        {p && (
          <>
            <button
              data-editor-cut-inpaint
              disabled={!!inpaintCost?.overLimit}
              onMouseDown={dropFocus}
              onClick={() => void inpaintCuts(doc, [p.id], count)}
              data-tip={t("editor.cutInpaintHint")}
              style={{ ...box, display: "inline-flex", alignItems: "center", gap: 5, padding: "1px 8px", fontSize: "var(--text-2xs)" }}
            >
              {Icon.brush12}{t("editor.cutInpaint")}
            </button>
            <button
              data-editor-cut-enhance
              disabled={!cur}
              onMouseDown={dropFocus}
              onClick={() => setEnhance(true)}
              data-tip={t(cur ? "editor.cutEnhanceHint" : "editor.cutEnhanceNone")}
              style={{ ...box, display: "inline-flex", alignItems: "center", gap: 5, padding: "1px 8px", fontSize: "var(--text-2xs)", color: cur ? undefined : "var(--ink-ghost)" }}
            >
              {Icon.spark12}{t("enhance.button")}
            </button>
          </>
        )}
      </div>
      <div data-editor-cut-takes style={{ flex: 1, minHeight: 0, display: "flex", gap: "var(--sp-3)", padding: "var(--sp-3) var(--sp-4)", overflowX: "auto" }}>
        {(!g || (!g.takes.length && !waiting)) && (
          <span style={{ flex: 1, display: "grid", placeItems: "center", color: "var(--ink-ghost)", fontSize: "var(--text-2xs)" }}>{t(p ? "editor.takesEmpty" : "editor.noCut")}</span>
        )}
        {p && g && base && g.takes.map((tk) => {
          const inUse = !!cur && cur.ws === tk.ws && cur.file === tk.file;
          return (
            <button
              key={tk.file}
              data-editor-cut-take={tk.file}
              data-on={inUse ? "" : undefined}
              onMouseDown={dropFocus}
              onClick={() => void pickTake(doc.id, p.id, tk)}
              style={{ width: 58, flexShrink: 0, padding: 0, borderRadius: "var(--r-2)", overflow: "hidden", position: "relative", border: "1px solid var(--line)", outline: inUse ? "2px solid var(--accent)" : undefined, outlineOffset: -2, background: "var(--bg)" }}
            >
              <img src={thumbUrlOf(base, tk.ws, tk.file)} alt="" draggable={false} style={{ width: "100%", height: "100%", objectFit: "cover", objectPosition: "50% 0", display: "block" }} />
              {inUse && <span style={{ position: "absolute", left: 4, top: 4, fontSize: 9.5, fontWeight: 600, color: "#fff", background: "var(--accent)", borderRadius: 3, padding: "0 4px" }}>{t("editor.takeInUse")}</span>}
            </button>
          );
        })}
        {Array.from({ length: waiting }, (_, i) => (
          <span key={`w${i}`} style={{ width: 58, flexShrink: 0, borderRadius: "var(--r-2)", border: "1px solid var(--line)", background: "var(--panel)", display: "grid", placeItems: "center", fontSize: "var(--text-3xs)", color: "var(--ink-faint)" }}>
            {t("editor.cutQueued")}
          </span>
        ))}
      </div>
      {enhance && cur && p && <EnhanceDialog files={[cur.file]} ws={cur.ws} route={cutRoute(doc, p)} input={() => refPayload(doc)} onClose={() => setEnhance(false)} />}
    </div>
  );
}

/* ── 조각 ─────────────────────────────────────────────────────── */

let seq = 0;
const newKey = (p: string) => `${p}${Date.now().toString(36)}${(seq++).toString(36)}`;

const fld: React.CSSProperties = { display: "flex", flexDirection: "column", gap: 6 };
const dashBtn: React.CSSProperties = {
  width: "100%", padding: "var(--sp-3)", border: "1px dashed var(--line)", borderRadius: "var(--r-3)", fontSize: "var(--text-2xs)", color: "var(--ink-faint)", background: "transparent",
};
const pill = (active: boolean): React.CSSProperties => ({
  height: 26, padding: "0 10px", display: "inline-flex", alignItems: "center", borderRadius: "var(--r-2)", fontSize: "var(--text-2xs)",
  border: `1px solid ${active ? "var(--accent)" : "var(--line)"}`, background: active ? "var(--accent-bg)" : "var(--panel)",
  color: active ? "var(--ink)" : "var(--ink-soft)", fontWeight: active ? "var(--w-semi)" : "var(--w-normal)",
});
const addWho: React.CSSProperties = {
  height: 26, padding: "0 10px 0 7px", display: "inline-flex", alignItems: "center", gap: 4, border: "1px dashed var(--line)", borderRadius: "var(--r-2)",
  fontSize: "var(--text-2xs)", color: "var(--ink-soft)", background: "transparent",
};
