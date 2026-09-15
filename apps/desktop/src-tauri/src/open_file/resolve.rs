//! Where a path the OS handed this process is allowed to point.
//!
//! Split out of `open_file` because it is the one part of the launch path that
//! is a DECISION rather than plumbing: the arguments arrive in the parent
//! module, and what they are worth is decided here. It knows nothing about
//! events, windows or `AppHandle` — it takes the registry and the record
//! startup restores, so every question below can be asked without an app to run
//! it in, which is how the tests for it are written.
//!
//! The whole of its policy is one distinction, and it is about evidence. A
//! launch's argument is evidence about a FILE — that someone asked for this
//! document — and never about a workspace. So the folder a launch may adopt is
//! the one the argument names, the vault a file belongs to is the one it LIVES
//! in, and a folder that can never be a vault is refused as a folder while the
//! file that led here is still what the user is told about.

use std::path::{Path, PathBuf};

use crate::domain::path_policy::ipc_path;
use crate::errors::fs_error;
use crate::state::VaultRegistry;

use super::LaunchChannel;

/// Which vault `file` belongs to, and the path to open.
///
/// Both things that can vouch for a root are passed in rather than read from an
/// app — the registry, and the record startup restores — so what the decision
/// does for either channel can be asked without an app to run it in.
///
/// Returns `(path, root, same_vault)` in the same spelling the window is given.
/// `same_vault: false` is not a detail of the answer but the whole of it: it
/// says the root is a folder this launch ADOPTED for the document, not a vault
/// of the user's, and the window reads it as such — it serves the file and
/// leaves the workspace where the user left it. Every branch below that returns
/// it is one where `approve_launch_root` just recorded the folder, and the bus
/// channel never reaches one.
pub fn resolve_launch(
    registry: &VaultRegistry,
    remembered: Option<&Path>,
    file: &Path,
    channel: LaunchChannel,
) -> Result<(String, String, bool), String> {
    // The file is judged where it LIVES. Canonicalizing it outright is what
    // let a `.md` symlink inside the vault answer for its target: the link
    // collapsed to a path in `~/.ssh`, the containment check below asked about
    // that folder instead, and the folder was adopted as the vault root —
    // putting every path-confined command inside a directory the user never
    // chose, reached by nothing worse than a note with a link in it.
    let located = locate(file)?;
    // The file itself is followed only to answer "is there a document here",
    // which is a question about the thing the OS named and not about its vault.
    let resolved = located
        .canonicalize()
        .map_err(|e| fs_error("open the file", file, e))?;
    if !resolved.is_file() {
        return Err(format!(
            "{} is not a file, so there is nothing to open",
            ipc_path(&resolved)
        ));
    }
    if let Some(root) = vault_already_holding(registry, remembered, &located) {
        return Ok((ipc_path(&located), ipc_path(&root), true));
    }
    // Outside every vault we know. Whether that may BECOME one is the one thing
    // the two channels disagree about, so it is decided here, beside the gate it
    // guards, rather than left to a caller to remember: the folder's path is the
    // caller's, and on the bus the caller is anyone of this user.
    let folder = located
        .parent()
        .ok_or_else(|| format!("{} has no folder to open as a vault", ipc_path(&located)))?;
    if !channel.may_create_root() {
        return Err(unservable_bus_launch(&located, folder));
    }
    // A first launch: the file's own folder becomes the vault, so the document
    // opens in the folder it lives in rather than nowhere. It is the folder the
    // ARGUMENT names — the one the link or the plain path sits in — and the
    // refusal, if the folder is one that can never be a vault, is written about
    // the file that led here.
    let root = registry.approve_launch_root(&located, &ipc_path(folder))?;
    Ok((ipc_path(&located), ipc_path(&root), false))
}

/// The path `file` names, with its own folder resolved and its last segment NOT
/// followed.
///
/// The folder is canonicalized because `..`, a relative spelling, a symlinked
/// home and `/tmp` being a link all have to collapse to one answer before a
/// root can be compared against a file at all. The last segment is left alone
/// on purpose: whether a name is a symlink is a fact about the file, and the
/// containment question below is about the folder the file sits in. Following
/// it there is what made a link the door to its target's directory.
fn locate(file: &Path) -> Result<PathBuf, String> {
    // No final name at all means the argument is `/` (or a Windows drive
    // root): a folder, refused by the `is_file` check with the message that
    // says so, and there is no last segment to leave unfollowed.
    let Some(name) = file.file_name() else {
        return file
            .canonicalize()
            .map_err(|e| fs_error("open the file", file, e));
    };
    let folder = match file.parent() {
        Some(folder) if !folder.as_os_str().is_empty() => folder,
        // A bare name has no folder in it. `markdown_arg` joins the launch
        // directory on before it gets here, so this is only reachable from a
        // caller that skipped that — and then `.` is what a bare name means.
        _ => Path::new("."),
    };
    Ok(folder
        .canonicalize()
        .map_err(|e| fs_error("open the file", file, e))?
        .join(name))
}

/// The refusal a second launch gets for a file outside every known vault.
///
/// The request is a legitimate one made through a channel that cannot vouch for
/// it, so the message names both ways to have it served: the folder dialog,
/// whose pick the backend does accept, and a launch that starts the process,
/// whose own `argv` is the evidence this channel never is.
fn unservable_bus_launch(file: &Path, folder: &Path) -> String {
    format!(
        "refusing to open {}: it is not inside a vault NekoWite has open or \
         remembers, and a file named by a second launch cannot open a new one — \
         those arguments arrive over the session bus, where any program running \
         as you can send anything. Open {} with \"Open folder\" to make it the \
         vault, or quit NekoWite and open the file again: a launch that starts \
         the app reads the path from its own command line, and may adopt the \
         folder.",
        ipc_path(file),
        ipc_path(folder)
    )
}

/// The vault root `file` already sits inside, if the backend knows one.
///
/// Two roots count, and both are ones the window is about to have open: a root
/// the user opened this session, and the root the backend recorded last time —
/// which is what startup restores, so a file inside it must not move the vault
/// the user was already working in. Both sides are canonical here, so a
/// symlinked home or a trailing slash does not turn one folder into two.
///
/// `file` is the path [`locate`] produced, not a canonicalized one: a link
/// inside the vault is inside the vault, whichever document it points at. It is
/// also the whole of what a second launch is allowed to do, which is why it
/// takes no channel: every root it can reach is one that already exists.
fn vault_already_holding(
    registry: &VaultRegistry,
    remembered: Option<&Path>,
    file: &Path,
) -> Option<PathBuf> {
    if let Some(root) = registry.containing_opened_vault(file) {
        return Some(root);
    }
    let remembered = remembered?.canonicalize().ok()?;
    (remembered.is_dir() && file.starts_with(&remembered)).then_some(remembered)
}
