/** **되돌리기 로그** — `Ctrl+Z` 가 보는 유일한 자리.
 *
 *  ★★**스택이 하나여야 한다** (사용자 지시 2026-08-22: *"실행취소를 제대로된 전역 로그를
 *    기록하게 만들어 … 컨트롤+z를 했을 때 사용자의 기대는 마지막에 수정한 걸 되돌리는거임."*).
 *    예전에는 스택이 **둘**이었고(칩 지우기 · 그림 선별) 부르는 쪽이 `칩 || 선별` 순서로
 *    물었다. 그래서 방금 그림을 지웠어도 칩 스택에 뭔가 남아 있으면 **칩이 먼저** 되돌아갔다
 *    (사용자 지적: *"카드 삭제하고 되돌리기하면 카드 말고 다른 슬롯에서 지운 이미지가 복구됨"*).
 *
 *  ★**되돌리는 방법을 그때 만들어 담는다** (`() => 이전 상태로`). 무엇이 어느 스토어에 사는지를
 *    여기서 알 필요가 없다 — 바꾸는 자리가 이미 그 방법을 쥐고 있으므로 그것을 담아 두면 된다.
 *  ★**이름을 함께 담는다.** 되돌릴 수 있는 것이 여러 갈래라, 무엇이 되돌아갔는지 말해 주지
 *    않으면 사용자가 화면에서 그것을 찾아 헤맨다.
 *  ★저장하지 않는다. 화면을 보는 동안만 사는 값이다.
 *
 *  ★★**되돌릴 수 없는 일을 하면 그 자리의 항목을 뺀다** (`dropUndoZone`). 세트·탭·씬·카드를
 *    지우면 그 안의 것을 되돌릴 방법이 사라지므로, 그대로 두면 `Ctrl+Z` 가 **엉뚱한 것**을
 *    되살린다 (2026-08-22 사용자 지적: *"카드 말고 다른 슬롯에서 지운 이미지가 복구됨"*).
 *    ★★**통째로 비우지 않는다** (사용자 정정 2026-08-25). 한동안 `clearUndo()` 로 스택을
 *      전부 지웠는데, 그러면 지운 것과 **상관없는 사용자 편집까지** 함께 날아간다 —
 *      특히 조수가 지웠을 때 사용자는 자기 되돌리기를 예고 없이 잃는다. 08-22 지적의 요지도
 *      **범위가 틀린 것**이었지 「전부 비워라」가 아니었다.
 *      뺄 자리는 `lib/delPlan` 의 `zones` 가 준다.
 *  ★`clearUndo` 는 **자리가 통째로 갈릴 때만** 쓴다 — 워크스페이스·탭 전환처럼 화면의
 *    모든 자리가 다른 것이 되는 경우다.
 */

export type UndoEntry = {
  /** 화면에 알릴 이름 — 이미 옮겨진 문구를 넣는다 */
  label: string;
  run: () => void | Promise<void>;
  /** **어느 자리의 일인가** — 블록 목록의 `libZone` 과 같은 값 (`base-p`·`<charId>-uc`).
   *  ★조수가 그 자리를 고치면 여기 걸린 사람의 항목을 버린다 (`dropUndoZone`). */
  zone?: string;
};

const stack: UndoEntry[] = [];

/** 너무 오래된 것은 버린다 — 그때의 상태가 이미 다른 것이 됐을 수 있다 */
const MAX = 50;

export function pushUndo(label: string, run: () => void | Promise<void>, zone?: string): void {
  stack.push({ label, run, zone });
  if (stack.length > MAX) stack.shift();
}

/** 마지막 것을 되돌린다. 되돌린 것의 **이름**을 주고, 없으면 `null` —
 *  부르는 쪽이 그것으로 알림을 띄우고 키 기본 동작을 막을지 정한다. */
export function undoLast(): string | null {
  const e = stack.pop();
  if (!e) return null;
  void e.run();
  return e.label;
}

/** 방금 담은 칸을 **도로 버린다** — 담아 둔 일이 저절로 취소됐을 때.
 *  ★쓰는 자리: `Esc` 로 물러나 갓 만든 빈 블록이 스스로 사라지는 길(`BlockList` 의 `cancelAt`).
 *    그 칸을 남겨 두면 `Ctrl+Z` 가 **없어진 그 블록을 되살린다.** */
export function dropUndo(): void {
  stack.pop();
}

export function canUndo(): boolean {
  return stack.length > 0;
}

/** ★★**조수가 고친 자리는 사람의 되돌리기에서 뺀다** (사용자 결정 2026-08-24).
 *
 *  담아 둔 되돌리기는 「그때의 블록 목록으로 되돌린다」는 **통째 복원**이라, 그 사이에 조수가
 *  같은 자리를 고쳐 놓았으면 `Ctrl+Z` 한 번이 **조수의 편집까지 조용히 지운다.**
 *  그래서 조수가 손댄 자리의 항목만 버린다 — 다른 자리(그림 선별·다른 캐릭터)는 그대로 남는다.
 *
 *  조수가 한 일을 되돌리는 길은 따로 있다: 조수에게 말하면 이력을 보고 되돌린다
 *  (`backend/agentlog.py` · `undo_change`). 두 경로를 한 키에 묶지 않는 것이 요점이다. */
export function dropUndoZone(zone: string): number {
  let n = 0;
  for (let i = stack.length - 1; i >= 0; i--) {
    if (stack[i].zone === zone) {
      stack.splice(i, 1);
      n++;
    }
  }
  return n;
}

/** 탭·세트·워크스페이스가 바뀌거나, 되돌릴 수 없는 삭제가 일어나면 비운다 */
export function clearUndo(): void {
  stack.length = 0;
}

/** 지금 로그에 쌓인 이름들 (새것이 뒤) — 판정과 디버깅용 */
export function undoLabels(): string[] {
  return stack.map((e) => e.label);
}
