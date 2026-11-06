import { useEffect, useRef, useState, type CSSProperties, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { useI18n } from "../i18n";
import { Icon } from "../components/Icon";
import { TipLayer } from "../components/Tip";
import { DragLayer } from "../cards/DragLayer";
import { BusyOverlay } from "./BusyOverlay";
import { WinBtn } from "./TitleBar";
import { dockArea, FLOAT_OK, splitArea, useFloat, WinCtx, type FloatArea, type FloatLive } from "../lib/floatWin";
import { useUi } from "../store/ui";
import { IS_MAC } from "../lib/platform";

/** 앱 밖 창 하나 — 영역을 새 창 문서에 포털로 그린다 (`lib/floatWin`).
 *
 *  ★분리되어 있지 않으면 아무것도 안 그린다. 메인 쪽은 `useFloat` 를 보고 자기 자리를 비운다.
 *  ★창마다 따로 필요한 층을 함께 건다: 툴팁 · 끌기 어둠과 고스트 · 파일 옮기는 동안의 덮개.
 *  ★옮길 때 다시 마운트된다 (포털 컨테이너가 바뀐다). 패널을 접을 때와 같고 상태는 스토어에 있다. */
export function FloatWindow({ area, title, children }: { area: FloatArea; title: string; children: ReactNode }) {
  const live = useFloat((s) => s.live[area]);
  if (!live) return null;
  return createPortal(
    <WinCtx.Provider value={live.win}>
      <FloatFrame live={live} title={title}>
        {children}
      </FloatFrame>
      <TipLayer />
      <DragLayer />
      <BusyOverlay />
    </WinCtx.Provider>,
    live.root,
  );
}

/** 제목 줄 + 내용. 제목 줄에는 이름 · 최대화 · 닫기뿐이다 (메인에 종속되어 함께 숨으므로 최소화가 없다).
 *  ★맥은 시스템 신호등 버튼을 겹쳐 쓰므로 창 버튼을 안 그리고 왼쪽에 그 자리를 비운다 (`TitleBar` 와 같다) */
function FloatFrame({ live, title, children }: { live: FloatLive; title: string; children: ReactNode }) {
  const t = useI18n((s) => s.t);
  const [maxed, setMaxed] = useState(false);
  /** 맥의 전체 화면 — 신호등 버튼이 숨는다 */
  const [full, setFull] = useState(false);
  const { tw, win, area } = live;

  useEffect(() => {
    win.document.title = `PeroPix · ${title}`;
    void tw.setTitle(`PeroPix · ${title}`).catch(() => {});
  }, [title, tw, win]);

  useEffect(() => {
    let dead = false;
    let un: (() => void) | undefined;
    const read = () => {
      void tw.isMaximized().then((v) => !dead && setMaxed(v)).catch(() => {});
      if (IS_MAC) void tw.isFullscreen().then((v) => !dead && setFull(v)).catch(() => {});
    };
    read();
    void tw.onResized(read).then((off) => (dead ? off() : (un = off)));
    return () => {
      dead = true;
      un?.();
    };
  }, [tw]);

  /** ★눌렀을 때가 아니라 **움직였을 때** 이동을 시작한다. OS 이동 모드는 마우스를 통째로 가져가서, 누르자마자 들어가면
   *    두 번째 누름이 안 와 더블클릭을 못 받는다 (`WindowFrame` 의 ★★★주와 같은 이유). */
  const onDown = (e: ReactMouseEvent<HTMLElement>) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest("button")) return;
    e.preventDefault();
    if (e.detail === 2) {
      void tw.toggleMaximize();
      return;
    }
    /* ★맥은 누를 때 바로 시작한다 (Tauri 의 drag-region 과 같다). 맥의 창 이동은 다음 누름을 막지 않아 더블클릭이 그대로 온다.
         움직인 후에 시작하면 시작이 늦은 만큼 커서가 창에서 미끄러진다 (CI 의 맥 실측: 120 끌어 111 옮겨졌다). */
    if (IS_MAC) {
      void tw.startDragging().catch(() => {});
      return;
    }
    const box = e.currentTarget.getBoundingClientRect();
    const ratioX = box.width ? e.clientX / box.width : 0.5;
    const offsetY = e.clientY - box.top;
    const x0 = e.clientX;
    const y0 = e.clientY;
    const stop = () => {
      win.removeEventListener("mousemove", move, true);
      win.removeEventListener("mouseup", stop, true);
    };
    const move = (m: MouseEvent) => {
      if (Math.abs(m.clientX - x0) < 4 && Math.abs(m.clientY - y0) < 4) return;
      stop();
      // ★최대화된 창은 캡션이 없어 OS 가 복원해 주지 않는다 (`lib/window` 의 `dragFromMaximized`)
      if (maxed) void invoke("drag_restore", { label: tw.label, ratioX, offsetY }).catch(() => {});
      else void tw.startDragging().catch(() => {});
    };
    win.addEventListener("mousemove", move, true);
    win.addEventListener("mouseup", stop, true);
  };

  return (
    <div data-float-window={area} style={{ height: "100%", display: "flex", flexDirection: "column", background: "var(--bg)" }}>
      <header
        data-float-title={area}
        onMouseDown={onDown}
        style={{
          height: 34,
          flexShrink: 0,
          display: "flex",
          alignItems: "center",
          padding: IS_MAC ? `0 var(--sp-4) 0 ${full ? "var(--sp-5)" : "78px"}` : "0 0 0 var(--sp-5)",
          background: "var(--surface)",
          borderBottom: "1px solid var(--line)",
          userSelect: "none",
        }}
      >
        <b style={{ flex: 1, fontSize: "var(--text-xs)", color: "var(--ink-soft)" }}>{title}</b>
        {!IS_MAC && (
          <div style={{ display: "flex", alignSelf: "stretch" }}>
            <WinBtn title={maxed ? t("window.restore") : t("window.maximize")} onClick={() => void tw.toggleMaximize()}>
              {maxed ? Icon.restore : Icon.maximize}
            </WinBtn>
            <WinBtn title={t("float.close")} danger mark={`float-close-${area}`} onClick={() => dockArea(area)}>
              {Icon.close}
            </WinBtn>
          </div>
        )}
      </header>
      {/* ★크게 보기·번역 창처럼 `inset: 0` 으로 덮는 것이 이 칸을 기준으로 잡히게 `relative` 를 준다 */}
      <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column", position: "relative" }}>{children}</div>
    </div>
  );
}

/** 마지막으로 포커스된 창에 그린다 — 확인 창·토스트처럼 **방금 조작한 곳에서 봐야 하는 것**.
 *  ★메인에 띄우면 사용자가 옆 모니터의 새 창을 보고 있을 때 눈에 안 들어온다.
 *  ★`hold` 가 켜진 동안은 창을 옮기지 않는다. 옮기면 다시 마운트되어 안에서 잡아 둔 값이 사라진다. */
export function OnActiveWindow({ hold, children }: { hold?: boolean; children: ReactNode }) {
  const active = useFloat((s) => s.active);
  const held = useRef(active);
  if (!hold) held.current = active;
  const live = useFloat((s) => (held.current === "main" ? undefined : s.live[held.current]));
  if (!live) return <>{children}</>;
  return createPortal(<WinCtx.Provider value={live.win}>{children}</WinCtx.Provider>, live.root);
}

/** 「새 창으로 분리」 */
export function SplitButton({ area, style }: { area: FloatArea; style?: CSSProperties }) {
  const t = useI18n((s) => s.t);
  if (!FLOAT_OK) return null;
  return (
    <button data-float-split={area} data-tip={t("float.split")} onClick={() => {
        void splitArea(area);
        // ★갤러리는 모드 하나를 통째로 쓰므로 나가면 메인은 앞서 보던 모드로 돌아간다
        if (area === "gallery") useUi.getState().leaveGallery();
      }} style={style}>
      {Icon.popOut}
    </button>
  );
}
