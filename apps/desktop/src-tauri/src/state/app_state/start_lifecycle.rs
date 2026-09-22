//! A stop invalidates pending work and shares the short final installation barrier.

use std::sync::{Mutex, MutexGuard};

#[derive(Default)]
pub struct StartLifecycle {
    generation: Mutex<u64>,
}

impl StartLifecycle {
    pub fn begin(&self) -> Result<u64, String> {
        self.generation
            .lock()
            .map(|generation| *generation)
            .map_err(|_| "the agent lifecycle state was poisoned by a panic".to_string())
    }

    pub fn finish<T>(
        &self,
        expected: u64,
        install: impl FnOnce() -> Result<T, String>,
    ) -> Result<T, String> {
        let generation = self
            .generation
            .lock()
            .map_err(|_| "the agent lifecycle state was poisoned by a panic".to_string())?;
        if *generation != expected {
            return Err("the agent start was cancelled by a stop".to_string());
        }
        // Both runtime and IPC installation must stay in this closure. A stop cannot clear
        // one slot between the other's installation, nor can a cancelled start revive it.
        install()
    }

    pub fn stop(&self) -> MutexGuard<'_, u64> {
        // A panic must not prevent teardown; invalidation also discards any partial start.
        let mut generation = self
            .generation
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        *generation = generation.wrapping_add(1);
        generation
    }
}
