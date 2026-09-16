/**
 * The pet window's 设置, as this window hears it: one listener, one target, one release.
 *
 * §5.1's 设置定位 is two halves. The pet's right-click is the sending one — it calls
 * `desktop_pet_open_settings`, the host raises this window and confirms the page against its own
 * list, and then emits on `pet-open-settings`. This is the receiving one, and it is a file rather
 * than a handful of lines in the shell because it is a *policy* — when the listener is registered,
 * when it is released, how long a request is remembered — and because `AppShell.vue` is over the
 * 400-line rung §13.1 sets: what the shell does not itself decide moves out, which is the same cut
 * T16 made for the rail in `agent-rail.ts`.
 *
 * Three rules, and each of them is a bug the obvious version has:
 *
 *  - **Registered for the window's life, not for the dialog's.** The case the whole feature exists
 *    for is a right-click while the settings dialog is closed, so a listener that lived as long as
 *    the panel would never hear the request it is there for.
 *  - **One request, consumed by the dialog it opened.** `inputs.open` is watched: the moment the
 *    dialog goes away, the target does too. Without that, the toolbar's gear would keep opening on
 *    the pet's section for the rest of the session, because the panel reads its landing place on
 *    every mount.
 *  - **Released on unmount, including a registration that is still in flight.** `listen` resolves
 *    after an await and the window can be gone by then; a registration nobody released is a
 *    listener on a channel whose other end is still emitting.
 */

import { onBeforeUnmount, onMounted, ref, watch, type Ref } from 'vue'
import { onPetSettingsRequest } from '../platform/pet-settings-request'
import { PET_SETTINGS_SECTION } from '../platform/gateways/pet-contracts'
import type { SettingsOpenTarget } from '../features/settings'

export interface PetSettingsLinkInputs {
  /** Whether the settings dialog is on screen. The shell's own value, read when it changes. */
  open: () => boolean
  /** Ask for the dialog — the shell emits `open-settings`. This file opens nothing. */
  onOpen: () => void
}

export interface AttachedPetSettingsLink {
  /** Where the dialog was asked to open, or `null` for where it always opened. */
  readonly target: Ref<SettingsOpenTarget | null>
}

/**
 * Attach the link, from a component's setup: the listener is registered on mount and released on
 * unmount, and the target follows the dialog out.
 */
export function attachPetSettingsLink(
  inputs: PetSettingsLinkInputs,
): AttachedPetSettingsLink {
  const target = ref<SettingsOpenTarget | null>(null)
  /** Set once the listener resolves, so an unmount during registration still releases it. */
  let release: (() => void) | null = null
  let stopped = false

  onMounted(async () => {
    const off = await onPetSettingsRequest((page) => {
      // The section is named here, and once: the payload carries a page and nothing else, and
      // `PET_SETTINGS_SECTION` is the same constant the navigation rail's row is built from.
      target.value = { section: PET_SETTINGS_SECTION, page }
      inputs.onOpen()
    })
    if (stopped) off()
    else release = off
  })

  onBeforeUnmount(() => {
    stopped = true
    release?.()
    release = null
  })

  watch(inputs.open, (open) => {
    if (!open) target.value = null
  })

  return { target }
}
