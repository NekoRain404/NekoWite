//! The AI request registry and the key vault: the two handles that hold a live request or a secret
//! rather than an engine, and the bounds that decide how many may stream.
//!
//! A module of its own because neither changes for any reason an engine start does: [`AiState`]
//! moves with the completion lifecycle — what makes an id cancellable, and what a cancel does to a
//! connection already open — and [`KeyVault`] with the master password and the stronghold snapshot
//! behind it. Nothing here knows a vault root, a program path or a profile.

use std::collections::{HashMap, HashSet};
use std::sync::atomic::AtomicUsize;
use std::sync::{Arc, Mutex};

use tauri_plugin_stronghold::stronghold::Stronghold;

// ---------------------------------------------------------------------------
// Key vault state
// ---------------------------------------------------------------------------

/// Managed stronghold handle, opened lazily on first use (or by
/// `set_master_password`, which swaps the inner snapshot after re-encryption).
pub struct KeyVault(pub Mutex<Option<Stronghold>>);

impl Default for KeyVault {
    fn default() -> Self {
        Self(Mutex::new(None))
    }
}

// ---------------------------------------------------------------------------
// AI state
// ---------------------------------------------------------------------------

/// Set of in-flight completion ids. `ai_cancel` removes an id, the stream
/// loop in `ai_complete` checks membership before each chunk and breaks when
/// the id is gone.
///
/// Also carries a bounded concurrency limiter: at most [`CONCURRENCY_LIMIT`]
/// completions stream at once, with [`MAX_PENDING`] more allowed to queue.
/// Beyond that a request is rejected with a clear "busy" error instead of
/// spawning an unbounded number of connections (which would duplicate billing,
/// open many sockets, and stutter every stream).
pub struct AiState {
    pub inflight: Mutex<HashSet<String>>,
    /// A cancellation signal per in-flight id.
    ///
    /// Membership in `inflight` is only observable BETWEEN awaits: the stream
    /// loop learns the id is gone after the current `stream.next()` resolves.
    /// For a reasoning model that await can be silent for tens of seconds (or
    /// until the 120 s read timeout), so cancelling left the connection open, the
    /// provider generating — and billing — and the concurrency permit held,
    /// which after a few cancels surfaced as "too many AI requests". A token can
    /// be awaited alongside the socket, so cancel drops the response body
    /// immediately.
    pub cancels: Mutex<HashMap<String, tokio_util::sync::CancellationToken>>,
    /// Concurrency cap for streaming completions. The permit is held for the
    /// whole request, so a bounded number of connections are ever open.
    pub(crate) semaphore: Arc<tokio::sync::Semaphore>,
    /// How many requests are currently queued waiting for a permit. Bounds the
    /// wait queue so saturation surfaces a fast "busy" error rather than a
    /// growing backlog of idle connections.
    pub(crate) pending: AtomicUsize,
}

impl AiState {
    /// Claim `id` for a new request and register its cancel token.
    ///
    /// Returns `false` when another live request already holds the id, leaving
    /// that request's registration untouched. An id is how `ai_cancel` and the
    /// stream loop address a request, so two live requests cannot share one:
    /// overwriting left the first request's token unreachable, and the first
    /// request's cleanup then removed the second's entries — a request still
    /// streaming that could never be cancelled and looked finished.
    pub fn claim(
        &self,
        id: &str,
        cancel: tokio_util::sync::CancellationToken,
    ) -> Result<bool, String> {
        let mut inflight = self.inflight.lock().map_err(|e| e.to_string())?;
        if !inflight.insert(id.to_string()) {
            return Ok(false);
        }
        let mut cancels = self.cancels.lock().map_err(|e| e.to_string())?;
        cancels.insert(id.to_string(), cancel);
        Ok(true)
    }

    /// Drop a request's registration. Removing an id that is not registered is
    /// a no-op, so every exit path can call this unconditionally.
    pub fn release(&self, id: &str) {
        if let Ok(mut inflight) = self.inflight.lock() {
            inflight.remove(id);
        }
        if let Ok(mut cancels) = self.cancels.lock() {
            cancels.remove(id);
        }
    }

    /// Interrupt a live request. `false` when nothing was registered under
    /// `id`, so the caller can tell "cancelled" from "there was nothing to
    /// cancel".
    ///
    /// The token is signalled, not just dropped: removing the id is only
    /// visible to the stream loop between reads, and a reasoning model can be
    /// silent for a long time. The token is awaited alongside the socket, so
    /// this is what actually closes the connection and frees the concurrency
    /// permit now rather than after the next chunk or the read timeout.
    pub fn cancel(&self, id: &str) -> Result<bool, String> {
        let token = self.cancels.lock().map_err(|e| e.to_string())?.remove(id);
        self.inflight.lock().map_err(|e| e.to_string())?.remove(id);
        match token {
            Some(token) => {
                token.cancel();
                Ok(true)
            }
            None => Ok(false),
        }
    }
}

impl Default for AiState {
    fn default() -> Self {
        Self {
            inflight: Mutex::new(HashSet::new()),
            cancels: Mutex::new(HashMap::new()),
            semaphore: Arc::new(tokio::sync::Semaphore::new(CONCURRENCY_LIMIT)),
            pending: AtomicUsize::new(0),
        }
    }
}

pub(crate) const CONCURRENCY_LIMIT: usize = 3;
pub(crate) const MAX_PENDING: usize = 8;

#[cfg(test)]
mod tests;
