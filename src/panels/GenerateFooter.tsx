import { useEffect, useState } from "react";
import { useI18n } from "../i18n";

/** ★키를 조립하지 않는다 — i18n 검사가 동적 접두사를 잡는다 (`i18n.test.ts`) */
const SEED_LABELS = ["options.seedFixed", "options.seedRound", "options.seedScene"] as const;
const SEED_HINTS = ["options.seedFixedHint", "options.seedRoundHint", "options.seedSceneHint"] as const;
import { SEED_MODES, modelCaps, randomSeed, useGen } from "../store/gen";
import { useQueue } from "../store/queue";
import { allScenes, useWs } from "../store/workspace";
import { useImageInput } from "../store/imageInput";
import { useUi } from "../store/ui";
import { toast } from "../store/toast";
import { MAX_PER_IMAGE } from "../lib/anlas";
import { costNow } from "../lib/costNow";
import { usageDuration, usageFullInSeconds, usageLow, usagePercent, usageRefillPerHour } from "../lib/opusUsage";
import { useSub } from "../store/sub";
import { useAnlasMeter } from "../store/anlasMeter";
import { useHasToken } from "../store/health";
import { Icon } from "../components/Icon";

/** 생성 푸터 — 페로픽스파이 `params-footer` 를 그대로 옮긴 것이다
 *  (`ui/src/tabs/workbench/ParamsPanel.tsx` · `styles.css` `.params-footer`).
 *
 *  ★쌓는 순서가 그쪽 구현의 핵심이다: **오류 → 큐 줄 → 시드 → 생성 버튼**.
 *    버튼은 **언제나 맨 아래**고, 위의 것들이 생겼다 사라져도 버튼은 자리를 안 옮긴다.
 *  ★큐 줄은 **돌고 있을 때만** 뜬다: `대기 n · 3/8` + `현재 중단` + `큐 비우기`.
 *    이게 없으면 눌렀는지 안 눌렀는지 알 수가 없다 (사용자 지적 2026-08-04 — 멀티에서
 *    아무 반응이 없어 보였다).
 *  ★시드는 **숫자칸 + Random 체크**다 (그쪽 `seed-row seed-pinned`). 체크를 켜면 매번
 *    새 시드로 굴리고, 숫자는 남아 있어 그대로 다시 쓸 수 있다.
 *  ★접힌 패널에서도 버튼은 남는다 — `compact` 로 부른다.
 */
export function GenerateFooter({ compact = false }: { compact?: boolean }) {
  const t = useI18n((s) => s.t);
  // 구독 상태는 **스토어 하나**가 들고 있다 (업스케일 값 표시도 같은 곳을 본다)
  const sub = useSub((s) => s.sub);
  const { params, set, busy, error, generateAll } = useGen();
  const { progress, phase, cancelAll } = useQueue();
  /** 잔액을 다시 물어본 횟수 — 누를 때마다 아이콘을 **한 바퀴 더** 돌린다 (v2 `refreshAnlasBtn`).
   *  ★각도를 원위치시키지 않고 누적한다. 되돌리면 애니메이션이 거꾸로 돌아 흔들려 보인다. */
  const [turns, setTurns] = useState(0);
  /** ★★취소를 **받았다**는 상태 (사용자 지적 2026-08-19: 눌러도 눌린 느낌이 없었다).
   *  받은 뒤에는 다시 못 누르고, 단추가 「취소 중」으로 바뀐다. 배치가 끝나면 저절로 풀린다. */
  const [cancelled, setCancelled] = useState(false);
  /** ★★막 눌렀다 (사용자 지적 2026-08-19: 눌린 느낌이 없다). 큐가 돌기 시작하기까지
   *  잠깐이지만 그 사이에 아무 반응이 없으면 **안 눌린 줄 안다.** 그동안 눌린 모양으로 두고
   *  다시 못 누르게 한다 — 그 뒤로는 `running` 이 이어받는다. */
  const [firing, setFiring] = useState(false);
  const tab = useWs((s) => s.activeSceneGroup());
  const img = useImageInput();
  /** ★그 모델에서 되는 것 — 값 계산이 **보내는 것과 같아야** 한다 (`lib/naiModels.ts`) */
  const cap = modelCaps(params.model);
  /* ★★캐릭터 상한은 **켜는 순간** 막는다 (사용자 지시 2026-08-21, `store/gen.ts` 의
     `toggleCharCapped`·`clampCharsToModel`). 넘긴 채로 두고 여기서 「초과분은 무시됩니다」를
     띄우던 것을 걷었다 — 다른 자리는 전부 막는데 여기만 알리고 두면, 그대로 생성했을 때
     뒤쪽 캐릭터가 조용히 빠진다. 서버의 자르기(`backend/nai.py`)는 마지막 방어선으로 남는다. */

  /** Opus 무료 잔량 — ★Opus 이고 서버가 값을 줄 때만 있다 */
  const usage = (sub?.tier ?? 0) >= 3 ? (sub?.usage ?? null) : null;

  // ★탭은 언제나 씬 탭이다 (싱글 폐기 2026-08-11) — 옛 싱글 탭은 열 때 옮겨진다.
  //   그래도 한 번 좁히는 이유는 `SceneGroup` 이 옛 파일을 읽으려고 두 갈래를 남겨 두기 때문이다.
  const sceneSet = tab?.kind === "sceneGroup" ? tab : null;
  const perSlot = useUi((s) => s.perSlot);
  const setPerSlot = useUi((s) => s.setPerSlot);
  /** ★잠긴 것은 생성에서 빠지므로 장 수도 그만큼 줄여야 한다.
   *
   *  ★★**카드 잠금도 함께 본다** — `gen.ts generateAll` 은 `!cell.locked && !card.locked` 로
   *    거르는데 여기는 씬 잠금만 세고 있었다. 카드를 잠그면 **푸터가 실제보다 많이 세고**,
   *    비용도 그만큼 부풀었다 (실측 장치가 「예상 > 실제」로 잡아낸 자리, `lib/anlasMeter`).
   *    세는 규칙이 둘이면 어느 쪽이 맞는지 화면으로는 알 수 없다. */
  const slots = sceneSet
    ? allScenes(sceneSet).filter((x) => !x.cell.locked && !x.card.locked).length
    : 1;
  const count = slots * perSlot;
  /** ★★**생성할 씬이 없으면 그 자리에서 말해 준다** (사용자 지시 2026-08-22:
   *  *"씬카드 없어서 생성불가능할때 생성 버튼쪽에도 경고 띄워줘"*).
   *
   *  문구는 세 로케일에 **이미 있었는데 아무도 안 쓰고 있었다** — 그래서 씬 카드가 없으면
   *  버튼을 눌러도 조용히 아무 일도 안 일어났다 (v2 `index.html:15905` 가 막던 자리다).
   *  ★두 갈래를 가른다: 씬이 **아예 없는 것**과, 있는데 **전부 잠긴 것**. 화면에서 보이는
   *    모습이 달라서(빈 줄 대 자물쇠 붙은 줄) 같은 말로 묶으면 무엇을 하라는 건지 흐려진다.
   *  ★씬 세트 탭에서만 본다 — 그 밖의 자리는 씬이라는 것이 없어 언제나 한 장이다. */
  const noScenes = !!sceneSet && allScenes(sceneSet).length === 0;
  const allLocked = !!sceneSet && !noScenes && slots === 0;
  const cantGen = noScenes || allLocked;
  /** 막힌 줄을 눌렀을 때 — **씬을 하나 만든다** (사용자 지시 2026-08-26).
   *
   *  ★★전부 잠긴 때도 **자물쇠를 대신 풀지 않는다.** 잠근 것은 사용자의 뜻이라 우리가
   *    되돌릴 일이 아니고, 새 씬 하나면 생성이 다시 된다.
   *  ★카드가 아예 없으면 카드부터 만든다 — `addSlot` 은 붙일 카드가 있어야 움직인다
   *    (`store/workspace` 의 `addSlot` 첫 줄). */
  const addScene = () => {
    if (!sceneSet) return;
    const ws = useWs.getState();
    if (sceneSet.cards.length) ws.addSlot(sceneSet.id);
    else ws.addCard(sceneSet.id);
  };
  /** ★★인페인트도 **이 버튼이 만든다** (사용자 지시 2026-08-19).
   *
   *  예전에는 여기를 잠그고 마스크 편집 화면 안에 실행 버튼을 따로 뒀다. 지금 인페인트는
   *  i2i 와 같은 **베이스 이미지 옵션**이라, 씬이 여럿이면 i2i 와 똑같이 씬마다 나간다.
   *
   *  ★★**칠한 곳이 없다고 막지 않는다** (사용자 지시 2026-08-19). 한 번 막아 봤는데,
   *    인페인트를 켜 두고 안 칠한 채 그냥 보내는 것은 **사용자의 자유**다 (그때는 백엔드가
   *    마스크 없는 i2i 로 보낸다). 값 계산은 그 사실을 그대로 따른다 (`costInpaint`).
  /** ★해상도 칸이 아니라 **나가는 크기**로 센다 — Focused 인페인트는 서버가 조각을 1MP 로
   *  키워 보내므로 둘이 다르다 (`imageInput.costSize`) */
  /* ★★값 계산은 **공용 함수 하나**다 (`lib/costNow`, 2026-08-24). 조수의 승인 카드도
     같은 것을 쓴다 — 자동 승인이 「Anlas 가 나가는가」로 갈리기 때문이다 (사용자 결정).
     여기 조립을 되살리지 말 것: 두 벌이 되면 푸터에 보이는 값과 승인 카드의 값이 갈린다. */
  const cost = costNow(1);
  const running = progress.total > progress.completed;
  useEffect(() => {
    if (!running) setCancelled(false);
  }, [running]);
  /** ★★취소를 누르면 **받았다고 말한다** (사용자 지적 2026-08-19: 눌러도 아무 일이 없어
   *  보였다). NAI 는 이미 나간 한 장을 못 끊으므로 **지금 것은 끝까지 나오고** 나머지가
   *  빠진다 — 그 사실을 그 자리에서 알린다. 안 알리면 「안 눌렸다」로 읽혀 또 누르게 된다. */
  const cancelQueue = async () => {
    if (!running || cancelled) return;
    setCancelled(true);
    toast(t("queue.cancelSent"));
    await cancelAll();
  };
  /** ★한 장이 140 Anlas 를 넘으면 **생성을 막는다** — 공홈과 같은 판정이다
   *  (v2 `index.html:15878-15882`. 합계가 아니라 개별 장 비용 기준이라, 여러 장을 걸어
   *  둔 정상 상황에서 헛되이 걸리지 않는다). 값만 세어 두고 아무도 안 읽던 자리다 (감사 B3). */
  const blocked = cost.overLimit;
  /** ★**지금 누르면 Anlas 가 나가는가.** 무료 구간(`cost.free`)이 아니고 값이 0보다 클 때다 —
   *  「자동 승인」이 갈리는 기준과 **같은 물음**이다 (`lib/appActions` 의 생성 위험도). */
  const paid = !cost.free && cost.total > 0;
  /** ★토큰이 없으면 NAI 생성이 통째로 안 된다. v2 는 누르는 순간 토큰 창을 띄웠고
   *  (`index.html:15859-15862`), 우리는 토큰을 넣는 창구가 **설정 하나**뿐이라 그리로
   *  데려간다. 지금까지는 검사가 없어 눌러 놓고 실패를 기다려야 했다 (감사 C5). */
  const noToken = !useHasToken();
  const openSettings = useUi((s) => s.openSettings);
  /** ★생성할 씬이 없으면 **버튼도 막는다** — 눌러도 아무 일이 없는 것이 가장 나쁘다.
   *  ★토큰 없음(`noToken`)은 안 막는다. 그 버튼은 「만들기」가 아니라 「넣으러 가기」다. */
  const off = busy || blocked || firing || cantGen;
  /** 이 버튼이 지금 하는 일 — 토큰이 없으면 「만들기」가 아니라 「넣으러 가기」다 */
  const fire = () => {
    if (noToken) return openSettings("general");
    // ★칠하던 중이면 편집에서 나온다 — 가운데가 편집기인 채로는 결과를 못 본다.
    //   마스크는 남으므로 다시 들어가면 그대로 이어진다
    if (img.editing) img.endEdit();
    // ★큐에 넣기 **직전**의 잔액을 적어 둔다. 배치가 끝나면 다시 물어 실제 청구를 낸다
    //   (`store/anlasMeter`). 위 `cost` 는 예상값일 뿐이라 맞는지 확인할 길이 이것뿐이다
    // ★실측 장치에 넘기는 크기도 **나가는 크기**여야 한다 (`costNow` 와 같은 값)
    const size = img.costSize();
    useAnlasMeter.getState().arm(cost.total, {
      width: size.width,
      height: size.height,
      steps: params.steps,
      opus: (sub?.tier ?? 0) >= 3,
      refs: cap.char_ref && img.refOn ? img.refs.length : 0,
      vibes: cap.vibe && img.vibeOn ? img.vibes.length : 0,
      inpaint: img.costInpaint(),
      count,
      from: "generate",
    });
    setFiring(true);
    setTimeout(() => setFiring(false), 700);
    void generateAll();
  };

  /** ★`Ctrl+Enter` 로 생성 (v2 `index.html:18459`).
   *
   *  ★버튼과 **같은 자리**에 매단다 — 버튼이 하는 일과 잠기는 조건이 하나여야 둘이 안 갈린다.
   *    이 컴포넌트는 생성 모드에서만 뜨므로(App 의 `leftFooter`) 갤러리·검열에서는 안 먹는다.
   *  ★창(모달)이 떠 있으면 넘긴다 — 그 안의 Enter 는 그 창 것이다 (v2 도 카드 편집기를 뺐다).
   *  ★입력칸은 **막지 않는다.** 프롬프트를 치다가 그대로 누르는 것이 이 단축키의 쓰임이다
   *    (평범한 Enter 와 달리 수식키가 붙어 글자 입력과 부딪히지 않는다). */
  useEffect(() => {
    // ★펼친 푸터와 접힌 레일은 **둘 중 하나만** 뜬다 (`Shell` 의 `leftCollapsed` 갈래) —
    //   그래서 접어 둔 채로도 단축키가 살아 있고, 두 번 걸리지도 않는다.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Enter" || !(e.ctrlKey || e.metaKey) || e.repeat) return;
      // ★마스크 편집기는 **빼지 않는다** — 인페인트도 이 버튼이 만들므로(2026-08-19),
      //   칠하다가 그대로 눌러 생성하는 것이 이 단축키의 쓰임이다
      if (document.querySelector("[data-enhance], [data-settings], [data-ask], [data-prompt-view]"))
        return;
      if (off) return;
      e.preventDefault();
      fire();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [off, perSlot, noToken, generateAll]);

  /** 상태 문구 — v2 `statusText` (`index.html:16121-16125, 16464-16471`).
   *  ★돌 때는 진행 숫자, 끝나면 성패를 말한다. 「준비」는 줄 자체가 사라지는 것으로 대신한다. */
  const stateText =
    phase === "done"
      ? t("queue.stDone")
      : phase === "failed"
        ? t("queue.stFailed")
        : phase === "partial"
          ? t("queue.stPartial")
          : `${progress.completed}/${progress.total}`;
  const stateInk =
    phase === "failed" ? "var(--err-ink)" : phase === "partial" ? "var(--warn)" : phase === "done" ? "var(--ok)" : "var(--accent-ink)";
  /** 끝났으면 100% 로 채워 둔다 (v2 `progressFill.style.width = '100%'`) */
  const pct =
    phase === "done" || phase === "failed" || phase === "partial"
      ? 100
      : progress.total > 0
        ? Math.min(100, Math.round((progress.completed / progress.total) * 100))
        : 0;

  const genBtn = (
    <button
      data-generate="all"
      data-gen-blocked={blocked ? "" : undefined}
      onClick={fire}
      disabled={off}
      /* ★펼쳐 놓았을 때는 **단축키를 알려 준다** — 있는 줄 모르면 없는 것과 같다 */
      data-tip={t(
        noScenes
          ? "gen.noScenes"
          : allLocked
            ? "gen.allLocked"
            : blocked
              ? "gen.overLimit"
              : noToken
                ? "gen.needToken"
                : compact
                    ? "canvas.generate"
                    : "canvas.generateShortcut",
        { a: MAX_PER_IMAGE },
      )}
      style={{
        // ★막 누른 동안은 **가라앉은 액센트** — 「못 누름(회색)」과 다르게 보여야 한다
        background: firing ? "var(--accent-bg)" : off ? "var(--panel)" : "var(--accent)",
        color: firing ? "var(--accent-ink)" : off ? "var(--ink-faint)" : "var(--accent-on)",
        borderRadius: "var(--r-2)",
        padding: compact ? "var(--sp-3) 0" : "var(--sp-3)",
        fontWeight: "var(--w-semi)",
        fontSize: "var(--text-sm)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        gap: "var(--sp-2)",
        width: "100%",
      }}
    >
      {/* ★★아이콘을 안 붙인다 (사용자 지시 2026-08-19) — 이름이 이미 적혀 있고, 접었을 때는
          **v2 처럼 `Q`** 다 (그쪽 `collapsedQueueBtn`). 글자 하나가 아이콘보다 또렷하다. */}
      {compact ? "Q" : busy || firing ? t("canvas.generating") : t("canvas.generate")}
      {/* ★몇 장을 만들지·얼마가 드는지를 **누르기 전에** 보여 준다.
          ★Opus 무료 구간이면 숫자 대신 **FREE** 다 (v2 `anlasFreeTag`, index.html:9438).
          ★★**강조는 값에만 건다** (사용자 지시 2026-08-25: *"강조할 때 장수 말고 가격만
            강조"*). 장수는 무료든 유료든 똑같이 알아야 하는 값이라 함께 물들이면 무엇이
            달라졌는지가 오히려 흐려진다. 그래서 두 조각으로 나눠 **뒤쪽만** 색을 바꾼다.
          ★색만 바꾼다 — 한때 경고색 바탕 딱지였는데 단추 위에서 너무 튀었다
            (*"너무 촌스러워"*). 반투명하게 두던 것(`opacity: 0.82`)만 걷고 색을 준다. */}
      {!compact && (
        <span style={{ fontVariantNumeric: "tabular-nums", display: "flex", gap: 4 }}>
          <span style={{ opacity: 0.82 }}>{t("gen.count", { n: count })}</span>
          <span style={{ opacity: 0.82 }}>·</span>
          <span
            data-gen-cost={paid ? "paid" : "free"}
            style={paid ? { color: "var(--warn)" } : { opacity: 0.82 }}
          >
            {cost.free ? "FREE" : t("gen.costAnlas", { a: cost.total })}
          </span>
        </span>
      )}
      {/* ★★접힌 레일에서도 알아야 한다 — 거기서는 값을 아예 안 보여 주고 있었다.
          「Q」 옆의 경고색 점 하나가 «지금 누르면 돈이 나간다»를 말한다. */}
      {compact && paid && (
        <span
          data-gen-cost="paid"
          data-tip={t("gen.countCost", { n: count, a: cost.total })}
          style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--warn)" }}
        />
      )}
    </button>
  );

  // 접힌 레일 — 버튼만 남긴다. 여기서도 누를 수 있어야 접어 둔 채 계속 만든다
  if (compact) {
    return (
      <div style={{ padding: "var(--sp-2)", borderTop: "1px solid var(--line)", display: "flex", flexDirection: "column", gap: 4 }}>
        {genBtn}
        {/* ★★`CQ` 는 **늘 있다** (사용자 지시 2026-08-19, v2 `collapsedClearQBtn`) —
            돌 때만 나타나면 멈추려는 순간에 자리를 찾게 된다. 돌지 않을 때는 눌러도
            할 일이 없으므로 흐리게 둔다. */}
        <button
          data-queue-cancel="compact"
          onClick={() => void cancelQueue()}
          disabled={!running || cancelled}
          /* ★안내는 한 열쇠에 통째로 담는다 — 코드에서 이으면 잇는 기호가 번역을 안 탄다 */
          data-tip={t("queue.cancelHint")}
          style={{
            ...qbtn,
            width: "100%",
            padding: "var(--sp-2) 0",
            textAlign: "center",
            /* ★★`CQ` 두 글자는 좁은 레일에서 넘쳤다 (사용자 지적 2026-08-19) — 한 글자다.
               ★받은 뒤에는 흐려지고 안 눌린다. */
            color: running && !cancelled ? "var(--err-ink)" : "var(--ink-ghost)",
            borderColor: running && !cancelled ? "var(--err)" : "var(--line)",
          }}
        >
          C
        </button>
        {running && (
          <div
            data-queue-mini
            style={{
              marginTop: 4,
              fontSize: "var(--text-2xs)",
              color: "var(--ink-dim)",
              textAlign: "center",
              fontVariantNumeric: "tabular-nums",
            }}
          >
            {progress.completed}/{progress.total}
          </div>
        )}
      </div>
    );
  }

  return (
    <div
      data-gen-footer
      style={{
        flexShrink: 0,
        borderTop: "1px solid var(--line)",
        padding: "var(--sp-3) var(--sp-4) var(--sp-4)",
        display: "flex",
        flexDirection: "column",
        gap: "var(--sp-2)",
      }}
    >
      {error && <span style={{ fontSize: "var(--text-2xs)", color: "var(--err-ink)" }}>{error}</span>}

      {/* ★★생성할 씬이 없으면 **누르기 전에** 말해 준다 (사용자 지시 2026-08-22).
          툴팁만으로는 마우스를 올려야 보이므로, 토큰 안내와 **같은 모양의 줄**로 낸다.
          ★★**누르면 그 자리에서 풀린다** (사용자 지시 2026-08-26) — 토큰 안내가 설정으로
            데려가는 것과 같은 몸짓이다. 막힌 까닭만 알리고 가만히 있으면, 어디서 무엇을
            해야 하는지 사용자가 스스로 찾아야 한다. */}
      {cantGen && (
        <button
          data-gen-noscenes
          onClick={addScene}
          style={{
            textAlign: "left",
            fontSize: "var(--text-2xs)",
            color: "var(--warn)",
            lineHeight: 1.5,
            border: "1px solid var(--warn)",
            borderRadius: "var(--r-2)",
            padding: "var(--sp-2) var(--sp-3)",
          }}
        >
          {t(noScenes ? "gen.noScenes" : "gen.allLocked")}
        </button>
      )}

      {/* ★토큰이 없으면 **누르기 전에** 말해 준다 — 눌러야 알 수 있으면 그건 안내가 아니다.
          누르면 설정 ▸ 일반으로 데려간다 (버튼도 같은 자리로 간다). */}
      {noToken && (
        <button
          data-need-token
          onClick={() => openSettings("general")}
          style={{
            textAlign: "left",
            fontSize: "var(--text-2xs)",
            color: "var(--warn)",
            lineHeight: 1.5,
            border: "1px solid var(--warn)",
            borderRadius: "var(--r-2)",
            padding: "var(--sp-2) var(--sp-3)",
          }}
        >
          {t("gen.needToken")}
        </button>
      )}

      {/* ★몇 장 — **씬 하나당**이다. 한 번에 여러 장을 뽑아 고르는 것이 본래 쓰임이다 */}
      <div style={{ display: "flex", alignItems: "center", gap: "var(--sp-2)" }}>
          <span style={{ fontSize: "var(--text-2xs)", color: "var(--ink-faint)", flexShrink: 0 }}>
            {t("gen.perSlot")}
          </span>
          {/* ★상한이 없다 (사용자 결정 2026-08-18 — v2 도 `min="1"` 뿐이었다).
              `step={1}` 과 `setPerSlot` 의 반올림이 음수·0·소수를 막는다 */}
          <input
            data-per-slot
            type="number"
            min={1}
            step={1}
            value={perSlot}
            onChange={(e) => setPerSlot(Number(e.target.value) || 1)}
            style={{
              width: 56,
              background: "var(--panel)",
              border: "1px solid var(--line)",
              borderRadius: "var(--r-2)",
              padding: "3px var(--sp-3)",
              fontSize: "var(--text-2xs)",
              fontFamily: "var(--font-mono)",
            }}
          />
          <span style={{ fontSize: "var(--text-2xs)", color: "var(--ink-ghost)" }}>
            {t("gen.slotsTimes", { s: slots, p: perSlot, t: count })}
          </span>
      </div>

      {/* 시드 — 매번 만지는 값이라 생성 버튼 바로 위에 고정 */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "var(--sp-2)",
          paddingTop: "var(--sp-2)",
          borderTop: "1px solid var(--line-soft, var(--line))",
        }}
      >
        <span style={{ fontSize: "var(--text-2xs)", color: "var(--ink-faint)", flexShrink: 0 }}>
          {t("options.seed")}
        </span>
        <input
          data-seed
          value={params.seed}
          onChange={(e) => {
            const v = parseInt(e.target.value, 10);
            set("seed", Number.isFinite(v) ? v : 0);
          }}
          // ★★**랜덤이어도 고칠 수 있다** (사용자 지적 2026-08-16). 랜덤은 아무 숫자를
          //   넣는 게 아니라 **여기 적힌 값으로 뽑고 나서** 이 칸을 굴리는 것이라,
          //   잠그면 "이 시드로 한 장 더" 를 아예 못 한다 (`lib/seedRounds` 머리 주석).
          style={{
            flex: 1,
            minWidth: 0,
            background: "var(--panel)",
            border: "1px solid var(--line)",
            borderRadius: "var(--r-2)",
            padding: "3px var(--sp-3)",
            fontSize: "var(--text-2xs)",
            fontFamily: "var(--font-mono)",
          }}
        />
        {/* 주사위 — 지금 자리에서 바로 새 시드를 뽑아 본다 */}
        <button
          data-seed-roll
          onClick={() => set("seed", randomSeed())}
          data-tip={t("options.seedRoll")}
          style={{ flexShrink: 0, color: "var(--ink-faint)", display: "grid", padding: "0 2px" }}
        >
          {Icon.dice}
        </button>
        {/* ★배타적 3택이다 — 체크박스 둘이면 「고정 + 씬마다 랜덤」 같은 뜻 없는 상태가
            생긴다 (사용자 지적 2026-08-11). v2 의 `랜덤/고정/슬롯마다 랜덤` 이관. */}
        <div
          data-seed-mode={params.seed_mode}
          style={{
            display: "flex",
            flexShrink: 0,
            border: "1px solid var(--line)",
            borderRadius: "var(--r-2)",
            overflow: "hidden",
          }}
        >
          {SEED_MODES.map((m, i) => {
            const on = params.seed_mode === m;
            return (
              <button
                key={m}
                data-seed-pick={m}
                onClick={() => set("seed_mode", m)}
                data-tip={t(SEED_HINTS[i])}
                style={{
                  padding: "2px var(--sp-3)",
                  fontSize: "var(--text-2xs)",
                  whiteSpace: "nowrap",
                  borderRight: i < 2 ? "1px solid var(--line)" : undefined,
                  background: on ? "var(--accent-bg)" : "transparent",
                  color: on ? "var(--accent-ink)" : "var(--ink-dim)",
                  fontWeight: on ? "var(--w-semi)" : "var(--w-normal)",
                }}
              >
                {t(SEED_LABELS[i])}
              </button>
            );
          })}
        </div>
      </div>

      {genBtn}

      {/* ★★진행바는 **언제나 자리를 차지한다** (사용자 지시 2026-08-21: 생성 버튼이 움직였다).
          돌 때만 나타나게 하면 버튼이 그만큼 밀려 올라가, 연달아 누르려던 손이 빗나간다.
          쉴 때는 선 하나로만 보인다. */}
      <div
        data-queue-progress={pct}
        style={{ height: 3, borderRadius: "var(--r-1)", background: "var(--line)", overflow: "hidden" }}
      >
        <div
          style={{
            height: "100%",
            width: running || phase !== "idle" ? `${pct}%` : 0,
            background: stateInk,
            transition: "width 0.18s linear",
          }}
        />
      </div>

      {/* ★막았으면 **왜 막혔는지**를 같은 자리에서 말한다. v2 는 눌렀을 때 토스트였는데,
          버튼이 잠긴 채 이유가 없으면 무엇을 고쳐야 하는지 알 수 없다 */}
      {blocked && (
        <span data-gen-over-limit style={{ fontSize: "var(--text-2xs)", color: "var(--err-ink)" }}>
          {t("gen.overLimit", { a: MAX_PER_IMAGE })}
        </span>
      )}

      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "var(--sp-2)",
          // ★칸이 좁으면 접는다. 실제 청구 값이 한 자리 더 붙어 잔액이 밀려나지 않게
          flexWrap: "wrap",
          rowGap: 2,
          fontSize: "var(--text-2xs)",
          color: "var(--ink-faint)",
        }}
      >
        {/* ★비용이 **어떻게 나왔나** — v2 의 `총액 (장당 × N슬롯 × M회)` (index.html:19031-19039).
            총액은 버튼에 있으므로 여기서는 분해만 보인다 (같은 값을 두 번 두지 않는다) */}
        {!cost.free && count > 1 && (
          <span data-cost-break style={{ fontVariantNumeric: "tabular-nums" }}>
            {t("gen.costPerSlots", { p: cost.perImage, s: slots, r: perSlot })}
          </span>
        )}
        {cost.encoding > 0 && <span>{t("gen.vibeEncode", { a: cost.encoding })}</span>}

        {/* ★★취소·진행은 **이 줄의 빈 자리**에 산다 (사용자 지시 2026-08-21).
            새 줄로 만들면 그만큼 위가 밀려 생성 버튼이 움직인다 — 그래서 여기다. */}
        {(running || phase !== "idle") && (
          <span
            data-queue-state={phase}
            style={{ color: stateInk, fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" }}
          >
            {stateText}
            {running && progress.queue_length > 0 && ` · ${t("queue.waiting", { n: progress.queue_length })}`}
          </span>
        )}
        {running && (
          <button
            data-queue-cancel
            onClick={() => void cancelQueue()}
            disabled={cancelled}
            data-tip={t("queue.cancelHint")}
            style={{
              ...qbtn,
              padding: "0 var(--sp-2)",
              color: cancelled ? "var(--ink-ghost)" : "var(--err-ink)",
              borderColor: cancelled ? "var(--line)" : "var(--err)",
            }}
          >
            {cancelled ? t("queue.cancelling") : t("queue.cancel")}
          </button>
        )}

        <span style={{ flex: 1 }} />

        {/* ★★Opus 무료 **잔량** — V5 부터 무료가 유한하다 (`lib/opusUsage.ts`).
            ★Opus 가 아니거나 서버가 값을 안 주면 아무것도 안 보인다 — 없는 것을 0% 로
              보여 주면 다 쓴 것처럼 읽힌다. */}
        {usage && (
          <span
            data-opus-usage={Math.round(usagePercent(usage))}
            /* ★가득(또는 그 이상)이면 **회복 줄을 안 적는다** — 채울 것이 없다 */
            data-tip={
              usageFullInSeconds(usage) > 0
                ? `${t("gen.opusUsageHint")}\n${t("gen.opusRefill", {
                    r: String(usageRefillPerHour(usage)),
                    f: usageDuration(usageFullInSeconds(usage)),
                  })}`
                : t("gen.opusUsageHint")
            }
            style={{ color: "var(--ink-faint)", fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" }}
          >
            {/* ★숫자는 Anlas 잔액과 **같은 꼴**로 — 변하는 값이라는 뜻 (사용자 지시 2026-08-30).
                바닥나면 숫자만 경고색이다. */}
            {t("gen.opusUsage")}{" "}
            <b style={{ fontFamily: "var(--font-mono)", color: usageLow(usage) ? "var(--warn)" : "var(--ink-soft)" }}>
              {Math.round(usagePercent(usage))}%
            </b>
          </span>
        )}
        <span data-anlas-balance data-tip={sub ? `tier ${sub.tier}` : undefined}>
          Anlas{" "}
          <b style={{ fontFamily: "var(--font-mono)", color: "var(--ink-soft)" }}>
            {sub ? sub.anlas.toLocaleString() : "--"}
          </b>
        </span>
        {/* ★잔액을 **다시 물어보는 창구** (v2 `refreshAnlasBtn`, index.html:9434·19087-19093).
            없으면 토큰을 넣거나 밖에서 충전해도 화면 값이 영영 안 바뀐다 */}
        <button
          data-anlas-refresh
          data-tip={t("gen.anlasRefresh")}
          onClick={() => {
            setTurns((n) => n + 1);
            void useSub.getState().load();
          }}
          style={{
            display: "grid",
            placeItems: "center",
            color: "var(--ink-faint)",
            padding: "0 2px",
            transform: `rotate(${turns * 360}deg)`,
            transition: "transform 0.3s",
          }}
        >
          {Icon.refresh12}
        </button>
      </div>
    </div>
  );
}

const qbtn: React.CSSProperties = {
  border: "1px solid var(--line)",
  borderRadius: "var(--r-2)",
  padding: "2px var(--sp-3)",
  fontSize: "var(--text-2xs)",
  color: "var(--ink-soft)",
  background: "var(--panel)",
};
