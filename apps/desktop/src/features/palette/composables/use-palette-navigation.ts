/**
 * Which row the arrow keys are on, and what Enter does with it (§13.4: state +
 * command).
 *
 * The highlight is one number plus the rules that move it: it wraps around both
 * ends, it resets to the top whenever the query changes, and it is clamped when
 * the list loses rows under it (a document opening or closing rebuilds the
 * command group). Those rules lived in the panel next to the markup; they are a
 * small state machine of their own (§13.7), so they live here and the rows and
 * the action they target arrive as getters rather than being read from a
 * mounted component.
 *
 * The number indexes the *rendered* rows: the same numbering `paletteItemId()`
 * mints the option ids from and the listbox marks each row with `data-index`,
 * so the arrows, the DOM ids and `aria-activedescendant` cannot drift apart
 * (§13.9).
 *
 * Scrolling the highlighted row into view is deliberately NOT here: it is DOM
 * work, and §13.3 keeps the component that owns the listbox doing its own.
 */

import { computed, ref, watch, type Ref } from 'vue'
import { isComposingKey } from '../../../services/key-guard'
import type { PaletteEntry } from '../services/command-palette-logic'
import { paletteItemId, type PaletteRow } from '../types'

export interface UsePaletteNavigationOptions {
  /** The results the user is moving through, in the order they are drawn. */
  flatRows: () => PaletteRow[]
  /** Runs the entry the user settled on. */
  activate: (entry: PaletteEntry) => void
  /** Resets the highlight whenever the results change. */
  query: Ref<string>
}

export function usePaletteNavigation(options: UsePaletteNavigationOptions) {
  const activeIndex = ref(0)

  const activeId = computed(() =>
    activeIndex.value < options.flatRows().length ? paletteItemId(activeIndex.value) : undefined,
  )

  function move(delta: number): void {
    const len = options.flatRows().length
    if (!len) return
    activeIndex.value = (activeIndex.value + delta + len) % len
  }

  /** Point the highlight at the row under the pointer. */
  function setActive(index: number): void {
    activeIndex.value = index
  }

  function onInputKeydown(e: KeyboardEvent): void {
    // Arrow/Enter belong to the IME candidate list while it is open.
    if (isComposingKey(e)) return
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      move(1)
      return
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      move(-1)
      return
    }
    if (e.key === 'Enter') {
      e.preventDefault()
      const row = options.flatRows()[activeIndex.value]
      if (row) options.activate(row.entry)
    }
  }

  watch(options.query, () => {
    activeIndex.value = 0
  })

  watch(
    () => options.flatRows().length,
    (len) => {
      if (activeIndex.value >= len) activeIndex.value = Math.max(0, len - 1)
    },
  )

  return { activeIndex, activeId, move, setActive, onInputKeydown }
}
