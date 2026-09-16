//! Reading the library: what the directories are, and whether they are what the manifest says.
//!
//! The second half of `library.rs`, split out on the same responsibility basis (§13.1): `library.rs`
//! is the *transaction* — how a character comes to exist and how it stops existing — and this file
//! is everything a page asks afterwards. The two answer different questions and change for
//! different reasons, which is the test for a split; that one of them also crossed 400 lines is
//! what made it urgent rather than what made it right.
//!
//! The rule this file implements is the module's cache rule, and it is worth restating where it is
//! carried out: **the manifest records what the character should be, the directory is what it is,
//! and a disagreement is a state.** `list` compares presence and size, which is what a settings
//! page can afford on every open; `verify` compares digests, which is what "is it still the same"
//! actually means. Neither is presented as the other's answer, and neither repairs anything.

use std::fs;

use sha2::{Digest, Sha256};

use super::library::CharacterLibrary;
use super::{
    hex, io_refusal, is_component, DigestMismatch, EntryState, InstalledCharacter, LibraryEntry,
    ResourceRefusal, INSTALLED_MANIFEST, RESERVED_PREFIX,
};

impl CharacterLibrary {
    /// Every directory in the library, newest first, each with what it currently is.
    ///
    /// Read from the directories rather than from a stored list: a character is installed when
    /// its directory is there, and a list that could disagree with the disk would be a second
    /// answer to the same question. A name that is not a component is still listed — the user can
    /// see it and remove the folder themselves — but no operation here will address it.
    pub fn list(&self) -> Result<Vec<LibraryEntry>, ResourceRefusal> {
        let entries = match fs::read_dir(&self.root) {
            Ok(entries) => entries,
            // A library nobody has imported into is empty, not an error: the first import
            // creates the root. Any other failure is reported, because "the library is empty"
            // and "the library could not be read" are different things to tell a user.
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(error) => return Err(io_refusal(&self.root, error)),
        };
        let mut listed: Vec<LibraryEntry> = Vec::new();
        for entry in entries.flatten() {
            let character_id = entry.file_name().to_string_lossy().into_owned();
            if character_id.starts_with(RESERVED_PREFIX) || !entry.path().is_dir() {
                continue;
            }
            listed.push(self.read_entry(&character_id));
        }
        listed.sort_by(|left, right| {
            // Newest first, which is where an import lands. An entry with no manifest has no
            // time to sort by and sorts last, by name.
            let key = |entry: &LibraryEntry| {
                (
                    entry
                        .manifest
                        .as_ref()
                        .map(|manifest| manifest.installed_at_ms)
                        .unwrap_or(0),
                    entry.character_id.clone(),
                )
            };
            let (left, right) = (key(left), key(right));
            right.0.cmp(&left.0).then_with(|| left.1.cmp(&right.1))
        });
        Ok(listed)
    }

    /// One library directory, read against its manifest.
    fn read_entry(&self, character_id: &str) -> LibraryEntry {
        let directory = self.directory(character_id);
        let path = directory.join(INSTALLED_MANIFEST);
        let text = match fs::read_to_string(&path) {
            Ok(text) => text,
            Err(_) => {
                return LibraryEntry {
                    character_id: character_id.to_string(),
                    state: EntryState::Unmanaged,
                    manifest: None,
                }
            }
        };
        let manifest: InstalledCharacter = match serde_json::from_str(&text) {
            Ok(manifest) => manifest,
            Err(error) => {
                return LibraryEntry {
                    character_id: character_id.to_string(),
                    state: EntryState::UnreadableManifest {
                        detail: error.to_string(),
                    },
                    manifest: None,
                }
            }
        };
        let mut missing = Vec::new();
        let mut changed = Vec::new();
        for file in &manifest.files {
            match fs::metadata(directory.join(&file.name)) {
                Ok(meta) if meta.len() == file.bytes => {}
                // Present at another size. The cheap half of the check, and it is the half that
                // catches a truncated copy, a replaced file and an editor's save.
                Ok(_) => changed.push(file.name.clone()),
                Err(_) => missing.push(file.name.clone()),
            }
        }
        let state = if !missing.is_empty() {
            EntryState::Incomplete { missing }
        } else if !changed.is_empty() {
            EntryState::Resized { changed }
        } else {
            EntryState::Intact
        };
        LibraryEntry {
            character_id: character_id.to_string(),
            state,
            manifest: Some(manifest),
        }
    }

    /// Hash every installed file and report the ones that are not what the manifest recorded.
    ///
    /// The second half of the cache rule, and separate from [`Self::list`] on purpose: a listing
    /// is drawn on a settings page and a byte-for-byte pass over a library is work nobody asked
    /// for at that moment. `list` answers "is everything here", this answers "is everything the
    /// same", and neither claims the other's answer.
    pub fn verify(&self, character_id: &str) -> Result<Vec<DigestMismatch>, ResourceRefusal> {
        if !is_component(character_id) {
            return Err(ResourceRefusal::InvalidName {
                field: "characterId",
                value: character_id.to_string(),
            });
        }
        let directory = self.directory(character_id);
        let path = directory.join(INSTALLED_MANIFEST);
        let text = fs::read_to_string(&path).map_err(|error| io_refusal(&path, error))?;
        let manifest: InstalledCharacter =
            serde_json::from_str(&text).map_err(|error| ResourceRefusal::MalformedManifest {
                detail: error.to_string(),
            })?;
        let mut mismatches = Vec::new();
        for file in &manifest.files {
            let installed = directory.join(&file.name);
            let bytes = fs::read(&installed).map_err(|error| io_refusal(&installed, error))?;
            let found = hex(&Sha256::digest(&bytes));
            if found != file.sha256 {
                mismatches.push(DigestMismatch {
                    character_id: character_id.to_string(),
                    name: file.name.clone(),
                    recorded: file.sha256.clone(),
                    found,
                });
            }
        }
        Ok(mismatches)
    }
}
