import { useEffect, useState } from "react";
import { useI18n } from "../../i18n";
import { api } from "../../lib/backend";
import { useImageDrop, type Dropped } from "../../lib/dropImages";
import { ask } from "../../store/ask";
import { toast } from "../../store/toast";
import { Icon } from "../../components/Icon";
import { useUi } from "../../store/ui";
import { taggerPct, useTagger } from "../../store/tagger";

/** Tagger — **아무 그림에서나 재현 태그를 뽑는다** (WD eva02, 사용자 지시 2026-08-29:
 *  *"보조도구에 넣고 아무 이미지나 태거 돌리게"*).
 *
 *  용도는 *"1girl 만 넣고 나온 캐릭터를 재현할 태그"* 다 — 그러니 워크스페이스 안일 필요가
 *  없고, EXIF 리더처럼 **밖에서 떨군 그림**을 받는다. 생성·갤러리의 「Tagger로 보내기」는
 *  그 그림(들)을 여기로 싣고 온다 (`sendToTagger`).
 *
 *  ★읽기만 한다. 저장하지도, 프롬프트에 넣지도 않는다 — 복사해 가는 것이 전부다.
 *  ★★**결과는 블록으로 아래에 쌓인다** (사용자 지시 2026-08-29: *"여러 이미지에도 대응하게,
 *    연속으로 여러 개 넣어도 되고, 개별로 지울 수 있게"*). 한 번에 여러 장을 떨구면 차례로
 *    돌려 하나씩 붙는다 (서버 추론은 한 번에 하나다 — `tagger._lock`).
 *  ★★**일치율은 옆판**이다 (사용자 지시 2026-08-29): 블록의 단추를 누르면 기둥이 왼쪽으로
 *    조금 밀리고 오른쪽에 그 블록의 태그 전부가 높은 순으로 선다. 다른 블록의 단추를
 *    누르면 즉시 바뀐다. 블록 안에 숫자를 섞지 않는다 — 복사해 갈 문자열이 지저분해진다.
 *  ★모델(1.26GB)은 동봉하지 않는다 — 탭에 들어오면 상태를 보여 주고, 없으면 내려받기 단추를
 *    상자 안에 둔다. 내려받는 동안 붙들지 않는다: 시작만 알리고 놓아 준다.
 */
type TagResult = {
  tags: { tag: string; score: number; character: boolean }[];
  caption: string;
  preview: string;
};
type Block = { id: number; name: string; result: TagResult };

/** ★★**결과는 탭을 옮겨도 남는다** — `Tools` 는 안 보이는 탭을 언마운트하므로 (EXIF 리더와
 *  같은 까닭) 모듈에 든다. 앱을 껐다 켜면 비는 것이 맞다. */
let kept: Block[] = [];
let seq = 0;

/** 다른 화면에서 **실어 보낸 그림들** — 마운트되면 곧장 돌린다.
 *  ★보내는 자리(생성·갤러리)에서는 이 탭이 언마운트 상태라, 값을 두고 모드를 옮기면
 *  새로 마운트되면서 집어 간다. */
let pending: Dropped[] = [];

export function sendToTagger(items: Dropped[]) {
  pending = items;
  useUi.getState().setMode("utility");
  useUi.getState().setView("tab", "tools", "tagger" as never);
}

export function TaggerTool() {
  const t = useI18n((s) => s.t);
  const [blocks, setBlocks] = useState<Block[]>(kept);
  /** 아직 돌릴 장 수 — 0 이면 놀고 있다 */
  const [left, setLeft] = useState(0);
  /** 일치율 옆판이 보고 있는 블록 */
  const [detail, setDetail] = useState<number | null>(null);
  useEffect(() => {
    kept = blocks;
  }, [blocks]);

  /** 모델 상태 — **앱 전역**(`store/tagger`)이다. 여기서는 읽고, 시작·취소를 부를 뿐이다.
   *  ★폴링·완료 토스트는 스토어가 한다 — 이 탭을 떠나 있어도 알림이 온다 (사용자 지적
   *    2026-08-29: 다 받았는데 토스트가 안 떴다 — 컴포넌트가 들고 있어서 탭을 떠나면 죽었다). */
  const st = useTagger((s) => s.st);
  const { refresh, start: startDownload, cancel: cancelDownload } = useTagger.getState();
  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const downloading = !!st?.downloading;

  /** 떨군 그림들을 **차례로** 돌려 블록으로 붙인다. 돌고 있는 중에 더 떨구면 뒤에 잇는다. */
  const run = async (items: Dropped[]) => {
    // ★받는 중에는 **아무것도 안 받는다** (사용자 지시 2026-08-29) — 상자도 창 전체도
    if (!items.length || downloading) return;
    const cur = await refresh();
    if (!cur) return;
    if (cur.error) return void toast(cur.error, "warn");
    if (!cur.ready) {
      if (cur.downloading)
        return void toast(
          t("tagger.downloading", {
            pct: Math.round((cur.got / cur.total) * 100),
          }),
        );
      if (
        await ask({
          title: t("tagger.dlTitle"),
          body: t("tagger.dlBody"),
          ok: t("tagger.dlOk"),
          cancel: t("common.cancel"),
        })
      )
        await startDownload().catch((e) => toast(String(e), "warn"));
      return;
    }
    setLeft((n) => n + items.length);
    for (const it of items) {
      try {
        const r = await api<TagResult>("/api/tagger/run", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(it),
        });
        setBlocks((b) => [...b, { id: ++seq, name: it.name, result: r }]);
      } catch (e) {
        toast(`${it.name}: ${String(e)}`, "warn");
      } finally {
        setLeft((n) => n - 1);
      }
    }
  };

  // 실어 보낸 그림들을 집어 간다 (한 번만)
  useEffect(() => {
    if (!pending.length) return;
    const items = pending;
    pending = [];
    void run(items);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** 창 어디에 떨궈도 받는다 (EXIF 리더와 같다). */
  const { zone, over, pick } = useImageDrop(run, true);
  const remove = (id: number) => {
    setBlocks((b) => b.filter((x) => x.id !== id));
    if (detail === id) setDetail(null);
  };
  const busy = left > 0;
  const empty = blocks.length === 0;
  const shown =
    detail === null ? null : (blocks.find((b) => b.id === detail) ?? null);

  return (
    /* ★★**가운데 기둥**으로 모은다 (사용자 지시 2026-08-29: *"필요한 UI 는 적은데 화면 전체를
       쓰고 있어서 가독성이 안 좋다. 중앙부 위주로"*). EXIF 리더는 두 열을 펼치느라 판 전체가
       필요하지만, 여기는 태그 두 절이 전부다 — 넓게 펴면 한 줄이 길어져 오히려 읽기 힘들다.
       ★그래도 **창 어디에 떨궈도 받는다** (`useImageDrop(run, true)`) — 기둥은 보이는 폭이지
       받는 폭이 아니다.
       ★옆판이 열려도 **기둥은 제자리**다 (사용자 지시 2026-08-29: 가운데는 고정, 우측에 열기).
         옆판은 기둥의 오른쪽 옆에 절대 배치한다 — 처음에는 둘을 함께 가운데 맞춰 기둥이
         왼쪽으로 밀렸는데, 단추를 누를 때마다 읽던 자리가 움직였다. */
    <div
      style={{
        flex: 1,
        minHeight: 0,
        display: "flex",
        justifyContent: "center",
        position: "relative",
      }}
    >
      <div
        style={{
          width: COL,
          maxWidth: "100%",
          minHeight: 0,
          overflowY: "auto",
          display: "flex",
          flexDirection: "column",
          alignItems: "stretch",
          justifyContent: empty ? "center" : "flex-start",
          paddingTop: empty ? 0 : "var(--sp-4)",
          paddingBottom: "var(--sp-6)",
          gap: "var(--sp-4)",
        }}
      >
        {/* 받는 상자 — 비었을 때는 가운데에 크게, 블록이 있으면 위에 낮게 (그 아래로 쌓인다) */}
        <div
          {...(downloading ? {} : zone)}
          data-tagger-drop
          data-disabled={downloading || undefined}
          /* ★모델이 없으면 상자 클릭이 곧 **내려받기**다 (사용자 지시 2026-08-29) — 파일 선택창을
             띄워 봐야 받을 수 없으니, 단추가 아니라 상자 어디를 눌러도 내려받기로 간다 */
          onClick={
            downloading
              ? undefined
              : st && !st.ready && !st.error
                ? () => void startDownload().catch((err) => toast(String(err), "warn"))
                : () => void pick()
          }
          style={{
            height: empty ? 220 : 88,
            flexShrink: 0,
            border: `1px dashed ${over && !downloading ? "var(--accent)" : "var(--line)"}`,
            background: over && !downloading ? "var(--accent-bg)" : "var(--bg)",
            borderRadius: "var(--r-3)",
            display: "grid",
            placeItems: "center",
            cursor: downloading ? "default" : "pointer",
          }}
        >
          <span
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: 4,
            }}
          >
            {empty && (
              <span
                style={{
                  color: over ? "var(--accent-ink)" : "var(--ink-ghost)",
                  display: "grid",
                }}
              >
                {Icon.tagger}
              </span>
            )}
            {st && !st.ready && !st.error && (
              /* ★무엇을 하는 기능인지 한 줄 (사용자 지시 2026-08-29: 내려받기 전에 설명) */
              <span
                data-tagger-about
                style={{ fontSize: "var(--text-sm)", color: "var(--ink-soft)", textAlign: "center" }}
              >
                {t("tagger.about")}
              </span>
            )}
            {st && !st.ready && !st.error ? (
              /* 모델이 없다 — 떨구기 전에 무엇을 해야 하는지 상자 안에서 보여 준다 */
              st.downloading ? (
                <span
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: "var(--sp-3)",
                    marginTop: 4,
                  }}
                >
                  {/* % 와 막대 (사용자 지시 2026-08-29) — 타이틀바 띠와 같은 값을 그린다 */}
                  <span style={{ width: 160, height: 4, borderRadius: 2, background: "var(--line)", overflow: "hidden" }}>
                    <span
                      data-tagger-dl-bar
                      style={{ display: "block", width: `${taggerPct(st)}%`, height: "100%", background: "var(--accent)", transition: "width 0.2s" }}
                    />
                  </span>
                  <span
                    data-tagger-dl-progress
                    style={{
                      fontSize: "var(--text-2xs)",
                      color: "var(--ink-dim)",
                    }}
                  >
                    {t("tagger.dlProgress", { pct: taggerPct(st) })}
                  </span>
                  <button
                    data-tagger-dl-cancel
                    onClick={(e) => {
                      e.stopPropagation();
                      void cancelDownload().catch((err) => toast(String(err), "warn"));
                    }}
                    style={hbtn}
                  >
                    {t("tagger.dlCancel")}
                  </button>
                </span>
              ) : (
                <button
                  data-tagger-dl
                  onClick={(e) => {
                    e.stopPropagation();
                    void startDownload().catch((err) =>
                      toast(String(err), "warn"),
                    );
                  }}
                  style={{ ...hbtn, marginTop: 4 }}
                >
                  {t("tagger.dlButton")}
                </button>
              )
            ) : (
              <>
                <span
                  style={{
                    fontSize: "var(--text-sm)",
                    color: st?.error
                      ? "var(--warn)"
                      : over
                        ? "var(--accent-ink)"
                        : "var(--ink-soft)",
                  }}
                >
                  {busy
                    ? t("tagger.running")
                    : st?.error
                      ? st.error
                      : t("tools.taggerDrop")}
                </span>
                {!busy && !st?.error && (
                  <span
                    style={{
                      fontSize: "var(--text-2xs)",
                      color: "var(--ink-faint)",
                    }}
                  >
                    {t("tools.dropHint")}
                  </span>
                )}
              </>
            )}
          </span>
        </div>

        {blocks.map((b) => (
          <TagBlock
            key={b.id}
            block={b}
            open={detail === b.id}
            onScores={() => setDetail(detail === b.id ? null : b.id)}
            onRemove={() => remove(b.id)}
          />
        ))}
      </div>

      {shown && <ScorePane block={shown} onClose={() => setDetail(null)} />}
    </div>
  );
}

/** 그림 한 장의 결과 — 머리(미리보기·이름·부제·복사·일치율·삭제) + 태그 두 절.
 *  ★복사는 **여기 하나**다 (사용자 지적 2026-08-29: 줄마다 있던 것과 겹쳤다). 캐릭터·일반을
 *    합친 전체(`caption`)를 복사한다 — 용도가 "그 모습을 재현할 태그"라 전부가 필요하다. */
function TagBlock({
  block,
  open,
  onScores,
  onRemove,
}: {
  block: Block;
  open: boolean;
  onScores: () => void;
  onRemove: () => void;
}) {
  const t = useI18n((s) => s.t);
  const { name, result } = block;
  const chars = result.tags.filter((x) => x.character).map((x) => x.tag);
  const rows: { label: string; text: string; accent?: string }[] = [
    ...(chars.length
      ? [
          {
            label: t("tagger.charTags"),
            text: chars.join(", "),
            accent: "var(--accent-ink)",
          },
        ]
      : []),
    {
      label: t("tagger.generalTags"),
      text: result.tags
        .filter((x) => !x.character)
        .map((x) => x.tag)
        .join(", "),
    },
  ];

  return (
    <div
      data-tagger-block
      data-open={open || undefined}
      style={{
        flexShrink: 0,
        display: "flex",
        flexDirection: "column",
        gap: "var(--sp-3)",
        border: `1px solid ${open ? "var(--accent)" : "var(--line)"}`,
        background: "var(--panel)",
        borderRadius: "var(--r-3)",
        padding: "var(--sp-3)",
      }}
    >
      <div
        style={{ display: "flex", alignItems: "center", gap: "var(--sp-3)" }}
      >
        {result.preview && (
          <img
            data-tagger-preview
            src={result.preview}
            alt=""
            style={{
              height: 72,
              borderRadius: "var(--r-2)",
              background: "var(--bg)",
            }}
          />
        )}
        <div
          style={{
            flex: 1,
            minWidth: 0,
            display: "flex",
            flexDirection: "column",
            gap: 3,
          }}
        >
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
          {/* ★무엇인지 한 줄로 밝힌다 (사용자 지시 2026-08-29: "이미지에서 자동 추출했다고") */}
          <span
            style={{ fontSize: "var(--text-2xs)", color: "var(--ink-dim)" }}
          >
            {t("tagger.subtitle")}
          </span>
        </div>
        <button
          data-tagger-copy
          disabled={!result.caption}
          onClick={() =>
            void navigator.clipboard
              ?.writeText(result.caption)
              .then(() => toast(t("act.copied")))
          }
          style={hbtn}
        >
          {Icon.copy}
          {t("act.copy")}
        </button>
        <button
          data-tagger-scores
          onClick={onScores}
          style={{
            ...hbtn,
            color: open ? "var(--accent-ink)" : hbtn.color,
            borderColor: open ? "var(--accent)" : "var(--line)",
          }}
        >
          {Icon.list}
          {t("tagger.scores")}
        </button>
        <button data-tagger-remove onClick={onRemove} style={hbtn}>
          {Icon.close12}
          {t("common.delete")}
        </button>
      </div>

      {rows.map((r, i) => (
        <div key={i}>
          <div
            style={{
              fontSize: "var(--text-2xs)",
              color: r.accent ?? "var(--ink-dim)",
            }}
          >
            {r.label}
          </div>
          <pre
            style={{
              margin: "2px 0 0",
              padding: "var(--sp-2)",
              background: "var(--code-bg)",
              borderRadius: "var(--r-1)",
              fontFamily: "var(--font-mono)",
              fontSize: "var(--text-2xs)",
              lineHeight: 1.5,
              whiteSpace: "pre-wrap",
              wordBreak: "break-all",
              color: "var(--ink-soft)",
            }}
          >
            {r.text || t("prompt.empty")}
          </pre>
        </div>
      ))}
    </div>
  );
}

/** 일치율 옆판 — 한 블록의 태그 전부를 **높은 순**으로 (서버가 이미 그 순서로 준다).
 *  캐릭터·작품 태그는 강조색이다. 기둥과 따로 스크롤한다. */
function ScorePane({ block, onClose }: { block: Block; onClose: () => void }) {
  const t = useI18n((s) => s.t);
  return (
    <div
      data-tagger-scores-pane
      style={{
        position: "absolute",
        left: `calc(50% + ${COL / 2}px + var(--sp-4))`,
        top: "var(--sp-4)",
        bottom: "var(--sp-6)",
        width: PANE,
        display: "flex",
        flexDirection: "column",
        border: "1px solid var(--line)",
        background: "var(--panel)",
        borderRadius: "var(--r-3)",
        overflow: "hidden",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "var(--sp-2)",
          padding: "var(--sp-2) var(--sp-3)",
          borderBottom: "1px solid var(--line)",
          flexShrink: 0,
        }}
      >
        <span style={{ fontSize: "var(--text-2xs)", color: "var(--ink-dim)" }}>
          {t("tagger.scores")}
        </span>
        <span
          style={{
            flex: 1,
            minWidth: 0,
            fontSize: "var(--text-xs)",
            color: "var(--ink)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {block.name}
        </span>
        <button
          data-tagger-scores-close
          onClick={onClose}
          style={{
            display: "grid",
            placeItems: "center",
            color: "var(--ink-faint)",
          }}
        >
          {Icon.close12}
        </button>
      </div>
      <div
        style={{ minHeight: 0, overflowY: "auto", padding: "var(--sp-1) 0" }}
      >
        {block.result.tags.map((x) => (
          <div
            key={x.tag}
            data-tagger-score-row
            style={{
              display: "flex",
              alignItems: "baseline",
              gap: "var(--sp-2)",
              padding: "2px var(--sp-3)",
              fontSize: "var(--text-2xs)",
            }}
          >
            <span
              style={{
                flex: 1,
                minWidth: 0,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
                color: x.character ? "var(--accent-ink)" : "var(--ink-soft)",
              }}
            >
              {x.tag}
            </span>
            <span
              style={{
                fontFamily: "var(--font-mono)",
                color: "var(--ink-dim)",
                flexShrink: 0,
              }}
            >
              {Math.round(x.score * 100)}%
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

/** 기둥 폭 — 프롬프트 보기 모달(560px)과 같다 */
const COL = 560;
/** 일치율 옆판 폭 */
const PANE = 260;

/** EXIF 리더의 머리 단추와 같은 꼴 */
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
