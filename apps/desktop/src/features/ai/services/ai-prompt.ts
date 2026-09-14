/**
 * The prompt a ghost-writer continuation is asked for.
 *
 * Pure functions over text: no editor, no gateway, no store, no reactive state.
 * `getCursorPrefix` reads the text preceding the cursor out of a structural
 * view — the caller owns the editor and hands in the slice — and
 * `buildAIPrompt` wraps it in the one instruction every endpoint answers as a
 * continuation rather than as a chat reply.
 *
 * `buildAIPrompt` is the ONLY definition of that instruction. A second copy
 * used to sit in `src-tauri/src/providers/ai/request.rs::build_prompt`, and it
 * was byte-identical — the same English sentence, the same two newlines, the
 * same trailing `\n` — which is what made it dangerous: two spellings of one
 * fact agree right up until someone edits one of them. The Rust copy had no
 * caller at all (the ghost writer builds this string here and hands the
 * finished prompt to `ai_complete`, which passes it to the provider verbatim),
 * so it was deleted. Do not reintroduce it: the cursor prefix lives in the
 * editor, on this side of the IPC boundary. `index.test.ts` pins the wrapper;
 * the sentence itself is load-bearing and belongs in exactly one place.
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
