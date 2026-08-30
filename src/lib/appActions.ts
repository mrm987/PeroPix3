/** **조수가 앱에 시킬 수 있는 일** — 여기가 정의되는 유일한 자리 (2026-08-24).
 *
 *  ★★한 액션의 이름·설명·**인자 형식**·위험도·실행이 **한 덩이**로 붙어 있다. 예전에는
 *    스키마가 백엔드(`agent.py` 의 `_table`)에, 구현이 앱(`queue.ts` 의 `runAction`)에
 *    나뉘어 있어 조용히 어긋났다 — `generate` 스키마의 `set` 을 앱이 안 읽어서 **오류 없이
 *    엉뚱한 씬 그룹에 생성되고 Anlas 가 나갔다** (적대 검토 2026-08-24).
 *
 *  ★목록은 빌드할 때 뽑아 백엔드에 넣는다 (`scripts/gen-actions.mjs`) — 앱이 접속할 때
 *    올려 보내면 소켓 타이밍에 걸려 **도구가 0개**로 보인다 (`backend/agent.py` 머리).
 *
 *  ★★**위험도(`confirm`)를 반드시 적는다.** 자동 승인이 이 값을 본다 (`lib/approve`):
 *      none — 물을 것이 없다 (읽기·값 편집)
 *      ask  — 되돌릴 수 있다 (휴지통 24시간)
 *      hard — **되돌릴 수 없다** — 카드·씬 삭제와 **Anlas 가 나가는 생성**
 *    ★생성은 고정이 아니다: 돈이 나가느냐로 그때 정한다 (사용자 결정 2026-08-24).
 */

import { defineAction, err, nearBy, type ActionResult } from "./actions.ts";
import { useWs, type DelTarget, type SceneGroup } from "../store/workspace";
import { findSetAt, findTab, whereOf } from "./findAt.ts";
import { useCensor } from "../store/censor";
import { useQueue } from "../store/queue";
import { useUi } from "../store/ui";
import { useGen } from "../store/gen";
import { useLlm } from "../store/llm";
import { usePrompt, thumbFromCard } from "../store/prompt";
import { costNow, countNow } from "./costNow.ts";
import { t } from "../i18n";

/* ── 삭제 ──────────────────────────────────────────────────────
   ★한 벌은 스토어에 있다 (`removeAt`) — 여기서는 **찾아 주고 말로 옮길** 뿐이다.
   사람이 버튼을 눌렀을 때와 **같은 함수**를 부른다 (선결 조건 3-1). */

/** 씬 그룹을 찾는다 — ★★규칙은 `lib/findAt` **하나**다 (2026-08-25).
 *
 *  예전에는 여기서 `find(x => x.id === key || x.name === key)` 로 **처음 걸리는 것**을 집었다.
 *  「새 씬 그룹」 같은 기본 이름은 탭마다 있으므로 **다른 탭의 씬 그룹을 지우고** 성공이라 답할 수
 *  있었다 (이 함수를 `delete_scene_group`·`delete_scene`·`move_scene`·`apply` 가 함께 쓴다).
 *  ★못 찾거나 여럿이면 그대로 오류로 바꿔 낸다 — 고르는 것은 코드가 할 일이 아니다. */
function findSet(key: string, tab = "") {
  const r = findSetAt(key, tab);
  if ("hit" in r) return { hit: r.hit as SceneGroup, miss: null };
  return { hit: undefined, miss: err(r.miss.code, r.miss.message, { given: key, candidates: r.miss.candidates }) };
}

const BLOCK_WHY: Record<string, string> = {
  last_set: "그 탭의 마지막 씬 그룹이라 닫을 수 없습니다 (탭에 씬 그룹이 없어집니다).",
  last_tab: "마지막 탭이라 지울 수 없습니다.",
  not_found: "그런 것이 없습니다.",
};

/** 삭제 액션 넷을 같은 모양으로 만든다 — 대상을 고르는 법만 다르다 */
async function doRemove(target: DelTarget): Promise<ActionResult> {
  const r = await useWs.getState().removeAt(target);
  if (!r.ok)
    return err(r.blocked === "not_found" ? "not_found" : "blocked", BLOCK_WHY[r.blocked], {
      retry: "never",
    });
  const p = r.plan;
  const files = p.files.length ? ` (그림 ${p.files.length}장도 휴지통으로)` : "";
  /* ★★**되돌릴 수 없다고 이력에 적는다** (2026-08-24). 삭제는 그 자리의 되돌리기를 빼므로
     되돌리기 로그를 비우므로 `undo_change` 로는 못 돌아온다 — 그렇게 적어 두지 않으면
     조수가 「되돌렸습니다」라고 말해 놓고 아무 일도 안 일어난다.
     ★그림만은 휴지통에서 꺼낼 수 있다 (24시간) — 그 길을 까닭에 적어 조수가 안내하게 한다. */
  return {
    ok: true,
    did: `${p.name} 을(를) 지움${files}`,
    at: { kind: "prompt" },
    undoable: false,
    why: p.files.length
      ? "지운 것은 되돌리기로 못 돌아옵니다. 그림은 list_trash·restore_files 로 24시간 안에 꺼낼 수 있습니다."
      : "지운 것은 되돌리기로 못 돌아옵니다.",
  };
}

/** 승인 카드에 띄울 문구 — **무엇이 사라지는지 미리 세어** 보여 준다 */
function previewRemove(target: DelTarget): string {
  const p = useWs.getState().planRemove(target);
  if (p.blocked) return BLOCK_WHY[p.blocked];
  /* ★★**어느 탭인지 함께 적는다** (사용자 승인 2026-08-25). 이름만 적으면 다른 탭의 같은
     이름을 지우려는 것도 **똑같은 카드**로 보인다 — 그러면 승인 절차가 방어가 되지 않는다.
     ★자리를 말로 옮기는 것은 `lib/findAt` 의 `whereOf` 하나다. */
  const at = target.kind === "sceneGroup" ? whereOf(target.id) : target.kind === "scene" ? whereOf(target.groupId) : "";
  const bits = [at && at.includes("탭") ? `${at} 안의 「${p.name}」` : `「${p.name}」`];
  if (p.inner) bits.push(`안에 든 ${p.inner}개`);
  if (p.files.length) bits.push(`그림 ${p.files.length}장 (휴지통으로)`);
  return bits.join(" · ") + " 가 사라집니다. 되돌리기로는 못 돌아옵니다.";
}

defineAction({
  id: "delete_scene_group",
  title: "씬 그룹을 지웁니다",
  desc: "★**씬 그룹을 닫는다** — 그 안의 씬과 **그림도 함께 휴지통으로** 간다. "
    + "그 탭의 마지막 씬 그룹은 못 닫는다 (탭이 빈다).",
  args: {
    sceneGroup: { type: "string", desc: "씬 그룹 **id** (이름은 탭마다 겹친다)", required: true },
    tab: { type: "string", desc: "어느 탭의 씬 그룹인지 — 이름으로 줄 때 함께 주면 정확하다" },
  },
  confirm: "hard",
  preview: (a) => {
    const { hit } = findSet(String(a.sceneGroup ?? ""));
    return hit ? previewRemove({ kind: "sceneGroup", id: hit.id }) : "그런 씬 그룹이 없습니다.";
  },
  run: async (a) => {
    const { hit, miss } = findSet(String(a.sceneGroup ?? ""), String(a.tab ?? ""));
    if (!hit) return miss!;
    return doRemove({ kind: "sceneGroup", id: hit.id });
  },
});

defineAction({
  id: "delete_scene",
  title: "씬을 지웁니다",
  desc: "★**씬 칸을 지운다** — 그 씬의 **그림도 함께 휴지통으로** 간다. "
    + "`sceneGroup` 을 비우면 지금 보고 있는 씬 그룹에서 찾는다.",
  args: {
    scene: { type: "string", desc: "씬 이름 또는 id", required: true },
    sceneGroup: { type: "string", desc: "어느 씬 그룹에서 — 비우면 지금 보고 있는 씬 그룹 (**id** 가 정확하다)" },
    tab: { type: "string", desc: "어느 탭의 씬 그룹인지 — 씬 그룹을 이름으로 줄 때 함께 준다" },
  },
  confirm: "hard",
  preview: (a) => {
    const f = pickScene(a);
    return "error" in f ? f.error.message : previewRemove(f.target);
  },
  run: async (a) => {
    const f = pickScene(a);
    return "error" in f ? f : doRemove(f.target);
  },
});

/** 씬을 고른다 — 씬 그룹을 안 주면 지금 보고 있는 것에서 */
function pickScene(a: Record<string, any>): { target: DelTarget } | ReturnType<typeof err> {
  const ws = useWs.getState();
  const want = String(a.sceneGroup ?? "").trim();
  const found = want ? findSet(want, String(a.tab ?? "")) : { hit: ws.activeSceneGroup(), miss: null };
  const set = found.hit;
  if (!set || set.kind !== "sceneGroup")
    return found.miss ?? err("not_found", "열려 있는 씬 그룹이 없습니다.", { retry: "never" });
  const key = String(a.scene ?? "").trim();
  const cells = set.cards.flatMap((k) => k.cells);
  const cell = cells.find((c) => c.id === key || c.name === key);
  if (!cell)
    return err("not_found", `그런 씬이 없습니다: ${key}`, {
      what: "scene", given: key, candidates: nearBy(key, cells.map((c) => c.name)),
    });
  return { target: { kind: "scene", groupId: set.id, cellId: cell.id } };
}

/* ── 큐 ─────────────────────────────────────────────────────── */

defineAction({
  id: "cancel_queue",
  title: "생성 큐를 비웁니다",
  desc: "★**생성 큐를 비운다** — 아직 시작 안 한 것이 취소된다. 이미 나간 장은 못 되돌린다 "
    + "(Anlas 가 이미 나갔다). 사용자가 «그만»·«취소» 라고 하면 쓴다.",
  // ★none 으로 내렸다 (사용자 결정 2026-08-25): 아직 안 만든 것을 안 만드는 일이다 — 잃는 것이 없고 자주 한다
  confirm: "none",
  preview: () => {
    const q = useQueue.getState();
    const left = Math.max(0, q.progress.total - q.progress.completed);
    return left ? `대기 중인 ${left}장을 취소합니다.` : "취소할 것이 없습니다.";
  },
  run: async () => {
    const q = useQueue.getState();
    const left = Math.max(0, q.progress.total - q.progress.completed);
    if (!left) return { ok: true, did: "큐가 이미 비어 있음" };
    await q.cancelAll();
    return { ok: true, did: `큐 취소 (대기 ${left}장)`, at: { kind: "queue" } };
  },
});

/* ── 검열 ────────────────────────────────────────────────────── */

defineAction({
  id: "censor_add",
  desc: "자동검열 화면에 **그림을 넣는다**. 경로는 `list_files` 가 준 것을 그대로 쓴다.",
  args: {
    files: { type: "array", items: { type: "string" }, desc: "워크스페이스 기준 상대경로", required: true },
  },
  confirm: "none",
  run: async (a) => {
    const files = (a.files ?? []).map((x: unknown) => String(x)).filter(Boolean);
    if (!files.length) return err("not_found", "넣을 그림을 주세요.");
    const ws = useWs.getState().current;
    if (!ws) return err("no_workspace", "열려 있는 워크스페이스가 없습니다.", { retry: "never" });
    /* ★★**경로 기준이 둘이라 여기서 옮긴다** (선결 조건 3-7, 2026-08-24).
       조수의 파일 도구는 **워크스페이스 폴더** 기준인데(`agent._ws_root`), 검열이 받는
       `rel` 은 **아웃풋 루트** 기준이다(`server._censor_open` 의 `files.under(WS_ROOT, rel)`).
       `list_files` 결과를 그대로 넣으면 「그림을 찾지 못했습니다」가 난다.
       ★기준을 아웃풋 루트로 통일하고, 어긋나는 쪽(조수)이 **경계에서** 워크스페이스 이름을
         앞에 붙인다 — 검열 화면·드롭이 쓰는 값을 건드리지 않는 쪽이 안전하다. */
    const rels = files.map((f: string) => `${ws}/${f.replace(/^\/+/, "")}`);
    await useCensor.getState().addImages(
      rels.map((rel: string) => ({ name: rel.split("/").pop() ?? rel, rel })),
    );
    return { ok: true, did: `검열에 ${files.length}장 넣음`, at: { kind: "censor" } };
  },
});

defineAction({
  id: "censor_clear",
  title: "검열 목록을 비웁니다",
  desc: "자동검열 목록을 **비운다** (원본 파일은 그대로다).",
  // ★none 으로 내렸다 (사용자 결정 2026-08-25): 목록만 비운다 — **원본 파일은 그대로**다
  confirm: "none",
  preview: () => `목록의 ${useCensor.getState().images.length}장을 뺍니다 (원본은 그대로).`,
  run: async () => {
    const n = useCensor.getState().images.length;
    useCensor.getState().clearImages();
    return { ok: true, did: `검열 목록 비움 (${n}장)`, at: { kind: "censor" } };
  },
});

defineAction({
  id: "censor_run",
  title: "자동검열을 돌립니다",
  desc: "★자동검열을 **돌린다** (목록에 든 그림 전부를 훑어 가릴 곳을 찾는다). "
    + "결과 저장은 사용자가 화면에서 따로 누른다.",
  // ★none 으로 내렸다 (사용자 결정 2026-08-25): 훑기만 한다 — 저장은 사용자가 따로 누른다
  confirm: "none",
  preview: () => `${useCensor.getState().images.length}장을 훑습니다.`,
  run: async () => {
    const c = useCensor.getState();
    if (!c.images.length) return err("not_found", "검열 목록이 비어 있습니다. 먼저 그림을 넣어 주세요.");
    await c.scanAll();
    return { ok: true, did: `검열 ${c.images.length}장 훑음`, at: { kind: "censor" } };
  },
});


/* ── 대화 이름 ────────────────────────────────────────────────
   ★★**지금 대화하는 조수가 짓는다** (사용자 지시 2026-08-25: *"이름짓기를 왜 API 키로
     호출함? 지금 대화하는 ai가 지어야지"*). 한때 이름 하나를 위해 BYOK 로 따로 한 번 더
     불렀는데, CLI 로 도는 사용자에게는 **대화하는 쪽과 다른 모델**이 이름을 지었다.
   ★★**호출을 더 늘리지 않는다** (사용자 지시: *"그냥 처음에 그걸 먼저 하고 작업 시작하라고
     하면 되는 거 아님?"*). 첫 턴의 지침에 한 줄을 얹어, 도구 하나를 먼저 부르게 한다. */

defineAction({
  id: "name_chat",
  title: "이 대화에 이름을 붙입니다",
  desc: "★**이 대화의 이름**을 정한다. 이름이 없는 새 대화라면 **다른 일보다 먼저** 부른다. "
    + "무엇에 관한 대화인지를 짧게 적는다 (20자 안팎, 따옴표·마침표 없이). "
    + "사용자가 쓴 언어로 적는다.",
  args: { title: { type: "string", desc: "짧은 제목", required: true } },
  // ★값 하나를 적는 일이고 사용자가 언제든 새 대화를 열 수 있다 — 물을 것이 없다
  confirm: "none",
  run: async (a) => {
    const name = String(a.title ?? "").trim().replace(/^["'「]|["'」]$/g, "").slice(0, 40);
    if (!name) return err("unknown_field", "제목이 비어 있습니다.", { given: String(a.title) });
    useLlm.getState().setTitle(name);
    return { ok: true, did: `대화 이름을 «${name}» 으로 정함` };
  },
});

/* ── 화면 설정 ────────────────────────────────────────────────
   ★★`슬롯당 장수` 가 여기 있어야 하는 까닭: 한 바퀴가 만드는 장 수를 이 값이 정하는데
     (`queued = 씬수 × count × perSlot`), 조수가 읽지도 바꾸지도 못해 *"10종 만들어줘"* 에서
     **장수를 보장할 수 없었다** (시뮬레이션 구멍 B). */

defineAction({
  id: "set_per_slot",
  desc: "★**슬롯당 몇 장**을 뽑을지 정한다. 한 바퀴가 만드는 장 수 = 잠기지 않은 씬 × 이 값. "
    + "«씬마다 3장씩» 같은 요청이 이것이다.",
  args: { n: { type: "number", desc: "1 이상", required: true } },
  confirm: "none",
  run: async (a) => {
    const n = Math.max(1, Math.round(Number(a.n) || 0));
    if (!n) return err("unknown_field", "1 이상의 수를 주세요.", { given: String(a.n) });
    useUi.getState().setPerSlot(n);
    return { ok: true, did: `슬롯당 ${n}장으로 바꿈`, at: { kind: "queue" } };
  },
});

/* ── 생성 옵션 ────────────────────────────────────────────────
   ★값 하나하나에 액션을 만들지 않는다 — **범용 창구 하나**다 (목표 ①: 예외를 열거하면
     반드시 빠뜨린다). 대신 **허용 목록**으로 아무 이름이나 들어오는 것을 막는다. */

/** 조수가 정해도 되는 생성 옵션 — 여기 없는 이름은 거절한다.
 *  ★막는 것: 저장 포맷·품질처럼 **파일이 달라지는 값**과, 화면이 따로 관리하는 것. */
const GEN_FIELDS: Record<string, "number" | "string" | "boolean"> = {
  width: "number", height: "number", steps: "number", cfg: "number",
  seed: "number", cfg_rescale: "number",
  model: "string", sampler: "string", scheduler: "string",
  quality_preset: "string", uc_preset: "string",
  variety_plus: "boolean", transparent_bg: "boolean", furry_mode: "boolean",
};

defineAction({
  id: "set_gen_option",
  desc: "★**생성 옵션을 고친다** — 모델·크기·스텝·CFG·시드·샘플러 등. "
    + "«시드 고정해서 다시»·«스텝 28로» 같은 요청이 이것이다. "
    + "지금 값은 `get_workspace` 의 `gen` 에 있다. 한 번에 여러 개를 줘도 된다.",
  args: {
    options: { type: "object", desc: "고칠 값들 — 예: {\"steps\": 28, \"seed\": 12345}", required: true },
  },
  confirm: "none",
  run: async (a) => {
    const o = (a.options ?? {}) as Record<string, unknown>;
    const bad = Object.keys(o).filter((k) => !GEN_FIELDS[k]);
    if (bad.length)
      return err("unknown_field", `고칠 수 없는 값입니다: ${bad.join(", ")}`, {
        candidates: nearBy(bad[0], Object.keys(GEN_FIELDS)), retry: "safe",
      });
    const g = useGen.getState();
    const done: string[] = [];
    for (const [k, v] of Object.entries(o)) {
      const want = GEN_FIELDS[k];
      const val = want === "number" ? Number(v) : want === "boolean" ? !!v : String(v);
      if (want === "number" && !Number.isFinite(val as number))
        return err("unknown_field", `${k} 는 숫자여야 합니다.`, { given: String(v) });
      g.set(k as never, val as never);
      done.push(`${k}=${val}`);
    }
    if (!done.length) return err("unknown_field", "고칠 값을 주세요.");
    return { ok: true, did: `생성 옵션 고침 — ${done.join(", ")}`, at: { kind: "queue" } };
  },
});

/* ── 생성 ─────────────────────────────────────────────────────
   ★★위험도가 **고정이 아니다** — Anlas 가 나가느냐로 그때 정한다 (사용자 결정 2026-08-24).
     Opus 무료 범위 안이면 자동 승인으로 통과시킨다. 판정은 `lib/anlas.ts` 의 계산을
     그대로 쓴다 (`costNow`) — 새 규칙을 만들면 두 벌이 되어 반드시 갈린다. */

defineAction({
  id: "generate",
  title: "그림을 생성합니다",
  desc: "★**생성을 큐에 넣는다.** 그 씬 그룹의 잠기지 않은 씬 전부를 `count` 바퀴 돈다 "
    + "(씬이 하나면 count 장). 비우면 지금 보고 있는 씬 그룹. "
    + "★**기다릴 필요가 없다** — 큐는 넣는 순간의 프롬프트를 담으므로, 이어서 프롬프트를 "
    + "고치고 또 넣어도 앞 배치는 그대로다. Anlas 가 들 수 있다.",
  args: {
    count: { type: "number", desc: "몇 바퀴. 기본 1" },
    workspace: { type: "string", desc: "어디에 넣을지 — 비우면 지금 보고 있는 곳" },
    sceneGroup: { type: "string", desc: "어느 씬 그룹에 — 비우면 활성 씬 그룹" },
  },
  // ★★돈이 나가면 되돌릴 수 없다 — 그때만 `hard`
  confirm: (a) => (costNow(Math.max(1, Number(a.count) || 1)).total > 0 ? "hard" : "ask"),
  preview: (a) => {
    const rounds = Math.max(1, Number(a.count) || 1);
    const c = costNow(rounds);
    const n = countNow(rounds);
    return c.total > 0
      ? `${n}장을 만듭니다. **Anlas ${c.total}** 가 나갑니다 (되돌릴 수 없습니다).`
      : `${n}장을 만듭니다 (Opus 무료 범위 — Anlas 는 안 나갑니다).`;
  },
  // ★실행은 기존 경로를 그대로 부른다 (`queue.ts` 의 `runAction`) — 프롬프트 조립·시드
  //   규칙이 전부 거기 있어서 여기 옮기면 두 벌이 된다.
  run: async (a) => {
    const { runLegacyAction } = await import("../store/queue");
    const out = await runLegacyAction("generate", a);
    if (out && typeof out === "object" && "error" in out)
      return err("blocked", String((out as { error: unknown }).error), { retry: "never" });
    return { ...(out as object), ok: true, did: String((out as { did?: string }).did ?? t("ai.queued")) } as ActionResult;
  },
});

/* ── 씬 자리 옮기기 ────────────────────────────────────────────
   ★★*"미소 씬이랑 슬픔 씬 위치를 바꿔줘"* 가 이것이다 (사용자 시나리오 2026-08-24).
     자리를 옮기면 **파일 이름의 씬 번호도 따라간다** (`renumberSet`) — 사람이 끌어다
     놓았을 때와 **같은 길**이라 조수가 시켜도 자동으로 맞는다. */

defineAction({
  id: "move_scene",
  desc: "★**씬 자리를 옮긴다.** «미소를 맨 앞으로»·«미소와 슬픔 자리를 바꿔줘» 가 이것이다. "
    + "자리가 바뀌면 **그림 파일 이름의 씬 번호도 따라간다.** "
    + "`before` 를 주면 그 씬 앞으로, 비우면 맨 뒤로 간다.",
  args: {
    scene: { type: "string", desc: "옮길 씬 이름 또는 id", required: true },
    before: { type: "string", desc: "이 씬 **앞**에 놓는다 — 비우면 맨 뒤" },
    sceneGroup: { type: "string", desc: "어느 씬 그룹에서 — 비우면 지금 보고 있는 씬 그룹" },
    tab: { type: "string", desc: "어느 탭의 씬 그룹인지 — 씬 그룹을 이름으로 줄 때 함께 준다" },
  },
  confirm: "none",
  run: async (a) => {
    const ws = useWs.getState();
    const want = String(a.sceneGroup ?? "").trim();
    const found = want ? findSet(want, String(a.tab ?? "")) : { hit: ws.activeSceneGroup(), miss: null };
    const set = found.hit;
    if (!set || set.kind !== "sceneGroup")
      return found.miss ?? err("not_found", "열려 있는 씬 그룹이 없습니다.", { retry: "never" });

    /* ★씬은 **카드 안에** 있다. 옮길 자리는 「받는 카드 + 그 카드 안의 틈 번호」로 준다
       (`moveScene` 의 규약) — 그래서 `before` 가 어느 카드의 몇 번째인지 먼저 찾는다. */
    const key = String(a.scene ?? "").trim();
    const named = set.cards.flatMap((k) => k.cells.map((c) => ({ card: k, cell: c })));
    const mine = named.find((x) => x.cell.id === key || x.cell.name === key);
    if (!mine)
      return err("not_found", `그런 씬이 없습니다: ${key}`, {
        what: "scene", given: key, candidates: nearBy(key, named.map((x) => x.cell.name)),
      });

    const beforeKey = String(a.before ?? "").trim();
    let toCard = mine.card.id;
    let toIndex = -1; // 맨 뒤
    if (beforeKey) {
      const target = named.find((x) => x.cell.id === beforeKey || x.cell.name === beforeKey);
      if (!target)
        return err("not_found", `그런 씬이 없습니다: ${beforeKey}`, {
          what: "scene", given: beforeKey, candidates: nearBy(beforeKey, named.map((x) => x.cell.name)),
        });
      if (target.cell.id === mine.cell.id) return { ok: true, did: "이미 그 자리입니다" };
      toCard = target.card.id;
      toIndex = target.card.cells.findIndex((c) => c.id === target.cell.id);
    }

    ws.moveScene(set.id, mine.cell.id, toCard, toIndex);
    const where = beforeKey ? `「${beforeKey}」 앞으로` : "맨 뒤로";
    return {
      ok: true,
      did: `씬 「${mine.cell.name}」 을 ${where} 옮김 (파일 번호도 함께 갱신)`,
      at: { kind: "prompt" },
    };
  },
});

/* ── 시나리오에서 드러난 빈자리 ────────────────────────────────
   ★2026-08-24 시뮬레이션에서 실제 요청 넷을 도구 호출로 밟아 보고 찾은 것들이다.
     *"키키의 감정별 이미지 10종"* 이 **남의 탭 밑에** 씬 그룹을 만들던 자리(A),
     저장해 둔 그림체를 못 꽂던 자리(C), 새 워크스페이스를 못 만들던 자리(F). */

defineAction({
  id: "switch_tab",
  desc: "★**그 탭으로 옮겨 간다** (윗줄). 이어서 만드는 씬 그룹·씬과 생성이 **그 탭에** 걸린다. "
    + "«키키 탭에서 작업하자» 처럼 대상이 정해진 요청에서 먼저 부른다.",
  args: { tab: { type: "string", desc: "탭 이름 또는 id", required: true } },
  confirm: "none",
  run: async (a) => {
    const ws = useWs.getState();
    const key = String(a.tab ?? "").trim();
    /* ★규칙은 `lib/findAt` 하나다 — 「새 탭」 같은 기본 이름이 겹치면 되묻는다 */
    const found = findTab(key);
    if ("miss" in found)
      return err(found.miss.code, found.miss.message, { what: "tab", given: key, candidates: found.miss.candidates });
    const hit = found.hit;
    if (ws.spec?.activeTab === hit.id) return { ok: true, did: `이미 「${hit.name}」 탭입니다` };
    ws.switchTab(hit.id);
    return {
      ok: true, tab: hit.name, tab_id: hit.id, did: `탭 「${hit.name}」 으로 옮김`,
      at: { kind: "prompt", workspace: ws.current ?? undefined, tab: hit.id },
    };
  },
});

defineAction({
  id: "apply_card",
  desc: "★**저장해 둔 카드를 지금 자리에 꽂는다** — 그림체(styles) · 캐릭터(characters) · "
    + "씬 카드(posesets). «저장해 둔 수채화풍으로»·«키키 카드 올려줘» 가 이것이다. "
    + "카드 목록은 `list_cards` 로 본다.",
  args: {
    kind: { type: "string", desc: '"styles" | "characters" | "posesets"', required: true },
    card: { type: "string", desc: "카드 이름 또는 id", required: true },
  },
  confirm: "none",
  run: async (a) => {
    const kind = String(a.kind ?? "").trim();
    if (!["styles", "characters", "posesets"].includes(kind))
      return err("unknown_field", `카드 종류가 아닙니다: ${kind}`, {
        candidates: ["styles", "characters", "posesets"],
      });
    const { useCards } = await import("../store/cards");
    const list = (useCards.getState()[kind as "styles" | "characters" | "posesets"] ?? []) as
      { id: string; name: string }[];
    const key = String(a.card ?? "").trim();
    /* ★★**id 가 먼저고, 같은 이름이 여럿이면 안 고른다** (2026-08-25). 덱은 언제나
       **새로 추가**라 같은 이름이 쌓인다 — 처음 걸리는 것을 집으면 엉뚱한 그림체가 얹힌다.
       백엔드의 카드 찾기(`agent.py` 의 `_find_card`)와 같은 규칙이다. */
    const same = list.filter((c) => c.name === key);
    if (!list.some((c) => c.id === key) && same.length > 1)
      return err("ambiguous", `「${key}」 이름의 카드가 여럿입니다. id 로 골라 주세요.`, {
        what: kind, given: key, candidates: same.map((c) => `${c.name}#${c.id}`),
      });
    const hit = list.find((c: { id: string; name: string }) => c.id === key) ?? same[0];
    if (!hit)
      return err("not_found", `그런 카드가 없습니다: ${key}`, {
        what: kind, given: key,
        candidates: nearBy(key, list.map((c: { name: string }) => c.name)),
      });
    /* ★★**꽂는 길은 사람이 끌어다 놓을 때와 같은 것**이어야 한다 (선결 조건 3-1 과 같은 원칙).
       카드마다 앉는 자리가 다르다 — 그림체는 베이스 프롬프트, 캐릭터는 인물 칸,
       씬 카드는 씬 그룹 위의 씬 카드다. 그 규칙은 덱 쪽이 갖고 있으므로 그것을 부른다. */
    const { applyCard } = await import("./applyCard");
    const r = applyCard(kind as never, hit as never);
    if (r.error) return err("blocked", r.error, { retry: "never" });
    return {
      ok: true, did: r.did ?? `${hit.name} 을(를) 꽂음`,
      at: { kind: "prompt", workspace: useWs.getState().current ?? undefined },
    };
  },
});

/* ── 캐릭터 칸 — 지우기·스택 (사용자 지적 2026-08-30) ─────────────────────────────
   ★★**지우는 도구가 없어서** 조수가 「캐릭터 다섯을 하나로」를 받으면 넷을 **빈 칸으로 비우고**
     남은 하나에 적었다 — 칸은 그대로 다섯이었다. 블록 `remove` 가 생기기 전과 같은 우회다
     (`store/queue` 의 ★★주). 스택도 화면에서는 끌어다 놓으면 되는데 조수에게는 길이 없었다. */

/** 캐릭터 칸 하나를 고른다 — id 가 먼저, 이름은 하나에만 걸릴 때 */
function pickChar(key: string): { hit: { id: string; name: string } } | ReturnType<typeof err> {
  const chars = usePrompt.getState().chars;
  const byId = chars.find((c) => c.id === key);
  if (byId) return { hit: byId };
  const same = chars.filter((c) => c.name === key);
  if (same.length > 1)
    return err("ambiguous", `「${key}」 이름의 캐릭터 칸이 ${same.length}개입니다. id 로 골라 주세요.`, {
      what: "character", given: key, candidates: same.map((c) => `${c.id}: ${c.name}`),
    });
  if (!same.length)
    return err("not_found", `그런 캐릭터 칸이 없습니다: ${key}`, {
      what: "character", given: key, candidates: nearBy(key, chars.map((c) => c.name)),
    });
  return { hit: same[0] };
}

defineAction({
  id: "remove_character",
  title: "캐릭터 칸을 지웁니다",
  desc: "★**캐릭터 칸(`characters` 항목)을 지운다** — 칸을 비우는 것이 아니라 **없앤다.** "
    + "«캐릭터를 하나로 줄여»·«두 번째 인물 빼» 가 이것이다. 남길 인물을 고치는 것과 나머지를 "
    + "지우는 것은 **다른 두 일**이다: 빈 칸을 남겨 두지 말고 이것으로 지워라. "
    + "★id 는 `get_workspace` 의 `characters[].id` 다. 이름은 하나에만 걸릴 때 받는다.",
  args: {
    character: { type: "string", desc: "캐릭터 칸 — **id** (이름도 받지만 겹치면 거절한다)", required: true },
  },
  confirm: "ask",
  preview: (a) => {
    const f = pickChar(String(a.character ?? "").trim());
    return "error" in f ? f.error.message : `캐릭터 칸 「${f.hit.name}」 이 사라집니다 (프롬프트·UC·스택 포함).`;
  },
  run: async (a) => {
    const f = pickChar(String(a.character ?? "").trim());
    if ("error" in f) return f;
    usePrompt.getState().removeChar(f.hit.id);
    return {
      ok: true, did: `캐릭터 칸 「${f.hit.name}」 을 지움`,
      at: { kind: "prompt", workspace: useWs.getState().current ?? undefined },
      undoable: false,
      why: "지운 캐릭터 칸은 되돌리기로 못 돌아옵니다. 필요하면 카드에서 다시 꽂습니다 (apply_card).",
    };
  },
});

defineAction({
  id: "stack_character",
  title: "캐릭터 카드를 스택에 얹습니다",
  desc: "★**덱의 캐릭터 카드를 어느 캐릭터 칸의 스택(순차 생성 대기줄)에 얹는다.** "
    + "화면에서 카드를 칸 위에 끌어다 놓는 것과 같다 — 생성 한 장이 끝날 때마다 다음 카드로 "
    + "돌아간다. «키키 다음에 미나도 번갈아» 가 이것이다. "
    + "★새 칸을 만드는 것이 아니다 — 새 칸은 `apply_card` 다.",
  args: {
    character: { type: "string", desc: "얹을 캐릭터 칸 — **id** (`get_workspace` 의 `characters[].id`)", required: true },
    card: { type: "string", desc: "덱의 캐릭터 카드 — 이름 또는 id (`list_cards`)", required: true },
  },
  confirm: "none",
  run: async (a) => {
    const f = pickChar(String(a.character ?? "").trim());
    if ("error" in f) return f;
    const { useCards } = await import("../store/cards");
    const list = useCards.getState().characters as
      { id: string; name: string; color: [string, string]; thumb?: unknown }[];
    const key = String(a.card ?? "").trim();
    const same = list.filter((c) => c.name === key);
    if (!list.some((c) => c.id === key) && same.length > 1)
      return err("ambiguous", `「${key}」 이름의 카드가 여럿입니다. id 로 골라 주세요.`, {
        what: "characters", given: key, candidates: same.map((c) => `${c.name}#${c.id}`),
      });
    const card = list.find((c) => c.id === key) ?? same[0];
    if (!card)
      return err("not_found", `그런 캐릭터 카드가 없습니다: ${key}`, {
        what: "characters", given: key, candidates: nearBy(key, list.map((c) => c.name)),
      });
    usePrompt.getState().stackChar(f.hit.id, { ref: card.id, name: card.name, color: card.color, thumb: thumbFromCard(card.thumb) });
    return {
      ok: true, did: `캐릭터 칸 「${f.hit.name}」 의 스택에 「${card.name}」 을 얹음`,
      at: { kind: "prompt", workspace: useWs.getState().current ?? undefined },
    };
  },
});

/* ── 씬 카드 지우기 (사용자 지적 2026-08-30: 씬 칸은 지워도 카드는 못 지웠다) ────── */
defineAction({
  id: "delete_scene_card",
  title: "씬 카드를 지웁니다",
  desc: "★**씬 카드(씬 칸 묶음)를 통째로 지운다** — 그 안의 씬과 **그림도 함께 휴지통으로** 간다. "
    + "씬 하나만 지우는 것은 `delete_scene` 이다. 카드 id 는 `get_workspace` 의 `cards[].id` 다.",
  args: {
    card: { type: "string", desc: "씬 카드 — **id** (이름은 겹칠 수 있다)", required: true },
    sceneGroup: { type: "string", desc: "어느 씬 그룹에서 — 비우면 지금 보고 있는 씬 그룹 (**id** 가 정확하다)" },
    tab: { type: "string", desc: "어느 탭의 씬 그룹인지 — 씬 그룹을 이름으로 줄 때 함께 준다" },
  },
  confirm: "hard",
  preview: (a) => {
    const f = pickSceneCard(a);
    return "error" in f ? f.error.message : previewRemove(f.target);
  },
  run: async (a) => {
    const f = pickSceneCard(a);
    return "error" in f ? f : doRemove(f.target);
  },
});

/** 씬 카드를 고른다 — 씬 그룹을 안 주면 지금 보고 있는 것에서 */
function pickSceneCard(a: Record<string, any>): { target: DelTarget } | ReturnType<typeof err> {
  const ws = useWs.getState();
  const want = String(a.sceneGroup ?? "").trim();
  const found = want ? findSet(want, String(a.tab ?? "")) : { hit: ws.activeSceneGroup(), miss: null };
  const set = found.hit;
  if (!set || set.kind !== "sceneGroup")
    return found.miss ?? err("not_found", "열려 있는 씬 그룹이 없습니다.", { retry: "never" });
  const key = String(a.card ?? "").trim();
  const byId = set.cards.find((k) => k.id === key);
  const same = set.cards.filter((k) => k.name === key);
  if (!byId && same.length > 1)
    return err("ambiguous", `「${key}」 이름의 씬 카드가 ${same.length}개입니다. id 로 골라 주세요.`, {
      what: "sceneCard", given: key, candidates: same.map((k) => `${k.id}: ${k.name} (씬 ${k.cells.length})`),
    });
  const card = byId ?? same[0];
  if (!card)
    return err("not_found", `그런 씬 카드가 없습니다: ${key}`, {
      what: "sceneCard", given: key, candidates: nearBy(key, set.cards.map((k) => k.name)),
    });
  return { target: { kind: "sceneCard", groupId: set.id, cardId: card.id } };
}

defineAction({
  id: "create_workspace",
  title: "새 워크스페이스를 만듭니다",
  desc: "★**새 워크스페이스를 만들고 그리로 옮겨 간다.** 워크스페이스는 최상위 작업 공간이라 "
    + "생성 옵션·바이브가 넘어가지 않는다 — «새 작업 시작하자» 같은 요청에서 쓴다.",
  args: { name: { type: "string", desc: "워크스페이스 이름", required: true } },
  // ★none 으로 내렸다 (사용자 결정 2026-08-25): 만들기만 한다 — 잃는 것이 없다
  confirm: "none",
  preview: (a) => `새 워크스페이스 「${String(a.name ?? "").trim()}」 을 만들고 그리로 옮겨 갑니다.`,
  run: async (a) => {
    const name = String(a.name ?? "").trim();
    if (!name) return err("unknown_field", "이름을 주세요.");
    const ws = useWs.getState();
    await ws.create(name);
    /* ★★**이름은 앱이 정한다** — 같은 이름이 있으면 `create` 가 번호를 붙인다
       (`store/workspace` 의 `create`). 여기서 미리 막지 않는 이유: 막는 규칙이 두 곳에
       생기고, 실제로 만들어진 이름은 저쪽만 안다. **만든 뒤에 물어본다.** */
    const made = useWs.getState().current;
    return { ok: true, workspace: made, did: `워크스페이스 「${made}」 을 만들고 옮겨 감`,
      at: { kind: "prompt", workspace: made ?? undefined } };
  },
});

/* ── 값 편집의 범용 창구 (`apply`) ────────────────────────────
   ★★**액션을 수십 개로 늘어놓지 않는다** (사용자 목표 ①, 2026-08-24). 이름 바꾸기·잠금 같은
     단순한 값에 액션을 하나씩 만들면 **예외 케이스를 코드로 열거하는 방식**이 되어 반드시
     빠뜨리는 것이 생긴다. 창구 하나가 **허용 목록 안에서** 넓게 받는다.
   ★그래도 자유형은 아니다: 무엇(`what`)·어느 것(`id`)·어떤 값(`set`)의 세 칸이 형식으로
     서 있고, 값 이름은 아래 표 밖으로 못 나간다 — 1판의 자유형 `patch` 가 조수의 오타를
     그대로 저장하던 문제를 여기서 막는다.
   ★★블록·프롬프트 편집은 **여기 없다** (설계 2-3). 블록에는 "사용자가 직접 친 글을 그대로
     NAI 에 보낸다"는 규칙이 있어서(`lib/blocks.ts` 의 `src`), 일반 편집으로 태그만 갈아
     끼우면 **같은 시드에서 다른 그림이 나온다.** `edit_current_prompt` 가 그 규칙을 지킨다. */

/** 무엇에 · 어떤 값을 걸 수 있나. ★여기 없는 이름은 **거절한다** (조용히 버리지 않는다) */
const APPLY: Record<string, { fields: Record<string, "string" | "boolean">; label: string }> = {
  tab: { label: "탭", fields: { name: "string" } },
  sceneGroup: { label: "씬 그룹", fields: { name: "string" } },
  scene: { label: "씬", fields: { name: "string", locked: "boolean" } },
  sceneCard: { label: "씬 카드", fields: { name: "string", locked: "boolean", folded: "boolean" } },
};

/** ★★**되돌리는 법을 변경이 스스로 들고 온다** (2026-08-25).
 *
 *  이름 바꾸기·잠금 같은 것은 **반대 값으로 같은 액션을 부르는 것**이 곧 되돌리기다.
 *  그래서 `before` 에 「어떤 액션을 어떤 인자로」를 담아 보내면, 백엔드가 그것을 그대로
 *  다시 불러 준다 (`agent.py` 의 `_undo_change`) — 갈래마다 되돌리는 코드를 새로 적지 않는다.
 *  ★`id` 는 **반드시 id** 로 담는다: 이름으로 담으면 이름을 바꾼 뒤에 못 찾는다. */
const undoApply = (what: string, id: string, was: Record<string, unknown>) => ({
  action: "apply",
  args: { what, id, patch: was },
});

defineAction({
  id: "apply",
  desc: "★**이름·잠금 같은 단순한 값을 고친다.** «씬 그룹 이름을 표정으로»·«미소 씬 잠가줘» 가 "
    + "이것이다. `what` 은 tab·sceneGroup·scene·sceneCard 중 하나이고, `patch` 에 고칠 값을 준다. "
    + "고칠 수 있는 값 — tab·sceneGroup: name / scene: name·locked / sceneCard: name·locked·folded. "
    + "★프롬프트·블록은 여기가 아니라 `edit_current_prompt` 로 고친다.",
  args: {
    what: { type: "string", desc: '"tab" | "sceneGroup" | "scene" | "sceneCard"', required: true },
    id: { type: "string", desc: "그것의 이름 또는 id", required: true },
    patch: { type: "object", desc: '고칠 값 — 예: {"name": "표정"} · {"locked": true}', required: true },
  },
  confirm: "none",
  run: async (a) => {
    const what = String(a.what ?? "").trim();
    const spec = APPLY[what];
    if (!spec)
      return err("unknown_field", `그런 대상이 없습니다: ${what}`, {
        candidates: Object.keys(APPLY), retry: "safe",
      });
    const patch = (a.patch ?? {}) as Record<string, unknown>;
    const bad = Object.keys(patch).filter((k) => !spec.fields[k]);
    if (bad.length)
      return err("unknown_field", `${spec.label}에 고칠 수 없는 값입니다: ${bad.join(", ")}`, {
        candidates: Object.keys(spec.fields), retry: "safe",
      });
    if (!Object.keys(patch).length) return err("unknown_field", "고칠 값을 주세요.");
    for (const [k, v] of Object.entries(patch)) {
      if (spec.fields[k] === "string" && !String(v ?? "").trim())
        return err("unknown_field", `${k} 가 비어 있습니다.`, { retry: "safe" });
    }

    const ws = useWs.getState();
    const key = String(a.id ?? "").trim();
    const done = Object.entries(patch).map(([k, v]) => `${k}=${v}`).join(", ");

    if (what === "tab") {
      const found = findTab(key);
      if ("miss" in found)
        return err(found.miss.code, found.miss.message, { what: "tab", given: key, candidates: found.miss.candidates });
      const hit = found.hit;
      const wasTab = { name: hit.name };
      ws.renameTab(hit.id, String(patch.name));
      return { ok: true, did: `탭 「${hit.name}」 → ${done}`,
        at: { kind: "prompt", workspace: ws.current ?? undefined, tab: hit.id },
        before: undoApply("tab", hit.id, wasTab) };
    }

    if (what === "set") {
      const { hit, miss } = findSet(key, String(a.tab ?? ""));
      if (!hit) return miss!;
      const wasSet = { name: hit.name };
      ws.renameSceneGroup(hit.id, String(patch.name));
      return { ok: true, did: `씬 그룹 「${hit.name}」 → ${done}`,
        at: { kind: "prompt", workspace: ws.current ?? undefined, sceneGroup: hit.id },
        before: undoApply("set", hit.id, wasSet) };
    }

    /* 씬·씬카드 — ★둘 다 **씬 그룹 안**에 산다 (`sceneGroups[].cards[].cells`). 지금 보고 있는
       씬 그룹에서 찾는다: 다른 씬 그룹의 것을 고치려면 먼저 그 씬 그룹을 연다 (`switch_tab`·생성). */
    const cur = ws.activeSceneGroup();
    if (cur?.kind !== "sceneGroup") return err("no_workspace", "열려 있는 씬 그룹이 없습니다.", { retry: "never" });

    if (what === "sceneCard") {
      const card = cur.cards.find((k) => k.id === key || k.name === key);
      if (!card)
        return err("not_found", `그런 씬 카드가 없습니다: ${key}`, {
          what: "sceneCard", given: key, candidates: nearBy(key, cur.cards.map((k) => k.name)),
        });
      const wasCard = Object.fromEntries(
        Object.keys(patch).map((k) => [k, (card as Record<string, unknown>)[k]]),
      );
      ws.setCard(cur.id, card.id, patch as never);
      return { ok: true, did: `씬 카드 「${card.name}」 → ${done}`,
        at: { kind: "prompt", workspace: ws.current ?? undefined, sceneGroup: cur.id },
        before: undoApply("sceneCard", card.id, wasCard) };
    }

    const cells = cur.cards.flatMap((k) => k.cells);
    const cell = cells.find((c) => c.id === key || c.name === key);
    if (!cell)
      return err("not_found", `그런 씬이 없습니다: ${key}`, {
        what: "scene", given: key, candidates: nearBy(key, cells.map((c) => c.name)),
      });
    /* ★씬은 카드 안에 있어 전용 setter 가 없다 — 카드를 통째로 갈아 끼운다. */
    /* ★옛 값을 먼저 뜬다 — 고친 뒤에는 무엇이었는지 알 길이 없다 */
    const wasCell = Object.fromEntries(
      Object.keys(patch).map((k) => [k, (cell as Record<string, unknown>)[k]]),
    );
    ws.patchSceneGroup(cur.id, {
      cards: cur.cards.map((k) => ({
        ...k,
        cells: k.cells.map((c) => (c.id === cell.id ? { ...c, ...patch } : c)),
      })),
    } as never);
    /* ★★이름이 바뀌면 **파일 이름도 따라간다**: 파일 앞 조각이 `<번호>_<씬 이름>` 이라
       이름만 바꾸면 옛 이름이 파일에 그대로 남는다. */
    if (patch.name) void ws.renumberSet(cur.id);
    return {
      ok: true,
      did: `씬 「${cell.name}」 → ${done}` + (patch.name ? " (파일 이름도 함께 갱신)" : ""),
      at: { kind: "prompt", workspace: ws.current ?? undefined, sceneGroup: cur.id, scene: cell.id },
      before: undoApply("scene", cell.id, wasCell),
    };
  },
});
