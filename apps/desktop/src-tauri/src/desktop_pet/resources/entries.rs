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
//!
//! **A name in that manifest is input, not configuration.** The manifest is a file in a directory
//! the user owns, so the names in it are as untrusted as a pack entry's name — and this is the half
//! of the module that reads: `list` stats what a name points at and `verify` reads and hashes it.
//! Every one of them therefore goes through [`installed_file`], which resolves it inside the
//! character's own directory by the module's own rule before any of that happens.

use std::fs;
use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};

use super::library::CharacterLibrary;
use super::{
    hex, io_refusal, name_problem, DigestMismatch, EntryState, InstalledCharacter, LibraryEntry,
    PackageProblem, ResourceRefusal, INSTALLED_MANIFEST, RESERVED_PREFIX,
};

/// The file a manifest names, resolved inside the character's own directory — or the refusal that
/// says why the library will not open one.
///
/// `manifest.json` is written by this module and by nothing else, but it is still a file on disk
/// in a directory the user owns: a hand-edited one can name any path on the machine, and `verify`
/// would read it and hand back its digest. The name is judged by [`name_problem`], which is the
/// library's one rule for a string that is about to become a single path component — the same
/// function `read_pack` applies to every pack entry on the way in and `character_view` applies to
/// `manifest.sheet.file` before it builds the sheet's path. It is not restated here, and the
/// refusal carries that function's own sentence for the clause that refused rather than a second
/// list of reasons that would have to be kept in step with it.
///
/// The link half is the same fact one level down. A name that is a component confines where a path
/// *points*; a link inside the directory would send the read wherever it points instead, so the
/// stat that decides is `symlink_metadata` — the one that does not follow the last component, the
/// same call `read_pack` makes on every entry and `domain::path_policy` makes on every component of
/// a resolved path. `read_pack` refuses every link on the way in ("what is copied has to be inside
/// the pack"), so a link here is not something this library wrote, and reading through one would
/// make what is hashed depend on a target that can be changed after any check.
///
/// Like `domain::path_policy`, this is not a defence against a writer that swaps the entry between
/// this stat and the caller's next syscall — that needs `openat`/`O_NOFOLLOW`, and it is out of
/// scope for a directory the app itself created and owns. It closes the case that is reachable
/// without winning a race: a link that is simply there.
fn installed_file(directory: &Path, name: &str) -> Result<PathBuf, ResourceRefusal> {
    if let Some(detail) = name_problem(name) {
        return Err(ResourceRefusal::InvalidName {
            field: "files[].name",
            value: name.to_string(),
            detail,
        });
    }
    let path = directory.join(name);
    let linked = fs::symlink_metadata(&path)
        .map(|meta| meta.file_type().is_symlink())
        .unwrap_or(false);
    if linked {
        return Err(ResourceRefusal::Package {
            name: name.to_string(),
            problem: PackageProblem::Symlink,
            detail: "the library reads no links: what one points at is not a file inside the \
                     character's own directory, and it can be changed after this check"
                .to_string(),
        });
    }
    Ok(path)
}

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
        let mut outside = Vec::new();
        let mut missing = Vec::new();
        let mut changed = Vec::new();
        for file in &manifest.files {
            // A name the library will not turn into a path is reported and never looked up.
            // `missing` and `resized` are both claims about a file somebody stat'ed, and no stat
            // was made: `..` would be the library directory's own size, and a name holding a NUL
            // would be reported as absent when the kernel was never asked a question it could
            // answer. Which clause refused is [`super::name_problem`]'s to say, and `verify` is
            // where that sentence is raised.
            let Ok(path) = installed_file(&directory, &file.name) else {
                outside.push(file.name.clone());
                continue;
            };
            match fs::metadata(&path) {
                Ok(meta) if meta.len() == file.bytes => {}
                // Present at another size. The cheap half of the check, and it is the half that
                // catches a truncated copy, a replaced file and an editor's save.
                Ok(_) => changed.push(file.name.clone()),
                Err(_) => missing.push(file.name.clone()),
            }
        }
        // A manifest that names something outside the character's directory is not a manifest of
        // this directory, so it is the state to report even when its other entries also disagree:
        // the file list as a whole is not something the library looked at.
        let state = if !outside.is_empty() {
            EntryState::OutsideDirectory { names: outside }
        } else if !missing.is_empty() {
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
        if let Some(detail) = name_problem(character_id) {
            return Err(ResourceRefusal::InvalidName {
                field: "characterId",
                value: character_id.to_string(),
                detail,
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
            // The first name the library will not open ends the pass. A manifest that names one is
            // not a manifest whose other entries this library should report on: "the files below
            // are what it recorded" is a claim about a file list that has already been refused.
            let installed = installed_file(&directory, &file.name)?;
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
