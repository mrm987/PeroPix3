/** 창 제목으로 알린다 — **창을 안 보고 있을 때만** (v2 `index.html:17517-17540` 이식).
 *
 *  v2 는 브라우저 탭이라 `document.title` 하나로 끝났다. 우리는 시스템 타이틀바를 끈
 *  Tauri 창이라 그 값이 화면 어디에도 안 뜬다 — 그래서 **창 제목까지 함께** 바꾼다
 *  (`appWindow.setTitle`). 작업 표시줄과 Alt+Tab 에 보이는 것이 그 값이다.
 *  브라우저(vite dev)에서는 `setTitle` 이 조용히 무시되고 탭 제목만 바뀐다.
 *
 *  ★제목은 v2 와 같은 `PeroPix ✦` 다 (사용자 지시 2026-08-18). 기호를 금지한 규칙은
 *    **SVG 를 넣을 수 있는 자리**를 두고 한 말이고, 창 제목·작업 표시줄처럼 문자열만
 *    들어가는 자리에서는 차선책으로 기호를 쓴다. 다른 화면의 아이콘은 그대로 SVG 다.
 *  ★v2 에서 **항상 켜져** 있던 알림이라 설정으로 끄지 않는다 (소리·토스트와 다르다).
 */
import { appWindow } from "./window";
import { appHasFocus, onEveryWindow } from "./floatWin";

const ORIGINAL = "PeroPix";
/** 이미 걸어 뒀나 — 여러 번 부르면 리스너가 쌓인다 */
let armed = false;

function put(title: string) {
  document.title = title;
  void appWindow.setTitle(title);
}

export function notifyByTitle(text: string) {
  // 보고 있으면 알릴 것이 없다
  if (appHasFocus()) return;
  if (armed) return;
  armed = true;
  put(text);

  const reset = () => {
    armed = false;
    put(ORIGINAL);
    offFocus();
    document.removeEventListener("visibilitychange", onVisible);
  };
  const onVisible = () => {
    if (document.visibilityState === "visible") reset();
  };
  const offFocus = onEveryWindow("focus", reset);
  document.addEventListener("visibilitychange", onVisible);
}
