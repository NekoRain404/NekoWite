//! Where the care ledger lives between runs: one file under the pet's own folder, written whole.
//!
//! **Why this is a sibling of `care_ledger` and not a child of it.** `tests/desktop_pet_care_test/local.rs`
//! holds that module to a rule it states as 「progress is local and must stay local」: every file
//! `care_ledger` is built from is scanned, and none of them may name `std::fs`, `File::`, a socket, a
//! process or a credential. That scan is worth keeping rather than relaxing — it is what makes 「this
//! ledger cannot reach a network」 a property of the tree — so the file belongs where the rule does not
//! reach: a module beside the ledger, owning the path and the replacement, exactly as
//! `desktop_pet::history::store` owns the reminder ledger's file one directory over.
//!
//! **What the restart has to preserve, and what it costs if it does not.**
//!
//!  - **The totals and the trailing window**, which is what a user means by their progress: xp, meals,
//!    the streak, the days and the badges and the usage anyone reported.
//!  - **The `decided` map**, and this is the half that is not merely sad to lose. `care_ledger`'s
//!    producer keys a decision on the contract's own run token, and that map is the *only* thing that
//!    stops a re-delivered completion from being paid twice. A fresh process has no memory of a run —
//!    the projection is rebuilt too, so 'this run already ended' is not a fact anything else holds —
//!    which makes the file the last line of defence for the idempotence clause
//!    `care_ledger/import.rs` states as 「idempotent across replays and restarts」.
//!
//! **A schema from a newer build is read-only.** The same §10.2 rule the reminder ledger's store and
//! the settings store keep, and it has to be a latch rather than a check at write time: a build that
//! read a future record as "this version, with defaults" would write that reading back over the user's
//! real progress. A file this build cannot read *at all* is the other arm and gets the other answer —
//! start fresh and report — because refusing for ever over one bad byte would leave a feature that
//! never records anything again with a single line at startup to explain it.
//!
//! The read command has an arm for the first of those (`PetCareRead::ReadOnly`): a page told `empty`
//! about a record that exists would show a user who has been using this for months the level-0 state
//! the whole two-arm design exists to avoid.

use std::fs;
use std::io::ErrorKind;
use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;

use super::care_ledger::{CareLedger, Decoded, LEDGER_SCHEMA_VERSION};
use crate::storage::atomic_write::atomic_write;

/// The care ledger's file, inside the pet's own folder (`resources::LIBRARY_DIR`).
///
/// A name of its own rather than the reminder ledger's `ledger.json`: the two records are different
/// shapes with different rules, and one file holding both would make a corrupt one cost the other.
pub const CARE_FILE: &str = "care.json";

/// What one read of the ledger produced.
#[derive(Debug)]
pub struct Loaded {
    /// The ledger this build will use. Empty when nothing could be restored — which is the same
    /// answer for "there is no file yet" and "the file could not be read", and is not the same
    /// *news*, which is why `detail` exists beside it.
    pub ledger: CareLedger,
    /// Why nothing was restored, when nothing was. `None` covers both "the ledger was read" and
    /// "there is no file yet", which are the same thing to a caller that has an empty ledger either
    /// way.
    pub detail: Option<String>,
    /// True when a newer build wrote the file, so this build must not replace it. The read command
    /// says so rather than answering `empty`.
    pub read_only: bool,
}

impl Default for Loaded {
    fn default() -> Self {
        Self {
            ledger: CareLedger::new(),
            detail: None,
            read_only: false,
        }
    }
}

/// What one write did.
///
/// The same three answers [`super::history::SaveOutcome`] gives, and deliberately its own type rather
/// than an import of that one: the arms mean "a newer *care record* owns this file" and "a newer
/// *reminder ledger* does", which are two different facts about two different files. Sharing the enum
/// would tie the care ledger's persistence to the reminder ledger's module for no behaviour in common.
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
    /// The encoded ledger as it was last written. Compared before every save, because `save` is
    /// called from the driver's task after every applied fact and most facts change no total.
    text: Option<String>,
    /// False until a read has happened. See [`CareStore::new`].
    writable: bool,
}

/// The ledger, as a path and what this process has done with it.
///
/// Nothing else is cached: the ledger itself lives in the handle `PetTaskFeed` and `DesktopPetState`
/// share, which is the one place a reward is decided, and a second copy here would be a second answer
/// to "what has been paid".
#[derive(Debug)]
pub struct CareStore {
    path: PathBuf,
    state: Mutex<Written>,
}

impl CareStore {
    /// A store under an app data directory the caller resolved.
    ///
    /// The root is refused when it is not absolute, for the reason the reminder ledger's store and
    /// `settings::PetSettingsStore::new` refuse one: a relative path resolves against this process's
    /// working directory, which is nobody's choice.
    pub fn new(data_dir: impl AsRef<Path>) -> Result<Self, String> {
        let data_dir = data_dir.as_ref();
        if !data_dir.is_absolute() || data_dir.components().next() != Some(Component::RootDir) {
            return Err(format!(
                "the pet's care ledger needs an absolute data directory; {} would resolve against \
                 this process's working directory",
                data_dir.display()
            ));
        }
        Ok(Self {
            path: data_dir
                .join(crate::desktop_pet::resources::LIBRARY_DIR)
                .join(CARE_FILE),
            // `writable` starts **false**, and only [`Self::load`] turns it on. A store that has read
            // nothing cannot know whether the file it would replace belongs to a newer build, and the
            // safe answer to "I do not know" is the one §10.2 gives: do not write. Every path the app
            // takes loads first, so this costs a caller nothing and takes the overwrite out of the
            // hands of whoever forgets.
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

    /// The ledger as it was left.
    ///
    /// No ageing rule and no forgetting, unlike the reminder ledger's read: a reminder is about work
    /// the user is still in a position to act on, and a meal they earned in March is still a meal.
    pub fn load(&self) -> Loaded {
        let raw = match fs::read_to_string(&self.path) {
            // A missing file is a fresh install: nothing was lost, and there is nothing to report.
            Err(error) if error.kind() == ErrorKind::NotFound => {
                self.lock_writable(true);
                return Loaded::default();
            }
            // A file that is there and could not be read is not one this build can preserve either —
            // the next write fails on its own terms and says so — and refusing to write for ever over
            // a transient error would be the care ledger that never records anything again.
            Err(error) => {
                self.lock_writable(true);
                return Loaded {
                    detail: Some(format!(
                        "{} could not be read: {error}",
                        self.path.display()
                    )),
                    ..Loaded::default()
                };
            }
            Ok(raw) => raw,
        };
        match CareLedger::decode(&raw) {
            Decoded::Restored(ledger) => {
                self.lock_writable(true);
                Loaded {
                    ledger: *ledger,
                    detail: None,
                    read_only: false,
                }
            }
            // Garbled bytes are this build's own file gone wrong, not a format from the future. The
            // loss is stated — the dedup memory starts empty, so a run already paid may be paid
            // again — and then the next write replaces a file that is not a ledger. A build that
            // refused instead would leave the care page empty for ever, with one line at startup to
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
                        "the care ledger at {} was written by schema {found}; this build writes \
                         {LEDGER_SCHEMA_VERSION}",
                        self.path.display()
                    )),
                    read_only: true,
                    ..Loaded::default()
                }
            }
        }
    }

    /// Whether this build may replace the file at all — the latch [`Self::load`] sets.
    ///
    /// Exposed because the read command owes the page the difference between "nothing has been
    /// settled" and "your record is here and this build cannot read it": the first is `Empty` and the
    /// second is a sentence.
    pub fn is_read_only(&self) -> bool {
        !self.state().writable
    }

    /// Put the ledger on disk, unless it is already there or this build may not write it.
    ///
    /// The crate's write lock is deliberately *not* taken: that lock exists for a read-old → decide →
    /// replace sequence, and there is none here — the bytes come from memory, and `atomic_write` stages
    /// its own temp sibling, so two writers of this file cannot expose a half of one another. Within
    /// this process the ledger's own lock is what serialises saves.
    pub fn save(&self, ledger: &CareLedger) -> Result<SaveOutcome, String> {
        let text = ledger.encode();
        let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
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
        let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        state.writable = writable;
    }

    fn state(&self) -> std::sync::MutexGuard<'_, Written> {
        self.state.lock().unwrap_or_else(|error| error.into_inner())
    }
}
