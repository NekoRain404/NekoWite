import { Plugin, PluginKey } from '@milkdown/prose/state'
import type { EditorState } from '@milkdown/prose/state'
import type { EditorView } from '@milkdown/prose/view'
import { isInTable } from '@milkdown/prose/tables'

export const TABLE_SELECTION_PLUGIN_KEY = new PluginKey<TableSelectionState>('nekowite.tableSelection')

/** Whether the caret of ONE editor's state sits inside a table. */
export interface TableSelectionState {
  inTable: boolean
}

type Listener = (inTable: boolean, view: EditorView) => void

const listeners = new Set<{ listener: Listener; view?: EditorView }>()
/**
 * What each view last published, so a transaction that does not move the
 * selection in or out of a table stays silent. Keyed by view, because two
 * editors are live at once (the split view) and the answer belongs to one of
 * them: a single module-level boolean let whichever editor dispatched last
 * report for both, so opening a second editor blanked the first one's table
 * menu. §10.2 — the state lives with its owner, not in the module.
 */
const published = new WeakMap<EditorView, boolean>()
/**
 * The view whose answer the no-argument form reports: the editor the user last
 * edited in. Only a TRANSACTION claims it — a view is created for every editor
 * the app opens (a tab switch re-keys one), and creation is not the user moving
 * to that editor.
 */
let activeView: EditorView | null = null

/**
 * Subscribe to "the cursor entered or left a table". The listener is given the
 * view that changed; pass `view` to hear about that editor only, which is what
 * a pane with its own table menu wants.
 */
export function onTableCursorChange(listener: Listener, view?: EditorView): () => void {
  const entry = { listener, view }
  listeners.add(entry)
  return () => listeners.delete(entry)
}

/**
 * True when the cursor is inside a table. With a `view`, that editor's own
 * state; without one, the editor the user last edited in (the only sensible
 * answer for the single global toolbar).
 */
export function isTableCursorActive(view?: EditorView): boolean {
  if (view) return inTableOf(view)
  return activeView === null ? false : inTableOf(activeView)
}

/** One view's answer, read from its own state. */
function inTableOf(view: EditorView): boolean {
  const state = TABLE_SELECTION_PLUGIN_KEY.getState(view.state)
  return state ? state.inTable : isInTable(view.state)
}

function publish(view: EditorView): void {
  const inTable = inTableOf(view)
  if (published.get(view) === inTable) return
  published.set(view, inTable)
  for (const entry of listeners) {
    if (entry.view !== undefined && entry.view !== view) continue
    entry.listener(inTable, view)
  }
}

export const tableSelectionPlugin = new Plugin<TableSelectionState>({
  key: TABLE_SELECTION_PLUGIN_KEY,
  state: {
    // `init` sees the state the plugin is installed into, so an editor that
    // opens with the caret already in a cell reports true before the first
    // transaction — read from the state, not from a flag set later.
    init: (_config, state: EditorState): TableSelectionState => ({ inTable: isInTable(state) }),
    apply: (_tr, value, _old, next: EditorState): TableSelectionState => {
      const inTable = isInTable(next)
      return value.inTable === inTable ? value : { inTable }
    },
  },
  view: (view: EditorView) => {
    publish(view)
    return {
      update: () => {
        activeView = view
        publish(view)
      },
      destroy: () => {
        published.delete(view)
        if (activeView !== view) return
        activeView = null
        for (const entry of listeners) {
          if (entry.view !== undefined && entry.view !== view) continue
          entry.listener(false, view)
        }
      },
    }
  },
})
