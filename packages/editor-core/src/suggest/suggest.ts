import { Plugin, PluginKey } from '@milkdown/prose/state'
import { Decoration, DecorationSet } from '@milkdown/prose/view'
import type { EditorView } from '@milkdown/prose/view'

export type SuggestionStatus = 'accepted' | 'rejected' | 'cleared'

export interface SuggestionState {
  text: string | null
}

export const SUGGESTION_KEY = new PluginKey<SuggestionState>('nekoSuggestion')
export const SUGGESTION_META = 'nekoSuggestion'

function makeGhostWidget(pos: number, text: string): Decoration {
  return Decoration.widget(
    pos,
    () => {
      const span = document.createElement('span')
      span.className = 'ghost-text'
      span.textContent = text
      span.setAttribute('contenteditable', 'false')
      span.setAttribute('aria-hidden', 'true')
      return span
    },
    { key: 'nekoSuggestion', ignoreSelection: true },
  )
}

export const suggestionPlugin = new Plugin<SuggestionState>({
  key: SUGGESTION_KEY,
  state: {
    init: (): SuggestionState => ({ text: null }),
    apply: (tr, value) => {
      const meta = tr.getMeta(SUGGESTION_META)
      if (meta !== undefined) {
        return { text: meta === null ? null : String(meta) }
      }
      if (tr.docChanged) {
        return { text: null }
      }
      return value
    },
  },
  props: {
    decorations: (state) => {
      const text = SUGGESTION_KEY.getState(state)?.text ?? null
      if (!text) return DecorationSet.empty
      return DecorationSet.create(state.doc, [makeGhostWidget(state.selection.head, text)])
    },
  },
})

export function setSuggestion(text: string | null, view: EditorView): void {
  view.dispatch(view.state.tr.setMeta(SUGGESTION_META, text))
}

export function acceptSuggestion(view: EditorView): string | null {
  const text = SUGGESTION_KEY.getState(view.state)?.text ?? null
  if (!text) return null
  const { from, to } = view.state.selection
  view.dispatch(view.state.tr.insertText(text, from, to).setMeta(SUGGESTION_META, null))
  return text
}

export function rejectSuggestion(view: EditorView): void {
  view.dispatch(view.state.tr.setMeta(SUGGESTION_META, null))
}

export function hasSuggestion(view: EditorView): boolean {
  return (SUGGESTION_KEY.getState(view.state)?.text ?? null) !== null
}
