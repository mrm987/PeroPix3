import { useEffect, useRef, useState, type ReactNode } from "react";
import { appWindow, type ResizeDir } from "../lib/window";

/** 창 가장자리 리사이즈 손잡이.
 *
 *  `decorations: false` 로 두면 OS 의 리사이즈 테두리가 사라지므로 직접 만든다.
 *  최대화 상태에서는 손잡이를 숨긴다 (그 상태에서 끌면 창이 어정쩡하게 복원된다).
 *
 *  ★★**가장자리의 주인은 이 손잡이 하나다** (사용자 지적 2026-08-28: *"커서 판정이랑
 *    더블클릭이 먹는 기준이 동일해야 하는데 그 불일치가 문제"*). Tauri 는 테두리 없는 창에
 *    투명 덧창(`TAURI_DRAG_RESIZE_BORDERS`)을 따로 깔아 안쪽 4px 을 제 것으로 삼는데, 거기서는
 *    커서만 바뀌고 화면은 누름을 못 본다 — 그래서 손잡이의 위쪽 절반이 죽어 있었다. 껍데기가
 *    부팅 때 그 덧창을 걷는다 (`src-tauri/src/window_edge.rs`). 이제 커서를 바꾸는 요소와
 *    누름·더블클릭을 받는 요소가 같은 것이라 어긋날 자리가 없다. */
/** 가장자리 두께. ★★손잡이는 창의 **첫 픽셀 줄부터** 선다 — 한때 「보이지 않는 OS 테두리」를
 *  셈해 4px 안쪽으로 물렸는데, 그 겹은 없었다(DWM 실측 0). 물린 만큼 맨 윗줄에 손잡이가
 *  없는 상태를 우리가 만들었던 것이라 되돌렸다. */
const EDGE = 8;
const CORNER = 16; // 모서리 판정 크기

export function WindowFrame({ children }: { children: ReactNode }) {
  const [maxed, setMaxed] = useState(false);

  useEffect(() => {
    /* ★★**정리가 먼저 돌아도 구독이 남지 않게** 한다 (조사 2026-08-28).
       `un` 은 비동기 안에서 대입되는데, 리액트의 StrictMode 는 마운트 직후 한 번 정리를
       돌린다 — 그때 `un` 은 아직 `undefined` 라 **첫 구독이 영영 안 풀렸다.** 크기 한 번에
       `noteHeight` 가 두 벌 돌고, 그 비동기 왕복이 서로 덮어써 상태가 거꾸로 잡혔다.
       ★표식(`dead`)을 두어, 늦게 온 구독도 그 자리에서 스스로 풀게 한다. */
    let dead = false;
    let un: (() => void) | undefined;
    let t: ReturnType<typeof setTimeout> | undefined;
    (async () => {
      setMaxed(await appWindow.isMaximized());
      /* ★★**켤 때 한 번 적어 둔다** (2026-09-14). 크기 사건이 오기 전까지는 「최대화 전 크기」를
         모르는데, 앱을 켜자마자 최대화하면 그 판에서는 **되돌릴 크기가 없는 채로** 지나간다.
         부팅 직후의 창 크기가 곧 그 값이므로 여기서 한 번 재어 둔다 (`lib/window` 의 `lastNormal`). */
      void appWindow.noteHeight();
      const off = await appWindow.onResized(async () => {
        setMaxed(await appWindow.isMaximized());
        /* ★★**크기가 멎으면 그 자리를 적어 둔다** (`lib/window` 의 `noteHeight`).
           안 적어 두면 창이 이미 꽉 찬 높이일 때 더블클릭이 되돌릴 자리를 못 찾아
           **아무 일도 안 한다.** ★끄는 동안 수십 번 오므로 멎은 뒤에 한 번만 부른다. */
        clearTimeout(t);
        t = setTimeout(() => void appWindow.noteHeight(), 300);
      });
      if (dead) off();          // ★이미 정리가 지나갔으면 그 자리에서 푼다
      else un = off;
    })();
    return () => {
      dead = true;
      clearTimeout(t);
      un?.();
    };
  }, []);

  return (
    /* ★★창 둘레 1px 경계선 (사용자 지시 2026-08-29: *"테두리 없으니까 다른 화면이랑 경계선
         구분이 안 되어서 불편해"*). `decorations: false` 라 OS 가 아무 선도 안 그려 주는데,
         바탕색이 비슷한 창과 겹치면 어디까지가 이 앱인지 안 보였다.
       ★최대화에서는 안 그린다 — 모니터 경계가 곧 창 경계라 선이 소음이다.
       ★`border-box` 로 안쪽에 그린다 — 밖에 그리면 창 크기를 1px 넘어 잘린다. */
    <div
      style={{
        position: "relative",
        width: "100%",
        height: "100%",
        overflow: "hidden",
        boxSizing: "border-box",
        border: maxed ? undefined : "1px solid var(--line-strong)",
      }}
    >
      {children}
      {!maxed && <ResizeHandles />}
    </div>
  );
}

/** 더블클릭으로 치는 간격 — 윈도우 기본값과 같은 500ms */
const DBL_MS = 500;
/** 이만큼 움직여야 「끄는 것」으로 본다.
 *  ★★**5px 이다** (조사 2026-08-28). 3px 은 윈도우 자신의 더블클릭 허용 오차(`SM_CXDOUBLECLK`,
 *    4px)보다 **빡빡해서**, 더블클릭의 첫 누름에서 손이 조금만 흔들려도 OS 크기 조절이
 *    시작되고 **두 번째 누름을 그쪽이 통째로 가져간다.** 8px 띠를 조준하는 동작이라 그
 *    흔들림이 특히 잦다. */
const DRAG_PX = 5;

function ResizeHandles() {
  /** ★★**더블클릭을 여기서 직접 센다** (`onDoubleClick` 을 안 쓴다).
   *  OS 크기 조절이 시작되면 포인터가 그쪽으로 넘어가, 브라우저의 더블클릭 판정이 그 뒤까지
   *  이어진다는 보장이 없다. 누른 자리와 시각만 보면 어긋날 일이 없다. */
  const last = useRef({ dir: "", at: 0 });

  const grab = (dir: ResizeDir) => (e: React.MouseEvent) => {
    // 좌클릭만. 이벤트가 아래로 새면 창 이동과 겹친다.
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();

    /* ★★위·아래 테두리를 두 번 누르면 **세로로만 화면 끝까지** (`lib/window` 의 ★★주).
       좌우에는 윈도우도 같은 기능을 주지 않으므로 여기서도 없다. */
    const now = performance.now();
    const dbl = last.current.dir === dir && now - last.current.at < DBL_MS;
    last.current = { dir, at: dbl ? 0 : now };
    if (dbl) {
      if (dir === "North" || dir === "South") appWindow.fitVertical();
      return;
    }

    /* ★★★**누르는 것만으로는 크기 조절을 시작하지 않는다 — 움직여야 시작한다**
       (사용자 지적 2026-08-28: *"엄청 많이 시도했는데 중간에 딱 한 번 되고 그 외에는 다 안 됨"*).
       앞 판은 첫 누름에서 곧장 `startResizeDragging` 을 불렀다. 그러면 **OS 가 크기 조절
       모드로 들어가 마우스를 통째로 가져가서**, 두 번째 누름이 우리에게 오지 않거나 뗀
       자취가 끊긴다. 그래서 더블클릭이 열 번에 한 번쯤만 잡혔다.
       문턱을 두면 **두 번 누르는 동안에는 OS 모드에 아예 안 들어가므로** 두 누름이 다
       우리에게 온다. OS 는 크기 조절을 시작할 때 그 변을 커서에 맞추므로, 몇 px 늦게
       시작해도 눈에 띄는 차이가 없다. */
    const x0 = e.clientX;
    const y0 = e.clientY;
    const stop = () => {
      document.removeEventListener("mousemove", move, true);
      document.removeEventListener("mouseup", stop, true);
    };
    function move(m: MouseEvent) {
      if (Math.abs(m.clientX - x0) < DRAG_PX && Math.abs(m.clientY - y0) < DRAG_PX) return;
      stop();
      void (async () => {
        // ★세로로 늘려 둔 창을 손으로 다시 조절하면 **반대쪽 변이 원래 자리로** 돌아간다
        if (dir === "North" || dir === "South") await appWindow.unfitFor(dir);
        appWindow.startResize(dir);
      })();
    }
    document.addEventListener("mousemove", move, true);
    document.addEventListener("mouseup", stop, true);
  };

  const base: React.CSSProperties = { position: "absolute", zIndex: 999 };

  return (
    <>
      {/* 변 */}
      <div
        onMouseDown={grab("North")}
        data-resize-edge="North"
        style={{ ...base, top: 0, left: CORNER, right: CORNER, height: EDGE, cursor: "ns-resize" }}
      />
      <div
        onMouseDown={grab("South")}
        data-resize-edge="South"
        style={{ ...base, bottom: 0, left: CORNER, right: CORNER, height: EDGE, cursor: "ns-resize" }}
      />
      <div
        onMouseDown={grab("West")}
        data-resize-edge="West"
        style={{ ...base, left: 0, top: CORNER, bottom: CORNER, width: EDGE, cursor: "ew-resize" }}
      />
      <div
        onMouseDown={grab("East")}
        data-resize-edge="East"
        style={{ ...base, right: 0, top: CORNER, bottom: CORNER, width: EDGE, cursor: "ew-resize" }}
      />
      {/* 모서리 */}
      <div
        onMouseDown={grab("NorthWest")}
        data-resize-edge="NorthWest"
        style={{ ...base, top: 0, left: 0, width: CORNER, height: CORNER, cursor: "nwse-resize" }}
      />
      <div
        onMouseDown={grab("NorthEast")}
        data-resize-edge="NorthEast"
        style={{ ...base, top: 0, right: 0, width: CORNER, height: CORNER, cursor: "nesw-resize" }}
      />
      <div
        onMouseDown={grab("SouthWest")}
        data-resize-edge="SouthWest"
        style={{ ...base, bottom: 0, left: 0, width: CORNER, height: CORNER, cursor: "nesw-resize" }}
      />
      <div
        onMouseDown={grab("SouthEast")}
        data-resize-edge="SouthEast"
        style={{ ...base, bottom: 0, right: 0, width: CORNER, height: CORNER, cursor: "nwse-resize" }}
      />
    </>
  );
}
