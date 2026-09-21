//! What a pet window is asked to be, and the stored preferences that answer it.
//!
//! Split out of `window_host.rs` when that file passed the line budget `docs/dev.md:286` puts on a
//! business source file. The subject is one round trip — §5.2's settings record in, a
//! [`WindowStyle`] out — so it changes when a row of §7.2's window presentation gains a preference
//! (the way 置顶 did, §5.2's 窗口行为) or when a record's field is renamed, neither of which is a
//! change to the rules about instances.
//!
//! **None of it is a claim that the request is honoured.** Whether a compositor applies any of the
//! seven flags is `linux_capabilities`' business, and today it answers `unverified` for all seven;
//! what is decided here is what the app *asks* for. The three readers are read once, at the two
//! moments a window's presentation can change — the launch and an applied write — because the host
//! holds the answer in between and a per-`open` file read would be a read per window for a value
//! that only ever moves through one.

use serde::Serialize;

use super::super::settings::{PetSettingsDomain, PetSettingsStore};
use super::geometry::CHARACTER_DEFAULT_SIZE;

/// What we ask a compositor for, as a value rather than as calls buried in an adapter.
///
/// Every field is a §7.2 row — 透明、无边框、置顶、不抢焦点 — and upstream set the same seven flags
/// at each of its four `WebviewWindowBuilder` sites (`:289-296`, `:358-370`, `:457-467`,
/// `:552-559`), which is how `spawn_extra_pet` and `sync_project_windows` came to differ in
/// nothing but their position. Keeping it a value means what the app requests is one thing, and
/// `TauriSurfaces` is the only place it becomes builder calls.
///
/// None of it is a claim that the request is honoured. Whether a compositor applies any of these
/// is `linux_capabilities`' business, and today it answers `unverified` for all seven.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowStyle {
    pub transparent: bool,
    pub decorations: bool,
    pub always_on_top: bool,
    pub skip_taskbar: bool,
    pub resizable: bool,
    pub shadow: bool,
    pub focused: bool,
}

/// Upstream's flags together (`:461-469`), once.
///
/// The *default* presentation: what a pet window is opened with until a stored preference says
/// otherwise, and what every flag but one stays for the life of the process. `always_on_top` is the
/// one that is also a setting (§5.2's 窗口行为, `view.alwaysOnTop`), so the host holds the value and
/// this constant is where it starts — a host with no readable record opens exactly what upstream
/// opened.
pub const PET_WINDOW_STYLE: WindowStyle = WindowStyle {
    transparent: true,
    decorations: false,
    always_on_top: true,
    skip_taskbar: true,
    resizable: false,
    shadow: false,
    focused: false,
};

/// Whether the pet's windows are kept above ordinary ones, as the `view` record holds it.
///
/// The one flag of [`PET_WINDOW_STYLE`] that is a stored preference (§5.2's 窗口行为), so this is
/// where a host that has a store asks what to open with. Read once, at the two moments a window can
/// appear — the launch (`feature_switch::restore`) and an applied `view` write
/// (`desktop_pet_surface::apply_window_style`) — because the host holds the answer in between and a
/// per-`open` file read would be a read per window for a value that only ever changes through one.
///
/// Every arm but a readable `false` answers `true`, which is what upstream asked for at all four of
/// its builder sites (`lib.rs:295,368,463,557`): an absent record is a fresh install, an unreadable
/// one is this build's defaults everywhere else, and §10.2's read-only arm is a record whose
/// *choice* this build cannot read — and taking a pet out of the top of the stack on a guess is the
/// direction that hides the pet the user asked for.
pub fn stored_always_on_top(store: &PetSettingsStore) -> bool {
    store
        .read(PetSettingsDomain::View)
        .record()
        .and_then(|record| {
            record
                .value("alwaysOnTop")
                .and_then(serde_json::Value::as_bool)
        })
        .unwrap_or(PET_WINDOW_STYLE.always_on_top)
}

/// The size the character window is built for, as the `character` record holds it (§5.1's 角色与动画).
///
/// The same shape as [`stored_always_on_top`] and for the same reason: it is a stored preference the
/// *window's own geometry* depends on, so the host has to be told it before it opens one, and the two
/// moments it can change are a launch and an applied write. Read once at each rather than per window:
/// a file read per `open` would be a read for a value that only changes through one command.
///
/// Every arm but a readable number answers [`CHARACTER_DEFAULT_SIZE`] — an absent record is a fresh
/// install, and an unreadable one is this build's defaults everywhere else, which is the reading
/// `settings::values` gives it too. §10.2's read-only arm is a record whose *choice* this build cannot
/// read, and the default is the direction that does not clip a sprite it cannot measure.
pub fn stored_character_size(store: &PetSettingsStore) -> f64 {
    store
        .read(PetSettingsDomain::Character)
        .record()
        .and_then(|record| record.value("size").and_then(serde_json::Value::as_f64))
        .unwrap_or(CHARACTER_DEFAULT_SIZE)
}

/// The floating ball's diameter, as the `general` record holds it (`general.ballSize`).
///
/// Beside [`stored_character_size`] rather than in `ball.rs`, because it is the same fact about the
/// same question — what size is a window built at — and because two of the three callers are here and
/// in `character_view` (the ball's page is told the same number through the appearance read, so that
/// one stored value sizes both the orb and the window around it).
///
/// Every arm but a readable number answers `ball::BALL_DEFAULT_SIZE`. The `general` domain is read
/// once for both of the ball's facts, and a read-only record — a newer build's — is the arm where a
/// choice exists and cannot be read: the schema's default is what this build's ball has always been.
///
/// The reading itself is `character_view::BallSize`'s, because the *page* needs the same number
/// through the appearance read and two readers of one field is how a window and an orb come to
/// disagree. What is here is the store half of it, beside the character's size for the same reason.
pub fn stored_ball_size(store: &PetSettingsStore) -> f64 {
    store
        .read(PetSettingsDomain::General)
        .record()
        .map_or(
            super::super::character_view::BallSize::DEFAULT,
            super::super::character_view::BallSize::of,
        )
        .value()
}
