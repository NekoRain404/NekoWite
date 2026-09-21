//! The windowing system as a port, and the one real implementation of it.
//!
//! Split out of `window_host.rs` when that file passed the line budget `docs/dev.md:286` puts on a
//! business source file. It changes when the call *into* a window system changes — an operation the
//! host needs that the port does not have, or a Tauri API that moved — and never for a rule about
//! instances. That is what lets it be this thin: everything here is translation, and whether a call
//! happens at all is decided on the other side of the trait.
//!
//! The port exists so those rules can be tested against something that is not a compositor (§10.2),
//! which is what `tests/desktop_pet_ipc_test` is built on. [`TauriSurfaces`] is deliberately the only
//! place `tauri::WebviewWindowBuilder` is named, and it reads its flags out of a [`WindowStyle`]
//! value rather than writing them out twice, so the window the app asks for and the one a test
//! asserts about cannot drift apart.

use super::identity::PetWindowLabel;
use super::placement::{Placement, WorkArea};
use super::presentation::WindowStyle;

/// The windowing system, as much of it as the host uses.
///
/// A port rather than a set of calls, so the rules — the cap, the labels, who may close what —
/// can be tested against something that is not a compositor, and so {@link PetWindowHost} needs
/// no window to run. {@link TauriSurfaces} is the real one and is deliberately thin.
pub trait PetSurfaces: Send {
    /// Create one window: its identity, its page, where it goes, how big it is, what it is, and
    /// whether it starts on screen.
    ///
    /// The size is a parameter rather than something the adapter reads, because the pet has two
    /// surfaces of two sizes — a character window that follows `character.size` and a ball that
    /// follows `general.ballSize` — and an adapter that picked one of them itself would be the place
    /// the two could be swapped without a test noticing.
    fn open(
        &mut self,
        label: &PetWindowLabel,
        page: &str,
        at: Placement,
        size: (f64, f64),
        style: WindowStyle,
        visible: bool,
    ) -> Result<(), String>;

    fn close(&mut self, label: &PetWindowLabel) -> Result<(), String>;

    /// Give an existing window a new size, keeping its position.
    ///
    /// A separate call rather than a close-and-reopen, for the reason [`Self::set_always_on_top`] is
    /// one: the size setting is about the pet that is *on screen*, and reopening it would reload the
    /// page — the sprite, the bubble and the open menu — every time a slider moved. Three settings
    /// reach it: `character.size` for the character's window, and `general.ballSize` for the ball's.
    ///
    /// **The position is not this call's business.** The compositor keeps the window where it is and
    /// moves only the edges, which is what a user dragging the size slider expects — and for the ball
    /// it is also what keeps a position the user dragged it to. What a *new* window is placed at is
    /// [`super::PetWindowHost::open`]'s and [`super::super::ball::Ball::ensure`]'s, and those read
    /// the size.
    fn resize(&mut self, label: &PetWindowLabel, size: (f64, f64)) -> Result<(), String>;

    fn set_visible(&mut self, label: &PetWindowLabel, visible: bool) -> Result<(), String>;

    /// Put this window in the always-on-top stack, or take it out (§5.2's `view.alwaysOnTop`).
    ///
    /// A separate call rather than a re-open: the setting changes what an *existing* window is, and
    /// a surface that could only be asked at creation would make the checkbox a preference about the
    /// next pet rather than about the one on screen. What a compositor does with it is its own
    /// business, which is why §7.2's 「置顶」 row exists at all.
    fn set_always_on_top(&mut self, label: &PetWindowLabel, on_top: bool) -> Result<(), String>;

    /// §7.2's 鼠标穿透, system half: whether the compositor sends this window the clicks that
    /// land on it. Deliberately *not* the same claim as knowing which pixels of the sprite are
    /// opaque — that is the renderer's hit test, and §7.2 forbids presenting one as the other.
    fn set_click_through(&mut self, label: &PetWindowLabel, ignore: bool) -> Result<(), String>;

    /// The primary monitor's work area, logical px; `None` when it cannot be read.
    ///
    /// Returning an option rather than a size is §7.2's rule about substitution: upstream
    /// `unwrap_or((1920.0, 1080.0))`-ed an unreadable monitor (`:194`) and could therefore park
    /// the pet off-screen on exactly the display it failed to read.
    fn work_area(&self) -> Option<WorkArea>;
}

/// The real windowing system.
///
/// Everything left here is translation: §7.1's rules are in {@link PetWindowHost}, and what
/// remains is turning {@link PET_WINDOW_STYLE} and a {@link Placement} into builder calls. The
/// flags are read from the value rather than written twice, so the window the app asks for and
/// the one a test asserts about cannot drift apart.
pub struct TauriSurfaces {
    app: tauri::AppHandle,
}

impl TauriSurfaces {
    pub fn new(app: tauri::AppHandle) -> Self {
        Self { app }
    }

    fn window(&self, label: &PetWindowLabel) -> Result<tauri::WebviewWindow, String> {
        use tauri::Manager;
        self.app
            .get_webview_window(label.as_str())
            .ok_or_else(|| format!("no pet window labelled {}", label.as_str()))
    }
}

impl PetSurfaces for TauriSurfaces {
    fn open(
        &mut self,
        label: &PetWindowLabel,
        page: &str,
        at: Placement,
        size: (f64, f64),
        style: WindowStyle,
        visible: bool,
    ) -> Result<(), String> {
        use tauri::{WebviewUrl, WebviewWindowBuilder};
        let (width, height) = size;
        WebviewWindowBuilder::new(&self.app, label.as_str(), WebviewUrl::App(page.into()))
            .title("NekoWite")
            .inner_size(width, height)
            .position(at.x, at.y)
            .transparent(style.transparent)
            .decorations(style.decorations)
            .always_on_top(style.always_on_top)
            .skip_taskbar(style.skip_taskbar)
            .resizable(style.resizable)
            .shadow(style.shadow)
            .focused(style.focused)
            .visible(visible)
            .build()
            .map(|_| ())
            .map_err(|error| error.to_string())
    }

    fn close(&mut self, label: &PetWindowLabel) -> Result<(), String> {
        self.window(label)?
            .close()
            .map_err(|error| error.to_string())
    }

    fn resize(&mut self, label: &PetWindowLabel, size: (f64, f64)) -> Result<(), String> {
        use tauri::{LogicalSize, Size};
        // Logical and not physical, which is what the size the host computes is: `inner_size` at
        // creation takes the same unit, so a window opened at 260x320 and then resized to its own
        // size again is the same window on a HiDPI display as on a 1:1 one.
        self.window(label)?
            .set_size(Size::Logical(LogicalSize::new(size.0, size.1)))
            .map_err(|error| error.to_string())
    }

    fn set_visible(&mut self, label: &PetWindowLabel, visible: bool) -> Result<(), String> {
        let window = self.window(label)?;
        if visible {
            window.show()
        } else {
            window.hide()
        }
        .map_err(|error| error.to_string())
    }

    fn set_click_through(&mut self, label: &PetWindowLabel, ignore: bool) -> Result<(), String> {
        self.window(label)?
            .set_ignore_cursor_events(ignore)
            .map_err(|error| error.to_string())
    }

    fn set_always_on_top(&mut self, label: &PetWindowLabel, on_top: bool) -> Result<(), String> {
        // `tao` sends this to the windowing system as a keep-above request (`WindowRequest::
        // AlwaysOnTop` → `set_keep_above`), so on a session whose compositor ignores it this
        // succeeds and changes nothing — which is exactly the state §7.2's 「置顶」 row describes
        // and why the setting is offered only where that row has been verified.
        self.window(label)?
            .set_always_on_top(on_top)
            .map_err(|error| error.to_string())
    }

    fn work_area(&self) -> Option<WorkArea> {
        let monitor = self.app.primary_monitor().ok().flatten()?;
        let area = monitor.work_area();
        // A zero scale factor would divide by zero, and a monitor that reports one is a monitor
        // whose geometry cannot be used at all rather than one that is 1:1.
        let scale = monitor.scale_factor();
        if !(scale > 0.0) {
            return None;
        }
        Some(WorkArea {
            x: area.position.x as f64 / scale,
            y: area.position.y as f64 / scale,
            width: area.size.width as f64 / scale,
            height: area.size.height as f64 / scale,
        })
    }
}
