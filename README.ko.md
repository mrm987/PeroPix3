<div align="center">

<img src="src-tauri/icons/128x128@2x.png" width="88" alt="PeroPix">

# PeroPix

**NovelAI 이미지 생성을 위한 데스크톱 작업대.**<br>
씬을 줄에 늘어놓고 큐에 한 번 걸면 한 벌이 통째로 나옵니다.

[![Release](https://img.shields.io/github/v/release/mrm987/PeroPix3?label=download&color=5865F2)](https://github.com/mrm987/PeroPix3/releases/latest)
[![Downloads](https://img.shields.io/github/downloads/mrm987/PeroPix3/total?color=5865F2)](https://github.com/mrm987/PeroPix3/releases)
[![License](https://img.shields.io/badge/license-AGPL--3.0-informational)](LICENSE)
![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS-lightgrey)
[![Website](https://img.shields.io/badge/website-peropix.mori--mo.com-5865F2)](https://peropix.mori-mo.com/ko/)
[![Ko-fi](https://img.shields.io/badge/Ko--fi-support-ff5e5b?logo=ko-fi&logoColor=white)](https://ko-fi.com/morimo_)

[English](README.md) · **한국어** · [日本語](README.ja.md)

사이트: [peropix.mori-mo.com](https://peropix.mori-mo.com/ko/)

</div>

---

그림을 만드는 것은 NovelAI 입니다. PeroPix 는 그 앞에 놓인 작업대입니다 — 한 장씩 뽑는
것은 어렵지 않지만, 같은 인물을 장면만 바꿔 스무 장 뽑으려 할 때부터 일이 되지요.
**그대로 두는 것은 한 번만 적고, 달라지는 것만 줄에 늘어놓은 뒤, 통째로 큐에 겁니다.**

- **씬 줄과 큐** — 씬 하나가 카드 하나입니다. 다른 부분만 채워 줄째로 큐에 걸어 두면
  도는 동안 다음 작업을 이어서 할 수 있고, 결과는 각자 자기를 만든 씬에 붙어 남습니다.
- **프롬프트 블록** — 긴 한 줄 대신 이름 붙은 블록으로 쌓습니다. 쉼표를 헤아리지 않고
  켜고 끄고, 순서를 바꾸고, 가중치를 줍니다.
- **카드덱** — 그림체나 캐릭터를 카드로 저장해 아무 씬에나 떨굽니다. 카드를 한 번 고치면
  그 카드를 쓰는 씬이 전부 따라옵니다.
- **와일드카드** — 생성하는 순간 알아서 뽑히는 후보 묶음입니다.
- **NovelAI 의 기능을 같은 자리에서** — 인페인트·강화·바이브 전이·업스케일을 지금 보고
  있는 씬에 그대로 겁니다. 프롬프트와 설정이 이미 들어가 있어, 공홈을 오갈 일이 없습니다.
- **검열** — 기기 안의 모델이 가릴 곳을 찾아 덮습니다. 밖으로 나가는 것이 없고, 방식과
  세기는 직접 고릅니다.
- **AI 조수** — 워크스페이스를 맡기고 말로 시키면 프롬프트를 고치고 작업을 걸어 둡니다.
  되돌릴 수 없는 일은 먼저 묻습니다.

## 필요한 것

- **NovelAI 구독과 Persistent API Token.** 그림은 NovelAI 가 만들고, PeroPix 는 그 앞의
  작업대입니다. 토큰은 NovelAI 계정 설정에서 만들며 `pst-` 로 시작합니다.
- **생성에는 Anlas 가 듭니다.** 요금제의 무료 범위(크기·스텝) 안이면 들지 않고, 생성
  단추가 누르기 전에 늘 지금 값을 보여 줍니다.
- **Windows 10 또는 11.** WebView2 런타임이 필요하고, 대개 이미 깔려 있습니다.
- **또는 애플 실리콘 맥, macOS 14 이상** (베타, 아래 참고).

## 설치

1. [최신 릴리즈](https://github.com/mrm987/PeroPix3/releases/latest)에서
   `PeroPix-<버전>-win64.zip` 을 받습니다.
2. **쓰기가 되는 자리**에 풉니다 — 문서 폴더나 다른 드라이브. `Program Files` 안은 안 됩니다.
3. `PeroPix.exe` 를 켜고 **설정 ▸ 일반**에서 토큰을 붙여 넣습니다.

끝입니다. 파이썬이 꾸러미 안에 들어 있어 따로 깔 것이 없고, 레지스트리에 아무것도 안
남깁니다. 옮기거나 지우려면 폴더째 옮기거나 지우면 됩니다.

> 여러 벌을 풀어 **나란히 켜도 됩니다** — 폴더마다 포트·저장소·설정이 따로입니다.
> 막히는 것은 *같은* 폴더를 두 번 여는 것뿐입니다.

### macOS (베타)

애플 실리콘 맥, macOS 14 이상용입니다. 맥 판은 커뮤니티와 함께 유지하고 있어 Windows 판보다
확인이 덜 되어 있습니다. 이상한 점이 보이면 알려 주세요.

1. [최신 릴리즈](https://github.com/mrm987/PeroPix3/releases/latest)에서 `PeroPix-<버전>-macos-arm64.zip` 을 받아 풉니다.
2. `PeroPix.app` 을 **응용 프로그램** 폴더로 옮기고 거기서 켭니다. 업데이트는 그 자리의 앱을
   바꿉니다.
3. 애플의 공증을 받지 않은 앱이라 처음 켤 때 막힙니다. **시스템 설정 ▸ 개인정보 보호 및 보안**에서
   PeroPix 의 **그래도 열기**를 누릅니다.

맥에서는 내 파일이 앱 옆이 아니라 `~/Library/Application Support/PeroPix` 에 있습니다.
그 안의 폴더는 아래와 같습니다.

## 내 파일이 있는 자리

전부 `PeroPix.exe` 옆에 있습니다. 이것만 챙기면 다 챙긴 것이고, 업데이트는 여기를
건드리지 않습니다.

| 폴더 | 무엇이 들어 있나 |
|---|---|
| `workspaces/` | 작업물 — 탭·씬·프롬프트와 `output/` 아래의 그림 |
| `gallery/` | 골라 둔 그림 |
| `data/` | 설정과 카드. **토큰은 오직 `data/secrets.json` 에만 있습니다** |
| `logs/` | 로그 한 파일. 문제를 알리실 때 `logs/peropix.log` 를 첨부해 주세요 |

`app/` 은 프로그램 자체이고 업데이트 때마다 갈립니다.

## 업데이트

켤 때 조용히 확인하고 새 판이 있으면 알려 줍니다. **설정 ▸ 업데이트**에서 눌러도 됩니다.
받은 뒤 다시 켜면 적용됩니다. 작은 패치를 받을지 전체를 받을지는 앱이 알아서 정하고,
사용자는 받는 양만 봅니다.

## 개발

```bash
npm install
npm run tauri dev     # 프런트(1420) + 백엔드(8770) + 창
```

백엔드만: `python backend/server.py --port 8770`.
의존성은 `backend/requirements.txt` 에 있습니다.

꾸러미 만들기·릴리즈·업데이트가 패치와 전체를 고르는 규칙은
**[docs/release.md](docs/release.md)** 에 있습니다.

## 라이선스

Copyright (C) 2026 mrm987

[AGPL-3.0-or-later](LICENSE). 함께 담긴 third-party 구성 요소는 [THIRD-PARTY.md](THIRD-PARTY.md) 에 있습니다.
