//! How this app's agent definitions are reached and changed: the shared handle a reader takes, the
//! one path that gets `&mut`, and the lazy build behind both.
//!
//! A module of its own because the question is one and so is its reason to change — §3.4.7's rule
//! that a definition may not be edited while a start is awaiting on it. That rule is the whole of
//! [`edit_registry`]'s structure and the reason the registry is an `Arc`; the slots that hold it
//! stay in [`super::agent`], where their own docs describe them.

use std::path::Path;
use std::sync::Arc;

use crate::agent_runtime::registry::AgentRegistry;

use super::agent::AgentRuntimeState;
use super::launch::{executable_dir, program_to_launch};

/// The definitions this app knows, for a reader that only looks — the settings surface's read.
///
/// A share rather than a borrow, because the command that asks runs on another task and a start may
/// be in flight beside it. What it deliberately is *not* is a mutation path: a change goes through
/// [`edit_registry`], which is the only way to get `&mut`, so no caller can edit a definition while
/// a start is awaiting on it (§3.4.7).
pub fn registry_of(
    state: &AgentRuntimeState,
    managed: &Path,
) -> Result<Arc<AgentRegistry>, String> {
    registry_for(state, managed)
}

/// Applies a change to the definitions — register, enable, disable — and answers
/// what the change produced.
///
/// The refusal grammar belongs to the caller: `change` returns its own value, so
/// "the backend said no" is data inside the answer while an `Err` from here means
/// the change *never ran* — the two failure channels T13a's settings surface
/// keeps apart, expressed as two types instead of two conventions.
///
/// **Why the value is taken out and put back.** The registry is stored as an
/// `Arc` because a start awaits while holding it (see [`AgentRuntimeState`]), and a mutation
/// needs `&mut`. `Arc::try_unwrap` succeeds exactly when no start is in flight,
/// so the `Err` arm below is not a lock timeout — it is §3.4.7's rule, seen from
/// the other side: a definition may not be edited while an engine is being
/// started from it. The slot is held for the whole operation, so nothing can
/// observe it empty, and a value that came back out of `try_unwrap` is put back
/// unchanged.
pub fn edit_registry<T>(
    state: &AgentRuntimeState,
    managed: &Path,
    change: impl FnOnce(&mut AgentRegistry) -> T,
) -> Result<T, String> {
    let mut slot = state
        .registry
        .lock()
        .map_err(|_| "the agent registry state was poisoned by a panic".to_string())?;
    let registry = match slot.take() {
        Some(registry) => registry,
        // Not built yet: this is the first thing to ask for it, and the build is the same one a
        // start would have done — a settings page that could not read before a session started
        // would be a page that only worked in one order.
        None => Arc::new(AgentRegistry::with_bundled(program_to_launch(
            managed,
            &executable_dir(),
        )?)),
    };
    match Arc::try_unwrap(registry) {
        Ok(mut owned) => {
            let answer = change(&mut owned);
            *slot = Some(Arc::new(owned));
            Ok(answer)
        }
        Err(shared) => {
            // An engine start is in flight and holds a share of this registry. Reported as a
            // failure of *this call* rather than as a refusal, because the request was never
            // considered — and left in the slot exactly as it was.
            *slot = Some(shared);
            Err(
                "an engine is being started, so its registration cannot be changed right now; \
                 try again in a moment"
                    .to_string(),
            )
        }
    }
}

/// This app's agent definitions, built on first use.
/// `pub(super)` rather than private because the start path in [`super::agent`] reaches this too —
/// it is the build [`registry_of`] shares rather than a second one — and `super` is the narrowest
/// scope that holds both readers.
pub(super) fn registry_for(
    state: &AgentRuntimeState,
    managed: &Path,
) -> Result<Arc<AgentRegistry>, String> {
    let mut slot = state
        .registry
        .lock()
        .map_err(|_| "the agent registry state was poisoned by a panic".to_string())?;
    if let Some(registry) = slot.as_ref() {
        return Ok(Arc::clone(registry));
    }
    let registry = Arc::new(AgentRegistry::with_bundled(program_to_launch(
        managed,
        &executable_dir(),
    )?));
    *slot = Some(Arc::clone(&registry));
    Ok(registry)
}
