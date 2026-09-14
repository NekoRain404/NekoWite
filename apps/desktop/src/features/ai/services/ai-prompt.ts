/**
 * The prompt a ghost-writer continuation is asked for.
 *
 * Pure functions over text: no editor, no gateway, no store, no reactive state.
 * `getCursorPrefix` reads the text preceding the cursor out of a structural
 * view — the caller owns the editor and hands in the slice — and
 * `buildAIPrompt` wraps it in the one instruction every endpoint answers as a
 * continuation rather than as a chat reply.
 */

/** Structural view contract (a ProseMirror `EditorView` satisfies it). Only the
 *  selection head and the text before it are read, so the shape stays two
 *  fields deep instead of dragging the editor's types in here. */
export interface PrefixView {
  state: {
    selection: { head: number }
    doc: {
      textBetween(from: number, to: number, blockSeparator: string, leafText: string): string
    }
  }
}

export function buildAIPrompt(prefix: string): string {
  return `Continue writing the following text. Only output the continuation, no preamble.\n\n${prefix.trimEnd()}\n`
}

export function getCursorPrefix(view: PrefixView | null, maxChars = 200): string {
  if (!view) return ''
  const head = view.state.selection.head
  const from = Math.max(0, head - maxChars)
  return view.state.doc.textBetween(from, head, '\n', ' ')
}
