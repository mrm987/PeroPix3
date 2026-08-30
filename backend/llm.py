"""LLM 대화 중계 — BYOK (사용자가 자기 키를 넣는다).

★**키는 프론트에 두지 않는다.** `data/secrets.json` 에 두고 여기서만 읽어 쓴다
  (`secretstore.py`). 브라우저에서 공급자를 직접 부르면 키가 화면 쪽 코드에 실리고 CORS 도 걸린다.

★**공급자를 정확히 고르게 한다** (사용자 지시 2026-08-08: "호환은 적을 필요 없음").
  앞서는 "OpenAI 호환" 한 칸에 주소를 갈아 끼우는 식이었는데, 사용자가 고르는 것은 규격이 아니라
  **어디에 돈을 내고 있는가**다. 규격은 우리가 알아서 맞춘다:

    anthropic   Anthropic Claude            앤트로픽 규격
    openai      OpenAI                      OpenAI 규격
    google      Google AI Studio (Gemini)   OpenAI 규격 (구글이 호환 창구를 연다)
    openrouter  OpenRouter                  OpenAI 규격
    vertex      Google Vertex AI            ★전용 규격 — Express 모드엔 호환 창구가 없다

★**공급자 응답을 한 모양으로 돌려준다.** 프론트는 도구 루프만 돌리면 되게:

    {"text": "...", "tools": [{"id","name","input"}], "stop": "...",
     "usage": {"in","out","cached"}}   ★`cached` 는 캐시에서 온 입력 토큰

주고받는 메시지는 앤트로픽 모양을 정본으로 삼는다 (도구 결과까지 한 배열에 담기는 쪽이
루프를 돌리기 쉽다). 다른 규격으로 보낼 때만 여기서 갈아 끼운다.

    {"role": "user"|"assistant",
     "content": [ {"type":"text","text":...}
                | {"type":"tool_use","id":...,"name":...,"input":{...}}
                | {"type":"tool_result","tool_use_id":...,"content":"..."} ]}
"""
from __future__ import annotations

import json
import re

import httpx

ANTHROPIC_VERSION = "2023-06-01"
# ★60초다 (사용자 결정 2026-08-08). 늘리는 것은 해결이 아니라 **기다리게 하는 것**이다 —
#   공급자가 불안정해서 나는 타임아웃은 라우팅(아래 OR_ROUTING)으로 고치고, 여기서는 빨리 포기한다.
TIMEOUT = 60.0

# ★오픈라우터 라우팅 (사용자 결정 2026-08-08). 실측 근거:
#   - `quantizations` 는 **화이트리스트**라 적지 않은 등급은 전부 잘린다. `unknown` 을 빼면
#     클로드·GPT·제미나이·그록·Qwen 이 **전부 404** 다 (닫힌 모델은 양자화가 unknown 으로 온다).
#     실측: claude-sonnet-5 + ["fp8","bf16","fp16"] → 404 / +["unknown"] → 200.
#     그래서 목록의 뜻은 "16·8비트와 미상은 쓰고 **4비트만 배제**한다" 이다.
#   - `sort: throughput` — 편차 16.8~27.7초 → 12.1~12.8초 (GLM 실측).
OR_ROUTING = {
    "quantizations": ["fp8", "bf16", "fp16", "unknown"],
    "data_collection": "deny",
    "sort": "throughput",
}

# ★주소·규격은 전부 확인한 것이다 (2026-08-08).
#   - 구글 AI 스튜디오의 OpenAI 호환 창구: https://ai.google.dev/gemini-api/docs/openai
#   - 버텍스 Express 모드는 generateContent 계열만 연다 (호환 창구 없음) —
#     주소는 PeroTalk `server.js` 가 실제로 쓰는 것과 같다.
PROVIDERS: dict[str, dict] = {
    "anthropic": {
        "label": "Anthropic Claude",
        "kind": "anthropic",
        "url": "https://api.anthropic.com/v1/messages",
        "hint": "claude-sonnet-5",
        "list": "https://api.anthropic.com/v1/models?limit=100",
    },
    "openai": {
        "label": "OpenAI",
        "kind": "openai",
        "url": "https://api.openai.com/v1/chat/completions",
        "hint": "gpt-5.6-sol",
        "list": "https://api.openai.com/v1/models",
    },
    "google": {
        "label": "Google AI Studio (Gemini)",
        "kind": "openai",
        "url": "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
        "hint": "gemini-3.7-flash",
        "list": "https://generativelanguage.googleapis.com/v1beta/models?pageSize=200",
    },
    "openrouter": {
        "label": "OpenRouter",
        "kind": "openai",
        "url": "https://openrouter.ai/api/v1/chat/completions",
        "hint": "deepseek/deepseek-v4-flash",
        "list": "https://openrouter.ai/api/v1/models",
    },
    "vertex": {
        "label": "Google Vertex AI",
        "kind": "gemini",
        "url": "https://aiplatform.googleapis.com/v1/publishers/google/models/{model}:generateContent",
        "hint": "gemini-2.5-flash",
    },
}
DEFAULT_PROVIDER = "openrouter"

# ★오픈라우터만 **추천 목록**을 둔다 (사용자 지시 2026-08-08: "모든 선택지를 주는 게 아니라
#   제일 좋은 것을 정해준다"). 400종을 그대로 보여 주면 고를 수가 없다.
#   메이저는 두 tier 씩, 나머지는 최상위 하나씩. 전부 도구·추론을 지원하는 것만 골랐다.
#   ★썩는다 — 새 모델이 나오면 여기 손대야 한다. 그래서 화면에 **「전체 목록」 토글**과
#     **직접 입력**을 남긴다. 이 목록은 울타리가 아니라 추천이다.
#   ★제미나이는 **일부러 없다** — 오픈라우터의 제미나이는 버텍스로 가면서도
#     `safety_settings` 를 못 받는다(실측: 지원 파라미터 목록에 없음). 검열을 끄려면
#     버텍스 공급자를 써야 하므로, 열등한 사본을 나란히 두지 않는다.
CURATED = {
    # ★공식 OpenAI 는 **5.6 세 모델만** (사용자 지시 2026-08-30: 그 밖은 수요가 없고 목록이 너무
    #   길다). 차례가 곧 기본값이다 — 목록의 첫 항목을 화면이 고른다 (`store/llm.loadModels`).
    "openai": [
        "gpt-5.6-sol",
        "gpt-5.6-terra",
        "gpt-5.6-luna",
    ],
    # ★클로드·제미나이(AI Studio)도 추린다 (사용자 지시 2026-08-30) — 전체 목록은 옛 세대까지 다 섰다
    "anthropic": [
        "claude-sonnet-5",
        "claude-opus-5",
        "claude-fable-5",
    ],
    "google": [
        "gemini-3.7-flash",
        "gemini-3.1-pro-preview",
        "gemini-2.5-pro",
    ],
    "openrouter": [
        "anthropic/claude-sonnet-5",
        "anthropic/claude-opus-5",
        "openai/gpt-5.6-terra",
        "openai/gpt-5.6-sol",
        "x-ai/grok-4.5",
        "deepseek/deepseek-v4-pro",
        "qwen/qwen3.8-max",
    ],
}

# 버텍스가 받는 추론 단계 (실측 2026-08-08: XHIGH 는 400 이 온다)
GEMINI_LEVELS = {"minimal", "low", "medium", "high"}
# 화면에 보일 순서 — 센 것부터. 오픈라우터의 `supported_efforts` 도 이 차례로 온다
EFFORT_ORDER = ["max", "xhigh", "high", "medium", "low", "minimal", "none"]


def provider_of(llm: dict) -> str:
    p = llm.get("provider") or DEFAULT_PROVIDER
    return p if p in PROVIDERS else DEFAULT_PROVIDER


def config_view(cfg: dict, has_key=None) -> dict:
    """설정 화면에 보여 줄 것 — **키 자체는 절대 돌려주지 않는다.**

    `has_key(provider) -> bool` 를 주면 공급자마다 키가 있는지 함께 알려 준다
    (화면의 초록 점). 안 주면 지금 공급자 것만 본다."""
    llm = cfg.get("llm") or {}
    cur = provider_of(llm)
    models = llm.get("models") or {}
    efforts = llm.get("efforts") or {}
    if has_key is None:
        def has_key(p: str) -> bool:  # noqa: E306
            return p == cur and bool(llm.get("key"))
    return {
        "provider": cur,
        "model": models.get(cur, ""),
        "models": models,
        # 추론 강도도 **공급자마다 따로** 산다 (모델·키와 같은 이유 — 단계 이름이 모델마다 다르다)
        "effort": efforts.get(cur, ""),
        "hasKey": bool(has_key(cur)),
        "providers": [
            {"id": pid, "label": p["label"], "hint": p["hint"], "hasKey": bool(has_key(pid))}
            for pid, p in PROVIDERS.items()
        ],
    }


async def chat(
    llm: dict,
    system: str,
    messages: list[dict],
    tools: list[dict] | None = None,
    max_tokens: int | None = None,
) -> dict:
    """★`max_tokens` 는 **안 보내는 것이 기본**이다 (사용자 결정 2026-08-08).

    자기 API 키를 쓰는 앱이라 사용 패턴에 상한을 걸 이유가 없고, 걸면 조용히 깨진다 —
    실측: thinking 모델이 추론에 1,760~2,639자를 쓰고 `finish=length` 로 잘려 **본문이 0자**
    였다. "검열로 빈 응답"으로 읽었던 것의 진짜 원인이 이것이었다.
    (앤트로픽 직결만 예외 — Messages API 가 `max_tokens` 를 **요구한다**)"""
    pid = provider_of(llm)
    spec = PROVIDERS[pid]
    key = llm.get("key", "")
    model = llm.get("model", "")
    if not key:
        return {"error": f"{spec['label']} API 키가 설정되지 않았습니다."}
    if not model:
        return {"error": "모델 이름이 설정되지 않았습니다."}

    url = llm.get("baseUrl") or spec["url"]
    effort = (llm.get("effort") or "").strip().lower()
    if spec["kind"] == "anthropic":
        return await _anthropic(key, model, system, messages, tools, max_tokens, url, effort)
    if spec["kind"] == "gemini":
        return await _gemini(key, model, system, messages, tools, max_tokens, url, effort)
    # ★`reasoning: {enabled, effort}` 는 **오픈라우터 확장**이다. 공식 OpenAI·구글 호환 창구는
    #   `reasoning_effort` 라는 다른 이름을 쓰는데, 키가 없어 **확인하지 못했다** — 확인 안 된 것을
    #   보내면 모르는 인자로 400 이 난다. 그래서 그쪽에는 안 보내고 모델 기본값으로 둔다
    #   (설정 화면도 그 둘에는 단계 칸을 안 낸다 — 목록에 `efforts` 가 없다).
    if pid == "openrouter":
        return await _openai_compat(key, model, system, messages, tools, max_tokens, url,
                                    effort, OR_ROUTING)
    return await _openai_compat(key, model, system, messages, tools, max_tokens, url)


async def verify(llm: dict) -> dict:
    """키·모델이 실제로 도는지 **한 번 불러 본다** (사용자가 누를 때만).

    ★탐지와 달리 이것은 공짜가 아니다 — 그래서 자동으로 하지 않는다. 대신 아주 작게 부른다
    (토큰 몇 개). 오타는 여기서 잡히고, 안 잡히면 첫 대화에서 잡힌다."""
    r = await chat(llm, "짧게 답한다.", [{"role": "user", "content": [{"type": "text", "text": "ok"}]}],
                   None, 16)
    if r.get("error"):
        return {"ok": False, "error": r["error"]}
    return {"ok": True, "usage": r.get("usage") or {}}


# ★버텍스 Express 모드에는 **모델 목록 창구가 없다** (문서 확인 2026-08-08 · 목록 API 는 403).
#   그래서 여기만 적어 둔다 — ★전부 **실제로 불러 보고** 넣은 것이다 (gemini-3-pro 는 404 라 뺐다).
# ★모델마다 **추론 규격이 다르다** (실측 2026-08-08):
#   3.x 는 `thinkingLevel`(단계), 2.5 는 `thinkingBudget`(토큰 수)이다 — 규격이 아예 다르다.
#   2.5 에 단계를 보내면 400 ("thinking_level is not supported by this model"). 목록에서
#   2.5 계열을 뺀 이유가 이것이고(사용자 결정 2026-08-08), 직접 입력으로 그런 모델을 넣어도
#   **단계를 안 보낸다** — 표에 없는 이름이면 그냥 모델 기본값으로 돈다.
#   기본 단계는 구글 문서의 표를 그대로 옮긴 것이다
#   (cloud.google.com/vertex-ai/generative-ai/docs/thinking — "Default thinking_level").
#   ★단계는 **모델마다 다르다** — 3.1 Pro 는 MINIMAL 을 400 으로 거부한다 (실측).
VERTEX_THINKING: dict[str, dict] = {
    # ★3.6 Flash 는 뺐다 (사용자 지시 2026-08-30: 필요 없음) — 3.7 Flash 가 그 자리다
    # ★이름이 `gemini-3.1-pro` 가 아니다 — 그건 404 다 (실측 2026-08-08)
    "gemini-3.1-pro-preview": {"efforts": ["high", "medium", "low"], "default": "high"},
}

# ★★**고를 수 있는 것 전부** — 위 표는 「추론 단계를 아는 것」일 뿐이다 (2026-08-25).
#   사용자 요청으로 둘을 더했는데, **단계 목록은 실제로 불러 보기 전에는 적지 않는다** —
#   모델마다 받는 값이 달라서(3.1 Pro 는 MINIMAL 이 400) 짐작해 적으면 그 순간 깨진다.
#   표에 없으면 `_gemini` 가 `thinkingConfig` 를 **아예 안 보내므로**, 모델 기본 추론으로
#   그냥 돈다. 즉 **쓰는 데는 지장이 없고, 강도 드롭다운만 안 뜬다.**
#   ★단계를 확인하면 위 표에 옮겨 적는다 (그때 드롭다운이 생긴다).
VERTEX_MODELS = [
    # ★2026-08-25 GA (구글 문서 확인) — 지금의 주력 워크호스
    "gemini-3.7-flash",
    *VERTEX_THINKING,
    # ★2.5 는 **추론 규격이 다르다**: 단계가 아니라 `thinkingBudget`(토큰 수)이다.
    #   그래서 여기서는 단계를 안 보낸다 (위 ★★주). ★**2026-10-16 은퇴 예정**이므로
    #   그 뒤로는 404 가 된다 (구글 문서: 2.5 Pro·Flash·Flash-Lite 은퇴일).
    "gemini-2.5-pro",
]
# OpenAI 목록에는 대화용이 아닌 것도 섞여 온다 — 이름으로 걸러 낸다
NOT_CHAT = ("embedding", "tts", "whisper", "dall-e", "moderation", "audio", "realtime", "image", "search")


async def models(llm: dict) -> dict:
    """공급자에게 **직접 물어본다** — 목록을 코드에 박으면 썩는다.

    ★키가 없거나 창구가 막히면 빈 목록 + 사유를 돌려준다. 화면은 그때 직접 입력으로 받는다.
    ★오픈라우터는 **추천 목록**(`CURATED`)만 준다 (사용자 결정 2026-08-08). 333종을 다 열면
      고르기 어렵고, 무엇보다 **명세를 모르는 모델**이 섞인다 — 추론 규격이 제각각이라
      조용히 400 이 난다. 직접 입력도 같은 이유로 없앴다."""
    pid = provider_of(llm)
    spec = PROVIDERS[pid]
    if pid == "vertex":
        # ★추론 단계도 함께 준다 — 화면은 이 값으로 드롭다운을 채운다. 오픈라우터처럼
        #   물어볼 창구가 없으므로 **실측한 것**을 적는다 (XHIGH 는 400 이라 빠져 있다).
        #   `locked` 인 이유: 제미나이는 추론이 필수다. 사실상 끄는 것은 `minimal` 이다.
        out = []
        for m in VERTEX_MODELS:
            spec_t = VERTEX_THINKING.get(m) or {}
            row = {"id": m}
            if spec_t.get("efforts"):
                row["efforts"] = spec_t["efforts"]
                row["effortDefault"] = spec_t.get("default", "")
                # 제미나이는 추론이 필수다 — 사실상 끄기는 `minimal` 이다
                row["reasoningLocked"] = True
            out.append(row)
        return {"models": out, "fixed": True}
    key = llm.get("key", "")
    if not key:
        return {"models": [], "error": f"{spec['label']} API 키가 필요합니다."}

    url = spec["list"]
    headers = {"Authorization": f"Bearer {key}"}
    if pid == "anthropic":
        headers = {"x-api-key": key, "anthropic-version": ANTHROPIC_VERSION}
    if pid == "google":
        url += f"&key={key}"
        headers = {}
    try:
        async with httpx.AsyncClient(timeout=60.0) as c:
            r = await c.get(url, headers=headers)
    except Exception as e:
        return {"models": [], "error": f"{type(e).__name__}: {e}"}
    if r.status_code >= 400:
        return {"models": [], "error": _err(r)}
    d = r.json()

    out: list[dict] = []
    if pid == "anthropic":
        out = [{"id": m["id"], "label": m.get("display_name") or ""} for m in d.get("data", [])]
    elif pid == "google":
        for m in d.get("models", []):
            if "generateContent" not in (m.get("supportedGenerationMethods") or []):
                continue
            out.append({"id": m["name"].split("/")[-1], "label": m.get("displayName") or ""})
    elif pid == "openai":
        for m in d.get("data", []):
            mid = m.get("id", "")
            if any(w in mid for w in NOT_CHAT):
                continue
            out.append({"id": mid, "label": ""})
    else:  # openrouter
        for m in d.get("data", []):
            # ★도구를 못 쓰는 모델은 뺀다 — 이 앱의 조수는 도구가 전부다
            if "tools" not in (m.get("supported_parameters") or []):
                continue
            pr = m.get("pricing") or {}
            try:
                inp = float(pr.get("prompt", 0)) * 1e6
            except Exception:
                inp = 0.0
            img = "image" in ((m.get("architecture") or {}).get("input_modalities") or [])
            row = {"id": m["id"], "label": m.get("name") or "", "in": round(inp, 3), "vision": img}
            # ★추론 단계는 **모델이 알려 준다** — 코드에 박으면 모델마다 다른 것을 못 맞춘다
            #   (문서: "Use this when building client UIs"). `mandatory` 면 끌 수 없다.
            rs = m.get("reasoning") or {}
            if rs.get("supported_efforts"):
                row["efforts"] = rs["supported_efforts"]
                row["effortDefault"] = rs.get("default_effort") or ""
                row["reasoningLocked"] = bool(rs.get("mandatory"))
            out.append(row)
    out.sort(key=lambda m: m["id"])
    if pid in CURATED:
        pick = CURATED[pid]
        by = {m["id"]: m for m in out}
        keep = [by[i] for i in pick if i in by]
        # ★추천 중 사라진 것이 있으면 **조용히 넘어가지 않는다** — 목록이 썩었다는 신호다
        gone = [i for i in pick if i not in by]
        keep += newer_than(pick, out)
        return {"models": keep, "curated": True, "total": len(out),
                "missing": gone, "error": (f"추천 목록에 없는 모델: {', '.join(gone)}" if gone else "")}
    return {"models": out}


# ★★**상위 버전은 손대지 않아도 뜬다** (사용자 지시 2026-08-30: 새 모델이 나올 때마다 손으로
#   넣어 주지 않아도 대응할 시간을 벌게). 추천 이름에서 **버전 숫자만 뺀 꼴**(`gpt-#-sol`,
#   `claude-sonnet-#`, `gemini-#-pro`)을 가족으로 보고, 공급자 목록에 같은 가족의 **더 높은
#   버전**이 있으면 추천 뒤에 `new` 표시로 붙인다. 날짜가 붙은 이름(`…-2025-04-14`)은 꼴이
#   달라 안 잡힌다 — 그런 것은 원래 뜻이 없다.
# ★숫자 앞의 `v` 는 `-`·`/` 뒤에 올 때만 버전 표기로 본다 (`deepseek-v4-pro`). 글자에 붙은 숫자는
#   그대로 버전이다 (`qwen3.8-max`). 앞이 숫자·점이면 버전 한가운데라 건너뛴다.
_VER = re.compile(r"(?<![0-9.])(?:(?<=[-/])v)?(\d+(?:\.\d+)*)(?![0-9])")


def _family(mid: str):
    """`gpt-5.6-sol` → (`gpt-#-sol`, 5.6). 숫자가 없으면 None.

    ★버전은 **소수로** 읽는다 (사용자 지적 2026-08-30: `grok-4.20` 이 `4.5` 보다 새 것으로 떴다).
      정수 조각으로 비교하면 `.20 > .5` 가 되지만, 모델 이름의 숫자는 4.20 = 4.2 로 읽힌다.
      셋째 조각(`1.2.3`)은 드물어 무시한다."""
    m = _VER.search(mid)
    if not m:
        return None
    parts = m.group(1).split(".")
    ver = float(parts[0] + ("." + parts[1] if len(parts) > 1 else ""))
    return mid[:m.start()] + "#" + mid[m.end():], ver


def newer_than(pick: list[str], out: list[dict]) -> list[dict]:
    """추천과 같은 가족이면서 버전이 더 높은 것 — 높은 버전이 앞."""
    fam: dict[str, float] = {}
    for i in pick:
        f = _family(i)
        if f:
            fam[f[0]] = max(fam.get(f[0], -1.0), f[1])
    found = []
    for m in out:
        if m["id"] in pick:
            continue
        f = _family(m["id"])
        if f and f[0] in fam and f[1] > fam[f[0]]:
            found.append(({**m, "new": True}, f[1]))
    found.sort(key=lambda t: t[1], reverse=True)
    return [m for m, _ in found]


# ── 앤트로픽 ──────────────────────────────────────────────────────
def _anthropic_images(messages: list[dict]) -> list[dict]:
    """정본의 그림 파트를 **앤트로픽 모양**으로 (2026-08-24, `read_image`).

    ★정본이 앤트로픽 모양이라 다른 파트는 그대로 나가지만, 그림만은 우리가 정한 짧은 모양
      (`{mime, b64}`)이라 여기서 편다 — 세 규격이 다 다르므로 정본을 어느 한쪽에 맞추지
      않고 **각 어댑터가 옮긴다** (`_to_openai`·`_to_gemini` 와 같은 방식).
    ★손대는 것은 그림 파트뿐이다 — 나머지는 원본 객체를 그대로 둔다."""
    out = []
    for m in messages:
        c = m.get("content")
        if not isinstance(c, list) or not any(
            isinstance(b, dict) and b.get("type") == "image" and b.get("b64") for b in c
        ):
            out.append(m)
            continue
        parts = []
        for b in c:
            if isinstance(b, dict) and b.get("type") == "image" and b.get("b64"):
                parts.append({"type": "image", "source": {
                    "type": "base64", "media_type": b.get("mime", "image/webp"), "data": b["b64"]}})
            else:
                parts.append(b)
        out.append({**m, "content": parts})
    return out


async def _anthropic(key, model, system, messages, tools, max_tokens, url, effort="") -> dict:
    messages = _anthropic_images(messages)
    body: dict = {
        # ★여기만 `max_tokens` 를 **꼭** 보낸다 — Messages API 가 요구한다 (문서 확인).
        #   다른 경로는 안 보내고 모델 기본값을 쓴다 (`chat()` 주석).
        "model": model,
        "max_tokens": max_tokens or 32000,
        "system": system,
        "messages": messages,
        # ★★**캐시를 켠다.** 안 켜면 매 턴 시스템 프롬프트+도구 명세를 새로 문다 —
        #   실측(2026-08-08, 오픈라우터 경유 클로드): 안 켜면 2회차도 cached=0,
        #   켜면 1,742 중 **1,736 이 캐시에서** 왔다. 우리 지침은 매 턴 동일하므로 그대로 걸린다.
        #   (문서의 "automatic caching" — 최상위에 한 줄이면 안정된 앞부분을 알아서 잡는다)
        "cache_control": {"type": "ephemeral"},
    }
    if effort:
        # ★적응형 추론 — 깊이는 토큰 예산이 아니라 `output_config.effort` 로 정한다
        #   (문서: "remove budget_tokens, set thinking:{type:adaptive}, control depth with output_config")
        body["thinking"] = {"type": "adaptive"}
        body["output_config"] = {"effort": effort}
    if tools:
        body["tools"] = [
            {"name": t["name"], "description": t["description"], "input_schema": t["schema"]}
            for t in tools
        ]
    async with httpx.AsyncClient(timeout=TIMEOUT) as c:
        r = await c.post(
            url,
            headers={
                "x-api-key": key,
                "anthropic-version": ANTHROPIC_VERSION,
                "content-type": "application/json",
            },
            json=body,
        )
    if r.status_code >= 400:
        return {"error": _err(r)}
    d = r.json()
    text = "".join(b.get("text", "") for b in d.get("content", []) if b.get("type") == "text")
    calls = [
        {"id": b["id"], "name": b["name"], "input": b.get("input") or {}}
        for b in d.get("content", [])
        if b.get("type") == "tool_use"
    ]
    u = d.get("usage") or {}
    return {
        "text": text,
        "tools": calls,
        "stop": d.get("stop_reason", ""),
        # ★캐시가 실제로 걸리는지 **보이게** 돌려준다 — 안 보이면 켰는지 알 수 없다
        "usage": {"in": u.get("input_tokens", 0), "out": u.get("output_tokens", 0),
                  "cached": u.get("cache_read_input_tokens", 0)},
    }


# ── OpenAI 규격 (OpenAI · OpenRouter · 구글 AI 스튜디오) ───────────
def _to_openai(system: str, messages: list[dict], cache: bool = False) -> list[dict]:
    """정본(앤트로픽 모양) → OpenAI 모양.

    ★도구 결과가 다르다: 앤트로픽은 user 메시지 안의 블록, OpenAI 는 `role:"tool"` 메시지다.
      그래서 블록 하나가 메시지 하나로 **풀린다**."""
    # ★`cache` 는 **오픈라우터에서만** 켠다 (실측 2026-08-08): 안 켜면 클로드가 매 턴 새로 문다
    #   (2회차 cached=0 → 켜면 1,736). 딥식·제미나이에 붙여도 탈이 없는 것까지 확인했다.
    #   ★공식 OpenAI 창구에는 안 켠다 — 모르는 필드로 400 이 날 수 있고, 거긴 알아서 캐시한다.
    out: list[dict] = [
        {"role": "system",
         "content": ([{"type": "text", "text": system, "cache_control": {"type": "ephemeral"}}]
                     if cache and system else system)}
    ]
    for m in messages:
        content = m.get("content")
        if isinstance(content, str):
            out.append({"role": m["role"], "content": content})
            continue
        texts = [b["text"] for b in content if b.get("type") == "text"]
        calls = [b for b in content if b.get("type") == "tool_use"]
        results = [b for b in content if b.get("type") == "tool_result"]
        if m["role"] == "assistant":
            # ★도구만 부른 턴은 content 가 빈다. 빈 문자열을 싫어하는 공급자가 있어 None 으로 둔다
            msg: dict = {"role": "assistant", "content": "\n".join(texts) or None}
            if calls:
                msg["tool_calls"] = [
                    {
                        "id": b["id"],
                        "type": "function",
                        "function": {"name": b["name"], "arguments": json.dumps(b.get("input") or {})},
                    }
                    for b in calls
                ]
            out.append(msg)
        else:
            for b in results:
                out.append(
                    {"role": "tool", "tool_call_id": b["tool_use_id"], "content": str(b.get("content", ""))}
                )
            # ★★그림은 **user 메시지의 `image_url`** 로 간다 (2026-08-24, `read_image`).
            #   ★`role:"tool"` 안에 넣지 않는다 — OpenAI 규격은 거기에 **글자만** 받는다.
            #     그래서 프론트도 도구 결과 **뒤에** 따로 붙여 보낸다 (`store/llm.ts`).
            shots = [b for b in content if b.get("type") == "image"]
            if shots:
                parts: list[dict] = [{"type": "text", "text": "\n".join(texts) or "(image)"}]
                for b in shots:
                    mime = b.get("mime", "image/webp")
                    parts.append({"type": "image_url",
                                  "image_url": {"url": f"data:{mime};base64,{b.get('b64', '')}"}})
                out.append({"role": "user", "content": parts})
            elif texts:
                out.append({"role": "user", "content": "\n".join(texts)})
    return out


async def _openai_compat(key, model, system, messages, tools, max_tokens, url,
                         effort="", routing=None) -> dict:
    body: dict = {"model": model, "messages": _to_openai(system, messages, cache=bool(routing))}
    if max_tokens:
        body["max_tokens"] = max_tokens
    if effort:
        # 오픈라우터가 공급자마다 다른 규격으로 옮겨 준다 (문서: "OpenRouter normalizes …")
        body["reasoning"] = {"enabled": True, "effort": effort}
    if routing:
        body["provider"] = routing
    if tools:
        body["tools"] = [
            {
                "type": "function",
                "function": {
                    "name": t["name"],
                    "description": t["description"],
                    "parameters": t["schema"],
                },
            }
            for t in tools
        ]
    headers = {"Authorization": f"Bearer {key}", "content-type": "application/json"}
    async with httpx.AsyncClient(timeout=TIMEOUT) as c:
        r = await c.post(url, headers=headers, json=body)
        # ★★공식 OpenAI 의 추론 모델은 `/v1/chat/completions` 에서 **도구와 추론을 함께 못 쓴다**
        #   (실측 2026-08-30, gpt-5.6-terra: "Function tools with reasoning_effort are not supported
        #   … use /v1/responses or set reasoning_effort to 'none'"). 우리는 이 창구에 효과 단계를
        #   안 보내는데도 모델 기본값이 추론이라 400 이 났다. 그 400 에 한해 **추론을 끄고 한 번
        #   더** 보낸다 — 모델마다 'none' 을 받는지 다르므로 미리 붙이지 않고, 거절당했을 때만
        #   붙인다. 추론이 꺼지는 대가가 있다: 제대로는 `/v1/responses` 로 옮겨야 한다.
        if (r.status_code == 400 and tools and "reasoning_effort" in r.text
                and "reasoning_effort" not in body):
            body["reasoning_effort"] = "none"
            r = await c.post(url, headers=headers, json=body)
    if r.status_code >= 400:
        return {"error": _err(r)}
    d = r.json()
    choice = (d.get("choices") or [{}])[0]
    msg = choice.get("message") or {}
    calls = []
    for c_ in msg.get("tool_calls") or []:
        fn = c_.get("function") or {}
        try:
            args = json.loads(fn.get("arguments") or "{}")
        except Exception:
            args = {}
        calls.append({"id": c_.get("id", ""), "name": fn.get("name", ""), "input": args})
    u = d.get("usage") or {}
    return {
        "text": msg.get("content") or "",
        "tools": calls,
        "stop": choice.get("finish_reason", ""),
        "usage": {"in": u.get("prompt_tokens", 0), "out": u.get("completion_tokens", 0),
                  "cached": ((u.get("prompt_tokens_details") or {}).get("cached_tokens") or 0)},
    }


# ── 제미나이 전용 규격 (Vertex AI Express) ────────────────────────
# ★버텍스 Express 모드는 `generateContent` 계열만 연다 — OpenAI 호환 창구가 없다
#   (문서 확인 2026-08-08). 그래서 규격을 하나 더 안다.
GEMINI_SCHEMA_KEYS = {"type", "description", "properties", "required", "items", "enum", "format", "nullable"}
# ★안전 필터를 끈다 — 이 앱은 성인 이미지 프롬프트를 다룬다. PeroTalk `server.js` 가 실제로
#   쓰는 목록과 같다 (거기서 검증된 값이다).
SAFETY_OFF = [
    {"category": c, "threshold": "OFF"}
    for c in (
        "HARM_CATEGORY_HARASSMENT",
        "HARM_CATEGORY_HATE_SPEECH",
        "HARM_CATEGORY_SEXUALLY_EXPLICIT",
        "HARM_CATEGORY_DANGEROUS_CONTENT",
        "HARM_CATEGORY_CIVIC_INTEGRITY",
    )
]


def _gemini_schema(s: dict) -> dict:
    """제미나이가 아는 키만 남긴다 — 모르는 키가 있으면 400 으로 튕긴다."""
    out = {}
    for k, v in (s or {}).items():
        if k not in GEMINI_SCHEMA_KEYS:
            continue
        if k == "properties" and isinstance(v, dict):
            out[k] = {pk: _gemini_schema(pv) for pk, pv in v.items()}
        elif k == "items" and isinstance(v, dict):
            out[k] = _gemini_schema(v)
        else:
            out[k] = v
    return out


def _as_obj(v) -> dict:
    """도구 결과는 우리 루프에서 JSON **문자열**로 온다. 제미나이는 객체를 원한다."""
    if isinstance(v, dict):
        return v
    try:
        d = json.loads(v)
        return d if isinstance(d, dict) else {"result": d}
    except Exception:
        return {"result": str(v)}


def _to_gemini(messages: list[dict]) -> list[dict]:
    """정본(앤트로픽 모양) → 제미나이 contents.

    ★도구 결과를 **이름으로** 되돌려준다 (제미나이에는 호출 id 가 없다). 그래서 앞선 턴의
      `tool_use` 에서 id→이름 표를 만들어 두고 쓴다."""
    names: dict[str, str] = {}
    out: list[dict] = []
    for m in messages:
        role = "model" if m["role"] == "assistant" else "user"
        content = m.get("content")
        if isinstance(content, str):
            out.append({"role": role, "parts": [{"text": content}]})
            continue
        parts: list[dict] = []
        for b in content:
            t = b.get("type")
            if t == "text" and b.get("text"):
                parts.append({"text": b["text"]})
            elif t == "tool_use":
                names[b.get("id", "")] = b.get("name", "")
                # ★모델이 준 part 를 **그대로 되돌려준다.** 생각하는 모델(제미나이 3 계열)은
                #   `functionCall` part 에 `thoughtSignature` 를 실어 보내고, 그것이 빠지면
                #   400 을 낸다: "Function call is missing a thought_signature in functionCall
                #   parts". 우리가 이름·인자만 뽑아 **다시 만들면** 그 서명이 사라진다.
                #   ★필드 이름·위치를 우리가 알 필요가 없다는 것이 이 방식의 요점이다 —
                #     받은 것을 손대지 않고 돌려주면 규격이 바뀌어도 안 깨진다.
                raw = b.get("raw")
                parts.append(
                    raw
                    if isinstance(raw, dict) and "functionCall" in raw
                    else {"functionCall": {"name": b.get("name", ""), "args": b.get("input") or {}}}
                )
            elif t == "tool_result":
                nm = names.get(b.get("tool_use_id", ""), "tool")
                parts.append({"functionResponse": {"name": nm, "response": _as_obj(b.get("content"))}})
            # ★그림은 `inlineData` 다 (2026-08-24, `read_image`) — 제미나이의 이름만 다르고
            #   자리는 같다 (user 파트 안).
            elif t == "image" and b.get("b64"):
                parts.append({"inlineData": {"mimeType": b.get("mime", "image/webp"), "data": b["b64"]}})
        if parts:
            out.append({"role": role, "parts": parts})
    return out


async def _gemini(key, model, system, messages, tools, max_tokens, url, effort="") -> dict:
    gc: dict = {}
    if max_tokens:
        gc["maxOutputTokens"] = max_tokens
    # ★단계를 **받는 모델에만** 보낸다. 2.5 계열은 `thinkingLevel` 을 400 으로 거부한다
    #   (실측 2026-08-08). 추론 강도는 공급자마다 저장되므로, 3.x 에서 고른 값이 2.5 로
    #   옮겨 갔을 때 그대로 보내면 그 순간 깨진다 — 여기서 막는다.
    ok_levels = (VERTEX_THINKING.get(model) or {}).get("efforts") or []
    if effort and ok_levels:
        # ★**그 모델이 받는 것만** 보낸다. 목록이 모델마다 다르다 — 3.1 Pro 는 MINIMAL 도 400 이고,
        #   XHIGH·MAX 는 어느 모델도 안 받는다 (실측). 모르는 값은 그 모델의 **가장 센 것**으로 접는다.
        lvl = effort if effort in ok_levels else ok_levels[0]
        gc["thinkingConfig"] = {"thinkingLevel": lvl.upper()}
    body: dict = {
        "contents": _to_gemini(messages),
        "safetySettings": SAFETY_OFF,
    }
    if gc:
        body["generationConfig"] = gc
    if system:
        body["systemInstruction"] = {"parts": [{"text": system}]}
    if tools:
        body["tools"] = [
            {
                "functionDeclarations": [
                    {
                        "name": t["name"],
                        "description": t["description"],
                        "parameters": _gemini_schema(t["schema"]),
                    }
                    for t in tools
                ]
            }
        ]
    async with httpx.AsyncClient(timeout=TIMEOUT) as c:
        r = await c.post(
            url.format(model=model),
            params={"key": key},  # ★버텍스 Express 는 쿼리로 키를 받는다 (헤더가 아니다)
            headers={"content-type": "application/json"},
            json=body,
        )
    if r.status_code >= 400:
        return {"error": _err(r)}
    d = r.json()
    cand = (d.get("candidates") or [{}])[0]
    parts = ((cand.get("content") or {}).get("parts") or [])
    text = "".join(p.get("text", "") for p in parts if "text" in p)
    calls = []
    for i, p in enumerate(parts):
        fc = p.get("functionCall")
        if not fc:
            continue
        # ★id 를 우리가 만든다 — 제미나이는 안 준다. 되돌려줄 때는 이름을 쓰므로 겹치지만 않으면 된다
        # ★`raw` 에 **받은 part 를 통째로** 담아 둔다. 다음 턴에 그대로 되돌려주지 않으면
        #   생각하는 모델이 `thought_signature` 가 없다며 400 을 낸다 (`_to_gemini` 주석).
        calls.append({"id": f"call_{i}", "name": fc.get("name", ""), "input": fc.get("args") or {},
                      "raw": p})
    u = d.get("usageMetadata") or {}
    if not text and not calls:
        why = (d.get("promptFeedback") or {}).get("blockReason") or cand.get("finishReason") or "원인 불명"
        # ★★**어느 필터가 걸렸는지 말해 준다** (사용자 지적 2026-08-25: 중단 후 다시 말했더니
        #   `(SAFETY)` 만 뜨고 끝났다). 이름만으로는 무엇을 고쳐야 할지 알 수 없다 —
        #   막은 갈래를 알면 그 대목을 바꿔 보거나 다른 모델로 옮길 수 있다.
        #   ★`safetyRatings` 는 응답에 늘 있는 것이 아니므로 **있을 때만** 덧붙인다.
        hit = [str(x.get("category", "")).replace("HARM_CATEGORY_", "")
               for x in (cand.get("safetyRatings") or []) if x.get("blocked")]
        return {"error": f"응답이 비어 있습니다 ({why}" + (" — " + ", ".join(hit) if hit else "") + ")"}
    return {
        "text": text,
        "tools": calls,
        "stop": cand.get("finishReason", ""),
        "usage": {"in": u.get("promptTokenCount", 0), "out": u.get("candidatesTokenCount", 0),
                  "cached": u.get("cachedContentTokenCount", 0)},
    }


def _err(r: httpx.Response) -> str:
    """공급자의 오류 메시지를 그대로 보여 준다 — 키·모델 오타가 대부분이라 원문이 제일 낫다."""
    try:
        d = r.json()
        e = d.get("error")
        if isinstance(e, dict):
            return f"{r.status_code} {e.get('message') or json.dumps(e, ensure_ascii=False)}"
        if e:
            return f"{r.status_code} {e}"
        return f"{r.status_code} {json.dumps(d, ensure_ascii=False)[:400]}"
    except Exception:
        return f"{r.status_code} {r.text[:400]}"
