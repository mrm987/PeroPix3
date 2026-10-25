/** 이미지 편집 — **효과 프리셋** (사용자 지시 2026-09-27: LUT 을 걷어 내고 그 자리에 글리치·브라운관 같은 실전 효과).
 *
 *  ★보정(`adj`)과 같은 규칙이다: 레이어의 속성(`fx`)으로 들고 **언제나** 걸린다. 그릴 때 `pixels.withFx` 가 입힌 사본을
 *    만들어 그리므로 합치기·저장이 자연히 굽는다. 레이어 픽셀은 그대로다.
 *  ★여기는 **순수 계산**이다 (RGBA 바이트 → RGBA 바이트, DOM 없음). 판정은 `fx.test.ts`.
 *  ★크기에 매인 값(줄 간격·밀기 폭·흐림 반경)은 전부 **그림의 짧은 변**에 비례한다 (`unitOf`). 그래야 그림 크기가 달라도
 *    같은 모양이 된다.
 *  ★무작위가 드는 효과(글리치·VHS·필름)는 `seed` 로 정해진다 — 화면에 보인 것과 저장된 것이 같아야 한다.
 *  ★**여럿을 겹쳐 건다** (사용자 지시 2026-09-28) — 레이어는 목록(`Fx[]`)을 들고, **건 차례대로** 입힌다 (`applyFxList`).
 *    같은 효과를 두 번 걸지는 않는다 (칸을 다시 누르면 뺀다).
 *  ★강도 0 이면 원본 그대로다. 각 효과는 강도를 **세기에** 쓰고(줄이 옅어지고 밀림이 줄어든다), 겹쳐 섞지 않는다
 *    (글리치를 반만 섞으면 두 겹으로 비친다). 하프톤만 섞는다 — 망점 크기는 인쇄처럼 정해져 있어야 한다. */

export type FxKind = "glitch" | "crt" | "vhs" | "chroma" | "film" | "bloom" | "halftone" | "pixel" | "vignette";
export const FX_KINDS: readonly FxKind[] = ["glitch", "crt", "vhs", "chroma", "film", "bloom", "halftone", "pixel", "vignette"];
/** 무작위가 드는 효과 — 「다시 섞기」가 뜬다 */
export const FX_SEEDED: readonly FxKind[] = ["glitch", "vhs", "film"];
export type Fx = { kind: FxKind; amt: number; seed: number };
/** 효과를 처음 고를 때의 강도 */
export const FX_AMT = 60;
export const fxKey = (fx: Fx) => `${fx.kind}:${fx.amt}:${fx.seed}`;
/** 목록의 열쇠 — 차례까지 같아야 같은 결과다 */
export const fxListKey = (list: readonly Fx[]) => list.map(fxKey).join("|");
/** 실제로 걸리는 것만 (강도 0 은 뺀다) */
export const liveFx = (list: readonly Fx[] | null | undefined): Fx[] => (list ?? []).filter((f) => f.amt > 0);
/** 저장본을 읽을 때 — 한 개짜리(옛 모양)도 목록으로 맞춘다 */
export const fxListOf = (raw: unknown): Fx[] | null => {
  const list = (Array.isArray(raw) ? raw : raw ? [raw] : []).filter((f): f is Fx => !!f && typeof f === "object" && typeof (f as Fx).kind === "string");
  return list.length ? list : null;
};
export const newSeed = () => Math.floor(Math.random() * 0x7fffffff);

/** 효과를 입힌 새 바이트 — `src` 는 건드리지 않는다 */
export function applyFx(src: Uint8ClampedArray, w: number, h: number, fx: Fx): Uint8ClampedArray {
  const t = Math.max(0, Math.min(100, fx.amt)) / 100;
  if (t <= 0 || w < 1 || h < 1) return new Uint8ClampedArray(src);
  const run = {
    glitch: () => glitch(src, w, h, t, fx.seed),
    crt: () => crt(src, w, h, t),
    vhs: () => vhs(src, w, h, t, fx.seed),
    chroma: () => chroma(src, w, h, t),
    film: () => film(src, w, h, t, fx.seed),
    bloom: () => bloom(src, w, h, t),
    halftone: () => halftone(src, w, h, t),
    pixel: () => pixel(src, w, h, t),
    vignette: () => vignette(src, w, h, t),
  }[fx.kind];
  return run ? run() : new Uint8ClampedArray(src);
}

/** 목록을 건 차례대로 입힌다 — 빈 목록이면 사본 */
export function applyFxList(src: Uint8ClampedArray, w: number, h: number, list: readonly Fx[]): Uint8ClampedArray {
  let out = src;
  for (const fx of list) out = applyFx(out, w, h, fx);
  return out === src ? new Uint8ClampedArray(src) : out;
}

/* ── 도구 ───────────────────────────────────────────────────────── */

/** 크기의 단위 — 짧은 변의 1/1000 */
const unitOf = (w: number, h: number) => Math.min(w, h) / 1000;

/** 씨앗이 같으면 같은 수열 (mulberry32) */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let x = a;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smooth = (a: number, b: number, v: number) => {
  const x = clamp01((v - a) / (b - a));
  return x * x * (3 - 2 * x);
};
const wrap = (x: number, w: number) => ((x % w) + w) % w;

/** 채널 넷을 0~1 로 */
function planes(src: Uint8ClampedArray, n: number) {
  const r = new Float32Array(n);
  const g = new Float32Array(n);
  const b = new Float32Array(n);
  const a = new Float32Array(n);
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    r[i] = src[j] / 255;
    g[i] = src[j + 1] / 255;
    b[i] = src[j + 2] / 255;
    a[i] = src[j + 3] / 255;
  }
  return { r, g, b, a };
}

/** 가로 상자 흐림 (누적합, 끝은 붙잡는다) */
function blurH(src: Float32Array, w: number, h: number, r: number): Float32Array {
  if (r < 1) return src;
  const out = new Float32Array(src.length);
  const n = 2 * r + 1;
  for (let y = 0; y < h; y++) {
    const o = y * w;
    let s = 0;
    for (let k = -r; k <= r; k++) s += src[o + Math.min(w - 1, Math.max(0, k))];
    for (let x = 0; x < w; x++) {
      out[o + x] = s / n;
      s += src[o + Math.min(w - 1, x + r + 1)] - src[o + Math.max(0, x - r)];
    }
  }
  return out;
}

function blurV(src: Float32Array, w: number, h: number, r: number): Float32Array {
  if (r < 1) return src;
  const out = new Float32Array(src.length);
  const n = 2 * r + 1;
  for (let x = 0; x < w; x++) {
    let s = 0;
    for (let k = -r; k <= r; k++) s += src[Math.min(h - 1, Math.max(0, k)) * w + x];
    for (let y = 0; y < h; y++) {
      out[y * w + x] = s / n;
      s += src[Math.min(h - 1, y + r + 1) * w + x] - src[Math.max(0, y - r) * w + x];
    }
  }
  return out;
}

/** 가우스에 가까운 흐림 — 상자 흐림 세 번 */
function blur(src: Float32Array, w: number, h: number, r: number): Float32Array {
  const k = Math.max(1, Math.round(r));
  let out = src;
  for (let i = 0; i < 3; i++) out = blurV(blurH(out, w, h, k), w, h, k);
  return out;
}

/** 넓게 흐리기 — 1/`f` 로 줄여서 흐린 뒤 쌍선형으로 되돌린다 (반경이 크면 줄여도 모양이 같고 훨씬 빠르다) */
function blurWide(src: Float32Array, w: number, h: number, r: number): Float32Array {
  const f = Math.max(1, Math.floor(r / 2));
  if (f === 1) return blur(src, w, h, r);
  const sw = Math.ceil(w / f);
  const sh = Math.ceil(h / f);
  const small = new Float32Array(sw * sh);
  const cnt = new Float32Array(sw * sh);
  for (let y = 0; y < h; y++) {
    const o = Math.floor(y / f) * sw;
    for (let x = 0; x < w; x++) {
      const k = o + Math.floor(x / f);
      small[k] += src[y * w + x];
      cnt[k]++;
    }
  }
  for (let i = 0; i < small.length; i++) small[i] /= cnt[i];
  const bl = blur(small, sw, sh, r / f);
  // 되돌리기 — 열마다의 이웃·가중치를 먼저 셈해 둔다
  const cx0 = new Int32Array(w);
  const cx1 = new Int32Array(w);
  const cdx = new Float32Array(w);
  for (let x = 0; x < w; x++) {
    const fx = Math.min(sw - 1, Math.max(0, (x + 0.5) / f - 0.5));
    cx0[x] = Math.floor(fx);
    cx1[x] = Math.min(sw - 1, cx0[x] + 1);
    cdx[x] = fx - cx0[x];
  }
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const fy = Math.min(sh - 1, Math.max(0, (y + 0.5) / f - 0.5));
    const y0 = Math.floor(fy);
    const o0 = y0 * sw;
    const o1 = Math.min(sh - 1, y0 + 1) * sw;
    const dy = fy - y0;
    for (let x = 0; x < w; x++) {
      const dx = cdx[x];
      const top = bl[o0 + cx0[x]] * (1 - dx) + bl[o0 + cx1[x]] * dx;
      const bot = bl[o1 + cx0[x]] * (1 - dx) + bl[o1 + cx1[x]] * dx;
      out[y * w + x] = top * (1 - dy) + bot * dy;
    }
  }
  return out;
}

/** 쌍선형 표본 (끝은 붙잡는다) */
function sample(p: Float32Array, w: number, h: number, x: number, y: number): number {
  const fx = Math.min(w - 1, Math.max(0, x));
  const fy = Math.min(h - 1, Math.max(0, y));
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const x1 = Math.min(w - 1, x0 + 1);
  const y1 = Math.min(h - 1, y0 + 1);
  const dx = fx - x0;
  const dy = fy - y0;
  const top = p[y0 * w + x0] * (1 - dx) + p[y0 * w + x1] * dx;
  const bot = p[y1 * w + x0] * (1 - dx) + p[y1 * w + x1] * dx;
  return top * (1 - dy) + bot * dy;
}

/** 채널 넷을 바이트로 */
function pack(r: Float32Array, g: Float32Array, b: Float32Array, a: Float32Array): Uint8ClampedArray {
  const out = new Uint8ClampedArray(r.length * 4);
  for (let i = 0, j = 0; i < r.length; i++, j += 4) {
    out[j] = r[i] * 255 + 0.5;
    out[j + 1] = g[i] * 255 + 0.5;
    out[j + 2] = b[i] * 255 + 0.5;
    out[j + 3] = a[i] * 255 + 0.5;
  }
  return out;
}

/* ── 효과 ───────────────────────────────────────────────────────── */

/** 글리치 — 가로 띠가 옆으로 밀리고, 빨강·파랑이 어긋나고, 몇 줄은 한 채널이 튄다 */
function glitch(src: Uint8ClampedArray, w: number, h: number, t: number, seed: number): Uint8ClampedArray {
  const rnd = rng(seed);
  const u = unitOf(w, h);
  const S = Math.min(w, h);
  const shift = new Int32Array(h);
  const split = new Int32Array(h);
  const bands = Math.round(3 + 14 * t);
  for (let i = 0; i < bands; i++) {
    const y0 = Math.floor(rnd() * h);
    const bh = Math.max(1, Math.round(S * (0.004 + rnd() * rnd() * 0.08)));
    const dx = Math.round((rnd() * 2 - 1) * w * 0.12 * t);
    const sp = rnd() < 0.5 ? Math.round(u * 24 * t * rnd()) : 0;
    for (let y = y0; y < Math.min(h, y0 + bh); y++) {
      shift[y] += dx;
      split[y] += sp;
    }
  }
  const base = Math.round(u * 7 * t);
  const out = new Uint8ClampedArray(src.length);
  for (let y = 0; y < h; y++) {
    const o = y * w;
    const d = base + split[y];
    for (let x = 0; x < w; x++) {
      const sx = wrap(x - shift[y], w);
      const j = (o + x) * 4;
      out[j] = src[(o + wrap(sx - d, w)) * 4];
      out[j + 1] = src[(o + sx) * 4 + 1];
      out[j + 2] = src[(o + wrap(sx + d, w)) * 4 + 2];
      out[j + 3] = src[(o + sx) * 4 + 3];
    }
  }
  // 몇 줄은 한 채널이 밝게 튄다 (디지털 신호가 깨진 자리)
  const lines = Math.round(2 + 8 * t);
  for (let i = 0; i < lines; i++) {
    const y0 = Math.floor(rnd() * h);
    const lh = Math.max(1, Math.round(u * (1 + rnd() * 3)));
    const x0 = Math.floor(rnd() * w);
    const len = Math.round(w * (0.1 + rnd() * 0.6));
    const c = Math.floor(rnd() * 3);
    const lift = 90 + 140 * t;
    for (let y = y0; y < Math.min(h, y0 + lh); y++) {
      for (let x = x0; x < Math.min(w, x0 + len); x++) {
        const j = (y * w + x) * 4;
        if (out[j + 3]) out[j + c] = Math.min(255, out[j + c] + lift);
      }
    }
  }
  return out;
}

/** 브라운관 — 볼록한 화면 · 주사선 · RGB 세로 격자 · 번짐 · 가장자리 어둡게 */
function crt(src: Uint8ClampedArray, w: number, h: number, t: number): Uint8ClampedArray {
  const n = w * h;
  const { r, g, b, a } = planes(src, n);
  const u = unitOf(w, h);
  const glow = [blurWide(r, w, h, u * 6), blurWide(g, w, h, u * 6), blurWide(b, w, h, u * 6)];
  const chans = [r, g, b];
  const k = 0.08 * t;
  const period = Math.max(2.5, h / 300);
  const stripe = Math.max(1, Math.round(period / 2));
  const out = new Uint8ClampedArray(src.length);
  const boost = 1 + 0.5 * t;
  const lo = 1 - 0.3 * t;
  const gk = 0.35 * t;
  for (let y = 0; y < h; y++) {
    const ny = ((y + 0.5) / h) * 2 - 1;
    for (let x = 0; x < w; x++) {
      const j = (y * w + x) * 4;
      const nx = ((x + 0.5) / w) * 2 - 1;
      const r2 = nx * nx + ny * ny;
      const f = 1 + k * r2;
      const sx = nx * f;
      const sy = ny * f;
      // 쌍선형 가중치를 한 번만 셈한다 (채널 일곱이 같은 자리를 읽는다)
      const px = Math.min(w - 1, Math.max(0, ((sx + 1) / 2) * w - 0.5));
      const py = Math.min(h - 1, Math.max(0, ((sy + 1) / 2) * h - 0.5));
      const x0 = Math.floor(px);
      const y0 = Math.floor(py);
      const x1 = Math.min(w - 1, x0 + 1);
      const y1 = Math.min(h - 1, y0 + 1);
      const dx = px - x0;
      const dy = py - y0;
      const i00 = y0 * w + x0, i01 = y0 * w + x1, i10 = y1 * w + x0, i11 = y1 * w + x1;
      const w00 = (1 - dx) * (1 - dy), w01 = dx * (1 - dy), w10 = (1 - dx) * dy, w11 = dx * dy;
      out[j + 3] = (a[i00] * w00 + a[i01] * w01 + a[i10] * w10 + a[i11] * w11) * 255 + 0.5;
      const edge = Math.max(Math.abs(sx), Math.abs(sy));
      if (edge >= 1) continue; // 화면 밖 — 검게 (투명한 레이어는 투명한 채)
      const scan = 1 - 0.55 * t * (0.5 - 0.5 * Math.cos((2 * Math.PI * (py + 0.5)) / period));
      const col = Math.floor(x / stripe) % 3;
      const vig = (1 - 0.25 * t * r2) * smooth(1, 1 - 0.02 - 0.03 * t, edge);
      const m = scan * vig * boost;
      for (let c = 0; c < 3; c++) {
        const p = chans[c];
        const q = glow[c];
        const v = p[i00] * w00 + p[i01] * w01 + p[i10] * w10 + p[i11] * w11;
        const gv = q[i00] * w00 + q[i01] * w01 + q[i10] * w10 + q[i11] * w11;
        out[j + c] = clamp01(v * m * (col === c ? 1 : lo) + gv * gk) * 255 + 0.5;
      }
    }
  }
  return out;
}

/** VHS — 색이 옆으로 번지고 밀리며, 줄마다 떨리고, 아래쪽에 트래킹 띠 · 잡음 · 옅은 채도 */
function vhs(src: Uint8ClampedArray, w: number, h: number, t: number, seed: number): Uint8ClampedArray {
  const n = w * h;
  const rnd = rng(seed);
  const u = unitOf(w, h);
  const S = Math.min(w, h);
  const { r, g, b, a } = planes(src, n);
  let Y = new Float32Array(n);
  let I = new Float32Array(n);
  let Q = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    Y[i] = 0.299 * r[i] + 0.587 * g[i] + 0.114 * b[i];
    I[i] = 0.596 * r[i] - 0.274 * g[i] - 0.322 * b[i];
    Q[i] = 0.211 * r[i] - 0.523 * g[i] + 0.312 * b[i];
  }
  // 색은 가로로 크게 번지고, 밝기는 조금 번진다
  const rc = Math.max(1, Math.round(u * 12 * t));
  for (let p = 0; p < 3; p++) {
    I = blurH(I, w, h, rc);
    Q = blurH(Q, w, h, rc);
  }
  Y = blurH(Y, w, h, Math.round(u * 1.5 * t));
  const cshift = Math.round(u * 8 * t);
  // 줄마다 떨림 + 트래킹 띠
  const jit = new Float32Array(h);
  let walk = 0;
  for (let y = 0; y < h; y++) {
    walk = walk * 0.9 + (rnd() * 2 - 1) * 0.1;
    jit[y] = walk * u * 6 * t;
  }
  const bandY = Math.floor(h * (0.78 + rnd() * 0.16));
  const bandH = Math.max(2, Math.round(S * 0.035 * (0.5 + t)));
  const oY = new Float32Array(n);
  const oI = new Float32Array(n);
  const oQ = new Float32Array(n);
  const oa = new Float32Array(n);
  for (let y = 0; y < h; y++) {
    const inBand = y >= bandY && y < bandY + bandH;
    const dx = Math.round(jit[y] + (inBand ? (rnd() * 2 - 1) * u * 30 * t : 0));
    const o = y * w;
    for (let x = 0; x < w; x++) {
      const i = o + x;
      const sx = Math.min(w - 1, Math.max(0, x - dx));
      const cx = Math.min(w - 1, Math.max(0, sx - cshift));
      let yy = Y[o + sx];
      yy = yy * (1 - 0.06 * t) + 0.05 * t + (rnd() * 2 - 1) * 0.07 * t;
      if (inBand && rnd() < 0.25 * t) yy += rnd() * 0.6 * t;
      oY[i] = yy;
      oI[i] = I[o + cx] * (1 - 0.25 * t);
      oQ[i] = Q[o + cx] * (1 - 0.25 * t);
      oa[i] = a[o + sx];
    }
  }
  for (let i = 0; i < n; i++) {
    const yy = oY[i];
    r[i] = clamp01(yy + 0.956 * oI[i] + 0.621 * oQ[i]);
    g[i] = clamp01(yy - 0.272 * oI[i] - 0.647 * oQ[i]);
    b[i] = clamp01(yy - 1.106 * oI[i] + 1.703 * oQ[i]);
  }
  return pack(r, g, b, oa);
}

/** 색수차 — 가장자리로 갈수록 빨강은 바깥, 파랑은 안쪽으로 어긋난다 (렌즈) */
function chroma(src: Uint8ClampedArray, w: number, h: number, t: number): Uint8ClampedArray {
  const n = w * h;
  const { r, g, b, a } = planes(src, n);
  const s = 0.02 * t;
  const cx = (w - 1) / 2;
  const cy = (h - 1) / 2;
  const or = new Float32Array(n);
  const ob = new Float32Array(n);
  const oa = new Float32Array(n);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const dx = x - cx;
      const dy = y - cy;
      const rx = cx + dx * (1 - s);
      const ry = cy + dy * (1 - s);
      const bx = cx + dx * (1 + s);
      const by = cy + dy * (1 + s);
      or[i] = sample(r, w, h, rx, ry);
      ob[i] = sample(b, w, h, bx, by);
      oa[i] = Math.max(a[i], sample(a, w, h, rx, ry), sample(a, w, h, bx, by));
    }
  }
  return pack(or, g, ob, oa);
}

/** 필름 — 검정이 뜨고 흰색이 눌리며, 그림자는 청록·밝은 곳은 주황, 채도 조금 낮춤, 중간톤에 짙은 입자, 가장자리 어둡게 */
function film(src: Uint8ClampedArray, w: number, h: number, t: number, seed: number): Uint8ClampedArray {
  const n = w * h;
  const rnd = rng(seed);
  const u = unitOf(w, h);
  const { r, g, b, a } = planes(src, n);
  let grain = new Float32Array(n);
  for (let i = 0; i < n; i++) grain[i] = rnd() + rnd() - 1;
  const gr = Math.floor(u * 0.9);
  if (gr >= 1) {
    grain = blurV(blurH(grain, w, h, gr), w, h, gr);
    let v = 0;
    for (let i = 0; i < n; i++) v += grain[i] * grain[i];
    const k = 0.41 / Math.max(1e-6, Math.sqrt(v / n));
    for (let i = 0; i < n; i++) grain[i] *= k;
  }
  const lift = 0.07 * t;
  const press = 0.05 * t;
  for (let y = 0; y < h; y++) {
    const ny = ((y + 0.5) / h) * 2 - 1;
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const nx = ((x + 0.5) / w) * 2 - 1;
      let R = r[i];
      let G = g[i];
      let B = b[i];
      const L = 0.299 * R + 0.587 * G + 0.114 * B;
      // 채도 조금 낮춤
      const ds = 0.15 * t;
      R += (L - R) * ds;
      G += (L - G) * ds;
      B += (L - B) * ds;
      // 스플릿 토닝
      const sh = (1 - L) * (1 - L);
      const hi = L * L;
      R += 0.05 * t * hi - 0.02 * t * sh;
      G += 0.012 * t * hi + 0.015 * t * sh;
      B += -0.045 * t * hi + 0.035 * t * sh;
      // 바랜 검정 · 눌린 흰색
      R = lift + R * (1 - lift - press);
      G = lift + G * (1 - lift - press);
      B = lift + B * (1 - lift - press);
      // 입자 — 중간톤에서 가장 짙다
      const gn = grain[i] * 0.11 * t * (0.35 + 2.6 * L * (1 - L));
      const vig = 1 - 0.3 * t * smooth(0.3, 1.25, Math.sqrt(nx * nx + ny * ny));
      r[i] = clamp01((R + gn) * vig);
      g[i] = clamp01((G + gn) * vig);
      b[i] = clamp01((B + gn) * vig);
    }
  }
  return pack(r, g, b, a);
}

/** 블룸 — 밝은 곳이 주위로 번져 빛난다 (좁은 번짐 + 넓은 번짐, 스크린 합성) */
function bloom(src: Uint8ClampedArray, w: number, h: number, t: number): Uint8ClampedArray {
  const n = w * h;
  const u = unitOf(w, h);
  const { r, g, b, a } = planes(src, n);
  const br = new Float32Array(n);
  const bg = new Float32Array(n);
  const bb = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const L = 0.299 * r[i] + 0.587 * g[i] + 0.114 * b[i];
    const k = smooth(0.55, 1, L) * a[i];
    br[i] = r[i] * k;
    bg[i] = g[i] * k;
    bb[i] = b[i] * k;
  }
  const near = [blurWide(br, w, h, u * 5), blurWide(bg, w, h, u * 5), blurWide(bb, w, h, u * 5)];
  const far = [blurWide(br, w, h, u * 22), blurWide(bg, w, h, u * 22), blurWide(bb, w, h, u * 22)];
  const chans = [r, g, b];
  for (let c = 0; c < 3; c++) {
    const p = chans[c];
    for (let i = 0; i < n; i++) {
      const glow = clamp01((near[c][i] * 0.6 + far[c][i] * 0.9) * 1.3 * t);
      p[i] = 1 - (1 - p[i]) * (1 - glow);
    }
  }
  return pack(r, g, b, a);
}

/** 하프톤 — 인쇄 망점 (CMYK 네 판을 15·75·0·45도로 돌려 찍는다). 흰 종이 위에 찍고 원본과 강도만큼 섞는다 */
function halftone(src: Uint8ClampedArray, w: number, h: number, t: number): Uint8ClampedArray {
  const n = w * h;
  const { r, g, b, a } = planes(src, n);
  const cell = Math.max(4, Math.min(w, h) / 110);
  const C = new Float32Array(n);
  const M = new Float32Array(n);
  const Yp = new Float32Array(n);
  const K = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    // ★검정 판은 어두운 곳에만 (밝은 색 위에 검은 망점이 박히면 지저분하다) — 인쇄의 UCR 과 같은 생각
    const dark = 1 - Math.max(r[i], g[i], b[i]);
    const k = dark * dark;
    const d = Math.max(1e-6, 1 - k);
    C[i] = (1 - r[i] - k) / d;
    M[i] = (1 - g[i] - k) / d;
    Yp[i] = (1 - b[i] - k) / d;
    K[i] = k;
  }
  const inks: [Float32Array, number][] = [
    [C, 15],
    [M, 75],
    [Yp, 0],
    [K, 45],
  ];
  const cov = inks.map(() => new Float32Array(n));
  inks.forEach(([plate, deg], p) => {
    const cs = Math.cos((deg * Math.PI) / 180);
    const sn = Math.sin((deg * Math.PI) / 180);
    const out = cov[p];
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        // 돌린 격자에서 이 픽셀이 든 칸의 가운데
        const u = (x * cs + y * sn) / cell;
        const v = (-x * sn + y * cs) / cell;
        const cu = Math.floor(u) + 0.5;
        const cv = Math.floor(v) + 0.5;
        const mx = (cu * cs - cv * sn) * cell;
        const my = (cu * sn + cv * cs) * cell;
        const ix = Math.min(w - 1, Math.max(0, Math.round(mx)));
        const iy = Math.min(h - 1, Math.max(0, Math.round(my)));
        const val = clamp01(plate[iy * w + ix]);
        // ★망점의 넓이가 잉크 양과 같게 (반지름을 √ 로) — 넓이를 칸의 반 이상으로 부풀리면 그림이 통째로 어두워진다
        const rad = Math.sqrt(val / Math.PI) * cell;
        const du = (u - cu) * cell;
        const dv = (v - cv) * cell;
        const dist = Math.sqrt(du * du + dv * dv);
        out[y * w + x] = clamp01(rad - dist + 0.5);
      }
    }
  });
  for (let i = 0; i < n; i++) {
    const kk = 1 - cov[3][i];
    const hr = (1 - cov[0][i]) * kk;
    const hg = (1 - cov[1][i]) * kk;
    const hb = (1 - cov[2][i]) * kk;
    r[i] += (hr - r[i]) * t;
    g[i] += (hg - g[i]) * t;
    b[i] += (hb - b[i]) * t;
  }
  return pack(r, g, b, a);
}

/** 도트 — 큰 픽셀로 뭉치고 색 수를 줄인다 (도트 그림) */
function pixel(src: Uint8ClampedArray, w: number, h: number, t: number): Uint8ClampedArray {
  const S = Math.min(w, h);
  const across = 260 - 190 * t;
  const bs = Math.max(1, Math.round(S / across));
  const levels = Math.max(2, Math.round(24 - 14 * t));
  const q = (v: number) => Math.round(clamp01(v) * (levels - 1)) / (levels - 1);
  const out = new Uint8ClampedArray(src.length);
  for (let by = 0; by < h; by += bs) {
    for (let bx = 0; bx < w; bx += bs) {
      let sr = 0, sg = 0, sb = 0, sa = 0, cnt = 0;
      const ye = Math.min(h, by + bs);
      const xe = Math.min(w, bx + bs);
      for (let y = by; y < ye; y++) {
        for (let x = bx; x < xe; x++) {
          const j = (y * w + x) * 4;
          const al = src[j + 3];
          sr += src[j] * al;
          sg += src[j + 1] * al;
          sb += src[j + 2] * al;
          sa += al;
          cnt++;
        }
      }
      const A = sa / cnt;
      // ★투명과 불투명의 경계는 반쯤 투명하게 두지 않고 가른다 (도트 그림은 가장자리가 딱 떨어진다)
      const outA = A >= 128 ? 255 : 0;
      // ★채널마다 따로 줄이면 회색 배경이 채널마다 다른 자리에서 꺾여 분홍·초록 띠가 진다 (실측) —
      //   밝기와 색 차이를 따로 줄여서 회색은 회색으로 남긴다
      const r0 = sa ? sr / sa / 255 : 0;
      const g0 = sa ? sg / sa / 255 : 0;
      const b0 = sa ? sb / sa / 255 : 0;
      const L = q(0.299 * r0 + 0.587 * g0 + 0.114 * b0);
      const step = (v: number) => Math.round(v * (levels - 1)) / (levels - 1);
      const lum = 0.299 * r0 + 0.587 * g0 + 0.114 * b0;
      const R = clamp01(L + step(r0 - lum)) * 255;
      const G = clamp01(L + step(g0 - lum)) * 255;
      const B = clamp01(L + step(b0 - lum)) * 255;
      for (let y = by; y < ye; y++) {
        for (let x = bx; x < xe; x++) {
          const j = (y * w + x) * 4;
          out[j] = R;
          out[j + 1] = G;
          out[j + 2] = B;
          out[j + 3] = outA;
        }
      }
    }
  }
  return out;
}

/** 비네팅 — 가장자리를 어둡게 */
function vignette(src: Uint8ClampedArray, w: number, h: number, t: number): Uint8ClampedArray {
  const out = new Uint8ClampedArray(src);
  for (let y = 0; y < h; y++) {
    const ny = ((y + 0.5) / h) * 2 - 1;
    for (let x = 0; x < w; x++) {
      const nx = ((x + 0.5) / w) * 2 - 1;
      const v = 1 - 0.8 * t * smooth(0.35, 1.3, Math.sqrt(nx * nx + ny * ny));
      const j = (y * w + x) * 4;
      out[j] = src[j] * v;
      out[j + 1] = src[j + 1] * v;
      out[j + 2] = src[j + 2] * v;
    }
  }
  return out;
}
