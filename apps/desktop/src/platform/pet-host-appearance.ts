/**
 * The app's own appearance, published to the host so the pet's windows can draw it (§1's
 * 「保留现有主题、强调色」).
 *
 * The missing half of the same sentence `platform/pet-settings-request.ts` and
 * `platform/pet-task-request.ts` are the other halves of: those two are *inbound* — a pet window
 * asks this one to do something — and this is outbound, the one thing this window says to the pet.
 * What crosses is five axes (a theme member, two `palettes.css` names, a switch and a length) and
 * nothing else: no colour is resolved here and no settings document is handed over, because the
 * colours belong to a stylesheet both pages load and the document belongs to this window.
 *
 * **Why a command and not an event.** §5.3's 「事件不能作为无需授权的配置写入口」: an event is
 * broadcast to whatever happens to listen, while this is authorised per window by the ACL —
 * `capabilities/default.json` grants `desktop_pet_publish_host_appearance` to `main` alone, so a
 * pet window cannot claim an appearance the user did not choose. The *push* that follows (the host
 * relaying the stored value on `pet-host-appearance`) is a read of state the host already holds,
 * and that is on the pet side (`tauri-pet.ts`'s `PET_HOST_APPEARANCE_CHANNEL`).
 *
 * **A refusal is not a state.** A browser build answers every command its stub does not know with a
 * rejection, and a host that refuses this one leaves the pet's windows on the app's own defaults —
 * which is what they drew before any of this crossed, and is a palette rather than a broken pet. So
 * the failure is swallowed here rather than reported on screen: there is no affordance in this
 * window for "the pet could not be told your accent", the next change republishes anyway, and a
 * warning per change would be noise in a console the app's own specs assert is clean.
 */

import { invoke } from '@tauri-apps/api/core'

/**
 * What this window publishes about itself, in the wire's spelling.
 *
 * Every field is a *member* or a number and never a resolved value: `theme` is the app's setting
 * (the engine decides what `system` comes to on each page, which is why a page may resolve it for
 * itself), and the two names are `palettes.css`'s. The host holds exactly these five and answers
 * them back to the pet's windows.
 */
export interface PetHostAppearanceWrite {
  theme: string
  colorScheme: string
  accent: string
  highContrast: boolean
  bodyFontSize: number
}

/** Publish one appearance. Resolves when the host has stored and relayed it. */
export async function publishPetHostAppearance(
  appearance: PetHostAppearanceWrite,
): Promise<void> {
  try {
    await invoke('desktop_pet_publish_host_appearance', { appearance })
  } catch {
    // See the header: "the pet was not told" is not something this window can draw, and the value
    // is republished on the next change — and at every start.
  }
}
