import type { MilkdownPlugin } from '@milkdown/ctx'
import type { Node as ProseNode } from '@milkdown/prose/model'
import type { Parser } from '@milkdown/transformer'
import { Editor, editorViewCtx, parserCtx, rootCtx } from '@milkdown/core'
import { EditorState } from '@milkdown/prose/state'
import { listenerCtx } from '@milkdown/plugin-listener'
import type { EditorView } from '@milkdown/prose/view'
import { getMarkdown } from '@milkdown/utils'

import { basicPlugins } from './plugins/basic'
import { createInlineBreakParser } from './plugins/remark'
import { isMdxDocument } from './mdx/document'
import { readDocumentEnvelope, writeDocumentEnvelope } from './document-envelope'
import { createDocumentHolder } from './held-document'
import { insertMarkdownInCell, isInTableCell } from './table/context'
import { invalidateTableClipboard } from './table/clipboard'
import { registerBuiltinCommands, setCommandViewProvider } from './commands'
import { normalizeNbsp, roundTrip } from './serialize'
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
// Kept on this module's path (and this package's public surface) although the
// implementation moved out; see the two modules for what they are.
export { splitFrontmatter } from './document-envelope'
export { NoDocumentLoadedError } from './held-document'

export interface NekoEditor {
  /** Load a document. `path` is what the document IS — a `.mdx` file is read
   *  with the MDX parser, anything else (including `.md`, and nothing at all for
   *  a document with no file behind it) stays Markdown. See `mdx/document.ts`.
   *
   *  Rejects when the document cannot be read, and the editor then holds NO
   *  document: whatever the model still has belongs to the file that was open
   *  before it, so `save()` refuses until a later `open()` succeeds. */
  open(content: string, path?: string | null): Promise<void>
  /** The open document, serialized. Throws `NoDocumentLoadedError` when the
   *  editor is holding none (see `open`). */
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

export function createEditor(
  target: HTMLElement,
  options: { plugins?: MilkdownPlugin[] } = {}
): NekoEditor {
  const plugins = options.plugins ?? basicPlugins
  // The table clipboard buffer is module-level so a copy+paste within one session
  // works without the async clipboard API. A NEW editor means a different note (or
  // a re-opened one), and an old buffer must never be pasted into it.
  invalidateTableClipboard()
  const changeHandlers = new Set<() => void>()
  const suggestionHandlers = new Set<(status: SuggestionStatus) => void>()
  let view: EditorView | null = null
  // `open()` and `insertMarkdownAtCursor` parse through this wrapper, which keeps
  // the author's inline `<br>` (see plugins/remark.ts). It falls back to the stock
  // parser until the editor is ready.
  let parse: ((markdown: string, mdx: boolean) => ProseNode) | null = null
  let destroyed = false
  // The document this editor is holding — the model's frontmatter, line ending,
  // BOM and kind — or the fact that it is holding none (held-document.ts).
  const held = createDocumentHolder()

  /**
   * Load `doc` as a brand-new editor state.
   *
   * The load is applied to an EMPTY document first, purely to let ProseMirror
   * place the caret: `replaceWith` maps the selection to the end of the inserted
   * content, so the caret ends up where a normal "open a note" leaves it (after
   * the last character of the first line for a one-line note) without this code
   * having to reason about node sizes. The resulting state is then rebuilt from
   * scratch, which is the point: dispatching the replace with
   * `addToHistory: false` kept the PREVIOUS note's edits on the undo stack, so the
   * first Cmd+Z after switching notes consumed one of those stale events —
   * `undoDepth` went from 1 to 0 while the new note did not change, which reads as
   * "undo is broken". `EditorState.create` starts with an empty history.
   */
  const openState = (prev: EditorState, doc: ProseNode): EditorState => {
    const seed = EditorState.create({ doc: prev.schema.topNodeType.createAndFill() ?? doc, plugins: prev.plugins })
    const seeded = seed.tr.replaceWith(0, seed.doc.content.size, doc)
    const selection = seeded.selection
    return EditorState.create({
      doc,
      selection,
      storedMarks: seed.storedMarks ?? undefined,
      plugins: prev.plugins,
    })
  }

  /**
   * The inline-break-repairing parser for a document of kind `mdx`, or the
   * stock one before the editor is ready. The kind is an argument because a load
   * must read the file it was HANDED, before anything about it is committed.
   */
  const parserFor = (ctx: { get: (slice: typeof parserCtx) => Parser }, mdx: boolean): Parser => {
    const documentParser = parse
    if (!documentParser) return ctx.get(parserCtx)
    return (markdown: string) => documentParser(markdown, mdx)
  }

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
    // The commonmark preset's empty-line transformer deletes EVERY `<br>` spelling
    // it sees, which also removed the author's INLINE line break and lost it for
    // good on the next save. That transformer cannot be replaced (a duplicate
    // remark plugin name replaces the whole entry), so the parser repairs the tree
    // it produced. See plugins/remark.ts.
    parse = created.action((ctx) => createInlineBreakParser(ctx))
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
    async open(content: string, path?: string | null) {
      await ready
      // Read off the SOURCE and kept local until the load has succeeded: a parse
      // that throws must not leave the previous document wearing this file's
      // frontmatter, line ending and kind (task-37 C1).
      const envelope = readDocumentEnvelope(content)
      const asMdx = isMdxDocument(path)
      const created = await editor
      try {
        created.action((ctx) => {
          const v = ctx.get(editorViewCtx)
          const node = parserFor(ctx, asMdx)(normalizeNbsp(envelope.body))
          // Rebuilding the state (rather than dispatching a replace transaction)
          // gives the freshly opened note its own, EMPTY history. Dispatching with
          // `addToHistory: false` kept the load out of the stack but left the
          // previous note's edits on it, so the first Cmd+Z after switching notes
          // consumed one of those stale events — `undoDepth` went from 1 to 0 while
          // the new note did not change, which reads as "undo is broken". The
          // plugins are carried over unchanged, so nothing else about the state (or
          // the view) is affected.
          v.updateState(openState(v.state, node))
          // The load's last statement: the model is in place, so the envelope
          // describing it can be committed with it, and not one line earlier.
          held.hold({ envelope, mdx: asMdx })
        })
      } catch (err) {
        // Disowning: the file the user asked for is not the one the model holds,
        // and may never have been opened at all. The model itself is left alone,
        // so a save cannot write another file's document out of it.
        held.drop()
        throw err
      }
    },
    async save() {
      const created = await editor
      const document = held.require()
      const md = created.action((ctx) =>
        roundTrip(getMarkdown()(ctx), { mdx: document.mdx })
      )
      // The model can hold U+00A0 for a space typed at the end of a text run;
      // it must not reach the file (see normalizeNbsp). Then the bytes the model
      // cannot hold are written back around it: this file's BOM, its own line
      // ending, and its frontmatter as source.
      return writeDocumentEnvelope(document.envelope, normalizeNbsp(md))
    },
    async insertMarkdownAtCursor(md: string): Promise<void> {
      await ready
      const created = await editor
      created.action((ctx) => {
        const v = ctx.get(editorViewCtx)
        // A snippet is parsed in the language of the document it lands in.
        const parsed = parserFor(ctx, held.mdx)(md)
        if (!parsed) return
        // Inside a table cell only the first paragraph's INLINE content can be
        // inserted: the cell holds one paragraph, so putting a block in it would
        // make the fitter lift the block out and split the table in two.
        // Markdown is what the image intake and the AI insert send, so a snippet
        // whose first block is a paragraph still lands (image, inline math,
        // text) AT THE CARET — the cell's other text is left alone; a snippet
        // that starts with a block (an hr, a table) has nowhere legal to go and
        // the cell is left untouched.
        if (isInTableCell(v.state)) {
          insertMarkdownInCell(v, parsed)
          return
        }
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
