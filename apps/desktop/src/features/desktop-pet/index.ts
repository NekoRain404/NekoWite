/**
 * The desktop pet feature's public API (§13.11, §9).
 *
 * Nothing outside this feature imports one of its files by path: the window's entry
 * (`app/desktop-pet-entry.ts`) mounts {@link DesktopPetRoot} through this module, and the
 * composition (`app/desktop-pet-composition.ts`) takes the menu actions from it — so the internal
 * layout can change without touching a call site.
 *
 * **The list is deliberately short, and it is a decision rather than a `export *`.** This module
 * is in the pet window's bundle, and `app/desktop-pet-entry.test.ts` walks that bundle's import
 * graph and compares it with a list somebody chose — so a name added here is a name the window
 * carries. What is *not* here is the feature's parts that only its own components use (the
 * bubble, the task list, the sprite, the roam and rendering pipeline): they are already reachable
 * from the root that draws them, and re-exporting them would say they are an API.
 */
export { default as DesktopPetRoot } from './components/DesktopPetRoot.vue'

// The care surface (D10). It is here because its caller is *outside* this feature — the settings
// care page draws it from `CareSummary`, the shape the ledger settles — and §13.11 sends that
// caller through this module rather than through the component's path. It is the largest thing
// this entry carries: the panel and the rules it renders from. What the pet *window* loads is
// unaffected, because the window's graph reaches `DesktopPetRoot` and the menu actions and
// references no care panel — Rollup drops the rest, and `desktop-pet-entry.test.ts` lists the
// sources so the day something in that window does draw one, it is a change to that list.
export { default as PetCarePanel } from './components/PetCarePanel.vue'
export {
  PET_CARE_PANEL_LABELS,
  petCareProgress,
  type PetCareImportResult,
  type PetCarePanelLabels,
  type PetCareProgress,
} from './services/pet-care-rules'

export { usePetLifecycle } from './composables/use-pet-lifecycle'
export type {
  PetHold,
  PetHoldScope,
  PetLifecycle,
  PetLifecycleCounts,
  PetLifecycleOptions,
  PetWindowState,
} from './composables/use-pet-lifecycle'

// The character library's reading (D8), for the settings page that chooses one: `readPetLibrary`
// turns the host's list and the user's stored choice into the rows, the selection and the notices
// a page draws. It is here for the same reason the care surface is: its caller is outside this
// feature, and §13.11 sends that caller through this module rather than through a path.
export { PET_CHARACTER_NAME_LIMIT, readPetLibrary } from './services/pet-library-policy'
export type {
  PetInstalledCharacter,
  PetLibraryNotice,
  PetLibraryReading,
  PetLibraryRow,
  PetLibraryState,
  PetSelection,
} from './services/pet-library-policy'

export { PET_MENU_PAD, placePetMenu } from './services/pet-context-menu'
export type {
  PetMenuAction,
  PetMenuPlacement,
  PetMenuPlacementInput,
} from './services/pet-context-menu'

export { actOnPetMenu } from './services/pet-menu-actions'
export type { PetMenuOutcome } from './services/pet-menu-actions'
