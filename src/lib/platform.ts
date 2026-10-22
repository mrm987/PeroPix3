/** 지금 맥에서 도는가 — 맥 웹뷰(WKWebView)의 UA 에는 `Macintosh` 가 들어 있다.
 *  ★창 모양(신호등 버튼·크기 조절)과 웹뷰 차이를 가르는 데만 쓴다. 단축키는 이것으로 가르지 않는다 —
 *    `ctrlKey || metaKey` 를 함께 받는 것이 이 앱의 방식이다. */
export const IS_MAC = typeof navigator !== "undefined" && /Macintosh/.test(navigator.userAgent);
