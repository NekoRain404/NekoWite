//! R2's task half — the projection: three identity failures, and the §6.2 table that reads them.
//!
//! §6.1 makes the host the single source of truth for a task, and the cases here are the ones that
//! fail *quietly* when it is not: two engines that both call a session `ses_1`, an instance that
//! ends while its frames are still in a queue, and several runs in flight at once. Each has a test
//! that says how it fails rather than only that it holds, because "one task" and "two tasks that
//! look like one" are indistinguishable from the outside until the user clicks the wrong one.
//!
//! Nothing here reaches an engine. The projection's inputs are the runtime's own envelopes and the
//! host's own snapshots — both plain data, constructed in `support.rs` — so the cases that matter
//! most (a frame from a previous incarnation, a sequence replayed out of order) are the ones a real
//! engine would find hardest to produce on purpose.
//!
//! Module inclusion: `lib.rs` does not declare `desktop_pet` — registering it is the integrator's
//! serialized change — so the tree is declared here by path, the convention
//! `desktop_pet_ipc_test.rs` and `agent_registry_test.rs` established, and this target compiles
//! exactly the source the library will build. The module list is the names this task owns, not
//! `desktop_pet/mod.rs`'s whole list: the two other modules in that tree belong to D3 and are
//! compiled by their own target.
//!
//! `use nekowite_lib::agent_runtime` at the crate root is what lets `task_projection.rs` reach its
//! types while it is compiled outside the library: it is the same module either way, bound under
//! the path the source already names, so the file tested here is the file that ships and not a
//! copy with its imports rewritten.
//!
//! The cases are divided by behaviour domain rather than kept in one file (§13.1's rule for a test
//! that outgrows a page) — `identity` for what names a task, `epochs` for which incarnation may
//! write to one, `tasks` for several at once and how one ends, and `outcomes` for §6.2's table.
//! They are one target and one command: `cargo test --test desktop_pet_task_projection_test` runs
//! every one of them, because a test in a file nobody runs is not evidence.

use nekowite_lib::agent_runtime;

#[path = "../src/desktop_pet"]
mod desktop_pet {
    pub mod task_projection;
}

// `#[path]` rather than a bare `mod`, because this target's root is
// `tests/desktop_pet_task_projection_test.rs` and a plain `mod identity;` would resolve to
// `tests/identity.rs` — a file cargo would then discover as a *target of its own*, four of them,
// three of which do not compile alone. The directory holds behaviour, not targets, and there is
// deliberately no `main.rs` in it.
#[path = "desktop_pet_task_projection_test/epochs.rs"]
mod epochs;
#[path = "desktop_pet_task_projection_test/identity.rs"]
mod identity;
#[path = "desktop_pet_task_projection_test/outcomes.rs"]
mod outcomes;
#[path = "desktop_pet_task_projection_test/support.rs"]
mod support;
#[path = "desktop_pet_task_projection_test/tasks.rs"]
mod tasks;
