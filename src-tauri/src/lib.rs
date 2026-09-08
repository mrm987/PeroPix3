mod backend;
mod window_edge;
mod update;

use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::sync::OnceLock;
use std::time::Instant;
use tauri::{Manager, RunEvent};

/// 이 프로세스가 시작한 순간. ★부팅이 어디서 오래 걸리는지 재는 자 (`uptime_ms`).
static START: OnceLock<Instant> = OnceLock::new();

/// 껍데기가 켜진 뒤 흐른 시간(ms). ★화면이 **자기가 언제 처음 돌았는지**를 알기 위한 값이다 —
/// 창을 만들고 웹뷰가 문서를 받아 번들을 돌리기까지가 여기 다 들어 있다. 그 구간은 화면
/// 스스로는 잴 수 없다 (`performance.timeOrigin` 은 문서가 생긴 뒤부터다).
#[tauri::command]
fn uptime_ms() -> u128 {
    START.get().map(|t| t.elapsed().as_millis()).unwrap_or(0)
}

/// 프론트가 백엔드 주소를 알아내는 유일한 창구.
/// 포트를 프론트에 하드코딩하지 않는다 — 포트는 이제 인스턴스마다 다르다(`backend_port`).
///
/// ★★**이번 실행의 열쇠가 주소 앞머리로 붙는다** (`/k/<열쇠>`, 2026-08-26). 화면이 쓰는
///   주소는 전부 이 값에 경로를 이어 붙여 만들어지므로, 여기 한 번 붙이면 그림 태그와
///   웹소켓까지 함께 덮인다 — 왜 필요한지는 `backend::backend_key` 의 ★★주에 있다.
#[tauri::command]
fn backend_url() -> String {
    let key = backend::backend_key();
    let base = format!("http://127.0.0.1:{}", backend::backend_port());
    if key.is_empty() { base } else { format!("{base}/k/{key}") }
}

/// 이 앱이 서 있는 자리. ★화면이 **「지금 붙은 백엔드가 내 것인가」**를 묻는 데 쓴다 —
/// 백엔드도 같은 값을 알려 주므로(`/api/health` 의 `root`), 둘이 다르면 남의 것에 붙은 것이다.
/// 최대화 창을 커서 아래로 한 번에 복원하고 끌기를 시작한다 — 까닭은 `window_edge::drag_restore`.
/// `offset_y` 는 논리 픽셀로 받아 여기서 물리 픽셀로 바꾼다.
#[tauri::command]
fn drag_restore(window: tauri::WebviewWindow, ratio_x: f64, offset_y: f64) -> Result<(), String> {
    #[cfg(windows)]
    {
        let h = window.hwnd().map_err(|e| e.to_string())?;
        let scale = window.scale_factor().unwrap_or(1.0);
        return window_edge::drag_restore(h.0 as isize as *mut core::ffi::c_void, ratio_x, (offset_y * scale).round() as i32);
    }
    #[cfg(not(windows))]
    {
        let _ = (window, ratio_x, offset_y);
        Err("윈도우에서만".into())
    }
}

#[tauri::command]
fn app_root() -> String {
    backend::root().to_string_lossy().to_string()
}

/// 쌓아 둔 새 판이 있나 — 화면이 「지금 다시 켜기」를 낼지 정하는 근거.
#[tauri::command]
fn update_staged() -> bool {
    update::staged(&backend::root())
}

/// **갈아 끼우고 다시 켠다** (사용자 지시 2026-08-26).
///
/// ★★차례가 곧 안전이다: **사이드카를 먼저 내린다** → 파일을 옮긴다 → 새 exe 를 띄운다 →
///   우리는 나간다. 파이썬이 살아 있으면 `python/` 안의 파일이 잡혀 있어 못 옮긴다.
/// ★옮기다 실패하면 **그 자리에서 멈추고 그대로 둔다** — 옛것은 `.update/old/` 에 온전히
///   있고, 다음에 켤 때 같은 자리를 다시 시도한다 (`update.rs` 머리 주석).
#[tauri::command]
fn apply_update(app: tauri::AppHandle) -> Result<(), String> {
    let root = backend::root();
    if let Some(state) = app.try_state::<backend::Backend>() {
        state.kill();
    }
    update::apply(&root).map_err(|e| format!("갈아 끼우지 못했습니다: {e}"))?;
    /* ★데우기는 **여기 없다** — 「설치 중」 단계 안에서 백엔드가 한다 (`backend/update.py`
       의 `warm`). 처음에는 여기서 했는데, 그러면 「다시 켜기」를 누른 뒤 12초가 조용히 흘러
       **누른 것이 안 먹은 것처럼** 보였다 (사용자 지적 2026-08-27). 이 자리는 즉시여야 한다. */
    /* ★★**띄우기 전에 자물쇠를 놓는다** (2026-08-27에 잡았다). 안 놓으면 새로 뜬 앱이
         「이 폴더의 PeroPix 가 이미 실행 중」으로 보고 **곧바로 스스로 닫는다** — 업데이트가
         끝나면 앱이 사라지는 셈이다. `app.exit(0)` 은 아래에서 부르므로, 그때까지 우리는
         아직 살아 있다.
       ★놓는 것은 자물쇠뿐이다 — 창·백엔드는 그대로 두고 순서만 앞당긴다. */
    if let Some(l) = app.try_state::<InstanceLock>() {
        if let Ok(mut g) = l.0.lock() {
            g.take();
        }
    }
    update::relaunch(&root).map_err(|e| format!("다시 켜지 못했습니다: {e}"))?;
    app.exit(0);
    Ok(())
}

/// **백엔드만 다시 띄운다** — 플러그인을 설치·삭제·업데이트·켜고 끈 뒤 붙이려고 (사용자 지시 2026-09-08).
/// 화면은 이어서 `location.reload()` 로 새로 읽는다 (확장 JS·캔버스는 페이지가 뜰 때 붙는다).
/// ★앱 프로세스를 통째로 다시 띄우지 않는다 — 개발 중(`tauri dev`)에는 exe 가 나가는 순간 `tauri dev` 가 Vite 를
///   내려서, 새로 뜬 exe 가 `localhost:1420` 연결 거부 화면을 봤다 (사용자 보고 2026-09-08). 포트·열쇠는 `OnceLock`
///   이라 그대로이므로 화면은 같은 주소로 다시 붙는다.
#[tauri::command]
fn restart_backend(app: tauri::AppHandle) -> Result<(), String> {
    let state = app.try_state::<backend::Backend>().ok_or("백엔드 상태가 없습니다")?;
    state.kill();
    let child = backend::spawn().map_err(|e| format!("백엔드를 다시 띄우지 못했습니다: {e}"))?;
    backend::log_line(&format!("[backend] respawned on port {}", backend::backend_port()));
    if let Ok(mut g) = state.0.lock() {
        *g = Some(child);
    }
    Ok(())
}

/// **그냥 다시 켠다** — 앱 전체를. `apply_update` 의
/// 뒷부분과 같은 차례(사이드카 내림 → 자물쇠 놓음 → 새 판 띄움 → 나감)인데 갈아 끼우는 것이 없다.
/// ★`update::relaunch` 를 쓰지 않는다 — 그쪽은 뿌리의 `PeroPix.exe` 를 띄우는데, 개발 중(`tauri dev`)에는
///   exe 가 `target/debug/` 에 있어 뿌리에 없다. **지금 도는 그 exe** 를 그대로 띄운다.
#[tauri::command]
fn restart_app(app: tauri::AppHandle) -> Result<(), String> {
    let root = backend::root();
    if let Some(state) = app.try_state::<backend::Backend>() {
        state.kill();
    }
    if let Some(l) = app.try_state::<InstanceLock>() {
        if let Ok(mut g) = l.0.lock() {
            g.take();
        }
    }
    let exe = std::env::current_exe().map_err(|e| format!("실행 파일을 못 찾았습니다: {e}"))?;
    let mut cmd = std::process::Command::new(exe);
    cmd.current_dir(&root);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const DETACHED_PROCESS: u32 = 0x0000_0008;
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
        cmd.creation_flags(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP);
    }
    cmd.spawn().map_err(|e| format!("다시 켜지 못했습니다: {e}"))?;
    app.exit(0);
    Ok(())
}

/// 같은 폴더를 두 번 열지 못하게 잡아 둔 표식 — **놓을 수 있게** 들고 있는다.
/// ★업데이트가 새 판을 띄우기 직전에 놓는다 (`apply_update` 의 ★★주).
struct InstanceLock(std::sync::Mutex<Option<std::fs::File>>);

/// 웹뷰(WebView2)의 저장소를 **앱 폴더 안**으로 끌어온다 (사용자 지적 2026-08-26).
///
/// ★★기본 자리는 `%LOCALAPPDATA%\<앱 식별자>\EBWebView` 이고, 그 이름이 **설치 경로가 아니라
///   앱 식별자**라 포터블 두 벌이 **같은 저장소를 함께 쓴다.** 거기 든 것이 가볍지 않다 —
///   생성 파라미터(`store/gen`)·검열 설정(`store/censor`)·엔진 선택(`store/cli`)·언어가
///   전부 localStorage 다. 한쪽에서 모델을 바꾸면 다른 쪽도 바뀐다.
/// ★자리를 옮기면 **앱을 지웠을 때 밖에 아무것도 안 남는다** — 포터블의 본뜻에 맞다.
/// ★WebView2 로더가 읽는 환경변수로 지정한다. **웹뷰가 만들어지기 전에** 놓아야 한다.
fn use_local_webview_profile() {
    /* ★웹뷰 저장소도 **앱 것**이라 `app/` 안이다 (2026-08-27 배치 정리).
       ★★옛 자리(`webview/`)에 있던 것은 **옮겨 온다** — 거기에 localStorage 가 들어 있어
         그냥 새 자리를 쓰면 생성 옵션·검열 설정·언어가 처음으로 되돌아간다. */
    let root = backend::root();
    let dir = backend::inner(&root).join("webview");
    let legacy = root.join("webview");
    if legacy.is_dir() && !dir.exists() {
        let _ = std::fs::create_dir_all(dir.parent().unwrap_or(&root));
        let _ = std::fs::rename(&legacy, &dir);
    }
    if std::fs::create_dir_all(&dir).is_err() {
        return; // 못 만들면 기본 자리로 둔다 — 저장소 때문에 앱이 안 뜨면 안 된다
    }
    migrate_webview_profile(&dir);
    std::env::set_var("WEBVIEW2_USER_DATA_FOLDER", &dir);
}

/// 옛 자리(`%LOCALAPPDATA%`)의 설정을 **한 번만** 옮겨 온다.
///
/// ★자리를 옮기는 순간 그동안 쓰던 설정이 초기화된 것처럼 보이는데, 사용자에게는 아무 일도
///   안 일어난 것처럼 보여야 한다.
/// ★**설정만** 데려온다 (`Local Storage`·`IndexedDB`). 캐시·쿠키는 다시 만들어지는 것이라
///   옮길 이유가 없고, 통째로 복사하면 수백 MB 가 든다.
/// ★실패해도 조용히 넘어간다 — 못 옮기면 설정이 기본값으로 시작할 뿐이다.
fn migrate_webview_profile(dir: &Path) {
    if dir.join("EBWebView").exists() {
        return; // 이미 이 자리에서 돌고 있다
    }
    let Some(local) = std::env::var_os("LOCALAPPDATA").map(PathBuf::from) else {
        return;
    };
    let old = local.join("com.peropix.app").join("EBWebView").join("Default");
    if !old.exists() {
        return;
    }
    let to = dir.join("EBWebView").join("Default");
    for name in ["Local Storage", "IndexedDB"] {
        let _ = copy_tree(&old.join(name), &to.join(name));
    }
    println!("[webview] 옛 저장소에서 설정을 옮겨 왔습니다: {}", old.display());
}

fn copy_tree(from: &Path, to: &Path) -> std::io::Result<()> {
    if !from.exists() {
        return Ok(());
    }
    std::fs::create_dir_all(to)?;
    for e in std::fs::read_dir(from)? {
        let e = e?;
        let (src, dst) = (e.path(), to.join(e.file_name()));
        if e.file_type()?.is_dir() {
            copy_tree(&src, &dst)?;
        } else {
            std::fs::copy(&src, &dst)?;
        }
    }
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    /* ★★**같은 폴더를 두 번 열지 않는다** (사용자 지시 2026-08-26). 같은 `workspaces/` 를
         두 창이 만지면 나중에 저장하는 쪽이 상대의 편집을 덮는다. 다른 폴더의 두 벌은
         그대로 허용한다 — 포터블은 그러라고 있는 형식이다 (`backend::lock_app_dir` 의 ★주). */
    let _ = START.set(Instant::now());
    let Some(lock) = backend::lock_app_dir() else {
        eprintln!("[app] 이 폴더의 PeroPix 가 이미 실행 중입니다 — 창을 안 띄웁니다");
        return;
    };
    /* ★자물쇠는 앱이 끝날 때까지 들고 있어야 한다 (핸들을 닫으면 풀린다).
       ★★**놓을 수 있게 들고 있는다** (2026-08-27). 업데이트가 새 판을 띄울 때, 옛
         프로세스가 이 자물쇠를 쥔 채로 띄우면 **새로 뜬 쪽이 곧바로 죽는다** — 같은 폴더를
         두 번 여는 것으로 보이기 때문이다. `apply_update` 가 띄우기 직전에 여기서 놓는다. */
    let lock = std::sync::Mutex::new(Some(lock));
    // ★웹뷰가 만들어지기 전에 저장소 자리를 정한다 (아래 ★주)
    use_local_webview_profile();
    // ★지난 업데이트가 남긴 옛 파일을 치운다 — 그때는 우리가 그 exe 위에서 돌고 있었다
    update::sweep(&backend::root());

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![backend_url, app_root, update_staged, apply_update, restart_app, restart_backend, uptime_ms, drag_restore])
        .setup(move |app| {
            // ★`apply_update` 가 새 판을 띄우기 전에 자물쇠를 놓을 수 있게 맡겨 둔다
            app.manage(InstanceLock(lock));
            /* ★★**웹뷰 바탕을 어둡게 깔아 둔다** (사용자 지적 2026-08-27: *"처음에 흰 화면이
                 한참 뜨다가"*). `index.html` 이 첫 페인트부터 스플래시를 그리지만, 그보다
                 **앞선 순간** — 창은 떴고 웹뷰가 아직 문서를 안 받은 때 — 에는 웹뷰의 기본
                 바탕인 **흰색**이 그대로 보인다. 그 한 겹을 여기서 덮는다.
               ★색은 `styles/tokens.css` 의 어두운 `--bg`(#16161a)다. 밝은 테마를 쓰는 사람에게는
                 잠깐 어두웠다 밝아지는데, **흰 번쩍임보다 눈에 덜 거슬린다** (어두운 쪽이
                 기본이고 대부분 그걸 쓴다).
               ★설정 파일로는 못 준다 — `tauri.conf.json` 의 창 스키마에 그 열쇠가 없다. */
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.set_background_color(Some(tauri::window::Color(0x16, 0x16, 0x1a, 0xff)));
            }
            match backend::spawn() {
                Ok(child) => {
                    app.manage(backend::Backend(Mutex::new(Some(child))));
                    backend::log_line(&format!("[backend] spawned on port {}", backend::backend_port()));
                }
                Err(e) => {
                    // 백엔드가 안 떠도 창은 띄운다 — 프론트가 상태를 표시하고 로그를 안내한다.
                    backend::log_line(&format!("[backend] spawn failed: {e}"));
                    app.manage(backend::Backend(Mutex::new(None)));
                }
            }
            /* ★★Tauri 가 깔아 둔 크기 조절 덧창을 걷는다 — 커서·누름·더블클릭의 주인을
               화면의 손잡이 하나로 (사용자 지적 2026-08-28). 까닭은 `window_edge.rs` 머리에.
               ★사이드카를 띄운 뒤에 한다 — 로그 파일이 그때 열린다. */
            #[cfg(windows)]
            if let Some(w) = app.get_webview_window("main") {
                match w.hwnd() {
                    Ok(h) => {
                        let gone = window_edge::drop_tauri_resize_overlay(h.0 as isize as *mut core::ffi::c_void);
                        backend::log_line(&format!("[edge] Tauri 크기 조절 덧창 걷기 = {}", if gone { "걷음" } else { "없었음" }));
                    }
                    Err(e) => backend::log_line(&format!("[edge] 창 손잡이를 못 얻었다: {e}")),
                }
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    // ★사이드카는 종료 이벤트에서 명시적으로 내린다.
    //   Drop 에만 맡기면 강제 종료·process::exit 경로에서 실행되지 않아
    //   백엔드가 고아로 남는다 (v2.x 에서 "브라우저를 닫아도 서버가 남던" 문제와 같은 부류).
    app.run(|app_handle, event| match event {
        RunEvent::ExitRequested { .. } | RunEvent::Exit => {
            if let Some(state) = app_handle.try_state::<backend::Backend>() {
                state.kill();
            }
        }
        _ => {}
    });
}
