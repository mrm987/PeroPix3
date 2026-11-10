"""NAI 생성 — v2.x `backend.py` 의 `call_nai_api` 에서 옮겨온 것.

★이 파일의 페이로드 구조는 NAI 웹의 실제 요청과 대조해 맞춘 결과다.
   필드 하나만 달라져도 결과 이미지가 바뀐다. 임의로 "정리"하지 말 것.
   근거: docs/renewal/feature-inventory.md 「절대 재구현하지 말 것」

5단계에서 vibe·Precise Reference·i2i·인페인트를 붙였다 (v2 backend.py:1479-1700).
그 구간은 **★재구현 금지가 가장 몰린 곳**이라 원문을 그대로 옮겼다 —
각 항목의 ★주석이 "왜 그 값인지"를 담고 있으니 지우지 말 것.
"""
from __future__ import annotations

import io
import json
from collections.abc import Awaitable, Callable
import math
import os
import random
import re
import zipfile
import dataclasses
from dataclasses import dataclass, field

import httpx

import imgutil
import naitext
import vibe as vibe_mod

NAI_ENDPOINT = "https://image.novelai.net/ai/generate-image"
#: 업스케일 — ★2026-08-21 재배포로 **생성과 같은 호스트로 옮겨졌다**
#: (`BackendUrl` → `ImageBackendUrl`). 옛 주소는 `api.novelai.net` 이었다.
UPSCALE_ENDPOINT = "https://image.novelai.net/ai/upscale"

#: 업스케일 모델 — ★새 규격은 **배율·해상도를 안 보낸다.** 대신 모델 id 하나를 보내고
#: 서버가 정한다 (공홈 `{image, model: eB.gb, declared_blur_sigma: eB.Kx}`).
UPSCALE_MODEL = "nai-diffusion-5-curated"
UPSCALE_BLUR_SIGMA = 0

#: 픽셀 수 구간별 Anlas — ★새 표다 (공홈 `g`). **처음 걸리는 구간이 이긴다**
#: (옛 표는 큰 것부터 훑어 마지막이 남는 구조였다 — 순서를 뒤집지 말 것).
UPSCALE_COST_TABLE = ((1048576, 1), (1747627, 2), (2446678, 3), (3145728, 4))
#: 이보다 크면 못 한다 — ★1MP 에서 **3MP 로 넓어졌다**
UPSCALE_MAX_PX = 3145728
#: ★★업스케일 **Opus 무료 구간이 없어졌다.** 옛 규격은 409,600px 이하가 0 이었다.

# ══ 모델별 표 — 정본은 `docs/nai-web-reference.md` 2절 (공홈 번들에서 추출) ══════════
#
# ★여기 값은 **모델마다 다르다.** 예전에는 V4.5 Full 것 한 벌을 모든 모델에 썼는데,
#   V4.5 Curated·V4 Curated 에 남의 퀄리티 접미사와 남의 UC 프리셋이 나가고 있었다.

#: 퀄리티 프리셋 (`UM()`). **목록의 순서가 곧 드롭다운 순서**이고, 마지막은 언제나 none 이다.
#: 각 항목 `(id, 접미사)`. 표시 이름은 화면이 i18n 으로 만든다.
#:
#: ★★2026-08-21 재배포로 공홈은 이것이 **목록**이 됐다 — V5·custom 은 `standard`/`light`/`none`
#:   셋이고 나머지는 `standard`/`none` 둘이다. 예전에는 켬/끔 하나였다.
#: ★접미사 앞의 `, ` 는 우리 표기다 (공홈 목록에는 없고 붙일 때 잇는다) — 결과는 같다.
#: ★아래에 **우리가 만들지 않는 모델**도 둔다 (목록에 없다). 갤러리에 들어온 옛 그림에서
#:   퀄리티 태그를 떼어내려면 그 모델의 접미사를 알아야 한다 (`meta.normalize`).
QUALITY_PRESETS: dict[str, list[tuple[str, str]]] = {
    "nai-diffusion-5-full": [
        ("standard", ", very aesthetic, masterpiece, no text"),
        ("light", ", very aesthetic, amazing quality, no text"),
        ("none", ""),
    ],
    "nai-diffusion-4-5-full": [
        ("standard", ", very aesthetic, masterpiece, no text"),
        ("none", ""),
    ],
    "nai-diffusion-4-5-curated": [
        ("standard", ", very aesthetic, masterpiece, no text, -0.8::feet::, rating:general"),
        ("none", ""),
    ],
    "nai-diffusion-4-full": [
        ("standard", ", no text, best quality, very aesthetic, absurdres"),
        ("none", ""),
    ],
    "nai-diffusion-4-curated-preview": [
        ("standard", ", rating:general, best quality, very aesthetic, absurdres"),
        ("none", ""),
    ],
    "nai-diffusion-3": [
        ("standard", ", best quality, amazing quality, very aesthetic, absurdres"),
        ("none", ""),
    ],
    "nai-diffusion-furry-3": [
        ("standard", ", {best quality}, {amazing quality}"),
        ("none", ""),
    ],
}
QUALITY_PRESETS["nai-diffusion-5-curated"] = QUALITY_PRESETS["nai-diffusion-5-full"]
#: ★V5 Full Medium(Effort: Medium, 2026-10 공홈 신규)도 V5 와 한 case 다 (번들 `b0f9d00`)
QUALITY_PRESETS["nai-diffusion-5-full-medium"] = QUALITY_PRESETS["nai-diffusion-5-full"]
QUALITY_PRESETS["custom"] = QUALITY_PRESETS["nai-diffusion-5-full"]

#: 모델 → **standard 접미사**. 옛 이름을 남긴다 (읽는 쪽이 여럿이다).
QUALITY_SUFFIX = {m: p[0][1] for m, p in QUALITY_PRESETS.items()}

#: 아는 접미사 **전부** — 모델을 모르는 그림에서 퀄리티 태그를 떼어낼 때 쓴다.
ALL_QUALITY_SUFFIXES = tuple(
    dict.fromkeys(s for plist in QUALITY_PRESETS.values() for _id, s in plist if s)
)

#: 퀄리티 태그를 **앞에** 붙이는 옛 모델 (`ed()` 의 `qualityTags`). V3 이후로는 전부 빈 값이라
#: 생성 경로는 안 쓰고, 옛 그림을 읽을 때만 쓴다.
QUALITY_PREFIX = {
    "nai-diffusion-2": "very aesthetic, best quality, absurdres, ",
}

#: ★투명 배경을 켜면 접미사 **앞에** 이것이 끼어든다 (공홈 `rr()`).
#:  퀄리티 프리셋이 none 이어도 이 한 마디는 붙는다.
TRANSPARENT_BG_TAG = "transparent background"

#: UC 프리셋 — **목록의 순서가 곧 공홈 `ucPreset` 인덱스**다 (`eF()`).
#: 마지막은 언제나 none 이고, none 은 nsfw 프리픽스 대상이 아니다.
#: 항목은 `(카테고리, 표시이름, 본문)`. 본문에 `nsfw, ` 는 **넣지 않는다** — 붙이는 규칙이
#: 따로 있다(`resolve_uc`). 예전에는 본문에 박아 두고 다시 떼어내고 있었다.
UC_PRESETS: dict[str, list[tuple[str, str, str]]] = {
    # ★V5 네 모델과 custom 이 **한 목록을 공유**한다 (공홈 `Z$()`).
    #   ★`Light` 본문이 V4.5 의 것과 **전혀 다르다** — 베끼지 말고 이 문자열을 쓸 것.
    "nai-diffusion-5-full": [
        ("heavy", "Heavy", "lowres, artistic error, film grain, scan artifacts, worst quality, bad quality, jpeg artifacts, very displeasing, chromatic aberration, dithering, halftone, screentone, multiple views, logo, too many watermarks, negative space, blank page"),
        ("light", "Light", "lowres, bad hands, bad anatomy, artistic error, sepia, white haze, worst quality, very displeasing, jpeg artifacts, 0::ai-generated::"),
        ("furry", "Furry Focus", "{worst quality}, distracting watermark, unfinished, bad quality, {widescreen}, upscale, {sequence}, {{grandfathered content}}, blurred foreground, chromatic aberration, sketch, everyone, [sketch background], simple, [flat colors], ych (character), outline, multiple scenes, [[horror (theme)]], comic"),
        ("human", "Human Focus", "lowres, artistic error, film grain, scan artifacts, worst quality, bad quality, jpeg artifacts, very displeasing, chromatic aberration, dithering, halftone, screentone, multiple views, logo, too many watermarks, negative space, blank page, @_@, mismatched pupils, glowing eyes, bad anatomy"),
        ("none", "None", ""),
    ],
    "nai-diffusion-4-5-full": [
        ("heavy", "Heavy", "lowres, artistic error, film grain, scan artifacts, worst quality, bad quality, jpeg artifacts, very displeasing, chromatic aberration, dithering, halftone, screentone, multiple views, logo, too many watermarks, negative space, blank page"),
        ("light", "Light", "lowres, artistic error, scan artifacts, worst quality, bad quality, jpeg artifacts, multiple views, very displeasing, too many watermarks, negative space, blank page"),
        ("furry", "Furry Focus", "{worst quality}, distracting watermark, unfinished, bad quality, {widescreen}, upscale, {sequence}, {{grandfathered content}}, blurred foreground, chromatic aberration, sketch, everyone, [sketch background], simple, [flat colors], ych (character), outline, multiple scenes, [[horror (theme)]], comic"),
        ("human", "Human Focus", "lowres, artistic error, film grain, scan artifacts, worst quality, bad quality, jpeg artifacts, very displeasing, chromatic aberration, dithering, halftone, screentone, multiple views, logo, too many watermarks, negative space, blank page, @_@, mismatched pupils, glowing eyes, bad anatomy"),
        ("none", "None", ""),
    ],
    "nai-diffusion-4-5-curated": [
        ("heavy", "Heavy", "blurry, lowres, upscaled, artistic error, film grain, scan artifacts, worst quality, bad quality, jpeg artifacts, very displeasing, chromatic aberration, halftone, multiple views, logo, too many watermarks, negative space, blank page"),
        ("light", "Light", "blurry, lowres, upscaled, artistic error, scan artifacts, jpeg artifacts, logo, too many watermarks, negative space, blank page"),
        ("human", "Human Focus", "blurry, lowres, upscaled, artistic error, film grain, scan artifacts, bad anatomy, bad hands, worst quality, bad quality, jpeg artifacts, very displeasing, chromatic aberration, halftone, multiple views, logo, too many watermarks, @_@, mismatched pupils, glowing eyes, negative space, blank page"),
        ("none", "None", ""),
    ],
}
# ★V4.0 계열도 표에 둔다 — 만들지는 않지만 **읽어야 한다** (위 QUALITY_SUFFIX 와 같은 이유).
#   순서가 곧 그 모델의 `ucPreset` 인덱스다 (공홈 번들 대조 2026-08-19).
UC_PRESETS["nai-diffusion-4-full"] = [
    ("heavy", "Heavy", "blurry, lowres, error, film grain, scan artifacts, worst quality, bad quality, jpeg artifacts, very displeasing, chromatic aberration, multiple views, logo, too many watermarks, white blank page, blank page"),
    ("light", "Light", "blurry, lowres, error, worst quality, bad quality, jpeg artifacts, very displeasing, white blank page, blank page"),
    ("none", "None", ""),
]
UC_PRESETS["nai-diffusion-4-curated-preview"] = [
    ("heavy", "Heavy", "blurry, lowres, error, film grain, scan artifacts, worst quality, bad quality, jpeg artifacts, very displeasing, chromatic aberration, logo, dated, signature, multiple views, gigantic breasts, white blank page, blank page"),
    ("light", "Light", "blurry, lowres, error, worst quality, bad quality, jpeg artifacts, very displeasing, logo, dated, signature, white blank page, blank page"),
    ("none", "None", ""),
]
#: ★V5 Curated 는 Full 과 **같은 목록**이다 (공홈이 한 case 로 묶어 둔다). custom 도 같다.
UC_PRESETS["nai-diffusion-5-curated"] = UC_PRESETS["nai-diffusion-5-full"]
UC_PRESETS["nai-diffusion-5-full-medium"] = UC_PRESETS["nai-diffusion-5-full"]
UC_PRESETS["custom"] = UC_PRESETS["nai-diffusion-5-full"]

#: `tag_hint_qt` · `tag_hint_uc_preset` 이 쓰는 **전역 번호표** (공홈 `Nb()`).
#: ★목록 안의 인덱스가 **아니다.** 모델마다 순서가 달라도 번호는 같다 —
#:  인덱스로 계산하면 조용히 틀린다 (V5 에서 heavy 는 0번째지만 번호는 2다).
TAG_HINT_ID = {
    "none": 0,
    "standard": 1,
    "heavy": 2,
    "light": 3,
    "human": 4,      # humanFocus
    "furry": 5,      # furryFocus
}

#: uc 앞에 `nsfw, ` 를 붙이지 **않는** 모델 (공홈 예외집합 `V`).
#: 실질적으로 V4.5 Full 만 붙는다.
#  ★번들 원본 그대로다 (`V=new Set([...])`). ★**V4 Full 은 여기 없다** — 문서의
#    "실질적으로 V4.5 Full 만 붙는다"를 읽고 V4 Full 을 넣었다가 번들 재확인으로 뺐다.
#    (지금은 V4.0 을 제공하지 않지만, 옛 레코드의 모델 id 가 들어와도 맞아야 한다)
NO_NSFW_PREFIX = {
    "safe-diffusion",
    "safe-diffusion-inpainting",
    "test",
    "custom",
    "nai-diffusion-4-curated-preview",
    "nai-diffusion-4-curated-inpainting",
    "nai-diffusion-4-5-curated",
    "nai-diffusion-4-5-curated-inpainting",
    # ★2026-08-21 재배포에서 **V5 Curated 두 개가 추가**됐다 (공홈 `sg`)
    "nai-diffusion-5-curated",
    "nai-diffusion-5-curated-inpainting",
}

#: 모델을 바꿨을 때 없는 프리셋을 무엇으로 대체하나 (공홈 `eN`)
UC_CATEGORY_FALLBACK = {
    "none": ["none", "light", "heavy"],
    "light": ["light", "none", "heavy"],
    "heavy": ["heavy", "light", "none"],
    "human": ["human", "heavy", "light", "none"],
    "furry": ["furry", "heavy", "light", "none"],
}

#: 인페인트 모델 (공홈 `el()`). ★접미사 규칙으로 만들지 말 것 — 없는 모델 id 가 생긴다
#:  (`nai-diffusion-4-curated-preview` 는 **-preview 가 탈락**한다).
INPAINT_MODEL = {
    "nai-diffusion-5-full": "nai-diffusion-5-full-inpainting",
    "nai-diffusion-5-full-medium": "nai-diffusion-5-full-medium-inpainting",
    # ★★V5 Curated 는 **V4.5 Curated 인페인트로 떨어진다** — 공홈과 같고, **이게 맞다.**
    #   ★결함이 아니다: `nai-diffusion-5-curated-inpainting` 은 **API 에 없는 모델**이다.
    #     실측 2026-08-21 — 그 id 로 쏘면 `400 Validation error: model
    #     nai-diffusion-5-curated-inpainting doesn't exist` 가 온다.
    #     (같은 조건에서 `nai-diffusion-5-full-inpainting` 과 위 V4.5 id 는 200 이다.)
    #   ★★**그러니 V5 Curated 로 인페인트하면 실제로 그리는 것은 V4.5 Curated 다.**
    #     NAI 가 V5 Curated 인페인팅을 내면 그때 이 줄을 바꾼다.
    "nai-diffusion-5-curated": "nai-diffusion-4-5-curated-inpainting",
    "nai-diffusion-4-5-full": "nai-diffusion-4-5-full-inpainting",
    "nai-diffusion-4-5-curated": "nai-diffusion-4-5-curated-inpainting",
    "custom": "custom",
}
INPAINT_MODEL_DEFAULT = "nai-diffusion-4-5-curated-inpainting"

#: 캐릭터 슬롯의 기본 UC (`xp()`) — **V4.0 계열과 custom** 만 값이 있다. V4.5 는 빈 문자열.
#:  (지금은 V4.0 을 제공하지 않아 실질적으로 늘 빈 문자열이다)
CHAR_DEFAULT_UC = {
    "nai-diffusion-4-curated-preview": "lowres, aliasing, ",
    "nai-diffusion-4-full": "lowres, aliasing, ",
    "custom": "lowres, aliasing, ",
}

#: Variety+ 기준 시그마 (`cfgDelaySigma`). 832x1216 이 보정계수 1.0 이 되는 기준.
VARIETY_SIGMA_BASE_V45 = 58
VARIETY_SIGMA_BASE_V4 = 19


# ══ 모델 능력표 ═══════════════════════════════════════════════════════════════════
#
# ★★공홈 `PE(model)` 에서 **우리가 실제로 쓰는 항목만** 추린 것이다 (2026-08-21 대조).
#   정본은 `docs/nai-web-reference.md` 의 「능력표」 절.
#
# ★★**모델 분기를 여기 밖에서 새로 만들지 말 것.** 예전에는 `"diffusion-4" in model` 같은
#   문자열 검사와 `ENHANCE_PROMPT_MODELS` 같은 집합이 파일 곳곳에 흩어져 있었다.
#   V5 가 오면서 「바이브 되나 · 스케줄러 고를 수 있나 · Variety+ 되나」가 전부 갈라졌고,
#   흩어진 검사는 하나씩 고쳐야 해서 **하나를 빠뜨리면 조용히 틀린다.**
#
# ★★화면 쪽 사본은 `src/lib/naiModels.ts` 에 있다 (UI 를 감추는 데 쓴다).
#   언어가 달라 한 벌로 못 두는 대신 **`test_caps_parity.py` 가 두 파일을 대조**한다 —
#   한쪽만 고치면 판정이 깨진다.
_V45 = {
    "vibe": True,            # Vibe Transfer
    "char_ref": True,        # Precise Reference (director_reference_*)
    "noise_schedule": True,  # 스케줄러를 고를 수 있나
    "cfg_rescale": True,
    "cfg_delay": True,       # Variety+ (skip_cfg_above_sigma)
    "transparency": False,   # 투명 배경
    "enhance_prompt_add": True,
    #: 따옴표 → `teXt:` 자동 조립이 걸리나 (공홈 `PE().text`) — V4.0 이상 전부 참, V3 이하 거짓
    "text": True,
    "freeform_position": False,  # 캐릭터 좌표를 격자 밖에 둘 수 있나
    "max_characters": 6,
    "cfg_delay_sigma": VARIETY_SIGMA_BASE_V45,
    "opus_usage_limit": False,   # Opus 무료가 유한한가
    "anlas_multiplier": 1.0,
}
_V5 = {
    **_V45,
    # ★★V5 에서 **꺼진 것들**. 공홈 FAQ: 바이브·정밀 참조는 "post-launch additions".
    "vibe": False,
    "char_ref": False,
    "noise_schedule": False,  # 전송 구간이 karras 로 덮어쓴다
    "cfg_delay": False,       # Variety+ 자체가 없다
    "transparency": True,
    "freeform_position": True,
    "max_characters": 32,     # ★코드값. 공홈 홍보 문구의 "22" 는 마케팅이다
    "opus_usage_limit": True,
    "anlas_multiplier": 1.5,  # ★★같은 해상도·스텝에서 V4.5 의 1.5배
}
for _c in (_V45, _V5):
    _c.setdefault("anlas_step_factor", 1.0)
    _c.setdefault("fixed", None)
#: ★★V5 Full **Medium** (공홈 「Effort: Medium」, 번들 `b0f9d00` 2026-10-12 대조).
#:   V5 Full 과 같고 CFG Rescale 만 없다. 그리고 **설정 몇 개가 고정**이다 (`fixedSettings`):
#:   공홈은 보내기 직전에 스텝·샘플러·UC 프리셋을 덮고, **사용자 UC 와 캐릭터 UC 를 비운다**
#:   (`uc: s3(model, "heavy", prompt, "")` · `characterPrompts[].uc = ""`). `build_payload` 가 같은 일을 한다.
#:   요금은 V5 식의 스텝 항에만 `1/1.06521739` 가 곱해진다 (`anlas_step_factor`).
_V5_MEDIUM = {
    **_V5,
    "cfg_rescale": False,
    "anlas_step_factor": 1 / 1.06521739,
    "fixed": {"steps": 14, "sampler": "k_euler_ancestral", "uc_preset_id": "heavy"},
}
MODEL_CAPS: dict[str, dict] = {
    "nai-diffusion-5-full": _V5,
    "nai-diffusion-5-full-medium": _V5_MEDIUM,
    "nai-diffusion-5-curated": _V5,
    "nai-diffusion-4-5-full": _V45,
    "nai-diffusion-4-5-curated": _V45,
}
#: ★모르는 모델(= 목록에서 뺀 **V4.0 계열**)의 능력. 공홈의 V4.0 행 그대로다 —
#:  V4.5 를 그대로 물려주면 **Enhance 문구가 붙지 않아야 할 모델에 붙고**, Variety+ 시그마도
#:  58 로 나가 CFG 지연 구간이 3배로 길어진다.
CAPS_FALLBACK = {
    **_V45,
    "char_ref": False,
    "enhance_prompt_add": False,
    "cfg_delay_sigma": VARIETY_SIGMA_BASE_V4,
}


def caps(model: str) -> dict:
    """그 모델의 능력. **인페인트 모델도 원본으로 되돌려** 조회한다."""
    return MODEL_CAPS.get(base_model(model), CAPS_FALLBACK)


def is_v5(model: str) -> bool:
    """공홈의 모델 그룹 `Jg(model) === v5` 와 같다 (`custom` 도 v5 그룹이다)."""
    base = base_model(model)
    return base.startswith("nai-diffusion-5") or base == "custom"


def uses_v4_prompt(model: str) -> bool:
    """`v4_prompt`/`characterPrompts` 구조를 쓰는 모델인가 (공홈 `PE().v4Prompts`).

    ★★**`"diffusion-4" in model` 로 판정하지 말 것.** V5 는 그 문자열이 없는데도
      같은 `v4_prompt` 구조를 쓴다 (`v5_prompt` 는 없다). 그 검사로 두면 V5 요청에서
      캐릭터·UC 구조가 통째로 빠져 조용히 다른 그림이 나온다."""
    base = base_model(model)
    return base.startswith("nai-diffusion-4-") or base.startswith("nai-diffusion-5") or base == "custom"


def tag_hint_uc(model: str, preset_name: str) -> int | None:
    """`tag_hint_uc_preset` — **전역 번호표**로 옮긴다 (목록 인덱스가 아니다)."""
    presets = uc_presets(model)
    idx = uc_preset_index(model, preset_name)
    return TAG_HINT_ID.get(presets[idx][0])

# ★공홈은 `text:` 지시가 있으면 덧붙이는 것을 그 **앞에** 넣는다 (퀄리티 접미사·인핸스 문구 모두).
#   뒤에 붙이면 렌더될 문자열 자체가 오염된다.
TEXT_CLAUSE_RE = re.compile(r"(?:^|\s|[,.:\[\]{}、。])text:(?!:)", re.IGNORECASE)

#: Enhance 가 V4.5 계열 프롬프트에 끼워 넣는 문구
ENHANCE_PROMPT_ADD = ", -2::upscaled, blurry::,"


#: 인페인트 모델 → 원본 (공홈 `Fo()`). ★★`INPAINT_MODEL` 을 뒤집어 쓰면 **안 된다** —
#:  V5 Curated 가 V4.5 Curated 인페인트로 떨어지는 바람에 그 표는 **일대일이 아니다**.
#:  뒤집으면 V4.5 Curated 인페인트가 V5 표로 조회돼 프리셋이 통째로 바뀐다.
BASE_MODEL = {
    "nai-diffusion-5-full-inpainting": "nai-diffusion-5-full",
    "nai-diffusion-5-full-medium-inpainting": "nai-diffusion-5-full-medium",
    "nai-diffusion-5-curated-inpainting": "nai-diffusion-5-curated",
    "nai-diffusion-4-5-full-inpainting": "nai-diffusion-4-5-full",
    "nai-diffusion-4-5-curated-inpainting": "nai-diffusion-4-5-curated",
    "nai-diffusion-4-full-inpainting": "nai-diffusion-4-full",
    "nai-diffusion-4-curated-inpainting": "nai-diffusion-4-curated-preview",
}


def base_model(model: str) -> str:
    """인페인트 모델을 원본 모델로 되돌린다 (표 조회용)."""
    return BASE_MODEL.get(model, model)


def quality_presets(model: str) -> list[tuple[str, str]]:
    """그 모델의 퀄리티 프리셋 목록. 모르는 모델은 V4.5 Full 목록으로 본다."""
    return QUALITY_PRESETS.get(base_model(model), QUALITY_PRESETS["nai-diffusion-4-5-full"])


def quality_preset_id(model: str, preset: str) -> str:
    """그 모델에서 실제로 쓸 프리셋 id.

    ★★모델을 바꿔서 **없는 프리셋**이 되면(V5 의 `light` → V4.5) `standard` 로 내린다.
      공홈은 이때 **퀄리티 태그를 통째로 빼 버린다**(`E0` 이 undefined 를 만나 프롬프트를
      그대로 돌려준다) — 켜 둔 채로 조용히 꺼지는 셈이라 그 동작은 따르지 않는다.
      껐던 것(`none`)은 그대로 꺼 둔다."""
    ids = [i for i, _s in quality_presets(model)]
    if preset in ids:
        return preset
    return "none" if preset == "none" else "standard"


def quality_suffix(model: str, preset: str = "standard") -> str:
    """그 모델·그 프리셋의 퀄리티 접미사. ★모르는 모델은 **V4.5 Full 것**으로 본다 —
    `uc_presets` 와 같은 폴백이어야 한다. 옛 레코드가 없어진 모델 id 를 들고 와도
    접미사만 조용히 빠지는 일이 없게."""
    pid = quality_preset_id(model, preset)
    return dict(quality_presets(model)).get(pid, "")


def uc_presets(model: str) -> list[tuple[str, str, str]]:
    """그 모델의 프리셋 목록. 모르는 모델은 V4.5 Full 목록으로 본다."""
    return UC_PRESETS.get(base_model(model), UC_PRESETS["nai-diffusion-4-5-full"])


def uc_preset_index(model: str, preset_name: str) -> int:
    """표시이름 → 공홈 `ucPreset` 인덱스. 그 모델에 없으면 카테고리 폴백표를 태운다.

    ★인덱스는 **모델마다 다르다.** V4.5 Full 의 `Human Focus` 는 3 이고 Curated 는 2 다 —
      한 벌짜리 숫자표를 쓰던 때는 둘 다 2 로 나갔고, `Furry Focus` 는 표에 없어
      0(Heavy)으로 떨어졌다."""
    presets = uc_presets(model)
    for i, (_cat, name, _text) in enumerate(presets):
        if name == preset_name:
            return i
    src_cat = None
    for plist in UC_PRESETS.values():
        for cat, name, _text in plist:
            if name == preset_name:
                src_cat = cat
                break
        if src_cat:
            break
    for cat in UC_CATEGORY_FALLBACK.get(src_cat or "none", ["none"]):
        for i, (c, _n, _t) in enumerate(presets):
            if c == cat:
                return i
    return len(presets) - 1  # 마지막 = none


#: 우리 표의 **카테고리** → 공홈의 프리셋 **id** (`ucPresetId` 로 나가는 값).
#: ★우리는 카테고리를 `human`·`furry` 로 줄여 쓴다 — 공홈 id 는 `humanFocus`·`furryFocus` 다.
UC_PRESET_ID = {
    "heavy": "heavy",
    "light": "light",
    "human": "humanFocus",
    "furry": "furryFocus",
    "none": "none",
}


def uc_preset_name(model: str, pid: str) -> str:
    """공홈 `ucPresetId` → **그 모델 목록의 표시이름** (`uc_preset_id` 의 역).

    ★모델마다 목록이 다르므로 이름도 모델로 풀어야 한다 (V4.5 Curated 에는 Furry Focus 가 없다).
    ★모르는 id 는 마지막(none)의 이름으로 — 없는 프리셋을 켜 두는 것보다 안전하다."""
    cat = next((c for c, i in UC_PRESET_ID.items() if i == pid), "none")
    plist = uc_presets(model)
    return next((name for c, name, _t in plist if c == cat), plist[-1][1])


def uc_preset_id(model: str, preset_name: str) -> str:
    """표시이름 → 공홈 `ucPresetId`. 그 모델에 없으면 인덱스와 **같은 폴백**을 탄다."""
    presets = uc_presets(model)
    cat = presets[uc_preset_index(model, preset_name)][0]
    return UC_PRESET_ID.get(cat, "none")


def append_prompt(prompt: str, addition: str) -> str:
    """`text:` 절이 있으면 그 앞에, 없으면 맨 뒤에 붙인다.

    ★★프롬프트에 `|` 가 있으면 **첫 조각에만** 붙인다 (사용자 결정 2026-08-29: *"공홈이랑
      똑같게"*). 공홈은 `|` 로 나뉜 프롬프트에서 덧붙이는 것(퀄리티 접미사·인핸스 문구)을
      첫 조각에 넣는다 — UC 프리셋 본문도 같은 자리다(번들 `_app` 오프셋 1025550 의
      `split("|")` 후 첫 조각, 접미사는 1362604). 우리는 끝에 붙여서, `|` 가 든 프롬프트에서만
      마지막 조각 뒤로 가는 차이가 있었다. `|` 를 캐릭터로 쪼개는 코드는 공홈에도 없다 —
      `base_caption` 에 그대로 실린다."""
    prompt = prompt or ""
    head, sep, tail = prompt.partition("|")
    m = TEXT_CLAUSE_RE.search(head)
    if m:
        head = head[: m.start()] + addition + head[m.start():]
    else:
        head = head + addition
    return head + sep + tail


def resolve_uc(model: str, preset_name: str, prompt: str, user_negative: str) -> str:
    """공홈 `J()` 와 같은 순서로 최종 uc 를 만든다.

    ★`nsfw, ` 는 프리셋이 none 이 아니고 · 모델이 예외집합에 없고 · **베이스 프롬프트**에
      `nsfw` 가 없을 때만 맨 앞에 붙는다. 검사 대상은 **퀄리티 태그가 붙은 베이스 프롬프트
      하나뿐**이고(캐릭터 슬롯은 안 본다), 매칭도 단어 경계가 아니라 **단순 부분문자열**이다."""
    presets = uc_presets(model)
    idx = uc_preset_index(model, preset_name)
    text = presets[idx][2]
    is_none = idx == len(presets) - 1

    if text and model not in NO_NSFW_PREFIX and "nsfw" not in (prompt or "").lower():
        text = "nsfw, " + text

    if user_negative:
        if is_none:
            return user_negative
        return (text + ", " + user_negative) if text else user_negative
    return text


#: 캐릭터 좌표 격자 (공홈 `$n()` 이 쓰는 눈금)
CENTER_GRID = (0.1, 0.3, 0.5, 0.7, 0.9)


def snap_center(center: dict) -> dict:
    """좌표를 5×5 격자로 스냅한다 (공홈 `$n()` 그대로: `u[min(4, max(0, floor(5v)))]`)."""

    def q(v: float) -> float:
        return CENTER_GRID[min(4, max(0, int(math.floor(5 * float(v)))))]

    return {"x": q(center.get("x", 0.5)), "y": q(center.get("y", 0.5))}


def align64(v: int) -> int:
    """★가까운 쪽으로 **반올림**이다 (올림이 아니다 — 공홈 `K()`). 동률이면 큰 쪽.

    ★올림으로 두면 800 이 832 가 되어(공홈은 768) **없던 Anlas 를 쓰고** 그림도 달라진다.
    ★공통 전송 구간에서 걸리므로 txt2img 뿐 아니라 **Enhance·img2img·인페인트 전부**
      여기를 지난다. 비용도 정렬된 해상도로 세야 표시와 청구가 맞는다."""
    lo = math.floor(v / 64) * 64
    hi = math.ceil(v / 64) * 64
    r = lo if (v - lo < hi - v) else hi
    return 64 if r <= 0 else int(r)


@dataclass
class CharPrompt:
    prompt: str = ""
    uc: str = ""
    center: dict = field(default_factory=lambda: {"x": 0.5, "y": 0.5})
    use_coord: bool = False


@dataclass
class GenRequest:
    prompt: str = ""
    negative_prompt: str = ""
    model: str = "nai-diffusion-5-full"
    width: int = 832
    height: int = 1216
    steps: int = 28
    cfg: float = 5.0
    cfg_rescale: float = 0.0
    sampler: str = "k_euler_ancestral"
    scheduler: str = "karras"
    seed: int = -1
    uc_preset: str = "Heavy"
    #: 퀄리티 프리셋 **id** — `"standard"` / `"light"`(V5·custom) / `"none"`.
    #: ★예전에는 `quality_tags: bool` 이었다. 공홈이 목록으로 바뀌어 우리도 맞추었다
    #: (2026-08-21). 보내는 쪽은 `server.GenBody` 가 옛 필드도 받아 옮겨 준다.
    quality_preset: str = "standard"
    variety_plus: bool = False
    #: 프롬프트 앞에 `fur dataset, ` 를 붙인다 (v2 backend.py:1326)
    furry_mode: bool = False
    characters: list[CharPrompt] = field(default_factory=list)
    #: ★이 요청이 Enhance 인가 — V4.5 계열 프롬프트에 `-2::upscaled, blurry::` 를 끼운다.
    #:  강화는 별도 경로가 아니라 **i2i 의 프리셋**이라, 조립은 여기 한 곳에서 한다.
    enhance: bool = False
    #: ★vibe 강도 정규화는 **사용자 토글**이다 (공홈 기본 켜짐, V4+ 에서만 노출).
    #:  하드코딩하지 말 것 — 끄면 값을 그대로 보내야 한다.
    normalize_reference_strength: bool = True
    #: 투명 배경 (V5 전용). 켜면 프롬프트에 `transparent background` 가 붙고
    #: `tag_hint_transparent_background` 가 실린다.
    transparent_bg: bool = False
    #: 투명 배경의 알파 모드 — True=Straight / False=Premultiplied.
    #: ★공홈 기본값이 **Straight(true)** 다 (`imageStraightAlpha:!0`).
    straight_alpha: bool = True

    # ── 이미지 입력 (5단계) ──
    #: Vibe Transfer. 각 항목 `{image, info_extracted, strength, name, encoded, encoded_model,
    #: encoded_info_extracted}`. `encoded*` 는 앞선 생성이 채워 준 것으로, 재사용 판정에 쓴다.
    vibe_transfer: list[dict] = field(default_factory=list)
    #: Precise Reference (V4.5). 각 항목 `{image, mode, strength, fidelity}`.
    precise_references: list[dict] = field(default_factory=list)
    #: i2i / 인페인트의 바탕 그림 (base64)
    base_image: str = ""
    #: `"img2img"` 또는 `"inpaint"`
    base_mode: str = "img2img"
    #: img2img 슬라이더 값. ★인페인트에서도 **이 값이 `strength` 로 그대로 나간다**
    base_strength: float = 0.7
    #: ★인페인트 슬라이더는 **`inpaintImg2ImgStrength` 하나에만** 실린다 (7절).
    #:  기본 1 이고, 1 이면 `img2img` 필드가 아예 없다(= 마스크 영역 완전 재생성).
    base_inpaint_strength: float = 1.0
    base_noise: float = 0.0
    #: 인페인트 마스크 (base64). 흰 부분이 다시 그려진다
    base_mask: str = ""


def build_payload(req: GenRequest) -> dict:
    """NAI 요청 페이로드를 조립한다. 실제 생성 여부와 무관하게 단위 검증이 가능하도록 분리."""
    cap = caps(req.model)
    # ★★고정 설정 모델(V5 Full Medium)은 **공홈처럼 보내기 직전에 덮는다** (`_V5_MEDIUM` 의 ★★주).
    #   사용자가 적은 UC·캐릭터 UC 는 나가지 않고 프리셋 본문만 나간다. 받은 요청은 고치지 않는다(사본).
    fixed = cap.get("fixed")
    if fixed:
        req = dataclasses.replace(
            req,
            steps=fixed["steps"],
            sampler=fixed["sampler"],
            uc_preset=uc_preset_name(req.model, fixed["uc_preset_id"]),
            negative_prompt="",
            characters=[dataclasses.replace(c, uc="") for c in req.characters],
        )
    if not cap["cfg_rescale"]:
        req = dataclasses.replace(req, cfg_rescale=0.0)
    # ★그 모델에 없는 프리셋이면 내려준다 (`quality_preset_id` 주석)
    quality_pid = quality_preset_id(req.model, req.quality_preset)
    # ★★`"diffusion-4" in model` 이었다 — V5 가 그 검사를 통과하지 못한다 (`uses_v4_prompt` 주석)
    is_v4 = uses_v4_prompt(req.model)
    seed = req.seed if req.seed >= 0 else random.randint(0, 2**31 - 1)

    # ★Furry 모드는 **퀄리티 태그보다 먼저** 앞에 붙는다 (v2 backend.py:1326 순서 그대로).
    #   순서가 바뀌면 프롬프트 문자열이 달라지고 곧 결과가 달라진다.
    prompt_for_nai = f"fur dataset, {req.prompt}" if req.furry_mode else req.prompt
    negative_for_nai = req.negative_prompt
    # 투명 배경은 그 모델이 지원할 때만 (`PE().transparency`)
    transparent = req.transparent_bg and cap["transparency"]

    if is_v4:
        # ★퀄리티 접미사는 **모델마다 다르다**. `text:` 절이 있으면 그 앞에 넣는다.
        #   ★투명 배경을 켜면 접미사 **앞에** `transparent background, ` 가 끼어들고,
        #     퀄리티 태그를 껐어도 그 한 마디는 붙는다 (공홈 `rr()` + `E0()`).
        suffix = quality_suffix(req.model, req.quality_preset)
        if transparent:
            suffix = ", " + TRANSPARENT_BG_TAG + (suffix or "")
        if suffix:
            prompt_for_nai = append_prompt(prompt_for_nai, suffix)
        # ★Enhance 는 접미사 **뒤**에 자기 문구를 끼운다 (공홈 순서)
        if req.enhance and cap["enhance_prompt_add"]:
            if "upscaled, blurry" not in prompt_for_nai:
                prompt_for_nai = append_prompt(prompt_for_nai, ENHANCE_PROMPT_ADD)

        # ★uc 는 `resolve_uc` 하나가 만든다 — 프리셋 본문·인덱스·nsfw 규칙이 전부 모델에 달렸다.
        #   ★nsfw 검사 대상은 **퀄리티 태그가 붙은 베이스 프롬프트 하나**다 (캐릭터는 안 본다).
        negative_for_nai = resolve_uc(
            req.model, req.uc_preset, prompt_for_nai, req.negative_prompt
        )

    # ★빈 슬롯은 보내지 않는다 (공통 전송 구간이 지운다). 슬롯이 비어 있는데 보내면
    #   캐릭터 수만 늘어나 구도가 달라진다.
    chars = [c for c in req.characters if (c.prompt or "").strip()]
    # ★★**그 모델이 받는 수까지만 보낸다** (공홈 `PE().maxCharacters` — V4.5 6 · V5 32).
    #
    #   실측 2026-08-21 (Opus 무료 구간이라 값은 안 들었다):
    #     V4.5 Full 에 7개  -> **HTTP 500 Internal Server Error**
    #     V5   Full 에 33개 -> HTTP 200 (그림이 나왔다)
    #   즉 V4.5 는 넘기면 **서버가 깨지고**, 사용자는 까닭을 알 수 없는 「서버 오류」만 본다.
    #   V5 의 32 는 API 상한이 아니라 **공홈 UI 상한**이지만 그대로 맞춘다 — 공홈이 안 보내는
    #   것을 우리가 보내면 같은 조건으로 견줄 수가 없다.
    #
    #   ★★**칸을 추가하는 것은 막지 않는다** (v2 와 같다 — 사용자 결정 2026-08-21).
    #     담아 두는 것과 보내는 것은 다른 일이다. 몇 개가 잘리는지는 화면이 미리 알린다
    #     (`GenerateFooter` 의 `overChars`).
    char_limit = cap["max_characters"]
    if len(chars) > char_limit:
        print(f"[NAI] 캐릭터 {len(chars)}개 중 {char_limit}개만 보냅니다 — {req.model} 상한")
        chars = chars[:char_limit]
    use_coords = any(c.use_coord for c in chars)

    # ★★따옴표 → `teXt:` **자동 조립** (`naitext.py` 머리 주석).
    #   ★붙는 자리가 **맨 마지막**이다 — 퀄리티 접미사·Enhance 문구·uc 해결이 다 끝난 뒤다
    #     (공홈 순서). 그래서 nsfw 판정도 uc 도 이 문구를 안 본다.
    #   ★그 모델의 `text` 능력으로 건다 — V3 이하에서는 안 붙는다.
    if cap["text"]:
        prompt_for_nai = naitext.build(
            prompt_for_nai,
            [{"prompt": c.prompt, "center": c.center} for c in chars],
            use_coords,
        )

    # ★64 정렬 — **가까운 쪽 반올림**이다 (올림 아님). `align64` 주석 참조.
    width = align64(req.width)
    height = align64(req.height)

    # ★★스케줄러를 못 고르는 모델은 **여기서 값이 정해진다** (공홈 전송 구간).
    #   V5 는 `noise_schedule` 이 언제나 karras 다 — 화면에서 무엇을 골랐든 덮어쓴다.
    #   그래서 화면에서도 스케줄러 칸을 감춘다 (`src/lib/naiModels.ts`).
    scheduler = req.scheduler if cap["noise_schedule"] else "karras"

    params: dict = {
        # ★★3 → 4 (2026-08-21). 공홈이 `ucPreset`·`qualityToggle` 을 지우고
        #   `ucPresetId`·`qualityPresetId` 로 옮기면서 올렸다. 서버가 되돌려 주는
        #   메타데이터에는 이 값이 없다 — 클라이언트 쪽 마이그레이션 표식이다.
        "params_version": 4,
        "width": width,
        "height": height,
        "scale": req.cfg,
        "sampler": req.sampler,
        "steps": req.steps,
        "seed": int(seed),
        "n_samples": 1,
        # ★공홈이 지금 보내는 것은 **문자 id** 다. 옛 숫자 필드도 함께 보낸다 —
        #   API 가 아직 옛 모양을 받고 있고(우리 앱이 그것으로 돌고 있다), 새 필드만 보내
        #   조용히 무시당하는 쪽이 더 위험하다. 실연동으로 확인되면 한쪽을 뺀다.
        "ucPreset": uc_preset_index(req.model, req.uc_preset),
        "ucPresetId": uc_preset_id(req.model, req.uc_preset),
        "qualityToggle": quality_pid != "none",
        "qualityPresetId": quality_pid,
        "dynamic_thresholding": False,
        "controlnet_strength": 1.0,
        "legacy": False,
        "add_original_image": True,
        "cfg_rescale": req.cfg_rescale,
        "noise_schedule": scheduler,
        "legacy_v3_extend": False,
        # ★`uncond_scale` 은 **보내지 않는다** — 공홈이 params_version 2 승격 때 이 키를
        #   지웠고(`delete r.uncond_scale`) V4 기본 파라미터에도 없다.
        "negative_prompt": negative_for_nai,
        "prompt": prompt_for_nai,
        # ★`extra_noise_seed` 도 여기 두지 않는다 — 공홈은 **베이스 이미지가 있을 때만**
        #   넣고, 값은 `seed - 1` 이다 (아래 i2i 절). 클램프도 없다.
        "normalize_reference_strength_multiple": req.normalize_reference_strength,
        # ★**언제나 실리는 값**이다 (10절) — 예전에는 i2i·인페인트 분기 안에서만 넣어서
        #   txt2img 요청에는 빠져 있었다
        "image_format": "png",
        "inpaintImg2ImgStrength": 1,
        "legacy_uc": False,
    }

    # ★★`tag_hint_*` — 프리셋 이름을 **전역 번호표**로 옮겨 함께 보낸다 (2026-08-21 신규).
    #   서버 기록(공홈 갤러리 76건)에 전부 들어 있으므로 서버가 실제로 읽는 값이다.
    #   ★번호는 목록 인덱스가 아니다 (`TAG_HINT_ID` 주석).
    qt_hint = TAG_HINT_ID[quality_pid]
    uc_hint = tag_hint_uc(req.model, req.uc_preset)
    params["tag_hint_qt"] = qt_hint
    if uc_hint is not None:
        params["tag_hint_uc_preset"] = uc_hint
    if transparent:
        # ★그 모델이 투명 배경을 지원할 때만 싣는다 (공홈 전송 구간이 아니면 지운다)
        params["tag_hint_transparent_background"] = True
        params["straight_alpha"] = req.straight_alpha

    if is_v4:
        # V4+ 는 sm/sm_dyn 대신 autoSmea (웹과 동일). V3 경로는 아직 옮기지 않았다.
        # ★SMEA 선택 UI 는 **일부러 안 만든다** — v2 에도 있지만 죽은 컨트롤이다.
        #   v2 가 제공하는 모델 3종이 전부 `diffusion-4` 라 `sm`·`sm_dyn` 이 항상 False 였다
        #   (v2 backend.py:1316). V3 모델을 되살릴 때 함께 꺼낸다.
        params["autoSmea"] = False

    # ★캐릭터 슬롯의 기본 UC 는 모델마다 다르다 (`xp()`) — V4.0 계열만 값이 있다
    #   (`chars`·`use_coords` 는 위 `teXt:` 조립이 이미 골라 뒀다 — 규칙이 둘이면 갈린다)
    char_uc_default = CHAR_DEFAULT_UC.get(req.model, "")
    for c in chars:
        if not (c.uc or "").strip():
            c.uc = char_uc_default
    params["use_coords"] = use_coords
    # ★★자유 배치를 못 하는 모델은 좌표를 **격자로 스냅해서** 보낸다 (공홈 `$n()`).
    #   공홈은 옛날엔 격자값만 만들 수 있어 스냅이 필요 없었는데, 자유 배치 UI 가 생기면서
    #   전송 직전 스냅이 붙었다. 우리가 임의 좌표를 넣게 되면 여기서 갈린다.
    #   ★스냅이 걸리는 곳은 **`v4_prompt` 쪽 `centers` 뿐**이다 — `characterPrompts[].center`
    #     는 공홈도 **날것 그대로** 보낸다. 둘을 같게 맞추지 말 것.
    place = (lambda c: c) if cap["freeform_position"] else snap_center
    centers = [place(c.center) for c in chars]
    params["characterPrompts"] = [
        {"prompt": c.prompt, "uc": c.uc, "center": c.center, "enabled": True} for c in chars
    ]
    params["v4_prompt"] = {
        "use_coords": use_coords,
        "use_order": True,
        "caption": {
            "base_caption": prompt_for_nai,
            "char_captions": [
                {"char_caption": c.prompt, "centers": [ctr]} for c, ctr in zip(chars, centers)
            ],
        },
    }
    params["v4_negative_prompt"] = {
        "legacy_uc": False,
        "caption": {
            "base_caption": negative_for_nai,
            "char_captions": [
                {"char_caption": c.uc, "centers": [ctr]} for c, ctr in zip(chars, centers)
            ],
        },
    }

    # ── Vibe Transfer (v2 backend.py:1479-1542) ──
    #   ★여기서는 **인코딩하지 않는다.** 인코딩은 유료 네트워크 호출이라 조립 밖에 있다
    #     (`encode_vibes`). 여기 오는 항목은 이미 `encoded` 가 채워져 있거나 V3 원본이다.
    # ★★그 모델이 바이브를 지원할 때만 싣는다 (`PE().vibetransfer`). V5 는 **거짓**이다 —
    #   화면에서 절을 감추지만, 모델을 바꾸기 전에 담아 둔 것이 남아 있을 수 있어 여기서도 막는다.
    if req.vibe_transfer and cap["vibe"]:
        images: list[str] = []
        infos: list[int | float] = []
        strengths: list[float] = []
        for v in req.vibe_transfer:
            info = v.get("info_extracted", 1.0)
            if is_v4:
                images.append(v["encoded"])
            else:
                # V3 는 사전 인코딩이 없다 — 원본 그림을 그대로 보낸다
                images.append(imgutil.ensure_png_base64(v["image"]))
            # ★NAI 는 정수 값을 정수로 받는다 (1.0 -> 1)
            infos.append(vibe_mod.as_nai_number(info))
            strengths.append(v.get("strength", 0.6))
        # ★정규화는 **클라이언트가** 한다 (사용자 토글 · 기본 켜짐). 2장 이상이고 합이 1을
        #   넘을 때만 각 값을 합으로 나눈다 — 서버가 알아서 해 주지 않는다.
        if req.normalize_reference_strength and len(strengths) > 1:
            total = sum(strengths)
            if total > 1:
                strengths = [s / total for s in strengths]
        params["reference_image_multiple"] = images
        # ★V4+ 경로는 **IE 배열을 보내지 않는다** — 정보량은 인코딩에 이미 구워져 있다.
        #   V3 레거시 경로만 함께 보낸다.
        if not is_v4:
            params["reference_information_extracted_multiple"] = infos
        params["reference_strength_multiple"] = strengths

    # ── Precise Reference (V4.5, v2 backend.py:1544-1593) ──
    #   ★전부 웹 캡처로 맞춘 값이다: secondary = 1 - fidelity 반전 · round(...,2) ·
    #     information_extracted 는 **항상 1** · mode 를 `base_caption` 에 넣는 구조.
    #   ★★그 모델이 지원할 때만 싣는다 (`PE().characterReferences`). V5 는 **거짓**이다.
    refs = [r for r in req.precise_references if r.get("image")] if cap["char_ref"] else []
    if refs:
        params["director_reference_images"] = [r["image"] for r in refs]
        params["director_reference_information_extracted"] = [1 for _ in refs]
        params["director_reference_strength_values"] = [r.get("strength", 1.0) for r in refs]
        params["director_reference_secondary_strength_values"] = [
            round(1.0 - r.get("fidelity", 1.0), 2) for r in refs
        ]
        params["director_reference_descriptions"] = [
            {
                "caption": {"base_caption": r.get("mode", "character&style"), "char_captions": []},
                "legacy_uc": False,
            }
            for r in refs
        ]

    # ★★Variety+ 는 `cfgDelay` 능력이 있는 모델만이다 — **V5 에는 없다**
    #   (공홈 전송 구간이 `PE(m).cfgDelay || delete skip_cfg_above_sigma`).
    #   화면에서도 체크박스를 감춘다.
    if req.variety_plus and cap["cfg_delay"]:
        # ★해상도로 보정한다 — 19 고정으로 보내면 V4.5 에서 CFG 지연 구간이 3배 짧아져
        #   Variety+ 가 거의 안 걸린다. 832x1216 이 보정계수 정확히 1.0 이다.
        params["skip_cfg_above_sigma"] = cap["cfg_delay_sigma"] * math.sqrt(
            (width // 8) * (height // 8) / 15808
        )

    # k_euler_ancestral + non-native scheduler 조합에서 필수
    if req.sampler == "k_euler_ancestral" and scheduler != "native":
        params["deliberate_euler_ancestral_bug"] = False
        params["prefer_brownian"] = True

    # ── i2i / 인페인트 (v2 backend.py:1626-1700) ──
    action = "generate"
    model = req.model
    if req.base_image:
        # ★**요청 해상도로 우리가 리샘플해 보낸다** — 서버 리사이즈에 맡기면 필터가 달라
        #   초기 latent 가 어긋난다 (`imgutil.preprocess_base_image` 주석).
        #   ★Enhance 도 여기를 지난다: `generateEnhance` 는 width/height 만 키우고,
        #     공통 전송 구간이 그 크기로 그림을 리샘플한다.
        params["image"] = imgutil.preprocess_base_image(req.base_image, width, height)
        params["strength"] = req.base_strength
        # ★`extra_noise_seed` 는 **이미지가 있을 때만**, 값은 `seed - 1` 이다.
        #   클램프가 없어 시드 0 이면 -1 이 그대로 나간다 (공홈과 같다).
        params["extra_noise_seed"] = int(seed) - 1

        if req.base_mode == "inpaint" and req.base_mask:
            action = "infill"
            # ★공홈 마스크는 **8px 블록**이다 (7절). 1px 단위로 보내면 같은 마스크로도
            #   다른 그림이 나온다. 크기는 **정렬된** 요청 해상도로 맞춘다.
            params["mask"] = imgutil.quantize_mask_8px(req.base_mask, width, height)

            # ★★여기부터는 NAI 웹의 실제 인페인트 요청을 캡처해 맞춘 것이다.
            #   세 줄이 각각 **다른 버그를 고친 흔적**이라, "중복이니 하나로" 하면
            #   강도 슬라이더가 통째로 무효가 되거나 솔기가 돌아온다:
            #     · request_type 미전송 — "NativeInfillingRequest" 는 마스크 영역을
            #       강도와 무관하게 완전 재생성시켜 강도를 무효화했다
            #     · add_original_image=False — 웹이 false 다 (우리는 True 로 보내고 있었다)
            #
            # ★강도 배치 (2026-08-12 번들 재확인 — "세 곳에 다 넣는다"는 틀렸다):
            #   **인페인트 슬라이더는 `inpaintImg2ImgStrength` 하나에만** 실린다. 기본 1 이고,
            #   1 이면 `img2img` 필드가 아예 없다(= 마스크 영역 완전 재생성).
            #   `strength` 는 별개로, **img2img 슬라이더 값**(기본 0.7)이 그대로 나간다.
            params.pop("request_type", None)
            params["add_original_image"] = False
            params["strength"] = req.base_strength
            params["inpaintImg2ImgStrength"] = req.base_inpaint_strength
            if req.base_inpaint_strength != 1:
                params["img2img"] = {
                    "strength": req.base_inpaint_strength,
                    "color_correct": True,
                }
            else:
                params.pop("img2img", None)
            params["noise"] = 0
            # 웹은 V3 SMEA(sm/sm_dyn) 대신 autoSmea:false 를 쓴다
            params.pop("sm", None)
            params.pop("sm_dyn", None)
            params["autoSmea"] = False
            params["deliberate_euler_ancestral_bug"] = False
            params["prefer_brownian"] = True

            # ★인페인트는 vibe 를 지원하지 않는다 (Precise Reference 는 지원한다)
            for k in (
                "reference_image_multiple",
                "reference_information_extracted_multiple",
                "reference_strength_multiple",
            ):
                params.pop(k, None)

            # ★인페인트 전용 모델은 **표로** 고른다 — 접미사 규칙으로 만들면 없는 id 가 생긴다
            #   (`nai-diffusion-4-curated-preview` 는 -preview 가 탈락한다).
            if not model.endswith("-inpainting"):
                model = INPAINT_MODEL.get(model, INPAINT_MODEL_DEFAULT)
        else:
            action = "img2img"
            params["noise"] = req.base_noise
            # ★공홈은 action 이 img2img 면 최상위 `color_correct=false` 를 붙인다
            params["color_correct"] = False

    return {
        "input": prompt_for_nai,
        "model": model,
        "action": action,
        # ★공홈이 최상위에 늘 싣는 값이다 (`docs/nai-web-reference.md` 1절 최상위 본문).
        #   v2 대조에서 **우리만 빠져 있었다** (2026-08-12).
        "use_new_shared_trial": True,
        "parameters": params,
    }


async def encode_vibes(req: GenRequest, token: str, cache: vibe_mod.VibeCache) -> None:
    """V4+ vibe 를 미리 굽는다 — **조립 전에** 부른다 (v2 backend.py:1489-1526).

    ★유료 호출이다. 이미 구워 둔 것이 있고 모델·info 가 맞으면 **건드리지 않는다.**
      판정은 `vibe.reuse_ok` 하나가 한다 (인페인트 접미어 제거·0.001 오차 포함)."""
    # ★★바이브를 지원하지 않는 모델(V5)에서는 **굽지 않는다** — 인코딩은 개당 2 Anlas 라
    #   조립에서 버릴 것을 여기서 사면 돈만 나간다. 옛 검사는 `"diffusion-4" not in model` 이었다.
    if not req.vibe_transfer or not caps(req.model)["vibe"]:
        return
    for i, v in enumerate(req.vibe_transfer):
        info = v.get("info_extracted", 1.0)
        if vibe_mod.reuse_ok(v, req.model, info):
            continue
        png = imgutil.ensure_png_base64(v["image"])
        v["encoded"] = await vibe_mod.encode(
            png, req.model, info, v.get("strength", 0.6), token, cache,
            v.get("name", f"vibe_{i + 1}"),
        )
        v["encoded_model"] = req.model
        v["encoded_info_extracted"] = info


async def generate_with_payload(payload: dict, token: str) -> tuple[bytes, int]:
    """이미 조립된 페이로드로 생성한다.

    ★조립(build_payload)과 전송을 나눈 이유: **records.jsonl 에 그 시점의 완전한 요청을
      그대로 남기기 위해서**다. 나중에 spec 이 바뀌어도 재현·비교가 가능해진다."""
    if not token:
        raise RuntimeError("NAI 토큰이 설정되지 않았습니다.")

    seed = payload["parameters"]["seed"]
    headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}
    async with httpx.AsyncClient(timeout=120) as client:
        res = await client.post(NAI_ENDPOINT, headers=headers, json=payload)
        if res.status_code != 200:
            raise RuntimeError(f"NAI API {res.status_code}: {res.text[:500]}")

        # 응답은 이미지 한 장이 든 zip 이다.
        with zipfile.ZipFile(io.BytesIO(res.content)) as zf:
            return zf.read(zf.namelist()[0]), seed


#: ★★**스트리밍 엔드포인트** — 평범한 생성과 **주소가 다르다** (공홈 번들 실측 2026-08-26:
#   `/ai/generate-image-stream`). 여기로 보내면서 `parameters.stream = "msgpack"` 을 얹으면
#   중간 그림이 흘러온다.
STREAM_ENDPOINT = "https://image.novelai.net/ai/generate-image-stream"

#: ★앞 몇 스텝은 버린다 — 공홈도 그렇게 한다 (`5 * !rawIntermediates`). 초반 몇 장은
#  형태가 안 잡힌 잡음이라, 보여 주면 「망했나」로 읽힌다.
STREAM_SKIP_STEPS = 5


async def generate_streaming(
    payload: dict,
    token: str,
    on_step: Callable[[bytes, int], Awaitable[None]] | None = None,
) -> tuple[bytes, int]:
    """생성하면서 **중간 그림을 흘려준다** (사용자 지시 2026-08-26).

    ★★규격은 공홈 번들에서 그대로 읽었다 (`reference/nai-web-2026-08-21`):
      · 주소가 다르다 (`/ai/generate-image-stream`) · `parameters.stream = "msgpack"`
      · 몸통은 **길이 접두 msgpack 프레임**의 연속이다:
          `4바이트 빅엔디언 길이` + 그만큼의 msgpack 맵
      · 맵의 `event_type` 이 셋이다
          `intermediate` → `image`(바이트) · `samp_ix` · `step_ix`
          `final`        → `image` · `samp_ix`
          `error`        → `message` · `samp_ix`
      · `step_ix` 가 되돌아가는 프레임은 **버린다** (순서가 뒤집혀 오는 일이 있다)

    ★**끝 그림은 zip 이 아니라 이미지 바이트 그대로** 온다 — 평범한 경로(zip)와 다르다.
    ★중간 그림을 흘리다 실패해도 생성 자체는 이어 간다 (`on_step` 의 예외를 삼킨다) —
      미리보기 때문에 그림을 잃으면 안 된다.
    """
    if not token:
        raise RuntimeError("NAI 토큰이 설정되지 않았습니다.")
    # ★C 확장(`_cmsgpack.pyd`)은 서명이 없어 윈도우 스마트 앱 컨트롤이 막고 「이 앱의 일부가
    #  차단되었습니다」 알림을 띄운다 (유저 제보 2026-11-10). 막혀도 msgpack 이 순수 파이썬으로
    #  넘어가 동작은 같으므로 처음부터 순수 파이썬을 쓴다 (1MB 프레임 하나에 1ms 쯤).
    os.environ.setdefault("MSGPACK_PUREPYTHON", "1")
    import msgpack

    body = json.loads(json.dumps(payload))          # 원본을 안 건드린다 (기록에 남는 것이다)
    body.setdefault("parameters", {})["stream"] = "msgpack"
    seed = body["parameters"]["seed"]
    headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}

    buf = bytearray()
    best: dict[int, int] = {}                        # samp_ix → 지금까지 본 가장 늦은 step
    final: bytes | None = None
    async with httpx.AsyncClient(timeout=300) as client:
        async with client.stream("POST", STREAM_ENDPOINT, headers=headers, json=body) as res:
            if res.status_code != 200:
                raw = await res.aread()
                raise RuntimeError(f"NAI API {res.status_code}: {raw[:500].decode('utf-8', 'replace')}")
            async for chunk in res.aiter_bytes():
                buf += chunk
                while len(buf) >= 4:
                    size = int.from_bytes(buf[:4], "big")
                    if len(buf) < 4 + size:
                        break
                    frame, buf[:] = buf[4:4 + size], buf[4 + size:]
                    try:
                        ev = msgpack.unpackb(bytes(frame), raw=False)
                    except Exception as e:
                        print(f"[nai] 스트림 프레임을 못 읽었습니다 (건너뜀): {e}")
                        continue
                    kind = ev.get("event_type")
                    if kind == "error":
                        raise RuntimeError(f"NAI 스트림 오류: {ev.get('message')}")
                    if kind == "final":
                        final = bytes(ev.get("image") or b"")
                    elif kind == "intermediate" and on_step:
                        ix, step = int(ev.get("samp_ix", 0)), int(ev.get("step_ix", 0))
                        if step < STREAM_SKIP_STEPS or step <= best.get(ix, -1):
                            continue          # 초반 잡음이거나 뒤집혀 온 프레임
                        best[ix] = step
                        try:
                            await on_step(bytes(ev.get("image") or b""), step)
                        except Exception as e:
                            print(f"[nai] 중간 그림 전달 실패 (무시): {e}")
    if not final:
        raise RuntimeError("NAI 스트림이 끝 그림 없이 닫혔습니다.")
    return final, seed


async def generate(req: GenRequest, token: str) -> tuple[bytes, int]:
    """조립 + 전송을 한 번에 (단순 호출용)."""
    return await generate_with_payload(build_payload(req), token)


# ── 업스케일 ──────────────────────────────────────────────────────
def upscale_cost(width: int, height: int, tier: int = 0, active: bool = False) -> int:
    """이 그림을 키우는 값 (Anlas). **-1 이면 못 한다** (너무 크다).

    ★★2026-08-21 재배포로 **표가 통째로 바뀌었다** (`docs/nai-web-reference.md` V5 절):
      · 상한이 1MP → **3MP**
      · 값이 1~7 → **1~4**
      · **Opus 무료 구간이 없어졌다** (옛 규격은 409,600px 이하가 0)
      · 훑는 방향도 반대다 — **처음 걸리는 구간**이 답이다 (옛 표는 마지막이 남았다)

    ★`tier`·`active` 는 이제 값에 영향을 주지 않지만 **인자를 남긴다** — 부르는 쪽이
      여럿이고, 무료가 되살아나면 여기 한 줄로 돌아온다.

    ★공홈은 못 하는 경우를 `-3` 으로 돌려주지만 우리는 **-1** 로 통일한다 —
      우리 쪽 다른 계산(Anlas 예상)이 음수를 "알 수 없음"으로 쓰고 있어서다."""
    px = int(width) * int(height)
    for limit, c in UPSCALE_COST_TABLE:
        if px <= limit:
            return c
    return -1


async def upscale(png_b64: str, width: int, height: int, token: str) -> bytes:
    """그림을 키운다 (`/ai/upscale`).

    ★★2026-08-21 재배포로 **주소도 본문도 바뀌었다**: 호스트가 `api` → `image` 로 옮겨졌고,
      본문에서 `width`·`height`·`scale` 이 빠지고 **`model`·`declared_blur_sigma`** 가 들어왔다.
      배율은 이제 서버가 정한다 — 「언제나 4배」를 화면 문구로 쓰지 말 것.
    ★`width`/`height` 인자는 **값 계산과 호출부 호환**을 위해 남긴다 (전송에는 안 쓴다).
    ★응답은 생성과 같은 **zip** 이다."""
    if not token:
        raise RuntimeError("NAI 토큰이 설정되지 않았습니다.")
    body = {
        "image": png_b64,
        "model": UPSCALE_MODEL,
        "declared_blur_sigma": UPSCALE_BLUR_SIGMA,
    }
    headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}
    async with httpx.AsyncClient(timeout=120) as client:
        res = await client.post(UPSCALE_ENDPOINT, headers=headers, json=body)
        if res.status_code != 200:
            raise RuntimeError(f"NAI API {res.status_code}: {res.text[:500]}")
        with zipfile.ZipFile(io.BytesIO(res.content)) as zf:
            return zf.read(zf.namelist()[0])
