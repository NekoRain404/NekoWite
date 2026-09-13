//! Shared, user-facing error helpers.
//!
//! Every command returns `Result<_, String>`; the strings here are the few
//! messages that cross more than one module, so they live in a single place
//! rather than being re-derived. Error CODES are unchanged — this is purely a
//! message-assembly helper, embedded in the `String` error a command returns.

use std::io;
use std::path::Path;

/// The error (with a recovery hint) returned when a `vault_root` was never
/// opened by the user. Raised by [`crate::state::VaultRegistry::authorize`] and
/// therefore surfaced by `require_opened_vault` on every path-confined command.
pub fn vault_root_unauthorized_error(root: &str) -> String {
    format!(
        "vault root is not open: {root}. \
         The backend only serves paths inside a vault the user actually opened. \
         Open the vault with register_vault (or pick it again with the folder dialog) before using it."
    )
}

/// Prefix that marks "the destination already exists".
///
/// A create-only write (`create_new_file`) is racing another writer by
/// definition: the file appearing between "is this name free?" and "write it"
/// is an ordinary outcome the caller handles by picking the next name, not an
/// error to show. The prefix lets the frontend tell the two apart without
/// parsing an OS message, and is stripped before anything reaches the user.
pub const ALREADY_EXISTS_PREFIX: &str = "EEXIST: ";

/// The error returned when a create-only write found the name taken.
pub fn file_exists_error(path: &str) -> String {
    format!("{ALREADY_EXISTS_PREFIX}{path} already exists")
}

/// The user-facing message for a failed filesystem operation.
///
/// A bare `e.to_string()` produced sentences like "cannot create the file when
/// it already exists (os error 183)" with no indication of WHICH file or WHICH
/// operation - unusable for a user trying to fix something, and equally useless
/// in a bug report. Every message names the operation and the path, then maps
/// the OS error kind to a plain-language reason (with the raw OS code kept in
/// parentheses) so "os error 5" never arrives alone.
pub fn fs_error(action: &str, path: &Path, e: io::Error) -> String {
    format!(
        "could not {action} {}: {}",
        crate::domain::path_policy::ipc_path(path),
        io_reason(&e)
    )
}

/// Plain-language reason for an OS failure, with the raw code kept after it.
///
/// Only the kinds a user can act on get a mapped phrase. Everything else keeps
/// the raw OS sentence: it is the most precise description available, and the
/// `could not {action} {path}:` lead has already made it readable.
fn io_reason(e: &io::Error) -> String {
    // The raw code is what makes a bug report diagnosable; the phrase in front
    // is what the user can act on.
    let reason = |phrase: &str| match e.raw_os_error() {
        Some(code) => format!("{phrase} (os error {code})"),
        None => phrase.to_string(),
    };
    match e.kind() {
        io::ErrorKind::NotFound => reason("no such file or folder"),
        io::ErrorKind::PermissionDenied => format!(
            "{}; close whatever is using it, or check that you are allowed to read it",
            reason("permission denied")
        ),
        io::ErrorKind::AlreadyExists => reason("it already exists"),
        io::ErrorKind::IsADirectory => reason("that is a folder, not a file"),
        io::ErrorKind::NotADirectory => reason("that is a file, not a folder"),
        // Windows reports a file another process holds open as a sharing or
        // lock violation; the OS sentence for those is localised (and maps to
        // `Uncategorized`), so a bug report carries mojibake instead of a
        // reason. Name the situation instead. These codes are Windows-only
        // and mean EPIPE/EDOM on unix, so the mapping must not run there.
        _ if cfg!(windows) && matches!(e.raw_os_error(), Some(32) | Some(33)) => {
            reason("another program is using it")
        }
        _ => e.to_string(),
    }
}
