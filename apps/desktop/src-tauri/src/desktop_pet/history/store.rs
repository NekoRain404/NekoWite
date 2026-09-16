//! Where the ledger lives between runs: one file under the pet's own folder, written whole.
//!
//! §6.3 asks the pet to 「重启读取已处理账本」, and until this module existed nothing did: the rows
//! were written into a `TaskHistory` that lived and died with the process, so every start began
//! with an empty dedup memory and — the part a user would notice — with no record that anything had
//! finished while they were not looking. A reminder that a crash erases is a delivery mechanism with
//! amnesia, which is the one thing an unread list cannot be.
//!
//! **Where.** `<data>/desktop-pet/ledger.json`, beside the character library and the settings
//! directory that [`crate::desktop_pet::settings::store`] owns — the same app-owned folder, one
//! file, because this is not a settings *domain*: nothing on a page edits it, no revision guards it
//! and no user-facing control resets it. Checking whether an existing store could hold it is how
//! this file came to be a sibling rather than a new kind of thing: the settings store is one
//! versioned record per domain with a revision and a conflict rule, and the care ledger is
//! documented as never naming a file at all. What is left is the crate's own primitive —
//! [`crate::storage::atomic_write`], the one write lock and the staged replacement — and one path.
//!
//! **What a restart may and may not resurrect.** Two rules, and both are about a file that is
//! older than the process reading it:
//!
//!  - **Stream marks are not restored.** A mark is a *position in one runtime's stream*, and the
//!    stream it describes cannot outlive the process that was reading it — `runtime_epoch` carries
//!    the process id, so a restarted runtime is a different epoch and no restored mark can match a
//!    live frame. What it *could* do is worse than being useless: a recycled process id would let a
//!    mark from the last run make this run's first frames look like replays, which swallows the
//!    reminder silently. Marks are therefore forgotten on load, and the file's copy of them is
//!    written for the human who opens it, not for the reader.
//!  - **An unread row ages out.** A reminder is about work the user is still in a position to act
//!    on; a row from before a night, a weekend or a holiday is not, and §6.3's unread list is not an
//!    archive. [`UNREAD_MAX_AGE_MS`] is the bound, the drop is counted in [`Loaded::dropped`] and
//!    the caller says so — a bound that silently forgot a reminder would be the 漏提示 this whole
//!    feature is graded against.
//!
//! **A schema from a newer build is read-only.** The same §10.2 rule the settings store keeps, and
//! it has to be a latch rather than a check at write time: a build that read a future ledger as
//! "this version, with defaults" would write that reading back on its first ending. A file this
//! build cannot read *at all* is the other arm and gets the other answer — start fresh and report,
//! because the alternative is a reminder system that stops working for ever after one bad byte —
//! and the report is where the loss is stated rather than hidden.

use std::fs;
use std::io::ErrorKind;
use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;

use super::{Decoded, TaskHistory, DEFAULT_MARK_CAPACITY, DEFAULT_RECORD_CAPACITY};
use crate::storage::atomic_write::atomic_write;

/// The ledger's file, inside the pet's own folder (`resources::LIBRARY_DIR`).
pub const LEDGER_FILE: &str = "ledger.json";

/// How old an unread row may be and still be a reminder: one day, in host milliseconds.
///
/// A working day is the wrong unit (an evening's work would age out overnight) and a week is the
/// wrong one too — by then the session it names is history the user has moved past, and the row
/// would be a stale notification dressed as a fresh one. A day covers the case the rule exists for
/// (the app was closed, or crashed, and the user wants to know what finished) and refuses the one
/// it must (a reminder from before yesterday).
pub const UNREAD_MAX_AGE_MS: i64 = 24 * 60 * 60 * 1000;

/// What one read of the ledger produced.
#[derive(Debug)]
pub struct Loaded {
    /// The rows this build will use: the file's, minus the marks and minus what aged out.
    pub history: TaskHistory,
    /// How much of the file did not survive — rows and marks beyond this build's bounds, and unread
    /// rows too old to be reminders. Never silent: the caller reports a non-zero count.
    pub dropped: usize,
    /// Why nothing was restored, when nothing was: a file this build cannot read, or one a newer
    /// build wrote. `None` covers both "the ledger was read" and "there is no file yet", which are
    /// the same thing to a caller that has an empty history either way.
    pub detail: Option<String>,
}

/// What one write did.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum SaveOutcome {
    /// The file now holds the ledger.
    Written,
    /// The file already held exactly this — a save that would have written the same bytes.
    Unchanged,
    /// A newer build wrote the file, so this build does not replace it (§10.2).
    ReadOnly,
}

/// The last thing this process put on disk, and whether it may write at all.
#[derive(Debug, Default)]
struct Written {
    /// The encoded ledger as it was last written. Compared before every save, because a save is
    /// called from the driver's task for every applied fact and most facts change no row.
    text: Option<String>,
    /// False once a read met a file a newer build wrote.
    writable: bool,
}

impl Default for Loaded {
    fn default() -> Self {
        Self {
            history: TaskHistory::new(),
            dropped: 0,
            detail: None,
        }
    }
}

/// The ledger, as a path and what this process has done with it.
///
/// Nothing else is cached: the rows live in the policy that decides about them
/// ([`super::super::notification_policy`]), which is the one place a fact is recorded, and a second
/// copy here would be a second answer to "what has been handled".
#[derive(Debug)]
pub struct HistoryStore {
    path: PathBuf,
    state: Mutex<Written>,
}

impl HistoryStore {
    /// A store under an app data directory the caller resolved.
    ///
    /// The root is refused when it is not absolute, for the reason
    /// [`crate::desktop_pet::settings::PetSettingsStore::new`] refuses one: a relative path resolves
    /// against this process's working directory, which is nobody's choice.
    pub fn new(data_dir: impl AsRef<Path>) -> Result<Self, String> {
        let data_dir = data_dir.as_ref();
        if !data_dir.is_absolute() || data_dir.components().next() != Some(Component::RootDir) {
            return Err(format!(
                "the pet's ledger needs an absolute data directory; {} would resolve against this \
                 process's working directory",
                data_dir.display()
            ));
        }
        Ok(Self {
            path: data_dir
                .join(crate::desktop_pet::resources::LIBRARY_DIR)
                .join(LEDGER_FILE),
            // `writable` starts **false**, and only [`Self::load`] turns it on. A store that has
            // read nothing cannot know whether the file it would replace belongs to a newer build,
            // and the safe answer to "I do not know" is the one §10.2 gives: do not write. Every
            // path the app takes loads first, so this costs a caller nothing and takes the
            // overwrite out of the hands of whoever forgets.
            state: Mutex::new(Written {
                text: None,
                writable: false,
            }),
        })
    }

    /// Where the ledger is. The one path everything here is built from.
    pub fn path(&self) -> &Path {
        &self.path
    }

    /// The ledger as it was left, with the two rules of this module's header applied.
    ///
    /// `now_ms` is the host's clock, taken as a parameter for the reason the ledger's own entry
    /// points take one (§10.2's injected clock): the ageing rule is then exercised by handing it two
    /// numbers rather than by writing a file with old rows in it and waiting.
    pub fn load(&self, now_ms: i64) -> Loaded {
        let raw = match fs::read_to_string(&self.path) {
            // A missing file is a fresh install: nothing was lost, and there is nothing to report.
            Err(error) if error.kind() == ErrorKind::NotFound => {
                self.lock_writable(true);
                return Loaded::default();
            }
            // A file that is there and could not be read is not one this build can preserve either
            // — the next write will fail on its own terms and say so — and refusing to write for
            // ever over a transient error would be the reminder system that never works again.
            Err(error) => {
                self.lock_writable(true);
                return Loaded {
                    detail: Some(format!("{} could not be read: {error}", self.path.display())),
                    ..Loaded::default()
                };
            }
            Ok(raw) => raw,
        };
        match TaskHistory::decode(&raw, DEFAULT_RECORD_CAPACITY, DEFAULT_MARK_CAPACITY) {
            Decoded::Restored(restored) => {
                self.lock_writable(true);
                self.restorable(restored.history, restored.dropped, now_ms)
            }
            // Garbled bytes are this build's own file gone wrong, not a format from the future, and
            // `Decoded::Unreadable`'s rule is that the caller must not write over it *as if it had
            // been empty* — which is what the `detail` below is for. The loss is stated (the dedup
            // memory starts empty, so an ending already announced may be announced again) and then
            // the next write replaces a file that is not a ledger. A build that refused instead
            // would leave a reminder system that never persists again, with one line at startup to
            // explain it and no way for the user to act.
            Decoded::Unreadable { detail } => {
                self.lock_writable(true);
                Loaded {
                    detail: Some(detail),
                    ..Loaded::default()
                }
            }
            Decoded::NewerSchema { found } => {
                self.lock_writable(false);
                Loaded {
                    detail: Some(format!(
                        "the ledger at {} was written by schema {found}; this build writes {}",
                        self.path.display(),
                        super::HISTORY_SCHEMA_VERSION
                    )),
                    ..Loaded::default()
                }
            }
        }
    }

    /// Apply the two restore rules and say how much they cost.
    fn restorable(&self, mut history: TaskHistory, dropped: usize, now_ms: i64) -> Loaded {
        let marks = history.forget_marks();
        let stale = history.drop_unread_before(now_ms - UNREAD_MAX_AGE_MS);
        Loaded {
            history,
            dropped: dropped + marks + stale,
            detail: None,
        }
    }

    /// Put the ledger on disk, unless it is already there or this build may not write it.
    ///
    /// The crate's write lock is deliberately *not* taken: that lock exists for a read-old →
    /// decide → replace sequence, and there is none here — the bytes come from memory, and
    /// `atomic_write` stages its own temp sibling, so two writers of this file cannot expose a half
    /// of one another. Within this process the ledger's own lock is what serialises saves.
    pub fn save(&self, history: &TaskHistory) -> Result<SaveOutcome, String> {
        let text = history.encode();
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if !state.writable {
            return Ok(SaveOutcome::ReadOnly);
        }
        if state.text.as_deref() == Some(text.as_str()) {
            return Ok(SaveOutcome::Unchanged);
        }
        atomic_write(&self.path, &text)?;
        state.text = Some(text);
        Ok(SaveOutcome::Written)
    }

    fn lock_writable(&self, writable: bool) {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        state.writable = writable;
    }
}
