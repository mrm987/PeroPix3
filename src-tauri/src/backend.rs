//! 파이썬 백엔드를 자식 프로세스로 띄우고, 앱이 닫힐 때 함께 내린다.
//!
//! ★2025-12-30 의 Tauri 시도에서 이 부분(사이드카 spawn)은 이미 올바르게 작성돼 있었다.
//! 당시 막힌 것은 빌드 배관이었지 이 구조가 아니다. 같은 형태를 유지하되
//! 프로세스 수명 관리를 셸이 확실히 하도록 정리했다.

use std::fs::File;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;

pub const DEFAULT_PORT: u16 = 8770;

/// 백엔드 포트 — **한 번 정하고 그대로 쓴다** (`OnceLock`).
///
/// ★**환경변수로 갈아 끼운다** (사용자 지시 2026-08-08). 예전엔 상수라, QA 인스턴스와
/// 사용자 앱이 같은 8770 을 다퉜다 — 나중에 켠 쪽은 사이드카를 못 띄워 창은 뜨는데
/// API 가 없는 상태(502)가 됐고, 원인이 화면에 안 나왔다.
/// `qa\host.cmd` 가 `PEROPIX_BACKEND_PORT=8771` 을 넣어 준다.
///
/// ★★**비어 있는 포트를 스스로 찾는다** (사용자 지시 2026-08-26, 포터블 배포 준비).
///   포터블은 **여러 벌을 다른 폴더에 풀어 두고 함께 쓰는** 형식이라, 번호를 하나로 박아
///   두면 나중에 켠 쪽이 남의 백엔드에 붙는다 — 창은 이쪽인데 데이터는 저쪽이 된다.
///   ★그래도 **8770 이 비어 있으면 그것을 쓴다** — 로그·문서·MCP 설정에 익숙한 번호가
///     유지되는 편이 낫고, 혼자 켤 때가 대부분이다.
///   ★잡았다 놓는 사이에 남이 채 갈 수는 있다. 그때는 사이드카가 못 떠서 **눈에 보이게**
///     실패한다 (조용히 남의 것에 붙는 지금보다 낫다).
/// ★★**CSP 도 함께 열어 두어야 한다** (`tauri.conf.json` 의 `app.security.csp`).
///   거기 포트를 번호로 박아 두면(예전에는 `127.0.0.1:8770`), 다른 포트로 뜬 인스턴스는
///   웹뷰가 **제 백엔드를 막아** 창만 뜨고 아무것도 못 한다. 그래서 `127.0.0.1:*` 이다.
///   ★그 설정 파일에는 주석을 못 단다 (스키마가 모르는 열쇠를 거부한다) — 그래서 여기 적는다.
/// 이번 실행의 **열쇠** — 주소 앞머리(`/k/<열쇠>`)로 실려 나간다.
///
/// ★★**왜 있나** (2026-08-26, 첫 공개 배포 점검에서 잡았다): 백엔드는 `127.0.0.1` 에만
///   붙지만 **브라우저는 로컬 주소로도 요청을 보낸다.** 포트가 8770 으로 거의 고정이라,
///   앱을 켜 둔 채 아무 사이트나 열려 있으면 그 사이트가 우리 API 를 그대로 부를 수 있었다
///   (실측: `Origin: https://evil.example` 로 프리플라이트를 던지니 `allow-origin: *` 이
///   돌아왔다). 그 API 에는 **임의의 실행 파일을 띄우는 길**(`/api/cli/run` 의 `exe`),
///   생성(돈), 워크스페이스 버리기, 폴더 경로 흘리기가 다 들어 있다.
/// ★★막는 방식은 **주소 앞머리**다. 화면이 쓰는 주소는 전부 이 값(`backend_url`)에
///   경로를 이어 붙여 만들어지므로(`lib/backend.ts`·`lib/imgUrl.ts`·소켓), 앞머리 하나로
///   **`<img>` 도 웹소켓도 함께 덮인다.** 헤더로 하면 그 둘이 헤더를 못 실어 새어 나간다.
/// ★웹페이지는 이 값을 알 길이 없다 — 껍데기가 만들고 화면에만 알려 준다.
///
/// ★**개발 중에는 안 건다** (`PEROPIX_DEV_RELOAD` — `dev.bat`·`qa\host.cmd` 만 넣는다).
///   그래야 브라우저로 `localhost:1420` 을 열어 사이드카에 붙이는 확인 방법이 그대로 산다
///   (`CLAUDE.md` 의 「확인 방법」). 배포되는 앱은 그 값을 넣지 않으므로 언제나 잠긴다.
pub fn backend_key() -> &'static str {
    use std::sync::OnceLock;
    static KEY: OnceLock<String> = OnceLock::new();
    KEY.get_or_init(|| {
        if std::env::var("PEROPIX_DEV_RELOAD").is_ok() {
            return String::new();
        }
        // ★새 크레이트를 안 들인다 — `RandomState` 의 씨앗은 OS 난수다(표준 문서).
        //   맞히는 쪽이 얻는 것은 403 뿐이라 되풀이 시도로 좁혀 갈 실마리도 없다.
        use std::collections::hash_map::RandomState;
        use std::hash::{BuildHasher, Hasher};
        let mut s = String::with_capacity(32);
        while s.len() < 32 {
            let mut h = RandomState::new().build_hasher();
            h.write_usize(s.len());
            s.push_str(&format!("{:016x}", h.finish()));
        }
        s
    })
}

pub fn backend_port() -> u16 {
    use std::sync::OnceLock;
    static PORT: OnceLock<u16> = OnceLock::new();
    *PORT.get_or_init(|| {
        if let Some(p) = std::env::var("PEROPIX_BACKEND_PORT")
            .ok()
            .and_then(|s| s.trim().parse::<u16>().ok())
        {
            return p;
        }
        let free = |port: u16| {
            std::net::TcpListener::bind(("127.0.0.1", port))
                .and_then(|l| l.local_addr())
                .map(|a| a.port())
                .ok()
        };
        free(DEFAULT_PORT).or_else(|| free(0)).unwrap_or(DEFAULT_PORT)
    })
}

/// 이 앱이 서 있는 자리 — `backend/server.py` 를 품은 폴더다.
///
/// ★★**데이터도 여기 쌓인다** (`server.py` 의 `APP_DIR`): `data/`·`workspaces/`·`gallery/`.
///   그래서 이 값이 곧 **인스턴스의 신원**이다 — 웹뷰 저장소를 가르는 것도, 같은 폴더를
///   두 번 열지 못하게 막는 것도, 화면이 「내 백엔드가 맞나」를 묻는 것도 이 값으로 한다.
pub fn root() -> PathBuf {
    find_repo_root().unwrap_or_else(app_dir)
}

/// 자식을 **Job Object 에 매단다** — 부모가 어떻게 죽든 함께 내려간다.
///
/// ★`kill()` 은 종료 이벤트에서만 돈다. `taskkill /F`·크래시·`process::exit` 에서는
/// 그 이벤트가 안 돌아 **파이썬이 고아로 남고 포트를 계속 쥔다.** 실측(2026-08-08):
/// 고아 사이드카가 8770 을 잡고 있어 새로 띄운 백엔드가 바인딩에 실패했고,
/// **옛 코드가 계속 응답해서** 고친 것이 안 먹힌 것처럼 보였다.
/// 잡의 `KILL_ON_JOB_CLOSE` 는 커널이 보장하므로 우리 코드가 안 돌아도 지켜진다.
#[cfg(windows)]
fn adopt_into_job(child: &Child) {
    use std::os::windows::io::AsRawHandle;
    use std::sync::OnceLock;
    use windows_sys::Win32::Foundation::HANDLE;
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };

    // ★핸들을 **살려 둔다.** 닫는 순간 잡이 닫히고 멤버가 죽는다 — 프로세스가 끝날 때까지 들고 있는다.
    static JOB: OnceLock<usize> = OnceLock::new();
    let job = *JOB.get_or_init(|| unsafe {
        let h = CreateJobObjectW(std::ptr::null(), std::ptr::null());
        if h.is_null() {
            return 0;
        }
        let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        SetInformationJobObject(
            h,
            JobObjectExtendedLimitInformation,
            &info as *const _ as *const std::ffi::c_void,
            std::mem::size_of_val(&info) as u32,
        );
        h as usize
    });
    if job == 0 {
        eprintln!("[backend] job object 를 못 만들었습니다 — 고아 방지가 꺼집니다");
        return;
    }
    let ok = unsafe { AssignProcessToJobObject(job as HANDLE, child.as_raw_handle() as HANDLE) };
    if ok == 0 {
        eprintln!("[backend] job 에 매달지 못했습니다 — 고아 방지가 꺼집니다");
    }
}

#[cfg(not(windows))]
fn adopt_into_job(_child: &Child) {}

/// 자식 프로세스 핸들.
///
/// ★종료는 `kill()` 을 종료 이벤트에서 **명시적으로** 부르는 것이 정본이다.
/// `Drop` 은 process::exit 경로에서 실행되지 않아 백엔드가 고아로 남는다 — 실측으로 확인됨.
/// Drop 은 마지막 안전망으로만 둔다.
pub struct Backend(pub Mutex<Option<Child>>);

impl Backend {
    pub fn kill(&self) {
        if let Ok(mut guard) = self.0.lock() {
            if let Some(child) = guard.as_mut() {
                kill_tree(child);
                let _ = child.kill();
                let _ = child.wait();
            }
            *guard = None;
        }
    }
}

/// 자식의 **자손까지** 끝낸다 (Windows: `taskkill /T` — pid 로만, 이름으로 죽이지 않는다).
///
/// ★개발 중(`PEROPIX_DEV_RELOAD`)의 uvicorn 은 감시자 + 워커 두 프로세스다. 감시자만 죽이면 워커가 남아
///   포트를 쥐고, 다시 띄운 백엔드가 바인딩에 실패한다 (같은 증상의 실측: 상단 `adopt_into_job` 주).
///   앱이 나갈 때는 잡(Job)이 자손을 거두지만, **앱은 살아 있고 백엔드만 다시 띄울 때**(`restart_backend`)는
///   잡이 닫히지 않으므로 여기서 직접 거둔다.
#[cfg(windows)]
fn kill_tree(child: &Child) {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let _ = Command::new("taskkill")
        .args(["/PID", &child.id().to_string(), "/T", "/F"])
        .creation_flags(CREATE_NO_WINDOW)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
}

#[cfg(not(windows))]
fn kill_tree(_child: &Child) {}

impl Drop for Backend {
    fn drop(&mut self) {
        if let Ok(mut guard) = self.0.lock() {
            if let Some(child) = guard.as_mut() {
                let _ = child.kill();
                let _ = child.wait();
            }
        }
    }
}

fn app_dir() -> PathBuf {
    std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(PathBuf::from))
        .unwrap_or_else(|| std::env::current_dir().unwrap_or_default())
}

/// **앱이 도는 데 필요한 것들이 사는 자리** (사용자 지시 2026-08-27: *"유저가 접근하는
/// 폴더는 한정적인데 너무 다 나와 있는 느낌"*).
///
/// ★★배포판은 `app/` 안에 넣는다 — `backend`·`python`·`models`·`webview`·`version.json`.
///   바깥에는 **사람이 여는 것만** 남는다 (`gallery`·`logs`·`workspaces`·`data`).
/// ★저장소에서 개발할 때는 `app/` 이 없다. 그때는 뿌리가 곧 그 자리다 — 두 배치를
///   **한 함수가** 가른다. 자리를 아는 곳이 여럿이면 한쪽만 고쳐진다.
pub fn inner(root: &Path) -> PathBuf {
    let nested = root.join("app");
    if nested.join("backend").join("server.py").exists() {
        nested
    } else {
        root.to_path_buf()
    }
}

/// 개발 중에는 실행 파일이 `src-tauri/target/debug` 에 있으므로 저장소 루트를 거슬러 찾는다.
/// ★배포판(`app/backend/server.py`)과 저장소(`backend/server.py`) 둘 다 알아본다.
fn find_repo_root() -> Option<PathBuf> {
    let mut dir = app_dir();
    for _ in 0..6 {
        if dir.join("backend").join("server.py").exists()
            || dir.join("app").join("backend").join("server.py").exists()
        {
            return Some(dir);
        }
        dir = dir.parent()?.to_path_buf();
    }
    None
}

/// 번들된 파이썬 → PATH 의 python 순으로 찾는다.
fn find_python(root: &PathBuf) -> PathBuf {
    let bundled = inner(root).join("python").join("python.exe");
    if bundled.exists() {
        return bundled;
    }
    PathBuf::from("python")
}

/// **같은 폴더를 두 번 열지 못하게** 잡아 두는 표식 (사용자 지시 2026-08-26).
///
/// ★★포터블은 **여러 벌을 다른 폴더에 두고 함께 쓰는** 형식이라, 「앱을 두 번 켜지 마라」는
///   전역 잠금은 오히려 방해다 (안정판 옆에 시험판을 두는 것을 막는다). 막아야 하는 것은
///   **같은 창고를 두 창이 만지는 것**뿐이다 — `workspaces/`·`data/` 가 곧 그 창고다.
/// ★파일을 **공유 없이** 연다. 잡혀 있으면 열리지 않으므로 그것이 곧 「누가 쓰는 중」이다.
///   ★핸들을 살려 둔다 — 닫으면 잠금이 풀린다. 프로세스가 죽으면 커널이 알아서 놓아 준다
///     (크래시·강제 종료에도 자물쇠가 남지 않는다).
#[cfg(windows)]
pub fn lock_app_dir() -> Option<File> {
    use std::os::windows::fs::OpenOptionsExt;
    std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(false)
        .share_mode(0) // 아무에게도 안 빌려준다
        .open(root().join(".instance.lock"))
        .ok()
}

#[cfg(not(windows))]
pub fn lock_app_dir() -> Option<File> {
    File::create(root().join(".instance.lock")).ok()
}


/// 실행 하나의 경계 표시. ★자를 때 **이 줄을 기준으로** 잘라내므로 문구를 바꾸지 않는다.
const MARK: &str = "=== PeroPix 실행 시작 ===";
/// 이 크기를 넘으면 오래된 실행부터 걷어낸다
///
/// ★★**크기는 「읽는 사람」에 맞춰 잡았다** (사용자 지시 2026-08-27: *"검토도 클로드가 할
///   텐데 너무 많아서 맥락 찾기가 어렵지만 않으면 됨"*). 실측으로 실행 한 번이 **1KB 남짓**
///   이므로(접근 로그를 끈 뒤), 128KB 면 **최근 백 회분**이 남는다 — 고장 난 실행과 그 앞
///   몇 회를 함께 보기에 넉넉하고, 통째로 읽어도 맥락이 묻히지 않는 양이다.
const LOG_MAX: u64 = 256 * 1024;
/// 걷어낸 뒤 남길 대략의 크기
const LOG_KEEP: u64 = 128 * 1024;
/// ★**한 실행이 이만큼을 넘으면** 그 실행이라도 앞을 자른다. 경계로만 자르는 규칙은
///   「마지막 한 회는 통째로」를 지키는데, 그 한 회가 오류를 쏟아 낸 경우에는 그것만으로
///   파일이 한없이 커진다. 이 천장이 그 경우를 막는다 — 여기서는 줄 경계로 자른다.
const LOG_HARD: u64 = 1024 * 1024;
/// 앞이 잘렸을 때 남기는 표시 — 읽는 사람이 「여기가 처음이 아니다」를 알아야 한다
const CUT_NOTE: &str = "…(앞부분이 잘렸습니다)\n";

/// 로그 이름 — ★★**파일은 하나뿐이다** (사용자 지시 2026-08-27: *"로그 파일은 하나만
/// 생기게"*). 파이썬의 두 물줄기(stdout·stderr)도 여기로 함께 흘린다.
pub const LOG_NAME: &str = "peropix.log";

/// 로그를 **이어 쓰기**로 연다. 켤 때마다 새로 만들면 직전 실행의 자취가 지워져,
/// 정작 알고 싶은 「죽기 직전」이 늘 사라진다 (부팅 시간표에서 그 일을 겪었다).
///
/// ★★**자를 때는 줄이 아니라 「실행」 단위로 자른다** (사용자 지적 2026-08-27:
///   *"최근 n줄로 하면 로그가 짤리려나"*). 줄 수로 자르면 사라지는 것이 언제나 **앞쪽**인데,
///   오류가 쏟아진 실행에서는 그 실행의 시작(무엇을 하다 그랬는지)이 먼저 밀려난다.
///   `MARK` 를 경계로 오래된 실행을 통째로 걷어내면 한 실행이 반토막 나지 않는다.
/// 어디서부터 남길지 — **실행 경계(`MARK`)에서만** 자른다.
///
/// 뒤에서부터 경계를 훑어, 남는 양이 `keep` 을 넘는 첫 경계를 고른다. 그래서 잘려 나가는
/// 것은 언제나 **완결된 옛 실행**이고, 남는 실행은 처음부터 끝까지 온전하다.
/// ★경계가 하나도 없으면(옛 파일) 0 — 아무것도 안 자른다. 다음 실행부터 경계가 생긴다.
fn trim_at(text: &str, keep: u64, hard: u64) -> usize {
    let mut cut = 0usize;
    for (i, _) in text.match_indices(MARK).collect::<Vec<_>>().into_iter().rev() {
        cut = i;
        if (text.len() - i) as u64 >= keep {
            break;
        }
    }
    // ★천장을 넘으면 줄 경계에서 한 번 더 자른다 (위 `LOG_HARD` 주석)
    // ★★**바이트로 자르지 않는다** — 한글은 세 바이트라 `text[want..]` 가 글자 한가운데를
    //   짚으면 **패닉**이다. 여기는 앱이 켜질 때 도는 자리라 그대로 창이 안 뜬다
    //   (판정이 잡았다: `한_실행이_너무_크면_줄_경계에서_자른다`). 줄바꿈 자리는
    //   언제나 글자 경계이므로 그것만 훑는다.
    if (text.len() - cut) as u64 > hard {
        let want = text.len() - hard as usize;
        cut = text
            .match_indices('\n')
            .find(|(i, _)| *i >= want)
            .map(|(i, _)| i + 1)
            .unwrap_or(text.len());
    }
    cut
}

/// 바이트째로 받아 자른다 — 남길 몸통을 돌려준다.
///
/// ★★**UTF-8 이 아닌 바이트가 섞여 있어도 자른다** (2026-09-05 실측: 파일이 46MB·106만 줄까지
///   자랐다). 파이썬 자식이 콘솔 코드페이지(cp949)로 찍은 줄이 섞이면 `read_to_string` 이
///   실패했고, 실패하면 자르기를 **조용히 건너뛰어** 상한이 없는 것과 같았다. 깨진 바이트는
///   � 로 바꿔서라도 자른다. 앞으로는 자식에게 `PYTHONIOENCODING=utf-8` 을 주므로 새 줄은
///   전부 UTF-8 이지만, 옛 파일은 이 길로 한 번에 정리된다 (업데이트 뒤 첫 실행).
fn trim_bytes(bytes: &[u8], keep: u64, hard: u64) -> String {
    let text = String::from_utf8_lossy(bytes);
    let cut = trim_at(&text, keep, hard);
    let kept = &text[cut..];
    if kept.starts_with(MARK) {
        kept.to_string()
    } else {
        format!("{CUT_NOTE}{kept}")
    }
}

fn open_log(root: &Path) -> Option<File> {
    let dir = root.join("logs");
    let _ = std::fs::create_dir_all(&dir);
    let path = dir.join(LOG_NAME);

    // ★옛 이름들은 치운다 — 「하나만」이 지켜지게 (없으면 조용히 넘어간다)
    for old in ["backend.log", "backend.err.log", "boot.log"] {
        let _ = std::fs::remove_file(dir.join(old));
    }

    if std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0) > LOG_MAX {
        if let Ok(bytes) = std::fs::read(&path) {
            let _ = std::fs::write(&path, trim_bytes(&bytes, LOG_KEEP, LOG_HARD));
        }
    }

    std::fs::OpenOptions::new().create(true).append(true).open(&path).ok()
}

/// 껍데기가 **로그 파일에 한 줄** 적는다.
///
/// ★★`println!` 은 갈 데가 없다 (사용자 지적으로 알게 됨 2026-08-28). 창만 있는 앱이라
///   stdout 이 어디에도 안 붙어 있고, `spawn` 이 파일로 흘려 주는 것은 **파이썬 자식의
///   출력**뿐이다. 그래서 껍데기가 적은 줄은 지금까지 통째로 사라지고 있었다 —
///   진단을 넣어 놓고 「아무 줄도 없다」를 결론으로 읽을 뻔했다.
/// ★쓰는 자리가 드물어 열고 닫는 값은 문제가 안 된다 (부팅 때 몇 줄).
pub fn log_line(msg: &str) {
    if let Some(mut f) = open_log(&root()) {
        let _ = writeln!(f, "{msg}");
    }
}

pub fn spawn() -> std::io::Result<Child> {
    let root = root();
    let python = find_python(&root);
    let script = inner(&root).join("backend").join("server.py");
    let log = open_log(&root);

    let mut head = String::new();
    head.push_str(&format!("{MARK}
"));
    head.push_str(&format!("[backend] root   = {}
", root.display()));
    head.push_str(&format!("[backend] python = {}
", python.display()));
    head.push_str(&format!("[backend] script = {}
", script.display()));
    if let Some(mut f) = log.as_ref().and_then(|f| f.try_clone().ok()) {
        let _ = f.write_all(head.as_bytes());
    }
    print!("{head}");

    let out = log.as_ref().and_then(|f| f.try_clone().ok());
    let err = log.as_ref().and_then(|f| f.try_clone().ok());

    let mut cmd = Command::new(&python);
    cmd.arg(&script)
        .arg("--port")
        .arg(backend_port().to_string())
        // ★열쇠는 **환경변수로만** 넘긴다 — 명령줄에 실으면 작업 관리자에서 그대로 보인다
        .env("PEROPIX_KEY", backend_key())
        // ★★파이썬의 출력은 **UTF-8 로** — 안 주면 윈도우 콘솔 코드페이지(cp949)로 찍어 로그에
        //   두 인코딩이 섞이고, 한글이 깨져 보이며, 자르기(`trim_bytes` 주석)가 막혔다 (2026-09-05)
        .env("PYTHONIOENCODING", "utf-8")
        .env("PYTHONUTF8", "1")
        .current_dir(&root)
        .stdout(out.map(Stdio::from).unwrap_or_else(Stdio::null))
        .stderr(err.map(Stdio::from).unwrap_or_else(Stdio::null));

    // 콘솔 창이 따로 뜨지 않게 (Windows)
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let child = cmd.spawn()?;
    adopt_into_job(&child); // ★부모가 어떻게 죽든 함께 내려가게
    Ok(child)
}

#[cfg(test)]
mod log_tests {
    use super::{trim_at, trim_bytes, MARK};

    /// 실행 세 회분을 만든다 — 각 회는 경계 한 줄 + 본문 몇 줄
    fn runs(n: usize, body: usize) -> String {
        (1..=n)
            .map(|i| format!("{MARK}
{}
", format!("실행{i} 줄
").repeat(body)))
            .collect()
    }

    #[test]
    fn 경계에서만_자른다() {
        let text = runs(3, 10);
        let cut = trim_at(&text, 1, u64::MAX);
        assert!(text[cut..].starts_with(MARK), "자른 자리가 실행의 첫머리라야 한다");
    }

    #[test]
    fn 남길_양보다_많이_남긴다() {
        let text = runs(5, 20);
        let keep = 200u64;
        let cut = trim_at(&text, keep, u64::MAX);
        assert!((text.len() - cut) as u64 >= keep, "남긴 양이 상한보다 적으면 안 된다");
        assert!(cut > 0, "다섯 회분이면 앞쪽은 걷어내야 한다");
    }

    #[test]
    fn 마지막_한_회는_통째로_남는다() {
        let text = runs(3, 5);
        // 아주 작은 상한이면 마지막 회 하나만 남는다 — 그래도 그 회는 온전하다
        let cut = trim_at(&text, 1, u64::MAX);
        let kept = &text[cut..];
        assert_eq!(kept.matches(MARK).count(), 1);
        assert!(kept.contains("실행3 줄"));
    }

    /// ★★cp949 바이트가 섞인 옛 로그도 자른다 — `read_to_string` 이 실패해 자르기가 건너뛰어지던
    ///   그 파일(46MB)이 업데이트 뒤 첫 실행에서 정리되어야 한다
    #[test]
    fn 유효하지_않은_바이트가_섞여도_자른다() {
        let mut bytes = Vec::new();
        for i in 1..=5 {
            bytes.extend_from_slice(format!("{MARK}\n").as_bytes());
            for _ in 0..20 {
                bytes.extend_from_slice(format!("실행{i} 줄 ").as_bytes());
                bytes.extend_from_slice(&[0xbe, 0xc8, 0xb3, 0xe7]); // cp949 「안녕」
                bytes.push(b'\n');
            }
        }
        let kept = trim_bytes(&bytes, 300, u64::MAX);
        assert!(kept.starts_with(MARK), "실행 경계에서 시작해야 한다");
        assert!(kept.contains("실행5 줄"), "마지막 실행은 남는다");
        assert!(!kept.contains("실행1 줄"), "앞쪽 실행은 걷어낸다");
        assert!(kept.contains('\u{FFFD}'), "깨진 바이트는 � 로 바뀐다");
    }

    #[test]
    fn 경계가_없으면_안_자른다() {
        assert_eq!(trim_at("경계 없는 옛 로그
여러 줄
", 1, u64::MAX), 0);
    }

    /// ★한 실행이 천장을 넘으면 **그 실행이라도** 앞을 자른다 — 안 그러면 오류를 쏟아 낸
    ///   실행 하나로 파일이 한없이 커진다. 자른 자리는 줄 경계다.
    #[test]
    fn 한_실행이_너무_크면_줄_경계에서_자른다() {
        let text = runs(1, 2000);
        let hard = 1000u64;
        let cut = trim_at(&text, 1, hard);
        let kept = &text[cut..];
        assert!(cut > 0, "천장을 넘었으면 잘라야 한다");
        assert!((kept.len() as u64) <= hard, "천장 안으로 들어와야 한다");
        assert!(!kept.starts_with('\n') && text[..cut].ends_with('\n'), "줄 한가운데를 자르면 안 된다");
    }
}
