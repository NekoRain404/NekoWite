/**
 * The desktop pet's settings feature: the one module the settings panel imports.
 *
 * §10.1 gives `features/settings` the pet's section id and its rail entry and gives this feature
 * the section's body, so what crosses that boundary is one component and one prop. What the
 * settings side writes, in full:
 *
 * ```html
 * <DesktopPetSettingsSection :gateway="petGateway" v-model:page="petPage" />
 * ```
 *
 * with `petGateway` from `app/desktop-pet-composition.ts` and `petPage` a `PetSettingsPage`. The
 * section fills the container's five slot pages itself, so the panel never learns that §5.1 has
 * seven sub-pages or that five of them are somebody else's components.
 *
 * `DesktopPetSettings` (the container, without the slots) is exported too, for a caller that wants
 * the rail and the preview without the pages — a test, or a future sub-page. It is not the way in
 * from the settings panel: an unfilled container offers two of §5.1's seven pages and says so,
 * which is the right state for a test and the wrong one for a shipped section.
 */
export { default as DesktopPetSettingsSection } from './components/DesktopPetSettingsSection.vue'
export { default as DesktopPetSettings } from './components/DesktopPetSettings.vue'
export type { PetSettingsContext, PetSettingsSessions } from './components/DesktopPetSettings.vue'

export { usePetSettings } from './composables/use-pet-settings'
export type { PetSettingsSession } from './composables/use-pet-settings'
