/**
 * The appearance this window is drawing with, published to the pet's windows.
 *
 * §1's 「保留现有主题、强调色」 is a promise about *every* surface, and the pet's windows are the only
 * ones that cannot keep it by reading the store: they are pages of their own (§7.1), the appearance
 * lives in this window's Pinia store, and `desktop-pet-entry.test.ts` fails on an import graph that
 * reaches `stores/`. So the app says what it is drawing — this file watches the four axes and the
 * body size and publishes them (`desktop_pet_publish_host_appearance`), the host holds the value
 * (`desktop_pet/host_appearance.rs`) and every pet window reads it or hears it on
 * `pet-host-appearance`.
 *
 * It is a file rather than a handful of lines in the shell for the reason the two links beside it
 * are: it is a *policy* — when the value is published, what it is read from, what happens when the
 * publish is refused — and `AppShell.vue` is over §13.1's 400-line rung, so what the shell does not
 * itself decide moves out.
 *
 * Three rules, and each is what the obvious version gets wrong:
 *
 *  - **The *resolved* values are published, not the settings.** `effectiveAccent()` and
 *    `effectiveTheme()` are what the shell itself puts on its own root, so the pet follows the
 *    accent the user is actually looking at — including the OS-accent path, where the pick is
 *    ignored and the palette entry nearest the system colour wins. Publishing the raw settings
 *    would leave the pet resolving `followSystemAccent` on a page that cannot read the OS.
 *  - **Published on mount, not only on change.** A window that mounts while the appearance is
 *    already settled would otherwise publish nothing until the user touched it, and a pet window
 *    opened a second later would draw the defaults.
 *  - **Republished on every change, whole.** The value is five axes at once and the host replaces
 *    it whole, so a change to one axis never leaves another axis at the value of an earlier
 *    publish. There is no unsubscription because there is nothing subscribed: this is a watcher on
 *    the shell's own store, and the shell's unmount takes it with it.
 *
 * What it deliberately does not do is read the pet's settings: the bubble's own theme, alpha and
 * size belong to 气泡与消息, and a window that published *those* would be a second author of a
 * domain it has no business deciding.
 */

import { onMounted, onScopeDispose, watch } from 'vue'
import { publishPetHostAppearance } from '../platform/pet-host-appearance'
import type { PetHostAppearanceWrite } from '../platform/pet-host-appearance'

export interface PetHostAppearanceLinkInputs {
  /**
   * The appearance this window is drawing with, as the shell computes it for its own root.
   *
   * A getter rather than a value so the watcher follows the store, and the *same* getters the
   * shell's template binds — `effectiveTheme()`, `effectiveAccent()`, `colorScheme`,
   * `highContrast`, `bodyFontSize` — so there is one answer to "what is this app drawing" rather
   * than a second one computed for the pet.
   */
  appearance: () => PetHostAppearanceWrite
}

/**
 * Attach the link, from a component's setup: the first publish happens on mount, and every change
 * after it republishes the whole appearance.
 *
 * The watch is established outside `onMounted` so that a change landing during the mount turn is
 * seen rather than dropped; the mount-time publish is what covers the state that was already there.
 */
export function attachPetHostAppearanceLink(inputs: PetHostAppearanceLinkInputs): void {
  let stopped = false

  function publish(): void {
    if (stopped) return
    void publishPetHostAppearance(inputs.appearance())
  }

  watch(() => inputs.appearance(), publish)
  onMounted(publish)
  onScopeDispose(() => {
    stopped = true
  })
}
