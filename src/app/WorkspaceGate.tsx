import { useI18n } from "../i18n";
import { ask } from "../store/ask";
import { useEffect, useRef, useState } from "react";
import { useWs } from "../store/workspace";
import { Icon } from "../components/Icon";

/** 워크스페이스 고르기·만들기 — **모달 하나뿐이다** (사용자 지시 2026-08-08).
 *
 *  ★첫 화면(고르는 전용 화면)은 없앴다. 탭 구조로 간 뒤로는 켜면 **마지막에 보던 화면**이
 *    바로 떠야 하고(`useWs.init`), 워크스페이스를 고르는 일은 탭 줄의 「+」에서 한다.
 *  ★상자는 **한 겹**이다. 예전엔 첫 화면용 카드(패널색·테두리·그림자)를 모달 셸 안에 그대로
 *    넣어서 카드 사방에 100px 짜리 회색 테두리가 생겼다 (사용자 지적 2026-08-08 —
 *    실측 셸 760×485 안에 카드 560×419). 그 카드 **자체가** 모달이다.
 *  ★앱 이름·설명은 여기 없다 — 첫 화면이라서 있던 것이다.
 *
 *  `onClose` 가 없으면 **닫을 수 없는 모달**이다 (열린 워크스페이스가 하나도 없어 갈 데가 없다). */
export function WorkspaceGate({ onClose }: { onClose?: () => void } = {}) {
  const { list, loading, open, create, remove, renameWs, openWs, current } = useWs();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  /** 이름을 고치는 중인 행 (사용자 지시 2026-08-29: 삭제 옆에 이름변경) — 행 안에서 바로 고친다 */
  const [editing, setEditing] = useState<string | null>(null);
  const cancelEdit = useRef(false);
  const t = useI18n((s) => s.t);

  // Esc 로도 닫는다 — 닫을 데가 있을 때만
  useEffect(() => {
    if (!onClose) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || busy) return;
    setBusy(true);
    setErr("");
    try {
      await create(name.trim());
      setName("");
      onClose?.();
    } catch (e2) {
      setErr(String(e2));
    } finally {
      setBusy(false);
    }
  };

  // ★고르면 모달은 닫힌다 — 안 닫으면 새 워크스페이스 위에 게이트가 덮여 있다
  const pick = async (fn: () => Promise<void>) => {
    await fn();
    onClose?.();
  };

  return (
    <div
      data-ws-gate-modal
      onPointerDown={(e) => e.target === e.currentTarget && onClose?.()}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 95,
        background: "rgba(6,8,12,0.62)",
        display: "grid",
        placeItems: "center",
        padding: "var(--sp-6)",
      }}
    >
      {/* ★스크롤은 **목록 한 곳**에서만 일어난다 — 카드까지 스크롤되면 워크스페이스가
          수십 개일 때 「새 워크스페이스」 칸이 위로 밀려 올라가 안 보인다 */}
      <div
        style={{
          position: "relative",
          display: "flex",
          flexDirection: "column",
          width: "min(560px, 92vw)",
          maxHeight: "86vh",
          overflow: "hidden",
          background: "var(--panel)",
          border: "1px solid var(--line)",
          borderRadius: "var(--r-4)",
          padding: "var(--sp-9) var(--sp-10) var(--sp-9)",
          boxShadow: "var(--shadow-3)",
        }}
      >
        {onClose && (
          <button
            data-ws-gate-close
            onClick={onClose}
            data-tip={t("common.close")}
            style={{
              position: "absolute",
              top: "var(--sp-4)",
              right: "var(--sp-4)",
              display: "grid",
              color: "var(--ink-faint)",
            }}
          >
            {Icon.close}
          </button>
        )}

        <form onSubmit={submit} style={{ marginBottom: "var(--sp-8)", flexShrink: 0 }}>
          <Label>{t("gate.newWorkspace")}</Label>
          <div style={{ display: "flex", gap: "var(--sp-3)" }}>
            <input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t("gate.namePlaceholder")}
              style={{
                flex: 1,
                minWidth: 0,
                background: "var(--surface)",
                border: "1px solid var(--line)",
                borderRadius: "var(--r-2)",
                padding: "var(--sp-3) var(--sp-4)",
                fontSize: "var(--text-sm)",
              }}
            />
            <button
              type="submit"
              disabled={busy || !name.trim()}
              style={{
                background: "var(--accent)",
                color: "var(--accent-on)",
                borderRadius: "var(--r-2)",
                padding: "var(--sp-3) var(--sp-7)",
                fontWeight: "var(--w-semi)",
                fontSize: "var(--text-sm)",
                whiteSpace: "nowrap",
                opacity: busy || !name.trim() ? 0.5 : 1,
              }}
            >
              {t("gate.create")}
            </button>
          </div>
        </form>

        <Label>{t("gate.recentWorkspaces")}</Label>
        <div
          data-ws-gate-list
          style={{
            flex: 1,
            minHeight: 0,
            overflowY: "auto",
            border: "1px solid var(--line)",
            borderRadius: "var(--r-2)",
            background: "var(--surface)",
          }}
        >
          {loading && <Empty>{t("gate.loading")}</Empty>}
          {!loading && list.length === 0 && (
            <Empty>
              {t("gate.emptyLine1")}
              <br />
              {t("gate.emptyLine2")}
            </Empty>
          )}
          {list.map((w) => {
            const here = w.name === current;
            const opened = openWs.includes(w.name);
            return (
              <div
                key={w.name}
                data-ws-row={w.name}
                data-ws-open={opened ? "" : undefined}
                data-ws-here={here ? "" : undefined}
                style={{
                  display: "flex",
                  alignItems: "stretch", // ★행의 두 버튼이 같은 높이를 갖는다 (줄 맞춤)
                  borderBottom: "1px solid var(--line-soft)",
                  background: here ? "var(--accent-bg)" : "transparent",
                }}
              >
                {editing === w.name ? (
                  /* ★행 안에서 바로 고친다 — Enter·밖 클릭 = 확정, Esc = 취소 (편집기의 규칙 그대로) */
                  <div
                    style={{
                      flex: 1,
                      minWidth: 0,
                      display: "flex",
                      alignItems: "center",
                      padding: "var(--sp-2) var(--sp-5)",
                    }}
                  >
                    <input
                      autoFocus
                      defaultValue={w.name}
                      onFocus={(e) => e.currentTarget.select()}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") e.currentTarget.blur();
                        if (e.key === "Escape") {
                          cancelEdit.current = true;
                          e.currentTarget.blur();
                        }
                      }}
                      onBlur={(e) => {
                        const next = e.currentTarget.value;
                        setEditing(null);
                        if (cancelEdit.current) {
                          cancelEdit.current = false;
                          return;
                        }
                        if (next.trim() && next !== w.name)
                          renameWs(w.name, next).catch((err) => setErr(String(err)));
                      }}
                      style={{
                        flex: 1,
                        minWidth: 0,
                        fontSize: "var(--text-md)",
                        color: "var(--ink)",
                        background: "var(--panel)",
                        border: "1px solid var(--accent)",
                        borderRadius: "var(--r-1)",
                        padding: "var(--sp-2) var(--sp-3)",
                      }}
                    />
                  </div>
                ) : (
                <button
                  onClick={() => void pick(() => open(w.name))}
                  style={{
                    flex: 1,
                    minWidth: 0,
                    display: "flex",
                    alignItems: "center",
                    gap: "var(--sp-3)",
                    padding: "var(--sp-4) var(--sp-5)",
                    fontSize: "var(--text-md)",
                    textAlign: "left",
                    color: opened ? "var(--ink)" : "var(--ink-soft)",
                  }}
                >
                  {/* 열려 있는 것 표시 — 지금 보는 것은 채운 점, 열어만 둔 것은 빈 점.
                      ★자리는 늘 차지한다. 안 그러면 이름의 왼쪽 끝이 줄마다 어긋난다 */}
                  <span
                    data-tip={here ? t("gate.here") : opened ? t("gate.opened") : undefined}
                    style={{
                      width: 7,
                      height: 7,
                      flexShrink: 0,
                      borderRadius: "50%",
                      border: opened ? "1.5px solid var(--accent)" : "1.5px solid transparent",
                      background: here ? "var(--accent)" : "transparent",
                    }}
                  />
                  <span
                    style={{
                      flex: 1,
                      minWidth: 0,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                      fontWeight: here ? "var(--w-semi)" : undefined,
                    }}
                  >
                    {w.name}
                  </span>
                  <span
                    style={{
                      fontSize: "var(--text-2xs)",
                      color: "var(--ink-faint)",
                      flexShrink: 0,
                      fontVariantNumeric: "tabular-nums",
                    }}
                  >
                    {w.updatedAt?.replace("T", " ").slice(0, 16) ?? ""}
                  </span>
                </button>
                )}
                <button
                  data-ws-rename={w.name}
                  onClick={() => setEditing(w.name)}
                  data-tip={t("gate.rename")}
                  style={{
                    display: "grid",
                    placeItems: "center",
                    padding: "0 var(--sp-3)",
                    color: "var(--ink-faint)",
                  }}
                >
                  {Icon.pencil}
                </button>
                <button
                  data-ws-delete={w.name}
                  onClick={async () => {
                    if (
                      await ask({
                        title: t("gate.deleteConfirm", { name: w.name }),
                        body: t("common.toTrash"),
                        ok: t("common.delete"),
                        cancel: t("common.cancel"),
                        danger: true,
                      })
                    )
                      remove(w.name);
                  }}
                  data-tip={t("gate.delete")}
                  style={{
                    // ★`display: grid` 만 주면 아이콘이 **위로 붙는다** — 행이 41px 인데
                    //   17px 짜리 SVG 가 위쪽에 놓여 × 가 글자보다 높이 떠 있었다
                    //   (사용자 지적 2026-08-08). 가운데 정렬을 함께 준다.
                    display: "grid",
                    placeItems: "center",
                    padding: "0 var(--sp-5)",
                    color: "var(--ink-faint)",
                  }}
                >
                  {Icon.trash}
                </button>
              </div>
            );
          })}
        </div>

        {err && (
          <div
            style={{
              marginTop: "var(--sp-4)",
              flexShrink: 0,
              fontSize: "var(--text-xs)",
              color: "var(--err-ink)",
            }}
          >
            {err}
          </div>
        )}
      </div>
    </div>
  );
}

const Label = ({ children }: { children: React.ReactNode }) => (
  <div
    style={{
      flexShrink: 0,
      fontSize: "var(--text-2xs)",
      color: "var(--ink-dim)",
      textTransform: "uppercase",
      letterSpacing: "0.08em",
      marginBottom: "var(--sp-3)",
    }}
  >
    {children}
  </div>
);

const Empty = ({ children }: { children: React.ReactNode }) => (
  <div
    style={{
      padding: "var(--sp-8)",
      color: "var(--ink-dim)",
      fontSize: "var(--text-xs)",
      textAlign: "center",
      lineHeight: 1.6,
    }}
  >
    {children}
  </div>
);
