import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Icon } from "./Icon";
import { useI18n } from "../i18n";
import { useWin } from "../lib/floatWin";

/** **우리가 그리는 색 고르기** — `<input type="color">` 를 갈음한다 (사용자 지시 2026-11-23).
 *
 *  ★기본 색 창의 스포이드는 WebView2 가 처리하는데, 사용자 PC 에서 눌러도 아무 반응이 없었다 (여러 사용자 제보).
 *    게스트(GPU 꺼짐)에서는 동작해서 앱 쪽에서 고칠 길이 없다. 그래서 색 창을 통째로 우리가 그리고, 스포이드는
 *    **화면에 보이는 캔버스·그림(`<img>`)의 픽셀**을 읽는다 (`sampleAt`). 그 밖(앱 밖 포함)의 색은 못 집는다.
 *  ★쓰는 곳: 이미지 편집의 색 칸 전부 · 자동검열의 단색 색 칸 (사용자 지시 2026-11-23). 앱에 기본 색 칸은 없다.
 *  ★배치는 기본 색 창과 같다: 위에 채도·명도 판, 아래 줄에 스포이드 · 지금 색 · 색상 막대, 맨 아래 RGB 칸.
 *  ★바뀔 때마다 `onChange` 를 부른다 (기본 색 창의 input 이벤트와 같다). 상자에는 `value` 를 단다 — 판정이 `.value` 로 읽는다.
 *  ★창은 `document.body` 에 띄운다 (`Dropdown` 과 같은 이유). 그래서 창을 품은 메뉴가 「밖을 누르면 닫기」를 하면
 *    `[data-color-pop]` 안은 빼야 한다 (`Editor` 의 캔버스 밖 배경 메뉴). */
type Hsv = { h: number; s: number; v: number };
type Rgb = [number, number, number];

const clamp = (n: number, a: number, b: number) => Math.min(b, Math.max(a, n));
export const hexToRgb = (hex: string): Rgb | null => {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [n >> 16, (n >> 8) & 255, n & 255];
};
export const rgbToHex = (r: number, g: number, b: number) =>
  "#" + [r, g, b].map((x) => clamp(Math.round(x), 0, 255).toString(16).padStart(2, "0")).join("");
const rgbToHsv = (r: number, g: number, b: number): Hsv => {
  const R = r / 255, G = g / 255, B = b / 255;
  const max = Math.max(R, G, B), min = Math.min(R, G, B), d = max - min;
  let h = 0;
  if (d) h = max === R ? ((G - B) / d) % 6 : max === G ? (B - R) / d + 2 : (R - G) / d + 4;
  return { h: (h * 60 + 360) % 360, s: max ? d / max : 0, v: max };
};
const hsvToRgb = ({ h, s, v }: Hsv): Rgb => {
  const f = (n: number) => {
    const k = (n + h / 60) % 6;
    return (v - v * s * Math.max(0, Math.min(k, 4 - k, 1))) * 255;
  };
  return [f(5), f(3), f(1)];
};
/** 색상이 없는 색(회색·검정)이면 앞의 색상을 지킨다 — 안 지키면 판을 검정까지 끌었다 놓을 때 막대가 빨강으로 튄다 */
const hsvOf = (hex: string, keep?: Hsv): Hsv => {
  const rgb = hexToRgb(hex) ?? [0, 0, 0];
  const x = rgbToHsv(...rgb);
  if (keep && (x.s === 0 || x.v === 0)) return { ...x, h: keep.h, s: x.v === 0 ? keep.s : x.s };
  return x;
};

/** `<img>` 의 픽셀을 읽을 사본 — 그 그림은 백엔드(다른 출처)에서 와서 그대로 그리면 캔버스가 더럽혀진다.
 *  ★`cache: "no-store"` 로 새로 받는다. `<img>` 가 CORS 없이 받아 둔 캐시 항목을 다시 쓰면 조용히 실패한다
 *    (`/api/pin` 으로 옮기게 된 이유와 같다). 최근 두 장만 든다 */
const imgCopies = new Map<string, Promise<HTMLCanvasElement | null>>();
function imgCopy(doc: Document, src: string): Promise<HTMLCanvasElement | null> {
  let p = imgCopies.get(src);
  if (!p) {
    p = fetch(src, { cache: "no-store" })
      .then((r) => (r.ok ? r.blob() : Promise.reject(r.status)))
      .then((b) => createImageBitmap(b))
      .then((bm) => {
        const cv = doc.createElement("canvas");
        cv.width = bm.width;
        cv.height = bm.height;
        cv.getContext("2d", { willReadFrequently: true })?.drawImage(bm, 0, 0);
        bm.close();
        return cv;
      })
      .catch(() => null);
    imgCopies.set(src, p);
    while (imgCopies.size > 2) imgCopies.delete(imgCopies.keys().next().value as string);
  }
  return p;
}

/** 그 자리에서 **보이는** 픽셀 — 캔버스와 그림(`<img>`)을 위의 것부터 보고, 투명하면 그 아래로.
 *  ★`elementsFromPoint` 로 찾지 않는다 — 자동검열의 덮개 캔버스처럼 `pointer-events: none` 인 것이 빠진다.
 *    대신 커서 아래 맨 위 요소와 **같은 틀**(부모가 그 요소를 품는다)에 든 캔버스·그림을 문서 차례의 역순(위가 먼저)으로 본다.
 *  ★`on` — 커서 아래에 캔버스·그림이 하나라도 있었나 (투명한 자리를 누른 것과 밖을 누른 것을 가른다) */
async function sampleAt(doc: Document, x: number, y: number): Promise<{ hex: string | null; on: boolean }> {
  const top = doc.elementFromPoint(x, y);
  if (!top) return { hex: null, on: false };
  const hits = [...doc.querySelectorAll<HTMLCanvasElement | HTMLImageElement>("canvas, img")].filter((el) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && x >= r.left && x < r.right && y >= r.top && y < r.bottom && (el === top || !!el.parentElement?.contains(top));
  });
  for (const el of hits.reverse()) {
    const r = el.getBoundingClientRect();
    let src: HTMLCanvasElement | null = null;
    let box = { l: r.left, t: r.top, w: r.width, h: r.height };
    if (el.tagName === "CANVAS") src = el as HTMLCanvasElement;
    else {
      const im = el as HTMLImageElement;
      if (!im.currentSrc || !im.naturalWidth) continue;
      // object-fit: contain 이면 그림이 그려진 상자만
      if (getComputedStyle(im).objectFit === "contain") {
        const k = Math.min(r.width / im.naturalWidth, r.height / im.naturalHeight);
        const w = im.naturalWidth * k, h = im.naturalHeight * k;
        box = { l: r.left + (r.width - w) / 2, t: r.top + (r.height - h) / 2, w, h };
      }
      src = await imgCopy(doc, im.currentSrc);
    }
    if (!src || !src.width || !src.height) continue;
    const px = Math.floor(((x - box.l) / box.w) * src.width);
    const py = Math.floor(((y - box.t) / box.h) * src.height);
    if (px < 0 || py < 0 || px >= src.width || py >= src.height) continue;
    try {
      const d = src.getContext("2d")?.getImageData(px, py, 1, 1).data;
      if (d && d[3] > 0) return { hex: rgbToHex(d[0], d[1], d[2]), on: true };
    } catch {
      /* 읽을 수 없는 캔버스 — 아래 것을 본다 */
    }
  }
  return { hex: null, on: hits.length > 0 };
}

/** 누른 뒤 따라오는 놓기·클릭을 먹는다 — 스포이드로 누른 것이 그 아래 버튼·붓에 닿지 않게 */
function swallowRest(w: Window) {
  const kinds = ["mousedown", "pointerup", "mouseup", "click", "dblclick", "contextmenu"];
  const stop = (e: Event) => {
    e.preventDefault();
    e.stopImmediatePropagation();
    if (e.type === "click") done();
  };
  const done = () => {
    for (const k of kinds) w.removeEventListener(k, stop, true);
    clearTimeout(timer);
  };
  for (const k of kinds) w.addEventListener(k, stop, true);
  const timer = setTimeout(done, 600);
}

type Props = Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "value" | "onChange"> & {
  value: string;
  onChange: (hex: string) => void;
};

export function ColorInput({ value, onChange, style, ...rest }: Props) {
  const t = useI18n((s) => s.t);
  const win = useWin();
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<{ l: number; t: number; b: number } | null>(null);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const [hsv, setHsv] = useState<Hsv>(() => hsvOf(value));
  const [mode, setMode] = useState<"rgb" | "hex">("rgb");
  const [picking, setPicking] = useState(false);
  /** 스포이드가 커서 아래에서 읽은 색 — 커서 옆 작은 원으로 보인다 */
  const [hover, setHover] = useState<{ x: number; y: number; hex: string | null } | null>(null);
  const box = useRef<HTMLButtonElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  const pipette = useRef<HTMLButtonElement>(null);
  const hsvRef = useRef(hsv);
  hsvRef.current = hsv;
  const valueRef = useRef(value);
  valueRef.current = value;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const pickRef = useRef(false);
  pickRef.current = picking;

  const rgb = hsvToRgb(hsv);
  const hex = rgbToHex(...rgb);
  // 밖에서 값이 바뀌면 따라간다 (우리가 낸 값이 돌아온 것이면 그대로 — 색상을 잃지 않게)
  useEffect(() => {
    if (value.toLowerCase() !== rgbToHex(...hsvToRgb(hsvRef.current))) setHsv(hsvOf(value, hsvRef.current));
  }, [value]);

  const set = (next: Hsv) => {
    setHsv(next);
    const h = rgbToHex(...hsvToRgb(next));
    if (h !== valueRef.current.toLowerCase()) onChangeRef.current(h);
  };
  const show = () => {
    const r = box.current?.getBoundingClientRect();
    if (!r) return;
    setAnchor({ l: r.left, t: r.top, b: r.bottom });
    setPos(null);
    setHsv(hsvOf(value, hsv));
    setOpen(true);
  };
  const close = () => {
    setOpen(false);
    setPicking(false);
    setHover(null);
  };

  // 밖 클릭·Esc·스크롤·창 크기 변화·창을 떠나면 닫는다. 스포이드 중의 Esc 는 스포이드만 끈다
  useEffect(() => {
    if (!open) return;
    const doc = win.document;
    const down = (e: PointerEvent) => {
      const t = e.target as Node;
      if (box.current?.contains(t) || pop.current?.contains(t)) return;
      close();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      if (pickRef.current) {
        setPicking(false);
        setHover(null);
      } else close();
    };
    const away = () => close();
    doc.addEventListener("pointerdown", down, true);
    win.addEventListener("keydown", key, true);
    win.addEventListener("scroll", away, true);
    win.addEventListener("resize", away);
    win.addEventListener("blur", away);
    return () => {
      doc.removeEventListener("pointerdown", down, true);
      win.removeEventListener("keydown", key, true);
      win.removeEventListener("scroll", away, true);
      win.removeEventListener("resize", away);
      win.removeEventListener("blur", away);
    };
  }, [open, win]);

  // 자리는 창을 재고 나서 — 상자 아래, 아래가 모자라면 위로 뒤집고, 넘치면 안쪽으로 민다 (`Dropdown` 과 같다)
  useLayoutEffect(() => {
    if (!open) return;
    const el = pop.current;
    if (!el || !anchor) return;
    const r = el.getBoundingClientRect();
    const W = win.innerWidth;
    const H = win.innerHeight;
    let x = anchor.l;
    let y = anchor.b + 4 + r.height > H - 8 && anchor.t - 4 - r.height >= 8 ? anchor.t - 4 - r.height : anchor.b + 4;
    x = Math.max(8, Math.min(W - 8 - r.width, x));
    y = Math.max(8, Math.min(H - 8 - r.height, y));
    if (!pos || pos.x !== x || pos.y !== y) setPos({ x, y });
  }, [open, anchor, pos, win]);

  /* ── 스포이드 — 켜져 있는 동안 창 밖의 누르기·움직임은 앱에 안 간다 (기본 색 창의 스포이드와 같다) ── */
  useEffect(() => {
    if (!picking) return;
    const doc = win.document;
    const inPop = (e: Event) => !!pop.current?.contains(e.target as Node);
    const block = (e: Event) => {
      e.preventDefault();
      e.stopImmediatePropagation();
    };
    // ★읽기는 비동기다 (그림은 사본을 받아 와서 읽는다) — 늦게 온 답은 버린다
    let live = true;
    let seq = 0;
    const move = (e: PointerEvent) => {
      const n = ++seq;
      if (inPop(e)) return setHover(null);
      block(e);
      const { clientX: x, clientY: y } = e;
      void sampleAt(doc, x, y).then((got) => live && n === seq && setHover({ x, y, hex: got.hex }));
    };
    const down = (e: PointerEvent) => {
      if (inPop(e)) {
        // 창 안을 누르면 스포이드를 끈다 — 스포이드 버튼은 제 클릭으로 켜고 끈다
        if (!pipette.current?.contains(e.target as Node)) setPicking(false);
        return;
      }
      block(e);
      swallowRest(win);
      void sampleAt(doc, e.clientX, e.clientY).then((got) => {
        if (!live) return;
        if (got.hex) set(hsvOf(got.hex, hsvRef.current));
        // 캔버스·그림의 빈(투명) 자리면 스포이드를 그대로 둔다 — 그 밖이면 끈다
        if (got.hex || !got.on) {
          setPicking(false);
          setHover(null);
        }
      });
    };
    const cur = doc.createElement("style");
    cur.textContent = "*{cursor:crosshair !important}";
    doc.head.appendChild(cur);
    win.addEventListener("pointermove", move, true);
    win.addEventListener("pointerdown", down, true);
    return () => {
      live = false;
      cur.remove();
      win.removeEventListener("pointermove", move, true);
      win.removeEventListener("pointerdown", down, true);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [picking, win]);

  /* ── 판·막대 끌기 ── */
  const dragOn = (el: HTMLElement, e: React.PointerEvent, at: (fx: number, fy: number) => void) => {
    const r = el.getBoundingClientRect();
    at(clamp((e.clientX - r.left) / r.width, 0, 1), clamp((e.clientY - r.top) / r.height, 0, 1));
  };
  const svAt = (fx: number, fy: number) => set({ h: hsvRef.current.h, s: fx, v: 1 - fy });
  const hueAt = (fx: number) => set({ ...hsvRef.current, h: Math.min(359.9, fx * 360) });
  const drag = (at: (fx: number, fy: number) => void) => ({
    onPointerDown: (e: React.PointerEvent<HTMLDivElement>) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.currentTarget.setPointerCapture(e.pointerId);
      dragOn(e.currentTarget, e, at);
    },
    onPointerMove: (e: React.PointerEvent<HTMLDivElement>) => {
      if (e.buttons & 1 && e.currentTarget.hasPointerCapture(e.pointerId)) dragOn(e.currentTarget, e, at);
    },
  });

  const field: React.CSSProperties = {
    width: "100%",
    minWidth: 0,
    boxSizing: "border-box",
    padding: "3px 4px",
    background: "var(--bg)",
    border: "1px solid var(--line)",
    borderRadius: "var(--r-1)",
    color: "var(--ink)",
    font: "inherit",
    fontSize: "var(--text-2xs)",
    fontVariantNumeric: "tabular-nums",
    textAlign: "center",
  };
  const fieldLabel: React.CSSProperties = { marginTop: 3, fontSize: "var(--text-3xs)", color: "var(--ink-faint)", textAlign: "center" };

  return (
    <>
      <button
        ref={box}
        type="button"
        {...rest}
        value={value}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => (open ? close() : show())}
        style={{ ...style, background: value, cursor: "pointer" }}
      />
      {open &&
        anchor &&
        createPortal(
          <div
            ref={pop}
            data-color-pop
            style={{
              position: "fixed",
              left: pos?.x ?? 0,
              top: pos?.y ?? 0,
              visibility: pos ? "visible" : "hidden",
              zIndex: 8000,
              width: 232,
              background: "var(--panel)",
              border: "1px solid var(--line-strong)",
              borderRadius: "var(--r-2)",
              boxShadow: "0 8px 24px rgba(0,0,0,0.28)",
              overflow: "hidden",
              userSelect: "none",
              fontSize: "var(--text-2xs)",
            }}
          >
            {/* 채도(가로) · 명도(세로) 판 */}
            <div
              data-color-sv
              {...drag(svAt)}
              style={{
                position: "relative",
                height: 136,
                cursor: "crosshair",
                touchAction: "none",
                background: `linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, hsl(${hsv.h} 100% 50%))`,
              }}
            >
              <span
                style={{
                  position: "absolute",
                  left: `${hsv.s * 100}%`,
                  top: `${(1 - hsv.v) * 100}%`,
                  width: 12,
                  height: 12,
                  margin: -6,
                  borderRadius: "50%",
                  border: "2px solid #fff",
                  boxShadow: "0 0 0 1px rgba(0,0,0,0.45)",
                  boxSizing: "border-box",
                  pointerEvents: "none",
                }}
              />
            </div>
            {/* 스포이드 · 지금 색 · 색상 막대 */}
            <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 10px 8px" }}>
              <button
                ref={pipette}
                type="button"
                data-color-pipette
                data-on={picking ? "" : undefined}
                aria-pressed={picking}
                data-tip={t("editor.eyedropper")}
                onClick={() => {
                  setPicking((p) => !p);
                  setHover(null);
                }}
                style={{
                  display: "grid",
                  placeItems: "center",
                  width: 26,
                  height: 26,
                  flexShrink: 0,
                  borderRadius: "var(--r-2)",
                  border: `1px solid ${picking ? "var(--accent)" : "transparent"}`,
                  background: picking ? "var(--accent-bg)" : "transparent",
                  color: picking ? "var(--ink)" : "var(--ink-soft)",
                }}
              >
                {Icon.pipette}
              </button>
              <span style={{ width: 22, height: 22, flexShrink: 0, borderRadius: "50%", background: hex, boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.18)" }} />
              <div data-color-hue {...drag((fx) => hueAt(fx))} style={{ position: "relative", flex: 1, height: 10, borderRadius: 5, touchAction: "none", cursor: "pointer", background: "linear-gradient(to right, #f00, #ff0, #0f0, #0ff, #00f, #f0f, #f00)" }}>
                <span
                  style={{
                    position: "absolute",
                    left: `${(hsv.h / 360) * 100}%`,
                    top: "50%",
                    width: 14,
                    height: 14,
                    margin: "-7px 0 0 -7px",
                    borderRadius: "50%",
                    border: "2px solid #fff",
                    boxShadow: "0 0 0 1px rgba(0,0,0,0.45)",
                    boxSizing: "border-box",
                    background: `hsl(${hsv.h} 100% 50%)`,
                    pointerEvents: "none",
                  }}
                />
              </div>
            </div>
            {/* RGB · HEX 칸 */}
            <div style={{ display: "flex", alignItems: "flex-start", gap: 6, padding: "0 10px 10px" }}>
              {mode === "rgb" ? (
                (["R", "G", "B"] as const).map((k, i) => (
                  <div key={k} style={{ flex: 1, minWidth: 0 }}>
                    <Field
                      mark={`data-color-${k.toLowerCase()}`}
                      value={String(Math.round(rgb[i]))}
                      style={field}
                      commit={(s) => {
                        if (!/^\d{1,3}$/.test(s.trim())) return;
                        const next = [...rgb] as Rgb;
                        next[i] = clamp(Number(s), 0, 255);
                        set(hsvOf(rgbToHex(...next), hsvRef.current));
                      }}
                    />
                    <div style={fieldLabel}>{k}</div>
                  </div>
                ))
              ) : (
                <div style={{ flex: 3, minWidth: 0 }}>
                  <Field
                    mark="data-color-hex"
                    value={hex}
                    style={field}
                    commit={(s) => {
                      const c = hexToRgb(s);
                      if (c) set(hsvOf(rgbToHex(...c), hsvRef.current));
                    }}
                  />
                  <div style={fieldLabel}>HEX</div>
                </div>
              )}
              <button
                type="button"
                data-color-mode={mode}
                onClick={() => setMode((m) => (m === "rgb" ? "hex" : "rgb"))}
                style={{ ...field, width: "auto", flexShrink: 0, padding: "3px 6px", color: "var(--ink-soft)", cursor: "pointer" }}
              >
                {mode === "rgb" ? "HEX" : "RGB"}
              </button>
            </div>
          </div>,
          win.document.body,
        )}
      {picking &&
        hover?.hex &&
        createPortal(
          <span
            data-color-loupe
            style={{
              position: "fixed",
              left: hover.x + 14,
              top: hover.y + 14,
              width: 22,
              height: 22,
              borderRadius: "50%",
              background: hover.hex,
              border: "2px solid #fff",
              boxShadow: "0 0 0 1px rgba(0,0,0,0.5), 0 2px 8px rgba(0,0,0,0.35)",
              pointerEvents: "none",
              zIndex: 8001,
            }}
          />,
          win.document.body,
        )}
    </>
  );
}

/** 글로 치는 칸 — 치는 동안은 친 글을 들고 있고, 맞는 값일 때마다 반영한다. 칸을 떠나면 지금 값으로 돌아온다 */
function Field({ value, commit, style, mark }: { value: string; commit: (s: string) => void; style: React.CSSProperties; mark: string }) {
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <input
      {...{ [mark]: "" }}
      type="text"
      spellCheck={false}
      value={draft ?? value}
      onChange={(e) => {
        setDraft(e.target.value);
        commit(e.target.value);
      }}
      onBlur={() => setDraft(null)}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
      }}
      style={style}
    />
  );
}
