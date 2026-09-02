"""비밀만 담는 곳 — `data/secrets.json` (사용자 지시 2026-08-08: "api 안전하게 로컬로 분리").

★**설정과 비밀을 한 파일에 두지 않는다.** 커밋·전송 경로는 이미 다 막혀 있지만
  (`data/` 는 gitignore, 창구는 `hasKey` 만 돌려준다), 문제를 신고하려고 `config.json` 을
  통째로 보내는 순간 키가 같이 나간다. **보여줄 수 있는 파일과 못 보여줄 파일을 가른다.**

담는 것은 둘뿐이다:

    llm_key     BYOK API 키 (앤트로픽 · OpenAI 호환/OpenRouter)
    nai_token   NovelAI 토큰

★환경변수(`NAI_TOKEN`)가 있으면 그쪽이 먼저다 — 파일에 안 적고 돌리는 길을 막지 않는다.
"""
from __future__ import annotations

import json
import os
from pathlib import Path

# config.json 에 섞여 있던 옛 자리 → 여기 이름
MOVED = {"nai_token": ("nai_token",), "llm_key": ("llm", "key")}


class Secrets:
    def __init__(self, path: Path):
        self.path = path
        self._d: dict = {}
        if path.exists():
            try:
                self._d = json.loads(path.read_text(encoding="utf-8")) or {}
            except Exception:
                self._d = {}

    def get(self, name: str) -> str:
        return str(self._d.get(name) or "")

    def set(self, name: str, value: str) -> None:
        value = (value or "").strip()
        if value:
            self._d[name] = value
        else:
            self._d.pop(name, None)
        self._save()

    def has(self, name: str) -> bool:
        return bool(self.get(name))

    # ★계정 목록처럼 **문자열이 아닌 것**도 담는다 (`accounts.py`). 같은 파일·같은 저장 규칙이다
    def get_obj(self, name: str):
        return self._d.get(name)

    def set_obj(self, name: str, value) -> None:
        if value is None:
            self._d.pop(name, None)
        else:
            self._d[name] = value
        self._save()

    def _save(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        # ★임시 파일에 쓰고 바꿔치기한다 — 쓰다 죽어도 옛 파일이 남는다
        tmp = self.path.with_suffix(".tmp")
        tmp.write_text(json.dumps(self._d, ensure_ascii=False, indent=2), encoding="utf-8")
        os.replace(tmp, self.path)

    def adopt(self, cfg: dict) -> bool:
        """옛 `config.json` 에 섞여 있던 비밀을 **가져오고 거기서 지운다**.

        ★순서가 중요하다: 비밀 파일을 **먼저 쓰고** 나서 설정에서 지운다. 반대로 하면
          중간에 죽었을 때 키가 양쪽에서 사라진다. 돌려주는 값이 True 면 부른 쪽이
          `config.json` 을 다시 써야 한다."""
        moved = False
        for name, where in MOVED.items():
            node: object = cfg
            for k in where[:-1]:
                node = (node or {}).get(k) if isinstance(node, dict) else None
            if not isinstance(node, dict):
                continue
            val = node.get(where[-1])
            if not val:
                continue
            if not self.has(name):
                self.set(name, str(val))  # 먼저 옮겨 담고
            node.pop(where[-1], None)  # 그 다음에 설정에서 지운다
            moved = True
        return moved
