//! The *app's* own appearance as a pet window sees it, and the one write that changes it (§1's
//! 「保留现有主题、强调色」).
//!
//! **Why this is a module and not a command on `desktop_pet.rs`.** The parent had reached 814 lines
//! against the 600-line budget `docs/dev.md:286` puts on a business file, and the split is by
//! *reason to change* — the criterion that same section states. What makes this file change is the
//! app's palette: a field added to `HostAppearance`, a change to who may publish it, or a change to
//! the relay in `desktop_pet/host_appearance.rs` that holds it. The character a window draws is the
//! file next door; the windows themselves are `window_surface`.
//!
//! **Why the read and the write are one file.** They are the two halves of one channel: the value is
//! a *published* one because a pet window may not read the main window's store (§7.1; the window's
//! `app/desktop-pet-entry.test.ts` fails on an import graph that reaches `stores/`), so the read here
//! is only meaningful because the write here put something there — and a change to what is broadcast
//! has to be made in both. The relay's own rules, including why a failed emit is not an error, are
//! `desktop_pet/host_appearance.rs`'s; this file is the IPC half of them.
//!
//! **The name is the domain's, not this file's.** `desktop_pet/host_appearance.rs` already owns the
//! relay and the value it holds, so the command half is spelled the same way rather than inventing a
//! second word for the same subject.

use crate::desktop_pet::{HostAppearance, HostAppearanceWrite};
use crate::state::DesktopPetState;

use super::PET_HOST_APPEARANCE_CHANNEL;

/// The *app's* own appearance — its theme, colour scheme, accent, contrast and body size.
///
/// The other half of §1's 「保留现有主题、强调色」, and the only one of the pet's reads that is not
/// about the character. It exists because the app's appearance lives in the main window's store and
/// a pet window may not read it (§7.1; `app/desktop-pet-entry.test.ts` fails on an import graph that
/// reaches `stores/`), so what crosses is a *published* value — see
/// `desktop_pet/host_appearance.rs` for the relay and `app/pet-host-appearance-link.ts` for the
/// publisher.
///
/// No caller identity is checked, and that is deliberate rather than an omission: the permission is
/// what decides who may ask (`capabilities/desktop-pet.json` grants this to `pet-*` only, and
/// `desktop_pet_publish_host_appearance` to `main` alone), this answer holds no path, no window and
/// no character, and every pet window is entitled to the palette it is drawn in.
#[tauri::command]
pub fn desktop_pet_host_appearance(
    state: tauri::State<'_, DesktopPetState>,
) -> Result<HostAppearance, String> {
    let relay = state
        .appearance
        .lock()
        .map_err(|_| "the app's appearance could not be read: the lock was poisoned".to_string())?;
    Ok(relay.current())
}

/// The app publishes what it is drawing, and every mounted pet window hears it.
///
/// The write half, and it is a **command rather than an event** for §5.3's reason: 「事件不能作为
/// 无需授权的配置写入口」. An event is broadcast to whoever happens to listen, while this is
/// authorised per window by the ACL — `capabilities/default.json` grants it to `main` and to no
/// other window, which is exactly the shape of "only the app says what the app looks like".
///
/// Two effects, in this order, and the order is the rule: the value is stored first, so a window
/// that is created *because* of this frame reads the appearance rather than the defaults, and only
/// then is it broadcast, so a window that is already mounted moves without asking. A failed emit is
/// not an error — it means no pet window is listening, which is the state of the whole feature being
/// switched off, and the value remains readable.
///
/// The *normalised* value is what is broadcast rather than the raw write: a window must never be
/// handed something the read would not answer with, or the pushed appearance and the read one would
/// be two answers to one question.
#[tauri::command]
pub fn desktop_pet_publish_host_appearance<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    state: tauri::State<'_, DesktopPetState>,
    appearance: HostAppearanceWrite,
) -> Result<HostAppearance, String> {
    let held = {
        let mut relay = state.appearance.lock().map_err(|_| {
            "the app's appearance could not be published: the lock was poisoned".to_string()
        })?;
        relay.publish(appearance)
    };
    let _ = tauri::Emitter::emit(&app, PET_HOST_APPEARANCE_CHANNEL, held.clone());
    Ok(held)
}
