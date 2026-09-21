//! The write protocol: the revision a document's bytes hash to, what a write did, and the atomic
//! replace that puts new bytes on disk.
//!
//! It changes when the write/rollback protocol changes — the temporary sibling a write stages
//! through, the mode it creates with, the rename and the directory sync that follow. Nothing here
//! reads a document or decides what an edit means; it is the last step of `apply_claim` and the
//! vocabulary that step answers with.

use std::fmt;
use std::fs;
use std::io::Write as _;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};

use sha2::{Digest, Sha256};

use super::document::ConfigDocument;
use super::error::ConfigError;

/// The mode a document this host creates is written with: owner read and write, nothing else.
///
/// §8.1's 「受管目录和敏感文件使用最小文件权限」, and it is not only the credential file that needs
/// it — a provider block in an engine's configuration holds a key just as often.
pub const DOCUMENT_MODE: u32 = 0o600;

/// Names the temporary sibling a write stages through. A counter and the pid are enough: two live
/// processes cannot share a pid, and the counter separates calls within one.
static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

/// The identity of the bytes a document was read from: their SHA-256, in lowercase hex.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct Revision(String);

impl Revision {
    pub fn of(text: &str) -> Self {
        let mut hasher = Sha256::new();
        hasher.update(text.as_bytes());
        Self(format!("{:x}", hasher.finalize()))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }

    /// The revision a caller claims, when it arrives as text from outside this process.
    ///
    /// Only ever compared, so what a caller sends must at least have the shape this host issues —
    /// and a token that does not is refused at the boundary rather than compared and reported as a
    /// conflict, because those are two different things for a user to act on: "someone else changed
    /// this" and "this form was not built from a document at all".
    pub fn parse(value: &str) -> Option<Self> {
        let well_formed = value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit());
        well_formed.then(|| Self(value.to_ascii_lowercase()))
    }
}

/// What a write did.
pub enum WriteOutcome {
    /// The bytes are on disk, under this revision.
    Written { revision: Revision },
    /// The document is not the one the caller read, so nothing was written. `current` is what is
    /// there now — the caller reloads and rebuilds its edit from it. `None` means there is no
    /// document there now: the one the caller read was removed, or the caller read none and there
    /// is still none to write into.
    Conflicted { current: Option<ConfigDocument> },
}

/// Hand-written, because a derived one would print `current`'s text: the document this module is
/// careful never to print, and the one that can hold a credential.
impl fmt::Debug for WriteOutcome {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            WriteOutcome::Written { revision } => f.debug_tuple("Written").field(revision).finish(),
            WriteOutcome::Conflicted { current } => f
                .debug_tuple("Conflicted")
                .field(&current.as_ref().map(ConfigDocument::revision))
                .finish(),
        }
    }
}

/// Replaces a file's bytes, atomically and with [`DOCUMENT_MODE`].
///
/// Staged through a temporary sibling in the same directory and renamed, so no reader ever sees a
/// half-written document and a failure leaves the original in place. A file that is already there
/// keeps the mode it has: this host sets the mode of what it creates, and tightening a user's file
/// behind their back is not a configuration edit.
pub(crate) fn write_replacing(path: &Path, text: &str) -> Result<(), ConfigError> {
    let mode = existing_mode(path).unwrap_or(DOCUMENT_MODE);
    write_replacing_with_mode(path, text, mode)
}

/// Replaces a file the host owns **and sets its mode**, whether or not it was already there.
///
/// The sibling of [`write_replacing`] for the one document whose permissions are a *claim this app
/// makes to the user*: the settings page renders `CredentialStorage`'s `mode` — `DOCUMENT_MODE`,
/// spelled `"600"` — so a writer that preserved whatever mode the file happened to have made that
/// sentence false. A `credentials.json` at `0644` — copied, restored from a backup, written by a
/// build that did not set it — stayed readable by every account on the machine while the page said
/// otherwise (finding S7 in `docs/audits/2026-09-21-code-review.md`).
///
/// The engine's own configuration document keeps the preserving behaviour, and that is the reason
/// this is a second function rather than a changed default: the file belongs to the user, this host
/// is a guest in it, and tightening it behind their back is not a configuration edit.
pub(crate) fn write_replacing_private(path: &Path, text: &str) -> Result<(), ConfigError> {
    write_replacing_with_mode(path, text, DOCUMENT_MODE)
}

/// The mode a file already has, if it is there and readable.
fn existing_mode(path: &Path) -> Option<u32> {
    use std::os::unix::fs::PermissionsExt;

    fs::metadata(path)
        .ok()
        .map(|meta| meta.permissions().mode() & 0o777)
}

/// The one write both entry points above go through: the mode is the temp file's, which is what the
/// rename puts in place — a new file gets it, and a file that was there is *replaced by* it.
fn write_replacing_with_mode(path: &Path, text: &str, mode: u32) -> Result<(), ConfigError> {
    use std::os::unix::fs::OpenOptionsExt;

    let io = |message: String| ConfigError::Io {
        path: path.to_path_buf(),
        message,
    };
    let parent = path
        .parent()
        .ok_or_else(|| io("the path has no directory".into()))?;
    fs::create_dir_all(parent).map_err(|error| io(error.to_string()))?;
    let temp = parent.join(format!(
        ".nekowite-config-{}-{}.tmp",
        std::process::id(),
        TEMP_COUNTER.fetch_add(1, Ordering::Relaxed)
    ));
    let staged = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(mode)
        .open(&temp)
        .and_then(|mut file| {
            file.write_all(text.as_bytes())
                .and_then(|()| file.sync_all())
        })
        .and_then(|()| fs::rename(&temp, path));
    if let Err(error) = staged {
        let _ = fs::remove_file(&temp);
        return Err(io(error.to_string()));
    }
    // The rename is what makes the new bytes visible; fsyncing the directory is what makes it
    // survive a power loss, since the directory's entry list is a separate write from the file's.
    fs::File::open(parent)
        .and_then(|directory| directory.sync_all())
        .map_err(|error| io(error.to_string()))
}
