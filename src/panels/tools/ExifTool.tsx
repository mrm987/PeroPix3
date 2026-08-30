import { useEffect, useState } from "react";
import { useI18n } from "../../i18n";
import { api } from "../../lib/backend";
import { useImageDrop, type Dropped } from "../../lib/dropImages";
import { KIND_LABEL } from "../../lib/dropImport";
import { toast } from "../../store/toast";
import { Icon } from "../../components/Icon";
import { useUi } from "../../store/ui";

/** EXIF 리더 — **밖에서 가져온 그림의 설정을 읽는다** (v2 `보조 도구 › EXIF 리더`).
 *
 *  ★읽기만 한다. 저장하지도, 고치지도 않는다 — 남의 그림을 여는 자리라 그게 전부여야 한다.
 *  ★프롬프트와 설정을 **갈라 놓는다** (v2 의 2열). 한 덩어리로 쏟아 놓으면
 *    "이 그림 어떻게 뽑았지"를 눈으로 못 따라간다.
 *  ★**키를 짐작하지 않는다.** 예전에는 `negative_prompt`·`character_prompts` 같은 있지도 않은
 *    이름으로 두 열을 갈라서, 네거티브와 캐릭터 프롬프트가 「설정」 열로 떨어지고 `raw`·
 *    `nai_vibes` 가 통째로 쏟아졌다 (감사 A5). 서버가 내는 이름은 `backend/meta.py`
 *    `normalize()` 의 반환문 하나가 정본이다.
 *  ★형식 배지·미리보기·「그 밖」 목록도 **서버가 준다** (`backend/tools.py read_meta`) —
 *    앱(Tauri)에는 경로만 와서 화면이 그 파일을 가리킬 주소가 없다.
 */
type Character = { prompt: string; negative?: string; center?: { x: number; y: number } | null };

type Meta = {
  kind?: string;
  preview?: string;
  bytes?: number;
  prompt?: string;
  negative?: string;
  characters?: Character[];
  slot_prompt?: string;
  seed?: number | string;
  width?: number;
  height?: number;
  steps?: number;
  cfg?: number;
  sampler?: string;
  scheduler?: string;
  nai_model?: string;
  smea?: string;
  uc_preset?: string;
  quality_tags?: boolean;
  quality_preset?: string;
  transparent_bg?: boolean;
  cfg_rescale?: number;
  variety_plus?: boolean;
  furry_mode?: boolean;
  nai_vibes?: { images?: unknown[]; strengths?: number[]; info_extracted?: number[] };
  precise_ref_count?: number;
  comfy?: { model?: string; denoise?: number; nodes?: number };
  vibe?: { model?: string; strength?: string; info_extracted?: string };
  extra?: Record<string, string>;
};

/** ★배지 이름은 `lib/dropImport` **하나**가 든다 — 드롭 가져오기 시트도 같은 배지를 단다.
 *  두 벌이면 같은 그림이 EXIF 리더와 드롭에서 다른 형식으로 보인다. */

/** ★★**읽은 결과는 탭을 옮겨도 남는다** (사용자 지시 2026-08-21).
 *
 *  `Tools` 는 안 보이는 탭을 **렌더하지 않으므로**(언마운트) 컴포넌트 state 로 두면
 *  이름 변환에 다녀오는 사이 결과가 통째로 사라진다. 모듈에 들고 있으면 다시 마운트될 때
 *  그대로 돌아온다. ★앱을 껐다 켜면 비는 것이 맞다 — 남의 그림을 잠깐 들여다보는 자리다. */
let kept: { name: string; meta: Meta | null } = { name: "", meta: null };

/** 밖에서 떨군 그림을 **EXIF 리더로 보낸다** — 드롭 가져오기 시트의 「EXIF 확인」이 부른다
 *  (사용자 지시 2026-08-23: 시트에서 프롬프트를 늘어놓지 말고 이쪽으로 보낼 것).
 *
 *  ★이미 읽어 둔 것을 그대로 넘긴다 — 같은 창구(`/api/tools/meta`)에서 온 것이라 다시
 *    물어볼 이유가 없다.
 *  ★★렌더 중이 아닌 것을 전제로 한다: 드롭 시트는 **생성·갤러리 모드에서만** 뜨므로
 *    (`app/DropImport`) 그때 EXIF 리더는 언마운트 상태다. 그래서 값을 넣고 모드를 옮기면
 *    새로 마운트되면서 이 값을 읽는다. */
export function showInExif(name: string, meta: unknown) {
  kept = { name, meta: meta as Meta };
  useUi.getState().setMode("utility");
  useUi.getState().setView("tab", "tools", "exif" as never);
}

export function ExifTool() {
  const t = useI18n((s) => s.t);
  const [name, setName] = useState(kept.name);
  const [meta, setMeta] = useState<Meta | null>(kept.meta);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    kept = { name, meta };
  }, [name, meta]);

  const read = async (items: Dropped[]) => {
    const it = items[0];
    if (!it || busy) return;
    setBusy(true);
    try {
      const r = await api<{ meta: Meta }>("/api/tools/meta", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(it),
      });
      setName(it.name);
      setMeta(r.meta);
      if (!r.meta.kind) toast(t("tools.exifNone"), "warn");
    } catch (e) {
      toast(String(e), "warn");
    } finally {
      setBusy(false);
    }
  };

  /** ★★**창 어디에 떨궈도 받는다** (사용자 지시 2026-08-21). 그림을 읽고 나면 드롭 상자가
   *  머리 한 줄로 줄어들어, 넓은 아래쪽에 떨구면 아무 일도 안 일어났다.
   *  ★주인이 따로 있는 자리(`[data-drop-file]`)는 비켜 간다 — 옆 패널의 베이스 그림 단추 등. */
  const { zone, over, pick } = useImageDrop(read, true);
  const clear = () => {
    setMeta(null);
    setName("");
  };

  return (
    <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column", gap: "var(--sp-4)" }}>
      {/* 머리 — 그림이 없으면 드롭 안내, 있으면 미리보기 + 형식 배지 + 교체·닫기 */}
      {!meta ? (
        /* ★★**받는 자리가 화면 전체**라는 것이 눈에도 보여야 한다 (사용자 지시 2026-08-23).
           예전에는 위쪽 머리 한 줄만 점선 상자였는데, 실제로는 창 어디에 떨궈도 받는다
           (`useImageDrop(read, true)`) — 그래서 넓은 아래쪽에 떨구면 「안 받는 자리에
           떨궜나」 싶게 아무 표시가 없었다. 판을 통째로 받는 자리로 그리고, 안내는
           **가운데**에 둔다. */
        <div
          {...zone}
          data-exif-drop
          onClick={() => void pick()}
          style={{
            flex: 1,
            minHeight: 0,
            border: `1px dashed ${over ? "var(--accent)" : "var(--line)"}`,
            background: over ? "var(--accent-bg)" : "var(--bg)",
            borderRadius: "var(--r-3)",
            display: "grid",
            placeItems: "center",
            gap: 2,
            cursor: "pointer",
          }}
        >
          <span style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 4 }}>
            <span style={{ color: over ? "var(--accent-ink)" : "var(--ink-ghost)", display: "grid" }}>{Icon.images}</span>
            <span style={{ fontSize: "var(--text-sm)", color: over ? "var(--accent-ink)" : "var(--ink-soft)" }}>
              {t("tools.exifDrop")}
            </span>
            <span style={{ fontSize: "var(--text-2xs)", color: "var(--ink-faint)" }}>{t("tools.dropHint")}</span>
          </span>
        </div>
      ) : (
        <div
          {...zone}
          data-exif-drop
          style={{
            display: "flex",
            alignItems: "center",
            gap: "var(--sp-3)",
            border: `1px solid ${over ? "var(--accent)" : "var(--line)"}`,
            background: over ? "var(--accent-bg)" : "var(--panel)",
            borderRadius: "var(--r-3)",
            padding: "var(--sp-3)",
            flexShrink: 0,
          }}
        >
          {meta.preview && (
            <img
              data-exif-preview
              src={meta.preview}
              alt=""
              style={{ height: 72, borderRadius: "var(--r-2)", background: "var(--bg)" }}
            />
          )}
          <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 3 }}>
            <span
              style={{
                fontSize: "var(--text-xs)",
                color: "var(--ink)",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {name}
            </span>
            <span style={{ display: "flex", alignItems: "center", gap: "var(--sp-2)" }}>
              <span
                data-exif-kind={meta.kind || "unknown"}
                style={{
                  border: "1px solid var(--accent)",
                  color: "var(--accent-ink)",
                  background: "var(--accent-bg)",
                  borderRadius: "var(--r-1)",
                  padding: "1px var(--sp-2)",
                  fontSize: "var(--text-2xs)",
                }}
              >
                {KIND_LABEL[meta.kind || ""] ?? t("tools.exifUnknown")}
              </span>
              <span style={{ fontSize: "var(--text-2xs)", color: "var(--ink-faint)" }}>
                {meta.width && meta.height ? `${meta.width} × ${meta.height}` : ""}
                {meta.bytes ? `  ${fmtSize(meta.bytes)}` : ""}
              </span>
            </span>
          </div>
          <button data-exif-replace onClick={() => void pick()} style={hbtn}>
            {Icon.refresh}
            {t("tools.exifReplace")}
          </button>
          <button data-exif-clear onClick={clear} style={hbtn}>
            {Icon.close12}
            {t("common.close")}
          </button>
        </div>
      )}

      {meta && (
        <div
          style={{
            flex: 1,
            minHeight: 0,
            display: "grid",
            gridTemplateColumns: "1fr 1fr",
            gap: "var(--sp-4)",
            overflow: "hidden",
          }}
        >
          <Col title={t("tools.exifPrompts")}>
            {/* ★구획을 나눠 보여 준다 (v2 index.html:25714-25752). 빈 것도 자리를 지킨다 —
                「없다」는 것도 알아야 하는 정보다 */}
            <Prompt label={t("tools.pBase")} value={meta.prompt} empty={t("tools.exifEmpty")} />
            <Prompt
              label={t("tools.pChar")}
              value={(meta.characters ?? []).map((c) => c.prompt).filter(Boolean).join("\n---\n")}
              empty={t("tools.exifEmpty")}
            />
            {(meta.characters ?? []).some((c) => (c.negative || "").trim()) && (
              <Prompt
                label={t("tools.pCharNeg")}
                value={(meta.characters ?? []).map((c) => c.negative || "").join("\n---\n")}
                empty={t("tools.exifEmpty")}
              />
            )}
            {!!meta.slot_prompt && <Prompt label={t("tools.pScene")} value={meta.slot_prompt} empty={t("tools.exifEmpty")} />}
            <Prompt label={t("tools.pNeg")} value={meta.negative} empty={t("tools.exifEmpty")} />
          </Col>

          <Col title={t("tools.exifSettings")}>
            <Fields label={t("tools.exifSettings")} rows={settingRows(meta)} />
            {meta.comfy && (
              <Fields
                label={t("tools.exifWorkflow")}
                rows={[
                  ["Model", meta.comfy.model],
                  ["Denoise", meta.comfy.denoise],
                  ["Nodes", meta.comfy.nodes],
                ]}
              />
            )}
            {meta.vibe && (
              <Fields
                label={t("tools.exifVibe")}
                rows={[
                  ["Model", meta.vibe.model],
                  ["Reference Strength", meta.vibe.strength],
                  ["Information Extracted", meta.vibe.info_extracted],
                ]}
              />
            )}
            {!!(meta.nai_vibes?.images?.length ?? 0) && (
              <Fields
                label={t("tools.exifVibe")}
                rows={[
                  ["Count", meta.nai_vibes?.images?.length],
                  ["Strength", (meta.nai_vibes?.strengths ?? []).join(", ")],
                  ["Info extracted", (meta.nai_vibes?.info_extracted ?? []).join(", ")],
                ]}
              />
            )}
            {!!meta.precise_ref_count && (
              <Fields label={t("tools.exifRefs")} rows={[["Count", meta.precise_ref_count]]} />
            )}
            {!!Object.keys(meta.extra ?? {}).length && (
              <Fields label={t("tools.exifRaw")} rows={Object.entries(meta.extra ?? {})} />
            )}
          </Col>
        </div>
      )}
    </div>
  );
}

/** 설정 열의 줄 — ★없는 값은 아예 안 낸다 (v2 `activeSettings` 와 같은 판정) */
/** ★★이름은 **NAI 웹 클라이언트 표기 그대로**다 (사용자 지시 2026-08-20:
 *  "NAI 공홈에 있는 값들은 번역하지마"). 우리 줄임말(`CFG`·`Scheduler`)도 쓰지 않는다 —
 *  한국어 정식 번역이 없어서 옮기면 무엇을 가리키는지 알 수 없게 된다. */
function settingRows(m: Meta): [string, unknown][] {
  return [
    ["Seed", m.seed],
    ["Size", m.width && m.height ? `${m.width} × ${m.height}` : ""],
    ["Steps", m.steps],
    ["Prompt Guidance (CFG)", m.cfg],
    ["Sampler", m.sampler],
    ["Noise Schedule", m.scheduler],
    ["Model", m.nai_model],
    ["Prompt Guidance Rescale", m.cfg_rescale],
    ["SMEA", m.smea === "none" ? "" : m.smea],
    ["UC Preset", m.uc_preset],
    ["Quality Preset", m.quality_preset ?? m.quality_tags],
    ["Variety+", m.variety_plus],
    ["Furry", m.furry_mode],
  ];
}

const fmtSize = (n: number) =>
  n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`;

function Col({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", minHeight: 0, gap: "var(--sp-2)" }}>
      <span style={{ fontSize: "var(--text-xs)", fontWeight: "var(--w-semi)", color: "var(--ink-soft)" }}>
        {title}
      </span>
      <div
        data-exif-col
        style={{
          flex: 1,
          minHeight: 0,
          overflowY: "auto",
          background: "var(--panel)",
          border: "1px solid var(--line)",
          borderRadius: "var(--r-3)",
          padding: "var(--sp-3)",
          display: "flex",
          flexDirection: "column",
          gap: "var(--sp-4)",
        }}
      >
        {children}
      </div>
    </div>
  );
}

/** 프롬프트 한 구획 — **복사 단추가 눈에 보인다** (v2 `exif-copy-btn` 과 같은 쓰임).
 *
 *  ★★예전에는 글자를 누르면 복사되기만 했다 (사용자 지적 2026-08-21). 커서가 `copy` 로
 *    바뀌는 것 말고는 표가 없어서, 복사가 되는 자리인 줄 알 방법이 없었다.
 *  ★글자 누르기도 **그대로 남긴다** — 이미 그렇게 쓰던 사람이 있다. 창구가 둘이 아니라
 *    같은 일을 하는 **넓은 과녁과 또렷한 표지**다. */
function Prompt({ label, value, empty }: { label: string; value?: string; empty: string }) {
  const t = useI18n((s) => s.t);
  const has = !!(value || "").trim();
  const copy = () => has && void navigator.clipboard?.writeText(value || "").then(() => toast(label));
  return (
    <div data-exif-part={label} style={{ display: "flex", flexDirection: "column", gap: 3 }}>
      <span style={{ display: "flex", alignItems: "center", gap: "var(--sp-2)" }}>
        <span style={{ flex: 1, minWidth: 0, fontSize: "var(--text-2xs)", color: "var(--ink-faint)" }}>
          {label}
        </span>
        {has && (
          <button data-exif-copy={label} onClick={copy} data-tip={t("act.copy")} style={copyBtn}>
            {Icon.copy}
          </button>
        )}
      </span>
      <span
        onClick={copy}
        data-tip={has ? value : undefined}
        style={{
          fontSize: "var(--text-2xs)",
          lineHeight: 1.6,
          color: has ? "var(--ink)" : "var(--ink-ghost)",
          fontFamily: "var(--font-mono)",
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
          cursor: has ? "copy" : "default",
        }}
      >
        {has ? value : empty}
      </span>
    </div>
  );
}

/** 이름·값 줄 묶음 */
function Fields({ label, rows }: { label: string; rows: [string, unknown][] }) {
  const live = rows.filter(([, v]) => v !== undefined && v !== null && v !== "" && v !== false);
  if (!live.length) return null;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
      <span style={{ fontSize: "var(--text-2xs)", color: "var(--ink-faint)" }}>{label}</span>
      {live.map(([k, v]) => (
        <div key={k} style={{ display: "flex", alignItems: "baseline", gap: "var(--sp-3)" }}>
          <span style={{ width: 92, flexShrink: 0, fontSize: "var(--text-2xs)", color: "var(--ink-dim)" }}>{k}</span>
          <span
            style={{
              flex: 1,
              minWidth: 0,
              fontSize: "var(--text-2xs)",
              color: "var(--ink)",
              wordBreak: "break-word",
              whiteSpace: "pre-wrap",
            }}
          >
            {v === true ? "on" : String(v)}
          </span>
        </div>
      ))}
    </div>
  );
}

/** 구획 머리의 복사 단추 — 작고 흐리게, 누르면 그 구획만 복사한다 */
const copyBtn: React.CSSProperties = {
  flexShrink: 0,
  display: "grid",
  placeItems: "center",
  width: 20,
  height: 20,
  borderRadius: "var(--r-1)",
  border: "1px solid var(--line)",
  background: "var(--panel)",
  color: "var(--ink-dim)",
};

const hbtn: React.CSSProperties = {
  flexShrink: 0,
  display: "inline-flex",
  alignItems: "center",
  gap: "var(--sp-2)",
  background: "var(--panel)",
  border: "1px solid var(--line)",
  borderRadius: "var(--r-2)",
  padding: "3px var(--sp-3)",
  fontSize: "var(--text-2xs)",
  color: "var(--ink-soft)",
};
