"""임시 파일을 **디스크까지** 내려 쓴다 — 바꿔치기 저장의 앞 단계.

★★`write_text` 뒤에 바로 이름을 바꾸면 블루스크린·정전에 파일이 빈다 (제보 2026-11-04: 블루스크린 뒤
  `workspace.json` 을 못 읽어 그 워크스페이스가 안 열렸다). 바꿔치기는 앱이 죽을 때만 안전하다. 이름 바꾸기는
  파일 시스템 저널에 먼저 남는데 내용은 아직 메모리에 있을 수 있어, OS 가 죽으면 **이름만 새 파일이고 속이 빈다.**
"""
from __future__ import annotations

import os
from pathlib import Path


def write_synced(tmp: Path, data: str | bytes) -> None:
    """★글은 `write_text` 와 같은 텍스트 모드로 쓴다 (줄바꿈 처리가 그대로다). 이름 바꾸기는 부르는 쪽이 한다."""
    f = open(tmp, "wb") if isinstance(data, bytes) else open(tmp, "w", encoding="utf-8")
    with f:
        f.write(data)
        f.flush()
        os.fsync(f.fileno())
