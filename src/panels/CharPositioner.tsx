import { useEffect, useMemo, useRef, useState } from "react";
import { useGen, modelCaps } from "../store/gen";
import { usePrompt } from "../store/prompt";
import { useImageInput } from "../store/imageInput";
import { useUi } from "../store/ui";
import { useI18n } from "../i18n";
import { Icon } from "../components/Icon";
import { crowded, snapCenter, toCenter, CENTER_GRID, type Center } from "../lib/charPos";

/** 배치와 관련된 화면이 **모두 같은 판정을 본다** — 세 곳에서 따로 세면 어긋난다.
 *
 *  ★공홈은 인물이 하나뿐일 때 배치를 여는 조건으로 `canPositionOneCharacter` 를 따로 두는데,
 *    번들의 **모델 일곱 군을 전수로 대조하니 `freeformCharacterPosition` 과 언제나 같았다**
 *    (2026-08-21). 값이 하나면 표도 하나다 — 두 번째 플래그를 만들지 않는다.
 */
function usePositioning() {
  const model = useGen((s) => s.params.model);
  const useCoords = useGen((s) => s.params.use_coords);
  const positioning = useUi((u) => u.positioning);
  const setPositioning = useUi((u) => u.setPositioning);
  const allChars = usePrompt((s) => s.chars);
  /* ★★셀렉터 안에서 **새 배열·객체를 만들지 말 것** — zustand v5 는 `Object.is` 로 비교해서
     매 렌더 다른 값이 되고, React 가 「getSnapshot 이 캐시되지 않았다」로 죽는다
     (실측 2026-08-21: `.map(c => c.center)` 를 셀렉터에 넣었다가 **화면이 통째로 안 떴다**).
     스토어에서는 참조가 안 바뀌는 것만 꺼내고, 가공은 `useMemo` 로 한다. */
  const centers = useMemo(() => allChars.filter((c) => c.on).map((c) => c.center), [allChars]);
  const freeform = modelCaps(model).freeform_position;
  const canPosition = centers.length >= 2 || (centers.length === 1 && freeform);
  return { useCoords, positioning, setPositioning, centers, freeform, canPosition };
}

/** 좌표를 쓰는 방식 2택 + 판 여닫기 — **캐릭터 프롬프트 카테고리 이름 줄 오른쪽**에 선다
 *  (사용자 지시 2026-08-21). 공홈도 캐릭터 프롬프트 패널에 둔다 (`dg()` 의 `sR` 세그먼트).
 *
 *  ★★2택을 아이콘 하나로 줄이지 말 것 — **좌표를 다시 끄는 창구가 사라진다.**
 *    판을 닫아도 좌표는 켜진 채라, AI 배치로 돌아갈 방법이 없어진다.
 *  ★판 여닫기 아이콘을 누르면 좌표를 켜면서 연다 (공홈 `i.use_coords||n({...}); g(!p)`). */
export function CharPositionToggle() {
  const tr = useI18n((s) => s.t);
  const { useCoords, positioning, setPositioning, canPosition } = usePositioning();
  const set = useGen((s) => s.set);
  if (!canPosition) return null;

  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "stretch",
        borderRadius: "var(--r-2)",
        border: "1px solid var(--line)",
        overflow: "hidden",
        fontSize: "var(--text-2xs)",
        fontWeight: "var(--w-normal)",
      }}
    >
      <button
        data-position-mode="ai"
        onClick={() => set("use_coords", false)}
        data-tip={tr("pos.aiTip")}
        style={{ ...segBtn, ...(useCoords ? null : segOn) }}
      >
        {tr("pos.ai")}
      </button>
      <button
        data-position-mode="custom"
        onClick={() => set("use_coords", true)}
        data-tip={tr("pos.customTip")}
        style={{ ...segBtn, ...(useCoords ? segOn : null), borderLeft: "1px solid var(--line)" }}
      >
        {tr("pos.custom")}
      </button>
      <button
        data-position-toggle={positioning ? "on" : "off"}
        onClick={() => {
          if (!useCoords) set("use_coords", true);
          setPositioning(!positioning);
        }}
        data-tip={positioning ? tr("pos.close") : tr("pos.open")}
        style={{ ...segBtn, ...(positioning ? segOn : null), borderLeft: "1px solid var(--line)", padding: "3px var(--sp-2)" }}
      >
        {Icon.grid}
      </button>
    </span>
  );
}

const segBtn: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 4,
  border: "none",
  background: "transparent",
  padding: "3px var(--sp-3)",
  color: "var(--ink-soft)",
  fontSize: "inherit",
  cursor: "pointer",
};
const segOn: React.CSSProperties = { background: "var(--accent)", color: "var(--accent-on)" };

/** 겹쳐 선 인물 경고 (공홈 `dp()`) — 캐릭터 프롬프트 **안**에 한 줄로 선다.
 *  ★**판을 닫고 있을 때만** 낸다. 판이 열려 있으면 마커가 이미 경고 색이라 같은 말을 두 번 한다.
 *  ★좌표를 안 쓰면 겹쳐도 상관없다. */
export function CharStackedWarning() {
  const tr = useI18n((s) => s.t);
  const { useCoords, positioning, centers, freeform, canPosition } = usePositioning();
  const stacked = freeform
    ? crowded(centers).size > 0
    : centers.some((a, i) =>
        centers.some((b, j) => {
          if (i === j) return false;
          const p = snapCenter(a);
          const q = snapCenter(b);
          return p.x === q.x && p.y === q.y;
        }),
      );
  /* ★★**순차 생성 모드에서는 안 낸다** (2026-09-15). 그 모드는 한 장에 한 명만 실으므로
     (`store/gen` 의 `parties`) 자리가 겹쳐도 겹칠 사람이 없다. */
  const seq = usePrompt((s) => s.seqChars);
  if (!canPosition || !useCoords || positioning || !stacked || seq) return null;
  return (
    <div
      data-stacked-warning
      style={{
        margin: "0 0 var(--sp-3)",
        padding: "3px var(--sp-3)",
        borderRadius: "var(--r-2)",
        background: "var(--warn)",
        color: "var(--accent-on)",
        fontSize: "var(--text-2xs)",
      }}
    >
      {tr("pos.stacked")}
    </div>
  );
}

/** 캐릭터 배치 판 — 큰 그림 위에 겹쳐 인물이 설 자리를 정한다.
 *
 *  ★★공홈 `sk()`·`sD()` 를 옮긴 것이다 (`reference/nai-web-2026-08-21/chunks/9360-…`, 대조 2026-08-21).
 *    좌표 값 자체는 `lib/charPos` 가 갖고 있고(회귀 `charPos.test.ts`), 여기는 화면이다.
 *    공홈에서 갈리는 자리 셋을 그대로 지킨다:
 *
 *      1. **판의 크기는 생성 해상도의 비율**이다. 남는 자리에 contain 으로 줄여 넣으므로,
 *         보고 있는 그림과 비율이 같으면 그 그림 위에 정확히 얹힌다.
 *         ★해상도가 아니라 **비율**이다 — 공홈 판정도 `|I.w/I.h - f.w/f.h| > 0.01` 이라
 *           1216×832 를 보다가 1536×1024 로 바꿔도 같은 판이다.
 *         ★큰 그림도 `objectFit: contain` 이라, 우리는 공홈처럼 두 갈래(그림 위 · 빈 판)로
 *           나눌 필요가 없다. **같은 사각형**이 나와서 한 경로로 둘 다 된다.
 *      2. **판 안은 모델이 가른다.** 자유 배치(V5·custom)는 끌어 놓는 면, 그 밖(V4.5)은 5×5 격자.
 *      3. **자리를 찍으면 `use_coords` 가 켜지고**, 그것을 끄면 판이 닫힌다.
 *
 *  ★i2i 베이스 그림이 있으면 판 바닥에 깐다 (공홈 `sD` 의 `backgroundUrl`).
 *  ★판 전체에 반투명 막을 덮는다 (공홈 `sN`) — 그림 위든 빈 판이든 마커가 보여야 한다.
 */
export function CharPositioner() {
  const params = useGen((s) => s.params);
  const setParam = useGen((s) => s.set);
  const chars = usePrompt((s) => s.chars);
  const setCenter = usePrompt((s) => s.setCenter);
  const baseImage = useImageInput((s) => s.baseImage);
  const [picked, setPicked] = useState(0);
  const { canPosition, setPositioning } = usePositioning();

  const freeform = modelCaps(params.model).freeform_position;
  /** 화면에 서는 인물만 — 꺼 둔 인물은 나가지 않으므로 자리도 없다 */
  const live = chars.filter((c) => c.on);

  useEffect(() => {
    if (picked > live.length - 1) setPicked(Math.max(0, live.length - 1));
  }, [live.length, picked]);

  /* ★★판은 **스스로 닫힌다** (공홈 `sk()` 를 감싸는 두 `useEffect` 와 같다):
       · 인물이 모자라면 — 판에 세울 사람이 없다
       · 좌표를 끄면 — 「AI 에게 맡김」인데 판이 열려 있으면 무엇이 먹는지 알 수 없다
     ★이 검사를 **바깥(토글이나 캔버스)에 두지 말 것.** 판이 닫혀 있을 때는 할 일이
       없는 검사라, 판과 생사를 같이하는 여기가 유일하게 빠짐없이 도는 자리다. */
  useEffect(() => {
    if (!canPosition || !params.use_coords) setPositioning(false);
  }, [canPosition, params.use_coords, setPositioning]);

  /** 자리를 찍으면 좌표를 **켠다** — 끈 채로 옮기면 아무 일도 안 일어난다 (공홈 `p()`) */
  const place = (i: number, at: Center) => {
    if (!params.use_coords) setParam("use_coords", true);
    const c = live[i];
    if (c) setCenter(c.id, at);
  };

  if (!live.length) return null;

  return (
    <Board w={params.width} h={params.height} bg={baseImage ? `data:image/png;base64,${baseImage}` : null}>
      {freeform ? (
        <FreeSurface chars={live} picked={picked} setPicked={setPicked} place={place} />
      ) : (
        <GridSurface chars={live} picked={picked} setPicked={setPicked} place={place} />
      )}
    </Board>
  );
}

/** 판 — 남는 자리에 `w×h` 비율을 contain 으로 줄여 넣는다 (공홈 `sD`) */
function Board(p: { w: number; h: number; bg: string | null; children: React.ReactNode }) {
  const box = useRef<HTMLDivElement>(null);
  const [avail, setAvail] = useState({ width: 0, height: 0 });
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver((es) => {
      for (const e of es) setAvail({ width: e.contentRect.width, height: e.contentRect.height });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const k =
    p.w > 0 && p.h > 0 ? Math.max(0, Math.min(avail.width / p.w, avail.height / p.h)) : 0;

  return (
    <div
      ref={box}
      data-char-positioner
      style={{ width: "100%", height: "100%", display: "flex", justifyContent: "center", alignItems: "center" }}
    >
      <div
        style={{
          position: "relative",
          width: p.w * k,
          height: p.h * k,
          borderRadius: "var(--r-1)",
          border: "1px solid var(--line-strong)",
          overflow: "hidden",
        }}
      >
        {p.bg && (
          <img
            src={p.bg}
            alt=""
            style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "fill" }}
          />
        )}
        {/* ★반투명 막 (공홈 `sN`) — 아래 그림을 죽여야 번호가 읽힌다 */}
        <div
          style={{
            position: "absolute",
            inset: 0,
            background: "color-mix(in srgb, var(--bg-deep) 50%, transparent)",
            display: "flex",
          }}
        >
          {p.children}
        </div>
      </div>
    </div>
  );
}

type Live = { id: string; name: string; center: Center }[];
type Surface = { chars: Live; picked: number; place: (i: number, at: Center) => void };

/** 자유 배치 — 끌어서 옮긴다 (공홈 `sV`).
 *  ★빈 곳을 누르면 **지금 고른 인물**이 거기로 간다. 마커 **18px 안**을 누르면 그것을 집는다. */
function FreeSurface(p: Surface & { setPicked: (i: number) => void }) {
  const surface = useRef<HTMLDivElement>(null);
  const dragging = useRef<number | null>(null);
  const warn = useMemo(() => crowded(p.chars.map((c) => c.center)), [p.chars]);

  /** 누른 자리에서 가장 가까운 마커 — 18px 밖이면 없는 것으로 본다 */
  const grab = (px: number, py: number) => {
    const r = surface.current?.getBoundingClientRect();
    if (!r) return undefined;
    let best = 18;
    let hit: number | undefined;
    p.chars.forEach((c, i) => {
      const d = Math.hypot(c.center.x * r.width - (px - r.left), c.center.y * r.height - (py - r.top));
      if (d <= best) {
        best = d;
        hit = i;
      }
    });
    return hit;
  };

  return (
    <div
      ref={surface}
      style={{ width: "100%", height: "100%", position: "relative", cursor: "crosshair", touchAction: "none" }}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        const hit = grab(e.clientX, e.clientY);
        const r = surface.current?.getBoundingClientRect();
        if (hit === undefined) {
          dragging.current = p.picked;
          if (r) p.place(p.picked, toCenter(e.clientX, e.clientY, r));
        } else {
          dragging.current = hit;
          p.setPicked(hit);
        }
      }}
      onPointerMove={(e) => {
        if (!e.currentTarget.hasPointerCapture(e.pointerId)) return;
        const i = dragging.current;
        const r = surface.current?.getBoundingClientRect();
        if (i !== null && r) p.place(i, toCenter(e.clientX, e.clientY, r));
      }}
      onPointerUp={() => {
        dragging.current = null;
      }}
    >
      {p.chars.map((c, i) => (
        <Marker
          key={c.id}
          n={i + 1}
          name={c.name}
          selected={i === p.picked}
          warning={warn.has(i)}
          style={{
            position: "absolute",
            left: `${100 * c.center.x}%`,
            top: `${100 * c.center.y}%`,
            transform: "translate(-50%, -50%)",
            zIndex: i === p.picked ? 2 : 1,
            pointerEvents: "none",
          }}
        />
      ))}
    </div>
  );
}

/** 격자 배치 — 빈 자리를 누르면 고른 인물이 그리로, **번호를 누르면 그 인물을 고른다** (공홈 `sF`).
 *
 *  ★★**번호로 고르는 길은 우리가 더한 것이다** (사용자 지적 2026-08-26: *"1번 말고는 다른
 *    위치를 조정할 수가 없음. 다른 번호를 고르면 그 위치로 1번이 이동함"*).
 *    공홈 격자는 `onClick: () => p(e.selectedIndex, {x,y})` 뿐이고, 고른 사람을 바꾸는 길이
 *    **자유 배치의 마커 집기 하나**다 (`e.setSelectedIndex(r)`). 그래서 격자만 쓰는 V4.5 에서는
 *    1번 말고는 영영 못 옮긴다 — 번들을 뜯어 확인한 사실이고, 공홈을 그대로 흉내 내면
 *    못 쓰는 화면이 된다. 자유 배치의 규칙(**마커를 누르면 집고, 빈 곳을 누르면 놓는다**)을
 *    격자에도 그대로 준다 — 새 규칙이 아니라 같은 규칙이다.
 *  ★한 칸에 둘 이상이 서면 경고 색이다. 번호를 누를 때마다 **그 칸의 다음 사람**으로 넘어가
 *    겹쳐 서 있어도 전부 고를 수 있다.
 *  ★칸에 보이는 번호는 평소 맨 앞 사람이지만, **고른 사람이 그 칸에 있으면 그 사람**이다 —
 *    안 그러면 방금 고른 것이 화면에 안 보인다. */
function GridSurface(p: Surface & { setPicked: (i: number) => void }) {
  /** 칸마다 그 자리에 선 인물 번호들 */
  const cell = useMemo(() => {
    const at = p.chars.map((c, i) => ({ i, ...snapCenter(c.center) }));
    return CENTER_GRID.map((y) => CENTER_GRID.map((x) => at.filter((a) => a.x === x && a.y === y)));
  }, [p.chars]);
  const here = p.chars[p.picked] ? snapCenter(p.chars[p.picked].center) : undefined;

  return (
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "grid",
        gridTemplateColumns: "repeat(5, 1fr)",
        gridTemplateRows: "repeat(5, 1fr)",
        gap: 4,
        padding: 4,
      }}
    >
      {CENTER_GRID.map((y, r) =>
        CENTER_GRID.map((x, c) => {
          const on = cell[r][c];
          const sel = here?.x === x && here?.y === y;
          /** 이 칸에서 지금 고른 사람의 차례 — 없으면 -1 */
          const mine = on.findIndex((a) => a.i === p.picked);
          const show = mine >= 0 ? on[mine] : on[0];
          return (
            <button
              key={`${r}-${c}`}
              type="button"
              onClick={() => p.place(p.picked, { x, y })}
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                borderRadius: "var(--r-1)",
                border: `1px solid ${sel ? "var(--accent-line)" : "var(--line)"}`,
                /* ★★고른 칸도 **속이 비쳐야 한다** (사용자 지적 2026-08-26: *"번호 선택했을
                   때의 배경 반투명하게 해줘. 이미지를 가림"*). `--accent-bg` 는 **불투명한
                   색**이라(밝게 `#e3eef8` · 어둡게 `#2a2640`) 그 칸만 그림이 통째로 가렸다.
                   ★안 고른 칸과 **같은 방식**으로 적는다 — 색만 강조색이고 투명도는 같은 층이다.
                     고른 표시는 이 옅은 물듦과 테두리 색이 함께 낸다. */
                background: sel
                  ? "color-mix(in srgb, var(--accent) 28%, transparent)"
                  : "color-mix(in srgb, var(--panel) 35%, transparent)",
                cursor: "pointer",
                padding: 0,
              }}
            >
              {on.length > 0 && (
                /* ★★번호를 누르면 **집는다** — 놓기는 칸의 빈 곳이 받는다 (자유 배치와 같은 규칙).
                   ★`stopPropagation` 이 없으면 칸의 놓기가 함께 돌아, 고르는 순간 그 사람이
                     제자리에 다시 놓인다 (값은 같지만 되돌리기 기록이 쌓인다).
                   ★span 이다 — 단추 안에 단추를 넣을 수 없다. */
                <span
                  role="button"
                  tabIndex={-1}
                  data-char-pick={show.i + 1}
                  onClick={(e) => {
                    e.stopPropagation();
                    // 같은 칸에 여럿이면 누를 때마다 다음 사람으로 (겹쳐 있어도 전부 고를 수 있다)
                    p.setPicked(on[(mine + 1) % on.length].i);
                  }}
                  style={{ display: "grid", cursor: "pointer" }}
                >
                  <Marker
                    n={show.i + 1}
                    name={p.chars[show.i].name}
                    selected={sel}
                    warning={on.length > 1}
                  />
                </span>
              )}
            </button>
          );
        }),
      )}
    </div>
  );
}

/** 인물 번호 마커 — 28px 원 (공홈 `sU`·`sW`) */
function Marker(p: {
  n: number;
  name: string;
  selected: boolean;
  warning: boolean;
  style?: React.CSSProperties;
}) {
  return (
    <div
      data-char-marker={p.n}
      title={p.name}
      style={{
        width: 28,
        height: 28,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        borderRadius: "50%",
        fontSize: "var(--text-sm)",
        fontWeight: "var(--w-semi)",
        background: p.warning ? "var(--warn)" : p.selected ? "var(--accent)" : "var(--panel)",
        color: p.warning || p.selected ? "var(--accent-on)" : "var(--ink)",
        border: `1px solid ${p.selected ? "var(--accent-line)" : "var(--line-strong)"}`,
        ...p.style,
      }}
    >
      {p.n}
    </div>
  );
}
