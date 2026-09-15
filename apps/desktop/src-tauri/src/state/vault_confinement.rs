//! The confinement authority: the vault roots the user actually opened, and the
//! structural rules a root must pass before one can be served.
//!
//! The rules stay in the same module as the registry on purpose. `register` is
//! their only caller, and a rule kept away from the gate that applies it is a
//! rule nothing enforces.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use crate::domain::path_policy::{canonicalize_vault_root, ipc_path};
use crate::errors::vault_root_unauthorized_error;

// ---------------------------------------------------------------------------
// Vault registry
// ---------------------------------------------------------------------------

/// Server-side record of the vault root the user actually opened this session.
/// Every path-confined command refuses a `vault_root` that is NOT in this set —
/// closing the hole where window code could pass an arbitrary absolute path
/// (e.g. `/home/user/.ssh`) as the "vault root" to read/write outside any
/// vault the user opened.
#[derive(Default)]
pub struct VaultRegistry {
    /// The root path-confined commands may be pointed at. The UI is
    /// single-vault, so registering replaces whatever was there: a closed vault
    /// must not keep answering commands for the rest of the session.
    opened: Mutex<HashSet<PathBuf>>,
    /// Roots the user chose in the native folder dialog this session.
    ///
    /// This is the only evidence the backend has that a path came from a
    /// person. `register_vault` is an IPC command, so "the window asked for it"
    /// is worth nothing on its own: a compromised renderer can ask for `/etc`
    /// exactly as easily as for the user's notes. A folder the user pointed at
    /// in the OS dialog is a fact the renderer cannot manufacture.
    chosen: Mutex<HashSet<PathBuf>>,
}

impl VaultRegistry {
    /// Record that the user picked `root` in the native folder dialog, without
    /// registering anything.
    ///
    /// Registering here would de-authorize the vault still on screen
    /// (`register` replaces it), and the frontend flushes the outgoing vault's
    /// dirty tabs before it commits to a new one — those writes would then be
    /// refused and the switch would abort, leaving the UI on a vault the
    /// backend no longer serves. The pick is remembered; `register` is called
    /// once the switch is actually committed.
    pub fn approve_pick(&self, root: &str) -> Result<PathBuf, String> {
        let canonical = canonicalize_vault_root(root)?;
        if !canonical.is_dir() {
            return Err(format!(
                "{} is not a folder and cannot be opened as a vault",
                ipc_path(&canonical)
            ));
        }
        let mut chosen = self.chosen.lock().map_err(|e| e.to_string())?;
        chosen.insert(canonical.clone());
        Ok(canonical)
    }

    /// Record `root` (canonicalized) as the opened vault.
    ///
    /// `remembered` is the root the BACKEND itself recorded the last time a
    /// vault was opened ([`remembered_vault`](crate::state::remembered_vault)). Passing it is what lets a
    /// session start on the vault the user was working in yesterday without a
    /// fresh dialog; it is not something the window can invent, because that
    /// record is only ever written here, from a root that got through this
    /// function.
    pub fn register(&self, root: &str, remembered: Option<&Path>) -> Result<PathBuf, String> {
        let canonical = canonicalize_vault_root(root)?;
        if !canonical.is_dir() {
            return Err(format!("cannot open {root} as a vault: it is not a folder"));
        }
        if let Some(refusal) = vault_root_structural_refusal(&canonical) {
            return Err(refusal);
        }
        let chosen = self
            .chosen
            .lock()
            .map_err(|e| e.to_string())?
            .contains(&canonical);
        let recalled = remembered.is_some_and(|record| same_folder(record, &canonical));
        if !chosen && !recalled {
            return Err(unvouched_vault_root_error(root));
        }
        let mut set = self.opened.lock().map_err(|e| e.to_string())?;
        set.clear();
        set.insert(canonical.clone());
        Ok(canonical)
    }

    /// Drop authorization for `root`. Unknown roots are a no-op.
    pub fn unregister(&self, root: &str) -> Result<(), String> {
        let canonical = canonicalize_vault_root(root)?;
        let mut set = self.opened.lock().map_err(|e| e.to_string())?;
        set.remove(&canonical);
        Ok(())
    }

    /// Record a vault root the USER pointed at by launching the app with a file
    /// inside it (`nekowite notes.md`, or a `.md` double-clicked in the file
    /// manager), the way [`approve_pick`](Self::approve_pick) records a folder
    /// dialog choice.
    ///
    /// The evidence is the same kind: the path reached this process through its
    /// own `argv`, which is something no renderer can manufacture. It goes in
    /// through `approve_pick`, so it passes exactly the validations a dialog
    /// pick passes and lands in the same set — a gate of its own beside
    /// `approve_pick`/`register` would be a hole, not a feature.
    ///
    /// The extra check is the one thing a dialog pick can defer and a launch
    /// cannot: a picked root is re-checked by `register` when the switch
    /// commits, but a launch has no second chance, so a root that could never
    /// be served is refused here where the user can still be told why.
    ///
    /// `file` is the document the launch named, and it is a parameter for the
    /// refusal ALONE. The rule is about the folder, but the request it refuses
    /// is about the file: `nekowite ~/todo.md` used to be answered with a
    /// sentence about the home directory and advice ("choose a folder inside
    /// it") that cannot open the note the user asked for. Passing the file here
    /// rather than back at the call site is what keeps the rule, its reason and
    /// the sentence the user reads in one module — a caller holding only the
    /// folder could not write that sentence, and a caller writing its own copy
    /// of the rule would be the second place the rule lives.
    pub fn approve_launch_root(&self, file: &Path, root: &str) -> Result<PathBuf, String> {
        // Canonicalized before the refusal so the message names the same path
        // `approve_pick` would record; that call canonicalizes again, and stays
        // the only place a root is remembered.
        let canonical = canonicalize_vault_root(root)?;
        if let Some(reason) = vault_root_refusal(&canonical) {
            return Err(unservable_launch_file(file, &canonical, reason));
        }
        self.approve_pick(root)
    }

    /// The opened root that contains `path`, if any — "is this file already
    /// inside a vault we serve?".
    ///
    /// `Path::starts_with` compares whole components, so `/notes-archive` is
    /// not reported as being inside `/notes`. Callers pass a canonical path:
    /// a root is stored canonical, and a comparison against a path that still
    /// carries `..` or a symlink would answer a question nobody asked.
    pub fn containing_opened_vault(&self, path: &Path) -> Option<PathBuf> {
        let set = self.opened.lock().ok()?;
        set.iter().find(|root| path.starts_with(root)).cloned()
    }

    /// Prove `root` was opened by the user. Returns the canonicalized root or
    /// an error with a recovery hint when the root was never authorized.
    pub fn authorize(&self, root: &str) -> Result<PathBuf, String> {
        let canonical = canonicalize_vault_root(root)?;
        let set = self.opened.lock().map_err(|e| e.to_string())?;
        if set.contains(&canonical) {
            Ok(canonical)
        } else {
            Err(vault_root_unauthorized_error(root))
        }
    }
}

/// Require `root` to be a vault the user opened this session, or fail with a
/// recovery hint. Called at the top of every path-confined command.
pub fn require_opened_vault(registry: &VaultRegistry, root: &str) -> Result<(), String> {
    registry.authorize(root).map(|_| ())
}

/// The error for a root that nothing vouches for. It names the two things that
/// do vouch for one, because the caller is a user whose vault did not open.
fn unvouched_vault_root_error(root: &str) -> String {
    format!(
        "refusing to open a vault the user did not choose: {root}. \
         The backend only serves a folder the user picked in the folder dialog, \
         or the vault it opened last. Use \"Open folder\" to choose it."
    )
}

/// The reason a folder can never be a vault root, whichever way it was chosen.
///
/// `register` is the one place that decides this, so it stays a policy about
/// vaults rather than a list of names: `/` and the user's home are exactly the
/// two folders whose children are "everything on the machine" and "everything
/// of mine". Neither can hold a note collection of its own, and serving one
/// would hand every path-confined command the run of the filesystem — not
/// because a rule failed, but because there would be no boundary left to
/// enforce. Everything else stays a matter of the user having chosen it.
///
/// It is a VALUE rather than a sentence because two readers need it. A pick and
/// a registration are refused with a sentence about the FOLDER, which is what
/// they asked about; a launch is refused with a sentence about the FILE it was
/// handed, which is what its user asked about
/// ([`unservable_launch_file`]). Both quote the clause below, so a fourth
/// structural rule reaches both the moment it is added here.
fn vault_root_refusal(path: &Path) -> Option<VaultRootRefusal> {
    // `/` on unix, `C:\` on windows: the only paths without a parent.
    if path.parent().is_none() {
        return Some(VaultRootRefusal::FilesystemRoot);
    }
    if let Some(home) = home_dir().and_then(|home| home.canonicalize().ok()) {
        if path == home {
            return Some(VaultRootRefusal::Home);
        }
        // `starts_with` also covers equality, but the case above has its own
        // message: "you picked home itself" and "you picked a folder that
        // contains home" are different mistakes.
        if home.starts_with(path) {
            return Some(VaultRootRefusal::ContainsHome);
        }
    }
    None
}

/// Why a folder cannot be a vault, as a value.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum VaultRootRefusal {
    FilesystemRoot,
    Home,
    ContainsHome,
}

impl VaultRootRefusal {
    /// The rule in its own words, as a clause that completes
    /// "… as a vault: {clause}." — or, in a launch's sentence, follows the
    /// folder it cannot serve.
    fn clause(self) -> &'static str {
        match self {
            Self::FilesystemRoot => {
                "it is the filesystem root, which would put every file on the machine inside the vault"
            }
            Self::Home => {
                "it is your home directory, which holds your keys, configuration and browser data"
            }
            Self::ContainsHome => "it contains your home directory",
        }
    }

    /// What to do about the FOLDER, for the reader who named one.
    fn advice(self) -> &'static str {
        match self {
            Self::FilesystemRoot => "Choose the folder that holds your notes.",
            Self::Home => "Choose a folder inside it, such as ~/Documents/notes.",
            Self::ContainsHome => "Choose a folder inside your home directory.",
        }
    }
}

/// The structural refusal as a sentence about the FOLDER — what a dialog pick
/// and a registration are refused with.
fn vault_root_structural_refusal(path: &Path) -> Option<String> {
    let reason = vault_root_refusal(path)?;
    Some(format!(
        "refusing to open {} as a vault: {}. {}",
        ipc_path(path),
        reason.clause(),
        reason.advice()
    ))
}

/// The structural refusal as a sentence about the FILE a launch was handed.
///
/// The rule is unmoved — nothing here makes `$HOME`, `/` or an ancestor of home
/// servable, and nothing makes a launch's refusal a way around it. What changes
/// is the subject. The folder's own sentence answers "may this folder be a
/// vault?" with no and tells the user to choose another one, which is right for
/// a pick and useless for a launch: the folder was never the user's question.
/// They asked for a note, and the answer they need is that the note cannot be
/// served and what would let it be. So the file is named first, the folder's
/// own clause gives the reason, and the remedy is the one that reaches the
/// document — a folder the user CAN open as a vault, with the note moved into
/// it.
fn unservable_launch_file(file: &Path, folder: &Path, reason: VaultRootRefusal) -> String {
    format!(
        "cannot open {}: it is not inside a vault NekoWite has open or \
         remembers, and a file a launch was handed is served from its own \
         folder — so it needs {} to be a vault, and that folder cannot be one: \
         {}. Move the note into a folder you can open as a vault, then open it \
         from there.",
        ipc_path(file),
        ipc_path(folder),
        reason.clause()
    )
}

/// The user's home directory: the folder whose children are the user's private
/// data on every platform this app ships for.
#[cfg(unix)]
fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME").map(PathBuf::from)
}

#[cfg(windows)]
fn home_dir() -> Option<PathBuf> {
    std::env::var_os("USERPROFILE").map(PathBuf::from)
}

/// Whether two paths name the same folder. Canonicalizes when it can, so a
/// record written through one spelling (a symlinked home, a `/tmp` that is a
/// link) still matches the other, and falls back to the literal comparison when
/// the folder is gone.
fn same_folder(a: &Path, b: &Path) -> bool {
    match (a.canonicalize(), b.canonicalize()) {
        (Ok(a), Ok(b)) => a == b,
        _ => a == b,
    }
}
