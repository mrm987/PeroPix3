import { useI18n } from "../i18n";
import { Icon } from "../components/Icon";
import { modelCaps, useGen } from "../store/gen";
import type { StyleOpts } from "../lib/styleOpts";

/** 프롬프트 칸 **하단에 붙는 띠** — 프롬프트의 일부가 되는 설정들.
 *
 *  ★★**공홈과 같은 자리다** (사용자 지시 2026-08-23: *"프리셋도 nai 공홈처럼 시각적으로도
 *    프롬프트의 일부인것 처럼 만들어야할거같은데. 공홈에 보면 투명여부, 프리셋설정이
 *    프롬프트 입력란 안에 하단에 있음"*). 공홈은 퀄리티·UC 프리셋과 투명 배경,
 *    그리고 anime/furry 스위치를 프롬프트 영역(`image-gen-prompt-main`) 안에 둔다
 *    (`docs/nai-web-reference.md` 의 「anime / furry 모드 스위치」 절).
 *
 *  ★★**여기 있는 것은 전부 프롬프트 문자열이 된다** (`backend/nai.py`) —
 *    퀄리티 접미사 · UC 프리셋 본문 · `transparent background` · `fur dataset, ` 접두.
 *    그래서 옵션 패널이 아니라 **글을 적는 칸 옆**이 제자리다. 담기는 자리도 같다:
 *    스타일 카드가 이 넷을 함께 든다 (`lib/styleOpts`).
 *  ★★**생성 옵션 패널에서는 뺐다** — 같은 값을 두 곳에서 만지면 어느 쪽이 진짜인지 흐려진다.
 *
 *  ★탭을 따라 갈린다: `Prompt` 를 보고 있으면 프롬프트에 붙는 것들, `UC` 를 보고 있으면
 *    네거티브에 붙는 것. 안 보이는 쪽 값을 함께 늘어놓으면 어디에 붙는 건지 흐려진다.
 */

/** 퀄리티 프리셋 이름 — ★키를 조립하지 않는다 (i18n 검사가 리터럴만 센다).
 *  ★목록 자체는 **모델이 정한다** (`lib/naiModels.ts` 의 `quality_presets`). */
const QP_LABEL: Record<string, string> = {
  standard: "options.qpStandard",
  light: "options.qpLight",
  none: "options.qpNone",
};

// ★v2 와 같은 5종. `Furry Focus` 는 ucPreset 숫자표에 없어 0(Heavy)으로 떨어지지만
//   프리셋 **태그 문자열**은 자기 것을 쓴다 — v2 와 같은 동작이다 (nai.py 참조).
const UC_PRESETS = ["Heavy", "Light", "Human Focus", "Furry Focus", "None"];

/** 카드 안의 값을 만질 때 쓰는 짝 — 없으면 지금 생성 설정을 만진다.
 *
 *  ★★스타일 카드는 이 넷을 **자기가 들고 다닌다** (`lib/styleOpts`). 그러니 덱에서 카드를
 *    열어 고칠 때도 같은 띠가 떠야 한다 (사용자 지적 2026-08-23: *"기존 스타일 카드에는
 *    투명 bg 체크가 있는데 새로 만든 스타일 카드엔 없음"*) — 카드 편집기가 이 띠를 안 붙여서,
 *    프롬프트에 꺼내 놓았을 때만 보이고 덱에서는 보이지도 고칠 수도 없었다. */
export type OptsTarget = { value: StyleOpts; onChange: (patch: StyleOpts) => void };

export function PromptOptsBar({ uc, target }: { uc: boolean; target?: OptsTarget }) {
  const t = useI18n((s) => s.t);
  const live = useGen((s) => s.params);
  const setLive = useGen((s) => s.set);
  /* ★카드를 고칠 때도 **고를 수 있는 값은 지금 모델이 정한다** — 카드는 모델을 안 들고
     다니기 때문이다 (모델은 카드의 관심사가 아니다). */
  const cap = modelCaps(live.model);
  const p = target ? { ...live, ...target.value } : live;
  const set = <K extends keyof StyleOpts>(k: K, v: StyleOpts[K]) =>
    target ? target.onChange({ [k]: v } as StyleOpts) : setLive(k, v as never);

  return (
    <div
      data-prompt-opts={uc ? "uc" : "p"}
      style={{
        display: "flex",
        flexWrap: "wrap",
        alignItems: "center",
        gap: "var(--sp-2)",
        /* ★★**칸 안의 아래쪽**이다 — 가르는 실선을 긋지 않는다 (공홈도 안 긋는다).
           선을 그으면 「글 칸 밖에 딸린 줄」로 보여서, 프롬프트의 일부라는 뜻이 흐려진다. */
        marginTop: "var(--sp-3)",
      }}
    >
      {uc ? (
        <>
          {/* ★`None` 이면 퀄리티와 같이 **꺼진 얼굴**로 낸다 (사용자 지시 2026-08-23) —
              그 값일 때는 네거티브에 아무것도 안 붙는다 */}
          <Pick
            label={t("options.ucPreset")}
            dim={p.uc_preset === "None"}
            value={p.uc_preset}
            options={UC_PRESETS.map((v) => [v, v])}
            onChange={(v) => set("uc_preset", v)}
          />
        </>
      ) : (
        <>
          {/* ★투명 배경은 V5 부터다 — 못 하는 모델에서는 아예 안 낸다 */}
          {cap.transparency && (
            <Toggle
              label={t("options.transparentBg")}
              help={t("options.transparentBgHint")}
              on={p.transparent_bg}
              onChange={(v) => set("transparent_bg", v)}
            />
          )}
          {/* ★★퍼리 모드는 프롬프트 **맨 앞**에 `fur dataset, ` 를 붙인다 — 공홈도 같은 접두를
              쓰고, 스위치를 프롬프트 영역에 둔다 (`hasFurryMode`, V4.5·V5 계열 전부 참이라
              우리 모델 목록에서는 언제나 뜬다).
              ★★**켬/끔이 아니라 두 모드**다 (사용자 지시 2026-08-23: 아니메면 벚꽃, 퍼리면
                발자국). v2 도 공홈도 그렇다 — 지금 어느 쪽인지를 **그림 하나**로 말한다. */}
          <Mode furry={p.furry_mode} onChange={(v) => set("furry_mode", v)} />
          {/* ★고를 수 있는 값은 **모델이 정한다**. 없는 것을 고른 채 모델을 바꾸면
              서버가 `standard` 로 내린다 (`nai.quality_preset_id`). */}
          {/* ★★`none` 이면 **꺼진 것처럼 어둡게** 보인다 (사용자 지시 2026-08-23) —
              그 값일 때는 프롬프트에 아무것도 안 붙으므로, 켬/끔 칩이 꺼졌을 때와 같은 얼굴이다 */}
          <Pick
            label={t("options.qualityPreset")}
            dim={p.quality_preset === "none"}
            value={cap.quality_presets.includes(p.quality_preset) ? p.quality_preset : "standard"}
            options={cap.quality_presets.map((id) => [id, t(QP_LABEL[id])] as [string, string])}
            onChange={(v) => set("quality_preset", v)}
          />
        </>
      )}
    </div>
  );
}

/** 칩 공통 — 글 칸 안에 앉는 작은 알약. ★**내용만큼만** 차지한다 */
const chip: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: "var(--sp-2)",
  height: 24,
  padding: "0 var(--sp-3)",
  borderRadius: "var(--r-2)",
  fontSize: "var(--text-2xs)",
  border: "1px solid var(--line)",
  background: "var(--panel)",
};

/** 고르기 칩 — ★**이름표가 칩 안에 있다** (`퀄리티 프리셋: 표준`). 옆에 따로 붙이면
 *  글 칸 아래가 「이름표 + 컨트롤」 두 겹이 되어 설정 패널처럼 보인다.
 *  ★네이티브 `select` 를 그대로 쓴다 — 목록을 직접 그리면 키보드 조작이 사라진다. */
function Pick({
  label,
  value,
  options,
  onChange,
  dim,
}: {
  label: string;
  value: string;
  options: [string, string][];
  onChange: (v: string) => void;
  /** 이 값일 때는 **프롬프트에 아무것도 안 붙는다** — 꺼진 칩과 같은 얼굴로 낸다 */
  dim?: boolean;
}) {
  const shown = options.find(([v]) => v === value)?.[1] ?? value;
  return (
    /* ★★**오른쪽 끝**에 선다 (공홈과 같다) — 켬/끔 칩과 성질이 달라 섞어 두면 어느 것이 눌러
       바뀌는 것인지 한눈에 안 들어온다. 탭을 오가도 같은 자리다 (사용자 지시 2026-08-23).
       ★띄우는 것은 `margin` 이지 **빈 칸(spacer)이 아니다** — 칸이 좁아 줄이 넘어가면 빈 칸은
         윗줄에 남고 고르기만 아랫줄 **왼쪽**으로 떨어진다 (실제로 그랬다). */
    <label
      data-prompt-pick
      data-dim={dim ? "" : undefined}
      style={{
        ...chip,
        marginLeft: "auto",
        position: "relative",
        color: dim ? "var(--ink-faint)" : "var(--ink-soft)",
        cursor: "pointer",
      }}
    >
      <span>
        {label}:{" "}
        <b style={{ fontWeight: "var(--w-semi)", color: dim ? "inherit" : "var(--ink)" }}>{shown}</b>
      </span>
      {Icon.chevronDown12}
      {/* ★진짜 `select` 는 칩 위에 투명하게 덮어 둔다 — 보이는 것은 우리 글자이고,
          누르면 브라우저의 목록이 그대로 뜬다 (모양과 조작을 둘 다 지킨다).
          ★★**색을 반드시 준다.** 눌러서 뜨는 목록은 브라우저가 그리는데, 그때 쓰는 색이
            **이 요소의 `background`·`color`** 다 (`opacity:0` 은 목록에 안 걸린다).
            안 주면 배경이 비어 다크 테마에서 **하얀 목록**이 뜬다 (사용자 지적 2026-08-23).
            ★앱에 `color-scheme` 선언이 없어서 네이티브 위젯이 밝은 쪽으로 떨어지는 것이
              뿌리 원인이다 — 옛 옵션 패널의 `select` 도 `background` 를 줘서 피해 갔다. */}
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        style={{
          position: "absolute",
          inset: 0,
          opacity: 0,
          cursor: "pointer",
          background: "var(--panel)",
          color: "var(--ink)",
        }}
      >
        {options.map(([v, name]) => (
          <option key={v} value={v}>
            {name}
          </option>
        ))}
      </select>
    </label>
  );
}

/** 아니메 / 퍼리 — ★**글자가 없다.** 지금 어느 쪽인지를 그림으로 말한다
 *  (v2 `#modeToggle` 이 벚꽃↔발자국으로 갈렸고, 공홈도 아이콘 스위치다).
 *  무엇인지는 툴팁이 말한다. ★그 자리에 **이모지 글자를 두지 않는다** — v2 는 그랬다
 *  (CLAUDE.md ★절: 아이콘은 언제나 SVG).
 *  ★켬/끔 칩과 **얼굴이 다르다** — 이쪽은 「꺼짐」이 없다. 아니메도 엄연한 한쪽이라
 *    흐리게 두면 「안 켜진 것」으로 읽힌다. */
function Mode({ furry, onChange }: { furry: boolean; onChange: (v: boolean) => void }) {
  const t = useI18n((s) => s.t);
  return (
    <button
      data-prompt-mode={furry ? "furry" : "anime"}
      onClick={() => onChange(!furry)}
      data-tip={t(furry ? "options.modeFurry" : "options.modeAnime")}
      style={{
        ...chip,
        width: 32,
        padding: 0,
        justifyContent: "center",
        borderColor: furry ? "var(--accent)" : "var(--line)",
        background: furry ? "var(--accent-bg)" : "var(--panel)",
        color: furry ? "var(--accent-ink)" : "var(--ink-soft)",
      }}
    >
      {furry ? Icon.paw12 : Icon.blossom12}
    </button>
  );
}

/** 켬/끔 칩 — ★상태를 **아이콘으로** 말한다 (공홈도 그렇다: 꺼지면 `✕`).
 *  네모 체크박스를 두면 글 칸 안에서 설정 목록처럼 보인다. */
function Toggle({
  label,
  on,
  onChange,
  help,
}: {
  label: string;
  on: boolean;
  onChange: (v: boolean) => void;
  help?: string;
}) {
  return (
    <button
      data-prompt-toggle={label}
      data-on={on ? "" : undefined}
      onClick={() => onChange(!on)}
      data-tip={help}
      style={{
        ...chip,
        gap: "var(--sp-1)",
        borderColor: on ? "var(--accent)" : "var(--line)",
        background: on ? "var(--accent-bg)" : "var(--panel)",
        color: on ? "var(--accent-ink)" : "var(--ink-faint)",
      }}
    >
      <span style={{ display: "grid", placeItems: "center", width: 12, height: 12 }}>
        {on ? Icon.check : Icon.close12}
      </span>
      {label}
    </button>
  );
}
