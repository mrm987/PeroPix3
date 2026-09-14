//! 창 크기·자리를 기억한다 — 껐다 켜도 **마지막에 맞춰 둔 그대로**.
//!
//! ★★**왜 앱 폴더에 두나**: 이 앱은 포터블이다 (풀어 놓은 폴더가 곧 인스턴스, `backend::root`).
//!   `%APPDATA%` 에 두면 포터블 두 벌이 같은 창 상태를 나눠 쓰고, 새로 푼 사본이 남의 상태를
//!   물고 뜬다. `data/window.json` 에 두면 폴더를 통째로 옮겨도 그 폴더의 것만 따라간다.
//! ★★**물리 픽셀로 적는다.** 화면 배율이 다른 모니터로 옮겨 다니면 논리 좌표는 같은 값이
//!   다른 자리를 가리킨다. 읽을 때도 그대로 물리 좌표로 되돌린다.
//! ★적는 쪽은 화면이다 (`WindowFrame` 의 크기 사건 · 300ms 뒤 한 번). 여기서 다시 듣지
//!   않는 까닭은 **판정이 이미 거기 있기 때문**이다 — 두 곳에서 들으면 디바운스도 두 벌이 된다.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

/// 화면이 넘겨주고 파일에 그대로 적히는 것. 최대화는 크기와 따로 기억한다 —
/// 최대화를 풀었을 때 돌아갈 크기가 있어야 하기 때문이다.
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct WinState {
    pub x: i32,
    pub y: i32,
    pub w: u32,
    pub h: u32,
    #[serde(default)]
    pub maximized: bool,
}

fn path(root: &Path) -> PathBuf {
    root.join("data").join("window.json")
}

pub fn load(root: &Path) -> Option<WinState> {
    let raw = std::fs::read_to_string(path(root)).ok()?;
    let s: WinState = serde_json::from_str(&raw).ok()?;
    // ★말이 안 되는 값은 없는 셈 친다 — 설정 파일은 사람이 열어 고칠 수 있다
    if s.w < 200 || s.h < 100 {
        return None;
    }
    Some(s)
}

pub fn save(root: &Path, s: &WinState) -> std::io::Result<()> {
    let p = path(root);
    if let Some(d) = p.parent() {
        std::fs::create_dir_all(d)?;
    }
    let tmp = p.with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_string_pretty(s).unwrap_or_default())?;
    std::fs::rename(&tmp, &p) // ★다 쓴 뒤에 이름을 준다 — 반쯤 쓰인 파일을 읽지 않게
}

/// 적어 둔 자리가 **지금 화면 안에** 있나. 모니터를 뽑거나 배치를 바꾸면 옛 자리가
/// 화면 밖이 되는데, 그대로 띄우면 창을 찾을 수 없다.
///
/// ★판정은 **겹치는가**다 (완전히 들어가는가가 아니다) — 조금 걸쳐 둔 창을 억지로 옮기지 않는다.
/// ★제목줄이 잡히도록 **위쪽 40px 이 보이는지**까지 본다. 아래로 벗어난 창은 끌어 올릴 데가 없다.
pub fn on_screen<R: tauri::Runtime>(w: &tauri::WebviewWindow<R>, s: &WinState) -> bool {
    let Ok(monitors) = w.available_monitors() else {
        return true; // 못 물어보면 그대로 쓴다 — 안 띄우는 것보다 낫다
    };
    monitors.iter().any(|m| {
        let p = m.position();
        let sz = m.size();
        let (l, t) = (p.x, p.y);
        let (r, b) = (p.x + sz.width as i32, p.y + sz.height as i32);
        let head = s.y + 40;
        s.x + (s.w as i32) > l && s.x < r && head > t && head < b
    })
}
