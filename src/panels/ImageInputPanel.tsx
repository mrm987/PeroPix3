import { useEffect, useRef, useState } from "react";
import { useI18n } from "../i18n";
import { Icon } from "../components/Icon";
import { Help } from "../components/Tip";
import {
  MAX_VIBES,
  fileToBase64,
  processReference,
  pushVibe,
  useImageInput,
  type BaseMode,
} from "../store/imageInput";
import { canFocus } from "../lib/focused";
import { fitSizeToBase, modelCaps, useGen } from "../store/gen";
import { flashStyle, useFlashAt } from "../store/ui";
import { toast } from "../store/toast";
import { NAI_VIBE_EXT, isNaiVibeFile, parseNaiVibeFile } from "../lib/naiVibeFile";
import { useTauriDrop } from "../lib/dropImages";
import { api } from "../lib/backend";
import { VibeCache } from "./VibeCache";

/** 앱 창에 떨군 파일 하나를 서버가 읽어 준다 (`POST /api/tools/read`) */
const readDropped = (path: string) =>
  api<{ name: string; text?: string; data?: string }>("/api/tools/read", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: path.split(/[\\/]/).pop() || path, path }),
  });

/** 이미지 입력 — Vibe Transfer · Precise Reference · 베이스 이미지.
 *
 *  ★v2 의 `Vibe / Character Ref` 절과 베이스 이미지 절을 옮긴 것이다
 *    (index.html:8998-9063 · 18362-18700). 값·범위·배타 규칙은 **원문 그대로**다. */
export function ImageInputPanel() {
  const t = useI18n((s) => s.t);
  const s = useImageInput();
  const model = useGen((g) => g.params.model);
  const cap = modelCaps(model);
  const [cache, setCache] = useState(false);

  /** ★서버에 구워 둔 인코딩이 있으면 「구워 둠」이 뜨고 비용에서도 빠진다.
   *
   *  ★여기 두는 것이 맞다 — 이 절과 모델 고르기가 **같은 패널**에 있어서, 패널이 접혀 있는
   *    동안에는 물어볼 것이 바뀔 수도 없다 (패널은 접히면 언마운트된다).
   *  ★딸림값은 **바뀌면 다시 물어야 하는 것**만 적는다. `s.vibes` 자체를 넣으면 답을 받아
   *    `encoded` 를 채우는 순간 배열이 새로 만들어져 무한히 돌게 된다. */
  const vibeKey = s.vibes.map((v) => `${v.image.length}:${v.info_extracted}`).join("|");
  useEffect(() => {
    void useImageInput.getState().syncVibeCache();
  }, [vibeKey, model]);

  /** 밖에서 가져온 바이브 파일 한 장 */
  const importVibeText = (text: string, name: string) => {
    try {
      const v = parseNaiVibeFile(text, name);
      if (!pushVibe(v)) {
        toast(t("imgIn.vibeFull", { n: MAX_VIBES }), "warn");
        return;
      }
      toast(v.encoded ? t("imgIn.vibeFileCached") : t("imgIn.vibeFileAdded"));
    } catch {
      toast(t("imgIn.vibeFileBad"), "warn");
    }
  };
  const importVibeFile = async (f: File) => importVibeText(await f.text(), f.name);
  /** ★앱 창에 떨군 것은 **경로**로 온다 — 서버가 읽어 준다 (`lib/dropImages.ts` 머리 주석).
   *  그림이면 그대로 바이브로, `.naiv4vibe` 면 안의 인코딩까지 들여온다. */
  const addDroppedPath = async (path: string) => {
    try {
      const r = await readDropped(path);
      if (r.text !== undefined) return importVibeText(r.text, r.name);
      if (r.data) s.addVibe(r.data, r.name);
    } catch {
      toast(t("imgIn.vibeFileBad"), "warn");
    }
  };
  /** 참조·베이스도 같은 길로 받는다. 그림만 오므로 `data` 하나면 된다 */
  const addRefPath = async (path: string) => {
    const r = await readDropped(path).catch(() => null);
    if (!r?.data) {
      toast(t("imgIn.dropBad"), "warn");
      return;
    }
    s.addRef({
      image: await processReference(r.data),
      preview: r.data,
      name: r.name,
      mode: "character&style",
      strength: 1,
      fidelity: 1,
    });
  };
  const addBasePath = async (path: string) => {
    const r = await readDropped(path).catch(() => null);
    if (!r?.data) {
      toast(t("imgIn.dropBad"), "warn");
      return;
    }
    s.setBase(r.data, r.name);
    await fitSizeToBase(r.data);
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--sp-5)" }}>
      {/* ★★**그 모델이 지원하는 것만 보여 준다** (사용자 지시 2026-08-21).
          V5 는 Vibe Transfer 도 Precise Reference 도 없다 (공홈 FAQ: "post-launch additions").
          담아 둔 그림은 **지우지 않는다** — 모델을 되돌리면 그대로 돌아온다. 보내는 쪽도
          같은 능력표로 막으므로(`backend/nai.py` `caps`) 숨은 값이 몰래 나가지 않는다. */}
      {cap.vibe && (
      <Section
        label={t("imgIn.vibe")}
        help={t("imgIn.vibeHint")}
        on={s.vibeOn}
        onToggle={s.setVibeOn}
        data-sec="vibe"
      >
        {/* ★공홈에도 같은 토글이 있다 (기본 켜짐). 켜져 있고 강도 합이 1을 넘으면 나눠서 보낸다 */}
        <Check
          label={t("imgIn.normalize")}
          data-tip={t("imgIn.normalizeHint")}
          checked={s.normalizeVibe}
          onChange={s.setNormalizeVibe}
          data-vibe-normalize={s.normalizeVibe ? "on" : "off"}
        />
        {s.vibes.map((v, i) => (
          <Card
            key={i}
            src={`data:image/png;base64,${v.image}`}
            name={v.name}
            badge={v.encoded ? t("imgIn.cached") : ""}
            onRemove={() => s.removeVibe(i)}
            data-vibe={i}
          >
            <Slide
              label={t("imgIn.refStrength")}
              value={v.strength}
              min={0}
              max={1}
              step={0.05}
              onChange={(x) => s.patchVibe(i, { strength: x })}
            />
            {/* ★정보 추출은 인코딩 캐시의 **키**다 — 바꾸면 다시 굽는다(유료). 그래서 눈에 보이게 둔다 */}
            <Slide
              label={t("imgIn.info")}
              value={v.info_extracted}
              min={0.01}
              max={1}
              step={0.01}
              onChange={(x) => s.patchVibe(i, { info_extracted: x })}
            />
          </Card>
        ))}
        <div style={{ display: "flex", gap: "var(--sp-2)" }}>
          {/* ★NAI 가 내보낸 `.naiv4vibe` 도 받는다 — 안에 구워 둔 인코딩이 들어 있어
              그대로 쓰면 Anlas 가 안 나간다 (v2 index.html:22758-22830) */}
          <Pick
            label={t("imgIn.vibeAdd")}
            disabled={s.vibes.length >= MAX_VIBES}
            accept={`image/*,${NAI_VIBE_EXT}`}
            takes={(f) => f.type.startsWith("image/") || isNaiVibeFile(f.name)}
            dropExt={/\.(png|jpe?g|webp|naiv4vibe)$/i}
            data-add="vibe"
            onFile={async (f) => {
              if (isNaiVibeFile(f.name)) return importVibeFile(f);
              s.addVibe(await fileToBase64(f), f.name);
            }}
            onPath={addDroppedPath}
          />
          {/* ★구워 둔 것에서 꺼내 쓰면 **돈이 안 나간다** (인코딩은 바이브당 2 Anlas) */}
          <button
            data-vibe-cache-open
            onClick={() => setCache(true)}
            data-tip={t("imgIn.cacheTitle")}
            style={{ ...box, flexShrink: 0, color: "var(--ink-soft)" }}
          >
            {Icon.duplicate}
          </button>
        </div>
      </Section>
      )}

      {cap.char_ref && (
      <Section label={t("imgIn.ref")} help={t("imgIn.refHint")} on={s.refOn} onToggle={s.setRefOn} data-sec="ref">
        {s.refs.map((r, i) => (
          <Card
            key={i}
            src={`data:image/png;base64,${r.preview}`}
            name={r.name}
            onRemove={() => s.removeRef(i)}
            data-ref={i}
          >
            <select
              value={r.mode}
              data-ref-mode={i}
              onChange={(e) => s.patchRef(i, { mode: e.target.value as typeof r.mode })}
              style={box}
            >
              <option value="character&style">{t("imgIn.modeCharStyle")}</option>
              <option value="character">{t("imgIn.modeChar")}</option>
              <option value="style">{t("imgIn.modeStyle")}</option>
            </select>
            {/* ★값을 누르면 직접 입력이 된다. 슬라이더는 0~1 이지만 **1 을 넘겨 넣을 수 있다**
                (v2 `.clickable-value`, index.html:18833-18866). 그쪽도 슬라이더만 클램프하고
                실제 값은 그대로 두었다 */}
            <Slide
              label={t("imgIn.refStrength")}
              value={r.strength}
              min={0}
              max={1}
              step={0.05}
              editable
              onChange={(x) => s.patchRef(i, { strength: x })}
            />
            <Slide
              label={t("imgIn.fidelity")}
              value={r.fidelity}
              min={0}
              max={1}
              step={0.05}
              editable
              onChange={(x) => s.patchRef(i, { fidelity: x })}
            />
          </Card>
        ))}
        <Pick
          label={t("imgIn.refAdd")}
          data-add="ref"
          onFile={async (f) => {
            const raw = await fileToBase64(f);
            // ★보내는 그림은 다듬은 것, 보여 주는 그림은 원본이다
            s.addRef({
              image: await processReference(raw),
              preview: raw,
              name: f.name,
              mode: "character&style",
              strength: 1,
              fidelity: 1,
            });
          }}
          onPath={addRefPath}
        />
      </Section>
      )}

      <Section label={t("imgIn.base")} data-sec="base" flashKey="base">
        {s.baseImage ? (
          <Card
            src={`data:image/png;base64,${s.baseImage}`}
            name={s.baseName}
            mask={s.baseMode === "inpaint" ? s.baseMask : ""}
            onRemove={s.clearBase}
            data-base
          >
            <div style={{ display: "flex", gap: "var(--sp-2)" }}>
              {(["img2img", "inpaint"] as BaseMode[]).map((m) => (
                <button
                  key={m}
                  data-base-mode={m}
                  onClick={() => s.patchBase({ baseMode: m })}
                  style={{
                    ...box,
                    flex: 1,
                    background: s.baseMode === m ? "var(--accent)" : "var(--panel)",
                    color: s.baseMode === m ? "var(--accent-on)" : "var(--ink-soft)",
                  }}
                >
                  {t(m === "img2img" ? "imgIn.i2i" : "imgIn.inpaint")}
                </button>
              ))}
            </div>
            {/* ★강도는 **모드마다 다른 값**이다 (v2 `currentBaseStrength`, index.html:23348).
                기본값도 다르고(0.7 / 1) 나가는 필드도 다르다 — 하나로 합치면 모드를 오갈 때
                값이 서로 샌다. 인페인트 쪽은 1 이 「마스크 영역 완전 재생성」이라 1 까지 간다. */}
            {s.baseMode === "inpaint" ? (
              <Slide
                label={t("imgIn.strength")}
                value={s.baseInpaintStrength}
                min={0.01}
                max={1}
                step={0.01}
                onChange={(x) => s.patchBase({ baseInpaintStrength: x })}
                data-base-strength="inpaint"
                help={t("imgIn.inpaintStrengthHint")}
              />
            ) : (
              // ★범위는 v2 그대로다 (`baseImageStrength`, index.html:9249 · 0~1 step .05).
              //   사용자 결정 2026-08-18: 조용히 바뀌어 있던 것을 되돌린다.
              <Slide
                label={t("imgIn.strength")}
                value={s.baseStrength}
                min={0}
                max={1}
                step={0.05}
                onChange={(x) => s.patchBase({ baseStrength: x })}
                data-base-strength="img2img"
              />
            )}
            {/* ★노이즈는 i2i 에만 붙는다 — 인페인트에는 NAI 가 안 받는다 (nai.py) */}
            {s.baseMode === "img2img" && (
              // ★step 도 v2 그대로 .05 다 (`baseImageNoise`, index.html:9253)
              <Slide
                label={t("imgIn.noise")}
                value={s.baseNoise}
                min={0}
                max={1}
                step={0.05}
                onChange={(x) => s.patchBase({ baseNoise: x })}
              />
            )}
            {s.baseMode === "inpaint" && (
              <>
                {/* ★칠하기는 **가운데 화면**에서 한다 (모달이 아니다). 그동안 왼쪽 아래
                    생성 버튼이 「인페인트」가 된다 */}
                <button
                  data-mask-open
                  onClick={() => s.startEdit()}
                  style={{
                    ...box,
                    width: "100%",
                    background: s.editing ? "var(--accent)" : "var(--panel)",
                    color: s.editing ? "var(--accent-on)" : "var(--ink-soft)",
                  }}
                >
                  <span style={{ display: "inline-flex", alignItems: "center", gap: "var(--sp-2)" }}>
                    {Icon.brush}
                    {t("imgIn.mask")}
                  </span>
                </button>
                <FocusedToggle />
              </>
            )}
          </Card>
        ) : (
          <>
            {/* ★「그림을 놓거나 골라…」 같은 안내는 없다 — 쓰는 사람이 아는 것이다
                (사용자 지시 2026-08-19) */}
            <Pick
              label={t("imgIn.basePick")}
              data-add="base"
              onFile={async (f) => {
                const b64 = await fileToBase64(f);
                s.setBase(b64, f.name);
                await fitSizeToBase(b64);
              }}
              onPath={addBasePath}
            />
          </>
        )}
      </Section>

      {cache && <VibeCache onClose={() => setCache(false)} />}
    </div>
  );
}

/** Focused Inpainting 스위치. 무엇을 하는 기능인지는 `lib/focused.ts` 머리 주석에 있다.
 *
 *  ★**끌 수 있게 둔다.** 큰 그림에서는 켜진 채로 시작하지만, 사각형보다 넓게 고치고 싶으면
 *    끄고 해상도를 올리는 길이 있어야 한다 (사용자 지시 2026-08-13).
 *  ★★**감추지 않는다** (사용자 지시 2026-08-20: *"기능을 아예 감추면 버그같음.
 *    보이는데 비활성화하고 이유를 보여줘야지"*). 예전에는 워크스페이스 파일이 아니면
 *    통째로 안 그렸는데, 그림을 갤러리에서 넣었는지 파일에서 넣었는지로 **UI 가 사라지니**
 *    고장으로 보였다. 출처 조건은 아예 없어졌다 (서버가 보낸 그림에서 자른다) —
 *    이제 못 켜는 경우는 **1MP 이하** 하나뿐이고, 그때는 흐리게 두고 이유를 적는다. */
function FocusedToggle() {
  const t = useI18n((s) => s.t);
  const s = useImageInput();
  const big = !!s.baseSize && canFocus(s.baseSize.w, s.baseSize.h);
  const on = s.focused && big;
  // 크기를 아직 재는 중이면 이유를 못 적는다 (곧 값이 온다) — 그 순간만 흐리게 둔다
  const why = s.baseSize && !big ? t("focus.tooSmall") : "";
  return (
    <div
      data-focused={on ? "on" : "off"}
      onClick={() => big && s.setFocused(!s.focused)}
      style={{
        display: "flex",
        alignItems: "flex-start",
        gap: "var(--sp-3)",
        padding: "var(--sp-2)",
        borderRadius: "var(--r-2)",
        border: `1px solid ${on ? "var(--accent)" : "var(--line)"}`,
        background: on ? "var(--accent-bg, var(--panel))" : "var(--panel)",
        opacity: big ? 1 : 0.5,
        cursor: big ? "pointer" : "default",
      }}
    >
      <span
        style={{
          flexShrink: 0,
          width: 30,
          height: 17,
          marginTop: 1,
          borderRadius: 9,
          background: on ? "var(--accent)" : "var(--line-strong, var(--line))",
          position: "relative",
          transition: "background 120ms",
        }}
      >
        <span
          style={{
            position: "absolute",
            top: 2,
            left: on ? 15 : 2,
            width: 13,
            height: 13,
            borderRadius: "50%",
            background: "var(--surface)",
            transition: "left 120ms",
          }}
        />
      </span>
      <span style={{ minWidth: 0 }}>
        <span style={{ display: "flex", alignItems: "center", gap: "var(--sp-2)", fontSize: "var(--text-xs)" }}>
          Focused Inpainting
          {/* ★설명 줄을 걷었다 (사용자 지시 2026-08-19) — 켬/끔 상태가 스위치에 이미 보이고,
              무엇을 하는 기능인지는 이 `?` 하나로 족하다 */}
          <Help tip={t("focus.help")} />
        </span>
        {/* ★★**못 켜는 이유는 그 자리에 적는다** — 흐리기만 하면 고장으로 읽힌다 */}
        {why && (
          <span
            data-focused-why
            style={{ display: "block", marginTop: 2, fontSize: "var(--text-2xs)", color: "var(--ink-faint)", lineHeight: 1.45 }}
          >
            {why}
          </span>
        )}
      </span>
    </div>
  );
}

const box: React.CSSProperties = {
  background: "var(--panel)",
  border: "1px solid var(--line)",
  borderRadius: "var(--r-2)",
  padding: "var(--sp-2) var(--sp-3)",
  fontSize: "var(--text-xs)",
};

/** 썸네일 위의 마스크. **칠한 자리만** 편집기와 같은 빨강으로 얹는다.
 *
 *  ★마스크는 순흑백 PNG 라(검정=유지) 그대로 얹으면 그림을 통째로 덮는다. 흰 칸만
 *    남기고 나머지는 투명으로 바꿔야 하는데, `mask-mode: luminance` 는 브라우저마다
 *    다르므로 **판에 직접 그려** 확실하게 한다 (38px 짜리라 값싸다).
 *  ★자르기는 `object-fit: cover` 와 같은 규칙이다 — 아래 그림과 어긋나면 안 된다. */
function MaskOverlay({ mask }: { mask: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const cv = ref.current;
    if (!cv) return;
    const cx = cv.getContext("2d");
    if (!cx) return;
    cx.clearRect(0, 0, cv.width, cv.height);
    if (!mask) return;
    const im = new Image();
    im.onload = () => {
      const k = Math.max(cv.width / im.width, cv.height / im.height);
      const dw = im.width * k;
      const dh = im.height * k;
      cx.drawImage(im, (cv.width - dw) / 2, (cv.height - dh) / 2, dw, dh);
      const d = cx.getImageData(0, 0, cv.width, cv.height);
      for (let i = 0; i < d.data.length; i += 4) {
        // 줄여 그리느라 회색이 섞이므로 가운데에서 자른다
        const on = d.data[i] > 128;
        d.data[i] = 255;
        d.data[i + 1] = 64;
        d.data[i + 2] = 96;
        d.data[i + 3] = on ? 150 : 0;
      }
      cx.putImageData(d, 0, 0);
    };
    im.src = "data:image/png;base64," + mask;
  }, [mask]);
  return (
    <canvas
      ref={ref}
      data-base-mask
      width={76}
      height={76}
      style={{
        position: "absolute",
        inset: 0,
        width: 38,
        height: 38,
        borderRadius: "var(--r-1)",
        pointerEvents: "none",
      }}
    />
  );
}

/** 켬/끔이 있는 절. `on` 을 안 주면 늘 열려 있는 절이다 (베이스 이미지) */
function Section({
  label,
  on,
  onToggle,
  flashKey,
  help,
  children,
  ...rest
}: {
  label: string;
  on?: boolean;
  onToggle?: (v: boolean) => void;
  /** 방금 이 자리가 바뀌었으면 강조한다 (`useUi.reveal`) */
  flashKey?: string;
  /** ★설명은 **라벨 옆 `?`** 로만 나온다 (사용자 지시 2026-08-19) — 화면에 펼쳐 두지 않는다 */
  help?: string;
  children: React.ReactNode;
} & Record<string, unknown>) {
  const f = useFlashAt<HTMLDivElement>(flashKey ?? "");
  return (
    <div
      ref={f.ref}
      style={{ display: "flex", flexDirection: "column", gap: "var(--sp-2)", ...flashStyle(!!flashKey && f.on) }}
      {...rest}
    >
      <div style={{ display: "flex", alignItems: "center", gap: "var(--sp-3)" }}>
        <span style={{ fontSize: "var(--text-xs)", fontWeight: "var(--w-semi)", color: "var(--ink-soft)" }}>
          {label}
        </span>
        {help && <Help tip={help} />}
        {onToggle && (
          <label style={{ marginLeft: "auto", display: "inline-flex", alignItems: "center", gap: "var(--sp-2)" }}>
            <input
              type="checkbox"
              checked={!!on}
              data-sec-on={label}
              onChange={(e) => onToggle(e.target.checked)}
            />
          </label>
        )}
      </div>
      {(on === undefined || on) && children}
    </div>
  );
}

/** 그림 한 장 + 그 그림의 값들 */
function Card({
  src,
  name,
  badge,
  mask,
  onRemove,
  children,
  ...rest
}: {
  src: string;
  name: string;
  badge?: string;
  /** 칠해 둔 마스크 (base64). 있으면 **썸네일 위에 그대로 겹쳐** 보여 준다
   *  (사용자 지시 2026-08-19) — 「마스크 있음」 같은 글자보다 어디를 칠했는지가 중요하다 */
  mask?: string;
  onRemove: () => void;
  children: React.ReactNode;
} & Record<string, unknown>) {
  const t = useI18n((s) => s.t);
  return (
    <div
      style={{
        border: "1px solid var(--line)",
        borderRadius: "var(--r-2)",
        padding: "var(--sp-2)",
        display: "flex",
        flexDirection: "column",
        gap: "var(--sp-2)",
        background: "var(--surface)",
      }}
      {...rest}
    >
      <div style={{ display: "flex", alignItems: "center", gap: "var(--sp-2)" }}>
        <span style={{ position: "relative", width: 38, height: 38, flexShrink: 0, display: "block" }}>
          <img
            src={src}
            alt=""
            style={{ width: 38, height: 38, objectFit: "cover", borderRadius: "var(--r-1)", display: "block" }}
          />
          {mask && <MaskOverlay mask={mask} />}
        </span>
        <span
          style={{
            flex: 1,
            minWidth: 0,
            fontSize: "var(--text-2xs)",
            color: "var(--ink-soft)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {name}
        </span>
        {badge && (
          <span style={{ fontSize: "var(--text-3xs, 10px)", color: "var(--ok, var(--accent))" }}>{badge}</span>
        )}
        <button onClick={onRemove} data-tip={t("imgIn.baseClear")} style={{ color: "var(--ink-faint)", display: "grid" }}>
          {Icon.close}
        </button>
      </div>
      {children}
    </div>
  );
}

/** 켬/끔 한 줄. ★네모는 입력요소 그대로 쓴다 (글자 아이콘을 만들지 않는다) */
function Check({
  label,
  title,
  checked,
  onChange,
  ...rest
}: {
  label: string;
  title?: string;
  checked: boolean;
  onChange: (v: boolean) => void;
} & Record<string, unknown>) {
  return (
    <label
      data-tip={title}
      style={{
        // ★★**글자 끝까지만** 누를 자리다 (사용자 지적 2026-08-21). `display: flex` 는 줄을
        //   가득 채워서, 오른쪽 빈 곳을 눌러도 켜졌다 — 무엇을 누른 건지 알 수 없다.
        //   `inline-flex` + `alignSelf` 로 **내용만큼만** 차지하게 한다.
        display: "inline-flex",
        alignSelf: "flex-start",
        alignItems: "center",
        gap: "var(--sp-2)",
        fontSize: "var(--text-2xs)",
        color: "var(--ink-dim)",
        cursor: "pointer",
      }}
      {...rest}
    >
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        style={{ flexShrink: 0 }}
      />
      {label}
    </label>
  );
}

function Slide({
  label,
  value,
  min,
  max,
  step,
  onChange,
  editable,
  help,
  ...rest
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
  /** 값을 눌러 **슬라이더 범위 밖의 수**를 직접 넣을 수 있게 한다 (v2 `.clickable-value`) */
  editable?: boolean;
  /** 그 값이 무엇을 하는지 — 라벨 옆 `?` 에 든다 */
  help?: string;
} & Record<string, unknown>) {
  return (
    <label
      {...rest}
      style={{ display: "flex", alignItems: "center", gap: "var(--sp-2)", fontSize: "var(--text-2xs)" }}
    >
      <span style={{ width: 54, color: "var(--ink-faint)", display: "inline-flex", alignItems: "center", gap: 3 }}>
        {label}
        {help && <Help tip={help} />}
      </span>
      <input
        type="range"
        // ★손잡이는 범위 안에 묶는다. 값이 1 을 넘어도 슬라이더는 끝에 선다 (v2 와 같다)
        value={Math.min(max, Math.max(min, value))}
        min={min}
        max={max}
        step={step}
        onChange={(e) => onChange(Number(e.target.value))}
        style={{ flex: 1 }}
      />
      {editable ? (
        <ValueBox value={value} step={step} onCommit={onChange} />
      ) : (
        <span style={{ width: 30, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{value}</span>
      )}
    </label>
  );
}

/** 슬라이더 옆 숫자. 누르면 입력칸이 되어 **범위 밖의 값도** 넣을 수 있다.
 *
 *  ★v2 의 Precise Reference 가 그랬다 (index.html:18833-18866): 슬라이더는 0~1 로 묶어 두고
 *    참조 강도만 1 을 넘겨 넣을 수 있었다. 옮기면서 빠져 있던 것을 되돌린다
 *    (사용자 결정 2026-08-18). */
function ValueBox({
  value,
  step,
  onCommit,
}: {
  value: number;
  step: number;
  onCommit: (v: number) => void;
}) {
  const [edit, setEdit] = useState(false);
  const [text, setText] = useState(String(value));
  /** Esc 로 나갈 때는 반영하지 않는다. blur 가 그 뒤에 오므로 표식이 필요하다 */
  const cancel = useRef(false);

  if (!edit)
    return (
      <span
        data-slide-value
        // ★label 안이라 그냥 두면 클릭이 슬라이더로 넘어간다
        onClick={(e) => {
          e.preventDefault();
          setText(String(value));
          setEdit(true);
        }}
        style={{
          width: 30,
          textAlign: "right",
          fontVariantNumeric: "tabular-nums",
          color: "var(--accent-ink)",
          cursor: "pointer",
        }}
      >
        {value}
      </span>
    );

  return (
    <input
      data-slide-input
      type="number"
      autoFocus
      step={step}
      value={text}
      onClick={(e) => e.preventDefault()}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => {
        if (!cancel.current) {
          const v = parseFloat(text);
          onCommit(Number.isFinite(v) ? v : value);
        }
        cancel.current = false;
        setEdit(false);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        if (e.key === "Escape") {
          cancel.current = true;
          (e.target as HTMLInputElement).blur();
        }
      }}
      style={{
        width: 44,
        textAlign: "right",
        fontSize: "inherit",
        padding: "1px 3px",
        borderRadius: "var(--r-1)",
        border: "1px solid var(--accent)",
        background: "var(--panel)",
        color: "var(--ink)",
      }}
    />
  );
}

/** 그림 고르기 — 누르면 파일 선택, **끌어다 놓아도** 받는다 */
function Pick({
  label,
  disabled,
  accept = "image/*",
  takes = (f: File) => f.type.startsWith("image/"),
  dropExt = /\.(png|jpe?g|webp)$/i,
  onFile,
  onPath,
  ...rest
}: {
  label: string;
  disabled?: boolean;
  /** 파일 고르기 대화상자가 보여 줄 종류 */
  accept?: string;
  /** 떨군 것을 받을지 (대화상자는 `accept` 가 이미 거른다) */
  takes?: (f: File) => boolean;
  /** ★앱 창에 떨군 것은 **경로**로 오므로 확장자로 거른다 (`File` 이 없다) */
  dropExt?: RegExp;
  onFile: (f: File) => void | Promise<void>;
  /** 앱(Tauri) 창에 떨군 파일. 없으면 앱에서는 떨구기를 안 받는다 */
  onPath?: (path: string) => void | Promise<void>;
} & Record<string, unknown>) {
  const t = useI18n((s) => s.t);
  const ref = useRef<HTMLInputElement>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const [over, setOver] = useState(false);
  // ★Tauri 는 HTML5 drop 을 가로채므로 아래 `onDrop` 은 앱에서 **안 불린다.**
  //   앱에서 떨구려면 이쪽이 있어야 한다 (`lib/dropImages.ts` 머리 주석).
  useTauriDrop(btn, dropExt, (paths) => void onPath?.(paths[0]), (v) => setOver(v && !!onPath));
  return (
    <>
      <button
        ref={btn}
        /** ★**파일 드롭존 표식** — 「창 전체로 받는」 자리(EXIF 리더)가 이 자리는 비켜 간다.
         *  없으면 베이스 그림에 떨구려던 것을 옆 도구가 가로챈다 (`lib/dropImages` 의 `wide`). */
        data-drop-file
        disabled={disabled}
        onClick={() => ref.current?.click()}
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          const f = e.dataTransfer.files[0];
          if (f && takes(f)) onFile(f);
        }}
        style={{
          ...box,
          width: "100%",
          borderStyle: over ? "solid" : "dashed",
          borderColor: over ? "var(--accent)" : "var(--line)",
          color: "var(--ink-soft)",
          opacity: disabled ? 0.5 : 1,
        }}
        {...rest}
      >
        <span style={{ display: "inline-flex", alignItems: "center", gap: "var(--sp-2)" }}>
          {Icon.plus}
          {over ? t("imgIn.drop") : label}
        </span>
      </button>
      <input
        ref={ref}
        type="file"
        accept={accept}
        style={{ display: "none" }}
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) onFile(f);
          e.target.value = "";
        }}
      />
    </>
  );
}
