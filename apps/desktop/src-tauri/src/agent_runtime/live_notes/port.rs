//! The seam as the read path uses it: the port a window is reached through, and the one value that
//! holds it together with the table it asks.
//!
//! **Why it is a file of its own.** It was the last piece of `live_notes.rs`, which passed the
//! 600-line budget `docs/dev.md:286` puts on a business source file, and the criterion that section
//! states is the number of reasons a file changes rather than its length. This module moves when the
//! port's shape moves — an operation a window is asked for, or whether the asking half and the
//! answering half are one value or two — while `super::vocabulary` moves when the wire does and
//! `super::table` moves when this host's rules for a question do.
//!
//! The trait is declared here and implemented outside, which is what keeps `agent_runtime` from
//! learning about Tauri; [`LiveNotes`] is that port beside the table the read path asks through.

use std::sync::Arc;

use super::table::LiveNoteTable;
use super::vocabulary::{LiveNoteAnswer, LiveNoteQuestion};

/// How a question reaches the windows, and how many of them can answer it.
///
/// The runtime declares the port and whoever owns the IPC surface implements it, the same way
/// [`super::super::fs_capability::VaultFiles`] is declared here and implemented by `storage`. It
/// exists as a trait so a test can hand in a window that answers, and so `agent_runtime` does
/// not learn about Tauri.
pub trait LiveNoteWindows: Send + Sync + 'static {
    /// Ask every window that can speak for the question's vault. `0` means none can, and the
    /// caller must not wait: waiting for a listener that does not exist is the only thing that
    /// can turn a missing capability into a ten-second stall on the serialized fs loop.
    fn ask(&self, question: &LiveNoteQuestion) -> usize;
}

/// The seam as the read path uses it: the questions this host has asked, and the windows that
/// answer them.
///
/// One value rather than two parameters because the two ends are one mechanism — a table that
/// could be asked without a way to reach a window, or a window port with no table behind it,
/// would be a shape nothing in this app can be in.
#[derive(Clone)]
pub struct LiveNotes {
    table: Arc<LiveNoteTable>,
    windows: Arc<dyn LiveNoteWindows>,
}

impl LiveNotes {
    pub fn new(table: Arc<LiveNoteTable>, windows: Arc<dyn LiveNoteWindows>) -> Self {
        Self { table, windows }
    }

    /// The table the answer path completes requests through. Handed out so the IPC surface can
    /// deliver a window's answer without owning the question side.
    pub fn table(&self) -> Arc<LiveNoteTable> {
        Arc::clone(&self.table)
    }

    /// What `path` holds in `vault_id`, as the window holding it says.
    pub async fn ask(&self, vault_id: &str, path: &str) -> LiveNoteAnswer {
        self.table.ask(self.windows.as_ref(), vault_id, path).await
    }
}
