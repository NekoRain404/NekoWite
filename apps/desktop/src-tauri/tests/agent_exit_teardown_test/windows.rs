//! Windows, through `xdotool`: what a process owns, where it is, and which of them is the app's
//! own main window.
//!
//! `only_visible` is `map_state == IsViewable`, which is the honest reading of "on screen" on a server
//! with no window manager, and the right one for the identity below: a window that is created but not
//! mapped is not one a click can land on. The main window is identified by its declared size and
//! nothing else — the pet's windows are titled `NekoWite` too, and no X property carries Tauri's window
//! label.

use std::path::Path;
use std::process::Command;

// ---------------------------------------------------------------------------
// Windows, through `xdotool`
// ---------------------------------------------------------------------------

/// One window an app process owns, as the X server has it.
#[derive(Clone, Copy, Debug)]
pub struct Win {
    pub id: u64,
    pub x: i64,
    pub y: i64,
    pub width: i64,
    pub height: i64,
}
/// Every window `xdotool` says this process owns, with its geometry.
///
/// `only_visible` is `map_state == IsViewable` — the honest reading of "on screen" on a server with
/// no window manager, and the right one for the identity below: a window that has been created but
/// not mapped yet is not one a click can land on.
pub fn windows_of(xdotool: &Path, display: &str, pid: u32, only_visible: bool) -> Vec<Win> {
    let mut search = vec!["search".to_string()];
    if only_visible {
        // `--onlyvisible` is a `search` option, not a global one: written before the subcommand,
        // xdotool refuses it and an error read as "no windows" would be this test lying to itself.
        search.push("--onlyvisible".to_string());
    }
    search.push("--pid".to_string());
    search.push(pid.to_string());
    let listed = match Command::new(xdotool)
        .env("DISPLAY", display)
        .args(&search)
        .output()
    {
        Ok(output) => output,
        Err(_) => return Vec::new(),
    };
    let ids = String::from_utf8_lossy(&listed.stdout);
    ids.split_whitespace()
        .filter_map(|id| {
            let geometry = Command::new(xdotool)
                .env("DISPLAY", display)
                .args(["getwindowgeometry", "--shell", id])
                .output()
                .ok()?;
            let text = String::from_utf8_lossy(&geometry.stdout).to_string();
            let field = |name: &str| {
                text.lines()
                    .find_map(|line| line.strip_prefix(name)?.parse::<i64>().ok())
            };
            Some(Win {
                id: id.parse().ok()?,
                x: field("X=")?,
                y: field("Y=")?,
                width: field("WIDTH=")?,
                height: field("HEIGHT=")?,
            })
        })
        .collect()
}

/// The app's main window, if it is on screen: the declared size is the whole of its identity here.
///
/// Not the title — the pet windows are titled `NekoWite` too (`desktop_pet/window_host/surfaces.rs`),
/// and not the label, which no X property carries. The size is the one thing the config gives this
/// window and no other, and the caller asserts the measured size against the config before it aims
/// a click at it.
pub fn main_window_on_screen(
    xdotool: &Path,
    display: &str,
    pid: u32,
    size: (i64, i64),
) -> Option<Win> {
    windows_of(xdotool, display, pid, true)
        .into_iter()
        .find(|win| (win.width, win.height) == size)
}
