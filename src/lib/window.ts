/** 창 제어 래퍼.
 *
 *  시스템 타이틀바를 끄면(`decorations: false`) OS 가 주던 것들이 함께 사라진다:
 *  이동·더블클릭 최대화·최소화/최대화/닫기 버튼·가장자리 리사이즈.
 *  전부 여기서 다시 제공한다.
 *
 *  브라우저(vite dev)에서 열었을 땐 Tauri 가 없으므로 조용히 무시한다. */

import { logLine } from "./report";

export type ResizeDir =
  | "North"
  | "NorthEast"
  | "East"
  | "SouthEast"
  | "South"
  | "SouthWest"
  | "West"
  | "NorthWest";

/** 세로로 늘리기 전의 자리 — 두 번째 더블클릭이 여기로 되돌린다 */
let vFitBack: { y: number; h: number } | null = null;
/** ★지금 세로로 늘려 둔 상태인가 — **묻지 않고 아는** 값이다.
 *  가장자리를 끌 때마다 창·모니터를 조회하면(왕복 셋) 크기 조절이 그만큼 늦게 시작한다.
 *  늘려 둔 상태가 아니면 되돌릴 것도 없으므로, 그때는 아무것도 묻지 않고 지나간다. */
let vFitted = false;

async function win() {
  try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    return getCurrentWindow();
  } catch {
    return null;
  }
}

export const appWindow = {
  async minimize() {
    (await win())?.minimize();
  },
  async toggleMaximize() {
    (await win())?.toggleMaximize();
  },
  async close() {
    (await win())?.close();
  },
  /** 창 제목 — 화면에는 안 보이지만 **작업 표시줄과 Alt+Tab** 에 뜬다.
   *  큐 완료 알림이 이걸 쓴다 (`lib/titleNotify.ts`). */
  async setTitle(title: string) {
    (await win())?.setTitle(title);
  },
  async isMaximized(): Promise<boolean> {
    const w = await win();
    return w ? await w.isMaximized() : false;
  },
  async startResize(dir: ResizeDir) {
    (await win())?.startResizeDragging(dir as never);
  },
  /** ★★**최대화 상태에서 제목줄을 끌면 복원하고 그대로 끌린다** (사용자 제보 2026-09-07).
   *
   *  왜 안 됐나: `decorations: false` 라 tao 가 창에서 캡션 스타일(WS_CAPTION)을 떼어 낸다. 윈도우가
   *  「최대화된 창의 제목줄을 끌면 복원」을 해 주는 것은 **진짜 캡션이 있는 창**뿐이고, Tauri 의
   *  `startDragging` 은 `WM_NCLBUTTONDOWN(HTCAPTION)` 을 흉내 내는 가짜 메시지라 최대화된 창에서는
   *  아무 일도 안 한다 (tao `drag_window`). Electron 은 캡션 스타일을 남겨 두어 공짜로 되던 동작이다.
   *  ★그래서 우리가 한다: 커서가 제목줄에서 차지하던 **가로 비율**을 기억 → 복원 → 복원된 창 너비에
   *    그 비율을 곱한 만큼 커서 왼쪽에 오도록 창을 옮김 → 드래그 시작. 커서 아래 그 자리를 잡은 채로
   *    끌리므로 윈도우 기본 동작과 같아 보인다.
   *  ★좌표는 **논리 픽셀**로 맞춘다 — 브라우저의 `screenX` 도 논리 좌표라 배율을 따로 곱지 않는다.
   *  ★권한: unmaximize · set-position · start-dragging (`capabilities/default.json`, 이미 있다). */
  async dragFromMaximized(cursor: { screenX: number; screenY: number; ratioX: number; offsetY: number }) {
    try {
      const w = await win();
      if (!w) return;
      const { LogicalPosition, PhysicalPosition, PhysicalSize } = await import("@tauri-apps/api/dpi");
      const scale = await w.scaleFactor();
      if (await w.isMaximized()) {
        /* ★★**껍데기가 한 번에 한다** (사용자 지적 2026-09-07: *"커서랑 헤더가 잠깐 불일치했다가 돌아와서
           튀듯이 움직임"*). `unmaximize → setPosition → startDragging` 은 IPC 세 번 사이에 창이 옛 자리에
           복원된 채 보였다. `drag_restore` 는 복원 사각형을 커서 아래로 잡아 복원과 끌기 시작을 한 호출로
           한다 (`src-tauri/src/window_edge.rs`). 그쪽이 실패하면 예전 길로. */
        try {
          const { invoke } = await import("@tauri-apps/api/core");
          await invoke("drag_restore", { ratioX: cursor.ratioX, offsetY: cursor.offsetY });
          return;
        } catch (e) {
          logLine("warn", "창", `drag_restore 실패 — 화면 쪽으로 되돌림: ${String(e)}`);
        }
        await w.unmaximize();
        const size = await w.outerSize();
        const width = size.width / scale;
        await w.setPosition(new LogicalPosition(cursor.screenX - cursor.ratioX * width, cursor.screenY - cursor.offsetY));
      } else if (vFitted && vFitBack) {
        /* ★★**세로 최대화**(위·아래 테두리 더블클릭, `fitVertical`)도 같은 몸짓으로 되돌린다 (실측 2026-09-07:
           사용자가 「더블클릭 확장」이라 부른 것이 이쪽이었다 — 로그의 창 크기가 1440×1400, 너비는 그대로).
           윈도우도 세로 최대화 창의 제목줄을 끌면 원래 높이로 되돌린다. 너비는 안 바뀌므로 x 는 그대로 두고,
           제목줄이 커서 아래에 남도록 y 만 맞춘다. 되돌릴 높이는 `fitVertical` 이 적어 둔 것이다. */
        const pos = await w.outerPosition();
        const size = await w.outerSize();
        const back = vFitBack;
        vFitted = false;
        await w.setSize(new PhysicalSize(size.width, back.h));
        await w.setPosition(new PhysicalPosition(pos.x, Math.round((cursor.screenY - cursor.offsetY) * scale)));
      }
      await w.startDragging();
    } catch (e) {
      console.error("[window] 끌어 복원하지 못했습니다:", e);
      logLine("error", "창", `dragFromMaximized 실패: ${String(e)}`);
    }
  },
  /** 세로로 늘려 둔 상태인가 — 제목줄의 동기 판정에 쓴다 (`fitVertical` 이 적는 값) */
  isVFitted(): boolean {
    return vFitted;
  },
  /** ★★**위·아래 테두리 더블클릭 = 세로로만 화면 끝까지** (사용자 지적 2026-08-28:
   *  *"윈도우 앱들은 다 기본으로 되는데 우린 안 된다"*).
   *
   *  시스템 타이틀바를 끄면 창에 **비클라이언트 영역이 없어져**, 윈도우가 그 자리에서
   *  해 주던 일(`WM_NCLBUTTONDBLCLK` → 세로 최대화)이 통째로 사라진다. 가장자리 손잡이를
   *  우리가 그린 것처럼 이것도 우리가 해야 한다.
   *  ★껍데기에 맡길 수도 없다 — tao 의 창 클래스에 `CS_DBLCLKS` 가 없어 창틀 더블클릭
   *    메시지가 **애초에 만들어지지 않는다** (소스 확인 2026-08-28). 더블클릭은 화면이 센다.
   *  ★**세로뿐이다.** 윈도우가 이 동작을 주는 것은 위·아래 테두리이고, 좌우 테두리에는
   *    같은 기능이 없다 (MS 문서·Windows 11 설정 항목 「세로로 창 최대화」).
   *  ★작업 표시줄을 덮지 않도록 **작업 영역**(`workArea`)까지만 늘린다.
   *  ★한 번 더 하면 되돌린다 — 윈도우도 그렇다.
   *
   *  ★★**창을 옮기고 늘리는 데에는 권한이 따로 필요하다** (사용자 지적 2026-08-28: *"안 되는데?"*).
   *    `core:default` 에 든 것은 **읽는 것뿐**이다 (`outerPosition`·`outerSize`·`currentMonitor`).
   *    쓰는 둘(`set-position`·`set-size`)은 `src-tauri/capabilities/default.json` 에 직접
   *    적어야 하고, 없으면 호출이 **조용히 거부되어 아무 일도 안 일어난다.**
   *    ★그래서 아래에서 잡아 콘솔에 남긴다. 배선은 `lib/windowPerms.test.ts` 가 지킨다. */
  async fitVertical() {
    try {
      const w = await win();
      if (!w) return;
      const { currentMonitor } = await import("@tauri-apps/api/window");
      const { PhysicalPosition, PhysicalSize } = await import("@tauri-apps/api/dpi");
      const m = await currentMonitor();
      if (!m) return;
      const pos = await w.outerPosition();
      const size = await w.outerSize();
      const wa = m.workArea;
      // ★두 값 다 물리 픽셀이라 그대로 견준다 (화면 배율을 거치지 않는다)
      const full =
        Math.abs(pos.y - wa.position.y) <= 2 && Math.abs(size.height - wa.size.height) <= 2;
      if (full) {
        const back = vFitBack;
        if (!back) {
          logLine("warn", "창세로", "이미 꽉 찼는데 되돌릴 자리가 없어 아무 일도 안 함");
          return;
        }
        /* ★★**되돌릴 자리를 비우지 않는다** (조사 2026-08-28). 비운 직후 창이 다시 꽉 차면
           (위 변을 화면 끝까지 끌면 윈도우가 스스로 세로 최대화를 건다) `noteHeight` 는
           꽉 찬 상태에서 아무것도 안 적으므로 **「늘어났는데 되돌릴 자리는 없음」으로 굳는다.**
           그 상태는 스스로 빠져나올 길이 없어 그 뒤로 더블클릭도 복원도 영영 안 된다.
           적는 것은 `noteHeight` 하나에 맡기고, 여기서는 상태만 내린다. */
        vFitted = false;
        await w.setPosition(new PhysicalPosition(pos.x, back.y));
        await w.setSize(new PhysicalSize(size.width, back.h));
        return;
      }
      vFitBack = { y: pos.y, h: size.height };
      vFitted = true;
      await w.setPosition(new PhysicalPosition(pos.x, wa.position.y));
      await w.setSize(new PhysicalSize(size.width, wa.size.height));
    } catch (e) {
      // ★거부되면 **조용히** 아무 일도 안 일어난다 — 그래서 까닭을 남긴다 (위 ★★주)
      logLine("error", "창세로", `실패 — capabilities 의 창 조작 권한을 본다: ${String(e)}`);
      console.error("[window] 세로 최대화 실패", e);
    }
  },
  /** ★★**늘리기 전 자리는 늘 갱신해 둔다** — 크기가 바뀔 때마다 부른다.
   *
   *  예전에는 `fitVertical` 이 늘리는 그 순간에만 적어 뒀다. 그래서 **창이 이미 꽉 찬
   *  높이일 때**(손으로 그렇게 맞춰 뒀거나, 윈도우가 위쪽 가장자리로 끌어 붙여 놨을 때)
   *  되돌릴 자리가 없어 **더블클릭이 아무 일도 안 했다.** 눈에는 「안 먹는다」로만 보인다.
   *  ★꽉 찬 상태에서는 적지 않는다 — 그것을 적으면 되돌릴 자리가 곧 지금 자리가 된다. */
  async noteHeight() {
    try {
      const w = await win();
      if (!w) return;
      /* ★★★**최소화된 동안에는 적지 않는다** (사용자 제보 2026-09-14: *"상하 최대화를 해놓고
         다른 작업을 한참 하다가 다시 돌아가서 상단부를 줄여서 원래 크기로 되돌리려고 하면,
         헤드 타이틀바만 보이는 크기로 극단적으로 줄어든다"*).
         게스트 실측: **최소화하면 크기 사건이 한 번 오고, 그때 창은 `{y: -32000, h: 28}` 을
         보고한다.** 작업 영역 위와 다르므로 `full` 이 거짓이 되어 그 값이 그대로 「되돌릴
         자리」로 적혔다. 그 뒤에 되돌리면 높이가 **28px** 이 되고(제목줄 끌기,
         `dragFromMaximized`), 테두리 더블클릭으로 되돌릴 때는 y 가 -32000 이라 **창이 화면
         밖으로** 간다 (`fitVertical`). 재현·회귀는 `qa/test-winsize-real.mjs`.
         ★좌표가 얼마나 이상한지로 거르지 않는다 — **상태로** 가른다. 「얼마나 작으면 가짜인가」를
           새로 정하는 순간 기준이 하나 더 생기고, 진짜로 작게 줄인 창까지 안 적히게 된다. */
      if (await w.isMinimized()) return;
      const { currentMonitor } = await import("@tauri-apps/api/window");
      const m = await currentMonitor();
      if (!m) return;
      const pos = await w.outerPosition();
      const size = await w.outerSize();
      const wa = m.workArea;
      const full =
        Math.abs(pos.y - wa.position.y) <= 2 && Math.abs(size.height - wa.size.height) <= 2;
      vFitted = full;
      if (!full) vFitBack = { y: pos.y, h: size.height };
    } catch {
      /* 자리를 못 적어도 하던 일에는 지장이 없다 */
    }
  },
  /** ★★**손으로 크기를 조절하면 세로 최대화가 풀린다** (사용자 지적 2026-08-28:
   *  *"확장됐을 때 수동으로 크기 줄이면 원래 아래 부분이 기존 위치로 돌아가는데, 이건
   *  안 돌아감"*).
   *
   *  세로로 늘린 상태에서 한쪽 변을 잡아 끌면, **반대쪽 변은 늘리기 전 자리로** 돌아가야
   *  한다 — 늘린 것은 「잠깐 맞춰 둔 상태」이지 그 창의 크기가 아니기 때문이다.
   *  ★위 변을 끌면 아래 변을, 아래 변을 끌면 위 변을 되돌린다.
   *  ★크기 조절을 **시작하기 직전에** 부른다. 되돌린 뒤 OS 가 그 변을 커서에 맞춘다.
   *  ★늘려 둔 상태가 아니면 아무 일도 안 한다. */
  async unfitFor(dir: "North" | "South") {
    // ★늘려 둔 상태가 아니면 **묻지도 않고** 지나간다 (위 `vFitted` 주석) — 끌기가 늦어진다
    if (!vFitted) return;
    try {
      const w = await win();
      const back = vFitBack;
      if (!w || !back) return;
      const { currentMonitor } = await import("@tauri-apps/api/window");
      const { PhysicalPosition, PhysicalSize } = await import("@tauri-apps/api/dpi");
      const m = await currentMonitor();
      if (!m) return;
      const pos = await w.outerPosition();
      const size = await w.outerSize();
      const wa = m.workArea;
      const fitted =
        Math.abs(pos.y - wa.position.y) <= 2 && Math.abs(size.height - wa.size.height) <= 2;
      if (!fitted) return;
      // ★되돌릴 자리는 비우지 않는다 (바로 위 ★★주) — 적는 것은 `noteHeight` 하나다
      vFitted = false;
      if (dir === "North") {
        // 아래 변을 원래 자리로 — 위 변은 지금 자리에 둔 채 높이만 줄인다
        const h = back.y + back.h - pos.y;
        if (h > 0) await w.setSize(new PhysicalSize(size.width, h));
      } else {
        // 위 변을 원래 자리로 — 아래 변은 지금 자리를 지킨다
        const h = pos.y + size.height - back.y;
        if (h > 0) {
          await w.setPosition(new PhysicalPosition(pos.x, back.y));
          await w.setSize(new PhysicalSize(size.width, h));
        }
      }
    } catch (e) {
      console.error("[window] 세로 최대화 풀기 실패", e);
    }
  },
  /** 최대화 상태가 바뀔 때마다 콜백. 정리 함수를 돌려준다. */
  async onResized(cb: () => void): Promise<() => void> {
    const w = await win();
    if (!w) return () => {};
    const un = await w.onResized(cb);
    return un;
  },
};
