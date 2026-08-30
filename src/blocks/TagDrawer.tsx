import { useEffect, useMemo, useState } from "react";
import { useI18n } from "../i18n";
import { Icon } from "../components/Icon";
import { fileMgrImg, fileMgrThumb } from "../lib/imgUrl";
import { loadTags } from "../lib/tagData";
import { filterTags } from "../lib/tagSearch";
import { useBlockLib } from "../store/blockLib";
import { useGen } from "../store/gen";
import { useTagSearch } from "../store/tagsearch";

/** 태그 검색 서랍 — 블록 저장소와 **같은 자리**(좌측 프롬프트 패널 옆)에 열린다 (사용자 지시 2026-08-31).
 *
 *  용도: 작가 태그를 섞어 쓰다 보면 어느 작가가 어느 그림체였는지 잊는다. 여기서 태그를 눌러
 *  그 태그가 쓰인 **내 그림**을 보고, `+` 로 베이스 맨 아래에 바로 넣는다 — 갤러리 탭으로
 *  옮겨 갔다 돌아와 치는 일이 없다 (사용자 지적: *"생성 모드에서 볼 수 있지 않으면 쓰기 애매"*).
 *  ★독립 기능이다 — 이 파일·`store/tagsearch.ts`·`lib/tagSearch.ts`·`backend/tagindex.py` 와
 *    단추 하나(`PromptPanel`)·마운트 한 줄(`App`)이 전부라 들어내기 쉽다. */
const SHOW_TAGS = 200;
const SHOW_STEP = 60;

export function TagDrawer() {
  const t = useI18n((s) => s.t);
  const base = useGen((s) => s.base);
  const { open, loaded, busy, status, tags, query, artistOnly, pick, view, setOpen, setQuery, setArtistOnly, setPick, setView, add, rebuild } =
    useTagSearch();
  const libOpen = useBlockLib((s) => s.open);
  const [shown, setShown] = useState(SHOW_STEP);

  // 작가 판별에 사전이 필요하다 — 한 번만 읽는다
  useEffect(() => {
    if (open) void loadTags();
  }, [open]);
  // ★같은 자리다 — 저장소가 열리면 이쪽은 닫힌다 (반대쪽은 `setOpen` 이 한다)
  useEffect(() => {
    if (libOpen && open) setOpen(false);
  }, [libOpen, open, setOpen]);
  useEffect(() => setShown(SHOW_STEP), [pick]);
  // 크게 보기는 Esc 로 닫는다
  useEffect(() => {
    if (!view) return;
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") setView(null);
    };
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  }, [view, setView]);

  const hits = useMemo(() => filterTags(tags, query, artistOnly), [tags, query, artistOnly]);
  const picked = pick ? tags.get(pick) : undefined;
  const files = useTagSearch((s) => s.files);

  if (!open) return null;

  return (
    <div
      data-tag-drawer
      style={{
        width: 240,
        flexShrink: 0,
        display: "flex",
        flexDirection: "column",
        background: "var(--bg)",
        borderRight: "1px solid var(--line)",
      }}
    >
      <div
        style={{
          height: 32,
          flexShrink: 0,
          display: "flex",
          alignItems: "center",
          gap: "var(--sp-2)",
          padding: "0 var(--sp-2) 0 var(--sp-3)",
          borderBottom: "1px solid var(--line)",
        }}
      >
        <b style={{ fontSize: "var(--text-xs)", color: "var(--ink-soft)", whiteSpace: "nowrap" }}>{t("tagsearch.title")}</b>
        <span style={{ flex: 1 }} />
        <button
          data-tag-refresh
          disabled={busy}
          onClick={() => void rebuild()}
          data-tip={t("tagsearch.refresh")}
          style={{ color: busy ? "var(--ink-faint)" : "var(--ink-dim)", display: "grid" }}
        >
          {Icon.refresh12}
        </button>
        <button data-tag-drawer-close onClick={() => setOpen(false)} data-tip={t("tagsearch.close")} style={{ color: "var(--ink-faint)", display: "grid" }}>
          {Icon.close12}
        </button>
      </div>

      {status?.running && (
        <div data-tag-indexing style={{ padding: "var(--sp-2) var(--sp-3) 0", fontSize: "var(--text-2xs)", color: "var(--ink-dim)" }}>
          {t("tagsearch.indexing", { done: status.done, total: status.total })}
          <div style={{ height: 3, marginTop: 3, background: "var(--surface2)", borderRadius: 2, overflow: "hidden" }}>
            <div style={{ height: "100%", width: `${status.total ? (status.done / status.total) * 100 : 0}%`, background: "var(--accent)" }} />
          </div>
        </div>
      )}
      {status?.error && (
        <div style={{ padding: "var(--sp-2) var(--sp-3) 0", fontSize: "var(--text-2xs)", color: "var(--err-ink)" }}>
          {t("tagsearch.error", { msg: status.error })}
        </div>
      )}

      <div style={{ padding: "var(--sp-2)", flexShrink: 0, display: "flex", gap: 4 }}>
        <input
          data-tag-search
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t("tagsearch.search")}
          style={{
            flex: 1,
            minWidth: 0,
            background: "var(--surface2)",
            border: "1px solid var(--line)",
            borderRadius: "var(--r-1)",
            padding: "3px var(--sp-2)",
            fontSize: "var(--text-2xs)",
          }}
        />
        <button
          data-tag-artist-only
          data-on={artistOnly ? "" : undefined}
          onClick={() => setArtistOnly(!artistOnly)}
          style={{
            padding: "0 var(--sp-2)",
            fontSize: "var(--text-2xs)",
            borderRadius: "var(--r-1)",
            border: `1px solid ${artistOnly ? "var(--accent)" : "var(--line)"}`,
            color: artistOnly ? "var(--accent-ink)" : "var(--ink-dim)",
            background: artistOnly ? "var(--accent-bg)" : "transparent",
            whiteSpace: "nowrap",
          }}
        >
          {t("tagsearch.artistOnly")}
        </button>
      </div>

      {/* 태그 목록 — 많이 쓴 순 */}
      <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "0 var(--sp-2)" }}>
        {loaded && !hits.length && (
          <div style={{ padding: "var(--sp-3) 2px", fontSize: "var(--text-2xs)", color: "var(--ink-faint)", lineHeight: 1.6 }}>
            {tags.size ? t("tagsearch.noHit") : t("tagsearch.empty")}
          </div>
        )}
        {hits.slice(0, SHOW_TAGS).map((h) => {
          const on = pick === h.t.toLowerCase().replace(/_/g, " ").trim();
          return (
            <div
              key={h.t}
              data-tag-row={h.t}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 4,
                padding: "2px 2px 2px 4px",
                borderRadius: "var(--r-1)",
                fontSize: "var(--text-2xs)",
                background: on ? "var(--accent-bg)" : "transparent",
              }}
            >
              <span
                onClick={() => setPick(on ? null : h.t.toLowerCase().replace(/_/g, " ").trim())}
                data-tip={t("tagsearch.pickHint")}
                style={{
                  flex: 1,
                  minWidth: 0,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                  cursor: "pointer",
                  color: on ? "var(--accent-ink)" : "var(--ink)",
                }}
              >
                {h.t}
              </span>
              <span style={{ color: "var(--ink-faint)" }}>{h.files.length}</span>
              <button data-tag-add={h.t} onClick={() => add(h.t)} data-tip={t("tagsearch.add")} style={{ color: "var(--ink-dim)", display: "grid" }}>
                {Icon.plus}
              </button>
            </div>
          );
        })}
        {hits.length > SHOW_TAGS && (
          <div style={{ padding: "var(--sp-2) 2px", fontSize: "var(--text-2xs)", color: "var(--ink-faint)" }}>
            {t("tagsearch.more", { n: hits.length - SHOW_TAGS })}
          </div>
        )}
      </div>

      {/* 고른 태그의 그림 — 최신순 격자 */}
      <div
        data-tag-grid
        style={{
          flex: 1,
          minHeight: 0,
          overflowY: "auto",
          borderTop: "1px solid var(--line)",
          padding: "var(--sp-2)",
        }}
      >
        {!picked ? (
          <div style={{ fontSize: "var(--text-2xs)", color: "var(--ink-faint)", lineHeight: 1.6 }}>{t("tagsearch.noPick")}</div>
        ) : (
          <>
            <div style={{ fontSize: "var(--text-2xs)", color: "var(--ink-dim)", marginBottom: "var(--sp-2)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {t("tagsearch.picked", { tag: picked.t, n: picked.files.length })}
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 4 }}>
              {picked.files.slice(0, shown).map((rel) => (
                <img
                  key={rel}
                  data-tag-thumb={rel}
                  src={fileMgrThumb(base, rel)}
                  alt=""
                  loading="lazy"
                  onClick={() => setView(rel)}
                  title={rel}
                  style={{ width: "100%", aspectRatio: "1", objectFit: "cover", borderRadius: "var(--r-1)", cursor: "zoom-in", background: "var(--surface2)" }}
                />
              ))}
            </div>
            {picked.files.length > shown && (
              <button
                data-tag-more
                onClick={() => setShown((n) => n + SHOW_STEP)}
                style={{ marginTop: "var(--sp-2)", width: "100%", fontSize: "var(--text-2xs)", color: "var(--accent-ink)", padding: "3px 0" }}
              >
                {t("tagsearch.showMore")}
              </button>
            )}
          </>
        )}
      </div>

      {/* 크게 보기 — 그림과 그 프롬프트 원문. 밖을 누르거나 Esc 로 닫는다 */}
      {view && (
        <div
          data-tag-view
          onClick={() => setView(null)}
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 9000,
            background: "rgba(0,0,0,0.72)",
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            gap: "var(--sp-3)",
            padding: "var(--sp-5)",
            cursor: "zoom-out",
          }}
        >
          <img src={fileMgrImg(base, view)} alt="" style={{ maxWidth: "90vw", maxHeight: "70vh", objectFit: "contain", borderRadius: "var(--r-2)" }} />
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              maxWidth: "90vw",
              maxHeight: "20vh",
              overflowY: "auto",
              background: "var(--panel)",
              color: "var(--ink)",
              border: "1px solid var(--line-strong)",
              borderRadius: "var(--r-2)",
              padding: "var(--sp-2) var(--sp-3)",
              fontSize: "var(--text-2xs)",
              lineHeight: 1.5,
              whiteSpace: "pre-wrap",
              cursor: "auto",
              userSelect: "text",
            }}
          >
            <div style={{ color: "var(--ink-faint)", marginBottom: 2 }}>{view}</div>
            {(files[view]?.p ?? []).join("\n---\n")}
          </div>
        </div>
      )}
    </div>
  );
}

/** 서랍 열기 단추 — 프롬프트 라벨 줄, 블록 저장소 단추 옆 */
export function TagSearchButton() {
  const t = useI18n((s) => s.t);
  const open = useTagSearch((s) => s.open);
  const setOpen = useTagSearch((s) => s.setOpen);
  return (
    <button
      data-tag-search-toggle
      data-on={open ? "" : undefined}
      onClick={() => setOpen(!open)}
      data-tip={t("tagsearch.hint")}
      style={{ color: open ? "var(--accent-ink)" : "var(--ink-faint)", display: "grid", padding: "0 4px" }}
    >
      {Icon.search}
    </button>
  );
}
