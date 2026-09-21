import { useRef, useState } from "react";

/** 슬라이더 옆 숫자. 누르면 입력칸이 되어 **범위 밖의 값도** 넣을 수 있다.
 *
 *  ★v2 의 Precise Reference 가 그랬다 (index.html:18833-18866): 슬라이더는 0~1 로 묶어 두고
 *    참조 강도만 1 을 넘겨 넣을 수 있었다. 옮기면서 빠져 있던 것을 되돌린다
 *    (사용자 결정 2026-08-18).
 *
 *  ★★**모양만 같은 것을 따로 만들지 않는다** — 쓰는 자리가 둘이다:
 *    Precise Reference 의 강도·Fidelity(`panels/ImageInputPanel`) 와 강화 창의 강도·노이즈
 *    (`panels/EnhanceDialog`). v2 도 둘 다 누르면 직접 입력이 됐다 (`.enhance-clickable-value`, 24857).
 *  ★값을 가두지 않는다 — 범위를 정하는 것은 부르는 쪽의 `onCommit` 이다. */
export function ValueBox({
  value,
  step,
  onCommit,
}: {
  value: number;
  step: number;
  onCommit: (v: number) => void;
}) {
  const [edit, setEdit] = useState(false);
  const [text, setText] = useState(String(value));
  /** Esc 로 나갈 때는 반영하지 않는다. blur 가 그 뒤에 오므로 표식이 필요하다 */
  const cancel = useRef(false);

  if (!edit)
    return (
      <span
        data-slide-value
        // ★label 안이라 그냥 두면 클릭이 슬라이더로 넘어간다
        onClick={(e) => {
          e.preventDefault();
          setText(String(value));
          setEdit(true);
        }}
        style={{
          width: 30,
          textAlign: "right",
          fontVariantNumeric: "tabular-nums",
          color: "var(--accent-ink)",
          cursor: "pointer",
        }}
      >
        {value}
      </span>
    );

  return (
    <input
      data-slide-input
      type="number"
      autoFocus
      step={step}
      value={text}
      onClick={(e) => e.preventDefault()}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => {
        if (!cancel.current) {
          const v = parseFloat(text);
          onCommit(Number.isFinite(v) ? v : value);
        }
        cancel.current = false;
        setEdit(false);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        if (e.key === "Escape") {
          cancel.current = true;
          (e.target as HTMLInputElement).blur();
        }
      }}
      style={{
        width: 44,
        textAlign: "right",
        fontSize: "inherit",
        padding: "1px 3px",
        borderRadius: "var(--r-1)",
        border: "1px solid var(--accent)",
        background: "var(--panel)",
        color: "var(--ink)",
      }}
    />
  );
}
