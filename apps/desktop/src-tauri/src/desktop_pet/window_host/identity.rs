//! What a pet window *is*: the label it is minted with, the page it loads, and the window the
//! windowing system says made a call.
//!
//! Split out of `window_host.rs` when that file passed the line budget `docs/dev.md:286` puts on a
//! business source file, and it changes for one reason: §7.1's identity policy — 「前端不能自选任意
//! label」, a label is never reused, and a caller is whoever the windowing system says called. Every
//! operation on the host is gated on that policy, which is why it is a type here rather than a check
//! at each call site: [`PetWindowLabel`]'s field is private and there is no public constructor, so
//! "validate the label" is not a line a later edit can quietly drop.
//!
//! **A capability file reads the same policy from the other side.** `capabilities/desktop-pet.json`
//! selects a window by the glob `pet-*`, so [`LABEL_PREFIX`] is what hands a pet window the pet's
//! nine commands and two `core:event` permissions *instead of* `capabilities/default.json`, which
//! governs the main window. A label that matched neither would be a window with no IPC at all, and
//! one that matched `main` would be given the editor's whole surface — which is why the prefix lives
//! here, beside the only type that may compose a label out of it, rather than at a call site.

use serde::Serialize;

use super::super::ball::BALL_LABEL;

/// The label prefix every pet window carries. Upstream's `is_pet_window` (`:42-43`) matched
/// `"pet"` and `"pet-"`; one string here so that "is this ours" has one answer.
const LABEL_PREFIX: &str = "pet";

/// The page the pet's windows load. `apps/desktop/desktop-pet.html` is the lightweight entry
/// (§9); its second Vite entry is the integrator's wiring point, so this names the built page.
pub const DESKTOP_PET_PAGE: &str = "desktop-pet.html";

/// A window label this host minted.
///
/// The inner string is private and there is no public constructor, which is the whole of §7.1's
/// 「前端不能自选任意 label」: a front end that could build one of these could name the main
/// window, and a check on a string is something a later edit can drop without the type changing.
/// Everything the host does with a label, it first made itself.
#[derive(Clone, PartialEq, Eq, Debug, Serialize)]
#[serde(transparent)]
pub struct PetWindowLabel(String);

impl PetWindowLabel {
    /// The next character window's label. `pub(super)` rather than private because the counter that
    /// feeds it lives on `PetWindowHost` in the parent module — the one caller — while the string
    /// itself is still composed only here, by the type that owns the prefix and the page beside it.
    pub(super) fn mint(generation: u32) -> Self {
        Self(format!("{LABEL_PREFIX}-{generation}"))
    }

    /// The ball's label, and the one label here that is not minted from a generation.
    ///
    /// Still built here and nowhere else: the point of the private field is that a label is the
    /// host's to make, and a fixed name is no exception — `ball.rs` holds the label, but it is
    /// handed one rather than making one. A generation could not collide with it — `mint` formats a
    /// number, this is a word — so a character window can never inherit it.
    pub(super) fn ball() -> Self {
        Self(BALL_LABEL.to_string())
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// The window that issued an IPC call, as the windowing system reported it.
///
/// `from_window_label` is the only constructor, and its only intended caller is the
/// `#[tauri::command]` shim (T4's/integrator's file), which Tauri hands a `WebviewWindow` and
/// which reads `label()` off that. A value from a request body never reaches this type, which is
/// the difference between a caller that is identified and one that names itself.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct CallerWindow(String);

impl CallerWindow {
    pub fn from_window_label(label: impl Into<String>) -> Self {
        Self(label.into())
    }

    pub fn label(&self) -> &str {
        &self.0
    }
}
