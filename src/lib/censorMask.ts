/** 검열 자리 — **칠한 픽셀의 비트맵**. 순수 계산만 둔다 (캔버스·DOM 없음).
 *
 *  ★★사용자 지시 2026-09-05: *"인페인트 브러시처럼 사각형 브러시로 칠하고 지우는 형태로.
 *    YOLO 모델이 만들어 준 박스도 마찬가지로 지우기 가능하게"*. 그래서 검열 중·후 탭의
 *    편집 대상은 박스 목록이 아니라 **이 비트맵 하나**다 — 찾은 박스는 여기에 구워 넣고,
 *    그 뒤로는 사람이 칠한 것과 구별하지 않는다. 지우개는 어느 쪽이든 똑같이 지운다.
 *  ★★**픽셀 단위**다 (사용자 지시 2026-09-05: *"붓 굵기 조절이 8단위로만 되어서 불편. 1단위로.
 *    흰색·검정 검열에서 사각 브러시가 어색함"* → 원형 붓). 처음에는 인페인트 마스크와 같은 8px
 *    격자였는데, 격자 위에서는 굵기가 칸 단위로만 뛰고 원형 붓도 8px 계단이 되어 또렷한 방식
 *    (흰색·검정)에서 그대로 보였다. 픽셀마다 1바이트인데 0 은 비었음, 1 이상은 **그 자리를
 *    가리는 방식**이다 (`METHOD_IDS` 의 번호). 방식이 자리마다 다를 수 있어야 하므로 (예전
 *    「박스마다 다른 방식」이 하던 일) 픽셀이 방식을 든다.
 *  ★`bounds` 는 켜진 픽셀을 품는 사각형이다 — **보수적**이고 **자라기만** 한다 (지워도 안 줄인다).
 *    100만 픽셀을 프레임마다 다 훑지 않으려는 장치라, 안에 빈 곳이 있어도 상관없다.
 *
 *  그리는 쪽은 두 갈래로 받는다:
 *    · 모자이크·흐리기·단색은 **비트맵을 그대로** 마스크로 쓴다 (`censorRender.drawMasked`).
 *    · 스팀은 사각형마다 v2 판을 찍는 구조라, 비트맵을 **8px 격자로 줄인 뒤**(`coarseOf`) 큰
 *      사각형들로 덮어 받는다 (`toRenderBoxes`, 겹쳐도 된다). 구름은 8px 계단을 어차피 뭉개므로
 *      보이는 결과는 격자 시절과 같다. 격자를 직접 받는 렌더러를 따로 만들지 않는다 — 한 벌이어야 한다.
 */
import type { RenderBox } from "./censorRender.ts";
import { SEEDS } from "./steam.ts";

/** 스팀 사각형을 뽑는 **거친 격자**의 칸 크기 (px). 비트맵과는 무관하다. ★8 로 못 박는다 — `coarseOf` 가 `>> 3` 을 쓴다 */
export const GRID = 8;

/** 픽셀에 적는 방식 번호의 순서. ★번호는 **저장되지 않는다**(세션 안에서만) — 순서를 바꿔도 된다 */
export const METHOD_IDS = ["steam", "mosaic", "blur", "black", "white", "color"] as const;

/** 방식 이름 → 픽셀 값 (1..). 모르는 이름은 첫째(스팀)로 본다 */
export const methodIndex = (m: string | undefined) => {
  const i = METHOD_IDS.indexOf((m ?? "") as (typeof METHOD_IDS)[number]);
  return (i < 0 ? 0 : i) + 1;
};

export const methodOf = (v: number) => METHOD_IDS[v - 1] ?? METHOD_IDS[0];

/** 픽셀 사각형 — 끝(`x1`·`y1`)은 **포함하지 않는다**. `x1 <= x0` 이면 비었다 */
export type Rect = { x0: number; y0: number; x1: number; y1: number };

export const emptyRect = (): Rect => ({ x0: 0, y0: 0, x1: 0, y1: 0 });
export const rectEmpty = (r: Rect) => r.x1 <= r.x0 || r.y1 <= r.y0;

/** `r` 을 사각형 `(x0,y0)-(x1,y1)` 까지 넓힌다 (제자리) */
export function grow(r: Rect, x0: number, y0: number, x1: number, y1: number) {
  if (x1 <= x0 || y1 <= y0) return r;
  if (rectEmpty(r)) { r.x0 = x0; r.y0 = y0; r.x1 = x1; r.y1 = y1; return r; }
  if (x0 < r.x0) r.x0 = x0;
  if (y0 < r.y0) r.y0 = y0;
  if (x1 > r.x1) r.x1 = x1;
  if (y1 > r.y1) r.y1 = y1;
  return r;
}

export type Mask = {
  w: number;
  h: number;
  /** 픽셀마다 0(비었음) 또는 방식 번호 — 줄 순서, `w` 칸씩 */
  cells: Uint8Array;
  /** 픽셀마다 **덮인 비율** 0..255 — 켜진 픽셀에서만 뜻이 있다. 원형 붓의 테두리 픽셀이 부분값을 갖는다
   *  (사용자 지적 2026-09-05: *"깔끔한 곡선이 아니고 테두리가 블러된 것처럼 흐려"* — 이진 마스크를 흐려서
   *  계단을 가리면 3px 로 번진다. 덮인 비율로 그리면 전환이 1px 안에서 끝난다). 사각 붓·찾은 박스는 255 */
  alpha: Uint8Array;
  /** 켜진 픽셀을 품는 사각형 (보수적 · 자라기만 한다) */
  bounds: Rect;
  /** 픽셀이 바뀔 때마다 오른다 — 렌더러가 옮겨 둔 알파 판을 다시 쓸지 판정하는 근거 */
  rev: number;
};

export function makeMask(w: number, h: number): Mask {
  const W = Math.max(1, Math.floor(w));
  const H = Math.max(1, Math.floor(h));
  return { w: W, h: H, cells: new Uint8Array(W * H), alpha: new Uint8Array(W * H), bounds: emptyRect(), rev: 0 };
}

export const cloneMask = (m: Mask): Mask =>
  ({ ...m, cells: new Uint8Array(m.cells), alpha: new Uint8Array(m.alpha), bounds: { ...m.bounds } });

/** 전부 지운다 (「전부 지우기」 단추) */
export function clearMask(m: Mask) {
  m.cells.fill(0);
  m.alpha.fill(0);
  m.bounds = emptyRect();
  m.rev++;
}

export function countOn(m: Mask) {
  const { w, cells, bounds: b } = m;
  let n = 0;
  for (let y = b.y0; y < b.y1; y++) {
    const row = y * w;
    for (let x = b.x0; x < b.x1; x++) if (cells[row + x]) n++;
  }
  return n;
}

export const isEmpty = (m: Mask | null | undefined) => !m || rectEmpty(m.bounds) || countOn(m) === 0;

/** 그림 좌표 → 픽셀 (그림 안으로 가둔다). ★수가 아니면(그림이 아직 배치되기 전의 NaN) null */
export function pixelAt(m: { w: number; h: number }, x: number, y: number) {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return {
    x: Math.max(0, Math.min(m.w - 1, Math.floor(x))),
    y: Math.max(0, Math.min(m.h - 1, Math.floor(y))),
  };
}

/** 사각형 하나를 `v` 로 채운다 (그림 밖은 잘라서). 켜면 `bounds` 도 넓힌다 */
function fillRect(m: Mask, x0: number, y0: number, x1: number, y1: number, v: number) {
  x0 = Math.max(0, x0); y0 = Math.max(0, y0);
  x1 = Math.min(m.w, x1); y1 = Math.min(m.h, y1);
  if (x1 <= x0 || y1 <= y0) return;
  const a = v ? 255 : 0;
  for (let y = y0; y < y1; y++) {
    m.cells.fill(v, y * m.w + x0, y * m.w + x1);
    m.alpha.fill(a, y * m.w + x0, y * m.w + x1);
  }
  if (v) grow(m.bounds, x0, y0, x1, y1);
  m.rev++;
}

/** 테두리 픽셀 하나 — 덮인 비율 `cov`(0..1) 로 칠하거나 지운다.
 *  ★반쯤 덮인 픽셀의 규칙: 빈 픽셀은 그 비율로 켜지고, 같은 방식이면 더 덮인 쪽을 남기고, 다른 방식은
 *    반 넘게 덮였을 때만 넘어온다. 지우개는 반 넘게 덮였으면 지우고, 덜 덮였으면 그만큼만 옅게 한다. */
function paintPx(m: Mask, i: number, v: number, cov: number) {
  if (cov <= 0) return;
  const a = cov >= 1 ? 255 : Math.round(cov * 255);
  const was = m.cells[i];
  if (v) {
    if (!was) { m.cells[i] = v; m.alpha[i] = a; }
    else if (was === v) { if (a > m.alpha[i]) m.alpha[i] = a; }
    else if (cov >= 0.5) { m.cells[i] = v; if (a > m.alpha[i]) m.alpha[i] = a; }
  } else if (was) {
    if (cov >= 0.5) { m.cells[i] = 0; m.alpha[i] = 0; }
    else {
      const left = 255 - a;
      if (left < m.alpha[i]) m.alpha[i] = left;
      if (m.alpha[i] === 0) m.cells[i] = 0;
    }
  }
}

/** 찾은 박스를 비트맵에 굽는다. ★**조금이라도 걸친 픽셀은 켠다** — 검열은 덜 가리는 쪽이 사고다.
 *  회전은 안 본다 (찾은 박스는 반듯하다). 박스가 방식을 들고 있으면 그것을, 없으면 `fallback` */
export function burnBoxes(
  m: Mask, boxes: { box: [number, number, number, number]; method?: string }[], fallback: string,
): Mask {
  for (const b of boxes) {
    const [x1, y1, x2, y2] = b.box;
    if (x2 <= x1 || y2 <= y1) continue;
    fillRect(m, Math.floor(x1), Math.floor(y1), Math.ceil(x2), Math.ceil(y2), methodIndex(b.method ?? fallback));
  }
  return m;
}

/** 붓 모양. ★기본은 사각이다 — 찾은 박스가 네모라 그 편이 이어 그리기 자연스럽다 (사용자 결정 2026-09-05) */
export type Shape = "square" | "round";

/** 붓의 **왼쪽 위**와 변 — 지름 `d` 의 붓이 `(x,y)` 를 가운데로 차지하는 사각형. 커서도 이 셈을 쓴다.
 *  홀수 지름은 `(x,y)` 가 정확히 가운데 픽셀이고, 짝수는 왼쪽·위로 반 픽셀 치우친다 */
export function brushBox(x: number, y: number, d: number) {
  const D = Math.max(1, Math.round(d));
  return { x0: x - (D >> 1), y0: y - (D >> 1), d: D };
}

/** 붓 한 번 — `(x,y)` 를 가운데로 지름 `d` 의 사각·원을 `v` 로 (0 이면 지우개).
 *  원은 붓 사각형에 내접하는 원이다. ★테두리 픽셀은 **덮인 비율**로 칠한다 — 픽셀 가운데에서 원 둘레까지의
 *  거리로 근사한다 (둘레 안쪽 반 픽셀부터 바깥 반 픽셀까지 1→0). 지름 3 이하는 사각형과 같다.
 *  `dirty` 를 주면 손댄 사각형만큼 넓혀 준다 (되돌리기가 그 자리만 보관한다) */
export function stamp(m: Mask, x: number, y: number, d: number, v: number, shape: Shape = "square", dirty?: Rect) {
  const { x0, y0, d: D } = brushBox(x, y, d);
  if (dirty) grow(dirty, Math.max(0, x0), Math.max(0, y0), Math.min(m.w, x0 + D), Math.min(m.h, y0 + D));
  if (shape === "square" || D <= 3) {
    fillRect(m, x0, y0, x0 + D, y0 + D, v);
    return;
  }
  const R = D / 2;
  const cx = x0 + R, cy = y0 + R;
  const rIn = (R - 0.5) * (R - 0.5), rOut = (R + 0.5) * (R + 0.5);
  let touched = false;
  for (let py = Math.max(0, y0); py < Math.min(m.h, y0 + D); py++) {
    const dy = py + 0.5 - cy;
    const dy2 = dy * dy;
    // 안쪽(가득 덮임) 구간은 통째로, 그 바깥 테두리 띠만 픽셀마다 비율을 센다
    const hwIn = Math.sqrt(Math.max(0, rIn - dy2)), hwOut = Math.sqrt(Math.max(0, rOut - dy2));
    const aIn = Math.ceil(cx - hwIn - 0.5), bIn = Math.floor(cx + hwIn - 0.5);
    const aOut = Math.max(0, Math.ceil(cx - hwOut - 0.5)), bOut = Math.min(m.w - 1, Math.floor(cx + hwOut - 0.5));
    if (bOut < aOut) continue;
    if (bIn >= aIn) fillRect(m, aIn, py, bIn + 1, py + 1, v);
    const row = py * m.w;
    for (let px = aOut; px <= bOut; px++) {
      if (px >= aIn && px <= bIn) continue;
      const dx = px + 0.5 - cx;
      paintPx(m, row + px, v, R + 0.5 - Math.sqrt(dx * dx + dy2));
    }
    touched = true;
  }
  if (touched) {
    if (v) grow(m.bounds, Math.max(0, x0), Math.max(0, y0), Math.min(m.w, x0 + D), Math.min(m.h, y0 + D));
    m.rev++;
  }
}

/** 지난 자리에서 이 자리까지 이어 찍는다 — 브레젠험. 빨리 그으면 점선이 되므로 잇는다.
 *  ★큰 붓은 픽셀마다 찍지 않고 지름의 1/8(원은 1/16)마다 찍는다 — 사각은 지름보다 촘촘하면 틈이 없고,
 *    원은 그 간격의 가리비 자국이 1px 미만이다 (깊이 ≈ 간격²/(4·지름)). 끝 자리는 반드시 찍는다. */
export function stroke(
  m: Mask, a: { x: number; y: number }, b: { x: number; y: number }, d: number, v: number,
  shape: Shape = "square", dirty?: Rect,
) {
  const dx = Math.abs(b.x - a.x);
  const dy = Math.abs(b.y - a.y);
  /* ★★수가 아닌 자리가 오면 **그냥 끝낸다.** `NaN === NaN` 이 영원히 거짓이라 아래 고리가 안
     끝난다 — 무대가 아직 크기를 못 받아 좌표가 NaN 이던 시험에서 앱이 통째로 멈췄다
     (2026-09-05). 걸음 수에도 천장을 둔다 (dx+dy 를 넘을 수 없다). */
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) return;
  const sx = a.x < b.x ? 1 : -1;
  const sy = a.y < b.y ? 1 : -1;
  // 원은 대각선 걸음(√2)까지 쳐서 더 촘촘히 (가리비 자국 ≈ 간격²/(4·지름) 을 1px 아래로)
  const every = Math.max(1, Math.round(d) >> (shape === "round" ? 4 : 3));
  let err = dx - dy;
  let { x, y } = a;
  for (let step = 0; step <= dx + dy; step++) {
    const last = x === b.x && y === b.y;
    if (step % every === 0 || last) stamp(m, x, y, d, v, shape, dirty);
    if (last) break;
    const e2 = 2 * err;
    if (e2 > -dy) { err -= dy; x += sx; }
    if (e2 < dx) { err += dx; y += sy; }
  }
}

/** 이 자리와 **이어진 칠한 픽셀 전부**를 지운다 (네 방향, 방식은 안 가린다). 지운 픽셀 수를 돌려준다.
 *  ★★사용자 지시 2026-09-05: *"우클릭을 기존처럼 박스 전체삭제로. 연결되어 있는 것 기준으로 모두 지움"*.
 *    박스 시절의 우클릭 삭제 자리다 — 붓에서 「박스」에 해당하는 것이 이어진 덩어리다. */
export function floodErase(m: Mask, x: number, y: number, dirty?: Rect) {
  const { w, h, cells } = m;
  if (x < 0 || y < 0 || x >= w || y >= h) return 0;
  if (!cells[y * w + x]) return 0;
  const stack = [y * w + x];
  let n = 0;
  let bx0 = x, by0 = y, bx1 = x + 1, by1 = y + 1;
  while (stack.length) {
    const i = stack.pop()!;
    if (!cells[i]) continue;
    cells[i] = 0;
    m.alpha[i] = 0;
    n++;
    const px = i % w, py = (i - px) / w;
    if (px < bx0) bx0 = px; else if (px + 1 > bx1) bx1 = px + 1;
    if (py < by0) by0 = py; else if (py + 1 > by1) by1 = py + 1;
    if (px > 0 && cells[i - 1]) stack.push(i - 1);
    if (px < w - 1 && cells[i + 1]) stack.push(i + 1);
    if (py > 0 && cells[i - w]) stack.push(i - w);
    if (py < h - 1 && cells[i + w]) stack.push(i + w);
  }
  if (dirty) grow(dirty, bx0, by0, bx1, by1);
  m.rev++;
  return n;
}

/** 페인트통 — 이 자리와 **이어진 빈 픽셀 전부**를 `v` 로 칠한다 (네 방향). 칠한 픽셀 수를 돌려준다.
 *  ★★사용자 지시 2026-11-19: 붓으로 테두리를 그린 다음 그 안을 한 번에 채운다. 그림 색은 보지 않는다.
 *    둘러싸이지 않은 자리를 누르면 이어진 바깥이 다 칠해진다 (되돌리기로 돌린다).
 *  ★둘레를 이루는 칠한 픽셀의 **덮인 비율을 가득 채운다** — 원형 붓의 테두리 픽셀은 부분값이라, 그대로 두면
 *    채운 자리와 테두리 사이에 옅은 줄이 남는다. 그 픽셀들도 `dirty` 에 든다 (되돌리면 함께 돌아온다).
 *  누른 자리가 이미 칠해져 있거나 그림 밖이면 아무것도 안 한다 (0) */
export function floodPaint(m: Mask, x: number, y: number, v: number, dirty?: Rect) {
  const { w, h, cells, alpha } = m;
  if (!v || x < 0 || y < 0 || x >= w || y >= h || cells[y * w + x]) return 0;
  const stack = [y * w + x];
  let n = 0;
  let bx0 = x, by0 = y, bx1 = x + 1, by1 = y + 1;
  // 가로 한 줄씩 — 이어진 빈 구간을 양쪽으로 넓혀 칠하고, 그 구간의 위아래를 다시 본다
  while (stack.length) {
    const p = stack.pop()!;
    if (cells[p]) continue;
    const py = (p / w) | 0, row = py * w;
    let l = p, r = p;
    while (l > row && !cells[l - 1]) l--;
    while (r < row + w - 1 && !cells[r + 1]) r++;
    for (let i = l; i <= r; i++) { cells[i] = v; alpha[i] = 255; }
    n += r - l + 1;
    if (l > row) alpha[l - 1] = 255;
    if (r < row + w - 1) alpha[r + 1] = 255;
    for (let i = l; i <= r; i++) {
      if (py > 0) { const u = i - w; if (!cells[u]) stack.push(u); else alpha[u] = 255; }
      if (py < h - 1) { const d = i + w; if (!cells[d]) stack.push(d); else alpha[d] = 255; }
    }
    const lx = l - row, rx = r - row + 1;
    if (lx < bx0) bx0 = lx;
    if (rx > bx1) bx1 = rx;
    if (py < by0) by0 = py; else if (py + 1 > by1) by1 = py + 1;
  }
  // 덮인 비율을 채운 둘레 한 줄까지 손댄 자리다
  if (dirty) grow(dirty, Math.max(0, bx0 - 1), Math.max(0, by0 - 1), Math.min(w, bx1 + 1), Math.min(h, by1 + 1));
  grow(m.bounds, bx0, by0, bx1, by1);
  m.rev++;
  return n;
}

/** 칠한 자리의 **윤곽선** — SVG 경로(`d`), 그림 픽셀 좌표. 비어 있는 이웃과 맞닿은 변만 긋는다.
 *  ★★사용자 지시 2026-09-05: *"그리는 중에는 박스 경계선이 보이게 (어떻게 칠해서 연결되고
 *    있는지 확인할 수 있게)"*. 이어진 자리는 한 윤곽이 되므로, 어디가 붙었고 어디가 떨어졌는지
 *    구름 아래에서도 보인다. 같은 줄의 이어진 변은 한 선분으로 합친다 (경로가 짧아진다).
 *  ★한 번 훑으면서 가로변은 줄 안에서, 세로변은 열마다 시작 줄을 들고 있다가 끊기는 자리에서 닫는다.
 *  ★★**가장자리 블록만 훑는다.** 8×8 블록마다 「비었다·꽉 찼다·섞였다」를 먼저 세고, 섞이지 않았고 왼쪽·위
 *    이웃과 같은 블록은 변이 있을 수 없으니 건너뛴다 (열린 선분만 그 자리에서 닫는다). 그림 전체를 가로지르는
 *    획도 변은 띠 하나라, 비용이 넓이가 아니라 둘레에 비례한다 (실측: 832×1216 대각선 획 26ms → 몇 ms). */
export function outlinePath(m: Mask) {
  const { w, h, cells, bounds: b } = m;
  if (rectEmpty(b)) return "";
  const parts: string[] = [];
  const x0 = b.x0, x1 = b.x1, y0 = b.y0, y1 = b.y1;
  // 블록 상태 — 0 비었음 · 1 섞임 · 2 꽉 참. 닫는 열·줄(x1·y1)을 위해 한 칸씩 더 둔다 (밖은 비었음)
  const bc0 = x0 >> 3, bc1 = x1 >> 3, br0 = y0 >> 3, br1 = y1 >> 3;
  const bcols = bc1 - bc0 + 1, brows = br1 - br0 + 1;
  const state = new Uint8Array(bcols * brows);
  for (let br = br0; br <= br1; br++) {
    const py0 = br << 3, py1 = Math.min(h, py0 + 8);
    for (let bc = bc0; bc <= bc1; bc++) {
      const px0 = bc << 3, px1 = Math.min(w, px0 + 8);
      if (px0 >= w || py0 >= h) continue;
      let n = 0;
      for (let y = py0; y < py1; y++) {
        const row = y * w;
        for (let x = px0; x < px1; x++) if (cells[row + x]) n++;
      }
      state[(br - br0) * bcols + (bc - bc0)] = n === 0 ? 0 : n === (px1 - px0) * (py1 - py0) ? 2 : 1;
    }
  }
  const stAt = (bc: number, br: number) => (bc < bc0 || br < br0 || bc > bc1 || br > br1) ? 0 : state[(br - br0) * bcols + (bc - bc0)];
  const span = x1 - x0 + 1;
  // 세로변의 열린 시작 줄 — 왼쪽변(오른쪽이 켜짐) · 오른쪽변(왼쪽이 켜짐). ★픽셀마다 배열을 만들지 않는다 (100만 번 돈다)
  const vL = new Int32Array(span).fill(-1), vR = new Int32Array(span).fill(-1);
  // 블록 열마다 열린 세로 선분 수 — 건너뛰는 블록에서 여덟 열을 매번 훑지 않으려고
  const vOpen = new Int32Array(bcols);
  // 블록 열의 픽셀 범위 — 줄마다 다시 셈하지 않는다
  const cxs0 = new Int32Array(bcols), cxs1 = new Int32Array(bcols);
  for (let bc = bc0; bc <= bc1; bc++) { cxs0[bc - bc0] = Math.max(x0, bc << 3); cxs1[bc - bc0] = Math.min(x1, (bc << 3) + 7); }
  const need: number[] = [];
  for (let br = br0; br <= br1; br++) {
    const ry0 = Math.max(y0, br << 3), ry1 = Math.min(y1, (br << 3) + 7);
    // 이 블록 줄에서 훑을 블록 — 섞였거나 왼쪽·위 이웃과 다른 것. 나머지에는 변이 없다
    need.length = 0;
    for (let bc = bc0; bc <= bc1; bc++) {
      const st = stAt(bc, br);
      if (st === 1 || st !== stAt(bc - 1, br) || st !== stAt(bc, br - 1)) need.push(bc - bc0);
      else if (vOpen[bc - bc0]) {
        // 건너뛰는 블록 열에 위 줄에서 열어 둔 세로 선분이 있으면 이 블록 줄 첫 줄에서 닫는다
        for (let x = cxs0[bc - bc0]; x <= cxs1[bc - bc0]; x++) {
          const i = x - x0;
          if (vL[i] >= 0) { parts.push(`M${x} ${vL[i]}V${ry0}`); vL[i] = -1; }
          if (vR[i] >= 0) { parts.push(`M${x} ${vR[i]}V${ry0}`); vR[i] = -1; }
        }
        vOpen[bc - bc0] = 0;
      }
    }
    if (!need.length) continue;
    for (let y = ry0; y <= ry1; y++) {
      const rowY = y < h ? y * w : -1, rowA = y > 0 ? (y - 1) * w : -1;
      let hT = -1, hB = -1;          // 이 줄 위쪽 경계의 열린 가로변 — 윗변(아래가 켜짐) · 아랫변(위가 켜짐)
      let prev = -2;
      for (const k of need) {
        const cx0 = cxs0[k], cx1 = cxs1[k];
        // 훑은 블록과 이 블록 사이에 건너뛴 블록이 있으면 가로 선분은 거기서 끝났다
        if (k !== prev + 1) {
          if (hT >= 0) { parts.push(`M${hT} ${y}H${cxs1[prev] + 1}`); hT = -1; }
          if (hB >= 0) { parts.push(`M${hB} ${y}H${cxs1[prev] + 1}`); hB = -1; }
        }
        prev = k;
        for (let x = cx0; x <= cx1; x++) {
          const inX = x < x1;
          const here = inX && rowY >= 0 && cells[rowY + x] !== 0;
          const above = inX && rowA >= 0 && cells[rowA + x] !== 0;
          const left = x > 0 && rowY >= 0 && cells[rowY + x - 1] !== 0;
          const top = here && !above, bot = above && !here;
          if (top && hT < 0) hT = x;
          else if (!top && hT >= 0) { parts.push(`M${hT} ${y}H${x}`); hT = -1; }
          if (bot && hB < 0) hB = x;
          else if (!bot && hB >= 0) { parts.push(`M${hB} ${y}H${x}`); hB = -1; }
          const i = x - x0;
          const l = y < y1 && here && !left, r = y < y1 && left && !here;
          if (l && vL[i] < 0) { vL[i] = y; vOpen[k]++; }
          else if (!l && vL[i] >= 0) { parts.push(`M${x} ${vL[i]}V${y}`); vL[i] = -1; vOpen[k]--; }
          if (r && vR[i] < 0) { vR[i] = y; vOpen[k]++; }
          else if (!r && vR[i] >= 0) { parts.push(`M${x} ${vR[i]}V${y}`); vR[i] = -1; vOpen[k]--; }
        }
      }
      if (hT >= 0) parts.push(`M${hT} ${y}H${cxs1[prev] + 1}`);
      if (hB >= 0) parts.push(`M${hB} ${y}H${cxs1[prev] + 1}`);
    }
  }
  return parts.join("");
}

/** 지금 비트맵에서 `base`(획 시작 전)에는 없던 픽셀만 남긴 비트맵 — **이번 획이 새로 칠한 것**.
 *  ★★사용자 제보 2026-09-05: 조각 300개 덩어리에 붓을 대면 그리는 동안 렉. 끄는 동안 매 프레임
 *    덩어리 전체를 다시 굽던 것을, 획 시작 전 그림은 구워 둔 그대로 두고 **이 델타만** 작은
 *    구름으로 얹는 방식으로 바꿨다 (`CensorStage.paint` · `censorRender.draw` 의 `overlay`).
 *    지우개 획은 얹을 수 없으므로 델타를 안 만든다 (부르는 쪽이 가른다).
 *  `within` 을 주면 그 사각형 안만 본다 (획이 손댄 자리) */
export function strokeDelta(m: Mask, base: Uint8Array, within?: Rect): Mask {
  const out = makeMask(m.w, m.h);
  if (base.length !== m.cells.length) return out;
  const r = within ?? m.bounds;
  const x0 = Math.max(0, r.x0), y0 = Math.max(0, r.y0), x1 = Math.min(m.w, r.x1), y1 = Math.min(m.h, r.y1);
  for (let y = y0; y < y1; y++) {
    const row = y * m.w;
    for (let x = x0; x < x1; x++) {
      const v = m.cells[row + x];
      if (v && !base[row + x]) { out.cells[row + x] = v; out.alpha[row + x] = m.alpha[row + x]; }
    }
  }
  grow(out.bounds, x0, y0, x1, y1);
  return out;
}

/** 칠한 픽셀 전부를 한 방식으로 (검열 방식 단추가 「지금 있는 것 전부」에 걸리는 규칙) */
export function remap(m: Mask, v: number) {
  const { w, cells, bounds: b } = m;
  for (let y = b.y0; y < b.y1; y++) {
    const row = y * w;
    for (let x = b.x0; x < b.x1; x++) if (cells[row + x]) cells[row + x] = v;
  }
  m.rev++;
  return m;
}

/** 되돌리기 한 걸음 — 사각형 하나의 픽셀 사본. ★비트맵 전체(100만 바이트)를 걸음마다 들고 있지 않는다 */
export type Patch = { x0: number; y0: number; x1: number; y1: number; data: Uint8Array; alpha: Uint8Array };

/** 어느 시점의 비트맵 두 판(`cells`·`alpha`)에서 사각형 `r` 을 떠 둔다. 빈 사각형이면 null */
export function snapshot(m: { w: number; h: number }, cells: Uint8Array, alpha: Uint8Array, r: Rect): Patch | null {
  const x0 = Math.max(0, r.x0), y0 = Math.max(0, r.y0), x1 = Math.min(m.w, r.x1), y1 = Math.min(m.h, r.y1);
  if (x1 <= x0 || y1 <= y0) return null;
  const pw = x1 - x0;
  const data = new Uint8Array(pw * (y1 - y0)), al = new Uint8Array(pw * (y1 - y0));
  for (let y = y0; y < y1; y++) {
    data.set(cells.subarray(y * m.w + x0, y * m.w + x1), (y - y0) * pw);
    al.set(alpha.subarray(y * m.w + x0, y * m.w + x1), (y - y0) * pw);
  }
  return { x0, y0, x1, y1, data, alpha: al };
}

/** 떠 둔 사각형을 되돌려 놓는다 */
export function restore(m: Mask, p: Patch) {
  const pw = p.x1 - p.x0;
  for (let y = p.y0; y < p.y1; y++) {
    m.cells.set(p.data.subarray((y - p.y0) * pw, (y - p.y0 + 1) * pw), y * m.w + p.x0);
    m.alpha.set(p.alpha.subarray((y - p.y0) * pw, (y - p.y0 + 1) * pw), y * m.w + p.x0);
  }
  grow(m.bounds, p.x0, p.y0, p.x1, p.y1);
  m.rev++;
}

/** 스팀용 **거친 격자** (`GRID`px 칸). 칸마다 0 또는 방식 번호 */
export type Coarse = { w: number; h: number; cols: number; rows: number; cells: Uint8Array };

/** 비트맵을 거친 격자로 줄인다. ★**픽셀이 하나라도 켜진 칸은 켠다** — 가는 획도 구름을 얻고, 어떤 모양도 통째로
 *  사라지지 않는다. 칸이 붓보다 넓어지는 몫은 `trimBox` 가 사각형을 실제 픽셀 범위로 줄여 되찾는다.
 *  ★★칸을 덜 켜서 폭을 맞추려던 시도는 전부 접었다 (2026-09-05): 칸 넓이 절반 기준은 박스 귀퉁이 칸만 꺼져
 *    네모가 십자로 갈라졌고, 칸 가운데 픽셀·가로세로 절반 기준은 40px 원의 바깥 줄이 2~3칸이라 가는 막대 두 장이
 *    되어 구름이 십자로 섰다 (*"원형 브러시를 칠하면 십자로 스팀이 생겨"*). 칸은 넉넉히 켜고 사각형을 픽셀로
 *    다듬는 쪽이 모양도 폭도 맞다. 방식이 섞인 칸은 픽셀이 가장 많은 쪽 */
export function coarseOf(m: Mask): Coarse {
  const cols = Math.max(1, Math.ceil(m.w / GRID));
  const rows = Math.max(1, Math.ceil(m.h / GRID));
  const out: Coarse = { w: m.w, h: m.h, cols, rows, cells: new Uint8Array(cols * rows) };
  const b = m.bounds;
  if (rectEmpty(b)) return out;
  const K = METHOD_IDS.length + 1;
  const counts = new Uint32Array(cols * rows * K);
  const cells = m.cells;
  // ★GRID 는 8 이라 나누기 대신 비트 이동 (100만 픽셀을 돈다)
  for (let y = b.y0; y < b.y1; y++) {
    const row = y * m.w, crow = (y >> 3) * cols;
    for (let x = b.x0; x < b.x1; x++) {
      const v = cells[row + x];
      if (v) counts[(crow + (x >> 3)) * K + v]++;
    }
  }
  const c0 = b.x0 >> 3, c1 = Math.min(cols - 1, (b.x1 - 1) >> 3);
  const r0 = b.y0 >> 3, r1 = Math.min(rows - 1, (b.y1 - 1) >> 3);
  for (let r = r0; r <= r1; r++) {
    for (let c = c0; c <= c1; c++) {
      const i = r * cols + c;
      let top = 0, bv = 0;
      for (let v = 1; v < K; v++) if (counts[i * K + v] > top) { top = counts[i * K + v]; bv = v; }
      out.cells[i] = bv;
    }
  }
  return out;
}

/** 칸으로 덮은 사각형을 **그 안에 실제로 칠해진 픽셀의 범위**로 줄인다 (사용자 지적 2026-09-05: *"스팀의
 *  칠해지는 영역이 좀 넓은 거 같아. 원래 90% 였는데 110%"* — 8px 칸으로 올림된 몫을 되찾는다).
 *  찾은 박스는 제 좌표 그대로, 40px 붓 띠는 40px 로 돌아온다. 원형 붓 한 점은 칸 귀퉁이가 빠져 사각형 두 장이
 *  되지만 둘 다 원의 범위로 줄어 도톰하게 겹친다 (가는 막대가 아니다).
 *  ★비용은 둘레에 비례한다 — 켜진 칸으로만 이루어진 사각형이라 위·아래 첫 칸 줄과 좌·우 첫 칸 열 안에서 끝난다 */
export function trimBox(m: Mask, v: number, box: [number, number, number, number]): [number, number, number, number] {
  const { w, cells } = m;
  let [x0, y0, x1, y1] = box;
  const rowHas = (y: number) => { const row = y * w; for (let x = x0; x < x1; x++) if (cells[row + x] === v) return true; return false; };
  const colHas = (x: number) => { for (let y = y0; y < y1; y++) if (cells[y * w + x] === v) return true; return false; };
  while (y0 < y1 && !rowHas(y0)) y0++;
  while (y1 > y0 && !rowHas(y1 - 1)) y1--;
  while (x0 < x1 && !colHas(x0)) x0++;
  while (x1 > x0 && !colHas(x1 - 1)) x1--;
  return [x0, y0, x1, y1];
}

/** 거친 격자를 **큰 사각형들로 덮는다** — 방식이 같은 칸끼리, 사각형은 **겹쳐도 된다**.
 *
 *  ★★왜 쪼개지 않고 덮는가 (사용자 지적 2026-09-05: *"정확한 사각형일 때랑 계단이 많은
 *    사각형일 때랑 그려지는 모습이 너무 달라"*): 겹치지 않게 쪼개면 계단이 있는 자리마다
 *    조각이 잘게 갈리고, 스팀은 조각마다 **그 조각 크기의** 구름을 찍으므로 작은 구름들이
 *    줄지어 붙어 계단이 그대로 드러났다. 칠한 영역 **안에 들어가는 큰 사각형**들로 겹치게
 *    덮으면 사각형마다 제 크기의 구름이 되고, 그것들이 최대값으로 합쳐져(한 덩이) 직각
 *    다각형도 사각형 몇 장이 겹친 구름이 된다. 정확한 사각형은 사각형 하나라 v2 그대로다.
 *
 *  방법: 왼쪽 위부터 훑어 아직 안 덮인 칸을 만나면, 그 칸을 품는 사각형 중 점수가 가장 높은
 *  것을 고른다. 점수는 **쪼개지 않고 그릴 수 있는 넓이** — 짧은 변 × (긴 변을 `SPLIT_ASPECT`
 *  배까지만 센 것). 비율을 넘는 긴 띠는 어차피 `splitSquarish` 가 짧은 변 크기로 자르므로,
 *  얇고 긴 띠(3×42)가 넓이로 이겨 놓고 잘게 잘리는 일을 막는다 (실측: 거의 세로인 획).
 *  같은 점수면 넓은 쪽. 사각형 안의 칸은 전부 덮인 것으로 친다.
 *  ★찾은 박스 하나는 사각형 하나로 돌아온다 (격자에 맞춰 넓어진 채로).
 *  ★합집합은 켜진 칸과 정확히 같다 — 사각형은 늘 켜진 칸 안에만 있고, 칸은 빠짐없이 덮인다. */
export function rectsOf(g: Coarse): { method: string; box: [number, number, number, number] }[] {
  const { cols, rows, cells } = g;
  const done = new Uint8Array(cells.length);
  const out: { method: string; box: [number, number, number, number] }[] = [];
  /** 행 t 에서 x 를 품고 값이 v 인 가로 줄의 양 끝 (칸, 양쪽 포함) */
  const run = (t: number, x: number, v: number) => {
    const row = t * cols;
    let a = x, b = x;
    while (a > 0 && cells[row + a - 1] === v) a--;
    while (b < cols - 1 && cells[row + b + 1] === v) b++;
    return [a, b];
  };
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const i = y * cols + x;
      const v = cells[i];
      if (!v || done[i]) continue;
      // 위로·아래로 행을 더할수록 좁아지는 가로 범위 (행 y 에서 k 행 떨어진 곳까지의 교집합)
      const upL: number[] = [], upR: number[] = [], dnL: number[] = [], dnR: number[] = [];
      for (let t = y, l = 0, r = cols - 1; t >= 0 && cells[t * cols + x] === v; t--) {
        const [a, b] = run(t, x, v);
        l = Math.max(l, a); r = Math.min(r, b);
        upL.push(l); upR.push(r);
      }
      for (let t = y, l = 0, r = cols - 1; t < rows && cells[t * cols + x] === v; t++) {
        const [a, b] = run(t, x, v);
        l = Math.max(l, a); r = Math.min(r, b);
        dnL.push(l); dnR.push(r);
      }
      let best = 0, bl = x, br = x, bt = y, bb = y;
      for (let u = 0; u < upL.length; u++) {
        for (let d = 0; d < dnL.length; d++) {
          const l = Math.max(upL[u], dnL[d]), r = Math.min(upR[u], dnR[d]);
          const w = r - l + 1, h = u + d + 1;
          const lo = Math.min(w, h), hi = Math.max(w, h);
          const score = lo * Math.min(hi, lo * SPLIT_ASPECT) + w * h * 1e-3;
          if (score > best) { best = score; bl = l; br = r; bt = y - u; bb = y + d; }
        }
      }
      for (let t = bt; t <= bb; t++) done.fill(1, t * cols + bl, t * cols + br + 1);
      out.push({
        method: methodOf(v),
        box: [bl * GRID, bt * GRID, Math.min(g.w, (br + 1) * GRID), Math.min(g.h, (bb + 1) * GRID)],
      });
    }
  }
  return out;
}

/** 씨앗 팔레트의 크기 — 사각형의 씨앗은 이 안의 하나다. 정본은 `steam.ts` (밭을 미리 굽는 쪽도 안다) */
export { SEEDS };

/** 사각형의 구름 씨앗 — **왼쪽 위 모서리**에서 골라, `SEEDS` 개 중 하나.
 *  ★오른쪽·아래로 더 칠해 사각형이 자라도 씨앗이 그대로라 구름이 통째로 바뀌지 않는다.
 *    (박스 시절에는 박스마다 번호를 붙여 옮겨도 같은 구름이었다 — 붓에는 「옮기기」가 없다.)
 *  ★★왜 팔레트인가 (사용자 지적 2026-09-05: *"기존 박스랑 연결되게 찍으면 엄청 느려짐"*):
 *    무늬 판은 **씨앗별로** 캐시된다. 자리마다 다른 씨앗이면 획이 박스에 닿아 사각형이
 *    다시 잘릴 때마다 새 씨앗이 수십 개 나와 판을 그만큼 새로 구웠다. 여덟이면 비율·배율
 *    버킷과 곱해도 금방 다 채워져 그 뒤로는 캐시만 맞는다. 이웃끼리 같은 씨앗이어도 비율과
 *    배율이 달라 같은 구름으로 보이지 않고, 최대값으로 합쳐지므로 되풀이가 드러나지 않는다. */
export function seedOf(box: [number, number, number, number]) {
  // ★칸 단위로 섞는다 — 픽셀(8의 배수)을 그대로 곱하면 낮은 비트가 늘 0 이라 팔레트가 하나로 뭉친다
  const cx = Math.floor(box[0] / GRID), cy = Math.floor(box[1] / GRID);
  let h = Math.imul(cx, 0x9e3779b1) ^ Math.imul(cy + 0x1000, 0x85ebca77);
  h ^= h >>> 15;
  h = Math.imul(h, 0x27d4eb2f);
  h ^= h >>> 13;
  return ((h >>> 0) % SEEDS) + 1;
}

/** 이 비율을 넘는 사각형은 조각낸다 (긴 변 ÷ 짧은 변).
 *  ★3 인 이유: 2 로 두면 계단 모양을 덮은 8×30칸 몸통이 8×8 로 잘려 큰 구름이 사라졌다
 *  (2026-09-05). 같은 폭으로 잘린 조각은 **옆면 구름 폭이 한 장일 때와 같고**(짧은 변이 정한다),
 *  비율 3 까지는 타원 끝의 뻗침이 짧은 변 이내라 뾰족해 보이지 않는다. */
export const SPLIT_ASPECT = 3;

/** 길쭉한 사각형을 **정사각형에 가까운 조각**으로 나눈다 — 칸 경계에서.
 *
 *  ★★왜: 스팀은 사각형마다 **그 비율의 타원 구름**을 배율로 키워 찍는다. 지우개로 박스를
 *    가로지르면 가장자리에 8px 폭 × 100px 높이 같은 **조각**이 남는데, 그것이 사각형 하나가
 *    되면 세로로 200px 짜리 뾰족한 구름이 선다 (실측 2026-09-05, 무대 시험). 정사각형에 가까운
 *    조각으로 나누면 조각마다 작은 구름이 되고, 이웃과 최대값으로 합쳐져 능선이 된다.
 *  ★찾은 박스 대부분(비율 2 이내)은 그대로 하나다 — 그 모양은 손대지 않는다. */
export function splitSquarish(box: [number, number, number, number]): [number, number, number, number][] {
  const [x1, y1, x2, y2] = box;
  const w = x2 - x1, h = y2 - y1;
  if (w <= 0 || h <= 0) return [];
  if (w <= h * SPLIT_ASPECT && h <= w * SPLIT_ASPECT) return [box];
  const out: [number, number, number, number][] = [];
  if (w > h) {
    const n = Math.ceil(w / h);
    const cells = Math.ceil(w / GRID);
    for (let i = 0; i < n; i++) {
      const a = x1 + Math.floor((cells * i) / n) * GRID;
      const b = i === n - 1 ? x2 : x1 + Math.floor((cells * (i + 1)) / n) * GRID;
      if (b > a) out.push([a, y1, Math.min(b, x2), y2]);
    }
  } else {
    const n = Math.ceil(h / w);
    const cells = Math.ceil(h / GRID);
    for (let i = 0; i < n; i++) {
      const a = y1 + Math.floor((cells * i) / n) * GRID;
      const b = i === n - 1 ? y2 : y1 + Math.floor((cells * (i + 1)) / n) * GRID;
      if (b > a) out.push([x1, a, x2, Math.min(b, y2)]);
    }
  }
  return out;
}

/** 스팀이 받는 모양으로 — 거친 격자로 줄여 큰 사각형으로 덮고, 픽셀 범위로 다듬고, 길쭉한 것은 조각내서 */
export function toRenderBoxes(m: Mask | null | undefined): RenderBox[] {
  if (!m || rectEmpty(m.bounds)) return [];
  return rectsOf(coarseOf(m)).flatMap((r) => {
    const box = trimBox(m, methodIndex(r.method), r.box);
    if (box[2] <= box[0] || box[3] <= box[1]) return [];
    return splitSquarish(box).map((piece) => ({ seed: seedOf(piece), box: piece, rotation: 0, method: r.method }));
  });
}
