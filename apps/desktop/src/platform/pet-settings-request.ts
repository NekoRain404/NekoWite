/**
 * The pet window's 设置, as the main window hears it.
 *
 * §5.1's 设置定位 has two halves and this is the receiving one: the pet's right-click calls
 * `desktop_pet_open_settings`, the host raises the main window and confirms the page against its
 * own list, and retains the request before signalling `pet-open-settings`. The listener consumes
 * pending requests after mounting and on each signal. What the main window does
 * with that — open the dialog on the pet's section, or move the section already open — is the
 * shell's business; what arrives here is only the page the user clicked, already vouched for on
 * the Rust side (`commands/desktop_pet.rs`'s `SETTINGS_PAGES`).
 *
 * The channel name is not spelled here: `tauri-pet.ts` exports `PET_SETTINGS_CHANNEL`, and the
 * section it belongs to is named once in TypeScript by `PET_SETTINGS_SECTION`. A second spelling
 * of either would be a right-click that raises a window and opens nothing.
 *
 * A page this build has no component for is *not* refused here. The pet's container falls back to
 * a page it can render and says which pages are unwired (`DesktopPetSettings.vue`), which is the
 * same rule as a page: the request was legitimate, and the answer to it belongs where the pages
 * are.
 *
 * Like `platform/open-request.ts`, this is a narrow platform adapter: outside Tauri there is no
 * such window and `listen` has nothing to register, so the caller is handed a no-op release and
 * the layers above stay free of the bridge.
 */

import { onPetNavigation } from './pet-navigation-listener'
import type { PetSettingsPage } from './gateways/pet-contracts'
import { PET_SETTINGS_CHANNEL } from './gateways/tauri-pet'

/** What the main-only consume command returns: no section, window label or URL. */
interface PetSettingsRequest {
  page: PetSettingsPage
}

/**
 * Call `cb` whenever the pet window asked the main window to open its settings.
 *
 * Resolves to the unsubscribe, or to a no-op outside Tauri, so the caller can always release what
 * it was given — the shape `onOpenFileRequest` established, for the same reason: a window that
 * unmounts must not leave a listener behind on a channel whose other end is still emitting.
 */
export async function onPetSettingsRequest(
  cb: (page: PetSettingsPage) => void,
): Promise<() => void> {
  return onPetNavigation<PetSettingsRequest>(
    PET_SETTINGS_CHANNEL, 'desktop_pet_take_settings_requests', (request) => cb(request.page),
  )
}
