/** 가리기를 **화면에서 그린다** — 캔버스 합성기.
 *
 *  ★★사용자 결정 2026-08-23: 가리는 일을 서버에서 화면으로 옮긴다. 그전에는 박스를 1px 만
 *    움직여도 서버가 그림 전체를 다시 그려 보냈다 (실측: 스팀 219ms + PNG 인코딩 58ms).
 *    사람 손이 움직이는 속도에는 원리상 못 따라온다.
 *  ★★렌더러는 **이것 하나뿐이다.** 저장도 이 함수가 원본 크기로 그린 것을 올린다
 *    (`renderFull`). v2 는 화면과 서버에 한 벌씩 두어 미리보기와 저장본이 갈렸는데,
 *    그 사고는 「두 벌」에서 온 것이지 「화면에서 그린다」에서 온 것이 아니다.
 *
 *  구조 — **재료와 모양을 가른다.** 여기가 빠른 까닭이다:
 *
 *      재료  방식·설정에만 매인다. 그림 전체를 덮은 한 장을 만들어 **캐시**한다
 *            (모자이크·흐리기·단색). 스팀은 박스 비율별 무늬 판을 캐시한다.
 *      모양  박스의 자리·크기·회전·넓히기·부드럽게. **매 프레임** 다시 그린다.
 *
 *  박스를 끄는 동안 일어나는 일은 `drawImage` 몇 번과 경로 채우기 하나뿐이다.
 */
import { cloudScale, fadeStartOf, plateRGBA, prepRegion, regionCoverRows, regionReach } from "./steam.ts";
import { makeNoise } from "./noise.ts";
import { methodIndex, rectEmpty, type Mask, type Rect } from "./censorMask.ts";
import { drawBlurred } from "./canvasFilter.ts";
import type { RegionCloud } from "./steam.ts";

/** 한 장에 그릴 것. ★★두 갈래다 (`censorMask` 머리의 ★★주): 스팀은 **사각형 목록**으로(비트맵을 8px
 *  격자로 줄여 덮은 것), 나머지 방식은 **비트맵 그대로** 마스크로 쓴다. 어느 방식이 있는지는 `boxes` 가
 *  말한다 (픽셀이 있는 방식은 사각형도 있다). */
export type Scene = {
  boxes: RenderBox[];
  mask: Mask | null;
  /** 끄는 동안 **이번 획이 새로 칠한 조각** (스팀). 본 목록은 구워 둔 것을 그대로 쓰고, 이것만 따로 굽는다 */
  overlay?: RenderBox[];
  /** 끄는 동안 **이번 획이 손댄 사각형** — 옮겨 둔 알파 판을 이 안만 다시 쓴다 (나머지 방식) */
  dirty?: Rect;
};

export type CoverSettings = {
  method: string;
  color: string;
  expand: number;
  feather: number;
  mosaic: number;
  mosaicOpacity: number;
  blur: number;
  steamBright: number;
  steamAlpha: number;
  /** 스팀 「경사」 0~100 — 알파 경사의 시작점을 안쪽으로 (`steam.fadeStartOf`). 칠한 넓이는 안 변한다 */
  steamFade: number;
};

export type RenderBox = {
  /** ★**안정된 씨앗**이다. 박스를 옮겨도 구름이 안 바뀌게 하려고 좌표가 아니라 이것을 쓴다
   *  (사용자 결정 2026-08-23). 옛것은 씨앗을 `x1*1000+y1` 로 만들어, 1px 만 밀어도
   *  구름이 통째로 다른 모양이 됐다. */
  seed: number;
  box: [number, number, number, number];
  rotation?: number;
  /** 박스마다 다른 방식 (없으면 전체 설정) */
  method?: string;
};

type Src = CanvasImageSource & { width: number; height: number };

/** 구름을 만드는 작업 해상도 (긴 변). ★★**여기가 비용이다** — 픽셀마다 노이즈를 여섯 번
 *  돈다 (실측 2026-09-05: 420px 에 40ms · 300px 에 21ms). 구름은 부드러워서 줄여 만들어
 *  늘려도 눈에 차이가 없다. */
const STEAM_WORK = 340;
/** ★★**끄는 동안**의 해상도. 손을 떼면 위 값으로 한 번 더 굽는다 — 이 앱이 한 번 겪은
 *  문제라(2026-08-23 「반응성이 매우 안 좋음」) 매 프레임 40ms 를 태울 수 없다. */
const STEAM_WORK_QUICK = 170;

const c2d = (w: number, h: number) => {
  const cv = document.createElement("canvas");
  cv.width = Math.max(1, Math.round(w));
  cv.height = Math.max(1, Math.round(h));
  return cv;
};

/** 덮임 값(0..255, `stride` 간격)을 **반지름 `r` 의 정사각 창 최소값**으로 — 침식.
 *
 *  ★★음수 「범위」(사용자 지시 2026-09-05: *"넓히기를 음수도 가능하게"*)는 **합집합을** 깎는다.
 *    사각형마다 깎으면 겹쳐 덮은 사각형(`rectsOf`)이 만나는 자리마다 양쪽이 물러나 **덩어리
 *    안쪽에 틈**이 생긴다. 그래서 양수는 v2 대로 사각형마다 넓히고, 음수는 다 모은 뒤 한 번 깎는다.
 *  가로·세로 두 번의 1차원 최소값이라 반지름과 무관하게 픽셀당 상수 비용이다 (van Herk). */
export function erodeAlpha(a: Uint8Array | Uint8ClampedArray, W: number, H: number, r: number, stride = 1, offset = 0) {
  rankAlpha(a, W, H, r, stride, offset, false);
}

/** 반대 — **정사각 창 최대값**으로 넓힌다 (팽창). 양수 「범위」와 「부드럽게」의 테두리 넓히기가 쓴다.
 *  ★비트맵 마스크에는 사각형마다 넓힐 경로가 없으므로(픽셀뿐이다) 마스크를 그린 뒤 한 번에 넓힌다 */
export function dilateAlpha(a: Uint8Array | Uint8ClampedArray, W: number, H: number, r: number, stride = 1, offset = 0) {
  rankAlpha(a, W, H, r, stride, offset, true);
}

function rankAlpha(
  a: Uint8Array | Uint8ClampedArray, W: number, H: number, r: number, stride: number, offset: number, max: boolean,
) {
  const R = Math.round(r);
  if (R <= 0) return;
  const k = 2 * R + 1;
  const n = Math.max(W, H);
  const tmp = new Uint8Array(n + 2 * R), f = new Uint8Array(n + 2 * R), b = new Uint8Array(n + 2 * R);
  /* ★★닫힌 고리로 쓴다 — 픽셀마다 `get`·`put` 닫힘을 부르던 판은 30만 픽셀에 30~60ms 였다 (2026-09-05 하네스).
     `pos` 는 줄(가로 훑기)이면 stride, 열(세로 훑기)이면 W*stride 만큼 뛴다. 양 끝은 밖을 「0」으로 본다 —
     그림 끝에서도 깎이고(침식), 넓혀도 그림 밖으로는 안 나간다(팽창). */
  const pass = (len: number, start: number, step: number) => {
    const m = len + 2 * R;
    tmp.fill(0, 0, m);
    for (let i = 0, p = start; i < len; i++, p += step) tmp[R + i] = a[p];
    if (max) {
      for (let i = 0, c = 0; i < m; i++, c++) { if (c === k) c = 0; const t = tmp[i]; f[i] = c === 0 ? t : (f[i - 1] > t ? f[i - 1] : t); }
      for (let i = m - 1, c = 0; i >= 0; i--, c++) { const t = tmp[i]; b[i] = (i % k === k - 1 || i === m - 1) ? t : (b[i + 1] > t ? b[i + 1] : t); }
      for (let i = 0, p = start; i < len; i++, p += step) { const x = b[i], y = f[i + k - 1]; a[p] = x > y ? x : y; }
    } else {
      for (let i = 0, c = 0; i < m; i++, c++) { if (c === k) c = 0; const t = tmp[i]; f[i] = c === 0 ? t : (f[i - 1] < t ? f[i - 1] : t); }
      for (let i = m - 1; i >= 0; i--) { const t = tmp[i]; b[i] = (i % k === k - 1 || i === m - 1) ? t : (b[i + 1] < t ? b[i + 1] : t); }
      for (let i = 0, p = start; i < len; i++, p += step) { const x = b[i], y = f[i + k - 1]; a[p] = x < y ? x : y; }
    }
  };
  for (let y = 0; y < H; y++) pass(W, y * W * stride + offset, stride);
  for (let x = 0; x < W; x++) pass(H, x * stride + offset, W * stride);
}

/** 구름 무리 한 장 (화면에 붙이는 캔버스). `full` 이 거짓이면 아직 저해상도 덮임이 섞여 있다 */
type SteamEntry = { cv: HTMLCanvasElement; x: number; y: number; w: number; h: number; full: boolean };
type SteamItem = { b: RenderBox; cx: number; cy: number; w: number; h: number; rot: number };
/** 칠 덩어리 하나의 **덮임** — 작업 격자. 상자 하나면 v2 판을, 자유 영역이면 거리 구름을 여기 쌓는다 */
type BlobEntry = {
  x0: number; y0: number; W: number; H: number; k: number; gw: number; gh: number; sx: number; sy: number;
  cover: Uint8Array; full: boolean;
};
/** 덩어리 굽기 한 판 — `step()` 을 되풀이 부르면 몇 ms 씩 나눠 굽는다 (끝나면 true). 상자 하나는 판 한 장,
 *  자유 영역은 거리장 만들기 → 줄 묶음마다 덮임 */
type BlobBake = { entry: BlobEntry; step: () => boolean; pieces: number };
/** 사각형들을 감싸는 자리 (1px 여유, 정수) */
function bboxOf(rs: number[][]) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const r of rs) {
    x0 = Math.min(x0, r[0]); y0 = Math.min(y0, r[1]);
    x1 = Math.max(x1, r[2]); y1 = Math.max(y1, r[3]);
  }
  x0 = Math.floor(x0 - 1); y0 = Math.floor(y0 - 1);
  x1 = Math.ceil(x1 + 1); y1 = Math.ceil(y1 + 1);
  return { x0, y0, W: Math.max(1, x1 - x0), H: Math.max(1, y1 - y0) };
}

/** 한가한 틈에 한 걸음 — 뒤에서 굽기용. 없는 환경이면 타이머로 */
const idle = (fn: () => void) => {
  const ric = (globalThis as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => void }).requestIdleCallback;
  if (ric) ric(fn, { timeout: 100 });
  else setTimeout(fn, 0);
};

/** 그림 한 장에 딸린 렌더러. 재료 캐시를 들고 있으므로 **그림마다 하나** 만든다. */
export class CensorRenderer {
  private src: Src;
  /** 원본 픽셀 크기 */
  readonly w: number;
  readonly h: number;

  /** 재료 — 그림 전체를 덮은 한 장. 열쇠는 `방식|수치|그릴 크기` */
  private layers = new Map<string, HTMLCanvasElement>();
  /** 구운 구름 한 장 — 열쇠는 **모양과 설정**이다 (`steamKey`) */
  /** 덩어리별 캔버스 — 덮임에 색을 입힌 것. 열쇠는 덩어리 열쇠·색 설정 (`drawSteam` ②). `full` 이 거짓이면 저해상도 */
  private steamGroups = new Map<string, SteamEntry>();
  /** 칠 덩어리별로 쌓은 덮임 — 열쇠는 그 덩어리의 박스·설정·배율 (`steamKey`). `full` 이 거짓이면 끄는 동안의 저해상도 */
  private blobs = new Map<string, BlobEntry>();
  /** 뒤에서 굽는 중인 덩어리 (열쇠 → 작업). 작업은 매 걸음 자기가 아직 그 열쇠의 주인인지 본다 */
  private jobs = new Map<string, object>();
  /** 뒤에서 굽던 것이 끝나면 부른다 — 무대가 다시 그리게 (`paint`) */
  onReady: (() => void) | null = null;
  /** 매 프레임 새로 만들지 않으려고 들고 있는 석 장 (모양 · 여백을 두른 모양 · 오려낸 재료) */
  private maskCv: HTMLCanvasElement | null = null;
  /** 비트맵을 옮겨 놓은 **원본 크기** 알파 판 — 방식마다 하나. 어느 비트맵의 몇 번째 판인지 들고 있다가
   *  안 바뀌었으면 그대로 쓰고, 획 중이면 손댄 사각형만 다시 쓴다 (`drawMasked` 의 ★★주) */
  private alphaCvs = new Map<string, { cv: HTMLCanvasElement; mask: Mask | null; rev: number }>();
  private padCv: HTMLCanvasElement | null = null;
  private cutCv: HTMLCanvasElement | null = null;

  constructor(src: Src, w?: number, h?: number) {
    this.src = src;
    this.w = w ?? src.width;
    this.h = h ?? src.height;
  }

  /** 설정이 바뀌면 재료를 버린다. ★모양만 바뀔 때는 **부르지 않는다** — 그게 빠른 이유다 */
  invalidate() {
    this.layers.clear();
    this.steamGroups.clear();
    this.blobs.clear();
    this.jobs.clear();
  }

  /** 무늬까지 버린다 (「부드럽게」가 바뀌었을 때) */
  invalidateAll() {
    this.invalidate();
  }

  /** 한 장을 그린다. `scale` 은 **원본 픽셀당 화면 픽셀**.
   *
   *  ★`withBase` 가 거짓이면 **덮개만** 그린다 (바탕은 투명). 화면에서는 원본을 `<img>` 로
   *    이미 깔아 두었으므로 그 위에 덮개만 얹으면 되고, 매 프레임 원본을 다시 그리지 않아도
   *    된다. 「들춰보기」도 이 캔버스의 CSS 투명도 하나로 끝난다.
   *  ★저장할 때만 참이다 — 그때는 한 장으로 합쳐야 한다. */
  /** `scene.overlay` — 끄는 동안 **이번 획이 새로 칠한 조각**(스팀). 본 목록은 구워 둔 것을 그대로 쓰고,
   *  이것만 따로(열쇠 `ov|`) 저해상도로 구워 위에 얹는다. 손을 떼면 본 목록에 합쳐져 들어오므로 그때 사라진다.
   *  ★겹친 자리는 최대값이 아니라 그냥 덧그려져 조금 밝을 수 있다 — 끄는 동안(옅게 보이는 때)뿐이다.
   *  ★나머지 방식은 비트맵을 그대로 그리므로 얹을 것이 없다 — 획이 손댄 만큼만 비용이 든다. */
  draw(
    target: HTMLCanvasElement, scene: Scene, s: CoverSettings,
    scale: number, withBase = false, quick = false, sync = false,
  ) {
    const { boxes, mask } = scene;
    const overlay = scene.overlay ?? [];
    const W = Math.max(1, Math.round(this.w * scale));
    const H = Math.max(1, Math.round(this.h * scale));
    if (target.width !== W || target.height !== H) {
      target.width = W;
      target.height = H;
      // 크기가 바뀌면 재료도 그 크기로 다시 만들어야 한다
      this.invalidate();
    }
    const ctx = target.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, W, H);
    if (withBase) ctx.drawImage(this.src, 0, 0, W, H);
    if (!boxes.length && !overlay.length) {
      this.steamGroups.clear();
      this.blobs.clear();
      this.jobs.clear();
      return;
    }

    // ★방식이 섞여 있어도 **한 방식당 한 번**만 오려 붙인다 (박스마다 오리면 그만큼 느려진다)
    const byMethod = (list: RenderBox[]) => {
      const m = new Map<string, RenderBox[]>();
      for (const b of list) {
        const how = b.method || s.method;
        const at = m.get(how);
        if (at) at.push(b);
        else m.set(how, [b]);
      }
      return m;
    };
    const groups = byMethod(boxes);
    const extra = byMethod(overlay);
    const used = new Set<string>();
    for (const how of new Set([...groups.keys(), ...extra.keys()])) {
      const list = groups.get(how) ?? [];
      const ov = extra.get(how) ?? [];
      if (how === "steam") {
        for (const k of this.drawSteam(ctx, list, s, scale, quick, sync, "", mask)) used.add(k);
        // ★이번 획의 델타는 제 열쇠로 따로 — 본 덩어리의 캐시를 건드리지 않는다
        if (ov.length) for (const k of this.drawSteam(ctx, ov, s, scale, true, false, "ov|", mask)) used.add(k);
      }
      else if (mask) this.drawMasked(ctx, how, mask, s, scale, W, H, scene.dirty);
    }
    // 이번에 안 쓴 덩어리·무리(모양이 바뀐 것의 옛 열쇠·끝난 획의 델타)는 버린다 — 굽던 작업도 함께
    for (const k of this.steamGroups.keys()) if (!used.has(k)) this.steamGroups.delete(k);
    for (const k of this.blobs.keys()) if (!used.has(k)) this.blobs.delete(k);
    for (const k of this.jobs.keys()) if (!used.has(k)) this.jobs.delete(k);
  }

  // ── 재료 ──────────────────────────────────────────────────

  private layer(how: string, s: CoverSettings, scale: number, W: number, H: number) {
    const key = `${how}|${s.mosaic}|${s.blur}|${s.color}|${W}x${H}`;
    const hit = this.layers.get(key);
    if (hit) return hit;
    const cv = c2d(W, H);
    const g = cv.getContext("2d")!;
    if (how === "mosaic") {
      // ★★격자를 **그림 기준**으로 맞춘다 (사용자 결정 2026-08-23). 옛것은 잘라낸 조각마다
      //   따로 줄여서, 박스를 옮기면 무늬가 미끄러졌다. 그림째 줄이면 제자리에 선다.
      const block = Math.max(1, s.mosaic * scale);
      const sw = Math.max(1, Math.round(W / block));
      const sh = Math.max(1, Math.round(H / block));
      const small = c2d(sw, sh);
      const sg = small.getContext("2d")!;
      sg.imageSmoothingEnabled = true;
      sg.drawImage(this.src, 0, 0, sw, sh);
      g.imageSmoothingEnabled = false;
      g.drawImage(small, 0, 0, W, H);
      g.imageSmoothingEnabled = true;
    } else if (how === "blur") {
      // ★맥(WKWebView)은 `ctx.filter` 가 꺼져 있어 픽셀로 흐린다 (`canvasFilter` 머리 주석)
      drawBlurred(g, this.src, W, H, Math.max(1, s.blur * scale));
      // ★가장자리가 비쳐 어두워지는 것을 막는다. 흐리기는 판 밖을 투명으로 보므로,
      //   그 자리에 **원본을 깔아** 메운다 (박스가 그림 끝에 붙었을 때만 보이던 결함)
      g.globalCompositeOperation = "destination-over";
      g.drawImage(this.src, 0, 0, W, H);
      g.globalCompositeOperation = "source-over";
    } else {
      g.fillStyle = how === "white" ? "#ffffff" : how === "color" ? s.color : "#000000";
      g.fillRect(0, 0, W, H);
    }
    this.layers.set(key, cv);
    return cv;
  }

  // ── 모양 ──────────────────────────────────────────────────

  private drawMasked(
    ctx: CanvasRenderingContext2D, how: string, mask: Mask,
    s: CoverSettings, scale: number, W: number, H: number, dirty?: Rect,
  ) {
    const feather = s.feather * scale;
    /* ★「범위」와 「부드럽게」의 테두리 넓히기를 **한 번의 팽창·침식**으로 (`dilateAlpha`·`erodeAlpha`).
       사각형 시절에는 양수 범위를 사각형마다 넓히고 테두리를 feather 폭으로 그어 넓혔는데, 비트맵에는
       사각형이 없으니 마스크를 그린 뒤 합집합을 통째로 넓히거나 깎는다. 안쪽은 100% 로 남기고
       **가장자리만** 부드럽게 하려면 흐리기 전에 feather/2 만큼 넓혀야 한다 (파이썬의 MaxFilter →
       GaussianBlur 과 같은 차례다) — 바로 흐리면 안쪽까지 옅어져 가려야 할 것이 비친다. */
    const net = s.expand * scale + feather / 2;
    /* ★★그림 가장자리에 붙은 박스가 **끝에서 옅어지던 결함** (유저 제보 2026-09-02: 흰색 검열이
       좌·우·상단 가장자리에서 제대로 안 됨). 캔버스 `blur` 필터는 캔버스 **밖을 투명**으로
       보므로, 마스크를 그림 크기 그대로 흐리면 그림 끝에서 feather 폭만큼 마스크가 빠지고
       그 자리의 덮개가 반투명이 된다 (실측: feather 10 에서 끝 픽셀의 원본 비침 46%).
       흰색만이 아니라 검정·색 지정·모자이크·흐리기가 전부 같은 마스크를 지난다.
       그래서 **여백(`m`)을 두른 판**에 마스크를 놓고, 그림 가장자리 픽셀을 여백으로 늘려
       깐 뒤(가장자리 복제 = 밖을 「끝과 같은 값」으로 본다) 흐린다. 그림 안쪽에서 끝나는
       변의 부드러움은 그대로다. 여백은 blur 반경(σ = feather/2)의 4배로, 그 밖의 투명이
       끝에 미치는 몫은 0.1% 미만이다. */
    /* ★계단은 흐림으로 다듬지 않는다 (사용자 지적 2026-09-05: *"테두리가 블러된 것처럼 흐려"* — σ 1px 흐림을
       걸어 봤더니 3px 로 번졌다). 원형 붓의 테두리는 마스크가 **덮인 비율**(`alpha`)로 들고 있어 1px 안에서
       전환된다. 흐림은 「부드럽게」가 켜졌을 때만이다. */
    const m = feather > 0 ? Math.ceil(feather * 2) : 0;
    const PW = W + m * 2;
    const PH = H + m * 2;
    if (!this.maskCv || this.maskCv.width !== W || this.maskCv.height !== H
        || !this.padCv || this.padCv.width !== PW || this.padCv.height !== PH) {
      this.maskCv = c2d(W, H);
      this.padCv = c2d(PW, PH);
      this.cutCv = c2d(PW, PH);
    }
    const cv = this.maskCv;
    // ★팽창·침식이 getImageData 로 읽으므로 자주 읽는다고 알린다 (GPU 캔버스 읽기 경고)
    const mg = cv.getContext("2d", { willReadFrequently: true })!;
    mg.setTransform(1, 0, 0, 1, 0, 0);
    mg.clearRect(0, 0, W, H);

    /* ★★비트맵을 **원본 크기의 알파 판**으로 옮겨 놓고 화면 크기로 줄여 그린다. 이 방식의 픽셀만 켠다
       (`v`) — 방식이 섞여 있어도 판은 방식마다 따로다. 줄여 그릴 때 보간이 가장자리를 1px 안에서 부드럽게 한다.
       ★★판은 **들고 있다가 다시 쓴다** (2026-09-05 하네스: 매 프레임 다시 옮기니 흰색 프레임이 격자 시절
         4ms → 14ms). 비트맵의 `rev` 가 그대로면 손대지 않고, 획 중(`dirty`)이면 손댄 사각형만 다시 쓰고,
         그 밖(되돌리기·덩어리 삭제·방식 바꾸기)에는 켜진 자리(`bounds`)를 다시 쓴다. 지운 픽셀도 그 사각형
         안에 있으므로 덮어쓰기(putImageData)로 함께 지워진다. */
    const v = methodIndex(how);
    const b = mask.bounds;
    if (rectEmpty(b)) return;
    let ent = this.alphaCvs.get(how);
    if (!ent || ent.cv.width !== mask.w || ent.cv.height !== mask.h) {
      ent = { cv: c2d(mask.w, mask.h), mask: null, rev: -1 };
      this.alphaCvs.set(how, ent);
    }
    const full = ent.cv;
    if (ent.mask !== mask || ent.rev !== mask.rev) {
      const fg = full.getContext("2d")!;
      const same = ent.mask === mask;
      if (!same) fg.clearRect(0, 0, mask.w, mask.h);
      const r = same && dirty && !rectEmpty(dirty) ? dirty : b;
      const x0 = Math.max(0, r.x0), y0 = Math.max(0, r.y0), x1 = Math.min(mask.w, r.x1), y1 = Math.min(mask.h, r.y1);
      if (x1 > x0 && y1 > y0) {
        const bw = x1 - x0, bh = y1 - y0;
        const img = fg.createImageData(bw, bh);
        const px = img.data;
        const cells = mask.cells, alpha = mask.alpha;
        for (let y = 0; y < bh; y++) {
          const row = (y0 + y) * mask.w + x0;
          let o = y * bw * 4;
          for (let x = 0; x < bw; x++, o += 4) {
            // 덮인 비율이 알파다 — 원형 붓의 테두리 픽셀이 반투명으로 옮겨져 계단이 안 진다
            if (cells[row + x] === v) { px[o] = px[o + 1] = px[o + 2] = 255; px[o + 3] = alpha[row + x]; }
          }
        }
        fg.putImageData(img, x0, y0);
      }
      ent.mask = mask;
      ent.rev = mask.rev;
    }
    // 켜진 자리만 옮겨 그린다 (그림 전체를 읽지 않는다)
    const bw = b.x1 - b.x0, bh = b.y1 - b.y0;
    mg.imageSmoothingEnabled = true;
    // ★줄여 그릴 때 보간 품질을 올린다 — 기본(양선형)은 0.6배 축소에서 덮인 비율의 계단을 도로 드러냈다 (하네스 6배 확대)
    mg.imageSmoothingQuality = "high";
    mg.drawImage(full, b.x0, b.y0, bw, bh, b.x0 * scale, b.y0 * scale, bw * scale, bh * scale);
    if (Math.abs(net) >= 0.5) {
      // ★팽창·침식도 켜진 자리 둘레(반지름만큼 더)만 읽고 쓴다 — 비용이 칠한 자리 크기에 비례한다
      const R = Math.ceil(Math.abs(net)) + 1;
      const sx0 = Math.max(0, Math.floor(b.x0 * scale) - R), sy0 = Math.max(0, Math.floor(b.y0 * scale) - R);
      const sx1 = Math.min(W, Math.ceil(b.x1 * scale) + R), sy1 = Math.min(H, Math.ceil(b.y1 * scale) + R);
      const sw = sx1 - sx0, sh = sy1 - sy0;
      if (sw > 0 && sh > 0) {
        const im = mg.getImageData(sx0, sy0, sw, sh);
        if (net > 0) dilateAlpha(im.data, sw, sh, net, 4, 3);
        else erodeAlpha(im.data, sw, sh, -net, 4, 3);
        mg.putImageData(im, sx0, sy0);
      }
    }
    const mask2 = cv;

    // 여백을 두른 판 — 가운데에 마스크, 둘레에는 가장자리 한 줄을 늘려 깐다
    const pad = this.padCv!;
    const pg = pad.getContext("2d")!;
    pg.setTransform(1, 0, 0, 1, 0, 0);
    pg.clearRect(0, 0, PW, PH);
    pg.imageSmoothingEnabled = false;
    pg.drawImage(mask2, m, m);
    if (m > 0) {
      pg.drawImage(mask2, 0, 0, 1, H, 0, m, m, H);                 // 왼쪽 띠
      pg.drawImage(mask2, W - 1, 0, 1, H, m + W, m, m, H);         // 오른쪽 띠
      pg.drawImage(mask2, 0, 0, W, 1, m, 0, W, m);                 // 위 띠
      pg.drawImage(mask2, 0, H - 1, W, 1, m, m + H, W, m);         // 아래 띠
      pg.drawImage(mask2, 0, 0, 1, 1, 0, 0, m, m);                 // 네 모서리
      pg.drawImage(mask2, W - 1, 0, 1, 1, m + W, 0, m, m);
      pg.drawImage(mask2, 0, H - 1, 1, 1, 0, m + H, m, m);
      pg.drawImage(mask2, W - 1, H - 1, 1, 1, m + W, m + H, m, m);
    }
    pg.imageSmoothingEnabled = true;

    const cut = this.cutCv!;
    const cg = cut.getContext("2d")!;
    cg.setTransform(1, 0, 0, 1, 0, 0);
    cg.clearRect(0, 0, PW, PH);
    if (feather > 0) drawBlurred(cg, pad, PW, PH, feather / 2);
    else cg.drawImage(pad, 0, 0);
    // 마스크가 남긴 자리에만 재료를 남긴다 (재료는 그림 자리에만 — 여백은 어차피 잘려 나간다)
    cg.globalCompositeOperation = "source-in";
    cg.drawImage(this.layer(how, s, scale, W, H), m, m);
    cg.globalCompositeOperation = "source-over";

    // ★모자이크의 「진하기」는 재료를 옅게 얹는 것이다 (파이썬도 마스크에 곱했다)
    ctx.globalAlpha = how === "mosaic"
      ? Math.min(1, Math.max(0, s.mosaicOpacity / 100)) : 1;
    ctx.drawImage(cut, -m, -m);
    ctx.globalAlpha = 1;
  }

  /** 이 구름이 무엇으로 만들어졌나 — 모양이 바뀌면 다시 굽는다 */
  private steamKey(list: RenderBox[], s: CoverSettings, scale: number) {
    const boxes = list
      .map((b) => `${b.seed}:${b.box.map((v) => Math.round(v)).join(",")}:${(b.rotation ?? 0).toFixed(3)}`)
      .join("|");
    return `${boxes}|${s.expand}|${s.feather}|${s.steamBright}|${s.steamAlpha}|${s.steamFade}|${scale.toFixed(3)}`;
  }

  /** ── 스팀 ──────────────────────────────────────────────────
   *
   *  ★★★**칠한 영역에서의 거리로 구름을 만든다** (`steam.ts` 의 영역 구름). 찾은 상자든 붓으로 칠한 것이든
   *    **같은 방식**이다 (사용자 지시 2026-09-06: *"yolo 가 잡은 박스만 칠해지는 모양이 다름. 그것도 동일한
   *    방식으로"*). 상자 하나만 v2 판을 그대로 쓰던 갈래는 걷었다 — 판을 겹쳐 최대값으로 합치던 구조는
   *    자유 영역에서 튀고·십자가 서고·자락 경계가 계단졌다 (steam.ts 영역 구름 머리 주석).
   *    셈은 v2 판을 거리로 옮긴 것이라 원 하나면 v2 와 같고, 상자는 모서리가 v2 타원보다 더 덮인다.
   *
   *  ★★**낮은 해상도에서 만들어 늘려 그린다.** 구름은 부드러워서 원본의 1/3 로 만들어도 눈에 차이가 없고,
   *    붓을 끄는 동안 매 프레임 다시 만들 수 있어야 한다 (2026-08-23 「반응성이 매우 안 좋음」).
   *
   *  ★★**칠 덩어리 단위로 굽고, 덩어리마다 한 장이다** (사용자 결정 2026-09-05: *"브러시 영역 기준으로 묶는 게
   *    나을 거 같은데"*). 사각형이 닿는 조각끼리(= 붓이 이어 칠한 것)가 덩어리다. 손을 떼면 손댄 덩어리의
   *    열쇠만 바뀌어 그것만 다시 굽는다 (뒤에서, 몇 ms 씩 나눠). 구름 겹침으로 묶던 때는 구름이 상자보다
   *    두 배쯤 퍼져 멀리 떨어진 상자 다섯이 한 무리가 됐다 (*"모든 안개가 순차적으로 렌더되는 것처럼 보임"*).
   *    떨어진 두 덩어리의 자락이 겹치는 자리는 캔버스가 겹쳐 그려져 조금 진해질 수 있다 (자락이 옅어 눈에 잘
   *    안 띈다 — 사용자가 이 쪽을 골랐다).
   *  ★★**제 해상도 굽기는 뒤에서 나눠 굽는다** (사용자 로그 2026-09-05: 손을 뗀 굽기 50~146ms, 그 사이 커서가
   *    멈춘다). 손을 떼면 우선 저해상도로 바로 보여 주고, 제 해상도는 `startBake` 가 거리장 → 줄 묶음으로
   *    몇 ms 씩 한가한 틈에 굽는다. 다 구워지면 `onReady` 로 무대가 다시 그려 바꿔 끼운다.
   *    저장(`renderFull`)만 동기(`sync`)로 굽는다.
   */
  private drawSteam(
    ctx: CanvasRenderingContext2D, list: RenderBox[], s: CoverSettings, scale: number,
    quick: boolean, sync: boolean, prefix: string, mask: Mask | null,
  ): Set<string> {
    const used = new Set<string>();
    const live = list.filter((b) => b.box[2] > b.box[0] && b.box[3] > b.box[1]);
    if (!live.length) return used;

    /** 조각 하나가 화면에서 차지하는 자리 */
    const items: SteamItem[] = live.map((b) => {
      const [x1, y1, x2, y2] = b.box;
      return {
        b,
        cx: ((x1 + x2) / 2) * scale,
        cy: ((y1 + y2) / 2) * scale,
        // ★음수 「범위」는 여기서 안 쓴다 — 만든 덮임을 깎는다 (`composite` 의 `erodeAlpha`)
        w: (x2 - x1 + Math.max(0, s.expand) * 2) * scale,
        h: (y2 - y1 + Math.max(0, s.expand) * 2) * scale,
        rot: b.rotation ?? 0,
      };
    });
    // 조각의 화면 사각형 — 닿는 조각끼리가 칠 덩어리다
    const boxes = items.map((it) => [it.cx - it.w / 2, it.cy - it.h / 2, it.cx + it.w / 2, it.cy + it.h / 2]);

    const union = (rs: number[][], slack: number) => {
      const parent = rs.map((_, i) => i);
      const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
      for (let i = 0; i < rs.length; i++) {
        const a = rs[i];
        for (let j = i + 1; j < rs.length; j++) {
          const b = rs[j];
          if (a[0] <= b[2] + slack && b[0] <= a[2] + slack && a[1] <= b[3] + slack && b[1] <= a[3] + slack) parent[find(i)] = find(j);
        }
      }
      const groups = new Map<number, number[]>();
      for (let i = 0; i < rs.length; i++) {
        const r = find(i);
        const g = groups.get(r);
        if (g) g.push(i);
        else groups.set(r, [i]);
      }
      return groups;
    };

    // ① 칠 덩어리 — 사각형이 닿는 조각끼리 (1px 틈까지). 거리 구름을 만드는 느린 일은 덩어리 열쇠로 캐시한다
    const blobOf = new Map<number, string>();       // 조각 → 덩어리 열쇠
    const groupsHead = new Map<string, number>();   // 덩어리 열쇠 → 첫 조각 (씨앗은 여기서 딴다)
    let quickBaked = 0, syncBaked = 0, scheduled = 0;
    const t0 = performance.now();
    for (const idx of union(boxes, 1).values()) {
      const key = prefix + "b|" + this.steamKey(idx.map((i) => live[i]), s, scale);
      used.add(key);
      for (const i of idx) blobOf.set(i, key);
      groupsHead.set(key, idx[0]);
      const gItems = idx.map((i) => items[i]);
      let e = this.blobs.get(key);
      if (sync) {
        if (!e || !e.full) { e = this.bakeBlob(gItems, s, scale, false, mask); this.blobs.set(key, e); syncBaked++; }
      } else {
        // ★없으면 우선 저해상도로 바로 — 끄는 동안이든 손을 뗀 직후든 화면이 비지 않게
        if (!e) { e = this.bakeBlob(gItems, s, scale, true, mask); this.blobs.set(key, e); quickBaked++; }
        // ★손을 뗐는데 제 해상도가 아니면 뒤에서 굽는다 (이미 굽고 있으면 그대로)
        if (!quick && !e.full && !this.jobs.has(key)) { this.startBake(key, gItems, s, scale, mask); scheduled++; }
      }
    }

    // ② 덩어리마다 캔버스 한 장 — 덮임에 밝기·진하기를 입힌다. 덩어리가 다 구워지면(full) 한 번 더 만들어 바꿔 끼운다
    let composed = 0;
    for (const [i, blobKey] of blobOf) {
      if (i !== groupsHead.get(blobKey)) continue;      // 덩어리의 첫 조각에서 한 번만
      const key = prefix + "g|" + blobKey + `|${s.expand}|${s.steamBright}|${s.steamAlpha}`;
      used.add(key);
      const part = this.blobs.get(blobKey)!;
      let e = this.steamGroups.get(key);
      if (!e || (!e.full && part.full)) {
        e = this.composite(items[i], part, s, scale);
        this.steamGroups.set(key, e);
        composed++;
      }
      ctx.drawImage(e.cv, e.x, e.y, e.w, e.h);
    }
    if (!quick && !sync && !prefix) {
      console.info(`[censor] 손 뗌: 칠 덩어리 ${groupsHead.size} (조각 ${items.length}) — 저해상도 즉시 ${quickBaked}, 뒤에서 제 해상도 예약 ${scheduled}, 색 입히기 ${composed}, ${(performance.now() - t0).toFixed(0)}ms`);
    }
    return used;
  }

  /** 뒤에서 굽는 작업 — 몇 ms 씩 나눠, 한가한 틈마다 한 걸음. 다 되면 바꿔 끼우고 `onReady` */
  private startBake(key: string, gItems: SteamItem[], s: CoverSettings, scale: number, mask: Mask | null) {
    const job = {};
    this.jobs.set(key, job);
    const started = performance.now();
    let bake: BlobBake | null = null;
    let cpu = 0;
    const step = () => {
      // 열쇠가 버려졌거나(모양이 바뀜) 다른 작업으로 바뀌었으면 그만둔다
      if (this.jobs.get(key) !== job) return;
      const t0 = performance.now();
      if (!bake) {
        bake = this.prepBlob(gItems, s, scale, false, mask);
      } else {
        // 한 걸음에 8ms 까지만 — 입력·프레임 사이에 끼어도 안 걸리게
        let done = false;
        while (!done && performance.now() - t0 < 8) done = bake.step();
        if (done) {
          cpu += performance.now() - t0;
          this.jobs.delete(key);
          this.blobs.set(key, bake.entry);
          console.info(`[censor] 뒤에서 제 해상도 굽기 끝: 조각 ${bake.pieces}, 걸린 시간 ${(performance.now() - started).toFixed(0)}ms (CPU ${cpu.toFixed(0)}ms)`);
          this.onReady?.();
          return;
        }
      }
      cpu += performance.now() - t0;
      idle(step);
    };
    idle(step);
  }

  /** 칠 덩어리 하나를 **한 번에** 굽는다 (끄는 동안의 저해상도, 저장) */
  private bakeBlob(gItems: SteamItem[], s: CoverSettings, scale: number, quick: boolean, mask: Mask | null): BlobEntry {
    const bake = this.prepBlob(gItems, s, scale, quick, mask);
    while (!bake.step()) { /* 끝까지 */ }
    return bake.entry;
  }

  /** 굽기 준비 — 격자에 칠한 픽셀을 찍고(마스크 표본, 없으면 조각 사각형), 거리장으로 굵기를 재고, 줄 묶음마다 덮임 */
  private prepBlob(gItems: SteamItem[], s: CoverSettings, scale: number, quick: boolean, mask: Mask | null): BlobBake {
    // 영역의 화면 사각형 (양수 「범위」는 조각 크기에 이미 들어 있다 — 여기서는 원래 상자로 되돌린다)
    const ex = Math.max(0, s.expand) * scale;
    const boxes = gItems.map((it) => [it.cx - it.w / 2 + ex, it.cy - it.h / 2 + ex, it.cx + it.w / 2 - ex, it.cy + it.h / 2 - ex]);
    const rb = bboxOf(boxes);
    // 굵기를 먼저 대략 재어 격자 여유를 잡는다 — 조각 짧은 변의 최대의 반 (거리장으로 다시 잰다)
    let half = 0;
    for (const b of boxes) half = Math.max(half, Math.min(b[2] - b[0], b[3] - b[1]) / 2);
    half = Math.max(1, half);
    const k0 = cloudScale((2 * half) / scale);
    const pad = Math.ceil(regionReach(half, k0, ex));
    const x0 = rb.x0 - pad, y0 = rb.y0 - pad, W = rb.W + pad * 2, H = rb.H + pad * 2;
    const long = Math.max(W, H);
    const kg = Math.min(1, (quick ? STEAM_WORK_QUICK : STEAM_WORK) / long);
    const gw = Math.max(8, Math.round(W * kg));
    const gh = Math.max(8, Math.round(H * kg));
    const sx = gw / W, sy = gh / H;
    const entry: BlobEntry = { x0, y0, W, H, k: kg, gw, gh, sx, sy, cover: new Uint8Array(gw * gh), full: !quick };
    const v = methodIndex("steam");
    let cloud: RegionCloud | null = null;
    let row = 0;
    const ROWS = 16;
    return {
      entry, pieces: gItems.length,
      step: () => {
        if (!cloud) {
          // ① 격자에 영역을 찍는다 — 이 덩어리의 상자 안이면서 마스크가 켜진 자리 (다른 덩어리는 안 들어온다).
          //    마스크가 없으면(비상) 조각 사각형 그대로
          const inside = new Uint8Array(gw * gh);
          for (const b of boxes) {
            const gx0 = Math.max(0, Math.floor((b[0] - x0) * sx)), gx1 = Math.min(gw - 1, Math.ceil((b[2] - x0) * sx));
            const gy0 = Math.max(0, Math.floor((b[1] - y0) * sy)), gy1 = Math.min(gh - 1, Math.ceil((b[3] - y0) * sy));
            for (let gy = gy0; gy <= gy1; gy++) {
              const iy = mask ? Math.min(mask.h - 1, Math.max(0, Math.floor((y0 + (gy + 0.5) / sy) / scale))) : 0;
              for (let gx = gx0; gx <= gx1; gx++) {
                if (!mask) { inside[gy * gw + gx] = 1; continue; }
                const ix = Math.min(mask.w - 1, Math.max(0, Math.floor((x0 + (gx + 0.5) / sx) / scale)));
                if (mask.cells[iy * mask.w + ix] === v) inside[gy * gw + gx] = 1;
              }
            }
          }
          // ② 거리장·굵기·노이즈. 씨앗은 첫 조각의 것 (자라도 왼쪽 위 씨앗이라 그대로)
          cloud = prepRegion(inside, gw, gh, gItems[0].b.seed, s.feather, kg * scale, ex * kg, fadeStartOf(s.steamFade));
          return false;
        }
        // ③ 줄 묶음마다 덮임
        regionCoverRows(cloud, row, Math.min(gh, row + ROWS), entry.cover);
        row += ROWS;
        return row >= gh;
      },
    };
  }

  /** 덩어리 캔버스 한 장 — 쌓은 덮임을 깎고(음수 범위) 밝기·진하기를 입힌다. 덮임 배열은 그대로 두고 사본을 깎는다 */
  private composite(head: SteamItem, part: BlobEntry, s: CoverSettings, scale: number): SteamEntry {
    const { x0, y0, W, H, k, gw, gh } = part;
    let cover = part.cover;
    // ★음수 「범위」— 모은 덮임을 격자 단위로 깎는다 (화면 px → 격자 px 는 k)
    if (s.expand < 0) { cover = new Uint8Array(cover); erodeAlpha(cover, gw, gh, -s.expand * scale * k); }

    /* ★★**밝기 무늬는 덩어리 격자에서 한 번 만든다** (판마다가 아니라).
       판의 것을 쓰면 두 구름이 만나는 자리에서 무늬가 갈려 **각진 선**이 드러난다
       (2026-09-05 렌더 대조). v2 의 밝기는 230~255 의 좁은 흔들림이라, 어느 좌표에서
       만들든 구름의 성격은 같다 — 갈리지 않는 쪽이 낫다.
       ★계산은 v2 원문 그대로다 (3옥타브 · 0.5~1 로 압축). 파장만 격자 단위로 환산한다. */
    const lum = new Uint8Array(gw * gh);
    {
      const n = makeNoise(head.b.seed);
      const ff = 1 + Math.min(50, Math.max(0, s.feather)) / 25;
      const ns = (Math.max(gw, gh) / 2) * ff;
      for (let y = 0; y < gh; y++) {
        for (let x = 0; x < gw; x++) {
          const bn = n(x / ns, y / ns) + n((x / ns) * 2, (y / ns) * 2) * 0.5
            + n((x / ns) * 4, (y / ns) * 4) * 0.25;
          lum[y * gw + x] = Math.round((0.5 + ((bn / 1.75 + 1) / 2) * 0.5) * 255);
        }
      }
    }
    const cv = c2d(gw, gh);
    const g = cv.getContext("2d")!;
    const img = g.createImageData(gw, gh);
    img.data.set(plateRGBA({ cover, lum }, s.steamBright, s.steamAlpha));
    g.putImageData(img, 0, 0);
    return { cv, x: x0, y: y0, w: W, h: H, full: part.full };
  }

  /** 저장용 — **원본 크기**로 한 장 굽는다. 화면에 쓰는 것과 같은 `draw` 를 지난다 */
  async renderFull(scene: Scene, s: CoverSettings, type = "image/png"): Promise<Blob> {
    const cv = c2d(this.w, this.h);
    // ★저장은 화면 캐시와 섞이지 않게 제 렌더러로 돈다 (그릴 크기가 다르면 재료도 다르다)
    const one = new CensorRenderer(this.src, this.w, this.h);
    /* ★캐시를 물려주지 않는다 — 구름은 **그릴 크기에 매인 한 장**이라 화면용(축소)과
       저장용(원본 크기)이 다르다. 저장은 한 번뿐이라 다시 굽는 비용이 문제되지 않는다. */
    // ★저장은 **동기**로 — 뒤에서 굽는 길을 타면 저해상도가 저장된다
    one.draw(cv, scene, s, 1, true, false, true);
    return await new Promise<Blob>((ok, no) =>
      cv.toBlob((b) => (b ? ok(b) : no(new Error("캔버스를 굽지 못했습니다"))), type));
  }
}


