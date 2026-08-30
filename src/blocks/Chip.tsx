import { useEffect, useRef, useState } from "react";
import { wheelIsOver } from "../lib/wheelAt";
import { COLOR_HEX, fmtW, weightTone, type Tag } from "../lib/blocks";
import { useUi } from "../store/ui";

/** 돌리는 동안 얼려 둘 칩 폭 — **바꾸기 전에** 계산한다.
 *
 *  지금 폭에서 지금 배지를 빼고, 돌리는 동안 쓸 배지(두 자리 고정)의 폭을 더한다.
 *  배지가 없으면 잠깐 넣어 글자 하나 폭을 재고 지운다 — React 가 다시 그리기 전의
 *  동기 작업이라 화면에는 안 보인다.
 *  ★★**늘려도 같은 줄에 남을 때만 늘린다** (사용자 지적 2026-08-22). 배지가 들어갈 자리는
 *    한 번은 생겨야 하는데, 칩이 줄 끝에 있으면 그 한 번에 다음 줄로 넘어가 버린다 —
 *    고치려던 바로 그 증상이다. 자리가 모자라면 **지금 폭 그대로** 얼린다: 태그 이름이
 *    말줄임으로 조금 잘리지만 칩은 제자리에 있다. 두 번 지적받은 것이 「칩이 움직인다」다.
 *  ★음수는 부호만큼 한 칸 더 든다. 지금 값의 부호로 잡으므로, 한 번의 조작 안에서
 *    부호를 넘나들면 그만큼 태그 이름이 잘릴 수 있다 (드물어서 그대로 둔다).
 *  ★못 재면 `null` — 그때는 안 얼린다 (예전처럼 튀되, 잘못된 폭으로 굳지는 않는다). */
function pinWidth(el: HTMLElement, w: number | null): number | null {
  const r = el.getBoundingClientRect();
  const now = r.width;
  if (!now) return null;
  /** 늘린 폭이 이 줄에 들어가나 — 안 들어가면 지금 폭으로 얼린다 */
  const fits = (want: number) => {
    const box = el.parentElement;
    if (!box) return want;
    const p = box.getBoundingClientRect();
    const right = p.right - parseFloat(getComputedStyle(box).paddingRight || "0");
    return r.left + want <= right ? want : now;
  };
  const chars = (w ?? 1).toFixed(2).length;   // 돌리는 동안의 표기와 같아야 한다
  const b = el.querySelector("b");
  if (b) {
    const bw = b.getBoundingClientRect().width;
    const per = bw / Math.max(1, (b.textContent ?? "").length);
    return fits(now - bw + per * chars);
  }
  // 배지가 아직 없다 — 같은 모양으로 하나 넣어 재고 지운다 (간격 `gap: 4` 도 새로 생긴다)
  const probe = document.createElement("b");
  probe.style.cssText = "font-family:var(--font-mono);font-size:0.92em;visibility:hidden;position:absolute";
  probe.textContent = "0".repeat(chars);
  el.appendChild(probe);
  const pw = probe.getBoundingClientRect().width;
  probe.remove();
  return pw ? fits(now + pw + 4) : null;
}

/** 태그 칩.
 *  - **끌기 = 자리 옮기기** (같은 블록 안에서도, 다른 블록으로도 — `useTagDrag`)
 *  - **Alt + 휠 = 가중치** (0.05 단위, Alt+Shift 로 0.1)
 *  - **휠 클릭(가운데 버튼) = 가중치 초기화(1)**
 *  - 우클릭 = 삭제
 *  - ★가중치 강조 수준에 따라 칩 색이 변한다 */
export function Chip({
  tag,
  dup,
  dragProps,
  dragging,
  onWeight,
  onWeightStart,
  onRemove,
  readOnly,
}: {
  tag: Tag;
  dup?: boolean;
  /** 보여 주기만 하는 자리 (블록 저장소의 펼친 내용) — 휠·우클릭이 안 먹는다.
   *  ★고치는 창구는 **프롬프트 쪽 하나**다. 저장소에서도 고치게 하면 어디서 고쳤나가 된다 */
  readOnly?: boolean;
  /** 끌기 손잡이 — 칩 전체가 손잡이다 */
  dragProps?: React.HTMLAttributes<HTMLSpanElement> & { style?: React.CSSProperties };
  dragging?: boolean;
  onWeight: (w: number | null) => void;
  /** ★가중치를 **만지기 시작했다** — 부르는 쪽이 되돌리기 한 칸을 그때 담는다.
   *  ★한 차례 조절(휠을 몇 번 돌리든)에 **한 번만** 온다. 눈금마다 오면 Ctrl+Z 를
   *    수십 번 눌러야 원래대로 돌아간다. 가운데 버튼의 초기화도 한 차례로 친다. */
  onWeightStart?: () => void;
  onRemove: () => void;
}) {
  /** 가중치 강조를 켜 두나 (설정) — 끄면 **평범한 칩**으로 보인다 (겹침 표시는 남는다) */
  const hl = useUi((u) => u.weightHl);
  const tone0 = hl ? weightTone(tag.w) : { sign: 0 as const, s: 0 };

  /** ★★가중치는 **Alt + 휠**이다 (사용자 지시 2026-08-21).
   *
   *  ★맨 휠로 두면 프롬프트를 훑어 내리다 **지나가는 칩의 가중치가 바뀐다** — 바뀐 줄도
   *    모르고 그대로 생성하게 된다 (실제로 그렇게 2.6 이 박혀 초록 노이즈가 나왔다).
   *  ★**네이티브 리스너로 붙인다.** React 의 `onWheel` 은 뿌리에 passive 로 달려서
   *    `preventDefault()` 가 안 먹는다 — 그대로 두면 가중치와 스크롤이 **함께** 일어난다. */
  const ref = useRef<HTMLSpanElement | null>(null);
  const onWeightRef = useRef(onWeight);
  onWeightRef.current = onWeight;
  const wRef = useRef(tag.w);
  wRef.current = tag.w;

  /** ★★**돌리는 동안에는 칩의 폭을 얼린다** (사용자 지적 2026-08-21).
   *
   *  가중치 배지는 글자 수가 계속 바뀐다 (`1.05` → `1.1` → 1 이 되면 아예 사라진다).
   *  칩이 그때마다 넓어졌다 좁아지면 **줄바꿈이 다시 계산돼 칩이 다음 줄로 밀리고**,
   *  커서 밑에 칩이 없어진 순간부터 휠이 패널 스크롤로 가 버린다 — 가중치를 맞추다
   *  화면이 통째로 굴러간다.
   *  ★그래서 폭을 얼린다. 칩 안에서만 글자가 움직이고 줄은 안 바뀐다.
   *    1 이 되어도 배지를 지우지 않는다 — 지우면 칩 안이 한 번 더 출렁인다.
   *
   *  ★★**첫 눈금이 그려지기 전에**, 배지가 다 든 폭을 계산해서 얼린다 (`pinWidth`).
   *    두 번 헛디딘 자리라 근거를 남긴다:
   *      · 첫 눈금 **뒤에** 재면(`useLayoutEffect`) 그 한 번의 넓어짐이 이미 화면에 반영돼
   *        **거기서 줄이 바뀐다.** 특히 이미 가중치가 있는 칩은 `1.2`→`1.20` 으로 한 글자
   *        넓어져서 **거의 매번** 튀었다 (사용자 지적 2026-08-22).
   *      · 첫 눈금 **전의** 폭으로 얼리면 배지가 들어갈 자리가 없어 태그 이름이 잘린다.
   *    그래서 재지 말고 **계산한다**: 지금 폭에서 지금 배지를 빼고, 들어갈 배지 폭을 더한다.
   *    배지가 등폭 글꼴이라 글자 하나 폭만 알면 되고, 배지가 없으면 잠깐 넣어 재고 지운다
   *    (React 가 다시 그리기 전의 동기 작업이라 화면에 안 보인다).
   *  ★★돌리는 동안은 **자릿수를 두 자리로 고정**한다 (`1.05`·`1.10`·`1.00`). `fmtW` 는 끝의 0 을
   *    떼어 내 글자 수가 오락가락하는데, 겉폭이 고정이라 그만큼 칩 안에 빈칸이 남는다
   *    (실측 2026-08-22: 최대 22px → 2px). 놓으면 곧바로 원래 표기로 돌아온다.
   *  ★★배지에 `minWidth` 로 **자리를 미리 비워 두지 말 것** (사용자 지적 2026-08-22) —
   *    숫자 왼쪽에 빈칸이 남고, 그것이 고정 풀릴 때에야 사라져 **반응이 느린 것처럼** 보였다.
   *  ★★푸는 때는 **커서가 칩을 벗어날 때뿐**이다 (사용자 지시 2026-08-21·22).
   *    ★그 손은 **네이티브로, 언제나** 매달려 있다 (아래 ★★주) — 리액트 쪽에 조건부로 달면
   *      얼린 직후 곧바로 손을 뺐을 때 떠나는 이벤트를 놓친다.
   *    ~~마지막 휠에서 얼마 지나면 스스로 푸는 안전장치~~를 뒀다가 걷었다 — 손만 멈추면
   *    커서가 그대로 위에 있는데도 몇 초 뒤 줄이 바뀌어 버렸다. 다시 넣지 말 것.
   *    안 풀린 채로 남아도 손해는 칩이 몇 px 넓은 것뿐이고, 다음에 커서가 지나가면 풀린다.
   *  ★긴 태그는 이 동안 말줄임으로 잘릴 수 있다 — 폭이 고정되고 배지가 자리를 차지해서다.
   *    놓으면 곧바로 돌아온다. 줄이 튀는 것보다 낫다고 봤다. */
  const [pin, setPin] = useState<number | null>(null);
  const pinning = useRef(false);
  const release = () => {
    pinning.current = false;
    setPin(null);
  };
  const onStartRef = useRef(onWeightStart);
  onStartRef.current = onWeightStart;

  useEffect(() => {
    const el = ref.current;
    if (!el || readOnly) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.altKey) return;      // 맨 휠은 평소대로 스크롤이다
      /* ★★**커서가 아직 이 칩 위인가**를 묻는다 (`lib/wheelAt` 의 ★★주).
         브라우저는 휠 제스처를 처음 잡은 요소에 매어 두므로(래칭), 이것이 없으면
         **커서가 떠난 뒤에도 가중치가 계속 바뀌고**, 커서가 간 곳(큰 그림)은 휠을 못 받는다
         (사용자 지적 2026-08-24). */
      if (!wheelIsOver(el, e)) return;
      e.preventDefault();
      if (!pinning.current) {
        pinning.current = true;
        onStartRef.current?.();               // ★되돌릴 한 칸은 **한 차례에 한 번** (위 주)
        setPin(pinWidth(el, wRef.current));   // ★바꾸기 **전에** 얼린다 (위 ★★주)
      }
      const step = e.shiftKey ? 0.1 : 0.05;
      const cur = wRef.current ?? 1;
      const next = Math.round((cur + (e.deltaY < 0 ? step : -step)) * 100) / 100;
      onWeightRef.current(next === 1 ? null : next);
    };
    /* ★★**푸는 손은 여기 네이티브로, 언제나 매달아 둔다** (사용자 지시 2026-08-22:
         *"커서가 칩을 떠났을때 즉시 편집 종료되게"*).
       예전에는 리액트 쪽에 `onPointerLeave={pin != null ? release : undefined}` 로 달아서,
       **얼린 뒤 다시 그려진 다음에야** 손이 생겼다. 마지막 눈금을 굴리고 곧바로 손을 빼면
       그 사이에 떠나는 이벤트가 지나가 버려 **얼린 폭이 그대로 남았다.**
       이제 조절이 시작되기 전부터 매달려 있으므로 놓칠 자리가 없다. */
    el.addEventListener("wheel", onWheel, { passive: false });
    el.addEventListener("pointerleave", release);
    return () => {
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("pointerleave", release);
    };
  }, [readOnly]);

  // ★부호가 색을 가르고, 세기는 값이 오를수록 한결같이 진해진다 (`weightTone`):
  //   배경 6~28% · 테두리 25~80% 를 세기(0~1)로 잇는다
  const tone = (() => {
    if (tone0.sign === 0) return { bg: "var(--chip-bg)", bd: "var(--line)", fg: "var(--ink)" };
    const hue = tone0.sign > 0 ? "var(--accent)" : "var(--minus)";
    const bg = Math.round(6 + 22 * tone0.s);
    const bd = Math.round(25 + 55 * tone0.s);
    return {
      bg: `color-mix(in srgb, ${hue} ${bg}%, var(--chip-bg))`,
      bd: `color-mix(in srgb, ${hue} ${bd}%, var(--line))`,
      fg: "var(--ink)",
    };
  })();

  return (
    <span
      data-chip
      {...dragProps}
      ref={ref}
      onMouseDown={(e) => {
        // 가운데 버튼의 브라우저 기본 동작(자동 스크롤)을 막는다
        if (e.button === 1) e.preventDefault();
      }}
      onAuxClick={(e) => {
        if (readOnly || e.button !== 1) return;
        e.preventDefault();
        onWeightStart?.();   // ★이것도 가중치를 만지는 것이다 — 되돌릴 수 있어야 한다
        onWeight(null);      // 가중치 초기화
      }}
      onContextMenu={(e) => {
        if (readOnly) return;
        e.preventDefault();
        onRemove();
      }}
      data-tip={readOnly ? tag.t : undefined}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        maxWidth: "100%",
        padding: "1px 7px",
        borderRadius: "var(--r-1)",
        background: tone.bg,
        border: `1px solid ${dup ? "var(--warn)" : tone.bd}`,
        color: tone.fg,
        // ★프롬프트를 **읽고 치는 글자**다 — v2 와 같은 14px (`--text-prompt`)
        fontSize: "var(--text-prompt)",
        cursor: "default",
        userSelect: "none",
        // 끌고 있는 칩은 자리만 지키고 흐려진다 (고스트가 커서를 따라간다)
        opacity: dragging ? 0.3 : 1,
        ...(dragProps?.style ?? {}),
        // ★얼린 폭은 **맨 마지막**이다 — 끌기 쪽 스타일이 덮으면 다시 줄이 튄다
        ...(pin != null ? { width: pin, flexShrink: 0 } : null),
      }}
    >
      {(tag.w != null || pin != null) && (
        <b
          style={{
            fontFamily: "var(--font-mono)",
            /* ★**상대값이라 그대로 둔다** — 칩 글자의 92%다. 토큰으로 바꾸면 칩 크기를
                 바꿔도 이 표시만 안 따라온다 (계층의 뜻과 반대다). */
              fontSize: "0.92em",
            color: (tag.w ?? 1) < 0 ? "var(--minus-ink)" : "var(--accent-ink)",
            /* ★★자리를 **미리 비워 두지 말 것** (사용자 지적 2026-08-22).
               `minWidth: 5ch` + 우측 정렬로 넉넉히 잡았더니 숫자 왼쪽에 빈칸이 크게 남고,
               그 빈칸이 고정이 풀릴 때(1초 뒤)에야 사라져 **반응이 느린 것처럼** 보였다.
               칩의 겉폭은 이미 얼려 두었으므로(`pin`) 줄바꿈은 배지 폭과 무관하다 —
               배지는 제 글자만큼만 차지하면 된다. */
            ...(pin != null ? { flexShrink: 0 } : null),
          }}
        >
          {/* ★★돌리는 동안은 **자릿수를 고정**한다 (`1.10`·`1.00`) — `fmtW` 는 끝의 0 을
              떼어 내서 `1.05`→`1.1`→`1` 로 글자 수가 오락가락하고, 겉폭이 고정이라
              그만큼 칩 안에 빈칸이 남는다 (실측 2026-08-22: 최대 22px). 두 자리로 붙들면
              부호가 바뀔 때 말고는 폭이 안 변한다. 놓으면 곧바로 원래 표기로 돌아온다. */}
          {pin != null ? (tag.w ?? 1).toFixed(2) : fmtW(tag.w!)}
        </b>
      )}
      <span
        style={{
          /* ★★**태그를 줄이지 않는다** (사용자 지적 2026-08-22). 예전에는 22em 을 넘으면
               말줄임으로 잘랐는데, 글 상자 쪽은 안 자르므로 **같은 태그가 두 모습에서 다르게**
               보였다 (그리고 잘린 뒷부분은 아예 읽을 수 없었다).
             ★줄보다 긴 태그는 **칩 안에서 접는다** — 칩 하나로 보이는 것은 그대로이고,
               칩 사이에서 갈라지는 일도 없다. 밖으로 넘쳐 잘리는 것보다 낫다. */
          overflowWrap: "anywhere",
        }}
      >
        {tag.t}
      </span>
    </span>
  );
}

export const colorHex = (c: string | null) => (c ? COLOR_HEX[c] : "var(--line)");
