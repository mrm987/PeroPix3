import { useEffect, useState } from "react";
import { useUi } from "../store/ui";
import { useI18n } from "../i18n";
import { api } from "../lib/backend";
import { useFiles } from "../store/files";
import { toast } from "../store/toast";
import { FolderOpenButton } from "../components/FolderOpenButton";
import { usePlugins, type PluginInfo } from "../lib/pluginHost";

/** 플러그인 모드 — **설치된 플러그인마다 캔버스 하나** + 「관리」 탭 (설계: `docs/plugin-design.md`).
 *
 *  ★캔버스는 백엔드가 서빙하는 플러그인 페이지를 iframe 으로 띄운 것이다 (`/plug/<id>/web/`).
 *    같은 오리진(백엔드)이라 페이지가 백엔드 API 를 **직접** 부른다 — 열쇠는 주소에 이미 들어 있다.
 *    앱에 시킬 것은 `postMessage` 로 (`lib/pluginHost` 의 창구).
 *  ★한 번 연 캔버스는 **숨기기만** 한다 (`hidden`) — 탭을 오가도 플러그인의 상태가 살아 있어야 한다
 *    (PeroPixfy 런처가 iframe 을 한 번만 만드는 것과 같은 까닭). 안 연 것은 만들지 않는다.
 *  ★관리 탭: 설치됨(삭제) · 받을 수 있음(공식 번들 + 원격 목록, 설치/업데이트) · zip 주소로 설치.
 *    ★★설치·삭제는 파일만 바꾼다 — **다시 켜야 적용**된다 (라우터·확장 JS 는 켤 때 붙는다). */

const MANAGE = "manage";

type RegItem = {
  id: string;
  name: string;
  version: string;
  description: string;
  source: "bundled" | "zip";
  installed: string | null;
};

export function Plugins() {
  const t = useI18n((s) => s.t);
  const items = usePlugins((s) => s.items);
  const dir = usePlugins((s) => s.dir);
  const base = usePlugins((s) => s.base);
  /** 어느 탭을 보고 있나 — ★**저장되는 작업 상태**다 (`useUi.view.tab`, 보조 도구와 같다) */
  const tab = useUi((u) => (u.view.tab["plugins"] as string | undefined) ?? "");
  const setTab = (k: string) => useUi.getState().setView("tab", "plugins", k as never);
  const [seen, setSeen] = useState<string[]>([]);

  useEffect(() => {
    void usePlugins.getState().load().catch((e) => toast(String(e), "warn"));
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

      {cur === MANAGE && <Manage items={items} dir={dir} />}
    </div>
  );
}

const row: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "1fr auto auto",
  alignItems: "center",
  gap: "var(--sp-1) var(--sp-3)",
  padding: "var(--sp-2) var(--sp-3)",
  border: "1px solid var(--line)",
  borderRadius: "var(--r-2)",
  background: "var(--panel)",
};
const btn: React.CSSProperties = {
  minHeight: 24,
  padding: "0 var(--sp-3)",
  fontSize: "var(--text-2xs)",
  color: "var(--ink-soft)",
  border: "1px solid var(--line)",
  borderRadius: "var(--r-2)",
  background: "var(--bg)",
};
const head: React.CSSProperties = { fontSize: "var(--text-2xs)", color: "var(--ink-faint)", letterSpacing: 0.3, textTransform: "uppercase" };

function Manage({ items, dir }: { items: PluginInfo[]; dir: string }) {
  const t = useI18n((s) => s.t);
  const [reg, setReg] = useState<RegItem[] | null>(null);
  const [remoteError, setRemoteError] = useState("");
  const [busy, setBusy] = useState("");
  const [zip, setZip] = useState("");
  /** 설치·삭제 뒤 — 파일은 바뀌었지만 붙는 것은 다음에 켤 때다 */
  const [restart, setRestart] = useState(false);

  const loadReg = async () => {
    try {
      const r = await api<{ items: RegItem[]; remoteError: string }>("/api/plugins/registry");
      setReg(r.items);
      setRemoteError(r.remoteError);
    } catch (e) {
      setReg([]);
      setRemoteError(String(e));
    }
  };
  useEffect(() => {
    void loadReg();
  }, []);

  const install = async (body: { id?: string; zip?: string }) => {
    const key = body.id ?? body.zip ?? "";
    setBusy(key);
    try {
      const r = await api<{ ok: boolean; id: string; pip?: string }>("/api/plugins/install", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      toast(t("plugins.installed", { n: r.id }));
      setRestart(true);
      setZip("");
      await Promise.all([loadReg(), usePlugins.getState().load()]);
    } catch (e) {
      toast(String(e), "warn");
    } finally {
      setBusy("");
    }
  };
  const remove = async (id: string) => {
    setBusy(id);
    try {
      await api(`/api/plugins/${encodeURIComponent(id)}`, { method: "DELETE" });
      toast(t("plugins.removed", { n: id }));
      setRestart(true);
      await Promise.all([loadReg(), usePlugins.getState().load()]);
    } catch (e) {
      toast(String(e), "warn");
    } finally {
      setBusy("");
    }
  };

  const available = (reg ?? []).filter((r) => !r.installed || (r.version && r.installed !== r.version));

  return (
    <div data-plugins-manage style={{ flex: 1, minHeight: 0, overflowY: "auto", display: "flex", flexDirection: "column", gap: "var(--sp-4)" }}>
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
        {restart && (
          <span data-plugins-restart style={{ marginLeft: "auto", fontSize: "var(--text-2xs)", color: "var(--accent-ink)" }}>
            {t("plugins.restart")}
          </span>
        )}
      </div>

      <section style={{ display: "flex", flexDirection: "column", gap: "var(--sp-2)" }}>
        <div style={head}>{t("plugins.installedHead")}</div>
        {items.length === 0 ? (
          <div style={{ fontSize: "var(--text-sm)", color: "var(--ink-dim)" }}>{t("plugins.none")}</div>
        ) : (
          items.map((p) => (
            <div key={p.id} data-plugin-row={p.id} style={row}>
              <span style={{ fontSize: "var(--text-sm)", color: "var(--ink)", minWidth: 0 }}>
                {p.name}
                <span style={{ marginLeft: "var(--sp-2)", fontSize: "var(--text-2xs)", color: "var(--ink-faint)" }}>{p.id}</span>
              </span>
              <span style={{ fontSize: "var(--text-2xs)", color: p.error ? "var(--minus-ink)" : "var(--ink-faint)", fontVariantNumeric: "tabular-nums" }}>
                {p.error ? t("plugins.broken") : p.version}
              </span>
              <button data-plugin-remove={p.id} disabled={!!busy} onClick={() => void remove(p.id)} style={btn}>
                {t("plugins.remove")}
              </button>
              {p.error && (
                <span style={{ gridColumn: "1 / -1", fontSize: "var(--text-2xs)", color: "var(--ink-dim)", whiteSpace: "pre-wrap" }}>{p.error}</span>
              )}
            </div>
          ))
        )}
      </section>

      <section style={{ display: "flex", flexDirection: "column", gap: "var(--sp-2)" }}>
        <div style={head}>{t("plugins.availableHead")}</div>
        {reg === null ? (
          <div style={{ fontSize: "var(--text-2xs)", color: "var(--ink-faint)" }}>…</div>
        ) : available.length === 0 ? (
          <div style={{ fontSize: "var(--text-sm)", color: "var(--ink-dim)" }}>{t("plugins.noAvailable")}</div>
        ) : (
          available.map((r) => (
            <div key={r.id} data-plugin-avail={r.id} style={row}>
              <span style={{ fontSize: "var(--text-sm)", color: "var(--ink)", minWidth: 0 }}>
                {r.name}
                <span style={{ marginLeft: "var(--sp-2)", fontSize: "var(--text-2xs)", color: "var(--ink-faint)" }}>
                  {r.id}
                  {r.source === "bundled" ? ` · ${t("plugins.official")}` : ""}
                </span>
                {r.description && (
                  <span style={{ display: "block", fontSize: "var(--text-2xs)", color: "var(--ink-dim)" }}>{r.description}</span>
                )}
              </span>
              <span style={{ fontSize: "var(--text-2xs)", color: "var(--ink-faint)", fontVariantNumeric: "tabular-nums" }}>{r.version}</span>
              <button data-plugin-install={r.id} disabled={!!busy} onClick={() => void install({ id: r.id })} style={btn}>
                {busy === r.id ? t("plugins.installing") : r.installed ? t("plugins.update") : t("plugins.install")}
              </button>
            </div>
          ))
        )}
        {remoteError && (
          <div style={{ fontSize: "var(--text-2xs)", color: "var(--ink-faint)" }}>{t("plugins.registryFail")}</div>
        )}
        <div style={{ display: "flex", gap: "var(--sp-2)", alignItems: "center" }}>
          <input
            data-plugin-zip
            value={zip}
            onChange={(e) => setZip(e.target.value)}
            placeholder={t("plugins.zipUrl")}
            style={{ flex: 1, minWidth: 0, height: 26, padding: "0 var(--sp-2)", fontSize: "var(--text-xs)", border: "1px solid var(--line)", borderRadius: "var(--r-2)", background: "var(--bg)", color: "var(--ink)" }}
          />
          <button data-plugin-install-zip disabled={!!busy || !/^https?:\/\//.test(zip.trim())} onClick={() => void install({ zip: zip.trim() })} style={btn}>
            {busy && busy === zip.trim() ? t("plugins.installing") : t("plugins.installZip")}
          </button>
        </div>
      </section>

      <div style={{ fontSize: "var(--text-2xs)", color: "var(--ink-faint)", lineHeight: 1.6 }}>{t("plugins.hint")}</div>
    </div>
  );
}
