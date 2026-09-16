//! R6 — the bundled engine and the update path, which is mostly a set of refusals.
//!
//! T14's acceptance is not "the update works". It is three refusals, and every test in this target
//! is one of them:
//!
//! 1. **无系统 CLI 可启动** — the engine is found beside this app, never on `PATH`, so a machine
//!    with no `opencode` installed still starts one.
//! 2. **坏摘要不执行** — a candidate whose digest does not match the app's own release record is
//!    never handed to anything that could run it, and never gets an execute bit.
//! 3. **迁移失败不破坏旧 profile** — a rollback that cannot complete leaves the profile it was about
//!    to replace exactly as it was, and never silently discards what the newer version wrote.
//!
//! The happy path matters too, but only as the thing the refusals are measured against: a gate that
//! refuses everything would pass every test above and ship a broken feature.
//!
//! The cases are divided by behaviour domain rather than kept in one file, because this target
//! outgrew a page (§13.1): `bundled` for which engine this app starts and where its files live,
//! `trust` for the record a download has to match, `gate` for what a candidate must prove before it
//! is installed, `switch` for moving the pointer — forward or back — and what neither direction may
//! discard, and `support` for the scratch world they share. They are one target and one command —
//! `cargo test --test agent_update_test` — because a test in a file nobody runs is not evidence.
//!
//! Every profile, download and release here is built under the repository's own `target/` directory
//! (plan §3.2: 开发测试的临时 profile 必须放仓库内的测试临时目录). Nothing in this target reads or writes
//! the developer's real OpenCode profile, real configuration or real credentials — including the one
//! test that runs the pinned artifact, whose `HOME`, XDG roots and `PATH` are a scratch directory.

// `#[path]` rather than a bare `mod`, matching `desktop_pet_ipc_test.rs` and
// `agent_settings_ipc_test.rs`: the entry file is the target, and the domains are named where they
// are declared rather than by a directory that a rename would silently empty.
#[path = "agent_update_test/bundled.rs"]
mod bundled;
#[path = "agent_update_test/gate.rs"]
mod gate;
#[path = "agent_update_test/support.rs"]
mod support;
#[path = "agent_update_test/switch.rs"]
mod switch;
#[path = "agent_update_test/trust.rs"]
mod trust;
