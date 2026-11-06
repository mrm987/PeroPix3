import { useEffect, useState } from "react";
import { useI18n } from "../i18n";
import { coverLayout } from "./FittedImg";
import { pointerGesture, isGestureActive, cancelGesture } from "./dragStore";
import { useWin } from "../lib/floatWin";
import type { View } from "../store/prompt";
import { BANNER_BG, BANNER_CUT, BANNER_IMG_W, BANNER_STEP } from "./banner";

/** 생성물을 그림으로 꽂을 때 **위치를 잡는 자리**.
 *
 *  ★미리보기 = 실물. 배너는 실제와 같은 240px 고정 폭 + 우측 검정이고,
 *    상자(덱 앞면·덱 커버)는 실물과 **같은 비율을 크게** 보여 준다.
 *    cover 배치 계산은 크기에 선형이라(coverLayout), 확대해 보여도 구도는 한 픽셀도 다르지 않다.
 *    작게 보여 주면 손이 떨려 못 맞춘다 — 크게 보여 주는 편이 정확하다.
 *  ★드래그는 커서와 1:1 — 넘치는 픽셀 양으로 환산한다. */
export type ThumbAsk = {
  url: string;
  /** 있으면 배너 미리보기(세로만 조정, 폭 240 고정) */
  banner?: View;
  /** 상자 미리보기들 — 덱 카드 앞면(138×118)·덱 커버(58×80) 등 */
  boxes: { key: string; label: string; w: number; h: number; view: View }[];
};

export type ThumbResult = { banner?: View; boxes: Record<string, View> };

/** 배너의 그림 영역 — 목업 .bimg 그대로. 패널을 넓혀도 이 폭은 늘지 않는다 */

export const BANNER_H = 56;

/** 상자 미리보기를 이 높이에 맞춰 키운다 (비율 유지) */
const BOX_PREVIEW_H = 190;
const BANNER_PREVIEW_W = 396;

export function ThumbDialog({
  ask,
  onDone,
  onCancel,
}: {
  ask: ThumbAsk | null;
  onDone: (r: ThumbResult) => void;
  onCancel: () => void;
}) {
  const t = useI18n((s) => s.t);
  const win = useWin();
  const [banner, setBanner] = useState<View | undefined>(ask?.banner);
  const [boxes, setBoxes] = useState<Record<string, View>>(() =>
    Object.fromEntries((ask?.boxes ?? []).map((b) => [b.key, b.view])),
  );
  const [nat, setNat] = useState<{ W: number; H: number } | null>(null);

  // ★값을 `ask` 의 **참조**로 다시 세우지 않는다. 부모가 인라인 객체로 넘기므로
  //   부모가 무슨 이유로든 다시 렌더되면 참조가 바뀌고, 그때마다 사용자가 잡아 둔
  //   위치가 조용히 초기값으로 돌아간다 — "적용해도 안 먹는다"로 보인다.
  //   대신 **호출부가 key 로 창을 갈아 끼운다** (App 참조).

  useEffect(() => {
    if (!ask) return;
    const key = (e: KeyboardEvent) => {
      // ★끌고 있는 중이면 Esc 는 **그 드래그만** 되돌린다 — 창까지 닫으면 되돌릴 길이 없다
      if (e.key === "Escape") isGestureActive() ? cancelGesture() : onCancel();
      if (e.key === "Enter" && !isGestureActive()) onDone({ banner, boxes });
    };
    win.addEventListener("keydown", key);
    return () => win.removeEventListener("keydown", key);
  }, [win, ask, onCancel, onDone, banner, boxes]);

  if (!ask) return null;

  // 상자들을 같은 높이로 키운 뒤 실제 표시 폭을 구한다 — 모달 폭이 내용에서 나온다
  const shown = ask.boxes.map((b) => {
    const s = BOX_PREVIEW_H / b.h;
    return { ...b, sw: Math.round(b.w * s), sh: BOX_PREVIEW_H };
  });
  const rowW = shown.reduce((n, b) => n + b.sw, 0) + (shown.length - 1) * 12;
  const contentW = Math.max(banner ? BANNER_PREVIEW_W : 0, rowW, 280);

  return (
    <div
      onPointerDown={(e) => e.target === e.currentTarget && !isGestureActive() && onCancel()}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 70,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "rgba(10,14,19,0.6)",
        backdropFilter: "blur(2px)",
      }}
    >
      <div
        style={{
          padding: "var(--sp-8)",
          borderRadius: "var(--r-4)",
          background: "var(--surface)",
          border: "1px solid var(--line)",
          boxShadow: "0 20px 50px rgba(0,0,0,0.45)",
          display: "flex",
          flexDirection: "column",
          alignItems: "stretch",
          gap: "var(--sp-6)",
          width: contentW + 40, // 좌우 --sp-8
        }}
      >
        <header style={{ display: "flex", flexDirection: "column", gap: "var(--sp-1)" }}>
          <b style={{ fontSize: "var(--text-lg)", lineHeight: 1.3 }}>{t("thumb.title")}</b>
          <span style={{ fontSize: "var(--text-2xs)", color: "var(--ink-dim)", lineHeight: 1.5 }}>
            {t("thumb.hint")}
          </span>
        </header>

        {/* 자연 크기를 재는 숨은 로더 — 드래그를 픽셀 1:1 로 환산하는 데 필요하다 */}
        {!nat && (
          <img
            src={ask.url}
            alt=""
            style={{ display: "none" }}
            onLoad={(e) =>
              setNat({ W: e.currentTarget.naturalWidth, H: e.currentTarget.naturalHeight })
            }
          />
        )}

        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: "var(--sp-6)",
          }}
        >
          {banner && (
            <Field label={t("thumb.inBanner")} width={contentW}>
              <BannerPreview
                url={ask.url}
                nat={nat}
                view={banner}
                setView={setBanner}
                width={contentW}
              />
            </Field>
          )}

          {shown.length > 0 && (
            <div style={{ display: "flex", gap: "var(--sp-5)", alignItems: "flex-end" }}>
              {shown.map((b) => {
                const view = boxes[b.key] ?? b.view;
                return (
                  <Field
                    key={b.key}
                    label={b.label}
                    width={b.sw}
                    right={`${Math.round(view.zoom * 100)}%`}
                  >
                    <BoxPreview
                      url={ask.url}
                      nat={nat}
                      w={b.sw}
                      h={b.sh}
                      view={view}
                      setView={(v) => setBoxes((cur) => ({ ...cur, [b.key]: v }))}
                    />
                  </Field>
                );
              })}
            </div>
          )}
        </div>

        <footer
          style={{
            display: "flex",
            gap: "var(--sp-3)",
            justifyContent: "flex-end",
            paddingTop: "var(--sp-2)",
            borderTop: "1px solid var(--line)",
          }}
        >
          <Btn onClick={onCancel}>{t("cards.cancel")}</Btn>
          <Btn onClick={() => onDone({ banner, boxes })} primary>
            {t("thumb.apply")}
          </Btn>
        </footer>
      </div>
    </div>
  );
}

/** 라벨 + 미리보기 한 벌 — 라벨 줄의 폭이 미리보기와 정확히 같아 좌우가 딱 맞는다 */
function Field({
  label,
  width,
  right,
  children,
}: {
  label: string;
  width: number;
  right?: string;
  children: React.ReactNode;
}) {
  return (
    <div style={{ width, display: "flex", flexDirection: "column", gap: "var(--sp-2)" }}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "baseline",
          fontSize: "var(--text-2xs)",
          color: "var(--ink-dim)",
          fontWeight: "var(--w-semi)",
        }}
      >
        <span>{label}</span>
        {right && (
          <span style={{ fontWeight: "var(--w-normal)", fontFamily: "var(--font-mono)", color: "var(--ink-faint)" }}>
            {right}
          </span>
        )}
      </div>
      {children}
    </div>
  );
}

/** 커서 1:1 드래그 — 시작 시점의 넘침(overflow)으로 픽셀→% 를 환산한다.
 *
 *  ★`pointerGesture` 를 거친다: 포인터를 캡처해 **영역을 벗어나도 이 미리보기가 계속 받고**,
 *    옆의 다른 미리보기가 끼어들지 않으며, 화면 전체 커서가 잡는 모양으로 고정된다.
 *  ★취소(Esc·창 포커스 상실·포인터 유실)면 **끌기 전 값으로 되돌린다** — 반쯤 끌린 채
 *    남으면 사용자는 자기가 뭘 했는지 모른다. */
function dragTo(
  e: React.PointerEvent,
  view: View,
  over: { x: number; y: number },
  setView: (v: View) => void,
) {
  const sx = e.clientX;
  const sy = e.clientY;
  const start = view;
  pointerGesture(e, {
    onMove: (ev) => {
      const dx = ev.clientX - sx;
      const dy = ev.clientY - sy;
      setView({
        ...start,
        px: over.x <= 0 ? start.px : clamp(start.px - (dx / over.x) * 100),
        py: over.y <= 0 ? start.py : clamp(start.py - (dy / over.y) * 100),
      });
    },
    onEnd: (committed) => {
      if (!committed) setView(start);
    },
  });
}

/** 배너 미리보기 — 실물처럼 그림 240px 고정 + 우측은 검정. 세로만 움직인다 */
function BannerPreview({
  url,
  nat,
  view,
  setView,
  width,
}: {
  url: string;
  nat: { W: number; H: number } | null;
  view: View;
  setView: (v: View) => void;
  width: number;
}) {
  const L = nat ? coverLayout(BANNER_IMG_W, BANNER_H, nat.W, nat.H, view) : null;
  return (
    <div
      // ★커서와 조작을 다른 미리보기와 같게 둔다 — 여기만 ns-resize 였던 것이 지적받았다.
      //   가로로 넘치는 만큼은 가로도 움직인다 (확대하면 생긴다). 넘침이 0 이면 dragTo 가 무시한다.
      onPointerDown={(e) => L && dragTo(e, view, { x: L.overX, y: L.overY }, setView)}
      // ★끄는 중에는 확대를 막는다 — 배율이 바뀌면 넘침이 달라져 1:1 환산의 기준이 무너진다
      onWheel={(e) =>
        !isGestureActive() &&
        setView({ ...view, zoom: clampZoom(view.zoom + (e.deltaY < 0 ? 0.08 : -0.08)) })
      }
      style={{
        position: "relative",
        width,
        height: BANNER_H,
        borderRadius: "var(--r-3)",
        overflow: "hidden",
        cursor: "grab",
        background: BANNER_BG,
        touchAction: "none",
        userSelect: "none",
      }}
    >
      <div
        style={{
          position: "absolute",
          left: 0,
          top: 0,
          bottom: 0,
          width: BANNER_IMG_W,
          overflow: "hidden",
          // ★실물 배너와 **같은 계단 컷** — 여기서 잡은 위치가 그대로 배너에 쓰이므로
          //   미리보기가 다르게 생기면 무엇을 잡는 것인지 알 수 없다 (사용자 지적).
          maskImage: BANNER_CUT,
          WebkitMaskImage: BANNER_CUT,
        }}
      >
        {L && (
          <img
            src={url}
            alt=""
            draggable={false}
            style={{
              position: "absolute",
              left: L.left,
              top: L.top,
              width: L.dW,
              height: L.dH,
              maxWidth: "none",
              pointerEvents: "none",
            }}
          />
        )}
        {/* 중간 단 — 실물 배너와 같다 */}
        <div style={{ position: "absolute", inset: 0, pointerEvents: "none", background: BANNER_STEP }} />
      </div>
    </div>
  );
}

/** 상자 미리보기 — 실물과 같은 비율을 키워서. 드래그 = 초점(1:1), 휠 = 확대 */
function BoxPreview({
  url,
  nat,
  w,
  h,
  view,
  setView,
}: {
  url: string;
  nat: { W: number; H: number } | null;
  w: number;
  h: number;
  view: View;
  setView: (v: View) => void;
}) {
  const L = nat ? coverLayout(w, h, nat.W, nat.H, view) : null;
  return (
    <div
      onPointerDown={(e) => L && dragTo(e, view, { x: L.overX, y: L.overY }, setView)}
      onWheel={(e) =>
        !isGestureActive() &&
        setView({ ...view, zoom: clampZoom(view.zoom + (e.deltaY < 0 ? 0.08 : -0.08)) })
      }
      style={{
        position: "relative",
        width: w,
        height: h,
        borderRadius: "var(--r-3)",
        overflow: "hidden",
        cursor: "grab",
        background: BANNER_BG,
        border: "1px solid var(--line)",
        touchAction: "none",
        userSelect: "none",
      }}
    >
      {L && (
        <img
          src={url}
          alt=""
          draggable={false}
          style={{
            position: "absolute",
            left: L.left,
            top: L.top,
            width: L.dW,
            height: L.dH,
            maxWidth: "none",
            pointerEvents: "none",
          }}
        />
      )}
    </div>
  );
}

const clamp = (v: number) => Math.max(0, Math.min(100, v));
const clampZoom = (v: number) => Math.max(1, Math.min(3, v));

function Btn({
  onClick,
  primary,
  children,
}: {
  onClick: () => void;
  primary?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      style={{
        padding: "var(--sp-3) var(--sp-7)",
        borderRadius: "var(--r-2)",
        fontSize: "var(--text-xs)",
        fontWeight: primary ? "var(--w-semi)" : "var(--w-normal)",
        border: primary ? "1px solid var(--accent)" : "1px solid var(--line)",
        background: primary ? "var(--accent)" : "var(--surface2)",
        color: primary ? "var(--accent-on)" : "var(--ink-soft)",
      }}
    >
      {children}
    </button>
  );
}
