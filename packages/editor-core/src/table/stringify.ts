import { remarkStringifyOptionsCtx } from '@milkdown/core'
import type { MilkdownPlugin } from '@milkdown/ctx'

interface HtmlNode {
  value?: string
}

interface ParentNode {
  type?: string
}

/**
 * Insert a backslash before every pipe that is not already escaped.
 *
 * A pipe is escaped when an ODD number of backslashes precedes it, so `x|y`
 * needs one inserted while the author's own `x\|y` must be left alone —
 * escaping it again yields `x\\|y`, where `\\` is just a literal backslash and
 * the pipe separates cells again. (Raw `html` nodes keep the source's escapes:
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

function htmlHandler(
  node: HtmlNode,
  _parent: ParentNode | undefined,
  state?: { stack?: string[] },
): string {
  const value = node.value || ''
  // In the mdast the cell's content is wrapped in its own paragraph, so the
  // immediate parent is a `paragraph` in both the table and the ordinary case.
  // The construct stack is what tells them apart — `state.safe` uses the same
  // one to apply the table's `|` unsafe pattern to plain text.
  const inCell = Array.isArray(state?.stack) && state.stack.includes('tableCell')
  return inCell ? escapeUnescapedPipes(value) : value
}

export const tableCellHtmlEscapeStringify: MilkdownPlugin = (ctx) => {
  ctx.update(remarkStringifyOptionsCtx, (prev) => ({
    ...prev,
    handlers: { ...prev.handlers, html: htmlHandler },
  }))
  return () => undefined
}
