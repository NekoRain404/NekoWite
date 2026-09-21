//! R2's missing half — the host's tasks, as a pet window can finally read them.
//!
//! D4 delivered the projection and D12 reported the hole this file is about: `desktop_pet_tasks`
//! had no state behind it, so a window's subscription died on its first read and a pet that could
//! not see any work looked exactly like a pet with none. `PetTaskFeed` is that state, and these
//! cases are the ones that matter about it:
//!
//! - **A window reads the list**, in the shape D1 froze, after the facts a real host applies —
//!   an instance installed, a turn started, a permission raised, an answer given, a turn ended.
//! - **A push happens when, and only when, the list changed.** A replayed frame, a foreign
//!   instance's frame, a kind that says nothing about a task and a fact about a run that already
//!   ended are all answers the window already has; pushing for one of them would have it apply the
//!   same fact twice.
//! - **The record survives a push nobody heard.** The whole point of the ordering in `task_feed`:
//!   the projection is written first and the emit is best-effort, so the read is the truth. This
//!   is the reference rule `SessionArchiveStore.swift:51` states from the other end — what is
//!   durable is recorded before what is not — and the case below is what makes it an assertion
//!   rather than a comment.
//!
//! The frames are the host's own envelopes, constructed here field by field: the feed never
//! touches an engine, so a case builds exactly the frame it is about, including the ones a
//! well-behaved runtime would not send.

// The cases are divided by behaviour domain rather than kept in one file (§13.1's rule for a test
// that outgrows a page): `pushes` for the list a window reads and the frames that are news,
// `notices` for the ledger the app reaches through the notification policy, and `ledger_store` for
// the file the ledger reaches and the restart that reads it back. They are one target and one
// command — `cargo test --test desktop_pet_task_feed_test` — because a test in a file nobody runs is
// not evidence.
//
// `#[path]` rather than a bare `mod`, for the reason `desktop_pet_ipc_test.rs` records: this file is
// the crate root of the target, so a plain `mod support;` resolves against `tests/` and would look
// for `tests/support.rs` — which is not there, and a file put there would be discovered by cargo as
// a target of its own. The directory holds behaviour, not targets, and there is deliberately no
// `main.rs` in it.
#[path = "desktop_pet_task_feed_test/ledger_store.rs"]
mod ledger_store;
#[path = "desktop_pet_task_feed_test/notices.rs"]
mod notices;
#[path = "desktop_pet_task_feed_test/pushes.rs"]
mod pushes;
#[path = "desktop_pet_task_feed_test/support.rs"]
mod support;
