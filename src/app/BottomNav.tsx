import { useI18n } from "../i18n";
import { MODES, useUi } from "../store/ui";
import { useDropZone } from "../cards/dragStore";
import { useGallery } from "../store/gallery";
import { useWs } from "../store/workspace";
import { toast } from "../store/toast";

/** 하단 네비 = v2.x 의 모드 전환 자리 (ui-guide.md 6절).
 *  모드마다 고유색이 있고, 활성 모드는 상단에 1.5px 색 선이 그어진다.
 *  ★모드 버튼은 **가운데**에 선다 (사용자 지시 2026-08-04) — 왼쪽 끝에 붙어 있으면
 *    좌 패널의 것처럼 보였다. 양옆은 같은 폭을 잡아 두어 가운데가 흔들리지 않는다.
 *  ★남은 Anlas 는 여기 없다 — 생성 푸터 하나로 모았다 (`GenerateFooter`). */
export function BottomNav({ right }: { right?: React.ReactNode }) {
  const t = useI18n((s) => s.t);
  const mode = useUi((s) => s.mode);
  const setMode = useUi((s) => s.setMode);

  return (
    <nav
      style={{
        height: 48,
        flexShrink: 0,
        display: "flex",
        alignItems: "stretch",
        background: "var(--bg)",
        borderTop: "1px solid var(--line)",
        padding: "0 var(--sp-3)",
      }}
    >
      {/* 왼쪽 저울추 — 오른쪽 상태 표시와 같은 자리를 비워 두어야 버튼 묶음이 정가운데에 선다 */}
      <span style={{ flex: 1 }} />
      {MODES.map((m) => {
        const on = m.id === mode;
        // ★★갤러리 단추는 **그림을 받는다** (사용자 지시 2026-08-21) — 떨구면 보관함에 넣는다.
        //   모드를 옮기지 않는다: 넣어 두고 하던 일을 계속하는 것이 이 몸짓의 뜻이다.
        if (m.id === "gallery") return <GalleryTab key={m.id} on={on} onClick={() => setMode(m.id)} />;
        return (
          <button
            key={m.id}
            onClick={() => setMode(m.id)}
            style={{
              position: "relative",
              display: "flex",
              alignItems: "center",
              padding: "0 var(--sp-7)",
              fontSize: "var(--text-md)",
              fontWeight: on ? "var(--w-semi)" : "var(--w-normal)",
              color: on ? "var(--ink)" : "var(--ink-dim)",
              borderRight: "1px solid var(--line-soft)",
            }}
          >
            {t(`mode.${m.id}`)}
            {on && (
              <span
                style={{
                  position: "absolute",
                  top: -1,
                  left: 8,
                  right: 8,
                  height: 1.5,
                  background: m.color,
                  borderRadius: 1,
                }}
              />
            )}
          </button>
        );
      })}
      <span style={{ flex: 1, display: "flex", justifyContent: "flex-end", alignItems: "center" }}>
        {right}
      </span>
    </nav>
  );
}

/** 갤러리 단추 = **보관함 드롭 자리**.
 *
 *  ★생성물을 여기 떨구면 보관함에 들어간다 (크게 본 그림의 「보관」 단추와 같은 일).
 *  ★★**무르지 않는다** (`toggle: false`) — 이미 보관된 그림을 떨궜다고 빼 버리면
 *    "놓았는데 사라졌다"가 된다. 이미 있으면 있다고 알리기만 한다.
 *  ★모드를 옮기지 않는다 — 옮기면 하던 작업 화면에서 튕겨 나간다. */
function GalleryTab({ on, onClick }: { on: boolean; onClick: () => void }) {
  const t = useI18n((s) => s.t);
  const m = MODES.find((x) => x.id === "gallery")!;
  const zone = useDropZone({
    id: "nav-gallery",
    kind: "image",
    dir: "image",
    prio: 30,
    onDrop: (d) => {
      const img = d.img;
      if (!img) return;
      void (async () => {
        try {
          const ws = img.ws || useWs.getState().current;
          if (!ws) return;
          // ★누르면 언제나 보관 — 무르기·「이미 있음」 갈래는 걷어냈다 (사용자 결정 2026-08-29)
          await useGallery.getState().keep(ws, img.file);
          toast(t("gallery.kept"));
        } catch (e) {
          toast(String(e), "warn");
        }
      })();
    },
  });
  return (
    <button
      // ★존의 ref 는 `HTMLDivElement` 로 잡혀 있다 — 재는 것은 사각형뿐이라 요소 종류는
      //   상관없다 (다른 자리도 이렇게 쓴다)
      ref={zone.ref as unknown as React.Ref<HTMLButtonElement>}
      data-nav-gallery
      onClick={onClick}
      data-tip={zone.active ? t("gallery.dropToKeep") : undefined}
      style={{
        position: "relative",
        display: "flex",
        alignItems: "center",
        padding: "0 var(--sp-7)",
        fontSize: "var(--text-md)",
        fontWeight: on ? "var(--w-semi)" : "var(--w-normal)",
        color: zone.over ? "var(--accent-ink)" : on ? "var(--ink)" : "var(--ink-dim)",
        borderRight: "1px solid var(--line-soft)",
        // ★받을 수 있을 때만 테두리를 보여 준다 — 평소에는 다른 단추와 같은 모습이다
        outline: zone.over ? "1px solid var(--accent)" : zone.active ? "1px dashed var(--line-strong)" : undefined,
        outlineOffset: -3,
        background: zone.over ? "var(--accent-bg)" : undefined,
        borderRadius: "var(--r-2)",
      }}
    >
      {t("mode.gallery")}
      {on && (
        <span
          style={{
            position: "absolute",
            top: -1,
            left: 8,
            right: 8,
            height: 1.5,
            background: m.color,
            borderRadius: 1,
          }}
        />
      )}
    </button>
  );
}
