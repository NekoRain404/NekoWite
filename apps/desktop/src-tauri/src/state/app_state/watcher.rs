//! The folder watcher, as the handle Tauri holds: the live watcher and the generation mark that
//! retires trailing work.
//!
//! A module of its own because the counter is one contract with one reader — the trailing-edge
//! flush task `watch_folder` installs — and that contract changes with the watching policy rather
//! than with anything about keys, AI requests or engines.

use std::sync::atomic::AtomicU64;
use std::sync::{Arc, Mutex};

// ---------------------------------------------------------------------------
// Watcher state
// ---------------------------------------------------------------------------

#[derive(Default)]
pub struct WatcherState {
    pub watcher: Mutex<Option<notify::RecommendedWatcher>>,
    /// Bumped every time `watch_folder` installs a new watcher so trailing-edge
    /// flush tasks from the previous vault stop emitting.
    pub generation: Arc<AtomicU64>,
}
