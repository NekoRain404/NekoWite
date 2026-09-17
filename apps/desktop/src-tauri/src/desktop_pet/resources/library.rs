//! The library itself: what is installed, and the one transaction that installs it.
//!
//! Split out of `resources.rs` by responsibility (§13.1) rather than by length: this file is the
//! *directory* half — the root, the commit point, and what a listing is — while `pack.rs` decides
//! what may go into one and `media.rs` decides what a file is. Everything here is reachable as
//! `desktop_pet::resources::…`; the split is not part of the module's surface.
//!
//! The four rules the parent module's header states live here as code: the transaction is
//! [`Staging`] plus one rename, the "no list, only directories" rule is [`CharacterLibrary::list`],
//! and the only deletion in the module is [`CharacterLibrary::remove`] — which is the user's ✕,
//! never a teardown.

use std::fs;
use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};

use super::pack::{classify_pack, read_pack, Grid, RawFile};
use super::{
    hex, io_refusal, name_problem, CharacterKind, CreateRequest, InstallRequest,
    InstalledCharacter, InstalledFile, Removal, ResourceRefusal, CHARACTERS_DIR,
    CHARACTER_SCHEMA_VERSION, INSTALLED_MANIFEST, LIBRARY_DIR, RESERVED_PREFIX, STAGING_ATTEMPTS,
};
use crate::storage::atomic_write::{atomic_write, move_no_clobber};

#[derive(Clone, Debug)]
pub struct CharacterLibrary {
    /// Private to the module's files rather than to this one: `entries.rs` reads the same
    /// directories the transaction writes, and a second accessor for it would be a second way to
    /// name a path.
    pub(super) root: PathBuf,
}

impl CharacterLibrary {
    /// Opens the library under an app data directory the caller resolved.
    ///
    /// The root is refused outside the app's own scope for §3.3's reason: a root the distribution
    /// owns is a path the app must never write to, and the place to refuse it is where the root
    /// is first named rather than where it is first written through.
    pub fn new(data: &Path) -> Result<Self, ResourceRefusal> {
        use std::path::Component;
        if !data.is_absolute() || data.components().next() != Some(Component::RootDir) {
            return Err(ResourceRefusal::OutsideManagedScope {
                root: data.to_path_buf(),
                detail: "the library root must be absolute; a relative one resolves against this process's working directory, which is nobody's choice".to_string(),
            });
        }
        // The same prefixes `agent_runtime::binary_registry` refuses, spelled again because that
        // module's check is private. Two lists that must agree is the shape this repository
        // already treats as a defect; registering this module is where the integrator can lift
        // one of them.
        const SYSTEM_PREFIXES: [&str; 8] = [
            "/usr", "/etc", "/opt", "/var", "/bin", "/sbin", "/lib", "/boot",
        ];
        let text = data.to_string_lossy();
        if let Some(prefix) = SYSTEM_PREFIXES
            .iter()
            .find(|prefix| text == **prefix || text.starts_with(&format!("{prefix}/")))
        {
            return Err(ResourceRefusal::OutsideManagedScope {
                root: data.to_path_buf(),
                detail: format!("{prefix} is the distribution's, not this app's"),
            });
        }
        Ok(Self {
            root: data.join(LIBRARY_DIR).join(CHARACTERS_DIR),
        })
    }

    /// Where the characters live. The one path everything below is built from.
    pub fn root(&self) -> &Path {
        &self.root
    }

    /// Where one character would live, for an id already checked by [`is_path_component`].
    ///
    /// Not public, and every caller validates first: a public `directory(id)` would be a way to
    /// turn an unchecked string into a path, which is the one operation this module exists to not
    /// have. `pub(super)` so `entries.rs` can read through the same one.
    pub(super) fn directory(&self, character_id: &str) -> PathBuf {
        self.root.join(character_id)
    }

    /// Import a pack from the user's own disk.
    ///
    /// The whole import is one transaction: the pack is read and classified, staged inside the
    /// library, and published by a rename. See the module header.
    pub fn install(&self, request: &InstallRequest) -> Result<InstalledCharacter, ResourceRefusal> {
        let files = read_pack(&request.source)?;
        self.publish(
            &request.character_id,
            &request.name,
            request.kind,
            request.installed_at_ms,
            files,
        )
    }

    /// Create a character from one sheet and an explicit grid (§5.2's 创建).
    ///
    /// The same transaction as an import and deliberately not a second path: a created character
    /// is an imported one whose pack was assembled in memory, so the validation, the budgets,
    /// the manifest and the commit point are the same code rather than a parallel implementation
    /// that drifts. That holds for a *downloaded* sheet as well — the bytes a catalogue supplied
    /// are assembled in memory exactly as a file the user picked is, which is why the download path
    /// has no transaction of its own to get wrong.
    pub fn create(&self, request: &CreateRequest) -> Result<InstalledCharacter, ResourceRefusal> {
        if let Some(detail) = name_problem(&request.sheet_name) {
            return Err(ResourceRefusal::InvalidName {
                field: "sheetName",
                value: request.sheet_name.clone(),
                detail,
            });
        }
        let files = vec![RawFile {
            name: request.sheet_name.clone(),
            bytes: request.sheet.clone(),
        }];
        let grid = Grid {
            columns: request.columns,
            rows: request.rows,
        };
        self.publish_with_grid(
            &request.character_id,
            &request.name,
            request.kind,
            request.installed_at_ms,
            files,
            Some(grid),
        )
    }

    fn publish(
        &self,
        character_id: &str,
        name: &str,
        kind: CharacterKind,
        installed_at_ms: u64,
        files: Vec<RawFile>,
    ) -> Result<InstalledCharacter, ResourceRefusal> {
        self.publish_with_grid(character_id, name, kind, installed_at_ms, files, None)
    }

    /// The one transaction both entry points go through.
    ///
    /// The order is the rule: everything that can refuse happens while nothing is visible, the
    /// staging directory is the only thing that exists until the last line, and the last line is
    /// one rename.
    fn publish_with_grid(
        &self,
        character_id: &str,
        name: &str,
        kind: CharacterKind,
        installed_at_ms: u64,
        files: Vec<RawFile>,
        grid: Option<Grid>,
    ) -> Result<InstalledCharacter, ResourceRefusal> {
        if let Some(detail) = name_problem(character_id) {
            return Err(ResourceRefusal::InvalidName {
                field: "characterId",
                value: character_id.to_string(),
                detail,
            });
        }
        let destination = self.directory(character_id);
        if destination.exists() {
            return Err(ResourceRefusal::AlreadyInstalled {
                character_id: character_id.to_string(),
            });
        }

        let classified = classify_pack(files, grid)?;
        let sheet = classified.sheet;
        let manifest = InstalledCharacter {
            schema_version: CHARACTER_SCHEMA_VERSION,
            character_id: character_id.to_string(),
            name: name.to_string(),
            kind,
            installed_at_ms,
            sheet,
            files: classified
                .files
                .iter()
                .map(|file| InstalledFile {
                    name: file.name.clone(),
                    bytes: file.bytes.len() as u64,
                    sha256: hex(&Sha256::digest(&file.bytes)),
                })
                .collect(),
        };

        fs::create_dir_all(&self.root).map_err(|error| io_refusal(&self.root, error))?;
        let mut staging = Staging::open(&self.root)?;
        for file in &classified.files {
            let path = staging.path.join(&file.name);
            fs::write(&path, &file.bytes).map_err(|error| io_refusal(&path, error))?;
        }
        let text = serde_json::to_string_pretty(&manifest).map_err(|error| {
            ResourceRefusal::MalformedManifest {
                detail: error.to_string(),
            }
        })?;
        atomic_write(&staging.path.join(INSTALLED_MANIFEST), &text)
            .map_err(|detail| io_refusal(&staging.path.join(INSTALLED_MANIFEST), detail))?;
        // The commit point. `move_no_clobber` rather than `fs::rename`, because a character
        // published by a rename *over* a directory that appeared in between is a character the
        // user lost without being told (the same reason the crate's other publishes use it).
        move_no_clobber(&staging.path, &destination).map_err(|error| ResourceRefusal::Io {
            path: destination.clone(),
            detail: error.to_string(),
        })?;
        staging.published = true;
        Ok(manifest)
    }

    /// Remove one character, because the user asked for it.
    ///
    /// Not a teardown. §4 makes switching the pet off a *display* operation that deletes nothing,
    /// and this call is not reachable from that path — it is what the ✕ on a library row is, and
    /// a deletion the user asked for is the only deletion this module performs. The commit point
    /// is a rename out of the visible namespace: after it the character is gone from the library,
    /// and emptying the directory beside it is debris work whose failure is reported rather than
    /// folded into a clean removal.
    ///
    /// A directory the library cannot describe is refused rather than removed. The id is not
    /// enough to know what a directory is: without the manifest this call would be destroying
    /// something it cannot name back to the user, which is the class of deletion §4 rules out —
    /// and an unmanaged directory is exactly what a character from an older build looks like.
    pub fn remove(&self, character_id: &str) -> Result<Removal, ResourceRefusal> {
        if let Some(detail) = name_problem(character_id) {
            return Err(ResourceRefusal::InvalidName {
                field: "characterId",
                value: character_id.to_string(),
                detail,
            });
        }
        let directory = self.directory(character_id);
        if !directory.is_dir() {
            return Err(ResourceRefusal::NotInstalled {
                character_id: character_id.to_string(),
            });
        }
        let manifest = directory.join(INSTALLED_MANIFEST);
        if !manifest.is_file() {
            return Err(ResourceRefusal::Unmanaged {
                character_id: character_id.to_string(),
            });
        }
        let text = fs::read_to_string(&manifest).map_err(|error| io_refusal(&manifest, error))?;
        if serde_json::from_str::<InstalledCharacter>(&text).is_err() {
            return Err(ResourceRefusal::Unmanaged {
                character_id: character_id.to_string(),
            });
        }
        // The commit point, and it is a rename rather than a removal: after it the character is
        // out of the library's namespace, and emptying the directory beside it is debris work.
        // `fs::rename` is used rather than `move_no_clobber` deliberately — the destination is the
        // empty directory [`claim_directory`] just took, and that is the one case where replacing
        // the destination is the intent.
        let aside = claim_directory(&self.root, "removing")?;
        fs::rename(&directory, &aside).map_err(|error| io_refusal(&directory, error))?;
        let debris = fs::remove_dir_all(&aside).err().map(|_| aside);
        Ok(Removal {
            character_id: character_id.to_string(),
            debris,
        })
    }
}

/// Take a fresh directory name inside `root`, under the reserved prefix, or say why none could be
/// taken.
///
/// The name is claimed by *creating the directory* rather than chosen and then used: a name
/// picked from a clock or a counter and created afterwards is a name a second writer — another
/// instance of the app, a crash's litter, a test running beside this one — can have taken in
/// between, and `create_dir` is the operation that either takes a name or reports that it is
/// taken. The attempt number is what makes the retry different from the try.
///
/// Ten attempts is far past what a library can hold; a name still taken after ten belongs to
/// something this module did not create, and guessing again would be guessing at somebody else's
/// directory.
fn claim_directory(root: &Path, label: &str) -> Result<PathBuf, ResourceRefusal> {
    let mut last = root.to_path_buf();
    for attempt in 0..STAGING_ATTEMPTS {
        let path = root.join(format!(
            "{RESERVED_PREFIX}{label}-{}-{attempt}",
            std::process::id()
        ));
        match fs::create_dir(&path) {
            Ok(()) => return Ok(path),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => last = path,
            Err(error) => return Err(io_refusal(&path, error)),
        }
    }
    Err(ResourceRefusal::Io {
        path: last,
        detail: format!("no {label} name could be claimed in the library"),
    })
}

/// A directory that removes itself unless it was published.
///
/// The transaction's whole enforcement: every early return, every `?` and every panic between
/// [`Staging::open`] and `published = true` runs this, so "fails halfway" cannot leave a
/// half-written character behind even if a later edit adds a new failure path.
struct Staging {
    path: PathBuf,
    published: bool,
}

impl Staging {
    fn open(root: &Path) -> Result<Self, ResourceRefusal> {
        Ok(Self {
            path: claim_directory(root, "staging")?,
            published: false,
        })
    }
}

impl Drop for Staging {
    fn drop(&mut self) {
        if !self.published {
            let _ = fs::remove_dir_all(&self.path);
        }
    }
}
