"""AI 가 만지는 것은 **데이터**다 — 화면이 아니다 (사용자 지시 2026-08-07).

★**앞선 구조(화면 조작)를 버렸다.** 도구를 화면(zustand)에 두고 WebSocket 으로 넘기던 방식은
  실사용에서 이렇게 깨졌다:

  1. **도구가 0개로 보였다.** 명세를 화면이 **붙는 순간에만** 올려서, 코드가 갱신돼도(HMR)
     소켓이 그대로면 영영 안 올라간다. 그러면 에이전트는 우리 도구를 못 보고 Read/Bash 로
     우리 소스를 뒤지다 권한 벽에 막힌다 (실제 대화 전문에서 확인).
  2. **화면이 없으면 아무것도 못 한다.** 앱을 안 켜면 도구가 통째로 사라진다.

★지금 구조는 단순하다: **도구는 파일을 만진다.** 카드는 `data/cards/`, 작업 상태는
  `outputs/<ws>/workspace.json` 에 이미 다 있다 (`workspace.py` 머리 주석: "spec — 사람·LLM 이
  편집"). 화면은 그 파일을 보여 주는 것일 뿐이라, **읽는 데도 쓰는 데도 화면이 필요 없다.**

★그래서 도구 목록은 **언제나 같다.** 앱이 꺼져 있어도 목록이 나오고, 켜져 있으면 바뀐 것을
  화면이 다시 읽는다 (`data_changed` 브로드캐스트).

★「앱 꺼짐 동작」자체는 요구 사항이 아니다 (사용자 정정 2026-08-24) — 핵심은 **앱을 켠 채
  사용자와 나란히 작업하는 것**이고, 위 기록의 요점은 목록이 소켓 타이밍에 좌우되지 않는
  신뢰성이다. 도구는 예외 케이스 열거 대신 **범용으로** 만들어 LLM 이 유연하게 조합하게 한다.
"""
from __future__ import annotations

import asyncio
import inspect
import json
import uuid
import re
from datetime import datetime
from pathlib import Path
from typing import Any, Callable

import base64

import nai
import thumbs
import trash

# 태그 사전은 프론트 자산이지만 **파일**이라 백엔드도 읽는다 (한 벌만 둔다)
#: ★★**둘을 함께 읽는다** — 단부루 덤프와, 우리가 더한 것(V5 태그·nsfw/sfw 등).
#   2026-08-24 까지 더한 것은 **화면 코드에만** 있어서, 조수는 그 태그들을 「없다」고 했다.
#   같은 정보에 창구가 둘이면 반드시 갈린다 (`src/lib/tagData.ts` 의 ★★주).
_PUBLIC = Path(__file__).resolve().parent.parent / "public"
TAGS_JSON = _PUBLIC / "tags.json"
TAGS_EXTRA_JSON = _PUBLIC / "tags-extra.json"

_tags_cache: list[dict] | None = None


def _tags() -> list[dict]:
    global _tags_cache
    if _tags_cache is None:
        out: list[dict] = []
        for p in (TAGS_EXTRA_JSON, TAGS_JSON):   # 더한 것이 앞에 서서 먼저 걸린다
            try:
                got = json.loads(p.read_text(encoding="utf-8"))
                if isinstance(got, list):
                    out.extend(got)
            except Exception:
                continue
        _tags_cache = out
    return _tags_cache


def _blocks(items: list[dict] | None) -> list[dict]:
    """`[{label, tags}]` → 블록 목록. 프론트의 `makeBlock` 과 같은 모양을 만든다."""
    out = []
    for i, b in enumerate(items or []):
        raw = str(b.get("tags", "")).strip()
        tags = [{"t": x.strip(), "w": None} for x in raw.split(",") if x.strip()]
        out.append(
            {
                "id": f"b{int(datetime.now().timestamp() * 1000):x}{i}",
                "label": str(b.get("label", "블록")),
                "color": b.get("color"),
                "on": True,
                "open": True,
                "tags": tags,
            }
        )
    return out


def _view(blocks: list[dict] | None) -> list[dict]:
    """블록 목록을 읽기 쉬운 줄로 (LLM 이 다루기 쉬운 모양)."""
    out = []
    for b in blocks or []:
        tags = ", ".join(
            (f"{x['w']}::{x['t']}::" if x.get("w") not in (None, 1) else str(x.get("t", "")))
            for x in b.get("tags", [])
        )
        out.append({"id": b.get("id"), "label": b.get("label"), "on": b.get("on", True), "tags": tags})
    return out


def _scenes(st: dict) -> list[dict]:
    """씬 그룹 안의 **씬들**.

    ★★씬은 **카드 안에** 있다 (`cards[].cells` — 2026-08-11 의 카드 층). 예전에는 씬 그룹이
      `cells` 를 직접 들었고, 여기는 그 옛 자리만 읽고 있었다. 그래서 **지금 만든 워크스페이스는
      조수에게 씬이 하나도 없는 것으로 보였다** (2026-08-24 발견).
      ★옛 자리를 읽는 폴백은 두지 않는다 — 그 모양의 워크스페이스가 남아 있지 않다
        (사용자 확인 2026-08-24). 없는 상황을 위한 길은 다음에 읽는 사람을 헷갈리게 한다.
    ★공통 접두(`prefix`)는 **카드마다** 있다 (그때 함께 내려갔다). 씬에 그 카드 이름과 접두를
      붙여 준다 — 조수가 「어느 카드의 씬인가」를 물어볼 필요가 없게."""
    out = []
    for k in st.get("cards") or []:
        for c in k.get("cells") or []:
            out.append({
                "id": c.get("id"), "name": c.get("name"),
                "card": k.get("name"), "prefix": k.get("prefix", ""),
                "blocks": _view(c.get("blocks")), "locked": bool(c.get("locked")),
            })
    return out


def _scene_group_prompt(spec: dict, st: dict) -> dict:
    """그 씬 그룹에 걸리는 **프롬프트**.

    ★★씬 그룹(kind=="sceneGroup")의 프롬프트는 **탭에 산다** (`spec.tabs[].prompt` — `workspace.ts` 의
      `promptOf`). 한 탭 아래 씬 그룹들은 같은 인물의 다른 포즈 묶음이라 프롬프트를 함께 쓴다.
      여기는 씬 그룹에서만 찾고 있어서 **프롬프트가 통째로 안 보였다** (2026-08-24 발견).
    ★씬 그룹에 든 것을 읽는 폴백은 두지 않는다 — 그 모양(옛 워크스페이스·싱글 탭)이 남아 있지
      않다 (사용자 확인 2026-08-24)."""
    cid = st.get("tabId") or spec.get("activeTab")
    for c in spec.get("tabs") or []:
        if c.get("id") == cid and c.get("prompt"):
            return c["prompt"]
    return {}


def _tab_model(spec: dict) -> str:
    """지금 탭이 쓰는 **모델**.

    ★조수가 이것을 알아야 하는 까닭: 자연어를 써도 되는지·투명 배경이 되는지·퀄리티 프리셋이
      무엇인지가 전부 모델에 매인다 (`docs/terms-plan.md` §4 의 빈칸 셋째).
    ★생성 옵션은 **탭마다 따로** 담긴다 (`src/store/gen.ts` 의 `stashGen` — 워크스페이스는
      각각이 개별 작업 공간이다). 그래서 씬 그룹이 아니라 **활성 탭**에서 꺼낸다.
    ★능력표(무엇이 되고 안 되나)는 여기 두지 않는다 — 정본은 `src/lib/naiModels.ts` 하나다.
      여기서 옮겨 적으면 표가 둘이 되어 반드시 갈린다. 지침에는 **모델 이름**만 실린다."""
    for c in spec.get("tabs") or []:
        if c.get("id") == spec.get("activeTab"):
            return str((c.get("gen") or {}).get("model") or nai.GenRequest.model)
    return nai.GenRequest.model


#: ★한 턴에 실을 수 있는 그림 수 — 상한이 없으면 컨텍스트가 통째로 찬다 (2-7)
MAX_IMAGES = 4

#: ★★**승인 기준은 하나다 — 앱 액션이든 백엔드 도구든** (사용자 지시 2026-08-25).
#:
#:    hard : **생성물이 지워지거나**, 되돌릴 수 없는데 **비용이 큰 것**
#:    ask  : 되돌릴 수 있지만 **수정폭이 큰 것** (카드를 통째로 갈아 끼우는 등)
#:    none : 자주 하고 **위험이 낮은 것** — 사용 편의를 우선한다 (같은 지시)
#:
#: ★여기 없는 이름은 `none` 이다 (읽기 도구가 대부분이다).
#: ★앱 액션의 위험도는 `src/lib/appActions.ts` 가 든다 — **같은 낱말**을 쓴다.
TOOL_RISK = {
    # 되돌릴 수 있지만 통째로 갈아 끼운다
    "update_card": "ask",   # `undo_change` 가 옛 내용으로 되살린다 (회귀로 확인)
    "write_guide": "ask",   # 지침 **전문**을 갈아 끼운다. 되살아난다
    "move_files": "ask",    # ★자동 되돌리기가 없다 (파일은 그대로지만 복구 경로가 없다)
    "delete_card": "ask",   # 되돌아오지만 **사용자가 넣어 둔 재료**가 사라진다
    # ★★`create_card` 도 묻는다 (사용자 지시 2026-08-25): 조수가 요청도 없이 덱에 카드를
    #   쌓아 두는 일이 잦았다 — 저장은 **사용자가 하는 것**이 기본이다 (지침에도 적었다).
    "create_card": "ask",
    # ★만들거나 되살리는 쪽은 **잃는 것이 없다** → none
    #   create_card · create_folder · restore_files · 읽기 전부
}

#: 앱 액션 목록 — **빌드할 때** 프론트에서 뽑아 둔 것 (`scripts/gen-actions.mjs`)
ACTIONS_JSON = Path(__file__).resolve().parent / "actions.json"
_actions_cache: list[dict] | None = None
#: 캐시를 찍은 시점의 파일 시각 — 파일이 바뀌면 다시 읽는다 (아래 ★★주)
_actions_mtime: float = -1.0


def _actions() -> list[dict]:
    """`actions.json` → 도구 명세.

    ★★**앱이 접속할 때 받지 않는다.** 그 방식은 이미 써 보고 버렸다 — 화면이 붙는 순간에만
      올려서, 코드가 갱신돼도 소켓이 그대로면 **도구가 0개**로 보였다 (이 파일 머리 주석).
    ★파일이 없으면 **빈 목록**이다 (개발 중에 아직 안 뽑았을 수 있다). 앱 도구가 통째로
      사라지므로 콘솔에 남긴다 — 조용히 비면 「도구가 없다」의 원인을 못 찾는다."""
    global _actions_cache, _actions_mtime
    # ★★**파일이 바뀌면 다시 읽는다** (2026-08-25). 예전에는 한 번 읽고 영영 들고 있어서,
    #   액션을 더하고 `gen-actions.mjs` 를 돌려도 **돌고 있던 백엔드에는 안 보였다** —
    #   조수는 없는 도구를 부를 수 없으니 그냥 넘어가고, 화면에는 아무 까닭도 안 남는다.
    #   (실측: `name_chat` 을 더한 직후 조수가 이름을 안 짓고 작업을 시작했다.)
    #   ★`stat` 한 번은 도구 목록을 낼 때만 도는 값싼 일이다.
    try:
        mtime = ACTIONS_JSON.stat().st_mtime
    except OSError:
        mtime = -1.0
    if _actions_cache is not None and mtime == _actions_mtime:
        return _actions_cache
    _actions_mtime = mtime
    out: list[dict] = []
    try:
        raw = json.loads(ACTIONS_JSON.read_text(encoding="utf-8"))
        for a in raw.get("actions") or []:
            props, req = {}, []
            for name, spec in (a.get("args") or {}).items():
                p: dict[str, Any] = {"type": spec.get("type", "string"),
                                     "description": spec.get("desc", "")}
                if spec.get("items"):
                    p["items"] = {"type": spec["items"].get("type", "string")}
                props[name] = p
                if spec.get("required"):
                    req.append(name)
            out.append({
                "name": a["id"],
                "description": a.get("desc", ""),
                "inputSchema": {"type": "object", "properties": props, "required": req},
            })
    except FileNotFoundError:
        print(f"[agent] {ACTIONS_JSON.name} 이 없습니다 — `node scripts/gen-actions.mjs` 를 돌리세요.")
    except Exception as e:
        print(f"[agent] {ACTIONS_JSON.name} 을 못 읽었습니다: {e}")
    _actions_cache = out
    return out


def _is_action(name: str) -> bool:
    """앱이 해야 하는 액션인가 — `call` 이 앱으로 넘길지 가르는 자리"""
    return any(a["name"] == name for a in _actions())



def fail(code: str, message: str, retry: str = "safe", **extra) -> dict:
    """조수가 **스스로 고칠 수 있는** 오류 (설계 2-4).

    ★★`retry` 를 반드시 싣는다 — **시간 초과는 `unsafe`** 다. 예전에는 "앱이 제때 답하지
      않았습니다"만 와서 조수가 그냥 다시 시도했고, 생성이면 **Anlas 가 두 배로** 나갔다.
    ★`candidates` 를 얹으면 대개 한 번에 고친다 (비슷한 이름 셋).
    ★앱 액션도 같은 모양을 쓴다 (`src/lib/actions.ts` 의 `err`) — 두 경로가 갈리면
      조수가 오류를 다루는 법을 두 벌 배워야 한다."""
    out = {"code": code, "message": message, "retry": retry}
    out.update({k: v for k, v in extra.items() if v})
    return {"error": out}


def near_by(want: str, names: list[str]) -> list[str]:
    """비슷한 이름 셋 — 맞춤법 교정이 아니라 **골라 주기**다 (`lib/actions.ts` 의 `nearBy`)."""
    w = (want or "").strip().lower()
    if not w:
        return names[:3]
    hit = [n for n in names if w in n.lower() or n.lower() in w]
    return (hit or names)[:3]


def _tab_gen(spec: dict) -> dict:
    """지금 탭의 **생성 옵션 전부** — 모델·크기·스텝·시드·CFG… (선결 조건 3-6).

    ★★**담기는 자리는 탭이다** (`src/store/gen.ts` 의 `stashGen`). 다만 지금 보고 있는 탭의
      값은 **화면 메모리에만** 있다가 탭을 떠날 때 담기므로, 여기서 읽은 것이 화면과
      다를 수 있다. 그래서 조수가 값을 **고칠 때는 파일이 아니라 액션**으로 간다
      (`docs/agent-actions-design.md` 4절).
    ★없는 탭·옛 워크스페이스는 빈 것을 돌려준다 — 지어내지 않는다."""
    for c in spec.get("tabs") or []:
        if c.get("id") == spec.get("activeTab"):
            return dict(c.get("gen") or {})
    return {}


class App:
    """앱에 **이름 붙은 행동**을 시키는 통로 (생성처럼 화면이 해야 하는 것).

    ★데이터 도구와 달리 여기는 앱이 꼭 필요하다. 앱이 없으면 **그 도구만** 오류를 돌려준다 —
      도구 목록 자체는 백엔드가 갖고 있으므로 사라지지 않는다."""

    def __init__(self, clients: dict):
        self.clients = clients
        self._waiting: dict[str, asyncio.Future] = {}
        # ★앱이 열어 둔 워크스페이스. 파일 도구의 기준이 된다 — 앱이 알려 준다.
        #   없으면 도구가 세운다 (코드가 대신 고르지 않는다).
        self.workspace: str = ""

    async def do(self, action: str, args: dict, timeout: float = 60.0, ask: bool = True) -> dict:
        if not self.clients:
            # ★앱을 켜면 그대로 다시 하면 된다 → safe
            return fail("app_off", "앱이 안 켜져 있습니다. PeroPix 를 켜고 다시 시켜 주세요.")
        cid = uuid.uuid4().hex[:8]
        fut: asyncio.Future = asyncio.get_running_loop().create_future()
        self._waiting[cid] = fut
        # ★`ask: false` 면 화면도 안 묻는다 — 앱 액션은 **화면이** 승인 카드를 띄우므로
        #   백엔드에서만 건너뛰면 바깥 요청이 그대로 카드에 걸린다 (`store/queue` 의 `runAction`)
        msg = {"type": "do", "id": cid, "action": action, "args": args or {}, "ask": ask}
        sent = False
        for _, ws in reversed(list(self.clients.items())):
            try:
                await ws.send_json(msg)
                sent = True
                break
            except Exception:
                continue
        if not sent:
            self._waiting.pop(cid, None)
            return fail("app_off", "앱에 보내지 못했습니다.")
        try:
            return await asyncio.wait_for(fut, timeout)
        except asyncio.TimeoutError:
            # ★★**시간 초과는 `unsafe`** 다 (설계 2-4). 앱이 이미 실행했을 수 있어서,
            #   조수가 그냥 다시 시도하면 **생성이 두 번 나가고 Anlas 가 두 배로** 든다.
            return fail("timeout", "앱이 제때 답하지 않았습니다. 이미 실행됐을 수 있으니 "
                        "다시 시키기 전에 상태를 먼저 확인하세요.", retry="unsafe")
        finally:
            self._waiting.pop(cid, None)

    def resolve(self, cid: str, result) -> None:
        fut = self._waiting.get(cid)
        if fut and not fut.done():
            fut.set_result(result if isinstance(result, dict) else {"result": result})


#: 도구 줄에 보일 카드 종류 이름
#: 카드 종류 → **화면에 쓰는 이름**. ★★낱말표에서 뽑는다 (`shared/terms.json`) —
#:  손으로 적어 두었더니 화면은 「스타일·씬 그룹」인데 조수만 「그림체·씬 카드」라고 말했다
#:  (사용자 지적 2026-08-25). 같은 정보에 창구가 둘이면 반드시 갈린다.
_KIND_TERM = {"styles": "styleCard", "characters": "characterCard", "posesets": "sceneSetCard"}


def _kind_ko(kind: str) -> str:
    """그 카드 종류를 화면이 부르는 이름 (「스타일」·「캐릭터」·「씬 그룹」)."""
    key = _KIND_TERM.get(kind)
    for t in _terms():
        if t.get("key") == key:
            # 「덱의 스타일 카드」 → 「스타일」
            ko = str((t.get("what") or {}).get("ko") or "")
            ko = ko.replace("덱의 ", "").split(" (")[0]
            return ko.replace(" 카드", "") or kind
    return kind


class Tools:
    """앱의 저장소를 그대로 쓴다 — 별도 경로를 만들면 화면과 어긋난다.

    ★★**바꾸는 도구는 `did` 와 `at` 을 돌려준다** (사용자 지시 2026-08-08 · 2026-08-24).
      `did` 는 **무엇을** 바꿨나, `at` 은 **어디를** 바꿨나다. 화면은 그 줄을 「고침 줄」로
      따로 그리고, 누르면 그 자리를 연다 (`docs/terms-plan.md` §3-4).
      ★읽기 도구에는 붙이지 않는다 (소음이 된다).
      ★★**고치는 도구는 `at` 없이 성공하면 안 된다** — 판정이 잡는다."""

    def __init__(self, cards, store, files_mod, outputs: Path, meta_mod, notify: Callable, app: App,
                 guide=None, log=None):
        self.cards = cards
        # ★조수의 **변경 이력** (`agentlog.py`) — 되돌릴 근거. 사람의 `Ctrl+Z` 와 섞지 않는다
        self.log = log
        # ★앱이 들고 있는 **사용자 지침** (`guide.py`) — 엔진이 무엇이든 같은 것을 본다
        self.guide = guide
        self.store = store
        self.files = files_mod
        self.outputs = outputs
        self.meta = meta_mod
        # 데이터가 바뀌면 화면에 알린다 (화면은 다시 읽기만 한다)
        self.notify = notify
        # 생성처럼 **앱이 해야 하는 것**은 여기로 시킨다
        self.app = app

    def _mark(self, tool: str, did: str, at: dict, before=None, after=None,
              undoable: bool = True, why: str = "") -> dict:
        """변경 하나를 이력에 적고, 대화 줄이 가리킬 `at` 을 돌려준다.

        ★★`at` 은 **어디를 고쳤나**다 — 화면이 그것으로 그 자리를 연다. 이력의 id(`log`)만
          싣고 **본문(before/after)은 안 싣는다**: 대화에 실으면 매 턴 컨텍스트에 딸려 온다.
        ★이력을 못 적어도 `at` 은 돌려준다 — 자리는 알려 줘야 한다."""
        rid = self.log.add(tool, did, at, before, after, undoable, why) if self.log else ""
        return {**at, "log": rid} if rid else dict(at)

    def _mark_app(self, name: str, out: dict) -> dict:
        """**앱이 한 일**도 같은 이력에 담는다 (프롬프트 편집·생성).

        ★앱은 `did`·`at`·`before`·`after` 를 돌려주고, 이력에 담는 일은 여기서 한다 —
          이력 파일이 백엔드에 있어서다.
        ★★`before`·`after` 는 **여기서 걷어낸다.** 그대로 두면 고친 프롬프트 전문이 도구
          결과로 LLM 에 실려 매 턴 컨텍스트에 눌러앉는다 (`agentlog.rows` 와 같은 이유)."""
        if not isinstance(out, dict):
            return out
        if name == "generate" and out.get("ok") and not out.get("at"):
            # ★생성은 **못 되돌린다** — 이미 Anlas 를 썼다. 그래도 자리는 남긴다
            n = out.get("queued", 0)
            where = out.get("sceneGroup") or ""
            did = f"「{where}」 씬 그룹에 {n}장을 넣음" if where else f"큐에 {n}장을 넣음"
            out["did"] = did
            out["at"] = self._mark("generate", did, {"kind": "queue"},
                                   undoable=False, why="이미 Anlas 를 쓴 생성입니다")
            return out
        if out.get("at") and out.get("did"):
            # ★★**되돌릴 수 없는 것을 되돌릴 수 있다고 적지 않는다** (2026-08-24).
            #   앱이 `undoable: false` 와 까닭을 실어 보내면 그대로 적는다 — 그러면
            #   `list_changes` 에 그렇게 뜨고 `undo_change` 가 까닭을 말하며 멈춘다.
            #   ★안 그러면 조수가 「되돌렸습니다」라고 말해 놓고 아무 일도 안 일어난다.
            can = out.pop("undoable", True)
            out["at"] = self._mark(name, str(out["did"]), dict(out["at"]),
                                   before=out.pop("before", None), after=out.pop("after", None),
                                   undoable=bool(can), why=str(out.pop("why", "") or ""))
        out.pop("before", None)
        out.pop("after", None)
        out.pop("undoable", None)
        out.pop("why", None)
        return out

    # ── 사용자 지침 ──────────────────────────────────────────────
    def _read_guide(self, a: dict) -> dict:
        """지금 지침 **전문**. 고치기 전에 반드시 이걸로 읽는다 (통째로 덮어쓰므로)."""
        if not self.guide:
            return fail("blocked", "지침 저장소가 없습니다.", retry="never")
        return {"text": self.guide.read()}

    def _write_guide(self, a: dict) -> dict:
        """지침을 **통째로** 갈아 끼운다.

        ★목록에 한 줄씩 더하던 방식을 버렸다 (사용자 지적 2026-08-08) — 이건 '기억'이 아니라
          **지침**이라, "지금까지의 지침을 종합해 봐" 같은 일이 안 됐다.
        ★직전 내용은 `data/.guide-bak/` 에 남는다 — 자유 편집이라 한 번에 다 날릴 수 있다."""
        if not self.guide:
            return fail("blocked", "지침 저장소가 없습니다.", retry="never")
        r = self.guide.write(str(a.get("text") or ""))
        if r.get("error"):
            return r
        self.notify("guide")
        if r.get("unchanged"):
            r["did"] = "지침 그대로 (바뀐 것 없음)"
        else:
            b = r.get("before") or {}
            r["did"] = (f"지침을 고침 — {b.get('lines', 0)}줄 → {r['lines']}줄 "
                        f"({b.get('chars', 0)}자 → {r['chars']}자)")
            r["at"] = self._mark("write_guide", r["did"], {"kind": "guide"},
                                 before=b.get("text"), after=str(a.get("text") or ""))
        return r

    # ── 목록 ────────────────────────────────────────────────────
    def specs(self) -> list[dict]:
        """★**앱 액션은 빌드 때 뽑은 파일에서 온다** (`actions.json`, 2026-08-24).

        표(`_table`)에 손으로 적던 앱 도구가 **스키마는 여기, 구현은 앱**으로 나뉘어 있어
        조용히 어긋났다 (`generate` 의 `sceneGroup`). 이제 한쪽(`src/lib/appActions.ts`)에서 뽑는다.
        ★같은 이름이 표에도 있으면 **표가 진다** — 옮기는 중에 두 벌이 되지 않게."""
        out = [
            {"name": n, "description": d, "inputSchema": s}
            for n, d, s, _ in self._table()
        ]
        have = {x["name"] for x in out}
        for a in _actions():
            if a["name"] in have:
                # ★옮겨진 것 — 파일 쪽 설명·스키마로 갈아 끼운다 (정본이 그쪽이다)
                for x in out:
                    if x["name"] == a["name"]:
                        x["description"], x["inputSchema"] = a["description"], a["inputSchema"]
                continue
            out.append(a)
        return out

    def _what(self, name: str, a: dict) -> str:
        """승인 카드에 뜰 **한 줄** — 무엇을 하려는지 사람 말로.

        ★도구 설명(`_table` 의 둘째 칸)을 쓰면 안 된다. 그쪽은 LLM 용이라 길고 ★표시가
          섞여 있어 카드가 설명서처럼 보인다 (QA 실측 2026-08-25, 앱 액션에서 밟은 자리)."""
        if name == "update_card":
            cur = self._find_card(str(a.get("kind", "")), str(a.get("id", "")))
            if cur and "__ambiguous__" in cur:
                cur = None   # ★여럿이면 이름을 짐작해 적지 않는다 (실행할 때 되묻는다)
            return f"카드 「{(cur or {}).get('name', a.get('id'))}」 를 통째로 덮어씁니다"
        if name == "write_guide":
            n = len(str(a.get("text") or "").splitlines())
            return f"조수 지침을 통째로 갈아 끼웁니다 ({n}줄)"
        if name == "move_files":
            return f"그림 {len(a.get('files') or [])}장을 「{a.get('dest', '')}」 로 옮깁니다"
        return name

    async def approve(self, name: str, what: str) -> dict | None:
        """★★**백엔드 도구도 같은 승인을 지난다** (사용자 지시 2026-08-25: *"백엔드든 뭐든
        동일 규칙을 적용해야됨"*).

        예전에는 앱 액션만 승인 카드를 지나고 백엔드 도구(카드 덮어쓰기·지침·파일 이동)는
        **아무것도 안 묻고 바로** 했다 — 기준이 두 벌이었다.
        ★묻는 자리는 앱이다 (`ask_approve` → `lib/approve`): 자동 승인 설정도 거기 있고,
          카드도 거기서 그린다. 백엔드는 **위험도만** 정해 넘긴다.
        ★승인이 필요 없으면 `None`, 막혔으면 그대로 돌려줄 오류를 준다."""
        risk = TOOL_RISK.get(name, "none")
        if risk == "none":
            return None
        # ★앱 통로 자체가 없는 구성(회귀 하네스 등)에서는 묻지 않는다 — 여기서 죽으면
        #   승인과 무관한 테스트까지 함께 넘어진다 (`test_guide` 가 그렇게 깨졌다)
        if self.app is None:
            return None
        if not self.app.clients:
            # ★앱이 없으면 물을 수 없다 — 조용히 실행하지 않는다 (기준을 건너뛰는 셈이 된다)
            return fail("app_off", "승인이 필요한 작업입니다. PeroPix 를 켜고 다시 시켜 주세요.")
        r = await self.app.do("ask_approve", {"title": what, "risk": risk}, timeout=600.0)
        if r.get("error"):
            return r
        if r.get("okay"):
            return None
        if r.get("busy"):
            return fail("blocked", "앞선 승인 요청이 아직 화면에 떠 있습니다. 그것을 먼저 처리해 주세요.")
        return fail("refused", "사용자가 승인하지 않았습니다.", retry="never")

    #: **우리 대화를 건드리는** 도구 — 바깥 에이전트에게는 열지 않는다 (사용자 결정 2026-08-31).
    #  ★묻는 것도 이름 붙이는 것도 **제 대화에서** 할 일이다. 여기서 열어 두면 사용자가 쓰던
    #    대화에 남의 물음이 끼어들고, 대화 이름이 바깥에서 바뀐다.
    CHAT_TOOLS = {"ask_user", "name_chat"}

    async def call(self, name: str, args: dict, outside: bool = False) -> dict:
        if outside and name in self.CHAT_TOOLS:
            return fail("not_here", "이 도구는 PeroPix 앱 안의 조수만 씁니다. "
                        "묻거나 이름 붙이는 것은 당신 쪽 대화에서 하세요.", retry="never")
        # ★★표에 없는 이름이라도 **액션 목록에 있으면 앱에 시킨다** (2026-08-24).
        #   ★기다리는 시간이 넉넉해야 한다: 되돌릴 수 없는 일 앞에서는 앱이 **승인 카드**를
        #     띄우고 사람이 누를 때까지 멈춘다 (`docs/agent-actions-design.md` 2-5).
        #     `ask_user` 와 같은 취급으로 두지 않으면, 사람이 답하는 중에 도구가 시간 초과로
        #     끝나 놓고 **그 뒤에 실행**되는 어긋남이 난다.
        if not any(n == name for n, _, _, _ in self._table()) and _is_action(name):
            return self._mark_app(name, await self.app.do(name, args or {}, timeout=600.0, ask=not outside))
        for n, _, _, fn in self._table():
            if n != name:
                continue
            # ★`fn` 이 없는 도구는 **앱이 하는 것**이다 (생성처럼 화면이 조립해야 하는 일)
            if fn is None:
                # ★사람이 답할 때까지 기다리는 도구는 넉넉히 (클로드 코드의 stdio MCP 유휴
                #   한계가 30분이라 그 안이면 된다)
                # ★★**사람을 기다리는 도구는 넉넉히.** `ask_user` 만이 아니라 **승인 카드가
                #   뜰 수 있는 것 전부**가 그렇다 (2026-08-24). 짧게 두면 사람이 승인을 누르는
                #   동안 도구가 시간 초과로 끝나 놓고 **그 뒤에 실행**되는 어긋남이 난다
                #   (조수는 실패로 보고했는데 실제로는 지워진다).
                out = await self.app.do(name, args or {}, timeout=600.0, ask=not outside)
                return self._mark_app(name, out)
            # ★★**실행 전에 승인을 지난다** — 앱 액션과 같은 기준이다 (`approve`).
            #   ★무엇을 하려는지 한 줄로 보여 준다: 카드·지침은 이름을, 파일은 장 수를.
            # ★바깥 에이전트는 지나간다 (`server.agent_call` 의 ★★주)
            gate = None if outside else await self.approve(name, self._what(name, args or {}))
            if gate is not None:
                return gate
            try:
                out = fn(args or {})
                if inspect.isawaitable(out):
                    out = await out
                return out if isinstance(out, dict) else {"result": out}
            except Exception as e:
                return {"error": f"{type(e).__name__}: {e}"}
        return fail("not_found", f"모르는 도구: {name}", retry="never",
                    candidates=near_by(name, [x["name"] for x in self.specs()]))

    # ── 표 ──────────────────────────────────────────────────────
    def _table(self) -> list[tuple[str, str, dict, Callable]]:
        obj = lambda props, req=(): {"type": "object", "properties": props, "required": list(req)}
        s = lambda d: {"type": "string", "description": d}
        n = lambda d: {"type": "number", "description": d}
        arr = lambda d, it: {"type": "array", "description": d, "items": it}
        blk = obj({"label": s("블록 이름"), "tags": s("태그들 — 쉼표로 구분")}, ["label", "tags"])

        return [
            (
                "list_workspaces",
                "워크스페이스 목록 — 이름과 마지막 수정 시각.",
                obj({}),
                lambda a: {"items": self.store.list()},
            ),
            (
                "get_workspace",
                "작업 상태 전부 — 탭·포즈 슬롯·프롬프트 블록·캐릭터. **지금 사용자가 만지고 있는 것**이 "
                "여기 들어 있다 (화면은 이 파일을 보여 줄 뿐이다). 이름을 비우면 가장 최근 것.",
                obj({"name": s("워크스페이스 이름 (비우면 최근)"), "records": n("최근 생성물 몇 개까지 (기본 0)")}),
                self._get_ws,
            ),
            (
                "list_cards",
                "저장된 카드 — 그림체(styles) · 캐릭터(characters) · 씬 카드(posesets).",
                obj({"kind": s('"styles" | "characters" | "posesets" — 비우면 전부')}),
                self._list_cards,
            ),
            (
                "get_card",
                "카드 하나의 내용 (블록·슬롯).",
                obj({"kind": s("카드 종류"), "id": s("카드 id 또는 이름")}, ["kind", "id"]),
                self._get_card,
            ),
            (
                "create_card",
                "카드를 **새로 만든다** — 언제나 새로 추가하고 기존 것을 덮지 않는다. "
                "캐릭터 디자인·그림체·씬 카드를 남길 때 쓴다.",
                obj(
                    {
                        "kind": s('"styles" | "characters" | "posesets"'),
                        "name": s("카드 이름"),
                        "blocks": arr("그림체·캐릭터의 프롬프트 블록", blk),
                        "uc": arr("Undesired Content 블록", blk),
                        "cells": arr("씬 카드의 칸들", obj({"name": s("포즈 이름"), "blocks": arr("블록", blk)}, ["name"])),
                    },
                    ["kind", "name"],
                ),
                self._create_card,
            ),
            (
                "update_card",
                "★기존 카드를 **덮어쓴다.** 되도록 create_card 로 새로 만들고, 정말 고쳐야 할 때만 쓴다. "
                "직전 내용은 백업으로 남는다.",
                obj(
                    {
                        "kind": s("카드 종류"),
                        "id": s("카드 id"),
                        "name": s("새 이름 (비우면 그대로)"),
                        "blocks": arr("갈아 끼울 프롬프트 블록", blk),
                        "uc": arr("갈아 끼울 UC 블록", blk),
                        "cells": arr("갈아 끼울 포즈 칸", obj({"name": s("포즈 이름"), "blocks": arr("블록", blk)}, ["name"])),
                    },
                    ["kind", "id"],
                ),
                self._update_card,
            ),
            (
                "delete_card",
                "★**덱에서 카드를 지운다.** «네가 만든 카드 지워줘» 같은 요청이 이것이다. "
                "되돌릴 수 있다 — 지운 뒤 사용자가 «되돌려» 라고 하면 undo_change 로 되살린다. "
                "★어떤 카드가 있는지는 list_cards 로 먼저 본다.",
                obj({"kind": s('"styles" | "characters" | "posesets"'),
                     "id": s("카드 id 또는 이름")}, ["kind", "id"]),
                self._delete_card,
            ),
            (
                "search_tags",
                "단부루 태그 사전을 찾는다. **실재하는 태그만 쓰기 위해** 프롬프트를 짜기 전에 확인한다. "
                "언더바로 찾고(long_hair), 넣을 때는 띄어쓰기로 쓴다(long hair).",
                obj({"query": s("찾을 말 (영어)"), "max": n("최대 개수 (기본 15)")}, ["query"]),
                self._search_tags,
            ),
            (
                "list_files",
                "그 워크스페이스 안의 폴더·파일. ★뿌리는 **워크스페이스 폴더**다 — 그림은 `output/멀티/<탭>/<씬 그룹>/` 아래에 있다 (옛것은 `output/싱글/…`·`싱글/…`·`work/…`).",
                obj({"folder": s("상대경로 — 뿌리는 빈 문자열"), "page": n("쪽 (기본 1)"),
                     "workspace": s("어느 워크스페이스인지 — 비우면 앱이 열어 둔 것")}),
                self._list_files,
            ),
            (
                "create_folder",
                "그 워크스페이스 안에 폴더를 만든다 (정리용).",
                obj({"parent": s("부모 폴더 상대경로"), "name": s("만들 이름"),
                     "workspace": s("어느 워크스페이스인지 — 비우면 앱이 열어 둔 것")}, ["name"]),
                self._mkdir,
            ),
            (
                "move_files",
                "생성물을 그 워크스페이스 안의 다른 폴더로 옮긴다 (캐릭터별 정리 등).",
                obj({"files": arr("옮길 파일 상대경로들", {"type": "string"}), "dest": s("받을 폴더"),
                     "workspace": s("어느 워크스페이스인지 — 비우면 앱이 열어 둔 것")}, ["files", "dest"]),
                self._move,
            ),
            (
                "create_tab",
                "★**탭을 새로 만든다** (윗줄). 만들고 **그리로 옮겨 간다** — 이어서 "
                "edit_current_prompt·generate 를 부르면 이 탭에 걸린다. 앱이 켜져 있어야 한다.",
                obj({"name": s("탭 이름 (비우면 기본 이름)")}),
                None,  # 앱에 시킨다 (아래 ★★주)
            ),
            (
                "create_scene_group",
                "★**씬 그룹을 새로 만든다** (지금 탭 아래). `scenes` 를 주면 그 이름의 씬들과 함께 "
                "열고, 비우면 씬 없는 빈 씬 그룹이다. 앱이 켜져 있어야 한다.",
                obj({"name": s("씬 그룹 이름 (비우면 기본 이름)"),
                     "scenes": arr("씬 이름들 — 비우면 씬 없이", {"type": "string"}),
                     "tab": s("어느 탭 아래에 — 비우면 지금 보고 있는 탭")}),
                None,
            ),
            (
                "create_scene",
                "★**씬 칸을 하나 더한다.** `sceneGroup` 을 비우면 지금 보고 있는 씬 그룹에. "
                "앱이 켜져 있어야 한다.",
                obj({"name": s("씬 이름 (비우면 기본 이름)"),
                     "sceneGroup": s("어느 씬 그룹에 — 비우면 지금 보고 있는 씬 그룹")}),
                None,
            ),
            (
                "generate",
                "★**생성을 큐에 넣는다.** 그 씬 그룹의 잠기지 않은 씬 전부를 count 바퀴 돈다 "
                "(씬이 하나면 count 장이다). 비우면 지금 보고 있는 씬 그룹, workspace·sceneGroup 을 주면 "
                "**거기로** 넣는다 (화면은 안 옮긴다). 앱이 켜져 있어야 한다. Anlas 가 든다 — "
                "사용자가 장수를 말했을 때만 쓴다.",
                obj({"count": n("몇 바퀴. 기본 1"),
                     "workspace": s("어디에 넣을지 — 비우면 지금 보고 있는 곳"),
                     "sceneGroup": s("어느 씬 그룹에 넣을지 — 비우면 그 워크스페이스의 활성 씬 그룹")}),
                None,  # 앱에 시킨다 (아래 _call_app)
            ),
            (
                "read_guide",
                "사용자가 정한 **지침 전문**을 읽는다. 이 지침은 매 대화에 자동으로 실리므로 "
                "평소엔 읽을 필요가 없다 — **고치기 전에** 읽어라 (통째로 덮어쓰기 때문에 "
                "읽지 않고 쓰면 앞서 있던 내용이 사라진다).",
                obj({}),
                self._read_guide,
            ),
            (
                "write_guide",
                "★사용자 지침을 **통째로** 갈아 끼운다. 다음 대화에도, 엔진(API·CLI)을 바꿔도 "
                "그대로 따라온다.\n"
                "쓰는 때: 사용자가 \"앞으로는 ~\"·\"이 태그는 쓰지 마\"·\"기억해\" 처럼 "
                "**계속 지킬 것**을 말했을 때, 또는 \"그건 이제 됐어\" 처럼 되물릴 때, "
                "또는 \"지침을 정리해 줘\" 처럼 손보라고 할 때.\n"
                "★**read_guide 로 먼저 읽고**, 있던 내용에 더하거나 고쳐서 **전문**을 준다. "
                "★사용자가 말하지 않은 것을 넣지 마라. 짧게 유지해라 — 매 턴 프롬프트에 실린다.",
                obj({"text": s("지침 전문 (마크다운). 빈 문자열이면 지침을 비운다)")}, ["text"]),
                self._write_guide,
            ),
            (
                "ask_user",
                "사용자에게 **선택지를 주고** 묻는다. ★**아무 때나 쓰지 않는다** — 사용자가 골라야 하고, "
                "고를 것이 **또렷하게 갈릴 때**만 쓴다 (예: 수채화풍 / 플랫 / 셀 셰이딩). "
                "그냥 되물을 일이면 도구 대신 **답글에 글로** 물어라. "
                "선택지는 2~4개, 각각 무엇이 달라지는지 한 줄로. "
                "여러 개를 함께 고를 수 있는 물음이면 multi=true 로 준다 (예: \"어떤 감정들을 넣을까요\"). "
                "★내장 AskUserQuestion 은 이 환경에서 안 되니 물을 때는 반드시 이 도구다. "
                "답이 올 때까지 기다린다(최대 10분).",
                obj(
                    {
                        "question": s("물어볼 것 — 한 문장"),
                        "header": s("짧은 제목 (선택)"),
                        "options": arr(
                            "선택지 2~4개",
                            obj({"label": s("보기 이름"), "description": s("무엇이 달라지는지")}, ["label"]),
                        ),
                        "multi": {
                            "type": "boolean",
                            "description": "여러 개를 함께 고를 수 있게 할지 (기본 false — 하나만)",
                        },
                    },
                    ["question", "options"],
                ),
                None,  # 앱에 시킨다
            ),
            (
                "edit_current_prompt",
                "★**보고 있는 것을 고친다** (덱의 카드에는 안 닿는다). "
                "\"지금 그림체를 더 플랫하게\"·\"키키 의상 바꿔 줘\" 같은 요청은 이것으로 한다. "
                "mode=\"add\" 는 블록을 새로 붙이고, \"replace\" 는 같은 이름의 블록을 갈아 끼운다 "
                "(없으면 새로 붙는다). "
                "★★**고칠 자리는 주소로 준다**: `workspace` → `tab` → `sceneGroup`. 셋 다 "
                "`get_workspace` 가 이미 준 값이다 (씬 그룹마다 `id`·`tab`, 그 위에 `tabs`·`activeTab`). "
                "비우면 지금 보고 있는 자리다. "
                "★★**씬 그룹은 id 로 줘라.** 「새 씬 그룹」 같은 이름은 탭마다 있어서, 이름만 주면 "
                "엉뚱한 탭을 고치고 성공이라 답하던 자리다. 하나로 안 좁혀지면 **되묻는다**. "
                "★`workspace` 가 지금 열린 것과 다르면 **고치지 않고 알린다** — 편집기는 열린 "
                "워크스페이스 하나뿐이라 몰래 고칠 길이 없다. "
                "★답에는 **어느 탭의 어느 씬 그룹**를 고쳤는지가 적혀 있다 — 사용자가 보고 있는 "
                "탭과 다르면 성공이라고 말하지 말고 그 사실을 알려라. "
                "★`area` 에 없는 캐릭터 이름을 주면 **그 자리를 새로 만든다.** "
                "앱이 켜져 있어야 한다.",
                obj(
                    {
                        "area": s('어디를 — "base"(베이스 프롬프트) · "baseUc"(베이스 UC) · '
                                  '캐릭터는 그 이름 · 캐릭터 UC 는 "<이름>:uc"'),
                        "label": s("블록 이름 (예: 그림체)"),
                        "tags": s("태그들 — 쉼표로 구분"),
                        "mode": s('"add"(기본, 뒤에 붙임) · "replace"(같은 이름을 갈아 끼움) · '
                                  '"remove"(그 블록을 걷어냄 — 되돌릴 수 있다)'),
                        "block": s("어느 블록을 — **블록 id** (`get_workspace` 가 블록마다 준다). "
                                   "★블록 이름은 대개 다 같으므로(기본 이름) **id 가 정본**이다. "
                                   "이름이 여럿에 걸리면 고르지 않고 되묻는다"),
                        "workspace": s("어느 워크스페이스 — 비우면 지금 열린 것 (다르면 거절한다)"),
                        "tab": s("어느 탭 — id 가 정확하다 (이름도 받는다). 비우면 지금 탭"),
                        "sceneGroup": s("어느 씬 그룹 — **id 로** 줘라 (이름은 탭마다 겹친다). 비우면 지금 씬 그룹"),
                        "scene": s("씬 칸 하나를 고칠 때 그 씬의 이름이나 id "
                                   "(주면 area·label 은 쓰지 않는다 — 칸에는 블록이 하나뿐이다)"),
                    },
                    ["area", "label", "tags"],
                ),
                None,  # 앱에 시킨다
            ),
            (
                "list_changes",
                "★**내가 이 앱에서 바꾼 것들** — 최근 것부터. 사용자가 «되돌려» 라고 하면 "
                "이걸로 무엇을 되돌릴지 먼저 고른다. 사람이 손으로 고친 것은 여기 없다 "
                "(그건 사용자가 Ctrl+Z 로 되돌린다).",
                obj({"limit": n("몇 줄까지. 기본 10")}),
                self._list_changes,
            ),
            (
                "undo_change",
                "★**그 변경을 되돌린다** (`list_changes` 의 id). 되돌리는 것도 하나의 변경이라 "
                "이력에 남는다 — 되돌린 것을 다시 되돌릴 수 있다. 못 되돌리는 것은 까닭을 말한다.",
                obj({"id": s("되돌릴 변경의 id")}, ["id"]),
                self._undo_change,
            ),
            (
                "read_image",
                "★**그림을 직접 본다.** 생성물을 눈으로 확인해야 하는 요청 — «방금 뽑은 거 "
                "확인해서»·«이 그림이랑 비슷하게»·«잘 나왔어?» 에 쓴다. "
                f"한 번에 최대 {MAX_IMAGES}장이고, 줄여서 싣는다 (긴 변 512). "
                "★경로는 `list_files`·`get_workspace`(records) 가 준 것을 그대로 쓴다.",
                obj({"files": arr("볼 그림들 — 워크스페이스 기준 상대경로", {"type": "string"}),
                     "file": s("한 장만 볼 때"),
                     "workspace": s("어느 워크스페이스인지 — 비우면 앱이 열어 둔 것")}),
                self._read_image,
            ),
            (
                "list_trash",
                "★**휴지통에 든 것** — 최근에 버린 것부터. 지운 그림은 24시간 동안 여기 있다가 "
                "앱을 켤 때 비워진다. 사용자가 «아까 지운 거 살려줘» 라고 하면 이걸로 먼저 찾는다. "
                "★사람이 지운 것도 여기 있다 (list_changes 는 내가 한 것만 보여 준다).",
                obj({"limit": n("몇 개까지. 기본 30"),
                     "workspace": s("어느 워크스페이스인지 — 비우면 앱이 열어 둔 것")}),
                self._list_trash,
            ),
            (
                "restore_files",
                "★**휴지통에서 되살린다.** `list_trash` 가 준 줄을 그대로 넘긴다. "
                "★그 사이 같은 이름이 생겼으면 덮지 않고 번호를 붙인다 — 새 이름을 돌려주니 "
                "사용자에게 그것을 말해라.",
                obj({"items": arr("되살릴 것 — list_trash 의 줄 그대로",
                                  obj({"file": s("원래 자리"), "at": s("휴지통 안 이름")}, ["file", "at"])),
                     "workspace": s("어느 워크스페이스인지 — 비우면 앱이 열어 둔 것")}, ["items"]),
                self._restore_files,
            ),
            (
                "read_image_meta",
                "생성물 한 장의 메타데이터 — 프롬프트·시드·설정. 무엇으로 만들었는지 되짚을 때.",
                obj({"file": s("워크스페이스 폴더 기준 상대경로"),
                     "workspace": s("어느 워크스페이스인지 — 비우면 앱이 열어 둔 것")}, ["file"]),
                self._read_meta,
            ),
        ]

    # ── 구현 ────────────────────────────────────────────────────
    def _get_ws(self, a: dict) -> dict:
        """★★**읽는 곳과 쓰는 곳을 맞춘다** (선결 조건 3-5, 2026-08-24).

        예전에는 이름이 없으면 `store.list()[0]` 을 봤다. 그 목록은 **이름순 정렬**이라
        (`workspace.Store.list`) 도구 설명의 "비우면 가장 최근 것"부터가 거짓이었고,
        쓰기는 앱이 연 것을 보므로 **다른 데를 읽고 다른 데에 쓸** 수 있었다.
        이제 쓰기와 같은 자리(`_ws_name`)를 본다."""
        # ★이 도구의 인자 이름은 `name` 이다 (파일 도구의 `workspace` 와 다르다 — 낱말표).
        name = str(a.get("name") or "").strip()
        if not name:
            # ★★**앱이 열어 둔 것을 먼저 본다** — 쓰기가 보는 자리와 같아야 한다.
            name = str(self.app.workspace or "").strip()
        if not name:
            lst = self.store.list()
            if not lst:
                return fail("not_found", "워크스페이스가 없습니다.", retry="never")
            # ★앱이 안 알려 줬을 때만 여기 온다 (헤드리스 MCP). **가장 최근에 고친 것**을
            #   고른다 — 이름순 첫 번째(옛 동작)는 아무 뜻이 없다.
            name = max(lst, key=lambda x: str(x.get("updatedAt") or ""))["name"]
        spec = self.store.load(name)
        if spec is None:
            return fail("not_found", f"그런 워크스페이스가 없습니다: {name}",
                        what="workspace", given=name,
                        candidates=near_by(name, [x["name"] for x in self.store.list()]))
        scene_groups = []
        for t in spec.get("sceneGroups", []):
            row = {"id": t.get("id"), "kind": t.get("kind"), "name": t.get("name")}
            if t.get("kind") == "sceneGroup":
                # ★어느 탭에 달렸는지 — 조수가 「키키 탭의 씬 그룹」를 고르려면 있어야 한다
                row["tab"] = t.get("tabId")
                row["scenes"] = _scenes(t)
                # ★★**카드 층을 함께 준다** (선결 조건 3-6). 씬을 옮기려면 **받을 카드의 id** 가
                #   필요한데 `_scenes` 는 카드 **이름**만 실어 줘서, 같은 이름의 카드가 둘이면
                #   조수가 고를 수 없었다.
                row["cards"] = [
                    {"id": k.get("id"), "name": k.get("name"),
                     "locked": bool(k.get("locked")), "scenes": len(k.get("cells") or [])}
                    for k in (t.get("cards") or [])
                ]
            p = _scene_group_prompt(spec, t)
            if p:
                row["prompt"] = {
                    "style": (p.get("style") or {}).get("name"),
                    "base": _view(p.get("base")),
                    "baseUc": _view(p.get("baseUc")),
                    # ★「캐릭터 프롬프트」다 — 덱의 **캐릭터 카드**와 다른 것이다 (낱말표)
                    #  ★★`id`·`on`·`center`·`stack` 을 함께 준다 (선결 조건 3-6): 꺼진 캐릭터를
                    #    켜거나 자리를 옮기려면 조수가 그 값을 **먼저 볼 수 있어야** 한다.
                    #  ★`center` 는 화면에서 설 자리(0~1)이고 **언제나 값이 있다**
                    #    (`store/prompt.ts` 의 `Char.center`) — 좌표를 안 쓰는 상태는
                    #    이 값을 비우는 것이 아니라 `use_coords` 를 끄는 것이다.
                    #  ★`stack` 은 순차 생성 대기줄이라 **수만** 준다 (본문은 카드가 들고 있다).
                    "characters": [
                        {"id": c.get("id"), "name": c.get("name"),
                         "on": c.get("on", True), "center": c.get("center"),
                         "stack": len(c.get("stack") or []),
                         "prompt": _view(c.get("prompt")), "uc": _view(c.get("uc"))}
                        for c in (p.get("chars") or [])
                    ],
                }
            scene_groups.append(row)
        out: dict[str, Any] = {
            "name": name,
            # ★★이름은 **화면 낱말**이다 (`docs/terms-plan.md` 의 낱말표) — 탭·씬 그룹·씬.
            #   저장 열쇠와 우연히 같아진 것이지 묶인 것이 아니다. 저장 쪽 이름을 또 바꾸면
            #   여기서 **옮겨 담아** 계약을 지킨다.
            "tabs": [{"id": c.get("id"), "name": c.get("name")} for c in (spec.get("tabs") or [])],
            "activeTab": spec.get("activeTab"),
            "sceneGroups": scene_groups,
            "activeSceneGroup": spec.get("activeSceneGroup"),
        }
        out["model"] = _tab_model(spec)
        # ★★**생성 옵션을 통째로 준다** (선결 조건 3-6). 예전에는 `model` 하나뿐이라
        #   "같은 시드로 다시" 같은 요청에서 조수가 지금 값을 **볼 수조차** 없었다.
        #   ★쓰기(액션)를 만들기 전에 읽기부터 채운다 — 못 읽는 값은 못 고친다.
        out["gen"] = _tab_gen(spec)
        limit = int(a.get("records", 0) or 0)
        if limit:
            recs = self.store.records(name, limit)
            out["records"] = recs[-limit:]
        return out

    def _list_cards(self, a: dict) -> dict:
        kinds = [a["kind"]] if a.get("kind") else ["styles", "characters", "posesets"]
        out = {}
        for k in kinds:
            out[k] = [{"id": c.get("id"), "name": c.get("name")} for c in self.cards.list(k)]
        return out

    def _find_card(self, kind: str, key: str) -> dict | None:
        """카드 하나 — ★★**id 가 먼저고, 같은 이름이 여럿이면 안 고른다** (2026-08-25).

        예전에는 목록에서 처음 걸리는 것을 집었다. 카드 이름은 겹칠 수 있고(덱은 언제나
        **새로 추가**다), `delete_card` 가 이 함수를 쓰므로 **엉뚱한 카드를 지울 수 있었다.**
        ★고르지 않고 되묻는 것은 화면 쪽 규칙과 같다 (`src/lib/findAt.ts`).
        ★여럿이면 `None` 이 아니라 **목록**을 돌려준다 — 부르는 쪽이 되묻는 오류를 만든다."""
        rows = self.cards.list(kind)
        for c in rows:
            if c.get("id") == key:
                return c
        named = [c for c in rows if c.get("name") == key]
        if len(named) == 1:
            return named[0]
        if len(named) > 1:
            return {"__ambiguous__": [f"{c.get('name')}#{c.get('id')}" for c in named]}
        return None

    def _get_card(self, a: dict) -> dict:
        c = self._find_card(str(a["kind"]), str(a["id"]))
        if c and "__ambiguous__" in c:
            # ★★여럿이면 **고르지 않는다** — 지우고 덮는 도구라 틀리면 되돌릴 수 없다
            return fail("ambiguous", f"「{a['id']}」 이름의 카드가 여럿입니다. id 로 골라 주세요.",
                        what=str(a["kind"]), given=str(a["id"]), candidates=c["__ambiguous__"])
        if not c:
            # ★★비슷한 이름 셋을 얹는다 — 종류가 틀렸는지 이름이 틀렸는지 조수가 가른다
            names = [str(x.get("name")) for x in self.cards.list(str(a["kind"]))]
            return fail("not_found", f"그런 카드가 없습니다: {a['id']}",
                        what=str(a["kind"]), given=str(a["id"]), candidates=near_by(str(a["id"]), names))
        out: dict[str, Any] = {"id": c.get("id"), "name": c.get("name")}
        if "base" in c:
            out["base"] = _view(c.get("base"))
        if "prompt" in c:
            out["prompt"] = _view(c.get("prompt"))
        if "uc" in c:
            out["uc"] = _view(c.get("uc"))
        if "cells" in c:
            out["cells"] = [{"name": x.get("name"), "blocks": _view(x.get("blocks"))} for x in c.get("cells", [])]
        return out

    def _card_body(self, kind: str, a: dict, base: dict | None = None) -> dict:
        card = dict(base or {})
        if a.get("name"):
            card["name"] = str(a["name"])
        if kind == "posesets":
            if a.get("cells") is not None:
                card["cells"] = [
                    {"name": str(c.get("name", "포즈")), "blocks": _blocks(c.get("blocks"))}
                    for c in a["cells"]
                ]
        else:
            key = "base" if kind == "styles" else "prompt"
            if a.get("blocks") is not None:
                card[key] = _blocks(a["blocks"])
            if a.get("uc") is not None:
                card["uc"] = _blocks(a["uc"])
        return card

    def _create_card(self, a: dict) -> dict:
        kind = str(a["kind"])
        card = self._card_body(kind, a, {"name": str(a["name"])})
        saved = self.cards.save(kind, card)
        self.notify("cards")
        did = f"{_kind_ko(kind)} 카드 만듦 — {saved.get('name')}"
        at = {"kind": "card", "cardKind": kind, "id": saved.get("id")}
        return {"ok": True, "id": saved.get("id"), "name": saved.get("name"),
                "did": did, "at": self._mark("create_card", did, at, after=saved)}

    def _update_card(self, a: dict) -> dict:
        kind = str(a["kind"])
        cur = self._find_card(kind, str(a["id"]))
        if cur and "__ambiguous__" in cur:
            # ★★여럿이면 **고르지 않는다** — 지우고 덮는 도구라 틀리면 되돌릴 수 없다
            return fail("ambiguous", f"「{a['id']}」 이름의 카드가 여럿입니다. id 로 골라 주세요.",
                        what=kind, given=str(a["id"]), candidates=cur["__ambiguous__"])
        if not cur:
            names = [str(x.get("name")) for x in self.cards.list(kind)]
            return fail("not_found", f"그런 카드가 없습니다: {a['id']}",
                        what=kind, given=str(a["id"]), candidates=near_by(str(a["id"]), names))
        # ★★**`.bak` 파일을 따로 남기지 않는다** (사용자 지적 2026-08-25). 바로 아래
        #   `_mark(..., before=cur)` 가 **같은 내용을 이력에 담고**, `undo_change` 가 그것으로
        #   실제로 되살린다 — 두 벌이었다. 원래 근거였던 *"사람이 확인할 창구가 없는 경로"* 도
        #   약해졌다: 지금은 앱이 켜진 채 돌고 사용자가 조수에게 「되돌려」라고 말하면 된다.
        saved = self.cards.save(kind, self._card_body(kind, a, cur))
        self.notify("cards")
        did = f"{_kind_ko(kind)} 카드 덮어씀 — {saved.get('name')}"
        at = {"kind": "card", "cardKind": kind, "id": saved.get("id")}
        return {"ok": True, "id": saved.get("id"),
                "did": did, "at": self._mark("update_card", did, at, before=cur, after=saved)}

    def _list_changes(self, a: dict) -> dict:
        """★본문(before/after)은 안 준다 — 고르라고 주는 목록이다 (`agentlog.rows` 주석)."""
        if not self.log:
            return {"items": []}
        return {"items": self.log.rows(int(a.get("limit", 10) or 10))}

    async def _undo_change(self, a: dict) -> dict:
        """이력 하나를 되돌린다.

        ★★**되돌릴 수 있는 것만** 되돌린다. 이미 Anlas 를 쓴 생성처럼 못 되돌리는 것은
          까닭을 말하고 끝낸다 — 조용히 아무것도 안 하면 사용자는 됐다고 믿는다."""
        if not self.log:
            return fail("blocked", "변경 이력이 없습니다.", retry="never")
        row = self.log.get(str(a["id"]))
        if not row:
            return fail("not_found", "그런 변경이 없습니다. list_changes 로 다시 보세요.")
        if not row.get("undoable", True):
            return fail("blocked", f"되돌릴 수 없습니다: {row.get('why') or row.get('did')}", retry="never")
        at = row.get("at") or {}
        kind = at.get("kind")

        # ★★**되돌리는 법을 변경이 스스로 들고 온다** (2026-08-25).
        #   `before` 가 `{action, args}` 면 그 액션을 그 인자로 부르면 되돌아간다 —
        #   이름 바꾸기·잠금 같은 것은 **반대 값으로 같은 액션을 부르는 것**이 곧 되돌리기다.
        #   ★갈래마다 되돌리는 코드를 새로 적지 않아도 되고, 액션이 늘어도 여기가 안 늘어난다.
        undo = row.get("before")
        if isinstance(undo, dict) and undo.get("action") and isinstance(undo.get("args"), dict):
            r = await self.app.do(str(undo["action"]), dict(undo["args"]), timeout=120.0)
            if r.get("error"):
                return r
            did = f"되돌림 — {row.get('did')}"
            return {"ok": True, "did": did, "at": self._mark("undo_change", did, at)}
        if kind == "card":
            ck, cid = at.get("cardKind"), at.get("id")
            before = row.get("before")
            if before is None:                      # 만든 것 → 지운다
                self.cards.delete(ck, cid)
                did = f"만들었던 카드를 지움 — {(row.get('after') or {}).get('name', cid)}"
            else:                                   # 덮어쓴 것 → 옛 내용으로
                self.cards.save(ck, before)
                did = f"카드를 되돌림 — {before.get('name', cid)}"
            self.notify("cards")
            return {"ok": True, "did": did,
                    "at": self._mark("undo_change", did, {"kind": "card", "cardKind": ck, "id": cid})}
        if kind == "guide":
            self.guide.write(str(row.get("before") or ""))
            self.notify("guide")
            did = "지침을 되돌림"
            return {"ok": True, "did": did, "at": self._mark("undo_change", did, {"kind": "guide"})}
        if kind == "prompt":
            # ★앱이 되돌린다 — 프롬프트는 **화면이 들고 있는 사본**이라 파일만 고칠 수 없다
            before = row.get("before")
            if not isinstance(before, dict):
                return fail("blocked", "되돌릴 내용이 남아 있지 않습니다.", retry="never")
            r = await self.app.do("restore_prompt", before, timeout=120.0)
            if r.get("error"):
                return r
            did = f"되돌림 — {row.get('did')}"
            return {"ok": True, "did": did, "at": self._mark("undo_change", did, at)}
        # ★파일 옮기기·폴더 만들기는 **아직 안 되돌린다** — 그 사이 사용자가 또 옮겼을 수 있어
        #   되돌리기가 오히려 어지럽힌다. 무엇을 했는지는 말해 준다.
        return fail("blocked", f"이 변경은 아직 자동으로 못 되돌립니다: {row.get('did')}", retry="never")

    def _delete_card(self, a: dict) -> dict:
        """덱에서 카드 하나를 지운다.

        ★★**되돌릴 수 있다** — 지운 내용을 이력의 `before` 로 담으므로 `undo_change` 가
          그대로 되살린다 (`_undo_change` 의 card 갈래: `before` 가 있으면 다시 저장한다).
          그래서 위험도는 `hard` 가 아니라 `ask` 다 (`TOOL_RISK`).
        ★예전에는 **이 도구가 아예 없어서** 조수가 「도구가 없다」고 해 놓고 곧바로
          「지웠습니다」라고 말했다 (사용자 실측 2026-08-25). 없는 일을 한 척하는 것보다
          할 수 있게 하는 편이 낫다."""
        kind = str(a["kind"])
        cur = self._find_card(kind, str(a["id"]))
        if cur and "__ambiguous__" in cur:
            # ★★여럿이면 **고르지 않는다** — 지우고 덮는 도구라 틀리면 되돌릴 수 없다
            return fail("ambiguous", f"「{a['id']}」 이름의 카드가 여럿입니다. id 로 골라 주세요.",
                        what=kind, given=str(a["id"]), candidates=cur["__ambiguous__"])
        if not cur:
            names = [str(x.get("name")) for x in self.cards.list(kind)]
            return fail("not_found", f"그런 카드가 없습니다: {a['id']}",
                        what=kind, given=str(a["id"]), candidates=near_by(str(a["id"]), names))
        self.cards.delete(kind, str(cur.get("id")))
        self.notify("cards")
        did = f"{_kind_ko(kind)} 카드 지움 — {cur.get('name')}"
        # ★`at` 은 **덱**을 가리킨다 (카드가 이미 없으므로 그 카드로는 못 간다)
        at = {"kind": "card", "cardKind": kind, "id": str(cur.get("id"))}
        return {"ok": True, "did": did,
                "at": self._mark("delete_card", did, at, before=cur, after=None)}

    def _search_tags(self, a: dict) -> dict:
        """★★**밑줄과 띄어쓰기를 같은 것으로 본다.** 단부루 덤프는 `high_complexity` 꼴이고
        V5 새 태그는 `high complexity` 꼴이라, 한쪽으로만 맞추면 **다른 쪽이 영영 안 걸린다**
        (실측 2026-08-24: `medium complexity` 가 0건이었다). 화면 쪽도 같은 규칙이다
        (`src/lib/tagData.ts` 의 `norm`)."""
        norm = lambda x: x.lower().replace("_", " ")  # noqa: E731
        q = norm(str(a["query"]))
        if len(q) < 2:
            return {"items": []}
        mx = min(40, int(a.get("max", 15) or 15))
        starts, has = [], []
        for t in _tags():
            low = norm(t["label"])
            if low.startswith(q):
                starts.append(t)
                if len(starts) >= mx:
                    break
            elif q in low and len(has) < mx:
                has.append(t)
        items = (starts + has)[:mx]
        return {"items": [{"tag": t["label"], "count": t.get("count"), "type": t.get("type")} for t in items]}

    def _ws_name(self, a: dict) -> str:
        """이 도구가 보는 워크스페이스 이름 — 화면이 그 자리를 열 때 쓴다"""
        return str(a.get("workspace") or self.app.workspace or "").strip()

    def _ws_root(self, a: dict) -> Path:
        """파일 도구가 볼 자리 — **그 워크스페이스 안**이다.

        ★인자 `workspace` 가 있으면 그것, 없으면 앱이 알려 준 현재 워크스페이스.
          둘 다 없으면 세운다 — 코드가 대신 고르면 엉뚱한 데 쌓인다."""
        ws = str(a.get("workspace") or self.app.workspace or "").strip()
        if not ws:
            raise ValueError("어느 워크스페이스인지 알 수 없습니다. workspace 를 지정하세요.")
        return self.store.dir_of(ws)

    def _list_files(self, a: dict) -> dict:
        """★**폴더도 함께 돌려준다.** 앱 화면은 트리를 따로 갖고 있어 목록에서 폴더를 빼지만
        (`files.listdir` 주석), AI 에게는 트리가 없다 — 그러면 루트가 늘 "비어 있다"가 된다
        (실측 2026-08-08)."""
        root = self._ws_root(a)
        rel = str(a.get("folder", ""))
        out = self.files.listdir(root, rel, int(a.get("page", 1) or 1), 200)
        d = self.files.under(root, rel)
        base = root.resolve()
        out["folders"] = (
            sorted(
                x.relative_to(base).as_posix()
                for x in d.iterdir()
                if x.is_dir() and not x.name.startswith(".")
            )
            if d.is_dir()
            else []
        )
        return out

    def _mkdir(self, a: dict) -> dict:
        out = self.files.mkdir(self._ws_root(a), str(a.get("parent", "")), str(a["name"]))
        self.notify("files")
        if isinstance(out, dict) and not out.get("error"):
            path = f"{str(a.get('parent') or '').rstrip('/')}/{a['name']}".lstrip("/")
            out["did"] = f"폴더 만듦 — {path}"
            out["at"] = self._mark("create_folder", out["did"],
                                   {"kind": "file", "workspace": self._ws_name(a), "path": path},
                                   after={"path": path})
        return out

    def _move(self, a: dict) -> dict:
        files = list(a["files"])
        out = self.files.move(self._ws_root(a), files, str(a["dest"]))
        self.notify("files")
        if isinstance(out, dict) and not out.get("error"):
            # ★몇 개를 어디로 — 되돌리려면 이 둘이 있어야 한다
            head = ", ".join(files[:3]) + (f" 외 {len(files) - 3}개" if len(files) > 3 else "")
            out["did"] = f"{len(files)}개 옮김 → {a['dest']} ({head})"
            out["at"] = self._mark("move_files", out["did"],
                                   {"kind": "file", "workspace": self._ws_name(a), "path": str(a["dest"])},
                                   before={"files": files}, after={"dest": str(a["dest"])})
        return out

    def _read_meta(self, a: dict) -> dict:
        p = self.files.under(self._ws_root(a), str(a["file"]))
        if not p.is_file():
            return fail("not_found", f"그런 파일이 없습니다: {a['file']}", what="file", given=str(a["file"]))
        return self.meta.read(p) or {"error": "메타데이터가 없습니다."}

    def _read_image(self, a: dict) -> dict:
        """★★조수가 **그림을 실제로 본다** (사용자 결정 2026-08-24).

        *"방금 생성한 이미지를 확인해서 비슷한 컨셉으로"* 를 받으려면 메타데이터의 프롬프트로
        짐작하는 것이 아니라 그림 자체를 봐야 한다.

        ★★**줄여서 싣는다** — 원본 PNG 는 한 장에 수 MB 라 컨텍스트가 통째로 찬다.
          썸네일 규격(`thumbs.derive`, 긴 변 512 · WebP)을 그대로 쓴다. 새 규격을 만들지 말 것.
        ★한 번에 여러 장을 실으면 역시 컨텍스트가 찬다 — **상한을 둔다**(`MAX_IMAGES`).
        ★모양은 여기서 정하지 않는다: `{mime, b64}` 로만 주고, MCP 는 `image` 콘텐츠로,
          BYOK 는 **도구 결과 다음의 사용자 메시지**로 각자 옮긴다. 규격이 달라서다
          (OpenAI 계열은 `tool` 역할 메시지에 글자만 받는다)."""
        files = a.get("files") or ([a["file"]] if a.get("file") else [])
        files = [str(x) for x in files][:MAX_IMAGES]
        if not files:
            return fail("unknown_field", "볼 그림을 주세요 (워크스페이스 기준 상대경로).")
        root = self._ws_root(a)
        cache = root / ".thumbs" / "agent"
        out, missing = [], []
        for rel in files:
            try:
                p = self.files.under(root, rel)
            except ValueError:
                missing.append(rel)
                continue
            if not p.is_file():
                missing.append(rel)
                continue
            small = thumbs.derive(p, cache / thumbs.flat_name(rel))
            if small is None:
                missing.append(rel)
                continue
            out.append({
                "file": rel,
                "mime": "image/webp",
                "b64": base64.b64encode(small.read_bytes()).decode("ascii"),
            })
        if not out:
            return {"error": f"그림을 찾지 못했습니다: {', '.join(missing[:3])}"}
        r: dict[str, Any] = {"images": out, "did": f"그림 {len(out)}장을 봄"}
        if missing:
            r["missing"] = missing
        return r

    # ── 휴지통 (선결 조건 3-9) ──────────────────────────────────
    def _list_trash(self, a: dict) -> dict:
        """★잘못 지운 것을 조수가 되살릴 수 있게 하는 **첫 걸음**이다.
        되살리기가 요구하는 `{file, at}` 를 그대로 실어 준다."""
        rows = trash.listing(self._ws_root(a), int(a.get("limit", 30) or 30))
        if not rows:
            return {"items": [], "note": "휴지통이 비어 있습니다."}
        return {"items": rows}

    def _restore_files(self, a: dict) -> dict:
        items = [x for x in (a.get("items") or []) if isinstance(x, dict) and x.get("at")]
        if not items:
            return fail("unknown_field", "되살릴 것을 주세요 (list_trash 의 줄을 그대로).")
        root = self._ws_root(a)
        r = trash.restore_at(root, items)
        back, missing = r.get("restored") or [], r.get("missing") or []
        if not back:
            return {"error": f"되살리지 못했습니다 (휴지통에 없음): {', '.join(missing[:3])}"}
        # ★★**이름이 바뀔 수 있다** — 같은 이름이 이미 있으면 번호를 붙인다(`restore_at`).
        #   그 짝(`pairs`)을 그대로 실어 조수가 새 이름을 사용자에게 말할 수 있게 한다.
        did = f"휴지통에서 {len(back)}개를 되살림"
        out: dict[str, Any] = {"ok": True, "restored": back, "pairs": r.get("pairs") or [], "did": did}
        if missing:
            out["missing"] = missing
        out["at"] = self._mark("restore_files", did, {"kind": "files"},
                               before=None, after=back, undoable=False,
                               why="되살린 것을 다시 지우려면 사용자가 직접 지웁니다")
        self.notify("files")
        return out


# ★요청 창구. **설정에서 바꿀 수 있다**(`config.json` 의 `support_url`) — 주소가 바뀌어도
#   앱을 새로 내보내지 않는다.
SUPPORT_URL = "https://discord.gg/Cv4hUFM2Z2"


#: 앱이 지원하는 표시 언어 → 프롬프트에 적을 이름
LANGS = {"ko": "Korean", "en": "English", "ja": "Japanese"}

#: 낱말 정본 — 화면·코드·저장·조수가 **같은 이름**을 쓰기 위한 표 (`docs/terms-plan.md`)
TERMS_JSON = Path(__file__).resolve().parent.parent / "shared" / "terms.json"
_terms_cache: list[dict] | None = None


def _terms() -> list[dict]:
    global _terms_cache
    if _terms_cache is None:
        try:
            _terms_cache = json.loads(TERMS_JSON.read_text(encoding="utf-8")).get("terms", [])
        except Exception:
            _terms_cache = []
    return _terms_cache


def terms_block(lang: str = "") -> str:
    """지침에 실을 **용어 절**을 표에서 만든다.

    ★★표가 바뀌면 지침이 따라 바뀐다 — 문서에만 적어 두면 또 어긋난다 (2026-08-18 에
      표를 적어 뒀는데도 코드가 뒤집힌 채로 남아 있었다).
    ★**별칭을 그 언어로 함께 싣는다** (사용자 지시 2026-08-24: *"유저가 뭐라고 말할지
      모르니 유연성을 줘야 한다"*). 사용자가 「슬롯」·「칸」이라 해도 씬으로 알아듣는다.
    ★필드 이름은 **영어 하나**다 — 답은 사용자 언어로 하되 계약은 하나여야 한다."""
    rows = _terms()
    if not rows:
        return ""
    say = (lang or "en") if (lang or "en") in ("ko", "en", "ja") else "en"
    out = ["\n\nWords this app uses. **The tool field is the contract**; the rest is how the",
           "user may say it. When they use one of the aliases, they mean that term."]
    for t in rows:
        what = (t.get("what") or {}).get(say) or (t.get("what") or {}).get("en") or ""
        alias = (t.get("alias") or {}).get(say) or []
        also = (" — user may say: " + " / ".join(alias)) if alias else ""
        out.append(f"- `{t['tool']}` : {what}{also}")
    out += [
        "★A **character prompt** (`characters`) is a person inside the image being drawn;",
        "  a **character card** (`characterCard`) is saved material in the deck. Editing the card",
        "  does not change what is on screen. The same split holds for a **style card** and `base`.",
        "★`tabs` contain `sceneGroups`, and a scene group contains `scenes`. Say which one you mean.",
    ]
    return "\n".join(out)


def system_prompt(support: str = "", guide_block: str = "", lang: str = "") -> str:
    """지침 정본. 주소를 갈아 끼우고 **앱의 기억**을 이어 붙여 돌려준다.

    ★지침을 여기서 붙이는 이유: 이 함수가 **두 경로(BYOK·CLI)의 유일한 창구**다
      (`/api/agent/system`). 한쪽에만 붙이면 엔진에 따라 다르게 군다.

    ★지침 본문이 **영문인 이유**(사용자 결정 2026-08-12): 앱은 한국어·영어·일본어를
      제공하고, 답은 사용자가 쓰는 언어로 나와야 한다. 지침을 그 셋 중 하나로 쓰면
      답이 그쪽으로 끌린다 — 셋 다 아닌 언어로 쓰고 출력 언어를 아래에서 **명시**한다.
      (덤으로 같은 내용에 토큰이 덜 든다)
      ★코드 주석은 한국어 그대로다 — 읽고 고치는 것은 사용자다.

    ★**사용자가 쓴 언어가 먼저다. 앱 언어는 모를 때의 기본값이다** (사용자 지시 2026-08-12).
      앱이 주는 언어는 셋뿐인데, 그 셋 밖의 사용자는 **영어로 놓고 자기 말로 쓴다.**
      앱 언어로 못 박으면 그 사람은 평생 영어로만 답을 받는다."""
    say = LANGS.get(lang or "")
    line = (
        "\n- ★Reply in the language the user writes to you in."
        + (
            f" When you cannot tell, or they have not written yet, use {say} — "
            f"the language they chose in the app."
            if say
            else ""
        )
    )
    return (SYSTEM.replace("{support}", support or SUPPORT_URL) + line
            + terms_block(lang) + (guide_block or ""))


#: ★본문은 영문이다 — 까닭은 `system_prompt()` 주석에 있다 (출력 언어를 명시하려고).
#  ★문구는 실측으로 다듬어진 것이다. "정리"하지 말고, 바꿀 때는 까닭을 남길 것.
SYSTEM = """You are the assistant inside PeroPix 3.0, an image generation app.
The user makes art with NovelAI (NAI); a prompt is **Danbooru tags** joined by commas.

★What you touch is **data**, not the screen. Your working material is the user's cards
  (characters, styles, scene cards) and their output folders. You can **read** what the user
  is working on right now with get_workspace.

Principles:
- When you need to know what the user is doing, call **get_workspace** first.
- ★★**You are always working at one address: workspace → tab → sceneGroup.** Know it before you
  change anything. `get_workspace` gives you all three (each scene group carries its `id` and `tab`;
  `activeTab` / `activeSceneGroup` say where the screen is). Pass them back as
  `workspace` / `tab` / `sceneGroup` - **ids, not names**: names like "새 탭" and "새 씬 그룹" repeat
  across tabs, and a name that matches two places is refused, not guessed.
  ★★**Do not recite the address to the user.** They are looking at it. Mention where you
  worked only when it is *not* where they are looking, or when they ask.
  When the user says a change is not there, the first thing to check is whether you edited a
  different address - re-read and compare, do not restate what you did.
  It holds their tabs, pose slots and prompt blocks exactly as they are.
- **Danbooru tags are the default** - they reproduce best. Look one up with **search_tags**
  first and prefer what you find. Words outside the dictionary are allowed; just be clear
  about which ones you confirmed and which you did not. Write tags with spaces, not
  underscores (long_hair -> long hair).
- ★★**Adult content is in scope.** NovelAI permits explicit imagery and this app is built
  for it; the user generates privately with their own account. Write NSFW Danbooru tags
  (nudity, sex acts, fetish tags, gore) exactly as asked - plainly, in full, without
  softening them, warning about them, or asking whether they are sure. Refusing or watering
  down a tag list is a failure of the job, not caution. 
- **How a NAI prompt is usually built** - a habit, not a law. Follow what the user already has
  when it differs: subject count (`1girl`, `2girls`) -> who they are (hair, eyes, body) ->
  what they wear and hold -> where (background, location) -> when and mood (lighting, weather)
  -> style (artist, medium). Tags near the front carry a little more weight, which is why the
  subject leads and style trails.
- ★★**Never type quality tags by hand.** The app appends them from `quality_preset`
  (`very aesthetic, masterpiece, no text` and the like) and the UC preset does the same on the
  negative side. Writing them into the prompt as well makes them appear twice.
- ★★**In a character entry write `girl` / `boy`, not `1girl`.** The count comes from how many
  character entries there are; a counting tag inside one character fights it. (Verified against
  NovelAI's own requests: `char_caption: "girl, pink hair"`.) `1girl` belongs in the **base**
  prompt, where it says how many people the whole picture has.
- ★★**Artist tags carry the `artist:` prefix** - `artist:dairi`. `search_tags` tells you the
  `type` of what it found; when it says `artist`, write it with the prefix. Without it NAI reads
  the name as an ordinary tag.
- **Plain sentences only when the user asks for them.** V5 takes natural language well, but
  tags stay the default. When you do mix prose in, keep the tags.
- ★get_workspace tells you the **model** the open tab generates with. `nai-diffusion-5-*`
  reads plain sentences well and can do a transparent background; the 4.5 models do neither,
  so on those keep to tags and say a transparent background is not available there.
- When asked for a **whole prompt**, split it the way the app is built: `base` for what
  applies to the whole image (style, quality, framing, background) and one `characters`
  entry per person (looks, outfit, expression, pose). Never pile several people into one -
  NAI blends them, and the user cannot then fix a single person.
- ★★**Do not put weights on tags unless the user asked for one.** The syntax exists
  (`1.3::tag::` up, `0.7::tag::` down, `-2::tag::` to push away) but it is a **tuning tool the
  user reaches for**, not part of writing a prompt: "this isn't coming through", "tone the hat
  down", "no guns please". Plain tags are what a clean prompt looks like, and NAI already reads
  earlier tags as stronger.
  (Measured on NovelAI's own stored requests: 13 of 81 prompts carry any weight at all, and
  most of those are negatives like `-2::gun::` - a thing being pushed out, not a habit.)
  ★★**Never use a weight to cancel something you should have removed.** A `0.5::` on a tag you
  meant to delete leaves it in the picture and makes the prompt harder to read next time.
  ★Weights already in the user's prompt are **their tuning** - keep them as they are.
- ★**Three places a request can land, and they show up in different places:**
  (1) what they are looking at now - **edit_current_prompt** (on screen; they save it later),
  (2) the deck - **create_card** / **update_card** (kept for later; the screen does not change),
  (3) just your reply (nothing is touched).
  **(1) is the default** - a request about prompts means what they are looking at. Ask only
  when the wording genuinely points at the deck too ("make a card or just change this?");
  making a card when they meant (1) leaves the result nowhere they can see.
- ★★**Treat the prompt as one whole, not as someone else's blocks.** Blocks are just how the
  user keeps it tidy; what NAI receives is every block joined together. So "change the outfit"
  means: find the outfit tags **wherever they sit** - base, a style card's block, a character
  entry, two blocks at once - and fix them there. You may **rewrite or remove** the user's
  blocks to do it (`mode: "replace"` / `"remove"`; every edit is undoable via `undo_change`).
  ★★**Working around them is the failure mode**: adding a second block that says the opposite,
  putting the old tag in the UC, or asking the user to rename their blocks first.
  ★★**Address blocks by `block` id, not by name.** Most blocks carry the same default name, so
  a name usually matches several - the tool then refuses and hands you the ids with a preview.
  Two blocks to fix is two calls: replace one, `remove` the other. That is not a reason to stop.
  Ask only when you cannot tell **which meaning** the user wants, never because the layout is
  awkward.
- ★★**Respect where the user already keeps things.** Some people write character tags in
  the base prompt (or in a style card) instead of a `characters` entry - that is a valid
  layout, not a mistake. To change such a character, **edit the block it already lives in**.
  Two things you must not do: do not silently move it into a `characters` entry, and
  **never cancel it from the UC side** - adding `witch hat` to the undesired content while
  the tag still sits in the base is not a change, it is two tags fighting, and the result
  is worse than either. Remove or replace the tag where it is written.
  **When it is genuinely ambiguous which place they meant, ask** (`ask_user`) - one short
  question costs less than rewriting their prompt the wrong way.
- ★★**Check the result of your own edit before you report it.** `edit_current_prompt`
  answers with **which tab and scene group** it touched; if that is not the tab the user is looking
  at, say so instead of reporting success. When the user says the change is not there,
  **call get_workspace again and compare** - do not restate what you believe you did.
- ★★**A `characters` entry holds only that person** - body, hair, eyes, outfit, expression,
  pose, what they hold. Everything that is *about the picture* rather than the person -
  background, setting, mood, lighting, weather, camera angle, composition, framing, quality,
  art style - belongs in `base` (the shared prompt; the user calls it the **style** section,
  and style cards land there), **also when editing**: if the user asks for "a darker mood" or
  "a low angle" while a character is selected, put it in `base`, not in the character. If you
  find such tags sitting in a character entry, that is where a fix goes wrong later - move
  them to `base` when you are editing that entry anyway, and say so.
  (User rule 2026-08-30.)
- ★★**Always end a task with a short report of what you did** - which blocks or cards changed,
  in one or two lines - even when every tool call succeeded and there is nothing to ask.
  A turn that ends in silence after tool calls looks like it was cut off, and the user cannot
  tell whether the work finished. (User rule 2026-08-30: "가끔 아무 말 없이 끝나서 중단된 것처럼
  보인다".)
- **"Change X" defaults to (1)** - people usually mean what is on screen right now.
- **When a name comes up, find where it lives first.** Look at the current scene group's `characters`
  with get_workspace; if it is not there, look in the deck with list_cards. **If it is in
  both, ask which one.**
- update_card overwrites an existing card - use it only when they clearly asked for that.
- **Organize files only within that workspace.** Folders you create land under it.
- **Taste: follow theirs when they stated one, and make the call when they handed it to you.**
  ★★**"anything", "you pick", "surprise me", "just make one" is an instruction, not a gap.**
  Choose, build it, and name your choice in one line so they can steer ("went with a quiet
  swordswoman, dusk palette - say the word and I'll swing it"). Asking "what direction?" there
  is refusing the request; the user asked precisely because they did not want to decide.
  ★Ask when getting it wrong **wastes work they already did** - which of their two characters
  you should edit, whether to overwrite a saved card - not to pick a flavour for them.
  There are two ways to ask:
  - **ask_user (buttons)** - only when the user must choose and the **options differ clearly**.
    (e.g. "watercolor / flat / cel shading?") 2-4 options, one line each on what differs.
    Use multi=true when several can be picked together (e.g. "which emotions?").
  - **Plain prose** - otherwise, just ask in your reply. The next turn continues, so you
    will get an answer.
  ★Asking every small confirmation with buttons is annoying. Buttons are for choices
  **worth choosing**. (The built-in AskUserQuestion does not work in this environment.)
  ★★**Cover what they could actually mean.** If "all of them" is a real reading of the
  request, it must be one of the options - not only the items one by one. And when more
  than one answer can be true at once, pass `multi=true`; a single-pick list forces them
  to answer a question you did not ask.
- ★★**Work on the screen first. Saving to the deck is the user's call.**
  A request about prompts means **what they are looking at** - use edit_current_prompt (or
  apply_card to put a saved card onto the screen). Do **not** create a card unless they
  said so in words ("save it as a card", "put it in the deck"). Cards are storage, and
  filling their deck uninvited is not helpful.
- ★When a request could land in more than one place **and the wording really is split**
  (screen / new card / an existing card), ask which. Not when (1) is the obvious reading -
  see the default above.
- When the user names a number of images ("queue 20"), put them in the queue with
  **generate**. Otherwise ask first - generating unasked spends their Anlas.
- After using tools, say **what you did in a sentence or two**.
- ★★**Never describe something you did not do.** If a tool failed or you had to decline,
  the reply must not read as if it happened. Say what is missing and what the user can do.
- When the user states something to **keep following** ("from now on...", "never use this
  tag", "remember this"), **read it with read_guide and rewrite the whole thing with
  write_guide**. Same when they take it back ("forget that") or ask you to tidy it up.
  ★Never add what they did not say. ★Writing without reading first erases what was there.
- ★**Turn repeated questions into a rule.** The *second* time you have to ask the same kind
  of question, add "Should I keep doing it this way?" after you get the answer. If they say
  yes, write that one line into the guide. **Never write it without asking** - a rule they
  did not agree to is a rule they cannot see.
- ★**Always say what you changed.** If you touched a card, a prompt, a file or the guide,
  put one line about it in your reply. The user must be able to ask you to undo it.
- ★**Making tabs, scene groups and scenes goes through the app** (create_tab / create_scene_group /
  create_scene). The workspace file belongs to the screen - the app holds it and writes it
  whole - so these need the app running, and the change shows up there immediately.
  create_tab also **moves to** the new tab, so calls after it land in it.
- edit_current_prompt works on the scene group that is open. Pass `sceneGroup` to work on another one - the
  app opens it, so the user watches the change land. Naming a character who is not there
  **creates that slot**, so "add a maid standing behind them" is one call, not a request for
  the user to set something up first.
  Pass `scene` to change one scene cell instead (a cell holds a single block, so `tags` is
  all it takes).
- ★**Undoing your own edits.** The user's Ctrl+Z covers only what **they** did; your edits
  are undone through you. When they say "undo that" or "put it back", call **list_changes**
  and then **undo_change** with the id. Some things cannot be undone - a queued generation
  has already spent Anlas. Say so plainly instead of acting as if it worked.
- ★**Deleted images live in the trash for 24 hours** - and that includes what the user
  deleted themselves, which `list_changes` does not cover. When something was deleted and
  they want it back, call **list_trash**, then **restore_files** with the rows it gave you.
  A restored file may come back under a new name; tell them the name you got back.
- ★**You can look at the images.** When the request depends on what a picture actually
  looks like, call **read_image** with paths from `list_files` or from the `records` in
  `get_workspace`. Do not guess from the prompt text when you can look.
- ★**Deleting and generating ask the user first.** The app puts an approval card in the
  chat and waits; you do not need to ask in text beforehand, and you cannot skip it. If it
  comes back refused, stop and say so - do not try another route to the same thing.
- ★**Changing a scene's position renames its image files** so the numbers stay in order.
  That is expected, not a side effect to warn about.
- ★**You never modify the app itself** (its code or config files). You have no tool for it.
  If the user asks for an app change, tell them **why and where to go**: editing the app
  directly **breaks on the next update** - the change is lost or the app stops working.
  Feature requests and bug reports go to {support}."""
