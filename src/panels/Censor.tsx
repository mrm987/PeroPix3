import { useEffect, useRef } from "react";
import { useI18n } from "../i18n";
import { BRUSH_MAX, dirOf, isAbsPath, savePathOf, useCensor, type Tab } from "../store/censor";
import { useFiles, type FileNode } from "../store/files";
import { useGen } from "../store/gen";
import { fileMgrThumb } from "../lib/imgUrl";
import { useImageDrop } from "../lib/dropImages";
import { toast } from "../store/toast";
import { Icon } from "../components/Icon";
import { TreeRoot } from "../components/TreeRoot";
import { onNearBottom } from "../lib/nearBottom";
import { CensorStage } from "./censor/CensorStage";
import { CensorSide } from "./censor/CensorSide";
import { card } from "./censor/ui";
import { FolderOpenButton } from "../components/FolderOpenButton";
import { ClearButton } from "../components/ClearButton";

/** 자동 검열. **여러 장을 한 번에** 찾고 가린다 (v2 이식).
 *
 *  ★탭 셋이 곧 작업 순서다: 담아서 찾고(검열 전) · 손보고(검열 중) · 다시 손본다(검열 후).
 *  ★그림은 **두 경로로** 들어온다: 아웃풋 폴더에서 고르거나(왼쪽 트리), 밖에서 떨구거나.
 *    떨군 것은 경로만 서버로 가고 바이트는 안 실린다 (`lib/dropImages.ts` 머리 주석).
 *  ★결과는 **새 파일**이다. 원본은 그대로 남는다. 덮어쓰기 경로를 만들지 말 것.
 */
export function Censor() {
  const t = useI18n((s) => s.t);
  const base = useGen((s) => s.base);
  const c = useCensor();
  const { tree, folder, items, open: opened, hasMore, loadTree, go, more, toggleOpen } = useFiles();
  const onScroll = onNearBottom(() => void more());
  const stripRef = useRef<HTMLDivElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);

  const list = c.tab === "after" ? c.after : c.images;
  const at = c.tab === "after" ? c.afterIdx : c.idx;
  const picked = new Set(c.images.map((x) => x.rel).filter(Boolean) as string[]);

  // ★떨군 그림은 **검열 전 탭에서만** 받는다 (v2 `canAcceptDrop`).
  //   결과를 보는 탭에 떨군 것이 조용히 다른 목록으로 들어가면 어디로 갔는지 알 수 없다
  const { zone, over, pick } = useImageDrop((dropped) => {
    if (useCensor.getState().tab !== "before") return;
    void c.addImages(dropped);
  });

  useEffect(() => {
    void c.loadModels();
    void loadTree().then(() => useFiles.getState().go(useFiles.getState().folder));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 고른 장이 띠 밖으로 나가지 않게 (v2 `scrollIntoView`)
  useEffect(() => {
    stripRef.current?.querySelector<HTMLElement>('[data-censor-thumb-active="1"]')?.scrollIntoView({
      block: "nearest",
      inline: "center",
      behavior: "smooth",
    });
  }, [at, c.tab]);

  /** 무대의 휠 = 장 넘기기.
   *
   *  ★**네이티브 리스너로 붙인다.** React 의 `onWheel` 은 뿌리에 passive 로 달려서
   *    `preventDefault()` 가 안 먹고, 그러면 넘기면서 화면까지 함께 밀린다
   *    (`SceneLane` 의 Ctrl+휠과 같은 함정). */
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      const s = useCensor.getState();
      /* ★★**Alt+휠 = 붓 크기** (사용자 지시 2026-09-05: *"조작키를 알트 + 휠로 변경"* — 칠하다 말고
         손을 옮기지 않아도 되게. 칩의 가중치와 같은 조합이다). Alt 단독 누름이 창의 메뉴 모드를 깨우지
         않게는 `App.tsx` 가 막아 둔다. */
      if (e.altKey && s.tab !== "before") {
        e.preventDefault();
        // ★한 눈금 1px, Shift 를 더하면 10px (칩의 가중치가 Alt+Shift 로 큰 걸음을 두는 것과 같다)
        const step = (e.shiftKey ? 10 : 1) * (e.deltaY < 0 ? 1 : -1);
        s.tune({ brushPx: Math.max(1, Math.min(BRUSH_MAX, s.brushPx + step)) });
        return;
      }
      const n = (s.tab === "after" ? s.after : s.images).length;
      if (n < 2) return;
      e.preventDefault();
      s.step(e.deltaY > 0 ? 1 : -1);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [c.tab]);

  /** 단축키. ★**글자를 치는 칸**에 커서가 있으면 먹지 않는다 (숫자칸에 1 을 못 치면 곤란하다).
   *  ★★슬라이더·체크박스는 글자 칸이 아니다 — 여기서 걸러 버리면 슬라이더를 만진 뒤로 단축키가
   *    전부 죽는다 (사용자 제보 2026-09-05: *"컨트롤 제트도 안 됨, 단축키 다 안 되는 거 보니까 입력을
   *    안 먹고 있는 듯"*). 무대는 `pointerdown` 의 기본 동작을 막고 있어 눌러도 포커스가 안 옮겨지므로,
   *    직전에 만진 슬라이더가 포커스를 쥔 채 남는다 (무대 쪽에서도 누를 때 포커스를 푼다). */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable
        || (el.tagName === "INPUT" && !/^(range|checkbox|radio|button|color)$/.test((el as HTMLInputElement).type)))) return;
      const s = useCensor.getState();
      if (s.tab !== "before" && (e.key === "1" || e.key === "2")) {
        e.preventDefault();
        return s.set({ tool: e.key === "1" ? "brush" : "erase" });
      }
      // ★`code` 로 본다 — 한글 자판이 켜져 있으면 `key` 가 "ㅋ" 로 오는 수가 있다
      if (s.tab !== "before" && e.code === "KeyZ" && (e.ctrlKey || e.metaKey) && !e.shiftKey) {
        e.preventDefault();
        return s.undoPaint();
      }
      if (e.key === "ArrowLeft") return s.step(-1);
      if (e.key === "ArrowRight") return s.step(1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  /* 저장 자리 — 검열 전·중은 지금 설정이 가리키는 폴더, 검열 후는 보고 있는 장이 있는 폴더.
     덮어쓰기는 원본 자리(그 장의 폴더). 루트 안은 `reveal`, 밖(절대 경로)은 `openDir` 로 연다. */
  const curIm = c.cur();
  const savePath = c.tab === "after" ? (curIm ? dirOf(curIm) : "") : savePathOf(c, c.images);
  const saveLabel = c.tab === "after"
    ? savePath || t("censor.openFolder")
    : savePath === null ? t("tools.destOverwrite") : savePath || t("tools.needDest");
  const openTarget = savePath === null ? (curIm ? dirOf(curIm) : "") : savePath;
  const openSaveDir = async () => {
    try {
      if (isAbsPath(openTarget)) await useFiles.getState().openDir(openTarget);
      else await useFiles.getState().reveal(openTarget);
    } catch (e) {
      toast(String(e), "warn");
    }
  };

  const Row = ({ node, depth }: { node: FileNode; depth: number }) => (
    <>
      <div
        data-folder={node.path}
        /* ★★**줄을 누르면 고르고 동시에 펼친다** (사용자 지시 2026-08-23) — 화살표를
           정확히 겨눠야만 펼쳐지던 자리다. 자식이 없으면 펼칠 것이 없으니 고르기만 한다.
           ★화살표 단추는 그대로 둔다 — **고르지 않고 펼치기만** 하려면 이것뿐이다 (딴 폴더를
             보면서 트리만 넓히고 싶을 때). */
        onClick={() => {
          void go(node.path);
          if (node.children.length) toggleOpen(node.path);
        }}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 4,
          padding: `2px var(--sp-2) 2px ${8 + depth * 12}px`,
          borderRadius: "var(--r-1)",
          fontSize: "var(--text-2xs)",
          cursor: "pointer",
          color: folder === node.path ? "var(--ink)" : "var(--ink-soft)",
          background: folder === node.path ? "var(--accent-bg)" : undefined,
        }}
      >
        <button
          onClick={(e) => {
            e.stopPropagation();
            toggleOpen(node.path);
          }}
          style={{
            width: 14,
            display: "grid",
            placeItems: "center",
            color: "var(--ink-faint)",
            visibility: node.children.length ? "visible" : "hidden",
          }}
        >
          {opened.has(node.path) ? Icon.chevronDown : Icon.chevronRight}
        </button>
        <span style={{ display: "grid", color: "var(--ink-faint)" }}>{Icon.folder}</span>
        <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {node.name}
        </span>
        {!!node.count && <span style={{ color: "var(--ink-faint)" }}>{node.count}</span>}
      </div>
      {opened.has(node.path) && node.children.map((x) => <Row key={x.path} node={x} depth={depth + 1} />)}
    </>
  );

  return (
    <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column", gap: "var(--sp-3)", padding: "var(--sp-4)" }}>
      {/* ── 머리: 어디까지 왔나 · 어디에 저장하나 ── */}
      <div style={{ display: "flex", alignItems: "center", gap: "var(--sp-2)" }}>
        {TABS.map(([id, key]) => {
          const active = c.tab === id;
          const dim = id === "processing" && !c.staged;
          return (
            <button
              key={id}
              data-censor-tab={id}
              onClick={() => c.setTab(id)}
              disabled={dim}
              style={{
                padding: "var(--sp-2) var(--sp-4)",
                borderRadius: "var(--r-2)",
                fontSize: "var(--text-xs)",
                fontWeight: "var(--w-semi)",
                border: `1px solid ${active ? "var(--accent)" : "transparent"}`,
                background: active ? "var(--accent-bg)" : "transparent",
                color: active ? "var(--ink)" : dim ? "var(--ink-ghost)" : "var(--ink-dim)",
              }}
            >
              {t(key)}
            </button>
          );
        })}

        <span style={{ flex: 1 }} />

        {/* ★★저장 자리는 **읽기만** 보여 준다 (사용자 지시 2026-09-06: *"저장 위치 정하는 게 도구 안으로 들어왔으니까
            상단에 저장 폴더 정하는 UI 는 사라져야 함, 새 폴더 추가 단추도. 현재 저장되는 경로랑 폴더 열기 단추만"*).
            정하는 창구는 오른쪽 기둥의 「저장 위치」(`DestPicker`) 하나다 — 같은 값을 두 곳에서 고치게 두지 않는다. */}
        <span
          data-censor-save-path
          title={savePath ?? ""}
          style={{ fontSize: "var(--text-2xs)", color: "var(--ink-faint)", maxWidth: 360, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
        >
          {saveLabel}
        </span>
        <FolderOpenButton
          data-censor-open-folder
          tip={t("censor.openFolder")}
          disabled={!openTarget && openTarget !== ""}
          onClick={() => void openSaveDir()}
        />
      </div>

      {/* ── 썸네일 띠: 지금 다루는 목록 ── */}
      <div
        ref={stripRef}
        data-censor-strip
        onWheelCapture={(e) => {
          // ★띠에서는 휠이 **가로 스크롤**이다 (무대의 장 넘기기와 갈라 둔다)
          if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
          e.stopPropagation();
          e.currentTarget.scrollLeft += e.deltaY;
        }}
        style={{
          ...card,
          flexShrink: 0,
          height: 68,
          display: "flex",
          alignItems: "center",
          gap: "var(--sp-2)",
          padding: "var(--sp-2)",
          overflowX: "auto",
          overflowY: "hidden",
        }}
      >
        {list.map((im, i) => (
          <div key={im.id} style={{ position: "relative", flexShrink: 0 }}>
            <button
              data-censor-thumb={i}
              data-censor-thumb-active={at === i ? "1" : "0"}
              onClick={() => c.select(i)}
              data-tip={im.name}
              style={{
                width: 50,
                height: 50,
                borderRadius: "var(--r-2)",
                overflow: "hidden",
                padding: 0,
                background: "var(--bg)",
                border: `2px solid ${at === i ? "var(--accent)" : "transparent"}`,
              }}
            >
              <img
                src={im.thumb ?? (im.rel ? fileMgrThumb(base, im.rel) : undefined)}
                alt=""
                loading="lazy"
                decoding="async"
                style={{ width: "100%", height: "100%", objectFit: "cover" }}
              />
            </button>
            {c.tab === "before" && (
              <button
                data-censor-thumb-del={i}
                data-tip={t("censor.removeOne")}
                onClick={() => c.removeImage(i)}
                style={{
                  position: "absolute",
                  top: -2,
                  right: -2,
                  width: 16,
                  height: 16,
                  display: "grid",
                  placeItems: "center",
                  borderRadius: "50%",
                  background: "var(--panel)",
                  border: "1px solid var(--line)",
                  color: "var(--ink-dim)",
                }}
              >
                {Icon.close12}
              </button>
            )}
          </div>
        ))}
        {c.tab === "before" && (
          <button
            data-censor-add
            onClick={() => void pick()}
            data-tip={t("censor.add")}
            style={{
              flexShrink: 0,
              width: 50,
              height: 50,
              display: "grid",
              placeItems: "center",
              borderRadius: "var(--r-2)",
              border: "1px dashed var(--line-strong)",
              color: "var(--ink-faint)",
              background: "transparent",
            }}
          >
            {Icon.plus}
          </button>
        )}
        {!list.length && c.tab !== "before" && (
          <span style={{ margin: "auto", fontSize: "var(--text-2xs)", color: "var(--ink-faint)" }}>
            {t("censor.emptyList")}
          </span>
        )}
        <span style={{ flex: 1 }} />
        {!!list.length && (
          <span style={{ flexShrink: 0, paddingRight: "var(--sp-2)", fontSize: "var(--text-2xs)", color: "var(--ink-faint)", fontVariantNumeric: "tabular-nums" }}>
            {at + 1} / {list.length}
          </span>
        )}
        {c.tab === "before" && !!list.length && (
          <ClearButton data-censor-clear tip={t("censor.clear")} onClick={() => c.clearImages()} />
        )}
        {c.tab === "after" && !!list.length && (
          <ClearButton data-censor-clear-after tip={t("censor.clear")} onClick={() => c.clearAfter()} />
        )}
      </div>

      <div style={{ flex: 1, minHeight: 0, display: "flex", gap: "var(--sp-4)" }}>
        {/* ── 왼쪽: 아웃풋 폴더에서 담기 (검열 전 탭에만) ── */}
        {c.tab === "before" && (
          <div style={{ width: 210, flexShrink: 0, display: "flex", flexDirection: "column", gap: "var(--sp-2)" }}>
            <div style={{ ...card, flex: "0 0 38%", overflowY: "auto", padding: "var(--sp-2)" }}>
              {/* ★★파일 관리와 **같은 머리글**이다 (`components/TreeRoot`, 사용자 지시
                  2026-08-23). 여기는 아예 없어서 폴더 목록이 어디의 것인지 안 보였다.
                  ★고르는 자리가 아니다 — 검열은 폴더를 옮겨 다니는 화면이 아니라
                    **그림을 담는** 화면이라, 뿌리를 눌러 갈 일이 없다. */}
              <TreeRoot label={t("files.root")} />
              {tree.map((n) => (
                <Row key={n.path} node={n} depth={0} />
              ))}
            </div>
            <div
              data-censor-picker
              onScroll={onScroll}
              style={{
                ...card,
                flex: 1,
                minHeight: 0,
                overflowY: "auto",
                padding: "var(--sp-2)",
                display: "grid",
                gridTemplateColumns: "repeat(auto-fill, minmax(56px, 1fr))",
                gridAutoRows: "min-content",
                gap: "var(--sp-2)",
                alignContent: "start",
              }}
            >
              {items.map((it) => {
                const inList = picked.has(it.file);
                return (
                  <button
                    key={it.file}
                    data-censor-pick={it.file}
                    onClick={() => c.toggleRel(it.file, it.name)}
                    data-tip={it.name}
                    style={{
                      position: "relative",
                      aspectRatio: "1 / 1",
                      borderRadius: "var(--r-2)",
                      overflow: "hidden",
                      border: `2px solid ${inList ? "var(--accent)" : "transparent"}`,
                      padding: 0,
                      background: "var(--bg)",
                    }}
                  >
                    <img
                      src={fileMgrThumb(base, it.file)}
                      alt=""
                      loading="lazy"
                      decoding="async"
                      style={{ width: "100%", height: "100%", objectFit: "contain", opacity: inList ? 1 : 0.85 }}
                    />
                    {inList && (
                      <span
                        style={{
                          position: "absolute",
                          right: 2,
                          top: 2,
                          display: "grid",
                          placeItems: "center",
                          width: 15,
                          height: 15,
                          borderRadius: "50%",
                          background: "var(--accent)",
                          color: "var(--accent-on)",
                        }}
                      >
                        {Icon.check}
                      </span>
                    )}
                  </button>
                );
              })}
              {hasMore && (
                <span style={{ gridColumn: "1/-1", textAlign: "center", fontSize: "var(--text-2xs)", color: "var(--ink-faint)" }}>
                  …
                </span>
              )}
              {!items.length && (
                <span style={{ gridColumn: "1/-1", margin: "auto", fontSize: "var(--text-2xs)", color: "var(--ink-faint)" }}>
                  {t("files.empty")}
                </span>
              )}
            </div>
          </div>
        )}

        {/* ── 가운데: 무대 ── */}
        <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: "var(--sp-2)" }}>
          <div
            {...zone}
            ref={(el) => {
              stageRef.current = el;
              // ★드롭존의 ref 와 **같은 요소**를 가리켜야 한다. 떨군 자리를 좌표로 가려내므로
              (zone.ref as React.MutableRefObject<HTMLDivElement | null>).current = el;
            }}
            data-censor-stage
            style={{
              ...card,
              flex: 1,
              minHeight: 0,
              display: "grid",
              placeItems: "center",
              overflow: "hidden",
              position: "relative",
              borderColor: over && c.tab === "before" ? "var(--accent)" : "var(--line)",
              background: over && c.tab === "before" ? "var(--accent-bg)" : "var(--bg)",
            }}
          >
            {list.length ? <CensorStage /> : null}

            {!list.length && (
              <button
                data-censor-dropzone
                onClick={() => c.tab === "before" && void pick()}
                style={{
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "center",
                  gap: "var(--sp-2)",
                  padding: "var(--sp-8)",
                  background: "transparent",
                  border: "none",
                  color: "var(--ink-faint)",
                }}
              >
                <span style={{ display: "grid", color: "var(--ink-ghost)" }}>{Icon.folderOpen}</span>
                <span style={{ fontSize: "var(--text-xs)", color: "var(--ink-dim)" }}>
                  {t(c.tab === "before" ? "censor.dropHere" : "censor.emptyList")}
                </span>
                {c.tab === "before" && <span style={{ fontSize: "var(--text-2xs)" }}>{t("censor.dropHint")}</span>}
              </button>
            )}

            {list.length > 1 && (
              <>
                <Arrow side="left" disabled={at <= 0} onClick={() => c.step(-1)} />
                <Arrow side="right" disabled={at >= list.length - 1} onClick={() => c.step(1)} />
              </>
            )}

            {c.scanning && (
              <span
                data-censor-scanning
                style={{
                  position: "absolute",
                  top: "var(--sp-3)",
                  left: "50%",
                  transform: "translateX(-50%)",
                  padding: "3px var(--sp-4)",
                  borderRadius: "var(--r-4)",
                  background: "var(--panel)",
                  border: "1px solid var(--line)",
                  fontSize: "var(--text-2xs)",
                  color: "var(--ink-soft)",
                }}
              >
                {t("censor.scanningOne")}
              </span>
            )}
          </div>
          {/* ★무대 아래 파일명·찾은 수·안내 줄은 걷었다 (사용자 지시 2026-09-05: "검열 페이지에서
              하단의 파일명과 안내 라인 필요없음"). 그 글자를 끌어 고르면 선택 상태가 남아 붓이
              한 틱 만에 끊기던 것도 함께 사라진다. */}
        </div>

        {/* ── 오른쪽: 무엇을 찾고 어떻게 가릴까 ── */}
        <CensorSide />
      </div>
    </div>
  );
}

const TABS: [Tab, "censor.tabBefore" | "censor.tabDuring" | "censor.tabAfter"][] = [
  ["before", "censor.tabBefore"],
  ["processing", "censor.tabDuring"],
  ["after", "censor.tabAfter"],
];

function Arrow({ side, disabled, onClick }: { side: "left" | "right"; disabled: boolean; onClick: () => void }) {
  return (
    <button
      data-censor-nav={side}
      onClick={onClick}
      disabled={disabled}
      style={{
        position: "absolute",
        [side]: "var(--sp-2)",
        top: "50%",
        transform: "translateY(-50%)",
        width: 30,
        height: 44,
        display: "grid",
        placeItems: "center",
        borderRadius: "var(--r-2)",
        border: "1px solid var(--line)",
        background: "var(--panel)",
        color: "var(--ink-soft)",
        opacity: disabled ? 0.25 : 0.85,
      }}
    >
      {side === "left" ? Icon.chevL : Icon.chevR}
    </button>
  );
}
