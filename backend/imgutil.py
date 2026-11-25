"""이미지 입력 보조 — v2.x `backend.py:322-381` 이식.

★두 함수 다 **재인코딩을 최대한 피한다.** PIL 로 다시 구운 PNG 가 NAI 와 호환되지 않는
  경우가 있어서 v2 가 그렇게 만들었다. "어차피 PNG 로 통일하면 되지" 로 바꾸지 말 것.
"""
from __future__ import annotations

import base64
import io
import json
import math

from PIL import Image, ImageChops, ImageDraw, ImageFilter


def ensure_png_base64(b64: str, force_reencode: bool = False) -> str:
    """base64 이미지를 PNG 로 만든다 — **필요할 때만** 다시 굽는다.

    ★RGBA 를 RGB 로 눕히지 않는다. NAI API 가 RGBA 를 받고, vibe 인코딩 호환에도 필요하다
      (v2 backend.py:322 주석)."""
    data = base64.b64decode(b64)
    img = Image.open(io.BytesIO(data))

    if not force_reencode and img.format == "PNG" and img.mode in ("RGB", "RGBA"):
        return b64

    if img.mode not in ("RGB", "RGBA"):
        img = img.convert("RGB")
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return base64.b64encode(buf.getvalue()).decode("utf-8")


def binarize_mask(b64_mask: str, threshold: int = 1) -> str:
    """인페인트 마스크를 **순흑백**으로 만든다.

    ★NAI 는 순수 흑백만 받는다 — 회색 가장자리(안티앨리어싱)가 남으면 솔기가 생긴다.
    ★**이미 순흑백이면 원본을 그대로 돌려준다.** PIL 재인코딩이 NAI 와 호환 안 되는
      경우가 있어서다 (v2 backend.py:346 주석). 최적화가 아니라 호환성 조치다."""
    data = base64.b64decode(b64_mask)
    img = Image.open(io.BytesIO(data))

    if img.mode == "RGBA":
        values = set(img.split()[0].getdata())  # 흑백이면 R=G=B
    else:
        values = set(img.convert("L").getdata())

    if values <= {0, 255}:
        return b64_mask

    gray = img.convert("L")
    binary = gray.point(lambda x: 255 if x >= threshold else 0, mode="L")
    alpha = Image.new("L", binary.size, 255)
    out = Image.merge("RGBA", (binary, binary, binary, alpha))
    buf = io.BytesIO()
    out.save(buf, format="PNG")
    return base64.b64encode(buf.getvalue()).decode("utf-8")


def preprocess_base_image(b64_image: str, width: int, height: int) -> str:
    """베이스 그림을 **요청 해상도로 리샘플하고 흰 배경 위에 평탄화**한다 (공홈 `rX`).

    ★서버 리사이즈에 맡기지 말 것 — 필터가 다르면 **초기 latent 가 달라진다.**
      공홈은 pica 의 lanczos3 를 쓴다. PIL 의 LANCZOS 가 같은 계열이다.
    ★`docs/nai-web-reference.md` 1절의 공통 전송 구간이
      `image = await rX(image, transparent?"transparent":"white", height, width, false)` 로
      **모든** 베이스 이미지에 건다 — i2i·인페인트뿐 아니라 **Enhance 도** 지난다.
      6절의 "원본을 미리 확대하지 않는다"는 `generateEnhance` **함수 안**의 이야기이고,
      그 뒤 공통 구간이 목표 해상도로 키운다. 기능 함수만 읽고 옮기면 여기서 틀린다.
    ★투명 PNG 를 그대로 보내면 결과가 갈린다. 알파는 **흰색**에 깐다 —
      `convert("RGB")` 는 검정에 깔아서 다른 그림이 된다."""
    img = Image.open(io.BytesIO(base64.b64decode(b64_image)))
    if img.size != (width, height):
        img = img.resize((width, height), Image.LANCZOS)
    if img.mode in ("RGBA", "LA", "P"):
        img = img.convert("RGBA")
        canvas = Image.new("RGBA", img.size, (255, 255, 255, 255))
        canvas.alpha_composite(img)
        img = canvas.convert("RGB")
    elif img.mode != "RGB":
        img = img.convert("RGB")

    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return base64.b64encode(buf.getvalue()).decode("utf-8")


#: V5 Precise Reference 판 — 공홈 번들 `b2fe159` 의 표 그대로다 (`[w, h]`, 전부 1MP 안팎 · 64 배수)
REF_BUCKETS: list[tuple[int, int]] = [
    (256, 4096), (256, 4032), (256, 3968), (256, 3904), (256, 3840), (256, 3776), (256, 3712), (256, 3648),
    (256, 3584), (256, 3520), (256, 3456), (256, 3392), (256, 3328), (320, 3264), (320, 3200), (320, 3136),
    (320, 3072), (320, 3008), (320, 2944), (320, 2880), (320, 2816), (320, 2752), (384, 2688), (384, 2624),
    (384, 2560), (384, 2496), (384, 2432), (384, 2368), (448, 2304), (448, 2240), (448, 2176), (448, 2112),
    (512, 2048), (512, 1984), (512, 1920), (512, 1856), (576, 1792), (576, 1728), (576, 1664), (640, 1600),
    (640, 1536), (704, 1472), (704, 1408), (768, 1344), (768, 1280), (832, 1216), (896, 1152), (960, 1088),
    (1024, 1024), (1088, 960), (1152, 896), (1216, 832), (1280, 768), (1344, 768), (1408, 704), (1472, 704),
    (1536, 640), (1600, 640), (1664, 576), (1728, 576), (1792, 576), (1856, 512), (1920, 512), (1984, 512),
    (2048, 512), (2112, 448), (2176, 448), (2240, 448), (2304, 448), (2368, 384), (2432, 384), (2496, 384),
    (2560, 384), (2624, 384), (2688, 384), (2752, 320), (2816, 320), (2880, 320), (2944, 320), (3008, 320),
    (3072, 320), (3136, 320), (3200, 320), (3264, 320), (3328, 256), (3392, 256), (3456, 256), (3520, 256),
    (3584, 256), (3648, 256), (3712, 256), (3776, 256), (3840, 256), (3904, 256), (3968, 256), (4032, 256),
    (4096, 256),
]


def ref_bucket(w: int, h: int) -> dict:
    """그 크기의 그림이 갈 판과 덮어 맞출 크기 (공홈 `D.f` 를 그대로 옮겼다).

    ★판은 **로그 비율이 가장 가까운 것**이다. 같으면 앞선 판이 남는다 (`t<n`).
    ★덮어 맞춘다(cover). 짧은 쪽이 판에 닿게 키우고 넘친 쪽의 가운데를 자른다 — 레터박스가 아니다."""
    a = math.log(max(w, 1) / max(h, 1))
    bw, bh = REF_BUCKETS[0]
    best = abs(a - math.log(bw / bh))
    for x, y in REF_BUCKETS:
        d = abs(a - math.log(x / y))
        if d < best:
            bw, bh, best = x, y, d
    n = max(bw / w, bh / h)
    rw = max(math.floor(w * n + 0.5), bw)
    rh = max(math.floor(h * n + 0.5), bh)
    return {"width": bw, "height": bh, "resize": (rw, rh),
            "left": (rw - bw) // 2, "top": (rh - bh) // 2, "unchanged": (w, h) == (bw, bh)}


def _drop_stealth(img: Image.Image) -> Image.Image | None:
    """NAI 가 알파 LSB 에 심은 메타데이터를 지운 그림. 심긴 것이 없으면 None (공홈 `removeAlphaMetadata`).

    ★공홈은 레퍼런스를 보내기 전에 이것부터 한다 — 알파 254 는 255 로, 1 은 0 으로."""
    if img.mode != "RGBA":
        return None
    import numpy as np
    from meta import _stealth_bits, _stealth_sig

    px = np.array(img)
    if not _stealth_sig(_stealth_bits(px[:, :, 3])):
        return None
    a = px[:, :, 3]
    a[a == 254] = 255
    a[a == 1] = 0
    return Image.fromarray(px)


def _open_ref(b64: str) -> tuple[Image.Image, Image.Image | None]:
    """레퍼런스 그림을 연다. 둘째 값은 알파 메타데이터를 지운 그림이다 (없었으면 None)."""
    img = Image.open(io.BytesIO(base64.b64decode(b64)))
    if img.mode in ("LA", "P", "PA"):
        img = img.convert("RGBA")
    elif img.mode not in ("RGB", "RGBA"):
        img = img.convert("RGB")
    return img, _drop_stealth(img)


def bucket_reference(b64: str) -> str:
    """V5 Precise Reference 그림을 판에 맞춘다 (공홈 `bucketCharacterReferences` 갈래).

    ★공홈 순서 그대로다: 알파 메타데이터 지우기 → 판 고르기 → **lanczos3** 로 덮어 맞추기 → 가운데 자르기 → PNG.
      PIL 의 LANCZOS 가 같은 계열이다 (`preprocess_base_image` 와 같은 이유).
    ★크기가 이미 판과 같으면 다시 굽지 않는다 (NAI 가 내는 832×1216 이 그렇다)."""
    img, clean = _open_ref(b64)
    b = ref_bucket(*img.size)
    if b["unchanged"]:
        return _png_b64(clean) if clean is not None else b64
    out = (clean or img).resize(b["resize"], Image.LANCZOS)
    out = out.crop((b["left"], b["top"], b["left"] + b["width"], b["top"] + b["height"]))
    return _png_b64(out)


#: V4.5 Precise Reference 판 — 공홈 `validDirectorSizes` 그대로다. ★차례가 곧 비율 차가 같을 때의 우선순위다
REF_CANVASES: list[tuple[int, int]] = [(1024, 1536), (1536, 1024), (1472, 1472)]


def _js_round(x: float) -> int:
    """JS `Math.round` (.5 는 위로). 파이썬 `round` 는 짝수 쪽이라 한 픽셀씩 어긋난다"""
    return math.floor(x + 0.5)


def letterbox_reference(b64: str, transparent: bool = False) -> str:
    """V4.5 Precise Reference 그림을 세 판 중 하나에 얹는다 (공홈 `resizeCharacterReferences` 갈래).

    ★공홈 순서 그대로다: 알파 메타데이터 지우기 → 판 = 가로세로 비율의 **차가 가장 작은 것**(같으면 앞선 판) →
      판 안에 들어가게 **lanczos3** 로 줄이기 → 가운데에 얹기 → 남는 곳은 검정 (투명 배경 모델이면 투명) → PNG.
    ★예전에는 화면이 캔버스로 했다 (v2 `processPreciseReferenceImage`): 판을 가로·세로·정사각으로만 갈라
      거의 정사각인 세로 그림이 1024×1536 으로 갔고, 줄이는 방식도 달랐다. 공홈은 2026-10 부터 이것이다."""
    img, clean = _open_ref(b64)
    img = clean or img
    w, h = img.size
    n = w / h
    s, o = REF_CANVASES[0]
    for x, y in REF_CANVASES:
        if abs(x / y - n) < abs(s / o - n):
            s, o = x, y
    if n > s / o:
        c, hh = s, _js_round(s / n)
    else:
        c, hh = _js_round(o * n), o
    f = img if (c, hh) == (w, h) else img.resize((c, hh), Image.LANCZOS)
    canvas = Image.new("RGBA", (s, o), (0, 0, 0, 0))
    canvas.alpha_composite(f.convert("RGBA"), (_js_round((s - c) / 2), _js_round((o - hh) / 2)))
    if transparent:
        return _png_b64(canvas)
    bg = Image.new("RGBA", (s, o), (0, 0, 0, 255))
    bg.alpha_composite(canvas)
    return _png_b64(bg.convert("RGB"))


def blend_mask_8px(b64_mask: str, width: int, height: int) -> Image.Image:
    """인페인트 결과를 원본에 되붙일 때 쓰는 **소프트 마스크** (공홈 합성 파이프라인).

    1/8 마스크 → `dilate(반경 4)` → 8배 확대 → `blur(반경 20)` ×2.
    1/8 스케일의 반경 4 는 원본 기준 **약 32px 확장**이다.

    ★와이어로 보내는 마스크(`quantize_mask_8px`)와 **다른 물건**이다. 이건 로컬 합성 전용.
    ★공홈의 dilate/blur 워커 본체는 지연 로드 청크라 번들에 없다 — 반경 값과 순서만
      확인됐고 **커널 형태는 미확인**이다. 픽셀 단위로 같지는 않고 "경계 32px 을 부드럽게
      섞는다"가 같다. (`docs/nai-web-reference.md` 7절)"""
    mask = Image.open(io.BytesIO(base64.b64decode(b64_mask))).convert("L")
    if mask.size != (width, height):
        mask = mask.resize((width, height), Image.NEAREST)

    sw, sh = max(1, width // 8), max(1, height // 8)
    small = mask.resize((sw, sh), Image.NEAREST).point(lambda v: 255 if v >= 155 else 0, mode="L")
    # 칠한 영역 그대로 (와이어로 보내는 마스크와 같은 8px 격자)
    hard = small.resize((width, height), Image.NEAREST)
    # dilate 반경 4 = 9x9 최대값 필터 (1/8 스케일)
    small = small.filter(ImageFilter.MaxFilter(9))
    blend = small.resize((width, height), Image.NEAREST)
    for _ in range(2):
        blend = blend.filter(ImageFilter.GaussianBlur(20))
    # ★칠한 영역 **안**은 알파 255 로 고정한다 (2026-08-20, v2 유저 제보 "인페인트 흔적").
    #   PIL 의 GaussianBlur(radius) 는 radius 가 표준편차라 2회면 유효 시그마 약 28 이고,
    #   팽창 32px 과 맞먹어 칠한 경계 안쪽 알파가 194~222 까지만 올라갔다. 지운 것이
    #   최대 24% 비쳐 흔적으로 남는다 (가는 선·작은 점은 칠한 자리 전체가 평균 14~18%).
    #   전이 구간은 칠한 영역 **바깥**에만 있어야 한다. v2 수정: PeroPix 11b25ae
    blend = ImageChops.lighter(blend, hard)
    return blend


def composite_inpaint(result_png: bytes, sent_image_b64: str, b64_mask: str) -> bytes:
    """인페인트 결과를 **보낸 원본 위에** 소프트 마스크로 되붙인다.

    ★NAI 결과는 마스크 밖도 미세하게 달라진다. 그대로 저장하면 고치지 않은 자리가 바뀐다.
    ★원본은 **NAI 로 보낸 그 이미지**여야 한다 (`preprocess_base_image` 를 거친 것) —
      알파를 검정에 깐 것으로 합성하면 투명했던 자리가 검게 되돌아온다.
    ★이진 마스크로 자르면 경계에 계단·색단차가 남는다. 그래서 소프트 마스크다."""
    with Image.open(io.BytesIO(result_png)) as res:
        res.load()
        w, h = res.size
        original = Image.open(io.BytesIO(base64.b64decode(sent_image_b64))).convert("RGB")
        if original.size != (w, h):
            original = original.resize((w, h), Image.LANCZOS)
        out = Image.composite(res.convert("RGB"), original, blend_mask_8px(b64_mask, w, h))
        # ★원본 PNG 의 tEXt 청크(NAI 메타데이터)를 그대로 물려준다 — 다시 저장하면서
        #   잃으면 공홈이 자기 이미지로 인식하지 못하고 재생성도 안 된다
        info = res.info
    buf = io.BytesIO()
    out.save(buf, format="PNG", pnginfo=_pnginfo_of(info))
    return buf.getvalue()


def _pnginfo_of(info: dict):
    """PIL 로 다시 저장할 때 tEXt 청크를 넘겨주기 위한 그릇."""
    from PIL import PngImagePlugin

    meta = PngImagePlugin.PngInfo()
    for k, v in (info or {}).items():
        if isinstance(v, str):
            meta.add_text(k, v)
    return meta


def quantize_mask_8px(b64_mask: str, width: int, height: int) -> str:
    """인페인트 마스크를 **8px 격자**에 맞추고 요청 해상도로 되돌린다.

    정본은 `docs/nai-web-reference.md` 7절 (공홈 `generateInfill`):
      1/8 축소(**스무딩 없음**) → 임계 155 → 스무딩 없이 원래 크기로 복원 = 8px 블록.

    ★단순 이진화(`binarize_mask`)와 다른 물건이다. 공홈이 보내는 마스크는 **8px 블록**이라,
      우리가 1px 단위로 보내면 같은 마스크로도 다른 그림이 나온다.
    ★크기는 **정렬된 요청 해상도**로 맞춘다. 공홈은 마스크 리사이즈를 64 정렬보다 먼저 해서
      정렬로 크기가 바뀌면 마스크와 요청 해상도가 어긋나는데(공홈 쪽 결함), 우리는 정렬된
      크기로 만든다."""
    mask = Image.open(io.BytesIO(base64.b64decode(b64_mask))).convert("L")
    if mask.size != (width, height):
        mask = mask.resize((width, height), Image.NEAREST)

    small = mask.resize((max(1, width // 8), max(1, height // 8)), Image.NEAREST)
    small = small.point(lambda v: 255 if v >= 155 else 0, mode="L")
    mask = small.resize((width, height), Image.NEAREST)

    alpha = Image.new("L", mask.size, 255)
    out = Image.merge("RGBA", (mask, mask, mask, alpha))
    buf = io.BytesIO()
    out.save(buf, format="PNG")
    return base64.b64encode(buf.getvalue()).decode("utf-8")


#: 인페인트 타일 한 장의 상한 — 1024×1024. 공홈 Focused Inpainting 과 같은 한도이고,
#: Opus 무료 판정(`src/lib/anlas.ts`)도 이 값을 본다. 넘기면 아낄 것 없이 요금만 는다.
TILE_MAX_PX = 1_048_576


def fit_tile_rect(rect: dict, iw: int, ih: int) -> tuple[int, int, int, int]:
    """크롭 사각형을 **보낼 수 있는 형태**로 다듬는다 — 64 배수 · 그림 안 · 1MP 이하.

    ★화면이 준 값을 그대로 믿지 않는다. 요금이 걸린 값이고(1MP 를 넘으면 Opus 무료가
      깨진다), 64 배수가 아니면 NAI 가 거절한다.
    ★**중심을 지킨 채** 줄인다 — 마스크를 감싸라고 잡은 사각형이라 한쪽 모서리를 깎으면
      칠한 자리가 밖으로 밀려난다."""
    x, y, w, h = (int(rect.get(k, 0)) for k in ("x", "y", "w", "h"))
    cx, cy = x + w / 2, y + h / 2

    # 64 배수로 내린다 (올리면 상한을 넘길 수 있다). 그림보다 크면 그림에 맞춘다
    w = max(64, min(int(w) // 64 * 64, iw // 64 * 64 or 64))
    h = max(64, min(int(h) // 64 * 64, ih // 64 * 64 or 64))

    # 1MP 를 넘으면 **비율을 지킨 채** 64 배수 단위로 줄인다
    while w * h > TILE_MAX_PX and (w > 64 or h > 64):
        if w >= h and w > 64:
            w -= 64
        elif h > 64:
            h -= 64
        else:
            break

    x = int(round(cx - w / 2))
    y = int(round(cy - h / 2))
    # 그림 안으로 밀어 넣는다 (경계에 붙는다)
    x = max(0, min(x, iw - w))
    y = max(0, min(y, ih - h))
    return x, y, w, h


def fit_to_1mp(w: int, h: int) -> tuple[int, int]:
    """조각을 **1MP 에 맞춰 키운 요청 크기**. 비율을 지키고 64 배수로 맞춘다.

    ★Focused Inpainting 의 핵심이 이 한 줄이다: 잘라낸 조각을 **그 크기 그대로** 보내면
      작게 그려지고, 1MP 로 키워 보내면 같은 자리를 더 촘촘하게 그린다. 공홈이 하는 그대로다
      (`docs/nai-web-reference.md`: 요청 크기는 사각형 비율을 1,048,576px 에 맞춘 값).
    ★조각이 589,824px(768×768) 이하면 확대율이 반드시 4/3 을 넘는다. 화면이 사각형을
      그 크기로 묶는 이유다 (`src/lib/focused.ts`).
    ★**넓이가 먼저고 비율 오차에는 천장(6%)을 둔다.** 오차를 먼저 보면 확대가 사라진다.
      320×1408 은 그대로가 오차 0 이라 1등이 되어 ×1.0 이 나왔다 (실측 2026-08-13).
      화면 쪽 `fitToPixels` 와 **같은 규칙이어야 한다** (표시한 크기로 실제로 나가야 하므로)."""
    if w <= 0 or h <= 0:
        return max(64, w), max(64, h)
    ar = w / h
    best: tuple[int, float, int, int] | None = None   # (넓이, 오차, w, h). 넓이가 클수록 좋다
    loose: tuple[float, int, int] | None = None       # 천장을 못 넘으면 오차가 가장 작은 것
    for cw in range(64, 4097, 64):
        ch = max(64, round(cw / ar / 64) * 64)
        px = cw * ch
        if px > TILE_MAX_PX:
            continue
        err = abs(cw / ch - ar) / ar
        if loose is None or err < loose[0]:
            loose = (err, cw, ch)
        if err > 0.06:
            continue
        if best is None or (px, -err) > (best[0], -best[1]):
            best = (px, err, cw, ch)
    if best:
        return best[2], best[3]
    return (loose[1], loose[2]) if loose else (w, h)


def resize_png(png: bytes, w: int, h: int) -> bytes:
    """다 만든 그림을 다른 크기로. ★tEXt 청크를 물려준다 (`paste_tile` 과 같은 이유)."""
    with Image.open(io.BytesIO(png)) as im:
        im.load()
        info = im.info
        if im.size == (w, h):
            return png
        out = im.convert("RGB").resize((w, h), Image.LANCZOS)
    buf = io.BytesIO()
    out.save(buf, format="PNG", pnginfo=_pnginfo_of(info))
    return buf.getvalue()


def crop_to_base64(img: Image.Image, x: int, y: int, w: int, h: int) -> str:
    """타일을 잘라 PNG base64 로. ★마스크로 지우지 않은 **원본 픽셀 그대로** 보낸다."""
    tile = img.crop((x, y, x + w, y + h))
    if tile.mode not in ("RGB", "RGBA"):
        tile = tile.convert("RGB")
    buf = io.BytesIO()
    tile.save(buf, format="PNG")
    return base64.b64encode(buf.getvalue()).decode("utf-8")


def mask_has_white(b64_mask: str) -> bool:
    """마스크에 칠한 곳이 있나 — 타일 안이 비었으면 생성을 세운다.

    ★익스텐션은 사각형 밖에 칠한 마스크를 **조용히 버린다**(조사 문서 1절). 우리는 세운다."""
    with Image.open(io.BytesIO(base64.b64decode(b64_mask))) as m:
        return m.convert("L").getextrema()[1] >= 155


def paste_tile(
    src: Image.Image, tile_png: bytes, x: int, y: int, w: int | None = None, h: int | None = None
) -> bytes:
    """되그린 타일을 원본 좌표에 얹어 **원본 크기** PNG 를 만든다.

    ★해상도를 지키는 것이 이 기능의 전부다 — 원본은 손대지 않고 타일 자리만 갈아 끼운다.
    ★`w`·`h` 는 **원본에서 잘라낸 사각형의 크기**다. 조각은 1MP 로 키워 보내므로 돌아온
      타일이 그보다 크다. 되붙이기 전에 원래 크기로 되돌린다 (`fit_to_1mp`).
    ★NAI 응답의 tEXt 청크를 결과에 **옮겨 싣는다.** 잃으면 공홈이 자기 이미지로 인식하지
      못하고 우리 「설정까지」 재현도 깨진다 (`composite_inpaint` 와 같은 이유)."""
    with Image.open(io.BytesIO(tile_png)) as tile:
        tile.load()
        info = tile.info
        piece = tile.convert("RGB")
        if w and h and piece.size != (w, h):
            piece = piece.resize((w, h), Image.LANCZOS)
        out = src.convert("RGB").copy()
        out.paste(piece, (x, y))
    buf = io.BytesIO()
    out.save(buf, format="PNG", pnginfo=_pnginfo_of(info))
    return buf.getvalue()


def size_of_base64(b64: str) -> tuple[int, int]:
    """base64 이미지의 크기. 진단 로그용."""
    with Image.open(io.BytesIO(base64.b64decode(b64))) as img:
        return img.size


def preview_jpeg(raw: bytes, quality: int = 85, crop: tuple[float, float, float, float] | None = None) -> bytes:
    """**형식만 바꿔 가볍게 한다** — 그리는 중인 중간 그림을 앱으로 흘릴 때 쓴다
    (`server.py` 의 `image_step`, 사용자 지시 2026-08-26).

    ★★**해상도는 그대로 둔다** (사용자 지시 2026-08-26: *"해상도는 줄이지 마. 형식만 jpg 나
      webp 같은 걸로 바꿔서 용량만 낮춰"*). 한때 768px 로 줄였는데, 큰 자리에 띄우면 그만큼
      흐리게 보인다 — 무엇이 그려지고 있는지 보려는 것이 목적이라 흐리면 목적을 못 채운다.
    ★줄이는 이유는 **고르게 흐르게** 하기 위해서다. NAI 가 주는 중간 그림은 완성본과 같은
      PNG 라 base64 로 부풀리면 한 장이 수백 KB~수 MB 다. 한 프레임을 실어 보내는 데만
      수백 ms 가 들어 프레임이 밀렸다가 몰려 나왔다 (사용자 지적: *"중간 스텝을 삭제하고
      보여 주는 것처럼 잠깐 멈춰 있다가 갑자기 확 오른다"*).
    ★★**JPEG 이다** — 같은 크기에서 WebP 가 3배 더 작지만 굽는 데 9~45배가 걸린다
      (실측 1024², b64 기준: JPEG q85 40KB·2ms / WebP q80 12KB·18~97ms). 여기서 아껴야 하는
      것은 **한 프레임에 드는 시간**이라 작은 쪽이 아니라 빠른 쪽을 고른다.
    ★품질을 아끼는 자리다 — **보고 버리는 그림**이라 원본에 손대지 않는다 (완성본은 그대로 PNG).
    ★`crop` 은 **비율로 적은 자리** `(x0, y0, x1, y1)` 다. 인퍼런스는 결과 칸만 흘린다 (`server._inference_of`).
      중간 그림의 크기가 요청 크기와 다를 수 있어 픽셀로 받지 않는다.
    """
    with Image.open(io.BytesIO(raw)) as im:
        im.load()
        out = im.convert("RGB")
    if crop:
        w, h = out.size
        out = out.crop((round(crop[0] * w), round(crop[1] * h), round(crop[2] * w), round(crop[3] * h)))
    buf = io.BytesIO()
    out.save(buf, format="JPEG", quality=quality)
    return buf.getvalue()


def _png_b64(img: Image.Image) -> str:
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return base64.b64encode(buf.getvalue()).decode("utf-8")


def inference_canvas(ref_b64: str, canvas: tuple[int, int], ref: tuple[int, int, int, int],
                     keep: tuple[int, int, int, int]) -> tuple[str, str]:
    """인퍼런스의 캔버스와 마스크 (설계 `docs/inference-design.md` 4번).

    ★배치는 **화면이 정한 숫자 그대로**다 (`src/lib/inference.ts` 의 `planFor`). 여기서 다시 계산하면
      요금·결과 크기 표시와 실제가 갈린다.
    ★흰 바탕에 참조를 `ref` 자리로 줄여 붙이고, `keep`(참조 칸 전체, 옆 여백 포함)만 검게 칠한 마스크를 만든다.
      흰 곳이 다시 그려진다. 테두리는 두르지 않는다 (두르면 결과에 검은 틀이 따라 그려진다, 6-2).
    ★투명한 참조는 **흰 바탕에 눕힌다.** 캔버스가 흰 바탕이라 검게 깔리면 칸 경계가 생긴다."""
    W, H = canvas
    with Image.open(io.BytesIO(base64.b64decode(ref_b64))) as src:
        src.load()
        im = src.convert("RGBA")
    flat = Image.new("RGB", im.size, "white")
    flat.paste(im, mask=im.getchannel("A"))
    x, y, w, h = ref
    out = Image.new("RGB", (W, H), "white")
    out.paste(flat.resize((w, h), Image.LANCZOS), (x, y))
    mask = Image.new("RGB", (W, H), "white")
    kx, ky, kw, kh = keep
    ImageDraw.Draw(mask).rectangle([kx, ky, kx + kw - 1, ky + kh - 1], fill="black")
    return _png_b64(out), _png_b64(mask)


def crop_png(png: bytes, x: int, y: int, w: int, h: int) -> bytes:
    """다 만든 그림에서 한 자리만 잘라 낸다 (인퍼런스의 결과 칸).

    ★tEXt 청크를 물려준다 (`paste_tile` 과 같은 이유). 그리고 NAI 메타데이터(`Comment`)의 `width`·`height` 를
      **잘라 낸 크기**로 고친다. 그대로 두면 그림과 적힌 크기가 달라 다른 도구가 잘못 읽는다."""
    with Image.open(io.BytesIO(png)) as im:
        im.load()
        info = dict(im.info)
        out = im.crop((x, y, x + w, y + h))
        if out.mode not in ("RGB", "RGBA"):
            out = out.convert("RGB")
    c = info.get("Comment")
    if isinstance(c, str):
        try:
            d = json.loads(c)
        except ValueError:
            d = None
        if isinstance(d, dict):
            d["width"], d["height"] = w, h
            info["Comment"] = json.dumps(d, ensure_ascii=False)
    buf = io.BytesIO()
    out.save(buf, format="PNG", pnginfo=_pnginfo_of(info))
    return buf.getvalue()
