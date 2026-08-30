import { useEffect, useState } from "react";
import { api } from "../lib/backend";
import { useI18n } from "../i18n";
import { useLlm } from "../store/llm";
import { useCli, CLI_EFFORTS } from "../store/cli";
import { useUi } from "../store/ui";
// ★같은 모양을 두 벌 만들지 않는다 — 설정 화면의 묶음 상자를 그대로 쓴다
import { Group, btn } from "./Settings";
import { Icon } from "../components/Icon";
import { Help } from "../components/Tip";
import { openExternal } from "../lib/openExternal";

/** AI 조수 설정 — **어떤 엔진으로 도는가**가 먼저다 (스튜디오 `SettingsPanel` 의 구성 참고).
 *
 *  ★두 갈래를 한 화면에 나란히 두지 않는다. 모드를 먼저 고르고, 그 모드에 필요한 것만 보인다 —
 *    키 칸과 CLI 목록이 같이 떠 있으면 "지금 뭘로 도는지"가 흐려진다.
 *  ★**탐지는 공짜, 로그인 확인은 아니다.** 깔렸는지는 스캔으로 알지만 로그인 여부는
 *    돌려 봐야 안다(돈이 든다). 그래서 여기서 자동으로 시험하지 않고, 안내만 한다. */
/** 「쓰려는 모델이 목록에 없다」의 유일한 출구.
 *
 *  ★목록을 잠근 대신(직접 입력 제거) **막다른 길을 만들지 않는다** — 없으면 요청할 곳을 준다.
 *  ★주소는 백엔드가 준다 (`agent.SUPPORT_URL`). 여기 박으면 두 곳이 어긋난다.
 *  ★★**주소를 글자로 보이지 않는다** (사용자 지시 2026-08-27) — 일반 옵션의
 *    「버그 신고 / 건의」와 **같은 단추**를 쓴다. 같은 곳으로 가는 길이 화면마다 다른
 *    모습이면(한쪽은 링크, 한쪽은 단추) 같은 곳인지 알 수 없고, 주소는 읽어 봐야
 *    아무 소용이 없다. */
function AskForModel({ url }: { url: string }) {
  const t = useI18n((s) => s.t);
  if (!url) return null;
  return (
    <div data-llm-ask style={{ fontSize: "var(--text-2xs)", color: "var(--ink-faint)", lineHeight: 1.6 }}>
      {t("settings.modelMissing")}{" "}
      <button
        data-llm-ask-link
        onClick={() => openExternal(url)}
        data-tip={url}
        style={{
          ...btn,
          display: "inline-flex",
          alignItems: "center",
          gap: "var(--sp-2)",
          verticalAlign: "middle",
        }}
      >
        {Icon.external}
        {t("settings.support")}
      </button>
    </div>
  );
}

/** 사용자 지침 — **문서 한 장을 통째로 고친다** (사용자 지적 2026-08-08).
 *
 *  처음엔 한 줄씩 더하고 지우는 목록이었는데, 이건 '기억'이라기보다 **지침**이라
 *  "지금까지의 지침을 종합해 봐" 같은 일이 안 됐다. 그래서 그냥 글이다.
 *  ★AI 와 사람이 **같은 문서**를 본다 (`backend/guide.py`). 엔진(API·CLI)과 무관하다 —
 *    그래서 CLI 의 개인 지침(`CLAUDE.md`)을 끌어들이지 않고도 취향이 이어진다.
 *  ★직전 내용은 `data/.guide-bak/` 에 남는다 — 통째로 덮어쓰는 자리라 되돌릴 길을 둔다. */
/** **자동 승인** — 조수의 작업을 어디까지 묻지 않고 넘길지 (사용자 결정 2026-08-24).
 *
 *  ★★칸이 **둘인** 까닭: 이 앱에는 되돌릴 수 있는 것과 없는 것이 섞여 있다. 일상 작업은
 *    안 끊기게 하되 정말 위험한 것만 남기려면 두 칸이 함께 있어야 한다 (1안).
 *  ★★「되돌릴 수 없는 것」은 셋이다 — 카드 삭제·씬 삭제(로그까지 비운다)와 **Anlas 가
 *    나가는 생성**. 생성은 「생성이니까 무조건」이 아니라 **돈이 나가느냐**로 가른다:
 *    Opus 무료 범위 안이면 통과시킨다 (`lib/appActions` 의 `generate.confirm`).
 */
function ApproveBox() {
  const t = useI18n((s) => s.t);
  const auto = useUi((s) => s.agentAuto);
  const askHard = useUi((s) => s.agentAskHard);
  const set = useUi((s) => s.setAgentApproval);
  const row: React.CSSProperties = {
    display: "inline-flex",
    alignSelf: "flex-start",
    alignItems: "center",
    gap: "var(--sp-2)",
    fontSize: "var(--text-2xs)",
    color: "var(--ink-soft)",
    cursor: "pointer",
  };
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--sp-2)" }}>
      <label style={row}>
        <input
          type="checkbox"
          data-agent-auto
          checked={auto}
          onChange={(e) => set({ agentAuto: e.target.checked })}
        />
        {t("settings.agentAuto")}
      </label>
      {/* ★자동 승인이 꺼져 있으면 전부 묻는 상태라 이 칸은 뜻이 없다 — 흐리게 둔다 */}
      <label style={{ ...row, marginLeft: "var(--sp-4)", opacity: auto ? 1 : 0.5 }}>
        <input
          type="checkbox"
          data-agent-ask-hard
          checked={askHard}
          disabled={!auto}
          onChange={(e) => set({ agentAskHard: e.target.checked })}
        />
        {t("settings.agentAskHard")}
      </label>
      <span style={{ fontSize: "var(--text-2xs)", color: "var(--ink-faint)", lineHeight: 1.6 }}>
        {t("settings.agentApproveHint")}
      </span>
    </div>
  );
}

function GuideBox() {
  const t = useI18n((s) => s.t);
  const [text, setText] = useState("");
  const [saved, setSaved] = useState("");
  const [max, setMax] = useState(4000);
  const [err, setErr] = useState("");

  const load = async () => {
    try {
      const r = await api<{ text: string; max: number }>("/api/guide");
      setText(r.text ?? "");
      setSaved(r.text ?? "");
      setMax(r.max ?? 4000);
    } catch {
      /* 백엔드가 아직 안 떴을 수 있다 */
    }
  };
  useEffect(() => {
    void load();
  }, []);

  const save = async () => {
    setErr("");
    try {
      await api("/api/guide", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      setSaved(text);
    } catch (e) {
      setErr(String((e as Error).message ?? e));
    }
  };

  const dirty = text !== saved;
  const over = text.length > max;
  return (
    <Group label={t("settings.guide")} help={t("settings.guideHint")}>
      <textarea
        data-guide
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={t("settings.guidePlaceholder")}
        rows={6}
        style={{
          ...field,
          width: "100%",
          resize: "vertical",
          minHeight: 96,
          lineHeight: 1.6,
          fontFamily: "var(--font-mono)",
        }}
      />
      <div style={{ display: "flex", alignItems: "center", gap: "var(--sp-2)" }}>
        <span
          data-guide-len
          style={{ fontSize: "var(--text-2xs)", color: over ? "var(--err)" : "var(--ink-faint)" }}
        >
          {text.length} / {max}
        </span>
        <span style={{ flex: 1 }} />
        {dirty && (
          <button data-guide-reset onClick={() => setText(saved)} style={btn}>
            {t("common.cancel")}
          </button>
        )}
        <button data-guide-save onClick={() => void save()} disabled={!dirty || over} style={btn}>
          {t("settings.save")}
        </button>
      </div>
      {err && <span style={{ fontSize: "var(--text-2xs)", color: "var(--err)" }}>{err}</span>}
    </Group>
  );
}

export function AiSettings() {
  const t = useI18n((s) => s.t);
  const cfg = useLlm((s) => s.cfg);
  const saveLlm = useLlm((s) => s.saveConfig);
  const loadLlm = useLlm((s) => s.loadConfig);
  const { engine, items, scanning, exe, setEngine, detect, pick } = useCli();
  // ★모델 목록은 **고른 CLI** 것이다 (`items` 가 실어 온다). 하나로 두면 코덱스를 골라 놓고
  //   `sonnet` 이 떠 있게 된다 — 코덱스가 못 받는 이름이다
  const cliModels = useCli((c) => c.models());
  const cliModel = useCli((c) => c.model);
  const cliEffort = useCli((c) => c.effort);
  const setCliModel = useCli((c) => c.setModel);
  const setCliEffort = useCli((c) => c.setEffort);
  const [key, setKey] = useState("");
  const [model, setModel] = useState("");
  const [verifying, setVerifying] = useState(false);
  /** "" 아직 안 눌렀다 · "ok" 통과 · 그 밖은 공급자가 준 오류 문구 그대로 */
  const [verdict, setVerdict] = useState("");
  // ★목록은 **스토어가 하나만** 들고 있다 — 채팅 칩도 같은 것을 본다
  const list = useLlm((s) => s.models);
  const listErr = useLlm((s) => s.modelsErr);
  const loading = useLlm((s) => s.modelsLoading);
  const loadModels = useLlm((s) => s.loadModels);
  const [effort, setEffort] = useState("");
  /** 지금 고른 모델의 추론 명세. 목록에 없으면(직접 입력) 단계 칸도 안 뜬다 */
  const picked = list.find((m) => m.id === model);
  const efforts = picked?.efforts ?? [];

  const runVerify = async () => {
    setVerifying(true);
    setVerdict("");
    try {
      const r = await api<{ ok: boolean; error?: string }>("/api/llm/verify", { method: "POST" });
      setVerdict(r.ok ? "ok" : String(r.error || "실패"));
    } catch (e) {
      setVerdict(String((e as Error).message ?? e));
    } finally {
      setVerifying(false);
    }
  };

  useEffect(() => {
    void loadLlm();
    void detect();
  }, [loadLlm, detect]);
  // ★공급자를 바꾸면 모델 칸도 **그 공급자 것**으로 바뀐다 (키와 마찬가지로 따로 산다)
  useEffect(() => setModel(cfg?.model ?? ""), [cfg?.model, cfg?.provider]);
  useEffect(() => setEffort(cfg?.effort ?? ""), [cfg?.effort, cfg?.provider]);
  // ★목록은 공급자·키가 정해진 뒤에 받는다 (키가 없으면 저쪽이 사유를 돌려준다)
  useEffect(() => {
    if (engine !== "api" || !cfg?.provider) return;
    void loadModels();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engine, cfg?.provider, cfg?.hasKey]);

  const installed = items.filter((x) => x.installed && x.drivable).length;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--sp-3)" }}>
      {/* 실행 모드 */}
      <div style={{ display: "flex", gap: "var(--sp-2)" }}>
        <ModeTab
          on={engine === "cli"}
          mark="cli"
          title={t("settings.engineCli")}
          sub={t("settings.engineCliSub", { n: installed })}
          onClick={() => setEngine("cli")}
        />
        <ModeTab
          on={engine === "api"}
          mark="api"
          title={t("settings.engineApi")}
          sub={cfg?.hasKey ? t("settings.keySetShort") : t("settings.keyEmpty")}
          onClick={() => setEngine("api")}
        />
      </div>

      <GuideBox />
      <ApproveBox />
      {engine === "cli" ? (
        <>
          <div style={{ display: "flex", alignItems: "center", gap: "var(--sp-2)" }}>
            <span style={{ flex: 1 }} />
            <button data-cli-rescan onClick={() => void detect()} disabled={scanning} style={btn}>
              {scanning ? t("settings.scanning") : t("settings.rescan")}
            </button>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "var(--sp-2)" }}>
            {items.map((c) => {
              const on = !!exe && c.path === exe;
              const off = !c.installed || !c.drivable;
              return (
                <button
                  key={c.id}
                  data-cli={c.id}
                  onClick={() => pick(c.id)}
                  disabled={off}
                  data-tip={c.path ?? t("settings.cliNone")}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "var(--sp-2)",
                    textAlign: "left",
                    padding: "6px var(--sp-3)",
                    borderRadius: "var(--r-2)",
                    border: `1px solid ${on ? "var(--accent)" : "var(--line)"}`,
                    background: on ? "var(--accent-bg)" : "var(--panel)",
                    opacity: off ? 0.5 : 1,
                    cursor: off ? "not-allowed" : "pointer",
                  }}
                >
                  <span
                    style={{
                      width: 8,
                      height: 8,
                      flexShrink: 0,
                      borderRadius: "50%",
                      background: on ? "var(--accent)" : c.installed ? "var(--ink-faint)" : "transparent",
                      border: c.installed ? "none" : "1px solid var(--line-strong)",
                    }}
                  />
                  <span style={{ minWidth: 0, flex: 1 }}>
                    <span
                      style={{
                        display: "block",
                        fontSize: "var(--text-2xs)",
                        color: "var(--ink)",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {c.label}
                    </span>
                    <span style={{ display: "block", fontSize: "var(--text-2xs)", color: "var(--ink-faint)" }}>
                      {!c.installed
                        ? t("settings.cliNone")
                        : c.drivable
                          ? t("settings.cliReady")
                          : t("settings.cliSoon")}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
          {/* ★CLI 도 모델·추론 강도를 고른다 (사용자 지적 2026-08-08).
              비우면 안 넘기고 CLI 기본값을 쓴다 — 값을 우리가 정하지 않는다 */}
          <Line label={t("settings.llmModel")}>
            <select
              data-cli-model
              value={cliModel}
              onChange={(e) => setCliModel(e.target.value)}
              style={{ ...field, flex: 1 }}
            >
              {/* ★기억해 둔 값이 목록에 없어도 자리를 남긴다 — 없으면 셀렉트가 멋대로
                  첫 항목을 보여 주면서 실제로 넘기는 값은 그대로라 둘이 어긋난다 */}
              {(cliModels.includes(cliModel) || !cliModel ? cliModels : [cliModel, ...cliModels]).map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </Line>
          <Line label={t("settings.reasoning")}>
            <select
              data-cli-effort
              value={cliEffort}
              onChange={(e) => setCliEffort(e.target.value)}
              style={{ ...field, flex: 1 }}
            >
              {CLI_EFFORTS.map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
            </select>
          </Line>
          <AskForModel url={cfg?.support ?? ""} />
          {/* ★CLI 안내 상자를 걷었다 (사용자 지시 2026-08-20) — 무엇이 열리고 어떻게
              인증하는지는 그 CLI 를 쓰는 사람이 이미 아는 것이라 자리만 먹었다. */}
        </>
      ) : (
        <>
          <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--sp-2)" }}>
            {(cfg?.providers ?? []).map((pv) => (
              <Chip
                key={pv.id}
                on={cfg?.provider === pv.id}
                onClick={() => {
                  setVerdict("");
                  void saveLlm({ provider: pv.id });
                }}
                mark={`llm-${pv.id}`}
              >
                {/* ★키가 든 공급자에 점을 켠다 — 어디까지 넣어 뒀는지 한눈에 */}
                <span
                  data-llm-haskey={pv.hasKey ? "" : undefined}
                  style={{
                    display: "inline-block",
                    width: 6,
                    height: 6,
                    borderRadius: 3,
                    marginRight: 6,
                    background: pv.hasKey ? "var(--ok)" : "var(--line-strong)",
                  }}
                />
                {pv.label}
              </Chip>
            ))}
          </div>
          {/* ★고를 수 있는 것은 **명세를 아는 모델**뿐이다 (사용자 결정 2026-08-08).
              직접 입력을 두면 그 모델이 어떤 추론 규격인지 알 수 없어 조용히 400 이 난다 —
              실제로 버텍스 2.5 계열에서 그렇게 깨질 뻔했다. 목록 밖은 아예 못 고른다. */}
          <Line label={t("settings.llmModel")}>
            <select
              data-llm-model
              value={model}
              disabled={!list.length}
              onChange={(e) => {
                setModel(e.target.value);
                void saveLlm({ model: e.target.value });
                setVerdict("");
              }}
              style={{ ...field, flex: 1, opacity: list.length ? 1 : 0.6 }}
            >
              {/* ★쓰던 모델이 목록에 없어도 사라지지 않게 맨 위에 남긴다 (설정을 말없이 바꾸지 않는다) */}
              {model && !list.some((m) => m.id === model) && <option value={model}>{model}</option>}
              {!model && (
                <option value="">
                  {/* ★힌트 모델 이름을 여기 적지 않는다 — 고른 것처럼 보이는데 빈 값이었다 (2026-08-30) */}
                  {loading ? t("settings.loading") : list.length ? t("settings.modelPick") : t("settings.modelNeedKey")}
                </option>
              )}
              {list.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.id}
                  {m.in ? `  ·  $${m.in}/M` : ""}
                  {m.vision ? "  ·  vision" : ""}
                </option>
              ))}
            </select>
            <button data-llm-models onClick={() => void loadModels(undefined, true)} disabled={loading} style={btn}>
              {loading ? t("settings.loading") : t("settings.refresh")}
            </button>
          </Line>
          {listErr && (
            <span data-llm-models-err style={{ fontSize: "var(--text-2xs)", color: "var(--ink-faint)" }}>
              {listErr}
            </span>
          )}
          <AskForModel url={cfg?.support ?? ""} />
          {/* 추론 강도 — ★단계는 **모델이 알려 준 것**만 보여 준다 (모델마다 다르다) */}
          {efforts.length > 0 && (
            <Line label={t("settings.reasoning")}>
              <select
                data-llm-effort
                value={effort}
                onChange={(e) => {
                  setEffort(e.target.value);
                  void saveLlm({ effort: e.target.value });
                }}
                style={{ ...field, flex: 1 }}
              >
                <option value="">
                  {t("settings.effortDefault")}
                  {picked?.effortDefault ? `  ·  ${picked.effortDefault}` : ""}
                </option>
                {efforts.map((v) => (
                  <option key={v} value={v}>
                    {v}
                  </option>
                ))}
                {/* 끌 수 없는 모델에는 끄기 칸을 아예 안 만든다 — 보내면 모델이 거부한다 */}
                {!picked?.reasoningLocked && <option value="none">{t("settings.effortOff")}</option>}
              </select>
            </Line>
          )}
          <div style={{ display: "flex", alignItems: "center", gap: "var(--sp-2)" }}>
            {/* ★키를 어디에 두는지는 **`?` 안에** 있다 (사용자 지시 2026-08-19) */}
            <Help tip={t("settings.llmHint")} />
            <input
              data-llm-key
              type="password"
              value={key}
              placeholder={cfg?.hasKey ? t("settings.keySet") : t("settings.keyEmpty")}
              onChange={(e) => setKey(e.target.value)}
              style={{ ...field, flex: 1 }}
            />
            <button
              data-llm-save
              onClick={() => {
                const next = key.trim();
                setKey("");
                setVerdict("");
                /* ★★저장이 끝나면 **모델 목록을 다시 받는다** (사용자 지적 2026-08-30: 틀린 키를
                     넣었다가 맞는 키로 바꿔 저장해도 오류 문구가 그대로였다). 목록은 공급자·
                     「키 있음」이 바뀔 때만 다시 받는데, 틀린 키도 「있음」이라 바뀐 것이 없었다 —
                     키의 **내용**이 바뀐 것은 여기서만 안다. */
                void saveLlm({ key: next, model }).then(() => loadModels(undefined, true));
              }}
              disabled={!key.trim()}
              style={btn}
            >
              {t("settings.save")}
            </button>
            {/* ★탐지와 달리 이것은 공짜가 아니다 — 누를 때만 부른다 (토큰 몇 개) */}
            <button data-llm-verify onClick={() => void runVerify()} disabled={!cfg?.hasKey || verifying} style={btn}>
              {verifying ? t("settings.verifying") : t("settings.verify")}
            </button>
          </div>
          {verdict && (
            <span
              data-llm-verdict={verdict === "ok" ? "ok" : "fail"}
              style={{
                fontSize: "var(--text-2xs)",
                color: verdict === "ok" ? "var(--ok)" : "var(--err)",
                wordBreak: "break-all",
              }}
            >
              {verdict === "ok" ? t("settings.verifyOk") : verdict}
            </span>
          )}
        </>
      )}
    </div>
  );
}

function ModeTab({
  on,
  mark,
  title,
  sub,
  onClick,
}: {
  on: boolean;
  mark: string;
  title: string;
  sub: string;
  onClick: () => void;
}) {
  return (
    <button
      data-engine={mark}
      onClick={onClick}
      style={{
        flex: 1,
        textAlign: "left",
        padding: "6px var(--sp-4)",
        borderRadius: "var(--r-2)",
        border: `1px solid ${on ? "var(--accent)" : "var(--line)"}`,
        background: on ? "var(--accent-bg)" : "var(--panel)",
      }}
    >
      <span
        style={{
          display: "block",
          fontSize: "var(--text-2xs)",
          fontWeight: "var(--w-semi)",
          color: on ? "var(--ink)" : "var(--ink-soft)",
        }}
      >
        {title}
      </span>
      <span style={{ display: "block", fontSize: "var(--text-2xs)", color: "var(--ink-faint)" }}>{sub}</span>
    </button>
  );
}

const Line = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <div style={{ display: "flex", alignItems: "center", gap: "var(--sp-2)" }}>
    <span style={{ width: 54, flexShrink: 0, fontSize: "var(--text-2xs)", color: "var(--ink-faint)" }}>
      {label}
    </span>
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

const field: React.CSSProperties = {
  minWidth: 0,
  background: "var(--panel)",
  border: "1px solid var(--line)",
  borderRadius: "var(--r-2)",
  padding: "4px var(--sp-3)",
  fontSize: "var(--text-2xs)",
  fontFamily: "var(--font-mono)",
};

/* ★단추 모양은 **설정 화면의 것을 그대로 쓴다** (`Settings` 에서 들여온다).
   여기 같은 값을 한 벌 더 두고 있었는데, 한쪽만 고쳐지면 같은 자리의 단추가
   서로 다르게 보인다 — 이 파일 머리의 「같은 모양을 두 벌 만들지 않는다」와 어긋났다. */
