/** **카드를 지금 자리에 꽂는다** — 사람이 끌어다 놓든 조수가 시키든 **같은 경로** (2026-08-24).
 *
 *  ★★규칙을 두 곳에 두지 않으려고 뽑았다 (선결 조건 3-1 과 같은 원칙). 세 갈래가 각각
 *    화면의 드롭 핸들러 안에만 있었는데, 조수가 *"저장해 둔 수채화풍으로"* 를 받으려면
 *    같은 일을 해야 한다. 베끼면 **끌어다 놓은 것과 조수가 꽂은 것이 달라진다.**
 *
 *  ★카드마다 앉는 자리가 다르다:
 *      그림체(styles)     → 베이스 프롬프트 + **생성 옵션 넷**(아래 ★★)
 *      캐릭터(characters) → 인물 칸 (자리가 없으면 꺼진 채로 들어온다)
 *      포즈세트(posesets) → 지금 세트 위의 씬 카드
 */

import { canEnableChar, useGen } from "../store/gen";
import { usePrompt, thumbFromCard } from "../store/prompt";
import { useUi } from "../store/ui";
import { useWs } from "../store/workspace";
import { styleOptsPatch } from "./styleOpts.ts";
import type { CardKind } from "../store/cards";

type AnyCardLike = {
  id?: string;
  name: string;
  color?: [string, string];
  thumb?: unknown;
  base?: unknown;
  prompt?: unknown;
  uc?: unknown;
  opts?: unknown;
  cells?: unknown[];
};

/** 꽂는다. 못 하면 까닭을 돌려준다 (조수가 사용자에게 말할 수 있게). */
export function applyCard(kind: CardKind, c: AnyCardLike): { error?: string; did?: string } {
  if (kind === "styles") {
    usePrompt.getState().setStyle({
      ref: c.id ?? null,
      name: c.name,
      color: c.color,
      base: c.base,
      uc: c.uc,
      thumb: thumbFromCard(c.thumb),
    } as never);
    /* ★★프롬프트가 되는 넷도 함께 건다 (`lib/styleOpts` 의 ★주) — 이것이 카드 밖에
       남아 있으면 **같은 카드가 다른 그림을 낸다.** 옛 카드에는 없으니 그때는 안 바뀐다.
       ★바뀐 것이 있으면 그 자리를 **편다** — 프롬프트 밖의 값이 함께 바뀌는 것이라
         안 알리면 「왜 갑자기 퀄리티 태그가 붙었지」가 된다. */
    const cur = useGen.getState().params;
    const patch = styleOptsPatch(cur, c.opts as never);
    if (Object.keys(patch).length) {
      useGen.setState({ params: { ...cur, ...patch } });
      useUi.getState().reveal("left", "params", false);
    }
    return { did: `그림체 「${c.name}」 을 걸었습니다` };
  }

  if (kind === "characters") {
    usePrompt.getState().addChar({
      ref: c.id ?? null,
      name: c.name,
      color: c.color,
      prompt: c.prompt,
      uc: c.uc,
      thumb: thumbFromCard(c.thumb),
      // ★자리가 없으면 **꺼진 채로** 들어온다 — 담는 것은 막지 않고, 나가는 수만 지킨다
      on: canEnableChar(),
    } as never);
    return { did: `캐릭터 「${c.name}」 을 넣었습니다` };
  }

  // 포즈세트 — 지금 세트 위에 씬 카드로 얹는다
  const cur = useWs.getState().activeSceneGroup();
  if (cur?.kind !== "sceneGroup") return { error: "열려 있는 세트가 없습니다." };
  if (!Array.isArray(c.cells) || !c.cells.length)
    return { error: `「${c.name}」 에는 씬이 없습니다.` };
  useWs.getState().addCard(cur.id, {
    name: c.name,
    color: c.color,
    cells: c.cells as never,
  });
  return { did: `포즈세트 「${c.name}」 을 「${cur.name}」 에 얹었습니다` };
}
