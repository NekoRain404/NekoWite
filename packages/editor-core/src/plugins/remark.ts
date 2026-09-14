import { remarkCtx, schemaCtx } from '@milkdown/core'
import type { Ctx } from '@milkdown/ctx'
import type { Node as ProseNode, Schema } from '@milkdown/prose/model'
import { ParserState } from '@milkdown/transformer'

import { normalizeMdxTree, withMdxSyntax } from '../mdx/document'
import { parseWithTableRepair } from '../table/delimiter'
import { maskInlineBreaks, restoreInlineBreaks, unmaskInlineBreaks } from './inline-break'
import type { MdastLike } from './inline-break'
import { keepUnusedDefinitions, restoreKeptDefinitions } from './link-definitions'

// The marker mechanism moved to `inline-break.ts`; it stays on this module's path
// for every existing importer.
export { maskInlineBreaks, restoreInlineBreaks, unmaskInlineBreaks } from './inline-break'
export type { MdastLike } from './inline-break'

interface RemarkProcessor {
  parse: (markdown: string) => unknown
  runSync: (tree: never, markdown: string) => unknown
}

/** The unified processor of the context, plus the internals this module needs. */
interface FrozenProcessor extends RemarkProcessor {
  /** `@deprecated` upstream, but the only way to clone a configured processor. */
  copy: () => unknown
}

/** The subset of milkdown’s `ParserState` this module drives. */
interface ParserStateLike {
  addText: (text: string) => unknown
  next: (node: never) => { toDoc: () => unknown }
}

/**
 * Ignore empty text nodes instead of aborting the whole parse.
 *
 * `ParserState.addText` calls `schema.text('')`, which throws `RangeError: Empty
 * text nodes are not allowed`. Milkdown catches that internally and abandons the
 * document — the editor then opens an EMPTY note over a file that is fine, which
 * is far worse than a stray empty text node. The masked tree can produce one (a
 * sentinel adjacent to a mark boundary leaves an empty run), so the state is
 * guarded before the tree is handed to it.
 */
function guardEmptyText(state: ParserStateLike): ParserStateLike {
  const addText = state.addText.bind(state)
  state.addText = (text: string) => (text === '' ? state : addText(text))
  return state
}

/**
 * Un-escape the pipes a table cell made the author write in a formula.
 *
 * `|` is the cell delimiter, so a formula that uses it — an absolute value, a norm
 * — has to be written `$\\|x\\|$` for the row to parse as one row at all. GFM’s own
 * reader unescapes `\\` and `\|` in a code span inside a cell (`exitCodeText` in
 * mdast-util-gfm-table), but remark-math copies the math value straight from the
 * source, so the backslashes reached the editor’s LaTeX and changed its MEANING:
 * `\|` is the double-bar symbol in LaTeX, not a `|`. Mirroring the code-span rule
 * keeps the editor’s latex as the author’s `|x|`; the serializer escapes it again
 * on the way out (see table/stringify.ts).
 */
export function unescapeCellPipes(tree: MdastLike, inCell = false): void {
  const children = tree.children
  if (!children) return
  const cell = inCell || tree.type === 'tableCell'
  for (const child of children) {
    if (Array.isArray(child.children)) {
      unescapeCellPipes(child, cell)
      continue
    }
    if (!cell || typeof child.value !== 'string') continue
    if (child.type !== 'inlineMath' && child.type !== 'math') continue
    child.value = child.value.replace(/\\([\\|])/g, '$1')
  }
}

/**
 * A body parser that is told which language it is reading: `mdx` selects the MDX
 * processor for that call, and a caller that is loading a document passes the
 * kind of the file it was handed.
 */
export type DocumentParser = (markdown: string, mdx: boolean) => ProseNode

/**
 * Build a parser that keeps the author’s inline `<br>` when a document loads.
 *
 * The context’s processor is frozen (the preset already ran `use` on it) and its
 * parser keeps its state private, so this copies the processor — a copy of a frozen
 * processor is unfrozen and carries the same configured plugins — runs the masked
 * Markdown through it, and repairs the tree before it becomes a ProseMirror
 * document. The masking and the repair are `inline-break.ts`'s; what is here is the
 * order they and the other tree passes have to run in.
 *
 * The kind of document to read is an ARGUMENT of each call, not state on the
 * parser: one editor serves every document the user opens and the answer
 * changes with each load — a `.mdx` file is read with the MDX parser, a `.md`
 * file with the Markdown one, and neither pays for the other. The caller that
 * is loading a document is the only one that knows its kind at the moment it
 * has to be known, which is before anything about that document has been
 * committed anywhere (see `editor.ts` `open()`).
 *
 * Returns null while the context is incomplete, so the caller can fall back to the
 * stock parser.
 */
export function createInlineBreakParser(ctx: Ctx): DocumentParser | null {
  const base = ctx.get(remarkCtx) as unknown as FrozenProcessor
  const schema = ctx.get(schemaCtx) as unknown as Schema
  if (typeof base?.runSync !== 'function' || !schema) return null
  const plain = base.copy() as unknown as RemarkProcessor
  // Built on the first MDX document, never at editor creation, so a Markdown
  // session does not pay for the extension or for its acorn parser.
  let mdx: RemarkProcessor | null = null

  const build = (markdown: string, processor: RemarkProcessor, asMdx: boolean): unknown => {
    const masked = maskInlineBreaks(markdown)
    // An MDX tree is folded into the shapes the schema knows BETWEEN the parse
    // and the transformers. It has to be here: the preset's transformers (image
    // dimensions, math, highlights, wikilinks, citations, the empty-line marker)
    // read plain text nodes, and MDX hands them `mdxTextExpression` nodes they
    // would walk past — an image's `{width=480}` would stop being an image
    // dimension.
    // The parse also rescues a GFM delimiter row that the list construct stole
    // (`- | -` above a table body); it answers with the source its offsets
    // describe, which is what every step below has to read.
    const { tree, source } = parseWithTableRepair(masked, (text) => processor.parse(text) as MdastLike)
    if (asMdx) normalizeMdxTree(tree as never, source, unmaskInlineBreaks)
    // Both around the transformers: the definitions nothing references have to
    // be out of `remark-inline-links`'s way while it runs, and back in the tree
    // as model-holdable nodes before the schema conversion (link-definitions.ts).
    keepUnusedDefinitions(tree)
    processor.runSync(tree as never, source)
    restoreInlineBreaks(tree)
    unescapeCellPipes(tree)
    restoreKeptDefinitions(tree, (start, end) => unmaskInlineBreaks(source.slice(start, end)))
    const state = guardEmptyText(new ParserState(schema) as unknown as ParserStateLike)
    return state.next(tree as never).toDoc()
  }

  return ((markdown: string, asMdx: boolean) => {
    if (asMdx) {
      mdx ??= withMdxSyntax(base.copy() as unknown as RemarkProcessor) as unknown as RemarkProcessor
      try {
        return build(markdown, mdx, true)
      } catch {
        // micromark REJECTS MDX it cannot read — an unterminated tag, a `{ … }`
        // that is not JavaScript, a raw HTML comment — and throws out of the
        // parse. A document the user has open must still open: it falls back to
        // the Markdown pipeline, which reads the same file the way it did before
        // MDX parsing existed, byte for byte.
      }
    }
    return build(markdown, plain, false)
  }) as DocumentParser
}
