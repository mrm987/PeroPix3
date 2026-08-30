import { composing } from "../lib/ime";
import { TYPE } from "../styles/type";
import { useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "../i18n";
import { useLlm, type Ask, type Confirm, type Line } from "../store/llm";
import { chatBlocks, type Blk, type Seg } from "../lib/chatMd";
import { useWs } from "../store/workspace";
import { useUi, MODES } from "../store/ui";
import { useCli, CLI_EFFORTS } from "../store/cli";
import { atLabel, openAt } from "../lib/agentAt";
import { Icon } from "../components/Icon";

/** AI 채팅 — **반복 작업을 말로 시키는 자리** (ui-guide 7절 「LLM 개입면」).
 *
 *  ★**수동 UI 가 정본이고 LLM 은 같은 것을 고칠 뿐이다** (renewal/README 5항).
 *    그래서 도구는 화면이 쓰는 스토어를 그대로 쓴다 — 고치면 화면이 곧바로 따라 바뀐다.
 *  ★**지금 보고 있는 것**을 머리에 한 줄로 건다. "무엇을 알고 있는지" 를 사용자가 눈으로
 *    확인할 수 있어야 시킬 말을 정할 수 있다 (Studio 의 `crumb` 과 같은 장치).
 *  ★스트리밍이 아니라 **도구 줄**로 진행을 보인다 — 무엇을 만졌는지가 글자보다 중요하다. */
/** **도는 중임을 알리는 표시** — 점 셋이 차례로 밝아지고, 경과 시간이 흐른다.
 *
 *  ★★사용자 지적 2026-08-25: *"ai가 작업중인 동적인 표시가 필요함. 멈춘 건지 작업 중인지
 *    알 수 없음."* 예전에는 「일하는 중…」 글자 하나였다 — 화면이 멎은 것과 구분이 안 됐다.
 *  ★**경과 시간이 진짜 신호다.** 점은 CSS 로 도니까 자바스크립트가 멈춰도 계속 움직이지만,
 *    초가 올라가는 것은 앱이 살아 있다는 뜻이다.
 *  ★마지막으로 부른 도구 이름을 함께 낸다 — 무엇을 하느라 오래 걸리는지가 보인다. */
function Working({ last }: { last?: string }) {
  const t = useI18n((s) => s.t);
  /* ★★**시작 시각은 스토어가 든다** (`useLlm.turnAt`, 사용자 지적 2026-08-26).
     화면이 들면 패널을 접었다 펼 때마다 컴포넌트가 새로 서면서 0 부터 다시 세어,
     한참 돌던 턴이 **막 시작한 것처럼** 보인다. */
  const at = useLlm((s) => s.turnAt);
  const [sec, setSec] = useState(0);
  useEffect(() => {
    const tick = () => setSec(at ? Math.max(0, Math.floor((Date.now() - at) / 1000)) : 0);
    tick();
    const h = setInterval(tick, 1000);
    return () => clearInterval(h);
  }, [at]);
  return (
    <div
      data-ai-working
      style={{ display: "flex", alignItems: "center", gap: 6, ...TYPE.meta, color: "var(--ink-faint)" }}
    >
      <span style={{ display: "flex", gap: 3 }}>
        {[0, 1, 2].map((i) => (
          <span
            key={i}
            className="think-dot"
            style={{ width: 4, height: 4, borderRadius: "50%", background: "var(--accent)" }}
          />
        ))}
      </span>
      <span>{last || t("ai.working")}</span>
      <span style={{ color: "var(--ink-ghost)" }}>{t("ai.elapsed", { s: String(sec) })}</span>
    </div>
  );
}

export function AiChat({ onOpenSettings }: { onOpenSettings: () => void }) {
  const t = useI18n((s) => s.t);
  // `id` = 지금 열려 있는 대화 (목록에서 어느 줄이 지금 것인지 표시)
  const { cfg, lines, wire, sending, error, ask, confirm, list, id: cur, title: chatTitle, cliSessionGone,
          loadConfig, restore, send, stop, newChat, open, remove } = useLlm();
  const [showList, setShowList] = useState(false);
  /* ★지난 대화 목록은 **밖을 누르면 닫힌다** (사용자 지시 2026-08-29: *"다시 버튼을 눌러야만
     닫힘"*). 목록 자신과 여는 버튼 안쪽 클릭은 예외다 — 버튼까지 잡으면 토글이 두 번 돌아
     닫히자마자 다시 열린다. */
  useEffect(() => {
    if (!showList) return;
    const onDown = (e: PointerEvent) => {
      const el = e.target as HTMLElement;
      if (el.closest("[data-ai-history]") || el.closest("[data-ai-list]")) return;
      setShowList(false);
    };
    window.addEventListener("pointerdown", onDown);
    return () => window.removeEventListener("pointerdown", onDown);
  }, [showList]);
  const { engine, exe, scanning, detect } = useCli();
  const ws = useWs((s) => s.current);
  const tab = useWs((s) => s.activeSceneGroup());
  const wsTab = useWs((s) => s.activeTabOf());

  const mode = useUi((s) => s.mode);
  const [text, setText] = useState("");
  const end = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLTextAreaElement>(null);
  // ★내용에 맞춰 높이를 다시 잰다. `auto` 로 되돌리지 않으면 **줄어들지 않는다**
  //   (scrollHeight 가 지금 높이에 갇힌다).
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    el.style.height = "auto";
    // ★`box-sizing: border-box` 라 높이에 **테두리까지** 포함해야 한다. 그냥 scrollHeight 를
    //   넣으면 내용이 테두리 두께만큼 넘쳐서 스크롤바가 생긴다 (실측 2026-08-08).
    el.style.height = el.scrollHeight + (el.offsetHeight - el.clientHeight) + "px";
  }, [text]);

  useEffect(() => {
    void loadConfig();
    // ★껐다 켜도 하던 이야기가 이어진다 (사용자 요청 2026-08-07)
    void restore();
    // 탐지는 공짜다 — 열 때마다 다시 봐서 "그새 깔았다"를 놓치지 않는다
    void detect();
  }, [loadConfig, restore, detect]);

  /* ★★**물음·승인 카드가 뜨면 그리로 따라간다** (사용자 지적 2026-08-26: *"ask 가 떴을 때
     하단으로 자동 스크롤을 안 해 줘서 선택지가 가려져 있음"*). 줄 수가 안 늘고 **카드만**
     뜨는 경우라, 딸림값이 `lines.length` 뿐이면 화면이 그대로 있는다. */
  useEffect(() => {
    end.current?.scrollIntoView({ block: "end" });
  }, [lines.length, sending, ask, confirm]);

  // ★도는 중에도 말을 걸 수 있다 (사용자 지시 2026-08-15) — 줄은 바로 뜨고, 지금 턴이
  //   끝나는 대로 이어서 처리된다. 그래서 `sending` 으로 막지 않는다.
  const submit = () => {
    const v = text.trim();
    if (!v) return;
    setText("");
    void send(v);
  };

  const modeLabel = MODES.find((m) => m.id === mode)?.label ?? mode;
  /** 조수가 보고 있는 곳 — ★**탭까지** 넣는다 (사용자 지적 2026-08-25: 이 줄에 탭이 빠져
   *  있었다). 화면에는 안 보이고 툴팁으로만 나간다. */
  const route = [ws || "—", modeLabel, wsTab?.name, tab?.name].filter(Boolean).join(" · ");
  // ★엔진마다 "준비됨"의 뜻이 다르다: API 는 키, CLI 는 몰 수 있는 실행 파일
  const ready = engine === "cli" ? !!exe : !!cfg?.hasKey;
  const noCli = engine === "cli" && !exe && !scanning;
  /** 지금 **실제로 돌고 있는 도구** — 부름(`tool_use`)은 갔는데 **결과가 아직 안 온 것**이다.
   *
   *  ★★사용자 지적 2026-08-26: 화면에 「generate 275초」가 떠서 **생성이 275초째 걸린 줄로**
   *    읽혔는데, 실제로는 그 도구가 이미 끝났고(백엔드 큐는 비어 있었다) 기다리는 것은
   *    **모델의 다음 말**이었다. 끝난 도구의 이름을 띄우면 그것이 도는 것처럼 읽힌다.
   *  ★그래서 **결과가 없는 부름**만 이름을 낸다. 없으면 이름 없이 「일하는 중」만 띄운다 —
   *    그때 기다리는 것은 도구가 아니라 모델이기 때문이다. */
  const inFlight = (() => {
    if (!sending) return undefined;
    const done = new Set<string>();
    for (const m of wire)
      for (const b of m.content) if (b.type === "tool_result") done.add(b.tool_use_id);
    for (let i = wire.length - 1; i >= 0; i--)
      for (const b of [...wire[i].content].reverse())
        if (b.type === "tool_use" && !done.has(b.id)) return b.name;
    return undefined;
  })();

  return (
    <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
      {/* 지금 대화 — 이름과 엔진·모델 표시가 한 줄에 앉는다 */}
      <div
        data-ai-context
        data-tip={t("ai.contextAt", { at: route })}
        style={{
          flexShrink: 0,
          display: "flex",
          alignItems: "center",
          gap: "var(--sp-2)",
          padding: "4px var(--sp-4)",
          borderBottom: "1px solid var(--line)",
          /* ★★**딱지 층이다** (사용자 지시 2026-08-25). 대화 이름을 조용히
             알리는 줄이라, 아래의 엔진·모델 표시와 **같은 층**으로 읽혀야 한다. */
          ...TYPE.eyebrow,
          color: "var(--ink-faint)",
          whiteSpace: "nowrap",
          overflow: "hidden",
        }}
      >
        {/* ★★**대화 이름을 보인다** (사용자 지시 2026-08-25: *"저 위치에 사실 유저는 저
             루트를 볼 필요가 없으니까 표시하지 말고 현재 채팅방 제목을 띄우는 게 낫다"*).
             ★경로는 없어지지 않고 **툴팁으로 내려갔다** — 조수가 어디를 보고 있는지는
               가끔 확인할 일이 있다. 거기에는 빠져 있던 **탭**도 넣는다 (같은 지적). */}
        <span
          style={{
            color: "var(--ink-dim)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {chatTitle || t("ai.newChatTitle")}
        </span>
        <span style={{ flex: 1 }} />
        {/* ★지금 무엇으로 도는가 — 누르면 설정이 열린다 */}
        <button
          data-ai-engine={engine}
          onClick={onOpenSettings}
          data-tip={t("ai.engineHint")}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 4,
            padding: "0 4px",
            color: ready ? "var(--ink-dim)" : "var(--warn)",
            ...TYPE.eyebrow,
          }}
        >
          <span
            style={{
              width: 6,
              height: 6,
              borderRadius: "50%",
              background: ready ? "var(--ok)" : "var(--warn)",
            }}
          />
          {engine === "cli" ? "CLI" : "API"}
        </button>
        <button
          data-ai-list
          onClick={() => setShowList((v) => !v)}
          data-tip={t("ai.history")}
          style={{ color: showList ? "var(--accent-ink)" : "var(--ink-faint)", display: "grid" }}
        >
          {Icon.folder}
        </button>
        {lines.length > 0 && (
          <button
            data-ai-new
            onClick={newChat}
            disabled={sending}
            data-tip={sending ? t("ai.busyLock") : t("ai.reset")}
            style={{ color: sending ? "var(--ink-ghost)" : "var(--ink-faint)", display: "grid" }}
          >
            {Icon.plus}
          </button>
        )}
      </div>

      {/* 지난 대화 — ★고르면 그 자리에서 열린다 (재실행 뒤에도 남아 있다) */}
      {showList && (
        <div
          data-ai-history
          style={{
            flexShrink: 0,
            maxHeight: 220,
            overflowY: "auto",
            borderBottom: "1px solid var(--line)",
            background: "var(--panel)",
          }}
        >
          {list.length === 0 && (
            <div style={{ padding: "var(--sp-3) var(--sp-4)", fontSize: "var(--text-2xs)", color: "var(--ink-ghost)" }}>
              {t("ai.noHistory")}
            </div>
          )}
          {sending && (
            <div
              data-ai-locked
              style={{
                padding: "var(--sp-2) var(--sp-4)",
                fontSize: "var(--text-2xs)",
                color: "var(--ink-faint)",
                borderBottom: "1px solid var(--line-soft)",
              }}
            >
              {t("ai.busyLock")}
            </div>
          )}
          {list.map((c) => (
            <div
              key={c.id}
              data-ai-chat={c.id}
              data-locked={sending ? "" : undefined}
              data-tip={sending ? t("ai.busyLock") : undefined}
              onClick={() => {
                if (sending) return; // ★돌던 응답이 그 대화에 붙는다
                void open(c.id);
                setShowList(false);
              }}
              style={{
                display: "flex",
                alignItems: "center",
                gap: "var(--sp-2)",
                padding: "4px var(--sp-4)",
                cursor: "pointer",
                fontSize: "var(--text-2xs)",
                color: c.id === cur ? "var(--ink)" : "var(--ink-soft)",
                background: c.id === cur ? "var(--accent-bg)" : undefined,
              }}
            >
              <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {c.title || t("ai.untitled")}
              </span>
              {/* ★대화는 전역이지만 **어디서 시작했는지**는 보인다 (사용자 결정 2026-08-08) */}
              {c.workspace && c.workspace !== ws && (
                <span
                  data-ai-chat-ws={c.workspace}
                  style={{
                    flexShrink: 0,
                    maxWidth: 90,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                    color: "var(--ink-ghost)",
                  }}
                >
                  {c.workspace}
                </span>
              )}
              <span style={{ flexShrink: 0, color: "var(--ink-ghost)", fontFamily: "var(--font-mono)" }}>
                {c.updatedAt.slice(5, 10)}
              </span>
              <button
                data-ai-chat-del={c.id}
                onClick={(e) => {
                  e.stopPropagation();
                  void remove(c.id);
                }}
                data-tip={t("common.delete")}
                style={{ flexShrink: 0, color: "var(--ink-faint)", display: "grid" }}
              >
                {Icon.close12}
              </button>
            </div>
          ))}
        </div>
      )}

      {/* 대화 */}
      <div
        data-ai-lines
        style={{
          flex: 1,
          minHeight: 0,
          overflowY: "auto",
          padding: "var(--sp-4)",
          display: "flex",
          flexDirection: "column",
          gap: "var(--sp-3)",
        }}
      >
        {/* CLI 인데 몰 수 있는 것이 없다 — 설치 안내 (스튜디오의 연결 가이드와 같은 자리) */}
        {noCli && (
          <div style={guide}>
            {t("ai.noCli")}
            <code style={{ fontFamily: "var(--font-mono)", color: "var(--ink-soft)" }}>
              npm i -g @anthropic-ai/claude-code
            </code>
            <span style={{ display: "flex", gap: "var(--sp-2)" }}>
              <button data-ai-rescan onClick={() => void detect()} style={guideBtn}>
                {t("settings.rescan")}
              </button>
              <button data-ai-settings onClick={onOpenSettings} style={guideBtn}>
                {t("ai.openSettings")}
              </button>
            </span>
          </div>
        )}
        {engine === "api" && !cfg?.hasKey && (
          <div style={guide}>
            {t("ai.noKey")}
            <button
              data-ai-settings
              onClick={onOpenSettings}
              style={{
                border: "1px solid var(--line)",
                borderRadius: "var(--r-2)",
                background: "var(--panel)",
                color: "var(--ink-soft)",
                padding: "3px var(--sp-4)",
                fontSize: "var(--text-2xs)",
              }}
            >
              {t("ai.openSettings")}
            </button>
          </div>
        )}
        {lines.length === 0 && ready && (
          <div style={{ fontSize: "var(--text-2xs)", color: "var(--ink-ghost)", lineHeight: 1.7 }}>
            {t("ai.empty")}
          </div>
        )}
        {lines.map((l, i) => (
          <Row key={i} line={l} />
        ))}
        {ask && <AskCard ask={ask} />}
        {confirm && <ConfirmCard c={confirm} />}
        {sending && <Working last={inFlight} />}
        {/* ★없어진 세션은 **열자마자** 알린다 (사용자 지시 2026-08-12) — 말을 걸어 실패를
            겪고 나서 알게 되지 않도록. claude 는 기본 30일이 지난 기록을 지운다. */}
        {cliSessionGone && !error && (
          <div style={{ display: "grid", gap: "var(--sp-2)", justifyItems: "start" }}>
            <Row line={{ kind: "error", text: t("ai.cliSessionGone") }} />
            {/* ★이어서 말을 걸 수 없는 대화다 — 갈 곳을 여기서 준다 (사용자 지시 2026-08-12) */}
            <button
              data-ai-gone-new
              onClick={newChat}
              disabled={sending}
              style={{
                fontSize: "var(--text-2xs)",
                color: "var(--ink)",
                border: "1px solid var(--line)",
                borderRadius: "var(--r-2)",
                padding: "var(--sp-1) var(--sp-3)",
              }}
            >
              {t("ai.cliSessionGoneNew")}
            </button>
          </div>
        )}
        {/* ★오류는 대화에 안 담는다 — 다음 턴에 공급자로 되돌아가면 또 걸린다 */}
        {error && <Row line={{ kind: "error", text: error }} />}
        <div ref={end} />
      </div>

      {/* 입력 */}
      <div
        style={{
          flexShrink: 0,
          borderTop: "1px solid var(--line)",
          padding: "var(--sp-3)",
          display: "flex",
          flexDirection: "column",
          gap: "var(--sp-2)",
        }}
      >
        {/* ★줄바꿈하면 **스크롤이 아니라 칸이 늘어난다** (사용자 지시 2026-08-08) —
            쓴 것이 한눈에 다 보여야 고치기 쉽다. 45vh 를 넘어가야 그때 스크롤이 생긴다
            (안 그러면 긴 글을 붙여 넣었을 때 대화가 통째로 가려진다). */}
        <textarea
          ref={box}
          data-ai-input
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            /* ★★**조합 중의 Enter 는 글자를 맺는 것이지 보내는 것이 아니다**
                 (사용자 지적 2026-08-25: *"보내기 버튼이 중단으로 변경 안 됨"*).
               한글을 치면 마지막 음절이 **조합 중**인 채로 Enter 가 온다. 그대로 보내면
               입력칸을 비운 **뒤에** 그 음절이 맺히면서 다시 들어와, 칸이 비지 않는다.
               단추는 「도는 중 + 칸이 비었을 때」만 「중단」이 되므로 **영영 「보내기」로
               남고, 멈출 방법이 없어진다.** 보내진 글에서도 끝 음절이 잘려 나간다.
               ★`isComposing` 을 못 주는 옛 브라우저는 `keyCode 229` 로 같은 것을 말한다. */
            if (e.key === "Enter" && !e.shiftKey && !composing(e)) {
              e.preventDefault();
              submit();
            }
          }}
          rows={1}
          placeholder={t("ai.placeholder")}
          style={{
            width: "100%",
            resize: "none",
            overflowY: "auto",
            maxHeight: "45vh",
            background: "var(--panel)",
            border: "1px solid var(--line)",
            borderRadius: "var(--r-2)",
            padding: "var(--sp-2) var(--sp-3)",
            fontSize: "var(--text-2xs)",
            lineHeight: 1.5,
          }}
        />
        <div style={{ display: "flex", alignItems: "center", gap: "var(--sp-2)" }}>
          <ModelChip onOpenSettings={onOpenSettings} />
          <span style={{ flex: 1 }} />
          {/* ★단추는 **하나**다 (사용자 지시 2026-08-15, CLI 들이 하는 방식).
              평소엔 보내기 · 도는 중엔 정지 · 도는 중에 **뭔가 치면 다시 보내기**.
              둘을 나란히 두면 도는 동안 어느 쪽을 누를지가 매번 판단거리가 된다. */}
          {sending && !text.trim() ? (
            <button data-ai-stop onClick={stop} style={sendBtn}>
              {t("ai.stop")}
            </button>
          ) : (
            <button
              data-ai-send
              onClick={submit}
              disabled={!text.trim()}
              // 도는 중에 보내면 곧바로 안 가고 이 턴이 끝난 뒤에 간다 — 그것을 미리 알린다
              data-tip={sending ? t("ai.queue") : undefined}
              style={sendBtn}
            >
              {t("ai.send")}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/** 지금 무엇으로 도는가 — **보내기 바로 옆에서 보고 바꾼다** (사용자 지시 2026-08-08).
 *
 *  ★값을 여기 따로 담지 않는다. 설정 화면과 **같은 스토어·같은 저장 경로**를 쓰므로
 *    두 화면이 어긋날 수 없다 (CLAUDE.md: 하나의 정보에는 하나의 창구).
 *  ★엔진에 따라 보는 곳이 다르다 — CLI 는 `useCli`(로컬 설정), API 는 `useLlm`(백엔드 설정). */
function ModelChip({ onOpenSettings }: { onOpenSettings?: () => void }) {
  const t = useI18n((s) => s.t);
  const [open, setOpen] = useState(false);
  const cfg = useLlm((s) => s.cfg);
  const models = useLlm((s) => s.models);
  const loadModels = useLlm((s) => s.loadModels);
  const saveLlm = useLlm((s) => s.saveConfig);
  const { engine, model: cliModel, effort: cliEffort, setModel: setCliModel, setEffort: setCliEffort } = useCli();
  // ★고른 CLI 가 받는 모델만 보여 준다 (`items` 가 실어 온다)
  const cliModels = useCli((c) => c.models());
  const cli = engine === "cli";

  // ★"기본값"이라고만 적으면 그게 뭔지 알 수 없다 (사용자 지적 2026-08-08) —
  //   클로드 코드의 설정에서 읽어 온 실제 값을 괄호로 붙인다. 모르면 안 붙인다.
  const name = cli ? cliModel : cfg?.model || "—";
  const eff = cli ? cliEffort : cfg?.effort;
  const picked = models.find((m) => m.id === cfg?.model);
  const efforts = cli ? CLI_EFFORTS : (picked?.efforts ?? []);

  useEffect(() => {
    if (open && !cli && !models.length) void loadModels();
  }, [open, cli, models.length, loadModels]);

  const short = name.includes("/") ? name.slice(name.indexOf("/") + 1) : name;
  return (
    <div style={{ position: "relative", minWidth: 0 }}>
      <button
        data-ai-model
        onClick={() => setOpen((v) => !v)}
        data-tip={`${cli ? "CLI" : cfg?.provider ?? ""} · ${name}${eff ? " · " + eff : ""}`}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 4,
          maxWidth: 190,
          padding: "3px var(--sp-2)",
          borderRadius: "var(--r-2)",
          border: `1px solid ${open ? "var(--accent)" : "var(--line)"}`,
          background: open ? "var(--accent-bg)" : "transparent",
          color: "var(--ink-dim)",
          /* ★★**엔진 표시와 짝이라 같은 층**이다 (`TYPE.eyebrow`, 사용자 지적 2026-08-25).
             한때 이것만 `meta`(12px)로 올라가 위의 `● CLI`(딱지)와 크기가 갈렸다 —
             둘은 「지금 무엇으로 도는가」를 위아래에서 나눠 말하는 한 쌍이다. */
          ...TYPE.eyebrow,
          whiteSpace: "nowrap",
        }}
      >
        <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{short}</span>
        {eff && <span style={{ color: "var(--ink-faint)", flexShrink: 0 }}>· {eff}</span>}
      </button>

      {open && (
        <>
          {/* 바깥을 누르면 닫힌다 */}
          <div onPointerDown={() => setOpen(false)} style={{ position: "fixed", inset: 0, zIndex: 60 }} />
          <div
            data-ai-model-pop
            style={{
              position: "absolute",
              bottom: "calc(100% + 6px)",
              left: 0,
              zIndex: 61,
              width: 248,
              display: "grid",
              gap: "var(--sp-2)",
              padding: "var(--sp-3)",
              background: "var(--panel)",
              border: "1px solid var(--line)",
              borderRadius: "var(--r-3)",
              boxShadow: "var(--shadow-3)",
            }}
          >
            <Field label={t("settings.llmModel")}>
              {cli ? (
                <select
                  data-ai-model-pick
                  value={cliModel}
                  onChange={(e) => setCliModel(e.target.value)}
                  style={popField}
                >
                  {/* ★목록은 고른 CLI 것이다. 기억해 둔 값이 목록에 없어도 자리를 남긴다 */}
                  {(cliModels.includes(cliModel) || !cliModel
                    ? cliModels
                    : [cliModel, ...cliModels]
                  ).map((m) => (
                    <option key={m} value={m}>{m}</option>
                  ))}
                </select>
              ) : (
                <select
                  data-ai-model-pick
                  value={cfg?.model ?? ""}
                  disabled={!models.length}
                  onChange={(e) => void saveLlm({ model: e.target.value })}
                  style={popField}
                >
                  {cfg?.model && !models.some((m) => m.id === cfg.model) && (
                    <option value={cfg.model}>{cfg.model}</option>
                  )}
                  {!cfg?.model && (
                    <option value="">{models.length ? t("settings.modelPick") : t("settings.modelNeedKey")}</option>
                  )}
                  {models.map((m) => (
                    <option key={m.id} value={m.id}>{m.id}</option>
                  ))}
                </select>
              )}
            </Field>
            {/* ★단계는 그 모델이 받는 것만 — 목록이 없으면 칸 자체를 안 낸다 */}
            {efforts.length > 0 && (
              <Field label={t("settings.reasoning")}>
                <select
                  data-ai-effort-pick
                  value={eff ?? ""}
                  onChange={(e) => (cli ? setCliEffort(e.target.value) : void saveLlm({ effort: e.target.value }))}
                  style={popField}
                >
                  {!cli && <option value="">{t("settings.effortDefault")}</option>}
                  {efforts.map((v) => (
                    <option key={v} value={v}>{v}</option>
                  ))}
                </select>
              </Field>
            )}
            <button
              data-ai-model-more
              onClick={() => {
                setOpen(false);
                onOpenSettings?.();
              }}
              style={{ justifySelf: "start", fontSize: "var(--text-2xs)", color: "var(--accent-ink)", textDecoration: "underline" }}
            >
              {t("settings.title")}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

const popField: React.CSSProperties = {
  width: "100%",
  background: "var(--surface)",
  border: "1px solid var(--line)",
  borderRadius: "var(--r-2)",
  padding: "3px var(--sp-2)",
  fontSize: "var(--text-2xs)",
};

const Field = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <label style={{ display: "grid", gap: 3 }}>
    <span style={{ fontSize: "calc(0.58rem * var(--text-scale))", color: "var(--ink-faint)", textTransform: "uppercase", letterSpacing: "0.06em" }}>
      {label}
    </span>
    {children}
  </label>
);

/** 조수의 말을 **마크다운 그대로 보이게** 그린다 (사용자 지적 2026-08-25).
 *
 *  ★규칙은 `lib/chatMd` 에 순수 함수로 있다 (회귀가 붙어 있다) — 여기서는 **그리기만** 한다.
 *  ★`dangerouslySetInnerHTML` 을 안 쓴다: 조각 목록을 받아 React 요소로 만든다. */
/** 아스키(영문·숫자·기호)뿐인가 — 고정폭 글꼴을 씌워도 되는지 가른다.
 *  ★`--font-mono` 는 토큰 주석 그대로 **영문·숫자 자리에만** 쓴다 (Consolas 에 한글이 없다). */
const isAscii = (v: string) => /^[ -~]*$/.test(v);

function Md({ text }: { text: string }) {
  /* ★굵기는 **토큰**을 쓴다 (`--w-bold` = 620). 700 은 한글 획이 겹친다 —
     굵기 상한을 한 단 낮춰 잡은 까닭이 `styles/tokens.css` 굵기 절에 있다. */
  const blocks = useMemo(() => chatBlocks(text), [text]);
  const draw = (segs: Seg[], key: number) => (
    <span key={key}>
      {segs.map((s, i) =>
        s.t === "b" ? (
          <strong key={i} style={{ fontWeight: "var(--w-bold)" }}>{s.v}</strong>
        ) : s.t === "code" ? (
          <code
            key={i}
            style={{
              /* ★★**한글에는 고정폭 글꼴을 안 씌운다** (사용자 지적 2026-08-25: *"왜 이렇게
                 글씨가 깨지지"*). `--font-mono` 는 토큰 주석 그대로 **영문·숫자 자리에만**
                 쓰는 것이다 — Consolas 에 한글 글립이 없어, 한글이 섞이면 글자마다 다른
                 글꼴로 떨어져 **줄이 들쭉날쭉해진다.**
                 ★조수는 태그(`long hair`)만이 아니라 이름(`키키`)도 백틱으로 감싼다.
                   그래서 **내용을 보고** 정한다: 아스키뿐일 때만 고정폭. */
              fontFamily: isAscii(s.v) ? "var(--font-mono)" : "inherit",
              fontSize: "0.92em",
              background: "var(--panel)",
              border: "1px solid var(--line)",
              borderRadius: "var(--r-1)",
              padding: "0 3px",
            }}
          >
            {s.v}
          </code>
        ) : (
          <span key={i} style={{ whiteSpace: "pre-wrap" }}>{s.v}</span>
        ),
      )}
    </span>
  );
  return (
    <>
      {blocks.map((b: Blk, i: number) =>
        b.k === "li" ? (
          // ★들여쓰기와 점은 **그림으로** — 원문의 `- ` 를 그대로 두면 줄이 안 맞는다
          <div key={i} style={{ display: "flex", gap: 6, paddingLeft: 2 }}>
            <span style={{ color: "var(--ink-faint)", flexShrink: 0 }}>·</span>
            {draw(b.segs, i)}
          </div>
        ) : b.k === "h" ? (
          // ★크기는 안 키운다 — 채팅 줄에서 제목이 커지면 요란해진다. 굵기로만 가른다
          <div key={i} style={{ fontWeight: "var(--w-bold)", marginTop: i ? 4 : 0 }}>{draw(b.segs, i)}</div>
        ) : (
          <div key={i}>{draw(b.segs, i)}</div>
        ),
      )}
    </>
  );
}

/** **승인 카드** — 되돌릴 수 없는 일 앞에서 뜬다 (사용자 결정 2026-08-24).
 *
 *  ★★모달 확인 창이 아니라 **대화 안**이다: 클로드 코드가 파일 삭제 전에 승인을 받는 것과
 *    같은 모양이라, 왕복이 한 번이고 **무엇을 승인했는지 대화에 남는다.**
 *  ★기다리는 쪽은 도구다 (`lib/approve` 의 `askApprove`) — 답할 때까지 안 끝난다.
 *  ★「되돌릴 수 없음」(`hard`)은 **색으로도** 알린다. 지운 것이 카드·씬이면 되돌리기로도
 *    못 돌아오고(로그를 비운다), 생성이면 Anlas 가 이미 나간다.
 */
function ConfirmCard({ c }: { c: Confirm }) {
  const t = useI18n((s) => s.t);
  const line = c.hard ? "var(--danger, #d9736a)" : "var(--accent)";
  return (
    <div
      data-ai-confirm
      data-ai-hard={c.hard ? "" : undefined}
      style={{
        border: `1px solid ${line}`,
        borderRadius: "var(--r-2)",
        background: "var(--accent-bg)",
        padding: "var(--sp-3)",
        display: "flex",
        flexDirection: "column",
        gap: "var(--sp-2)",
      }}
    >
      <span style={{ ...TYPE.eyebrow, color: line }}>
        {t("ai.confirmHeader")}
      </span>
      <span style={{ fontSize: "var(--text-2xs)", color: "var(--ink)", lineHeight: 1.6 }}>
        {c.title}
      </span>
      {c.body && (
        <span style={{ fontSize: "var(--text-2xs)", color: "var(--ink-faint)", lineHeight: 1.6 }}>
          {c.body}
        </span>
      )}
      <div style={{ display: "flex", gap: "var(--sp-2)" }}>
        <button
          data-ai-approve
          onClick={() => c.answer(true)}
          style={{
            flex: 1,
            border: `1px solid ${line}`,
            borderRadius: "var(--r-2)",
            background: c.hard ? line : "var(--accent)",
            color: "#fff",
            padding: "4px var(--sp-3)",
            fontSize: "var(--text-2xs)",
          }}
        >
          {t("ai.approve")}
        </button>
        <button
          data-ai-deny
          onClick={() => c.answer(false)}
          style={{
            flex: 1,
            border: "1px solid var(--line)",
            borderRadius: "var(--r-2)",
            background: "var(--panel)",
            color: "var(--ink)",
            padding: "4px var(--sp-3)",
            fontSize: "var(--text-2xs)",
          }}
        >
          {t("ai.deny")}
        </button>
      </div>
    </div>
  );
}

/** AI 의 물음 — **답할 때까지 도구가 기다린다** (`ask_user`).
 *
 *  ★취향이 갈리는 자리에서 임의로 고르지 말라는 뜻이라, 답하기 전에는 다음 줄이 안 온다.
 *  ★**다중 선택**은 눌러서 담았다가 「확인」으로 한 번에 보낸다 (사용자 지시 2026-08-08) —
 *    하나짜리는 누르는 즉시 간다. 두 경우의 조작이 달라야 무엇을 고르는지 헷갈리지 않는다. */
function AskCard({ ask }: { ask: Ask }) {
  const t = useI18n((s) => s.t);
  const [picked, setPicked] = useState<string[]>([]);
  /** 고를 것에 없는 답 — 카드 안에서 바로 적는다 (아래 ★★주) */
  const [text, setText] = useState("");
  const multi = !!ask.multi;

  return (
    <div
      data-ai-ask
      data-ai-multi={multi ? "" : undefined}
      style={{
        border: "1px solid var(--accent)",
        borderRadius: "var(--r-2)",
        background: "var(--accent-bg)",
        padding: "var(--sp-3)",
        display: "flex",
        flexDirection: "column",
        gap: "var(--sp-2)",
      }}
    >
      {ask.header && (
        <span style={{ ...TYPE.eyebrow, color: "var(--accent-ink)" }}>
          {ask.header}
        </span>
      )}
      <span style={{ fontSize: "var(--text-2xs)", color: "var(--ink)", lineHeight: 1.6 }}>
        {ask.question}
      </span>

      {ask.options.map((o, i) => {
        const on = picked.includes(o.label);
        return (
          <button
            key={i}
            data-ai-choice={o.label}
            data-on={on ? "" : undefined}
            onClick={() =>
              multi
                ? setPicked((p) => (on ? p.filter((x) => x !== o.label) : [...p, o.label]))
                : ask.answer([o.label])
            }
            style={{
              display: "flex",
              alignItems: "flex-start",
              gap: "var(--sp-2)",
              textAlign: "left",
              border: `1px solid ${on ? "var(--accent)" : "var(--line)"}`,
              borderRadius: "var(--r-2)",
              background: on ? "var(--accent-bg)" : "var(--panel)",
              padding: "4px var(--sp-3)",
            }}
          >
            {/* 여럿 고르는 물음에서만 네모 표시 — 한 개짜리와 조작이 다르다는 것을 알린다 */}
            {multi && (
              <span
                style={{
                  flexShrink: 0,
                  marginTop: 3,
                  width: 11,
                  height: 11,
                  borderRadius: 3,
                  border: `1px solid ${on ? "var(--accent)" : "var(--line-strong)"}`,
                  background: on ? "var(--accent)" : "transparent",
                  display: "grid",
                  placeItems: "center",
                  color: "var(--accent-on)",
                }}
              >
                {on && Icon.check}
              </span>
            )}
            <span style={{ minWidth: 0 }}>
              <span style={{ display: "block", fontSize: "var(--text-2xs)", color: "var(--ink)" }}>
                {o.label}
              </span>
              {o.description && (
                <span style={{ display: "block", fontSize: "var(--text-2xs)", color: "var(--ink-faint)" }}>
                  {o.description}
                </span>
              )}
            </span>
          </button>
        );
      })}

      {/* ★★**직접 적는 칸** (사용자 지적 2026-08-26: *"ask에서 직접입력 항목에 입력란이 없어서
          매번 새로 채팅해서 말해야 함"*). 고를 것에 없는 답이 있을 때 새 대화 줄을 쓰면
          조수는 그것을 **물음의 답이 아니라 새 요청**으로 받는다 — 물음은 답을 못 받은 채 남는다.
          ★여럿 고르기에서는 **고른 것과 함께** 실어 보낸다 (「이것들 + 이것도」가 자연스럽다).
          ★Enter 로도 보낸다 — 한글 조합 중의 Enter 는 거른다 (`lib/ime`). */}
      <div style={{ display: "flex", gap: "var(--sp-2)" }}>
        <input
          data-ai-ask-text
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !composing(e) && text.trim()) {
              e.preventDefault();
              ask.answer(multi ? [...picked, text.trim()] : [text.trim()]);
            }
          }}
          placeholder={t("ai.askOther")}
          style={{
            flex: 1,
            minWidth: 0,
            border: "1px solid var(--line)",
            borderRadius: "var(--r-2)",
            background: "var(--panel)",
            color: "var(--ink)",
            padding: "3px var(--sp-3)",
            fontSize: "var(--text-2xs)",
          }}
        />
        <button
          data-ai-ask-send
          disabled={!text.trim()}
          onClick={() => ask.answer(multi ? [...picked, text.trim()] : [text.trim()])}
          style={{
            flexShrink: 0,
            border: "1px solid var(--line)",
            borderRadius: "var(--r-2)",
            background: text.trim() ? "var(--panel)" : "transparent",
            color: text.trim() ? "var(--ink)" : "var(--ink-ghost)",
            padding: "3px var(--sp-3)",
            fontSize: "var(--text-2xs)",
          }}
        >
          {t("ai.send")}
        </button>
      </div>
      {multi && (
        <button
          data-ai-confirm
          disabled={!picked.length}
          onClick={() => ask.answer(picked)}
          style={{
            alignSelf: "flex-end",
            border: "1px solid var(--accent)",
            borderRadius: "var(--r-2)",
            background: picked.length ? "var(--accent)" : "var(--panel)",
            color: picked.length ? "var(--accent-on)" : "var(--ink-faint)",
            padding: "3px var(--sp-5)",
            fontSize: "var(--text-2xs)",
          }}
        >
          {picked.length ? t("ai.pickN", { n: picked.length }) : t("ai.pickNone")}
        </button>
      )}
    </div>
  );
}

function Row({ line }: { line: Line }) {
  const t = useI18n((s) => s.t);
  if (line.kind === "user")
    return (
      <div
        style={{
          alignSelf: "flex-end",
          maxWidth: "92%",
          background: "var(--accent-bg)",
          border: "1px solid var(--accent-line)",
          borderRadius: "var(--r-2)",
          padding: "var(--sp-2) var(--sp-3)",
          fontSize: "var(--text-chat)",
          fontWeight: "var(--w-normal)",
          lineHeight: 1.6,
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
        }}
      >
        {line.text}
      </div>
    );

  if (line.kind === "ai")
    return (
      <div
        style={{
          fontSize: "var(--text-chat)",
          color: "var(--ink)",
          /* ★★굵기를 **명시**한다 (사용자 지적 2026-08-25: *"응답 전체가 볼드처럼 두꺼워서
             가독성이 떨어짐"*). 본문 폰트가 가변 굵기라(`fonts.css` 의 `font-weight: 45 920`)
             지정을 안 하면 자리마다 다르게 잡힌다 — 여기서 400 으로 못 박는다. */
          fontWeight: "var(--w-normal)",
          lineHeight: 1.7,
          wordBreak: "break-word",
          display: "flex",
          flexDirection: "column",
          gap: 2,
        }}
      >
        <Md text={line.text} />
      </div>
    );

  if (line.kind === "error")
    return (
      <div
        style={{
          fontSize: "var(--text-2xs)",
          color: "var(--err-ink)",
          background: "color-mix(in srgb, var(--err) 10%, transparent)",
          border: "1px solid color-mix(in srgb, var(--err) 35%, var(--line))",
          borderRadius: "var(--r-2)",
          padding: "var(--sp-2) var(--sp-3)",
          wordBreak: "break-word",
          // ★줄바꿈을 살린다 — CLI 가 죽은 까닭(stderr)이 여러 줄로 붙는다 (`llm.ts` 의 exit)
          whiteSpace: "pre-wrap",
        }}
      >
        {line.text}
      </div>
    );

  /* 도구 — ★무엇을 만졌는지가 이 패널의 핵심 정보다.
     ★★**고친 줄은 얼굴이 다르다** (사용자 지시 2026-08-24): 왼쪽에 강조색 띠가 서고 글자가
       안 흐리며, **누르면 그 자리를 연다**. 읽기만 한 줄은 예전 그대로 흐린 한 줄이다.
       가르는 기준은 `at` 이다 — 고치는 도구만 그것을 돌려준다 (`backend/agent.py` `_mark`). */
  const at = line.at;
  return (
    <div
      data-ai-tool={line.name}
      data-ai-did={at ? line.name : undefined}
      data-tip={at ? `${line.note} — ${atLabel(at, t)}` : line.note || undefined}
      onClick={at ? () => void openAt(at) : undefined}
      style={{
        /* ★★**줄바꿈에 들여쓰기를 두지 않는다** (사용자 지시 2026-08-26).
             flex 로 늘어놓으면 넘친 글이 **앞 칸 너비만큼 들여쓰기된 것처럼** 붙는다 —
             좁은 패널에서는 그 들여쓰기가 글보다 넓어 보인다.
           ★그래서 **글 흐름**으로 둔다: 표시·이름·설명이 한 문단처럼 이어지고,
             넘치면 **왼쪽 끝**에서 다시 시작한다. */
        fontSize: "var(--text-2xs)",
        fontFamily: "var(--font-mono)",
        lineHeight: 1.5,
        wordBreak: "break-word",
        color: !line.ok ? "var(--warn)" : at ? "var(--ink-soft)" : "var(--ink-dim)",
        ...(at
          ? {
              cursor: "pointer",
              borderLeft: "2px solid var(--accent)",
              paddingLeft: "var(--sp-2)",
              marginLeft: -2,
            }
          : null),
      }}
    >
      {/* ★표시는 글줄 안에 선다 — `grid` 로 두면 제 줄을 차지한다 */}
      <span
        style={{
          display: "inline-grid",
          verticalAlign: "-0.15em",
          marginRight: 4,
          color: line.ok ? "var(--ok)" : "var(--warn)",
        }}
      >
        {line.ok ? Icon.check : Icon.close12}
      </span>
      <span>{line.name}</span>
      {line.note && (
        <span
          data-ai-tool-did={line.ok ? "" : undefined}
          style={{
            /* ★★**채팅창은 아무것도 안 자른다** (사용자 지시 2026-08-25: *"에딧 내역도 …
                 으로 축소되어 안 보임"*). 무엇을 고쳤는지가 바로 이 줄에 적힌다. */
            // 성공한 것의 설명은 한 단 흐리게 — 실패 문구와 눈으로 갈린다
            //   ★고친 줄은 안 흐리다 (그 줄의 알맹이가 바로 이 문구다)
            color: !line.ok || at ? "inherit" : "var(--ink-faint)",
          }}
        >
          {" "}— {line.note}
        </span>
      )}
      {!line.ok && !line.note && <span> — {t("ai.failed")}</span>}
    </div>
  );
}

const guide: React.CSSProperties = {
  border: "1px dashed var(--line)",
  borderRadius: "var(--r-2)",
  padding: "var(--sp-4)",
  fontSize: "var(--text-2xs)",
  color: "var(--ink-dim)",
  display: "flex",
  flexDirection: "column",
  gap: "var(--sp-2)",
  alignItems: "flex-start",
  lineHeight: 1.6,
};

const guideBtn: React.CSSProperties = {
  border: "1px solid var(--line)",
  borderRadius: "var(--r-2)",
  background: "var(--panel)",
  color: "var(--ink-soft)",
  padding: "3px var(--sp-4)",
  fontSize: "var(--text-2xs)",
};

const sendBtn: React.CSSProperties = {
  border: "1px solid var(--line)",
  borderRadius: "var(--r-2)",
  background: "var(--panel)",
  color: "var(--ink-soft)",
  padding: "3px var(--sp-5)",
  fontSize: "var(--text-2xs)",
};
