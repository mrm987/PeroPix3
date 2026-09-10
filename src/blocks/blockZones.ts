import type { Block } from "../lib/blocks";

/** 화면에 떠 있는 **블록 목록들의 명부** — 칩을 카드 너머로 옮기기 위한 것이다
 *  (사용자 지시 2026-08-24: *"다른 카드의 블럭에도 옮길 수 있게"*).
 *
 *  ★★칩 끌기는 원래 **한 목록 안**에서만 돌았다 (`useTagDrag` 이 자기 `rows` 만 봤다).
 *    목록은 카드마다·씬 칸마다 따로 서므로(`BlockList` 인스턴스), 카드를 넘으려면 **놓는 쪽의
 *    `onChange` 를 부를 방법**이 있어야 한다. 자리는 DOM 으로 찾을 수 있지만(`data-block-list`)
 *    그 목록을 고치는 함수는 DOM 에 없다 — 그래서 명부를 둔다.
 *
 *  ★★**값이 아니라 상자를 담는다** (`ref`). 값을 담으면 렌더마다 다시 등록해야 하고,
 *    한 번이라도 흘리면 **낡은 `blocks` 위에 덮어써서 그 사이의 편집이 사라진다.**
 *    상자를 담아 두면 부르는 순간의 최신 값을 읽는다.
 *  ★열쇠는 `libZone` 이다 — *"화면에서 유일한 id"* 라는 규약이 이미 있고(`BlockList` 의
 *    그 인자 주석), `data-block-list` 로 DOM 에도 같은 값이 나가 있어 둘이 짝을 이룬다.
 *  ★열쇠가 없는 목록(`libZone` 을 안 준 곳)은 **명부에 안 든다** — 받을 수만 없을 뿐,
 *    거기서 끌어내는 것은 그대로 된다.
 */
export type BlockZone = {
  blocks: Block[];
  onChange: (b: Block[]) => void;
  /** 블록이 하나뿐인 자리인가 (씬 칸) — 받을 때 **그 하나**에 붙인다 */
  single?: boolean;
};

const zones = new Map<string, { current: BlockZone }>();

/** 목록 하나를 명부에 올린다. 돌려주는 것으로 내린다 (`useEffect` 의 정리) */
export function registerZone(key: string, box: { current: BlockZone }): () => void {
  zones.set(key, box);
  return () => {
    // ★내릴 때 **내 것인지 보고** 내린다 — 같은 열쇠로 새 목록이 이미 올라왔으면 그대로 둔다
    //   (React 는 새 것을 먼저 붙이고 옛 것을 나중에 정리할 수 있다)
    if (zones.get(key) === box) zones.delete(key);
  };
}

export const getZone = (key: string): BlockZone | undefined => zones.get(key)?.current;
