"""로컬 에이전트 CLI — 찾아서 띄우고, 흘러나오는 것을 화면으로 넘긴다.

★**왜 CLI 인가**: 사용자가 이미 구독료를 내고 있는 것을 그대로 쓴다 (API 크레딧이 따로 안 든다).
  에이전트 루프·도구·재시도를 저쪽이 돌고, 우리는 **우리 도구만** 열어 준다 (`mcp_stdio.py`).

★프로세스를 띄우고 말을 거는 일은 `agentsession.py` 가 한다 (2026-08-15부터 CLI 는
  턴마다가 아니라 **대화 내내** 산다). 여기는 **찾고 · 깃발을 짓는** 자리다.

★실행 깃발 셋이 핵심이다 (실측 2026-08-07, `test_agent_live.py`):

    --mcp-config <설정> --strict-mcp-config --allowedTools "mcp__peropix__*"

  - `--strict-mcp-config` 를 빼면 **사용자의 다른 MCP 서버까지 딸려 온다.**
  - `--allowedTools` 는 **자동 승인일 뿐 막지 않는다.** 잠금 모드(`open=False`)에서는
    `--disallowedTools` 로 Read/Bash 등을 실제로 닫는다 — 안 닫으면 에이전트가 우리 소스를
    뒤지다 권한 벽에 막힌다 (실사용 로그에서 확인).
  - ★★기본은 **연 모드**다 (사용자 결정 2026-09-07): 저쪽 도구를 전부 쓰고 묻지 않는다.
    잠금은 설정 「앱 밖 도구 허용」을 끄면 된다 (`Runner.argv` 의 `open`).
  - ★`--bare` 는 쓰지 않는다 — OAuth 를 안 읽어 **구독 대신 API 키**를 요구한다.
  - ★**앱 안의 빈 폴더에서 돌린다**(`work_dir`). 예전엔 앱 밖이었다 — 왜 되돌렸는지는
    그 함수의 주석에 있다 (근거가 실측으로 무너졌다).
"""
from __future__ import annotations

import json
import os
import shutil
import sys
from pathlib import Path

# ★일곱에서 셋으로 줄였다 (사용자 지시 2026-08-08). 고를 수 없는 줄이 넷이나 떠 있어
#   "왜 회색인가"만 늘렸다. 남긴 기준은 **앞으로 붙일 값어치가 있는가**다:
#     Codex     OpenAI 공식 (GitHub 별 104k)
#     OpenCode  CLI 중 별 최다 193k · npm 주당 168만 — 이 PC 에도 이미 깔려 있었다
#   내린 것: Gemini CLI(구글이 Antigravity 로 흡수, 개인 무료 2026-06-18 종료) ·
#            Cursor Agent · Qwen Code · GitHub Copilot CLI.
#   ★다시 늘릴 때는 **스트림 파싱도 함께** 붙여야 한다 (`src/lib/codexStream.ts` 가 그 예다).
#   ★2026-08-15: 코덱스를 붙였다 — `codexapp.py`(app-server), 옮겨 적기는 `codexStream.ts`.
KNOWN = [
    {"id": "claude-code", "label": "Claude Code", "bins": ["claude"]},
    {"id": "codex", "label": "Codex CLI", "bins": ["codex"]},
    {"id": "opencode", "label": "OpenCode", "bins": ["opencode"]},
]

# 지금 실제로 몰 수 있는 것 — 나머지는 목록에만 보이고 고를 수 없다
DRIVABLE = {"claude-code", "codex"}


def agent_of(exe: str) -> str:
    """실행 파일 이름으로 어느 CLI 인지 가른다.

    ★화면이 `agent` 를 안 실어 보냈을 때의 **폴백일 뿐**이다. 어느 CLI 인지는 화면이 안다
      (고른 항목의 id). 이름으로 짐작하는 것을 정본으로 삼지 말 것."""
    stem = Path(exe).stem.lower()
    for c in KNOWN:
        if stem in c["bins"]:
            return c["id"]
    return "claude-code"


def _extra_dirs() -> list[Path]:
    """PATH 에 늘 있지는 않은 툴체인 폴더 (스튜디오 `engine.rs` 와 같은 자리)."""
    home = Path.home()
    if os.name == "nt":
        rel = [
            ("AppData", "Roaming", "npm"),
            ("AppData", "Local", "Programs", "claude"),
            ("scoop", "shims"),
            (".cargo", "bin"),
        ]
    else:
        rel = [(".npm-global", "bin"), (".local", "bin"), (".cargo", "bin"), (".bun", "bin")]
    return [home.joinpath(*r) for r in rel]


def find(bins: list[str]) -> str | None:
    for b in bins:
        p = shutil.which(b)
        if p:
            return real_exe(p, b)
    exts = [""] if os.name != "nt" else os.environ.get("PATHEXT", ".EXE;.CMD;.BAT").lower().split(";")
    for d in _extra_dirs():
        for b in bins:
            for e in exts:
                cand = d / (b + e)
                if cand.is_file():
                    return real_exe(str(cand), b)
    return None


#: 배치 래퍼 → 진짜 실행 파일. 찾는 데 폴더를 뒤지므로 한 번만 한다
_REAL: dict[str, str] = {}


def real_exe(path: str, name: str) -> str:
    """★★**배치 래퍼(`.CMD`)로 돌리지 않는다** — 실측으로 두 번 밟았다 (2026-08-15).

    npm 이 깔아 주는 것은 `claude.CMD`·`codex.CMD` 같은 **배치 파일**이라, 윈도우가
    `cmd.exe /c` 를 한 겹 끼운다. 그러면 cmd 가 명령줄을 **다시 해석**해서:

      · 코덱스 — 지침에 든 `long_hair -> long hair` 의 `>` 가 **출력 리다이렉션**이 됐다.
        JSON 이 통째로 `data/agent/long` 파일로 새고 종료 코드는 0 이었다.
      · 클로드 — 같은 지침을 실어 보내면 **출력이 아무것도 안 나온다.** 프로세스는 살아
        있는데 stdout·stderr 둘 다 조용하다. 진짜 `claude.exe` 로는 멀쩡히 돈다.

    두 증상 다 **조용히** 틀린다. 그래서 래퍼를 만나면 그 패키지 안의 진짜 exe 를 찾는다.
    못 찾으면 래퍼를 그대로 쓴다 (안 도는 것보다는 낫다)."""
    if os.name != "nt" or not path.lower().endswith((".cmd", ".bat", ".ps1")):
        return path
    if path in _REAL:
        return _REAL[path]
    root = Path(path).parent / "node_modules"
    found = ""
    if root.is_dir():
        # 얕은 곳부터 본다 — 깊이가 패키지마다 다르다 (클로드는 3단, 코덱스는 7단)
        for depth in range(2, 9):
            hit = next(root.glob("/".join(["*"] * depth) + f"/{name}.exe"), None)
            if hit and hit.is_file():
                found = str(hit)
                break
    _REAL[path] = found or path
    return _REAL[path]


#: 클로드 코드의 모델 별칭 — 도움말이 예로 든 둘 (실측 2026-08-08)
CLAUDE_MODELS = ["opus", "sonnet"]


def codex_home() -> Path:
    """코덱스가 자기 것을 두는 곳. ★우리가 옮기지 않는다 — 인증서가 여기 있다."""
    d = os.environ.get("CODEX_HOME")
    return Path(d) if d else Path.home() / ".codex"


def codex_models() -> list[str]:
    """코덱스가 **자기 캐시에 적어 둔** 모델 목록 (`~/.codex/models_cache.json`).

    ★목록을 우리가 들고 있지 않는다. 저쪽이 새 모델을 받으면 그 파일이 바뀌고 우리는 따라간다.
      실측 2026-08-15: `visibility` 가 `list` 인 것만 사람에게 보인다 (`hide` 는 내부용).
    ★못 읽으면 **빈 목록**이다. 그러면 `-m` 을 안 넘기고 코덱스 기본값으로 돈다."""
    try:
        raw = json.loads((codex_home() / "models_cache.json").read_text(encoding="utf-8"))
        return [m["slug"] for m in raw.get("models", []) if m.get("visibility") == "list"]
    except Exception:
        return []


def detect() -> list[dict]:
    out = []
    for c in KNOWN:
        path = find(c["bins"])
        out.append(
            {
                "id": c["id"],
                "label": c["label"],
                "installed": bool(path),
                "path": path,
                # ★"깔려 있다"와 "몰 수 있다"는 다르다. 목록에는 보이되 고르지 못하게 한다
                "drivable": c["id"] in DRIVABLE,
                # ★모델 목록은 **CLI 마다 다르다.** 하나로 두면 코덱스를 골라 놓고
                #   `sonnet` 이 떠 있게 된다 (고를 수 있는 값이 아니다)
                "models": CLAUDE_MODELS if c["id"] == "claude-code" else (
                    codex_models() if c["id"] == "codex" else []
                ),
            }
        )
    return out


def work_dir(data_dir: Path) -> Path:
    """CLI 를 돌릴 **빈 폴더** — 앱 안이다 (`data/agent/`).

    ★예전에는 앱 **밖**(임시 폴더)이었다. "앱 안에서 돌리면 우리 `CLAUDE.md` 가 문맥에
      실려 에이전트가 개발자처럼 군다"가 근거였는데, 실측(2026-08-12)으로 무너졌다:

        빈 임시 폴더에서 돌려도 **사용자 홈의 `~/.claude/CLAUDE.md` 는 그대로 실린다.**
        (조수에게 직접 물어 확인 — 로드된 지침 파일로 그 경로 하나를 댔다)

      즉 밖으로 뺀 것이 막은 것은 개발 폴더의 `CLAUDE.md` 하나뿐이고, 그것도 **개발
      환경에만 있는 파일**이다. 배포된 앱에는 없다. 그 이유로 앱이 쓰는 폴더를 앱 밖에
      둘 값어치가 없다 (사용자 결정 2026-08-12).

    ★전역 지침이 실리는 것은 **막지 않는다** (사용자 결정 2026-08-12) — 사용자는 자기
      지침을 바탕으로 도는 것을 오히려 기대한다. 막을 수단도 마땅치 않다: `--bare` 는
      OAuth 를 안 읽어 구독 대신 API 키를 요구하고, `CLAUDE_CONFIG_DIR` 로 홈을 옮기면
      인증서까지 따라가 **로그인이 깨진다** (둘 다 실측).

    ★비워 둔다 — 여기에 파일을 만들지 말 것. 조수가 만든 것은 MCP 도구를 거쳐 앱의
      제자리(카드·워크스페이스)로 간다."""
    d = data_dir / "agent"
    d.mkdir(parents=True, exist_ok=True)
    return d


def config_dir() -> Path:
    """claude 가 자기 것을 두는 곳 — 홈의 `.claude`, 또는 `CLAUDE_CONFIG_DIR` 로 옮긴 자리.

    ★우리가 옮기지는 않는다. 옮기면 인증서까지 따라가 **로그인이 깨진다** (실측 2026-08-12)."""
    d = os.environ.get("CLAUDE_CONFIG_DIR")
    return Path(d) if d else Path.home() / ".claude"


def session_exists(sid: str, agent: str = "claude-code") -> bool:
    """그 대화가 저쪽에 **아직 있는가**.

    ★있어야 `--resume` 이 먹는다. 없으면 claude 는 한 마디도 못 하고 죽는데, 화면에는
      까닭 없는 오류만 남는다 — 그래서 **대화를 열 때 미리** 물어 안내한다.

    ★claude 는 기본 30일이 지난 기록을 지운다(`cleanupPeriodDays`). 우리가 늘릴 수는
      없다 — 청소는 claude 홈 전체를 대상으로 **매 실행 시작 때** 돌아서, 우리가 큰 값을
      넘겨도 사용자가 직접 쓰는 claude 가 기본값으로 지워 버린다 (사용자 결정: 손대지 않음).

    ★폴더 이름 규칙을 흉내 내지 않고 **전 프로젝트에서 그 번호를 찾는다.** 규칙은
      작업 폴더 경로에서 나오는데, claude 버전에 따라 찾는 범위도 바뀐다
      (v2.1.223 부터는 프로젝트를 가리지 않고 찾는다). 파일 하나를 찾는 것뿐이라 싸다."""
    if not sid or any(c in sid for c in "/\\.:"):
        return False  # 경로 조각이 섞인 것은 우리 번호가 아니다
    if agent == "codex":
        # ★코덱스는 날짜로 나눠 담는다: `sessions/<년>/<월>/<일>/rollout-<시각>-<uuid>.jsonl`
        #   (실측 2026-08-15). claude 와 자리도 이름 규칙도 달라 한 함수로 겸할 수 없다.
        root = codex_home() / "sessions"
        return root.is_dir() and any(root.glob(f"*/*/*/rollout-*-{sid}.jsonl"))
    root = config_dir() / "projects"
    if not root.is_dir():
        return False
    return any(root.glob(f"*/{sid}.jsonl"))


def mcp_spec(backend: str) -> dict:
    """우리 도구를 여는 stdio 서버 한 벌 — **여기 하나뿐이다.**

    ★CLI 마다 적는 자리가 다르다 (claude 는 파일, 코덱스는 실행 깃발). 담는 그릇이 다를 뿐
      내용은 같아야 하므로 값은 여기서만 만든다."""
    return {
        "command": sys.executable,
        "args": [str(Path(__file__).resolve().parent / "mcp_stdio.py")],
        # ★★**앱 안의 조수**라고 밝힌다 (사용자 결정 2026-09-07, 1안). 이 다리(`mcp_stdio.py`)는 바깥
        #   에이전트용 설정(`/api/mcp/config`)과 같은 파일이라, 표식 없이는 매 요청에 「바깥」 머리글을 붙여
        #   `name_chat` 이 거절되고(「이 도구는 PeroPix 앱 안의 조수만 씁니다」) **승인 카드도 건너뛰었다** —
        #   앱이 띄운 CLI 엔진인데도 (실연동 2026-09-07). 바깥 설정에는 이 변수가 없으므로 그쪽 규칙은 그대로다.
        "env": {"PEROPIX_BACKEND": backend, "PEROPIX_INSIDE": "1"},
    }


def mcp_config(data_dir: Path, backend: str) -> Path:
    """우리 도구를 여는 MCP 설정 — 켤 때마다 다시 쓴다 (백엔드 주소가 바뀔 수 있다)."""
    cfg = data_dir / "mcp.json"
    cfg.write_text(
        json.dumps({"mcpServers": {"peropix": {"type": "stdio", **mcp_spec(backend)}}}, ensure_ascii=False),
        encoding="utf-8",
    )
    return cfg


class Runner:
    """클로드 코드 **실행 깃발**만 든다.

    ★프로세스를 띄우고 말을 거는 일은 `agentsession.py` 로 옮겼다 (2026-08-15) —
      이제 CLI 는 턴마다가 아니라 **대화 내내** 산다. 여기 남은 것은 깃발뿐이라
      잠금 규칙이 한 곳에 모여 있다."""

    #: `claude --effort` 가 받는 단계 (실측: `claude --help` — low·medium·high·xhigh·max)
    EFFORTS = ["max", "xhigh", "high", "medium", "low"]

    def argv(self, cfg: Path, system: str = "", resume: str = "",
             model: str = "", effort: str = "", open: bool = True) -> list[str]:
        """실행 깃발 — **여기 하나뿐이다.** 회귀(`test_lockdown_live.py`)도 이것을 그대로 쓴다.

        ★★`open` — **앱 밖 도구(파일·셸·웹)를 허용한다** (사용자 결정 2026-09-07, 기본 켬).
          이 앱은 자유도를 안전보다 앞에 둔다 (`CLAUDE.md` 「자유도의 기준은 ComfyUI」).
          켜면 저쪽 CLI 가 제 도구를 전부 쓰고, 허용 목록 밖도 묻지 않고 지나간다
          (`bypassPermissions`). 헤드리스라 **답할 사람이 없는** `AskUserQuestion` 만 닫는다.
        ★끄면 예전의 잠금이다 — 설정에서 끌 수 있게 둔다 (아래 갈래)."""
        args = [
            "-p",
            "--mcp-config", str(cfg),
            "--strict-mcp-config",
            "--allowedTools", "mcp__peropix__*",
        ]
        if open:
            args += [
                # ★헤드리스에는 **답할 사람이 없다** — 물어 놓고 턴만 버린다 (실측 2026-08-08)
                "--disallowedTools", "AskUserQuestion",
                "--permission-mode", "bypassPermissions",
            ]
        else:
            args += [
                # ★`--allowedTools` 는 **자동 승인일 뿐 막지 않는다.** 실사용에서 에이전트가
                #   Read/Grep/Bash 로 우리 소스를 뒤지고 고치려 들었다. 이름으로 닫는다.
                "--disallowedTools",
                "Bash", "PowerShell", "BashOutput", "KillShell",
                "Read", "Write", "Edit", "NotebookEdit", "Glob", "Grep",
                "WebFetch", "WebSearch", "Task", "SlashCommand",
                # ★`Skill` 도 닫는다 — 바깥 지침을 문맥에 끌어들이는 통로다
                "Skill",
                "AskUserQuestion",
                # ★★**실제로 막는 것은 이것이다.** 위 목록은 이름을 하나씩 적는 것이라 새 도구가
                #   생기면 샌다 — 실측(2026-08-08)에서 에이전트가 `PowerShell` 을 시도했는데
                #   그 이름이 목록에 없었다. `dontAsk` 가 **허용 목록 밖을 묻지 않고 거절**해서
                #   막혔다. 목록은 보조일 뿐이니 이 깃발을 빼지 말 것.
                "--permission-mode", "dontAsk",
            ]
        args += [
            "--output-format", "stream-json",
            "--verbose",
        ]
        # ★**이어 붙일 때는 지침을 다시 안 준다.** 세션에 이미 적용돼 있고, 다시 주면
        #   클로드 코드가 **다른 세션으로 갈라 버린다** — 그래서 2턴이 1턴을 기억 못 했다
        #   (실측 2026-08-08: 짧은 지침으로는 이어지고 긴 지침으로는 안 이어졌다).
        if system and not resume:
            args += ["--append-system-prompt", system]
        # ★이어 붙이기 — 없으면 새 대화가 된다 (「새 대화」가 이 값을 비운다)
        if resume:
            args += ["--resume", resume]
        # ★모델·추론 강도도 고를 수 있다 (사용자 지적 2026-08-08 — API 쪽에만 있었다).
        #   `--model` 은 별칭('sonnet'·'opus')도 전체 이름도 받는다. 비우면 CLI 기본값.
        if model:
            args += ["--model", model]
        if effort:
            args += ["--effort", effort]
        return args
