"""태그 한글 키워드(`public/tags-ko.json`)를 만든다.

    python scripts/update-tags-ko.py

받는 곳: https://huggingface.co/datasets/mengod-hf/danbooru-tags-kr (CC BY-SA 4.0, `THIRD-PARTY.md`).
`scripts/update-tags.py` 로 사전을 갱신했으면 이것도 다시 돌린다 (사전에 있는 태그만 담는다).

모양: `{"long_hair": ["긴 머리, 장발", "헤어스타일"]}`. 첫 칸은 목록에 보이는 이름이고, 그 뒤는 검색에만 쓴다.

★원본 키워드 맨 앞의 `<...>` 는 대개 분류다 (`<헤어스타일>, 트윈테일`). 그래서 이름으로 안 보이고 검색에만 쓴다.
  다른 키워드가 없으면 그것이 곧 이름이다 (`<메이드>`).
★원본에 없는 옛 이름(`china_dress`)은 사전에서 그 이름을 별칭으로 가진 태그(`qipao`)의 것을 쓴다.
  옛 이름을 남긴 이유가 NAI 모델이 그 이름을 알 수 있어서이므로, 한글로 찾을 때도 함께 나와야 한다.
"""
from __future__ import annotations

import csv
import io
import json
import re
import urllib.request
from pathlib import Path

REPO = "mengod-hf/danbooru-tags-kr"
PUBLIC = Path(__file__).resolve().parent.parent / "public"
HANGUL = re.compile("[가-힣]")


def fetch(url: str) -> bytes:
    with urllib.request.urlopen(url, timeout=120) as r:
        return r.read()


def latest_csv() -> str:
    info = json.loads(fetch(f"https://huggingface.co/api/datasets/{REPO}"))
    names = [s["rfilename"] for s in info["siblings"]]
    return next(n for n in names if re.fullmatch(r"danbooru-tags-kr-\d{4}-\d{2}-\d{2}\.csv", n))


def keywords(desc: str) -> list[str]:
    """`... 키워드: <분류>, 이름, 이름` → `[이름, 이름 묶음, 분류]`. 한글이 없는 것은 뺀다 (영어는 사전 이름으로 찾는다)."""
    m = re.search(r"키워드:\s*(.*)$", desc)
    if not m:
        return []
    groups: list[str] = []
    names: list[str] = []
    for raw in m.group(1).split(","):
        word = raw.strip()
        grouped = word.startswith("<")
        word = word.strip("<>[] ")
        if not HANGUL.search(word):
            continue
        target = groups if grouped else names
        if word not in target:
            target.append(word)
    if not names:
        names, groups = groups[:1], groups[1:]
    return [", ".join(names), *[g for g in groups if g not in names]] if names else []


def build(rows: list[list[str]], tags: list[dict]) -> dict[str, list[str]]:
    source = {r[0].replace(" ", "_"): keywords(r[3]) for r in rows}
    out = {t["value"]: source[t["value"]] for t in tags if source.get(t["value"])}
    alias_of: dict[str, list[str]] = {}
    for t in tags:     # ★사전은 게시물 수 차례라 먼저 걸린 것이 가장 많이 쓰이는 태그다
        if t["value"] in out:
            for a in t["aliases"]:
                alias_of.setdefault(a, out[t["value"]])
    for t in tags:
        if t["value"] not in out and t["value"] in alias_of:
            out[t["value"]] = alias_of[t["value"]]
    return out


def main() -> None:
    name = latest_csv()
    text = fetch(f"https://huggingface.co/datasets/{REPO}/resolve/main/{name}").decode("utf-8-sig")
    tags = json.loads((PUBLIC / "tags.json").read_text(encoding="utf-8"))
    out = build(list(csv.reader(io.StringIO(text))), tags)
    (PUBLIC / "tags-ko.json").write_bytes(json.dumps(out, ensure_ascii=False, separators=(",", ":")).encode("utf-8"))
    print(f"{name} · 사전 {len(tags)}개 중 {len(out)}개에 한글 키워드")


if __name__ == "__main__":
    main()
