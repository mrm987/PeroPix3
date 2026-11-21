//! 쌓아 둔 새 판을 **제자리에 놓고 다시 켠다** (사용자 지시 2026-08-26).
//!
//! ★★받는 것은 백엔드가 한다 (`backend/update.py`) — 여기 오는 순간 `.update/new/` 에는
//!   **앱 폴더와 같은 배치**로 새 파일이 놓여 있다. 그래서 이 코드는 무엇을 지킬지를
//!   따로 셈하지 않는다: **거기 없는 것은 안 건드리므로** `workspaces/`·`data/`·`gallery/`·
//!   `webview/` 는 손대지 않고 그대로 남는다.
//!
//! ★★**돌고 있는 exe 는 지울 수 없지만 이름은 바꿀 수 있다** — 윈도우의 오래된 성질이고,
//!   자기 자신을 갈아 끼우는 프로그램이 전부 쓰는 방법이다. 그래서 「지우고 쓰기」가 아니라
//!   **「비켜 놓고 놓기」**다: 옛것을 `.update/old/` 로 옮기고 새것을 제자리에 놓는다.
//!   옛것은 다음에 켤 때 지운다 (`sweep`) — 지금은 아직 우리가 그 위에서 돌고 있다.
//!
//! ★파이썬(사이드카)을 **먼저 내린다.** 안 그러면 `python/` 안의 파일이 잡혀 있어 못 옮긴다.

use std::path::{Path, PathBuf};

pub const STAGE: &str = ".update";

fn stage_dir(root: &Path) -> PathBuf {
    root.join(STAGE)
}

/// 갈아 끼우기를 시작했다는 표식. `apply` 가 옮기기 전에 세우고 다 옮긴 뒤에 지운다.
const APPLYING: &str = "applying";

/// 지난 갈아 끼우기가 **중간에 끊겼나** (표식이 남아 있고 옮길 것도 남았다).
///
/// ★★끊긴 채로 두면 앱이 안 뜬다 (사용자 제보 2026-11-21). 3.7.12 에서 전체 업데이트를 받다 앱이 꺼진 뒤로
///   `app/python` 에서 Pillow 의 `ImageFilter` 가 빠진 채 남아, 백엔드가 켤 때마다 import 에서 죽었다.
///   예전에는 다음 실행의 `sweep` 이 비켜 놓은 옛것(`old/`)마저 지웠다. 백엔드가 안 뜨니 앱 안에서 다시 받을 수도 없다.
///   그래서 껍데기가 켤 때 이것을 보고 마저 옮긴다 (`lib.rs` 의 `resume_update`).
pub fn interrupted(root: &Path) -> bool {
    stage_dir(root).join(APPLYING).exists() && staged(root)
}

/// 지난번 업데이트가 남긴 옛 파일을 치운다. **켤 때 한 번**, 조용히.
///
/// ★그때는 못 지웠다 — 우리가 그 exe 위에서 돌고 있었기 때문이다. 지금은 새것으로 떠 있다.
/// ★실패해도 아무 말 안 한다. 다음에 또 해 보면 된다 (남아 있어도 앱은 멀쩡히 돈다).
/// ★갈아 끼우기가 끊긴 채면 아무것도 안 치운다. 마저 옮기는 것이 먼저다 (`interrupted`).
pub fn sweep(root: &Path) {
    if interrupted(root) {
        return;
    }
    let _ = std::fs::remove_file(stage_dir(root).join(APPLYING));
    let _ = std::fs::remove_dir_all(stage_dir(root).join("old"));
    // 받아 둔 것을 다 옮겼으면 빈 껍데기만 남는다 — 비어 있을 때만 지운다
    let _ = std::fs::remove_dir(stage_dir(root).join("new"));
    let _ = std::fs::remove_dir(stage_dir(root));
}

/// 쌓아 둔 것이 있나 — 화면이 「지금 다시 켜기」를 낼지 정하는 근거.
pub fn staged(root: &Path) -> bool {
    stage_dir(root)
        .join("new")
        .read_dir()
        .map(|mut d| d.next().is_some())
        .unwrap_or(false)
}

#[cfg(not(target_os = "macos"))]
/// `.update/new/` 의 것들을 제자리로 옮긴다.
///
/// ★한 항목이라도 실패하면 **거기서 멈춘다.** 이미 옮긴 것은 그대로 두고, 표식(`APPLYING`)이
///   남아 다음에 켤 때 남은 것을 마저 옮긴다 (`interrupted`). 이 함수를 다시 부르면 그 일이 된다:
///   옮긴 것은 `new/` 에서 빠졌으므로 남은 것만 돈다. (전체 되돌리기는 흉내 내지 않는다. 그 코드가 더 위험하다.)
pub fn apply(root: &Path) -> std::io::Result<()> {
    let stage = stage_dir(root);
    let new = stage.join("new");
    let old = stage.join("old");
    std::fs::create_dir_all(&old)?;
    std::fs::write(stage.join(APPLYING), b"")?;
    move_tree(&new, root, &old)?;
    // ★표식은 다 옮긴 직후에 지운다. 빈 폴더가 남아 `new/` 를 못 지워도 끊긴 것으로 보지 않게
    let _ = std::fs::remove_file(stage.join(APPLYING));
    let _ = std::fs::remove_dir_all(&new);
    Ok(())
}

#[cfg(not(target_os = "macos"))]
/// 새 파일을 제자리에 **겹쳐 놓는다** — 폴더는 통째로 바꾸지 않고 **안으로 들어간다.**
///
/// ★★**폴더를 통째로 옮기면 패치가 앱을 부순다** (2026-08-27 배치 정리). 새 배치에서는
///   앱 것이 `app/` 안에 모여 있는데(`backend`·`python`·`models`·`webview`), 패치에는
///   `app/backend` 와 `app/version.json` 만 들어 있다. 맨 위 항목을 통째로 옮기던 예전
///   방식이면 `app/` 이 **패치에 든 두 개짜리로 바뀌면서 `app/python` 이 사라진다** —
///   앱이 아예 안 뜬다. 그래서 **파일 단위로** 내려간다.
/// ★옛것은 여전히 `old/` 로 비켜 놓는다 (지우지 않는다). 돌고 있는 exe 도 이름은 바뀐다.
/// ★한 개라도 실패하면 거기서 멈춘다 — 되돌리기를 흉내 내지 않는다 (위 ★주).
fn move_tree(from: &Path, to: &Path, park: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(to)?;
    for e in std::fs::read_dir(from)? {
        let e = e?;
        let name = e.file_name();
        let target = to.join(&name);
        if e.file_type()?.is_dir() {
            move_tree(&e.path(), &target, &park.join(&name))?;
            continue;
        }
        if target.exists() {
            std::fs::create_dir_all(park)?;
            let spot = park.join(&name);
            let _ = std::fs::remove_dir_all(&spot);
            let _ = std::fs::remove_file(&spot);
            // ★★**이름 바꾸기**다 (복사가 아니다) — 돌고 있는 exe 도 이건 된다
            std::fs::rename(&target, &spot)?;
            // ★★옛것을 비켜 놓은 뒤 새것을 못 놓으면 **그 파일이 빈다** (사용자 제보 2026-11-21:
            //   `app/python` 의 파일 한 장이 빠져 앱이 아예 안 떴다). 옛것을 도로 놓고 멈춘다.
            //   다른 프로그램이 새 파일을 쥐고 있으면 여기서 실패한다.
            if let Err(err) = std::fs::rename(e.path(), &target) {
                let _ = std::fs::rename(&spot, &target);
                return Err(err);
            }
            continue;
        }
        std::fs::rename(e.path(), &target)?;
    }
    Ok(())
}

#[cfg(not(target_os = "macos"))]
/// 새 exe 를 띄운다. ★부모가 죽어도 살아 있어야 하므로 **잡에 매달지 않는다**
/// (사이드카와 정반대다 — 그쪽은 함께 죽어야 하고 이쪽은 살아남아야 한다).
pub fn relaunch(root: &Path) -> std::io::Result<()> {
    // ★★**이름을 박지 않는다** — 꾸러미에 담기는 이름은 `PeroPix.exe` 이고 빌드가 내는
    //   이름은 `peropix.exe` 다 (`scripts/portable.ps1` 이 바꿔 담는다). 지금 돌고 있는
    //   그 이름을 그대로 쓰면 어느 쪽이든 맞는다. (윈도우는 대소문자를 안 가리지만,
    //   이름이 또 바뀔 자리라 여기서 못 박지 않는다.)
    let name = std::env::current_exe()
        .ok()
        .and_then(|p| p.file_name().map(|n| n.to_os_string()))
        .unwrap_or_else(|| "PeroPix.exe".into());
    let exe = root.join(name);
    let mut cmd = std::process::Command::new(exe);
    cmd.current_dir(root);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const DETACHED_PROCESS: u32 = 0x0000_0008;
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
        cmd.creation_flags(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP);
    }
    cmd.spawn().map(|_| ())
}


// ── 맥 ─────────────────────────────────────────────────────────────
//
// ★★맥은 `.app` 을 **통째로** 바꾼다 (사용자 결정 2026-10-22: 안정성 우선, 전체 zip 만 받는다).
//   서명이 `.app` 안의 파일 전부를 묶고 있어서, 윈도우처럼 몇 개만 겹쳐 놓으면 봉인이 깨진다.
//   돌고 있는 앱도 이름은 바꿀 수 있다 — 옛 `.app` 을 `.update/old/` 로 비켜 놓고 새것을 그 자리에 놓는다.
// ★윈도우와 달리 **실패하면 되돌린다.** 옮기는 것이 둘뿐이라 되돌리기가 단순하고, 안 되돌리면
//   응용 프로그램 폴더에서 앱이 사라진다.

#[cfg(target_os = "macos")]
const BUNDLE: &str = "PeroPix.app";

#[cfg(target_os = "macos")]
fn other(msg: &str) -> std::io::Error {
    std::io::Error::new(std::io::ErrorKind::Other, msg.to_string())
}

/// 지금 도는 `.app` — 실행 파일(`…/PeroPix.app/Contents/MacOS/peropix`)에서 세 단계 위
#[cfg(target_os = "macos")]
fn running_bundle() -> std::io::Result<PathBuf> {
    let exe = std::env::current_exe()?;
    exe.parent()
        .and_then(Path::parent)
        .and_then(Path::parent)
        .filter(|p| p.extension().is_some_and(|e| e == "app"))
        .map(Path::to_path_buf)
        .ok_or_else(|| other("앱 꾸러미(.app) 안에서 돌고 있지 않습니다"))
}

/// 바꿀 수 있는가 — ★**백엔드를 내리기 전에** 본다 (`lib.rs` 의 `apply_update`). 내린 뒤에 막히면 앱이 백엔드 없이 남는다
#[cfg(target_os = "macos")]
pub fn ready(root: &Path) -> std::io::Result<()> {
    check_at(root, &running_bundle()?)
}

#[cfg(target_os = "macos")]
pub fn apply(root: &Path) -> std::io::Result<()> {
    apply_to(root, &running_bundle()?)
}

#[cfg(target_os = "macos")]
fn check_at(root: &Path, app: &Path) -> std::io::Result<()> {
    use std::os::unix::ffi::OsStrExt;
    // ★맥이 앱을 옮겨 실행 중이면(App Translocation) 지금 자리는 읽기 전용 사본이고 원래 자리는 알 수 없다
    if app.to_string_lossy().contains("/AppTranslocation/") {
        return Err(other("앱을 응용 프로그램 폴더로 옮긴 뒤 다시 켜서 업데이트해 주세요"));
    }
    if !stage_dir(root).join("new").join(BUNDLE).join("Contents").join("MacOS").is_dir() {
        return Err(other("받아 둔 새 버전에 PeroPix.app 이 없습니다"));
    }
    // ★앱이 든 폴더에 쓸 수 있어야 바꿔 놓는다 (관리자가 아닌 계정의 응용 프로그램 폴더)
    let parent = app.parent().ok_or_else(|| other("앱이 든 폴더를 모릅니다"))?;
    let c = std::ffi::CString::new(parent.as_os_str().as_bytes()).map_err(|_| other("앱 자리가 이상합니다"))?;
    if unsafe { libc::access(c.as_ptr(), libc::W_OK) } != 0 {
        return Err(other("앱이 든 폴더에 쓸 수 없습니다. 새 버전을 받아 직접 바꿔 주세요"));
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn apply_to(root: &Path, app: &Path) -> std::io::Result<()> {
    check_at(root, app)?;
    let new = stage_dir(root).join("new").join(BUNDLE);
    let park = stage_dir(root).join("old").join(BUNDLE);
    std::fs::create_dir_all(park.parent().unwrap_or(root))?;
    let _ = std::fs::remove_dir_all(&park);
    move_dir(app, &park)?;
    if let Err(e) = move_dir(&new, app) {
        let _ = move_dir(&park, app); // ★되돌린다 (위 ★주)
        return Err(e);
    }
    let _ = std::fs::remove_dir_all(stage_dir(root).join("new"));
    Ok(())
}

/// 이름 바꾸기로 옮긴다. ★다른 디스크면(외장 디스크에 둔 앱) 이름 바꾸기가 안 되므로 `ditto` 로 베끼고 지운다
#[cfg(target_os = "macos")]
fn move_dir(from: &Path, to: &Path) -> std::io::Result<()> {
    match std::fs::rename(from, to) {
        Err(e) if e.raw_os_error() == Some(libc::EXDEV) => {
            if !std::process::Command::new("/usr/bin/ditto").arg(from).arg(to).status()?.success() {
                let _ = std::fs::remove_dir_all(to);
                return Err(other("다른 디스크로 옮기지 못했습니다"));
            }
            std::fs::remove_dir_all(from)
        }
        r => r,
    }
}

/// 바꿔 놓은 `.app` 을 새로 띄운다. ★`open -n` — 지금 것이 아직 살아 있어도 새 것을 하나 더 띄운다
#[cfg(target_os = "macos")]
pub fn relaunch(_root: &Path) -> std::io::Result<()> {
    let app = running_bundle()?;
    std::process::Command::new("/usr/bin/open").arg("-n").arg(&app).spawn().map(|_| ())
}

#[cfg(all(test, target_os = "macos"))]
mod mac_tests {
    use super::{apply_to, stage_dir, BUNDLE};
    use std::path::{Path, PathBuf};

    fn put(p: &Path, body: &str) {
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, body).unwrap();
    }

    /// 데이터 자리와 응용 프로그램 폴더의 `.app` 하나
    fn setup(name: &str, apps: &str) -> (PathBuf, PathBuf, PathBuf) {
        let base = std::env::temp_dir().join(format!("peropix-macapply-{name}"));
        let _ = std::fs::remove_dir_all(&base);
        let root = base.join("data");
        let app = base.join(apps).join(BUNDLE);
        put(&app.join("Contents/MacOS/peropix"), "옛");
        put(&root.join("workspaces/내작업/spec.json"), "사용자 것");
        (base, root, app)
    }

    #[test]
    fn 앱을_통째로_바꾼다() {
        let (base, root, app) = setup("swap", "Applications");
        put(&stage_dir(&root).join("new").join(BUNDLE).join("Contents/MacOS/peropix"), "새");
        apply_to(&root, &app).unwrap();
        assert_eq!(std::fs::read_to_string(app.join("Contents/MacOS/peropix")).unwrap(), "새");
        assert_eq!(
            std::fs::read_to_string(stage_dir(&root).join("old").join(BUNDLE).join("Contents/MacOS/peropix")).unwrap(),
            "옛",
            "옛것은 지우지 않고 비켜 놓는다 (다음에 켤 때 `sweep` 이 치운다)"
        );
        assert_eq!(std::fs::read_to_string(root.join("workspaces/내작업/spec.json")).unwrap(), "사용자 것");
        assert!(!stage_dir(&root).join("new").exists());
        let _ = std::fs::remove_dir_all(base);
    }

    #[test]
    fn 새_판이_없으면_그대로다() {
        let (base, root, app) = setup("none", "Applications");
        assert!(apply_to(&root, &app).is_err());
        assert_eq!(std::fs::read_to_string(app.join("Contents/MacOS/peropix")).unwrap(), "옛");
        let _ = std::fs::remove_dir_all(base);
    }

    #[test]
    fn 옮겨_실행_중이면_안_바꾼다() {
        let (base, root, app) = setup("transloc", "AppTranslocation/X1");
        put(&stage_dir(&root).join("new").join(BUNDLE).join("Contents/MacOS/peropix"), "새");
        assert!(apply_to(&root, &app).is_err());
        assert_eq!(std::fs::read_to_string(app.join("Contents/MacOS/peropix")).unwrap(), "옛");
        let _ = std::fs::remove_dir_all(base);
    }
}

#[cfg(all(test, not(target_os = "macos")))]
mod apply_tests {
    use super::{apply, interrupted, stage_dir, sweep};
    use std::path::{Path, PathBuf};

    fn put(p: &Path, body: &str) {
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, body).unwrap();
    }

    /// 앱 하나를 만든다 — 새 배치(`app/` 안에 앱 것, 바깥에 사용자 것)
    fn app(name: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!("peropix-apply-{name}"));
        let _ = std::fs::remove_dir_all(&root);
        put(&root.join("PeroPix.exe"), "옛 exe");
        put(&root.join("app/version.json"), "{\"version\":\"1\"}");
        put(&root.join("app/backend/server.py"), "옛 서버");
        put(&root.join("app/python/python.exe"), "파이썬");
        put(&root.join("app/models/censor.onnx"), "모델");
        put(&root.join("workspaces/내작업/spec.json"), "사용자 것");
        root
    }

    /// ★★**패치는 `app/` 을 통째로 갈아치우면 안 된다.** 예전 방식이면 여기서
    ///   `app/python` 이 사라지고 앱이 아예 안 뜬다 — 이 판정이 그것을 잡는다.
    #[test]
    fn 패치는_형제를_안_건드린다() {
        let root = app("patch");
        let new = stage_dir(&root).join("new");
        put(&new.join("PeroPix.exe"), "새 exe");
        put(&new.join("app/version.json"), "{\"version\":\"2\"}");
        put(&new.join("app/backend/server.py"), "새 서버");

        apply(&root).unwrap();

        assert!(root.join("app/python/python.exe").exists(), "파이썬이 사라지면 안 된다");
        assert!(root.join("app/models/censor.onnx").exists(), "모델도 그대로여야 한다");
        assert_eq!(std::fs::read_to_string(root.join("PeroPix.exe")).unwrap(), "새 exe");
        assert_eq!(std::fs::read_to_string(root.join("app/backend/server.py")).unwrap(), "새 서버");
        assert_eq!(std::fs::read_to_string(root.join("app/version.json")).unwrap(), "{\"version\":\"2\"}");
        let _ = std::fs::remove_dir_all(root);
    }

    /// 전체 판도 같은 길로 간다 — 파이썬까지 새것으로 덮인다
    #[test]
    fn 전체는_다_덮는다() {
        let root = app("full");
        let new = stage_dir(&root).join("new");
        put(&new.join("PeroPix.exe"), "새 exe");
        put(&new.join("app/version.json"), "{\"version\":\"2\"}");
        put(&new.join("app/backend/server.py"), "새 서버");
        put(&new.join("app/python/python.exe"), "새 파이썬");
        put(&new.join("app/models/censor.onnx"), "새 모델");

        apply(&root).unwrap();

        assert_eq!(std::fs::read_to_string(root.join("app/python/python.exe")).unwrap(), "새 파이썬");
        let _ = std::fs::remove_dir_all(root);
    }

    /// ★★**사용자 것은 어느 경우에도 안 건드린다** — 새 판에 없는 것은 그대로 남는다
    #[test]
    fn 사용자_폴더는_그대로다() {
        let root = app("user");
        let new = stage_dir(&root).join("new");
        put(&new.join("PeroPix.exe"), "새 exe");
        apply(&root).unwrap();
        assert_eq!(
            std::fs::read_to_string(root.join("workspaces/내작업/spec.json")).unwrap(),
            "사용자 것"
        );
        let _ = std::fs::remove_dir_all(root);
    }

    /// 새 파일 하나를 다른 프로그램이 쥐고 있는 것처럼 잠근다 (공유 없이 연다). 쥐고 있는 동안은 옮길 수 없다
    #[cfg(windows)]
    fn hold(p: &Path) -> std::fs::File {
        use std::os::windows::fs::OpenOptionsExt;
        std::fs::OpenOptions::new().read(true).share_mode(0).open(p).unwrap()
    }

    /// ★★옛것을 비켜 놓은 뒤 새것을 못 놓으면 **그 파일이 비면 안 된다** (사용자 제보 2026-11-21:
    ///   `app/python` 에서 파일 한 장이 빠져 백엔드가 켤 때마다 죽었다). 옛것이 제자리에 남아야 한다.
    #[cfg(windows)]
    #[test]
    fn 새것을_못_놓으면_옛것이_제자리에_남는다() {
        let root = app("hold");
        let new = stage_dir(&root).join("new");
        put(&new.join("app/python/python.exe"), "새 파이썬");
        let held = hold(&new.join("app/python/python.exe"));

        assert!(apply(&root).is_err(), "쥐고 있는 파일은 못 옮긴다");
        assert_eq!(
            std::fs::read_to_string(root.join("app/python/python.exe")).unwrap(),
            "파이썬",
            "옛것이 제자리에 있어야 한다"
        );
        drop(held);
        let _ = std::fs::remove_dir_all(root);
    }

    /// ★★끊긴 업데이트는 **다음에 켤 때 마저 옮긴다** (`interrupted` → `apply` 다시). 그 전에 `sweep` 이 아무것도 안 치운다.
    #[cfg(windows)]
    #[test]
    fn 끊긴_업데이트는_다음에_켤_때_마저_한다() {
        let root = app("resume");
        let new = stage_dir(&root).join("new");
        put(&new.join("PeroPix.exe"), "새 exe");
        put(&new.join("app/backend/server.py"), "새 서버");
        put(&new.join("app/python/python.exe"), "새 파이썬");
        let held = hold(&new.join("app/python/python.exe"));
        assert!(apply(&root).is_err());
        drop(held);

        assert!(interrupted(&root), "표식이 남아야 한다");
        sweep(&root);
        assert!(new.join("app/python/python.exe").exists(), "끊긴 동안 sweep 이 남은 새 파일을 지우면 안 된다");
        assert!(interrupted(&root), "sweep 이 표식을 지우면 다음 실행이 마저 옮기지 못한다");

        apply(&root).unwrap();
        assert!(!interrupted(&root));
        assert_eq!(std::fs::read_to_string(root.join("PeroPix.exe")).unwrap(), "새 exe");
        assert_eq!(std::fs::read_to_string(root.join("app/backend/server.py")).unwrap(), "새 서버");
        assert_eq!(std::fs::read_to_string(root.join("app/python/python.exe")).unwrap(), "새 파이썬");

        sweep(&root);
        assert!(!stage_dir(&root).exists(), "다 끝났으면 sweep 이 .update 를 치운다");
        let _ = std::fs::remove_dir_all(root);
    }

    /// 받아만 두고 아직 안 바꾼 판은 끊긴 것이 아니다 (켤 때 저절로 깔리면 안 된다. 「지금 다시 켜기」를 기다린다)
    #[test]
    fn 받아만_둔_판은_끊긴_것이_아니다() {
        let root = app("staged");
        put(&stage_dir(&root).join("new/app/backend/server.py"), "새 서버");
        assert!(!interrupted(&root));
        let _ = std::fs::remove_dir_all(root);
    }

    /// 옛것은 지우지 않고 비켜 놓는다 (다음에 켤 때 `sweep` 이 치운다)
    #[test]
    fn 옛것은_비켜_놓는다() {
        let root = app("park");
        let new = stage_dir(&root).join("new");
        put(&new.join("app/backend/server.py"), "새 서버");
        apply(&root).unwrap();
        assert_eq!(
            std::fs::read_to_string(stage_dir(&root).join("old/app/backend/server.py")).unwrap(),
            "옛 서버"
        );
        let _ = std::fs::remove_dir_all(root);
    }
}
