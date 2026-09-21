//! R1 — the pet's window host: one entry, a bounded teardown, and a caller that cannot name a
//! window.
//!
//! Three of the plan's requirements are the kind that fail silently, so each has a test that says
//! how it fails rather than only that it holds:
//!
//! - §7.1 「前端不能自选任意 label 去关闭主窗口」. The tests below do forge labels — they can, this
//!   is what a front end would send — and what they assert is that the host refuses them. The
//!   operation a window may invoke takes no window argument at all, so the forgery is refused
//!   because there is nothing to forge: identity comes from the window, and the only labels the
//!   host recognises are the ones it minted and has not closed.
//! - §7.1's teardown 「不取消后台 Agent 任务」 and §4's 「不删除已导入的角色与养成数据」. Asserting
//!   "nothing was cancelled" against a mock would be asserting about the mock, so what is checked
//!   is the shape: the report has no field that could describe a cancellation or a deletion, and
//!   no source file in the module can name an agent, a vault or a file. A future teardown that
//!   learned to erase would have to change the type, and this target with it.
//! - §7.2's 「不伪装已支持」. `window-climb` stays unavailable even when an observation claims it
//!   worked, which is the one arm an observation may not move.
//!
//! Module inclusion: `lib.rs` now declares `desktop_pet` (the integrator's D12 change), so this
//! target addresses the library's own module instead of compiling the tree itself by `#[path]`.
//! The `#[path]` form was what a test does while the file that registers a module belongs to
//! another task; with the registration landed, `crate::desktop_pet` below is the module the app
//! ships, and a name that drifted would fail to compile rather than test something else.
//!
//! The cases are divided by behaviour domain rather than kept in one file (§13.1's rule for a test
//! that outgrows a page) — `windows` for which windows exist and what they were asked for,
//! `access` for who is allowed to ask and what a teardown may not reach, `capabilities` for §7.2,
//! `commands` for the `#[tauri::command]` shims driven through Tauri's own IPC entry, and
//! `support` for the window system that is not one. They are one target and one command:
//! `cargo test --test desktop_pet_ipc_test` runs every one of them, because a test in a file
//! nobody runs is not evidence.

pub use nekowite_lib::desktop_pet;

// `#[path]` rather than a bare `mod`, because this target's root is `tests/desktop_pet_ipc_test.rs`
// and a plain `mod access;` would resolve to `tests/access.rs` — a file that cargo would then
// discover as a *target of its own*, six of them, five of which do not compile alone. The
// directory holds behaviour, not targets, and there is deliberately no `main.rs` in it.
#[path = "desktop_pet_ipc_test/access.rs"]
mod access;
#[path = "desktop_pet_ipc_test/capabilities.rs"]
mod capabilities;
#[path = "desktop_pet_ipc_test/commands.rs"]
mod commands;
#[path = "desktop_pet_ipc_test/support.rs"]
mod support;
#[path = "desktop_pet_ipc_test/teardown.rs"]
mod teardown;
#[path = "desktop_pet_ipc_test/windows.rs"]
mod windows;
// The two commands that join this window surface to the agent runtime: the task list a window
// reads, and the click that goes back to a session.
#[path = "desktop_pet_ipc_test/character_selection.rs"]
mod character_selection;
#[path = "desktop_pet_ipc_test/event_boundary.rs"]
mod event_boundary;
#[path = "desktop_pet_ipc_test/navigation.rs"]
mod navigation;
#[path = "desktop_pet_ipc_test/wiring.rs"]
mod wiring;
