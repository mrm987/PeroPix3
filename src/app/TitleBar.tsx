import { useI18n } from "../i18n";
import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import { Icon } from "../components/Icon";
import { appWindow } from "../lib/window";
import { useWs } from "../store/workspace";
import { useHealth } from "../store/health";
import { IS_MAC } from "../lib/platform";

/** 커스텀 타이틀바 — 시스템 타이틀바를 끄고(`decorations: false`) 그 기능을 전부 대신한다.
 *
 *  - 빈 영역 드래그 = 창 이동          (`data-tauri-drag-region`)
 *  - 빈 영역 더블클릭 = 최대화 토글    (드래그 영역이 자동 처리)
 *  - ★최대화 상태에서 끌면 복원 + 이어서 이동 — 이것만은 우리가 한다 (`appWindow.dragFromMaximized`,
 *    사용자 제보 2026-09-07: 캡션 스타일이 없는 창이라 윈도우가 안 해 준다). 최대화 상태에서는
 *    `mousedown` 을 여기서 받아 Tauri 의 드래그 스크립트에 넘기지 않고, 실제로 몇 px 끌었을 때만
 *    복원한다 — 누르자마자 복원하면 더블클릭(복원 토글)이 「복원 → 다시 최대화」로 어긋난다.
 *  - 최소화 / 최대화·복원 / 닫기 버튼
 *  - 최대화 상태에 따라 아이콘이 바뀐다
 *
 *  창 가장자리 리사이즈는 `WindowFrame` 이 담당한다.
 *
 *  ★★맥은 시스템 제목 표시줄을 화면 위에 겹쳐 쓴다 (`tauri.macos.conf.json` 의 `titleBarStyle: "Overlay"`).
 *    신호등 버튼·크기 조절·전체 화면은 macOS 가 맡으므로 우리 창 버튼을 안 그리고, 왼쪽에 신호등 자리를 비운다.
 *    끌기는 그대로 `data-tauri-drag-region` 이다 (맥은 최대화된 창도 그냥 끌린다). */
export function TitleBar({ left, right }: { left?: ReactNode; right?: ReactNode }) {
  const t = useI18n((s) => s.t);
  const version = useHealth((s) => s.health?.version ?? "");
  const [maxed, setMaxed] = useState(false);
  /** 맥의 전체 화면 — 신호등 버튼이 숨는다 */
  const [full, setFull] = useState(false);

  useEffect(() => {
    let un: (() => void) | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    (async () => {
      setMaxed(await appWindow.isMaximized());
      /* ★★크기 변경 사건이 올 때 `isMaximized()` 가 **아직 false** 인 때가 있다 (실측 2026-09-07: 더블클릭
         최대화 뒤 제목줄을 눌렀는데 `maxed=false` 로 찍혔다). 그 뒤로 사건이 다시 안 오므로 잠깐 뒤 한 번
         더 묻는다. 누르는 순간의 판정은 아래 `isMaximizedNow` 가 창 크기로도 본다. */
      un = await appWindow.onResized(async () => {
        setMaxed(await appWindow.isMaximized());
        if (IS_MAC) setFull(await appWindow.isFullscreen());
        clearTimeout(timer);
        timer = setTimeout(async () => setMaxed(await appWindow.isMaximized()), 250);
      });
    })();
    return () => {
      un?.();
      clearTimeout(timer);
    };
  }, []);
  const maxedRef = useRef(false);
  maxedRef.current = maxed;
  /** 누르는 순간의 동기 판정 — 스토어 값이 늦어도 창 크기로 본다. **세로만 늘린 창**(위·아래 테두리
   *  더블클릭)도 끌면 되돌릴 대상이다 (실측 2026-09-07) — 높이가 작업 영역을 꽉 채웠으면 그렇다. */
  const isMaximizedNow = () =>
    maxedRef.current ||
    appWindow.isVFitted() ||
    (window.innerWidth >= window.screen.availWidth - 1 && window.innerHeight >= window.screen.availHeight - 1) ||
    window.innerHeight >= window.screen.availHeight - 1;

  /** 최대화 상태의 제목줄 누름 — 드래그 영역이 아닌 곳(단추·글)은 그대로 둔다 */
  const onDragDown = (e: ReactMouseEvent<HTMLElement>) => {
    if (IS_MAC || e.button !== 0 || !isMaximizedNow()) return;
    const el = e.target as HTMLElement | null;
    if (!el?.hasAttribute?.("data-tauri-drag-region")) return;
    /* ★Tauri 가 주입한 스크립트(document 의 mousedown)는 이 창에서 죽은 드래그를 시작하므로 막는다 */
    e.stopPropagation();
    e.preventDefault();
    if (e.detail === 2) {
      void appWindow.toggleMaximize();
      return;
    }
    const header = e.currentTarget.getBoundingClientRect();
    const ratioX = header.width ? e.clientX / header.width : 0.5;
    const offsetY = e.clientY - header.top;
    const x0 = e.clientX;
    const y0 = e.clientY;
    const move = (m: MouseEvent) => {
      if (Math.abs(m.clientX - x0) < 4 && Math.abs(m.clientY - y0) < 4) return;
      stop();
      void appWindow.dragFromMaximized({ screenX: m.screenX, screenY: m.screenY, ratioX, offsetY });
    };
    const stop = () => {
      window.removeEventListener("mousemove", move, true);
      window.removeEventListener("mouseup", stop, true);
    };
    window.addEventListener("mousemove", move, true);
    window.addEventListener("mouseup", stop, true);
  };

  return (
    <header
      data-tauri-drag-region
      onMouseDown={onDragDown}
      style={{
        height: 34,
        flexShrink: 0,
        display: "flex",
        alignItems: "center",
        gap: "var(--sp-4)",
        // ★맥 — 왼쪽은 신호등 버튼 자리 (전체 화면에서는 숨으므로 비우지 않는다), 오른쪽은 창 버튼이 없으니 여백
        padding: IS_MAC ? `0 var(--sp-4) 0 ${full ? "var(--sp-5)" : "78px"}` : "0 0 0 var(--sp-5)",
        background: "var(--surface)",
        borderBottom: "1px solid var(--line)",
        userSelect: "none",
      }}
    >
      <b data-tauri-drag-region style={{ fontSize: "var(--text-md)", letterSpacing: "-0.01em" }}>
        Pero<span style={{ color: "var(--accent-ink)" }}>Pix</span>
      </b>
      {/* ★버전을 여기 박아 두지 않는다 — 백엔드의 `APP_VERSION` 이 정본이다 (감사 C5).
          아직 안 붙었으면 아무것도 안 쓴다: 틀린 숫자보다 빈 자리가 낫다 */}
      <span data-app-version data-tauri-drag-region style={{ fontSize: "var(--text-2xs)", color: "var(--ink-dim)" }}>
        {version}
      </span>
      <Crumb />
      {left}

      {/* 가운데 빈 공간이 드래그 영역이다 */}
      <span data-tauri-drag-region style={{ flex: 1, alignSelf: "stretch" }} />

      {right}

      {!IS_MAC && <div style={{ display: "flex", alignSelf: "stretch" }}>
        <WinBtn title={t("window.minimize")} onClick={() => appWindow.minimize()}>
          {Icon.minimize}
        </WinBtn>
        <WinBtn
          title={maxed ? t("window.restore") : t("window.maximize")}
          onClick={() => appWindow.toggleMaximize()}
        >
          {maxed ? Icon.restore : Icon.maximize}
        </WinBtn>
        <WinBtn title={t("window.close")} danger onClick={() => appWindow.close()}>
          {Icon.close}
        </WinBtn>
      </div>}
    </header>
  );
}

/** 지금 워크스페이스 이름.
 *
 *  ★예전엔 앞에 「워크스페이스 ›」 뒤로가기가 있었는데, 첫 화면을 없애면서 **갈 데가
 *    사라졌다** (사용자 지시 2026-08-08). 고르는 창구는 탭 줄의 「+」 하나다.
 *  ★이름만 남기는 이유: 탭 줄은 자동검열·보조 도구에서 감춰지므로, 거기서도 어느
 *    워크스페이스에 붙어 있는지는 여기서 보인다. */
function Crumb() {
  const current = useWs((s) => s.current);
  if (!current) return null;
  return (
    <b
      data-ws-crumb
      data-tauri-drag-region
      style={{ fontSize: "var(--text-2xs)", fontWeight: "var(--w-semi)", color: "var(--ink-dim)" }}
    >
      {current}
    </b>
  );
}

function WinBtn({
  children,
  onClick,
  title,
  danger,
}: {
  children: ReactNode;
  onClick: () => void;
  title: string;
  danger?: boolean;
}) {
  const [hover, setHover] = useState(false);
  return (
    <button
      data-tip={title}
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        width: 46,
        alignSelf: "stretch",
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        color: hover && danger ? "#fff" : "var(--ink-soft)",
        background: hover ? (danger ? "#c4443c" : "var(--surface2)") : "transparent",
        transition: "background 0.12s, color 0.12s",
      }}
    >
      {children}
    </button>
  );
}
