//! Opening a file the operating system handed this process.
//!
//! `nekowite notes.md`, and a `.md` double-clicked in a file manager, arrive the
//! same way: as a path in this process's `argv` — on the first launch from
//! `std::env::args`, on every later one from the single-instance plugin's
//! callback, which is where a second launch's arguments end up.
//!
//! Neither is a path the window asked for, and that is the point. A path the OS
//! handed the process is a fact the renderer cannot manufacture, which is the
//! same standing a folder-dialog pick has; so it is vouched for through the same
//! gate ([`VaultRegistry::approve_launch_root`]) instead of one of its own. The
//! window never receives a bare path to open: "which vault does this belong to,
//! and may we serve it?" is answered here, where the evidence is, and the window
//! is handed the answer.

use std::ffi::OsStr;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use crate::domain::path_policy::ipc_path;
use crate::errors::fs_error;
use crate::state::{remembered_vault, VaultRegistry};

/// Rung when a request is waiting. The event is a doorbell, not the payload:
/// see [`PendingOpen`] for why the request travels through state instead.
pub const OPEN_FILE_EVENT: &str = "open-file-request";

/// The extensions this app edits. They mirror `bundle.fileAssociations` in
/// `tauri.conf.json`: an association the desktop environment can route to us but
/// this list does not recognise would be a file manager opening the app on a
/// file the app then ignores.
pub const MARKDOWN_EXTENSIONS: [&str; 3] = ["md", "markdown", "mdx"];

/// What the window should do about a file the OS named on the command line.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum OpenFileRequest {
    Open {
        /// Absolute, canonical path of the file to open.
        path: String,
        /// The vault root it belongs to. Always a root the backend vouches for:
        /// one this session already opened, or — for a file inside none of them
        /// — the file's own folder, recorded as the user's choice by
        /// [`VaultRegistry::approve_launch_root`].
        root: String,
        /// The file already belongs to the vault the window has open, or to the
        /// one startup is about to restore. Nothing about the vault changes, so
        /// the tab opens into the session the user was already in.
        same_vault: bool,
    },
    /// The path cannot be opened and `message` says why. A refusal that explains
    /// itself is a better answer than opening the wrong folder in silence.
    Refused {
        message: String,
    },
}

/// The request waiting for the window to collect it.
///
/// A first launch leaves it here because there is no window yet; a second launch
/// leaves it here because the doorbell it also rings can arrive before the
/// window's listener is armed (a double-click while the app is still starting).
/// Either way the window collects the request when it is ready to act on it, and
/// the event only tells it that there is something to collect. Collecting is
/// what empties the slot, so the two triggers can never carry out one request
/// twice.
#[derive(Default)]
pub struct PendingOpen(Mutex<Option<OpenFileRequest>>);

impl PendingOpen {
    /// Leave `request` for the window, replacing one still waiting: the last
    /// file the user named is the one they mean, and letting two requests queue
    /// up would start two vault switches, which the frontend resolves
    /// latest-wins anyway.
    pub fn store(&self, request: OpenFileRequest) {
        if let Ok(mut slot) = self.0.lock() {
            *slot = Some(request);
        }
    }

    /// Take the waiting request, if any. A given request is handed out once.
    pub fn take(&self) -> Option<OpenFileRequest> {
        self.0.lock().ok().and_then(|mut slot| slot.take())
    }
}

/// Handle one launch: resolve the file those arguments name, leave the request
/// for the window and ring the doorbell. A launch that names no markdown file —
/// the ordinary case — does nothing at all.
pub fn handle_launch<S: AsRef<OsStr>>(
    app: &AppHandle,
    args: impl IntoIterator<Item = S>,
    cwd: &Path,
) {
    let Some(request) = request_for(app, args, cwd) else {
        return;
    };
    app.state::<PendingOpen>().store(request);
    let _ = app.emit(OPEN_FILE_EVENT, ());
}

/// The request `args` amount to, or `None` when they name no markdown file.
pub fn request_for<S: AsRef<OsStr>>(
    app: &AppHandle,
    args: impl IntoIterator<Item = S>,
    cwd: &Path,
) -> Option<OpenFileRequest> {
    let file = markdown_arg(args, cwd)?;
    Some(match resolve(app, &file) {
        Ok((path, root, same_vault)) => OpenFileRequest::Open {
            path,
            root,
            same_vault,
        },
        Err(message) => OpenFileRequest::Refused { message },
    })
}

/// The markdown file an argument list names, if any.
///
/// `args` is a whole `argv`, so its first entry — the program's own path — is
/// skipped. Anything that is not a markdown-looking path is ignored in silence:
/// a launcher passes its own flags through `argv`, and a complaint about
/// `--no-sandbox` would be noise the user cannot act on. A path that DOES name a
/// markdown file is different — there the user asked for something specific, so
/// a failure to open it is reported rather than swallowed.
pub fn markdown_arg<S: AsRef<OsStr>>(
    args: impl IntoIterator<Item = S>,
    cwd: &Path,
) -> Option<PathBuf> {
    args.into_iter().skip(1).find_map(|arg| {
        let path = Path::new(arg.as_ref());
        if !has_markdown_extension(path) {
            return None;
        }
        // A file manager hands over an absolute path (the desktop entry's `%f`);
        // a terminal need not. `cwd` is the directory the launch happened in,
        // which the plugin passes for exactly this.
        Some(if path.is_absolute() {
            path.to_path_buf()
        } else {
            cwd.join(path)
        })
    })
}

/// Whether `path` names a file this app edits. Case-insensitive: the extension
/// is spelled by whoever created the file, and `Notes.MD` is the same document
/// as `notes.md`.
fn has_markdown_extension(path: &Path) -> bool {
    path.extension()
        .and_then(OsStr::to_str)
        .is_some_and(|ext| {
            MARKDOWN_EXTENSIONS
                .iter()
                .any(|known| ext.eq_ignore_ascii_case(known))
        })
}

/// Which vault `file` belongs to, and the canonical path to open.
///
/// Returns `(path, root, same_vault)` in the same spelling the window is given.
fn resolve(app: &AppHandle, file: &Path) -> Result<(String, String, bool), String> {
    // Canonicalizing is what makes the containment check below mean anything:
    // `..`, a symlinked home and a second spelling of one folder all have to
    // collapse to one answer before a root can be compared against the file.
    let canonical = file
        .canonicalize()
        .map_err(|e| fs_error("open the file", file, e))?;
    if !canonical.is_file() {
        return Err(format!(
            "{} is not a file, so there is nothing to open",
            ipc_path(&canonical)
        ));
    }
    if let Some(root) = vault_already_holding(app, &canonical) {
        return Ok((ipc_path(&canonical), ipc_path(&root), true));
    }
    // Outside every vault we know: the file's own folder becomes the vault, so
    // the document opens in the folder it lives in rather than nowhere.
    let parent = canonical
        .parent()
        .ok_or_else(|| format!("{} has no folder to open as a vault", ipc_path(&canonical)))?;
    let root = app
        .state::<VaultRegistry>()
        .approve_launch_root(&ipc_path(parent))?;
    Ok((ipc_path(&canonical), ipc_path(&root), false))
}

/// The vault root `file` already sits inside, if the backend knows one.
///
/// Two roots count, and both are ones the window is about to have open: a root
/// the user opened this session, and the root the backend recorded last time —
/// which is what startup restores, so a file inside it must not move the vault
/// the user was already working in. Both sides are canonical here, so a
/// symlinked home or a trailing slash does not turn one folder into two.
fn vault_already_holding(app: &AppHandle, file: &Path) -> Option<PathBuf> {
    let registry = app.state::<VaultRegistry>();
    if let Some(root) = registry.containing_opened_vault(file) {
        return Some(root);
    }
    let remembered = remembered_vault(app)?.canonicalize().ok()?;
    (remembered.is_dir() && file.starts_with(&remembered)).then_some(remembered)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cwd() -> PathBuf {
        PathBuf::from("/home/user")
    }

    #[test]
    fn the_program_path_is_never_read_as_a_file() {
        // `argv[0]` is the binary. It is named `nekowite`, but a build or a
        // wrapper script could make it anything — `notes.md` even — and opening
        // the executable as a note is not a defensible thing to do.
        let args = vec!["notes.md"];
        assert_eq!(markdown_arg(args, &cwd()), None);
    }

    #[test]
    fn a_relative_argument_resolves_against_the_launch_directory() {
        let args = vec!["nekowite", "notes.md"];
        assert_eq!(
            markdown_arg(args, &cwd()),
            Some(PathBuf::from("/home/user/notes.md"))
        );
    }

    #[test]
    fn an_absolute_argument_is_used_as_it_arrives() {
        let args = vec!["nekowite", "/tmp/notes.md"];
        assert_eq!(
            markdown_arg(args, &cwd()),
            Some(PathBuf::from("/tmp/notes.md"))
        );
    }

    #[test]
    fn every_associated_extension_is_a_markdown_file() {
        for name in ["a.md", "a.markdown", "a.mdx", "A.MD", "a.Markdown"] {
            let args = vec!["nekowite", name];
            assert!(
                markdown_arg(args, &cwd()).is_some(),
                "{name} is one of the extensions this app edits"
            );
        }
    }

    #[test]
    fn flags_and_unrelated_files_are_ignored_without_a_word() {
        // A launcher passes its own arguments through; complaining about them
        // would be noise. `README.txt` is not ours to open either.
        let args = vec!["nekowite", "--no-sandbox", "README.txt", "/tmp/x.Genesis"];
        assert_eq!(markdown_arg(args, &cwd()), None);
    }

    #[test]
    fn the_first_markdown_argument_wins() {
        let args = vec!["nekowite", "--flag", "one.md", "two.md"];
        assert_eq!(
            markdown_arg(args, &cwd()),
            Some(PathBuf::from("/home/user/one.md"))
        );
    }

    #[test]
    fn a_later_request_replaces_one_still_waiting() {
        let pending = PendingOpen::default();
        let open = |path: &str| OpenFileRequest::Open {
            path: path.to_string(),
            root: "/home/user/notes".to_string(),
            same_vault: false,
        };
        pending.store(open("one.md"));
        pending.store(open("two.md"));
        assert_eq!(pending.take(), Some(open("two.md")));
    }

    #[test]
    fn a_request_is_handed_out_exactly_once() {
        // The startup pull and the doorbell both take; whichever asks second
        // must find nothing rather than open the file a second time.
        let pending = PendingOpen::default();
        pending.store(OpenFileRequest::Refused {
            message: "nope".to_string(),
        });
        assert!(pending.take().is_some());
        assert_eq!(pending.take(), None);
    }
}
