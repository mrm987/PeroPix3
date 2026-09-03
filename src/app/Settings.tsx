import { Fragment, useState } from "react";
import { useI18n, LOCALES } from "../i18n";
import { api } from "../lib/backend";
import { useTheme } from "../store/theme";
import { playDoneSound } from "../lib/notifySound";
import { useUi, FONTS, type SettingsTabId } from "../store/ui";
import { useAccounts, type Account } from "../store/accounts";
import { useHealth } from "../store/health";
import { mb, useUpdate } from "../store/update";
import { ask } from "../store/ask";
import { openExternal } from "../lib/openExternal";
import { toast } from "../store/toast";
import { Icon } from "../components/Icon";
import { Help } from "../components/Tip";
import { AiSettings } from "./AiSettings";
import { McpSettings } from "./McpSettings";

/** 설정 — **앱 안에서 손대는 것들**을 한자리에 (10단계).
 *
 *  ★NAI 토큰이 여기 없으면 앱만으로는 아무것도 못 만든다 — 지금까지는 `data/config.json` 을
 *    직접 고쳐야 했다. 백엔드 `/api/token` 은 이미 있었고, **창구가 없었다.**
 *  ★토큰은 **되읽지 않는다.** 서버는 있는지(`hasToken`)만 알려 주고 값은 안 내보낸다 —
 *    화면에 띄우면 스크린샷·화면 공유로 새어 나간다.
 *  ★글꼴·언어·테마도 여기로 모은다. 타이틀바에 흩어 두면 자주 안 쓰는 것이 늘 자리를 차지한다.
 *  ★**좌측 탭으로 가른다** (사용자 지시 2026-08-08). 한 화면에 다 쌓으면 항목이 늘수록
 *    나빠진다 — 특히 AI 조수는 공급자·모델·키가 붙어 자기 화면이 필요하다.
 */
export function Settings({
  onClose,
  tab: initialTab = "general",
}: {
  onClose: () => void;
  /** 어느 탭으로 열 것인가 — ★**연 자리에 맞춘다.** AI 채팅의 엔진 칩에서 오면 LLM 탭이다
   *  (사용자 지시 2026-08-12). 거기서 일반 탭이 열리면 한 번 더 눌러야 한다 */
  tab?: TabId;
}) {
  const t = useI18n((s) => s.t);
  const locale = useI18n((s) => s.locale);
  const setLocale = useI18n((s) => s.setLocale);
  const theme = useTheme((s) => s.theme);
  const setTheme = useTheme((s) => s.set);
  const font = useUi((s) => s.font);
  const setFont = useUi((s) => s.setFont);
  const textScale = useUi((s) => s.textScale);
  const setTextScale = useUi((s) => s.setTextScale);
  /** 그리는 중인 그림 보기 — ★결과를 바꾸지 않는 **보는 방식**이라 여기 산다 */
  const stream = useUi((s) => s.streamPreview);
  const focusNew = useUi((s) => s.focusNewPending);
  const notify = useUi((s) => s.notifyDone);
  const sound = useUi((s) => s.notifySound);
  const setSound = useUi((s) => s.setNotifySound);
  const vol = useUi((s) => s.notifyVolume);
  const setVol = useUi((s) => s.setNotifyVolume);
  const setNotify = useUi((s) => s.setNotifyDone);
  const suggest = useUi((s) => s.tagSuggest);
  const weightHl = useUi((s) => s.weightHl);
  const setWeightHl = useUi((s) => s.setWeightHl);
  const setSuggest = useUi((s) => s.setTagSuggest);
  const artistPrefix = useUi((s) => s.artistPrefix);
  const setArtistPrefix = useUi((s) => s.setArtistPrefix);
  // ★토큰 유무·앱 버전·요청 창구는 **백엔드가 정본**이다 (`store/health.ts`)
  const version = useHealth((s) => s.health?.version ?? "");
  const support = useHealth((s) => s.health?.support ?? "");
  const [tab, setTab] = useState<TabId>(initialTab);

  return (
    <div
      data-settings
      onPointerDown={(e) => e.target === e.currentTarget && onClose()}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 90,
        background: "rgba(6,8,12,0.62)",
        display: "grid",
        placeItems: "center",
        padding: "var(--sp-6)",
      }}
    >
      <div
        style={{
          background: "var(--bg)",
          border: "1px solid var(--line)",
          borderRadius: "var(--r-4)",
          width: "min(880px, 94vw)",
          height: "min(620px, 88vh)",
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            padding: "var(--sp-4) var(--sp-5)",
            borderBottom: "1px solid var(--line-soft)",
          }}
        >
          <b style={{ fontSize: "var(--text-md)" }}>{t("settings.title")}</b>
          <span style={{ flex: 1 }} />
          <button data-settings-close onClick={onClose} style={{ color: "var(--ink-faint)", display: "grid" }}>
            {Icon.close}
          </button>
        </div>

        <div style={{ flex: 1, minHeight: 0, display: "flex" }}>
          {/* ★왼쪽은 **어디에 있는지**만 말한다 — 항목이 늘어도 여기는 안 는다 */}
          <nav
            style={{
              width: 168,
              flexShrink: 0,
              borderRight: "1px solid var(--line-soft)",
              padding: "var(--sp-3)",
              display: "flex",
              flexDirection: "column",
              gap: 2,
            }}
          >
            {TABS.map(([id, key]) => (
              <button
                key={id}
                data-settings-tab={id}
                data-on={tab === id ? "" : undefined}
                onClick={() => setTab(id)}
                style={{
                  textAlign: "left",
                  padding: "6px var(--sp-3)",
                  borderRadius: "var(--r-2)",
                  fontSize: "var(--text-2xs)",
                  background: tab === id ? "var(--accent-bg)" : "transparent",
                  color: tab === id ? "var(--ink)" : "var(--ink-soft)",
                  border: `1px solid ${tab === id ? "var(--accent)" : "transparent"}`,
                }}
              >
                {t(key)}
              </button>
            ))}
          </nav>

          <div
            data-settings-pane={tab}
            style={{
              flex: 1,
              minWidth: 0,
              overflowY: "auto",
              padding: "var(--sp-5)",
              display: "flex",
              flexDirection: "column",
              gap: "var(--sp-5)",
            }}
          >
            {tab === "general" && (
              <>
                <AccountSettings />

                <Group label={t("settings.editing")} help={t("settings.tagSuggestHint")}>
                  <label
                    style={checkRow}
                  >
                    <input
                      type="checkbox"
                      data-tag-suggest-toggle
                      checked={suggest}
                      onChange={(e) => setSuggest(e.target.checked)}
                    />
                    {t("settings.tagSuggest")}
                  </label>
                  {/* ★작가를 고르면 `artist:` 를 단다 — 끌 수 있다 (사용자 지시 2026-08-28) */}
                  <label
                    style={checkRow}
                    data-tip={t("settings.artistPrefixHint")}
                  >
                    <input
                      type="checkbox"
                      data-artist-prefix-toggle
                      checked={artistPrefix}
                      onChange={(e) => setArtistPrefix(e.target.checked)}
                    />
                    {t("settings.artistPrefix")}
                  </label>
                  {/* ★가중치 강조 — 칩과 글 상자가 **같은 스위치**를 본다 */}
                  <label
                    style={checkRow}
                  >
                    <input
                      type="checkbox"
                      data-weight-hl-toggle
                      checked={weightHl}
                      onChange={(e) => setWeightHl(e.target.checked)}
                    />
                    {t("settings.weightHl")}
                  </label>
                </Group>

                <Group label={t("settings.queue")} help={t("settings.notifyHint")}>
                  {/* ★★**그리는 중인 그림 보기** (사용자 지시 2026-08-26:
                      *"스트리밍 온오프 옵션은 생성부가 아니고 옵션 패널에 넣어"*).
                      한때 생성 옵션 패널에 있었는데, 거기 있는 값들과 달리 **결과를 바꾸지
                      않는다** — 알림·소리와 같은 성격이라 이 묶음이 제자리다. */}
                  <label
                    style={checkRow}
                    /* ★툴팁은 **우리가 그린다** (`components/Tip`) — 브라우저 기본 `title` 은
                       뜨는 데 1초쯤 걸리고 모양도 우리 것이 아니라, 이 하나만 따로 논다 */
                    data-tip={t("settings.streamPreviewHint")}
                  >
                    <input
                      type="checkbox"
                      data-stream-preview
                      checked={stream}
                      onChange={(e) => useUi.getState().setStreamPreview(e.target.checked)}
                    />
                    {t("settings.streamPreview")}
                  </label>
                  {/* ★생성을 누르면 방금 넣은 대기 칸으로 이동 (사용자 지시 2026-09-03).
                      결과를 바꾸지 않는 「보는 방식」이라 위 항목과 같은 묶음이다. 기본은 끔. */}
                  <label style={checkRow} data-tip={t("settings.focusNewPendingHint")}>
                    <input
                      type="checkbox"
                      data-focus-new-pending
                      checked={focusNew}
                      onChange={(e) => useUi.getState().setFocusNewPending(e.target.checked)}
                    />
                    {t("settings.focusNewPending")}
                  </label>
                  <label
                    style={checkRow}
                  >
                    <input
                      type="checkbox"
                      data-notify-done
                      checked={notify}
                      onChange={(e) => setNotify(e.target.checked)}
                    />
                    {t("settings.notifyDone")}
                  </label>
                  {/* ★소리로도 알린다 (v2 `notifySoundOnComplete` 이식 2026-08-16).
                      ★생성 옵션이 아니라 **앱 설정**이라 여기 있다 (사용자 지시). */}
                  <label
                    style={checkRow}
                  >
                    <input
                      type="checkbox"
                      data-notify-sound
                      checked={sound}
                      onChange={(e) => setSound(e.target.checked)}
                    />
                    {t("settings.notifySound")}
                  </label>
                  {sound && (
                    <label
                      style={{ display: "flex", alignItems: "center", gap: "var(--sp-2)" }}
                    >
                      <span style={{ fontSize: "var(--text-2xs)", color: "var(--ink-faint)" }}>
                        {t("settings.notifyVolume")}
                      </span>
                      <input
                        type="range"
                        data-notify-volume
                        min={1}
                        max={100}
                        value={vol}
                        onChange={(e) => setVol(Number(e.target.value))}
                        style={{ flex: 1 }}
                      />
                      <span
                        style={{
                          width: 30,
                          textAlign: "right",
                          fontSize: "var(--text-2xs)",
                          fontVariantNumeric: "tabular-nums",
                        }}
                      >
                        {vol}
                      </span>
                      <button
                        data-notify-test
                        onClick={() => void playDoneSound()}
                        data-tip={t("settings.notifyTest")}
                        style={{ color: "var(--ink-faint)", display: "grid" }}
                      >
                        {Icon.spark}
                      </button>
                    </label>
                  )}
                </Group>

                {/* ★★**업데이트** (사용자 지시 2026-08-26 — 「보류」였던 자리다: 배포처가
                     포터블 zip 으로 정해지면서 풀렸다).
                   ★단추는 **하나**다. 패치를 받을지 전체를 받을지는 앱이 정하고, 사용자에게는
                     **받는 양만** 숫자로 보인다 (사용자 지시: *"「이번엔 전체를 받아야 합니다」
                     라는 문구를 볼 필요가 있음?"*). */}
                <Group label={t("update.title")}>
                  <UpdateBox />
                </Group>

                {/* ★앱 정보 — 버전은 백엔드가 준다(`/api/health`). 화면에 박아 두면 어긋난다. */}
                <Group label={t("settings.about")}>
                  <div style={{ display: "flex", alignItems: "center", gap: "var(--sp-3)", flexWrap: "wrap" }}>
                    <span
                      data-about-version
                      style={{
                        fontSize: "var(--text-2xs)",
                        color: "var(--ink-dim)",
                        fontFamily: "var(--font-mono)",
                      }}
                    >
                      {version || t("settings.loading")}
                    </span>
                    {/* ★★**로그를 여는 단추** (사용자 지시 2026-08-27, 제보용). 자리를
                        글로 적어 주면 탐색기에서 손으로 찾아 들어가야 해서 제보가 거기서
                        끊긴다 — 눌러서 파일이 잡힌 채로 열리게 한다. */}
                    <button
                      data-open-log
                      onClick={() =>
                        void api("/api/log/reveal", { method: "POST" }).catch((e) =>
                          toast(String(e), "warn"),
                        )
                      }
                      data-tip={t("settings.logHint")}
                      style={{ ...btn, display: "inline-flex", alignItems: "center", gap: "var(--sp-2)" }}
                    >
                      {t("settings.log")}
                    </button>
                    {support && (
                      <button
                        data-support-link
                        onClick={() => openExternal(support)}
                        data-tip={support}
                        style={{ ...btn, display: "inline-flex", alignItems: "center", gap: "var(--sp-2)" }}
                      >
                        {Icon.external}
                        {t("settings.support")}
                      </button>
                    )}
                  </div>
                </Group>
              </>
            )}

            {tab === "look" && (
              <Group label={t("settings.look")}>
                <Line label={t("settings.language")}>
                  {LOCALES.map((l) => (
                    <Chip key={l.id} on={locale === l.id} onClick={() => setLocale(l.id)} mark={`locale-${l.id}`}>
                      {l.label}
                    </Chip>
                  ))}
                </Line>
                <Line label={t("settings.theme")}>
                  {THEMES.map(([k, key]) => (
                    <Chip key={k} on={theme === k} onClick={() => setTheme(k)} mark={`theme-${k}`}>
                      {t(key)}
                    </Chip>
                  ))}
                </Line>
                <Line label={t("settings.font")}>
                  {FONTS.map((f) => (
                    <Chip key={f.id} on={font === f.id} onClick={() => setFont(f.id)} mark={`font-${f.id}`}>
                      {f.label}
                    </Chip>
                  ))}
                </Line>
                {/* ★글자 크기 — 앱 안의 모든 글자 토큰에 곱하는 배율 (사용자 지시 2026-08-29).
                    80~150%, 5% 눈금. 움직이는 즉시 화면 전체가 따라온다. */}
                <Line label={t("settings.textScale")}>
                  <input
                    type="range"
                    data-text-scale
                    min={80}
                    max={150}
                    step={5}
                    value={Math.round(textScale * 100)}
                    onChange={(e) => setTextScale(Number(e.target.value) / 100)}
                    style={{ flex: 1 }}
                  />
                  <span
                    data-text-scale-value
                    style={{ width: 40, textAlign: "right", fontSize: "var(--text-2xs)", color: "var(--ink-faint)", fontVariantNumeric: "tabular-nums" }}
                  >
                    {Math.round(textScale * 100)}%
                  </span>
                </Line>
              </Group>
            )}

            {tab === "llm" && <AiSettings />}
            {tab === "mcp" && <McpSettings />}
            {tab === "keys" && <KeyGuide />}
          </div>
        </div>
      </div>
    </div>
  );
}

/** 좌측 탭 — ★이름을 문자열로 이어 만들지 않는다 (아래 THEMES 와 같은 이유).
 *  ★값 자체는 `store/ui.ts` 가 든다 (여는 자리가 셋이라 스토어에 있어야 한다) */
export type TabId = SettingsTabId;
const TABS = [
  ["general", "settings.tabGeneral"],
  ["look", "settings.look"],
  ["llm", "settings.llm"],
  ["mcp", "settings.mcpTab"],
  ["keys", "settings.keysTab"],
] as const satisfies readonly (readonly [TabId, string])[];

/** **조작 안내** — 겉으로 안 드러나는 조작들 (사용자 지시 2026-08-30: 우클릭 삭제·Alt+휠 가중치처럼
 *  화면에 힌트가 없는 것을 한 자리에). ★목록은 **코드에서 실제로 처리하는 것만** 적는다 — 없는 조작을
 *  적으면 안내가 곧 거짓말이 된다. 조작을 더하거나 걷으면 여기도 같이 고친다.
 *  ★설명은 i18n 에 산다 (`settings.keyGuide.*`) — 여기서는 어느 무리에 무엇이 드는지만 정한다. */
const KEY_GROUPS: readonly (readonly [string, readonly string[]])[] = [
  ["prompt", ["chipDelete", "chipWeight", "chipWeightBig", "chipReset", "chipDrag", "blockDrag",
              "editEnter", "editShiftEnter", "editTab", "editEsc", "editUndo"]],
  ["scene", ["pickMulti", "pickRange", "pickDelete", "pickClear", "arrowTake", "arrowScene", "wheelTake", "wheelZoom",
             "wheelLane", "sceneRename", "sceneTab", "dragGroup", "dragTab", "undo"]],
  ["gallery", ["galArrows", "galStar", "galMulti", "galRename", "galClose"]],
  ["censor", ["cenTools", "cenDelete", "cenRight", "cenArrows"]],
  ["files", ["fileMulti"]],
  ["window", ["titleDbl"]],
];

function KeyGuide() {
  const t = useI18n((s) => s.t);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--sp-4)" }}>
      <span style={{ fontSize: "var(--text-2xs)", color: "var(--ink-dim)" }}>{t("settings.keyGuide.intro")}</span>
      {KEY_GROUPS.map(([g, items]) => (
        <Group key={g} label={t(`settings.keyGuide.group.${g}`)}>
          <div style={{ display: "grid", gridTemplateColumns: "max-content 1fr", columnGap: "var(--sp-4)", rowGap: "var(--sp-2)" }}>
            {items.map((k) => (
              <Fragment key={k}>
                <code
                  data-key-guide={k}
                  style={{
                    fontFamily: "var(--font-mono)",
                    fontSize: "var(--text-2xs)",
                    color: "var(--ink)",
                    background: "var(--code-bg)",
                    border: "1px solid var(--line)",
                    borderRadius: "var(--r-1)",
                    padding: "1px var(--sp-2)",
                    whiteSpace: "nowrap",
                    alignSelf: "start",
                  }}
                >
                  {t(`settings.keyGuide.${k}.k`)}
                </code>
                <span style={{ fontSize: "var(--text-2xs)", color: "var(--ink-soft)", lineHeight: 1.5 }}>
                  {t(`settings.keyGuide.${k}.v`)}
                </span>
              </Fragment>
            ))}
          </div>
        </Group>
      ))}
    </div>
  );
}

/** ★키를 **문자열로 이어 만들지 않는다** — i18n 회귀 테스트가 "실재하지 않는 그룹"으로 잡고,
 *  무엇보다 키가 조용히 빠져도 아무도 모른다 */
const THEMES = [
  ["system", "settings.themeSystem"],
  ["light", "settings.themeLight"],
  ["dark", "settings.themeDark"],
] as const;

/** ★설명은 **라벨 옆 `?`** 로만 나온다 (사용자 지시 2026-08-19) — 화면에 펼쳐 두지 않는다 */
export const Group = ({ label, help, children }: { label: string; help?: string; children: React.ReactNode }) => (
  <div style={{ display: "flex", flexDirection: "column", gap: "var(--sp-2)" }}>
    <span style={{ display: "flex", alignItems: "center", gap: "var(--sp-2)", fontSize: "var(--text-xs)", fontWeight: "var(--w-semi)", color: "var(--ink-soft)" }}>
      {label}
      {help && <Help tip={help} />}
    </span>
    {children}
  </div>
);

const Line = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <div style={{ display: "flex", alignItems: "center", gap: "var(--sp-2)" }}>
    <span style={{ width: 54, flexShrink: 0, fontSize: "var(--text-2xs)", color: "var(--ink-faint)" }}>{label}</span>
    {children}
  </div>
);

const Chip = ({
  on,
  onClick,
  mark,
  children,
}: {
  on: boolean;
  onClick: () => void;
  mark: string;
  children: React.ReactNode;
}) => (
  <button
    data-set={mark}
    onClick={onClick}
    style={{
      border: `1px solid ${on ? "var(--accent)" : "var(--line)"}`,
      background: on ? "var(--accent-bg)" : "var(--panel)",
      color: on ? "var(--ink)" : "var(--ink-soft)",
      borderRadius: "var(--r-2)",
      padding: "3px var(--sp-4)",
      fontSize: "var(--text-2xs)",
    }}
  >
    {children}
  </button>
);

/** 체크박스 한 줄 — ★**모든 체크 항목이 이것 하나를 쓴다** (사용자 지적 2026-08-26:
 *  *"설정에 있는 체크박스 항목들의 폰트 사이즈가 다름"*). 줄마다 따로 적어 두었더니
 *  어떤 것은 글자 크기·색이 빠져 부모 크기를 물려받고 있었다. 여기서만 고친다.
 *  ★누를 자리는 **글자 끝까지만** (`inline-flex` + `alignSelf`) — 빈 곳을 눌러도 켜지지 않게. */
const checkRow: React.CSSProperties = {
  display: "inline-flex",
  alignSelf: "flex-start",
  alignItems: "center",
  gap: "var(--sp-2)",
  fontSize: "var(--text-2xs)",
  color: "var(--ink-soft)",
  cursor: "pointer",
};

export const btn: React.CSSProperties = {
  border: "1px solid var(--line)",
  borderRadius: "var(--r-2)",
  background: "var(--panel)",
  color: "var(--ink-soft)",
  padding: "4px var(--sp-4)",
  fontSize: "var(--text-2xs)",
};


/** 업데이트 칸 — 확인 · 받기 · 다시 켜기. **한 줄기로 이어진다.**
 *
 *  ★★상태가 곧 화면이다: 아무것도 모름 → 「업데이트 확인」 / 새 판 있음 → 「지금 업데이트」 /
 *    받는 중 → 진행률 / 받아 둠 → 「지금 다시 켜기」. 갈래마다 단추를 따로 두지 않는다.
 *  ★부팅 때 이미 조용히 확인해 두므로(`App`), 여기 들어오면 대개 답이 나와 있다. */
function UpdateBox() {
  const t = useI18n((s) => s.t);
  const { info, checking, phase, done, total } = useUpdate();
  const u = useUpdate.getState();

  /* ★★**갈아 끼우는 동안**도 말해 준다 (사용자 지적 2026-08-26: *"다운 받은 후 설치중
     프로그레스가 없음"*). 몇 %인지는 못 낸다 — 이름 바꾸기 몇 번이라 순식간에 끝나고,
     눈에 보이는 시간은 앱이 꺼졌다 다시 뜨는 동안이다. */
  if (phase === "applying") return <span data-update-applying style={dim}>{t("update.applying")}</span>;

  /* ★★다 받고 **푸는 동안** (사용자 지적 2026-08-27: *"132.3/132.3 에서 멈춰 있다가 완료됨"*).
     몇 %인지는 못 낸다 — zip 을 통째로 푸는 일이라 중간 숫자가 없다. */
  if (phase === "unpacking") return <span data-update-unpacking style={dim}>{t("update.unpacking")}</span>;

  if (phase === "staged")
    return (
      <Row>
        <span style={dim}>{t("update.ready")}</span>
        <button data-update-restart onClick={() => void u.restart()} style={accentBtn}>
          {t("update.restart")}
        </button>
      </Row>
    );

  if (phase === "downloading")
    return (
      <Row>
        <span style={dim}>
          {t("update.downloading", { done: mb(done), total: mb(total || info?.size || 0) })}
        </span>
        {/* ★막대는 **받은 만큼**이다 — 총량을 모르면(0) 채우지 않는다 */}
        <div style={{ flex: 1, height: 4, background: "var(--line)", borderRadius: 2, overflow: "hidden" }}>
          <div
            data-update-bar
            style={{
              width: total ? `${Math.min(100, (done / total) * 100)}%` : "0%",
              height: "100%",
              background: "var(--accent)",
              transition: "width 0.2s",
            }}
          />
        </div>
        {/* ★★**그만둘 수 있어야 한다** (사용자 지적 2026-08-26: *"무조건 끝까지 받아야함"*) */}
        <button data-update-cancel onClick={() => void u.cancel()} style={btn}>
          {t("update.cancel")}
        </button>
      </Row>
    );

  if (info?.has_update && info.building)
    return <span style={dim}>{t("update.building", { v: info.latest })}</span>;

  if (info?.has_update)
    return (
      <Row>
        <button data-update-now onClick={() => void u.start()} style={accentBtn}>
          {t("update.now")}
        </button>
        <span style={dim}>
          v{info.latest} · {mb(info.size ?? 0)}
        </span>
        {info.url && (
          <button data-update-notes onClick={() => openExternal(info.url!)} style={{ ...btn, display: "inline-flex", gap: "var(--sp-2)" }}>
            {Icon.external}
            {t("update.notes")}
          </button>
        )}
      </Row>
    );

  return (
    <Row>
      <button data-update-check disabled={checking} onClick={() => void u.check()} style={btn}>
        {checking ? t("update.checking") : t("update.check")}
      </button>
    </Row>
  );
}

const dim = { fontSize: "var(--text-2xs)", color: "var(--ink-dim)" } as const;
const accentBtn = {
  padding: "var(--sp-2) var(--sp-4)",
  borderRadius: "var(--r-1)",
  background: "var(--accent)",
  color: "var(--accent-on)",
} as const;

function Row({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: "var(--sp-3)", flexWrap: "wrap" }}>{children}</div>
  );
}

/** **NAI 계정 목록** (사용자 결정 2026-09-02) — 여럿을 두고 워크스페이스마다 고른다 (`store/accounts`).
 *
 *  ★이름은 자동 번호(「API n」)로 태어나고 **여기서 고친다** — 칸을 고치고 나가면 저장된다.
 *  ★토큰 값은 되읽지 않는다 (옛 규칙 그대로) — **갈아 끼우기**만 된다. 지우고 다시 넣으면 번호가 바뀌어
 *    워크스페이스의 선택이 끊기므로, 같은 계정의 새 토큰은 교체로 넣는다.
 *  ★검사는 서버가 한다 (공백·비ASCII·`pst-` 접두 + NAI 401 확인). 화면에서 한 번 더 재면 두 곳이 어긋난다.
 *  ★되짚어야 할 것(경고)은 토스트가 아니라 **칸 옆에 남긴다** — "왜 안 되지"의 답이다. */
function AccountSettings() {
  const t = useI18n((s) => s.t);
  const items = useAccounts((s) => s.items);
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  /** 토큰을 갈아 끼우는 중인 계정 — 그 줄 아래에 입력칸이 열린다 */
  const [replacing, setReplacing] = useState<string | null>(null);
  const [replaceToken, setReplaceToken] = useState("");

  const run = async (fn: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setNote("");
    try {
      await fn();
    } catch (e) {
      setNote(String(e).replace(/^Error:\s*/, ""));
    } finally {
      setBusy(false);
    }
  };
  const add = () =>
    run(async () => {
      const r = await useAccounts.getState().add(token.trim());
      setToken("");
      if (r.warning) setNote(r.warning);
      toast(t("settings.accountAdded", { name: r.name }));
    });
  const replace = (id: string) =>
    run(async () => {
      const r = await useAccounts.getState().replaceToken(id, replaceToken.trim());
      setReplacing(null);
      setReplaceToken("");
      if (r.warning) setNote(r.warning);
      toast(t("settings.accountReplaced"));
    });
  const remove = async (a: Account) => {
    if (
      !(await ask({
        title: t("settings.accountDelete", { name: a.name }),
        body: t("settings.accountDeleteBody"),
        ok: t("common.delete"),
        cancel: t("common.cancel"),
        danger: true,
      }))
    )
      return;
    await run(async () => {
      await useAccounts.getState().remove(a.id);
      toast(t("settings.accountRemoved"));
    });
  };
  const input = {
    flex: 1,
    minWidth: 0,
    background: "var(--panel)",
    border: "1px solid var(--line)",
    borderRadius: "var(--r-2)",
    padding: "4px var(--sp-3)",
    fontSize: "var(--text-2xs)",
  } as const;
  const row = { display: "flex", alignItems: "center", gap: "var(--sp-2)" } as const;

  return (
    <Group label={t("settings.accounts")} help={t("settings.accountsHint")}>
      {items.map((a) => (
        <div key={a.id} data-account={a.id} style={{ display: "flex", flexDirection: "column", gap: "var(--sp-2)" }}>
          <div style={row}>
            {/* ★이름은 그 자리에서 고친다 — 나가면 저장. 비우면 원래 이름으로 돌아간다 */}
            <input
              key={a.name}
              data-account-name
              defaultValue={a.name}
              disabled={!!a.env}
              onBlur={(e) => {
                const v = e.currentTarget.value.trim();
                if (v && v !== a.name) void useAccounts.getState().rename(a.id, v);
                else e.currentTarget.value = a.name;
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") e.currentTarget.blur();
              }}
              style={input}
            />
            {!a.env && (
              <button
                data-account-replace
                onClick={() => {
                  setReplacing(replacing === a.id ? null : a.id);
                  setReplaceToken("");
                }}
                disabled={busy}
                style={btn}
              >
                {t("settings.accountReplace")}
              </button>
            )}
            {!a.env && (
              <button data-account-delete onClick={() => void remove(a)} disabled={busy} style={{ ...btn, color: "var(--err-ink)" }}>
                {t("common.delete")}
              </button>
            )}
          </div>
          {replacing === a.id && (
            <div style={row}>
              <input
                data-account-token
                type="password"
                value={replaceToken}
                placeholder={t("settings.tokenEmpty")}
                onChange={(e) => setReplaceToken(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && replaceToken.trim()) void replace(a.id);
                }}
                style={{ ...input, fontFamily: "var(--font-mono)" }}
              />
              <button onClick={() => void replace(a.id)} disabled={busy || !replaceToken.trim()} style={btn}>
                {t(busy ? "settings.tokenChecking" : "settings.save")}
              </button>
            </div>
          )}
        </div>
      ))}
      {/* 새 계정 — 토큰만 넣으면 이름은 자동 번호다 */}
      <div style={row}>
        <input
          data-token
          type="password"
          value={token}
          placeholder={t("settings.tokenEmpty")}
          onChange={(e) => setToken(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && token.trim()) void add();
          }}
          style={{ ...input, fontFamily: "var(--font-mono)" }}
        />
        <button data-token-save onClick={() => void add()} disabled={busy || !token.trim()} style={btn}>
          {t(busy ? "settings.tokenChecking" : "settings.accountAdd")}
        </button>
      </div>
      {note && (
        <span data-token-note style={{ fontSize: "var(--text-2xs)", color: "var(--warn)", lineHeight: 1.6 }}>
          {note}
        </span>
      )}
      {/* ★NAI 계정이 걸린 경고라 눈에 띄어야 한다 (v2 index.html:10558) */}
      <span style={{ fontSize: "var(--text-2xs)", color: "var(--warn)", lineHeight: 1.6 }}>
        {t("settings.bulkWarn")}
      </span>
    </Group>
  );
}
