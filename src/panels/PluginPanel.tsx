import { useEffect } from "react";
import { useUi } from "../store/ui";
import { useI18n } from "../i18n";
import { toast } from "../store/toast";
import { Icon } from "../components/Icon";
import { usePlugins, usePickText, type PluginInfo } from "../lib/pluginHost";
import { linkOf } from "../lib/pluginLink";
import { openExternal } from "../lib/openExternal";
import { currentPan, defaultFrame, raiseFrame, putOnCanvas, useManage } from "../lib/pluginFrames";

/** 오른쪽 「플러그인」 패널 — 생성 모드의 카드덱과 같은 자리·같은 어법의 **간략판** (사용자 선택 2026-09-09, 시안 `Compact.dc.html`).
 *  줄 하나 = 머리글자 · 이름 · GitHub · 꺼내기(+) 또는 상태 점. 설명·판·딱지는 관리 화면에만.
 *  ★꺼진 플러그인은 여기 안 뜬다 — 켜고 끄기는 관리 화면(설치된 목록)에만 (사용자 결정 2026-09-09). 캔버스가 없는(단추만 두는)
 *    플러그인도 꺼낼 것이 없으니 안 뜬다. 줄을 캔버스로 끌어 놓아도 된다 (HTML 드래그, `PluginCanvas.onDrop`). */

export function PluginPanel() {
  const pick = usePickText();   // 플러그인 이름이 언어별 묶음일 수 있다
  const t = useI18n((s) => s.t);
  const items = usePlugins((s) => s.items);
  const hide = useUi((u) => u.view.hide);
  const frames = useUi((u) => u.view.frame);

  useEffect(() => {
    void usePlugins.getState().load().catch((e) => toast(String(e), "warn"));
  }, []);

  const usable = items.filter((p) => p.web && !p.error && p.enabled !== false);
  const onCanvas = usable.filter((p) => !hide[p.id]);
  const folded = onCanvas.filter((p) => frames[p.id]?.fold);

  /** 꺼내기 — 지금 보는 화면의 왼쪽 위에 놓고 맨 앞으로 */
  const takeOut = (p: PluginInfo) => putOnCanvas(p);
  /** 캔버스에 있는 것을 누르면 — 그 프레임이 보이게 화면을 옮기고 맨 앞으로 */
  const focus = (p: PluginInfo) => {
    const pan = currentPan();
    const f = frames[p.id] ?? defaultFrame(p);
    useManage.getState().set(false);
    useUi.getState().setView("pan", "plugins", { ...pan, x: 40 - f.x * pan.z, y: 40 - f.y * pan.z });
    raiseFrame(p.id, f);
  };

  const iconBtn: React.CSSProperties = { width: 22, height: 22, display: "grid", placeItems: "center", borderRadius: "var(--r-1)", color: "var(--ink-faint)", flexShrink: 0 };

  return (
    <div data-plugin-panel style={{ display: "flex", flexDirection: "column", gap: "var(--sp-3)", padding: "var(--sp-4)", minHeight: "100%", boxSizing: "border-box" }}>
      {/* ★관리 단추는 여기 없다 — **캔버스 우상단**으로 옮겼다 (사용자 지시 2026-09-11, `Plugins.tsx`) */}
      <div style={{ display: "flex", alignItems: "center", gap: "var(--sp-2)" }}>
        <span data-plugin-panel-summary style={{ marginLeft: "auto", fontSize: "var(--text-3xs)", color: "var(--ink-faint)" }}>
          {t("plugins.summary", { n: onCanvas.length, m: folded.length })}
        </span>
      </div>

      {usable.length === 0 ? (
        <div style={{ fontSize: "var(--text-2xs)", color: "var(--ink-dim)", padding: "var(--sp-2) 0" }}>{t("plugins.none")}</div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: "var(--sp-1)" }}>
          {usable.map((p) => {
            const on = !hide[p.id];
            const fold = on && !!frames[p.id]?.fold;
            const official = p.origin?.official === true;
            const link = linkOf({ id: p.id, homepage: p.homepage, origin: p.origin });
            return (
              <div
                key={p.id}
                data-plugin-panel-row={p.id}
                data-on={on ? "" : undefined}
                draggable
                onDragStart={(e) => { e.dataTransfer.setData("peropix/plugin", p.id); e.dataTransfer.effectAllowed = "copy"; }}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "var(--sp-3)",
                  height: 36,
                  padding: "0 var(--sp-2) 0 var(--sp-3)",
                  boxSizing: "border-box",
                  border: `1px solid ${on ? (fold ? "var(--accent-line)" : "var(--accent)") : "var(--line)"}`,
                  borderRadius: "var(--r-3)",
                  background: on ? "var(--accent-bg)" : "var(--panel)",
                  opacity: fold ? 0.85 : 1,
                }}
              >
                <span style={{ width: 22, height: 22, flexShrink: 0, display: "grid", placeItems: "center", borderRadius: "var(--r-2)", background: official ? "var(--accent-bg)" : "var(--line-soft)", color: official ? "var(--accent-ink)" : "var(--ink-soft)", fontSize: "var(--text-2xs)", fontWeight: "var(--w-semi)" as never }}>
                  {(pick(p.name).trim()[0] ?? "?").toUpperCase()}
                </span>
                <button
                  data-plugin-panel-name={p.id}
                  onClick={() => (on ? focus(p) : takeOut(p))}
                  title={on ? t(fold ? "plugins.onCanvasFolded" : "plugins.onCanvas") : t("plugins.takeOut")}
                  style={{ flex: 1, minWidth: 0, textAlign: "left", fontSize: "var(--text-xs)", fontWeight: "var(--w-semi)", color: "var(--ink)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}
                >
                  {pick(p.name)}
                </button>
                {link ? (
                  <button data-plugin-panel-link={p.id} title={link} onClick={() => openExternal(link)} style={iconBtn}>{Icon.external}</button>
                ) : (
                  <span style={{ width: 22, flexShrink: 0 }} />
                )}
                {on ? (
                  /* ★꺼내고 나면 **끄는 단추**가 된다 (사용자 지시 2026-09-11). 전에는 켜짐을 알리는 점만 있어,
                     꺼낸 뒤에는 이 줄에서 닫을 길이 없었다 (프레임의 X 로만 닫혔다).
                     ★접힘 표식(`data-plugin-panel-state`)은 그대로 이 자리에 둔다 — 점검이 그것으로 접힘을 본다. */
                  <button
                    data-plugin-panel-state={fold ? "folded" : "canvas"}
                    data-plugin-panel-off={p.id}
                    data-tip={t("plugins.closeFrame")}
                    onClick={() => useUi.getState().setView("hide", p.id, true)}
                    style={{ ...iconBtn, border: "1px solid var(--accent-line)", borderRadius: "var(--r-2)", color: "var(--accent-ink)", opacity: fold ? 0.7 : 1 }}
                  >
                    <span style={{ display: "grid", placeItems: "center", width: 13, height: 13 }}>{Icon.close12}</span>
                  </button>
                ) : (
                  <button data-plugin-panel-out={p.id} data-tip={t("plugins.takeOut")} onClick={() => takeOut(p)} style={{ ...iconBtn, border: "1px solid var(--line)", borderRadius: "var(--r-2)", color: "var(--ink-soft)" }}>
                    <span style={{ display: "grid", placeItems: "center", width: 13, height: 13 }}>{Icon.plus}</span>
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}
      <span style={{ marginTop: "auto", fontSize: "var(--text-3xs)", color: "var(--ink-ghost)", lineHeight: 1.5 }}>{t("plugins.panelHint")}</span>
    </div>
  );
}
