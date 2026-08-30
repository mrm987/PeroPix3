import { Icon } from "../components/Icon";
import { useI18n } from "../i18n";
import { useTranslate } from "../store/translate";

/** 번역 창 단추 — 프롬프트 라벨 줄, 와일드카드·블록 저장소 옆 (v2 도 그 줄에 있었다).
 *  누르면 작은 번역 창이 열리고(`TranslatePanel`), 다시 누르거나 창의 닫기로 닫는다. */
export function TranslateButton() {
  const t = useI18n((s) => s.t);
  const open = useTranslate((s) => s.open);
  const setOpen = useTranslate((s) => s.setOpen);
  return (
    <button
      data-translate-toggle
      data-on={open ? "" : undefined}
      onClick={() => setOpen(!open)}
      data-tip={t("translate.hint")}
      style={{ color: open ? "var(--accent-ink)" : "var(--ink-faint)", display: "grid", padding: "0 4px" }}
    >
      {Icon.globe}
    </button>
  );
}
