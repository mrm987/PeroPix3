import { useI18n } from "../i18n";
import { FloatWindow } from "./FloatWindow";
import { SideColumn } from "./Shell";
import { DropImport } from "./DropImport";
import { AiChat } from "../panels/AiChat";
import { PreviewArea, SceneArea } from "../panels/Canvas";
import { Gallery } from "../panels/Gallery";
import { GalleryFolders } from "../panels/GalleryFolders";
import { GalleryMeta } from "../panels/GalleryMeta";
import { LeftPanel } from "../panels/LeftPanel";
import { GenerateFooter } from "../panels/GenerateFooter";
import { BlockDrawer } from "../blocks/BlockDrawer";
import { askThumb } from "../cards/thumbAsk";
import { useUi } from "../store/ui";

/** 앱 밖 창에 나가 있는 영역들 (`lib/floatWin`). 나가 있지 않으면 아무것도 안 그린다.
 *
 *  ★이미지 편집 · 자동검열 · 보조 도구 · 플러그인은 없다. 화면 전체를 쓰는 모드이고, 플러그인 iframe 은 옮기면 다시 로드된다.
 *  ★카드덱도 없다 (사용자 결정 2026-11-06). 메인에 남아 새 창의 그림을 받는다.
 *  ★파일을 끌어다 놓는 자리(`DropImport`)는 창마다 따로다. 파일 드롭은 웹뷰마다 온다. */
export function Floats({ onOpenSettings }: { onOpenSettings: () => void }) {
  const t = useI18n((s) => s.t);
  return (
    <>
      <FloatWindow area="ai" title={t("ai.title")}>
        <AiChat onOpenSettings={onOpenSettings} />
      </FloatWindow>
      <FloatWindow area="preview" title={t("float.preview")}>
        <PreviewArea />
        <DropImport />
      </FloatWindow>
      <FloatWindow area="scene" title={t("float.scene")}>
        <SceneArea />
        <DropImport />
      </FloatWindow>
      <FloatWindow area="prompt" title={t("panel.prompt")}>
        <PromptArea />
        <DropImport />
      </FloatWindow>
      <FloatWindow area="gallery" title={t("mode.gallery")}>
        <GalleryArea />
        <DropImport />
      </FloatWindow>
    </>
  );
}

/** 프롬프트 — 왼쪽 패널 그대로. 생성 푸터가 함께 가므로 메인의 레일에는 생성 버튼이 없다 (단축키가 두 번 걸린다) */
function PromptArea() {
  return (
    <div style={{ flex: 1, minHeight: 0, display: "flex" }}>
      <section style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
        <div style={{ flex: 1, minHeight: 0, overflowY: "auto", display: "flex", flexDirection: "column" }}>
          <LeftPanel onThumb={(section, img) => askThumb({ type: "section", section, img })} />
        </div>
        <GenerateFooter />
      </section>
      <BlockDrawer />
    </div>
  );
}

/** 갤러리 — 메인의 갤러리 모드와 같은 세 칸. 폭과 접힘은 갤러리 모드의 값을 그대로 쓴다 */
function GalleryArea() {
  const t = useI18n((s) => s.t);
  const leftWidth = useUi((s) => s.leftWidth.gallery);
  const rightWidth = useUi((s) => s.rightWidth.gallery);
  const leftCollapsed = useUi((s) => s.leftCollapsed.gallery);
  const rightCollapsed = useUi((s) => s.rightCollapsed.gallery);
  const commit = useUi((s) => s.commitLayout);
  // ★스토어의 `setLeftWidth` 등은 메인의 **지금 모드** 몫을 고친다. 메인이 다른 모드여도 갤러리 몫을 고쳐야 한다
  const setW = (k: "leftWidth" | "rightWidth") => (w: number) =>
    useUi.setState((s) => ({ [k]: { ...s[k], gallery: w } }) as never);
  const fold = (k: "leftCollapsed" | "rightCollapsed") => () => {
    useUi.setState((s) => ({ [k]: { ...s[k], gallery: !s[k].gallery } }) as never);
    commit();
  };
  return (
    <div style={{ flex: 1, minHeight: 0, display: "flex" }}>
      <SideColumn
        side="left"
        label={t("gallery.folders")}
        width={leftWidth}
        setWidth={setW("leftWidth")}
        onCommit={commit}
        collapsed={leftCollapsed}
        onToggle={fold("leftCollapsed")}
      >
        <GalleryFolders />
      </SideColumn>
      <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", position: "relative" }}>
        <Gallery />
      </div>
      <SideColumn
        side="right"
        label={t("gallery.meta")}
        width={rightWidth}
        setWidth={setW("rightWidth")}
        onCommit={commit}
        collapsed={rightCollapsed}
        onToggle={fold("rightCollapsed")}
      >
        <GalleryMeta />
      </SideColumn>
    </div>
  );
}
