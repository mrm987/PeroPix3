import { useI18n } from "../i18n";
import { useEffect, useState, type ReactNode } from "react";
import { Icon } from "../components/Icon";
import { appWindow } from "../lib/window";
import { useWs } from "../store/workspace";
import { useHealth } from "../store/health";

/** 커스텀 타이틀바 — 시스템 타이틀바를 끄고(`decorations: false`) 그 기능을 전부 대신한다.
 *
 *  - 빈 영역 드래그 = 창 이동          (`data-tauri-drag-region`)
 *  - 빈 영역 더블클릭 = 최대화 토글    (드래그 영역이 자동 처리)
 *  - 최소화 / 최대화·복원 / 닫기 버튼
 *  - 최대화 상태에 따라 아이콘이 바뀐다
 *
 *  창 가장자리 리사이즈는 `WindowFrame` 이 담당한다. */
export function TitleBar({ left, right }: { left?: ReactNode; right?: ReactNode }) {
  const t = useI18n((s) => s.t);
  const version = useHealth((s) => s.health?.version ?? "");
  const [maxed, setMaxed] = useState(false);

  useEffect(() => {
    let un: (() => void) | undefined;
    (async () => {
      setMaxed(await appWindow.isMaximized());
      un = await appWindow.onResized(async () => setMaxed(await appWindow.isMaximized()));
    })();
    return () => un?.();
  }, []);

  return (
    <header
      data-tauri-drag-region
      style={{
        height: 34,
        flexShrink: 0,
        display: "flex",
        alignItems: "center",
        gap: "var(--sp-4)",
        padding: "0 0 0 var(--sp-5)",
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

      <div style={{ display: "flex", alignSelf: "stretch" }}>
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
      </div>
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
