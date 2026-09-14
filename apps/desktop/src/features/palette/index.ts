/**
 * The palette feature's public API.
 *
 * The panel itself is not in this directory: it is `ui/CommandPalette.vue`,
 * mounted once by the app shell beside the other global surfaces and kept at
 * that path. Everything it needs from the feature comes through here rather
 * than by deep path (§13.11), so the internal layout — composables, services,
 * components, styles — stays free to change.
 *
 * What it does not re-export is just as deliberate: the group ordering and the
 * scoring in `services/commandPaletteLogic.ts` are reached only through the
 * entries composable, and the listbox's own props are its own business.
 */

export { default as PaletteList } from './components/PaletteList.vue'
export { usePaletteEntries } from './composables/usePaletteEntries'
export { usePaletteNavigation } from './composables/usePaletteNavigation'
export { PALETTE_LIST_ID, paletteItemId } from './types'
export type { PaletteGroupRows, PaletteRow } from './types'
export type { PaletteEntry } from './services/commandPaletteLogic'
