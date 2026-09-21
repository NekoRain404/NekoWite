//! One of `update.rs`'s children: moving the pointer, forward and back.
//!
//! Split out of `update.rs` when it passed §13.1's 600-line default. The seam is "changes when the
//! promote/rollback protocol changes" — the order a promotion and a rollback perform their steps in,
//! and what neither direction may discard. The gate that licenses a promotion is `verify.rs`'s.

use super::super::binary_registry::{self, BinaryRegistry};
use super::super::registry::{InstallSource, UpdatePolicy};
use super::claims::{Check, Verified};
use super::error::UpdateError;
use std::fs;
use std::path::{Path, PathBuf};

/// Whether sessions are live, as the update path has to know before it moves the pointer.
///
/// A trait rather than a call into the agent registry (§3.4: the two registries stay apart): the
/// update path needs the answer to one question, and a caller that owns the sessions is the one
/// that has it.
pub trait SessionActivity {
    fn live_sessions(&self) -> usize;
}

/// Moves the pointer to a verified version, refusing while anything is running.
///
/// The candidate is moved rather than copied, so the download area does not keep an executable
/// second copy of a version, and the pointer is written last: a failure between the two leaves a
/// release on disk that nothing points at, which is a state the next attempt fixes.
pub fn promote(
    registry: &BinaryRegistry,
    verified: &Verified,
    activity: &dyn SessionActivity,
) -> Result<binary_registry::ActiveRelease, UpdateError> {
    if verified.checks != Check::ALL.to_vec() {
        return Err(UpdateError::NotVerified);
    }
    let live = activity.live_sessions();
    if live > 0 {
        return Err(UpdateError::SessionLive { sessions: live });
    }
    let program = registry.program_of(&verified.version);
    let directory = program.parent().unwrap_or(registry.root()).to_path_buf();
    fs::create_dir_all(&directory).map_err(|error| UpdateError::Io {
        path: directory.clone(),
        detail: error.to_string(),
    })?;
    fs::rename(&verified.program, &program).map_err(|error| UpdateError::Io {
        path: program.clone(),
        detail: error.to_string(),
    })?;
    Ok(registry.set_active(&verified.version)?)
}

/// What one version left in one profile.
///
/// The app's own record of it, not the engine's: an engine that migrates a store is the reason this
/// field exists, and the host learns it from the version that ran rather than from the store.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProfileState {
    pub profile_id: String,
    /// The profile's managed root (§3.2's `agent-profiles/<profile-id>/`).
    pub root: PathBuf,
    /// The version that last wrote this profile's state, as the app recorded it — including the
    /// version that was active when the app created the profile.
    ///
    /// `None` is not "nothing has written it": it is "this host has no record of what wrote it".
    /// [`rollback`] treats that as a migration it cannot rule out rather than as one it can, which
    /// is the difference between refusing a bare rollback and silently crossing a store format
    /// change. T12 owns writing this field.
    pub written_by: Option<String>,
}

/// A rollback, and the confirmations it needs.
///
/// `confirm_data_restore` is the user's answer to §3.3's rule (若新版本已迁移数据库，不得仅回退二进制):
/// without it, a rollback under migrated state — or under a profile no version record covers — is
/// refused rather than performed, because the binary is the easy half and the data is the half that
/// loses work.
#[derive(Debug, Clone)]
pub struct RollbackRequest<'a> {
    pub to_version: &'a str,
    pub profiles: &'a [ProfileState],
    /// A snapshot of `agent-profiles/` to restore from: the backup root, whose children are profile
    /// ids. `None` moves the pointer and retains the newer data without restoring anything.
    pub restore_from: Option<&'a Path>,
    /// §3.3: 必要时在进程停止后备份 profile. Nothing is copied or moved while an engine could be
    /// writing, so this is a statement by the caller rather than something this module can check.
    pub engine_stopped: bool,
    pub confirm_data_restore: bool,
}

/// What a rollback did, including what it could not do.
#[derive(Debug, Clone)]
pub struct RollbackReport {
    pub active: binary_registry::ActiveRelease,
    /// Where the newer data was kept, one directory per profile that had any.
    pub retained: Vec<PathBuf>,
    pub restored: bool,
    /// §3.3: 无法兼容时报告限制 — the profiles whose newer data was retained rather than reconciled,
    /// which is every profile a rollback crossed a migration on. This host copies the newer material
    /// and puts the backup back, and it never merges the two, because it does not know the engine's
    /// own store format; a session the newer version wrote is therefore somewhere the user can find
    /// it and not in the profile they are about to open. The sentence is the frontend's, as with
    /// every other report here.
    pub unreconciled: Vec<String>,
}

/// Returns to an older installed version, keeping what the newer one produced.
///
/// The order is the whole of §3.3's rollback rule, and it is deliberately the slow one: validate
/// everything, then retain, then restore, then move the pointer. Every refusal happens before the
/// first byte is copied, which is what makes 迁移失败不破坏旧 profile true rather than hopeful — a
/// rollback that cannot be completed leaves the profile exactly as it was.
pub fn rollback(
    registry: &BinaryRegistry,
    request: RollbackRequest<'_>,
) -> Result<RollbackReport, UpdateError> {
    if !request.engine_stopped {
        return Err(UpdateError::EngineRunning);
    }
    let program = registry.program_of(request.to_version);
    if !program.is_file() {
        return Err(UpdateError::VersionNotInstalled {
            version: request.to_version.to_string(),
            program,
        });
    }

    // Which profiles a newer version has written, and which ones no record covers.
    //
    // Comparing by the app's record rather than by the filesystem's timestamps, so a profile touched
    // by a *sync* does not read as migrated. The second list is the fail-closed half: while T12 has
    // not written a record yet, every profile is in it, and a rollback over a profile this host
    // cannot speak for is refused rather than assumed to be older than the version being returned
    // to. §3.3's rule is about a database a newer version rewrote; "we cannot tell" is not "it did
    // not happen", and the silent pass is the data-loss path the rule exists to prevent.
    let mut migrated: Vec<&ProfileState> = Vec::new();
    let mut unrecorded: Vec<&ProfileState> = Vec::new();
    for state in request.profiles {
        match state.written_by.as_deref() {
            None => unrecorded.push(state),
            Some(writer) if binary_registry::is_newer(writer, request.to_version) => {
                migrated.push(state)
            }
            Some(_) => {}
        }
    }
    if !request.confirm_data_restore {
        if !migrated.is_empty() {
            return Err(UpdateError::StateMigrated {
                profiles: migrated
                    .iter()
                    .map(|state| state.profile_id.clone())
                    .collect(),
            });
        }
        if !unrecorded.is_empty() {
            return Err(UpdateError::UnrecordedState {
                profiles: unrecorded
                    .iter()
                    .map(|state| state.profile_id.clone())
                    .collect(),
            });
        }
    }
    // Everything this rollback cannot vouch for: a profile a newer version wrote, and a profile no
    // record covers. Both are retained before anything is replaced, because "we cannot prove this
    // state is ours to drop" answers the retention question the same way it answers the refusal.
    let crossing: Vec<&ProfileState> = migrated.iter().chain(unrecorded.iter()).copied().collect();

    // Every backup is checked before any of them is used: a rollback that restores one profile and
    // then finds the next backup unreadable has already damaged the state it was recovering.
    let mut planned: Vec<(&ProfileState, PathBuf)> = Vec::new();
    if let Some(backup) = request.restore_from {
        for state in &crossing {
            let source = backup.join(&state.profile_id);
            if !binary_registry::is_restorable(&source) {
                return Err(UpdateError::BackupIncomplete {
                    profile_id: state.profile_id.clone(),
                    path: source,
                });
            }
            planned.push((state, source));
        }
    }

    // Retention, before anything is replaced: the newer data is what a rollback is most likely to
    // lose, and a failure to keep it stops the rollback instead of proceeding without it.
    let mut retained = Vec::new();
    for state in &crossing {
        let destination = registry.retained_path(&state.profile_id);
        binary_registry::retain_tree(&state.root, &destination).map_err(|detail| {
            UpdateError::Unpreserved {
                profile_id: state.profile_id.clone(),
                path: destination.clone(),
                detail,
            }
        })?;
        retained.push(destination);
    }

    let mut restored = false;
    for (state, source) in planned {
        binary_registry::restore_tree(&state.root, &source, &registry.recovery(&state.profile_id))
            .map_err(|detail| UpdateError::RestoreFailed {
                profile_id: state.profile_id.clone(),
                detail,
            })?;
        restored = true;
    }

    // The pointer last: it is what a start resolves through, so it names the version whose profile
    // has been put back rather than the one being left.
    let active = registry.set_active(request.to_version)?;
    Ok(RollbackReport {
        active,
        retained,
        restored,
        unreconciled: crossing
            .iter()
            .map(|state| state.profile_id.clone())
            .collect(),
    })
}

/// Whether this installation may be replaced at all (§3.4.6, §3.3).
///
/// The policy is the registry's, by provenance — an external installation gets a version notice and
/// a user-initiated native entry point, and this is the half that refuses to act on anything else.
pub fn may_replace(source: InstallSource) -> Result<(), UpdateError> {
    match source.update_policy() {
        UpdatePolicy::HostManaged => Ok(()),
        UpdatePolicy::ReportedOnly => Err(UpdateError::NotUpdatable { source }),
    }
}
