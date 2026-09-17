//! R3 — the pet's settings: one versioned record per domain, a revision that refuses rather than
//! merges, atomic writes, migration, and the unknown-field policy.
//!
//! The plan's D6 row asks for five things by name (「schema/revision/原子失败/迁移/未知字段策略」), and
//! each has a file here because each fails a different way:
//!
//! - `values.rs` — the field rules: one predicate both directions read from, the schema's own
//!   defaults passing through it, the structured caps, and the UTF-16 line length that has to agree
//!   with `raw.length` on the other side.
//! - `record.rs` — the record rules: the four arms a read answers with and the four a write answers
//!   with, with the schema version and the revision deciding rather than a merge.
//! - `store.rs` — the file half: one file per domain, a replacement that keeps the mode it replaces
//!   and refuses a read-only destination, and a write race whose loser finds out and changes nothing.
//! - `switch.rs` — §5.1's 启用 as it actually happens: an applied `general` write opens the pet's
//!   window, and the switch going off closes every one of them without deleting anything.
//! - `motion.rs` — §5.2's 动效 as a pet window receives it: the policy the `general` record holds
//!   rides the appearance read, because a pet window may not read a settings domain for itself.
//! - `bubble.rs` — §5.2's 气泡与消息 the same way: the bubble's background alpha, which `message`
//!   stores and the window draws with, needs the same road into a window that cannot read it.
//! - `window_style.rs` — §5.2's 窗口行为 the same way again: `view.alwaysOnTop` is the one window
//!   flag that is a setting, and the windows are what have to follow it.
//! - `schema.rs` — the mirror itself, compared against `pet-contracts/config.ts` and
//!   `pet-settings-values.ts`, so a field or a rule added on one side alone fails a test.
//!
//! Module inclusion: `desktop_pet/mod.rs` declares `settings` — D12 registers the tree and this
//! task's line is part of adding to that shape — so this target uses the library's own module
//! rather than declaring the tree by path, the way `desktop_pet_ipc_test.rs` does after the same
//! change. What is *not* exercised here is the two commands' IPC boundary: they resolve the app's
//! data directory from a real `AppHandle`, and a test that built one would write into the
//! developer's own data directory. The switch's behaviour is tested against the same window-system
//! port the product uses ([`support::FakeSurfaces`]) instead, and the wiring that is therefore
//! unobserved — two lines in `lib.rs`'s handler list — is reported rather than asserted here.
//!
//! One target and one command: `cargo test --test desktop_pet_settings_test` runs all of them,
//! because a test in a file nobody runs is not evidence.

#[path = "desktop_pet_settings_test/bubble.rs"]
mod bubble;
#[path = "desktop_pet_settings_test/motion.rs"]
mod motion;
#[path = "desktop_pet_settings_test/record.rs"]
mod record;
#[path = "desktop_pet_settings_test/schema.rs"]
mod schema;
#[path = "desktop_pet_settings_test/store.rs"]
mod store;
#[path = "desktop_pet_settings_test/support.rs"]
mod support;
#[path = "desktop_pet_settings_test/switch.rs"]
mod switch;
#[path = "desktop_pet_settings_test/values.rs"]
mod values;
#[path = "desktop_pet_settings_test/window_style.rs"]
mod window_style;
