//! One of `update.rs`'s children: why an update or a rollback was refused.
//!
//! Split out of `update.rs` when it passed §13.1's 600-line default. The seam is "changes when the
//! set of refusals changes" — the frontend maps these variants to sentences, so the variant list is
//! the module's one subject and every other child names it.

use super::super::binary_registry::LayoutError;
use super::super::registry::InstallSource;
use super::claims::Check;
use std::path::PathBuf;

/// Why an update or a rollback was refused. Data only: the frontend maps these to sentences, the
/// same way it maps `registry::RegistryError` — every variant carries what a sentence needs (the
/// version, the path the data was kept at, how many sessions are running) and none of them carries
/// wording, so there is one place where a refusal becomes something a user reads.
#[derive(Debug, Clone)]
pub enum UpdateError {
    /// The bytes are not what the app's record names. This is the refusal that stops everything
    /// else: nothing has run, and nothing will.
    DigestMismatch { expected: String, actual: String },
    /// Not a file this release can execute: wrong architecture, wrong class, or not an executable
    /// at all.
    NotExecutable { path: PathBuf, reason: String },
    /// A staged candidate arrived with an execute bit, so it did not come from the download path
    /// this module owns (§3.2: 未验证文件不得执行).
    StagedExecutable { path: PathBuf },
    /// The candidate answers with a version the record does not name.
    VersionMismatch { expected: String, reported: String },
    /// A probe failed at a named stage.
    Probe { check: Check, detail: String },
    /// A release for an architecture this build does not claim to support (§3.2).
    UnsupportedTarget { target: String },
    /// The pointer was asked to move while an engine is running (§3.3: 活跃会话期间不热替换进程).
    SessionLive { sessions: usize },
    /// The pointer was asked to move for a version that is not installed. §3.3's rule is that an
    /// incompatible version leaves the *old* one usable, and a version that is not on disk is not
    /// usable by anyone.
    VersionNotInstalled { version: String, program: PathBuf },
    /// A `Verified` value that did not pass every check.
    NotVerified,
    /// The profile has been written by a version newer than the one being returned to, so moving the
    /// binary back alone would hand an older engine a store a newer one rewrote.
    StateMigrated { profiles: Vec<String> },
    /// No record covers which version last wrote the profile, so this host cannot tell whether a
    /// rollback would cross a state migration. Refused rather than assumed (§3.3): 若新版本已迁移
    /// 数据库，不得仅回退二进制, and "we cannot tell" is not "it did not happen". The confirmation that
    /// clears it is the same one [`UpdateError::StateMigrated`] takes, because the user is being
    /// asked the same question — do you want the data-restore path, or not.
    UnrecordedState { profiles: Vec<String> },
    /// A restore was asked for while an engine could still be writing.
    EngineRunning,
    /// The backup named for a restore cannot be read, or does not hold the profile it should.
    BackupIncomplete { profile_id: String, path: PathBuf },
    /// The newer data could not be retained, so the rollback was stopped rather than performed
    /// (§3.3: 回退不得默默丢弃升级后产生的会话).
    Unpreserved {
        profile_id: String,
        path: PathBuf,
        detail: String,
    },
    /// A restore failed; the profile it was replacing is still in place.
    RestoreFailed { profile_id: String, detail: String },
    /// An installation this host may report on but never replace (§3.4.6).
    NotUpdatable { source: InstallSource },
    /// The managed layout refused the path.
    Layout(LayoutError),
    /// The filesystem said no.
    Io { path: PathBuf, detail: String },
}

impl From<LayoutError> for UpdateError {
    fn from(error: LayoutError) -> Self {
        UpdateError::Layout(error)
    }
}
