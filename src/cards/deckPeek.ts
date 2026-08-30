import { useEffect, useRef } from "react";
import { useDrag } from "./dragStore";
import { useUi } from "../store/ui";

/** 카드를 끌기 시작하면 **카드덱을 잠깐 펴 준다** (사용자 지시 2026-08-20).
 *
 *  ★없으면 덱을 접어 둔 사람은 **놓을 자리가 화면에 없다.** 레일만 남아 있어서
 *    "여기 놓으면 되나?"를 알 길이 없고, 카드를 든 채로 접기 단추를 누를 수도 없다.
 *  ★★**놓았으면 열어 두고, 취소하면 도로 닫는다.** 넣은 카드를 바로 봐야 하고,
 *    그만둔 사람의 화면은 건드리지 않은 것과 같아야 한다.
 *  ★임시로 편 것은 **저장하지 않는다** (`commitLayout` 을 안 부른다) — 취소로 끝나면
 *    앱을 다시 켰을 때 접힌 채여야 한다. 놓았을 때만 그 상태를 적어 둔다.
 *
 *  @returns 지금 **덱으로 끌고 있는가** — 부르는 쪽이 패널을 강조하는 데 쓴다 */
export function useDeckPeek(): boolean {
  // `dir: "save"` = 프롬프트 카드·씬 세트 머리를 덱으로 (덱이 받는 유일한 방향)
  // ★블록(`blocklib`)은 같은 방향이지만 **덱이 받지 않는다** — 블록 저장소·다른 카드가 받는다.
  //   그래서 엿보기에서 뺀다 (사용자 지적 2026-08-30: 블록 손잡이를 끌면 덱 패널이 열렸다).
  const saving = useDrag((s) => s.drag?.dir === "save" && s.drag.kind !== "blocklib");
  const peeked = useRef(false);

  useEffect(() => {
    if (saving) {
      if (useUi.getState().rightCollapsed) {
        peeked.current = true;
        useUi.setState({ rightCollapsed: false });
      }
      return;
    }
    if (!peeked.current) return;
    peeked.current = false;
    if (useDrag.getState().dropped) {
      // 넣었다 — 편 채로 두고 그 상태를 적어 둔다
      useUi.getState().commitLayout();
    } else {
      useUi.setState({ rightCollapsed: true });
    }
  }, [saving]);

  return saving;
}
