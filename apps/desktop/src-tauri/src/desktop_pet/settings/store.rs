//! Where the records live: one file per domain, written whole, under the app's own data directory.
//!
//! This is the half `pet-settings-policy.ts` has no counterpart for. That module decides a value and
//! a record and nothing else — it is pure on purpose — and `memory-pet/settings.ts` keeps its
//! records in a variable because a double has no disk. What a real install needs is the two things
//! neither of them states: where a record is, and what happens between reading it and replacing it.
//!
//! **One file per domain.** §5.3 makes the domains independent schemas, and a single file would
//! couple them again in the one place it matters: a domain written by a newer build is `read_only`,
//! and a store that kept all seven in one document would make one unreadable domain unreadable for
//! the six this build can edit. `<data>/desktop-pet/settings/<domain>.json` is the layout, beside
//! the character library's `<data>/desktop-pet/characters/`, and the file *is* the record — the same
//! JSON an IPC answer carries, so what a user opens by hand and what a page reads cannot disagree.
//!
//! **A write is a read, a decision and a replacement, and the three are one step.** Two callers
//! that both read revision *r* would both write, and the second would silently win; refusing the
//! loser of a race is only possible if the two steps cannot overlap. The lock is
//! [`crate::storage::atomic_write::write_lock`], the crate's one write lock, held for the whole
//! sequence — a second `Mutex` here would look self-consistent and would be a second concurrency
//! story for one process's files. What it does **not** give is a cross-process compare-and-swap: a
//! writer outside this process is a window this module states rather than closes, exactly as
//! `config_edit.rs` states its own.
//!
//! **The replacement is atomic and does not loosen a mode.** The bytes are staged through a
//! temporary sibling and renamed over the target by [`crate::storage::atomic_write::atomic_write`],
//! which also carries the destination's permission bits over and refuses to replace a file the user
//! made read-only. The pet's settings are not credentials, but an atomic replacement is what keeps
//! a half-written settings file — a parse error the next read would report as `unreadable` — from
//! existing at all, and the mode rule is `config_edit.rs`'s discipline applied through the crate's
//! own primitive rather than a second implementation of it.

use std::fs;
use std::io::ErrorKind;
use std::path::{Component, Path, PathBuf};

use serde_json::Value;

use super::{
    decide_write, read_domain, schema_newer_message, unreadable_load, PetSettingsDomain,
    PetSettingsLoad, PetSettingsRecord, PetSettingsUpdate, PetSettingsWrite, RefusalReason,
};
use crate::storage::atomic_write::{atomic_write, write_lock};

/// The directory under the app's own data directory that holds the pet's settings.
///
/// One directory beside the character library's, inside the pet's app-owned folder — whose name is
/// [`super::super::resources::LIBRARY_DIR`] rather than a literal here. Imported and not repeated:
/// a second spelling of one path is how two modules come to read and write two different
/// directories that look the same in a log.
pub const SETTINGS_DIR: &str = "settings";

/// The pet's settings, as a directory of one-file records.
///
/// Nothing is cached. A store holds a path and nothing else, which is what makes two windows agree:
/// a copy in memory would be a second answer to "what is stored", and the one thing §5.3's revision
/// rule cannot survive is two answers.
#[derive(Clone, Debug)]
pub struct PetSettingsStore {
    root: PathBuf,
}

impl PetSettingsStore {
    /// A store under an app data directory the caller resolved.
    ///
    /// The root is refused when it is not absolute, the way [`super::super::resources::CharacterLibrary::new`]
    /// refuses one: a relative path resolves against this process's working directory, which is
    /// nobody's choice. The distribution's own prefixes are *not* re-checked here — that list is
    /// the library's, and this root is the app's own data directory rather than a path a caller
    /// named.
    pub fn new(data_dir: impl AsRef<Path>) -> Result<Self, String> {
        let data_dir = data_dir.as_ref();
        if !data_dir.is_absolute() || data_dir.components().next() != Some(Component::RootDir) {
            return Err(format!(
                "the pet's settings need an absolute data directory; {} would resolve against this \
                 process's working directory",
                data_dir.display()
            ));
        }
        Ok(Self {
            root: data_dir
                .join(super::super::resources::LIBRARY_DIR)
                .join(SETTINGS_DIR),
        })
    }

    /// Where the records are. The one path everything below is built from.
    pub fn root(&self) -> &Path {
        &self.root
    }

    /// Where one domain's record is, whether or not it exists yet.
    pub fn path_of(&self, domain: PetSettingsDomain) -> PathBuf {
        self.root.join(format!("{}.json", domain.id()))
    }

    /// What the store holds for one domain, in [`PetSettingsLoad`]'s four arms.
    ///
    /// Nothing here fails: a file that is missing, unreadable, or not a record is an answer a page
    /// can render — `absent`, `unreadable` — and the read arm that would have been an error is the
    /// one the contract has no room for. The three cases are told apart rather than merged, because
    /// what the caller does about them differs: a missing file is a fresh install whose first write
    /// is welcome, and a file that is there and unreadable is one to back up before writing.
    pub fn read(&self, domain: PetSettingsDomain) -> PetSettingsLoad {
        match fs::read_to_string(self.path_of(domain)) {
            Ok(text) => match serde_json::from_str::<Value>(&text) {
                Ok(stored) => read_domain(domain, Some(&stored)),
                // A file that is not JSON at all is not a record either; `read_domain`'s own
                // checks are for a document that parsed.
                Err(_) => unreadable_load(domain),
            },
            Err(error) if error.kind() == ErrorKind::NotFound => read_domain(domain, None),
            Err(_) => unreadable_load(domain),
        }
    }

    /// Apply one domain's write, or say why it did not apply.
    ///
    /// The revision check and the replacement are one critical section (see this module's header):
    /// the record is read, `decide_write` is asked, and what it applies is persisted before the
    /// lock is released. A `conflict` writes nothing — that is the whole point of the arm — and a
    /// `failed` leaves the file as it was, because the replacement is atomic.
    pub fn apply(&self, write: &PetSettingsWrite) -> PetSettingsUpdate {
        let _guard = write_lock()
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let stored = match self.read(write.domain) {
            // §10.2: a store written by a newer build is reported and left alone. The refusal is
            // built here and not by `decide_write`, because there is no record to hand it — the
            // read arm carries the version it found and nothing else — and the sentence is the
            // same one `schema_newer_message` builds for the same fact.
            PetSettingsLoad::ReadOnly { found_version, .. } => {
                return PetSettingsUpdate::Refused {
                    reason: RefusalReason::SchemaNewer,
                    message: schema_newer_message(write.domain, found_version),
                }
            }
            PetSettingsLoad::Current { record }
            | PetSettingsLoad::Migrated { record, .. }
            | PetSettingsLoad::Defaults { record, .. } => record,
        };
        let outcome = decide_write(&stored, write);
        let PetSettingsUpdate::Applied { record } = &outcome else {
            return outcome;
        };
        match self.persist(record) {
            Ok(()) => outcome,
            Err(message) => PetSettingsUpdate::Failed { message },
        }
    }

    /// The character the settings name, or `None` while they name none.
    ///
    /// A read of the `character` domain and nothing else: the enable path asks this to know which
    /// window to open, and a store that answered from a cached selection would be a second answer
    /// to a question the file already answers.
    pub fn chosen_character(&self) -> Option<String> {
        let load = self.read(PetSettingsDomain::Character);
        let record = load.record()?;
        record.value("characterId")?.as_str().map(str::to_string)
    }

    /// Put one record on disk, replacing what was there.
    ///
    /// Pretty-printed rather than compact, because this is a file a user may open and a diff a
    /// reviewer may read, and neither is served by one line per record.
    fn persist(&self, record: &PetSettingsRecord) -> Result<(), String> {
        let text = serde_json::to_string_pretty(record)
            .map_err(|error| format!("the settings could not be written out: {error}"))?;
        atomic_write(&self.path_of(record.domain), &text)
    }
}
