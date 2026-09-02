import { useEffect, useState } from "react";
import { useI18n } from "../i18n";
import { useGen } from "../store/gen";
import {
  clampEnhanceScale,
  enhanceScaleOptions,
  enhanceTargets,
  enhanceTargetSize,
} from "../lib/enhance";
import { useUi } from "../store/ui";
import { useImageInput } from "../store/imageInput";
import { useQueue } from "../store/queue";
import { usePrompt } from "../store/prompt";
import { useWs } from "../store/workspace";
import { imgUrl } from "../lib/imgUrl";
import { Icon } from "../components/Icon";
import { anlasCost, MAX_PER_IMAGE } from "../lib/anlas";
import { useCurrentSub } from "../store/sub";
import { currentAccountId } from "../store/accounts";
import { useAnlasMeter } from "../store/anlasMeter";
import { useSceneFocus } from "../store/sceneFocus";
import { allScenes } from "../store/workspace";
import { api } from "../lib/backend";
import type { ImageMeta } from "../store/gallery";
import { hasMeta, metaParams } from "../lib/metaApply";

/** ★Magnitude → 강도·노이즈. v2 `magnitudePresets` 원문 그대로 (index.html:23953).
 *  숫자를 바꾸면 결과가 달라진다 — "적당히 비슷한 값"으로 손대지 말 것. */
const MAGNITUDE: Record<number, { strength: number; noise: number }> = {
  1: { strength: 0.2, noise: 0 },
  2: { strength: 0.4, noise: 0 },
  3: { strength: 0.5, noise: 0 },
  4: { strength: 0.6, noise: 0 },
  5: { strength: 0.7, noise: 0.1 },
};

/** 강화(Enhance) — **그 그림을 다시 그린다**.
 *
 *  ★새 기능이 아니라 **i2i 의 프리셋**이다: 원본을 베이스 이미지로 넣고 Magnitude 가 정한
 *    강도로 굴린다. NAI 는 큰 판으로 그리는 것이지 업스케일러가 아니다.
 *  ★**원본을 미리 확대해 보내지 않는다** (`docs/nai-web-reference.md` 6절). 서버가 저장된
 *    원본을 그대로 보내고 width/height 만 키운다 — 예전 주석의 "캔버스로 먼저 키운다"는 폐기됐다.
 *  ★배율도 1.5 고정이 아니다. 원본 크기가 정한다 (`lib/enhance.ts`).
 *  ★★**그 그림의 메타데이터로 돈다** (사용자 결정, `docs/v2-port-audit.md` D1).
 *    프롬프트·네거티브·캐릭터·모델·샘플러·스텝·cfg 를 **강화할 그림에서** 읽어 싣는다
 *    (v2 `buildEnhanceRequest`, `index.html:24455-24486`). 지금 화면의 프롬프트로 돌면
 *    갤러리의 옛 그림을 강화할 때 전혀 다른 그림이 나온다.
 *    - **배치는 장마다** 그 장의 메타데이터를 읽는다 (크기와 같은 이유로 한 벌로 못 묶는다).
 *    - 메타데이터가 없는 그림(밖에서 가져온 것)은 v2 와 같이 **지금 화면 값**으로 떨어지고,
 *      그 사실을 창에 한 줄로 알린다 (v2 는 말없이 떨어졌다).
 *    - ★**화면 상태는 안 건드린다.** 갤러리의 「설정 불러오기」와 다른 점이 이것뿐이다 —
 *      강화는 그 요청에만 쓰는 값이라 사용자가 적어 둔 프롬프트를 덮으면 안 된다.
 *    - ★**시드는 메타데이터에서 안 가져온다** (v2 `index.html:24476`). 원본 시드 그대로면
 *      같은 그림이 나와 강화의 뜻이 없다.
 *  ★결과는 **새 그림**이다. 어느 그림에서 나왔는지만 `enhance_of` 에 남기고, 화면은
 *    묶지 않는다 (사용자 결정 2026-08-13: v2 의 버전 스택 `1/n` 은 작업할 때 불편하다).
 */
export function EnhanceDialog({
  files,
  onClose,
}: {
  /** 강화할 그림들. 여럿이면 **배치**다 — 큐로 보낸다 */
  files: string[];
  onClose: () => void;
}) {
  const t = useI18n((s) => s.t);
  const { base, params } = useGen();
  const opus = (useCurrentSub()?.tier ?? 0) >= 3;
  const ws = useWs((s) => s.current);
  const records = useWs((s) => s.records);
  const setNow = useWs((s) => s.activeSceneGroup());
  // ★탭이 없으면 이 창이 뜰 수 없다 (부르는 두 자리가 다 탭 안이다). 옛 폴백은 `"싱글"`
  //   이라는 글자를 저장 자리로 흘려보냈다 — 싱글/멀티 구분이 폐기된 지금은 뜻이 없다.
  const setName = setNow?.name ?? "";
  const tabName = useWs.getState().activeTabOf()?.name ?? null;
  /** 실제로 돌릴 것과 뺀 것 — ★**열 때 한 번** 정한다 (v2 도 모달을 열 때 목록을 굳힌다).
   *  돌아가는 사이에 새 레코드가 들어와도 대상이 바뀌면 안 된다.
   *  ★한 장짜리는 거르지 않는다 — 걸러 내는 것은 **배치**의 규칙이다 (v2 단일 모달도 안 거른다). */
  const [{ targets, skipped }] = useState(() =>
    files.length > 1
      ? enhanceTargets(useWs.getState().records, files)
      : { targets: files, skipped: [] as string[] },
  );
  // ★강도는 **마지막에 쓴 값**으로 연다 (v2 `enhanceLast`). 열 때마다 3 으로 되돌아가던 자리
  const last = useUi.getState().enhanceLast;
  const [mag, setMag] = useState(last.mag);
  const [scale, setScale] = useState(1);
  const [adv, setAdv] = useState(last.adv);
  const [strength, setStrength] = useState(last.strength);
  const [noise, setNoise] = useState(last.noise);
  /** 대상마다 원본 크기 — 배치는 크기가 섞여 있어 **장마다** 재야 한다 */
  const [sizes, setSizes] = useState<Record<string, [number, number]> | null>(null);
  /** 대상마다 **그 그림의 메타데이터** — 강화가 읽는 값의 정본 (머리 주석 ★★).
   *  ★배치는 장마다 다르므로 한 벌로 못 묶는다. 못 읽으면 그 자리만 `null` 이다. */
  const [metas, setMetas] = useState<Record<string, ImageMeta | null> | null>(null);
  const [busy, setBusy] = useState(false);

  // 원본 크기를 읽어 목표 해상도를 낸다 (배치면 전부)
  useEffect(() => {
    let dead = false;
    setSizes(null);
    void Promise.all(
      targets.map(
        (f) =>
          new Promise<[string, [number, number]]>((res) => {
            const im = new Image();
            im.onload = () => res([f, [im.naturalWidth, im.naturalHeight]]);
            // 못 읽으면 화면 값으로 둔다 — 목표 크기는 어차피 서버가 원본에서 다시 잰다
            im.onerror = () => res([f, [params.width, params.height]]);
            im.src = imgUrl(base, ws, f);
          }),
      ),
    ).then((pairs) => {
      if (dead) return;
      const m = Object.fromEntries(pairs);
      setSizes(m);
      // ★기본 선택은 **전부가 쓸 수 있는 가장 큰 배율**이다. 한 장이면 그 장의 최대라
      //   단일 강화의 동작이 그대로다 (공홈과 같다).
      const opts = Object.values(m).map(([w, h]) => enhanceScaleOptions(w, h));
      setScale([2, 1.5, 1].find((s) => opts.every((o) => o.includes(s))) ?? 1);
    });
    return () => {
      dead = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [base, ws, targets]);

  /** 장마다 메타데이터를 읽는다 — ★크기 읽기와 **따로** 돈다. 한쪽이 실패해도 다른 쪽은
   *  살아 있어야 하고, 메타데이터가 없는 그림도 강화 자체는 돌아가야 한다. */
  useEffect(() => {
    let dead = false;
    setMetas(null);
    void Promise.all(
      targets.map(async (f) => {
        try {
          const r = await api<{ meta: ImageMeta | null }>(
            `/api/gallery/${encodeURIComponent(ws)}/meta?file=${encodeURIComponent(f)}`,
          );
          return [f, r.meta] as const;
        } catch {
          // 못 읽는 것은 정상 경우다 (밖에서 가져온 그림) — 화면 값으로 떨어진다
          return [f, null] as const;
        }
      }),
    ).then((pairs) => {
      if (!dead) setMetas(Object.fromEntries(pairs));
    });
    return () => {
      dead = true;
    };
  }, [ws, targets]);

  /** 메타데이터가 없어 **지금 화면 값**으로 도는 장 수 — 창에 한 줄로 알린다 */
  const noMeta = metas ? targets.filter((f) => !hasMeta(metas[f])).length : 0;

  const preset = MAGNITUDE[mag] ?? MAGNITUDE[3];
  const useStrength = adv ? strength : preset.strength;
  const useNoise = adv ? noise : preset.noise;
  // ★고른 강도를 기억해 둔다 — 다음에 열 때 이 값으로 뜬다
  useEffect(() => {
    useUi.getState().setEnhanceLast({ mag, adv, strength, noise });
  }, [mag, adv, strength, noise]);

  /** 이 장에 실제로 나갈 배율 — ★못 쓰는 배율이면 **쓸 수 있는 가장 큰 것으로 내린다**.
   *  배치는 크기가 섞여 있어 한 배율이 전부에 맞는 일이 드물다 (v2 규칙, `lib/enhance.ts`). */
  const scaleOf = (f: string) => {
    const d = sizes?.[f];
    return d ? clampEnhanceScale(d[0], d[1], scale) : scale;
  };
  /** 이 장에 실제로 나갈 steps — 메타데이터에 있으면 그 값, 없으면 화면 값 (`metaJob` 과 같은 규칙) */
  const stepsOf = (f: string) => {
    const m = metas?.[f];
    return (hasMeta(m) ? metaParams(m!).steps : undefined) ?? params.steps;
  };
  /** 이 장에 실제로 나갈 모델 — steps 와 **같은 규칙**이다 (`metaJob` 이 그 값을 싣는다).
   *  ★V5 는 Anlas 배율이 1.5라, 화면 모델로 세면 옛 V4.5 그림을 강화할 때 표시가 어긋난다. */
  const modelOf = (f: string) => {
    const m = metas?.[f];
    return (hasMeta(m) ? (metaParams(m!).model as string | undefined) : undefined) ?? params.model;
  };
  /** 배율이 내려간 장 수 — ★**누르기 전에** 알린다 (v2 는 큐에 넣고 나서 토스트로 알렸다) */
  const adjusted = sizes ? targets.filter((f) => scaleOf(f) !== scale).length : 0;
  // ★배율 선택지는 대상 **아무나** 쓸 수 있는 것까지 보여 준다. 한 장이면 그 장의 목록 그대로다
  const scales = sizes
    ? [2, 1.5, 1].filter((s) =>
        targets.some((f) => {
          const d = sizes[f];
          return d ? enhanceScaleOptions(d[0], d[1]).includes(s) : s === 1;
        }),
      )
    : [1];
  // ★목표 해상도는 `align64(floor(원본 × 배율))` 이다 — round 가 아니다
  const one = targets.length === 1 && sizes ? sizes[targets[0]] : null;
  const target: [number, number] = one
    ? enhanceTargetSize(one[0], one[1], scaleOf(targets[0]))
    : [params.width, params.height];

  /** ★값을 **누르기 전에** 보여 준다 (사용자 지적 2026-08-14).
   *  강화는 i2i 라 강도가 값에 들어간다. 배율을 올리면 크기가 커져 값도 뛴다.
   *  ★배치는 크기가 장마다 달라 **장마다 세서 더한다** — 한 장 값에 장 수를 곱하면 어긋난다. */
  const each = targets.map((f) => {
    const d = sizes?.[f];
    const [w, h] = d ? enhanceTargetSize(d[0], d[1], scaleOf(f)) : [params.width, params.height];
    return anlasCost({
      // ★steps 도 **그 그림의 것**이다 — 요청에 그 값이 나가므로(`metaJob`) 화면 값으로 세면
      //   표시 비용과 실제 청구가 어긋난다 (v2 는 사이드바 steps 로 세어 어긋나 있었다)
      // ★모델도 **그 그림의 것**이다 — V5 는 배율이 1.5 라 이걸 빼면 표시가 실제의 2/3 가 된다
      model: modelOf(f), width: w, height: h, steps: stepsOf(f), opus,
      uncachedVibes: 0, activeVibes: 0, refCount: 0,
      strength: useStrength, count: 1,
    });
  });
  const cost = {
    perImage: each[0]?.perImage ?? 0,
    total: each.reduce((s, c) => s + c.total, 0),
    encoding: 0,
    free: each.length > 0 && each.every((c) => c.free),
    overLimit: each.some((c) => c.overLimit),
  };

  const run = async () => {
    if (busy) return;
    setBusy(true);
    try {
      // ★한 장이어도 **큐로 보낸다** (사용자 지적 2026-08-14).
      //   예전에는 한 장일 때만 `generate()` 로 직접 돌아서, 다 될 때까지 창이 안 닫히고
      //   조작이 막혔다. 대기 칸도 안 떴다. 큐로 보내면 누른 즉시 자리가 잡힌다.
      const { prompt, uc, chars } = usePrompt.getState().compiled();
      // ★어느 씬 칸의 그림인가. 안 실으면 씬 탭에서 결과가 어디에도 안 뜬다 (`lib/takes.ts`)
      const cellId = useSceneFocus.getState().cell;
      const scenes = setNow?.kind === "sceneGroup" ? allScenes(setNow) : [];
      const found = cellId ? scenes.find((x) => x.cell.id === cellId) : null;
      /** 그 그림이 원래 있던 씬 칸 — ★배치는 **여러 씬에 걸쳐** 고른다. 보고 있는 칸 하나로
       *  전부 보내면 다른 줄의 그림을 강화한 결과가 엉뚱한 줄에 붙는다.
       *  칸을 못 찾으면 base 의 것(지금 보는 칸)이 그대로 쓰인다 (`store/queue` enqueue 주석). */
      const cellOf = (f: string) => {
        const id = records.find((r) => r.file === f)?.cell_id;
        const at = id ? scenes.find((x) => x.cell.id === id) : null;
        return at ? { cell: at.cell.name, cell_id: at.cell.id } : {};
      };
      // ★그림은 **서버가 읽는다** — 화면이 4.6MB base64 를 실어 보내지 않는다 (`enhance_from`).
      //   ★뿌리를 가리킨다: 강화본을 또 강화해도 스택이 평평해야 버전 넘기기가 안 꼬인다.
      //   ★배율은 **장마다** 다를 수 있다 (`scaleOf` — 못 쓰는 배율은 내려간다).
      //   ★★그리고 **그 그림의 메타데이터**를 얹는다 (머리 주석). 큐는 항목의 값만 base 위에
      //     덮으므로(`server._process_job`), 메타데이터가 안 준 자리는 저절로 아래 base 의
      //     화면 값이 된다 — v2 의 `normalized?.x || 사이드바` 와 같은 결과다.
      const jobs = targets.map((f) => ({
        enhance_from: f,
        enhance_scale: scaleOf(f),
        enhance_of: records.find((r) => r.file === f)?.enhance_of || f,
        base_strength: useStrength,
        base_noise: useNoise,
        ...cellOf(f),
        ...metaJob(metas?.[f] ?? null),
      }));
      // ★창을 **먼저** 닫는다 (사용자 지적 2026-08-14: 다 될 때까지 안 꺼졌다).
      //   큐는 보내기 전에 대기 칸을 미리 잡아 두므로, 닫자마자 그 자리가 보인다.
      onClose();
      // ★큐에 넣기 직전의 잔액을 적어 둔다. 끝나면 실제 청구가 나온다 (`store/anlasMeter`).
      //   ★기록에 남기는 해상도·steps 는 **첫 장의 것**이다. 배치는 장마다 크기가 달라
      //     하나로 대표할 수 없다 (값 자체는 위 `each` 가 장마다 세서 더한 것이라 맞다).
      const d0 = sizes?.[targets[0]];
      const [w0, h0] = d0 ? enhanceTargetSize(d0[0], d0[1], scaleOf(targets[0])) : target;
      useAnlasMeter.getState().arm(cost.total, {
        width: w0, height: h0, steps: stepsOf(targets[0]), opus,
        refs: 0, vibes: 0, inpaint: false, count: targets.length, from: "enhance",
      });
      await useQueue.getState().enqueue(
        {
          ...useGen.getState().params,
          ...useImageInput.getState().payload(),
          prompt, negative_prompt: uc, characters: chars,
          /* ★열쇠 짝은 낱말표 그대로다 (`shared/terms.json`): `tab`=탭 이름 ·
             `set`=세트 이름 · `scene_group_id`=그 세트의 id. 개명 뒤에도 여기가 옛 짝
             (`char`=탭 이름, `tab`=세트 이름)으로 남아 저장 경로의 탭 칸이 비어 있었다. */
          workspace: ws, tab: tabName, scene_group: setName, scene_group_id: setNow?.id ?? null,
          // ★이 워크스페이스의 계정으로 (점검 2026-09-02: 빠져 있어 강화가 첫 계정으로 나갔다)
          account: currentAccountId(),
          ...(found ? { cell: found.cell.name, cell_id: found.cell.id } : {}),
        },
        jobs,
        1,
      );
    } catch (e) {
      // ★조용히 실패하지 않는다 — 실측으로 밟았다 (그림을 못 읽어 아무 일도 안 일어났다)
      useGen.setState({ error: String(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      data-enhance
      onPointerDown={(e) => e.target === e.currentTarget && onClose()}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 85,
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
          padding: "var(--sp-5)",
          width: "min(420px, 92vw)",
          display: "flex",
          flexDirection: "column",
          gap: "var(--sp-4)",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "var(--sp-3)" }}>
          <b style={{ fontSize: "var(--text-md)" }}>{t("enhance.title")}</b>
          <span style={{ flex: 1 }} />
          <button data-enhance-close onClick={onClose} style={{ color: "var(--ink-faint)", display: "grid" }}>
            {Icon.close}
          </button>
        </div>

        {/* 배치일 때만 — 몇 장을 돌리고 몇 장을 뺐나 */}
        {files.length > 1 && (
          <Row label={t("enhance.targets")}>
            <span data-enhance-targets={targets.length} style={{ fontSize: "var(--text-2xs)", color: "var(--ink)" }}>
              {t("slots.count", { n: targets.length })}
            </span>
            {skipped.length > 0 && (
              <span
                data-enhance-skipped={skipped.length}
                data-tip={t("slots.enhanceSkip")}
                style={{ fontSize: "var(--text-2xs)", color: "var(--ink-faint)" }}
              >
                {t("enhance.excluded", { n: skipped.length })}
              </span>
            )}
          </Row>
        )}

        <Row label={t("enhance.size")}>
          {[...scales].reverse().map((s) => (
            <button
              key={s}
              data-enhance-scale={s}
              onClick={() => setScale(s)}
              style={{ ...chip, ...(scale === s ? on : {}) }}
            >
              {s}×
            </button>
          ))}
          <span style={{ fontSize: "var(--text-2xs)", color: "var(--ink-faint)", fontFamily: "var(--font-mono)" }}>
            {!sizes ? t("enhance.measuring") : one ? `${target[0]}×${target[1]}` : ""}
          </span>
        </Row>

        {/* ★배율이 내려가는 장이 있으면 **누르기 전에** 알린다 (v2 는 큐에 넣은 뒤 토스트였다) */}
        {adjusted > 0 && (
          <span
            data-enhance-adjusted={adjusted}
            style={{ fontSize: "var(--text-2xs)", color: "var(--warn)" }}
          >
            {t("enhance.scaleAdjusted", { n: adjusted, s: scale })}
          </span>
        )}

        {/* ★메타데이터가 없는 그림은 **지금 화면 값**으로 돈다. v2 는 말없이 그렇게 했는데,
            여기서는 왜 다른 결과가 나오는지 알 수 있게 한 줄로 알린다 */}
        {noMeta > 0 && (
          <span
            data-enhance-nometa={noMeta}
            style={{ fontSize: "var(--text-2xs)", color: "var(--ink-faint)" }}
          >
            {t("enhance.noMeta", { n: noMeta })}
          </span>
        )}

        {!adv && (
          <Row label={t("enhance.magnitude")}>
            {[1, 2, 3, 4, 5].map((m) => (
              <button
                key={m}
                data-enhance-mag={m}
                onClick={() => setMag(m)}
                style={{ ...chip, ...(mag === m ? on : {}) }}
              >
                {m}
              </button>
            ))}
          </Row>
        )}

        {adv && (
          <>
            <Row label={t("imgIn.strength")}>
              {/* ★범위는 v2 그대로다 (`enhanceStrengthSlider`, index.html:10469 · 0~1 step .01).
                  사용자 결정 2026-08-18 로 되돌렸다 */}
              <input
                type="range"
                data-enhance-strength
                min={0}
                max={1}
                step={0.01}
                value={strength}
                onChange={(e) => setStrength(Number(e.target.value))}
                style={{ flex: 1 }}
              />
              <span style={{ width: 34, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{strength}</span>
            </Row>
            <Row label={t("imgIn.noise")}>
              <input
                type="range"
                min={0}
                max={1}
                step={0.01}
                value={noise}
                onChange={(e) => setNoise(Number(e.target.value))}
                style={{ flex: 1 }}
              />
              <span style={{ width: 34, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{noise}</span>
            </Row>
          </>
        )}

        <label style={{ display: "flex", alignItems: "center", gap: "var(--sp-2)", fontSize: "var(--text-2xs)", color: "var(--ink-soft)" }}>
          <input type="checkbox" data-enhance-adv checked={adv} onChange={(e) => setAdv(e.target.checked)} />
          {t("enhance.advanced")}
        </label>

        <span style={{ fontSize: "var(--text-2xs)", color: "var(--ink-faint)" }}>
          {t("enhance.hint", { s: useStrength, n: useNoise })}
        </span>

        {/* ★한 장이 140 Anlas 를 넘으면 실행을 막는다 — 생성 쪽과 **같은 판정**이다
            (v2 `index.html:24419-24438`. 인핸스는 언제나 한 장이라 그대로 개별 비용 기준).
            배율을 올리면 해상도가 뛰어 여기서 자주 걸린다 */}
        {cost.overLimit && (
          <span data-enhance-over-limit style={{ fontSize: "var(--text-2xs)", color: "var(--err-ink)" }}>
            {t("gen.overLimit", { a: MAX_PER_IMAGE })}
          </span>
        )}

        {/* 고른 것이 전부 이미 강화한 그림이면 돌릴 것이 없다 */}
        {!targets.length && (
          <span data-enhance-no-target style={{ fontSize: "var(--text-2xs)", color: "var(--warn)" }}>
            {t("enhance.noTarget")}
          </span>
        )}

        <button
          data-enhance-run
          onClick={() => void run()}
          /* ★메타데이터를 다 읽기 전에는 못 누른다 — 그 전에 보내면 **전부 화면 값**으로
             나가서, 고치려던 그 결함(D1)이 그대로 재현된다 */
          disabled={busy || !sizes || !metas || !targets.length || cost.overLimit}
          style={{
            background: cost.overLimit || !targets.length ? "var(--panel)" : "var(--accent)",
            color: cost.overLimit || !targets.length ? "var(--ink-faint)" : "var(--accent-on)",
            borderRadius: "var(--r-2)",
            padding: "var(--sp-3)",
            fontWeight: "var(--w-semi)",
            fontSize: "var(--text-sm)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: "var(--sp-2)",
          }}
        >
          {Icon.spark}
          {targets.length > 1 ? t("enhance.runN", { n: targets.length }) : t("enhance.run")}
          <span style={{ opacity: 0.82, fontVariantNumeric: "tabular-nums" }}>
            {t("focus.oneCost", { a: cost.total })}
          </span>
        </button>
      </div>
    </div>
  );
}

/** 그 그림의 메타데이터를 **이 요청의 값**으로 (v2 `buildEnhanceRequest`, `index.html:24455-24486`).
 *
 *  ★없는 값은 **안 싣는다** — 그 자리는 큐가 base(지금 화면)로 채운다. v2 의
 *    `normalized?.x || 사이드바` 를 항목/기본값 두 층으로 옮긴 것이다.
 *  ★생성 설정의 표는 `lib/metaApply` 하나다 (갤러리의 「설정 불러오기」와 같은 표).
 *  ★캐릭터는 **메타데이터가 있으면 그것으로 갈아 끼운다** — 없던 그림이면 빈 목록이 되어
 *    화면의 캐릭터가 안 섞인다 (v2 도 `normalized?.character_prompts || []` 로 비웠다).
 *    좌표는 안 싣는다: v2 도 `{prompt, uc}` 만 보낸다 (`index.html:24472`).
 *  ★시드·해상도는 여기 없다 (머리 주석). */
function metaJob(m: ImageMeta | null): Record<string, unknown> {
  if (!hasMeta(m)) return {};
  const o: Record<string, unknown> = { ...metaParams(m!) };
  if (m!.prompt) o.prompt = m!.prompt;
  if (m!.negative) o.negative_prompt = m!.negative;
  o.characters = (m!.characters ?? []).map((c) => ({ prompt: c.prompt, uc: c.negative }));
  return o;
}

const Row = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <div style={{ display: "flex", alignItems: "center", gap: "var(--sp-2)" }}>
    <span style={{ width: 62, flexShrink: 0, fontSize: "var(--text-2xs)", color: "var(--ink-faint)" }}>{label}</span>
    {children}
  </div>
);

const chip: React.CSSProperties = {
  border: "1px solid var(--line)",
  borderRadius: "var(--r-2)",
  background: "var(--panel)",
  color: "var(--ink-soft)",
  padding: "3px var(--sp-4)",
  fontSize: "var(--text-2xs)",
};
const on: React.CSSProperties = {
  borderColor: "var(--accent)",
  background: "var(--accent-bg)",
  color: "var(--ink)",
};
