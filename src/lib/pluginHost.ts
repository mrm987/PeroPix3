/** 플러그인 호스트 — 설치된 플러그인의 확장 JS 를 앱 페이지에 불러들이고, 기여 지점(단추·메뉴)과
 *  캔버스(iframe)의 postMessage 창구를 한 자리에서 맡는다 (설계: `docs/plugin-design.md` 5절).
 *
 *  ★★플러그인은 앱의 규칙 밖에서 돈다 (사용자 결정 2026-09-07). 승인 카드를 지나지 않고(`runAction(…, false)`),
 *    공개 API 밖의 `window`·DOM·스토어에 닿는 것도 막지 않는다. 일반 사용자가 넣는 것이라 결과는 전부
 *    플러그인 몫이다. 앱이 지키는 것은 하나 — **플러그인 하나가 터져도 앱은 계속 뜬다** (전부 try 로 감싼다).
 *  ★공개 API 는 작게 시작한다: 단추·메뉴 자리, 캔버스 열기, 앱 액션, 지금 화면 주소, 토큰, 번역, 토스트.
 *    앱 개정으로 그 밖의 것이 깨지면 플러그인이 고친다 (ComfyUI 와 같은 계약).
 *
 *  확장 JS (`plugin.json` 의 `ext`):
 *      window.peropix.registerExtension({ name: "x", setup(api) { api.addButton("generate.footer", { label, onClick }); } });
 *  캔버스 페이지(iframe)는 같은 것을 postMessage 로 부른다:
 *      parent.postMessage({ type: "peropix", id: 1, call: "action", name: "add_style_card", args: {...} }, "*");
 *      window.addEventListener("message", (e) => { if (e.data?.type === "peropix" && e.data.id === 1) … });
 *  앱이 먼저 보내는 것(id 없음) 셋 — 설정이 바뀔 때. 받는 것은 `peropix.js` 가 알아서 한다 (플러그인은 할 일이 없다):
 *    `{ event: "theme", theme: "dark" | "light" }` · `{ event: "font", font: "<글꼴 목록>" }` · `{ event: "scale", scale: "1.2" }`
 */
import { useEffect, useState } from "react";
import { create } from "zustand";
import { api, backendUrl } from "./backend";
import { useUi } from "../store/ui";
import { putOnCanvas } from "./pluginFrames";
import { toast } from "../store/toast";
import { sceneBlocks, screenAddr } from "./promptEdit";
import { runAction } from "../store/queue";
import { t, useI18n } from "../i18n";

/** 이번 기동의 표식 — 플러그인 캔버스·확장 JS 주소에 `?v=` 로 붙인다.
 *  ★★여기는 일반 브라우저가 아니라 **우리가 플러그인을 띄워 주는 환경**이다: 플러그인을 고치거나 업데이트했으면 앱을 새로고침하든
 *    다시 켜든 무조건 새 파일이어야 한다 (사용자 지시 2026-09-08). 백엔드가 `Cache-Control: no-store` 를 보내지만(`plugins.py`
 *    `_FreshStatic`), 그 전에 캐시된 항목은 헤더가 못 걷어 낸다 (실측: 확장 JS 가 앱을 다시 켜도 옛 캐시에서 왔다).
 *    주소가 매 기동 달라지면 캐시에 맞는 항목이 없다. */
export const BOOT = Date.now();
export const fresh = (u: string) => `${u.includes("?") ? "&" : "?"}v=${BOOT}`;

/** 매니페스트가 적은 문구 — 문자열 하나이거나 **언어별 묶음**(`{ "ko": "…", "en": "…" }`)이다.
 *  ★제작자가 한 언어만 적어도 그대로 쓰인다 (사용자 결정 2026-09-11: 대응은 제작자 마음). */
export type LocText = string | Record<string, string>;

/** 지금 앱 언어로 고른다. 그 언어가 없으면 영어 → 한국어 → 적힌 것 중 아무거나. */
export function pickText(v: LocText | undefined, locale?: string): string {
  if (typeof v === "string") return v;
  if (!v || typeof v !== "object") return "";
  const l = locale ?? useI18n.getState().locale;
  return v[l] || v.en || v.ko || Object.values(v)[0] || "";
}

/** 열쇠에 쓸 이름 — **언어와 무관하게 한 가지**여야 한다 (화면 표식 `data-plugin-button` 이 이것이다).
 *  언어별 묶음이면 영어를 먼저 쓴다. 문자열 하나면 그대로다. */
export function keyText(v: LocText | undefined): string {
  if (typeof v === "string") return v;
  if (!v || typeof v !== "object") return "";
  return v.en || v.ko || Object.values(v)[0] || "";
}

/** 컴포넌트용 — 언어가 바뀌면 다시 그려진다 */
export function usePickText(): (v: LocText | undefined) => string {
  const locale = useI18n((s) => s.locale);
  return (v) => pickText(v, locale);
}

export type PluginInfo = {
  id: string;
  name: LocText;
  version: string;
  /** 캔버스 주소 — 비면 캔버스가 없는 플러그인 (단추만 두는 것) */
  web: string;
  /** 앱 페이지 안에서 돌 JS 주소들 */
  ext: string[];
  contributes: { buttons?: DeclaredButton[] } & Record<string, unknown>;
  /** 못 읽었으면 까닭. 비면 정상 */
  error: string;
  dir: string;
  /** 꺼진 플러그인 — 백엔드가 붙이지 않았다. 화면도 캔버스·단추·메뉴를 감춘다 (`isOn`) */
  enabled: boolean;
  /** 어디서 왔나 (`_origin.json`). 폴더에 직접 넣은 것은 null — 업데이트를 받지 않고 GitHub 링크도 없다.
   *  ★`official` 은 설치할 때 목록이 말해 준 것을 적어 둔 것이다 — 인터넷이 없어도 딱지가 남게 (`plugins.py install`) */
  origin: { source: "repo" | "zip"; repo?: string; zip?: string; official?: boolean } | null;
  /** 매니페스트의 `homepage` (선택) */
  homepage: string;
  description: LocText;
  /** 캔버스 프레임 규격 — 백엔드가 기본값을 채워 준다 (`plugins.py canvas_spec`) */
  canvas: { width: number; height: number; minWidth: number; minHeight: number; resize: boolean };
};

/** 화면에 내놓아도 되는 플러그인인가 — 켜져 있고 읽혔다. ★끄면 다시 켜기 전에도 단추·메뉴·캔버스는 바로 감춘다
 *  (백엔드 라우터는 다음에 켤 때 떨어지지만, 사용자 눈에는 끈 즉시 사라져야 한다). */
export function isOn(id: string): boolean {
  const p = usePlugins.getState().items.find((x) => x.id === id);
  return !!p && !p.error && p.enabled !== false;
}

/** `plugin.json` 의 `contributes.buttons[]` — JS 없이 단추 하나를 두는 길 */
export type DeclaredButton = {
  slot: string;
  label: LocText;
  /** SVG 마크업 (선택) — 앱은 그대로 그린다 */
  icon?: string;
  /** `"openCanvas"` 또는 `{ action, args }` */
  do?: "openCanvas" | { action: string; args?: Record<string, unknown> };
};

export type PluginButton = { key: string; plugin: string; label: LocText; icon?: string; onClick: () => void };
export type PluginImage = { url: string; name: string };
export type PluginMenuItem = { key: string; plugin: string; label: LocText; onClick: (img: PluginImage) => void };

/** 자리 이름 — 여기 없는 이름으로 등록하면 아무 데도 안 그려진다 (오류는 아니다) */
export const SLOTS = ["generate.footer", "nav.right"] as const;
export const MENUS = ["image.send"] as const;

type S = {
  items: PluginInfo[];
  dir: string;
  base: string;
  loaded: boolean;
  buttons: Record<string, PluginButton[]>;
  menus: Record<string, PluginMenuItem[]>;
  /** 목록을 읽고(언제나) 확장 JS 를 불러들인다(처음 한 번) */
  load: () => Promise<void>;
};

let extDone = false;
/** 지금 확장 JS 를 불러들이는 중인 플러그인 — `registerExtension` 이 누구 것인지 알기 위해 */
let current: PluginInfo | null = null;

export const usePlugins = create<S>((set) => ({
  items: [],
  dir: "",
  base: "",
  loaded: false,
  buttons: {},
  menus: {},
  async load() {
    const base = await backendUrl();
    const r = await api<{ dir: string; items: PluginInfo[] }>("/api/plugins");
    set({ items: r.items, dir: r.dir, base, loaded: true });
    if (extDone) return;
    extDone = true;
    installBridge();
    for (const p of r.items) {
      if (p.error || p.enabled === false) continue;
      // 선언된 단추 — JS 없이도 된다
      for (const b of p.contributes?.buttons ?? []) {
        try {
          if (!b?.slot || !b?.label) continue;
          hostApi(p).addButton(b.slot, {
            label: b.label,
            icon: b.icon,
            onClick: () => {
              if (!b.do || b.do === "openCanvas") hostApi(p).openCanvas(p.id);
              else void hostApi(p).action(b.do.action, b.do.args ?? {});
            },
          });
        } catch (e) {
          console.error(`[plugins] ${p.id} 단추`, e);
        }
      }
      for (const u of p.ext) {
        current = p;
        try {
          // ★모듈로 불러들인다 — 백엔드 오리진이라 CSP 의 script-src 에 127.0.0.1 이 있어야 한다 (tauri.conf.json)
          // ★★주소에 이번 기동의 표식(`BOOT`)을 붙인다 — 캐시된 옛 파일을 받지 않게 (사용자 지시 2026-09-08, 아래 BOOT 주)
          await import(/* @vite-ignore */ `${base}${u}${fresh(u)}`);
        } catch (e) {
          console.error(`[plugins] ${p.id} ext`, e);
          toast(t("plugins.extFail", { n: pickText(p.name), e: String((e as Error)?.message ?? e) }), "warn");
        } finally {
          current = null;
        }
      }
    }
  },
}));

function push<T extends { key: string }>(map: Record<string, T[]>, k: string, item: T): Record<string, T[]> {
  const list = (map[k] ?? []).filter((x) => x.key !== item.key);
  return { ...map, [k]: [...list, item] };
}

/** 플러그인 하나에게 주는 공개 API */
export function hostApi(p: PluginInfo) {
  const st = () => usePlugins.getState();
  return {
    plugin: p,
    backend: st().base,
    addButton(slot: string, b: { label: LocText; icon?: string; onClick: () => void }) {
      // ★이름표는 **언어별 묶음일 수 있다** — 열쇠는 언어와 무관해야 하므로 `keyText` 가 한 가지로 정한다
      usePlugins.setState({ buttons: push(st().buttons, slot, { key: `${p.id}:${keyText(b.label)}`, plugin: p.id, label: b.label, icon: b.icon, onClick: b.onClick }) });
    },
    addMenuItem(menu: string, m: { label: LocText; onClick: (img: PluginImage) => void }) {
      usePlugins.setState({ menus: push(st().menus, menu, { key: `${p.id}:${keyText(m.label)}`, plugin: p.id, label: m.label, onClick: m.onClick }) });
    },
    openCanvas(id: string = p.id) {
      // ★캔버스(2026-09-09): 플러그인 모드로 가서 그 플러그인을 캔버스에 꺼내 놓고 맨 앞으로 (관리 화면을 보고 있었으면 캔버스로)
      useUi.getState().setMode("plugins");
      const q = usePlugins.getState().items.find((x) => x.id === id);
      if (q) putOnCanvas(q);
    },
    /** 앱 액션·백엔드 도구 — 조수가 쓰는 것과 같은 목록(`GET /api/agent/tools`). ★승인 카드를 지나지 않는다 */
    action: async (name: string, args: Record<string, unknown> = {}) => {
      const out = await runAction(name, args, false);
      // ★★앱 액션이 아니면 **백엔드 도구**로 넘긴다 (`get_workspace` 처럼 읽기만 하는 것들). 플러그인에게는
      //   「이름은 도구 목록과 같다」고 안내해 놓고 앱 액션만 되던 구멍이었다 — 태그 굴리기가 지금 씬의 블록을
      //   읽으려다 「모르는 행동」을 받고 조용히 아무것도 못 했다 (실측 2026-09-11).
      if (out && typeof (out as { error?: unknown }).error === "string" && String((out as { error: string }).error).startsWith("모르는 행동")) {
        const r = await fetch(`${usePlugins.getState().base}/api/agent/call`, {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ name, input: args }),
        });
        return (await r.json()) as Record<string, unknown>;
      }
      return out;
    },
    /** 지금 보고 있는 화면 주소 (workspace · tab · sceneGroup) */
    state: () => screenAddr(),
    /** 지금 씬의 **살아 있는** 블록 — `{ base, chars }`. 블록마다 id 가 있어 이름이 겹쳐도 하나를 짚을 수 있다.
     *  ★`action("get_workspace")` 와 달리 저장된 파일이 아니라 화면의 스토어를 읽는다 (`promptEdit.sceneBlocks`). */
    scene: () => sceneBlocks(),
    /** 디자인 토큰 값 — `theme("--accent")`. 이름 없이 부르면 지금 테마 이름(`"dark"` | `"light"`) */
    theme: (name: string) => (name ? getComputedStyle(document.documentElement).getPropertyValue(name).trim() : currentTheme()),
    t,
    /** 지금 앱 언어 (`"ko"` | `"en"` | `"ja"`) — 플러그인이 **자기 문구**를 고를 때 쓴다.
     *  ★앱은 플러그인의 사전을 관리하지 않는다 (사용자 결정 2026-09-11): 언어만 알려 주고,
     *    무엇을 어떻게 번역할지는 플러그인이 정한다. 공식 플러그인은 셋을 다 갖추고, 남의 것은 자유다. */
    locale: () => useI18n.getState().locale,
    toast,
  };
}

export type HostApi = ReturnType<typeof hostApi>;

declare global {
  interface Window {
    peropix?: { registerExtension: (ext: { name?: string; setup?: (api: HostApi) => void | Promise<void> }) => void };
  }
}

if (typeof window !== "undefined" && !window.peropix) {
  window.peropix = {
    registerExtension(ext) {
      const p = current;
      if (!p) {
        console.error("[plugins] registerExtension 은 플러그인 확장 JS 가 불려 오는 동안만 부를 수 있습니다");
        return;
      }
      try {
        void Promise.resolve(ext.setup?.(hostApi(p))).catch((e) => console.error(`[plugins] ${p.id} setup`, e));
      } catch (e) {
        console.error(`[plugins] ${p.id} setup`, e);
      }
    },
  };
}

/** 지금 보이는 테마 — `data-theme` 이 있으면 그것, 없으면(시스템) OS 설정 */
export function currentTheme(): "dark" | "light" {
  const t = document.documentElement.getAttribute("data-theme");
  if (t === "dark" || t === "light") return t;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

/** 테마 이름을 구독한다 — 캔버스가 프레임(iframe)의 `color-scheme` 을 앱 테마에 맞추는 데 쓴다 (`PluginCanvas` 의 ★주) */
export function useThemeName(): "dark" | "light" {
  const [name, setName] = useState(currentTheme);
  useEffect(() => {
    const tell = () => setName(currentTheme());
    const mo = new MutationObserver(tell);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    mq.addEventListener("change", tell);
    return () => {
      mo.disconnect();
      mq.removeEventListener("change", tell);
    };
  }, []);
  return name;
}

/** 앱 → 열린 캔버스 전부: 테마가 바뀌었다 (`{ type: "peropix", event: "theme", theme }`).
 *  ★`theme()` 은 부른 시점의 값이라, 따르고 싶은 플러그인이 바뀐 순간을 알 길이 없었다 (사용자 결정 2026-09-08: 알림을 준다).
 *    `data-theme` 의 변화(설정에서 고름)와 OS 테마의 변화(시스템을 따를 때) 둘 다 본다. 받을지는 플러그인 마음이다. */
function watchTheme() {
  let last = currentTheme();
  const tell = () => {
    const now = currentTheme();
    if (now === last) return;
    last = now;
    for (const f of document.querySelectorAll<HTMLIFrameElement>("iframe[data-plugin-canvas]")) {
      f.contentWindow?.postMessage({ type: "peropix", event: "theme", theme: now }, "*");
    }
  };
  new MutationObserver(tell).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", tell);

  // ★글꼴도 같이 알린다 (사용자 지시 2026-09-11 「플러그인도 앱 설정 글꼴과 같게」). 설정에서 고르면
  //   `applyFont` 가 `<html>` 의 인라인 스타일에 `--font-sans` 를 꽂으므로 그 변화를 본다.
  //   캔버스 쪽에서는 `peropix.js` 가 받아 자기 문서의 `--font-sans` 를 갈아 끼운다.
  //   글자 크기(`--text-scale`)도 같은 자리에서 바뀌므로 함께 본다 (사용자 지시 2026-09-11 「옵션의 글자크기도」).
  let lastFont = rootVar("--font-sans"), lastScale = rootVar("--text-scale");
  const tellStyle = () => {
    const font = rootVar("--font-sans"), scale = rootVar("--text-scale");
    const msgs: Record<string, unknown>[] = [];
    if (font && font !== lastFont) { lastFont = font; msgs.push({ type: "peropix", event: "font", font }); }
    if (scale && scale !== lastScale) { lastScale = scale; msgs.push({ type: "peropix", event: "scale", scale }); }
    if (!msgs.length) return;
    for (const f of document.querySelectorAll<HTMLIFrameElement>("iframe[data-plugin-canvas]")) {
      for (const m of msgs) f.contentWindow?.postMessage(m, "*");
    }
  };
  new MutationObserver(tellStyle).observe(document.documentElement, { attributes: true, attributeFilter: ["style"] });

  // ★언어도 알린다 (사용자 결정 2026-09-11). 설정에서 언어를 바꾸면 캔버스가 그 자리에서 다시 그린다 —
  //   테마·글꼴과 달리 CSS 로는 못 따라오므로, 알림을 받아 플러그인이 자기 문구를 갈아 끼운다.
  let lastLoc = useI18n.getState().locale;
  useI18n.subscribe(() => {
    const now = useI18n.getState().locale;
    if (now === lastLoc) return;
    lastLoc = now;
    for (const f of document.querySelectorAll<HTMLIFrameElement>("iframe[data-plugin-canvas]")) {
      f.contentWindow?.postMessage({ type: "peropix", event: "locale", locale: now }, "*");
    }
  });
}

/** `<html>` 에 꽂힌 앱 토큰 값 (`--font-sans`·`--text-scale`) */
function rootVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/** 캔버스(iframe) → 앱: postMessage 창구. 한 번만 단다. */
let bridged = false;
function installBridge() {
  if (bridged) return;
  bridged = true;
  watchTheme();
  window.addEventListener("message", (e: MessageEvent) => {
    const d = e.data as { type?: string; id?: unknown; call?: string; name?: string; args?: Record<string, unknown>; text?: string; key?: string } | null;
    if (!d || d.type !== "peropix" || !d.call) return;
    const base = usePlugins.getState().base;
    let origin = "";
    try { origin = new URL(base).origin; } catch { /* 아직 모르면 아래 프레임 대조만 */ }
    if (origin && e.origin !== origin) return;
    const frame = [...document.querySelectorAll<HTMLIFrameElement>("iframe[data-plugin-canvas]")].find((f) => f.contentWindow === e.source);
    if (!frame) return;
    const pid = frame.getAttribute("data-plugin-canvas") ?? "";
    const p = usePlugins.getState().items.find((x) => x.id === pid);
    if (!p) return;
    const reply = (msg: Record<string, unknown>) => (e.source as Window | null)?.postMessage({ type: "peropix", id: d.id, ...msg }, e.origin || "*");
    void (async () => {
      try {
        const a = hostApi(p);
        let result: unknown;
        switch (d.call) {
          case "action": result = await a.action(String(d.name ?? ""), d.args ?? {}); break;
          case "state": result = a.state(); break;
          case "scene": result = a.scene(); break;
          case "openCanvas": a.openCanvas(String(d.name ?? p.id)); break;
          case "toast": toast(String(d.text ?? "")); break;
          case "theme": result = a.theme(String(d.name ?? "")); break;
          case "t": result = t(String(d.key ?? d.name ?? ""), d.args as Record<string, string | number> | undefined); break;
          case "locale": result = a.locale(); break;
          case "plugin": result = { id: p.id, name: pickText(p.name), version: p.version, backend: base }; break;
          default: throw new Error(`모르는 호출: ${d.call}`);
        }
        reply({ ok: true, result });
      } catch (err) {
        reply({ ok: false, error: String((err as Error)?.message ?? err) });
      }
    })();
  });
}
