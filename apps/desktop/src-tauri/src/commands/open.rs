//! The launch state the window asks about.
//!
//! One command, and it is a PULL. A file the OS named on the command line is
//! resolved and left in managed state by [`crate::open_file::handle_launch`],
//! and the window collects it here when it is ready to act on it — at the end of
//! its startup, once the vault and the previous session are in place. The
//! `open-file-request` event is only a nudge to ask again, because a first
//! launch's argument is known before there is a window to ring.

use crate::open_file::{OpenFileRequest, PendingOpen};

/// Take the file this process was asked to open, if one is still waiting.
///
/// Taking empties the slot, so the startup pull and the doorbell can both ask
/// without racing: whoever asks first gets it, and no request is carried out
/// twice.
#[tauri::command]
pub fn take_pending_open(state: tauri::State<'_, PendingOpen>) -> Option<OpenFileRequest> {
    state.take()
}
