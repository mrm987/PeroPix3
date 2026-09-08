import { useEffect, useState } from "react";
import { useUi } from "../store/ui";
import { useI18n } from "../i18n";
import { api } from "../lib/backend";
import { useFiles } from "../store/files";
import { toast } from "../store/toast";
import { FolderOpenButton } from "../components/FolderOpenButton";
import { Icon } from "../components/Icon";
import { usePlugins, type PluginInfo } from "../lib/pluginHost";
import { openExternal } from "../lib/openExternal";

/** 플러그인 모드 — **설치된 플러그인마다 캔버스 하나** + 「관리」 (설계: `docs/plugin-design.md`).
 *
 *  ★캔버스는 백엔드가 서빙하는 플러그인 페이지를 iframe 으로 띄운 것이다 (`/plug/<id>/web/`).
 *    같은 오리진(백엔드)이라 페이지가 백엔드 API 를 **직접** 부른다 — 열쇠는 주소에 이미 들어 있다.
 *    앱에 시킬 것은 `postMessage` 로 (`lib/pluginHost` 의 창구).
 *  ★한 번 연 캔버스는 **숨기기만** 한다 (`hidden`) — 탭을 오가도 플러그인의 상태가 살아 있어야 한다
 *    (PeroPixfy 런처가 iframe 을 한 번만 만드는 것과 같은 까닭). 안 연 것은 만들지 않는다.
 *  ★「관리」는 플러그인 탭과 **다른 모양**이다 (오른쪽 끝의 테두리 단추, 사용자 지시 2026-09-08) — 탭 줄에 플러그인이
 *    늘어서도 관리가 그 사이에 섞이지 않는다.
 *  ★관리: 「설치된 플러그인」(켜기/끄기 · 업데이트 · 삭제) 과 「플러그인 목록」(공식 / 유저, 설치만).
 *    업데이트는 설치된 줄에서만 받는다 — 목록은 아직 없는 것만 보여 준다 (사용자 지시 2026-09-08).
 *    ★★설치·삭제·켜기/끄기는 파일과 설정만 바꾼다 — **다시 켜야 적용**된다 (라우터·확장 JS 는 켤 때 붙는다).
 *    끈 플러그인의 단추·메뉴·캔버스는 화면에서 바로 감춘다 (`pluginHost.isOn`). */

const MANAGE = "manage";

type RegItem = {
  id: string;
  name: string;
  version: string;
  description: string;
  source: "bundled" | "repo" | "zip";
  installed: string | null;
  /** 앱과 함께 오는 번들(공식)인가 — 아니면 목록에 오른 유저 플러그인 */
  official: boolean;
  /** 깔린 것보다 높은 판이 있다 */
  update: boolean;
};

/** 남의 플러그인이 오르는 목록 저장소 — 만드는 법·올리는 법(PR)은 저 README 가 정본이다. 여기엔 링크만 둔다
 *  (같은 안내를 앱에도 적으면 두 곳이 되고, 절차가 바뀔 때마다 앱을 다시 배포해야 한다. 사용자 결정 2026-09-08).
 *  백엔드의 기본 목록 주소(`server.py` `PLUGIN_REGISTRY`)와 같은 저장소다. */
const PLUGIN_LIST_REPO = "https://github.com/mrm987/peropix-plugins";

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

  const canvases = items.filter((p) => p.web && !p.error && p.enabled !== false);
  // ★기억한 탭이 사라졌으면(플러그인을 지웠거나 껐거나 못 읽음) 첫 캔버스로, 그것도 없으면 관리로
  const cur = canvases.some((p) => p.id === tab) ? tab
    : tab === MANAGE || canvases.length === 0 ? MANAGE
    : canvases[0].id;
  useEffect(() => {
    if (cur !== MANAGE && !seen.includes(cur)) setSeen((s) => [...s, cur]);
  }, [cur, seen]);

  const onManage = cur === MANAGE;

  return (
    <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column", padding: "var(--sp-4)", gap: "var(--sp-4)" }}>
      {/* 밑줄 탭(플러그인) — 보조 도구와 같은 어법. 관리는 오른쪽 끝의 테두리 단추 */}
      <div style={{ display: "flex", alignItems: "flex-end", gap: "var(--sp-5)", borderBottom: "1px solid var(--line)", flexShrink: 0 }}>
        {canvases.map((p) => {
          const on = cur === p.id;
          return (
            <button
              key={p.id}
              data-plugin-tab={p.id}
              onClick={() => setTab(p.id)}
              style={{
                padding: "0 2px var(--sp-2)",
                marginBottom: -1,
                fontSize: "var(--text-sm)",
                fontWeight: on ? "var(--w-semi)" : "var(--w-norm)",
                color: on ? "var(--ink)" : "var(--ink-faint)",
                borderBottom: `2px solid ${on ? "var(--accent)" : "transparent"}`,
              }}
            >
              {p.name}
            </button>
          );
        })}
        <button
          data-plugin-tab={MANAGE}
          onClick={() => setTab(MANAGE)}
          style={{
            marginLeft: "auto",
            marginBottom: "var(--sp-2)",
            display: "inline-flex",
            alignItems: "center",
            gap: "var(--sp-1)",
            minHeight: 24,
            padding: "0 var(--sp-3)",
            fontSize: "var(--text-xs)",
            border: "1px solid",
            borderColor: onManage ? "var(--accent)" : "var(--line)",
            borderRadius: "var(--r-2)",
            background: onManage ? "var(--accent-bg)" : "var(--panel)",
            color: onManage ? "var(--accent-ink)" : "var(--ink-soft)",
          }}
        >
          <span style={{ display: "grid", placeItems: "center", width: 14, height: 14 }}>{Icon.settings}</span>
          {t("plugins.manage")}
        </button>
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

      {onManage && <Manage items={items} dir={dir} />}
    </div>
  );
}

const row: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "1fr auto",
  alignItems: "center",
  gap: "var(--sp-1) var(--sp-3)",
  padding: "var(--sp-2) var(--sp-3)",
  border: "1px solid var(--line)",
  borderRadius: "var(--r-2)",
  background: "var(--panel)",
};
const cluster: React.CSSProperties = { display: "inline-flex", alignItems: "center", gap: "var(--sp-2)" };
const btn: React.CSSProperties = {
  minHeight: 24,
  padding: "0 var(--sp-3)",
  fontSize: "var(--text-2xs)",
  color: "var(--ink-soft)",
  border: "1px solid var(--line)",
  borderRadius: "var(--r-2)",
  background: "var(--bg)",
};
const accentBtn: React.CSSProperties = { ...btn, background: "var(--accent)", color: "var(--accent-on)", borderColor: "var(--accent)" };
const head: React.CSSProperties = { fontSize: "var(--text-xs)", fontWeight: "var(--w-semi)", color: "var(--ink)" };
const subHead: React.CSSProperties = { fontSize: "var(--text-2xs)", color: "var(--ink-faint)", letterSpacing: 0.3, textTransform: "uppercase" };
const badge: React.CSSProperties = {
  marginLeft: "var(--sp-2)",
  padding: "0 6px",
  fontSize: "var(--text-2xs)",
  lineHeight: "16px",
  border: "1px solid var(--line)",
  borderRadius: "var(--r-2)",
  color: "var(--ink-faint)",
  verticalAlign: "middle",
};
const version: React.CSSProperties = { fontSize: "var(--text-2xs)", color: "var(--ink-faint)", fontVariantNumeric: "tabular-nums" };

function Manage({ items, dir }: { items: PluginInfo[]; dir: string }) {
  const t = useI18n((s) => s.t);
  const [reg, setReg] = useState<RegItem[] | null>(null);
  const [remoteError, setRemoteError] = useState("");
  const [busy, setBusy] = useState("");
  const [zip, setZip] = useState("");
  /** 설치·삭제·켜기/끄기 뒤 — 파일·설정은 바뀌었지만 붙는 것은 다음에 켤 때다 */
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

  const post = (path: string, body: unknown) =>
    api<{ ok: boolean; id: string; pip?: string }>(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

  const install = async (body: { id?: string; zip?: string }) => {
    const key = body.id ?? body.zip ?? "";
    setBusy(key);
    try {
      const r = await post("/api/plugins/install", body);
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
  const setEnabled = async (p: PluginInfo, on: boolean) => {
    setBusy(p.id);
    try {
      await post(`/api/plugins/${encodeURIComponent(p.id)}/enabled`, { enabled: on });
      toast(t("plugins.toggled", { n: p.name, s: t(on ? "plugins.on" : "plugins.off") }));
      setRestart(true);
      await usePlugins.getState().load();
    } catch (e) {
      toast(String(e), "warn");
    } finally {
      setBusy("");
    }
  };

  const regOf = (id: string) => (reg ?? []).find((r) => r.id === id);
  /** 목록 — 아직 없는 것만. 깔린 것의 새 판은 위 「설치된 플러그인」 줄이 맡는다 */
  const listed = (reg ?? []).filter((r) => !r.installed);
  const groups: { key: "official" | "user"; items: RegItem[] }[] = [
    { key: "official", items: listed.filter((r) => r.official) },
    { key: "user", items: listed.filter((r) => !r.official) },
  ].filter((g) => g.items.length > 0) as { key: "official" | "user"; items: RegItem[] }[];

  return (
    <div data-plugins-manage style={{ flex: 1, minHeight: 0, overflowY: "auto", display: "flex", flexDirection: "column", gap: "var(--sp-5)" }}>
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
          <span data-plugins-restart style={{ marginLeft: "auto", display: "inline-flex", alignItems: "center", gap: "var(--sp-2)", fontSize: "var(--text-2xs)", color: "var(--accent-ink)" }}>
            {t("plugins.restart")}
            {/* ★설치·삭제·켜기/끄기는 다음에 켤 때 붙는다 — 여기서 바로 켜게 한다 (사용자 지시 2026-09-08). 껍데기의 `restart_app` */}
            <button
              data-plugins-restart-btn
              onClick={() =>
                void import("@tauri-apps/api/core")
                  .then((m) => m.invoke("restart_app"))
                  .catch((e) => toast(String(e), "warn"))
              }
              style={accentBtn}
            >
              {t("plugins.restartBtn")}
            </button>
          </span>
        )}
      </div>

      <section data-plugins-installed style={{ display: "flex", flexDirection: "column", gap: "var(--sp-2)" }}>
        <div style={head}>{t("plugins.installedHead")}</div>
        {items.length === 0 ? (
          <div style={{ fontSize: "var(--text-sm)", color: "var(--ink-dim)" }}>{t("plugins.none")}</div>
        ) : (
          items.map((p) => {
            const on = p.enabled !== false;
            const r = regOf(p.id);
            return (
              <div key={p.id} data-plugin-row={p.id} data-on={on ? "" : undefined} style={{ ...row, opacity: on ? 1 : 0.6 }}>
                <span style={{ fontSize: "var(--text-sm)", color: "var(--ink)", minWidth: 0 }}>
                  {p.name}
                  <span style={{ marginLeft: "var(--sp-2)", fontSize: "var(--text-2xs)", color: "var(--ink-faint)" }}>{p.id}</span>
                  {r && <span style={badge}>{t(r.official ? "plugins.official" : "plugins.user")}</span>}
                </span>
                <span style={cluster}>
                  <span style={{ ...version, color: p.error ? "var(--minus-ink)" : "var(--ink-faint)" }}>{p.error ? t("plugins.broken") : p.version}</span>
                  {r?.update && (
                    <button data-plugin-update={p.id} disabled={!!busy} onClick={() => void install({ id: p.id })} style={accentBtn}>
                      {busy === p.id ? t("plugins.installing") : `${t("plugins.update")} ${r.version}`}
                    </button>
                  )}
                  <button
                    data-plugin-toggle={p.id}
                    data-on={on ? "" : undefined}
                    disabled={!!busy}
                    onClick={() => void setEnabled(p, !on)}
                    style={{
                      ...btn,
                      display: "inline-flex",
                      alignItems: "center",
                      gap: "var(--sp-1)",
                      borderColor: on ? "var(--accent)" : "var(--line)",
                      background: on ? "var(--accent-bg)" : "var(--panel)",
                      color: on ? "var(--accent-ink)" : "var(--ink-faint)",
                    }}
                  >
                    <span style={{ display: "grid", placeItems: "center", width: 12, height: 12 }}>{on ? Icon.check : Icon.close12}</span>
                    {t(on ? "plugins.on" : "plugins.off")}
                  </button>
                  <button data-plugin-remove={p.id} disabled={!!busy} onClick={() => void remove(p.id)} style={btn}>
                    {t("plugins.remove")}
                  </button>
                </span>
                {p.error && (
                  <span style={{ gridColumn: "1 / -1", fontSize: "var(--text-2xs)", color: "var(--ink-dim)", whiteSpace: "pre-wrap" }}>{p.error}</span>
                )}
              </div>
            );
          })
        )}
      </section>

      <section data-plugins-list style={{ display: "flex", flexDirection: "column", gap: "var(--sp-3)" }}>
        <div style={head}>{t("plugins.availableHead")}</div>
        {reg === null ? (
          <div style={{ fontSize: "var(--text-2xs)", color: "var(--ink-faint)" }}>…</div>
        ) : groups.length === 0 ? (
          <div style={{ fontSize: "var(--text-sm)", color: "var(--ink-dim)" }}>{t("plugins.noAvailable")}</div>
        ) : (
          groups.map((g) => (
            <div key={g.key} data-plugin-group={g.key} style={{ display: "flex", flexDirection: "column", gap: "var(--sp-2)" }}>
              <div style={subHead}>{t(g.key === "official" ? "plugins.official" : "plugins.user")}</div>
              {g.items.map((r) => (
                <div key={r.id} data-plugin-avail={r.id} style={row}>
                  <span style={{ fontSize: "var(--text-sm)", color: "var(--ink)", minWidth: 0 }}>
                    {r.name}
                    <span style={{ marginLeft: "var(--sp-2)", fontSize: "var(--text-2xs)", color: "var(--ink-faint)" }}>{r.id}</span>
                    {r.description && (
                      <span style={{ display: "block", fontSize: "var(--text-2xs)", color: "var(--ink-dim)" }}>{r.description}</span>
                    )}
                  </span>
                  <span style={cluster}>
                    <span style={version}>{r.version}</span>
                    <button data-plugin-install={r.id} disabled={!!busy} onClick={() => void install({ id: r.id })} style={btn}>
                      {busy === r.id ? t("plugins.installing") : t("plugins.install")}
                    </button>
                  </span>
                </div>
              ))}
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
      <button
        data-plugins-author
        onClick={() => openExternal(PLUGIN_LIST_REPO)}
        style={{ alignSelf: "flex-start", background: "none", border: "none", padding: 0, cursor: "pointer", fontSize: "var(--text-2xs)", color: "var(--accent-ink)", textDecoration: "underline" }}
      >
        {t("plugins.author")}
      </button>
    </div>
  );
}
