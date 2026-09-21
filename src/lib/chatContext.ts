/** 조수 대화의 **맥락 관리** — 순수 함수. 페로데스크(Claude Code)가 SDK 로 해 주는 것을 BYOK 경로에서 우리가 한다
 *  (2026-09-22). 실측 계기: 한 대화가 37만 글자(그림 넉 장 24만 + `get_workspace` 두 벌 10만)를 도구 바퀴마다
 *  통째로 다시 보내고 있었고, 그 끝에 오픈라우터 402 가 났다.
 *
 *  넷을 한다.
 *   1. **그림은 그 턴에서만 실린다** (`stripOldImages`) — 앞 턴이 본 그림은 이름 한 줄로 바뀐다.
 *   2. **큰 도구 결과는 자른다** (`capToolResult`) — Claude Code 가 큰 출력을 자르는 것과 같다.
 *   3. **압축** (`compactPlan`·`applySummary`) — 문턱을 넘으면 마지막 턴만 남기고 앞을 요약 하나로 접는다.
 *   4. **문턱** (`compactAt`) — 페로데스크가 창 100만에 50만으로 잡은 이유("큰 맥락을 매 턴 이고 가는 값이
 *      압축을 자주 하는 값보다 크다")를 그대로: 창의 60% 를 넘지 않되 12만을 상한으로.
 *
 *  ★여기는 **저장된 대화(`wire`)를 안 바꾼다** (1·2). 보내는 사본만 바꾼다 — 화면·파일은 그대로 남는다.
 *    바꾸는 것은 압축(3)뿐이고, 그것도 `note` 조각으로 무엇을 접었는지 화면에 남긴다. */
import type { Part, Usage, Wire } from "../store/llm";

/** 한 턴의 시작 — **마지막으로 사용자가 글을 건 메시지**의 자리. 도구 결과도 `role:"user"` 지만 글이 아니다.
 *  ★숨은 글(화면 주소)만 있는 것은 사용자 말이 아니다. 없으면 0. */
export function turnStartOf(wire: Wire[]): number {
  for (let i = wire.length - 1; i >= 0; i--) {
    const m = wire[i];
    if (m.role === "user" && m.content.some((b) => b.type === "text" && !b.hidden && b.text.trim())) return i;
  }
  return 0;
}

/** 앞 턴이 본 그림 — 이름만 남긴다. 조수가 다시 봐야 하면 `read_image` 를 또 부르면 된다 (같은 캐시에서 온다). */
export const IMAGE_NOTE = (files: string[]) =>
  `[images seen earlier in this chat: ${files.join(", ")}. Call read_image again if you need to look.]`;

/** `turnStart` 앞의 `image` 조각을 글 한 줄로 바꾼다. 지금 턴의 그림은 그대로다.
 *  ★그림 메시지는 `[파일, 파일]` 글 조각이 앞에 붙어 있다 (`store/llm` 의 `shots`) — 그 이름을 쓴다. */
export function stripOldImages(wire: Wire[], turnStart: number): Wire[] {
  return wire.map((m, i) => {
    if (i >= turnStart || !m.content.some((b) => b.type === "image")) return m;
    const names = fileNamesOf(m);
    const rest = m.content.filter((b) => b.type !== "image" && !(b.type === "text" && b.text === `[${names.join(", ")}]`));
    return { ...m, content: [...rest, { type: "text", text: IMAGE_NOTE(names) }] };
  });
}

/** 그림 메시지에 붙은 이름 줄 `[a.png, b.png]` 을 푼다. 없으면 「image」 하나. */
function fileNamesOf(m: Wire): string[] {
  const head = m.content.find((b) => b.type === "text" && /^\[.+\]$/.test(b.text.trim()));
  if (head && head.type === "text") return head.text.trim().slice(1, -1).split(",").map((x) => x.trim()).filter(Boolean);
  return ["image"];
}

/** 도구 결과 한 개의 상한 (글자). 12,000 글자 ≈ 3~4천 토큰 — `get_workspace` 통째(5만)의 4분의 1이다.
 *  ★잘렸다는 것과 **어떻게 줄여 부를지**를 함께 적는다 — 조수가 다음 호출에서 인자를 좁힐 수 있게. */
export const TOOL_MAX = 12_000;

export function capToolResult(s: string, max = TOOL_MAX): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + `\n…[truncated: ${s.length.toLocaleString()} chars total, ${max.toLocaleString()} shown. ` +
    "Call again with narrower arguments (e.g. one tab, fewer records) to see the rest.]";
}

/** 압축 문턱 (입력 토큰). **모델마다 다르다** (사용자 지시 2026-09-22: 창을 받아와 유동으로).
 *   · 창(`ctx`)을 알면 그 60% (페로데스크의 50만/100만과 같은 비율 언저리).
 *   · 단가가 오르는 경계(`tier`, 오픈라우터 `pricing.overrides[].min_prompt_tokens`)를 알면 **그 경계의 90%** 까지만.
 *     문턱을 경계에 딱 맞추면 넘은 뒤에야 접혀 한 번은 두 배 단가를 낸다.
 *   · 창을 모르면 12만 (앤트로픽·OpenAI 직접 연결은 목록 API 가 창을 안 준다).
 *  ★한때 12만을 **상한**으로 두어 100만짜리 모델도 12만에서 접혔다 (창의 12% 만 쓰는 셈이었다). */
export const COMPACT_AT = 120_000;
export const COMPACT_RATIO = 0.6;
export const TIER_MARGIN = 0.9;

export function compactAt(ctx?: number | null, tier?: number | null): number {
  if (!ctx || ctx <= 0) return COMPACT_AT;
  const byWindow = Math.floor(ctx * COMPACT_RATIO);
  return tier && tier > 0 ? Math.min(byWindow, Math.floor(tier * TIER_MARGIN)) : byWindow;
}

/** 압축이 필요한가 — 마지막 응답의 입력 토큰으로 판정한다 (재지 못했으면 안 한다: 틀린 수치로 접지 않는다) */
export function needsCompact(usage: Usage | null | undefined, ctx?: number | null, tier?: number | null): boolean {
  return !!usage && usage.in >= compactAt(ctx, tier);
}

/** 무엇을 접나 — 마지막 턴 앞의 전부. 접을 것이 두 메시지도 안 되면 null.
 *  ★마지막 턴은 그대로 둔다: 지금 하는 일의 세부는 요약이 아니라 원문이어야 한다. */
export function compactPlan(wire: Wire[]): { head: Wire[]; tail: Wire[] } | null {
  const at = turnStartOf(wire);
  if (at < 2) return null;
  return { head: wire.slice(0, at), tail: wire.slice(at) };
}

/** 요약을 만드는 지침. ★영어다 — 모델에게만 가는 글이고, 요약 자체는 대화의 언어로 쓰라고 시킨다. */
export const SUMMARY_SYSTEM =
  "You are compacting the earlier part of a conversation between a user and an assistant that operates " +
  "PeroPix, an image generation app, through tools. Write a summary the assistant can continue from. " +
  "Keep, in this order: (1) what the user asked for and every decision the user made; (2) what was actually " +
  "changed, with exact names and ids (workspaces, tabs, scene groups, cards, blocks, files); (3) what is " +
  "still pending or was refused; (4) images and files that were looked at, by name. Omit tool chatter and " +
  "intermediate reasoning. Write in the same language the user used. Plain text, at most 600 words.";

/** 접을 부분을 요약 모델에게 보일 글로 편다 — 도구 결과는 앞 1,500 글자만, 그림은 이름만. */
export function summaryInput(head: Wire[]): string {
  const lines: string[] = [];
  const names = new Map<string, string>();
  for (const m of head) {
    for (const b of m.content) {
      if (b.type === "text") { if (!b.hidden && b.text.trim()) lines.push(`${m.role}: ${b.text.trim()}`); }
      else if (b.type === "tool_use") { names.set(b.id, b.name); lines.push(`assistant → ${b.name}(${JSON.stringify(b.input).slice(0, 400)})`); }
      else if (b.type === "tool_result") lines.push(`${names.get(b.tool_use_id) ?? "tool"} ← ${b.content.slice(0, 1500)}`);
      else if (b.type === "image") lines.push("(image)");
    }
  }
  return lines.join("\n");
}

/** 요약을 대화에 적용한다 — `tail` 의 첫 사용자 메시지 앞에 요약 글 조각을 끼우고, 그 앞에 화면용 `note` 를 둔다.
 *  ★요약을 **따로 메시지로 두지 않는다**: 사용자 메시지 둘이 잇따르면 규격에 따라 합쳐지거나(앤트로픽) 거절된다(제미나이).
 *    첫 사용자 메시지의 조각으로 넣으면 세 규격 모두 그대로 간다. */
export function applySummary(tail: Wire[], summary: string, note: string): Wire[] {
  const [first, ...rest] = tail;
  const prefix: Part = { type: "text", text: `[Summary of the earlier conversation]\n${summary.trim()}\n[End of summary]` };
  const marker: Wire = { role: "assistant", content: [{ type: "note", text: note }] };
  return [marker, { ...first, content: [prefix, ...first.content] }, ...rest];
}

/** 마지막 응답의 사용량 — 대화를 열 때 `ctx` 를 되살린다 */
export function lastUsage(wire: Wire[]): Usage | null {
  for (let i = wire.length - 1; i >= 0; i--) {
    const u = wire[i].usage;
    if (u) return u;
  }
  return null;
}

/** 머리에 보일 「맥락 45k · 캐시 88%」 */
export function fmtUsage(u: Usage): { k: string; pct: number } {
  const k = u.in >= 10_000 ? `${Math.round(u.in / 1000)}k` : u.in.toLocaleString();
  const pct = u.in > 0 ? Math.round((u.cached / u.in) * 100) : 0;
  return { k, pct };
}
