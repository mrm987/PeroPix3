import { useI18n } from "../../i18n";
import { api } from "../../lib/backend";
import { toast } from "../../store/toast";
import { Icon } from "../../components/Icon";
import { BRUSH_MAX, useCensor, type Tool } from "../../store/censor";
import { useCensorView, bumpZoom, setFit, setZoom } from "../../store/censorView";
import { fitScale, percent } from "../../lib/zoomView";
import { isEmpty, type Shape } from "../../lib/censorMask";
import { card, box, on, num, dropFocus, Hint, Line, Sec } from "./ui";

/** 오른쪽 기둥. **탭마다 다른 것을 묻는다** (v2 `censor-side-panel`).
 *
 *      검열 전   무엇을 찾을까   모델 · 대상 · 클래스별 문턱 · 낮은 신뢰도 숨김
 *      검열 중·후 어떻게 고칠까  붓·지우개 · 붓 크기 · 되돌리기 · 단축키
 *      공통       어떻게 가릴까   방식과 그 방식의 슬라이더
 *
 *  ★「고른 박스만 다른 방식」 절은 걷었다 — 붓이 **지금 고른 방식**을 칸에 적으므로, 방식을
 *    바꿔 가며 덧칠하면 자리마다 방식이 다르다 (사용자 지시 2026-09-05, 붓으로 바꾸며).
 */
export function CensorSide() {
  const t = useI18n((s) => s.t);
  const c = useCensor();
  const classes = c.models.find((m) => m.file === c.model)?.classes ?? [];
  const editable = c.tab !== "before";
  const curIm = c.cur();
  const painted = !!curIm && !isEmpty(c.paint[curIm.id]);

  return (
    <div style={{ width: 250, flexShrink: 0, display: "flex", flexDirection: "column", minHeight: 0 }}>
      <div style={{ flex: 1, minHeight: 0, overflowY: "auto", display: "flex", flexDirection: "column", gap: "var(--sp-5)", paddingRight: "var(--sp-1)" }}>
        {!editable && (
          <>
            <Sec label={t("censor.model")} help={t("censor.modelHint")}>
              {c.modelsLoading ? (
                /* ★목록을 받는 동안에도 화면은 뜬다 — 여기와 「검열 시작」만 기다린다 (`modelsLoading` 의 ★주) */
                <div data-censor-models-loading style={{ ...box, width: "100%", color: "var(--ink-faint)" }}>
                  {t("censor.modelLoading")}
                </div>
              ) : (
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
              )}
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

        <Sec label={t("censor.tools")} help={t("censor.toolHint")}>
          {/* ★★도구 섹션은 **모든 탭에 있다** (2026-09-20). 「선택」은 그리는 도구가 아니라
              확대한 그림을 끌어 옮기는 도구라, 읽기 전용인 검열 전 탭에서도 필요하다.
              그리는 도구 둘은 아래에서 `editable` 일 때만 낸다. */}
          {/* ★칸 수는 실제로 내는 도구 수에 맞춘다 — 2열에 셋을 넣으면 마지막 하나가 반쪽으로 남는다 */}
          <div style={{ display: "grid", gridTemplateColumns: editable ? "1fr 1fr 1fr" : "1fr", gap: "var(--sp-2)" }}>
            {(editable ? TOOLS : TOOLS.filter(([id]) => id === "pan")).map(([id, key, icon]) => (
              <button
                key={id}
                data-censor-tool={id}
                // ★도구 칩도 같다 — `1 2 3` 단축키와 같은 자리라 고리가 특히 잘 남는다
                onMouseDown={dropFocus}
                onClick={() => c.set({ tool: id })}
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
          <ViewLine />
        </Sec>

        {editable && (
          <>
            <Sec label={t("imgIn.brush")}>
              {/* ★붓 모양 — 사각·원 (사용자 지시 2026-09-05). 기본은 사각: 찾은 박스가 네모라 이어 그리기 자연스럽다 */}
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "var(--sp-2)" }}>
                {SHAPES.map(([id, key, icon]) => (
                  <button
                    key={id}
                    data-censor-shape={id}
                    onMouseDown={dropFocus}
                    onClick={() => c.tune({ brushShape: id })}
                    style={{
                      ...box,
                      ...(c.brushShape === id ? on : {}),
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      gap: "var(--sp-1)",
                      padding: "var(--sp-1) 0",
                    }}
                  >
                    {Icon[icon]}
                    {t(key)}
                  </button>
                ))}
              </div>
              {/* ★붓 지름은 **픽셀 1 단위**다 (사용자 지시 2026-09-05: "8단위로만 되어서 불편") */}
              <Line label={t("imgIn.brushSize")}>
                <input type="range" data-censor-brush-size min={1} max={BRUSH_MAX} value={c.brushPx}
                  onChange={(e) => c.tune({ brushPx: Number(e.target.value) })} style={{ flex: 1 }} />
                <span style={num}>{c.brushPx}</span>
              </Line>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "var(--sp-2)" }}>
                <button
                  data-censor-undo
                  onMouseDown={dropFocus}
                  onClick={() => c.undoPaint()}
                  disabled={!c.undos.length}
                  style={{ ...box, display: "flex", alignItems: "center", justifyContent: "center", gap: "var(--sp-1)",
                    color: c.undos.length ? "var(--ink-soft)" : "var(--ink-ghost)" }}
                >
                  {Icon.undo}
                  {t("imgIn.maskUndo")}
                </button>
                <button
                  data-censor-clear
                  onMouseDown={dropFocus}
                  onClick={() => c.clearPaint()}
                  disabled={!painted}
                  style={{ ...box, display: "flex", alignItems: "center", justifyContent: "center", gap: "var(--sp-1)",
                    color: painted ? "var(--ink-soft)" : "var(--ink-ghost)" }}
                >
                  {Icon.trash}
                  {t("imgIn.maskClear")}
                </button>
              </div>
            </Sec>
          </>
        )}

        {/* ★★방식과 그 아래 옵션은 **검열 중·후에서만** 보인다 (사용자 제안 2026-09-06: *"검열전에서
            검열방식 선택을 없애면 되지않나?"*). 검열 전 탭은 캔버스에 아무것도 안 그리므로(`CensorStage`
            의 `tab === "before"` 갈래) 여기서 바꿔도 보이는 것이 없고, 검열 중 상태에서 바꾸면 칠해 둔
            마스크에는 안 걸려 돌아왔을 때 단추와 화면이 어긋났다. 검열 시작은 마지막에 고른 방식으로
            굽고, 방식은 검열 중에서 바꾸면 모든 장에 함께 걸린다 (`setMethod`). */}
        {editable && (
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
              {/* ★「경사」— 자락의 100% 시작점을 안쪽으로 당긴다. 칠한 넓이는 그대로 (사용자 결정 2026-09-06:
                  끝을 늘리면 영역이 넓어지므로 시작점을 밀고, 별도 수치로 조절) */}
              <Line label={t("censor.steamFade")} help={t("censor.steamFadeHint")}>
                <input type="range" data-censor-steam-fade min={0} max={100} value={c.steamFade}
                  onChange={(e) => c.tune({ steamFade: Number(e.target.value) }, "draw")} style={{ flex: 1 }} />
                <span style={num}>{c.steamFade}</span>
              </Line>
            </>
          )}
          {/* ★「범위」— 음수면 합집합을 깎는다 (사용자 지시 2026-09-05: "넓히기를 음수도 가능하게. 이름을 범위로") */}
          <Line label={t("censor.expand")}>
            <input type="range" data-censor-expand min={-50} max={50} value={c.expand}
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
        )}

        {editable && (
          <Sec label={t("censor.keys")}>
            <div style={{ display: "flex", flexDirection: "column", gap: "var(--sp-1)" }}>
              {[
                // ★도구는 셋이다 (`3` 은 검열 전 탭에서도 먹는다 — `panels/Censor.tsx`)
                ["1 2 3", t("censor.k_tool")],
                [`Ctrl+${t("censor.k_wheelKey")}`, t("censor.k_zoom")],
                [`Alt+${t("censor.k_wheelKey")}`, t("censor.k_size")],
                ["Ctrl+Z", t("censor.k_undo")],
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
        {/* ★★저장 위치 — **일괄변환과 같은 선택지**다 (사용자 지시 2026-09-04).
            문구도 그 도구의 것을 그대로 쓴다 (`tools.dest*`) — 같은 뜻에 다른 말을 두면
            어느 쪽이 무엇인지 매번 다시 읽어야 한다. */}
        {editable && <DestPicker />}
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
            <button data-censor-run onClick={() => void c.scanAll()} disabled={c.busy || !c.images.length || c.modelsLoading || !c.model} style={runBtn}>
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
            <button data-censor-resave onClick={() => void c.saveOne()} disabled={c.busy || !painted} style={runBtn}>
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

// ★문구는 인페인트 마스크의 것을 그대로 쓴다 — 같은 뜻에 다른 말을 두지 않는다
const TOOLS: [Tool, "imgIn.brush" | "imgIn.eraser" | "censor.toolPan", "brush" | "eraser" | "move"][] = [
  ["brush", "imgIn.brush", "brush"],
  ["erase", "imgIn.eraser", "eraser"],
  // ★그리지 않는 도구다 — 확대한 그림을 끌어 옮긴다. 아이콘도 커서와 같은 십자 화살표다
  ["pan", "censor.toolPan", "move"],
];

/** 얼마로 볼까 — **생성 쪽 큰 그림과 같은 줄**이다 (`panels/Canvas.tsx` 의 보기 단추).
 *
 *  ★단추 뜻도 문구도 그쪽 것을 그대로 쓴다 (`scenes.view*`) — 같은 일을 하는 자리에 다른
 *    말을 두면 두 화면이 다른 기능처럼 보인다.
 *  ★배율은 검열이 따로 기억한다 (`useCensor.view`) — 계산만 같은 `lib/zoomView` 를 쓴다. */
function ViewLine() {
  const t = useI18n((s) => s.t);
  const view = useCensor((s) => s.view);
  const { nat, box: stage } = useCensorView();
  const shown = view.fit ? fitScale(stage, nat) : view.zoom;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: "var(--sp-1)", justifyContent: "center" }}>
      <ViewBtn on={view.fit} onClick={setFit} tip={t("scenes.viewFit")}>{Icon.fitBox}</ViewBtn>
      <ViewBtn
        on={!view.fit && Math.abs(view.zoom - 1) < 0.001}
        onClick={() => setZoom(1)}
        tip={t("scenes.viewActual")}
      >
        {Icon.oneToOne}
      </ViewBtn>
      <span style={{ width: 1, height: 16, background: "var(--line)", margin: "0 2px" }} />
      <ViewBtn onClick={() => bumpZoom(-1)} tip={t("scenes.viewOut")}>−</ViewBtn>
      {/* ★고정폭이다 — 100% ↔ 37% 를 오갈 때 옆 단추가 밀리면 눌러 둔 자리를 놓친다 */}
      <span
        data-censor-pct
        style={{
          minWidth: 44,
          textAlign: "center",
          fontSize: "var(--text-2xs)",
          fontFamily: "var(--font-mono)",
          fontVariantNumeric: "tabular-nums",
          color: view.fit ? "var(--ink-faint)" : "var(--ink)",
        }}
      >
        {`${percent(shown)}%`}
      </span>
      <ViewBtn onClick={() => bumpZoom(1)} tip={t("scenes.viewIn")}>+</ViewBtn>
    </div>
  );
}

function ViewBtn({ on: active, tip, onClick, children }: {
  on?: boolean; tip?: string; onClick: () => void; children: React.ReactNode;
}) {
  return (
    <button
      data-censor-view-btn
      data-tip={tip}
      onMouseDown={dropFocus}
      onClick={onClick}
      style={{
        ...box,
        ...(active ? on : {}),
        padding: "2px 8px",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      {children}
    </button>
  );
}

const SHAPES: [Shape, "censor.shapeSquare" | "censor.shapeRound", "shapeSquare" | "shapeRound"][] = [
  ["square", "censor.shapeSquare", "shapeSquare"],
  ["round", "censor.shapeRound", "shapeRound"],
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

/** 저장 위치 — 일괄변환(`ConvertTool`)과 같은 세 갈래.
 *
 *  ★★**자리를 모르는 그림**(밖에서 떨군 것)은 「저장 폴더 지정」으로만 받는다 —
 *    덮어쓸 원본도, 아래에 폴더를 만들 자리도 없기 때문이다. 그 그림이 하나라도 있으면
 *    나머지 갈래를 잠근다 (변환 도구가 `noHome` 으로 하는 것과 같다).
 */
function DestPicker() {
  const t = useI18n((s) => s.t);
  const c = useCensor();
  const list = c.tab === "after" ? c.after : c.images;
  const noHome = list.some((im) => !im.rel && !im.path);
  const needDest = c.destMode === "folder" || noHome;

  const pick = async () => {
    const first = list.find((im) => im.path || im.rel);
    try {
      const r = await api<{ dir: string | null }>("/api/files/pick-dir", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // ★윈도우 경로는 `\` 로도 갈린다 — 둘 다 봐야 파일 이름을 떼고 폴더가 남는다
        body: JSON.stringify({ start: first?.path ? first.path.replace(/[\\/][^\\/]*$/, "") : "" }),
      });
      if (r.dir) c.set({ dest: r.dir });
    } catch (e) {
      toast(String(e), "warn");
    }
  };

  return (
    <Sec label={t("tools.dest")} help={t("tools.destHint")}>
      <select
        data-censor-dest-mode
        value={noHome ? "folder" : c.destMode}
        onChange={(e) => c.set({ destMode: e.target.value as "overwrite" | "sub" | "folder" })}
        style={{ ...box, width: "100%" }}
      >
        <option value="overwrite" disabled={noHome}>{t("tools.destOverwrite")}</option>
        <option value="sub" disabled={noHome}>{t("tools.destSub")}</option>
        <option value="folder">{t("tools.destFolder")}</option>
      </select>
      {c.destMode === "overwrite" && !noHome && <Hint>{t("tools.destOverwriteHint")}</Hint>}
      {needDest && (
        <button data-censor-dest-pick onClick={() => void pick()} style={{ ...box, width: "100%", textAlign: "left" }}>
          {c.dest || t("tools.destPick")}
        </button>
      )}
      {needDest && !c.dest && <Hint>{t("tools.needDest")}</Hint>}
    </Sec>
  );
}
