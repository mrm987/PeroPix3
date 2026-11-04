# 함께 담기는 것들

PeroPix 3.0 은 **AGPL-3.0-or-later** 다 (`LICENSE`). 이 문서는 배포 꾸러미
(`PeroPix-<버전>-win64.zip`)에 **함께 들어가는 남의 것**과 그 조건을 적어 둔다.

다음에 또 뒤지지 않으려고 적는다. 조사한 날은 **2026-08-26** 이고, 근거는 각 줄에 적었다.

## 왜 AGPL 인가 — 검열 기능 때문이다

| 무엇 | 어디서 | 조건 |
|---|---|---|
| `models/censor/ntd11_anime_nsfw_segm_v5-variant1.onnx` (40MB) | **YOLO11s-seg 계보** ([`backend/censor.py`](backend/censor.py) 머리 주석) | Ultralytics YOLO 는 **AGPL-3.0** |
| 전처리·후처리 구현 (`letterbox`·NMS 상수) | ultralytics 구현을 옮겨 적었다 ([`docs/v2-port-plan.md`](docs/v2-port-plan.md) 264행: *"전처리·후처리는 ultralytics 구현 그대로"*, 상수는 `cfg/default.yaml`) | 같은 계보 |

**이 둘을 담아서 내보내기 때문에** 이 프로젝트가 AGPL 이다. 허용형(MIT 등)으로 내면
AGPL 물건을 더 느슨한 조건으로 재배포하는 꼴이 된다.

- **v2 는 사정이 다르다.** 그쪽은 `ultralytics` 를 꾸러미에 안 담고 검열을 켤 때 받으며
  (`backend.py` 의 `CENSOR_DEPS`), 모델도 그때 허깅페이스에서 받는다
  (`CENSOR_MODEL_HF_BASE`). **재배포하지 않으므로** MIT 라벨과 어긋나지 않는다.
- **미확인으로 남긴 것 하나**: 이 `.onnx` 를 공개한 쪽이 자기 페이지에 적어 둔 조건은
  안 찾아봤다 (사용자 판단, 2026-08-26). Ultralytics 계보면 AGPL 이 따라오는 것이 원칙이라
  더 강한 조건이 나올 여지는 낮지만, **확인한 사실은 아니다.**

## 태그 사전

| 무엇 | 어디서 | 조건 |
|---|---|---|
| `public/tags.json` (79,437개 · 9.1MB, 2026-10-01 목록) | [DraconicDragon/dbr-e621-lists-archive](https://github.com/DraconicDragon/dbr-e621-lists-archive) — v2 README 에 적혀 있던 출처 | **The Unlicense** (퍼블릭 도메인 헌정, GitHub API 로 확인) |
| `public/tags-ko.json` (4.6MB) | [mengod-hf/danbooru-tags-kr](https://huggingface.co/datasets/mengod-hf/danbooru-tags-kr) 2026-11-04 판을 고친 것 | **CC BY-SA 4.0** (아래) |
| `public/tags-extra.json` | 우리가 더한 것 (NAI 전용 태그) | 이 프로젝트와 같다 |

`tags.json` 은 퍼블릭 도메인이라 어느 조건으로든 담을 수 있다. 출처만 적어 둔다.

**`tags-ko.json` 은 CC BY-SA 4.0 으로 내보낸다** (<https://creativecommons.org/licenses/by-sa/4.0/legalcode.en>).
코드와 별개의 데이터 파일이고, 이 파일만 이 조건을 따른다.

- 원본의 조건: 데이터셋 페이지와 README 표시는 MIT 인데, 저장소의 [`LICENSE`](https://huggingface.co/datasets/mengod-hf/danbooru-tags-kr/blob/main/LICENSE) 는 한글 번역을 CC BY-SA 4.0 으로 적고 있다 (2026-11-04 확인). 더 강한 쪽을 따른다.
- 고친 것: 키워드의 한글만 뽑았다 · 설명문을 뺐다 · `tags.json` 에 있는 태그만 담았다 · 원본에 없는 옛 이름은 그 이름을 별칭으로 가진 태그의 키워드를 붙였다 (`scripts/update-tags-ko.py`).
- 그 `LICENSE` 가 적은 출처: 먼저 있던 한글 번역 nyantong · PYU224/tagdb-updater (MIT) · boorutan/booru-japanese-tag (MIT) · 단부루 위키 기여자 (patvessel/danbooru-wiki-2606 으로 모음) · supercatdoing/booru_artists_merged (CC0 1.0 표기). 그 파일은 위키 내용의 재배포 조건이 **확인되지 않았다**고 적고 있고, 우리도 확인하지 못했다.
- 앱에서는 설정 → 앱 정보에 출처 버튼이 있다 (`data-tags-ko-credit`).

## 파이썬 런타임과 패키지

포터블에는 **임베드 파이썬 3.11.9** 가 통째로 들어간다 (`python/`) — **PSF License**.

담기는 패키지는 전부 허용형이거나 파일 단위 카피레프트라 AGPL 과 충돌하지 않는다.
아래는 **실제로 담긴 것에서 뽑았다** (`python/Lib/site-packages/*/METADATA`, 2026-08-26).

| 조건 | 패키지 |
|---|---|
| MIT | fastapi · pydantic · pydantic-core · piexif · h11 · httptools · anyio · PyYAML · watchfiles · annotated-types · typing-inspection · **onnxruntime-directml** |
| MIT-CMU | Pillow |
| BSD-3-Clause | uvicorn · starlette · httpx · httpcore · click · idna · python-dotenv · websockets · **numpy** · protobuf |
| BSD | colorama · mpmath · sympy |
| Apache-2.0 | aiofiles · python-multipart · msgpack · flatbuffers |
| PSF-2.0 | typing_extensions |
| **MPL-2.0** | certifi — 파일 단위 카피레프트이지만 **AGPL 과 호환된다** (MPL 자체가 그렇게 허용한다) |

## 고쳐야 할 때

- 새 의존성을 더하면 **이 표도 같이 고친다.** 뽑는 방법은 위에 적은 `METADATA` 훑기다.
- 검열 모델을 바꾸면 **첫 표를 다시 본다** — 계보가 바뀌면 이 프로젝트의 라이선스 근거가 바뀐다.
