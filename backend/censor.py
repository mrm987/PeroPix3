"""검열 — 가릴 곳을 찾아 가린다 (8단계).

★**ONNX 로 바꿔 통째로 번들한다** (사용자 결정 2026-08-05).
  v2 는 ultralytics(`.pt`)로 돌렸고, 그 때문에 **torch 4.4GB** 가 딸려 왔다 (v2 번들 파이썬 실측).
  그래서 v2 는 "처음 켤 때 설치"를 골랐고, 첫 검열마다 수 GB 설치를 기다려야 했다.
  ONNX 로 내보내면 실행기가 `onnxruntime` 하나로 줄어, 모델 39MB 를 앱에 넣어도 부담이 없다.
  → 다운로드 경로·설치 실패 지점·HF 파일 크기 하드코딩이 **통째로 사라진다.**

★**박스만 쓴다.** 모델은 세그멘테이션(`-segm`)이지만 v2 도 마스크를 한 번도 안 봤다
  (`result.masks` 참조 0회). 그래서 mask 계수 32개는 그냥 버린다.
  ★★한 번 살려 봤다가 **걷었다** (2026-08-21). 마스크 프로토타입은 **입력의 1/4** 해상도라,
    1608px 그림에서 마스크 1픽셀이 원본 6.3픽셀이다 (91px 부위 → 윤곽 16픽셀).
    그 자리만 잘라 다시 보는 방법으로 3배까지 올려 봤지만 절반은 재탐지가 실패했고,
    사용자 판정은 *"제대로된 sam 모델보다 훨씬 거칠음"* 이었다.
    ★되살리지 말 것 — 그 바닥은 구조에서 오는 것이라 이 모델로는 못 넘는다.
      필요하면 **프롬프트로 도는 모델**(SAM 계열)을 따로 들인다.

★**cv2 를 쓰지 않는다** (109MB). numpy 로 레터박스와 NMS 를 직접 짠다.

★**가리는 일은 여기 없다** (2026-08-23). 화면이 캔버스로 그린다 — 아래 「가리기는 여기 없다」 절 참조.

★**imgsz 를 모델에서 읽는다 (여기 640 을 박지 말 것).** 이 모델은 **1024** 로 학습·추론된다
  (`m.overrides['imgsz']`). ultralytics 는 `.pt` 를 부를 때 그 값을 그대로 쓰므로 v2 는 내내
  1024 로 돌고 있었다. 640 으로 내보내면 같은 골든 16장에서 **탐지가 40→36 으로 준다**
  (실측 2026-08-05). 검열에서 탐지 감소는 곧 놓침이라 행동 퇴행이다.

★**모델은 둘**이고 **출력 형식이 다르다.**

    기본 ntd11 (40MB · 1024px)   YOLO11s-seg  — 우리가 NMS 를 돌린다
    고급 XL    (251MB · 1280px)  YOLO26x-seg  — **모델이 이미 NMS 를 했다**(end2end)

  end2end 는 (300, 4+1+1+32) 로 **걸러진 결과**를 낸다. 여기서 NMS 를 또 돌리면 안 된다.
  둘을 가르는 것은 코드가 아니라 **모델 메타데이터**(`end2end`)다. 클래스 이름도 서로 다르다.
  기본은 **가벼운 쪽**이다 — 무거운 쪽이 기본이면 첫 검열이 10배 느려진다.

정확도의 정본은 `.pt` 다 (feature-inventory.md 가 정한 분업: 검증은 torch, 배포는 ONNX).
`test_censor_golden.py` 가 골든 16장으로 대조한다 (2026-08-05):

    기본 — 덮음 40/40 · IoU 0.9975 · 0.3px · conf 0.001 · CPU 0.4초/장
    XL   — 덮음 56/56 · IoU 0.9956 · 0.2px · conf 0.016 · CPU 4.0초/장

문서가 세운 기준(기본 36/36 · 0.981 / XL 48/50)보다 둘 다 낫다.
"""
from __future__ import annotations

import ast
import threading
from functools import lru_cache
from pathlib import Path

import numpy as np
from PIL import Image

MODEL_DIR = Path(__file__).resolve().parent.parent / "models" / "censor"
# ★ultralytics predict 의 기본값. 바꾸면 v2 와 결과가 달라진다 (cfg/default.yaml:54)
IOU_THRES = 0.7
MAX_DET = 300
MAX_NMS = 30000
MAX_WH = 7680
PAD_VALUE = 114  # LetterBox 기본 채움색


def models() -> list[dict]:
    """번들된 모델 목록. ★다운로드 항목이 없다 — 전부 앱에 들어 있다.

    ★**가벼운 것부터** 낸다 (첫 줄이 기본). 이름순으로 두면 무거운 XL 이 기본이 되어
      첫 검열이 몇 배 느려진다. 크기는 곧 무게라 따로 표를 두지 않아도 순서가 유지된다."""
    out = []
    for p in sorted(MODEL_DIR.glob("*.onnx"), key=lambda f: f.stat().st_size):
        error = None
        try:
            # ★세션 생성은 잠그고 한다 (`_RUN` 의 ★주) — 서버가 뜰 때 `warm()` 이 뒤에서 같은 모델을 열고 있을 수 있다
            with _RUN:
                _, names, size, _, _ = _load(p.name)
        except Exception as e:  # noqa: BLE001 — 무엇이든 화면에 그대로 올린다
            # ★★**못 연 이유를 올려 보낸다** (유저 제보 2026-10-28: 찾을 것 목록이 빈 채로 「찾을 것을 하나 이상
            #   고르세요」만 나오고 영영 그대로였다). 예전에는 여기서 삼켜 빈 목록만 갔고 화면은 아무 말도 못 했다.
            #   실제로 본 것: VC++ 런타임(msvcp140)이 없는 윈도우에서 `import onnxruntime` 이 DLL 을 못 찾는다
            names, size, error = {}, (0, 0), f"{type(e).__name__}: {e}"
        out.append(
            {
                "id": p.stem,
                "file": p.name,
                "classes": list(names.values()),
                "bytes": p.stat().st_size,
                "imgsz": size[0],
                "error": error,
            }
        )
    return out


#: ★쓸 수 있으면 **GPU 부터** (사용자 지적 2026-08-21: *"장당 5초씩 걸리면"*).
#  그때까지 `CPUExecutionProvider` 를 박아 두고 있어서, RTX 4080 이 있는 기계에서도
#  XL(251MB·1280px)이 **4.8초/장**이었다. v2 가 훨씬 빨랐던 것도 같은 까닭이다 —
#  그쪽은 torch 로 돌아 GPU 를 썼다.
#  ★차례가 곧 우선순위다. 없는 것은 조용히 건너뛴다 (설치된 실행기만 남긴다).
#  ★CPU 는 **언제나 마지막에 남긴다** — GPU 가 없는 기계에서도 돌아야 한다.
PREFER = ("CUDAExecutionProvider", "DmlExecutionProvider", "CPUExecutionProvider")


def _providers(ort) -> list[str]:
    have = set(ort.get_available_providers())
    return [p for p in PREFER if p in have] or ["CPUExecutionProvider"]


#: ★★**추론은 한 번에 하나씩** (실측 2026-08-23).
#  FastAPI 는 `def` 엔드포인트를 스레드풀에서 돌리므로 탐지 요청이 겹칠 수 있는데
#  (그림을 고르자마자 「전체 검열」을 누르거나, 좌우로 빨리 넘길 때가 그렇다),
#  같은 `InferenceSession` 을 두 스레드가 동시에 `run` 하면 **프로세스가 통째로 죽는다.**
#  파이썬 예외가 아니라 네이티브 크래시라 로그에 아무것도 안 남고, 화면에는
#  「엔진을 깨우는 중…」만 뜬 채로 멈춘다 — 원인을 찾기 대단히 어려운 종류다.
#  ★재현: 같은 그림에 detect 를 세 갈래로 동시에 던지면 세 요청이 전부 끊긴다.
#  ★세션을 만드는 것도 함께 잠근다 — 두 스레드가 같은 모델을 동시에 열면 같은 자리에 걸린다.
_RUN = threading.Lock()


@lru_cache(maxsize=2)
def _load(file: str):
    """세션과 클래스 이름. ★이름은 **모델이 들고 있다** — 코드에 박아 두면 모델을 바꿀 때 어긋난다."""
    import onnxruntime as ort

    p = MODEL_DIR / file
    if not p.exists():
        raise FileNotFoundError(f"검열 모델이 없습니다: {p}")
    so = ort.SessionOptions()
    so.log_severity_level = 3
    sess = ort.InferenceSession(str(p), so, providers=_providers(ort))
    meta = sess.get_modelmeta().custom_metadata_map or {}
    names = ast.literal_eval(meta.get("names", "{}"))
    names = {int(k): str(v) for k, v in names.items()}
    shape = sess.get_inputs()[0].shape  # [1, 3, H, W] — 동적이면 H·W 가 문자열이다
    fixed = isinstance(shape[2], int) and isinstance(shape[3], int)
    # ★크기도 **모델이 들고 있다**. 640 을 박아 두면 1024·1280 모델에서 탐지를 놓친다
    size = (int(shape[2]), int(shape[3])) if fixed else (int(meta.get("imgsz", "[640, 640]").strip("[] ").split(",")[0]),) * 2
    # ★YOLO26(XL)은 **NMS 를 모델이 이미 한다**(end2end). 출력 모양이 통째로 다르다
    e2e = str(meta.get("end2end", "")).lower() == "true"
    return sess, names, size, not fixed, e2e


def warm() -> None:
    """서버가 뜰 때 **뒤에서** 모델을 미리 올리고 한 번 돌려 둔다 (사용자 지시 2026-09-06: *"검열 모델은
    앱 열때 미리 로드해놔야할듯"*).

    ★★검열 모드에 처음 들어가면 화면이 한동안 안 켜졌다. 모델 목록 요청이 번들된 모델 **전부**의 세션을
      만드는데(클래스 이름이 모델 안에 있다), 그 요청이 `async def` 라 이벤트 루프 위에서 돌아 파일 트리·
      썸네일까지 **모든 요청이 그동안 멈췄다.** 목록 요청은 `def` 로 옮겼고(스레드풀), 여기서 미리 올려
      두면 들어갈 때 기다릴 것이 없다.
    ★첫 추론도 함께 돌린다 — DirectML 은 첫 `run` 에 셰이더를 굽느라 **1.4초**가 더 든다 (실측
      2026-09-06: 첫 1.43s → 다음 0.14s). 작은 그림 한 장이면 된다 — 레터박스가 모델 크기로 늘린다.
    ★실패해도 조용히 넘긴다 — `onnxruntime` 이 없는 얇은 파이썬에서도 서버는 떠야 한다. 필요할 때
      실제 요청이 같은 오류를 다시 만나 화면에 알린다."""
    dummy = Image.new("RGB", (64, 64), (128, 128, 128))
    for p in sorted(MODEL_DIR.glob("*.onnx"), key=lambda f: f.stat().st_size):
        try:
            detect(dummy, p.name, None, {}, 0.25, False)
        except Exception:
            pass


def default_model() -> str:
    """★기본은 **가벼운 쪽**이다 (models() 주석 참조)."""
    got = sorted(MODEL_DIR.glob("*.onnx"), key=lambda f: f.stat().st_size)
    if not got:
        raise FileNotFoundError("번들된 검열 모델이 없습니다 (models/censor/*.onnx)")
    return got[0].name


def _resize_linear(a: np.ndarray, nw: int, nh: int) -> np.ndarray:
    """cv2 `INTER_LINEAR` 과 **같은 방식**으로 줄인다.

    ★PIL 의 `resize(BILINEAR)` 를 쓰면 안 된다 — 축소할 때 필터 폭을 배율만큼 넓혀
      **안티에일리어싱**을 건다. cv2 는 걸지 않는다. 그 차이만으로 검출이 달라졌다
      (실측 2026-08-05: IoU 0.95 · conf 차 0.075 · 검출 개수까지 어긋남).
      cv2 의 좌표 대응은 `src = (dst + 0.5) * 배율 - 0.5`, 가장자리는 복제다."""
    h, w = a.shape[:2]
    if (w, h) == (nw, nh):
        return a.astype(np.float32)
    src = a.astype(np.float32)
    y = (np.arange(nh, dtype=np.float32) + 0.5) * (h / nh) - 0.5
    x = (np.arange(nw, dtype=np.float32) + 0.5) * (w / nw) - 0.5
    y0 = np.floor(y).astype(np.int32)
    x0 = np.floor(x).astype(np.int32)
    wy = (y - y0)[:, None, None]
    wx = (x - x0)[None, :, None]
    y0c, y1c = np.clip(y0, 0, h - 1), np.clip(y0 + 1, 0, h - 1)
    x0c, x1c = np.clip(x0, 0, w - 1), np.clip(x0 + 1, 0, w - 1)
    top = src[y0c][:, x0c] * (1 - wx) + src[y0c][:, x1c] * wx
    bot = src[y1c][:, x0c] * (1 - wx) + src[y1c][:, x1c] * wx
    # ★**8비트로 반올림해서 돌려준다** — cv2 는 uint8 배열을 낸다. 실수로 두면 픽셀마다
    #   1 미만의 차가 남고, 문턱 근처의 검출에서 confidence 가 0.026 까지 흔들렸다
    #   (실측 2026-08-05: 0.530 vs 0.504). 반올림하니 소수점까지 같아졌다.
    return np.round(top * (1 - wy) + bot * wy)


def _letterbox(im: Image.Image, size: tuple[int, int], rect: bool):
    """ultralytics `LetterBox(scaleup=True, center=True)` 그대로.

    ★`rect` 는 ultralytics 의 `auto` 다 — 정사각으로 채우지 않고 **32의 배수까지만** 채운다.
      832×1216 을 640 으로 줄이면 640×448 이 되어, 정사각(640×640)보다 여백이 훨씬 적다.
      여백이 적으면 대상이 더 크게 들어가 검출이 는다 — v2(.pt)가 하던 방식이고,
      실측에서 정사각 고정은 v2 가 찾던 것을 놓쳤다 (8장 중 2장).
    ★비율을 유지한 채 가운데 놓고 남는 곳을 114 로 채운다. 여기를 틀리면 좌표가 통째로 밀린다."""
    h0, w0 = im.height, im.width
    r = min(size[0] / h0, size[1] / w0)
    nw, nh = round(w0 * r), round(h0 * r)
    dw, dh = size[1] - nw, size[0] - nh
    if rect:
        dw, dh = dw % 32, dh % 32
    dw, dh = dw / 2, dh / 2
    resized = _resize_linear(np.asarray(im, dtype=np.uint8), nw, nh)
    left, top = int(round(dw - 0.1)), int(round(dh - 0.1))
    right, bottom = int(round(dw + 0.1)), int(round(dh + 0.1))
    canvas = np.full((nh + top + bottom, nw + left + right, 3), PAD_VALUE, dtype=np.float32)
    canvas[top : top + nh, left : left + nw] = resized
    return canvas, r, (left, top)


def _nms(boxes: np.ndarray, scores: np.ndarray, iou: float) -> list[int]:
    """표준 NMS. ★클래스별로 나누는 것은 부르는 쪽에서 좌표를 밀어 처리한다 (ultralytics 방식)."""
    x1, y1, x2, y2 = boxes[:, 0], boxes[:, 1], boxes[:, 2], boxes[:, 3]
    areas = (x2 - x1) * (y2 - y1)
    order = scores.argsort()[::-1]
    keep = []
    while order.size:
        i = order[0]
        keep.append(int(i))
        if order.size == 1:
            break
        xx1 = np.maximum(x1[i], x1[order[1:]])
        yy1 = np.maximum(y1[i], y1[order[1:]])
        xx2 = np.minimum(x2[i], x2[order[1:]])
        yy2 = np.minimum(y2[i], y2[order[1:]])
        inter = np.clip(xx2 - xx1, 0, None) * np.clip(yy2 - yy1, 0, None)
        ovr = inter / (areas[i] + areas[order[1:]] - inter)
        order = order[1:][ovr <= iou]
    return keep


def flatten_white(img: Image.Image) -> Image.Image:
    """탐지 입력용 RGB — 투명 그림은 **흰 바탕에 깐다**.

    ★`convert("RGB")` 는 알파만 떼어, 알파 0 픽셀의 RGB 쓰레기 값이 그대로 탐지기에 들어간다
      (사용자 지적 2026-09-06, `tools.thumb_image` 의 ★★주). 생성 쪽(`imgutil`)이 베이스 그림에
      하는 것과 같은 규칙이다."""
    if img.mode in ("RGBA", "LA") or (img.mode == "P" and "transparency" in img.info):
        rgba = img.convert("RGBA")
        canvas = Image.new("RGBA", rgba.size, (255, 255, 255, 255))
        canvas.alpha_composite(rgba)
        return canvas.convert("RGB")
    return img.convert("RGB")


def detect(
    img: Image.Image,
    model: str | None = None,
    targets: list[str] | None = None,
    label_conf: dict[str, float] | None = None,
    default_conf: float = 0.25,
    return_all: bool = False,
) -> list[dict]:
    """가릴 곳 찾기 — v2 `detect_nsfw_regions` 와 같은 계약.

    `return_all` 이면 문턱을 0.01 까지 낮춰 **문턱 미달까지** 돌려준다 (화면이 슬라이더로
    다시 거를 수 있게). 그때 `passes_threshold` 로 통과 여부를 함께 표시한다."""
    with _RUN:
        sess, names, size, rect, e2e = _load(model or default_model())
    label_conf = label_conf or {}
    labels = list(names.values())
    targets = targets if targets is not None else labels
    min_conf = 0.01 if return_all else min([label_conf.get(x, default_conf) for x in targets] + [default_conf])

    im = flatten_white(img)
    canvas, r, (padx, pady) = _letterbox(im, size, rect)
    x = canvas.transpose(2, 0, 1)[None] / 255.0
    # ★★한 번에 하나씩 (`_RUN` 의 ★★주). 겹쳐 돌리면 프로세스가 죽는다
    with _RUN:
        out = sess.run(None, {sess.get_inputs()[0].name: np.ascontiguousarray(x, dtype=np.float32)})[0]

    if e2e:
        # ★YOLO26 은 **이미 걸러진 결과**를 낸다: (1, 300, 4+1+1+32) = xyxy · conf · cls · 마스크.
        #   여기서 NMS 를 또 돌리면 안 된다 (ultralytics 도 end2end 면 문턱만 건다).
        pred = out[0]  # (300, 4+1+1+32) — 배치 축은 위에서 이미 벗겼다
        boxes, conf, cls = pred[:, :4].copy(), pred[:, 4], pred[:, 5].astype(np.int32)
        m = conf > min_conf
        boxes, conf, cls = boxes[m], conf[m], cls[m]
        if not len(boxes):
            return []
        keep = list(range(min(len(boxes), MAX_DET)))
    else:
        # (1, 4+nc+32, N) → (N, 4+nc+32). ★뒤의 마스크 계수 32 개는 안 쓴다
        pred = out[0].T
        nc = len(names)
        xywh, scores = pred[:, :4], pred[:, 4 : 4 + nc]
        cls = scores.argmax(1)
        conf = scores.max(1)
        m = conf > min_conf
        xywh, cls, conf = xywh[m], cls[m], conf[m]
        if not len(xywh):
            return []
        if len(xywh) > MAX_NMS:
            top = conf.argsort()[::-1][:MAX_NMS]
            xywh, cls, conf = xywh[top], cls[top], conf[top]

        boxes = np.empty_like(xywh)
        boxes[:, 0] = xywh[:, 0] - xywh[:, 2] / 2
        boxes[:, 1] = xywh[:, 1] - xywh[:, 3] / 2
        boxes[:, 2] = xywh[:, 0] + xywh[:, 2] / 2
        boxes[:, 3] = xywh[:, 1] + xywh[:, 3] / 2
        # ★클래스마다 따로 억제한다 — 좌표를 클래스 번호만큼 밀어 한 번에 처리 (ultralytics max_wh)
        keep = _nms(boxes + (cls[:, None] * MAX_WH), conf, IOU_THRES)[:MAX_DET]

    # 레터박스를 되돌린다 (여백 빼고 배율 나누고, 그림 밖은 잘라낸다)
    dets = []
    for i in keep:
        b = boxes[i]
        x1 = (b[0] - padx) / r
        y1 = (b[1] - pady) / r
        x2 = (b[2] - padx) / r
        y2 = (b[3] - pady) / r
        label = names[int(cls[i])]
        if label not in targets:
            continue
        need = label_conf.get(label, default_conf)
        ok = float(conf[i]) >= need
        if not return_all and not ok:
            continue
        dets.append(
            {
                "label": label,
                "confidence": round(float(conf[i]), 3),
                # ★반올림이 아니라 **버림**이다 (v2 `int(x)`, backend.py:6924).
                #   반올림하면 박스가 한 픽셀씩 밀려 v2 결과와 어긋난다 (실측 2026-08-05).
                "box": [
                    int(max(0, min(im.width, x1))),
                    int(max(0, min(im.height, y1))),
                    int(max(0, min(im.width, x2))),
                    int(max(0, min(im.height, y2))),
                ],
                "passes_threshold": ok,
            }
        )
    return dets


# ── 가리기는 **여기 없다** ──────────────────────────────────────
#
# ★★사용자 결정 2026-08-23: 가리는 일을 **화면(캔버스)으로 옮겼다** (`src/lib/censorRender.ts`).
#   서버가 그리면 박스를 1px 옮길 때마다 왕복이 걸려, 사람 손이 움직이는 속도를 원리상
#   못 따라온다 (실측: 스팀 219ms + PNG 인코딩 58ms = 초당 3~4장).
#   ★렌더러는 **한 벌뿐이다.** 저장도 화면이 원본 크기로 구운 것을 올리고, 서버는 그 바이트를
#     받아 적기만 한다 (`/api/censor/apply`). v2 가 겪은 「미리보기와 저장본이 갈린다」는
#     두 벌을 뒀기 때문이지 화면에서 그렸기 때문이 아니다.
#   ★여기 있던 것(apply_boxes·스팀 심플렉스 노이즈·마스크·모자이크)은 **되살리지 말 것.**
#     되살리면 그 순간 두 벌이 된다.
#
# 서버에 남은 검열 일은 **탐지 하나**다 (`detect`). 모델 39~251MB 를 웹뷰에서 못 돌리므로
# 이것만은 서버여야 한다.
