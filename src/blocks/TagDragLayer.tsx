import { createPortal } from "react-dom";
import type { useTagDrag } from "./useTagDrag";
import { useWin } from "../lib/floatWin";

/** 칩을 끄는 동안의 표시들 — 끼울 자리 막대 · 통째로 받는 줄 · 커서를 따라오는 이름표.
 *
 *  ★★**전부 화면 좌표에 띄운다**(`position: fixed`). 자리를 벌리는 식으로 그리면
 *    레이아웃이 밀려 방금 잰 칩 좌표가 어긋난다 (`useTagDrag` 머리 주석).
 *  ★블록 목록(`BlockList`)과 씬 칸(`SlotBlock`)이 **같은 것을 쓴다** — 한쪽만 고치면
 *    같은 조작이 화면마다 다르게 보인다. */
export function TagDragLayer({ tag }: { tag: ReturnType<typeof useTagDrag> }) {
  const here = useWin();
  if (!tag.from) return null;
  const marks = (
    <>
      {tag.bar && (
        <div
          style={{
            position: "fixed",
            left: tag.bar.x,
            top: tag.bar.y,
            width: 3,
            height: tag.bar.h,
            borderRadius: 2,
            background: "var(--accent)",
            boxShadow: "0 0 0 2px var(--accent-bg)",
            zIndex: 901,
            pointerEvents: "none",
          }}
        />
      )}
      {tag.box && (
        <div
          style={{
            position: "fixed",
            left: tag.box.x,
            top: tag.box.y,
            width: tag.box.w,
            height: tag.box.h,
            borderRadius: "var(--r-3)",
            border: "2px solid var(--accent)",
            zIndex: 901,
            pointerEvents: "none",
          }}
        />
      )}
      {tag.ghost && (
        <div
          style={{
            position: "fixed",
            left: tag.ghost.x,
            top: tag.ghost.y,
            zIndex: 902,
            pointerEvents: "none",
            padding: "1px 7px",
            borderRadius: "var(--r-1)",
            background: "var(--chip-bg)",
            border: "1px solid var(--accent)",
            color: "var(--ink)",
            fontSize: "var(--text-2xs)",
            boxShadow: "var(--shadow-3)",
            whiteSpace: "nowrap",
          }}
        >
          {tag.label}
        </div>
      )}
    </>
  );
  // ★커서가 다른 창에 있으면 표시도 그 창에 그린다 (좌표가 그 창 기준이다)
  return tag.win && tag.win !== here ? createPortal(marks, tag.win.document.body) : marks;
}
