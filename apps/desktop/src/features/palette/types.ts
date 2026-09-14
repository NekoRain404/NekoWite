/**
 * What the palette's parts share (§13.9).
 *
 * `PaletteEntry` and the functions that rank it stay in
 * `services/commandPaletteLogic.ts`, which is the pure matching code. What is
 * here is what the *rendered* palette adds on top of an entry: the flat row
 * numbering a highlight is addressed by, the two labelled groups the listbox
 * draws, and the id wiring that ties the search field to that listbox.
 */

import type { PaletteEntry, PaletteKind } from './services/commandPaletteLogic'

/** A row as rendered: the entry plus the index the arrow keys move through it
 *  by, and the index `aria-activedescendant` points at. */
export interface PaletteRow {
  entry: PaletteEntry
  index: number
}

export interface PaletteGroupRows {
  key: PaletteKind
  label: string
  entries: PaletteRow[]
}

/**
 * The listbox id, and the id scheme for its options.
 *
 * The field that owns the highlight and the list that renders it are two
 * components (§13.3), and they have to agree on these strings for the combobox
 * to announce anything at all: the input names the list through `aria-controls`
 * and the highlighted option through `aria-activedescendant`, while the option
 * ids are minted next to the buttons. Keeping the scheme in one place is what
 * stops the two halves from drifting apart silently.
 */
export const PALETTE_LIST_ID = 'nekowite-command-palette-list'

export function paletteItemId(index: number): string {
  return `${PALETTE_LIST_ID}-item-${index}`
}
