//! WebView2 의 하위 프로세스가 죽었을 때 (`ProcessFailed`).
//!
//! ★제보 (2026-11-12): 작업 도중 메인 창과 앱 밖 창이 함께 창 바탕색(#16161a)만 남고 비었다.
//!   렌더러가 죽으면 WebView2 는 아무것도 그리지 않은 채로 두고, 다시 띄우는 것은 앱 몫이다.
//! ★종류·이유·종료 코드를 로그에 남기고, 렌더러가 죽은 것이면 화면을 다시 불러온다.
//!   다시 불러오면 메인이 남은 앱 밖 창을 치우고 다시 연다 (`floatWin.ts` 의 부팅 정리).
//! ★GPU 프로세스는 WebView2 가 스스로 다시 띄우므로 적기만 한다.
//! ★메인 창에만 단다. 앱 밖 창은 메인과 같은 렌더러에서 돌고 (`window.open` + 포털), GPU·브라우저
//!   프로세스는 모든 창이 함께 쓰므로 메인 하나에서 다 받는다.

use std::sync::Mutex;
use std::time::{Duration, Instant};

use webview2_com::Microsoft::Web::WebView2::Win32::*;
use webview2_com::{take_pwstr, ProcessFailedEventHandler};
use windows_core::{Interface, PWSTR};

use crate::backend::log_line;

/// 다시 불러오자마자 또 죽으면 되풀이하지 않는다
const RELOAD_GAP: Duration = Duration::from_secs(30);
static LAST_RELOAD: Mutex<Option<Instant>> = Mutex::new(None);

fn kind_name(k: COREWEBVIEW2_PROCESS_FAILED_KIND) -> &'static str {
    match k {
        COREWEBVIEW2_PROCESS_FAILED_KIND_BROWSER_PROCESS_EXITED => "browser",
        COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_EXITED => "render",
        COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_UNRESPONSIVE => "render-unresponsive",
        COREWEBVIEW2_PROCESS_FAILED_KIND_FRAME_RENDER_PROCESS_EXITED => "frame-render",
        COREWEBVIEW2_PROCESS_FAILED_KIND_UTILITY_PROCESS_EXITED => "utility",
        COREWEBVIEW2_PROCESS_FAILED_KIND_SANDBOX_HELPER_PROCESS_EXITED => "sandbox-helper",
        COREWEBVIEW2_PROCESS_FAILED_KIND_GPU_PROCESS_EXITED => "gpu",
        _ => "other",
    }
}

fn reason_name(r: COREWEBVIEW2_PROCESS_FAILED_REASON) -> &'static str {
    match r {
        COREWEBVIEW2_PROCESS_FAILED_REASON_UNEXPECTED => "unexpected",
        COREWEBVIEW2_PROCESS_FAILED_REASON_UNRESPONSIVE => "unresponsive",
        COREWEBVIEW2_PROCESS_FAILED_REASON_TERMINATED => "terminated",
        COREWEBVIEW2_PROCESS_FAILED_REASON_CRASHED => "crashed",
        COREWEBVIEW2_PROCESS_FAILED_REASON_LAUNCH_FAILED => "launch-failed",
        COREWEBVIEW2_PROCESS_FAILED_REASON_OUT_OF_MEMORY => "out-of-memory",
        COREWEBVIEW2_PROCESS_FAILED_REASON_PROFILE_DELETED => "profile-deleted",
        _ => "other",
    }
}

/// 다시 불러와도 되나 — 마지막으로 불러온 지 `RELOAD_GAP` 이 지났을 때만
fn may_reload() -> bool {
    let mut last = LAST_RELOAD.lock().unwrap_or_else(|e| e.into_inner());
    if last.is_some_and(|t| t.elapsed() < RELOAD_GAP) {
        return false;
    }
    *last = Some(Instant::now());
    true
}

pub fn watch(window: &tauri::WebviewWindow) {
    let done = window.with_webview(|wv| unsafe {
        let attach = || -> windows_core::Result<()> {
            let core = wv.controller().CoreWebView2()?;
            let mut token = 0i64;
            core.add_ProcessFailed(
                &ProcessFailedEventHandler::create(Box::new(|sender, args| {
                    let Some(args) = args else { return Ok(()) };
                    let mut kind = COREWEBVIEW2_PROCESS_FAILED_KIND::default();
                    args.ProcessFailedKind(&mut kind)?;
                    let mut line = format!("[webview] 프로세스가 죽었습니다: kind={}", kind_name(kind));
                    if let Ok(a2) = args.cast::<ICoreWebView2ProcessFailedEventArgs2>() {
                        let mut reason = COREWEBVIEW2_PROCESS_FAILED_REASON::default();
                        let mut code = 0i32;
                        let mut desc = PWSTR::null();
                        let _ = a2.Reason(&mut reason);
                        let _ = a2.ExitCode(&mut code);
                        let _ = a2.ProcessDescription(&mut desc);
                        line.push_str(&format!(" reason={} exit={code}", reason_name(reason)));
                        let desc = take_pwstr(desc);
                        if !desc.is_empty() {
                            line.push_str(&format!(" desc={desc}"));
                        }
                    }
                    if kind == COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_EXITED {
                        if !may_reload() {
                            line.push_str(" · 30초 안에 또 죽어 다시 불러오지 않습니다");
                        } else if let Some(core) = sender {
                            line.push_str(" · 화면을 다시 불러옵니다");
                            let _ = core.Reload();
                        }
                    }
                    log_line(&line);
                    Ok(())
                })),
                &mut token,
            )
        };
        if let Err(e) = attach() {
            log_line(&format!("[webview] ProcessFailed 를 못 달았습니다: {e}"));
        }
    });
    if let Err(e) = done {
        log_line(&format!("[webview] 웹뷰에 접근하지 못했습니다: {e}"));
    }
}
