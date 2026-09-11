import { usePlugins, isOn, usePickText } from "../lib/pluginHost";
import { toast } from "../store/toast";

/** 플러그인이 등록한 단추를 그리는 자리 (`docs/plugin-design.md` 5절).
 *
 *  ★비어 있으면 아무것도 안 그린다 — 플러그인이 없을 때 화면이 달라지면 안 된다.
 *  ★아이콘은 플러그인이 준 SVG 마크업을 그대로 그린다 (개별 책임). 없으면 글자다.
 *  ★`compact` 는 접힌 레일 — 아이콘이 있으면 아이콘만, 없으면 글자를 작게. */
export function PluginSlot({ slot, compact }: { slot: string; compact?: boolean }) {
  const pick = usePickText();   // 이름표가 언어별 묶음일 수 있다
  const all = usePlugins((s) => s.buttons[slot]);
  usePlugins((s) => s.items); // 켜기/끄기가 바뀌면 다시 그린다
  const items = all?.filter((b) => isOn(b.plugin));
  if (!items?.length) return null;
  return (
    <div data-plugin-slot={slot} style={{ display: "flex", flexWrap: "wrap", gap: 4, width: "100%" }}>
      {items.map((b) => (
        <button
          key={b.key}
          data-plugin-button={b.key}
          data-tip={compact ? b.label : undefined}
          onClick={() => {
            try {
              b.onClick();
            } catch (e) {
              toast(String((e as Error)?.message ?? e), "warn");
            }
          }}
          style={{
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            gap: "var(--sp-1)",
            flex: compact ? "1 1 100%" : "1 1 auto",
            minHeight: 24,
            padding: compact ? "var(--sp-1) 0" : "var(--sp-1) var(--sp-3)",
            fontSize: compact ? "var(--text-2xs)" : "var(--text-xs)",
            color: "var(--ink-soft)",
            border: "1px solid var(--line)",
            borderRadius: "var(--r-2)",
            background: "var(--panel)",
          }}
        >
          {b.icon ? (
            <span
              aria-hidden
              style={{ display: "grid", placeItems: "center", width: 14, height: 14 }}
              dangerouslySetInnerHTML={{ __html: b.icon }}
            />
          ) : null}
          {(!compact || !b.icon) && pick(b.label)}
        </button>
      ))}
    </div>
  );
}
