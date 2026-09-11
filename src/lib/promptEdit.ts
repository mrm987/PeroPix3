/** 프롬프트 편집 액션의 **공용 규칙** — 주소 풀기 · 보낸 시점의 화면 · 블록 고르기 (2026-09-07).
 *
 *  ★★왜 뽑았나 (사용자 지시 2026-09-07: *"카드 생성·수정·덱에 저장 모든 액션은 개별로 만들어"*).
 *    한 도구(`edit_current_prompt`)가 스타일 카드·캐릭터 칸·씬 칸을 `area` 문자열 하나로
 *    가르고 있었다. 갈라진 액션들이 같은 규칙(주소·블록 지목)을 써야 하므로 규칙만 여기 모은다.
 *
 *  ★★**보낸 시점의 화면이 「지금 자리」다** (사용자 지시 2026-09-07: *"유저가 채팅 보내는 시점에
 *    해당 메시지에 현재 보고 있던 화면 경로를 같이 보내. 중간에 전환해도 llm은 보낸 시점의 화면
 *    기준으로 판단하게"*). 채팅 스토어가 턴을 시작할 때 그 주소를 들고(`useLlm.turnAddr`),
 *    앱 액션은 실행 직전에 화면을 그 주소로 맞춘다(`alignToTurn`). 그래서 인자를 비운
 *    「지금 씬 그룹」이 사용자가 말을 건 그 자리가 된다 — 도구 하나하나가 기본값을 따로
 *    셈하지 않는다 (같은 규칙이 여러 벌이면 반드시 갈린다).
 */
import { usePrompt } from "../store/prompt";
import { useWs } from "../store/workspace";
import { useLlm } from "../store/llm";
import { findSetAt, findTab, whereOf } from "./findAt.ts";
import { err, type ActionError } from "./actions.ts";
import { makeBlock, parseSegs, type Block, type Tag } from "./blocks.ts";

export type Addr = { workspace?: string; tab?: string; sceneGroup?: string };

/** 지금 화면의 주소 — 워크스페이스 이름 · 탭 id · 씬 그룹 id */
export function screenAddr(): Addr {
  const ws = useWs.getState();
  return {
    workspace: ws.current ?? undefined,
    tab: ws.spec?.activeTab ?? undefined,
    sceneGroup: ws.spec?.activeSceneGroup ?? undefined,
  };
}

/** 지금 화면에 **살아 있는** 씬의 블록 — 스타일 카드(`base`)와 캐릭터 카드들.
 *
 *  ★★조수의 `get_workspace` 는 **저장된 파일**을 읽으므로 방금 손댄 것을 모른다. 그래서 블록을 지우고 넣는
 *    플러그인이 자기가 조금 전에 넣은 것(또는 사용자가 방금 만든 것)을 못 보고 지나쳤다 (게스트 실측 2026-09-11:
 *    지울 대상이 스냅샷에 없어 지우기가 통째로 헛돌았다). 이 함수는 **스토어를 그대로** 읽는다. */
export function sceneBlocks() {
  const p = usePrompt.getState();
  const strip = (b: Block) => ({ id: b.id, label: b.label, on: b.on, tags: b.tags });
  return {
    base: p.base.map(strip),
    chars: p.chars.map((c) => ({ id: c.id, name: c.name, prompt: (c.prompt ?? []).map(strip) })),
  };
}

/** 사용자 말에 붙여 보내는 한 줄 — id 와 이름을 함께 (지침이 이 줄을 설명한다). */
export function screenAddrText(): string {
  const ws = useWs.getState();
  const spec = ws.spec;
  const tab = spec?.tabs?.find((c) => c.id === spec.activeTab);
  const group = spec?.sceneGroups?.find((x) => x.id === spec.activeSceneGroup);
  const q = (s: string) => JSON.stringify(s);
  const bits = [`workspace=${q(ws.current ?? "")}`];
  if (tab) bits.push(`tab=${tab.id} ${q(tab.name)}`);
  if (group) bits.push(`sceneGroup=${group.id} ${q(group.name)}`);
  return `[screen] ${bits.join(" ")}`;
}

/** 채팅 줄에 숨겨 실은 주소를 되읽는다 (`screenAddrText` 의 반대) */
export function parseAddrText(line: string): Addr | null {
  if (!line.startsWith("[screen] ")) return null;
  const out: Addr = {};
  const ws = /workspace="((?:[^"\\]|\\.)*)"/.exec(line);
  if (ws) out.workspace = JSON.parse(`"${ws[1]}"`);
  const tab = /tab=(\S+) "/.exec(line);
  if (tab) out.tab = tab[1];
  const g = /sceneGroup=(\S+) "/.exec(line);
  if (g) out.sceneGroup = g[1];
  return out;
}

/** 이 턴의 주소 — 턴이 도는 동안만 있다. 아니면 null (화면이 곧 기준이다) */
export function turnAddr(): Addr | null {
  const s = useLlm.getState();
  return s.sending && s.turnAddr ? s.turnAddr : null;
}

/** ★이 액션들은 자리를 안 탄다 — 대화·큐·검열·옮겨 가기 자체 */
const NO_ALIGN = new Set([
  "name_chat", "ask_user", "ask_approve", "cancel_queue",
  "censor_add", "censor_clear", "censor_run",
  "create_workspace", "switch_tab", "create_tab", "restore_prompt",
]);
/** ★이 액션들은 **자리를 옮긴다** — 끝나면 이 턴의 주소도 따라간다 (조수가 일부러 옮긴 것) */
export const MOVERS = new Set(["create_workspace", "switch_tab", "create_tab", "create_scene_group"]);

/** 실행 직전에 화면을 **보낸 시점의 자리**로 맞춘다. 워크스페이스가 다르면 거절한다 —
 *  작업이 통째로 바뀌는 것이라 조수가 몰래 넘나들 일이 아니다. */
export function alignToTurn(action: string): { error: ActionError } | null {
  if (NO_ALIGN.has(action)) return null;
  const want = turnAddr();
  if (!want) return null;
  return alignScreen(want);
}

export function alignScreen(want: Addr): { error: ActionError } | null {
  const ws = useWs.getState();
  if (want.workspace && ws.current && want.workspace !== ws.current)
    return err(
      "blocked",
      `말을 건 때의 워크스페이스는 「${want.workspace}」 인데 지금 열린 것은 「${ws.current}」 입니다. ` +
        `그쪽을 고치려면 사용자가 그 워크스페이스를 다시 열어야 합니다.`,
      { retry: "never" },
    );
  const spec = ws.spec;
  if (!spec) return null;
  if (want.tab && want.tab !== spec.activeTab && (spec.tabs ?? []).some((c) => c.id === want.tab))
    ws.switchTab(want.tab);
  const now = useWs.getState().spec;
  if (want.sceneGroup && want.sceneGroup !== now?.activeSceneGroup
      && now?.sceneGroups.some((x) => x.id === want.sceneGroup))
    useWs.getState().setActiveSceneGroup(want.sceneGroup);
  return null;
}

export type Opened = {
  set: { id: string; name: string; kind: string };
  /** 「어느 탭의 어느 씬 그룹」 — 답에 붙인다 (보고 있는 탭과 다르면 바로 보이게) */
  where: string;
};

/** 액션 인자의 주소(`workspace`·`tab`·`sceneGroup`)를 풀어 **그 자리를 연다.**
 *  비우면 지금 자리다 (턴 정렬이 이미 보낸 시점의 자리로 맞춰 놓았다).
 *  ★씬 그룹은 id 가 먼저다 — 이름은 탭마다 겹친다 (`lib/findAt`). 여럿이면 되묻는다. */
export function openAddress(a: Record<string, unknown>): { error: ActionError } | Opened {
  const wantWs = String(a.workspace ?? "").trim();
  const ws = useWs.getState();
  if (wantWs && wantWs !== ws.current)
    return err(
      "blocked",
      `지금 열린 워크스페이스는 「${ws.current}」 입니다. 「${wantWs}」 를 고치려면 사용자가 그 워크스페이스를 열어야 합니다.`,
      { retry: "never" },
    );
  const wantTab = String(a.tab ?? "").trim();
  const wantSet = String(a.sceneGroup ?? a.set ?? "").trim();
  if (wantTab && !wantSet) {
    const t = findTab(wantTab);
    if ("miss" in t) return err(t.miss.code, t.miss.message, { what: "tab", given: wantTab, candidates: t.miss.candidates });
    if (ws.spec?.activeTab !== t.hit.id) ws.switchTab(t.hit.id);
  }
  if (wantSet) {
    const f = findSetAt(wantSet, wantTab);
    if ("miss" in f) return err(f.miss.code, f.miss.message, { what: "sceneGroup", given: wantSet, candidates: f.miss.candidates });
    const groups = useWs.getState().spec?.sceneGroups ?? [];
    const owner = (groups.find((x) => x.id === f.hit.id) as { tabId?: string } | undefined)?.tabId;
    /* ★씬 그룹은 탭에 속한다 — 탭을 안 옮기면 윗줄과 아랫줄이 어긋난 채 남는다 */
    if (owner && owner !== useWs.getState().spec?.activeTab) useWs.getState().switchTab(owner);
    useWs.getState().setActiveSceneGroup(f.hit.id);
  }
  const spec = useWs.getState().spec;
  const set = spec?.sceneGroups.find((x) => x.id === spec?.activeSceneGroup);
  if (!set) return err("not_found", "열려 있는 씬 그룹이 없습니다.", { retry: "never" });
  return { set, where: whereOf(set.id) };
}

/* ── 블록 지목 ─────────────────────────────────────────────────
   ★★**이름으로는 못 고른다** (사용자 정정 2026-08-26: *"보통 다 같은 이름임"*). 기본 이름이
     「새 블록」이라 거의 모든 블록이 같은 이름이다 — 이름으로 갈아 끼우거나 걷으면 남의 블록까지
     함께 간다. 여럿이면 **고르지 않고 되묻는다** (후보에 id 와 앞 태그를 실어 준다).
   ★고칠 자리가 둘이면 두 번 부르면 된다 — 하나는 갈아 끼우고 하나는 걷어낸다. */

export type BlockEdit = { label: string; tags: Tag[]; mode: "add" | "replace" | "remove"; block: string };

export function readEdit(a: Record<string, unknown>): BlockEdit {
  const m = String(a.mode ?? "add");
  return {
    label: String(a.label ?? "블록"),
    tags: parseSegs(String(a.tags ?? "")),
    mode: m === "replace" || m === "remove" ? m : "add",
    block: String(a.block ?? "").trim(),
  };
}

export const editVerb = (e: BlockEdit) => (e.mode === "remove" ? "걷어냄" : e.mode === "replace" ? "갈아 끼움" : "더함");

/** 고른 자리에 새 태그를 넣거나(갈아 끼움) 그 블록을 걷는다. 못 고르면 뒤에 붙인다.
 *  ★하나로 안 좁혀지면 오류 — `ambiguous` 에 후보를 싣는다. */
export function applyEdit(cur: Block[], e: BlockEdit): { next: Block[] } | { error: ActionError } {
  /* ★`add` 는 **언제나 새 블록**이다. 옛 코드는 같은 이름이 하나 있으면 add 인데도 그 블록을 갈아
     끼웠다 — 설명("뒤에 붙임")과 달랐고, 조수가 「더했다」고 말한 것이 실제로는 덮어쓴 것이 됐다. */
  if (e.mode === "add") return { next: [...cur, makeBlock(e.label, [], { open: true, tags: e.tags })] };
  let at = -1;
  if (e.block) {
    at = cur.findIndex((b) => b.id === e.block);
    if (at < 0)
      return err("not_found", `그런 블록이 없습니다: ${e.block}`, {
        what: "block", given: e.block, candidates: cur.map((b) => `${b.id}: ${b.label}`),
      });
  } else {
    const hits = cur.filter((b) => b.label === e.label);
    if (hits.length > 1)
      return err("ambiguous", `「${e.label}」 이름의 블록이 ${hits.length}개입니다. block 에 블록 id 를 주세요.`, {
        what: "block", given: e.label,
        candidates: hits.map((b) => `${b.id}: ${b.tags.map((x) => x.t).slice(0, 4).join(", ")}`),
      });
    if (hits.length === 1) at = cur.indexOf(hits[0]);
  }
  if (at >= 0)
    return { next: e.mode === "remove" ? cur.filter((_, i) => i !== at) : cur.map((b, i) => (i === at ? { ...b, tags: e.tags } : b)) };
  if (e.mode === "remove") return { next: cur };               // 걷을 것이 없다 — 그대로 둔다
  return { next: [...cur, makeBlock(e.label, [], { open: true, tags: e.tags })] };
}

/** 캐릭터 칸 하나 — id 가 먼저, 이름은 하나에만 걸릴 때. 없으면 `none` */
export function findChar(key: string):
  | { hit: { id: string; name: string } }
  | { none: true }
  | { error: ActionError } {
  const chars = usePrompt.getState().chars;
  const byId = chars.find((c) => c.id === key);
  if (byId) return { hit: byId };
  const same = chars.filter((c) => c.name === key);
  if (same.length > 1)
    return err("ambiguous", `「${key}」 이름의 캐릭터 칸이 ${same.length}개입니다. id 로 골라 주세요.`, {
      what: "character", given: key, candidates: same.map((c) => `${c.id}: ${c.name}`),
    });
  return same.length ? { hit: same[0] } : { none: true };
}
