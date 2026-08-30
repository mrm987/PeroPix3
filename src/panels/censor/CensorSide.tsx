import { useI18n } from "../../i18n";
import { Icon } from "../../components/Icon";
import { useCensor, type Tool } from "../../store/censor";
import { card, box, on, num, dropFocus, Hint, Line, Sec } from "./ui";

/** 오른쪽 기둥. **탭마다 다른 것을 묻는다** (v2 `censor-side-panel`).
 *
 *      검열 전   무엇을 찾을까   모델 · 대상 · 클래스별 문턱 · 낮은 신뢰도 숨김
 *      검열 중·후 어떻게 고칠까  도구 · 단축키 · 고른 박스의 방식
 *      공통       어떻게 가릴까   방식과 그 방식의 슬라이더
 */
export function CensorSide() {
  const t = useI18n((s) => s.t);
  const c = useCensor();
  const classes = c.models.find((m) => m.file === c.model)?.classes ?? [];
  const editable = c.tab !== "before";
  const sel = c.curBoxes()[c.sel];

  return (
    <div style={{ width: 250, flexShrink: 0, display: "flex", flexDirection: "column", minHeight: 0 }}>
      <div style={{ flex: 1, minHeight: 0, overflowY: "auto", display: "flex", flexDirection: "column", gap: "var(--sp-5)", paddingRight: "var(--sp-1)" }}>
        {!editable && (
          <>
            <Sec label={t("censor.model")} help={t("censor.modelHint")}>
              <select
                data-censor-model
                value={c.model ?? ""}
                onChange={(e) => c.setModel(e.target.value)}
                style={{ ...box, width: "100%" }}
              >
                {c.models.map((m) => (
                  <option key={m.file} value={m.file}>
                    {m.id} · {Math.round(m.bytes / 1e6)}MB · {m.imgsz}px
                  </option>
                ))}
              </select>
            </Sec>

            <Sec label={t("censor.targets")} help={t("censor.confHint")}>
              {/* ★클래스마다 문턱을 따로 준다 (백엔드 `label_conf`). 젖꼭지는 낮게, 오탐이 잦은
                  것은 높게. 하나의 문턱으로는 둘을 같이 맞출 수 없다 */}
              <div style={{ ...card, padding: "var(--sp-2)", display: "flex", flexDirection: "column", gap: 2 }}>
                {classes.map((k) => (
                  <label
                    key={k}
                    style={{
                      display: "grid",
                      gridTemplateColumns: "auto 1fr auto",
                      alignItems: "center",
                      gap: "var(--sp-2)",
                      padding: "2px var(--sp-1)",
                      borderRadius: "var(--r-1)",
                      fontSize: "var(--text-2xs)",
                      color: c.targets.includes(k) ? "var(--ink-soft)" : "var(--ink-faint)",
                    }}
                  >
                    <input
                      type="checkbox"
                      data-censor-target={k}
                      checked={c.targets.includes(k)}
                      onChange={() => c.toggleTarget(k)}
                    />
                    <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{k}</span>
                    <input
                      type="number"
                      data-censor-label-conf={k}
                      min={0}
                      max={1}
                      step={0.01}
                      value={(c.labelConf[k] ?? c.conf).toFixed(2)}
                      disabled={!c.targets.includes(k)}
                      onChange={(e) => {
                        const v = Number(e.target.value);
                        c.setLabelConf(k, Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : c.conf);
                      }}
                      style={{ ...box, width: 54, padding: "1px var(--sp-2)", textAlign: "right", fontVariantNumeric: "tabular-nums" }}
                    />
                  </label>
                ))}
                {!classes.length && <Hint>{t("censor.noClasses")}</Hint>}
              </div>
            </Sec>

            <Sec label={t("censor.floor")} help={t("censor.floorHint")}>
              {/* ★보이는 것만 거른다. 실제로 가리는 것은 위의 클래스별 문턱이 정한다 (v2 주석) */}
              <Line label={`${Math.round(c.floor * 100)}%`}>
                <input
                  type="range"
                  data-censor-floor
                  min={0}
                  max={50}
                  value={Math.round(c.floor * 100)}
                  onChange={(e) => c.tune({ floor: Number(e.target.value) / 100 })}
                  style={{ flex: 1 }}
                />
              </Line>
            </Sec>
          </>
        )}

        {editable && (
          <>
            <Sec label={t("censor.tools")} help={t("censor.toolHint")}>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "var(--sp-2)" }}>
                {TOOLS.map(([id, key, icon]) => (
                  <button
                    key={id}
                    data-censor-tool={id}
                    // ★도구 칩도 같다 — `1 2 3` 단축키와 같은 자리라 고리가 특히 잘 남는다
                    onMouseDown={dropFocus}
                    onClick={() => c.set({ tool: id, sel: -1 })}
                    style={{
                      ...box,
                      ...(c.tool === id ? on : {}),
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      gap: "var(--sp-1)",
                      padding: "var(--sp-2) 0",
                    }}
                  >
                    {Icon[icon]}
                    {t(key)}
                  </button>
                ))}
              </div>
            </Sec>

            {sel && (
              <Sec label={t("censor.boxMethod")} help={t("censor.boxMethodHint")}>
                {/* ★박스마다 다른 방식 (B7). 백엔드 `apply_boxes` 가 박스별 `method` 를 읽는다 */}
                <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--sp-2)" }}>
                  {METHODS.map(([m, key]) => (
                    <button
                      key={m}
                      data-censor-box-method={m}
                      onMouseDown={dropFocus}
                      onClick={() => c.setBoxMethod(c.sel, m)}
                      style={{ ...box, ...((sel.method ?? c.method) === m ? on : {}) }}
                    >
                      {t(key)}
                    </button>
                  ))}
                </div>
              </Sec>
            )}
          </>
        )}

        <Sec label={t("censor.method")}>
          <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--sp-2)" }}>
            {METHODS.map(([m, key]) => (
              <button
                key={m}
                data-censor-method={m}
                // ★마우스로는 포커스가 안 가게 막는다 (`dropFocus` 의 ★★주). 누른 뒤에 떼지 않는다
                onMouseDown={dropFocus}
                onClick={() => c.setMethod(m)}
                style={{ ...box, ...(c.method === m ? on : {}) }}
              >
                {t(key)}
              </button>
            ))}
          </div>
          {c.method === "color" && (
            <input
              type="color"
              value={c.color}
              onChange={(e) => c.tune({ color: e.target.value }, "draw")}
              style={{ width: "100%", height: 26, borderRadius: "var(--r-2)" }}
            />
          )}
          {c.method === "mosaic" && (
            <>
              {/* ★범위는 v2 그대로다 (`mosaicStrength` 4~48 · `mosaicOpacity` 10~100,
                  index.html:9801·9808). 불투명도 아래끝이 10 인 것은 0 이면 가린 것이
                  통째로 안 보여 검열이 아니게 되기 때문이다 */}
              <Line label={t("censor.grain")}>
                <input type="range" min={4} max={48} value={c.mosaic}
                  onChange={(e) => c.tune({ mosaic: Number(e.target.value) }, "draw")} style={{ flex: 1 }} />
                <span style={num}>{c.mosaic}</span>
              </Line>
              <Line label={t("censor.opacity")}>
                <input type="range" min={10} max={100} value={c.mosaicOpacity}
                  onChange={(e) => c.tune({ mosaicOpacity: Number(e.target.value) }, "draw")} style={{ flex: 1 }} />
                <span style={num}>{c.mosaicOpacity}</span>
              </Line>
            </>
          )}
          {c.method === "blur" && (
            <Line label={t("censor.blur")}>
              <input type="range" min={2} max={60} value={c.blur}
                onChange={(e) => c.tune({ blur: Number(e.target.value) }, "draw")} style={{ flex: 1 }} />
              <span style={num}>{c.blur}</span>
            </Line>
          )}
          {c.method === "steam" && (
            <>
              {/* ★v2 의 슬라이더 둘 (`steamBrightness`·`steamAlpha`) — 스팀에만 뜻이 있다 */}
              <Line label={t("censor.steamBright")}>
                <input type="range" data-censor-steam-bright min={0} max={100} value={c.steamBright}
                  onChange={(e) => c.tune({ steamBright: Number(e.target.value) }, "draw")} style={{ flex: 1 }} />
                <span style={num}>{c.steamBright}</span>
              </Line>
              <Line label={t("censor.steamAlpha")}>
                <input type="range" data-censor-steam-alpha min={0} max={100} value={c.steamAlpha}
                  onChange={(e) => c.tune({ steamAlpha: Number(e.target.value) }, "draw")} style={{ flex: 1 }} />
                <span style={num}>{c.steamAlpha}</span>
              </Line>
            </>
          )}
          <Line label={t("censor.expand")}>
            <input type="range" min={0} max={50} value={c.expand}
              onChange={(e) => c.tune({ expand: Number(e.target.value) }, "draw")} style={{ flex: 1 }} />
            <span style={num}>{c.expand}</span>
          </Line>
          {/* ★★**모든 방식이 같은 한 줄을 쓴다** (사용자 지적 2026-08-23: *"거칠기라는 이름이
              이상함. 올릴수록 부드러워짐"* · *"다른 옵션의 「부드럽기」라는 건 없는데?"*).
              스팀에만 「거칠기」라는 딴 이름으로 서 있었는데, 값은 처음부터 **같은 하나**였고
              (`feather`) 올릴수록 부드러워지므로 이름이 방향까지 거꾸로였다. 설명도 걷었다 —
              이름이 방향을 말하면 설명이 필요 없다. */}
          <Line label={t("censor.feather")}>
            <input type="range" data-censor-feather min={0} max={50} value={c.feather}
              onChange={(e) => c.tune({ feather: Number(e.target.value) }, "draw")} style={{ flex: 1 }} />
            <span style={num}>{c.feather}</span>
          </Line>
          {/* ★★들춰보기도 **모든 방식 공통**이다 (사용자 지시 2026-08-23: *"박스 이동할때 뒤가
              보이는건 모든 검열방식에 공통 스펙"*). 덮개를 옅게 하는 동작은 처음부터 방식을
              가리지 않았는데(`CensorStage` 의 `opacity`), 슬라이더만 스팀 안에 갇혀 있어
              다른 방식에서는 그 값을 만질 길이 없었다. */}
          <Line label={t("censor.peek")} help={t("censor.peekHint")}>
            <input type="range" data-censor-peek min={0} max={100} value={c.peek}
              onChange={(e) => c.tune({ peek: Number(e.target.value) })} style={{ flex: 1 }} />
            <span style={num}>{c.peek}</span>
          </Line>
        </Sec>

        {editable && (
          <Sec label={t("censor.keys")}>
            <div style={{ display: "flex", flexDirection: "column", gap: "var(--sp-1)" }}>
              {[
                ["1 2 3", t("censor.k_tool")],
                ["Del", t("censor.k_del")],
                [t("censor.k_wheelKey"), t("censor.k_wheel")],
                [t("censor.k_rightKey"), t("censor.k_right")],
              ].map(([k, v]) => (
                <div key={k} style={{ display: "flex", alignItems: "center", gap: "var(--sp-2)", fontSize: "var(--text-2xs)", color: "var(--ink-faint)" }}>
                  <kbd style={kbd}>{k}</kbd>
                  {v}
                </div>
              ))}
            </div>
          </Sec>
        )}
      </div>

      {/* 액션은 스크롤 밖에 고정. 위의 것이 늘고 줄어도 버튼 자리는 그대로다 */}
      <div style={{ paddingTop: "var(--sp-3)", display: "flex", flexDirection: "column", gap: "var(--sp-2)" }}>
        {c.error && (
          <span data-censor-error style={{ fontSize: "var(--text-2xs)", color: "var(--err-ink)" }}>{c.error}</span>
        )}
        {c.progress && (
          <span data-censor-progress style={{ fontSize: "var(--text-2xs)", color: "var(--ink-soft)" }}>
            {t(c.progress.what === "scan" ? "censor.scanning" : "censor.saving", {
              n: c.progress.done,
              total: c.progress.total,
            })}
          </span>
        )}
        {c.tab === "before" && (
          <>
            <button data-censor-run onClick={() => void c.scanAll()} disabled={c.busy || !c.images.length} style={runBtn}>
              {Icon.search}
              {t("censor.runAll")}
            </button>
          </>
        )}
        {c.tab === "processing" && (
          <>
            <button data-censor-complete onClick={() => void c.saveAll()} disabled={c.busy} style={runBtn}>
              {Icon.check}
              {t("censor.complete")}
            </button>
            <button data-censor-cancel onClick={() => c.cancelProcessing()} disabled={c.busy} style={{ ...box, padding: "var(--sp-2)" }}>
              {t("censor.cancel")}
            </button>
          </>
        )}
        {c.tab === "after" && (
          <>
            <button data-censor-resave onClick={() => void c.saveOne()} disabled={c.busy || !c.curBoxes().length} style={runBtn}>
              {Icon.save}
              {t("censor.resave")}
            </button>
          </>
        )}
      </div>
    </div>
  );
}

/** ★키를 **문자열로 이어 만들지 않는다**. i18n 회귀가 잡고, 무엇보다 키가 조용히 빠져도
 *  아무도 모른다 (Settings.tsx 의 THEMES 와 같은 이유). */
const METHODS = [
  ["steam", "censor.m_steam"],
  ["mosaic", "censor.m_mosaic"],
  ["blur", "censor.m_blur"],
  ["black", "censor.m_black"],
  ["white", "censor.m_white"],
  ["color", "censor.m_color"],
] as const;

const TOOLS: [Tool, "censor.t_select" | "censor.t_add" | "censor.t_del", "cursor" | "plus" | "trash"][] = [
  ["select", "censor.t_select", "cursor"],
  ["add", "censor.t_add", "plus"],
  ["delete", "censor.t_del", "trash"],
];

const kbd: React.CSSProperties = {
  minWidth: 40,
  textAlign: "center",
  padding: "1px var(--sp-2)",
  border: "1px solid var(--line)",
  borderRadius: "var(--r-1)",
  background: "var(--panel)",
  color: "var(--ink-soft)",
  fontFamily: "var(--font-mono)",
  fontSize: "var(--text-2xs)",
};

const runBtn: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  gap: "var(--sp-2)",
  background: "var(--accent)",
  color: "var(--accent-on)",
  borderRadius: "var(--r-2)",
  padding: "var(--sp-2)",
  fontSize: "var(--text-xs)",
  fontWeight: "var(--w-semi)",
};
