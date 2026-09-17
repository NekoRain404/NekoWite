import { remarkStringifyOptionsCtx } from '@milkdown/core'
import type { MilkdownPlugin } from '@milkdown/ctx'
import { mathToMarkdown } from '../math/nodes'
import { isInlineBreakValue } from '../plugins/inline-break'

interface HtmlNode {
  value?: string
}

interface MathNode {
  value?: string
  data?: { hName?: string }
}

interface ParentNode {
  type?: string
  /** `mdast-util-to-markdown` hands every handler the node it is rendering
   *  INSIDE, children and all — which is the only way to ask whether this node
   *  is the whole of its container (see {@link isSoleCellContent}). */
  children?: unknown[]
}

/**
 * The bits of `mdast-util-to-markdown`'s state this module reads.
 *
 * The library's own `State` type is structural and versioned with the library, and
 * its `safe` helper is called with an `info` object the handlers here do not need,
 * so a structural subset keeps the handlers assignable to the (much wider) `Handle`
 * type the option object expects.
 */
interface StringifyState {
  stack?: string[]
  safe?: (value: string, info?: unknown, unsafe?: unknown) => string
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = any

/**
 * Insert a backslash before every pipe that is not already escaped.
 *
 * A pipe is escaped when an ODD number of backslashes precedes it, so `x|y`
 * needs one inserted while the author's own `x\|y` must be left alone — escaping
 * it again yields `x\\|y`, where `\\` is just a literal backslash and the pipe
 * separates cells again. (Raw `html` nodes keep the source's escapes:
 * remark-gfm unescapes cell text but not raw HTML.)
 */
export function escapeUnescapedPipes(value: string): string {
  let out = ''
  let backslashes = 0
  for (const char of value) {
    if (char === '\\') {
      backslashes += 1
      out += char
      continue
    }
    out += char === '|' && backslashes % 2 === 0 ? '\\|' : char
    backslashes = 0
  }
  return out
}

/** The construct stack of `mdast-util-to-markdown` marks a table cell. */
/**
 * Whether a node is being stringified inside a table cell.
 *
 * Takes only the one field it reads rather than the whole {@link StringifyState}.
 * `StringifyState`'s `safe` is declared with an `unknown` second parameter so the
 * handlers stay assignable to the library's wide `Handle` type — and a caller
 * whose own `safe` is *narrower* than that (the MDX text handler, whose `safe`
 * must accept the real `SafeConfig`) cannot satisfy `StringifyState` for a reason
 * that has nothing to do with this function. Narrowing the parameter to the field
 * actually used is what lets both kinds of caller through.
 */
export function inTableCell(
  state: { stack?: string[] } | undefined,
  node?: ParentNode,
): boolean {
  if (Array.isArray(state?.stack) && state.stack.includes('tableCell')) return true
  // Defensive: a caller may pass a state whose stack is not populated yet.
  return node?.type === 'tableCell'
}

/**
 * Whether the node being written is the ONLY thing its table cell holds.
 *
 * A GFM cell holds exactly one paragraph, so "the only child of that paragraph"
 * and "the whole cell" are the same thing. A `<br>` of that shape is not content
 * the author put between two things — it is what a cell with nothing in it looks
 * like on the way out — and it must not be written (see the cell rule in
 * {@link htmlHandler}).
 *
 * The distinction is the whole point: `a<br />b` keeps its break, `<br />` alone
 * in a cell does not, and the file stops carrying a marker that means "empty".
 */
function isSoleCellContent(state: Loose, parent: Loose): boolean {
  const p = parent as ParentNode | undefined
  return inTableCell(state as StringifyState | undefined, p) && Array.isArray(p?.children) && p.children.length === 1
}

function htmlHandler(node: Loose, parent: Loose, state: Loose): string {
  const value = (node as HtmlNode).value || ''
  // The empty-cell placeholder arrives here as an `html` node: milkdown's
  // paragraph serializer emits `<br />` for an empty paragraph, and inside a cell
  // that paragraph IS the cell. It used to reach the file, so every blank cell of
  // every table was written `| <br /> |` — and, worse, the atom that came back on
  // the next open made the save after it write `<br />` again beside whatever was
  // typed next to it. Dropping it here is what stops the file ever holding one.
  if (isInlineBreakValue(value) && isSoleCellContent(state, parent)) return ''
  // In the mdast the cell's content is wrapped in its own paragraph, so the
  // immediate parent is a `paragraph` in both the table and the ordinary case.
  // The construct stack is what tells them apart — `state.safe` uses the same
  // one to apply the table's `|` unsafe pattern to plain text.
  return inTableCell(state as StringifyState | undefined, parent as ParentNode) ? escapeUnescapedPipes(value) : value
}

/**
 * Escape pipes in a formula that sits inside a table cell.
 *
 * `|` is the cell delimiter, so a formula using it (an absolute value, a norm)
 * has to escape it in the file — that is what the author writes and what remark
 * reads back. Without this the serializer emitted a bare `|` inside the math
 * node, which splits the row into extra cells on the next open.
 *
 * The math node itself is rendered by the same `mathToMarkdown` the node's own
 * `toMarkdown` uses, so the two paths cannot drift.
 */
function mathHandler(node: Loose, parent: Loose, state: Loose): string {
  const { value, data } = node as MathNode
  const latex = String(value ?? '')
  const inline = Boolean(data?.hName)
  const markdown = mathToMarkdown(latex, inline ? 'inline' : 'display')
  return inTableCell(state as StringifyState | undefined, parent as ParentNode)
    ? escapeUnescapedPipes(markdown)
    : markdown
}

/**
 * Write a hard line break inside a cell as `<br />`.
 *
 * A `break` node is serialized as a backslash followed by a newline, and a cell
 * has no way to hold either: remark hands the lines back as separate rows, so the
 * break vanished entirely — Shift+Enter in a cell saved a file byte-identical to
 * one without the break. `<br />` is the spelling the parser keeps as an inline
 * break inside a cell (see plugins/remark.ts), so the round trip is stable.
 *
 * There is no "a break that is the WHOLE of its cell" case to handle here, and
 * the absence is deliberate rather than an oversight: the preset's
 * `serializeText` emits every child EXCEPT a trailing hardbreak, so a paragraph
 * whose only child is one reaches this handler with nothing at all. A lone
 * break in a cell therefore writes nothing already — measured, not assumed — and
 * a guard for it here would be a guard that cannot fire.
 */
function breakHandler(_node: Loose, parent: Loose, state: Loose): string {
  return inTableCell(state as StringifyState | undefined, parent as ParentNode) ? '<br />' : '\\\n'
}

export const tableCellHtmlEscapeStringify: MilkdownPlugin = (ctx) => {
  ctx.update(remarkStringifyOptionsCtx, (prev) => ({
    ...prev,
    handlers: {
      ...prev.handlers,
      html: htmlHandler,
      inlineMath: mathHandler,
      math: mathHandler,
      break: breakHandler,
    },
  }))
  return () => undefined
}
