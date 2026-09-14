/**
 * The author's text, read back off a parse.
 *
 * A parse is not a source file. micromark's `html` value drops the indentation
 * of a tag's continuation lines, and a node inside a blockquote or a list item
 * is offset by its container, so what a node is *made of* and what the file
 * *says* are different strings. Both the MDX parse (`document.ts`) and the
 * CommonMark one (`remark.ts`) read the author's text off the offsets, and so
 * does the masker (`mask.ts`), which is why the reading lives in a module of its
 * own rather than inside the MDX registration.
 */

export interface SourceNode {
  type?: string
  value?: unknown
  position?: {
    start?: { offset?: number }
    end?: { offset?: number }
  }
}

/**
 * The prefix width that applies to `node`'s own content, given the width its
 * container already contributes.
 *
 * A blockquote adds `> ` to every non-blank continuation line. A list item adds
 * its marker plus one space — read from the source rather than computed from the
 * list, because that is the indentation the item's own lines actually carry
 * (`- `, `10. `, and whatever its parent added on top). Anything that is not a
 * marker falls back to the canonical two.
 */
export function contentIndent(node: SourceNode, containerIndent: number, source: string): number {
  if (node.type === 'blockquote') return containerIndent + 2
  if (node.type !== 'listItem') return containerIndent
  const start = node.position?.start?.offset
  if (start === undefined || !source) return containerIndent + 2
  const lineStart = source.lastIndexOf('\n', start - 1) + 1
  const prefix = source.slice(lineStart, start)
  return /^[ \t]*(?:[-*+]|\d+[.)])[ \t]+$/.test(prefix) ? prefix.length : containerIndent + 2
}

/** The source between two nodes' offsets, de-prefixed — or null when the parse
 *  carries no offsets (a synthetic tree) or no source. */
export function sourceBetween(
  from: SourceNode,
  to: SourceNode,
  source: string,
  indent = 0,
): string | null {
  const start = from.position?.start?.offset
  const end = to.position?.end?.offset
  if (start === undefined || end === undefined || !source) return null
  return stripContainerPrefix(source.slice(start, end), indent)
}

/** The source of one node, falling back to its parsed value when the tree has
 *  no offsets to slice. */
export function sourceOf(node: SourceNode, source: string, indent = 0): string {
  return sourceBetween(node, node, source, indent) ?? (typeof node.value === 'string' ? node.value : '')
}

/**
 * Take the container's prefix off the continuation lines of a raw span.
 *
 * The stringifier adds the prefix back when it writes the span out again, so
 * keeping it here would double it — an element written across lines inside a
 * blockquote came back as `> > >` and, at the top level of a list item, escaped
 * into literal text. Blank lines get no indent from a list item and only a bare
 * `>` from a blockquote, so they are normalised to empty, which is exactly what
 * the writer re-creates for them.
 */
function stripContainerPrefix(raw: string, indent: number): string {
  if (indent <= 0) return raw
  const lines = raw.split('\n')
  for (let i = 1; i < lines.length; i++) {
    const head = lines[i].slice(0, indent)
    // Not a container prefix — the line is content that happens to start with
    // these characters, and removing them would change it.
    if (!/^[> \t]*$/.test(head)) continue
    const rest = lines[i].slice(indent)
    lines[i] = rest.trim() === '' ? '' : rest
  }
  return lines.join('\n')
}
