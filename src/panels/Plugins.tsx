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
import { PLUGIN_LIST_REPO, linkOf } from "../lib/pluginLink";
import { PluginCanvas } from "./PluginCanvas";

/** 플러그인 모드 — **캔버스**(`PluginCanvas`, 자유 배치 프레임) + 「플러그인 목록」·「설치된 플러그인」 두 관리 화면
 *  (설계: `docs/plugin-design.md`, 시안: `docs/design/plugins/`·`docs/design/plugins-canvas/`).
 *
 *  ★2026-09-08 의 탭 줄은 2026-09-09 에 캔버스로 바꿨다 (사용자 결정). 오른쪽 패널(`PluginPanel`)이 꺼내기·관리 전환을 맡는다.
 *  ★관리는 `view.tab["plugins"] === "manage"` 일 때 캔버스 자리에 뜬다. 캔버스는 그동안 숨기기만 한다 (iframe 을 지키려고).
 *  ★「플러그인 목록」(카드 격자) / 「설치된 플러그인」(줄 목록). 업데이트는 **양쪽 어디서나** 받고, 받는 중·다시 켜기 안내는
 *    두 화면이 한 상태(`useMgr`)를 본다. ★★설치·삭제·업데이트·켜기/끄기는 파일과 설정만 바꾼다 — **다시 켜야 적용**된다. */

const MANAGE = "manage";
/** 관리 안의 두 화면 (`useUi.view.tab["plugins-manage"]`) */
const INSTALLED = "installed";
const LIST = "list";

type RegItem = {
  id: string;
  name: string;
  version: string;
  description: string;
  homepage: string;
  source: "bundled" | "repo" | "zip";
  repo?: string;
  zip?: string;
  installed: string | null;
  /** 앱과 함께 오는 번들(공식)인가 — 아니면 목록에 오른 유저 플러그인 */
  official: boolean;
  /** 깔린 것보다 높은 판이 같은 출처에 있다 */
  update: boolean;
};

/** 두 화면이 함께 보는 관리 상태 — 목록·받는 중·다시 켜기 안내. ★화면을 오가도 「받는 중」이 끊기지 않는다 */
type Mgr = {
  reg: RegItem[] | null;
  remoteError: string;
  /** 지금 받는/지우는/켜고 끄는 대상 (id 또는 zip 주소). 비면 한가하다 */
  busy: string;
  /** 설치·삭제·업데이트·켜기/끄기 뒤 — 파일·설정은 바뀌었지만 붙는 것은 다음에 켤 때다. 무엇이 바뀌었는지 띠에 적는다.
   *  ★플러그인마다 **마지막 것 하나만** 남긴다 (사용자 지시 2026-09-08: 켜고 끄기를 반복하면 줄줄이 쌓였다) */
  changes: { id: string; text: string }[];
  loadReg: () => Promise<void>;
  install: (body: { id?: string; zip?: string }, name?: string) => Promise<void>;
  remove: (p: { id: string; name: string }) => Promise<void>;
  setEnabled: (p: PluginInfo, on: boolean) => Promise<void>;
};

const post = (path: string, body: unknown) =>
  api<{ ok: boolean; id: string; pip?: string }>(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

/** 바뀐 것 기록 — 같은 플러그인의 이전 기록은 지우고 뒤에 붙인다 */
const noted = (list: { id: string; text: string }[], id: string, text: string) => [...list.filter((c) => c.id !== id), { id, text }];

const useMgr = create<Mgr>((set, get) => ({
  reg: null,
  remoteError: "",
  busy: "",
  changes: [],
  async loadReg() {
    try {
      const r = await api<{ items: RegItem[]; remoteError: string }>("/api/plugins/registry");
      set({ reg: r.items, remoteError: r.remoteError });
    } catch (e) {
      set({ reg: [], remoteError: String(e) });
    }
  },
  async install(body, name) {
    if (get().busy) return;
    set({ busy: body.id ?? body.zip ?? "" });
    try {
      const r = await post("/api/plugins/install", body);
      toast(tr("plugins.installed", { n: r.id }));
      // ★설치하면 탭은 열린 상태로 시작한다 — 전에 닫아 두고 지웠던 플러그인을 다시 깔면 옛 「닫음」 이 남아
      //   다시 켠 뒤에도 탭이 안 보였다 (사용자 보고 2026-09-08)
      useUi.getState().setView("hide", r.id, false);
      set({ changes: noted(get().changes, r.id, tr("plugins.chgInstalled", { n: name ?? r.id })) });
      await Promise.all([get().loadReg(), usePlugins.getState().load()]);
    } catch (e) {
      toast(String(e), "warn");
    } finally {
      set({ busy: "" });
    }
  },
  async remove(p) {
    if (get().busy) return;
    set({ busy: p.id });
    try {
      await api(`/api/plugins/${encodeURIComponent(p.id)}`, { method: "DELETE" });
      toast(tr("plugins.removed", { n: p.id }));
      useUi.getState().setView("hide", p.id, false); // 지운 플러그인의 「닫음」 을 남기지 않는다
      set({ changes: noted(get().changes, p.id, tr("plugins.chgRemoved", { n: p.name })) });
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
      set({ changes: noted(get().changes, p.id, tr(on ? "plugins.chgOn" : "plugins.chgOff", { n: p.name })) });
      await usePlugins.getState().load();
    } catch (e) {
      toast(String(e), "warn");
    } finally {
      set({ busy: "" });
    }
  },
}));

/** @param hidden 다른 모드를 보는 중 — 떼지 않고 숨긴다 (`App` 의 ★주). 숨은 동안에도 캔버스의 iframe 은 살아 있다 */
export function Plugins({ hidden = false }: { hidden?: boolean }) {
  const items = usePlugins((s) => s.items);
  const dir = usePlugins((s) => s.dir);
  const base = usePlugins((s) => s.base);
  /** 캔버스를 보나 관리를 보나 — ★**저장되는 작업 상태**다 (`useUi.view.tab["plugins"]`: "manage" 면 관리, 그 밖은 캔버스) */
  const tab = useUi((u) => (u.view.tab["plugins"] as string | undefined) ?? "");
  /** 관리 안의 어느 화면인가 — 이것도 저장되는 작업 상태. ★처음은 「플러그인 목록」, 그 뒤로는 마지막에 보던 곳 (사용자 지시 2026-09-08) */
  const sub = useUi((u) => (u.view.tab["plugins-manage"] as string | undefined) ?? LIST);
  const setSub = (k: string) => useUi.getState().setView("tab", "plugins-manage", k as never);
  /** 관리 화면의 찾기 — 두 화면이 같은 글을 쓴다 */
  const [q, setQ] = useState("");

  useEffect(() => {
    void usePlugins.getState().load().catch((e) => toast(String(e), "warn"));
  }, []);

  const manageOn = tab === MANAGE;

  return (
    // ★숨김은 인라인 display 로 — `hidden` 속성만 주면 인라인 `display: flex` 가 이겨 다른 모드 위에 그대로 그려진다 (사용자 보고 2026-09-08)
    <div data-plugins-root data-hidden={hidden ? "" : undefined} style={{ flex: 1, minHeight: 0, display: hidden ? "none" : "flex", flexDirection: "column" }}>
      {/* ★캔버스는 떼지 않고 숨긴다 — 관리 화면을 보는 동안에도 프레임의 iframe 이 살아 있어야 한다 */}
      <div style={{ flex: 1, minHeight: 0, display: manageOn ? "none" : "flex", flexDirection: "column" }}>
        <PluginCanvas items={items} base={base} />
      </div>
      {manageOn && (
        <div data-plugins-manage style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column", gap: "var(--sp-6)", padding: "var(--sp-6) var(--sp-9) var(--sp-7)" }}>
          {sub === LIST ? (
            <List q={q} setQ={setQ} sub={sub} setSub={setSub} installedCount={items.length} />
          ) : (
            <Installed q={q} setQ={setQ} sub={sub} setSub={setSub} items={items} dir={dir} />
          )}
        </div>
      )}
    </div>
  );
}

/* ── 공통 모양 ───────────────────────────────────────────────────────────── */

const btn: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: "var(--sp-1)",
  boxSizing: "border-box",
  height: 26,
  padding: "0 var(--sp-4)",
  fontSize: "var(--text-2xs)",
  color: "var(--ink-dim)",
  border: "1px solid var(--line)",
  borderRadius: "var(--r-2)",
  background: "var(--panel)",
  whiteSpace: "nowrap",
};
const accentBtn: React.CSSProperties = { ...btn, background: "var(--accent)", color: "var(--accent-on)", borderColor: "var(--accent)", fontWeight: "var(--w-semi)" as never };
const eyebrow: React.CSSProperties = { fontSize: "var(--text-3xs)", letterSpacing: 0.4, textTransform: "uppercase", color: "var(--ink-faint)" };
const mono: React.CSSProperties = { fontSize: "var(--text-2xs)", color: "var(--ink-faint)", fontFamily: "var(--font-mono)", fontVariantNumeric: "tabular-nums" };

function Badge({ kind }: { kind: "official" | "user" | "folder" }) {
  const t = useI18n((s) => s.t);
  const official = kind === "official";
  return (
    <span
      data-plugin-badge={kind}
      style={{
        padding: "0 6px",
        fontSize: "var(--text-3xs)",
        lineHeight: "16px",
        borderRadius: "var(--r-2)",
        border: `1px solid ${official ? "var(--mode-plugins)" : "var(--line)"}`,
        color: official ? "var(--mode-plugins)" : "var(--ink-dim)",
        whiteSpace: "nowrap",
      }}
    >
      {t(kind === "official" ? "plugins.official" : kind === "user" ? "plugins.user" : "plugins.folderSource")}
    </span>
  );
}

/** 머리글자 타일 — 아이콘이 없는 플러그인의 얼굴 (시안). 공식은 강조 바탕, 유저는 회색 */
function Monogram({ name, official, size = 36 }: { name: string; official: boolean; size?: number }) {
  return (
    <span
      style={{
        width: size,
        height: size,
        flexShrink: 0,
        display: "grid",
        placeItems: "center",
        borderRadius: "var(--r-3)",
        background: official ? "var(--accent-bg)" : "var(--line-soft)",
        color: official ? "var(--accent-ink)" : "var(--ink-soft)",
        fontSize: "var(--text-lg)",
        fontWeight: "var(--w-semi)" as never,
      }}
    >
      {(name.trim()[0] ?? "?").toUpperCase()}
    </span>
  );
}

/** GitHub(홈) 링크 — README 를 보러 간다 (사용자 지시 2026-09-08). 주소가 없으면 안 그린다 */
function GitLink({ href, label }: { href: string; label: string }) {
  if (!href) return null;
  return (
    <button
      data-plugin-link={href}
      onClick={() => openExternal(href)}
      title={href}
      style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: "var(--text-2xs)", color: "var(--ink-faint)", background: "none", border: "none", padding: 0, cursor: "pointer", minWidth: 0 }}
    >
      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{label}</span>
      <span style={{ display: "grid", placeItems: "center", width: 11, height: 11, flexShrink: 0 }}>{Icon.external}</span>
    </button>
  );
}

/** 업데이트 단추 — 두 화면이 같은 것을 쓴다 (같은 출처의 새 판이 있을 때만) */
function UpdateButton({ r }: { r: RegItem }) {
  const t = useI18n((s) => s.t);
  const busy = useMgr((m) => m.busy);
  if (!r.update) return null;
  return (
    <button data-plugin-update={r.id} disabled={!!busy} onClick={() => void useMgr.getState().install({ id: r.id }, r.name)} style={accentBtn}>
      <span style={{ display: "grid", placeItems: "center", width: 12, height: 12 }}>{Icon.refresh}</span>
      {busy === r.id ? t("plugins.installing") : `${t("plugins.update")} ${r.version}`}
    </button>
  );
}

/** 두 화면의 머리 — 화면 전환(세그먼트) · 찾기 · 오른쪽 자리 */
function Head({ sub, setSub, q, setQ, installedCount, right }: { sub: string; setSub: (k: string) => void; q: string; setQ: (v: string) => void; installedCount: number; right: React.ReactNode }) {
  const t = useI18n((s) => s.t);
  const seg = (k: string, label: string, count?: number) => {
    const on = sub === k;
    return (
      <button
        key={k}
        data-plugin-sub={k}
        onClick={() => setSub(k)}
        style={{
          padding: "4px 12px",
          fontSize: "var(--text-xs)",
          fontWeight: on ? "var(--w-semi)" : "var(--w-norm)",
          borderRadius: "var(--r-2)",
          background: on ? "var(--accent-bg)" : "transparent",
          color: on ? "var(--accent-ink)" : "var(--ink-dim)",
          whiteSpace: "nowrap",
        }}
      >
        {label}
        {count != null && <span data-plugin-sub-count style={{ marginLeft: 4, fontSize: "var(--text-2xs)", opacity: 0.7 }}>{count}</span>}
      </button>
    );
  };
  return (
    <div style={{ display: "flex", alignItems: "center", gap: "var(--sp-7)", flexShrink: 0 }}>
      {/* 캔버스로 돌아가기 — 오른쪽 패널의 「관리」 를 다시 눌러도 된다 */}
      <button data-plugins-back onClick={() => useUi.getState().setView("tab", "plugins", "canvas" as never)} style={{ ...btn, height: 28, gap: "var(--sp-2)" }}>
        <span style={{ display: "grid", placeItems: "center", width: 12, height: 12 }}>{Icon.chevronLeft}</span>
        {t("plugins.backToCanvas")}
      </button>
      <div style={{ display: "flex", gap: 2, padding: 3, border: "1px solid var(--line)", borderRadius: "var(--r-3)", background: "var(--panel)" }}>
        {seg(LIST, t("plugins.availableHead"))}
        {seg(INSTALLED, t("plugins.installedHead"), installedCount)}
      </div>
      <label style={{ flex: 1, maxWidth: 360, display: "flex", alignItems: "center", gap: "var(--sp-3)", height: 30, padding: "0 var(--sp-4)", boxSizing: "border-box", border: "1px solid var(--line)", borderRadius: "var(--r-3)", background: "var(--panel)", color: "var(--ink-faint)" }}>
        <span style={{ display: "grid", placeItems: "center", width: 14, height: 14 }}>{Icon.search}</span>
        <input
          data-plugin-search
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={t("plugins.search")}
          style={{ flex: 1, minWidth: 0, border: "none", background: "none", color: "var(--ink)", fontSize: "var(--text-xs)", outline: "none" }}
        />
      </label>
      <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: "var(--sp-5)" }}>{right}</div>
    </div>
  );
}

/** 「다시 켜기」 띠 — 바뀐 것이 있을 때만. 무엇이 바뀌었는지 함께 적는다 (시안) */
function RestartBand() {
  const t = useI18n((s) => s.t);
  const changes = useMgr((m) => m.changes);
  if (changes.length === 0) return null;
  return (
    <div data-plugins-restart style={{ flexShrink: 0, display: "flex", alignItems: "center", gap: "var(--sp-5)", padding: "var(--sp-3) var(--sp-5)", border: "1px solid var(--accent-line)", borderRadius: "var(--r-3)", background: "var(--accent-bg)" }}>
      <span style={{ width: 8, height: 8, borderRadius: 4, background: "var(--accent-ink)", flexShrink: 0 }} />
      <span style={{ fontSize: "var(--text-xs)", color: "var(--ink)", whiteSpace: "nowrap" }}>{t("plugins.changed")}</span>
      <span data-plugins-changes style={{ fontSize: "var(--text-2xs)", color: "var(--ink-dim)", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{changes.map((c) => c.text).join(" · ")}</span>
      {/* ★설치·삭제·업데이트·켜기/끄기는 다음에 켤 때 붙는다 — 여기서 바로 붙인다 (사용자 지시 2026-09-08):
          껍데기가 **백엔드만** 다시 띄우고(`restart_backend`) 화면은 새로 읽는다. 앱 프로세스를 통째로 다시 띄우면
          개발 중에는 Vite 가 함께 내려가 연결 거부 화면이 떴다 (사용자 보고 2026-09-08, `lib.rs` 의 주). */}
      <button
        data-plugins-restart-btn
        onClick={() =>
          void import("@tauri-apps/api/core")
            .then((m) => m.invoke("restart_backend"))
            .then(() => location.reload())
            .catch((e) => toast(String(e), "warn"))
        }
        style={{ ...accentBtn, marginLeft: "auto" }}
      >
        <span style={{ display: "grid", placeItems: "center", width: 12, height: 12 }}>{Icon.refresh}</span>
        {t("plugins.restartBtn")}
      </button>
    </div>
  );
}

const matches = (q: string, ...fields: string[]) => {
  const k = q.trim().toLowerCase();
  return !k || fields.some((f) => f.toLowerCase().includes(k));
};

/* ── 플러그인 목록 — 카드 격자 ─────────────────────────────────────────── */

function Card({ r }: { r: RegItem }) {
  const t = useI18n((s) => s.t);
  const busy = useMgr((m) => m.busy);
  const link = linkOf(r);
  const owner = r.repo ? r.repo.split("/")[0] : r.official ? "PeroPix" : "";
  return (
    <div data-plugin-avail={r.id} style={{ display: "flex", flexDirection: "column", gap: "var(--sp-4)", padding: "var(--sp-6) var(--sp-6) var(--sp-5)", border: "1px solid var(--line)", borderRadius: "var(--r-4)", background: "var(--panel)", minWidth: 0 }}>
      <div style={{ display: "flex", alignItems: "center", gap: "var(--sp-4)", minWidth: 0 }}>
        <Monogram name={r.name} official={r.official} />
        <div style={{ minWidth: 0, display: "flex", flexDirection: "column", gap: 1 }}>
          <span style={{ fontSize: "var(--text-md)", fontWeight: "var(--w-semi)", color: "var(--ink)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{r.name}</span>
          <span style={mono}>{r.id} · {r.installed ?? r.version}</span>
        </div>
        <span style={{ marginLeft: "auto", flexShrink: 0 }}><Badge kind={r.official ? "official" : "user"} /></span>
      </div>
      <div style={{ fontSize: "var(--text-2xs)", lineHeight: 1.5, color: "var(--ink-soft)", minHeight: 36, display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>{r.description}</div>
      <div style={{ display: "flex", alignItems: "center", gap: "var(--sp-3)", paddingTop: 2, minWidth: 0 }}>
        {link ? <GitLink href={link} label={owner || t("plugins.github")} /> : <span style={{ fontSize: "var(--text-2xs)", color: "var(--ink-faint)" }}>{owner}</span>}
        <span style={{ marginLeft: "auto", display: "inline-flex", gap: "var(--sp-2)", flexShrink: 0 }}>
          {r.installed ? (
            <>
              <span data-plugin-installed-mark={r.id} style={btn}>
                <span style={{ display: "grid", placeItems: "center", width: 12, height: 12 }}>{Icon.check}</span>
                {t("plugins.installedMark")}
              </span>
              <UpdateButton r={r} />
            </>
          ) : (
            <button data-plugin-install={r.id} disabled={!!busy} onClick={() => void useMgr.getState().install({ id: r.id }, r.name)} style={accentBtn}>
              {busy === r.id ? t("plugins.installing") : t("plugins.install")}
            </button>
          )}
        </span>
      </div>
    </div>
  );
}

type Filter = "all" | "official" | "user";

function List({ q, setQ, sub, setSub, installedCount }: { q: string; setQ: (v: string) => void; sub: string; setSub: (k: string) => void; installedCount: number }) {
  const t = useI18n((s) => s.t);
  const reg = useMgr((m) => m.reg);
  const remoteError = useMgr((m) => m.remoteError);
  const busy = useMgr((m) => m.busy);
  const dir = usePlugins((s) => s.dir);
  const [zip, setZip] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  useEffect(() => {
    void useMgr.getState().loadReg();
  }, []);

  /** 목록 — 전부. 깔린 것은 「설치됨」 표식 (+ 새 판이 있으면 업데이트 단추) */
  const listed = (reg ?? []).filter((r) => matches(q, r.name, r.id, r.description));
  const groups = ([
    { key: "official", items: listed.filter((r) => r.official), note: t("plugins.officialNote") },
    { key: "user", items: listed.filter((r) => !r.official), note: t("plugins.userNote") },
  ] as { key: Filter; items: RegItem[]; note: string }[]).filter((g) => g.items.length > 0 && (filter === "all" || filter === g.key));

  const installZip = async () => {
    await useMgr.getState().install({ zip: zip.trim() });
    setZip("");
  };
  const chip = (k: Filter, label: string) => {
    const on = filter === k;
    return (
      <button key={k} data-plugin-filter={k} onClick={() => setFilter(k)} style={{ ...btn, height: 24, padding: "0 var(--sp-4)", borderColor: on ? "var(--accent)" : "var(--line)", background: on ? "var(--accent-bg)" : "transparent", color: on ? "var(--accent-ink)" : "var(--ink-dim)" }}>
        {label}
      </button>
    );
  };

  return (
    <div data-plugins-list style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column", gap: "var(--sp-6)" }}>
      <Head
        sub={sub}
        setSub={setSub}
        q={q}
        setQ={setQ}
        installedCount={installedCount}
        right={
          <>
            <span style={{ display: "inline-flex", gap: "var(--sp-1)" }}>
              {chip("all", t("plugins.filterAll"))}
              {chip("official", t("plugins.official"))}
              {chip("user", t("plugins.user"))}
            </span>
            <button data-plugins-author onClick={() => openExternal(PLUGIN_LIST_REPO)} style={{ display: "inline-flex", alignItems: "center", gap: 5, background: "none", border: "none", padding: 0, cursor: "pointer", fontSize: "var(--text-2xs)", color: "var(--accent-ink)", whiteSpace: "nowrap" }}>
              {t("plugins.author")}
              <span style={{ display: "grid", placeItems: "center", width: 13, height: 13 }}>{Icon.external}</span>
            </button>
            <FolderOpenButton data-plugins-open tip={t("plugins.openDir")} disabled={!dir} onClick={() => void useFiles.getState().openDir(dir).catch((e) => toast(String(e), "warn"))} />
          </>
        }
      />
      <RestartBand />
      <div style={{ flex: 1, minHeight: 0, overflowY: "auto", display: "flex", flexDirection: "column", gap: "var(--sp-8)" }}>
        {reg === null ? (
          <div style={{ fontSize: "var(--text-2xs)", color: "var(--ink-faint)" }}>…</div>
        ) : groups.length === 0 ? (
          <div style={{ fontSize: "var(--text-sm)", color: "var(--ink-dim)" }}>{t(listed.length === 0 && (reg ?? []).length > 0 ? "plugins.noMatch" : "plugins.noAvailable")}</div>
        ) : (
          groups.map((g) => (
            <div key={g.key} data-plugin-group={g.key} style={{ display: "flex", flexDirection: "column", gap: "var(--sp-3)" }}>
              <div style={{ display: "flex", alignItems: "baseline", gap: "var(--sp-3)" }}>
                <span style={eyebrow}>{t(g.key === "official" ? "plugins.official" : "plugins.user")}</span>
                <span style={{ fontSize: "var(--text-3xs)", color: "var(--ink-ghost)" }}>{g.note}</span>
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))", gap: "var(--sp-5)" }}>
                {g.items.map((r) => <Card key={r.id} r={r} />)}
              </div>
            </div>
          ))
        )}
        {remoteError && <div style={{ fontSize: "var(--text-2xs)", color: "var(--ink-faint)" }}>{t("plugins.registryFail")}</div>}
      </div>
      <div style={{ flexShrink: 0, display: "flex", alignItems: "center", gap: "var(--sp-5)", paddingTop: "var(--sp-5)", borderTop: "1px solid var(--line-soft)" }}>
        <span style={{ fontSize: "var(--text-2xs)", color: "var(--ink-faint)", whiteSpace: "nowrap" }}>{t("plugins.notListed")}</span>
        <input
          data-plugin-zip
          value={zip}
          onChange={(e) => setZip(e.target.value)}
          placeholder={t("plugins.zipUrl")}
          style={{ flex: 1, maxWidth: 520, minWidth: 0, height: 28, padding: "0 var(--sp-4)", boxSizing: "border-box", fontSize: "var(--text-2xs)", border: "1px solid var(--line)", borderRadius: "var(--r-2)", background: "var(--panel)", color: "var(--ink)" }}
        />
        <button data-plugin-install-zip disabled={!!busy || !/^https?:\/\//.test(zip.trim())} onClick={() => void installZip()} style={btn}>
          {busy && busy === zip.trim() ? t("plugins.installing") : t("plugins.installZip")}
        </button>
        <span style={{ marginLeft: "auto", fontSize: "var(--text-3xs)", color: "var(--ink-ghost)", whiteSpace: "nowrap" }}>{t("plugins.applyNote")}</span>
      </div>
    </div>
  );
}

/* ── 설치된 플러그인 — 줄 목록 ─────────────────────────────────────────── */

const COLS = "36px minmax(0, 1fr) 90px 80px 96px 140px";

function Row({ p, r }: { p: PluginInfo; r: RegItem | undefined }) {
  const t = useI18n((s) => s.t);
  const busy = useMgr((m) => m.busy);
  const base = usePlugins((s) => s.base);
  const on = p.enabled !== false;
  const kind: "official" | "user" | "folder" = p.origin?.source === "bundled" || r?.official ? "official" : p.origin ? "user" : "folder";
  const link = linkOf({ id: p.id, homepage: p.homepage, origin: p.origin });
  const sub = p.error ? `${t("plugins.broken")} — ${p.error}` : p.description || (p.origin?.repo ?? "");
  return (
    <div data-plugin-row={p.id} data-on={on ? "" : undefined} style={{ display: "grid", gridTemplateColumns: COLS, alignItems: "center", gap: "var(--sp-5)", padding: "var(--sp-5) var(--sp-6)", borderBottom: "1px solid var(--line-soft)", opacity: on ? 1 : 0.6 }}>
      <Monogram name={p.name} official={kind === "official"} />
      <div style={{ minWidth: 0, display: "flex", flexDirection: "column", gap: 2 }}>
        <span style={{ display: "flex", alignItems: "center", gap: "var(--sp-2)", minWidth: 0 }}>
          <span style={{ fontSize: "var(--text-md)", fontWeight: "var(--w-semi)", color: "var(--ink)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{p.name}</span>
          <span style={mono}>{p.id}</span>
          {link && <GitLink href={link} label={t("plugins.github")} />}
        </span>
        <span style={{ fontSize: "var(--text-2xs)", color: p.error ? "var(--err-ink)" : "var(--ink-dim)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{sub}</span>
      </div>
      <span style={{ width: "max-content" }}><Badge kind={kind} /></span>
      <span style={{ display: "inline-flex", flexDirection: "column", gap: 1, ...mono, color: "var(--ink-soft)" }}>
        {p.version}
        {r?.update && <span data-plugin-next={r.version} style={{ fontSize: "var(--text-3xs)", color: "var(--accent-ink)" }}>→ {r.version}</span>}
      </span>
      <button
        data-plugin-toggle={p.id}
        data-on={on ? "" : undefined}
        disabled={!!busy}
        onClick={() => void useMgr.getState().setEnabled(p, !on)}
        style={{ display: "inline-flex", alignItems: "center", gap: "var(--sp-3)", fontSize: "var(--text-2xs)", color: on ? "var(--ink-soft)" : "var(--ink-faint)", background: "none", border: "none", padding: 0, cursor: "pointer" }}
      >
        <span style={{ width: 30, height: 18, borderRadius: 9, background: on ? "var(--accent)" : "var(--line)", position: "relative", flexShrink: 0, transition: "background 0.12s" }}>
          <span style={{ position: "absolute", top: 2, left: on ? 14 : 2, width: 14, height: 14, borderRadius: 7, background: on ? "var(--accent-on)" : "var(--ink-dim)", transition: "left 0.12s" }} />
        </span>
        {t(on ? "plugins.on" : "plugins.off")}
      </button>
      <span style={{ display: "inline-flex", justifyContent: "flex-end", gap: "var(--sp-2)" }}>
        {/* ★제작자용 — 플러그인 페이지를 진짜 브라우저에서 연다 (거기서 개발자 도구를 쓴다). 창에 두지 않고 여기 둔다
            (사용자 지시 2026-09-10: 앱 상자에는 창을 다루는 단추만) */}
        {p.web && base && (
          <button data-plugin-open-browser={p.id} data-tip={t("plugins.openInBrowser")} onClick={() => openExternal(`${base}${p.web}`)} style={{ ...btn, width: 26, padding: 0, justifyContent: "center", color: "var(--ink-faint)" }}>
            <span style={{ display: "grid", placeItems: "center", width: 14, height: 14 }}>{Icon.globe}</span>
          </button>
        )}
        {r && <UpdateButton r={r} />}
        <button data-plugin-remove={p.id} data-tip={t("plugins.remove")} disabled={!!busy} onClick={() => void useMgr.getState().remove(p)} style={{ ...btn, width: 26, padding: 0, justifyContent: "center", color: "var(--ink-faint)" }}>
          <span style={{ display: "grid", placeItems: "center", width: 14, height: 14 }}>{Icon.trash}</span>
        </button>
      </span>
    </div>
  );
}

function Installed({ q, setQ, sub, setSub, items, dir }: { q: string; setQ: (v: string) => void; sub: string; setSub: (k: string) => void; items: PluginInfo[]; dir: string }) {
  const t = useI18n((s) => s.t);
  const reg = useMgr((m) => m.reg);
  useEffect(() => {
    void useMgr.getState().loadReg();
  }, []);
  const regOf = (id: string) => (reg ?? []).find((r) => r.id === id);
  const shown = items.filter((p) => matches(q, p.name, p.id, p.description ?? ""));
  const col = (k: string) => <span style={eyebrow}>{k}</span>;

  return (
    <div data-plugins-installed style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column", gap: "var(--sp-6)" }}>
      <Head
        sub={sub}
        setSub={setSub}
        q={q}
        setQ={setQ}
        installedCount={items.length}
        right={
          <>
            <span data-plugins-dir style={{ ...mono, maxWidth: 360, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{dir}</span>
            <button data-plugins-open onClick={() => void useFiles.getState().openDir(dir).catch((e) => toast(String(e), "warn"))} disabled={!dir} style={{ ...btn, height: 28 }}>
              <span style={{ display: "grid", placeItems: "center", width: 14, height: 14 }}>{Icon.folderOpen}</span>
              {t("plugins.openDirBtn")}
            </button>
          </>
        }
      />
      <RestartBand />
      <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column", border: "1px solid var(--line)", borderRadius: "var(--r-4)", background: "var(--panel)", overflow: "hidden" }}>
        <div style={{ display: "grid", gridTemplateColumns: COLS, alignItems: "center", gap: "var(--sp-5)", padding: "var(--sp-3) var(--sp-6)", borderBottom: "1px solid var(--line-soft)" }}>
          <span />{col(t("plugins.colPlugin"))}{col(t("plugins.colSource"))}{col(t("plugins.colVersion"))}{col(t("plugins.colState"))}<span />
        </div>
        <div style={{ flex: 1, minHeight: 0, overflowY: "auto", display: "flex", flexDirection: "column" }}>
          {shown.length === 0 ? (
            <div style={{ padding: "var(--sp-6)", fontSize: "var(--text-sm)", color: "var(--ink-dim)" }}>{t(items.length === 0 ? "plugins.none" : "plugins.noMatch")}</div>
          ) : (
            shown.map((p) => <Row key={p.id} p={p} r={regOf(p.id)} />)
          )}
          <div style={{ marginTop: "auto", padding: "var(--sp-5) var(--sp-6)", fontSize: "var(--text-3xs)", color: "var(--ink-ghost)" }}>{t("plugins.footnote")}</div>
        </div>
      </div>
    </div>
  );
}
