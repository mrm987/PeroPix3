import { useEffect, useRef, useState } from "react";
import { useI18n } from "../i18n";
import { useDragSource, dragSourceStyle } from "../cards/dragStore";
import { useGen } from "../store/gen";
import { useWs, takesOfScene, allCells, allScenes, type ShotEnv } from "../store/workspace";
import { SceneLane, takeSrc } from "./SceneLane";
import { useSceneFocus } from "../store/sceneFocus";
import { runningPendingId, stepKey, useQueue } from "../store/queue";
import { removeTakes, stepTake } from "../lib/sceneTakes";
import { useUi } from "../store/ui";
import { CanvasTabs } from "./CanvasTabs";
import { imgUrl } from "../lib/imgUrl";
import { Icon } from "../components/Icon";
import { toast } from "../store/toast";
import { ImageActions } from "./ImageActions";
import { useConvertQueue } from "./tools/ConvertTool";
import { MaskEditor } from "../components/MaskEditor";
import { useImageInput } from "../store/imageInput";
import { EnhanceDialog } from "./EnhanceDialog";
import { useGallery, type ImageMeta } from "../store/gallery";
import { usePreviews, withPreviews, isPreviewFile } from "../store/previews";
import { api } from "../lib/backend";
import { wheelIsOver } from "../lib/wheelAt";
import {
  canPan,
  centerPan,
  clampPan,
  drawSize,
  fitScale,
  percent,
  type Pan,
} from "../lib/zoomView";
/* ★배율을 정하는 일은 **자리(pan)를 아는 곳**에 있다 (`store/previewBox`) — 조절 단추가
   이 파일의 다른 줄로 내려가면서, 계산도 둘이 함께 읽는 자리로 옮겼다 (2026-08-25) */
import { bumpZoom, setZoom, usePreviewBox } from "../store/previewBox";
import { applyMetaParams, applyMetaVibes } from "./GalleryMeta";
import { hasMeta } from "../lib/metaApply";
import { CharPositioner } from "./CharPositioner";

/** 캔버스 — 씬 세트 줄 + 씬 무대 (마스크를 칠하는 동안에는 그 자리가 편집기다).
 *
 *  ★우하단 카드 핸드는 걷었다 (2026-08-16) — 덱이 오른쪽 기둥에 상시로 있다.
 *  ★**싱글 화면은 없다** (사용자 결정 2026-08-11). 탭은 언제나 씬 탭이다 — 옛 싱글 탭을
 *    옮겨 주던 길도 2026-08-24 에 걷었다. 큰 그림·히스토리 줄·별표만 보기가
 *    있던 자리는 `SceneLane` + `ScenePreview` + `SceneActions` 가 이어받았다. */
export function Canvas() {
  const { activeSceneGroup } = useWs();
  /** ★마스크를 칠하는 동안 **이 자리가 편집기로 바뀐다** (사용자 결정 2026-08-13).
   *  모달로 띄우면 칠하는 동안 프롬프트도 결과도 못 본다. 생성 버튼은 그동안 「인페인트」다. */
  const editing = useImageInput((s) => s.editing);
  const tab = activeSceneGroup();
  if (!tab) return null;

  return (
    <div
      style={{
        flex: 1,
        display: "flex",
        flexDirection: "column",
        minHeight: 0,
        position: "relative",
      }}
    >
      {/* ★씬 세트 줄 — 이 층이 가르는 것이 바로 아래 결과라 여기 붙는다 (사용자 제안 2026-08-05) */}
      <CanvasTabs part="sceneGroups" />

      {/* ★씬 칸 (2026-08-11) — 그릇 + 얹은 카드 + 씬 줄. 위는 **고른 한 장**의 프리뷰다 */}
      {editing ? <MaskEditor /> : <SceneStage />}

      {/* ★생성 바는 **좌측 프롬프트 패널 아래**로 옮겼다 (사용자 지시 2026-08-04).
          시드·장 수·Anlas 와 한자리에 있어야 누르기 전에 판단이 선다 — `GenerateFooter`. */}
    </div>
  );
}

/** 씬 무대 — **고른 한 장**과 **씬 칸**을 함께 놓는다.
 *
 *  ★★놓는 방향이 둘이다 (사용자 지시 2026-08-22, `useUi.laneSide`):
 *      `bottom`  위에 큰 그림, 아래에 씬 줄 — 지금까지의 모습
 *      `right`   **세로 모드** — 가운데를 좌우로 양분해 씬을 오른쪽으로 보낸다.
 *                세로로 긴 그림은 아래에 줄이 누우면 그만큼 작아지는데, 옆으로 보내면
 *                높이를 다 쓴다. 「우측 패널처럼」이라는 말이 그 뜻이다.
 *    ★가르는 손잡이도 방향을 따라간다 (아래는 `row-resize`, 옆은 `col-resize`).
 *    ★두 모습이 **같은 컴포넌트를 그대로 쓴다** — 씬 줄을 세로용으로 따로 만들지 않는다.
 *      만들면 고칠 때마다 두 벌을 맞춰야 한다.
 *
 *  ★씬 칸은 **빈 자리를 남기지 않는다** — 내용이 짧으면 그만큼으로 줄어든다. 다만 카드가
 *    하나도 없을 때는 안 줄인다: 그릇이 있다는 것과 「씬 카드 추가하기」가 설 자리가 필요하다. */
function SceneStage() {
  const { laneHeight, setLaneHeight, laneWidth, setLaneWidth, laneSide } = useUi();
  const grip = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const side = laneSide === "right";

  /** 손잡이를 끄는 동안 크기를 따라 바꾼다 — 놓을 때 한 번만 저장한다(`commitLayout`) */
  const drag = (e: React.PointerEvent) => {
    grip.current?.setPointerCapture(e.pointerId);
    dragging.current = true;
    if (grip.current) grip.current.style.background = "var(--accent)";
    const p0 = side ? e.clientX : e.clientY;
    const s0 = side ? laneWidth : laneHeight;
    // 씬은 오른쪽·아래에 있으므로 **거슬러 끌면 커진다**
    const move = (ev: PointerEvent) =>
      side ? setLaneWidth(s0 + (p0 - ev.clientX)) : setLaneHeight(s0 + (p0 - ev.clientY));
    const up = () => {
      grip.current?.removeEventListener("pointermove", move);
      grip.current?.removeEventListener("pointerup", up);
      dragging.current = false;
      if (grip.current) grip.current.style.background = "transparent";
      useUi.getState().commitLayout();
    };
    grip.current?.addEventListener("pointermove", move);
    grip.current?.addEventListener("pointerup", up);
  };

  /** 씬 줄과 큰 그림 사이의 **크기 손잡이**.
   *
   *  ★★**보이는 것을 전부 걷었다** (사용자 지시 2026-08-26: *"씬 경계선도 없애 줘. 그냥 다른
   *    패널들처럼 패널의 끝부분을 핸들러로 쓰면 됨. 강조 효과가 들어가니까 확실함"*).
   *    알갱이 → 경계선 → 아무것도 없음 순으로 걷어 왔다. 자리를 차지하는 표식이 없어도
   *    **손을 대면 물드는 것**이 「여기를 끌 수 있다」를 대신 말한다.
   *  ★모습·두께·물드는 색을 `ResizeHandle`(생성 패널)과 맞춘다 — 화면 안에서 크기를 바꾸는
   *    자리는 전부 같아 보여야 한다. 이쪽만 다른 규칙을 두지 않는다. */
  const handle = (
    <div
      ref={grip}
      data-lane-grip={side ? "col" : "row"}
      onPointerDown={drag}
      onPointerEnter={(e) => {
        if (!dragging.current) e.currentTarget.style.background = "var(--accent-line)";
      }}
      onPointerLeave={(e) => {
        if (!dragging.current) e.currentTarget.style.background = "transparent";
      }}
      style={{
        flexShrink: 0,
        zIndex: 2,
        background: "transparent",
        transition: "background 0.12s",
        /* ★★**세로 모드는 자리를 안 먹는다** (사용자 지적 2026-08-26: *"세로 모드일 때의
             이미지와 씬 사이 간격이 또 너무 넓어짐"*). 좌우로 나뉜 자리는 예전에 **선 하나**로
             갈려 있었으므로, 그 자리에 5px 을 흘려 넣으면 그만큼 벌어진 것으로 읽힌다.
             음수 여백으로 양쪽에 걸쳐 두면 **잡히는 넓이는 5px 그대로**이고 자리는 1px 이다.
           ★아래 모드는 그대로 5px 을 먹는다 — 큰 그림과 씬 줄이 위아래로 맞닿으면 한 덩이로
             읽힌다는 지적이 먼저 있었다 (같은 날). 두 방향의 알맞은 간격이 서로 다르다. */
        ...(side
          ? { width: 5, margin: "0 -2px", cursor: "col-resize" }
          : { height: 5, cursor: "row-resize" }),
      }}
    />
  );

  const lane = (
    <div
      style={{
        flexShrink: 0,
        display: "flex",
        minHeight: 0,
        minWidth: 0,
        ...(side ? { width: laneWidth } : { height: laneHeight }),
      }}
    >
      <SceneLane />
    </div>
  );

  if (side)
    return (
      <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "row" }}>
        {/* 왼쪽 — 큰 그림과 그 아래 한 줄 */}
        <div style={{ flex: 1, minWidth: 0, minHeight: 0, display: "flex", flexDirection: "column" }}>
          <ScenePreview />
          <SceneActions />
        </div>
        {handle}
        {lane}
      </div>
    );

  return (
    <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
      <ScenePreview />
      <SceneActions />
      {handle}
      {lane}
    </div>
  );
}

/** 그림 **바로 아래** 한 줄 — 저장·강화·삭제·갤러리 보관.
 *
 *  ★싱글 화면이 없어지면서 갈 곳이 사라진 것들이라 여기로 옮겼다 (CLAUDE.md 의
 *    「시안에 없다고 지우면 안 되는 것이 있었다」 — 화면을 갈아 끼울 때마다 밟는 자리다). */
function SceneActions() {
  const tr = useI18n((s) => s.t);
  /** 씬을 오른쪽에 두는 모드인가 — 아래 여백이 그때만 필요하다 (반환 자리의 ★★주) */
  const vert = useUi((u) => u.laneSide === "right");
  const { base } = useGen();
  const { current: ws, records, addRecord } = useWs();
  const file = useSceneFocus((s) => s.file);
  /** 지금 지우면 몇 장이 가나 — ★**구독해서 읽는다.** 씬 줄에서 고른 것이 늘고 줄면
   *  이 줄의 안내도 따라 바뀌어야 한다 (`getState()` 로만 읽으면 다시 안 그린다). */
  const picked = useSceneFocus((s) => s.picked);
  const many = picked.length;
  /** ★다중 처리 대상 — 미저장(미리보기)은 파일이 없어 뺀다 (사용자 지시 2026-08-29) */
  const multiFiles = picked.filter((f) => !isPreviewFile(f));
  const previews = usePreviews((s) => s.items);
  const [enhance, setEnhance] = useState<string[] | null>(null);
  /* ★★**해상도는 프리뷰가 잰 값 그대로**다 (`store/previewBox` 의 `nat`, 2026-08-25).
     예전에는 여기 `dims` 라는 별도 상태를 두었는데 **채우는 곳이 없어 영영 안 떴다** —
     실제 크기는 하나뿐이니 재는 곳도 하나여야 한다 (사용자 지시: *"생성된 이미지 하단에
     해당 이미지의 해상도도 표기. 시드 옆에"*). */
  const nat = usePreviewBox((s) => s.nat);
  const dims = nat.w ? nat : null;
  const [saving, setSaving] = useState(false);
  if (!file) return null;

  /** ★★미저장 그림에도 **같은 줄**이 붙는다 (사용자 지시 2026-08-19).
   *
   *  예전에는 「파일로 저장 · 미리보기 지우기」 둘만 냈다. 미저장은 **아직 파일이 아닐 뿐**
   *  같은 그림이라, 할 수 있는 일도 같아야 한다. 갈리는 것은 둘뿐이다:
   *    · 「삭제」 자리에 **「저장」** 이 선다 (저장하면 그 줄이 그대로 「삭제」가 된다)
   *    · 저장 안 한 동안만 **「미리보기 지우기」**가 하나 더 선다
   *  ★서버의 파일을 다루는 것(강화·업스케일·보관·탐색기·새 탭으로 복제)은 **먼저 저장하고**
   *    이어서 한다 (`ensureSaved`). 눌러야 실패하는 단추를 두지 않는다는 규칙 그대로다.
   *  ★읽기만 하는 것(프롬프트 보기·설정)은 **저장하지 않는다** — 바이트를 그대로 보내
   *    메타데이터만 읽는다 (`/api/tools/meta-upload`). 훑어보다 저장돼 버리면
   *    「자동 저장 끄기」의 뜻이 사라진다. */
  const un = previews.find((x) => x.file === file);
  const dropPreview = () => {
    usePreviews.getState().drop(file);
    useSceneFocus.getState().focus(useSceneFocus.getState().cell, null);
  };
  const savePreview = async () => {
    const rec = await usePreviews.getState().save(file);
    // ★저장한 그 장을 **그대로 보고 있게** 한다 — 미리보기가 빠지면서 화면이 비면
    //   방금 무엇을 저장했는지 알 수 없다
    addRecord(rec);
    useSceneFocus.getState().focus(useSceneFocus.getState().cell, rec.file);
    return rec.file;
  };
  /** 파일이 있어야 하는 일 앞에 부른다. 미저장이면 저장하고 **새 경로**를 돌려준다 */
  const ensureSaved = async (): Promise<string | null> => {
    if (!un) return file;
    setSaving(true);
    try {
      const f = await savePreview();
      toast(tr("scenes.savedToast", { name: f.split("/").pop() ?? f }));
      return f;
    } catch (e) {
      toast(String(e), "warn");
      return null;
    } finally {
      setSaving(false);
    }
  };

  const rec = records.find((r) => r.file === file);
  /** ★미저장이면 **바이트를 보내** 읽는다 — 저장하지 않는다 (위 주석) */
  const loadMeta = async () => {
    if (un) {
      const bin = Uint8Array.from(atob(un.preview.b64), (c) => c.charCodeAt(0));
      const fd = new FormData();
      fd.append("file", new Blob([bin], { type: `image/${un.preview.fmt}` }), "preview.png");
      const r = await api<{ meta: ImageMeta | null }>("/api/tools/meta-upload", { method: "POST", body: fd });
      return r.meta;
    }
    return (
      await api<{ meta: ImageMeta | null }>(
        `/api/gallery/${encodeURIComponent(ws)}/meta?file=${encodeURIComponent(file)}`,
      )
    ).meta;
  };

  /** 「새 탭으로 복제」 — **그 그림을 그대로 다시 뽑을 수 있는** 탭을 만든다.
   *
   *  ★★기준은 하나다: **그 그림을 뽑을 때의 구조를 그대로 재현한다**
   *    (사용자 지시 2026-08-19: *"스타일/캐릭터/슬롯 구조 그대로 재현"*).
   *    나뉘어 온다:
   *      구조 → **그 그림이 나온 탭과 씬**에서 (`cloneToNewTab`, 레코드의 `scene_group_id`·`cell_id`)
   *             스타일 카드 · 베이스/네거티브 블록 · **캐릭터 카드** ·
   *             그 씬의 블록 · **카드 공통 접두** · 씬 프롬프트 목적지
   *             ★접두와 목적지를 빼면 같은 씬이라도 **다른 프롬프트가 나간다** (`gen.ts` 참조)
   *      값   → **그 그림의 메타데이터**에서
   *             생성 설정 · 해상도 · **시드** · **바이브**(인코딩이 남아 다시 안 굽는다)
   *  ★★구조를 메타데이터에서 되살리려 하지 말 것. NAI 는 **합쳐진 문자열**만 저장해서
   *    블록이 한 덩어리로 뭉치고 캐릭터가 `#1`·`#2` 로 다시 만들어지며 스타일 카드도 사라진다.
   *    (한 번 그렇게 만들었다가 되돌렸다.)
   *  ★메타데이터를 **먼저** 읽는다. 탭을 만들고 나서 실패하면 되돌릴 자리가 없다.
   *  ★메타데이터가 없는 그림이면 값은 지금 것이 남는다 — 구조는 그래도 그 탭 것이 온다. */
  const cloneToNewTab = async () => {
    /* ★여러 장 골랐으면 **한 새 탭의 같은 씬**에 테이크로 쌓인다 (사용자 지시 2026-08-29).
       구조·설정은 첫 장이 세운다 — 메타데이터 적용(apply)은 보는 장과 첫 장이 다를 수 있어
       건너뛴다 (환경 스냅샷이 있는 그림은 그것으로 충분하다). */
    if (multiFiles.length > 1) {
      try {
        const landed = await useWs.getState().cloneToNewTab(multiFiles[0], {
          excludeNo: useGen.getState().params.exclude_slot_number,
          extraFiles: multiFiles.slice(1),
        });
        if (!landed) return;
        useSceneFocus.getState().focus(landed.cell, landed.file);
        toast(tr("act.cloned"));
      } catch (e) {
        toast(String(e), "warn");
      }
      return;
    }
    try {
      const m = await loadMeta().catch(() => null);
      // ★구조는 **레코드**에서 온다 — 미저장이면 먼저 파일로 남겨야 그 자리가 생긴다
      const target = await ensureSaved();
      if (!target) return;
      const landed = await useWs.getState().cloneToNewTab(target, {
        excludeNo: useGen.getState().params.exclude_slot_number,
        apply: hasMeta(m)
          ? () => {
              applyMetaParams(m!);
              // 이미지 입력도 환경이다 — 바이브는 메타데이터에 인코딩이 남아 되살릴 수 있다
              applyMetaVibes(m!);
            }
          : undefined,
      });
      if (!landed) return;
      // ★새 탭의 씬 줄은 탭이 바뀔 때 고른 것을 놓는다 — 그 뒤에 세워야 남는다
      useSceneFocus.getState().focus(landed.cell, landed.file);
      toast(tr("act.cloned"));
    } catch (e) {
      toast(String(e), "warn");
    }
  };

  return (
    /* ★★**세로 모드에서는 아래도 띄운다** (사용자 지시 2026-08-26: *"이미지 하단의 편집
       버튼들이 하단 모드랑 딱 붙어 있음"*). 아래 모드에서는 이 줄 밑에 **씬 줄**이 이어져
       그것이 간격 노릇을 하는데, 세로 모드에서는 씬이 오른쪽으로 가 버려 이 줄이 곧
       하단바와 맞닿는다. 아래를 0 으로 둔 것은 그 전제 위의 값이었다. */
    <div style={{ flexShrink: 0, padding: vert ? "var(--sp-3) var(--sp-4)" : "var(--sp-3) var(--sp-4) 0" }}>
      <ImageActions
        url={un ? `data:image/${un.preview.fmt};base64,${un.preview.b64}` : imgUrl(base, ws, file, rec?.ts)}
        name={un ? tr("scenes.unsaved") : file.split("/").pop() ?? file}
        seed={(un ?? rec)?.seed ?? 0}
        loadMeta={loadMeta}
        /* ★설정 불러오기도 **그때 구조**를 쓴다 (사용자 지적 2026-08-19: 블록이 한 뭉텅이로 왔다).
           미저장 그림에는 레코드가 없어 스냅샷도 없다 — 그때는 메타데이터로 떨어진다. */
        loadEnv={
          un
            ? undefined
            : async () =>
                (
                  await api<{ env: ShotEnv | null }>(
                    `/api/workspaces/${encodeURIComponent(ws)}/env?file=${encodeURIComponent(file)}`,
                  )
                ).env
        }
        /* ★★베이스 이미지도 **그때 것**을 되살린다 (사용자 지시 2026-08-22). 그림에는 안 남고
             보낸 페이로드 기록에만 있다 (`GalleryMeta` 의 `applyRecordedBase` ★주).
           ★미저장 그림에는 레코드가 없어 가져올 것도 없다 — `loadEnv` 와 같은 규칙이다. */
        loadBase={
          un
            ? undefined
            : async () =>
                await api<{ image?: string }>(
                  `/api/workspaces/${encodeURIComponent(ws)}/base?file=${encodeURIComponent(file)}`,
                )
        }
        onClone={cloneToNewTab}
        /* ★배율 조절 — 그림 위 겹침에서 이 줄의 **오른쪽**으로 (`ViewZoom` 머리 주석) */
        right={<ViewZoom />}
        dims={dims}
        /* ★미저장이면 누를 때 저장하고 그 경로로 연다 (`revealPath` 는 함수도 받는다) */
        revealPath={un ? async () => { const f = await ensureSaved(); return f && `${ws}/${f}`; } : `${ws}/${file}`}
        ensureFile={un ? ensureSaved : undefined}
        /* ★여러 장 골랐으면 **전부** (사용자 지시 2026-08-29) — 인핸스 대화상자는 원래 배치다 */
        onEnhance={async () => {
          if (multiFiles.length > 1) return setEnhance(multiFiles);
          const f = await ensureSaved();
          if (f) setEnhance([f]);
        }}
        upscale={{ ws, file, files: multiFiles.length > 1 ? multiFiles : undefined }}
        multi={multiFiles.length}
        onKeep={async () => {
          /* ★누르면 언제나 보관이다 — 무르기(토글)는 걷어냈다 (사용자 결정 2026-08-29:
             *"넣기가 빼기로 변하는 게 비직관적"*). 여러 장 골랐으면 전부 보관한다.
             보관한 뒤에는 갤러리로 데려간다 — 일괄 변환 보내기와 같은 어법. */
          try {
            const files = multiFiles.length > 1 ? multiFiles : [await ensureSaved()].filter((x): x is string => !!x);
            if (!files.length) return;
            for (const f of files) await useGallery.getState().keep(ws, f);
            toast(tr("gallery.kept"));
            useUi.getState().setMode("gallery");
          } catch (e) {
            toast(String(e), "warn");
          }
        }}
        /* ★일괄 변환으로 보내기 (사용자 지시 2026-08-29: *"생성하고 바로 메타데이터 지워서
             쓰게"*) — 파일 관리의 「일괄 이름 변환으로 보낸다」와 같은 창구다 (`useConvertQueue`).
           ★목록을 **교체**한다 (파일 관리와 같은 어법) — 이 버튼은 「지금 이 한 장」의 몸짓이다.
           ★메타 제거 여부는 변환 도구의 체크가 정한다 (설정이 저장되므로 한 번 켜면 유지). */
        onConvert={async () => {
          // ★여러 장 골랐으면 전부 싣는다 (사용자 지시 2026-08-29)
          const files = multiFiles.length > 1 ? multiFiles : [await ensureSaved()].filter((x): x is string => !!x);
          if (!files.length) return;
          useConvertQueue.setState({
            items: files.map((f) => ({ name: f.split("/").pop() ?? f, rel: `${ws}/${f}` })),
          });
          useUi.getState().setMode("utility");
          useUi.getState().setView("tab", "tools", "convert" as never);
        }}
        extra={
          <>
            {/* ★미저장이면 「삭제」 자리에 **「저장」** — 저장하면 이 줄이 그대로 「삭제」가 된다 */}
            {un ? (
              <button
                data-save-preview
                disabled={saving}
                onClick={() => void ensureSaved()}
                data-tip={tr("scenes.saveToFile")}
                style={{ ...rowBtn, color: "var(--warn)", minWidth: 28, justifyContent: "center" }}
              >
                {Icon.save}
              </button>
            ) : (
              <button
                data-scene-delete
                /* ★★**여러 장 골랐으면 전부 지운다** (사용자 지시 2026-08-22).
                     씬 줄의 「숨김」 단추를 걷은 자리가 여기다 — 지우는 창구를 하나로 모은다.
                   ★★`Del` 키와 **같은 규칙**으로 옆 장을 고른다 (`lib/sceneTakes.removeTakes`).
                     전에는 여기서만 `null` 로 비워서, 단추로 지우면 큰 자리가 텅 비었다
                     (사용자 지적 2026-08-21). 규칙은 한 곳에만 둔다. */
                onClick={() => removeTakes()}
                /* ★★**문구를 코드에서 잇지 않는다** (사용자 지적 2026-08-26: *"코드에서 조합하는
                     툴팁이 존재해? 그럼 언어 대응이 안 되는 거 아니야?"*). 조각은 번역돼도
                     **잇는 기호와 어순은 코드에 박혀** 언어를 안 탄다. 갈래마다 열쇠 하나씩이다. */
                data-tip={many > 1 ? tr("canvas.hideManyHint", { n: many }) : tr("canvas.hideHint")}
                style={{ ...rowBtn, color: "var(--err-ink)", minWidth: 28, justifyContent: "center" }}
              >
                {Icon.trash}
              </button>
            )}
            {/* 저장 안 한 동안만 — 파일이 아니라 **화면의 미리보기**를 버린다.
                ★지우개다 — 파일을 지우는 휴지통과 **다른 일**이라 모양도 달라야 한다
                  (v2 도 「미리보기 지우기」에 지우개를 썼다) */}
            {un && (
              <button
                data-drop-preview
                onClick={dropPreview}
                data-tip={tr("scenes.dropPreview")}
                style={{ ...rowBtn, minWidth: 28, justifyContent: "center" }}
              >
                {Icon.eraser}
              </button>
            )}
          </>
        }
      />
      {enhance && <EnhanceDialog files={enhance} onClose={() => setEnhance(null)} />}
    </div>
  );
}

/** 아래 줄의 단추 모양 — `ImageActions` 의 것과 같은 자에 맞춘다 */
const rowBtn: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 3,
  border: "1px solid var(--line)",
  borderRadius: "var(--r-2)",
  background: "var(--panel)",
  padding: "3px var(--sp-3)",
  fontSize: "var(--text-2xs)",
  color: "var(--ink-soft)",
};

/** 고른 한 장 — 씬 칸에서 고른 결과를 크게. 아무것도 안 골랐으면 안내만 */
/** 보기 컨트롤의 단추 하나 — 켜진 것은 강조색 테두리 (앱의 다른 2택과 같은 규칙) */
function ViewBtn({
  on,
  tip,
  onClick,
  children,
}: {
  on?: boolean;
  tip?: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      data-view-btn
      data-tip={tip}
      onClick={onClick}
      style={{
        padding: "2px 8px",
        borderRadius: "var(--r-1)",
        fontSize: "var(--text-2xs)",
        lineHeight: 1.6,
        cursor: "pointer",
        /* ★★`border` 는 **줄임으로 한 벌** 쓴다 — 낱개(`borderColor`)만 덮으면 끌 때 색이
             `currentColor` 로 떨어져 테두리가 안 사라진다 (실측 2026-08-23). */
        border: on ? "1px solid var(--accent)" : "1px solid transparent",
        background: on ? "var(--accent-bg)" : "transparent",
        color: on ? "var(--accent-ink)" : "var(--ink-dim)",
      }}
    >
      {children}
    </button>
  );
}

/** **배율 조절** — 시드가 있는 아래 줄에 선다.
 *
 *  ★★자리를 옮긴 까닭 (사용자 지시 2026-08-25): *"이미지 배율 조정 UI를 아래의 시드 있는
 *    곳으로 내려 줘. **꽉차게 봤을 때 이미지를 가림.**"* 예전에는 그림 오른쪽 아래에
 *    겹쳐 있었는데, 「꽉차게」로 보면 그림이 무대를 꽉 채우므로 겹치는 자리가 곧
 *    **그림 위**였다. 가리지 않는 자리는 그림 **바깥**뿐이다.
 *  ★재는 값은 스토어에서 온다 (`store/previewBox`) — 무대 크기·그림 실제 크기는 프리뷰가
 *    재고, 여기서는 읽기만 한다. */
function ViewZoom() {
  const tr = useI18n((s) => s.t);
  const { nat, box } = usePreviewBox();
  const view = useWs((s) => s.spec?.preview) ?? { fit: true, zoom: 1 };
  const positioning = useUi((u) => u.positioning);
  const fit = view.fit || positioning;
  const scale = fit ? fitScale(box, nat) : view.zoom;
  if (!nat.w) return null;
  return (
    <div
      data-preview-view
      style={{
        display: "flex",
        alignItems: "center",
        gap: 2,
        /* ★★**해상도 표시와 떨어뜨린다** (사용자 지시 2026-08-25: *"해상도 표시랑 너무
           붙어 있음"*). 둘은 성격이 다르다 — 왼쪽은 **이 그림의 값**이고 여기는 **보는 방식**
           이라, 붙어 있으면 한 덩어리로 읽힌다. */
        marginLeft: "var(--sp-4)",
        /* ★배치 중에는 **꽉차게로 잠긴다** — 그때는 흐리게 두어 「지금은 못 만진다」가 보인다 */
        opacity: positioning ? 0.4 : 1,
        pointerEvents: positioning ? "none" : undefined,
      }}
    >
      {/* ★★**아이콘으로 말한다** (사용자 지시 2026-08-25). 글자 둘이 나란히 서면 이 줄에서
          가장 큰 덩어리가 되는데, 정작 자주 누르는 것은 ＋ / − 다. 뜻은 툴팁이 든다. */}
      <ViewBtn on={fit} onClick={() => useWs.getState().setPreview({ fit: true })} tip={tr("scenes.viewFit")}>
        {Icon.fitBox}
      </ViewBtn>
      <ViewBtn
        on={!fit && Math.abs(view.zoom - 1) < 0.001}
        onClick={() => setZoom(1)}
        tip={tr("scenes.viewActual")}
      >
        {Icon.oneToOne}
      </ViewBtn>
      <span style={{ width: 1, height: 16, background: "var(--line)", margin: "0 2px" }} />
      <ViewBtn onClick={() => bumpZoom(-1)} tip={tr("scenes.viewOut")}>
        −
      </ViewBtn>
      {/* ★지금 몇 %인가 — 꽉차게일 때는 **그때 실제 배율**을 보여 준다 (자동이라는 뜻).
          ★고정폭이다 — 100% ↔ 37% 를 오갈 때 옆 단추가 밀리면 눌러 둔 자리를 놓친다 */}
      <span
        data-preview-pct
        style={{
          minWidth: 44,
          textAlign: "center",
          fontSize: "var(--text-2xs)",
          fontFamily: "var(--font-mono)",
          fontVariantNumeric: "tabular-nums",
          color: fit ? "var(--ink-faint)" : "var(--ink)",
        }}
      >
        {`${percent(scale)}%`}
      </span>
      <ViewBtn onClick={() => bumpZoom(1)} tip={tr("scenes.viewIn")}>
        +
      </ViewBtn>
    </div>
  );
}

function ScenePreview() {
  const tr = useI18n((s) => s.t);
  /** 큰 그림을 카드 커버로 끄는 출발점 (`dir: "image"`) */
  const startDrag = useDragSource();
  const { base } = useGen();
  const ws = useWs((s) => s.current);
  const { records, activeSceneGroup, isStarred } = useWs();
  /** ★씨 줄과 **같은 거르기**를 건다 — 줄에서 안 보이는 장이 휠로
   *  넘어오면 둘이 어긋난다 (`lib/sceneTakes` 의 거르기와 같은 규칙) */
  const starOnly = useUi((u) => u.laneStarOnly);
  const cell = useSceneFocus((s) => s.cell);
  const file = useSceneFocus((s) => s.file);
  /** ★만들어지는 중인 칸을 골랐나 — 그때는 **빈 화면**이다 (안내 문구도 안 띄운다) */
  const pendingSel = useSceneFocus((s) => s.pending);
  /** 지금 고른 칸에 **그리는 중인 그림** (`store/queue` 의 `steps`) */
  const stepImg = useQueue((q) => (cell ? (q.steps[stepKey(ws, cell)] ?? "") : ""));
  /** 지금 그리고 있는 대기 칸 — 씬 줄과 **같은 답**을 본다 (`store/queue.runningPendingId`) */
  const runId = useQueue(() => runningPendingId(activeSceneGroup()?.id));
  const previews = usePreviews((s) => s.items);

  /* ★캐릭터 배치 — 큰 그림 위에 판을 겹친다 (`CharPositioner` 머리 주석).
     ★여기는 **판을 놓을 자리만** 안다. 열 수 있는지·스스로 닫히는지는 전부
       `CharPositioner` 가 판정하고, 2택 컨트롤은 캐릭터 프롬프트 카테고리에 선다. */
  const positioning = useUi((u) => u.positioning);

  /** ★휠로 앞뒤 장 (사용자 지시 2026-08-14, 싱글 큰 그림과 같은 조작).
   *
   *  ★**씬 줄에 보이는 순서를 따른다.** 줄은 최신이 왼쪽이므로, 아래로 굴리면
   *    오른쪽(더 오래된 것)으로 간다. 저장 순서로 세면 줄과 반대로 움직인다
   *    (싱글 쪽에서 한 번 밟은 함정이다). */
  const tab = activeSceneGroup();
  const sceneSet = tab?.kind === "sceneGroup" ? tab : null;
  const scene = sceneSet ? allScenes(sceneSet).find((x) => x.cell.id === cell) : null;
  // ★씬 줄과 **같은 창구**로 고른다 — 갈 씬이 없는 결과는 첫 씬이 받으므로(감사 D6),
  //   여기서 `takesOf` 를 쓰면 줄에는 보이는 그림을 휠로 못 넘긴다
  //   ★미저장 그림도 **같은 목록**에 든다 (`withPreviews`) — 줄과 큰 그림이 한 목록을 본다
  const merged = withPreviews(records, ws, previews);
  const shown =
    sceneSet && scene
      ? [...takesOfScene(merged, sceneSet, allCells(sceneSet), scene.cell)]
          .filter((r) => !starOnly || isStarred(r.file))
          .reverse()
      : [];
  /** 지금 띄울 장 — ★**거르기 전 목록**에서 찾는다. 「별표만 보기」를 켜면 보고 있던 장이
   *  줄에서는 빠지는데, 그때 큰 그림까지 못 찾으면 미저장 그림이 깨진 주소로 바뀐다. */
  const cur = merged.find((r) => r.file === file);

  /** ★★**휠은 「생성 중」 칸도 지나간다** (사용자 지시 2026-08-25: *"휠로 이미지 전환할 때
   *  「생성 중」인 걸로는 전환이 안 됨. 클릭으로만 선택됨"*).
   *
   *  ★차례는 **씬 줄과 같아야** 한다 — 대기 칸이 앞(늦게 넣은 것이 먼저), 그다음이 나온 장이다
   *    (`SceneRow` 의 `waits`·`takes`). 줄에서 보이는 차례와 휠이 다르면 넘길 때마다 튄다.
   *  ★대기 칸은 **파일이 없다** — 그래서 목록의 원소를 파일이 아니라 «둘 중 하나»로 든다. */
  /*  ★★**규칙은 `lib/sceneTakes.stepTake` 하나다** (사용자 지적 2026-08-28: *"씬에서 방향키
        좌우 이동으로 이미지 전환할 때 생성 중 이미지로 전환이 안 됨"*).
      여기 휠은 2026-08-25 에 대기 칸을 지나가게 고쳤는데, **씬 줄의 방향키는 따로 적혀 있어**
      파일만 보고 있었다. 같은 지적이 두 번 온 까닭이 그것이다 — 목록도 걸음도 한 곳에 둔다. */
  const step = (d: 1 | -1) => void stepTake(d);

  /* ── 얼마로 볼까 (사용자 지시 2026-08-24) ────────────────────────────────
     ★★설정은 **워크스페이스에 남는다** (`spec.preview`) — *"비율은 워크스페이스 단위로
       유저가 정해둔거 항상 고정"*. 그림마다·탭마다 달라지면 「정해 뒀다」가 성립하지 않는다.
     ★계산은 전부 `lib/zoomView` 다 (순수 함수 · 판정이 붙어 있다). 여기서는 재고, 끌고, 그린다.
     ★보고 있는 **자리**(pan)는 안 남긴다 — 그림마다 다르고, 다음에 열었을 때 엉뚱한 구석을
       보고 있으면 「왜 이러지」가 된다. 배율만 남고 자리는 가운데에서 시작한다. */
  const view = useWs((s) => s.spec?.preview) ?? { fit: true, zoom: 1 };
  const boxRef = useRef<HTMLDivElement | null>(null);
  /* ★★재는 값은 **스토어에 둔다** (`store/previewBox`, 2026-08-25) — 배율 단추가 이 줄이
     아니라 아래 시드 줄로 내려갔고(사용자 지시), 해상도 표시도 같은 값을 읽는다.
     지역 상태로 두면 그 둘이 값을 못 본다. */
  const { box, nat, pan } = usePreviewBox();
  const { setBox, setNat, setPan } = usePreviewBox.getState();
  /** ★배치판이 열려 있으면 **꽉차게로 되돌린다** — 그 판은 그림 위에 좌표를 찍는 도구라
   *  두 사각형이 어긋나면 엉뚱한 자리를 찍는다 (`CharPositioner` 머리 주석 1번). */
  const fit = view.fit || positioning;
  const scale = fit ? fitScale(box, nat) : view.zoom;
  const draw = drawSize(nat, scale);
  const movable = !fit && canPan(box, draw);

  // 상자 크기를 잰다 — 패널 폭·씬 줄 높이를 사용자가 끌므로 계속 바뀐다
  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      // ★`clientWidth/Height` — 테두리를 뺀 **안쪽**이다. 절대 배치의 기준과 같은 상자라야
      //   끌기 한계(`clampPan`)가 눈에 보이는 가장자리와 맞는다
      setBox({ w: el.clientWidth, h: el.clientHeight });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  /** 장이 바뀌면 보던 자리를 놓는다 (그림마다 크기가 다르다).
   *  ★★새 그림은 **가운데**에서 시작한다 (사용자 지시 2026-08-24) — 원본 해상도로 볼 때
   *    왼쪽 위 구석부터 보이면 대개 빈 배경이라 무엇이 나왔는지 알 수 없다.
   *  ★딸림값에 그림의 **원본 크기**도 넣는다: 파일이 바뀐 순간에는 아직 옛 크기라
   *    (`onLoad` 가 나중에 온다) 새 크기가 들어올 때 한 번 더 가운데로 잡아야 맞는다.
   *  ★배율(`scale`)은 **안 넣는다** — %를 만질 때마다 가운데로 튀면 `keepCenter` 가
   *    붙들어 둔 「보고 있던 지점」이 사라진다. */
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => setPan(centerPan(box, drawSize(nat, scale))), [file, nat.w, nat.h]);
  // ★상자·배율이 바뀌면 **밖으로 나간 만큼만** 도로 붙든다 (`clampPan`)
  useEffect(() => setPan((p) => clampPan(p, box, draw)), [box.w, box.h, draw.w, draw.h]);


  const drag = useRef<{ x: number; y: number; p: Pan } | null>(null);

  /** ★★**그린 그림과 그리는 중인 그림이 같은 자를 쓴다** (사용자 지시 2026-08-26:
   *  *"스트리밍 이미지를 현재 설정된 이미지 보는 비율로 표시"*). 예전에는 스트리밍 쪽만
   *  `contain` 으로 박혀 있어서, 200% 로 보고 있어도 그리는 동안에는 작게 나오다가 다 되면
   *  갑자기 커졌다 — 같은 자리에 놓이는 같은 그림인데 크기가 두 번 바뀌었다.
   *  ★두 벌로 적지 말 것: 한쪽만 고쳐지면 그 어긋남이 그대로 돌아온다. */
  const geom: React.CSSProperties = fit
    ? { width: "100%", height: "100%", objectFit: "contain" }
    : {
        position: "absolute",
        left: 0,
        top: 0,
        width: draw.w,
        height: draw.h,
        transform: `translate(${pan.x}px, ${pan.y}px)`,
        maxWidth: "none",
      };
  /** 넘치는 그림 끌어 보기 — ★그리는 중인 그림도 **같이 끌린다** (위 ★★주와 같은 이유) */
  const panMove = (e: React.PointerEvent<HTMLImageElement>) => {
    const d = drag.current;
    if (!d) return;
    setPan(clampPan({ x: d.p.x + (e.clientX - d.x), y: d.p.y + (e.clientY - d.y) }, box, draw));
  };
  const panUp = (e: React.PointerEvent<HTMLImageElement>) => {
    if (!drag.current) return;
    drag.current = null;
    e.currentTarget.releasePointerCapture(e.pointerId);
  };
  const panDown = (e: React.PointerEvent<HTMLImageElement>) => {
    drag.current = { x: e.clientX, y: e.clientY, p: pan };
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  /** ★★휠은 **직접 매단다** (React 의 `onWheel` 이 아니라).
   *
   *  React 는 휠 listener 를 **passive 로** 걸어서 `preventDefault()` 가 안 먹는다. 그러면
   *  `Ctrl+휠` 이 우리 확대와 **웹뷰 자체의 확대**를 동시에 일으켜 앱 전체가 커진다.
   *  여기서 `{ passive: false }` 로 걸고 우리가 쓸 때만 막는다.
   *  ★그냥 휠은 **앞뒤 장** 그대로다 (사용자 지시 2026-08-14) — 원래 조작을 안 뺏는다.
   *  ★`Ctrl+휠 = 확대·축소` (사용자 결정 2026-08-24: *"컨트롤 휠로 확대 축소"*). */
  const wheelRef = useRef<HTMLDivElement | null>(null);
  const onWheel = useRef<(e: WheelEvent) => void>(() => {});
  onWheel.current = (e: WheelEvent) => {
    if (e.deltaY === 0) return;
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      bumpZoom(e.deltaY > 0 ? -1 : 1);
      return;
    }
    step(e.deltaY > 0 ? 1 : -1);
  };
  /* ★★**창에 매달고 커서 자리로 고른다** (사용자 지적 2026-08-24: 칩에서 Alt+휠로 가중치를
     만진 뒤 큰 그림 위로 와서 휠하면 아무 일도 안 일어나고, 한 번 클릭해야 풀렸다).
     까닭은 브라우저의 **휠 래칭**이다 — 제스처를 처음 잡은 요소(칩)에 이벤트가 계속 배달돼서
     이 요소는 아예 못 받는다 (`lib/wheelAt` 의 ★★주).
     ★거품 단계다: 칩이 먼저 보고(그쪽도 커서로 판정해 그냥 넘긴다) 여기로 올라온다.
     ★`{ passive: false }` 를 줘야 `Ctrl+휠` 에서 `preventDefault` 가 먹는다 — 안 그러면
       웹뷰 자체가 확대돼 앱 전체가 커진다 (위 ★★주). */
  useEffect(() => {
    const fn = (e: WheelEvent) => {
      if (wheelIsOver(wheelRef.current, e)) onWheel.current(e);
    };
    window.addEventListener("wheel", fn, { passive: false });
    return () => window.removeEventListener("wheel", fn);
  }, []);

  return (
    <div
      data-scene-preview
      ref={wheelRef}
      style={{
        flex: 1,
        minHeight: 0,
        margin: "var(--sp-3) var(--sp-4) 0",
        borderRadius: "var(--r-3)",
        border: "1px solid var(--line)",
        background: "var(--panel)",
        display: "flex",
        alignItems: "stretch",
        padding: "var(--sp-4)",
        overflow: "hidden",
        position: "relative",
      }}
    >
      {/* ★★**무대**(그림이 실제로 그려지는 자리). 겉 상자는 여백·테두리를 들고, 재는 것은
          이 안쪽이다 — 두 모드가 **같은 자를 써야** 「꽉차게 = 100%」가 눈과 맞는다.
          ★넘치는 그림은 여기서 잘린다 (`overflow: hidden`). */}
      <div
        ref={boxRef}
        style={{ flex: 1, minWidth: 0, minHeight: 0, position: "relative", overflow: "hidden",
                 display: "flex", alignItems: "stretch" }}
      >
      {file ? (
        <img
          data-scene-img={file}
          data-scene-pos={`${shown.findIndex((r) => r.file === file) + 1}/${shown.length}`}
          /* ★미저장이면 data URL 이다 — 파일이 없으므로 서버 주소를 만들면 안 된다 */
          src={cur ? takeSrc(cur, base, ws, false) : imgUrl(base, ws, file)}
          alt=""
          draggable={false}
          /* ★★큰 그림도 **끌면 카드 커버**가 된다 (덱·손패·프롬프트 배너가 받는다).
               싱글 캔버스를 걷을 때 이 출발점이 씬 칸의 것과 함께 사라져 있었다
               (사용자 지적 2026-08-18). 고스트는 `DragLayer` 가 작게 그리므로 화면을 안 가린다.
             ★미저장은 못 끈다 — 파일이 없어 커버로 쓸 수 없다 (받는 쪽이 경로를 쓴다). */
          onPointerMove={panMove}
          onPointerUp={panUp}
          onPointerDown={
            /* ★★넘치는 그림을 잡으면 **이동**이다. 그러지 않으면 카드 커버로 끄는 출발점이
                 이동을 통째로 먹어, 확대해 놓고도 다른 데를 볼 수 없다.
                 커버로 끌기는 「꽉차게」에서 그대로 살아 있다. */
            movable
              ? panDown
              : cur?.preview
              ? undefined
              : (e) =>
                  startDrag(e, {
                    dir: "image",
                    kind: "image",
                    img: { ws, file, url: cur ? takeSrc(cur, base, ws, true) : imgUrl(base, ws, file) },
                  })
          }
          onLoad={(e) => {
            const el = e.currentTarget;
            setNat({ w: el.naturalWidth, h: el.naturalHeight });
          }}
          style={{
            /* ★꽉차게는 지금까지 그대로다 (`contain`). 배율을 정한 뒤에는 **그린 크기**를
               직접 주고 왼쪽 위에서 밀어 놓는다 — 그래야 넘치는 만큼을 끌어 볼 수 있다. */
            ...geom,
            borderRadius: "var(--r-1)",
            // ★끌어 볼 수 있으면 그 커서다. 아니면 **카드 커버로 끄는** 출발점 그대로
            cursor: movable ? (drag.current ? "grabbing" : "move") : cur?.preview ? undefined : "grab",
            ...(cur?.preview || movable ? null : dragSourceStyle),
          }}
        />
      ) : (!pendingSel || pendingSel === runId) && stepImg ? (
        /* ★★★**고른 대기 칸이 「지금 그리는 것」일 때만 띄운다** (사용자 지적 2026-08-28:
             *"스트리밍 썸네일이 같은 씬에 걸려 있는 모든 생성 대기 썸네일에 표시됨"*).
           중간 그림은 **씬 단위로** 온다 — 그 씬에 대기 칸이 여럿이면, 둘째를 골라 둬도
           첫째가 그리는 그림이 뜬다. 그 자리에 나올 것이 아닌데 그 자리에 보이는 셈이다.
           ★아무것도 안 골랐을 때는 그대로 띄운다 — 그때는 「어느 칸의 것」이라고 말하는
             자리가 없어서 어긋날 것도 없다.
           ★★**그리는 중이면 그 그림을 띄운다** (사용자 지시 2026-08-26). 대기 칸을 골라 둔
             사람은 «그 자리에 무엇이 나오나»를 보고 있는 것이라, 큰 자리가 비어 있으면
             기다림이 그대로 빈 화면이다. 씬 줄의 칸에 까는 것과 **같은 그림**이다
             (`store/queue` 의 `steps`).
           ★★**보는 배율도 그린 그림과 같다** (사용자 지시 2026-08-26) — `geom` 하나를
             둘이 나눠 쓴다. 그래서 무대 바로 밑에 놓는다: 배율을 올리면 `position: absolute`
             가 되는데, 가운데 정렬 상자 안에 있으면 기준이 그 상자가 되어 어긋난다. */
        <img
          data-scene-step
          src={stepImg}
          alt=""
          draggable={false}
          /* ★크기를 여기서도 잰다 — 배율·가운데 잡기가 **그림의 실제 크기**를 안다는 전제로
             돌아간다. 같은 값이면 스토어가 무시하므로 프레임마다 다시 그리지 않는다
             (`store/previewBox` 의 `setNat`). */
          onLoad={(e) => setNat({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
          onPointerMove={panMove}
          onPointerUp={panUp}
          onPointerDown={movable ? panDown : undefined}
          style={{
            ...geom,
            borderRadius: "var(--r-1)",
            opacity: 0.92,
            cursor: movable ? (drag.current ? "grabbing" : "move") : undefined,
          }}
        />
      ) : (
        <div
          style={{
            flex: 1,
            display: "grid",
            placeItems: "center",
            color: "var(--ink-faint)",
            fontSize: "var(--text-md)",
          }}
        >
          {/* ★★만들어지는 중인 칸을 골랐는데 **아직 첫 프레임도 안 왔으면** 빈 화면이다
              (사용자 지시 2026-08-22) — 「골라 주세요」를 띄우면 안 고른 것처럼 보인다. */}
          {pendingSel ? null : tr("scenes.pickOne")}
        </div>
      )}

      {/* ★판은 **그림과 같은 무대**에 들어간다 — 배치 중에는 꽉차게로 잠기므로
          (`fit` 의 ★주) 두 사각형이 언제나 겹친다 (`CharPositioner` 머리 주석 1번). */}
      {positioning && (
        <div style={{ position: "absolute", inset: 0, zIndex: 2 }}>
          <CharPositioner />
        </div>
      )}
      </div>


    </div>
  );
}
