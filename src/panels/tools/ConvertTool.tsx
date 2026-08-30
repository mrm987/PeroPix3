import { useEffect, useState } from "react";
import { create } from "zustand";
import { useI18n } from "../../i18n";
import { api } from "../../lib/backend";
import { useImageDrop, type Dropped } from "../../lib/dropImages";
import { useReorder } from "../../lib/useReorder";
import { useFiles } from "../../store/files";
import { useUi } from "../../store/ui";
import { toast } from "../../store/toast";
import { Icon } from "../../components/Icon";
import { Help } from "../../components/Tip";
import { DragGhost } from "../../cards/DragGhost";

/** 이름 변환 — **형식과 이름을 한 번에** 바꾼다 (v2 `보조 도구 › 이미지 변환`).
 *
 *  ★밖에서 떨군 그림도 받는다 (`useImageDrop`). 앱에서는 경로가 오고, 브라우저에서는
 *    바이트가 온다 — 부르는 쪽은 몰라도 되게 서버가 둘 다 받는다.
 *  ★**원본을 지우지 않는다.** 늘 새 파일을 만들고, 이름이 겹치면 번호를 붙인다.
 *  ★번호는 **목록 차례**를 따른다. 그래서 목록 순서를 바꿀 수 있어야 한다 —
 *    ↑↓ 단추와 **그립 드래그** 둘 다 둔다 (한 칸 옮기기와 멀리 옮기기는 다른 일이다).
 *  ★**한 장씩 보낸다** (v2 `runConversion` 과 같다). 한 번에 묶어 보내면 진행률을 알 수
 *    없고, 어느 장이 실패했는지도 끝나서야 안다. 번호는 `start + i` 를 그때그때 실어 보낸다.
 */
type Q = { items: Dropped[]; add: (x: Dropped[]) => void; clear: () => void };

/** 파일 관리에서 고른 것을 여기로 보내는 통로 — 창구를 둘로 만들지 않으려는 것 */
export const useConvertQueue = create<Q>((set, get) => ({
  items: [],
  add: (x) => set({ items: [...get().items, ...x] }),
  clear: () => set({ items: [] }),
}));

/** 목록에 보여 줄 것 — 서버가 준다 (`/api/tools/probe`). 앱에는 경로만 와서
 *  화면이 그 파일을 가리킬 주소가 없다. 키는 `name` 이 아니라 **차례**다 (같은 이름이 있다). */
type Probe = { name: string; bytes?: number; width?: number; height?: number; thumb?: string; error?: string };

/** 한 장의 결과 — 끝나면 그 줄에 그대로 남는다 (v2 `updateConvertFileListWithResults`) */
type Row = { saved?: string; error?: string };

export function ConvertTool() {
  const t = useI18n((s) => s.t);
  const { items, add } = useConvertQueue();
  /* ★★**마지막에 쓰던 설정으로 연다** (사용자 지시 2026-08-26). 열 때마다 기본값으로
     되돌아가면 같은 값을 매번 다시 맞춰야 한다 — 인핸스 창과 같은 사정이다
     (`useUi.enhanceLast`). 남는 것은 **설정뿐**이고, 목록·진행·결과는 그 판에서 끝난다.
     ★한 곳에서 든다 — 화면이 지역 상태로 또 들면 둘이 갈린다 (그 자리에서만 바뀐다). */
  const last = useUi((s) => s.convertLast);
  const put = useUi((s) => s.setConvertLast);
  const { fmt, strip, ren, prefix, start, pad, mode, dest } = last;
  const setFmt = (v: string) => put({ fmt: v });
  const setStrip = (v: boolean) => put({ strip: v });
  const setRen = (v: boolean) => put({ ren: v });
  const setPrefix = (v: string) => put({ prefix: v });
  const setStart = (v: number) => put({ start: v });
  const setPad = (v: number) => put({ pad: v });
  const setMode = (v: "overwrite" | "sub" | "folder") => put({ mode: v });
  const setDest = (v: string) => put({ dest: v });
  const [busy, setBusy] = useState(false);
  /** 몇 장까지 끝났나 — 진행바가 이것만 본다 (v2 `convertProgressText` 의 `n / total`) */
  const [done, setDone] = useState(0);
  const [rows, setRows] = useState<Row[]>([]);
  const [probes, setProbes] = useState<Probe[]>([]);
  const openAfter = useUi((s) => s.convertOpenFolder);
  const setOpenAfter = useUi((s) => s.setConvertOpenFolder);
  const { zone, over, pick } = useImageDrop(add);

  /** ★경로를 모르는 그림(브라우저 드롭)은 원본 자리를 알 수 없다 — 폴더를 골라야 한다 */
  const noHome = items.some((i) => !i.path && !i.rel);
  const needDest = mode === "folder" || noHome;

  /** 썸네일·크기는 **목록이 바뀔 때 한 번** 물어본다. 순서만 바꾼 것은 화면에서 같이 옮긴다 */
  useEffect(() => {
    let alive = true;
    if (!items.length) return setProbes([]);
    void api<{ items: Probe[] }>("/api/tools/probe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ items }),
    })
      .then((r) => alive && setProbes(r.items))
      .catch(() => alive && setProbes([]));
    return () => {
      alive = false;
    };
  }, [items]);

  const setItems = (next: Dropped[], nextProbes?: Probe[]) => {
    useConvertQueue.setState({ items: next });
    if (nextProbes) setProbes(nextProbes);
    setRows([]);
  };

  const drop = (i: number) =>
    setItems(items.filter((_, n) => n !== i), probes.filter((_, n) => n !== i));

  const swap = (i: number, j: number) => {
    if (j < 0 || j >= items.length) return;
    const next = [...items];
    const np = [...probes];
    [next[i], next[j]] = [next[j], next[i]];
    [np[i], np[j]] = [np[j], np[i]];
    setItems(next, np);
  };

  /** 그립 드래그 — `to` 는 **틈 번호**다 (0..n). `useReorder` 규약 그대로 */
  const move = (from: number, to: number) => {
    const at = to > from ? to - 1 : to;
    const next = [...items];
    const np = [...probes];
    const [it] = next.splice(from, 1);
    const [pb] = np.splice(from, 1);
    next.splice(at, 0, it);
    np.splice(at, 0, pb);
    setItems(next, np);
  };
  const { register, handleProps, dragIdx, overIdx, ghost } = useReorder(items.length, move);

  /** 윈도우 폴더 찾기 — ★취소하면 **아무것도 안 바꾼다** (빈 값으로 지우지 않는다) */
  const pickDest = async () => {
    const first = items.find((i) => i.path || i.rel);
    try {
      const r = await api<{ dir: string | null }>("/api/files/pick-dir", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // ★윈도우 경로는 `\` 로 갈린다 — 둘 다 봐야 파일 이름을 떼고 **폴더**가 남는다
        body: JSON.stringify({ start: first?.path ? first.path.replace(/[\\/][^\\/]*$/, "") : "" }),
      });
      if (r.dir) setDest(r.dir);
    } catch (e) {
      toast(String(e), "warn");
    }
  };

  const run = async () => {
    if (busy || !items.length) return;
    if (needDest && !dest) return toast(t("tools.needDest"), "warn");
    if (noHome && mode !== "folder") return toast(t("tools.needDest"), "warn");
    setBusy(true);
    setDone(0);
    setRows([]);
    const out: Row[] = [];
    try {
      for (let i = 0; i < items.length; i++) {
        // ★마지막 장에서만 폴더를 연다 — 장마다 열면 창이 쌓인다
        const last = i === items.length - 1;
        try {
          const r = await api<{ results: { saved?: string; error?: string; ok: boolean }[]; ok: number }>(
            "/api/tools/convert",
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                items: [items[i]],
                fmt,
                strip_metadata: strip,
                prefix: ren ? prefix : null,
                // ★번호는 화면이 정한다 — 한 장씩 보내므로 `start + i` 를 그때그때 싣는다
                start: start + i,
                pad,
                // ★`dest` 는 「저장 폴더 지정」에서만 뜻이 있다 — 다른 갈래에서 실어 보내면
                //   서버가 거절한다 (`backend/tools.convert`)
                dest: noHome || mode === "folder" ? dest : "",
                open_folder: openAfter && last,
                // ★자리를 모르는 그림이 섞여 있으면 폴더로 몰아 준다 (위 `noHome`)
                mode: noHome ? "folder" : mode,
              }),
            },
          );
          const one = r.results[0];
          out.push(one?.ok ? { saved: one.saved } : { error: one?.error || "" });
        } catch (e) {
          out.push({ error: String(e) });
        }
        setDone(i + 1);
        setRows([...out]);
      }
      const ok = out.filter((r) => !r.error).length;
      toast(t("tools.converted", { n: ok, f: out.length - ok }), ok === out.length ? "ok" : "warn");
      if (ok) void useFiles.getState().reload();
    } finally {
      setBusy(false);
    }
  };

  const nameOf = (i: number) => (ren ? `${prefix}${String(start + i).padStart(pad, "0")}.${fmt}` : "");
  const example = ren ? nameOf(0) : t("tools.keepName", { f: fmt });

  return (
    <div style={{ flex: 1, minHeight: 0, display: "flex", gap: "var(--sp-4)" }}>
      {/* 왼쪽 — 무엇을 */}
      <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: "var(--sp-3)" }}>
        {/* ★★**목록 판 자체가 드롭존**이다 (사용자 지시 2026-08-23: 따로 두지 말고 화면
            전체에서 받기). 위에 점선 상자를 따로 두면 목록이 길 때 그 상자가 화면 밖으로
            밀려 나가, 넓은 아래쪽에 떨궈도 아무 일이 안 일어났다 (EXIF 리더와 같은 자국). */}
        <div
          {...zone}
          data-convert-drop
          style={{
            position: "relative",
            flex: 1,
            minHeight: 0,
            overflowY: "auto",
            background: over ? "var(--accent-bg)" : "var(--panel)",
            border: `1px ${over ? "solid var(--accent)" : "solid var(--line)"}`,
            borderRadius: "var(--r-3)",
            padding: "var(--sp-2)",
            display: "flex",
            flexDirection: "column",
            gap: 2,
          }}
        >
          {items.map((it, i) => {
            const p = probes[i];
            const row = rows[i];
            return (
              <div key={`${it.name}-${i}`}>
                {/* 끼울 자리 — 드래그 중에만 */}
                <div
                  style={{
                    height: 2,
                    borderRadius: 1,
                    background:
                      dragIdx != null && overIdx === i && i !== dragIdx && i !== dragIdx + 1
                        ? "var(--accent-ink)"
                        : "transparent",
                  }}
                />
                <div
                  ref={register(i)}
                  data-convert-row
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "var(--sp-2)",
                    padding: "3px var(--sp-2)",
                    borderRadius: "var(--r-1)",
                    fontSize: "var(--text-2xs)",
                    opacity: dragIdx === i ? 0.35 : 1,
                  }}
                >
                  <span {...handleProps(i)} style={{ ...handleProps(i).style, color: "var(--ink-ghost)", display: "grid" }}>
                    {Icon.grip}
                  </span>
                  <span
                    style={{
                      width: 30,
                      flexShrink: 0,
                      color: "var(--ink-faint)",
                      fontFamily: "var(--font-mono)",
                      fontVariantNumeric: "tabular-nums",
                    }}
                  >
                    {ren ? String(start + i).padStart(pad, "0") : i + 1}
                  </span>
                  {/* 썸네일 — 서버가 96px 로 줄여 준다. 못 읽은 것은 빈 칸으로 자리만 지킨다 */}
                  <span
                    style={{
                      width: 28,
                      height: 28,
                      flexShrink: 0,
                      borderRadius: "var(--r-1)",
                      background: "var(--bg)",
                      overflow: "hidden",
                      display: "grid",
                      placeItems: "center",
                    }}
                  >
                    {p?.thumb && (
                      <img
                        src={p.thumb}
                        alt=""
                        style={{ width: "100%", height: "100%", objectFit: "cover" }}
                      />
                    )}
                  </span>
                  <span style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
                    <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {it.name}
                    </span>
                    {/* ★★**바뀔 이름이 주인공**이다 (사용자 지적 2026-08-23: 잘 안 보였다) —
                        크기·해상도와 나란히 흐린 글씨로 두면 어느 것이 새 이름인지 안 보인다.
                        화살표로 가리키고 글자를 밝게 둔다. */}
                    <span style={{ display: "flex", alignItems: "center", gap: 4, minWidth: 0 }}>
                      {row?.error ? (
                        <span style={{ color: "var(--err-ink)" }}>{t("tools.rowFailed")}</span>
                      ) : (
                        <>
                          <span style={{ color: "var(--ink-ghost)" }}>→</span>
                          <span
                            data-convert-newname
                            style={{
                              color: row?.saved ? "var(--ok)" : "var(--accent-ink)",
                              fontWeight: "var(--w-semi)",
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                              whiteSpace: "nowrap",
                            }}
                          >
                            {row?.saved ?? nameOf(i)}
                          </span>
                          <span style={{ color: "var(--ink-faint)", flexShrink: 0 }}>
                            {[p?.bytes ? fmtSize(p.bytes) : "", p?.width && p?.height ? `${p.width} × ${p.height}` : ""]
                              .filter(Boolean)
                              .join("  ")}
                          </span>
                        </>
                      )}
                    </span>
                  </span>
                  <button onClick={() => swap(i, i - 1)} style={mini} data-tip={t("tools.up")}>
                    {Icon.chevronUp}
                  </button>
                  <button onClick={() => swap(i, i + 1)} style={mini} data-tip={t("tools.down")}>
                    {Icon.chevronDown}
                  </button>
                  <button onClick={() => drop(i)} style={mini} data-tip={t("common.delete")}>
                    {Icon.close12}
                  </button>
                </div>
              </div>
            );
          })}
          {!items.length && (
            <button
              data-convert-pick
              onClick={() => void pick()}
              style={{
                margin: "auto",
                display: "flex",
                flexDirection: "column",
                gap: 2,
                fontSize: "var(--text-xs)",
                color: "var(--ink-soft)",
              }}
            >
              {t("tools.convertDrop")}
              <span style={{ fontSize: "var(--text-2xs)", color: "var(--ink-faint)" }}>{t("tools.dropHint")}</span>
            </button>
          )}
        </div>
      </div>

      {/* 오른쪽 — 어떻게 */}
      <div style={{ width: 260, flexShrink: 0, display: "flex", flexDirection: "column", gap: "var(--sp-4)", overflowY: "auto" }}>
        <Section label={t("tools.format")}>
          {/* ★★내는 형식은 **PNG·WebP 둘뿐**이다 (사용자 결정 2026-08-23) — 공홈과 같다.
              JPG 는 투명이 없고 픽셀을 뭉개므로 뺐다. **읽는 것은 그대로다** — 밖에서 온
              JPG 를 목록에 담아 PNG·WebP 로 바꿀 수 있다.
              ★품질 슬라이더도 함께 걷었다: PNG 도 무손실 WebP 도 품질이라는 것이 없다. */}
          <div style={{ display: "flex", gap: "var(--sp-2)" }}>
            {[["png", "PNG"], ["webp", "WebP (Lossless)"]].map(([f, name]) => (
              <button key={f} data-fmt={f} onClick={() => setFmt(f)} style={{ ...box, flex: 1, ...(fmt === f ? onSt : {}) }}>
                {name}
              </button>
            ))}
          </div>
          <label style={lbl}>
            <input type="checkbox" data-strip checked={strip} onChange={(e) => setStrip(e.target.checked)} />
            {t("tools.strip")}
            <Help tip={strip ? t("tools.stripHint") : t("tools.keepHint")} />
          </label>
        </Section>

        <Section label={t("tools.rename")}>
          <label style={lbl}>
            <input type="checkbox" data-ren checked={ren} onChange={(e) => setRen(e.target.checked)} />
            {t("tools.renameOn")}
          </label>
          {ren && (
            <>
              <Line label={t("tools.prefix")}>
                <input value={prefix} onChange={(e) => setPrefix(e.target.value)} style={{ ...box, flex: 1, minWidth: 0 }} />
              </Line>
              <Line label={t("tools.start")}>
                <input
                  type="number"
                  min={0}
                  value={start}
                  onChange={(e) => setStart(Number(e.target.value) || 0)}
                  style={{ ...box, width: 64 }}
                />
              </Line>
              <Line label={t("tools.pad")}>
                <input
                  type="number"
                  min={0}
                  max={8}
                  value={pad}
                  onChange={(e) => setPad(Number(e.target.value) || 0)}
                  style={{ ...box, width: 64 }}
                />
              </Line>
            </>
          )}
          <Hint>{t("tools.preview", { s: example })}</Hint>
        </Section>

        <Section label={t("tools.dest")} help={t("tools.destHint")}>
          {/* ★★세 갈래는 **드롭다운 하나**다 (사용자 지시 2026-08-23) — 단추 셋을 세로로
              늘어놓으면 오른쪽 기둥에서 세 줄을 먹는데, 한 번 정하고 잘 안 바꾸는 값이다.
              ★「원본 옆에」는 걷었다 — 같은 폴더에 번호 붙은 사본이 쌓여 원본과 뒤섞였다. */}
          <select
            data-dest-mode
            value={mode}
            onChange={(e) => setMode(e.target.value as typeof mode)}
            style={{ ...box, width: "100%" }}
          >
            {/* ★자리를 모르는 그림(브라우저 드롭)은 폴더를 골라야만 저장할 수 있다 */}
            <option value="overwrite" disabled={noHome}>{t("tools.destOverwrite")}</option>
            <option value="sub" disabled={noHome}>{t("tools.destSub")}</option>
            <option value="folder">{t("tools.destFolder")}</option>
          </select>
          {/* ★★덮어쓰기는 **원본이 자리를 내주는** 유일한 갈래다 — 무슨 일이 일어나는지 적는다.
              (지우지는 않는다: 옛 파일은 휴지통으로 간다, `backend/tools.convert`) */}
          {mode === "overwrite" && <Hint>{t("tools.destOverwriteHint")}</Hint>}
          {mode === "folder" && (
            <>
              {/* ★★**윈도우 폴더 찾기**로 고른다 (사용자 지시 2026-08-23) — 목록에서 고르는
                  방식은 아웃풋 루트 안으로만 갈 수 있었다. 창은 서버가 띄운다
                  (`backend/files.pick_dir`) — 브라우저에는 폴더를 고르는 표준 길이 없다.
                  ★맨 앞에 세울 자리는 **첫 그림이 있는 폴더**다. */}
              <button data-dest-pick onClick={() => void pickDest()} style={{ ...box, width: "100%", textAlign: "left" }}>
                {dest || t("tools.destPick")}
              </button>
            </>
          )}
          {/* ★남는 것은 **지금 막힌 이유**뿐이다 — 무엇을 하는 자리인지는 라벨 옆 `?` 에 있다 */}
          {needDest && !dest && <Hint>{t("tools.needDest")}</Hint>}
          {/* ★여는 것은 **방금 우리가 쓴 자리**뿐이다 (backend/files.py `open_dir` 주석) */}
          <label style={lbl}>
            <input
              type="checkbox"
              data-open-after
              checked={openAfter}
              onChange={(e) => setOpenAfter(e.target.checked)}
            />
            {t("tools.openAfter")}
          </label>
        </Section>

        {/* 진행바 — 돌 때만. 눌렀다는 신호이자 어디까지 갔는지다 (v2 `convertProgress`) */}
        {busy && (
          <div data-convert-progress style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <div style={{ height: 4, borderRadius: 2, background: "var(--bg)", overflow: "hidden" }}>
              <div
                style={{
                  width: `${items.length ? Math.round((done / items.length) * 100) : 0}%`,
                  height: "100%",
                  background: "var(--accent)",
                  transition: "width 0.15s",
                }}
              />
            </div>
            <span
              style={{
                fontSize: "var(--text-2xs)",
                color: "var(--ink-faint)",
                textAlign: "right",
                fontVariantNumeric: "tabular-nums",
              }}
            >
              {done} / {items.length}
            </span>
          </div>
        )}

        <button data-convert-run onClick={() => void run()} disabled={busy || !items.length} style={runBtn}>
          {Icon.refresh}
          {t("tools.runConvert", { n: items.length })}
        </button>
        <button data-convert-clear onClick={() => setItems([], [])} disabled={busy || !items.length} style={box}>
          {t("tools.clearList")}
        </button>
      </div>

      {/* 끌고 있는 줄의 잔상 — 브라우저가 안 만들어 주므로 우리가 그린다 (useReorder 주석) */}
      {ghost && dragIdx != null && (
        <DragGhost
          x={ghost.x}
          y={ghost.y}
          anchor="exact"
          style={{
            width: ghost.w,
            height: ghost.h,
            borderRadius: "var(--r-2)",
            border: "1px solid var(--accent)",
            background: "var(--panel)",
            display: "flex",
            alignItems: "center",
            padding: "0 var(--sp-3)",
            fontSize: "var(--text-2xs)",
            color: "var(--ink)",
            overflow: "hidden",
          }}
        >
          {items[dragIdx]?.name}
        </DragGhost>
      )}
    </div>
  );
}

const fmtSize = (n: number) =>
  n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`;

/* ★폴더 트리를 펴서 목록으로 만들던 `flatten` 은 걷었다 — 저장 폴더를 **윈도우 폴더 찾기**로
   고르게 되면서(2026-08-23) 아웃풋 루트 안의 목록을 그릴 이유가 없어졌다. */

/** ★설명은 **라벨 옆 `?`** 로만 나온다 (사용자 지시 2026-08-19) */
const Section = ({ label, help, children }: { label: string; help?: string; children: React.ReactNode }) => (
  <div style={{ display: "flex", flexDirection: "column", gap: "var(--sp-2)" }}>
    <span style={{ display: "flex", alignItems: "center", gap: "var(--sp-2)", fontSize: "var(--text-xs)", fontWeight: "var(--w-semi)", color: "var(--ink-soft)" }}>
      {label}
      {help && <Help tip={help} />}
    </span>
    {children}
  </div>
);

const Line = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <div style={{ display: "flex", alignItems: "center", gap: "var(--sp-2)" }}>
    <span style={{ width: 48, flexShrink: 0, fontSize: "var(--text-2xs)", color: "var(--ink-faint)" }}>{label}</span>
    {children}
  </div>
);

const Hint = ({ children }: { children: React.ReactNode }) => (
  <span style={{ fontSize: "var(--text-2xs)", color: "var(--ink-faint)" }}>{children}</span>
);

const box: React.CSSProperties = {
  background: "var(--panel)",
  border: "1px solid var(--line)",
  borderRadius: "var(--r-2)",
  padding: "3px var(--sp-3)",
  fontSize: "var(--text-2xs)",
  color: "var(--ink-soft)",
};
/** 고른 칩. ★★**`border` 를 통째로 준다** — 낱개(`borderColor`)만 덮으면, 선택이 풀릴 때
 *  리액트가 그 낱개를 지우면서 아래의 줄임 속성에 실린 색까지 함께 빠져 **테두리가 글자색으로
 *  남는다** (검열 방식 칩에서 실측하고 고친 것과 같은 함정, `panels/censor/ui.tsx` 의 ★★주). */
const onSt: React.CSSProperties = { border: "1px solid var(--accent)", background: "var(--accent-bg)", color: "var(--ink)" };
const lbl: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "var(--sp-2)",
  fontSize: "var(--text-2xs)",
  color: "var(--ink-soft)",
};
const mini: React.CSSProperties = { color: "var(--ink-faint)", display: "grid", padding: 2 };
const runBtn: React.CSSProperties = {
  background: "var(--accent)",
  color: "var(--accent-on)",
  borderRadius: "var(--r-2)",
  padding: "var(--sp-2)",
  fontSize: "var(--text-xs)",
  fontWeight: "var(--w-semi)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  gap: "var(--sp-2)",
};
