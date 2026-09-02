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
import { bucketAspect, marginOf, plate, plateRGBA, type Plate } from "./steam.ts";

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

const c2d = (w: number, h: number) => {
  const cv = document.createElement("canvas");
  cv.width = Math.max(1, Math.round(w));
  cv.height = Math.max(1, Math.round(h));
  return cv;
};

/** 그림 한 장에 딸린 렌더러. 재료 캐시를 들고 있으므로 **그림마다 하나** 만든다. */
export class CensorRenderer {
  private src: Src;
  /** 원본 픽셀 크기 */
  readonly w: number;
  readonly h: number;

  /** 재료 — 그림 전체를 덮은 한 장. 열쇠는 `방식|수치|그릴 크기` */
  private layers = new Map<string, HTMLCanvasElement>();
  /** 스팀 무늬 판 — 열쇠는 `씨앗|부드럽게|비율` */
  private plates = new Map<string, Plate>();
  /** 무늬 판을 밝기·진하기까지 입혀 캔버스로 구워 둔 것 */
  private plateCanvas = new Map<string, HTMLCanvasElement>();
  /** 매 프레임 새로 만들지 않으려고 들고 있는 석 장 (모양 · 여백을 두른 모양 · 오려낸 재료) */
  private maskCv: HTMLCanvasElement | null = null;
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
    this.plateCanvas.clear();
  }

  /** 무늬까지 버린다 (「부드럽게」가 바뀌었을 때) */
  invalidateAll() {
    this.invalidate();
    this.plates.clear();
  }

  /** 한 장을 그린다. `scale` 은 **원본 픽셀당 화면 픽셀**.
   *
   *  ★`withBase` 가 거짓이면 **덮개만** 그린다 (바탕은 투명). 화면에서는 원본을 `<img>` 로
   *    이미 깔아 두었으므로 그 위에 덮개만 얹으면 되고, 매 프레임 원본을 다시 그리지 않아도
   *    된다. 「들춰보기」도 이 캔버스의 CSS 투명도 하나로 끝난다.
   *  ★저장할 때만 참이다 — 그때는 한 장으로 합쳐야 한다. */
  draw(
    target: HTMLCanvasElement, boxes: RenderBox[], s: CoverSettings,
    scale: number, withBase = false,
  ) {
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
    if (!boxes.length) return;

    // ★방식이 섞여 있어도 **한 방식당 한 번**만 오려 붙인다 (박스마다 오리면 그만큼 느려진다)
    const groups = new Map<string, RenderBox[]>();
    for (const b of boxes) {
      const how = b.method || s.method;
      const at = groups.get(how);
      if (at) at.push(b);
      else groups.set(how, [b]);
    }

    for (const [how, list] of groups) {
      if (how === "steam") this.drawSteam(ctx, list, s, scale);
      else this.drawMasked(ctx, how, list, s, scale, W, H);
    }
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
      g.filter = `blur(${Math.max(1, s.blur * scale)}px)`;
      g.drawImage(this.src, 0, 0, W, H);
      g.filter = "none";
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

  /** 박스 하나의 사각형을 지금 좌표계에 그린다 (넓히기·회전 포함) */
  private path(g: CanvasRenderingContext2D, b: RenderBox, expand: number, scale: number) {
    const [x1, y1, x2, y2] = b.box;
    const cx = ((x1 + x2) / 2) * scale;
    const cy = ((y1 + y2) / 2) * scale;
    const w = (x2 - x1) * scale + expand * 2;
    const h = (y2 - y1) * scale + expand * 2;
    g.save();
    g.translate(cx, cy);
    if (b.rotation) g.rotate(b.rotation);
    g.beginPath();
    g.rect(-w / 2, -h / 2, w, h);
    g.restore();
  }

  private drawMasked(
    ctx: CanvasRenderingContext2D, how: string, list: RenderBox[],
    s: CoverSettings, scale: number, W: number, H: number,
  ) {
    const expand = s.expand * scale;
    const feather = s.feather * scale;
    /* ★★그림 가장자리에 붙은 박스가 **끝에서 옅어지던 결함** (유저 제보 2026-09-02: 흰색 검열이
       좌·우·상단 가장자리에서 제대로 안 됨). 캔버스 `blur` 필터는 캔버스 **밖을 투명**으로
       보므로, 마스크를 그림 크기 그대로 흐리면 그림 끝에서 feather 폭만큼 마스크가 빠지고
       그 자리의 덮개가 반투명이 된다 (실측: feather 10 에서 끝 픽셀의 원본 비침 46%).
       흰색만이 아니라 검정·색 지정·모자이크·흐리기가 전부 같은 마스크를 지난다.
       그래서 **여백(`m`)을 두른 판**에 마스크를 놓고, 그림 가장자리 픽셀을 여백으로 늘려
       깐 뒤(가장자리 복제 = 밖을 「끝과 같은 값」으로 본다) 흐린다. 그림 안쪽에서 끝나는
       변의 부드러움은 그대로다. 여백은 blur 반경(σ = feather/2)의 4배로, 그 밖의 투명이
       끝에 미치는 몫은 0.1% 미만이다. */
    const m = feather > 0 ? Math.ceil(feather * 2) : 0;
    const PW = W + m * 2;
    const PH = H + m * 2;
    if (!this.maskCv || this.maskCv.width !== W || this.maskCv.height !== H
        || !this.padCv || this.padCv.width !== PW || this.padCv.height !== PH) {
      this.maskCv = c2d(W, H);
      this.padCv = c2d(PW, PH);
      this.cutCv = c2d(PW, PH);
    }
    const mask = this.maskCv;
    const mg = mask.getContext("2d")!;
    mg.setTransform(1, 0, 0, 1, 0, 0);
    mg.clearRect(0, 0, W, H);

    /* ★★안쪽은 100% 로 남기고 **가장자리만** 부드럽게 한다. 그래서 흐리기 전에 테두리를
       `feather` 만큼 **넓힌다** (파이썬의 MaxFilter → GaussianBlur 과 같은 차례다).
       바로 흐리면 박스 안쪽까지 옅어져, 가려야 할 것이 비친다. */
    mg.fillStyle = "#fff";
    mg.strokeStyle = "#fff";
    mg.lineJoin = "round";
    mg.lineWidth = Math.max(0, feather);
    for (const b of list) {
      this.path(mg, b, expand, scale);
      mg.fill();
      if (feather > 0) mg.stroke();
    }

    // 여백을 두른 판 — 가운데에 마스크, 둘레에는 가장자리 한 줄을 늘려 깐다
    const pad = this.padCv!;
    const pg = pad.getContext("2d")!;
    pg.setTransform(1, 0, 0, 1, 0, 0);
    pg.clearRect(0, 0, PW, PH);
    pg.imageSmoothingEnabled = false;
    pg.drawImage(mask, m, m);
    if (m > 0) {
      pg.drawImage(mask, 0, 0, 1, H, 0, m, m, H);                 // 왼쪽 띠
      pg.drawImage(mask, W - 1, 0, 1, H, m + W, m, m, H);         // 오른쪽 띠
      pg.drawImage(mask, 0, 0, W, 1, m, 0, W, m);                 // 위 띠
      pg.drawImage(mask, 0, H - 1, W, 1, m, m + H, W, m);         // 아래 띠
      pg.drawImage(mask, 0, 0, 1, 1, 0, 0, m, m);                 // 네 모서리
      pg.drawImage(mask, W - 1, 0, 1, 1, m + W, 0, m, m);
      pg.drawImage(mask, 0, H - 1, 1, 1, 0, m + H, m, m);
      pg.drawImage(mask, W - 1, H - 1, 1, 1, m + W, m + H, m, m);
    }
    pg.imageSmoothingEnabled = true;

    const cut = this.cutCv!;
    const cg = cut.getContext("2d")!;
    cg.setTransform(1, 0, 0, 1, 0, 0);
    cg.clearRect(0, 0, PW, PH);
    cg.filter = feather > 0 ? `blur(${feather / 2}px)` : "none";
    cg.drawImage(pad, 0, 0);
    cg.filter = "none";
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

  private steamPlate(b: RenderBox, s: CoverSettings, scale: number) {
    const [x1, y1, x2, y2] = b.box;
    const w = (x2 - x1) * scale + s.expand * scale * 2;
    const h = (y2 - y1) * scale + s.expand * scale * 2;
    const aspect = bucketAspect(w, h);
    const pkey = `${b.seed}|${s.feather}|${aspect}`;
    let p = this.plates.get(pkey);
    if (!p) {
      p = plate({ seed: b.seed, feather: s.feather, aspect });
      this.plates.set(pkey, p);
    }
    const ckey = `${pkey}|${s.steamBright}|${s.steamAlpha}`;
    let cv = this.plateCanvas.get(ckey);
    if (!cv) {
      cv = c2d(p.pw, p.ph);
      const g = cv.getContext("2d")!;
      const img = g.createImageData(p.pw, p.ph);
      img.data.set(plateRGBA(p, s.steamBright, s.steamAlpha));
      g.putImageData(img, 0, 0);
      this.plateCanvas.set(ckey, cv);
    }
    return { p, cv, w, h };
  }

  private drawSteam(
    ctx: CanvasRenderingContext2D, list: RenderBox[], s: CoverSettings, scale: number,
  ) {
    for (const b of list) {
      const [x1, y1, x2, y2] = b.box;
      if (x2 <= x1 || y2 <= y1) continue;
      const { p, cv, w, h } = this.steamPlate(b, s, scale);
      // 판은 박스 짧은 변을 1 로 놓고 만들었다. 그 단위로 되돌려 그릴 크기를 셈한다
      const unit = Math.min(w, h);
      const dw = w + 2 * p.margin * unit;
      const dh = h + 2 * p.margin * unit;
      const cx = ((x1 + x2) / 2) * scale;
      const cy = ((y1 + y2) / 2) * scale;
      ctx.save();
      ctx.translate(cx, cy);
      if (b.rotation) ctx.rotate(b.rotation);
      ctx.drawImage(cv, -dw / 2, -dh / 2, dw, dh);
      ctx.restore();
    }
  }

  /** 저장용 — **원본 크기**로 한 장 굽는다. 화면에 쓰는 것과 같은 `draw` 를 지난다 */
  async renderFull(boxes: RenderBox[], s: CoverSettings, type = "image/png"): Promise<Blob> {
    const cv = c2d(this.w, this.h);
    // ★저장은 화면 캐시와 섞이지 않게 제 렌더러로 돈다 (그릴 크기가 다르면 재료도 다르다)
    const one = new CensorRenderer(this.src, this.w, this.h);
    one.plates = this.plates;   // 무늬는 크기와 무관하므로 그대로 쓴다
    one.draw(cv, boxes, s, 1, true);
    return await new Promise<Blob>((ok, no) =>
      cv.toBlob((b) => (b ? ok(b) : no(new Error("캔버스를 굽지 못했습니다"))), type));
  }
}

/** 「부드럽게」가 바뀌면 무늬까지 버려야 하는지 — 스토어가 이 표를 보고 고른다 */
export const NEEDS_PLATE_RESET = new Set(["feather"]);

void marginOf;
