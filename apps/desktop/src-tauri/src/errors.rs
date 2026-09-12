//! Shared, user-facing error helpers.
//!
//! Every command returns `Result<_, String>`; the strings here are the few
//! messages that cross more than one module, so they live in a single place
//! rather than being re-derived. Error CODES are unchanged — this is purely a
//! message-assembly helper, embedded in the `String` error a command returns.

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
