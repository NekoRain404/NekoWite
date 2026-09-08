import { Plugin, PluginKey } from '@milkdown/prose/state'
import type { EditorView } from '@milkdown/prose/view'
import { isInTable } from '@milkdown/prose/tables'

export const TABLE_SELECTION_PLUGIN_KEY = new PluginKey('nekowite.tableSelection')

type Listener = (inTable: boolean) => void
const listeners = new Set<Listener>()
let current = false

/** Subscribe to "is the cursor inside a table" changes. Returns unsubscribe. */
export function onTableCursorChange(listener: Listener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function isTableCursorActive(): boolean {
  return current
}

function emit(inTable: boolean): void {
  if (current === inTable) return
  current = inTable
  for (const l of listeners) l(inTable)
}

export const tableSelectionPlugin = new Plugin({
  key: TABLE_SELECTION_PLUGIN_KEY,
  view: (view: EditorView) => {
    const sync = (): void => {
      emit(isInTable(view.state))
    }
    sync()
    return { update: sync, destroy: () => emit(false) }
  },
})
