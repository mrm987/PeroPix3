import { useI18n } from "../i18n";
import { Icon } from "../components/Icon";
import { mb, useUpdate } from "../store/update";
import { useUi } from "../store/ui";

/** 타이틀바의 업데이트 띠 — **어디서 무엇을 하고 있든 보인다.**
 *
 *  ★★사용자 지적 2026-08-26: *"업데이트를 누르면 화면에 아무 변화가 없는데 옵션 모달에
 *    가보면 조용히 다운받고 있음."* 진행 막대가 **설정 모달 안에만** 있었다. 알림은 어디서든
 *    뜨는데 그 알림을 누른 결과는 한 군데서만 보이니, 누른 사람 눈에는 아무 일도 안 일어났다.
 *  ★★자리를 타이틀바로 잡은 까닭: **탭·모달과 무관하게 늘 떠 있는 유일한 자리**다.
 *    설정을 열어 두라고 요구하면 그동안 앱을 못 쓴다 — 받는 동안에도 쓸 수 있어야 한다.
 *  ★아무 일도 없을 때는 **아무것도 안 그린다.** 늘 자리를 차지하면 그것대로 방해다.
 *  ★값은 `store/update` 의 `phase` 하나에서 온다 — 설정 칸도 같은 값을 본다.
 */
export function UpdateStrip() {
  const t = useI18n((s) => s.t);
  const { phase, done, total, info } = useUpdate();
  const u = useUpdate.getState();
  const openSettings = useUi((s) => s.openSettings);
  if (phase === "idle") return null;

  const pct = total ? Math.min(100, (done / total) * 100) : 0;

  return (
    <span
      data-update-strip={phase}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: "var(--sp-2)",
        fontSize: "var(--text-2xs)",
        color: "var(--ink-dim)",
        paddingRight: "var(--sp-3)",
      }}
    >
      {phase === "downloading" && (
        <>
          {/* ★누르면 설정의 업데이트 칸으로 — 자세한 것은 거기 있다 */}
          <button
            data-update-strip-open
            onClick={() => openSettings("general")}
            data-tip={t("update.title")}
            style={{ color: "var(--ink-dim)" }}
          >
            {t("update.downloading", { done: mb(done), total: mb(total || info?.size || 0) })}
          </button>
          {/* ★막대는 **받은 만큼**이다 — 총량을 모르면(0) 안 채운다 */}
          <span
            style={{
              width: 64, height: 4, borderRadius: 2,
              background: "var(--line)", overflow: "hidden",
            }}
          >
            <span
              data-update-strip-bar
              style={{
                display: "block", width: `${pct}%`, height: "100%",
                background: "var(--accent)", transition: "width 0.2s",
              }}
            />
          </span>
          {/* ★★**그만둘 수 있어야 한다** (사용자 지적 2026-08-26: *"무조건 끝까지 받아야함"*) */}
          <button
            data-update-cancel
            onClick={() => void u.cancel()}
            data-tip={t("update.cancel")}
            style={{ color: "var(--ink-faint)", display: "grid" }}
          >
            {Icon.close}
          </button>
        </>
      )}

      {/* ★★**다 받고 푸는 동안** (사용자 지적 2026-08-27). 몇 %인지는 못 낸다 — 백엔드가
          zip 을 통째로 푸는 일이라 중간 숫자가 없다. 대신 **멈춘 게 아니라는 것**을 보인다.
          ★그만두기는 안 붙인다: 이미 다 받았고, 푸는 것을 중간에 끊으면 `.update/` 가
            어중간하게 남는다. */}
      {phase === "unpacking" && (
        <button
          data-update-strip-open
          onClick={() => openSettings("general")}
          data-tip={t("update.title")}
          style={{ color: "var(--ink-dim)" }}
        >
          {t("update.unpacking")}
        </button>
      )}

      {phase === "staged" && (
        <button
          data-update-strip-restart
          onClick={() => void u.restart()}
          data-tip={t("update.ready")}
          style={{ color: "var(--accent-ink)", fontWeight: "var(--w-semi)" }}
        >
          {t("update.restart")}
        </button>
      )}

      {/* ★★**갈아 끼우는 동안** (사용자 지적 2026-08-26: *"다운 받은 후 설치중 프로그레스가
          없음"*). 몇 %인지는 못 낸다 — 이름 바꾸기 몇 번이라 순식간에 끝나고, 눈에 보이는
          시간은 **앱이 꺼졌다 다시 뜨는 동안**이다. 그래서 숫자 대신 「곧 다시 켜집니다」다. */}
      {phase === "applying" && <span data-update-applying>{t("update.applying")}</span>}
    </span>
  );
}
