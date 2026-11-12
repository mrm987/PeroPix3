import { Component, Fragment, type ReactNode } from "react";
import { useI18n } from "../i18n";
import { logError } from "../lib/report";
import { usePreviews } from "../store/previews";
import { TitleBar } from "./TitleBar";
import { WindowFrame } from "./WindowFrame";

/** 화면 전체를 감싸는 오류 경계.
 *
 *  ★★경계가 없으면 렌더 중의 오류 하나로 React 가 화면 전체를 내리고 창 바탕색만 남는다
 *    (제보 2026-11-12, React #185). 사용자는 새로고침할 수밖에 없고, 그러면 **메모리에만 있는
 *    미저장 그림**(`store/previews`)이 사라진다.
 *  ★「화면 다시 그리기」는 새로고침이 아니다. 앱을 다시 마운트할 뿐이라 스토어(미저장 그림 · 큐 ·
 *    분리 창)는 그대로 남는다. 다시 마운트해도 되는 것은 StrictMode 가 개발 중에 매번 확인한다. */
export class Crash extends Component<{ children: ReactNode }, { error: Error | null; round: number }> {
  state = { error: null as Error | null, round: 0 };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error) {
    // ★경계가 받은 오류는 `window` 의 error 사건으로 안 온다 (React 19 는 console 에만 적는다)
    logError("화면", error);
  }

  render() {
    if (this.state.error)
      return (
        <Fallback
          error={this.state.error}
          redraw={() => this.setState((s) => ({ error: null, round: s.round + 1 }))}
        />
      );
    // ★`key` 를 바꿔 통째로 새로 그린다. 오류가 난 트리의 상태를 이어 쓰지 않는다
    return <Fragment key={this.state.round}>{this.props.children}</Fragment>;
  }
}

function Fallback({ error, redraw }: { error: Error; redraw: () => void }) {
  const t = useI18n((s) => s.t);
  const kept = usePreviews((s) => s.items.length);
  return (
    <WindowFrame>
      <div data-crash style={{ height: "100%", display: "flex", flexDirection: "column", background: "var(--bg-deep)" }}>
        <TitleBar />
        <div style={{ flex: 1, display: "grid", placeItems: "center" }}>
          <div style={{ display: "grid", justifyItems: "center", gap: "var(--sp-5)", padding: "var(--sp-8)", maxWidth: 520 }}>
            <div style={{ fontSize: "var(--text-sm)", color: "var(--ink)", fontWeight: "var(--w-bold)" }}>
              {t("crash.title")}
            </div>
            {kept > 0 && (
              <div style={{ fontSize: "var(--text-2xs)", color: "var(--ink-dim)" }}>{t("crash.kept", { n: kept })}</div>
            )}
            <div
              style={{
                fontSize: "var(--text-2xs)",
                color: "var(--ink-faint)",
                fontFamily: "var(--font-mono)",
                textAlign: "center",
                wordBreak: "break-word",
              }}
            >
              {error.message.slice(0, 200)}
            </div>
            <button
              data-crash-redraw
              onClick={redraw}
              style={{
                border: "1px solid var(--accent)",
                borderRadius: "var(--r-2)",
                background: "var(--accent)",
                color: "var(--accent-on)",
                padding: "var(--sp-2) var(--sp-5)",
                fontSize: "var(--text-xs)",
                cursor: "pointer",
              }}
            >
              {t("crash.redraw")}
            </button>
          </div>
        </div>
      </div>
    </WindowFrame>
  );
}
