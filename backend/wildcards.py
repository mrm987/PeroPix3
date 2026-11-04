"""와일드카드 정의 문서. 이름 붙인 프롬프트 풀 하나를 텍스트 파일로 보관한다.

v2 `backend.py:6156-6198` 이식 (2026-08-18). v2 는 `prompts/wildcards/default.txt` 였고
3.0 은 **앱 데이터 한 자리**로 모은다 (`data/wildcards.txt`).

★**파싱하지 않는다.** 문법을 아는 것은 화면(`src/lib/wildcards.ts`)뿐이고 여기는 글을
  그대로 싣고 내린다. 서버가 한 벌 더 파싱하면 두 해석이 조용히 갈린다.
★카드·블록과 같은 **공용** 저장소다. 워크스페이스를 안 가린다.
★파일이 없을 때는 **맛보기 문서**를 돌려준다 (v2 와 같다). 저장하기 전까지 파일은 안 생긴다.
"""
from __future__ import annotations

from pathlib import Path

from durable import write_synced

#: 파일이 아직 없을 때 편집기에 채워 주는 맛보기. ★문법 셋(주석·인라인·중첩 호출)을 한 번씩
#: 보여 준다. 도움말을 읽지 않아도 모양을 보고 따라 쓸 수 있게. 자유롭게 지워도 된다.
#: ★v2 의 샘플 원문 그대로다 (`backend.py:6160-6179`). 줄 끝 주석이 문법을 그 자리에서
#: 설명하는 것이 이 샘플의 쓰임이라, 번역하거나 줄이지 않는다. 작대기만 뺐다.
DEFAULT_DOC = """// 샘플 와일드카드 (테스트용). 자유롭게 수정하거나 지우세요
// 규칙: 한 줄 = 한 후보 / #이름 = 풀 정의 / // = 주석

#hair
blonde hair
(black hair:1.2)
red twintails, long hair
{silver|pink|blue} hair      // 후보 안에 인라인 변형 {a|b}

#outfit
school uniform
white dress, frills
black business suit, necktie
||casual hoodie|sportswear||   // 후보 안에 NAI 인라인 ||a|b||

#scene
1girl, solo, #hair, #outfit, classroom            // 다른 풀 중첩 호출
1girl, solo, #hair, #outfit, city street at night
1boy, #hair, #outfit, cozy cafe interior
"""


class Wildcards:
    def __init__(self, path: Path):
        self.path = path
        path.parent.mkdir(parents=True, exist_ok=True)

    def read(self) -> str:
        if not self.path.exists():
            return DEFAULT_DOC
        try:
            return self.path.read_text(encoding="utf-8")
        except OSError:
            # ★못 읽었다고 맛보기를 돌려주지 않는다. 화면이 그걸 저장하면 사용자 문서를 덮는다
            return ""

    def write(self, content: str) -> None:
        tmp = self.path.with_suffix(".tmp")
        write_synced(tmp, content)
        tmp.replace(self.path)
