import { useEffect, useState } from "react";
import { create } from "zustand";
import { useI18n } from "../i18n";
import { Icon } from "../components/Icon";
import { ColorInput } from "../components/ColorInput";
import { api } from "../lib/backend";
import { undoToast } from "../store/toast";
import { useUi } from "../store/ui";
import { Hint, Line, Sec, box, dropFocus, num, on } from "../panels/censor/ui";
import { sfxSubstituted, type Layer } from "./pixels";
import { useEditor } from "./store";
import { PHRASE_CATS, type PhraseCat, type SfxMeta } from "./sfx";
import PHRASES from "./sfxPhrases.json";

/** 내 문구 — `data/sfx-phrases.json` (앱 번들 문구 모음 옆에 사용자가 더한 것, 설계 7번) */
const useMine = create<{ items: string[]; loaded: boolean; load: () => Promise<void>; save: (items: string[]) => Promise<void> }>((set, get) => ({
  items: [],
  loaded: false,
  async load() {
    if (get().loaded) return;
    try {
      const r = await api<{ items: { text: string }[] }>("/api/edit/sfx-phrases");
      set({ items: r.items.map((x) => x.text), loaded: true });
    } catch {
      set({ loaded: true });
    }
  },
  async save(items) {
    set({ items });
    await api("/api/edit/sfx-phrases", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ items: items.map((text) => ({ text })) }) });
  },
}));

const CAT_KEY: Record<PhraseCat | "mine", "editor.sfxCatGeneral" | "editor.sfxCatAction" | "editor.sfxCatEmotion" | "editor.sfxCatAdult" | "editor.sfxCatMine"> = {
  general: "editor.sfxCatGeneral", action: "editor.sfxCatAction", emotion: "editor.sfxCatEmotion", adult: "editor.sfxCatAdult", mine: "editor.sfxCatMine",
};

/** 효과음 칸 — 글 · 문구 모음(일반·액션·감정·성인·내 문구) · 기울기 · 흔들림 · 휘기 · 자간 · 그림자 · 세로쓰기 (설계 7번).
 *  ★효과음을 골랐으면 그것을 고치고, 효과음 도구만 들었으면 **새 효과음의 글**을 고른다.
 *  ★성인 분류는 기본으로 보인다 (사용자 결정 2026-09-23). */
export function SfxSection({ sel }: { sel: Layer | null }) {
  const t = useI18n((s) => s.t);
  const s = useEditor();
  const ui = useUi((st) => st.editorSfx);
  const setUi = useUi((st) => st.setEditorSfx);
  const mine = useMine();
  useEffect(() => {
    void mine.load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const m: SfxMeta | null = sel?.sfx ?? null;
  const value = m ? m.value : ui.text;
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value, sel?.id]);
  const setValue = (v: string) => {
    if (m && sel) s.patchSfx(sel.id, { value: v });
    else setUi({ text: v });
  };
  const patch = (p: Partial<SfxMeta>, live = false) => m && sel && s.patchSfx(sel.id, p, live);
  const list: string[] = ui.cat === "mine" ? mine.items : ((PHRASES as Record<string, Record<string, string[]>>)[ui.cat]?.[ui.lang] ?? []);
  const subs = m ? sfxSubstituted(m) : [];

  return (
    <Sec label={t("editor.sfx")}>
      <Line label={t("editor.sfxText")}>
        <input
          data-editor-sfx-text
          value={text}
          onChange={(e) => setText(e.target.value)}
          onBlur={() => text !== value && setValue(text)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Enter") (e.currentTarget as HTMLInputElement).blur();
            if (e.key === "Escape") { setText(value); (e.currentTarget as HTMLInputElement).blur(); }
          }}
          style={{ ...box, flex: 1, minWidth: 0, padding: "2px 6px" }}
        />
      </Line>
      {subs.length > 0 && <span data-editor-sfx-subs><Hint>{t("editor.sfxSubs", { s: subs.join(" ") })}</Hint></span>}
      {/* 문구 모음 — 분류 · 언어, 누르면 그 글로 */}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 2 }}>
        {[...PHRASE_CATS, "mine" as const].map((c) => (
          <button key={c} data-editor-sfx-cat={c} onMouseDown={dropFocus} onClick={() => setUi({ cat: c })} style={{ ...box, ...(ui.cat === c ? on : {}), padding: "1px 7px", fontSize: "var(--text-3xs)" }}>
            {t(CAT_KEY[c])}
          </button>
        ))}
        {ui.cat !== "mine" && (
          <span style={{ marginLeft: "auto", display: "inline-flex", gap: 2 }}>
            {(["ko", "ja", "en"] as const).map((l) => (
              <button key={l} data-editor-sfx-lang={l} onMouseDown={dropFocus} onClick={() => setUi({ lang: l })} style={{ ...box, ...(ui.lang === l ? on : {}), padding: "1px 6px", fontSize: "var(--text-3xs)" }}>
                {l === "ko" ? "한" : l === "ja" ? "日" : "EN"}
              </button>
            ))}
          </span>
        )}
      </div>
      <div data-editor-sfx-phrases style={{ display: "flex", flexWrap: "wrap", gap: 4, maxHeight: 120, overflowY: "auto" }}>
        {list.map((ph, i) => (
          <span key={`${ph}-${i}`} style={{ display: "inline-flex", alignItems: "center" }}>
            <button
              data-editor-sfx-phrase={ph}
              onMouseDown={dropFocus}
              onClick={() => setValue(ph)}
              style={{ ...box, ...(value === ph ? on : {}), padding: "1px 8px", borderTopRightRadius: ui.cat === "mine" ? 0 : undefined, borderBottomRightRadius: ui.cat === "mine" ? 0 : undefined }}
            >
              {ph}
            </button>
            {ui.cat === "mine" && (
              <button
                data-editor-sfx-mine-del={ph}
                onMouseDown={dropFocus}
                onClick={() => {
                  const before = mine.items;
                  void mine.save(before.filter((_, k) => k !== i));
                  undoToast(t("editor.sfxMineRemoved", { s: ph }), t("common.undo"), () => useMine.getState().save(before));
                }}
                data-tip={t("editor.delete")}
                style={{ ...box, display: "grid", padding: "3px 4px", borderLeft: 0, borderTopLeftRadius: 0, borderBottomLeftRadius: 0, color: "var(--ink-faint)" }}
              >
                {Icon.close12}
              </button>
            )}
          </span>
        ))}
        {ui.cat === "mine" && !list.length && <Hint>{t("editor.sfxMineEmpty")}</Hint>}
      </div>
      {ui.cat === "mine" && (
        <button
          data-editor-sfx-mine-add
          disabled={!value.trim() || mine.items.includes(value.trim())}
          onMouseDown={dropFocus}
          onClick={() => void mine.save([...mine.items, value.trim()])}
          style={{ ...box, display: "inline-flex", alignItems: "center", gap: 4, padding: "2px 8px", alignSelf: "flex-start" }}
        >
          {Icon.plus}{t("editor.sfxMineAdd")}
        </button>
      )}
      {m && sel && (
        <>
          <Slider mark="skew" label={t("editor.sfxSkew")} min={-40} max={40} value={Math.round(m.skew)} show={`${Math.round(m.skew)}°`} onChange={(v) => patch({ skew: v }, true)} />
          <Slider mark="jitter" label={t("editor.sfxJitter")} min={0} max={100} value={Math.round(m.jitter * 100)} show={`${Math.round(m.jitter * 100)}`} onChange={(v) => patch({ jitter: v / 100 }, true)} />
          <Slider mark="arc" label={t("editor.sfxArc")} min={-100} max={100} value={Math.round(m.arc * 100)} show={`${Math.round(m.arc * 100)}`} onChange={(v) => patch({ arc: v / 100 }, true)} />
          <Slider mark="spacing" label={t("editor.sfxSpacing")} min={-30} max={60} value={Math.round(m.spacing * 100)} show={`${Math.round(m.spacing * 100)}`} onChange={(v) => patch({ spacing: v / 100 }, true)} />
          <Slider mark="shadow" label={t("editor.sfxShadow")} min={0} max={20} value={Math.round(m.shadow * 100)} show={`${Math.round(m.shadow * 100)}`} onChange={(v) => patch({ shadow: v / 100 }, true)} />
          <Line label="">
            <button data-editor-sfx-vertical onMouseDown={dropFocus} onClick={() => patch({ vertical: !m.vertical })} style={{ ...box, ...(m.vertical ? on : {}), padding: "2px 8px" }}>
              {t("editor.vertical")}
            </button>
            {m.shadow > 0 && <ColorInput data-editor-sfx-shadow-color value={m.shadowColor} onChange={(c) => patch({ shadowColor: c })} style={{ width: 24, height: 18, padding: 0, border: "1px solid var(--line)", borderRadius: 4, background: "transparent" }} data-tip={t("editor.sfxShadowColor")} />}
            <button
              data-editor-sfx-reroll
              onMouseDown={dropFocus}
              onClick={() => patch({ seed: Math.floor(Math.random() * 1e9) + 1 })}
              style={{ ...box, marginLeft: "auto", display: "inline-flex", alignItems: "center", gap: 4, padding: "2px 8px" }}
            >
              {Icon.dice}{t("editor.sfxReroll")}
            </button>
          </Line>
        </>
      )}
    </Sec>
  );
}

/** 슬라이더 한 줄 — 끌기 전에 한 걸음 적고(`markBefore`) 끄는 동안은 이력 없이 */
function Slider({ mark, label, min, max, value, show, onChange }: { mark: string; label: string; min: number; max: number; value: number; show: string; onChange: (v: number) => void }) {
  return (
    <Line label={label}>
      <input type="range" data-editor-sfx-slider={mark} min={min} max={max} value={value} onPointerDown={() => useEditor.getState().markBefore()} onChange={(e) => onChange(Number(e.target.value))} style={{ flex: 1 }} />
      <span style={num}>{show}</span>
    </Line>
  );
}
