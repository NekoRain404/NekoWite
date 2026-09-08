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
