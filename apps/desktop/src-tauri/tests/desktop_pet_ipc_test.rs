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
//! Module inclusion: `lib.rs` does not declare `desktop_pet` — registering it is the integrator's
//! serialized change — so the tree is declared here by path, the convention
//! `agent_permission_ipc_test.rs` and `agent_registry_test.rs` established, and this target
//! compiles exactly the source the library will build. The module list is `desktop_pet/mod.rs`'s
//! own list: a name that drifted would fail to compile here rather than silently test something
//! else.
//!
//! The cases are divided by behaviour domain rather than kept in one file (§13.1's rule for a test
//! that outgrows a page) — `windows` for which windows exist and what they were asked for,
//! `access` for who is allowed to ask and what a teardown may not reach, `capabilities` for §7.2,
//! and `support` for the window system that is not one. They are one target and one command:
//! `cargo test --test desktop_pet_ipc_test` runs every one of them, because a test in a file
//! nobody runs is not evidence.

#[path = "../src/desktop_pet"]
mod desktop_pet {
    pub mod linux_capabilities;
    pub mod window_host;
}

// `#[path]` rather than a bare `mod`, because this target's root is `tests/desktop_pet_ipc_test.rs`
// and a plain `mod access;` would resolve to `tests/access.rs` — a file that cargo would then
// discover as a *target of its own*, four of them, three of which do not compile alone. The
// directory holds behaviour, not targets, and there is deliberately no `main.rs` in it.
#[path = "desktop_pet_ipc_test/access.rs"]
mod access;
#[path = "desktop_pet_ipc_test/capabilities.rs"]
mod capabilities;
#[path = "desktop_pet_ipc_test/support.rs"]
mod support;
#[path = "desktop_pet_ipc_test/teardown.rs"]
mod teardown;
#[path = "desktop_pet_ipc_test/windows.rs"]
mod windows;
