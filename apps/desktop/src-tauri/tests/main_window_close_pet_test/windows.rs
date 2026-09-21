//! Windows, through `xdotool`: what a process owns, how big each one is, and which of them are on
//! screen.
//!
//! `only_visible` is `map_state == IsViewable` — the honest reading of "on screen" on a server with
//! no window manager — and the main window is identified by its declared size and nothing else: the
//! pet's windows are titled `NekoWite` too, and no X property carries Tauri's window label. `Win`
//! and these readings are `pub` because both the launch and the case read them.

use std::path::Path;
use std::process::Command;

// ---------------------------------------------------------------------------
// Windows, through `xdotool`
// ---------------------------------------------------------------------------

/// One window an app process owns, as the X server has it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
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
/// no window manager, and the one the pet's own windows are read with: a window that has been
/// created but not mapped is not a window the reader would have seen, and the question here is what
/// the reader sees.
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

/// The app's windows that are on screen. GTK keeps a 10x10 helper window of its own that the
/// unfiltered search finds and this one does not.
fn on_screen(xdotool: &Path, display: &str, pid: u32) -> Vec<Win> {
    windows_of(xdotool, display, pid, true)
}

/// The app's main window, if it is on screen: the declared size is the whole of its identity here.
///
/// Not the title — the pet windows are titled `NekoWite` too (`desktop_pet/window_host/surfaces.rs`),
/// and not the label, which no X property carries. The size is the one thing the config gives this
/// window and no pet window: the character window is built at `character.size` (260x320 at the
/// default 160) and the ball at `ballSize` plus its margins (80x80 at the default 56), and the
/// caller asserts the measured size against the config before it aims a click at it.
pub fn main_window_on_screen(
    xdotool: &Path,
    display: &str,
    pid: u32,
    size: (i64, i64),
) -> Option<Win> {
    on_screen(xdotool, display, pid)
        .into_iter()
        .find(|win| (win.width, win.height) == size)
}

/// The app's windows that are on screen and are **not** the main window — the pet's own.
///
/// Read by size, for the reason [`main_window_on_screen`] gives, and this is the whole measurement
/// this case is about: these are the windows in the wry runtime's map that a closed main window
/// would otherwise leave the process living for.
pub fn pet_windows_on_screen(
    xdotool: &Path,
    display: &str,
    pid: u32,
    size: (i64, i64),
) -> Vec<Win> {
    on_screen(xdotool, display, pid)
        .into_iter()
        .filter(|win| (win.width, win.height) != size)
        .collect()
}
