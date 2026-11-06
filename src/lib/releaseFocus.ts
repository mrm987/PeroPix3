/** 입력칸 밖을 누르면 포커스를 푼다: **앱 전체에서 여기 하나로 한다**
 *  (사용자 지시 2026-11-04: AI 조수 입력칸에서 시작해 전체 입력칸으로).
 *
 *  포커스를 옮기는 것은 `mousedown` 의 기본 동작이다. 끌기가 시작되는 자리(`pointerGesture`)와 타이틀바처럼 그 동작을
 *  막는 표면을 누르면 입력칸에 포커스가 남고, 단축키가 그 칸에 먹혀 죽는다.
 *  ★누르기 처리가 다 끝난 **뒤에** 본다. 브라우저가 이미 옮긴 자리에서는 할 일이 없으므로, 막는 표면에서만 동작이 바뀐다.
 */

import { onEveryWindow } from "./floatWin";

const TEXT_ENTRY = "input, textarea, select, [contenteditable=true]";

/** 일부러 포커스를 지키는 자리.
 *  - 연필 버튼: 흐려지면 저장하고 닫힌 뒤에 클릭이 다시 연다 (`useRename`)
 *  - 자동완성 목록: 누르면 입력칸에 글을 넣는다 (`TagSuggest`)
 *  - 서랍: 글 상자에 끌어다 놓는 출발점이다 (`BlockBody`)
 *  - 창 테두리: 창 크기 조절은 앱 안을 누른 것이 아니다 */
const KEEPS = "[data-rename-btn], [data-tag-suggest], [data-block-drawer], [data-resize-edge]";

export function releaseFocusOnPress(): () => void {
  const onDown = (e: PointerEvent) => {
    // ★누른 창의 문서를 본다. 앱 밖 창은 `document` 가 다르다 (`lib/floatWin`)
    const t = e.target as Element | null;
    const doc = t?.ownerDocument ?? document;
    const a = doc.activeElement as HTMLElement | null;
    if (!a?.matches(TEXT_ENTRY)) return;
    if (t?.closest?.(`${TEXT_ENTRY}, ${KEEPS}`)) return;
    window.setTimeout(() => {
      if (doc.activeElement === a) a.blur();
    }, 0);
  };
  // ★잡기 단계로 듣는다. 버블을 기다리면 `stopPropagation` 하는 표면에서 못 듣는다
  return onEveryWindow("pointerdown", onDown, true);
}
