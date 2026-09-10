/** **무엇이 사라지는가** — 지우기 전에 세어 주는 순수 계산 (2026-08-24).
 *
 *  ★★삭제는 **다섯 단계**다 (`docs/agent-actions-design.md` 3-1):
 *
 *      ① 그림 모으기 → ② 묻기 → ③ 그림을 **먼저** 휴지통으로 → ④ 대상 제거
 *      → ⑤ **지운 자리의** 되돌리기 빼기(`zones`)
 *
 *    예전에는 ①③⑤ 가 **화면 코드에만** 있어서, 스토어 함수(`closeSet`·`removeTab`)를
 *    직접 부르면 그 단계가 통째로 빠졌다. 조수가 그렇게 부르면 *"파일은 남았는데 앱에서
 *    볼 길이 없는 그림"* 이 쌓이고, `Ctrl+Z` 가 **엉뚱한 것**을 되살린다.
 *
 *  ★**묻는 것(②)은 여기 없다.** 창구마다 다르기 때문이다 — 화면은 확인 창(`store/ask`),
 *    조수는 승인 카드(`docs/…` 2-5). 스토어 안에서 `ask()` 를 부르면 조수 경로에서 **둘 다**
 *    뜬다. 그래서 「무엇이 사라지나」(이 파일)와 「실행」(`store/workspace` 의 `removeAt`)만
 *    한 벌로 두고, 묻기는 부르는 쪽이 한다.
 *
 *  ★앱 의존이 없는 순수 함수라 회귀를 붙였다 (`delPlan.test.ts`) — `takes.ts` 와 같은 취급이다.
 */

import { takesOf, type Rec } from "./takes.ts";

/** 지울 대상 — 네 갈래뿐이다 (덱 카드·갤러리 폴더는 다른 저장소라 여기 없다) */
export type DelTarget =
  | { kind: "sceneGroup"; id: string }
  | { kind: "tab"; id: string }
  | { kind: "scene"; groupId: string; cellId: string }
  | { kind: "sceneCard"; groupId: string; cardId: string };

/** 못 하는 이유 — 있으면 **실행하지 않는다** */
export type DelBlock = "not_found" | "last_set" | "last_tab";

export type DelPlan = {
  kind: DelTarget["kind"];
  /** 사람이 읽는 이름 — 확인 창·승인 카드의 문구에 그대로 쓴다 */
  name: string;
  /** 함께 휴지통으로 갈 그림 (이미 지운 것은 뺀다) */
  files: string[];
  /** 딸려 사라지는 것의 수 — 탭이면 세트 수, 세트·씬카드면 씬 수 */
  inner: number;
  /** ★★**되돌릴 수 없다** — `Ctrl+Z` 로도 `undo_change` 로도 안 돌아온다.
   *
   *  자동 승인(2-5)이 이 값을 본다. 지금은 **넷 다 참**이다: 안에 든 씬·프롬프트는
   *  되돌릴 방법이 없고, 그림만 휴지통에서 돌아와 봐야 갈 자리가 없다.
   *  ★그림 자체는 24시간 안에 휴지통에서 꺼낼 수 있다 (3-9) — 「되돌리기」와 다른 경로다. */
  hard: boolean;
  /** ★★**사람의 `Ctrl+Z` 에서 빼야 할 자리들** (2026-08-25).
   *
   *  지운 것 안에 있던 편집은 되돌릴 자리가 없어져, 그대로 두면 `Ctrl+Z` 가 **엉뚱한 것**을
   *  되살린다 (2026-08-22 사용자 지적). 예전에는 그 자리에서 로그를 **통째로 비웠는데**
   *  (`clearUndo`), 그러면 지운 것과 **상관없는 사용자 편집까지** 함께 날아간다 —
   *  특히 조수가 지웠을 때는 사용자가 자기 되돌리기를 예고 없이 잃는다.
   *  ★자리 이름은 화면이 쓰는 것과 같다: 씬은 `scene-<id>`(`SceneLane` 의 `libZone`),
   *    프롬프트는 `<base|charId>-<p|uc>`(`PromptSections`). */
  zones: string[];
  blocked?: DelBlock;
};

/* ── 최소 구조 타입 — 스토어를 끌어오지 않는다 (`takes.ts` 와 같은 방식) ── */
type Cell = { id: string; name: string };
type Card = { id: string; name: string; cells: Cell[] };
type Set_ = { id: string; kind: string; name: string; cards?: Card[]; tabId?: string; idOnly?: boolean };
type Spec_ = { tabs?: { id: string; name: string }[]; sceneGroups: Set_[] };

const isSet = (t: Set_ | undefined): t is Set_ & { cards: Card[] } =>
  !!t && t.kind === "sceneGroup" && Array.isArray(t.cards);

/** 그 세트의 모든 씬 — 카드 순서대로 편다 (`store/workspace` 의 `allCells` 와 같은 규칙) */
const cellsOf = (t: Set_ & { cards: Card[] }): Cell[] => t.cards.flatMap((k) => k.cells);

/** 세트 하나가 들고 있는 그림 전부 */
function filesOfSet(records: Rec[], t: Set_, deleted: (f: string) => boolean): string[] {
  return takesOf(records, { id: t.id, name: t.name, idOnly: t.idOnly }, undefined)
    .filter((r) => !deleted(r.file))
    .map((r) => r.file);
}

/** 무엇이 사라지는지 센다. 대상이 없으면 `blocked: "not_found"` 로 돌려준다 —
 *  ★`null` 을 돌려주지 않는 이유: 부르는 쪽이 "없음"과 "못 함"을 갈라 다뤄야 하는데,
 *    `null` 이면 그 까닭이 사라져 조수에게 줄 오류(2-4)를 만들 수 없다. */
export function planDelete(
  spec: Spec_,
  records: Rec[],
  deleted: (f: string) => boolean,
  target: DelTarget,
): DelPlan {
  const none = (kind: DelTarget["kind"]): DelPlan => ({
    kind, name: "", files: [], inner: 0, hard: true, zones: [], blocked: "not_found",
  });
  const sceneZones = (cells: Cell[]) => cells.map((c) => `scene-${c.id}`);

  if (target.kind === "tab") {
    const tab = (spec.tabs ?? []).find((c) => c.id === target.id);
    if (!tab) return none("tab");
    const mine = spec.sceneGroups.filter((x) => x.kind === "sceneGroup" && x.tabId === target.id);
    const files = mine.flatMap((t) => filesOfSet(records, t, deleted));
    /* ★탭이 사라지면 **그 탭의 프롬프트도** 사라진다 (프롬프트는 탭에 산다) — 편집기가
       다른 탭 것으로 갈리므로 프롬프트 자리의 되돌리기도 함께 뺀다.
       ★캐릭터 자리는 id 를 모르므로 **베이스만** 뺀다: 남는 것이 있어도 `Ctrl+Z` 가
         엉뚱한 것을 되살리지는 않는다 (그 자리의 편집이었던 것은 맞다). */
    const zones = [
      ...mine.flatMap((t) => (isSet(t) ? sceneZones(cellsOf(t)) : [])),
      "base-p", "base-uc",
    ];
    return {
      kind: "tab", name: tab.name, files, inner: mine.length, hard: true, zones,
      // ★마지막 탭은 지우지 않는다 — 세트가 설 자리가 없어진다 (`removeTab` 의 주석)
      blocked: (spec.tabs ?? []).length <= 1 ? "last_tab" : undefined,
    };
  }

  if (target.kind === "sceneGroup") {
    const t = spec.sceneGroups.find((x) => x.id === target.id);
    if (!isSet(t)) return none("sceneGroup");
    /* ★★**그 탭의 마지막 세트는 못 닫는다** (`closeSet` 의 ★★주). 안 막으면 탭 줄이
       비고 `neighbour` 가 undefined 라 앱이 죽는다. 세는 단위는 **탭**이다. */
    const siblings = spec.sceneGroups.filter((x) => x.kind === "sceneGroup" && x.tabId === t.tabId);
    return {
      kind: "sceneGroup", name: t.name, files: filesOfSet(records, t, deleted),
      inner: cellsOf(t).length, hard: true, zones: sceneZones(cellsOf(t)),
      blocked: siblings.length <= 1 ? "last_set" : undefined,
    };
  }

  const t = spec.sceneGroups.find((x) => x.id === target.groupId);
  if (!isSet(t)) return none(target.kind);

  if (target.kind === "sceneCard") {
    const card = t.cards.find((k) => k.id === target.cardId);
    if (!card) return none("sceneCard");
    const files = card.cells.flatMap((c) =>
      takesOf(records, { id: t.id, name: t.name, idOnly: t.idOnly }, c)
        .filter((r) => !deleted(r.file))
        .map((r) => r.file),
    );
    return { kind: "sceneCard", name: card.name, files, inner: card.cells.length, hard: true,
             zones: sceneZones(card.cells) };
  }

  const cell = cellsOf(t).find((c) => c.id === target.cellId);
  if (!cell) return none("scene");
  const files = takesOf(records, { id: t.id, name: t.name, idOnly: t.idOnly }, cell)
    .filter((r) => !deleted(r.file))
    .map((r) => r.file);
  return { kind: "scene", name: cell.name, files, inner: 0, hard: true, zones: [`scene-${cell.id}`] };
}
