import { composing } from "../lib/ime";
import { useRef, useState } from "react";
import { useI18n } from "../i18n";
import { useWs } from "../store/workspace";
import { ALL, useGallery } from "../store/gallery";
import { dragSourceStyle, useDrag, useDragSource, useDropZone } from "../cards/dragStore";
import { useRename } from "../components/useRename";
import { ask } from "../store/ask";
import { toast } from "../store/toast";
import { Icon } from "../components/Icon";
import { FolderOpenButton } from "../components/FolderOpenButton";

/** 갤러리의 폴더 목록 — 좌 패널.
 *
 *  ★폴더 축은 **사용자 소유**다 (feature-inventory K절). 앱이 캐릭터 이름 같은 걸로 폴더를
 *    만들지 않으므로, 여기 뜨는 이름은 전부 사용자가 붙인 탭·셀 이름이다.
 *  ★빈 폴더도 보인다 — 여기서 만든 폴더는 그림을 옮겨 넣기 전까지 비어 있다.
 *  ★폴더를 만들고 지우는 창구가 **여기 하나**다 (v2-port-audit C6). */
export function GalleryFolders() {
  const t = useI18n((s) => s.t);
  const ws = useWs((s) => s.current);
  // ★목록을 불러오는 것은 **중앙(Gallery)** 이다 — 이 패널은 접으면 언마운트되므로
  //   (Shell 이 접힌 쪽을 렌더하지 않는다) 여기서 불러오면 접었을 때 갤러리가 빈다.
  const { folders, folder, items, setFolder, newFolder, dropFolder, moveFolder, renameFolder, reveal, moveTo, vibeMode, setVibeMode } =
    useGallery();
  /** 그림을 끌어다 놓으면 그 폴더로 옮긴다 (사용자 지시 2026-08-19) */
  const moveFiles = async (files: string[], dest: string) => {
    try {
      const n = await moveTo(ws, dest === ALL ? "" : dest, files);
      if (n) toast(t("gallery.moved", { n }));
    } catch (e) {
      toast(String(e), "warn");
    }
  };
  /** 새 폴더 — **그 자리 입력칸**이다. 브라우저 `prompt` 은 창 밖 OS 대화상자라 쓰지 않는다 */
  const [adding, setAdding] = useState<string | null>(null);
  /** ★적고 있는 글자를 **ref 로도** 든다. Esc 로 물린 직후 `blur` 가 오면 그 순간의
   *  렌더가 들고 있던 옛 값으로 폴더가 만들어진다 — ref 는 즉시 비울 수 있다. */
  const draft = useRef("");
  /** 갤러리 그림을 끌고 있나 — 그동안 이 영역이 어둠 위로 올라온다 */
  const lift = useDrag((d) => d.drag?.kind === "keep");

  /** ★폴더를 끌어다 다른 폴더 줄에 놓으면 **그 아래로** 들어간다 (사용자 지시 2026-09-06) */
  const moveFolderTo = async (src: string, dest: string) => {
    if (dest === src || dest.startsWith(src + "/")) return toast(t("gallery.folderIntoSelf"), "warn");
    try {
      await moveFolder(ws, src, dest === ALL ? "" : dest);
      toast(t("gallery.folderMoved"));
    } catch (e) {
      toast(String(e), "warn");
    }
  };

  /** ★줄을 두 번 눌러 이름을 고친다 (사용자 지시 2026-09-10). 자리는 그대로다 */
  const renameFolderTo = async (path: string, next: string) => {
    try {
      await renameFolder(ws, path, next);
      toast(t("gallery.folderRenamed"));
    } catch (e) {
      toast(String(e), "warn");
    }
  };

  const addFolder = async () => {
    const name = draft.current.trim();
    draft.current = "";
    setAdding(null);
    if (!name) return;
    try {
      // ★★**고른 폴더 아래에** 만든다 (사용자 지시 2026-09-06: *"하위폴더 선택한채로 '새폴더' 누르면
      //   하위-하위-하위… 이런식으로도 만들 수 있게"*). 뿌리를 보고 있으면 뿌리에.
      await newFolder(ws, folder === ALL ? name : `${folder}/${name}`);
    } catch (e) {
      toast(String(e), "warn");
    }
  };

  const removeFolder = async (path: string, count: number) => {
    // ★그림이 든 폴더는 서버가 거절한다. 여기서 먼저 알려 주는 편이 눌러 보고 실패하는 것보다 낫다
    if (count > 0) return toast(t("gallery.folderNotEmpty"), "warn");
    if (!(await ask({ title: t("gallery.folderDelConfirm", { name: path }), ok: t("common.delete"), cancel: t("common.cancel") })))
      return;
    try {
      await dropFolder(ws, path);
    } catch (e) {
      toast(String(e), "warn");
    }
  };

  // ★서버가 주는 첫 줄(`path: ""`)이 **전체**다 — 그걸 그대로 쓴다.
  //   따로 더하면 하위 폴더가 두 번 세어지고, 이름 없는 빈 줄이 하나 더 생긴다
  //   (실측 2026-08-05: 3장짜리 폴더 하나에 전체가 6으로 뜨고 무명 줄이 붙었다).
  const total = folders.find((f) => f.path === ALL)?.count ?? 0;
  const rest = folders.filter((f) => f.path !== ALL);

  return (
    // ★제목은 패널 머리글(Shell)이 이미 달고 있다 — 여기서 또 적으면 두 겹이 된다
    <div
      /* ★★그림을 끌 때 **이 영역을 어둠 위로 올린다** (사용자 지적 2026-08-23: 폴더 트리가
         어두워서 안 보였다). `DragLayer` 가 화면에 어둠을 까는데, 받는 자리는 그 위로
         올라와야 한다 — CLAUDE.md 「드롭 표시는 하나의 양식이다」의 첫 번째 겹이다.
         ★올리는 것은 **영역 전체**다. 줄마다 올리면 줄 사이 여백이 어두운 채로 남는다. */
      data-spot={lift ? "" : undefined}
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        minHeight: 0,
        ...(lift ? { position: "relative" as const, zIndex: 31, background: "var(--bg)" } : {}),
      }}
    >
      <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "var(--sp-2) var(--sp-2) var(--sp-3)" }}>
        {/* ★★첫 줄이 **뿌리 폴더 그 자체**다 (사용자 지시 2026-08-23).
            이름도 실제 폴더와 같은 `gallery` 이고, **떨구면 최상위로 올라온다**.
            ★따로 있던 「폴더 밖으로」 줄을 걷은 자리다 — 뿌리로 되돌리는 자리가 둘이면
              어느 것이 무엇인지 헷갈린다. 같은 일은 한 줄이 한다. */}
        <Row
          label={t("gallery.all")}
          count={total}
          on={folder === ALL}
          onClick={() => void setFolder(ws, ALL)}
          onDropFiles={(files) => void moveFiles(files, ALL)}
          onDropFolder={(src) => void moveFolderTo(src, ALL)}
        />
        {/* ★나머지는 뿌리의 **하위**다 — 깊이만큼 들여쓴다 (사용자 지시 2026-09-06) */}
        {rest.map((f) => (
          <Row
            key={f.path}
            /* ★줄에는 **그 폴더 이름만** 적는다 (사용자 지시 2026-09-07: "상위 폴더 이름 다 쓰지말고 해당
               폴더명만") — 들여쓰기가 이미 어디에 속하는지 말한다. 열쇠·이동·삭제는 그대로 전체 경로다. */
            label={f.path.split("/").pop() ?? f.path}
            depth={f.path.split("/").length}
            count={f.count}
            on={folder === f.path}
            onClick={() => void setFolder(ws, f.path)}
            onDelete={() => void removeFolder(f.path, f.count)}
            onRename={(next) => void renameFolderTo(f.path, next)}
            onDropFiles={(files) => void moveFiles(files, f.path)}
            onDropFolder={(src) => void moveFolderTo(src, f.path)}
            dragPath={f.path}
          />
        ))}

        {/* ★★**바이브 칸** (사용자 지시 2026-08-25: *"v2에 있던 바이브 캐시 저장해 두는
            공간이 사라졌음 … 갤러리 쪽에 vibe 전용 공간 만들어서 거기에 보관"*).
            구워 둔 인코딩은 **Anlas 로 산 자산**이라 잃으면 다시 지불한다 — 그림 폴더와
            같은 자리에서 늘 보이는 편이 맞다.
            ★예전에는 이미지 입력 패널의 작은 단추 하나뿐이었고, 그 칸은 **모델이 바이브를
              안 받으면 통째로 사라진다**(V5). 그래서 캐시로 가는 길까지 함께 없어졌다.
            ★폴더가 아니다 — 워크스페이스 밖의 전역 자산이라(`data/vibe-cache`) 옮기기·
              지우기 규칙이 폴더와 다르다. 목록에서 한 칸 띄워 둔다. */}
        <button
          data-keep-vibe
          data-on={vibeMode ? "" : undefined}
          onClick={() => setVibeMode(!vibeMode)}
          style={{
            display: "flex",
            alignItems: "center",
            gap: "var(--sp-2)",
            width: "100%",
            marginTop: "var(--sp-2)",
            padding: "var(--sp-2) var(--sp-3)",
            borderRadius: "var(--r-2)",
            border: `1px solid ${vibeMode ? "var(--accent)" : "transparent"}`,
            background: vibeMode ? "var(--accent-bg)" : "transparent",
            fontSize: "var(--text-xs)",
            color: vibeMode ? "var(--ink)" : "var(--ink-soft)",
          }}
        >
          <span style={{ display: "grid", color: "var(--ink-faint)" }}>{Icon.duplicate}</span>
          {t("imgIn.cacheTitle")}
        </button>

        {/* ★앱 안에서 하위 폴더를 만들 길 (v2 `POST /api/gallery/folders`).
            전에는 탐색기로 나가야만 폴더를 만들 수 있었다 (v2-port-audit C6). */}
        {adding === null ? (
          <button
            data-keep-newfolder
            onClick={() => {
              draft.current = "";
              setAdding("");
            }}
            style={{
              display: "flex",
              alignItems: "center",
              gap: "var(--sp-2)",
              width: "100%",
              marginTop: "var(--sp-2)",
              padding: "5px var(--sp-3)",
              borderRadius: "var(--r-2)",
              color: "var(--ink-faint)",
              fontSize: "var(--text-xs)",
              textAlign: "left",
            }}
          >
            {Icon.plus}
            {t("gallery.newFolder")}
          </button>
        ) : (
          <input
            data-keep-newfolder-input
            autoFocus
            value={adding}
            placeholder={t("gallery.newFolderHint")}
            onChange={(e) => {
              draft.current = e.target.value;
              setAdding(e.target.value);
            }}
            onBlur={() => void addFolder()}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !composing(e)) e.currentTarget.blur();
              else if (e.key === "Escape") {
                draft.current = "";
                setAdding(null);
              }
            }}
            style={{
              width: "100%",
              marginTop: "var(--sp-2)",
              padding: "5px var(--sp-3)",
              borderRadius: "var(--r-2)",
              border: "1px solid var(--accent)",
              background: "var(--panel)",
              color: "var(--ink)",
              fontSize: "var(--text-xs)",
            }}
          />
        )}
      </div>

      <div
        style={{
          flexShrink: 0,
          display: "flex",
          alignItems: "center",
          gap: "var(--sp-2)",
          padding: "var(--sp-2) var(--sp-3)",
          borderTop: "1px solid var(--line-soft)",
          fontSize: "var(--text-2xs)",
          color: "var(--ink-faint)",
        }}
      >
        {/* ★숫자만 두면 무엇의 개수인지 알 수 없다 — 지금 보고 있는 범위를 함께 적는다 */}
        <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {folder === ALL ? t("gallery.all") : folder} · {t("gallery.countImages", { n: items.length })}
        </span>
        {/* 보관함은 앱 밖에서도 들여다보는 폴더다 — 지금 보고 있는 폴더를 그대로 연다 */}
        <FolderOpenButton
          data-keep-openfolder
          tip={t("files.reveal")}
          onClick={() => void reveal(folder).catch((e) => toast(String(e), "warn"))}
        />
      </div>
    </div>
  );
}

function Row({
  label,
  depth = 0,
  count,
  on,
  onClick,
  onDelete,
  onRename,
  onDropFiles,
  onDropFolder,
  dragPath,
}: {
  label: string;
  /** 트리 깊이 — 뿌리 0, 그 아래 폴더 1, `a/b` 는 2. 들여쓰기만 정한다 */
  depth?: number;
  count: number;
  on: boolean;
  onClick: () => void;
  /** 없으면 지우는 단추가 안 뜬다 (전체 줄) */
  onDelete?: () => void;
  /** 있으면 **줄을 두 번 눌러 이름을 고친다** (사용자 지시 2026-09-10). 뿌리 줄에는 없다 */
  onRename?: (next: string) => void;
  /** ★그림을 끌어다 놓으면 **이 폴더로 옮긴다** (사용자 지시 2026-08-19).
   *  없으면 받지 않는다 (「전체」는 폴더가 아니라 보기라 받을 자리가 없다 — 뿌리로 옮기는
   *  것은 「전체」가 아니라 뿌리 폴더 줄이 받아야 뜻이 분명하다). */
  onDropFiles?: (files: string[]) => void;
  /** 폴더를 끌어다 놓으면 **이 폴더 아래로** 옮긴다 (사용자 지시 2026-09-06) */
  onDropFolder?: (src: string) => void;
  /** 있으면 이 줄을 **끌 수 있다** (뿌리 줄은 없다 — 뿌리는 옮길 데가 없다) */
  dragPath?: string;
}) {
  const t = useI18n((s) => s.t);
  const startDrag = useDragSource();
  /** ★앱의 포인터 끌기를 받는다 — HTML5 드롭은 Tauri 가 가로채 안 온다 (`cards/dragStore`) */
  const zone = useDropZone({
    /* ★★열쇠는 **전체 경로**여야 한다. 줄에 적는 이름(`label`)은 마지막 조각뿐이라
       (2026-09-07 부터), 그것으로 열쇠를 만들면 상위가 다른 같은 이름의 폴더 둘이 **한 열쇠**를
       나눠 갖는다 — 떨구면 `dragStore.end` 가 먼저 등록된 쪽을 찾아 **엉뚱한 폴더로 들어간다.** */
    id: `keep-folder-${dragPath ?? ""}`,
    kind: "keep",
    prio: 10,
    onDrop: (d) => {
      if (d.folder !== undefined) onDropFolder?.(d.folder);
      else if (d.files?.length) onDropFiles?.(d.files);
    },
  });
  // 폴더는 `work/유나/포즈1` 처럼 계층이라, 마지막 조각을 굵게 두고 앞은 흐리게 둔다
  const parts = label.split("/");
  const leaf = parts.pop()!;
  /** 이름 고치기 — ★규칙은 **앱에 하나**다 (`useRename`): Enter 저장 · Esc 취소 · 밖을 누르면 저장 */
  const rename = useRename(leaf, (v) => onRename?.(v));
  /** ★★**더블클릭을 직접 센다.** 이 줄은 끌기 출발점이라 pointerdown 에서 기본 동작을 막고,
   *  그러면 브라우저의 click·dblclick 이 오지 않는다 (갤러리 칸과 같은 사정). 간격은 500ms. */
  const lastTap = useRef(0);
  const tap = () => {
    if (!onRename) return onClick();
    const now = Date.now();
    const dbl = now - lastTap.current < 500;
    lastTap.current = dbl ? 0 : now;
    if (dbl) rename.toggle();
    else onClick();
  };
  return (
    <div
      // ★지우는 단추는 **커서를 올렸을 때만** 보인다 (globals.css `*:hover > .thumb-star` 와 같은 요령).
      //   늘 보이면 폴더 목록이 단추 줄로 읽힌다.
      className="keep-folder-row"
      data-keep-folder-row={label}
      ref={zone.ref}
      style={{
        display: "flex",
        alignItems: "center",
        borderRadius: "var(--r-2)",
        outline: zone.over ? "1px solid var(--accent)" : undefined,
        background: zone.over ? "var(--accent-bg)" : undefined,
      }}
    >
    {rename.editing ? (
      /* ★★**편집 중에는 줄을 통째로 입력칸으로 바꾼다.** `<button>` 안에 `<input>` 을 넣으면
         단추가 누름을 먼저 가져가 글자를 못 친다 (HTML 이 금지하는 겹침이다). */
      <input
        data-keep-folder-rename={label}
        {...rename.inputProps}
        style={{
          flex: 1,
          minWidth: 0,
          padding: "5px var(--sp-3)",
          paddingLeft: `calc(var(--sp-3) + ${depth * 14}px)`,
          borderRadius: "var(--r-2)",
          border: "1px solid var(--accent)",
          background: "var(--panel)",
          color: "var(--ink)",
          fontSize: "var(--text-xs)",
        }}
      />
    ) : (
    <button
      /* ★끌 수 있는 줄은 **포인터 판**으로 시작한다 (`useDragSource`). pointerdown 의 preventDefault 가
         click 을 삼키므로 누르기는 onTap 으로 받는다 — 뿌리 줄은 끌지 않으니 onClick 그대로. */
      onClick={dragPath === undefined ? onClick : undefined}
      onPointerDown={dragPath === undefined ? undefined
        : (e) => startDrag(e, { dir: "apply", kind: "keep", folder: dragPath }, undefined, tap)}
      data-tip={label}
      style={{
        ...(dragPath === undefined ? {} : dragSourceStyle),
        display: "flex",
        alignItems: "baseline",
        gap: "var(--sp-2)",
        width: "100%",
        padding: "5px var(--sp-3)",
        paddingLeft: `calc(var(--sp-3) + ${depth * 14}px)`,
        borderRadius: "var(--r-2)",
        background: on ? "var(--surface2)" : "transparent",
        color: on ? "var(--ink)" : "var(--ink-dim)",
        fontSize: "var(--text-xs)",
        textAlign: "left",
      }}
    >
      <span
        style={{
          flex: 1,
          minWidth: 0,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {parts.length > 0 && (
          <span style={{ color: "var(--ink-faint)" }}>{parts.join("/")}/</span>
        )}
        <span style={{ fontWeight: on ? "var(--w-semi)" : "var(--w-normal)" }}>{leaf}</span>
      </span>
      <span style={{ fontFamily: "var(--font-mono)", fontSize: "var(--text-2xs)", color: "var(--ink-faint)" }}>
        {count}
      </span>
    </button>
    )}
    {onDelete && (
      <button
        data-keep-folder-del={label}
        className="keep-folder-del"
        onClick={onDelete}
        data-tip={t("gallery.folderDelete")}
        style={{ display: "grid", placeItems: "center", padding: "2px 4px", color: "var(--ink-faint)" }}
      >
        {Icon.trash}
      </button>
    )}
    </div>
  );
}

