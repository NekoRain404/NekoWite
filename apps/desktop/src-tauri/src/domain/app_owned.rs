//! The directories the app itself owns, and the rule that no path-confined
//! command serves a path inside one.
//!
//! `~/.config/dev.nekowite.app` holds `last-vault`, the record `register` reads
//! as proof the user chose a vault root. `~/.local/share/dev.nekowite.app`
//! holds the master key and the stronghold snapshot. Both are ordinary folders
//! inside the user's own tree, so a vault can CONTAIN them: the folder dialog
//! returns `~/.config` as readily as `~/Documents/notes`.
//!
//! That is the whole of the hole the record's location opens. Whoever can write
//! `last-vault` — and `write_file` served it as an ordinary file of an ordinary
//! vault — names any absolute directory, and the next `register_vault` accepts
//! it on the record's authority, for the session and for the next launch (the
//! forged root is what gets recorded). It needs the user to have opened
//! `~/.config`, or something containing it, as their vault; it is not a
//! default configuration. Once it holds, though, the confinement model is gone
//! entirely, and the same route overwrites the key files under the data
//! directory.
//!
//! The rule here is the one [`crate::storage::trash_store`] already applies to
//! the vault's own bookkeeping (`.nekowite`, `.nekowite-trash`, `.tmp`),
//! extended to the directories it was always about: an app-owned path is not
//! the user's document, and no file command serves it — read or write. Read
//! included, because the rule is one rule and a read/write split would be two
//! scopes to keep in step, and because the data directory holds the key
//! material: `read_file` returns a `String`, which fails on most of those bytes
//! and not on all of them.
//!
//! It is applied in [`super::path_policy::resolve_within_rel`] — the one
//! function every path-confined command's target passes through — rather than
//! at each command. Eight commands can place bytes at a vault path
//! (`write_file`, `create_new_file`, `save_attachment`, `import_attachment`,
//! `rename_entry`, `restore_history`, `restore_from_trash`, `create_dir`), and
//! a rule that has to be remembered at eight call sites is one the ninth will
//! miss.
//!
//! The set is installed once, at startup, from the app handle (`lib.rs`),
//! because only the running app knows where the platform resolved these
//! directories. Nothing installed refuses nothing, which is what the
//! integration tests — which build no app — rely on;
//! `tests/app_owned_dirs_test.rs` pins the wiring.

use std::path::{Path, PathBuf};
use std::sync::RwLock;

use super::path_policy::{canonicalize_loose, ipc_path};

/// Which of the app's directories a path was found in.
///
/// It exists for the refusal: "inside NekoWite's own configuration directory"
/// says which folder was hit and what the app keeps there, where "inside an
/// app-owned directory" says nothing the user can act on.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum AppDir {
    /// Where the remembered-vault record lives.
    Configuration,
    /// Where the master key and the stronghold snapshot live.
    Data,
}

impl AppDir {
    fn label(self) -> &'static str {
        match self {
            AppDir::Configuration => "configuration",
            AppDir::Data => "data",
        }
    }
}

/// One directory the app owns: the folder, and which of the app's folders it is.
struct OwnedDir {
    kind: AppDir,
    path: PathBuf,
}

/// The app's own directories, as this process resolved them.
///
/// Process-wide rather than a field on `VaultRegistry`: it is a fact about the
/// running app, it is read on the path every file command resolves, and
/// cloning it per call would be pure cost. An `RwLock` rather than a
/// `OnceLock` only so a test can install a set of its own — the app installs
/// once, in `run()`'s setup pass.
static APP_DIRS: RwLock<Vec<OwnedDir>> = RwLock::new(Vec::new());

/// Install the directories the app owns. Called once, from `lib.rs`'s setup.
///
/// Each path is canonicalized as far as it exists: the configuration directory
/// need not exist yet on a first run, and a home reached through a symlink must
/// still compare equal to the canonical vault roots this is checked against.
pub fn install(dirs: Vec<(AppDir, PathBuf)>) {
    let mut installed: Vec<OwnedDir> = Vec::new();
    for (kind, path) in dirs {
        let path = canonicalize_loose(&path).unwrap_or(path);
        // Tauri's data and local-data directories are the same folder on Linux;
        // one entry is enough for the rule, and a duplicate would only give the
        // search below the same answer twice.
        if installed.iter().any(|dir| dir.path == path) {
            continue;
        }
        installed.push(OwnedDir { kind, path });
    }
    if let Ok(mut guard) = APP_DIRS.write() {
        *guard = installed;
    }
}

/// Refuse `path` when it is inside one of the app's own directories.
///
/// `path` must be canonical — every caller gets it from
/// [`resolve_within_rel`](super::path_policy::resolve_within_rel), which
/// canonicalizes — because the installed directories are.
pub fn refuse(path: &Path) -> Result<(), String> {
    // A poisoned lock can only come from `install` panicking, and `install` runs
    // once at startup; recovering the guard keeps the rule in force instead of
    // switching it off, which is the failure this module exists to prevent.
    let dirs = APP_DIRS.read().unwrap_or_else(|e| e.into_inner());
    let Some(dir) = dirs.iter().find(|dir| path.starts_with(&dir.path)) else {
        return Ok(());
    };
    Err(format!(
        "refusing to serve {}: it is inside NekoWite's own {} directory, which \
         no vault command may read or write. The app keeps its state there — the \
         vault root it remembers, the keys it stores — and a vault that contains \
         that folder must not be able to reach it. Choose a vault that does not \
         contain it.",
        ipc_path(path),
        dir.kind.label()
    ))
}
