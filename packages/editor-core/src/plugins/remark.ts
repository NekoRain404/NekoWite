import { remarkCtx, schemaCtx } from '@milkdown/core'
import type { Ctx } from '@milkdown/ctx'
import type { Schema } from '@milkdown/prose/model'
import { ParserState } from '@milkdown/transformer'
import type { Parser } from '@milkdown/transformer'

/**
 * The spellings milkdown (and the export) treat as an empty-paragraph marker.
 */
const BR_MARKERS = ['<br />', '<br>', '<br/>', '<br >'] as const

/**
 * Delimiters for the sentinel an inline marker is swapped for while parsing.
 *
 * They have to be characters a note cannot reasonably contain AND characters
 * `String.prototype.trim()` keeps: the preset’s predicate compares
 * `node.value?.trim()`, so a whitespace-like delimiter (a control character, for
 * instance) would be trimmed away and the value would match the marker again.
 * Unicode’s Private Use Area is neither whitespace nor markdown syntax.
 */
const SENTINEL_OPEN = '\uE000'
const SENTINEL_CLOSE = '\uE001'

/** Node types whose text must not be reinterpreted as HTML. */
const CODE_NODES = new Set(['code', 'inlineCode', 'code_block'])

export interface MdastLike {
  type?: string
  value?: unknown
  children?: MdastLike[]
}

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

function escapeRe(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function markerPattern(): RegExp {
  return new RegExp(BR_MARKERS.map(escapeRe).join('|'), 'g')
}

/**
 * True when the marker is the only thing on its line.
 *
 * A marker on its own line is an HTML BLOCK: that is the shape the serializer
 * writes for an empty paragraph, so the parser has to fold it away. A marker next
 * to text is an inline HTML node: the author’s line break, which has to survive
 * (and in a GFM cell is the only way to write one).
 */
function isStandaloneLine(markdown: string, index: number, length: number): boolean {
  const lineStart = markdown.lastIndexOf('\n', index - 1) + 1
  let lineEnd = markdown.indexOf('\n', index)
  if (lineEnd === -1) lineEnd = markdown.length
  const before = markdown.slice(lineStart, index).trim()
  const after = markdown.slice(index + length, lineEnd).trim()
  return before === '' && after === ''
}

/**
 * Hide the inline markers before the parser sees them.
 *
 * @milkdown/preset-commonmark ships `remarkPreserveEmptyLine`, whose transformer
 * DELETES every mdast `html` node whose value is one of the `<br>` spellings. That
 * rule exists for the empty-paragraph marker above, but it also matched the
 * author’s own break: `line1<br />line2` re-opened as `line1line2` (the two text
 * runs merged, because the only node between them had been spliced out) and the
 * next save wrote that over the file, so the break was lost permanently. Inside a
 * GFM cell the same thing happened, and there the author has no other way to write
 * a line break at all.
 *
 * The preset’s transformer is not exported, takes no options, and unified only
 * APPENDS transformers, so it always runs before one this package could add. Its
 * input is changed instead: an inline marker is rewritten to a sentinel (no `html`
 * node is produced, so nothing deletes it) and turned back into an `html` node
 * after the transformers ran. A marker standing alone on its line is left alone
 * and keeps the preset’s behavior.
 */
export function maskInlineBreaks(markdown: string): string {
  const pattern = markerPattern()
  let masked = ''
  let cursor = 0
  for (const match of markdown.matchAll(pattern)) {
    const index = match.index ?? 0
    const token = match[0]
    masked += markdown.slice(cursor, index)
    masked += isStandaloneLine(markdown, index, token.length)
      ? token
      : `${SENTINEL_OPEN}${token}${SENTINEL_CLOSE}`
    cursor = index + token.length
  }
  return masked + markdown.slice(cursor)
}

type Piece = string | { html: string }

function splitSentinel(value: string, inCode: boolean): Piece[] {
  const pieces: Piece[] = []
  const pattern = new RegExp(`${SENTINEL_OPEN}([\\s\\S]*?)${SENTINEL_CLOSE}`, 'g')
  let cursor = 0
  for (const match of value.matchAll(pattern)) {
    const index = match.index ?? 0
    const lead = value.slice(cursor, index)
    if (lead !== '') pieces.push(lead)
    pieces.push(inCode ? match[1] : { html: match[1] })
    cursor = index + match[0].length
  }
  const tail = value.slice(cursor)
  if (tail !== '') pieces.push(tail)
  return pieces
}

/**
 * Turn the sentinels back into `html` nodes (or plain text inside code).
 *
 * Two shapes have to be handled. Normally the masked marker comes back as one text
 * node (`line1<sentinel><br /><sentinel>line2`) and is split into text/html/text. A
 * marker the parser broke out of its run — the `html` node it produced is removed
 * while the surrounding text stays — leaves the open sentinel at the end of one
 * node and the close sentinel at the start of the next, so that pair is joined and
 * replaced by the `html` node alone. Inside code the sentinel is put back as the
 * literal source text: the preset never touched code content, so code must stay
 * byte-identical. Empty `text` pieces are dropped, because milkdown’s parser
 * rejects an empty text node.
 */
export function restoreInlineBreaks(tree: MdastLike): void {
  const children = tree.children
  if (!children) return
  const inCode = tree.type !== undefined && CODE_NODES.has(tree.type)
  for (let i = 0; i < children.length; i++) {
    const child = children[i]
    if (Array.isArray(child.children)) {
      restoreInlineBreaks(child)
      continue
    }
    if (typeof child.value !== 'string') continue
    if (!inCode && child.value.endsWith(SENTINEL_OPEN) && i + 1 < children.length) {
      const next = children[i + 1]
      if (typeof next.value === 'string' && next.value.startsWith(SENTINEL_CLOSE)) {
        child.value = child.value.slice(0, -SENTINEL_OPEN.length)
        next.value = next.value.slice(SENTINEL_CLOSE.length)
        children.splice(i + 1, 0, { type: 'html', value: '<br />' })
        i += 1
        continue
      }
    }
    if (!child.value.includes(SENTINEL_OPEN)) continue
    const pieces = splitSentinel(child.value, inCode)
    if (pieces.length === 1 && typeof pieces[0] === 'string') {
      child.value = pieces[0]
      continue
    }
    const replacement: MdastLike[] = pieces
      .map((piece: Piece) =>
        typeof piece === 'string'
          ? { type: child.type, value: piece }
          : { type: 'html', value: piece.html },
      )
      .filter((node) => node.type !== 'text' || String(node.value ?? '').length > 0)
    children.splice(i, 1, ...replacement)
    i += replacement.length - 1
  }
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
 * Build a parser that keeps the author’s inline `<br>` when a document loads.
 *
 * The context’s processor is frozen (the preset already ran `use` on it) and its
 * parser keeps its state private, so this copies the processor — a copy of a frozen
 * processor is unfrozen and carries the same configured plugins — runs the masked
 * Markdown through it, and repairs the tree before it becomes a ProseMirror
 * document.
 *
 * Returns null while the context is incomplete, so the caller can fall back to the
 * stock parser.
 */
export function createInlineBreakParser(ctx: Ctx): Parser | null {
  const base = ctx.get(remarkCtx) as unknown as FrozenProcessor
  const schema = ctx.get(schemaCtx) as unknown as Schema
  if (typeof base?.runSync !== 'function' || !schema) return null
  const processor = base.copy() as unknown as RemarkProcessor
  return ((markdown: string) => {
    const masked = maskInlineBreaks(markdown)
    const tree = processor.runSync(
      processor.parse(masked) as never,
      masked,
    ) as unknown as MdastLike
    restoreInlineBreaks(tree)
    unescapeCellPipes(tree)
    const state = guardEmptyText(new ParserState(schema) as unknown as ParserStateLike)
    return state.next(tree as never).toDoc()
  }) as Parser
}
