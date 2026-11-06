import { useEffect, useRef, useState } from "react";
import { useWin } from "../lib/floatWin";

/** 패널 폭 조절 손잡이.
 *  드래그 중에는 상태만 바꾸고, 손을 뗐을 때 한 번만 저장한다(onCommit). */
export function ResizeHandle({
  width,
  setWidth,
  onCommit,
  min = 240,
  max = 640,
  side = "left",
}: {
  width: number;
  setWidth: (w: number) => void;
  onCommit?: () => void;
  min?: number;
  max?: number;
  /** left = 손잡이 왼쪽에 패널이 있음 / right = 오른쪽에 있음 */
  side?: "left" | "right";
}) {
  const win = useWin();
  const [dragging, setDragging] = useState(false);
  const start = useRef({ x: 0, w: 0 });

  useEffect(() => {
    if (!dragging) return;
    const move = (e: MouseEvent) => {
      const dx = e.clientX - start.current.x;
      const next = side === "left" ? start.current.w + dx : start.current.w - dx;
      setWidth(Math.max(min, Math.min(max, next)));
    };
    const up = () => {
      setDragging(false);
      onCommit?.();
    };
    win.addEventListener("mousemove", move);
    win.addEventListener("mouseup", up);
    // 드래그 중 텍스트 선택·커서 깜빡임 방지
    const body = win.document.body;
    const prev = body.style.cursor;
    body.style.cursor = "ew-resize";
    body.style.userSelect = "none";
    return () => {
      win.removeEventListener("mousemove", move);
      win.removeEventListener("mouseup", up);
      body.style.cursor = prev;
      body.style.userSelect = "";
    };
  }, [dragging, min, max, onCommit, setWidth, side, win]);

  /** ★★**자리를 먹지 않는다** (사용자 지시 2026-08-26: *"가로 모드일 때 씬 헤더가 좌측 끝까지
   *    안 닿는다. 생성 패널의 리사이즈 핸들러 두께만큼 여백이 있는 느낌인데, 생성 패널과
   *    떨어져 있지 않게 붙여 줘"*).
   *    5px 짜리 띠가 흐름 안에 있어서, 가운데 칸이 통째로 그만큼 밀려 있었다. 이제 폭 0 인
   *    자리만 남기고 **띠는 경계선 위에 겹쳐 띄운다** — 잡히는 넓이는 그대로 6px 이다.
   *  ★`zIndex` 로 양옆 패널 위에 올린다. 오른쪽 손잡이는 DOM 상 패널보다 앞에 있어서
   *    올리지 않으면 패널 배경에 덮인다. */
  return (
    <div style={{ flex: "0 0 0px", position: "relative", zIndex: 3, alignSelf: "stretch" }}>
    <div
      onMouseDown={(e) => {
        if (e.button !== 0) return;
        start.current = { x: e.clientX, w: width };
        setDragging(true);
      }}
      style={{
        position: "absolute",
        top: 0,
        bottom: 0,
        left: -3,
        width: 6,
        cursor: "ew-resize",
        background: dragging ? "var(--accent)" : "transparent",
        transition: dragging ? undefined : "background 0.12s",
      }}
      onMouseEnter={(e) => {
        if (!dragging) e.currentTarget.style.background = "var(--accent-line)";
      }}
      onMouseLeave={(e) => {
        if (!dragging) e.currentTarget.style.background = "transparent";
      }}
    />
    </div>
  );
}
