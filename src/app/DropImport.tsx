import { useState } from "react";
import { useI18n } from "../i18n";
import { Icon } from "../components/Icon";
import { DropVeil } from "../cards/DropVeil";
import { useImageDrop, type Dropped } from "../lib/dropImages";
import { DROP_ACCEPT, readDrop, vibeFromCachePng, type DropRead } from "../lib/dropImport";
import { hasMeta } from "../lib/metaApply";
import { isNaiVibeFile } from "../lib/naiVibeFile";
import { MAX_VIBES, processReference, pushVibe, useImageInput } from "../store/imageInput";
import { vibeDefaults } from "../lib/vibeDefaults";
import { fitSizeToBase, modelCaps, useGen } from "../store/gen";
import { useUi } from "../store/ui";
import { toast } from "../store/toast";
import { ask } from "../store/ask";
import { useGallery } from "../store/gallery";
import { useWs } from "../store/workspace";
import { applyMeta, PICK_DROP, ReproNote, type MetaPick } from "../panels/GalleryMeta";
import { showInExif } from "../panels/tools/ExifTool";

/** 밖에서 떨군 그림 하나를 **무엇으로 쓸지 고르는 자리** (v2 「드롭 확인 모달」 이식).
 *
 *  ★★**떨어뜨린 뒤에 고른다.** 떨구는 순간 곧바로 적용하지 않는 까닭은, 그림 한 장이 쓰일 곳이
 *    넷이기 때문이다 — 설정·베이스 이미지·바이브·레퍼런스. 어디로 갈지 코드가 짐작하면
 *    반은 틀린다.
 *  ★★**받는 자리를 생성·갤러리 모드로 한정한다** (v2 `!isInCensorMode() && !isInUtilityMode()`).
 *    자동검열과 보조 도구에는 **자기 드롭존이 이미 있고**, 그쪽도 창 전체로 받는다
 *    (`ExifTool` 의 `wide`). 여기까지 매달면 한 번 떨군 것을 둘이 잡는다.
 *    ★그래서 이 컴포넌트는 **그 두 모드에서 아예 안 그려진다** (`App`).
 *  ★주인이 따로 있는 자리(`[data-drop-file]` — 베이스 그림 단추 등)는 비켜 간다.
 *    거기 떨구는 것은 「이걸로 하겠다」가 이미 정해진 동작이라 물어볼 것이 없다.
 */
export function DropImport() {
  const t = useI18n((s) => s.t);
  const model = useGen((g) => g.params.model);
  const cap = modelCaps(model);
  const [sheet, setSheet] = useState<DropRead | null>(null);
  const [busy, setBusy] = useState(false);

  const take = async (items: Dropped[]) => {
    const it = items[0];
    if (!it || busy) return;
    setBusy(true);
    try {
      const read = await readDrop(it);
      /* ★★**갤러리에 떨구면 시트를 안 띄운다** (사용자 지시 2026-08-25: *"갤러리에 드롭 시에
           지금 생성과 동일한 모달이 뜨는데 이건 생성에만 떠야 함. 갤러리에서는 별도 동작"*).
         갤러리에서 그림을 떨구는 몸짓은 **「여기 넣어라」** 하나뿐이라 고를 것이 없다.
         ★NAI 메타데이터가 있으면 **바로** 넣고, 없으면 한 번 묻는다 — 설정이 안 남은 그림은
           나중에 그 그림에서 되돌릴 것이 없으므로, 그것을 알고 넣는 편이 낫다.
         ★바이브 파일은 그림이 아니다 — 갤러리에 넣을 것이 없으니 지금까지대로 시트로 간다. */
      if (useUi.getState().mode === "gallery" && read.kind === "image") {
        /* ★★**여러 장을 한 번에 받는다** (사용자 지시 2026-08-29: *"갤러리 다중 드롭"*).
           첫 장은 이미 읽었고 나머지는 여기서 읽는다 — 하나가 깨졌다고 전부 버리지 않는다.
           ★설정이 없는 장이 섞여 있으면 **한 번만** 묻는다: 그래도 넣겠다고 하면 그것까지,
             아니면 설정 있는 장만 넣는다. 장마다 물으면 열 장 떨구고 열 번 답해야 한다. */
        type Img = Extract<DropRead, { kind: "image" }>;
        const reads: Img[] = [read];
        for (const other of items.slice(1)) {
          try {
            const r = await readDrop(other);
            if (r.kind === "image") reads.push(r);
          } catch (e) {
            toast(`${other.name}: ${String(e)}`, "warn");
          }
        }
        const withBytes = reads.filter((r) => r.meta?.data);
        if (!withBytes.length) return void toast(t("drop.noBytes"), "warn");
        const withMeta = withBytes.filter((r) => hasMeta(r.meta));
        const noMeta = withBytes.filter((r) => !hasMeta(r.meta));
        const list =
          noMeta.length &&
          (await ask({
            title: t("drop.noMetaAsk"),
            ok: t("drop.toGallery"),
            cancel: t("common.cancel"),
          }))
            ? withBytes
            : withMeta;
        if (!list.length) return;
        const ws = useWs.getState().current;
        for (const r of list) await useGallery.getState().importImage(ws, r.meta!.data!, r.name);
        toast(list.length > 1 ? t("drop.addedMany", { n: list.length }) : t("drop.added"));
        return;
      }
      setSheet(read);
      // ★여러 장은 **말하고 첫 장만** 받는다 (v2 는 말없이 `files[0]` 이었다) —
      //   조용히 버리면 나머지가 어디 갔는지 알 수 없다
      if (items.length > 1) toast(t("drop.onlyOne"), "warn");
    } catch (e) {
      toast(isNaiVibeFile(it.name) ? t("imgIn.vibeFileBad") : String(e), "warn");
    } finally {
      setBusy(false);
    }
  };

  const { over } = useImageDrop(take, true, DROP_ACCEPT);

  return (
    <>
      {/* ★★강조 양식은 **앱 전체에서 하나**다 (`cards/DropVeil`, 사용자 지시 2026-08-20:
          *"강조 스타일이 전부 다름. 통일시켜야해"*). 여기서 점선 테두리를 새로 만들지 않는다.
          ★어둠(`DragLayer`)은 안 깐다 — 그것은 「받는 자리만 밝힌다」는 뜻인데, 밖에서 온
            파일은 **창 전체가 받는 자리**라 밝힐 것과 덮을 것이 갈리지 않는다. */}
      {over && !sheet && (
        <div data-drop-overlay style={{ position: "fixed", inset: 0, zIndex: 70, pointerEvents: "none" }}>
          <DropVeil over name="import" label={t("drop.hint")} />
        </div>
      )}
      {sheet && <Sheet read={sheet} cap={cap} model={model} onClose={() => setSheet(null)} />}
    </>
  );
}

function Sheet({
  read,
  cap,
  model,
  onClose,
}: {
  read: DropRead;
  cap: ReturnType<typeof modelCaps>;
  model: string;
  onClose: () => void;
}) {
  const t = useI18n((s) => s.t);
  const [busy, setBusy] = useState(false);
  /** 무엇을 가져올까 — 공홈과 같은 갈래 (`ImportPicks`).
   *  ★★**설정에 남는다** (사용자 지시 2026-08-30: 체크한 것을 기억할 것). 옛 저장본에는
   *    `model` 이 없을 수 있어 기본값 위에 얹어 읽는다. */
  const saved = useUi((u) => u.importPick);
  const pick: MetaPick = { ...PICK_DROP, ...saved };
  const setPick = useUi((u) => u.setImportPick);
  const vibeFile = read.kind === "vibefile" ? read.vibe : null;
  const m = read.kind === "image" ? read.meta : null;
  const name = read.name;
  /** 바이브 캐시 PNG 면 **구워 둔 인코딩**이 함께 온다 — 그대로 쓰면 Anlas 가 안 나간다 */
  const cached = m ? vibeFromCachePng(m, name) : null;
  const canApply = hasMeta(m);

  const preview = vibeFile
    ? vibeFile.image && `data:image/png;base64,${vibeFile.image}`
    : m?.preview || (m?.data && `data:image/png;base64,${m.data}`);

  /** ★적용한 것은 **생성 화면**에 나타난다 — 갤러리에서 떨궜으면 데려가야 보인다 */
  const leave = () => {
    useUi.getState().setMode("generate");
    onClose();
  };

  /** 「설정 적용」 — 그림 아래 「설정 불러오기」와 **같은 것**이다 (`ImageActions.useSettings`).
   *  ★밖에서 온 그림에는 생성 시점 스냅샷(`env`)도 기록된 베이스도 없다. 되돌릴 수 있는 것은
   *    그림에 남은 것 전부다 — 프롬프트·캐릭터·생성 옵션·해상도·시드·바이브. */
  const applySettings = () => {
    if (!m) return;
    applyMeta(m, pick);
    toast(t("act.applied"));
    leave();
  };

  /** 「갤러리에 추가」 — 생성하지 않고 **바이트 그대로** 보관함에 들인다 */
  const toGallery = async () => {
    if (!m?.data || busy) return;
    setBusy(true);
    try {
      await useGallery.getState().importImage(useWs.getState().current, m.data, name);
      toast(t("drop.added"));
      onClose();
    } catch (e) {
      toast(String(e), "warn");
    } finally {
      setBusy(false);
    }
  };

  const asBase = async () => {
    if (!m?.data || busy) return;
    setBusy(true);
    try {
      useImageInput.getState().setBase(m.data, name);
      await fitSizeToBase(m.data);
      /* ★★**그 자리로 데려간다** (사용자 지적 2026-08-26: *"이미지 드롭해서 베이스 이미지로
           등록할 때 해당 위치로 자동 스크롤 안 되고 있음"*).
         ★밖에서 끌어다 놓은 사람은 **그림이 어디로 들어갔는지 모른다.** 앱 안의 그림을
           i2i 로 보내는 길(`ImageActions` 의 `reveal("left", "base", true)`)과 **가는 곳이
           같으므로** 거동도 같아야 한다. 예전에는 여기만 거짓이라 강조만 뜨고 말았다.
         ★자동 스크롤의 기본은 여전히 끔이다 (사용자 지시 2026-08-22). 참을 주는 자리는
           **베이스 그림뿐**이고 지금 그것이 둘이다. 다른 자리로 늘리지 말 것. */
      useUi.getState().reveal("left", "base", true);
      leave();
    } finally {
      setBusy(false);
    }
  };

  /** 바이브 한 장. ★구워 둔 인코딩이 있으면 그것까지 싣는다 (`.naiv4vibe` · 바이브 캐시 PNG).
   *  ★맨 그림은 **모델별 기본값**으로 넣는다 (`lib/vibeDefaults` — 공홈과 같은 인코딩을 굽는다). */
  const asVibe = () => {
    const d = vibeDefaults(model);
    const v =
      vibeFile ?? cached ?? (m?.data ? { name, image: m.data, strength: d.strength, info_extracted: d.infoExtracted } : null);
    if (!v) return;
    if (!pushVibe(v)) return toast(t("imgIn.vibeFull", { n: MAX_VIBES }), "warn");
    toast(v.encoded ? t("imgIn.vibeFileCached") : t("imgIn.vibeFileAdded"));
    leave();
  };

  const asRef = async () => {
    if (!m?.data || busy) return;
    setBusy(true);
    try {
      useImageInput.getState().setRefOn(true);
      useImageInput.getState().addRef({
        // ★보내는 것은 **다듬은 판**, 보여 주는 것은 원본이다 (`processReference` 의 ★주)
        image: await processReference(m.data),
        preview: m.data,
        name,
        mode: "character&style",
        strength: 1,
        fidelity: 1,
      });
      leave();
    } catch (e) {
      toast(String(e), "warn");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      data-drop-sheet
      onPointerDown={(e) => e.target === e.currentTarget && onClose()}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 80,
        background: "rgba(6,8,12,0.6)",
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
          width: "min(560px, 92vw)",
          maxHeight: "86vh",
          display: "flex",
          flexDirection: "column",
          gap: "var(--sp-4)",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "var(--sp-3)" }}>
          <b style={{ fontSize: "var(--text-md)" }}>{t("drop.title")}</b>
          <span style={{ flex: 1 }} />
          <button data-drop-close onClick={onClose} style={{ color: "var(--ink-faint)", display: "grid" }}>
            {Icon.close}
          </button>
        </div>

        <div style={{ display: "flex", gap: "var(--sp-4)", minHeight: 0, flex: 1 }}>
          {/* ★★**썸네일이 크고, 곁들이는 글은 없다** (사용자 지시 2026-08-25: *"이 모달에서
              파일명, 메타데이터 등을 미리 보여 줄 필요 없음. 그냥 썸네일만 보이고 버튼들이
              더 메인이 되게"*). 파일 이름도 값 요약도 걷었다 — 여기서 정하는 것은
              「이 그림을 무엇으로 쓸까」 하나이고, 값을 읽는 자리는 EXIF 리더다. */}
          <div style={{ flexShrink: 0, width: 200 }}>
            {preview ? (
              <img
                src={preview}
                alt=""
                style={{
                  width: "100%",
                  maxHeight: "42vh",
                  objectFit: "contain",
                  borderRadius: "var(--r-2)",
                  border: "1px solid var(--line)",
                  background: "var(--surface2)",
                }}
              />
            ) : (
              <div
                style={{
                  height: 140,
                  borderRadius: "var(--r-2)",
                  border: "1px solid var(--line)",
                  background: "var(--surface2)",
                }}
              />
            )}
          </div>

          <div style={{ flex: 1, minWidth: 0, minHeight: 0, overflowY: "auto" }}>
            {vibeFile || cached ? (
              /* ★바이브는 **값이 곧 쓰임**이다 (강도·정보추출·구워 둠) — 이건 남긴다.
                 구워 둔 것이 있으면 Anlas 가 안 나가는데, 그것을 모르면 고를 수가 없다. */
              <VibeInfo
                strength={(vibeFile ?? cached)!.strength}
                info={(vibeFile ?? cached)!.info_extracted}
                model={(vibeFile ?? cached)!.encoded_model}
                cached={!!(vibeFile ?? cached)!.encoded}
              />
            ) : canApply ? (
              /* ★★**고르는 목록과 「가져오기」는 한 덩이다** (사용자 지시 2026-08-25:
                   *"저 체크박스는 「가져오기」랑만 관련 있는 건데 같은 그룹처럼 보이지가 않음"*).
                 체크 상자가 아래 단추 줄과 떨어져 있으면, 그 체크가 **어느 단추에 걸리는지**가
                 화면에 안 나타난다 — 베이스·바이브·갤러리 단추에도 걸리는 것처럼 읽힌다.
                 그래서 테두리 하나로 묶고 **단추를 그 안에** 넣는다. */
              <div
                data-drop-import
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: "var(--sp-3)",
                  padding: "var(--sp-3)",
                  borderRadius: "var(--r-3)",
                  border: "1px solid var(--line)",
                  background: "var(--surface2)",
                }}
              >
                {/* ★★**못 되살리는 것은 말해 준다** (사용자 결정 2026-08-25 — 공홈과 같은 갈래).
                    가져오기를 막지는 않는다: 프롬프트·설정은 그대로 들어가고, 그림이 왜
                    달라지는지만 미리 알린다. */}
                <ReproNote meta={m} />
                <ImportPicks pick={pick} onPick={setPick} />
                <button
                  data-drop-apply
                  disabled={busy}
                  onClick={applySettings}
                  data-tip={t("drop.applyHint")}
                  style={{
                    ...btn,
                    width: "100%",
                    justifyContent: "center",
                    background: "var(--accent)",
                    color: "var(--accent-on)",
                    borderColor: "var(--accent)",
                  }}
                >
                  {t("drop.apply")}
                </button>
              </div>
            ) : (
              <div style={{ fontSize: "var(--text-2xs)", color: "var(--ink-faint)", lineHeight: 1.6 }}>
                {t("drop.noMeta")}
              </div>
            )}
          </div>
        </div>

        {/* **이 그림으로 할 다른 일** — 가져오기와 달리 고를 것이 없는, 한 번 누르면 끝나는 것들.
            ★**이 그림에 뜻이 있는 것만** 낸다. 눌러야 실패하는 단추를 두지 않는다.
            ★★**「취소」는 없다** (사용자 지시 2026-08-23) — 머리의 `×` 와 하는 일이 같다.
            ★★「가져오기」는 **여기 없다** (2026-08-25) — 체크 목록과 한 덩이라 그 상자 안에 있다.
              이 줄로 도로 내리지 말 것: 그러면 체크가 어느 단추에 걸리는지가 다시 흐려진다. */}
        <div style={{ display: "flex", flexWrap: "wrap", justifyContent: "flex-end", gap: "var(--sp-2)" }}>
          {/* ★★프롬프트·설정을 **읽는 것**은 EXIF 리더의 일이다 (사용자 지시 2026-08-23).
              여기서는 보내기만 한다 — 이미 읽어 둔 것을 그대로 넘기므로 다시 안 물어본다. */}
          {canApply && (
            <button
              data-drop-exif
              disabled={busy}
              onClick={() => {
                showInExif(name, m);
                onClose();
              }}
              style={btn}
            >
              {t("drop.exif")}
            </button>
          )}
          {/* ★바이브 파일은 그림이 아니다 — 베이스·레퍼런스로 못 쓴다.
              ★원본 바이트가 안 왔으면 눌러도 아무 일이 없으므로 아예 안 낸다 */}
          {!vibeFile && !!m?.data && (
            <button data-drop-base disabled={busy} onClick={() => void asBase()} style={btn}>
              {t("imgIn.base")}
            </button>
          )}
          {/* ★모델이 못 하는 것은 안 낸다 — V5 에는 Vibe 도 Precise Reference 도 없다 */}
          {cap.vibe && (vibeFile || !!m?.data) && (
            <button data-drop-vibe disabled={busy} onClick={asVibe} style={btn}>
              {t("imgIn.vibeAdd")}
            </button>
          )}
          {cap.char_ref && !vibeFile && !!m?.data && (
            <button data-drop-ref disabled={busy} onClick={() => void asRef()} style={btn}>
              {t("imgIn.ref")}
            </button>
          )}
          {/* ★★**갤러리에 그대로 넣는다** (사용자 지시 2026-08-25: *"현재는 설정 적용 후 한 번
              생성해서 갤러리에 넣어야 하는데, 그냥 그걸 한 번에 넣어 주게"*).
              생성 없이 바이트를 그대로 보관함에 들이므로 Anlas 도 안 나간다.
              ★NAI 메타데이터가 있는 그림에만 낸다 — 없는 그림을 들이는 길은 **갤러리에
                떨구는 것**이고, 그쪽은 물어보고 넣는다 (`DropImport` 의 갤러리 갈래). */}
          {canApply && !!m?.data && (
            <button
              data-drop-gallery
              disabled={busy}
              onClick={() => void toGallery()}
              data-tip={t("drop.toGalleryHint")}
              style={btn}
            >
              {t("drop.toGallery")}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/** **무엇을 가져올까** — 공홈(NovelAI)이 드롭할 때 내는 목록과 같은 갈래다
 *  (사용자 지시 2026-08-25: *"공홈에 보면 드롭했을 때 저렇게 항목을 선택해서 넣을 수 있음"*).
 *
 *  ★`Append` 는 **캐릭터에 딸린 것**이라 한 칸 들여 쓴다 — 켜면 지금 인물 뒤에 잇고,
 *    끄면 갈아 끼운다. 캐릭터를 안 가져오면 눌러도 뜻이 없으므로 함께 잠근다.
 *  ★처음 상태는 `PICK_DROP` 이다 (프롬프트·캐릭터만) — 그 까닭은 그쪽 주석에 있다. */
function ImportPicks({ pick, onPick }: { pick: MetaPick; onPick: (p: MetaPick) => void }) {
  const t = useI18n((s) => s.t);
  const Row = ({ k, label, sub }: { k: keyof MetaPick; label: string; sub?: boolean }) => {
    const off = !!sub && !pick.characters;
    const on = pick[k] && !off;
    return (
      <button
        data-drop-pick={k}
        data-on={on ? "" : undefined}
        disabled={off}
        onClick={() => onPick({ ...pick, [k]: !pick[k] })}
        style={{
          display: "flex",
          alignItems: "center",
          gap: "var(--sp-2)",
          padding: "3px 0",
          marginLeft: sub ? "var(--sp-5)" : 0,
          fontSize: "var(--text-xs)",
          color: off ? "var(--ink-ghost)" : on ? "var(--ink)" : "var(--ink-faint)",
          cursor: off ? "default" : "pointer",
        }}
      >
        <span
          style={{
            display: "grid",
            placeItems: "center",
            width: 18,
            height: 18,
            flexShrink: 0,
            borderRadius: "var(--r-1)",
            border: `1px solid ${on ? "var(--accent)" : "var(--line)"}`,
            background: on ? "var(--accent)" : "transparent",
            color: on ? "var(--accent-on)" : "var(--ink-ghost)",
          }}
        >
          {on ? Icon.check : Icon.close12}
        </span>
        {label}
      </button>
    );
  };
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-start" }}>
      {/* ★모델이 **맨 앞**이다 — 가장 먼저 적용된다 (`lib/metaApply` 의 `MetaPick` ★★주) */}
      <Row k="model" label={t("drop.pickModel")} />
      <Row k="prompt" label={t("drop.pickPrompt")} />
      <Row k="uc" label={t("drop.pickUc")} />
      <Row k="characters" label={t("drop.pickChars")} />
      <Row k="append" label={t("drop.pickAppend")} sub />
      <Row k="settings" label={t("drop.pickSettings")} />
      <Row k="seed" label={t("drop.pickSeed")} />
    </div>
  );
}
/** 바이브 한 장의 값 — ★**구워 둠**을 눈에 띄게 말한다. 그것이 Anlas 를 가르는 유일한 정보다 */
function VibeInfo({
  strength,
  info,
  model,
  cached,
}: {
  strength: number;
  info: number;
  model?: string;
  cached: boolean;
}) {
  const t = useI18n((s) => s.t);
  const row = (k: string, v: string) => (
    <div style={{ display: "flex", gap: "var(--sp-2)", padding: "2px 0" }}>
      <span style={{ width: 120, flexShrink: 0, color: "var(--ink-faint)" }}>{k}</span>
      <span style={{ color: "var(--ink-soft)", fontFamily: "var(--font-mono)" }}>{v}</span>
    </div>
  );
  return (
    <div style={{ fontSize: "var(--text-2xs)" }}>
      {row(t("imgIn.strength"), String(strength))}
      {row(t("imgIn.info"), String(info))}
      {!!model && row(t("gallery.fieldModel"), model)}
      <div style={{ marginTop: "var(--sp-2)", color: cached ? "var(--ok)" : "var(--warn)" }}>
        {cached ? t("drop.vibeCached") : t("drop.vibeRaw")}
      </div>
    </div>
  );
}

const btn: React.CSSProperties = {
  padding: "var(--sp-2) var(--sp-3)",
  borderRadius: "var(--r-2)",
  border: "1px solid var(--line)",
  fontSize: "var(--text-xs)",
  color: "var(--ink-soft)",
};
