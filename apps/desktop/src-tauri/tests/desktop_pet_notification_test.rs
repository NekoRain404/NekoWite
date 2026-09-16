//! R2 — the pet's notification ledger: what the user is told, and what they are deliberately not.
//!
//! The five things this target has to hold (§6.2, §6.3) are not five features; they are one decision
//! seen from five sides, and the two that matter most pull in opposite directions:
//!
//! - **完成 / 等待 / 失败.** The four run endings `run-finished` can carry are the protocol's
//!   (`end-turn`, `max-tokens`, `max-turn-requests`, `refusal`, plus `cancelled`) and the last three
//!   are *not* failures. `endings.rs` drives each of them through the policy and asserts what the
//!   notice says, because a notice that called a limit a crash, or a refusal an error, would tell
//!   the user something untrue about their own run.
//! - **去重 without 漏提示.** These are opposite failures, so a test for one is not a test for the
//!   other. `dedup.rs` asserts both directions: the same ending twice is announced once, and a
//!   different agent, vault, run or permission request is never folded into it.
//! - **勿扰, and the recovery it owes.** `quiet.rs` holds the choice this task made — a suppressed
//!   notice is *dropped as a notice and kept as an unread row*, never queued for the way back — and
//!   holds the other half of it, that nothing is replayed when do-not-disturb ends.
//! - **投递失败.** A notice that fails and reports success is worse than one that never fired, so
//!   `delivery.rs` asserts that the failure is a distinct outcome, that the row survives it, and
//!   that the ledger does not quietly try again (§6.3's at-most-once attempt).
//! - **恢复.** `history.rs` runs the ledger through `encode`/`decode` and back into a fresh policy,
//!   which is the restart §6.3 requires — and reads `pet-contracts/task.ts` and `config.ts` rather
//!   than a copy of either, so a vocabulary that drifted on the TypeScript side fails here.
//!
//! Module inclusion: `desktop_pet/mod.rs` is the integrator's file, so the tree is declared by path
//! here, the convention `desktop_pet_ipc_test.rs` established, and this target compiles exactly the
//! source the library will build. `#[path]` on the inline block makes its children resolve inside
//! `src/desktop_pet/` — the same file's directory, which is the trap worth naming: pointing this at
//! `desktop_pet/mod.rs` instead would send the children looking for `src/desktop_pet/desktop_pet/`.
//!
//! The cases are divided by behaviour rather than kept in one file (§13.1) — `endings`, `dedup`,
//! `quiet`, `delivery`, `history` — and they are one target and one command, because a test in a
//! file nobody runs is not evidence.

#[path = "../src/desktop_pet"]
mod desktop_pet {
    pub mod history;
    pub mod notification_delivery;
    pub mod notification_policy;
}

// `#[path]` rather than a bare `mod`, for the reason `desktop_pet_ipc_test.rs` gives: this target's
// root is `tests/desktop_pet_notification_test.rs`, so a plain `mod endings;` would resolve to
// `tests/endings.rs` — a file cargo would then discover as a target of its own, five of which do not
// compile alone. The directory holds behaviour, not targets, and there is deliberately no `main.rs`.
#[path = "desktop_pet_notification_test/dedup.rs"]
mod dedup;
#[path = "desktop_pet_notification_test/delivery.rs"]
mod delivery;
#[path = "desktop_pet_notification_test/endings.rs"]
mod endings;
#[path = "desktop_pet_notification_test/history.rs"]
mod history;
#[path = "desktop_pet_notification_test/quiet.rs"]
mod quiet;
#[path = "desktop_pet_notification_test/support.rs"]
mod support;
