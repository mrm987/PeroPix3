import { useEffect, useState } from "react";
import { useUi } from "../store/ui";
import { useI18n } from "../i18n";
import { api, backendUrl } from "../lib/backend";
import { useFiles } from "../store/files";
import { toast } from "../store/toast";
import { FolderOpenButton } from "../components/FolderOpenButton";

/** 플러그인 모드 — **설치된 플러그인마다 캔버스 하나** + 「관리」 탭 (설계: `docs/plugin-design.md`).
 *
 *  ★캔버스는 백엔드가 서빙하는 플러그인 페이지를 iframe 으로 띄운 것이다 (`/plug/<id>/web/`).
 *    같은 오리진(백엔드)이라 페이지가 백엔드 API 를 **직접** 부른다 — 열쇠는 주소에 이미 들어 있다.
 *  ★한 번 연 캔버스는 **숨기기만** 한다 (`hidden`) — 탭을 오가도 플러그인의 상태가 살아 있어야 한다
 *    (PeroPixfy 런처가 iframe 을 한 번만 만드는 것과 같은 까닭). 안 연 것은 만들지 않는다.
 *  ★관리 탭은 1단계에서는 **목록과 폴더 열기**뿐이다. 받기·설치·삭제는 3단계. */

export type PluginInfo = {
  id: string;
  name: string;
  version: string;
  /** 캔버스 주소 — 비면 캔버스가 없는 플러그인 (버튼만 두는 것) */
  web: string;
  ext: string[];
  contributes: Record<string, unknown>;
  /** 못 읽었으면 까닭. 비면 정상 */
  error: string;
  dir: string;
};

const MANAGE = "manage";

export function Plugins() {
  const t = useI18n((s) => s.t);
  const [items, setItems] = useState<PluginInfo[]>([]);
  const [dir, setDir] = useState("");
  const [base, setBase] = useState("");
  /** 어느 탭을 보고 있나 — ★**저장되는 작업 상태**다 (`useUi.view.tab`, 보조 도구와 같다) */
  const tab = useUi((u) => (u.view.tab["plugins"] as string | undefined) ?? "");
  const setTab = (k: string) => useUi.getState().setView("tab", "plugins", k as never);
  const [seen, setSeen] = useState<string[]>([]);

  useEffect(() => {
    void (async () => {
      try {
        const r = await api<{ dir: string; items: PluginInfo[] }>("/api/plugins");
        setItems(r.items);
        setDir(r.dir);
        setBase(await backendUrl());
      } catch (e) {
        toast(String(e), "warn");
      }
    })();
  }, []);

  const canvases = items.filter((p) => p.web && !p.error);
  // ★기억한 탭이 사라졌으면(플러그인을 지웠거나 못 읽음) 첫 캔버스로, 그것도 없으면 관리로
  const cur = canvases.some((p) => p.id === tab) ? tab
    : tab === MANAGE || canvases.length === 0 ? MANAGE
    : canvases[0].id;
  useEffect(() => {
    if (cur !== MANAGE && !seen.includes(cur)) setSeen((s) => [...s, cur]);
  }, [cur, seen]);

  const tabs = [...canvases.map((p) => ({ id: p.id, label: p.name })), { id: MANAGE, label: t("plugins.manage") }];

  return (
    <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column", padding: "var(--sp-4)", gap: "var(--sp-4)" }}>
      {/* 밑줄 탭 — 보조 도구와 같은 어법 */}
      <div style={{ display: "flex", gap: "var(--sp-5)", borderBottom: "1px solid var(--line)", flexShrink: 0 }}>
        {tabs.map((x) => {
          const on = cur === x.id;
          return (
            <button
              key={x.id}
              data-plugin-tab={x.id}
              onClick={() => setTab(x.id)}
              style={{
                padding: "0 2px var(--sp-2)",
                marginBottom: -1,
                fontSize: "var(--text-sm)",
                fontWeight: on ? "var(--w-semi)" : "var(--w-norm)",
                color: on ? "var(--ink)" : "var(--ink-faint)",
                borderBottom: `2px solid ${on ? "var(--accent)" : "transparent"}`,
              }}
            >
              {x.label}
            </button>
          );
        })}
      </div>

      {base &&
        canvases
          .filter((p) => seen.includes(p.id))
          .map((p) => (
            <iframe
              key={p.id}
              data-plugin-canvas={p.id}
              hidden={cur !== p.id}
              title={p.name}
              src={`${base}${p.web}`}
              style={{ flex: 1, minHeight: 0, width: "100%", border: "1px solid var(--line)", borderRadius: "var(--r-2)", background: "var(--bg)" }}
            />
          ))}

      <div hidden={cur !== MANAGE} style={{ flex: 1, minHeight: 0, display: cur === MANAGE ? "flex" : "none", flexDirection: "column", gap: "var(--sp-3)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "var(--sp-2)", fontSize: "var(--text-xs)", color: "var(--ink-soft)" }}>
          <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} data-plugins-dir>
            {dir}
          </span>
          <FolderOpenButton
            data-plugins-open
            tip={t("plugins.openDir")}
            disabled={!dir}
            onClick={() => void useFiles.getState().openDir(dir).catch((e) => toast(String(e), "warn"))}
          />
        </div>
        {items.length === 0 ? (
          <div style={{ fontSize: "var(--text-sm)", color: "var(--ink-dim)" }}>{t("plugins.none")}</div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: "var(--sp-2)" }}>
            {items.map((p) => (
              <div
                key={p.id}
                data-plugin-row={p.id}
                style={{
                  display: "grid",
                  gridTemplateColumns: "1fr auto",
                  gap: "var(--sp-1) var(--sp-3)",
                  padding: "var(--sp-2) var(--sp-3)",
                  border: "1px solid var(--line)",
                  borderRadius: "var(--r-2)",
                  background: "var(--panel)",
                }}
              >
                <span style={{ fontSize: "var(--text-sm)", color: "var(--ink)" }}>
                  {p.name}
                  <span style={{ marginLeft: "var(--sp-2)", fontSize: "var(--text-2xs)", color: "var(--ink-faint)" }}>{p.id}</span>
                </span>
                <span style={{ fontSize: "var(--text-2xs)", color: p.error ? "var(--minus-ink)" : "var(--ink-faint)", fontVariantNumeric: "tabular-nums" }}>
                  {p.error ? t("plugins.broken") : p.version}
                </span>
                {p.error && (
                  <span style={{ gridColumn: "1 / -1", fontSize: "var(--text-2xs)", color: "var(--ink-dim)", whiteSpace: "pre-wrap" }}>{p.error}</span>
                )}
              </div>
            ))}
          </div>
        )}
        <div style={{ fontSize: "var(--text-2xs)", color: "var(--ink-faint)", lineHeight: 1.6 }}>{t("plugins.hint")}</div>
      </div>
    </div>
  );
}
