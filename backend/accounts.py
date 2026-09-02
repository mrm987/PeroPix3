"""NAI 계정 **여럿** — 워크스페이스마다 고르고, 계정마다 따로 생성한다 (사용자 결정 2026-09-02).

★까닭은 **할당량**이다 — Opus 무료 구간이 계정마다 따로 있으니, 계정을 나눠 두면 한쪽이
  바닥나도 다른 쪽으로 계속 뽑는다. 계정 수만큼 **동시에** 뽑히도록 큐도 계정별 차선이다
  (`genqueue.py`).

★토큰은 비밀 파일(`secrets.json`)의 `nai_accounts` 에 산다: `[{id, name, token}]`.
  화면에는 `id`·`name` 만 나간다 — 토큰 값은 어느 창구로도 되돌려 주지 않는다 (옛 규칙 그대로).
★옛 `nai_token` 하나는 **첫 계정으로 옮긴다** — 이름은 자동 번호 「API 1」. 사용자가 고치면
  그 이름이 남고, 번호는 다시 쓰지 않는다 (`id` 는 `a<번호>` 라 이름과 무관하다).
★환경변수 `NAI_TOKEN` 은 계정이 **하나도 없을 때만** 대신 쓴다 — 파일에 안 적고 돌리는 길을
  막지 않으려는 것이지, 목록 위에 덮는 것이 아니다.
★워크스페이스가 가리키는 계정이 지워졌으면 **첫 계정으로** 떨어진다 (`resolve`). 요청을 거절하면
  옛 워크스페이스가 통째로 멈춘다.
"""
from __future__ import annotations

import os
import re

KEY = "nai_accounts"
LEGACY = "nai_token"
ENV_ID = "env"


class Accounts:
    def __init__(self, secrets):
        self.s = secrets
        self._migrate()

    def _migrate(self) -> None:
        """옛 토큰 하나 → 계정 하나. ★옮긴 뒤 옛 자리를 비운다 — 둘이 남으면 어느 쪽이 진짜인지 갈린다."""
        if self.s.get_obj(KEY) is None and self.s.get(LEGACY):
            self.s.set_obj(KEY, [{"id": "a1", "name": "API 1", "token": self.s.get(LEGACY)}])
            self.s.set(LEGACY, "")

    def _list(self) -> list[dict]:
        v = self.s.get_obj(KEY)
        return [dict(a) for a in v] if isinstance(v, list) else []

    # ── 읽기 ──
    def public(self) -> list[dict]:
        """화면에 주는 목록 — **토큰 없이**. 계정이 없고 환경변수만 있으면 그것을 하나로 보인다."""
        out = [{"id": a["id"], "name": a.get("name") or a["id"]} for a in self._list()]
        if not out and os.environ.get("NAI_TOKEN"):
            out = [{"id": ENV_ID, "name": "NAI_TOKEN", "env": True}]
        return out

    def default_id(self) -> str:
        pub = self.public()
        return pub[0]["id"] if pub else ""

    def resolve(self, account_id: str | None) -> str:
        """요청이 가리킨 계정 → **실제로 쓸** 계정 id. 없거나 지워졌으면 첫 계정이다."""
        ids = {a["id"] for a in self.public()}
        return account_id if account_id and account_id in ids else self.default_id()

    def name_of(self, account_id: str) -> str:
        for a in self.public():
            if a["id"] == account_id:
                return a["name"]
        return ""

    def token_of(self, account_id: str | None = None) -> str:
        acc = self.resolve(account_id)
        for a in self._list():
            if a["id"] == acc:
                return str(a.get("token") or "")
        return os.environ.get("NAI_TOKEN") or ""

    # ── 쓰기 ──
    def add(self, token: str, name: str = "") -> dict:
        """새 계정. ★번호는 **지금까지 쓴 것 다음**이다 — 지운 번호를 다시 쓰면 워크스페이스에
        남은 옛 id 가 새 계정에 달라붙는다."""
        lst = self._list()
        used = [int(m.group(1)) for a in lst if (m := re.fullmatch(r"a(\d+)", str(a.get("id", ""))))]
        n = (max(used) + 1) if used else 1
        acc = {"id": f"a{n}", "name": (name or "").strip() or f"API {n}", "token": token.strip()}
        lst.append(acc)
        self.s.set_obj(KEY, lst)
        return {"id": acc["id"], "name": acc["name"]}

    def update(self, account_id: str, token: str | None = None, name: str | None = None) -> dict | None:
        lst = self._list()
        for a in lst:
            if a["id"] != account_id:
                continue
            if token is not None and token.strip():
                a["token"] = token.strip()
            if name is not None and name.strip():
                a["name"] = name.strip()
            self.s.set_obj(KEY, lst)
            return {"id": a["id"], "name": a["name"]}
        return None

    def remove(self, account_id: str) -> bool:
        lst = self._list()
        keep = [a for a in lst if a["id"] != account_id]
        if len(keep) == len(lst):
            return False
        self.s.set_obj(KEY, keep)
        return True
