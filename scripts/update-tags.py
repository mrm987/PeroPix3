"""태그 사전(`public/tags.json`)을 새 단부루 목록으로 갱신한다.

    python scripts/update-tags.py 2026-10-01

받는 곳: https://github.com/DraconicDragon/dbr-e621-lists-archive (퍼블릭 도메인). 3개월마다 목록이 올라온다.

★게시물 100개 이상만 담는다. 그 아래는 자동완성에 잡음이고 파일만 커진다.
★지금 사전에 있던 이름은 새 목록에 없어도 남긴다 (사용자 결정 2026-11-04). 단부루에서 이름이 바뀌어도
  NAI 모델은 옛 이름으로 학습했을 수 있다 (`china_dress`→`qipao`). 게시물 수는 새 목록에 있으면 그 값, 없으면 옛 값이다.
"""
from __future__ import annotations

import csv
import io
import json
import sys
import urllib.request
from pathlib import Path

URL = ("https://raw.githubusercontent.com/DraconicDragon/dbr-e621-lists-archive/main/"
       "tag-lists/danbooru/danbooru_{date}_pt20-ia-dd.csv")
TAGS = Path(__file__).resolve().parent.parent / "public" / "tags.json"
MIN_COUNT = 100
TYPES = {0: "general", 1: "artist", 3: "copyright", 4: "character", 5: "meta"}


def merge(rows: list[list[str]], old: list[dict]) -> tuple[list[dict], dict]:
    """→ (새 사전, 수). `rows` 는 `이름,종류,게시물 수,"별칭,별칭"` 줄이다."""
    listed: dict[str, dict] = {}
    for name, cat, count, *rest in rows:
        aliases = rest[0].split(",") if rest and rest[0] else []
        listed[name] = {"label": name, "value": name, "count": int(count),
                        "type": TYPES[int(cat)], "category": int(cat), "aliases": aliases}
    known = {t["value"] for t in old}
    out = [t for t in listed.values() if t["count"] >= MIN_COUNT or t["value"] in known]
    kept = [t for t in old if t["value"] not in listed]
    out += kept
    out.sort(key=lambda t: -t["count"])     # ★안정 정렬이라 게시물 수가 같으면 새 목록 차례가 먼저다
    return out, {"total": len(out), "added": sum(t["value"] not in known for t in out), "kept": len(kept)}


def main() -> None:
    if len(sys.argv) != 2:
        sys.exit("사용법: python scripts/update-tags.py <목록 날짜, 예: 2026-10-01>")
    with urllib.request.urlopen(URL.format(date=sys.argv[1]), timeout=60) as r:
        rows = list(csv.reader(io.StringIO(r.read().decode("utf-8"))))
    old = json.loads(TAGS.read_text(encoding="utf-8"))
    out, counts = merge(rows, old)
    # ★앱이 읽는 파일이라 덮어쓰기 전에 다 만든 뒤 한 번에 쓴다 (git 에 옛 판이 있어 사본은 안 둔다)
    TAGS.write_bytes(json.dumps(out, ensure_ascii=False, separators=(",", ":")).encode("utf-8"))
    print(f"전체 {counts['total']} · 새로 들어옴 {counts['added']} · 새 목록에 없어 남긴 옛 이름 {counts['kept']}")


if __name__ == "__main__":
    main()
