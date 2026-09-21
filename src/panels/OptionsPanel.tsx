import { useI18n } from "../i18n";
import { Category } from "./Category";
import { useEffect, useState } from "react";
import { DEFAULT_MODEL, MODELS, NAI_MAX, SIZE_PRESETS, alignTo64, modelCaps, useGen, type GenParams } from "../store/gen";
import { pushUndo } from "../lib/undo";
import { Icon } from "../components/Icon";
import { Ratio } from "../components/Ratio";
import { Help } from "../components/Tip";
import { ImageInputBadge, ImageInputPanel } from "./ImageInputPanel";
import { flashStyle, useFlash, useUi } from "../store/ui";

const SAMPLERS = ["k_euler_ancestral", "k_euler", "k_dpmpp_2m", "k_dpmpp_2m_sde", "k_dpmpp_2s_ancestral", "k_dpmpp_sde"];
const SCHEDULERS = ["karras", "native", "exponential", "polyexponential"];
/* ★프리셋 이름표(`QP_LABEL`)와 UC 프리셋 목록은 **`panels/PromptOpts`** 로 옮겼다 —
   그 컨트롤이 프롬프트 칸 하단으로 갔기 때문이다 (2026-08-23). */

/** 우측 패널 — 생성 파라미터. */
/** 생성 옵션 — ★**왼쪽 프롬프트 아래**에 산다 (사용자 지시 2026-08-16).
 *  오른쪽 기둥은 카드덱이 쓴다. 여기 있는 것들은 프롬프트와 함께 보면서 만지는 값이다.
 *  ★묶음마다 접힌다 — 한 기둥에 프롬프트까지 들어오므로 다 펴 두면 훑을 수가 없다.
 *    접기 단추는 따로 두지 않는다. **묶음 이름을 누르면** 접힌다. */
export function OptionsPanel() {
  const p = useGen((s) => s.params);
  const set = useGen((s) => s.set);
  const t = useI18n((s) => s.t);
  /** 값 하나를 **되돌릴 수 있게** 바꾼다 (사용자 지시 2026-08-22:
   *  *"생성옵션 패널에 있는 숫자, 텍스트 입력은 전부 undo 리스트에 들어가야함"*).
   *
   *  ★★`useGen.set` 안에 넣지 않는다. 그 창구는 **사람이 안 만진 변경**도 지난다 —
   *    설정 불러오기·베이스 그림에 해상도 맞추기·시드 굴리기가 전부 거기로 간다.
   *    거기 담으면 `Ctrl+Z` 한 번이 사람이 한 적 없는 것을 되돌린다.
   *  ★**이름을 함께 담는다** — 되돌린 것이 무엇인지 토스트가 말한다 (`lib/undo` 의 ★주).
   *  ★안 바뀌었으면 안 담는다. 칸만 열고 닫아도 쌓이면 `Ctrl+Z` 가 몇 번씩 헛돈다. */
  const setUndo = <K extends keyof GenParams>(k: K, v: GenParams[K], label: string) => {
    const before = useGen.getState().params[k];
    if (before === v) return;
    pushUndo(label, () => useGen.getState().set(k, before));
    set(k, v);
  };
  /** ★★**이 모델에서 되는 것만 보여 준다** (사용자 지시 2026-08-21).
   *
   *  V5 는 스케줄러·Variety+ 가 아예 없다 — 서버가 무시하는 컨트롤을 남겨 두면 사용자는
   *  켰다고 믿고 결과만 다르게 나온다. 능력표는 `lib/naiModels.ts` 하나다. */
  const cap = modelCaps(p.model);

  return (
    /* ★★좌우 여백을 주지 않는다 (사용자 지적 2026-08-19) — 이 패널은 프롬프트와 **같은
       스크롤 칸 안**에 산다 (`PromptPanel`). 여기서 또 주면 「NAI 설정」부터 한 칸씩
       들여쓰기가 되어, 위의 「베이스 프롬프트」와 시작점이 어긋난다. */
    <div style={{ paddingBottom: "var(--sp-4)", display: "flex", flexDirection: "column", gap: "var(--sp-3)" }}>
      {/* ★★묶음은 **페로픽스 v2 의 절 그대로**다 (`index.html` 통째로 대조 2026-08-16):
            NAI Settings · Generation · Vibe / Character Ref · Base Image · Save Options.
          ★접는 층은 **카테고리 하나뿐**이다 — 항목마다 접으면 훑을 수가 없다. */}
      {/* ★★처음에는 **다 접혀 있다** (사용자 지시 2026-08-20) — 첫 화면에 펴 두는 것은
          베이스·캐릭터 프롬프트 둘뿐이다. 옵션은 한 번 정하면 잘 안 건드리는데, 다 펴 두면
          프롬프트가 화면 밖으로 밀린다. 접힘은 사람이 편 대로 기억된다(`Category` 의 `foldState`). */}
      {/* ★★「NAI 설정」과 「생성」을 **하나로 합쳤다** (사용자 지시 2026-08-26). 앞의 것은
          모델 고르기 하나뿐이라 카테고리를 따로 세울 만큼의 내용이 없었다. 이름은 「생성 옵션」.
          ★순서도 사용자가 정한 대로다: 생성 옵션 · 베이스 이미지 · 해상도 · 저장 옵션. */}
      <Category id="opt-gen" label={t("options.catGeneration")} defaultFolded flashKey="params">
        <div style={{ display: "flex", flexDirection: "column", gap: "var(--sp-4)" }}>
              <Group label={t("options.model")}>
                {/* ★옛 워크스페이스가 없어진 모델(V4.0)을 들고 있으면 목록에 없어 빈칸으로 보인다 —
                    기본값으로 되돌린다. 조용히 다른 표로 생성되는 것보다 낫다 */}
                <Select
                  value={MODELS.some(([id]) => id === p.model) ? p.model : DEFAULT_MODEL}
                  options={MODELS}
                  onChange={(v) => set("model", v)}
                />
              </Group>

              {/* ★★Variety+ 는 **모델 바로 아래**다 (사용자 지시 2026-08-26: *"모델에 따라
                  변하는 거니까 그쪽에 있어야함"*). V5 에는 이 기능 자체가 없어서
                  (`cfgDelay` 거짓 — 서버가 `skip_cfg_above_sigma` 를 지운다) 모델을 바꾸면
                  칸이 생겼다 없어진다. 그 변화가 **무엇 때문인지 눈에 보이는 자리**가 여기다.
                  ★안이 비면 이름표만 선 빈 칸이 되므로 묶음째 안 낸다. */}
              {cap.cfg_delay && (
                <Group label={t("options.misc")}>
                  <Check label={t("options.varietyPlus")} checked={p.variety_plus} onChange={(v) => set("variety_plus", v)} />
                </Group>
              )}

              {/* ★시드는 여기 없다 — **생성 버튼 옆 하나**로 옮겼다 (사용자 지시 2026-08-04).
                  매번 만지는 유일한 옵션이라 생성 버튼 곁이 맞고, 두 곳에 두면 어느 쪽이
                  진짜인지 흐려진다 (하나의 정보에는 하나의 창구). → `GenerateFooter` */}
              {/* ★★퀄리티 프리셋·UC 프리셋·투명 배경·퍼리 모드는 **여기 없다**
                  (사용자 지시 2026-08-23). 넷 다 서버에서 **프롬프트 문자열이 되는** 것이라
                  글을 적는 칸 하단으로 옮겼다 — 공홈도 그 자리에 둔다 (`panels/PromptOpts`).
                  ★같은 값을 두 곳에서 만지게 되돌리지 말 것. */}
              {/* ★V5 에는 Variety+ 자체가 없다 (`cfgDelay` 거짓) — 서버가 값을 지운다.
                  ★그러면 묶음도 **통째로 안 낸다** — 넷이 빠져 나가면서 이 묶음에 남은 것이
                    Variety+ 하나뿐이라, 이름표만 선 빈 칸이 된다 */}
              {/* ★★**그리는 중인 그림 보기는 여기 없다** (사용자 지시 2026-08-26:
                   *"스트리밍 온오프 옵션은 생성부가 아니고 옵션 패널에 넣어"*).
                 결과를 바꾸지 않는 **보는 방식**이라, 큐 알림·소리와 같은 자리인
                 앱 설정의 「생성」 묶음으로 갔다 (`app/Settings`). 여기로 되돌리지 말 것 —
                 같은 값을 두 곳에서 만지게 된다. */}
              <Group label={t("options.steps")} help={t("options.stepsHint")}>
                <Num value={p.steps} min={1} max={NAI_MAX.steps} onChange={(v) => setUndo("steps", v, t("options.steps"))} />
              </Group>
              <Group label={t("options.cfg")}>
                <Num value={p.cfg} min={1} max={NAI_MAX.cfg} step={0.1} onChange={(v) => setUndo("cfg", v, t("options.cfg"))} />
              </Group>
              {cap.cfg_rescale && (
                <Group label={t("options.cfgRescale")}>
                  <Num value={p.cfg_rescale} min={0} max={1} step={0.02} onChange={(v) => setUndo("cfg_rescale", v, t("options.cfgRescale"))} />
                </Group>
              )}
              <Group label={t("options.sampler")}>
                <Select value={p.sampler} options={SAMPLERS} onChange={(v) => set("sampler", v)} />
              </Group>
              {/* ★★V5 는 스케줄러를 못 고른다 — 공홈 전송 구간이 **karras 로 덮어쓴다.**
                  칸을 남겨 두면 고른 값이 안 나가는데 화면만 그대로라 거짓말이 된다. */}
              {cap.noise_schedule && (
                <Group label={t("options.scheduler")}>
                  <Select value={p.scheduler} options={SCHEDULERS} onChange={(v) => set("scheduler", v)} />
                </Group>
              )}
        </div>
      </Category>

      {/* v2 의 `Vibe / Character Ref` + `Base Image` 절 */}
      {/* ★★딱지는 **패널 밖**이다 — 이 묶음은 접히면 안이 통째로 언마운트되므로, 걸려 있는
          그림을 알리는 표시가 안에 있으면 접힌 동안 아무것도 못 말한다 (`ImageInputBadge`) */}
      <Category id="opt-img" label={t("options.catImage")} badge={<ImageInputBadge />} defaultFolded flashKey="base" flashQuiet>
        <ImageInputPanel />
      </Category>

      {/* ★★해상도는 **따로 선 카테고리**다 (사용자 지시 2026-08-19). 생성 옵션 안에 있으면
          설정을 얹을 때 강조 테두리가 **겹쳐 그려진다** (묶음 하나와 카테고리 하나가 서로
          안쪽·바깥쪽으로). 강조 자리가 겹치지 않으려면 층이 하나여야 한다. */}
      <Category id="opt-size" label={t("options.resolution")} defaultFolded flashKey="size">
        {/* ★★모양이 곧 목록이다 (페로픽스파이 `.res-item` 이식). 전부 늘어놓으면 열넷이라
            훑을 수가 없어서 **가로·세로·정방 탭**으로 가르고, 줄마다 그 비율의 사각형을
            함께 그린다 — 숫자보다 모양이 먼저 읽힌다. */}
        <div style={{ display: "flex", flexDirection: "column", gap: "var(--sp-2)" }}>
          <SizePicker w={p.width} h={p.height} onPick={(w, h) => { set("width", w); set("height", h); }} />
          {/* ★직접 입력 — NAI 는 64 배수만 받는다. 입력을 떠날 때 올려 맞추고 그 값을 보여 준다
              (서버도 같은 정렬을 하지만, 무엇이 갈지 지금 보여야 한다) */}
          <div style={{ display: "flex", alignItems: "center", gap: "var(--sp-2)" }}>
            <NumBox data-size="w" value={p.width} onCommit={(v) => setUndo("width", alignTo64(v), t("options.resolution"))} />
            <span style={{ color: "var(--ink-faint)", fontSize: "var(--text-2xs)" }}>×</span>
            <NumBox data-size="h" value={p.height} onCommit={(v) => setUndo("height", alignTo64(v), t("options.resolution"))} />
          </div>
        </div>
      </Category>

      <Category id="opt-save" label={t("options.catSave")} defaultFolded>
        <div style={{ display: "flex", flexDirection: "column", gap: "var(--sp-4)" }}>
              <Group label={t("options.saveOptions")}>
                {/* ★★내는 형식은 **PNG·WebP 둘뿐**이다 (사용자 결정 2026-08-23) — 공홈과 같다.
                    JPG 는 투명이 없고 픽셀을 뭉개므로 **저장 형식에서 뺐다** (읽는 것은 그대로다).
                    ★품질 칸도 함께 걷었다 — 둘 다 품질이라는 것이 없다 (PNG·**무손실** WebP).
                      그래서 「투명이 사라진다」는 경고도 설 자리가 없어졌다. */}
                <Select
                  value={p.save_format === "webp" ? "webp" : "png"}
                  options={[["png", "PNG"], ["webp", "WebP (Lossless)"]]}
                  onChange={(v) => set("save_format", v)}
                />
                {/* ★그림을 공유할 때만 쓴다 — 지우면 그 그림으로 재생성할 수 없다 */}
                <Check
                  label={t("options.stripMetadata")}
                  help={t("options.stripHint")}
                  checked={p.strip_metadata}
                  onChange={(v) => set("strip_metadata", v)}
                />
        {/* ★v2 `autoSaveToggle` — 끄면 파일도 기록도 안 남기고 미리보기만 (대조 2026-08-16) */}
        <Check
          label={t("options.autoSave")}
          help={t("options.autoSaveHint")}
          checked={p.auto_save}
          onChange={(v) => set("auto_save", v)}
        />
        {/* ★v2 `excludeSlotNumber` — 옮기다 빠져 있었다 (대조 2026-08-16).
            번호는 탐색기에서 씬 순서를 만드는 것이라, 순서가 필요 없을 때만 끈다. */}
        <Check
          label={t("options.excludeSlotNo")}
          checked={p.exclude_slot_number}
          onChange={(v) => set("exclude_slot_number", v)}
        />
              </Group>
        </div>
      </Category>

    </div>
  );
}

/** 해상도 고르기 — **가로·세로·정방 탭** + 그 비율을 그린 목록 (사용자 지시 2026-08-19).
 *
 *  ★페로픽스파이의 `.res-item` 을 옮긴 것이다: [비율 사각형][W × H][묶음 이름].
 *  ★★**탭을 누르면 그 방향이 바로 걸린다** (사용자 지시 2026-08-22). 방향마다 마지막에
 *    고른 크기를 기억해 두고(`useUi.sizeLast`) 그것을 건다 — 세로로 뽑다가 가로로 옮길 때
 *    목록에서 한 번 더 고르지 않아도 된다.
 *    ★그래서 **지금 탭은 지금 값이 곧 알려 준다** (`dirOf(w, h)`) — 따로 들고 있지 않는다.
 *      들고 있으면 밖에서 해상도가 바뀔 때(설정 불러오기·베이스 그림 맞춤) 둘이 어긋난다.
 *  ★★탭에도 **비율 사각형**을 그린다 (사용자 지시 2026-08-22) — 이름만으로는 가로·세로가
 *    한눈에 안 들어온다. 목록의 사각형과 **같은 방식**으로 그린다 (긴 변을 맞춘다).
 *  ★묶음(Small·Large·Wallpaper)은 지우지 않고 **줄 오른쪽에 이름으로** 남긴다 — 가르는
 *    축은 방향 하나뿐이어야 훑을 수 있다. */
function SizePicker({ w, h, onPick }: { w: number; h: number; onPick: (w: number, h: number) => void }) {
  const t = useI18n((s) => s.t);
  const sizeLast = useUi((u) => u.sizeLast);
  const setSizeLast = useUi((u) => u.setSizeLast);
  const dirOf = (a: number, b: number): SizeDir => (a > b ? "landscape" : a === b ? "square" : "portrait");
  const tab = dirOf(w, h);

  /** 고르면 그 방향의 마지막 값으로 적어 둔다 — 탭을 오갈 때 이것이 돌아온다 */
  const pick = (pw: number, ph: number) => {
    setSizeLast(dirOf(pw, ph), [pw, ph]);
    onPick(pw, ph);
  };

  const shown = SIZE_PRESETS.flatMap((g) => g.items.map((it) => ({ group: g.group, item: it })))
    .filter((x) => dirOf(x.item[0], x.item[1]) === tab);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--sp-2)" }}>
      <div style={{ display: "flex", gap: "var(--sp-2)" }}>
        {(["landscape", "portrait", "square"] as const).map((d) => {
          const on = tab === d;
          const [lw, lh] = sizeLast[d] ?? DIR_FALLBACK[d];
          return (
            <button
              key={d}
              data-size-tab={d}
              // ★누르는 순간 그 방향이 걸린다 — 목록은 그 결과로 따라 바뀐다
              onClick={() => pick(lw, lh)}
              style={{
                flex: 1,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                gap: 5,
                padding: "3px var(--sp-2)",
                borderRadius: "var(--r-2)",
                border: `1px solid ${on ? "var(--accent)" : "var(--line)"}`,
                background: on ? "var(--accent-bg)" : "var(--panel)",
                color: on ? "var(--ink)" : "var(--ink-dim)",
                fontSize: "var(--text-2xs)",
                fontWeight: on ? "var(--w-semi)" : "var(--w-normal)",
              }}
            >
              <Ratio w={lw} h={lh} max={13} on={on} />
              {t(`options.${d}`)}
            </button>
          );
        })}
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
        {shown.map(({ group, item: [pw, ph, star] }) => {
          const on = w === pw && h === ph;
          return (
            <button
              key={`${pw}x${ph}`}
              data-size-preset={`${pw}x${ph}`}
              onClick={() => pick(pw, ph)}
              style={{
                display: "flex",
                alignItems: "center",
                gap: "var(--sp-3)",
                padding: "3px var(--sp-2)",
                borderRadius: "var(--r-2)",
                border: `1px solid ${on ? "var(--accent)" : "var(--line)"}`,
                background: on ? "var(--accent-bg)" : "var(--bg)",
                color: "var(--ink)",
                fontSize: "var(--text-2xs)",
                textAlign: "left",
              }}
            >
              <span style={{ width: 28, height: 28, display: "grid", placeItems: "center", flexShrink: 0 }}>
                <Ratio w={pw} h={ph} max={26} on={on} />
              </span>
              <span style={{ flex: 1, fontFamily: "var(--font-mono)", fontVariantNumeric: "tabular-nums" }}>
                {pw}×{ph}
              </span>
              {star && (
                <span data-tip={t("options.starHint")} style={{ display: "inline-grid", color: "var(--ink-faint)" }}>
                  {Icon.spark12}
                </span>
              )}
              <span style={{ width: 62, textAlign: "right", color: "var(--ink-faint)" }}>
                {t(`options.sizeGroup.${group}`)}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

type SizeDir = "landscape" | "portrait" | "square";

/** 저장된 값이 없을 때의 방향별 기본 — `store/ui` 의 초기값과 같아야 한다 */
const DIR_FALLBACK: Record<SizeDir, [number, number]> = {
  landscape: [1216, 832],
  portrait: [832, 1216],
  square: [1024, 1024],
};

function Group({
  label,
  flashKey,
  help,
  children,
}: {
  label: string;
  /** 방금 이 자리가 바뀌었으면 강조한다 (`useUi.reveal`) */
  flashKey?: string;
  /** ★설명은 **라벨 옆 `?`** 로만 나온다 (사용자 지시 2026-08-19) — 화면에 펼쳐 두지 않는다 */
  help?: string;
  children: React.ReactNode;
}) {
  const on = useFlash(flashKey ?? "");
  // ★★항목은 **안 접힌다.** 접는 층은 카테고리 하나뿐이다 (`Category` 머리 주석) —
  //   항목마다 접히면 훑을 수가 없고, 위(카드)와 아래(항목)가 따로 노는 화면이 된다
  //   (사용자 지적 2026-08-16).
  return (
    <div
      data-flash={flashKey && on ? "" : undefined}
      data-opt-group={label}
      style={{ display: "flex", flexDirection: "column", gap: "var(--sp-2)", ...flashStyle(!!flashKey && on) }}
    >
      <span style={{ display: "flex", alignItems: "center", gap: "var(--sp-2)", fontSize: "var(--text-xs)", fontWeight: "var(--w-semi)", color: "var(--ink-soft)" }}>
        {label}
        {help && <Help tip={help} />}
      </span>
      {children}
    </div>
  );
}

/** ★페로픽스파이의 `input, select, textarea, button` 규칙과 같은 모양
 *  (panel 바탕 + border 1px + radius 6). 포커스는 globals.css 가 테두리 색으로 처리한다. */
const input: React.CSSProperties = {
  background: "var(--panel)",
  border: "1px solid var(--line)",
  borderRadius: "var(--r-2)",
  padding: "var(--sp-2) var(--sp-3)",
  fontSize: "var(--text-sm)",
};

/** 생성 옵션의 수치 — ★**슬라이더가 아니라 입력칸**이다 (사용자 지시 2026-08-04).
 *
 *  Steps·CFG 는 "28", "5.5" 처럼 **아는 값을 그대로 넣는** 항목이라, 끌어서 맞추면
 *  오히려 느리고 정확하지 않다. 슬라이더는 값을 모른 채 훑는 것에 쓴다 (썸네일 크기 같은).
 *
 *  ★타이핑 중에는 고치지 않는다 — 글자를 그대로 두고 **떠날 때(blur)·Enter 에** 반영한다.
 *    매 글자마다 clamp 하면 "5" 를 지우고 "12" 를 치는 도중에 값이 튄다. */
function Num({
  value,
  onChange,
  min,
  max,
  step = 1,
  unit,
}: {
  value: number;
  onChange: (v: number) => void;
  min: number;
  max: number;
  step?: number;
  unit?: string;
}) {
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  const commit = () => {
    const v = parseFloat(text);
    if (Number.isNaN(v)) return setText(String(value));
    const clamped = Math.min(max, Math.max(min, v));
    onChange(clamped);
    setText(String(clamped));
  };
  return (
    <div style={{ display: "flex", alignItems: "center", gap: "var(--sp-2)" }}>
      <input
        type="number"
        min={min}
        max={max}
        step={step}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
        style={{ ...input, width: 88, fontFamily: "var(--font-mono)", textAlign: "right" }}
      />
      <span style={{ fontSize: "var(--text-2xs)", color: "var(--ink-faint)" }}>
        {unit ?? `${min} ~ ${max}`}
      </span>
    </div>
  );
}

function Select({
  value,
  options,
  onChange,
}: {
  value: string;
  /** 문자열이면 값=라벨, 쌍이면 [값, 라벨] */
  options: (string | [string, string])[];
  onChange: (v: string) => void;
}) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} style={input}>
      {options.map((o) => {
        const [val, label] = typeof o === "string" ? [o, o] : o;
        return (
          <option key={val} value={val}>
            {label}
          </option>
        );
      })}
    </select>
  );
}

/** 숫자 직접 입력 — **떠날 때 확정한다.** 타이핑 중 정렬하면 "8" 을 치는 순간 64 로
 *  튀어 이어서 못 친다 (v2 도 input 이 아니라 change 에서 맞춘다). */
function NumBox({
  value,
  onCommit,
  ...rest
}: { value: number; onCommit: (v: number) => void } & Record<string, unknown>) {
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  return (
    <input
      {...rest}
      value={text}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => onCommit(parseInt(text) || value)}
      onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
      style={{ ...input, width: 74, fontFamily: "var(--font-mono)", textAlign: "center" }}
    />
  );
}

function Check({
  label,
  checked,
  onChange,
  help,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  help?: string;
}) {
  return (
    <label
      style={{
        // ★★**글자 끝까지만** 누를 자리다 (사용자 지적 2026-08-21). `display: flex` 는 줄을
        //   가득 채워서, 오른쪽 빈 곳을 눌러도 켜졌다 — 무엇을 누른 건지 알 수 없다.
        //   `inline-flex` + `alignSelf` 로 **내용만큼만** 차지하게 한다.
        display: "inline-flex",
        alignSelf: "flex-start",
        alignItems: "center",
        gap: "var(--sp-2)",
        fontSize: "var(--text-xs)",
        color: "var(--ink-soft)",
        cursor: "pointer",
      }}
    >
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        style={{ accentColor: "var(--accent)" }}
      />
      {label}
      {help && <Help tip={help} />}
    </label>
  );
}
