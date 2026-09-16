//! Recovery material: the baselines an agent's changes are judged against, and the one
//! recovery this host will perform. A module of §9's tree — `agent_runtime/recovery.rs`,
//! 「基线与恢复资料，不冒充全盘事务」 — and the second half of that line is a limit that
//! shapes everything here.
//!
//! §7.2 asks for four things and this is three of them:
//!
//! - **A baseline for the notes a session is about to touch, taken before it starts**
//!   (「会话开始前对明确相关的打开/附加笔记保存基线」). [`Recovery::baseline`] reads the note
//!   through the app's own read path and keeps its text, not only its hash: a hash can
//!   *identify* the version a change replaced but cannot restore it, and a host that held
//!   hashes alone would have to call a change recoverable it cannot actually recover.
//! - **A check that the file still holds what the change left** (「恢复前检查当前内容是否仍
//!   等于已记录结果；不一致则三方比较/人工合并，不能覆盖用户后续编辑」). [`Recovery::plan`]
//!   re-reads the file and refuses on any difference, and [`Recovery::recover`] runs the same
//!   judgement again at the moment of the write rather than trusting an older answer.
//! - **A refusal where there is nothing to restore** (「没有基线时标记不可直接恢复，不伪造
//!   「撤销成功」」). Every way of not being able to restore is a named refusal, so a surface can
//!   say which one instead of printing one blank "recovery failed".
//!
//! What it is *not* is a transaction, and the line is stated here rather than discovered by a
//! reader who assumes otherwise. §7.2: 「应用内锁不能锁住外部 shell；普通"读取后检查再写入"
//! 不是跨进程原子比较替换」. The window between the check and the write is closed against this
//! process's own writes — the write goes through the app's save path, which holds the crate's
//! one write lock — and is **not** closed against another program, a sync client or a second
//! instance editing the same note. Closing it needs a staged workspace and a controlled
//! publish, which §7.2 defers to a separate security review; nothing here may be read as
//! having it.
//!
//! The write goes through [`VaultFiles`] for the same reason [`super::fs_capability`] uses it:
//! that is the app's write path, and it is what makes a recovery reversible in the other
//! direction — the save stages the version it replaces (the agent's) into the note's history
//! before publishing the baseline over it, so putting a change back does not destroy it.
//! Nothing in this module writes a file itself.

use std::collections::VecDeque;
use std::sync::{Arc, Mutex};

use sha2::{Digest, Sha256};

use super::fs_capability::{ChangeRecord, VaultFiles};

/// How many baselines are held at once.
///
/// Bounded, because a baseline is a whole note's text and this is one session's worth of
/// material rather than an archive: the note's own history (kept by the app, capped per note)
/// is what makes a change reversible over time, and what this list has to cover is the notes a
/// session is working on now. The oldest is dropped when it overflows, which is also the
/// honest behaviour — a baseline nobody has asked about for that long is not one a recovery
/// should still be offered against.
const MAX_BASELINES: usize = 64;

/// One note's text as it was before a session touched it.
///
/// `hash` is derived from `text` by the one function that makes it ([`hash_of`]), so the two
/// cannot disagree — a stored hash and a stored text that were computed separately are exactly
/// the pair that would let a wrong version be declared correct.
#[derive(Debug, Clone)]
pub struct Baseline {
    /// The root this baseline was taken under. Carried rather than re-supplied later, so a
    /// lookup cannot pair one vault's path with another vault's text.
    pub vault_root: String,
    pub path: String,
    /// The SHA-256 of `text`, in lowercase hex — comparable with the hashes a
    /// [`ChangeRecord`] carries.
    pub hash: String,
    pub text: String,
}

/// Why a change cannot be recovered.
///
/// One arm per reason, because each is a different thing for the caller to do, and each carries
/// what a surface needs to name the offender. [`RecoveryRefusal::code`] is the stable spelling
/// for the IPC boundary: the UI maps codes to sentences, the same way the front end's own
/// refusals are codes, so no user-facing wording has to live in the runtime.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RecoveryRefusal {
    /// Nothing was recorded for this path — a file the session created, or one it touched
    /// without a baseline having been taken. §7.2's 「不可直接恢复」, marked rather than
    /// guessed at.
    NoBaseline {
        path: String,
        /// The vault the change says it happened in. Named because "no baseline" is a fact
        /// about this host's record for *this* root, not about the file.
        vault_root: String,
    },
    /// The version the change replaced is not the version this host recorded: the file moved
    /// between the baseline and the agent's write (the user saved in the meantime). Putting the
    /// held baseline back would undo an edit that was never part of the change.
    BaselineStale {
        path: String,
        /// The hash this host holds.
        held: String,
        /// The hash the change says it replaced; `None` when the change created the file.
        recorded: Option<String>,
    },
    /// The file could not be read where the change's result should be. A deleted or renamed
    /// file arrives here, and §7.2 requires both to be shown rather than restored around: the
    /// read cannot tell the two apart, so neither is claimed.
    Unavailable { path: String, detail: String },
    /// The file is not what the change left — the case §7.2 names first. Whoever edited it
    /// since is owed a comparison, not a decision taken for them.
    Changed {
        path: String,
        /// The hash the change recorded as its result.
        expected: String,
        /// What the file holds now.
        found: String,
    },
    /// The file already holds the baseline: there is nothing to put back, and reporting a
    /// recovery would be the fabricated success §7.2 forbids.
    AlreadyAtBaseline { path: String },
    /// The write itself was refused by the app's own path (a read-only destination, a path that
    /// left the vault, a file that is not text). The change is untouched.
    WriteRefused { path: String, detail: String },
}

impl RecoveryRefusal {
    /// The stable code the IPC layer sends and a surface maps to its own wording.
    pub fn code(&self) -> &'static str {
        match self {
            RecoveryRefusal::NoBaseline { .. } => "no-baseline",
            RecoveryRefusal::BaselineStale { .. } => "baseline-stale",
            RecoveryRefusal::Unavailable { .. } => "unavailable",
            RecoveryRefusal::Changed { .. } => "changed-since-recorded",
            RecoveryRefusal::AlreadyAtBaseline { .. } => "already-at-baseline",
            RecoveryRefusal::WriteRefused { .. } => "write-refused",
        }
    }
}

/// A recovery that has been judged possible, and the material it would use.
#[derive(Debug, Clone)]
pub struct RecoveryStep {
    pub baseline: Baseline,
    /// What the file holds now — equal to the change's result hash by construction, and carried
    /// so the caller can record what was replaced without a second read.
    pub current_hash: String,
}

/// What [`Recovery::plan`] answers. Both arms are values: a caller that only wants to decide
/// whether to offer a button does not have to write anything to find out.
#[derive(Debug, Clone)]
pub enum RecoveryPlan {
    Recoverable(RecoveryStep),
    Refused(RecoveryRefusal),
}

/// What a recovery did.
#[derive(Debug, Clone)]
pub struct RecoveryOutcome {
    pub vault_root: String,
    pub path: String,
    /// What the file holds now.
    pub baseline_hash: String,
    /// What it held a moment ago: the change that was put back.
    pub replaced_hash: String,
    /// The app's own warning about the optional part of the save (the history snapshot), or
    /// `None`. Carried rather than dropped: "recovered, but the previous version could not be
    /// kept" is a thing the user has to be told.
    pub warning: Option<String>,
}

/// The baselines this host holds, and the recovery it will perform against them.
pub struct Recovery {
    files: Arc<dyn VaultFiles>,
    baselines: Mutex<VecDeque<Baseline>>,
}

impl Recovery {
    /// `files` is the app's own file path, supplied the way [`super::fs_capability`] supplies
    /// it: this module is a library module and must not reach into `storage` or Tauri state by
    /// absolute path, and the tests hand in the real implementation so what is proved is the
    /// app's write path rather than a stand-in for it.
    pub fn new(files: Arc<dyn VaultFiles>) -> Self {
        Self {
            files,
            baselines: Mutex::new(VecDeque::new()),
        }
    }

    /// Record one note's text as it is now, before a session that will work on it starts.
    ///
    /// A second baseline for the same path **replaces** the first rather than being added
    /// beside it: two entries for one file would make a later recovery depend on which one the
    /// lookup happened to find, and the newer text is the one any change is about to sit on.
    ///
    /// A read that fails is an `Err`, not a refusal: this is the caller asking for material it
    /// may not be able to have, and the caller is the one that can tell the user a note could
    /// not be protected before the session started.
    pub fn baseline(&self, vault_root: &str, path: &str) -> Result<Baseline, String> {
        let text = self.files.read(vault_root, path)?;
        let baseline = Baseline {
            vault_root: vault_root.to_string(),
            path: path.to_string(),
            hash: hash_of(&text),
            text,
        };
        let mut held = self.baselines.lock().unwrap();
        held.retain(|other| !(other.vault_root == baseline.vault_root && other.path == baseline.path));
        if held.len() == MAX_BASELINES {
            held.pop_front();
        }
        held.push_back(baseline.clone());
        Ok(baseline)
    }

    /// The baseline held for this path in this vault, if any.
    ///
    /// Both halves of the key are required: a path alone would let a change recorded against
    /// one vault be recovered from another vault's text, which is the same cross-root mistake
    /// the runtime refuses everywhere else.
    fn held_baseline(&self, vault_root: &str, path: &str) -> Option<Baseline> {
        self.baselines
            .lock()
            .unwrap()
            .iter()
            .find(|baseline| baseline.vault_root == vault_root && baseline.path == path)
            .cloned()
    }

    /// Whether this change can be put back, and what it would put back.
    ///
    /// The questions are asked in the order the answers stop mattering, and each one is a
    /// refusal rather than a correction:
    ///
    ///  1. *Is there a baseline?* Without one there is nothing to restore, and no amount of
    ///     reading the file produces the version the change replaced.
    ///  2. *Is it the baseline this change replaced?* The change carries the hash of what it
    ///     overwrote. If that is not what this host recorded, the file moved between the two
    ///     moments and the held text belongs to a version that is no longer any change's
    ///     predecessor.
    ///  3. *Does the file still hold the change's result?* The check §7.2 asks for by name.
    ///  4. *Is there anything to do?* A file already at its baseline ends here rather than
    ///     being written with the bytes it already has.
    pub fn plan(&self, change: &ChangeRecord) -> RecoveryPlan {
        let path = change.path.clone();
        let Some(baseline) = self.held_baseline(&change.vault_root, &path) else {
            return RecoveryPlan::Refused(RecoveryRefusal::NoBaseline {
                path,
                vault_root: change.vault_root.clone(),
            });
        };
        if change.baseline_hash.as_deref() != Some(baseline.hash.as_str()) {
            return RecoveryPlan::Refused(RecoveryRefusal::BaselineStale {
                path,
                held: baseline.hash.clone(),
                recorded: change.baseline_hash.clone(),
            });
        }
        let current = match self.files.read(&change.vault_root, &path) {
            Ok(text) => text,
            Err(detail) => return RecoveryPlan::Refused(RecoveryRefusal::Unavailable { path, detail }),
        };
        let current_hash = hash_of(&current);
        if current_hash != change.result_hash {
            return RecoveryPlan::Refused(RecoveryRefusal::Changed {
                path,
                expected: change.result_hash.clone(),
                found: current_hash,
            });
        }
        if change.result_hash == baseline.hash {
            return RecoveryPlan::Refused(RecoveryRefusal::AlreadyAtBaseline { path });
        }
        RecoveryPlan::Recoverable(RecoveryStep {
            baseline,
            current_hash,
        })
    }

    /// Put the file back to its baseline, if it is still the file this change left.
    ///
    /// The judgement is made here again rather than taken from an older [`Recovery::plan`]:
    /// the user's press and the answer they were shown are two different moments, and the file
    /// can move between them. What the second check does *not* give is atomicity — see this
    /// module's header for exactly how far the guarantee reaches.
    ///
    /// On success the write is the app's own, so the version being replaced (the agent's) is
    /// staged into the note's history first: a recovery is itself reversible, which is what
    /// keeps it from being the one destructive operation in the review.
    pub fn recover(&self, change: &ChangeRecord) -> Result<RecoveryOutcome, RecoveryRefusal> {
        let step = match self.plan(change) {
            RecoveryPlan::Recoverable(step) => step,
            RecoveryPlan::Refused(refusal) => return Err(refusal),
        };
        let path = step.baseline.path.clone();
        let warning = self
            .files
            .write(&step.baseline.vault_root, &path, &step.baseline.text)
            .map_err(|detail| RecoveryRefusal::WriteRefused {
                path: path.clone(),
                detail,
            })?;
        Ok(RecoveryOutcome {
            vault_root: step.baseline.vault_root,
            path,
            baseline_hash: step.baseline.hash,
            replaced_hash: step.current_hash,
            warning,
        })
    }
}

/// The SHA-256 of a text, in lowercase hex.
///
/// `fs_capability` hashes a file's text the same way and does not export it, and that file is
/// not this task's to change. The two **must** agree — a baseline and the change it judges are
/// compared by this value alone, so a difference would not be a wrong answer but an
/// unexplainable one: every change would come back "not recoverable" and nothing would say why.
/// `agent_recovery_test.rs` hashes with a third, independent implementation for exactly that
/// reason, so the agreement is a test result rather than a shared name.
fn hash_of(content: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(content.as_bytes());
    format!("{:x}", hasher.finalize())
}
