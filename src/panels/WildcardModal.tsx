import { composing } from "../lib/ime";
import { useEffect, useRef, useState } from "react";
import { useI18n } from "../i18n";
import { Icon } from "../components/Icon";
import { findPoolLine, parseWildcardDoc, resolveWildcards } from "../lib/wildcards";
import { useWildcards } from "../store/wildcards";
import { useTagSuggest } from "../blocks/TagSuggest";
import { ask } from "../store/ask";
import { toast } from "../store/toast";

/** 와일드카드 관리. 정의 문서 하나를 고치는 자리 (v2 `#wildcardModal` 이식 2026-08-18).
 *
 *  ★★**문서가 정본이고 목록은 보여 주기만 한다.** 왼쪽 칩을 누르면 편집기의 그 줄로 데려간다.
 *    칩에서 이름을 고치게 만들면 같은 것을 두 자리에서 편집하게 된다 (하나의 정보에 하나의 창구).
 *  ★**미리보기는 저장된 글이 아니라 편집 중인 글로 푼다**. 고치고 나서 바로 시험할 수 있어야
 *    한다 (v2 `runWildcardPreview`). 생성이 쓰는 풀은 저장한 뒤에야 바뀐다.
 *  ★바깥을 눌러도 닫히지 않는다. 긴 글을 쓰다 실수로 날리지 않게, 닫는 길은 닫기 단추뿐이고
 *    저장 안 한 변경이 있으면 한 번 묻는다 (v2 와 같다).
 */
export function WildcardModal() {
  const t = useI18n((s) => s.t);
  const { open, draft, setDraft, setOpen, save, justSaved, dirty, load, loaded } = useWildcards();
  const ta = useRef<HTMLTextAreaElement>(null);
  const [preview, setPreview] = useState("");
  const [out, setOut] = useState("");
  // ★정의 편집기에도 태그 자동완성이 붙는다. 다만 **한 줄에 한 후보**라 쉼표를 안 붙인다
  //   (v2 `dataset.noTagComma`).
  const ac = useTagSuggest(draft, setDraft, ta, { noComma: true });

  useEffect(() => {
    if (open && !loaded) void load().catch(() => {});
  }, [open, loaded, load]);

  if (!open) return null;

  const pools = parseWildcardDoc(draft);
  const names = Object.keys(pools);

  /** 그 풀을 정의한 줄로 데려간다. 줄을 통째로 선택해 눈에 띄게 하고 가운데로 굴린다 */
  const jump = (name: string) => {
    const el = ta.current;
    if (!el) return;
    const at = findPoolLine(draft, name);
    if (at < 0) return;
    const lines = draft.split("\n");
    let offset = 0;
    for (let i = 0; i < at; i++) offset += lines[i].length + 1;
    el.focus();
    el.setSelectionRange(offset, offset + lines[at].length);
    const cs = window.getComputedStyle(el);
    const lh = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.5;
    el.scrollTop = Math.max(0, at * lh - el.clientHeight / 2 + lh);
  };

  const close = async () => {
    if (
      dirty() &&
      !(await ask({
        title: t("wc.discardTitle"),
        body: t("wc.discardBody"),
        ok: t("wc.discardOk"),
        cancel: t("wc.discardCancel"),
        danger: true,
      }))
    )
      return;
    setOpen(false);
  };

  const doSave = async () => {
    try {
      await save();
    } catch (e) {
      toast(t("wc.saveFailed", { m: String((e as Error).message ?? e) }), "warn");
    }
  };

  return (
    <div
      data-wildcard-modal
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 70,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "rgba(10,14,19,0.55)",
        backdropFilter: "blur(2px)",
      }}
    >
      <div
        style={{
          width: "min(920px, 92vw)",
          height: "min(680px, 82vh)",
          display: "flex",
          flexDirection: "column",
          borderRadius: "var(--r-4)",
          background: "var(--panel)",
          border: "1px solid var(--line)",
          boxShadow: "0 20px 50px rgba(0,0,0,0.45)",
          overflow: "hidden",
        }}
      >
        {/* 머리 */}
        <div
          style={{
            flexShrink: 0,
            height: 40,
            display: "flex",
            alignItems: "center",
            gap: "var(--sp-3)",
            padding: "0 var(--sp-3) 0 var(--sp-5)",
            borderBottom: "1px solid var(--line)",
          }}
        >
          <b style={{ fontSize: "var(--text-sm)" }}>{t("wc.title")}</b>
          <span style={{ fontSize: "var(--text-2xs)", color: "var(--ink-faint)" }}>
            {t("wc.subtitle")}
          </span>
          <span style={{ flex: 1 }} />
          <button
            data-wildcard-close
            onClick={() => void close()}
            data-tip={t("wc.close")}
            style={{ color: "var(--ink-dim)", display: "grid", padding: "0 var(--sp-2)" }}
          >
            {Icon.close}
          </button>
        </div>

        {/* 몸 */}
        <div style={{ flex: 1, minHeight: 0, display: "flex" }}>
          {/* 왼쪽: 등록된 풀 + 도움말 */}
          <div
            style={{
              width: 232,
              flexShrink: 0,
              display: "flex",
              flexDirection: "column",
              borderRight: "1px solid var(--line)",
            }}
          >
            <div
              style={{
                flexShrink: 0,
                display: "flex",
                alignItems: "center",
                gap: "var(--sp-2)",
                padding: "var(--sp-3) var(--sp-4) var(--sp-2)",
                fontSize: "var(--text-2xs)",
                fontWeight: "var(--w-semi)",
                color: "var(--ink-dim)",
              }}
            >
              <span>{t("wc.pools")}</span>
              <span style={{ color: "var(--ink-faint)", fontWeight: "var(--w-normal)" }}>{names.length}</span>
            </div>

            <div style={{ flexShrink: 0, maxHeight: "42%", overflowY: "auto", padding: "0 var(--sp-3)" }}>
              {!names.length && (
                <div
                  style={{
                    padding: "var(--sp-2) var(--sp-1)",
                    fontSize: "var(--text-2xs)",
                    color: "var(--ink-faint)",
                    lineHeight: 1.6,
                  }}
                >
                  {t("wc.empty")}
                </div>
              )}
              {names.map((n) => (
                <button
                  key={n}
                  data-wc-pool={n}
                  onClick={() => jump(n)}
                  data-tip={t("wc.jump")}
                  style={{
                    width: "100%",
                    display: "flex",
                    alignItems: "center",
                    gap: "var(--sp-2)",
                    marginBottom: 2,
                    padding: "3px var(--sp-2)",
                    borderRadius: "var(--r-1)",
                    background: "var(--bg)",
                    border: "1px solid var(--line)",
                    fontSize: "var(--text-2xs)",
                    color: "var(--ink-soft)",
                    textAlign: "left",
                  }}
                >
                  <span
                    style={{
                      flex: 1,
                      minWidth: 0,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                      fontFamily: "var(--font-mono)",
                    }}
                  >
                    #{n}
                  </span>
                  <span style={{ flexShrink: 0, color: "var(--ink-faint)" }}>{pools[n].length}</span>
                </button>
              ))}
            </div>

            <div
              style={{
                flex: 1,
                minHeight: 0,
                overflowY: "auto",
                margin: "var(--sp-3) 0 0",
                padding: "var(--sp-3) var(--sp-4) var(--sp-4)",
                borderTop: "1px solid var(--line)",
                fontSize: "var(--text-2xs)",
                color: "var(--ink-dim)",
                lineHeight: 1.7,
              }}
            >
              <b style={{ color: "var(--ink-soft)" }}>{t("wc.helpTitle")}</b>
              <div style={{ marginBottom: "var(--sp-3)" }}>{t("wc.helpWhat")}</div>

              <b style={{ color: "var(--ink-soft)" }}>{t("wc.help1Title")}</b>
              <div>{t("wc.help1")}</div>
              <Sample>{"#hair\nblonde hair\n(black hair:1.2)"}</Sample>

              <b style={{ color: "var(--ink-soft)" }}>{t("wc.help2Title")}</b>
              <div style={{ marginBottom: "var(--sp-3)" }}>{t("wc.help2")}</div>

              <b style={{ color: "var(--ink-soft)" }}>{t("wc.help3Title")}</b>
              <div>{t("wc.help3a")}</div>
              <div>{t("wc.help3b")}</div>
            </div>
          </div>

          {/* 오른쪽: 정의 문서 + 미리보기 */}
          <div
            style={{
              flex: 1,
              minWidth: 0,
              display: "flex",
              flexDirection: "column",
              gap: "var(--sp-3)",
              padding: "var(--sp-4)",
            }}
          >
            <textarea
              ref={ta}
              data-wildcard-editor
              value={draft}
              spellCheck={false}
              onChange={ac.onChange}
              // ★붙여넣은 직후에는 자동완성을 안 띄운다 (`useTagSuggest` 의 ★★주)
              onPaste={ac.onPaste}
              onKeyDown={(e) => {
                ac.onKeyDown(e);
              }}
              placeholder={t("wc.editorPlaceholder")}
              style={{
                flex: 1,
                minHeight: 0,
                resize: "none",
                padding: "var(--sp-3)",
                borderRadius: "var(--r-2)",
                border: "1px solid var(--line)",
                background: "var(--bg)",
                color: "var(--ink)",
                fontFamily: "var(--font-mono)",
                fontSize: "var(--text-2xs)",
                lineHeight: 1.7,
              }}
            />

            <div style={{ flexShrink: 0, display: "flex", gap: "var(--sp-2)" }}>
              <input
                data-wc-preview-input
                value={preview}
                onChange={(e) => setPreview(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !composing(e)) setOut(resolveWildcards(preview, pools));
                }}
                placeholder={t("wc.previewPlaceholder")}
                style={{
                  flex: 1,
                  minWidth: 0,
                  padding: "var(--sp-2) var(--sp-3)",
                  borderRadius: "var(--r-2)",
                  border: "1px solid var(--line)",
                  background: "var(--panel)",
                  fontSize: "var(--text-2xs)",
                }}
              />
              <button
                data-wc-preview-run
                onClick={() => setOut(resolveWildcards(preview, pools))}
                style={{
                  flexShrink: 0,
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "var(--sp-2)",
                  padding: "var(--sp-2) var(--sp-4)",
                  borderRadius: "var(--r-2)",
                  border: "1px solid var(--line)",
                  background: "var(--panel)",
                  color: "var(--ink-soft)",
                  fontSize: "var(--text-2xs)",
                }}
              >
                {Icon.cards}
                {t("wc.preview")}
              </button>
            </div>

            <div
              data-wc-preview-out
              style={{
                flexShrink: 0,
                minHeight: 46,
                maxHeight: 92,
                overflowY: "auto",
                padding: "var(--sp-2) var(--sp-3)",
                borderRadius: "var(--r-2)",
                background: "var(--bg)",
                border: "1px solid var(--line)",
                fontFamily: "var(--font-mono)",
                fontSize: "var(--text-2xs)",
                lineHeight: 1.6,
                color: out ? "var(--ink-soft)" : "var(--ink-faint)",
                whiteSpace: "pre-wrap",
                wordBreak: "break-all",
              }}
            >
              {out || t("wc.previewEmpty")}
            </div>
          </div>
        </div>

        {/* 발 */}
        <div
          style={{
            flexShrink: 0,
            height: 48,
            display: "flex",
            alignItems: "center",
            gap: "var(--sp-3)",
            padding: "0 var(--sp-4)",
            borderTop: "1px solid var(--line)",
          }}
        >
          <span style={{ fontSize: "var(--text-2xs)", color: justSaved ? "var(--ok)" : "var(--ink-faint)" }}>
            {justSaved ? t("wc.saved") : dirty() ? t("wc.dirty") : ""}
          </span>
          <span style={{ flex: 1 }} />
          <button
            data-wildcard-save
            onClick={() => void doSave()}
            style={{
              padding: "var(--sp-2) var(--sp-5)",
              borderRadius: "var(--r-2)",
              border: "none",
              background: "var(--accent)",
              color: "var(--accent-on)",
              fontSize: "var(--text-xs)",
              fontWeight: "var(--w-semi)",
            }}
          >
            {t("wc.save")}
          </button>
        </div>
      </div>
      {ac.node}
    </div>
  );
}

/** 도움말 안의 짧은 예시. 코드 블록과 같은 톤 */
function Sample({ children }: { children: string }) {
  return (
    <pre
      style={{
        margin: "var(--sp-2) 0 var(--sp-3)",
        padding: "var(--sp-2)",
        borderRadius: "var(--r-1)",
        background: "var(--code-bg)",
        fontFamily: "var(--font-mono)",
        fontSize: "var(--text-2xs)",
        lineHeight: 1.6,
        color: "var(--ink-soft)",
        whiteSpace: "pre-wrap",
      }}
    >
      {children}
    </pre>
  );
}

/** 여는 단추. 프롬프트 기둥의 카테고리 머리에 붙는다 (v2 는 프롬프트 라벨 줄이었다) */
export function WildcardButton() {
  const t = useI18n((s) => s.t);
  const open = useWildcards((s) => s.open);
  const setOpen = useWildcards((s) => s.setOpen);
  return (
    <button
      data-wildcard-toggle
      data-on={open ? "" : undefined}
      onClick={() => setOpen(!open)}
      data-tip={t("wc.openHint")}
      style={{ color: open ? "var(--accent-ink)" : "var(--ink-faint)", display: "grid", padding: "0 4px" }}
    >
      {Icon.cards}
    </button>
  );
}
