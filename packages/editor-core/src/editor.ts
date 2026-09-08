import type { MilkdownPlugin } from '@milkdown/ctx'
import { Editor, editorViewCtx, parserCtx, rootCtx } from '@milkdown/core'
import { listenerCtx } from '@milkdown/plugin-listener'
import type { EditorView } from '@milkdown/prose/view'
import { getMarkdown } from '@milkdown/utils'

import { basicPlugins } from './plugins/basic'
import { registerBuiltinCommands, setCommandViewProvider } from './commands'
import { roundTrip } from './serialize'
import { setMathFeatureView } from './math/feature'
import { setTableFeatureView } from './table/plugin'
import {
  acceptSuggestion as acceptSuggestionFor,
  hasSuggestion as hasSuggestionFor,
  rejectSuggestion as rejectSuggestionFor,
  setSuggestion as setSuggestionFor,
  SUGGESTION_META,
} from './suggest'
import type { SuggestionStatus } from './suggest'

export { basicPlugins }

export interface NekoEditor {
  open(content: string): Promise<void>
  save(): Promise<string>
  getView(): EditorView
  onContentChange(cb: () => void): () => void
  insertMarkdownAtCursor(md: string): Promise<void>
  setSuggestion(text: string | null): void
  acceptSuggestion(): string | null
  rejectSuggestion(): void
  hasSuggestion(): boolean
  onSuggestionChange(cb: (status: SuggestionStatus) => void): () => void
  destroy(): void
}

/** YAML frontmatter block at the very start of a document, if any. The
 * trailing line breaks (including blank separator lines) are part of the
 * block so a save() re-prepends the source byte-faithfully. */
const FRONTMATTER_RE = /^---\r?\n[\s\S]*?\r?\n---((?:\r?\n)+|$)/

export function splitFrontmatter(md: string): { front: string; body: string } {
  const match = FRONTMATTER_RE.exec(md)
  if (!match) return { front: '', body: md }
  return { front: match[0], body: md.slice(match[0].length) }
}

export function createEditor(
  target: HTMLElement,
  options: { plugins?: MilkdownPlugin[] } = {}
): NekoEditor {
  const plugins = options.plugins ?? basicPlugins
  const changeHandlers = new Set<() => void>()
  const suggestionHandlers = new Set<(status: SuggestionStatus) => void>()
  let view: EditorView | null = null
  let destroyed = false
  // YAML frontmatter is not representable in the Milkdown model (it would be
  // parsed as a thematic break + setext heading and rewritten on save), so it
  // is extracted before the body enters the editor and re-prepended on save.
  let frontmatter = ''

  const notifySuggestion = (status: SuggestionStatus): void => {
    suggestionHandlers.forEach((handler) => handler(status))
  }

  const editor = Editor.make()
    .config((ctx) => {
      ctx.set(rootCtx, target)
    })
    .config((ctx) => {
      ctx.get(listenerCtx).markdownUpdated(() => {
        changeHandlers.forEach((handler) => handler())
      })
    })
    .use(plugins)
    .create()

  const ready = editor.then((created) => {
    view = created.action((ctx) => ctx.get(editorViewCtx))
    // Toolbar commands resolve the view lazily; point them at this editor and
    // make sure the global registry has fresh handlers for this schema. The
    // math/table dialog commands capture the view eagerly — keep them in
    // sync and let destroy() clear them.
    setCommandViewProvider(() => (destroyed ? null : view))
    registerBuiltinCommands()
    const v = view as EditorView
    setMathFeatureView(v)
    setTableFeatureView(v)
    const dispatch = v.dispatch.bind(v)
    v.dispatch = (tr) => {
      const hadSuggestion = hasSuggestionFor(v)
      const docChanged = tr.docChanged
      dispatch(tr)
      const hasNow = hasSuggestionFor(v)
      if (
        hadSuggestion &&
        !hasNow &&
        docChanged &&
        tr.getMeta(SUGGESTION_META) === undefined
      ) {
        notifySuggestion('cleared')
      }
      // A transaction that changes the document is the authoritative "content
      // changed" signal. Milkdown's markdownUpdated only re-fires when the
      // re-derived markdown string differs, so on some input paths (e.g. plain
      // typed characters where the recomputed string happens to read the same)
      // it never fires — and the app's content sync + lifecycle emit, which are
      // keyed off onContentChange, would silently stop updating active.content
      // and never emit onDocChange. Key off ProseMirror's docChanged instead;
      // the debounced sync layer coalesces the burst. markdownUpdated is kept
      // as a secondary signal — double-firing is harmless (idempotent + debounced).
      if (docChanged) changeHandlers.forEach((handler) => handler())
    }
    return created
  })

  return {
    async open(content: string) {
      await ready
      const { front, body } = splitFrontmatter(content)
      frontmatter = front
      const created = await editor
      created.action((ctx) => {
        const v = ctx.get(editorViewCtx)
        const parser = ctx.get(parserCtx)
        const node = parser(body)
        const tr = v.state.tr.replaceWith(0, v.state.doc.content.size, node)
        // A document load is not a user edit: keep it out of undo history so
        // Cmd+Z after switching documents cannot wipe the freshly opened doc.
        tr.setMeta('addToHistory', false)
        v.dispatch(tr)
      })
    },
    async save() {
      const created = await editor
      const md = created.action((ctx) => roundTrip(getMarkdown()(ctx)))
      return frontmatter + md
    },
    async insertMarkdownAtCursor(md: string): Promise<void> {
      await ready
      const created = await editor
      created.action((ctx) => {
        const v = ctx.get(editorViewCtx)
        const parser = ctx.get(parserCtx)
        const parsed = parser(md)
        if (!parsed) return
        // The parser yields a doc node; insert each top-level child at the
        // caret so block images split the surrounding paragraph naturally.
        parsed.forEach((child) => {
          v.dispatch(v.state.tr.replaceSelectionWith(child).scrollIntoView())
        })
      })
    },
    getView() {
      if (!view) {
        throw new Error('[NekoEditor] editor view is not available yet')
      }
      return view as EditorView
    },
    onContentChange(cb: () => void): () => void {
      changeHandlers.add(cb)
      return () => changeHandlers.delete(cb)
    },
    setSuggestion(text: string | null): void {
      const v = this.getView()
      const had = hasSuggestionFor(v)
      setSuggestionFor(text, v)
      if (text === null && had) notifySuggestion('cleared')
    },
    acceptSuggestion(): string | null {
      const inserted = acceptSuggestionFor(this.getView())
      if (inserted !== null) notifySuggestion('accepted')
      return inserted
    },
    rejectSuggestion(): void {
      const v = this.getView()
      if (!hasSuggestionFor(v)) return
      rejectSuggestionFor(v)
      notifySuggestion('rejected')
    },
    hasSuggestion(): boolean {
      return hasSuggestionFor(this.getView())
    },
    onSuggestionChange(cb: (status: SuggestionStatus) => void): () => void {
      suggestionHandlers.add(cb)
      return () => suggestionHandlers.delete(cb)
    },
    destroy() {
      destroyed = true
      changeHandlers.clear()
      suggestionHandlers.clear()
      setMathFeatureView(null)
      setTableFeatureView(null)
      void editor
        .then((created) => {
          if (created.status !== 'Destroyed') return created.destroy()
        })
        .catch(() => undefined)
    },
  }
}
