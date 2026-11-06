import { queryAnyWindow } from "./floatWin";

/** 어떤 일이 벌어지는 동안 **보던 자리를 그대로** 붙잡아 둔다.
 *
 *  ★★「설정 불러오기」가 그 자리다 (사용자 지시 2026-08-21: 현재 위치에 고정).
 *    불러오면 좌측 패널에서 **여러 가지가 한꺼번에** 벌어진다 —
 *    접힌 묶음이 펴지고, 프롬프트 블록이 통째로 갈리고, 강조가 켜진다.
 *    그때마다 내용 높이가 변해 보던 자리가 위아래로 밀린다.
 *  ★`scrollIntoView` 를 끄는 것만으로는 모자란다 — 그것은 「데려가는 것」을 막을 뿐이고,
 *    **내용이 늘어서 밀리는 것**은 그대로다. 그래서 값을 재서 되돌려 놓는다.
 *  ★두 번 되돌린다: 곧바로 한 번(같은 프레임의 변화), 다음 프레임에 한 번(리액트가 그린 뒤).
 *    그 뒤에도 움직이는 것은 사용자가 스스로 굴린 것이라 건드리지 않는다.
 */
export function keepScroll(selector: string, run: () => void) {
  // ★프롬프트를 앱 밖 창으로 분리했으면 거기 있다
  const el = typeof document === "undefined" ? null : (queryAnyWindow(selector) as HTMLElement | null);
  if (!el) return run();
  const top = el.scrollTop;
  const left = el.scrollLeft;
  run();
  const put = () => {
    el.scrollTop = top;
    el.scrollLeft = left;
  };
  put();
  requestAnimationFrame(put);
}

/** 좌측 패널에서 실제로 구르는 칸 (`panels/PromptPanel.tsx` 가 다는 표식).
 *  ★Shell 의 패널 칸이 아니다 — 그 칸은 프롬프트 패널이 높이를 꽉 채워 구를 일이 없다.
 *    한동안 그쪽을 재서 되돌리는 것이 아무 일도 안 했다 (실측 2026-09-28: 내용 높이와 보이는 높이 둘 다 492px). */
export const LEFT_SCROLL = "[data-prompt-scroll]";
