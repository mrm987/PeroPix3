import { useEffect, useState } from "react";
import { create } from "zustand";
import { useUi } from "../store/ui";
import { useI18n, t as tr } from "../i18n";
import { api } from "../lib/backend";
import { useFiles } from "../store/files";
import { toast } from "../store/toast";
import { FolderOpenButton } from "../components/FolderOpenButton";
import { Icon } from "../components/Icon";
import { usePlugins, type PluginInfo } from "../lib/pluginHost";
import { openExternal } from "../lib/openExternal";

/** 플러그인 모드 — **설치된 플러그인마다 캔버스 탭 하나** + 「설치된 플러그인」·「플러그인 목록」 두 화면 (설계: `docs/plugin-design.md`).
 *
 *  ★캔버스는 백엔드가 서빙하는 플러그인 페이지를 iframe 으로 띄운 것이다 (`/plug/<id>/web/`).
 *    같은 오리진(백엔드)이라 페이지가 백엔드 API 를 **직접** 부른다 — 열쇠는 주소에 이미 들어 있다.
 *    앱에 시킬 것은 `postMessage` 로 (`lib/pluginHost` 의 창구).
 *  ★한 번 연 캔버스는 **숨기기만** 한다 (`hidden`) — 탭을 오가도 플러그인의 상태가 살아 있어야 한다
 *    (PeroPixfy 런처가 iframe 을 한 번만 만드는 것과 같은 까닭). 안 연 것은 만들지 않는다.
 *  ★캔버스 탭은 워크스페이스 탭처럼 × 로 닫고 + 로 다시 연다 (사용자 지시 2026-09-08). + 는 언제나 있고, 닫은 것이
 *    없으면 「모든 플러그인 탭이 열려 있습니다」 를 보여 준다. 닫는 것은 화면 상태(`useUi.view.hide`)일 뿐이다.
 *  ★「설치된 플러그인」 과 「플러그인 목록」 은 **다른 화면**이다 (사용자 지시 2026-09-08) — 오른쪽 끝의 테두리 단추 둘.
 *    업데이트는 **양쪽 어디서나** 받는다. 받는 중·다시 켜기 안내는 두 화면이 한 상태(`useMgr`)를 본다.
 *    ★★설치·삭제·업데이트·켜기/끄기는 파일과 설정만 바꾼다 — **다시 켜야 적용**된다 (라우터·확장 JS 는 켤 때 붙는다). */

const INSTALLED = "installed";
const LIST = "list";
/** 옛 저장본의 탭 이름 — 지금은 「설치된 플러그인」 */
const MANAGE_LEGACY = "manage";

type RegItem = {
  id: string;
  name: string;
  version: string;
  description: string;
  source: "bundled" | "repo" | "zip";
  installed: string | null;
  /** 앱과 함께 오는 번들(공식)인가 — 아니면 목록에 오른 유저 플러그인 */
  official: boolean;
  /** 깔린 것보다 높은 판이 같은 출처에 있다 */
  update: boolean;
};

/** 남의 플러그인이 오르는 목록 저장소 — 만드는 법·올리는 법(PR)은 저 README 가 정본이다. 여기엔 링크만 둔다
 *  (같은 안내를 앱에도 적으면 두 곳이 되고, 절차가 바뀔 때마다 앱을 다시 배포해야 한다. 사용자 결정 2026-09-08).
 *  백엔드의 기본 목록 주소(`server.py` `PLUGIN_REGISTRY`)와 같은 저장소다. */
const PLUGIN_LIST_REPO = "https://github.com/mrm987/peropix-plugins";

/** 두 화면이 함께 보는 관리 상태 — 목록·받는 중·다시 켜기 안내. ★화면을 오가도 「받는 중」이 끊기지 않는다 */
type Mgr = {
  reg: RegItem[] | null;
  remoteError: string;
  /** 지금 받는/지우는/켜고 끄는 대상 (id 또는 zip 주소). 비면 한가하다 */
  busy: string;
  /** 설치·삭제·업데이트·켜기/끄기 뒤 — 파일·설정은 바뀌었지만 붙는 것은 다음에 켤 때다 */
  restart: boolean;
  loadReg: () => Promise<void>;
  install: (body: { id?: string; zip?: string }) => Promise<void>;
  remove: (id: string) => Promise<void>;
  setEnabled: (p: PluginInfo, on: boolean) => Promise<void>;
};

const post = (path: string, body: unknown) =>
  api<{ ok: boolean; id: string; pip?: string }>(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

const useMgr = create<Mgr>((set, get) => ({
  reg: null,
  remoteError: "",
  busy: "",
  restart: false,
  async loadReg() {
    try {
      const r = await api<{ items: RegItem[]; remoteError: string }>("/api/plugins/registry");
      set({ reg: r.items, remoteError: r.remoteError });
    } catch (e) {
      set({ reg: [], remoteError: String(e) });
    }
  },
  async install(body) {
    if (get().busy) return;
    set({ busy: body.id ?? body.zip ?? "" });
    try {
      const r = await post("/api/plugins/install", body);
      toast(tr("plugins.installed", { n: r.id }));
      set({ restart: true });
      await Promise.all([get().loadReg(), usePlugins.getState().load()]);
    } catch (e) {
      toast(String(e), "warn");
    } finally {
      set({ busy: "" });
    }
  },
  async remove(id) {
    if (get().busy) return;
    set({ busy: id });
    try {
      await api(`/api/plugins/${encodeURIComponent(id)}`, { method: "DELETE" });
      toast(tr("plugins.removed", { n: id }));
      set({ restart: true });
      await Promise.all([get().loadReg(), usePlugins.getState().load()]);
    } catch (e) {
      toast(String(e), "warn");
    } finally {
      set({ busy: "" });
    }
  },
  async setEnabled(p, on) {
    if (get().busy) return;
    set({ busy: p.id });
    try {
      await post(`/api/plugins/${encodeURIComponent(p.id)}/enabled`, { enabled: on });
      toast(tr("plugins.toggled", { n: p.name, s: tr(on ? "plugins.on" : "plugins.off") }));
      set({ restart: true });
      await usePlugins.getState().load();
    } catch (e) {
      toast(String(e), "warn");
    } finally {
      set({ busy: "" });
    }
  },
}));

export function Plugins() {
  const t = useI18n((s) => s.t);
  const items = usePlugins((s) => s.items);
  const dir = usePlugins((s) => s.dir);
  const base = usePlugins((s) => s.base);
  /** 어느 탭을 보고 있나 — ★**저장되는 작업 상태**다 (`useUi.view.tab`, 보조 도구와 같다) */
  const tabRaw = useUi((u) => (u.view.tab["plugins"] as string | undefined) ?? "");
  const tab = tabRaw === MANAGE_LEGACY ? INSTALLED : tabRaw;
  const setTab = (k: string) => useUi.getState().setView("tab", "plugins", k as never);
  const [seen, setSeen] = useState<string[]>([]);
  const hide = useUi((u) => u.view.hide);
  const setHide = (id: string, v: boolean) => useUi.getState().setView("hide", id, v);
  const [picking, setPicking] = useState(false);

  useEffect(() => {
    void usePlugins.getState().load().catch((e) => toast(String(e), "warn"));
  }, []);

  /** 캔버스가 있고 켜진 플러그인 — 탭이 될 수 있는 것 */
  const usable = items.filter((p) => p.web && !p.error && p.enabled !== false);
  /** 열린 탭. ★설치하면 기본은 열림 (`hide` 에 없음). 닫은 것은 + 로 다시 연다 */
  const canvases = usable.filter((p) => !hide[p.id]);
  const closed = usable.filter((p) => hide[p.id]);
  // ★기억한 탭이 사라졌으면(플러그인을 지웠거나 껐거나 닫았거나 못 읽음) 첫 캔버스로, 그것도 없으면 설치된 플러그인으로
  const cur = canvases.some((p) => p.id === tab) ? tab
    : tab === INSTALLED || tab === LIST ? tab
    : canvases.length === 0 ? INSTALLED
    : canvases[0].id;
  useEffect(() => {
    if (cur !== INSTALLED && cur !== LIST && !seen.includes(cur)) setSeen((s) => [...s, cur]);
  }, [cur, seen]);

  const screenBtn = (id: string, label: string, icon: React.ReactNode) => {
    const on = cur === id;
    return (
      <button
        data-plugin-tab={id}
        onClick={() => setTab(id)}
        style={{
          marginBottom: "var(--sp-2)",
          display: "inline-flex",
          alignItems: "center",
          gap: "var(--sp-1)",
          minHeight: 24,
          padding: "0 var(--sp-3)",
          fontSize: "var(--text-xs)",
          border: "1px solid",
          borderColor: on ? "var(--accent)" : "var(--line)",
          borderRadius: "var(--r-2)",
          background: on ? "var(--accent-bg)" : "var(--panel)",
          color: on ? "var(--accent-ink)" : "var(--ink-soft)",
        }}
      >
        <span style={{ display: "grid", placeItems: "center", width: 14, height: 14 }}>{icon}</span>
        {label}
      </button>
    );
  };

  return (
    <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column", padding: "var(--sp-4)", gap: "var(--sp-4)" }}>
      {/* 밑줄 탭(플러그인, × 로 닫음) + 닫은 것을 여는 + — 워크스페이스 탭과 같은 어법. 오른쪽 끝은 두 화면의 테두리 단추 */}
      <div style={{ position: "relative", display: "flex", alignItems: "flex-end", gap: "var(--sp-5)", borderBottom: "1px solid var(--line)", flexShrink: 0 }}>
        {canvases.map((p) => {
          const on = cur === p.id;
          return (
            <span key={p.id} style={{ display: "inline-flex", alignItems: "center", gap: "var(--sp-1)", marginBottom: -1, borderBottom: `2px solid ${on ? "var(--accent)" : "transparent"}` }}>
              <button
                data-plugin-tab={p.id}
                onClick={() => setTab(p.id)}
                style={{
                  padding: "0 2px var(--sp-2)",
                  fontSize: "var(--text-sm)",
                  fontWeight: on ? "var(--w-semi)" : "var(--w-norm)",
                  color: on ? "var(--ink)" : "var(--ink-faint)",
                }}
              >
                {p.name}
              </button>
              <button
                data-plugin-tab-close={p.id}
                data-tip={t("plugins.closeTab")}
                onClick={() => setHide(p.id, true)}
                style={{ display: "grid", placeItems: "center", padding: "0 0 var(--sp-2)", color: "var(--ink-ghost)" }}
              >
                {Icon.close12}
              </button>
            </span>
          );
        })}
        <button
          data-plugin-tab-add
          data-tip={t("plugins.addTab")}
          onClick={() => setPicking((v) => !v)}
          style={{ display: "grid", placeItems: "center", padding: "0 var(--sp-2) var(--sp-2)", color: "var(--ink-faint)" }}
        >
          {Icon.plus}
        </button>
        {picking && (
          <div
            data-plugin-tab-pick
            style={{
              position: "absolute",
              top: "100%",
              left: 0,
              zIndex: 5,
              marginTop: 4,
              minWidth: 180,
              padding: "var(--sp-1)",
              display: "flex",
              flexDirection: "column",
              border: "1px solid var(--line)",
              borderRadius: "var(--r-2)",
              background: "var(--panel)",
              boxShadow: "var(--shadow-2)",
            }}
          >
            {closed.length === 0 ? (
              <span data-plugin-tab-all-open style={{ padding: "var(--sp-1) var(--sp-3)", fontSize: "var(--text-xs)", color: "var(--ink-faint)" }}>
                {t("plugins.allTabsOpen")}
              </span>
            ) : (
              closed.map((p) => (
                <button
                  key={p.id}
                  data-plugin-tab-open={p.id}
                  onClick={() => {
                    setHide(p.id, false);
                    setTab(p.id);
                    setPicking(false);
                  }}
                  style={{ textAlign: "left", padding: "var(--sp-1) var(--sp-3)", fontSize: "var(--text-sm)", color: "var(--ink)", borderRadius: "var(--r-1)" }}
                >
                  {p.name}
                </button>
              ))
            )}
          </div>
        )}
        <span style={{ marginLeft: "auto", display: "inline-flex", gap: "var(--sp-2)" }}>
          {screenBtn(INSTALLED, t("plugins.installedHead"), Icon.settings)}
          {screenBtn(LIST, t("plugins.availableHead"), Icon.plus)}
        </span>
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

      {cur === INSTALLED && <Installed items={items} dir={dir} />}
      {cur === LIST && <List dir={dir} />}
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

/** 업데이트 단추 — 두 화면이 같은 것을 쓴다 (같은 출처의 새 판이 있을 때만) */
function UpdateButton({ r }: { r: RegItem }) {
  const t = useI18n((s) => s.t);
  const busy = useMgr((m) => m.busy);
  if (!r.update) return null;
  return (
    <button data-plugin-update={r.id} disabled={!!busy} onClick={() => void useMgr.getState().install({ id: r.id })} style={accentBtn}>
      {busy === r.id ? t("plugins.installing") : `${t("plugins.update")} ${r.version}`}
    </button>
  );
}

/** 두 화면의 머리 — 플러그인 폴더와 「다시 켜야 적용」 안내 */
function Head({ dir }: { dir: string }) {
  const t = useI18n((s) => s.t);
  const restart = useMgr((m) => m.restart);
  return (
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
          {/* ★설치·삭제·업데이트·켜기/끄기는 다음에 켤 때 붙는다 — 여기서 바로 켜게 한다 (사용자 지시 2026-09-08). 껍데기의 `restart_app` */}
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
  );
}

function Installed({ items, dir }: { items: PluginInfo[]; dir: string }) {
  const t = useI18n((s) => s.t);
  const reg = useMgr((m) => m.reg);
  const busy = useMgr((m) => m.busy);
  useEffect(() => {
    void useMgr.getState().loadReg();
  }, []);
  const regOf = (id: string) => (reg ?? []).find((r) => r.id === id);

  return (
    <div data-plugins-manage data-plugins-installed style={{ flex: 1, minHeight: 0, overflowY: "auto", display: "flex", flexDirection: "column", gap: "var(--sp-4)" }}>
      <Head dir={dir} />
      {items.length === 0 ? (
        <div style={{ fontSize: "var(--text-sm)", color: "var(--ink-dim)" }}>{t("plugins.none")}</div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: "var(--sp-2)" }}>
          {items.map((p) => {
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
                  {r && <UpdateButton r={r} />}
                  <button
                    data-plugin-toggle={p.id}
                    data-on={on ? "" : undefined}
                    disabled={!!busy}
                    onClick={() => void useMgr.getState().setEnabled(p, !on)}
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
                  <button data-plugin-remove={p.id} disabled={!!busy} onClick={() => void useMgr.getState().remove(p.id)} style={btn}>
                    {t("plugins.remove")}
                  </button>
                </span>
                {p.error && (
                  <span style={{ gridColumn: "1 / -1", fontSize: "var(--text-2xs)", color: "var(--ink-dim)", whiteSpace: "pre-wrap" }}>{p.error}</span>
                )}
              </div>
            );
          })}
        </div>
      )}
      <div style={{ fontSize: "var(--text-2xs)", color: "var(--ink-faint)", lineHeight: 1.6 }}>{t("plugins.hint")}</div>
    </div>
  );
}

function List({ dir }: { dir: string }) {
  const t = useI18n((s) => s.t);
  const reg = useMgr((m) => m.reg);
  const remoteError = useMgr((m) => m.remoteError);
  const busy = useMgr((m) => m.busy);
  const [zip, setZip] = useState("");
  useEffect(() => {
    void useMgr.getState().loadReg();
  }, []);

  /** 목록 — 전부. 깔린 것은 「설치됨」 표식 (+ 새 판이 있으면 업데이트 단추) */
  const listed = reg ?? [];
  const groups = ([
    { key: "official", items: listed.filter((r) => r.official) },
    { key: "user", items: listed.filter((r) => !r.official) },
  ] as { key: "official" | "user"; items: RegItem[] }[]).filter((g) => g.items.length > 0);

  const installZip = async () => {
    await useMgr.getState().install({ zip: zip.trim() });
    setZip("");
  };

  return (
    <div data-plugins-manage data-plugins-list style={{ flex: 1, minHeight: 0, overflowY: "auto", display: "flex", flexDirection: "column", gap: "var(--sp-4)" }}>
      <Head dir={dir} />
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
                  <span style={version}>{r.installed ?? r.version}</span>
                  {r.installed ? (
                    <>
                      <span data-plugin-installed-mark={r.id} style={{ ...badge, marginLeft: 0, color: "var(--accent-ink)", borderColor: "var(--accent)" }}>
                        {t("plugins.installedMark")}
                      </span>
                      <UpdateButton r={r} />
                    </>
                  ) : (
                    <button data-plugin-install={r.id} disabled={!!busy} onClick={() => void useMgr.getState().install({ id: r.id })} style={btn}>
                      {busy === r.id ? t("plugins.installing") : t("plugins.install")}
                    </button>
                  )}
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
        <button data-plugin-install-zip disabled={!!busy || !/^https?:\/\//.test(zip.trim())} onClick={() => void installZip()} style={btn}>
          {busy && busy === zip.trim() ? t("plugins.installing") : t("plugins.installZip")}
        </button>
      </div>
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
