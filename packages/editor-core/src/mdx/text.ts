import { remarkStringifyOptionsCtx } from '@milkdown/core'
import type { MilkdownPlugin } from '@milkdown/ctx'

import { escapeUnescapedPipes, inTableCell } from '../table/stringify'
import { findMdxRuns } from './runs'

/**
 * How MDX text is written back to Markdown.
 *
 * Both stringifiers — the editor's own (milkdown's serializer) and the pure
 * `serializeMarkdown` the save path re-parses through — escape a text node with
 * `mdast-util-to-markdown`'s `state.safe`. That escaping is Markdown's, and it was
 * applied to text that is not Markdown: `{a * b}` came back as `{a \* b}`, which
 * is not valid JavaScript, and `<Callout {...props} />` as
 * `\<Callout {...props} />`, which is no longer JSX. Both stringifiers therefore
 * use this handler instead.
 *
 * Everything outside a run is escaped exactly as before, so prose, entities and
 * the cell-pipe rule are untouched; only the runs (see `runs.ts`) are written out
 * byte for byte. A run can still hold the table's cell delimiter, so inside a cell
 * its pipes are escaped with the helper the cell's own stringifier uses —
 * otherwise a protected run would split its row into extra cells on the next save.
 */

/**
 * The slice of `mdast-util-to-markdown`'s state this handler reads.
 *
 * Its `safe` takes a `SafeConfig`, and a parameter is **contravariant**: this
 * file used to declare that parameter `unknown`, which is not assignable *to*
 * `SafeConfig`, so the real `State` a caller holds failed to match and
 * `serialize.ts` would not compile. `info` must also be **required** — marking it
 * optional reintroduces `undefined`, which `SafeConfig` does not accept either.
 * Naming the real shape is the fix; importing the type itself would be another
 * way, but `mdast-util-to-markdown` is only a transitive dependency of this
 * package, so the shape is spelled out instead of adding a dependency for it.
 */
interface SafeState {
  safe: (value: string, info: SafeContext) => string
  /** Not `readonly`: `stack` is handed straight to `inTableCell`, whose
   *  `StringifyState` declares it mutable, and a readonly array is not
   *  assignable to a mutable one. */
  stack?: string[]
}

interface SafeContext {
  before: string
  after: string
}

interface TrackInfo {
  before?: string
  after?: string
}

/** `safe` decides by the characters on BOTH sides of a value, so each piece of a
 *  split text node has to carry the real neighbours as its context. Without this
 *  the trailing space of `Value ` — now followed by a run instead of by the next
 *  word — matches the "space before a line break" rule and is encoded as
 *  `&#x20;`. */
function context(info: unknown, before: string, after: string): SafeContext {
  return { ...(info as TrackInfo | undefined), before, after } as SafeContext
}

export function mdxTextHandler(
  node: { value?: unknown },
  parent: unknown,
  state: SafeState,
  info: unknown,
): string {
  const value = typeof node.value === 'string' ? node.value : ''
  const runs = findMdxRuns(value)
  // `info` is the config `mdast-util-to-markdown` hands every text handler, which
  // is a `SafeConfig` by construction; it arrives typed `unknown` only because
  // the handler is registered through a deliberately loose option object (the
  // same reason `parent` is asserted below).
  if (runs.length === 0) return state.safe(value, info as SafeContext)
  const cell = inTableCell(state, parent as { type?: string } | undefined)
  const trailing = (info as TrackInfo | undefined)?.after ?? ''
  let before = (info as TrackInfo | undefined)?.before ?? ''
  let out = ''
  let cursor = 0
  for (const run of runs) {
    const source = value.slice(run.start, run.end)
    if (run.start > cursor) {
      out += state.safe(value.slice(cursor, run.start), context(info, before, source[0] ?? ''))
    }
    out += cell ? escapeUnescapedPipes(source) : source
    before = source.slice(-1)
    cursor = run.end
  }
  if (cursor < value.length) out += state.safe(value.slice(cursor), context(info, before, trailing))
  return out
}

export const mdxTextStringify: MilkdownPlugin = (ctx) => {
  ctx.update(remarkStringifyOptionsCtx, (prev) => ({
    ...prev,
    handlers: {
      ...prev.handlers,
      // The library's handler signature takes the full mdast node and state;
      // this one reads `value`, `state.safe`, `state.stack` and the parent's
      // type, so it is cast rather than widened to `any` (as the table's own
      // stringify plugin does for the same reason).
      text: mdxTextHandler as never,
    },
  }))
  return () => undefined
}
