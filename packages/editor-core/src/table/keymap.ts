/**
 * Tab-in-last-cell auto-append.
 *
 * GFM tables always need a header row plus data rows, but a table the user is
 * actively filling has no natural "out of cells" escape: pressing Tab on the
 * final cell is the universal trigger to grow the table. ProseMirror's
 * goToNextCell is a no-op on the last cell, so this keymap checks that case
 * first and appends a row (single transaction = single undo step), then drops
 * the cursor into the new row's first cell. In every other table cell it
 * returns false so the stock GFM keymap keeps handling Tab/Shift-Tab.
 */

import type { EditorView } from '@milkdown/prose/view'
import { Plugin, PluginKey, Selection } from '@milkdown/prose/state'
import { addRowAfter, findTable, isInTable, selectedRect } from '@milkdown/prose/tables'

export const TABLE_AUTO_ROW_PLUGIN_KEY = 'nekowite.tableAutoRow'

/** True when the cursor sits in the final row and final column of a table. */
export function isInLastCell(view: EditorView): boolean {
  if (!isInTable(view.state)) return false
  const rect = selectedRect(view.state)
  const atBottom = rect.map.height === 1 ? true : rect.bottom >= rect.map.height
  const atRight = rect.map.width === 1 ? true : rect.right >= rect.map.width
  return atBottom && atRight
}

export const tableAutoRowKeymap = new Plugin({
  key: new PluginKey(TABLE_AUTO_ROW_PLUGIN_KEY),
  props: {
    handleKeyDown(view: EditorView, event: KeyboardEvent): boolean {
      if (event.key !== 'Tab' || event.shiftKey) return false
      if (!isInTable(view.state) || !isInLastCell(view)) return false
      event.preventDefault()
      if (!addRowAfter(view.state, view.dispatch)) return true
      // Move the cursor into the new row's first cell.
      const table = findTable(view.state.selection.$from)
      if (!table) return true
      const rect = selectedRect(view.state)
      const row = rect.map.height - 1
      const pos = rect.tableStart + rect.map.positionAt(row, rect.left, rect.table)
      const $pos = view.state.doc.resolve(pos + 1)
      const sel = Selection.near($pos)
      view.dispatch(view.state.tr.setSelection(sel).scrollIntoView())
      return true
    },
  },
})
