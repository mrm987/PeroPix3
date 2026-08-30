"""생성 이미지의 메타데이터 — 읽기 · 정규화 · 쓰기 · 제거.

★**진실은 이미지 메타데이터에 있다** (feature-inventory K절). 폴더 구조를 상태의 정본으로
  삼지 않으므로, 사용자가 탐색기에서 파일을 옮기거나 이름을 고쳐도 갤러리·재현이 깨지지 않는다.

★이 파일은 **v2(`d:\\PeroPix\\backend.py` · `index.html`)의 이식**이다. 재구현이 아니다.
  아래 셋은 v2 에서 시행착오로 굳은 코드라 **동작을 바꾸지 말 것** (docs/v2-port-plan.md):

    1. `read_raw` 의 **6단계 폴백 순서** — 순서 자체가 규칙이다. Comment 가 있으면 EXIF 를
       안 보고, stealth 는 앞이 전부 실패했을 때만 본다 (opaque 이미지에서 헛돌지 않게).
    2. `normalize` 의 **퀄리티 태그 제거 패턴** — 어긋나면 Apply 할 때마다 태그가 중복 누적된다.
       V4.5 패턴이 Enhance 용·일반용 **두 가지**다.
    3. `strip` 의 **알파 LSB 처리** — NAI 는 스테가노그래피로 메타데이터를 한 벌 더 심는다.
       tEXt 만 지우면 남는다. 단 실제 투명도가 있는 그림은 건드리면 안 된다.

원본 위치: read_raw ← backend.py:629-784 · normalize ← index.html:17422-17668 ·
           write ← backend.py:509-582 · strip ← backend.py:2794-2821
"""
from __future__ import annotations

import gzip
import io
import json
from pathlib import Path

import nai
import naitext

import piexif
import piexif.helper
from PIL import Image
from PIL.PngImagePlugin import PngInfo

# NAI 원본 PNG tEXt 청크 — PNG 로 낼 때 함께 옮겨 준다 (backend.py:506).
# ★공홈이 **이걸 보고 가리는 것은 아니다** (`write` 의 ★★주, 2026-08-23 번들 확인) —
#   읽는 쪽은 tEXt 전체 → EXIF UserComment → 알파 순서로 본다. 그림의 출처가 파일에
#   남아 있게 하려고 옮기는 것이다.
ND_PNG_TEXT_CHUNKS = ("Title", "Description", "Software", "Source", "Generation time")


# ── 1. 읽기 ──────────────────────────────────────────────────


def _decode_stealth_pnginfo(img: Image.Image) -> dict | None:
    """NAI stealth pnginfo(알파 채널 LSB 스테가노그래피) 디코드.

    다른 유저가 공유한 파일은 업로드·재저장에서 PNG tEXt(Comment)가 제거되지만,
    알파 채널에 숨은 데이터는 남는다 (NAI 공홈이 이걸 읽는다).
    알파 LSB 를 **column-major**(x 바깥, y 안쪽)로 읽어 시그니처·길이·페이로드를 복원한다."""
    try:
        if img.mode != "RGBA":
            return None
        import numpy as np

        alpha = np.array(img)[:, :, 3]
        bits = (alpha & 1).astype(np.uint8).T.reshape(-1)  # column-major
        sig_bits = 15 * 8
        if bits.size < sig_bits + 32:
            return None
        # 시그니처 확인 (opaque 이미지는 알파 LSB 가 전부 1이라 여기서 걸러진다)
        sig = np.packbits(bits[:sig_bits]).tobytes().decode("utf-8", "ignore")
        if sig not in ("stealth_pnginfo", "stealth_pngcomp"):
            return None
        compressed = sig == "stealth_pngcomp"
        off = sig_bits
        param_len = int.from_bytes(np.packbits(bits[off : off + 32]).tobytes(), "big")
        off += 32
        if param_len <= 0 or param_len % 8 != 0 or off + param_len > bits.size:
            return None
        payload = np.packbits(bits[off : off + param_len]).tobytes()
        raw = gzip.decompress(payload).decode("utf-8") if compressed else payload.decode("utf-8")
        outer = json.loads(raw)  # ★바깥 봉투다 — `_unwrap_envelope` 가 여는 것과 같은 모양
        return _unwrap_envelope(outer) or None
    except Exception:
        return None


def _unwrap_envelope(d):
    """NAI 의 **바깥 봉투**를 열어 안의 메타데이터를 꺼낸다. 봉투가 아니면 그대로 돌려준다.

    ★★공홈이 파일에 넣는 것은 **두 겹**이다 (번들 `chunks/9360` 의 `function l` 과
      그것을 쓰는 자리들, 2026-08-23 확인):

          바깥 봉투  {Title, Description, Software, Source, Comment, "Generation time"}
          그 안       Comment 에 **문자열로** 든 진짜 메타데이터 JSON (prompt·uc·steps…)

      PNG 에서는 봉투의 칸 하나하나가 tEXt 청크라 `Comment` 만 집으면 됐다. 그런데
      **WebP 에서는 봉투째 EXIF `UserComment` 한 칸에 들어간다** — 넣을 칸이 하나뿐이라
      그렇다. 공홈 자신도 세 갈래(tEXt·UserComment·알파)를 전부 **봉투 모양**으로 맞춰
      돌려주고, 부르는 쪽은 언제나 `r.Comment` 를 `JSON.parse` 한다.

    ★사용자 지적 2026-08-23: *"nai 에서 만들어낸 무손실 webp 의 메타데이터를 못 읽는다"*.
      봉투를 안 열고 그대로 내부 메타데이터로 삼으니 `prompt` 가 없어 「없음」이 됐다."""
    if not isinstance(d, dict):
        return d
    c = d.get("Comment")
    if isinstance(c, str) and c.strip().startswith("{"):
        try:
            inner = json.loads(c)
        except Exception:
            return d
        return inner if isinstance(inner, dict) else d
    if isinstance(c, dict):
        return c
    return d


def read_raw(image_bytes: bytes, stealth: bool = True) -> dict:
    """이미지에서 **원본 형식 그대로** 메타데이터를 읽는다. 없으면 빈 dict.

    ★**단계 순서가 규칙이다** (backend.py:629-784 이식). 바꾸면 이전 세대 파일 복원이
      조용히 틀린다. Pillow 버전에 따라 UserComment 가 str/bytes 로 갈리는 대응도 실측 산물."""
    meta: dict = {}
    try:
        img = Image.open(io.BytesIO(image_bytes))
        info = getattr(img, "info", {}) or {}

        # 1. PNG Comment (NAI 호환) — 있으면 여기서 끝. EXIF 를 보지 않는다.
        if "Comment" in info:
            try:
                c = info["Comment"]
                if isinstance(c, bytes):
                    c = c.decode("utf-8")
                return json.loads(c)
            except Exception:
                pass

        # 2. ComfyUI 형식 (prompt/workflow 키)
        if "prompt" in info:
            try:
                p = info["prompt"]
                if isinstance(p, bytes):
                    p = p.decode("utf-8")
                wf = info.get("workflow")
                if isinstance(wf, bytes):
                    wf = wf.decode("utf-8")
                return {
                    "_comfyui": True,
                    "prompt": json.loads(p),
                    "workflow": json.loads(wf) if wf else None,
                }
            except Exception:
                pass

        # 3. 레거시 peropix 필드 → NAI 호환 형식으로 변환
        if "peropix" in info:
            try:
                legacy = json.loads(info["peropix"])
                return {
                    "prompt": legacy.get("prompt", ""),
                    "uc": legacy.get("negative_prompt", ""),
                    "seed": legacy.get("seed"),
                    "width": legacy.get("width"),
                    "height": legacy.get("height"),
                    "steps": legacy.get("steps"),
                    "scale": legacy.get("cfg"),
                    "sampler": legacy.get("sampler"),
                    "noise_schedule": legacy.get("scheduler"),
                    "request_type": legacy.get("nai_model"),
                    "ucPreset": legacy.get("uc_preset"),
                    "qualityToggle": legacy.get("quality_tags"),
                    "cfg_rescale": legacy.get("cfg_rescale"),
                    "peropix": {
                        "version": 0,
                        "provider": legacy.get("provider", "nai"),
                        "character_prompts": legacy.get("character_prompts", []),
                        "variety_plus": legacy.get("variety_plus", False),
                        "furry_mode": legacy.get("furry_mode", False),
                    },
                }
            except Exception:
                pass

        # 4. EXIF UserComment — getexif() (Pillow 9.0+, WebP/JPEG 모두)
        try:
            exif = img.getexif()
            if exif:
                ifd = exif.get_ifd(0x8769)  # ExifIFD
                if ifd and 0x9286 in ifd:  # UserComment
                    v = ifd[0x9286]
                    uc = None
                    if isinstance(v, str):
                        uc = v
                    elif isinstance(v, bytes):
                        try:
                            uc = piexif.helper.UserComment.load(v)
                        except Exception:
                            try:
                                uc = v.decode("utf-8")
                            except Exception:
                                pass
                    if uc:
                        return _unwrap_envelope(json.loads(uc))
        except Exception:
            pass

        # 5. EXIF raw bytes (WebP — piexif.load 는 JPEG 만 받는다)
        try:
            raw = info.get("exif")
            if raw:
                d = piexif.load(raw)
                if "Exif" in d and piexif.ExifIFD.UserComment in d["Exif"]:
                    return _unwrap_envelope(json.loads(piexif.helper.UserComment.load(d["Exif"][piexif.ExifIFD.UserComment])))
        except Exception:
            pass

        # 6. piexif 로 직접 (JPEG 전용)
        try:
            d = piexif.load(image_bytes)
            if "Exif" in d and piexif.ExifIFD.UserComment in d["Exif"]:
                return _unwrap_envelope(json.loads(piexif.helper.UserComment.load(d["Exif"][piexif.ExifIFD.UserComment])))
        except Exception:
            pass

        # 6-1. EXIF **어느 칸이든** 훑는다
        #
        # ★★사용자 지적 2026-08-23: *"공홈에서 webp 를 골라도 exif 를 남겨주는데 우리 앱은
        #   그 메타데이터를 못 읽음"*. 앞의 넷은 **UserComment 한 칸**만 본다 — 우리가 쓴
        #   WebP 는 그 칸에 넣으니 왕복이 되는데(실측), 남이 쓴 것이 `ImageDescription` 같은
        #   다른 칸에 넣으면 통째로 못 읽는다.
        # ★칸 이름을 짐작해 하나 더 넣는 대신 **전부 훑고 내용으로 가린다** — 우리 형식으로
        #   읽히는 것만 받아들이므로, 엉뚱한 글이 메타데이터로 둔갑하지 않는다.
        try:
            found = _json_in_exif(img)
            if found:
                return found
        except Exception:
            pass

        # 7. NAI stealth pnginfo — ★앞이 전부 실패했을 때만.
        # ★`stealth=False` 면 건너뛴다 — 픽셀 전부를 훑는 폴백이라 수천 장을 인덱싱할 때는
        #   못 쓴다 (`tagindex.py`). 한 장씩 볼 때는 전처럼 끝까지 간다.
        if stealth:
            hidden = _decode_stealth_pnginfo(img)
            if hidden:
                return hidden
    except Exception:
        pass
    return meta


#: 이 키가 하나라도 있으면 **우리가 아는 형식**이다 (NAI 원본 · PeroPix 확장 · 바깥 봉투)
_META_HINTS = ("prompt", "uc", "peropix", "steps", "sampler", "seed", "Comment")


def _json_in_exif(img: Image.Image) -> dict | None:
    """EXIF 의 **모든 문자열 칸**에서 우리 형식의 JSON 을 찾는다 (`read_raw` 6-1 의 ★주).

    ★칸을 짐작하지 않는다 — 훑고 **내용으로** 가린다. 우리 형식으로 읽히는 것만 받는다.
    ★`UserComment` 는 앞에 인코딩 표시(`ASCII` 등) 8바이트가 붙는 규격이라 그것도 벗긴다."""
    try:
        exif = img.getexif()
    except Exception:
        return None
    if not exif:
        return None

    def ifds():
        yield exif
        # ★★`get_ifd` 는 그 IFD 가 **없으면 KeyError 를 던진다** (PIL). 하나로 묶어 감싸면
        #   첫 칸에서 터지면서 나머지도 통째로 못 보게 된다 — 실측으로 밟았다.
        for tag in (0x8769, 0xA005):
            try:
                got = exif.get_ifd(tag)
            except Exception:
                continue
            if got:
                yield got

    def texts():
        for ifd in ifds():
            for v in ifd.values():
                if isinstance(v, str):
                    yield v
                elif isinstance(v, bytes):
                    for enc in ("utf-8", "utf-16-be", "utf-16-le"):
                        try:
                            yield v.decode(enc)
                        except Exception:
                            pass
                        try:
                            yield v[8:].decode(enc)   # UserComment 규격의 머리 8바이트
                        except Exception:
                            pass

    for txt in texts():
        t = txt.strip().strip("")
        if not t.startswith("{"):
            continue
        try:
            d = json.loads(t)
        except Exception:
            continue
        if isinstance(d, dict) and any(k in d for k in _META_HINTS):
            return _unwrap_envelope(d)
    return None


# ── 2. 정규화 ────────────────────────────────────────────────
# index.html:17422-17668 이식. NAI 원본과 PeroPix 확장을 하나의 내부 형식으로 맞춘다.

# ★★표는 **`nai.py` 하나**다 (2026-08-19). 여기 사본을 두던 때는 V4.5 Full 것 한 벌로
#   모든 모델을 읽어서, V4.5 Curated 이미지의 퀄리티 접미사(`-0.8::feet::, rating:general`)가
#   프롬프트에 남고 `ucPreset` 숫자도 엉뚱한 이름으로 풀렸다 (2 는 Full 에서 Furry Focus,
#   Curated 에서 Human Focus 다). 보내는 표와 읽는 표가 갈리면 왕복이 조용히 깨진다.


def _quality_patterns(model: str) -> list[tuple[str, str, bool]]:
    """그 모델의 퀄리티 접미사 후보 — `(문자열, 프리셋 id, 투명배경인가)`.

    ★**Enhance 변형을 먼저** 본다 (긴 쪽이 먼저 걸려야 한다).
    ★모델을 모르면 아는 모델의 것을 전부 대 본다. 문자열이 길고 서로 달라 헛맞지 않는다.
    ★★프리셋 id 와 투명 배경을 **갈라** 돌려주는 이유가 둘이다:
      · 투명 배경만 켜고 퀄리티는 끈 조합이 있다 (꼬리가 `, transparent background` 하나뿐).
        하나로 뭉치면 되읽을 때 퀄리티 태그가 저절로 켜진다.
      · 공홈 V5 는 퀄리티 프리셋이 `standard`·`light` 둘이라, **어느 쪽이었는지**까지
        되살려야 다시 그렸을 때 같은 문자열이 나간다."""
    # ★★그 모델의 프리셋을 **전부** 대 본다. 모델을 모르면 아는 접미사 전부.
    if model:
        pairs = [(pid, s) for pid, s in nai.quality_presets(model) if s]
    else:
        # 모델을 모르면 id 를 특정할 수 없다 — standard 로 본다 (다시 그릴 때 기본값이다)
        pairs = [("standard", s) for s in nai.ALL_QUALITY_SUFFIXES]
    bg = ", " + nai.TRANSPARENT_BG_TAG

    cands: list[tuple[str, str, bool]] = []
    for pid, suf in pairs:
        cands.append((bg + suf, pid, True))    # 투명 배경 + 퀄리티
        cands.append((suf, pid, False))        # 퀄리티만
    cands.append((bg, "none", True))           # 투명 배경만

    out: list[tuple[str, str, bool]] = []
    for text, pid, tb in cands:
        out.append((text + nai.ENHANCE_PROMPT_ADD, pid, tb))
        out.append((text, pid, tb))
    out.sort(key=lambda x: len(x[0]), reverse=True)
    return out


def _preset_candidates(model: str) -> list[tuple[str, str]]:
    """각 프리셋의 정상형 + NSFW 변형.

    ★NAI 는 프롬프트에 NSFW 가 있으면 프리셋 맨 앞의 `nsfw, ` 를 빼고 넣는다 (공홈 캡처로 확인).
      그래서 `nai.UC_PRESETS` 의 본문(nsfw 없음)에 변형을 하나 더 만들어 둘 다 본다.
    ★그 모델의 표를 먼저 보되 **다른 모델 표도 뒤에 붙인다** — 모델 id 가 없는 그림이 있다.
    ★길이 내림차순 — 안 하면 짧은 Heavy 가 먼저 걸려 긴 Human Focus 를 놓친다."""
    seen: set[str] = set()
    out: list[tuple[str, str]] = []
    lists = [nai.uc_presets(model)] if model else []
    lists += list(nai.UC_PRESETS.values())
    for plist in lists:
        for _cat, name, text in plist:
            if not text or text in seen:
                continue
            seen.add(text)
            out.append((name, text))
            out.append((name, "nsfw, " + text))
    out.sort(key=lambda x: len(x[1]), reverse=True)
    return out


def _strip_named_uc(neg: str, name: str, model: str = "") -> str:
    """**이름을 알고** 떼어낸다 — 짐작하지 않는다 (`sent` 가 있을 때).

    ★못 찾으면 그대로 둔다. 억지로 떼면 사용자가 적은 네거티브가 잘려 나간다 —
      프리셋 본문을 손대 놓았거나, 프리셋이 맨 앞이 아닐 수 있다."""
    neg = neg or ""
    for cand in sorted(
        (c for n, c in _preset_candidates(model) if n == name), key=len, reverse=True
    ):
        if neg.startswith(cand):
            return neg[len(cand):].lstrip(", ").lstrip()
    return neg


def _strip_uc_preset(neg: str, model: str = ""):
    """네거티브 앞에서 프리셋 태그를 감지·제거. 매칭되면 (이름, 나머지), 아니면 None."""
    neg = neg or ""
    for name, cand in _preset_candidates(model):
        if neg.startswith(cand):
            rest = neg[len(cand) :]
            return name, rest.lstrip(", ").lstrip()
    return None


def _detect_uc_preset_from_diff(full_uc: str, base_neg: str, model: str = ""):
    """구버전 PeroPix 이미지(uc_preset 미저장)의 프리셋 복원.

    최종 uc = <프리셋 태그> + ", " + <클린 네거티브> 구조이므로 차분으로 역산한다.
    PeroPix 가 자기 테이블로 만든 값이라 매칭이 보장된다. 못 맞추면 None."""
    full_uc, base_neg = full_uc or "", base_neg or ""
    if full_uc == base_neg:
        return "None"
    prefix = full_uc
    if base_neg:
        if full_uc.endswith(base_neg):
            prefix = full_uc[: len(full_uc) - len(base_neg)].rstrip().rstrip(",").rstrip()
        else:
            return None
    for name, cand in _preset_candidates(model):
        if prefix == cand:
            return name
    return None


def _comfy_text(prompt: dict, ref: object) -> str:
    """노드 참조(`[노드id, 출력번호]`)를 한 칸 따라가 CLIPTextEncode 의 글을 꺼낸다.

    ★더 깊이 들어가지 않는 것도 v2 그대로다 (index.html:25851 `getTextFromNodeRef`).
      노드 그래프는 끝이 없어서, 못 찾으면 지어내는 것보다 빈 값이 낫다."""
    if not isinstance(ref, list) or not ref:
        return ""
    node = prompt.get(str(ref[0]))
    if not isinstance(node, dict):
        return ""
    cls = str(node.get("class_type") or "")
    if "CLIPTextEncode" in cls or "PromptEncode" in cls:
        text = (node.get("inputs") or {}).get("text")
        if isinstance(text, str):
            return text
    return ""


def _from_comfyui(meta: dict) -> dict:
    """ComfyUI 워크플로 → 내부 형식 (index.html:25851 `renderComfyUIContent` 이식).

    ★분기가 없어서 EXIF 리더에 `prompt`·`workflow` 원문이 통째로 쏟아지고 있었다
      (감사 C7). 여기서 한 번 풀어 주면 화면은 다른 그림과 똑같이 다루면 된다."""
    prompt = meta.get("prompt") if isinstance(meta.get("prompt"), dict) else {}
    workflow = meta.get("workflow")
    pos: list[str] = []
    neg: list[str] = []
    s: dict = {}
    for node in prompt.values():
        if not isinstance(node, dict):
            continue
        inputs = node.get("inputs") or {}
        cls = str(node.get("class_type") or "")
        if cls in ("KSampler", "KSamplerAdvanced"):
            p = _comfy_text(prompt, inputs.get("positive"))
            n = _comfy_text(prompt, inputs.get("negative"))
            if p and p not in pos:
                pos.append(p)
            if n and n not in neg:
                neg.append(n)
            if "seed" in inputs:
                # 시드가 다른 노드 참조면 값을 알 수 없다 — 모른다고 적는다
                s["seed"] = "(dynamic)" if isinstance(inputs["seed"], list) else inputs["seed"]
            for key, into in (("steps", "steps"), ("cfg", "cfg"),
                              ("sampler_name", "sampler"), ("scheduler", "scheduler"),
                              ("denoise", "denoise")):
                if inputs.get(key) is not None:
                    s[into] = inputs[key]
        elif cls == "EmptyLatentImage":
            for key in ("width", "height"):
                if inputs.get(key):
                    s[key] = inputs[key]
        elif "CheckpointLoader" in cls and inputs.get("ckpt_name"):
            s["model"] = inputs["ckpt_name"]

    return {
        "prompt": "\n---\n".join(pos),
        "negative": "\n---\n".join(neg),
        "characters": [],
        "slot_prompt": "",
        "seed": s.get("seed"),
        "width": s.get("width"),
        "height": s.get("height"),
        "steps": s.get("steps"),
        "cfg": s.get("cfg"),
        "sampler": s.get("sampler"),
        "scheduler": s.get("scheduler"),
        "nai_model": "",
        "smea": "none",
        "uc_preset": "None",
        "quality_tags": False,
        "cfg_rescale": None,
        "variety_plus": False,
        "furry_mode": False,
        "vibe_transfer": None,
        "nai_vibes": {"images": [], "strengths": [], "info_extracted": []},
        "precise_ref_count": 0,
        "pure_nai": False,
        # ComfyUI 만 갖는 것 — 화면이 「워크플로」 칸으로 따로 보여 준다
        "comfy": {
            "model": s.get("model") or "",
            "denoise": s.get("denoise"),
            "nodes": len((workflow or {}).get("nodes") or []) if isinstance(workflow, dict) else 0,
        },
        "raw": meta,
    }


def kind_of(raw: dict | None, info: dict | None = None) -> str:
    """이 그림이 어디서 나왔나 — 화면의 **형식 배지** (index.html:25683-25701 이식).

    빈 문자열이면 모르는 것이다. ★판정 순서가 규칙이다: vibe 캐시 PNG 는 NAI 메타데이터가
    없고 tEXt 로만 알아볼 수 있으므로 먼저 본다."""
    info = info or {}
    if info.get("vibe_data") or info.get("cache_key"):
        return "vibe"
    if raw:
        if raw.get("_comfyui"):
            return "comfyui"
        if raw.get("peropix"):
            return "peropix"
        if raw.get("prompt") or raw.get("uc"):
            return "nai"
    return "custom" if info else ""


def normalize(meta: dict | None, sent: dict | None = None) -> dict | None:
    """NAI 원본 + PeroPix 확장 → 내부 형식. `read_raw` 의 결과를 넣는다.

    ★★`sent` 는 **그때 실제로 보낸 값**이다 (`records.jsonl` 의 `resolved`).
      NAI 는 응답 PNG 에 `ucPreset`·`qualityToggle` 을 **`null` 로 비워** 돌려주므로,
      프리셋이 무엇이었는지는 그림만 봐서는 **알 수 없다.** 그래서 지금까지는 네거티브 앞에서
      프리셋 본문을 떼어내 **짐작**했는데, 두 갈래로 틀렸다 (사용자 지적 2026-08-21):

        · 프리셋을 안 썼는데 사용자 UC 가 마침 Heavy 본문으로 시작하면 **Heavy 로 읽혔다**
        · 프리셋 본문을 손대 놓았으면 못 찾아 **언제나 None** 이었다

      기록이 있으면 짐작하지 않는다. 짐작은 밖에서 가져온 그림에만 남는다."""
    if not meta:
        return None
    # ComfyUI 는 규격이 통째로 달라 따로 푼다
    if meta.get("_comfyui"):
        return _from_comfyui(meta)
    # 이미 내부 형식이면 그대로
    if "negative" in meta or "cfg" in meta or "nai_model" in meta:
        return meta

    ppx = meta.get("peropix") or {}
    is_pure_nai = "peropix" not in meta

    # 캐릭터 프롬프트 — peropix 확장 > v4_prompt > characterPrompts
    char_prompts: list[str] = []
    if ppx.get("character_prompts"):
        char_prompts = list(ppx["character_prompts"])
    elif ((meta.get("v4_prompt") or {}).get("caption") or {}).get("char_captions"):
        char_prompts = [
            c.get("char_caption", "")
            for c in meta["v4_prompt"]["caption"]["char_captions"]
            if c.get("char_caption")
        ]
    elif meta.get("characterPrompts"):
        char_prompts = [c.get("prompt", "") for c in meta["characterPrompts"] if c.get("prompt")]

    # 캐릭터 네거티브 — ★같은 인덱스로 정렬해야 남의 네거티브가 안 붙는다
    char_negs: list[str] = []
    if ppx.get("character_negatives"):
        char_negs = list(ppx["character_negatives"])
    elif ((meta.get("v4_negative_prompt") or {}).get("caption") or {}).get("char_captions"):
        char_negs = [c.get("char_caption", "") for c in meta["v4_negative_prompt"]["caption"]["char_captions"]]

    # 좌표 — v4_prompt 의 centers
    centers: list[dict | None] = []
    for c in ((meta.get("v4_prompt") or {}).get("caption") or {}).get("char_captions") or []:
        cs = c.get("centers") or []
        centers.append(cs[0] if cs else None)

    # ★★모델 id 를 **여기서 먼저** 잡는다 — 퀄리티 접미사도 UC 프리셋도 순서도 모델마다
    #   다르다 (`nai.QUALITY_SUFFIX`·`nai.UC_PRESETS`). 아래 판정이 전부 이 값을 본다.
    #   ★`request_type` 이 "PromptGenerateRequest" 같은 내부 타입이면 무시한다
    nai_model = ""
    for key in ("request_type", "model"):
        v = meta.get(key)
        if isinstance(v, str) and v.startswith("nai-diffusion"):
            nai_model = v
            break
    quality_pats = _quality_patterns(nai_model)
    # ★★따옴표 → `teXt:` 자동 조립을 **먼저** 되돌린다 (`naitext.strip`).
    #   붙는 자리가 맨 끝이라, 안 떼면 퀄리티 접미사가 그 뒤에 있는 셈이 되어 안 걸린다.
    #   ★다시 만들어 보고 **같을 때만** 뗀다 — 손으로 적은 `teXt:` 는 안 건드린다.
    _text_chars = [
        {"prompt": p, "center": centers[i] if i < len(centers) and centers[i] else {"x": 0.5, "y": 0.5}}
        for i, p in enumerate(char_prompts)
    ]
    _use_coords = bool(((meta.get("v4_prompt") or {}).get("use_coords")))
    # ★★`ucPreset` **숫자는 안 쓴다.** 프리셋은 네거티브 **앞에서 그 문자열을 떼어낼 수 있을
    #   때만** 이름을 붙인다 — 못 떼면 그 태그가 네거티브에 남아 있는 것이라, 이름까지 붙이면
    #   다시 그릴 때 프리셋이 **두 번** 들어간다. (숫자의 뜻도 모델마다 다르다:
    #   V4.5 Full 의 2 는 Furry Focus, Curated 의 2 는 Human Focus)
    uc_preset = "None"
    quality_tags = meta.get("qualityToggle")
    # ★투명 배경 — 공홈은 `tag_hint_transparent_background` 를 싫고(2026-08-21),
    #   우리는 접미사에서도 되잊는다. 둘 중 하나라도 참이면 켜진 것이다.
    transparent_bg = bool(meta.get("tag_hint_transparent_background"))
    # ★프리셋 id 는 접미사를 떼어 낼 때 함께 정해진다 (`_quality_patterns`).
    #   못 떼면 "none" 이다 — 붙어 있지 않았다는 뜻이라 다시 붙이면 안 된다.
    quality_preset = "none"
    slot_prompt = ppx.get("slot_prompt") or ""
    prompt = meta.get("prompt") or ""
    negative = meta.get("uc") or ""

    if prompt:
        prompt = naitext.strip(prompt, _text_chars, _use_coords)

    # ★★**기록이 있으면 짐작하지 않는다** (사용자 지적 2026-08-21: 다른 프리셋으로 뽑았는데
    #   같은 것이 불러와진다). NAI 가 `ucPreset`·`qualityToggle` 을 null 로 비워 돌려주기
    #   때문에, 지금까지는 네거티브 앞에서 본문을 떼어내 짐작하는 길밖에 없었다.
    #   ★떼어내는 것은 여전히 필요하다 — 안 떼면 다시 적용할 때 프리셋이 **두 번** 들어간다.
    #     다만 **이름을 알고** 그것만 뗀다 (`_strip_named_uc`).
    sent_uc = (sent or {}).get("uc_preset")
    sent_q = (sent or {}).get("quality_preset")
    if sent_uc is not None:
        uc_preset = sent_uc
        if uc_preset != "None":
            negative = _strip_named_uc(negative, uc_preset, nai_model)
    if sent_q is not None:
        quality_preset = sent_q
        quality_tags = quality_preset != "none"
        transparent_bg = bool((sent or {}).get("transparent_bg", transparent_bg))
        # 그 프리셋(+투명 배경)의 접미사만 떼어낸다
        for pat, pid, was_bg in quality_pats:
            if pid == quality_preset and was_bg == transparent_bg and prompt.endswith(pat):
                prompt = prompt[: -len(pat)]
                break

    if is_pure_nai:
        # 순수 NAI: 프롬프트 끝의 퀄리티 태그 제거 (안 지우면 Apply 때마다 중복 누적)
        #   ★기록이 있으면 위에서 이미 뗐다 — 여기서 또 짐작하지 않는다
        removed = sent_q is not None
        for pat, pid, was_bg in quality_pats:
            if removed:
                break
            if prompt.endswith(pat):
                prompt = prompt[: -len(pat)]
                # ★★퀄리티 프리셋과 투명 배경을 **따로** 되살린다 — 붙는 자리가 같을 뿐
                #   서로 다른 스위치다 (`_quality_patterns` 주석)
                quality_preset = pid
                quality_tags = pid != "none"
                transparent_bg = was_bg
                removed = True
                break
        # ★V2 는 접미사가 아니라 **앞에** 붙는다 (`nai.QUALITY_PREFIX`)
        if not removed:
            for pre in nai.QUALITY_PREFIX.values():
                if prompt.startswith(pre):
                    prompt = prompt[len(pre) :]
                    quality_tags = True
                    quality_preset = "standard"
                    removed = True
                    break
        if not removed:
            quality_tags = False
        # ★기록이 있으면 위에서 이름을 알고 뗐다 — 짐작은 기록이 없을 때만
        if sent_uc is None:
            res = _strip_uc_preset(negative, nai_model)
            if res:
                uc_preset, negative = res
            else:
                uc_preset = "None"
    else:
        # PeroPix 이미지
        base_neg = ppx.get("base_negative_prompt")
        if base_neg is not None:
            negative = base_neg or ""
        if ppx.get("uc_preset") is not None:
            uc_preset = ppx["uc_preset"]
        elif base_neg is not None:
            uc_preset = _detect_uc_preset_from_diff(meta.get("uc") or "", base_neg or "", nai_model) or "None"
        else:
            res = _strip_uc_preset(negative, nai_model)
            if res:
                uc_preset, negative = res
            else:
                uc_preset = "None"
        if ppx.get("quality_tags") is not None:
            quality_tags = ppx["quality_tags"]
        else:
            # ★패턴은 `(문자열, 프리셋 id, 투명배경인가)` 다 — 걸린 것의 id 를 그대로 쓴다
            for pat, pid, _bg in quality_pats:
                if (meta.get("prompt") or "").endswith(pat):
                    quality_preset = pid
                    break
            quality_tags = quality_preset != "none"

        # base_prompt 가 있으면 직접 (v3+), 없으면 슬롯 프롬프트 수동 제거 (v2 하위호환)
        if ppx.get("base_prompt") is not None:
            prompt = ppx["base_prompt"] or ""
        elif slot_prompt:
            for pat, pid, was_bg in quality_pats:
                if prompt.endswith(pat):
                    prompt = prompt[: -len(pat)]
                    quality_preset = pid
                    quality_tags = pid != "none"
                    transparent_bg = was_bg
                    break
            for suffix in (", " + slot_prompt, "," + slot_prompt, slot_prompt):
                if prompt.endswith(suffix):
                    prompt = prompt[: -len(suffix)].rstrip().rstrip(",").rstrip()
                    break

    variety_plus = bool(ppx.get("variety_plus"))
    if not variety_plus and meta.get("skip_cfg_above_sigma") is not None:
        variety_plus = True

    furry = bool(ppx.get("furry_mode"))
    if not furry and (meta.get("prompt") or "").startswith("fur dataset,"):
        furry = True

    return {
        "prompt": prompt,
        "negative": negative,
        "characters": [
            {
                "prompt": p,
                "negative": char_negs[i] if i < len(char_negs) else "",
                "center": centers[i] if i < len(centers) else None,
            }
            for i, p in enumerate(char_prompts)
        ],
        # ★좌표를 **쓰고 있었는가** — 자리(`center`)만 돌려주면 화면이 되살려도 NAI 는
        #   무시한다 (`nai.py` 는 `any(c.use_coord)` 로만 켠다). 켜짐 상태가 있어야 왕복이 닫힌다.
        "use_coords": _use_coords,
        "slot_prompt": slot_prompt,
        "seed": meta.get("seed"),
        "width": meta.get("width"),
        "height": meta.get("height"),
        "steps": meta.get("steps"),
        "cfg": meta.get("scale"),
        "sampler": meta.get("sampler"),
        "scheduler": meta.get("noise_schedule") or "karras",
        "nai_model": nai_model,
        "smea": "SMEA+DYN" if meta.get("sm_dyn") else ("SMEA" if meta.get("sm") else "none"),
        "uc_preset": uc_preset,
        "quality_tags": bool(quality_tags),
        "quality_preset": quality_preset if quality_tags else "none",  # ★둘은 같은 사실의 두 표기다
        "transparent_bg": bool(transparent_bg),
        "cfg_rescale": meta.get("cfg_rescale"),
        "variety_plus": variety_plus,
        "furry_mode": furry,
        "vibe_transfer": ppx.get("vibe_transfer"),
        "nai_vibes": {
            "images": meta.get("reference_image_multiple") or [],
            "strengths": meta.get("reference_strength_multiple") or [],
            "info_extracted": meta.get("reference_information_extracted_multiple") or [],
        },
        # ★★**이름이 둘이다** (공홈 번들 실측 2026-08-25). 우리가 **보낼 때**는
        #   `director_reference_strength_values` 인데(`nai.py`), NAI 가 PNG 에 적어 주는
        #   기록에는 `director_reference_strengths` 로 나온다 (번들의 요청 기록 166건 대 1건).
        #   한쪽만 보면 공홈에서 뽑은 그림의 개수가 **늘 0** 이 되어, 「재현 불가」 알림이
        #   안 뜬다. 둘 다 본다.
        "precise_ref_count": len(
            meta.get("director_reference_strengths")
            or meta.get("director_reference_strength_values")
            or []
        ),
        # ★어떤 요청이었나 — 「메타데이터만으로는 재현 못 한다」를 가르는 값이다
        #   (공홈: `Img2ImgRequest` · `NativeInfillingRequest`). 그림에 그대로 남는다.
        "request_type": meta.get("request_type") or "",
        "pure_nai": is_pure_nai,
        "raw": meta,
    }


def read(path: Path, sent: dict | None = None) -> dict | None:
    """파일 한 장의 내부 형식 메타데이터. 없거나 못 읽으면 None.

    ★못 읽는 것은 **정상 경우다** — 밖에서 가져온 그림, 메타데이터를 지운 그림.
      예외로 만들지 않는다 (갤러리는 그런 파일도 보여줘야 한다)."""
    try:
        data = path.read_bytes()
        with Image.open(io.BytesIO(data)) as im:
            size = im.size
            info = dict(im.info)
    except Exception:
        return None

    out = normalize(read_raw(data), sent) or {}
    out.setdefault("width", size[0])
    out.setdefault("height", size[1])
    if out.get("width") is None:
        out["width"] = size[0]
    if out.get("height") is None:
        out["height"] = size[1]
    # 표시용 문자열 — NAI 가 PNG tEXt 에 넣는 것. 모델 **id**(nai_model)와 다르다.
    if "Source" in info:
        out["source"] = str(info["Source"])
    if "Software" in info:
        out["software"] = str(info["Software"])
    return out or None


# ── 3. 쓰기 ──────────────────────────────────────────────────


def write(image_bytes: bytes, metadata: dict, fmt: str = "PNG", quality: int = 95,
          extra_png_chunks: dict | None = None) -> bytes:
    """메타데이터를 박아 넣은 이미지 바이트를 돌려준다 (backend.py:509-582 이식).

    ★PNG 는 EXIF 를 직접 지원하지 않아 tEXt 로만 넣는다. NAI 원본 청크(`Source` 등)도 함께
      옮겨 준다 — 그림이 어디서 나왔는지가 파일에 남아야 한다.

    ★★**공홈이 무엇을 보고 읽는가** (번들 `chunks/9360` 의 `function l`, 2026-08-23 확인):

          1) PNG tEXt 청크를 전부 읽는다
          2) 없으면 **EXIF `UserComment`** 를 풀어 `JSON.parse`
             (앞 8바이트가 `UNICODE\0` 면 UTF-16 · `ASCII\0\0\0` 나 전부 0 이면 떼고 UTF-8)
          3) 그래도 없으면 **알파 채널**(stealth)

      즉 **`Source` 를 보고 가리는 것이 아니다.** 그래서 우리가 낸 WebP 도 공홈이 읽는다 —
      단 **봉투째** 넣어야 한다 (`user_comment()` 의 ★★주). 세 갈래 모두 결과가 봉투 모양이고,
      그것을 부르는 쪽은 언제나 `Comment` 를 다시 푼다.
      ★한때 이 자리에 *"원본 청크를 보존해야 공홈이 자기 이미지로 인식한다"* 고 적혀 있었다.
        그 문장을 근거로 「PNG 가 아니면 공홈이 못 읽는다」고 잘못 말한 적이 있다 —
        읽는 쪽 코드를 보면 그렇지 않다."""
    try:
        js = json.dumps(metadata, ensure_ascii=False)
        img = Image.open(io.BytesIO(image_bytes))
        out = io.BytesIO()
        up = fmt.upper()

        def user_comment() -> bytes:
            """EXIF `UserComment` 한 칸에 넣을 것 — **바깥 봉투째** 넣는다.

            ★★PNG 는 봉투의 칸마다 tEXt 청크를 하나씩 쓰지만, EXIF 에는 넣을 칸이 하나다.
              공홈은 그 하나에 **봉투를 통째로** 넣고, 읽을 때 `Comment` 를 다시 푼다
              (`_unwrap_envelope` 의 ★★주). 우리가 안쪽 JSON 만 넣으면 공홈이 `Comment` 를
              못 찾아 *"no importable metadata"* 가 된다 — 우리 앱끼리는 되지만 공홈에서 막힌다.
            ★`piexif` 의 `unicode` 는 `UNICODE` 접두 + UTF-16BE 다. 공홈 풀이 규칙과 맞는 것을 실측했다."""
            envelope = {}
            for name in ND_PNG_TEXT_CHUNKS:
                v = (extra_png_chunks or {}).get(name)
                if isinstance(v, str) and v:
                    envelope[name] = v
            envelope["Comment"] = js
            return piexif.helper.UserComment.dump(
                json.dumps(envelope, ensure_ascii=False), encoding="unicode")

        if up == "PNG":
            info = PngInfo()
            if extra_png_chunks:
                for name in ND_PNG_TEXT_CHUNKS:
                    v = extra_png_chunks.get(name)
                    if isinstance(v, str) and v:
                        info.add_text(name, v)
            info.add_text("Comment", js)
            img.save(out, format="PNG", pnginfo=info)
        elif up in ("JPEG", "JPG"):
            exif = piexif.dump({
                "0th": {}, "GPS": {}, "1st": {}, "thumbnail": None,
                "Exif": {piexif.ExifIFD.UserComment: user_comment()},
            })
            if img.mode in ("RGBA", "P"):
                img = img.convert("RGB")
            img.save(out, format="JPEG", exif=exif, quality=quality)
        elif up == "WEBP":
            exif = piexif.dump({
                "0th": {}, "GPS": {}, "1st": {}, "thumbnail": None,
                "Exif": {piexif.ExifIFD.UserComment: user_comment()},
            })
            # ★★**무손실이다** (사용자 결정 2026-08-23). 공홈도 `WebP (Lossless)` 하나만 낸다 —
            #   생성물은 Anlas 가 든 원본이라 저장할 때 픽셀을 다시 뭉개지 않는다.
            #   투명은 손실이든 무손실이든 살지만, 무손실이면 **PNG 와 같은 그림**이 된다.
            img.save(out, format="WEBP", exif=exif, lossless=True)
        else:
            img.save(out, format=fmt)
        return out.getvalue()
    except Exception:
        return image_bytes  # 실패하면 원본을 돌려준다 — 그림을 잃지 않는 것이 우선


def strip(image_bytes: bytes, fmt: str = "PNG", quality: int = 95) -> bytes:
    """메타데이터를 **완전히** 제거한다 (backend.py:2794-2821 이식).

    ★tEXt/EXIF 만 지우면 안 된다 — NAI 는 **알파 채널 LSB 스테가노그래피**로 한 벌 더 심는다.
    ★단 실제 투명도가 있는 그림은 건드리지 않는다. 알파 최솟값이 254 이상일 때만 불투명으로
      본다 (그때만 LSB 가 데이터다)."""
    import numpy as np

    img = Image.open(io.BytesIO(image_bytes))
    up = fmt.upper()
    if up in ("JPEG", "JPG") and img.mode in ("RGBA", "P"):
        img = img.convert("RGB")

    arr = np.array(img)
    if arr.ndim == 3 and arr.shape[2] == 4:
        if arr[:, :, 3].min() >= 254:
            arr[:, :, 3] = 255  # 불투명 — 스테가노그래피 LSB 를 지운다
    clean = Image.fromarray(arr)

    out = io.BytesIO()
    if up in ("JPEG", "JPG"):
        clean.save(out, format="JPEG", quality=quality, exif=b"")
    elif up == "WEBP":
        # ★쓰기와 같은 규칙 — 무손실 (위 `write` 의 ★★주)
        clean.save(out, format="WEBP", lossless=True, exif=b"")
    else:
        clean.save(out, format="PNG", pnginfo=PngInfo())  # 빈 pnginfo 를 명시
    return out.getvalue()
