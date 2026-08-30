import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Icon } from "./Icon";

/** **우리가 그리는 드롭다운** (사용자 지시 2026-08-30).
 *
 *  ★브라우저 기본 `<select>` 는 **펼쳐지는 목록을 우리가 못 그린다** — 항목 여백·줄 간격·글꼴을
 *    크로미움이 정하고 `<option>` 의 padding 은 무시된다. 사용자 지적: *"펼쳐지는 곳 여백이
 *    너무 적다."* 닫힌 상자는 전부터 우리가 그렸으니(`SceneLane` 의 목적지 상자), 목록도 그린다.
 *  ★★목록은 **`document.body` 에 띄운다** (portal). 세로쓰기(`writing-mode`)나 `transform` 이
 *    걸린 조상 안에서 `position: fixed` 를 쓰면 그 조상 기준으로 잡혀 엉뚱한 자리에 뜬다.
 *    목록 자체는 언제나 가로쓰기다 — 세로 목록은 읽기 어렵다.
 *  ★열고 닫기는 `<select>` 와 같게: 클릭·Space·Enter·↓ 로 열고, ↑↓ 로 옮기고, Enter 로 고르고,
 *    Esc·밖 클릭·스크롤로 닫는다.
 *  ★처음 쓰는 자리는 씬 프롬프트 목적지 하나다 — 나머지 `<select>` 들은 보고 나서 차례로. */
export type DropdownOption = { value: string; label: string };

export function Dropdown({
  value,
  options,
  onChange,
  vert = false,
  tip,
  mark,
}: {
  value: string;
  options: DropdownOption[];
  onChange: (v: string) => void;
  /** 세로 모드 — 상자의 글이 세로로 서고, 목록은 상자의 **오른쪽**에 뜬다 */
  vert?: boolean;
  /** 상자에 다는 툴팁 (`data-tip`) */
  tip?: string;
  /** 판정·QA 가 잡는 표식 — `data-dropdown={mark}` */
  mark?: string;
}) {
  const [open, setOpen] = useState(false);
  const [hi, setHi] = useState(0);
  /** 상자의 자리 — 목록을 어디에 붙일지는 목록을 **재고 나서** 정한다 (아래 `useLayoutEffect`) */
  const [anchor, setAnchor] = useState<{ l: number; t: number; r: number; b: number; w: number } | null>(null);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const box = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const cur = options.find((o) => o.value === value);
  const label = cur?.label ?? options[0]?.label ?? "";

  const show = () => {
    const r = box.current?.getBoundingClientRect();
    if (!r) return;
    setAnchor({ l: r.left, t: r.top, r: r.right, b: r.bottom, w: r.width });
    setPos(null);
    setHi(Math.max(0, options.findIndex((o) => o.value === value)));
    setOpen(true);
  };
  const pick = (v: string) => {
    setOpen(false);
    if (v !== value) onChange(v);
    box.current?.focus();
  };

  // 밖 클릭·스크롤·창 크기 변화·Esc 면 닫는다
  useEffect(() => {
    if (!open) return;
    const down = (e: PointerEvent) => {
      const t = e.target as Node;
      if (box.current?.contains(t) || list.current?.contains(t)) return;
      setOpen(false);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        box.current?.focus();
      }
    };
    const away = () => setOpen(false);
    document.addEventListener("pointerdown", down, true);
    document.addEventListener("keydown", key);
    window.addEventListener("scroll", away, true);
    window.addEventListener("resize", away);
    window.addEventListener("blur", away);
    return () => {
      document.removeEventListener("pointerdown", down, true);
      document.removeEventListener("keydown", key);
      window.removeEventListener("scroll", away, true);
      window.removeEventListener("resize", away);
      window.removeEventListener("blur", away);
    };
  }, [open]);

  /* ★★**자리는 목록을 재고 나서 정한다.** 가로: 상자 아래, 아래가 모자라면 **위로 뒤집는다**.
     세로: 상자 오른쪽, 오른쪽이 모자라면 **왼쪽으로**. 그러고도 넘치면 안쪽으로 민다
     (사용자 지적 2026-08-30: 뒤집히지 않고 밀리기만 해서 상자를 덮었다). 열리면 목록이 키를 받는다. */
  useLayoutEffect(() => {
    if (!open) return;
    const el = list.current;
    if (!el || !anchor) return;
    el.focus();
    const r = el.getBoundingClientRect();
    const W = window.innerWidth;
    const H = window.innerHeight;
    let x: number;
    let y: number;
    if (vert) {
      x = anchor.r + 4 + r.width > W - 8 && anchor.l - 4 - r.width >= 8 ? anchor.l - 4 - r.width : anchor.r + 4;
      y = anchor.t;
    } else {
      x = anchor.l;
      y = anchor.b + 4 + r.height > H - 8 && anchor.t - 4 - r.height >= 8 ? anchor.t - 4 - r.height : anchor.b + 4;
    }
    x = Math.max(8, Math.min(W - 8 - r.width, x));
    y = Math.max(8, Math.min(H - 8 - r.height, y));
    if (!pos || pos.x !== x || pos.y !== y) setPos({ x, y });
  }, [open, anchor, pos, vert]);

  const onListKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHi((h) => Math.min(options.length - 1, h + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHi((h) => Math.max(0, h - 1));
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      const o = options[hi];
      if (o) pick(o.value);
    }
  };

  return (
    <>
      <button
        ref={box}
        type="button"
        data-dropdown={mark}
        data-open={open ? "" : undefined}
        data-tip={tip}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => (open ? setOpen(false) : show())}
        onKeyDown={(e) => {
          if (!open && (e.key === "ArrowDown" || e.key === "Enter" || e.key === " ")) {
            e.preventDefault();
            show();
          }
        }}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 2,
          background: "var(--bg)",
          border: `1px solid ${open ? "var(--accent)" : "var(--line)"}`,
          borderRadius: "var(--r-2)",
          color: "var(--ink)",
          /* ★글자 쪽 10px · 화살표 쪽 6px — 화살표 아이콘이 좌우에 빈 여백을 품고 있어 같은 값을
             주면 화살표 쪽만 넓어 보인다 (2026-08-30). 세로 모드는 같은 배분을 위아래에 */
          padding: vert ? "var(--sp-4) var(--sp-1) var(--sp-2)" : "1px var(--sp-2) 1px var(--sp-4)",
          cursor: "pointer",
          font: "inherit",
          textAlign: "left",
        }}
      >
        <span>{label}</span>
        {/* ★화살표는 언제나 아래 — 세로쓰기에 딸려 돌지 않게 그 자리만 가로쓰기로 */}
        <span style={{ display: "grid", color: "var(--ink-faint)", writingMode: "horizontal-tb" }}>
          {Icon.chevronDown14}
        </span>
      </button>
      {open &&
        anchor &&
        createPortal(
          <div
            ref={list}
            role="listbox"
            tabIndex={-1}
            data-dropdown-list={mark}
            onKeyDown={onListKey}
            style={{
              position: "fixed",
              left: pos?.x ?? 0,
              top: pos?.y ?? 0,
              // ★재기 전에는 안 보인다 — 잰 뒤에 자리를 잡는다 (0,0 에서 깜빡이지 않게)
              visibility: pos ? "visible" : "hidden",
              minWidth: vert ? undefined : anchor.w,
              zIndex: 8000,
              writingMode: "horizontal-tb",
              display: "flex",
              flexDirection: "column",
              padding: "var(--sp-1) 0",
              background: "var(--panel)",
              border: "1px solid var(--line-strong)",
              borderRadius: "var(--r-2)",
              boxShadow: "0 8px 24px rgba(0,0,0,0.28)",
              outline: "none",
              maxHeight: "60vh",
              overflowY: "auto",
            }}
          >
            {options.map((o, i) => {
              const on = o.value === value;
              const hot = i === hi;
              return (
                <div
                  key={o.value}
                  role="option"
                  aria-selected={on}
                  data-dropdown-item={o.value}
                  onPointerEnter={() => setHi(i)}
                  onClick={() => pick(o.value)}
                  style={{
                    /* ★항목 여백은 상자와 같은 급 — 좌우 10px, 위아래 6px (사용자 지적 2026-08-30) */
                    padding: "var(--sp-2) var(--sp-4)",
                    fontSize: "var(--text-xs)",
                    lineHeight: 1.4,
                    whiteSpace: "nowrap",
                    cursor: "pointer",
                    color: on ? "var(--accent-ink)" : "var(--ink)",
                    background: hot ? "color-mix(in srgb, var(--accent) 12%, transparent)" : "transparent",
                  }}
                >
                  {o.label}
                </div>
              );
            })}
          </div>,
          document.body,
        )}
    </>
  );
}
