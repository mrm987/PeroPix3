import { useI18n } from "../i18n";
import { useRename } from "../components/useRename";
import { ask } from "../store/ask";
import { toast } from "../store/toast";
import { useEffect, useRef, useState } from "react";
import { useGen } from "../store/gen";
import { useWs } from "../store/workspace";
import { useGallery } from "../store/gallery";
import { useDragSource, dragSourceStyle } from "../cards/dragStore";
import { keepThumb, keepUrl } from "../lib/imgUrl";
import { api } from "../lib/backend";
import { ImageActions, iconBtn } from "./ImageActions";
import { cloneMetaToNewTab } from "./GalleryMeta";
import { VibeCache } from "./VibeCache";
import { hasMeta } from "../lib/metaApply";
import { nextAfter } from "../lib/pickNext";
import type { ImageMeta } from "../store/gallery";
import { Icon } from "../components/Icon";
import { onNearBottom } from "../lib/nearBottom";

/** 옮길 곳 드롭다운에서 **최상위**를 가리키는 값. 서버가 쓰는 값은 빈 문자열인데,
 *  그것은 이 드롭다운에서 「고르지 않음」자리표시자가 이미 쓰고 있다. 보낼 때 되돌린다. */
const ROOT_DEST = "/";

/** 갤러리 — 워크스페이스에 쌓인 그림을 훑어 본다 (feature-inventory G절).
 *
 *  ★칸에는 **썸네일**을 쓴다 (`lib/imgUrl`). 여기는 수백 장이 한 번에 뜨는 화면이라,
 *    원본 PNG 를 걸면 그것만으로 무너진다. 크게 볼 때만 원본을 받는다.
 *
 *  조작: 클릭 = 크게 보기 · Ctrl(⌘)+클릭 = 선택. 두 가지가 한 칸에 겹치므로
 *  섞이지 않게 **선택은 수식키를 요구한다** (v2 의 일괄 삭제·이동이 이 선택을 먹는다). */
export function Gallery() {
  const t = useI18n((s) => s.t);
  const base = useGen((s) => s.base);
  const ws = useWs((s) => s.current);
  /** ★별표는 **보관함이 든다** — 워크스페이스가 아니다 (store/gallery.ts `starred` 주석) */
  const { items, folders, picked, focus, meta, loading, total, hasMore, load, more, setFocus,
          togglePick, pickAll, clearPick, remove, moveTo, isStarred, toggleStar, rename, vibeMode } =
    useGallery();
  // ★바닥에 닿기 전에 다음 쪽을 당긴다 (v2 방식, lib/nearBottom)
  const onScroll = onNearBottom(() => void more(ws));
  const [dest, setDest] = useState("");
  /** ★별표는 **거르는 장치**다 — 큰 그림에 별표 버튼을 두지 않는다 (사용자 지시 2026-08-05) */
  const [starOnly, setStarOnly] = useState(false);

  const shown = starOnly ? items.filter((i) => isStarred(i.file)) : items;
  const idx = focus ? shown.findIndex((i) => i.file === focus) : -1;

  // ★목록은 **여기서** 불러온다. 좌우 패널은 접으면 언마운트되지만 중앙은 항상 떠 있다.
  useEffect(() => {
    void load(ws);
  }, [ws, load]);

  // ★크게 보기가 열려 있을 때만 키를 먹는다 — 그리드에서 S 를 눌러도 아무 일이 없어야
  //   "무엇에 대한 별표인지" 가 모호해지지 않는다.
  useEffect(() => {
    if (!focus) return;
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT") return;
      if (e.key === "Escape") return void setFocus(ws, null);
      if (e.key === "ArrowLeft" && idx > 0) return void setFocus(ws, shown[idx - 1].file);
      if (e.key === "ArrowRight" && idx >= 0 && idx < shown.length - 1)
        return void setFocus(ws, shown[idx + 1].file);
      if (e.key === "s" || e.key === "S") return void toggleStar(focus);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [focus, idx, shown, ws, setFocus, toggleStar]);

  const onRemove = async () => {
    if (
      !(await ask({
        title: t("gallery.removeConfirm", { n: picked.size }),
        body: t("common.toTrash"),
        ok: t("common.delete"),
        cancel: t("common.cancel"),
        danger: true,
      }))
    )
      return;
    await remove(ws);
  };

  return (
    // ★position:relative 가 **필수다.** 크게 보기가 `inset:0` 이라, 여기가 기준이 아니면
    //   창 전체를 덮어 우 패널의 버튼까지 가린다 (실측으로 밟았다 — 배경 클릭으로 처리돼
    //   "불러오기"가 눌리지 않고 크게 보기만 닫혔다). 그림 정보는 크게 보는 중에도 보여야 한다.
    <div style={{ position: "relative", flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
      {/* ★★**바이브 칸이면 그리드 대신 그것을 그린다** (v2 와 같은 모드 갈아 끼우기).
          목록·툴바를 함께 감추는 까닭: 별표·고르기·옮기기는 **그림 폴더의 규칙**이라
          전역 자산인 캐시에는 뜻이 없다 (`store/gallery` 의 `vibeMode` ★★주). */}
      {vibeMode ? (
        <VibeCache />
      ) : (
      <>
      <Toolbar
        picked={picked.size}
        total={total || items.length}
        starOnly={starOnly}
        onStarOnly={() => setStarOnly((v) => !v)}
        folders={folders.map((f) => f.path)}
        dest={dest}
        setDest={setDest}
        onAll={pickAll}
        onClear={clearPick}
        onRemove={onRemove}
        onMove={() => dest && void moveTo(ws, dest === ROOT_DEST ? "" : dest)}
      />

      {items.length === 0 ? (
        <Empty loading={loading} />
      ) : (
        <div
          data-gallery-grid
          onScroll={onScroll}
          style={{
            flex: 1,
            minHeight: 0,
            overflowY: "auto",
            // 많은 것을 담아 들여다보는 자리 — 가라앉은 톤 (페로픽스파이 `.zoom-viewport`)
            background: "var(--bg)",
            padding: "var(--sp-3) var(--sp-4) var(--sp-4)",
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(132px, 1fr))",
            // ★행 높이를 **칸이 정하게** 둔다. 안 잡아 주면 암묵적 행이 0 높이로 접혀
            //   위아래 그림이 겹쳐 보인다 (사용자 지적 2026-08-05).
            gridAutoRows: "min-content",
            gap: "var(--sp-3)",
            alignContent: "start",
          }}
        >
          {shown.map((it) => (
            <Cell
              key={it.file}
              /* ★칸에는 **썸네일**이다 (lib/imgUrl `keepThumb`). 크게 볼 때만 원본을 받는다 */
              src={keepThumb(base, it.file)}
              name={it.name}
              starred={isStarred(it.file)}
              picked={picked.has(it.file)}
              onStar={() => void toggleStar(it.file)}
              onOpen={(withMod) => (withMod ? togglePick(it.file) : void setFocus(ws, it.file))}
              /* 고른 것이 있으면 **고른 것 전부**, 아니면 이 한 장 */
              onDragFiles={() => (picked.has(it.file) ? [...picked] : [it.file])}
            />
          ))}
          {hasMore && (
            <span
              data-gallery-more
              style={{ gridColumn: "1/-1", padding: "var(--sp-3)", textAlign: "center",
                       fontSize: "var(--text-2xs)", color: "var(--ink-faint)" }}
            >
              {t("gallery.more", { n: total - items.length })}
            </span>
          )}
        </div>
      )}

      </>
      )}

      {focus && (
        <Big
          url={keepUrl(base, focus)}
          name={shown[idx]?.name ?? ""}
          pos={idx >= 0 ? `${idx + 1}/${shown.length}` : ""}
          /* ★크게 본 그림 아래 줄 — 싱글·라이트박스와 같은 것 (ImageActions).
             보관함 그림은 워크스페이스 파일이 아니라 강화·보관은 없다. */
          file={focus}
          seed={meta?.seed}
          onRename={(name) => rename(ws, focus, name)}
          onClose={() => void setFocus(ws, null)}
          onPrev={idx > 0 ? () => void setFocus(ws, shown[idx - 1].file) : undefined}
          onNext={idx >= 0 && idx < shown.length - 1 ? () => void setFocus(ws, shown[idx + 1].file) : undefined}
          /* ★★**지우면 옆 그림으로 넘어간다** (사용자 지시 2026-08-25). 지울 때마다 창이
              닫히면, 여러 장을 훑어 내며 고르는 흐름이 매번 끊긴다.
             ★어디로 갈지는 **지우기 전에** 정한다 — 지운 뒤에는 그 장이 목록에서 빠져
              자리를 잃는다 (`lib/pickNext` 의 ★★주). 씬 줄과 같은 규칙이다. */
          nextOf={(file) => nextAfter(shown.map((x) => x.file), file)}
        />
      )}
    </div>
  );
}

function Toolbar({
  picked,
  total,
  starOnly,
  onStarOnly,
  folders,
  dest,
  setDest,
  onAll,
  onClear,
  onRemove,
  onMove,
}: {
  picked: number;
  total: number;
  starOnly: boolean;
  onStarOnly: () => void;
  folders: string[];
  dest: string;
  setDest: (s: string) => void;
  onAll: () => void;
  onClear: () => void;
  onRemove: () => void;
  onMove: () => void;
}) {
  const t = useI18n((s) => s.t);
  return (
    <div
      style={{
        flexShrink: 0,
        display: "flex",
        alignItems: "center",
        gap: "var(--sp-3)",
        padding: "var(--sp-2) var(--sp-4)",
        borderBottom: "1px solid var(--line-soft)",
        fontSize: "var(--text-2xs)",
        color: "var(--ink-faint)",
        minHeight: 34,
      }}
    >
      <span data-gallery-hint>{picked ? t("gallery.selected", { n: picked }) : t("gallery.pickHint")}</span>
      <span style={{ flex: 1 }} />
      {/* ★별표의 쓸모는 **거르기** 하나다 (사용자 지시 2026-08-05) */}
      <button
        data-star-filter
        onClick={onStarOnly}
        style={{
          ...linkBtn,
          display: "inline-flex",
          alignItems: "center",
          gap: 3,
          color: starOnly ? "var(--warn)" : "var(--ink-dim)",
          border: `1px solid ${starOnly ? "var(--warn)" : "transparent"}`,
        }}
      >
        {starOnly ? Icon.star12On : Icon.star12}
        {starOnly ? t("canvas.starAll") : t("canvas.starOnly")}
      </button>
      {total > 0 && (
        <button onClick={onAll} style={linkBtn}>
          {t("gallery.selectAll")}
        </button>
      )}
      {picked > 0 && (
        <>
          <button onClick={onClear} style={linkBtn}>
            {t("gallery.clear")}
          </button>
          <select
            value={dest}
            onChange={(e) => setDest(e.target.value)}
            aria-label={t("gallery.moveTo")}
            style={{
              background: "var(--surface2)",
              border: "1px solid var(--line)",
              borderRadius: "var(--r-1)",
              color: "var(--ink-dim)",
              fontSize: "var(--text-2xs)",
              padding: "2px var(--sp-2)",
            }}
          >
            <option value="">{t("gallery.moveTo")}</option>
            {/* ★서버가 주는 첫 줄은 `path: ""`(전체)이라 그대로 쓰면 **빈 이름 항목**이
                하나 더 생기고, 값이 자리표시자와 같아서 **최상위로 되돌리는 이동이 안 된다.**
                여기서만 자리표시자와 갈리는 값을 붙이고, 보낼 때 다시 빈 문자열로 되돌린다. */}
            {folders.map((f) => (
              <option key={f || ROOT_DEST} value={f || ROOT_DEST}>
                {f || t("gallery.rootFolder")}
              </option>
            ))}
          </select>
          <button onClick={onMove} disabled={!dest} style={{ ...linkBtn, opacity: dest ? 1 : 0.4 }}>
            →
          </button>
          <button onClick={onRemove} style={{ ...linkBtn, color: "var(--err-ink)" }}>
            {t("gallery.remove")}
          </button>
        </>
      )}
    </div>
  );
}

const linkBtn: React.CSSProperties = {
  padding: "2px var(--sp-2)",
  borderRadius: "var(--r-1)",
  color: "var(--ink-dim)",
  fontSize: "var(--text-2xs)",
};

function Empty({ loading }: { loading: boolean }) {
  const t = useI18n((s) => s.t);
  if (loading) return <div style={{ flex: 1 }} />;
  return (
    <div
      data-gallery-empty
      style={{
        flex: 1,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: "var(--sp-2)",
        color: "var(--ink-faint)",
      }}
    >
      <div style={{ fontSize: "var(--text-lg)" }}>{t("gallery.empty")}</div>
      <div style={{ fontSize: "var(--text-xs)" }}>{t("gallery.emptyHint")}</div>
    </div>
  );
}

function Cell({
  src,
  name,
  starred,
  picked,
  onStar,
  onOpen,
  onDragFiles,
}: {
  src: string;
  name: string;
  starred: boolean;
  picked: boolean;
  onStar: () => void;
  onOpen: (withMod: boolean) => void;
  /** 끌기 시작 — 폴더 목록이 받는다 (`GalleryFolders`) */
  onDragFiles: () => string[];
}) {
  const startDrag = useDragSource();
  return (
    // ★★**단추가 아니라 `div` 다** (사용자 지적 2026-08-19: 갤러리 그림이 안 끌렸다).
    //   크로미움은 `<button>` 에 `draggable` 을 줘도 끌기를 시작하지 않는다 — 폼 컨트롤의
    //   기본 눌림 처리가 먼저 가져간다. 누르는 것은 `role="button"` 으로 그대로 둔다.
    <div
      data-gallery-cell={name}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen(e.ctrlKey || e.metaKey);
        }
      }}
      data-tip={name}
      /* ★★그림을 **폴더로 끌어다 옮긴다** (사용자 지시 2026-08-19).
         ★HTML5 `draggable` 은 이 앱에서 안 된다 — Tauri 가 `dragDropEnabled` 로 드래그를
           가로채기 때문이다 (`cards/dragStore` 머리 주석). 그래서 **앱의 포인터 끌기**를 쓴다.
         ★누르기는 `onTap` 으로 받는다 — pointerdown 의 기본 동작 막기가 호환 click 을 삼킨다. */
      onPointerDown={(e) =>
        startDrag(
          e,
          { dir: "apply", kind: "keep", files: onDragFiles(), img: { ws: "", file: name, url: src } },
          undefined,
          () => onOpen(e.ctrlKey || e.metaKey),
        )
      }
      style={{
        // ★끌기 출발점의 공통 차림 — 네이티브 이미지 끌기·글자 선택을 원천에서 막는다.
        //   여기만 빠져 있었다 (다른 출발점은 전부 쓴다).
        ...dragSourceStyle,
        position: "relative",
        aspectRatio: "832 / 1216",
        borderRadius: "var(--r-2)",
        overflow: "hidden",
        cursor: "pointer",
        background: "var(--surface2)",
        border: `2px solid ${picked ? "var(--accent)" : "transparent"}`,
      }}
    >
      <img
        src={src}
        alt=""
        loading="lazy"
        decoding="async"
        style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
      />
      {/* ★여기서 **켜고 끈다** (페로픽스파이 `.thumb-star`). 큰 그림에는 별표를 두지 않는다 —
          견주며 고르는 일은 격자에서 일어난다. */}
      <span
        data-cell-star={name}
        onClick={(e) => {
          e.stopPropagation();
          onStar();
        }}
        style={{
          position: "absolute",
          right: 2,
          top: 1,
          padding: "1px 2px",
          borderRadius: 3,
          background: "rgba(10,14,20,0.55)",
          color: starred ? "var(--warn)" : "rgba(255,255,255,0.8)",
          display: "grid",
          opacity: starred ? 1 : 0,
          transition: "opacity 120ms",
        }}
        className="thumb-star"
      >
        {/* ★썸네일 위 별표는 **18px** — 씬 칸과 같은 자리라 크기도 같아야 한다
            (사용자 지시 2026-08-18). 글자 옆에 서는 것(위 「별표만 보기」 단추·`StarCount`)은
            12px 그대로다 — 글자 높이에 맞아야 줄이 안 흔들린다 */}
        {starred ? Icon.star18On : Icon.star18}
      </span>
    </div>
  );
}

/** 크게 보기 — 원본을 받는다. 그리드 위에 덮는다. */
function Big({
  url,
  name,
  pos,
  file,
  seed,
  onRename,
  onClose,
  onPrev,
  onNext,
  nextOf,
}: {
  url: string;
  name: string;
  pos: string;
  /** 보관함 기준 경로 — 설정 불러오기가 이걸로 메타데이터를 읽는다 */
  file: string;
  seed?: number;
  /** 이름 변경 (v2 `PATCH /api/gallery/{filename}`) */
  onRename: (name: string) => Promise<string>;
  onClose: () => void;
  onPrev?: () => void;
  onNext?: () => void;
  /** 이 그림을 지우면 어디로 갈까 (없으면 닫는다) */
  nextOf?: (file: string) => string | null;
}) {
  const t = useI18n((s) => s.t);
  const box = useRef<HTMLDivElement>(null);
  const img = useRef<HTMLImageElement>(null);
  const [dims, setDims] = useState<{ w: number; h: number } | null>(null);
  /** 보관함 그림의 메타데이터 — 「프롬프트 보기」와 「새 탭으로 복제」가 같은 것을 쓴다 */
  const loadMeta = async () =>
    (await api<{ meta: ImageMeta | null }>(`/api/keep/meta?file=${encodeURIComponent(file)}`)).meta;
  /** ★★**설정이 없는 그림은 복제를 안 낸다** (사용자 지시 2026-08-25: *"갤러리에 메타데이터
   *  없는 이미지는 새 탭으로 복제 비활성화"*). 예전에는 단추가 그대로 있고 눌러도 아무 일이
   *  없었다 — 눌러야 실패하는 단추를 두지 않는다는 규칙과 같은 자리다.
   *  ★그래서 **열 때 한 번 읽어 둔다.** 누른 뒤에 읽으면 그때는 이미 늦다. */
  const [meta, setMeta] = useState<ImageMeta | null>(null);
  useEffect(() => {
    let alive = true;
    setMeta(null);
    void loadMeta()
      .then((m) => alive && setMeta(m))
      .catch(() => {});
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file]);
  /** 크게 보다가 지운다 — ★한 번 묻고, 지운 뒤에는 닫는다 (없어진 그림을 띄워 둘 수 없다) */
  const onDelete = async () => {
    if (
      !(await ask({
        title: t("gallery.removeConfirm", { n: 1 }),
        ok: t("common.delete"),
        cancel: t("common.cancel"),
        danger: true,
      }))
    )
      return;
    // ★넘어갈 자리를 **먼저** 잡는다 (`nextOf` 의 ★★주)
    const next = nextOf?.(file) ?? null;
    await useGallery.getState().remove(useWs.getState().current, [file]);
    if (next) await useGallery.getState().setFocus(useWs.getState().current, next);
    else onClose();   // 마지막 한 장이었다 — 볼 것이 없으면 닫는다
  };

  /** 이름 고치기 — ★규칙은 **앱에 하나**다 (`useRename`): 단추를 다시 누르면 저장하고 끝.
   *  ★예전에는 여기만 손으로 만들었고, Esc 로 물린 직후의 `blur` 가 옛 값으로 이름을
   *    되돌리는 것을 `ref` 로 막고 있었다. 훅에서는 `Esc` 가 입력칸을 **접어 버리므로**
   *    (언마운트에는 `blur` 이 오지 않는다) 그 장치가 필요 없다. */
  const rename = useRename(name, (v) => void save(v));
  const save = async (next: string) => {
    if (next === name) return;
    try {
      await onRename(next);
      toast(t("gallery.renamed"));
    } catch (e) {
      toast(String(e), "warn");
    }
  };
  return (
    <div
      ref={box}
      data-gallery-big
      /* ★★그림 **옆의 빈 자리**를 눌러도 닫힌다 (사용자 지시 2026-08-29). 그림은 `object-fit:
         contain` 이라 요소 상자가 그려진 그림보다 크다 — 상자 안이지만 그림 밖인 자리를
         눌렀을 때 닫히지 않았다 (예전에는 뿌리를 직접 눌렀을 때만 닫혔다). 그려진 영역을
         계산해 그 밖이면 닫는다. 단추 줄은 전파를 끊으므로 여기까지 안 온다. */
      onClick={(e) => {
        const im = img.current;
        if (im && e.target === im && dims) {
          const r = im.getBoundingClientRect();
          const k = Math.min(r.width / dims.w, r.height / dims.h);
          const w = dims.w * k;
          const h = dims.h * k;
          const x0 = r.left + (r.width - w) / 2;
          const y0 = r.top + (r.height - h) / 2;
          if (e.clientX >= x0 && e.clientX <= x0 + w && e.clientY >= y0 && e.clientY <= y0 + h) return;
        }
        onClose();
      }}
      // ★휠로 앞뒤 그림 (v2 갤러리의 휠 네비게이션)
      onWheel={(e) => (e.deltaY > 0 ? onNext?.() : onPrev?.())}
      style={{
        position: "absolute",
        inset: 0,
        zIndex: 40,
        background: "rgba(8,10,14,0.88)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "var(--sp-5)",
      }}
    >
      <div
        style={{
          maxWidth: "100%",
          maxHeight: "100%",
          minHeight: 0,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: "var(--sp-3)",
        }}
      >
        <img
          ref={img}
          src={url}
          alt=""
          onLoad={(e) => setDims({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
          style={{ minHeight: 0, maxWidth: "100%", objectFit: "contain" }}
        />
        {/* ★배경(닫기 판정)을 뚫지 않도록 클릭을 여기서 멈춘다 */}
        <div onClick={(e) => e.stopPropagation()}>
          <ImageActions
            url={url}
            name={name}
            seed={seed}
            dims={dims}
            loadMeta={loadMeta}
            /* ★보관함 그림에는 워크스페이스 파일이 없다 — 그림에 남은 설정으로 새 탭을 만든다 */
            hideSettings
            /* ★설정이 없는 그림에는 **아예 안 낸다** (위 `meta` 의 ★★주) */
            onClone={
              hasMeta(meta)
                ? async () => {
                    const m = await loadMeta();
                    if (m) await cloneMetaToNewTab(m, file);
                  }
                : undefined
            }
            /* ★★**지우는 단추가 여기 있어야 한다** (사용자 지시 2026-08-25: *"갤러리 이미지
                 보는 곳에 삭제 버튼이 없음"*). 그리드에서는 골라서 지우지만, 크게 보다가
                 「이건 아니다」 하는 자리가 바로 여기다 — 닫고 다시 골라야 했다.
               ★지운 뒤에는 **닫는다.** 없어진 그림을 계속 띄워 둘 수 없다. */
            extra={
              <button
                data-gallery-big-del
                onClick={() => void onDelete()}
                data-tip={t("gallery.remove")}
                style={{ ...iconBtn, color: "var(--err-ink)" }}
              >
                {Icon.trash}
              </button>
            }
            /* ★같은 줄에 「탐색기에서 열기」를 둔다 — 뿌리만 보관함으로 갈아 끼운다.
               자리마다 다른 버튼을 만들면 어디서는 되고 어디서는 안 되는 상태가 생긴다. */
            revealPath={file}
            revealApi="/api/keep/reveal"
            onLeave={onClose}
          />
        </div>
      </div>

      {/* ★탐색기로 여는 길은 **아래 액션 줄**에 있다 (`revealApi`) — 여기 또 두지 않는다 */}
      <button onClick={onClose} style={{ ...overlayBtn, position: "absolute", left: "var(--sp-4)", top: "var(--sp-4)" }}>
        {t("gallery.close")}
      </button>
      {/* ★별표 버튼은 **칸 우상단**에 있다 (사용자 지시 2026-08-05). 큰 그림 위에 두면
          지금 보는 한 장만 켤 수 있어, 견주며 고르는 흐름과 어긋난다. S 키는 그대로 둔다. */}
      {/* ★파일 이름·조작 안내는 **위로** 올렸다 — 아래는 액션 줄이 쓴다.
          바닥에 겹쳐 두면 시드·프롬프트 버튼이 배지 뒤로 숨는다 (실측 2026-08-05). */}
      {/* ★이름은 **더블클릭으로 그 자리 편집**이다 (앱 공통 규칙). 클릭 한 번은 배경 클릭과
          겹치므로 쓰지 않는다. Enter 로 확정, Esc 로 되돌린다. */}
      {!rename.editing ? (
        <span
          data-keep-name
          onDoubleClick={(e) => {
            e.stopPropagation();
            rename.toggle();
          }}
          style={nameBadge}
        >
          {name} {pos && `· ${pos}`}
        </span>
      ) : (
        <input
          data-keep-rename
          {...rename.inputProps}
          // ★키 입력이 큰 그림의 단축키(휠·화살표·S)로 새지 않게 — 여기만의 사정이다
          onKeyDown={(e) => {
            rename.inputProps.onKeyDown(e);
            e.stopPropagation();
          }}
          style={{ ...nameBadge, border: "1px solid var(--accent)", background: "rgba(10,14,20,0.92)", width: 260 }}
        />
      )}
      <span
        style={{
          position: "absolute",
          right: "var(--sp-5)",
          bottom: "var(--sp-2)",
          fontSize: "var(--text-2xs)",
          color: "rgba(255,255,255,0.35)",
        }}
      >
        {t("gallery.keyHint")}
      </span>
    </div>
  );
}

const nameBadge: React.CSSProperties = {
  position: "absolute",
  left: "50%",
  transform: "translateX(-50%)",
  top: "var(--sp-4)",
  padding: "2px var(--sp-3)",
  borderRadius: "var(--r-1)",
  background: "rgba(10,14,20,0.62)",
  color: "#fff",
  fontSize: "var(--text-2xs)",
  fontFamily: "var(--font-mono)",
  maxWidth: "46%",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

const overlayBtn: React.CSSProperties = {
  padding: "3px var(--sp-3)",
  borderRadius: "var(--r-1)",
  background: "rgba(10,14,20,0.55)",
  border: "1px solid rgba(255,255,255,0.12)",
  color: "rgba(255,255,255,0.8)",
  fontSize: "var(--text-2xs)",
};
