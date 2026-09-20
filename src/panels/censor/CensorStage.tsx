import { useCallback, useEffect, useRef, useState } from "react";
import { coverOf, useCensor, passes, type Box } from "../../store/censor";
import { useCensorView } from "../../store/censorView";
import { canPan, centerPan, clampPan } from "../../lib/zoomView";
import { brushBox, outlinePath, pixelAt, strokeDelta, toRenderBoxes } from "../../lib/censorMask";
import type { RenderBox, Scene } from "../../lib/censorRender";
import { hitBox } from "../../lib/censorBox";

/** 무대. 그림 한 장과 그 위의 덮개 (v2 `censorPreviewCanvas` + `censorOverlayCanvas`).
 *
 *  세 겹이다 — 아래부터 **원본 `<img>` · 덮개 캔버스 · 조작 SVG**.
 *
 *  ★★덮개는 **여기서 그린다** (`CensorRenderer`). 서버에 물어보지 않으므로 붓을 끄는
 *    동안 기다릴 것이 없다. 캔버스에는 **덮개만** 그린다 (바탕은 투명) — 원본은 아래
 *    `<img>` 가 이미 깔고 있어서, 매 프레임 원본을 다시 그릴 이유가 없다.
 *  ★「들춰보기」는 그래서 **CSS 투명도 하나**로 끝난다. 다시 그리지 않는다.
 *
 *  ★★검열 중·후 탭의 조작은 **붓과 지우개**다 (사용자 지시 2026-09-05: *"인페인트 브러시처럼
 *    사각형 브러시로 칠하고 지우는 형태로. YOLO 박스도 마찬가지로 지우기 가능하게"*).
 *    박스를 고르고·옮기고·늘리고·돌리던 손잡이는 걷었다 — 찾은 박스는 검열 중으로 넘어갈 때
 *    격자에 구워지므로(`scanAll`), 여기서는 찾은 것과 칠한 것을 가르지 않는다.
 *  ★검열 전 탭은 그대로 **읽기 전용 박스 목록**이다 — 눌러서 끄고 켠다.
 */
export function CensorStage() {
  const c = useCensor();
  const boxes = c.curBoxes();
  const im = c.cur();
  const size = im ? c.sizes[im.id] : undefined;
  /** 얼마로 볼까 — 설정은 `useCensor.view`(저장됨), 재는 값과 보고 있는 자리는 `censorView` */
  const view = c.view;
  const pan = useCensorView((s) => s.pan);
  const box = useCensorView((s) => s.box);
  const { setBox, setNat, setPan } = useCensorView.getState();
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const [hover, setHover] = useState(-1);
  const [scale, setScale] = useState(1);
  /** ★그림을 **판 안에 맞춘 화면 크기**(px). CSS 퍼센트로는 세로가 안 잡혀서 셈해서 못 박는다
   *  (사용자 지적 2026-09-04: *"검열중 화면이 앱 안에 꽉차게 표시되어야 하는데 원본 해상도로
   *  표시되어서 전체화면으로만 작업할 수 있음"*). 세로로 긴 그림은 `max-height: 100%` 가
   *  **부모 높이가 auto 라 안 먹었다** — 그래서 원본 크기 그대로 서고 판을 넘쳤다. */
  const [fitted, setFitted] = useState<{ w: number; h: number } | null>(null);
  const editable = c.tab !== "before";
  /** 붓이 닿을 자리 (그림 좌표의 칸). 손을 대고 있을 때만 그린다 */
  /** 붓 커서가 보이는가. ★자리(x·y)는 리액트를 안 거치고 `cursorRef` 로 바로 쓴다 — 마우스는 초당
   *  수백 번 움직임을 보내는데, 그때마다 리액트를 돌리면 스팀의 프레임 예산을 잡아먹는다 */
  const [cursorOn, setCursorOn] = useState(false);
  const cursorRef = useRef<SVGRectElement | null>(null);
  /** 긋는 중 — 지난 자리와 지우개 여부. ★ref 다: pointermove 는 리액트 렌더를 안 기다린다 */
  const strokeRef = useRef<{ last: { x: number; y: number } | null; erase: boolean; baseBoxes?: RenderBox[] } | null>(null);
  /** 「선택」 도구로 끄는 중 — 누른 자리와 그때의 `pan` (생성 쪽 `drag` 와 같은 모양) */
  const panRef = useRef<{ x: number; y: number; p: { x: number; y: number } } | null>(null);
  /** 커서가 마지막으로 있던 자리 (그림 픽셀) — 붓 크기가 바뀌면 그 자리에 다시 맞춘다 */
  const lastPos = useRef<{ x: number; y: number } | null>(null);
  /** 손을 뗀 시각 — 제 해상도 덮개가 완성될 때까지 걸린 시간을 콘솔에 남긴다 (사용자 제보 2026-09-05:
   *  스팀에서 손을 떼는 순간 0.5초 멈춤. 재현이 안 되어 실제 앱에서 잰다) */
  const upAt = useRef(0);
  /** 획 도중 프레임마다 든 시간 — 붓 처리·윤곽·굽기. 손을 뗄 때 한 줄로 찍고 비운다 */
  const strokeStats = useRef({ n: 0, ms: [] as number[], outline: 0, draw: 0, brush: 0 });
  /** 끄는 동안 예약된 다시 그리기 (프레임당 한 번). ★마우스는 프레임보다 자주 움직임을 보낸다 */
  const rafRef = useRef(0);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  /** 긋는 동안 보이는 칠한 칸의 윤곽 (`outlinePath`). ★ref 로 `d` 를 바로 쓴다 — 긋는 중엔 리액트가 안 돈다 */
  const outlineRef = useRef<SVGPathElement | null>(null);

  /** 덮개를 **지금 당장** 다시 그린다.
   *
   *  ★★값을 `getState()` 로 읽는다. 끄는 동안 리액트가 다시 그려 주기를 기다리지 않고
   *    이 함수를 그 자리에서 부르기 때문이다 (한 프레임도 늦지 않는다).
   *  ★캔버스 버퍼는 **화면에 보이는 크기 × 화면 배율**이다. 원본 크기로 그리면 큰 그림에서
   *    쓸데없이 몇 배를 칠하게 되고, 눈에 보이는 것은 똑같다. */
  const paint = useCallback(() => {
    const cv = canvasRef.current;
    const el = imgRef.current;
    if (!cv || !el) return;
    const st = useCensor.getState();
    const cur = st.cur();
    const r = st.renderer;
    const sz = cur ? st.sizes[cur.id] : undefined;
    const g = cv.getContext("2d");
    if (!r || !cur || !sz || st.tab === "before") {
      if (g) g.clearRect(0, 0, cv.width, cv.height);
      return;
    }
    /* ★★긋는 동안만 **칠한 칸의 윤곽**을 얹는다 (사용자 지시 2026-09-05: *"그리는 중에는 박스
       경계선이 보이게 — 어떻게 칠해서 연결되고 있는지 확인할 수 있게"*). 구름은 이어진 칸을
       한 덩이로 뭉개므로, 어디가 붙었고 어디가 떨어졌는지는 이 선이 말해 준다. */
    const tOutline = performance.now();
    outlineRef.current?.setAttribute("d", st.editing && st.paint[cur.id] ? outlinePath(st.paint[cur.id]) : "");
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const shown = el.clientWidth;
    if (!shown) return;
    /* ★끄는 동안에는 **낮은 해상도로** 굽는다 (`censorRender` 의 `STEAM_WORK_QUICK`).
       스팀은 모양이 바뀔 때마다 다시 만들어야 해서, 제 해상도로 태우면 손이 걸린다.
       손을 떼면 `editing` 이 꺼지고 이 함수가 한 번 더 돌아 제 해상도로 다시 굽는다. */
    // ★뒤에서 제 해상도 굽기가 끝나면 그 자리에서 다시 그린다 (스팀, 손을 뗀 뒤)
    r.onReady = paint;
    const t0 = performance.now();
    /* ★★붓 획을 긋는 동안은 **획 시작 전 그림은 구워 둔 그대로**, 이번 획이 새로 칠한 자리만 따로 얹는다
       (사용자 제보 2026-09-05: 조각 300개 덩어리에서 그리는 동안 렉). 전에는 매 프레임 덩어리 전체를
       저해상도로 다시 구워 조각 수만큼 느려졌다. 획 시작 전 사각형 목록은 획 동안 안 변하므로 한 번만
       만들어 둔다 (`baseBoxes`) — 그 열쇠는 구워 둔 것과 같아 굽기가 없다. 지우개 획은 얹을 수 없어
       전처럼 통째로 굽는다. (스팀 얘기다 — 나머지 방식은 비트맵을 그대로 그려 얹을 것이 없다.) */
    const mask = st.paint[cur.id];
    const sr = strokeRef.current;
    let scene: Scene;
    if (st.editing && sr && !sr.erase && st.strokeBase && mask && st.strokeBase.cells.length === mask.cells.length) {
      if (!sr.baseBoxes) sr.baseBoxes = toRenderBoxes({ ...mask, cells: st.strokeBase.cells });
      scene = { boxes: sr.baseBoxes, mask, overlay: toRenderBoxes(strokeDelta(mask, st.strokeBase.cells, st.strokeDirty ?? undefined)), dirty: st.strokeDirty ?? undefined };
    } else scene = { boxes: toRenderBoxes(mask), mask: mask ?? null };
    r.draw(cv, scene, coverOf(st), (shown * dpr) / sz.w, false, st.editing, false);
    const now = performance.now();
    const ss = strokeStats.current;
    if (st.editing) {
      ss.n++;
      ss.ms.push(now - tOutline);
      ss.outline = Math.max(ss.outline, t0 - tOutline);
      ss.draw = Math.max(ss.draw, now - t0);
    } else if (upAt.current) {
      // ★console.info — debug 등급은 개발자 도구 기본 필터에 안 보인다 (사용자: "콘솔창에 아무 로그도 안 찍힘")
      const sorted = [...ss.ms].sort((a, b) => a - b);
      const med = sorted[sorted.length >> 1] ?? 0, max = sorted[sorted.length - 1] ?? 0;
      console.info(`[censor] 획 ${ss.n}점: 프레임 중앙값 ${med.toFixed(1)}ms·최대 ${max.toFixed(1)}ms (붓 최대 ${ss.brush.toFixed(1)}, 윤곽 최대 ${ss.outline.toFixed(1)}, 굽기 최대 ${ss.draw.toFixed(1)}) | 손 뗌 → 화면 반영 ${(now - upAt.current).toFixed(0)}ms (그리기 ${(now - t0).toFixed(0)}ms, 캔버스 ${cv.width}×${cv.height})`);
      upAt.current = 0;
      strokeStats.current = { n: 0, ms: [], outline: 0, draw: 0, brush: 0 };
    }
  }, []);

  /** 그림 좌표 ↔ 화면 좌표의 배율 + **그려 둘 크기**.
   *
   *  ★재는 대상은 **판**(무대를 감싼 칸)이다. 그림 자신을 재면 「지금 크기」를 되먹여
   *    줄어들 줄을 모른다 (커지기만 하고 다시 못 줄어드는 되먹임이 된다).
   *  ★★**「꽉차게」에서만 줄이기만 한다** — 작은 그림을 억지로 늘리면 뭉개지기 때문이다.
   *    사용자가 배율을 정하면(`view.fit === false`) 그 값이 곧 배율이고, 확대도 한다
   *    (사용자 지시 2026-09-20). 배율이 커져 그림이 판을 넘치면 「선택」 도구로 끌어 옮긴다.
   *  ★★**붓과 박스 좌표는 손댈 것이 없다.** 이 `scale` 하나가 그림↔화면 변환의 기준이라,
   *    배율이 바뀌면 칠하는 자리도 박스 선 굵기도 저절로 따라간다. */
  useEffect(() => {
    const el = wrapRef.current;
    const host = el?.parentElement;
    if (!el || !host || !size) return;
    const fit = () => {
      const bw = host.clientWidth, bh = host.clientHeight;
      if (!bw || !bh) return;
      setBox({ w: bw, h: bh });
      const k = view.fit ? Math.min(bw / size.w, bh / size.h, 1) : view.zoom;
      const w = Math.max(1, Math.floor(size.w * k));
      const h = Math.max(1, Math.floor(size.h * k));
      setFitted((old) => (old && old.w === w && old.h === h ? old : { w, h }));
      setScale(w / size.w || 1);
      paint();
    };
    const ro = new ResizeObserver(fit);
    ro.observe(host);
    fit();
    return () => ro.disconnect();
  }, [size?.w, size?.h, c.src, paint, view.fit, view.zoom, setBox]);

  // ★원본 크기를 보기 스토어에도 알려 준다 — 배율 계산(`setZoom`)이 이 값으로 그린 크기를 낸다
  useEffect(() => {
    if (size) setNat(size);
  }, [size?.w, size?.h, setNat]);

  /** 장이 바뀌면 보던 자리를 놓는다 — **가운데**에서 시작한다 (그림마다 크기가 다르다).
   *  ★생성 쪽과 같은 이유다: 확대해서 볼 때 왼쪽 위 구석부터 보이면 대개 빈 배경이다.
   *  ★★**배율은 딸림값에 안 넣는다** — %를 만질 때마다 가운데로 튀면 `keepCenter` 가 붙들어
   *    둔 「보고 있던 지점」이 사라진다. 그래서 그린 크기도 `fitted`(배율이 바뀌면 함께 바뀐다)를
   *    쓰지 않고 **그 자리에서 다시 셈한다.** */
  useEffect(() => {
    if (!size || !box.w || !box.h) return;
    const k = useCensor.getState().view.fit
      ? Math.min(box.w / size.w, box.h / size.h, 1)
      : useCensor.getState().view.zoom;
    setPan(centerPan(box, { w: size.w * k, h: size.h * k }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [im?.id, size?.w, size?.h, box.w, box.h]);
  // ★판·배율이 바뀌면 **밖으로 나간 만큼만** 도로 붙든다
  useEffect(() => {
    if (fitted) setPan((p) => clampPan(p, box, fitted));
  }, [box.w, box.h, fitted?.w, fitted?.h, setPan]);

  // ★칸·설정이 바뀌면 `rev` 가 오르고, 여기서 다시 그린다 (끄는 동안에는 `move` 가 직접 부른다)
  useEffect(() => {
    paint();
    // ★`editing` 도 딸림값이다 — 손을 뗀 순간 **제 해상도로 다시 굽기** 위해서다.
  }, [c.rev, c.src, c.tab, c.renderer, c.editing, paint]);

  const toImage = (e: { clientX: number; clientY: number }) => {
    const el = imgRef.current;
    if (!el || !size) return null;
    const r = el.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * size.w, y: ((e.clientY - r.top) / r.height) * size.h };
  };

  const posOf = (e: { clientX: number; clientY: number }) => {
    const p = toImage(e);
    return p && size ? pixelAt(size, p.x, p.y) : null;
  };

  /** 붓 커서를 그 자리에 놓는다 — 붓 사각형(`brushBox`)과 같은 셈. 원형이면 모서리를 지름의 반으로 둥글린다 */
  const placeCursor = (pos: { x: number; y: number }) => {
    const cr = cursorRef.current;
    if (!cr) return;
    const st = useCensor.getState();
    const { x0, y0, d } = brushBox(pos.x, pos.y, st.brushPx);
    cr.setAttribute("x", String(x0));
    cr.setAttribute("y", String(y0));
    cr.setAttribute("width", String(d));
    cr.setAttribute("height", String(d));
    cr.setAttribute("rx", String(st.brushShape === "round" ? d / 2 : 0));
  };
  // ★Alt+휠로 크기를 바꾸면 마우스가 안 움직여도 커서가 그 자리에서 다시 맞는다
  useEffect(() => {
    if (lastPos.current) placeCursor(lastPos.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [c.brushPx, c.brushShape, cursorOn]);

  const down = (e: React.PointerEvent) => {
    /* ★★**「이동」 도구는 그리지 않고 끈다** (사용자 결정 2026-09-20). 생성 쪽은 그냥 끌기로
       옮기지만 여기서는 끌기가 이미 붓질이라, 도구를 골라서 가른다. 맨 앞에 둔다 — 검열 전
       탭에서도(박스 켜고 끄기) 같은 도구로 옮길 수 있어야 한다. */
    if (c.tool === "pan" && e.button === 0 && movable) {
      e.preventDefault();
      panRef.current = { x: e.clientX, y: e.clientY, p: pan };
      (e.currentTarget as Element).setPointerCapture(e.pointerId);
      return;
    }
    const p = toImage(e);
    if (!p) return;
    if (!editable) {
      // 검열 전 탭은 **읽기 전용**이다. 박스를 눌러 끄고 켜는 것만 한다 (v2 도 같다)
      const i = hitBox(boxes, p.x, p.y);
      if (i >= 0) c.toggleBox(i);
      return;
    }
    /* ★★**「이동」 도구는 끌 것이 없어도 칠하지 않는다** (사용자 지적 2026-09-20: *"화면에 이미지
       전체가 보이는 배율에서는 선택도구를 쓰면 브러시가 칠해짐"*). 위의 문은 `movable` 일 때만
       잡으므로, 넘치지 않는 배율에서는 여기까지 떨어져 붓질이 됐다. 박스 켜고 끄기(위의 `!editable`)
       보다 뒤에 둔다 — 검열 전 탭에서는 이 도구로 박스를 눌러야 한다. */
    if (c.tool === "pan") return;
    // ★기본 동작(글자 선택·선택된 글자 끌기)을 막는다 — 선택이 남아 있으면 붓이 한 틱 만에 끊겼다
    e.preventDefault();
    /* ★★그 대신 **포커스를 손수 푼다.** `pointerdown` 을 막으면 뒤따르는 `mousedown` 이 안 나가고, 포커스를
       옮기는 것은 그 `mousedown` 의 기본 동작이다 — 그래서 직전에 만진 슬라이더가 포커스를 쥔 채 남아
       Ctrl+Z 같은 단축키를 전부 삼켰다 (사용자 제보 2026-09-05). */
    (document.activeElement as HTMLElement | null)?.blur?.();
    const pos = posOf(e);
    if (!pos) return;
    const st = useCensor.getState();
    /* ★★오른쪽 단추는 **이어진 덩어리 삭제**다 (사용자 지시 2026-09-05: *"우클릭을 기존처럼 박스
       전체삭제로. 연결되어 있는 것 기준으로 모두 지움"*). 박스 시절의 우클릭 삭제 자리 —
       붓에서 「박스」에 해당하는 것이 이어진 덩어리다. 끌지 않는다 (한 번 눌러 한 덩어리). */
    if (e.button === 2) {
      st.eraseBlob(pos);
      paint();
      return;
    }
    if (e.button !== 0) return;
    const erase = c.tool === "erase";
    if (!st.strokeBegin()) return;
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    strokeRef.current = { last: pos, erase };
    st.strokeAt(pos, null, erase);
    paint();
  };

  const move = (e: React.PointerEvent) => {
    const d = panRef.current;
    if (d) {
      if (fitted) setPan(clampPan({ x: d.p.x + (e.clientX - d.x), y: d.p.y + (e.clientY - d.y) }, box, fitted));
      return;
    }
    if (!editable) {
      const p = toImage(e);
      if (p) setHover(hitBox(boxes, p.x, p.y));
      return;
    }
    const pos = posOf(e);
    if (pos) { lastPos.current = pos; placeCursor(pos); }
    if (pos && !cursorOn) setCursorOn(true);
    const s = strokeRef.current;
    if (!s || !pos) return;
    if (s.last && s.last.x === pos.x && s.last.y === pos.y) return;
    /* ★★**그 자리에서 다시 그린다.** 리액트가 다시 그려 주기를 기다리지 않는다 —
       칸은 제자리에서 바뀌었고 `paint` 는 스토어를 `getState()` 로 읽으므로 바로 반영된다.
       서버 왕복이 없으므로 프레임마다 불러도 손이 안 걸린다. */
    const tb = performance.now();
    useCensor.getState().strokeAt(pos, s.last, s.erase);
    strokeStats.current.brush = Math.max(strokeStats.current.brush, performance.now() - tb);
    s.last = pos;
    /* ★★**프레임당 한 번만** 다시 그린다 (사용자 로그 2026-09-05: 그리는 도중 잔렉). 마우스는 초당
       수백 번 움직임을 보내고 칸이 바뀔 때마다 굽고 있었다 — 굽기 15~25ms 가 프레임 안에 여러 번
       쌓이면 화면이 밀린다. 칸은 위에서 이미 바뀌었으니 다음 프레임에 한 번 그리면 다 반영된다. */
    if (!rafRef.current) rafRef.current = requestAnimationFrame(() => { rafRef.current = 0; paint(); });
  };

  const up = () => {
    if (panRef.current) {
      panRef.current = null;
      return;
    }
    if (!strokeRef.current) return;
    strokeRef.current = null;
    if (rafRef.current) { cancelAnimationFrame(rafRef.current); rafRef.current = 0; }
    upAt.current = performance.now();
    // ★손을 떼면 덮개를 다시 진하게 (「들춰보기」는 끄는 동안만이다) — 그리고 제 해상도로 다시 굽는다
    useCensor.getState().strokeEnd();
  };

  /** 판보다 커서 끌 수 있는가 — 「이동」 도구를 켜 두어도 넘치지 않으면 끌 것이 없다 */
  const movable = !view.fit && !!fitted && canPan(box, fitted);
  /* ★「이동」 도구는 붓 커서를 숨기고 **십자 화살표**를 쓴다 — 그림을 끌어 옮긴다는 것이 커서로
     보여야 한다 (사용자 지시 2026-09-20). 넘치지 않아 옮길 것이 없으면 평범한 화살표이고,
     검열 전 탭에서는 박스 위에서 손가락이다 (거기서는 눌러서 끄고 켠다). */
  const cursor = c.tool === "pan" && movable
    ? "move"
    : !editable
      ? (hover >= 0 ? "pointer" : "default")
      : c.tool === "pan" ? "default" : "none";

  if (!im) return null;

  const shown = boxes
    .map((b, i) => ({ b, i }))
    // ★낮은 신뢰도 숨김은 **보이는 것만** 거른다 (v2 주석 그대로: 실제 검열엔 영향 없음)
    .filter(({ b }) => b.manual || b.confidence >= c.floor);

  const erasing = c.tool === "erase" || strokeRef.current?.erase;

  return (
    <div
      ref={wrapRef}
      style={{
        lineHeight: 0,
        // ★셈한 크기로 못 박는다 (아직 못 쟀으면 판 안으로만 묶어 둔다)
        width: fitted ? fitted.w : undefined,
        height: fitted ? fitted.h : undefined,
        userSelect: "none",
        /* ★★**배율을 정하면 자리 잡는 방식 자체가 바뀐다** (사용자 지시 2026-09-20).
           「꽉차게」는 판이 그리드 가운데로 놓아 주고 판 안에 묶인다. 확대는 넘치는 것이
           목적이라, 판의 **왼쪽 위 기준**으로 떼어 놓고 `pan` 만큼 옮긴다 — 그래야
           `lib/zoomView` 의 계산(`clampPan`·`centerPan`·`keepCenter`)이 그대로 맞는다.
           그 계산은 「상자 왼쪽 위에서 본 그림의 왼쪽 위」를 좌표로 쓴다. */
        ...(view.fit
          ? { position: "relative", maxWidth: "100%", maxHeight: "100%" }
          : {
              position: "absolute",
              left: 0,
              top: 0,
              maxWidth: "none",
              maxHeight: "none",
              transform: `translate(${pan.x}px, ${pan.y}px)`,
            }),
        // ★끌 수 있을 때만 십자 화살표 — 도구를 켜 두어도 넘치지 않으면 끌 것이 없다
        cursor: c.tool === "pan" ? (movable ? "move" : "default") : undefined,
      }}
    >
      {/* ★★그림이 아직 없으면(탭 전환·목록 비움 사이) `<img>` 를 **아예 두지 않는다** (사용자 지적
          2026-09-05: 검열 시작을 누르면 잠깐 깨진 그림 아이콘이 뜬다). Chromium 은 src 가 있다가
          없어진 img 를 「깨진 그림」으로 그린다 — 헤드리스로 재현: src 를 뗀 것·빈 문자열·404 는
          아이콘이 뜨고, 처음부터 src 가 없던 img 만 아무것도 안 그린다. src 가 null 인 길은 넷인데
          (탭 전환·목록 비움·범위 밖 선택·초기값) 전부 이 한 자리를 지나므로 여기서 한 번에 막는다. */}
      {c.src === null && <div data-censor-empty style={{ width: "100%", height: "100%" }} />}
      {c.src !== null && <img
        ref={imgRef}
        data-censor-img
        src={c.src}
        alt=""
        draggable={false}
        onLoad={(e) => {
          const el = e.currentTarget;
          if (!size) c.set({ sizes: { ...c.sizes, [im.id]: { w: el.naturalWidth, h: el.naturalHeight } } });
          setScale(el.clientWidth / (size?.w ?? el.naturalWidth) || 1);
        }}
        // ★칸을 꽉 채운다 — 칸의 크기는 위에서 그림 비율대로 셈해 두었다
        style={{ width: "100%", height: "100%", objectFit: "contain", userSelect: "none", display: "block" }}
      />}
      <canvas
        ref={canvasRef}
        data-censor-cover
        style={{
          position: "absolute",
          inset: 0,
          width: "100%",
          height: "100%",
          pointerEvents: "none",
          // ★붓을 끄는 동안 옅게 — **방식을 가리지 않는 공통 동작**이다 (v2 「조작시 투명도」)
          //   ★다시 그리지 않는다. 캔버스 한 장의 투명도만 바뀐다
          opacity: c.editing ? 1 - c.peek / 100 : 1,
        }}
      />
      <svg
        data-censor-overlay
        viewBox={size ? `0 0 ${size.w} ${size.h}` : undefined}
        style={{ position: "absolute", inset: 0, width: "100%", height: "100%", cursor, touchAction: "none" }}
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={up}
        onPointerCancel={up}
        onPointerLeave={() => setCursorOn(false)}
        // ★우클릭 메뉴를 막는다 — 오른쪽 단추는 이어진 덩어리 삭제다
        onContextMenu={(e) => e.preventDefault()}
      >
        {editable && (
          <path
            ref={outlineRef}
            data-censor-outline
            fill="none"
            stroke="rgba(255,64,96,0.95)"
            strokeWidth={1.5 / scale}
            style={{ pointerEvents: "none" }}
          />
        )}
        {!editable && shown.map(({ b, i }) => (
          <BoxShape key={i} b={b} hot={hover === i} ok={passes(b, c.labelConf, c.conf)} scale={scale} />
        ))}
        {/* 붓 미리보기 — **눌렀을 때 칠해질 자리**를 그대로 그린다 (`brushBox`). 자리·크기·둥글기는
            `placeCursor` 가 DOM 에 바로 쓴다 — 리액트는 이 속성들을 다시 쓰지 않는다 */}
        {/* ★「이동」 도구에서는 붓을 안 낸다 — 칠하지 않는데 칠할 자리를 보여 주면 거짓말이다
            (사용자 지적 2026-09-20) */}
        {editable && cursorOn && c.tool !== "pan" && (
          <rect
            ref={cursorRef}
            data-censor-brush
            x={-9999}
            y={-9999}
            width={1}
            height={1}
            fill={erasing ? "rgba(255,255,255,0.14)" : "rgba(255,64,96,0.22)"}
            stroke={erasing ? "rgba(255,255,255,0.85)" : "rgba(255,64,96,0.9)"}
            strokeWidth={1.5 / scale}
            style={{ pointerEvents: "none" }}
          />
        )}
      </svg>
    </div>
  );
}

/** 검열 전 탭의 박스 하나 — 테두리와 이름. 눌러서 끄고 켠다 (손잡이는 없다) */
function BoxShape({ b, hot, ok, scale }: { b: Box; hot: boolean; ok: boolean; scale: number }) {
  const [x1, y1, x2, y2] = b.box;
  const line = 1.5 / scale;
  const stroke = b.off ? "var(--ink-ghost)" : ok ? "#dc3c3c" : "#808080";

  return (
    <g opacity={b.off ? 0.45 : 1}>
      <rect
        x={x1}
        y={y1}
        width={x2 - x1}
        height={y2 - y1}
        fill={hot ? "rgba(220,60,60,0.2)" : "rgba(220,60,60,0.12)"}
        stroke={stroke}
        strokeWidth={line * (hot ? 1.6 : 1)}
        strokeDasharray={b.off ? `${6 / scale} ${4 / scale}` : undefined}
      />
      <text
        x={x1 + 4 / scale}
        y={y1 - 5 / scale}
        fill={stroke}
        fontSize={12 / scale}
        style={{ pointerEvents: "none", userSelect: "none" }}
      >
        {`${b.label} ${b.confidence}`}
      </text>
    </g>
  );
}
