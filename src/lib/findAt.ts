/** **자리를 찾는 규칙** — 워크스페이스 → 탭 → 세트. 창구는 여기 하나다.
 *
 *  ★★왜 모았나 (사용자 지시 2026-08-25): 자리마다 `find(x => x.id === key || x.name === key)`
 *    를 손으로 적고 있었는데, 그것은 **목록에서 처음 걸리는 것**을 집는다. 「새 세트」·「새 탭」
 *    같은 기본 이름은 탭마다 있으므로 **엉뚱한 것을 집고 성공이라 답한다.**
 *    실제로 프롬프트 편집에서 그 일이 났고(2026-08-25), 같은 모양이 **지우는 경로**에도
 *    있었다 — 거기서는 다른 탭의 그림이 통째로 휴지통으로 간다.
 *
 *  ★규칙 셋 (순서가 규칙이다):
 *    1. **id 가 먼저다.** 이름은 사용자가 계속 고치는 값이라 열쇠가 못 된다.
 *    2. 이름이면 **지금 탭 안**에서 찾는다 (대개 보고 있는 것을 말한다).
 *    3. 그래도 여럿이면 **고르지 않고 되묻는다.** 코드가 하나를 집으면 틀렸을 때
 *       **조용히** 틀린다 — 그것이 이번에 난 일이다.
 */
import { useWs } from "../store/workspace";

/** 못 찾았거나 여럿일 때 부르는 쪽이 낼 오류 — 코드와 후보를 함께 준다 */
export type FindMiss = { code: "not_found" | "ambiguous"; message: string; candidates: string[] };

const tabsOf = () => useWs.getState().spec?.tabs ?? [];
const sceneGroupsOf = () => (useWs.getState().spec?.sceneGroups ?? []).filter((x) => x.kind === "sceneGroup");

/** 「어느 탭의 어느 것」을 말로 — 승인 카드·보고에 붙인다 (자리가 어긋난 것이 눈에 보이게) */
/** 그 씬 그룹이 **어느 탭에** 있나 — 씬 그룹 자신의 이름은 넣지 않는다.
 *  ★`whereOf` 는 「탭의 씬그룹」까지 말한다. 지우는 대상이 **씬 그룹 자신**일 때 그것을 쓰면
 *    「…「A」 안의 「A」」 처럼 이름이 두 번 나온다 (사용자 지적 2026-08-31). */
export function tabOf(groupId: string): string {
  const set = sceneGroupsOf().find((x) => x.id === groupId);
  const tab = set && tabsOf().find((c) => c.id === (set as { tabId?: string }).tabId);
  return tab ? `「${tab.name}」 탭` : "";
}

export function whereOf(groupId: string): string {
  const set = sceneGroupsOf().find((x) => x.id === groupId);
  if (!set) return "";
  const tab = tabsOf().find((c) => c.id === (set as { tabId?: string }).tabId);
  return tab ? `「${tab.name}」 탭의 「${set.name}」` : `「${set.name}」`;
}

/** 탭 하나 — id 우선, 이름은 하나로 좁혀질 때만 */
export function findTab(key: string): { hit: { id: string; name: string } } | { miss: FindMiss } {
  const tabs = tabsOf();
  const byId = tabs.find((c) => c.id === key);
  if (byId) return { hit: byId };
  const named = tabs.filter((c) => c.name === key);
  if (named.length === 1) return { hit: named[0] };
  if (named.length > 1)
    return {
      miss: {
        code: "ambiguous",
        message: `「${key}」 이름의 탭이 여럿입니다. 탭 id 로 골라 주세요.`,
        candidates: named.map((c) => `${c.name}#${c.id}`),
      },
    };
  return {
    miss: { code: "not_found", message: `그런 탭이 없습니다: ${key}`, candidates: tabs.map((c) => c.name) },
  };
}

/** 세트 하나 — id 우선 → 지금 탭 안의 같은 이름 → 그래도 여럿이면 되묻는다.
 *  @param tabKey 탭을 함께 받으면 **그 탭 안에서만** 찾는다 (주소로 부를 때) */
export function findSetAt(key: string, tabKey = ""): { hit: { id: string; name: string } } | { miss: FindMiss } {
  const sceneGroups = sceneGroupsOf();
  const byId = sceneGroups.find((x) => x.id === key);
  if (byId) return { hit: byId };

  let scope = sceneGroups;
  if (tabKey) {
    const t = findTab(tabKey);
    if ("miss" in t) return t;
    scope = sceneGroups.filter((x) => (x as { tabId?: string }).tabId === t.hit.id);
  }
  const named = scope.filter((x) => x.name === key);
  if (named.length === 1) return { hit: named[0] };
  /* ★탭을 안 줬으면 **지금 탭**을 먼저 본다 — 「이거 고쳐 줘」는 대개 보고 있는 것이다 */
  if (!tabKey && named.length > 1) {
    const here = named.filter(
      (x) => (x as { tabId?: string }).tabId === useWs.getState().spec?.activeTab,
    );
    if (here.length === 1) return { hit: here[0] };
  }
  if (named.length > 1)
    return {
      miss: {
        code: "ambiguous",
        message: `「${key}」 이름의 세트가 여럿입니다. 세트 id 로 골라 주세요.`,
        candidates: named.map((x) => `${whereOf(x.id)}#${x.id}`),
      },
    };
  return {
    miss: {
      code: "not_found",
      message: `그런 세트가 없습니다: ${key}`,
      candidates: scope.map((x) => x.name),
    },
  };
}
