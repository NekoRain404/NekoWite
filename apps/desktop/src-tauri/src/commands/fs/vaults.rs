//! Vault registration: the command that records the root the user opened.
//!
//! **This file was split out of `commands/fs.rs`.** One subject: turning "the user picked this
//! folder" into "the backend will serve this root for the rest of the session, and remember it for
//! the next launch". It changes when the authority behind that sentence changes — the remembered
//! vault, the pick the dialog proved, the canonicalization rule — and not when a command that
//! writes a note changes.
//!
//! It is the security-relevant half of this module, so its long comment survives the move verbatim:
//! what makes a root servable is not the call, it is that the USER chose it.

use crate::state::{remember_vault, remembered_vault, VaultRegistry};

/// Register a vault root the user opened. Call this right after the user picks
/// a vault (folder dialog) or restores a previously opened one, BEFORE any
/// path-confined command, so the backend will serve it. This is the authority
/// that lets path-confined commands distinguish "a vault the user opened" from
/// arbitrary absolute paths.
///
/// The authority is not the call itself. A path arrives here from the window,
/// so the window could ask for `/etc` as easily as for the user's notes; what
/// makes a root servable is that the USER chose it — in the native folder
/// dialog this session, or as the vault the backend recorded last time
/// ([`remembered_vault`]). A root that is neither is refused, and the root that
/// gets through is recorded for the next launch.
#[tauri::command(rename_all = "snake_case")]
pub fn register_vault(
    vault_root: String,
    state: tauri::State<'_, VaultRegistry>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let remembered = remembered_vault(&app);
    let canonical = state.register(&vault_root, remembered.as_deref())?;
    // Only a root that got through `register` is written down, so the record
    // can never vouch for a root this function refused.
    remember_vault(&app, &canonical);
    Ok(())
}
