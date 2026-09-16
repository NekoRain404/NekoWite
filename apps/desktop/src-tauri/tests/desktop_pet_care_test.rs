//! R5 — the care ledger: paid once, on a local day, with nothing that can become a credential.
//!
//! The four acceptance clauses of D10 each name a way a local-progress system goes wrong, and each has
//! a file here because each is a different failure:
//!
//! - `replay.rs` — **幂等奖励**. The test is not that the code looks idempotent: it is that a replayed
//!   event leaves the ledger *equal* to a copy taken before the replay, revision included. A reward
//!   paid twice is the failure, and byte-for-byte equality is what rules it out.
//! - `days.rs` — **日期/时区**. A day is decided once, by the host, and stored; the ledger never
//!   converts an instant into a day, so the tests here are about the boundaries — midnight, a month
//!   end, a leap day — and about what a clock that moved backwards may and may not do to a streak.
//! - `local.rs` — **无 token**. Nothing here can reach a network, a credential or a file, and an
//!   unreported token count is never read as a zero (`token 未知不是 0`, §8). The first of those is not
//!   observable from outside, so the test reads this module's own source, the way
//!   `desktop_pet_ipc_test/teardown.rs` reads the window host's.
//! - `import.rs` — **导入回退**. An import may only raise. A file that is older, lower or unreadable
//!   must leave the user's progress exactly where it was and *say* what it kept, because §4's rule for
//!   the window host's teardown holds for an import too: a repair that normalises is unrecoverable for
//!   the user it was done to.
//!
//! Module inclusion: `desktop_pet/mod.rs` is D12's wiring point and does not declare `care_ledger`
//! yet, so the tree is declared here by path — the convention `desktop_pet_ipc_test.rs` and
//! `agent_registry_test.rs` established — and this target compiles exactly the source the library
//! will build. The `#[path]` on the submodules is not decoration: a plain `mod replay;` would resolve
//! to `tests/replay.rs`, which cargo would then discover as a target of its own.
//!
//! One target and one command: `cargo test --test desktop_pet_care_test` runs all of them, because a
//! test in a file nobody runs is not evidence.

#[path = "../src/desktop_pet"]
mod desktop_pet {
    pub mod care_ledger;
}

#[path = "desktop_pet_care_test/days.rs"]
mod days;
#[path = "desktop_pet_care_test/import.rs"]
mod import;
#[path = "desktop_pet_care_test/local.rs"]
mod local;
#[path = "desktop_pet_care_test/replay.rs"]
mod replay;
#[path = "desktop_pet_care_test/support.rs"]
mod support;
