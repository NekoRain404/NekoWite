//! Putting a change this host performed back: the one write on the agent surface that a window
//! can ask for without holding a tab.
//!
//! §7.2 asks for three things about an agent's changes — a baseline, a check before restoring, and
//! a refusal where there is nothing to restore — and `agent_runtime::recovery` is that judgement.
//! What this file adds is the way in: a session id and a path arrive from a window, and the
//! *path* is the only thing the window gets to name.
//!
//! ## Why the session is named and the vault is not
//!
//! A path is only a path inside one vault, so a change is looked up under the root of the session
//! the caller named — read from this host's own table, never from the request. That is the same
//! §6.1 rule the session commands apply to a vault id, one step further in: a renderer cannot
//! point a recovery at a file in a folder the user did not open, because it cannot name a folder
//! at all.
//!
//! ## Why this exists beside the editor's own rejection
//!
//! The editor pane's review (`features/agent/components/AgentChangedFiles.vue`) puts a change back
//! through the note's *tab* — the note's own save transaction, which is the app's one path into a
//! file that is open, and which is the right path while a tab holds it: the buffer, the vault and
//! the precondition all apply. What it cannot do is write a file **no tab holds**, and that was a
//! dead end: §7.2's 「没有基线时标记不可直接恢复」 was reached as a refusal with no way out, for
//! exactly the notes a reader is least likely to have open — the ones an agent went and changed.
//!
//! This host is the other half of that, and it is not a second copy of the same judgement: it
//! holds the bytes the *delegated* write replaced, taken from the same read that produced the
//! record's baseline hash, so its check is against the file's hash rather than against the text
//! the engine said it left. A change the engine performed with its own tools produced no record
//! here and is answered `no-baseline` — a refusal with a reason, which is what §7.2 asks for.
//!
//! ## The two channels, and which fact goes where
//!
//! A **refusal** is data: `no-baseline`, `baseline-stale`, `changed-since-recorded`,
//! `already-at-baseline`, `write-refused`, `unavailable` are six different things for the reader
//! to do, and they arrive in the `Ok` arm as a code the window's copy tree already names. A
//! **rejection** is the call not having happened — no engine running, no such session — and it
//! travels as [`AgentFailure`] like every other refusal on the agent surface. Nothing here turns
//! one into the other.

use serde::Serialize;

use crate::agent_runtime::recovery::{RecoveryOutcome, RecoveryRefusal};

use super::agent::{AgentFailure, AgentIpcState};

/// What a recovery did, or why it did not.
///
/// `kind` is the arm and `code` is the condition, and both are needed: a page renders the code
/// (its copy tree is keyed by one, exactly as the review's own refusals are) while `kind` is what
/// a caller branches on before it reads either.
#[derive(Debug, Clone, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum AgentChangeRecovery {
    /// The file holds its baseline again. `replacedHash` is the change that was put back, and
    /// `warning` is the app's own word about the optional part of the save — the history snapshot —
    /// or null. It is carried rather than dropped: "recovered, but the previous version could not
    /// be kept" is something the user has to be told.
    Recovered {
        path: String,
        baseline_hash: String,
        replaced_hash: String,
        warning: Option<String>,
    },
    /// Nothing was written, and `code` says which of the six reasons it was. See
    /// [`RecoveryRefusal::code`] for the list; the sentence belongs to the window's catalogue.
    Refused { path: String, code: &'static str },
}

impl AgentChangeRecovery {
    fn recovered(outcome: RecoveryOutcome) -> Self {
        Self::Recovered {
            path: outcome.path,
            baseline_hash: outcome.baseline_hash,
            replaced_hash: outcome.replaced_hash,
            warning: outcome.warning,
        }
    }

    /// The refusal for a path this host has performed no change for.
    ///
    /// `no-baseline` is [`RecoveryRefusal::NoBaseline`]'s own code, taken from that arm rather
    /// than spelled again: the window keys its sentence on this word, and a second literal here
    /// would render as a missing sentence the day one of them moved. The vault root is empty
    /// because the record that would have carried one is exactly what is missing.
    fn no_change(path: &str) -> Self {
        Self::Refused {
            path: path.to_string(),
            code: RecoveryRefusal::NoBaseline {
                path: path.to_string(),
                vault_root: String::new(),
            }
            .code(),
        }
    }
}

/// Puts one of this runtime's changes back, for the file a window names.
///
/// **A note no tab holds is the case this was built for**, and it is why the answer is the file's
/// own hash rather than the editor's account of a buffer: the review can refuse a note it has no
/// tab for (「no tab holds this note」), and this is the same request answered by the half of the
/// app that performed the write.
///
/// The write goes through the app's save path like every other agent write (`VaultFiles::write`),
/// so the version being replaced is staged into the note's history first: a recovery is itself
/// reversible, which is what keeps it from being the one destructive operation in the review.
#[tauri::command]
pub async fn agent_recover_change(
    ipc: tauri::State<'_, AgentIpcState>,
    session_id: String,
    path: String,
) -> Result<AgentChangeRecovery, AgentFailure> {
    let session = ipc.session()?;
    // §6.1 first, and it is the *rejection* channel: a session this host never opened is not a
    // change it cannot find, it is a call about something that is not there.
    session
        .runtime
        .known_session(&session_id)
        .map_err(|error| AgentFailure::of_session(&error))?;
    let change = session
        .runtime
        .change_for(&session_id, &path)
        .map_err(|error| AgentFailure::of_session(&error))?;
    let Some(change) = change else {
        return Ok(AgentChangeRecovery::no_change(&path));
    };
    // Off the async worker, like the delegated write this puts back: the app's save path fsyncs,
    // and a recovery that ran on the IPC task would block every other call the window makes while
    // it waits for the disk.
    let runtime = std::sync::Arc::clone(&session.runtime);
    let outcome = tokio::task::spawn_blocking(move || runtime.recover(&change))
        .await
        .map_err(|join| {
            AgentFailure::unavailable(format!("the recovery did not finish: {join}"))
        })?;
    Ok(match outcome {
        Ok(outcome) => AgentChangeRecovery::recovered(outcome),
        Err(refusal) => AgentChangeRecovery::Refused {
            path,
            code: refusal.code(),
        },
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The one refusal this file makes up, and it has to be the code §7.2 already names.
    ///
    /// A page keys its sentence on the code (`agent.changes.refused.noBaseline` in the review's
    /// own copy tree), so a second spelling here would render as a missing sentence for a file the
    /// host never wrote — the state a reader reaches most often, because it is every file the
    /// engine changed with its own tools rather than through this host.
    #[test]
    fn a_change_this_host_never_performed_is_refused_as_having_no_baseline() {
        let refusal = AgentChangeRecovery::no_change("notes/a.md");
        let AgentChangeRecovery::Refused { path, code } = refusal else {
            panic!("a change with no record is a refusal");
        };
        assert_eq!(path, "notes/a.md");
        assert_eq!(code, "no-baseline");
        // And it is `RecoveryRefusal`'s own word rather than a literal that happens to match, so a
        // rename there fails here rather than on a window that has lost its sentence.
        assert_eq!(
            code,
            RecoveryRefusal::NoBaseline {
                path: String::new(),
                vault_root: String::new(),
            }
            .code()
        );
    }
}
