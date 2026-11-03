import { useUi } from "../store/ui";
import { nextAfter } from "./pickNext";
import { newestFirst, takesOfScene, type Rec } from "./takes";
import { allCells, useWs } from "../store/workspace";
import { isPreviewFile, previewOf, usePreviews, withPreviews } from "../store/previews";
import { useSceneFocus } from "../store/sceneFocus";
import { useQueue } from "../store/queue";
import { pushUndo } from "./undo";
import { t } from "../i18n";

/** 씬 칸에 **보이는 그대로**의 장 목록과, 그 위를 오가는 규칙.
 *
 *  ★★창구를 하나로 둔 이유: 같은 규칙을 두 곳이 쓴다 — 씬 줄의 `Del` 키와 프리뷰의
 *    **삭제 단추**다. 나눠 적어 두었더니 키로 지우면 옆 장으로 넘어가는데 단추로 지우면
 *    아무것도 안 골라진 상태가 됐다 (사용자 지적 2026-08-21).
 *  ★목록은 화면과 **같아야** 한다 — 지운 것 빼기, 「별표만 보기」 거르기, 최신이 앞.
 *    하나라도 다르면 「다음 장」이 화면에 없는 장을 가리킨다.
 */
export function visibleTakes(cellId: string): Rec[] {
  const ws = useWs.getState();
  // ★세트를 찾는 것이므로 열쇠는 `activeSceneGroup` 이다 (개명 casualty — `CanvasTabs.SaveHint` 와 같은 자리)
  const tab = ws.spec?.sceneGroups.find((x) => x.id === ws.spec?.activeSceneGroup);
  if (tab?.kind !== "sceneGroup" || !cellId) return [];
  const cell = allCells(tab).find((c) => c.id === cellId);
  if (!cell) return [];
  const all = withPreviews(ws.records, ws.current, usePreviews.getState().items);
  /* ★거르기는 **여기 하나**다 — 줄·큰 그림·다음 장 고르기가 전부 이 목록을 본다 */
  const starOnly = useUi.getState().laneStarOnly;
  return takesOfScene(all, tab, allCells(tab), cell)
    .filter((r) => !starOnly || ws.isStarred(r.file))
    .sort(newestFirst);
}

/** 줄에 **보이는 차례 그대로**의 칸 — 「대기·생성 중」이 앞, 그다음이 나온 장.
 *
 *  ★★**대기 칸도 한 칸이다** (사용자 지시 2026-08-25 휠 · 2026-08-28 방향키:
 *    *"씬에서 방향키 좌우 이동으로 이미지 전환할 때 생성 중 이미지로 전환이 안 됨"*).
 *    대기 칸은 **파일이 없어서** 파일 목록으로는 가리킬 수가 없다 — 그래서 원소를
 *    「파일이거나 대기 번호」 둘 중 하나로 든다.
 *  ★★**차례는 씬 줄과 같아야 한다** (`SceneRow` 의 `waits`·`takes`): 늦게 넣은 대기가
 *    앞이고, 나온 장은 최신이 앞이다. 줄에서 보이는 차례와 다르면 넘길 때마다 튄다.
 *  ★★규칙을 **여기 하나**에 둔다. 예전에는 큰 그림의 휠(`Canvas`)만 대기 칸을 지나가고
 *    방향키(`stepTake`)는 파일만 봤다 — 같은 지적이 두 번 온 까닭이 그것이다. */
export type LaneSlot = { file: string; pending?: undefined } | { pending: string; file?: undefined };

export function visibleSlots(cellId: string): LaneSlot[] {
  const waits = useQueue
    .getState()
    .pending.filter((p) => p.cellId === cellId)
    .slice()
    .reverse()
    .map((p) => ({ pending: p.id }) as LaneSlot);
  return [...waits, ...visibleTakes(cellId).map((r) => ({ file: r.file }) as LaneSlot)];
}

/** 한 칸 옆으로 (`d = +1` 오른쪽 · `-1` 왼쪽). 끝에서는 **머문다** — 감싸지 않는다.
 *
 *  ★줄은 **최신이 왼쪽**이다. 그래서 오른쪽이 「그 다음으로 옛것」이다.
 *  ★감싸지 않는 이유: 방향키로 훑을 때 끝에서 반대편으로 튀면 지금 어디인지를 잃는다.
 *  ★대기 칸에서도 출발한다 — 거기 서 있을 때 방향키가 죽으면 되돌아 나올 길이 없다. */
export function stepTake(d: 1 | -1): boolean {
  const { cell, file, pending } = useSceneFocus.getState();
  if (!cell) return false;
  const list = visibleSlots(cell);
  const at = pending
    ? list.findIndex((x) => x.pending === pending)
    : file
      ? list.findIndex((x) => x.file === file)
      : -1;
  if (at < 0) return false;
  const next = list[at + d];
  if (!next) return false;
  /* ★방향키·휠은 고른 것을 **안 푼다** — 푸는 것은 「그냥 좌클릭」과 `Esc` 뿐이다
     (사용자 지시 2026-08-22). 고른 목록이 그 자체로 정본이라, 훑고 지나가도 안 불어난다.
     ★그래서 대기 칸으로 갈 때도 `focusPending`(고른 것을 푼다)을 안 쓰고 자리만 옮긴다 —
       그쪽은 **클릭**의 창구다. */
  if (next.file) useSceneFocus.getState().focus(cell, next.file);
  else useSceneFocus.setState({ cell, file: null, pending: next.pending });
  return true;
}

/** 그 씬의 **`want` 번째 칸**으로 자리를 옮긴다.
 *
 *  ★★**같은 번째가 없으면 가장 가까운 칸**이다 (사용자 지시 2026-08-28: *"같은 줄 있으면
 *    같은 줄로 이동. 없으면 그 씬에서 가장 가까운 이미지로 이동"*). 씬마다 장 수가 달라서
 *    무조건 맨 앞으로 가면 **줄이 옆으로 통째로 밀리고**, 견주던 자리도 잃는다.
 *  ★그 씬에 아무것도 없으면 씬만 고른다. */
function focusAt(cellId: string, want: number) {
  const list = visibleSlots(cellId);
  if (!list.length) return useSceneFocus.getState().focus(cellId, null);
  const s = list[Math.min(Math.max(0, want), list.length - 1)];
  if (s.file) useSceneFocus.getState().focus(cellId, s.file);
  else useSceneFocus.setState({ cell: cellId, file: null, pending: s.pending });
}

/** 지금 서 있는 칸이 그 씬에서 **몇 번째**인가 (없으면 `0`) */
function slotIndex(cellId: string): number {
  const { file, pending } = useSceneFocus.getState();
  const list = visibleSlots(cellId);
  const at = pending
    ? list.findIndex((x) => x.pending === pending)
    : file
      ? list.findIndex((x) => x.file === file)
      : -1;
  return at < 0 ? 0 : at;
}

/** **옆 씬으로** (`d = +1` 다음 · `-1` 이전). 끝에서는 머문다 — 감싸지 않는다.
 *
 *  ★★사용자 지시 2026-08-28: *"방향키 위아래로 하면 씬 간에 전환되게 해 줘.
 *    세로 모드에선 반대로 작동하고."* 축을 가르는 것은 **씬이 늘어선 방향**이다 —
 *    아래 모드에서는 씬이 위아래로 쌓이므로 위아래 키가, 세로 모드에서는 씬이 좌우로
 *    서므로 좌우 키가 씬을 오간다. 장을 넘기는 축(`stepTake`)과 언제나 직각이다.
 *  ★★씬을 옮기면 **같은 번째 칸**에 선다 (사용자 지시 2026-08-28). 없으면 그 씬에서 가장
 *    가까운 칸이다(끝). 무조건 맨 앞으로 가면 줄이 옆으로 통째로 밀리고, 씬끼리 같은 번째를
 *    견주던 자리도 잃는다. 자리만 옮기고 큰 그림을 비우지도 않는다 —
 *    그러면 「전환됐다」가 눈에 안 보인다.
 *  ★카드를 가로질러 센다: 화면에 보이는 차례가 곧 이 차례다 (`allCells`).
 *  ★감싸지 않는 것은 `stepTake` 와 같은 까닭이다 — 끝에서 반대편으로 튀면 자리를 잃는다.
 *  ★훑는 동안 고른 것은 안 푼다 (`stepTake` 의 ★주와 같다). */
export function stepScene(d: 1 | -1): boolean {
  const ws = useWs.getState();
  const tab = ws.spec?.sceneGroups.find((x) => x.id === ws.spec?.activeSceneGroup);
  if (tab?.kind !== "sceneGroup") return false;
  const cells = allCells(tab);
  const { cell } = useSceneFocus.getState();
  const at = cells.findIndex((c) => c.id === cell);
  if (at < 0) return false;
  const next = cells[at + d];
  if (!next) return false;
  // ★서 있던 번째를 그대로 들고 간다 (`focusAt` 의 ★★주)
  focusAt(next.id, slotIndex(cell));
  return true;
}

/** 이 장(들)을 지우면 **어디로 갈지** — 오른쪽(그 다음으로 옛것) → 없으면 왼쪽 → 없으면 `null`.
 *
 *  ★★**지우기 전에** 부른다. 지운 뒤에 부르면 그 장이 목록에서 빠져 자리를 잃는다 —
 *    지금은 `deleteFiles` 가 비동기라 뒤에 불러도 우연히 맞지만, 그 우연에 기대지 않는다.
 *  ★지우는 것은 부르는 쪽이 한다 — 여기는 **어디로 갈지**만 정한다.
 *  ★여러 장을 지울 때는 **함께 사라지는 것을 건너뛴다.** 안 그러면 방금 지운 장을 가리켜
 *    큰 자리가 텅 빈다 (한 장짜리와 같은 결함이 여러 장에서 되살아난다). */
export function pickAfterRemoving(cellId: string, file: string | string[]): string | null {
  /* ★규칙 자체는 `lib/pickNext` 하나다 — 갤러리도 같은 것을 쓴다 (2026-08-25).
     여기서는 **어느 목록인가**만 정한다. */
  return nextAfter(visibleTakes(cellId).map((r) => r.file), file);
}

/** 고른 것을 **휴지통으로** 보낸다 — 여러 장 고른 상태면 **전부**, 아니면 보고 있는 한 장.
 *
 *  ★★창구가 하나여야 한다: `Del` 키와 큰 그림 아래 **삭제 단추**가 같은 일을 한다.
 *    나눠 적었더니 키로 지우면 옆 장으로 넘어가는데 단추로 지우면 아무것도 안 골라진
 *    상태가 됐다 (사용자 지적 2026-08-21). 이번에 「여러 장 지우기」가 늘면서 갈라질 자리가
 *    하나 더 생겼으므로 아예 여기로 모은다 (사용자 지시 2026-08-22).
 *  ★**고른 것을 먼저 푼다.** 지워진 파일을 고른 채로 두면 그 뒤의 `Ctrl+Z` 로 되살아나기
 *    전까지 없는 파일을 가리킨다.
 *  ★★**미저장 그림도 같은 창구로 지운다** (사용자 지시 2026-09-30: *"자동저장을 하든 안 하든 최대한
 *    UI 동일하게"*). 예전에는 미저장의 표식(`preview:3`)까지 서버 휴지통으로 보내서, 서버에서는 아무
 *    일도 안 일어나고 화면에서도 안 빠졌다 (`Del` 이 안 먹었다). 미저장은 메모리에서 빼고, 섞여 있으면
 *    `Ctrl+Z` 한 번이 둘 다 되살린다.
 *  @returns 실제로 지운 것 (없으면 빈 배열) */
export function removeTakes(): string[] {
  const f = useSceneFocus.getState();
  // ★고른 것이 있으면 **그것 전부**, 없으면 지금 보고 있는 한 장
  const target = f.picked.length ? [...f.picked] : f.file ? [f.file] : [];
  if (!target.length) return [];
  const next = pickAfterRemoving(f.cell, target);   // ★지우기 **전에** 정한다
  useSceneFocus.getState().setPicked([]);           // ★없어진 파일을 고른 채로 두지 않는다
  const files = target.filter((x) => !isPreviewFile(x));
  const drops = target.filter(isPreviewFile);
  const back = drops.length ? usePreviews.getState().discard(drops) : undefined;
  if (files.length)
    void useWs.getState().deleteFiles(files, { also: back }).catch(() => back && pushUndo(t("common.undoImages"), back));
  else if (back) pushUndo(t("common.undoImages"), back);
  useSceneFocus.getState().focus(f.cell, next);
  return target;
}

/** 미저장 그림을 **파일로 남긴다** — 「저장」 버튼만 부른다 (사용자 지시 2026-09-30: 저장 버튼을 누른 것이
 *  아니면 어디서도 저장하지 않는다. 파일이 있어야 하는 일은 미저장에서 꺼 둔다). 이미 파일이면 그대로 돌려준다.
 *  ★저장하면 그 장을 가리키던 자리(보고 있는 장 · 고른 것 · 별표)가 **새 경로**를 따라간다. 안 그러면
 *    방금 저장한 장이 화면에서 빠진 자리를 가리킨다. */
export function saveTake(file: string): Promise<string> {
  if (!isPreviewFile(file)) return Promise.resolve(file);
  /* ★★저장 중인 장을 또 부르면 **같은 약속**을 돌려준다 — 저장이 끝나기 전에는 미리보기가 목록에 남아 있어서,
       `Enter` 를 두 번 누르면(버튼과 키를 함께 써도) 같은 그림이 파일 둘로 남는다. */
  const running = saving.get(file);
  if (running) return running;
  const p = saveTakeOnce(file).finally(() => saving.delete(file));
  saving.set(file, p);
  return p;
}

/** 지금 저장 중인 미리보기 → 그 약속 (`saveTake`) */
const saving = new Map<string, Promise<string>>();

async function saveTakeOnce(file: string): Promise<string> {
  const starred = !!previewOf(file)?.starred;
  const rec = await usePreviews.getState().save(file);
  const ws = useWs.getState();
  ws.addRecord(rec);
  // ★별표를 옮겨 적는 것은 되돌리기 목록에 안 넣는다 — 사용자가 켠 별표가 아니라 이미 켜 둔 것이 따라가는 것이다
  if (starred) ws.restoreStars([...(useWs.getState().spec?.selection.starred ?? []), rec.file]);
  const f = useSceneFocus.getState();
  if (f.picked.includes(file)) f.setPicked(f.picked.map((x) => (x === file ? rec.file : x)));
  if (f.file === file) f.focus(f.cell, rec.file);
  return rec.file;
}
