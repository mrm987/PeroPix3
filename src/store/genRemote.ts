import { api } from "../lib/backend";
import { promptOf, useWs, type Spec } from "./workspace";
import { defaultParams, queueGroup, tabImageSnap, useGen } from "./gen";
import { usePrompt } from "./prompt";
import { payloadOfSnap, useImageInput } from "./imageInput";
import { resolveAccount, useAccounts } from "./accounts";
import { randomSeed } from "../lib/seedRounds";
import { liftCardLock } from "../lib/sceneCards";

/** **보고 있지 않은 씬 그룹**으로 생성을 넣는다 — 같은 워크스페이스의 다른 씬 그룹이든, 다른 워크스페이스든
 *  (사용자 지시 2026-08-08: "워크스페이스2에 큐 10개").
 *
 *  ★화면을 그리로 옮기지 않는다 — 보고 있던 것을 뺏지 않는 게 요청의 요지였다.
 *  ★★**생성 버튼과 똑같이 짠다** (사용자 지시 2026-10-12). 짜는 것은 `gen.queueGroup` 하나이고, 여기서는
 *    그 탭에서 생성 버튼을 눌렀다면 읽었을 것을 **그 탭의 것으로** 모아 줄 뿐이다:
 *      · 프롬프트 — 위 줄 탭의 것 (보고 있는 탭이면 화면의 편집기)
 *      · 생성 옵션 — 그 탭에 담아 둔 것 (`tab.gen`). 없으면 탭을 옮겨 갔을 때와 같은 값
 *      · 이미지 입력 — 그 탭에 담아 둔 한 벌 (`tabImageSnap`). 메모리에만 있으므로 **다른 워크스페이스는 비어 있다**
 *        (그쪽을 열어도 비어 있는 것과 같다)
 *  ★예전에는 이 파일이 따로 짜서 이미지 입력·순차 생성·슬롯당 장수·씬 목적지가 빠지고, 베이스가 비면
 *    캐릭터 프롬프트가 있어도 거절했다. 생성 옵션도 쓰이지 않는 `spec.params` 를 읽고 있었다.
 */
export async function queueToWorkspace(
  workspace: string,
  count: number,
  setName?: string,
): Promise<{ ok: true; queued: number; scene_group: string } | { error: string }> {
  const ws = useWs.getState();
  const here = workspace === ws.current;
  let spec: Spec | null = here ? ws.spec : null;
  if (!here) {
    try {
      const r = await api<{ spec: Spec | null }>(`/api/workspaces/${encodeURIComponent(workspace)}`);
      spec = r.spec;
    } catch (e) {
      return { error: `워크스페이스를 못 읽었습니다: ${String((e as Error).message ?? e)}` };
    }
  }
  if (!spec) return { error: `'${workspace}' 워크스페이스가 없습니다.` };

  const groups = spec.sceneGroups ?? [];
  /* ★★세트를 찾는 열쇠는 **`activeSceneGroup`** 이다. 개명(2026-08-24) 전에는 `spec.tabs` 를
     `activeTab` 으로 찾는 맞는 코드였는데, 목록만 `spec.sceneGroups` 로 바뀌고 열쇠는 남아서
     **절대 안 맞고 언제나 `tabs[0]`(첫 세트)으로 떨어졌다** (적대 검토 2026-08-24). */
  /* ★★**id 가 먼저다** (2026-10-12 발견) — 도구 명세는 씬 그룹을 id 로 달라고 하는데 여기서 이름만 보고 있어
       조수가 명세대로 `tab_1` 을 보내면 「'tab_1' 세트가 없습니다」로 생성이 통째로 안 됐다. 이름도 받아 준다. */
  const found = setName
    ? groups.find((t) => t.id === setName) ?? groups.find((t) => t.name === setName)
    : (groups.find((t) => t.id === spec!.activeSceneGroup) ?? groups[0]);
  /* ★서버에서 막 읽은 spec 은 `migrate` 를 안 거쳤다 — 옛 카드 잠금(`card.locked`)을 씬 잠금으로 옮겨야
       잠근 카드의 씬이 생성에 안 섞인다 (`lib/sceneCards` 의 `liftCardLock`) */
  const group = found?.kind === "sceneGroup" ? { ...found, cards: found.cards.map((k) => liftCardLock(k)) } : found;
  if (!group) return { error: setName ? `'${setName}' 세트가 없습니다.` : "세트가 없습니다." };
  if (group.kind !== "sceneGroup") return { error: `'${group.name}' 은 씬 세트가 아닙니다.` };

  const tabId = group.tabId ?? spec.activeTab;
  const tab = (spec.tabs ?? []).find((c) => c.id === tabId);
  /** 그 탭이 **지금 화면의 탭**인가 — 그러면 프롬프트·생성 옵션·이미지 입력이 화면에 살아 있다 */
  const live = here && tabId === spec.activeTab;
  const params = live
    ? useGen.getState().params
    // ★담아 둔 것이 없는 탭은 탭을 옮겨 갔을 때와 같다 — 같은 워크스페이스면 지금 값, 아니면 기본값 (`watchTabParams`)
    : { ...(tab?.gen ? { ...defaultParams(), ...tab.gen } : here ? useGen.getState().params : defaultParams()) };
  const images = live
    ? useImageInput.getState().payload()
    : payloadOfSnap(here && tabId ? tabImageSnap(tabId) : null, params);
  const prompt = live ? usePrompt.getState().snapshot() : promptOf(spec, group);
  const account = resolveAccount(spec.account, useAccounts.getState().items);
  const tabName = tab?.name ?? null;

  let queued = 0;
  for (let round = 0; round < Math.max(1, Math.min(50, count)); round++) {
    /* ★시드는 생성 버튼처럼 **한 바퀴마다 넘긴다**. 화면의 값이면 화면을 굴리고(`generateAll` 과 같다),
       담아 둔 값이면 그 자리에서 새로 뽑는다 — 안 그러면 부를 때마다 같은 시드로 첫 바퀴가 나간다. */
    const p = live ? useGen.getState().params : params.seed_mode === "fixed" ? params : { ...params, seed: randomSeed() };
    let r;
    try {
      r = await queueGroup({ group, workspace, tabName, account, params: p, images, prompt });
    } catch (e) {
      return { error: String((e as Error).message ?? e) };
    }
    if ("empty" in r)
      return { error: r.empty === "locked" ? `'${group.name}' 탭에 잠기지 않은 씬이 없습니다.` : `'${group.name}' 탭에 씬이 없습니다.` };
    queued += r.queued;
    if (live && p.seed_mode !== "fixed") useGen.getState().set("seed", randomSeed());
  }
  return { ok: true, queued, scene_group: group.name };
}
