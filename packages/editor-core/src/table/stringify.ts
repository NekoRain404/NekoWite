import { remarkStringifyOptionsCtx } from '@milkdown/core'
import type { MilkdownPlugin } from '@milkdown/ctx'
import { mathToMarkdown } from '../math/nodes'

interface HtmlNode {
  value?: string
}

interface MathNode {
  value?: string
  data?: { hName?: string }
}

interface ParentNode {
  type?: string
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
function escapeUnescapedPipes(value: string): string {
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
function inTableCell(state: StringifyState | undefined, node?: ParentNode): boolean {
  if (Array.isArray(state?.stack) && state.stack.includes('tableCell')) return true
  // Defensive: a caller may pass a state whose stack is not populated yet.
  return node?.type === 'tableCell'
}

function htmlHandler(node: Loose, parent: Loose, state: Loose): string {
  const value = (node as HtmlNode).value || ''
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
