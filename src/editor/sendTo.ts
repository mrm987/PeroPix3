/** 「이미지 편집으로 보내기」 — 씬 캔버스·갤러리·떨구기가 **같은 창구**로 온다 (사용자 지시 2026-09-22).
 *
 *  ★열려 있는 캔버스가 있으면 **한 번만** 묻는다: 새 캔버스 / 레이어로 추가. 여러 장을 보내도 물음은 한 번이고
 *    넣는 곳도 한 곳이다 (사용자 결정 2026-09-22). 열린 캔버스가 없으면 묻지 않고 새 캔버스다.
 *  ★남겨 둔 캔버스를 다 읽은 뒤에 본다 (`ready`) — 안 기다리면 켠 직후에 보낸 그림이 물음 없이 새 캔버스가 된다. */
import { t } from "../i18n";
import { askPick } from "../store/ask";
import { useUi } from "../store/ui";
import type { Dropped } from "../lib/dropImages";
import { useEditor } from "./store";

export async function sendToEditor(items: Dropped[]): Promise<void> {
  if (!items.length) return;
  await useEditor.getState().ready;
  const s = useEditor.getState();
  let how: "new" | "layer" = "new";
  if (s.cur) {
    const a = await askPick({
      title: t("editor.sendAsk"),
      body: t("editor.sendAskBody", { n: items.length }),
      options: [
        { key: "new", label: t("editor.asNew") },
        { key: "layer", label: t("editor.asLayer") },
      ],
      cancel: t("common.cancel"),
    });
    if (!a) return;
    how = a as "new" | "layer";
  }
  await s.openItems(items, how);
  useUi.getState().setMode("editor");
}
