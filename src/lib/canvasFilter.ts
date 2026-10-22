/** 캔버스 `ctx.filter` 를 못 쓰는 곳에서 **같은 일을 픽셀로** 한다.
 *
 *  ★★맥의 WKWebView(Safari 엔진)는 `CanvasRenderingContext2D.filter` 를 기본으로 꺼 두었다 (caniuse: 17.6 까지 없음,
 *    18.0~26.x 「기본 꺼짐」). 대입은 조용히 무시되어 **흐림 검열을 걸어도 원본 그대로 저장된다.**
 *    이미지 편집의 보정(밝기·대비·채도·색조)도 안 걸린다.
 *  ★쓸 수 있으면 그대로 `filter` 를 쓴다 — 윈도우(WebView2)는 지금과 똑같다.
 *  ★식은 CSS Filter Effects 명세의 것이다: 흐림은 상자 흐림 세 번(`feGaussianBlur` 의 근사), 보정은 각 함수의 행렬.
 */

let ok: boolean | null = null;

/** 판정에서만 쓴다 — 대체 경로를 윈도우에서도 강제로 태운다. `null` 이면 다시 잰다 */
export function forceCanvasFilter(v: boolean | null): void {
  ok = v;
}

/** 이 웹뷰에서 `ctx.filter` 가 **실제로 걸리는가** — 대입이 되는지가 아니라 흐림이 번지는지로 잰다 */
export function canvasFilterOk(): boolean {
  if (ok === null) {
    try {
      const c = document.createElement("canvas");
      c.width = 3;
      c.height = 1;
      const g = c.getContext("2d")!;
      g.filter = "blur(1px)";
      g.fillStyle = "#fff";
      g.fillRect(1, 0, 1, 1);
      ok = g.getImageData(0, 0, 1, 1).data[3] > 0;
    } catch {
      ok = false;
    }
  }
  return ok;
}

/** 가우스 흐림(표준편차 `sigma` px) — `blur(sigma px)` 와 같다. 판 밖은 투명으로 본다.
 *  ★명세의 근사: 상자 크기 d = ⌊s·3·√(2π)/4 + 0.5⌋, 홀수면 가운데 상자 셋, 짝수면 왼쪽·오른쪽으로 치우친 상자 둘과 d+1 상자 하나.
 *  ★알파를 곱한 값으로 흐린다 — 안 그러면 투명한 자리의 색이 번져 나온다. */
export function blurPixels(px: Uint8ClampedArray, w: number, h: number, sigma: number): void {
  const d = Math.max(1, Math.floor((sigma * 3 * Math.sqrt(2 * Math.PI)) / 4 + 0.5));
  const passes: [number, number][] =
    d % 2
      ? [[-(d - 1) / 2, (d - 1) / 2], [-(d - 1) / 2, (d - 1) / 2], [-(d - 1) / 2, (d - 1) / 2]]
      : [[-d / 2, d / 2 - 1], [-d / 2 + 1, d / 2], [-d / 2, d / 2]];
  /* ★★둘레에 여백(`m`)을 두고 흐린 뒤 잘라 낸다 (게스트 실측 2026-10-22). 판 안에서만 세 번 흐리면 한 번 흐릴 때 판 밖으로
       번진 값이 버려져 다음 번에 못 돌아온다 — 그림 가장자리가 진짜 필터보다 덜 흐려져(σ6 에서 알파 0.35 대 0.53)
       **원본이 더 비쳤다.** 여백이 세 상자의 폭을 다 받으면 커널 하나로 한 번 흐린 것과 같아진다. */
  const m = 3 * Math.ceil(d / 2);
  const PW = w + 2 * m;
  const PH = h + 2 * m;
  const planes = [0, 1, 2, 3].map(() => new Float32Array(PW * PH));
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const j = (y + m) * PW + x + m;
      const a = px[i + 3];
      planes[0][j] = (px[i] * a) / 255;
      planes[1][j] = (px[i + 1] * a) / 255;
      planes[2][j] = (px[i + 2] * a) / 255;
      planes[3][j] = a;
    }
  const line = new Float32Array(Math.max(PW, PH));
  for (const p of planes) {
    for (const [lo, hi] of passes) box(p, PW, PH, 1, PW, lo, hi, line);
    for (const [lo, hi] of passes) box(p, PH, PW, PW, 1, lo, hi, line);
  }
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const j = (y + m) * PW + x + m;
      const a = planes[3][j];
      const k = a > 0 ? 255 / a : 0;
      px[i] = planes[0][j] * k;
      px[i + 1] = planes[1][j] * k;
      px[i + 2] = planes[2][j] * k;
      px[i + 3] = a;
    }
}

/** 한 방향 상자 흐림 — 줄마다 `[x+lo, x+hi]` 의 합을 상자 크기로 나눈다. `len` 이 그 방향의 길이,
 *  `step` 이 그 방향으로 한 칸, `next` 가 다음 줄로 한 칸 */
function box(p: Float32Array, len: number, lines: number, step: number, next: number, lo: number, hi: number, buf: Float32Array) {
  const size = hi - lo + 1;
  for (let l = 0; l < lines; l++) {
    const o = l * next;
    for (let i = 0; i < len; i++) buf[i] = p[o + i * step];
    let sum = 0;
    for (let k = Math.max(0, lo); k <= Math.min(len - 1, hi); k++) sum += buf[k];
    for (let x = 0; x < len; x++) {
      p[o + x * step] = sum / size;
      const add = x + hi + 1;
      const drop = x + lo;
      if (add < len) sum += buf[add];
      if (drop >= 0 && drop < len) sum -= buf[drop];
    }
  }
}

/** `g` 에 `src` 를 흐려 그린다 — `g.filter = blur(sigma px)` 다음 `drawImage(src, 0, 0, w, h)` 와 같다 */
export function drawBlurred(g: CanvasRenderingContext2D, src: CanvasImageSource, w: number, h: number, sigma: number): void {
  if (canvasFilterOk()) {
    g.filter = `blur(${sigma}px)`;
    g.drawImage(src, 0, 0, w, h);
    g.filter = "none";
    return;
  }
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  const cg = c.getContext("2d", { willReadFrequently: true })!;
  cg.drawImage(src, 0, 0, c.width, c.height);
  const im = cg.getImageData(0, 0, c.width, c.height);
  blurPixels(im.data, c.width, c.height, sigma);
  cg.putImageData(im, 0, 0);
  g.drawImage(c, 0, 0, w, h);
}

/** 보정 하나 — CSS 필터 함수와 같은 값 */
export type ColorOp =
  | { kind: "brightness"; v: number }
  | { kind: "contrast"; v: number }
  | { kind: "saturate"; v: number }
  | { kind: "hue-rotate"; deg: number };

/** 보정을 차례대로 건다 — 함수마다 [0,1] 로 자르고 다음으로 넘긴다 (명세의 필터 사슬과 같다). 알파는 그대로 둔다 */
export function colorPixels(px: Uint8ClampedArray, ops: readonly ColorOp[]): void {
  const mats = ops.map(matrixOf);
  for (let i = 0; i < px.length; i += 4) {
    let r = px[i] / 255;
    let g = px[i + 1] / 255;
    let b = px[i + 2] / 255;
    for (const m of mats) {
      const nr = m[0] * r + m[1] * g + m[2] * b + m[3];
      const ng = m[4] * r + m[5] * g + m[6] * b + m[7];
      const nb = m[8] * r + m[9] * g + m[10] * b + m[11];
      r = nr < 0 ? 0 : nr > 1 ? 1 : nr;
      g = ng < 0 ? 0 : ng > 1 ? 1 : ng;
      b = nb < 0 ? 0 : nb > 1 ? 1 : nb;
    }
    px[i] = r * 255 + 0.5;
    px[i + 1] = g * 255 + 0.5;
    px[i + 2] = b * 255 + 0.5;
  }
}

/** 3×4 행렬 (행마다 R·G·B 계수와 더하는 값) — Filter Effects 명세 13.2 의 정의 */
function matrixOf(op: ColorOp): number[] {
  if (op.kind === "brightness") {
    const s = op.v;
    return [s, 0, 0, 0, 0, s, 0, 0, 0, 0, s, 0];
  }
  if (op.kind === "contrast") {
    const s = op.v;
    const c = 0.5 - 0.5 * s;
    return [s, 0, 0, c, 0, s, 0, c, 0, 0, s, c];
  }
  if (op.kind === "saturate") {
    const s = op.v;
    return [
      0.213 + 0.787 * s, 0.715 - 0.715 * s, 0.072 - 0.072 * s, 0,
      0.213 - 0.213 * s, 0.715 + 0.285 * s, 0.072 - 0.072 * s, 0,
      0.213 - 0.213 * s, 0.715 - 0.715 * s, 0.072 + 0.928 * s, 0,
    ];
  }
  const a = (op.deg * Math.PI) / 180;
  const cs = Math.cos(a);
  const sn = Math.sin(a);
  return [
    0.213 + cs * 0.787 - sn * 0.213, 0.715 - cs * 0.715 - sn * 0.715, 0.072 - cs * 0.072 + sn * 0.928, 0,
    0.213 - cs * 0.213 + sn * 0.143, 0.715 + cs * 0.285 + sn * 0.14, 0.072 - cs * 0.072 - sn * 0.283, 0,
    0.213 - cs * 0.213 - sn * 0.787, 0.715 - cs * 0.715 + sn * 0.715, 0.072 + cs * 0.928 + sn * 0.072, 0,
  ];
}
