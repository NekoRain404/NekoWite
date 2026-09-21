//! The live-buffer seam: this process asking a window what a note holds *right now*.
//!
//! `fs/read_text_file` is described by ACP as access to "unsaved editor state" and Zed
//! answers it from the open buffer (`project.open_buffer`, `acp_thread.rs:4595`); we answered
//! it from `std::fs::read_to_string` (`storage/file_store.rs`). That divergence is a silent
//! one — an agent re-reading a note the user is mid-edit in receives older, saved text and
//! proposes a change against a version they have already moved past — and it is the reason
//! this module exists. `fs_capability`'s module header states the divergence; this is the
//! direction that closes it.
//!
//! **It is not ACP, and it cannot be borrowed from ACP.** The SDK's connection has exactly two
//! participants and a client's only peer is the agent (`agent-client-protocol-2.1.0/src/
//! concepts/peers.rs:31-32`), so there is no reverse request from the client into its own UI
//! anywhere in the protocol, the schema or the SDK. What this needs is in-process IPC between
//! Rust and a webview — Tauri's own surface — and the SDK's contribution is only the shape of
//! the question the host must eventually answer.
//!
//! **The value type is shared and is not duplicated here.** [`LiveNote`] carries the same
//! three facts the window's `AgentLiveNote` carries (`src/features/agent/services/
//! agent-context-snapshot.ts`): the buffer's text, whether it is dirty, and the document-
//! INSTANCE revision that `agent-edit-apply.ts` and `agent-svg-insertion.ts` both judge
//! staleness against. There is one lookup behind both consumers — the window's tab store —
//! and this port is the second *end* of it, not a second implementation.
//!
//! **The deadline is over our own memory, and that is why it is not the deadline
//! `permissions.rs` refuses.** `PermissionRefusal::Expired` argues that a host-side deadline
//! would be "a policy nothing measured" over *another party's* work — a human deciding, an
//! engine thinking — neither of which has an upper bound. [`LIVE_NOTE_BOUND`] bounds this
//! process answering a question about a `Map` it already holds, behind one in-process IPC hop.
//! A lookup that has not come back is not slow, it is broken. What the bound prevents is
//! concrete: `runs::dispatch_fs` serves file requests one at a time, so a read that never
//! resolves parks the loop and every later read *and write* on that runtime is never
//! answered, for as long as the rail lives.
//!
//! **What expiry may not become is disk.** [`LiveNoteAnswer::NotHeld`] is the only arm a
//! caller may serve from the file, and it is the only arm that was *asked for*: a window said
//! no tab holds this path. `Unknown` — no window registered, a window that went away, a window
//! that says it cannot answer yet, the deadline, two windows disagreeing — is an error the
//! model can act on. A stale read that silently succeeds is indistinguishable from a correct
//! one, which is the failure class this whole area keeps producing.
//!
//! **How the tree is laid out.** This file was 873 lines and is now the module's own doc and the
//! names a caller outside it may use. `docs/dev.md:286` asks for the number of reasons a file
//! changes rather than its length, and this file had three subjects beside its tests: what a note,
//! a question and an answer *are* (`vocabulary`), the rules for a question in flight (`table`), and
//! the port a window is reached through (`port`).

mod port;
mod table;
mod vocabulary;

#[cfg(test)]
mod tests;

// Every name re-exported below was defined in this file before the split, and the paths callers use
// did not move with the code: `agent_runtime/mod.rs` re-exports most of them, and `fs_capability`,
// `registry`, `session` and the test targets reach the rest through this module. `unused_imports`
// does not report them in the library build, where `live_notes` is public, but
// `tests/agent_recovery_test.rs` and `tests/agent_settings_ipc_test.rs` `#[path]`-include this tree
// whole and reach only what `fs_capability`'s read arm names — `LiveNoteAnswer` and `LiveNotes` — so
// everything else is reported as unused there. Allowing the re-exports rather than dropping them
// keeps every pre-split path resolving and leaves those targets' lints where they were, which is the
// trade `agent_runtime::process` and `agent_runtime::capabilities` record for their own.
#[allow(unused_imports)]
pub use port::{LiveNoteWindows, LiveNotes};
#[allow(unused_imports)]
pub use table::{LiveNoteTable, LIVE_NOTE_BOUND};
#[allow(unused_imports)]
pub use vocabulary::{
    LiveNote, LiveNoteAnswer, LiveNoteAnswerPayload, LiveNoteQuestion, LiveNoteRefusal,
    LiveNoteReply, LIVE_NOTE_ANSWER_CHANNEL, LIVE_NOTE_ATTACH_CHANNEL, LIVE_NOTE_REQUEST_CHANNEL,
};
