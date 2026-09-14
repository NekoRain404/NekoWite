import remarkMdx from 'remark-mdx'

/**
 * An MDX document: what makes one, how it is parsed, and how the source it is
 * made of is read back off that parse.
 *
 * The first half is the registration. MDX is a language, not a tolerance:
 * `5 <> 6` and `{width=640 align=center}` are ordinary prose and NekoWite's own
 * image syntax in Markdown, and both are a syntax error to an MDX reader.
 * Turning the extensions on for every document would reject documents that open
 * fine today, so the file's own path decides — `.mdx` is MDX, everything else
 * (including `.md`) stays Markdown.
 *
 * The second half exists because a parse is not a source file. micromark's
 * `html` value drops the indentation of a tag's continuation lines, and a node
 * inside a blockquote or a list item is offset by its container, so what a node
 * is *made of* and what the file *says* are different strings. Both the MDX
 * parse (`normalizeMdxTree` below) and the CommonMark one (`remark.ts`) read the
 * author's text off the offsets, so the reading lives here once.
 */

export function isMdxDocument(path: string | null | undefined): boolean {
  return typeof path === 'string' && /\.mdx$/i.test(path.trim())
}

/**
 * Add MDX syntax to a processor.
 *
 * The processor has to be a copy that `use()` accepts (see
 * `plugins/remark.ts` and `serialize.ts`, which copy the frozen one), and the
 * result reads `mdxjsEsm`, `mdxFlowExpression`, `mdxTextExpression` and the two
 * JSX element types as mdast nodes of their own instead of text that happens to
 * contain braces or angle brackets.
 */
export function withMdxSyntax<T>(processor: T): T {
  const use = (processor as { use?: unknown } | null | undefined)?.use
  if (typeof use !== 'function') return processor
  return (use as (plugin: unknown) => T).call(processor, remarkMdx)
}

// ---------------------------------------------------------------------------
// The source behind a node
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// The parsed tree, in the shapes the schema knows
// ---------------------------------------------------------------------------

interface MdxNode extends SourceNode {
  children?: MdxNode[]
}

/** The mdast types that are a whole block of MDX source. */
const BLOCK = new Set(['mdxJsxFlowElement', 'mdxFlowExpression', 'mdxjsEsm'])

/**
 * Fold what the MDX parser produces into what the schema knows.
 *
 * The model has exactly one way to hold MDX source it must not rewrite — the
 * `raw` attribute of `mdxComponent` — so every construct is mapped onto that,
 * not onto a second, parallel mechanism:
 *
 *   - a flow element, a flow `{ … }` expression and an ESM statement are block
 *     source: they arrive as `value`, which is what `mdxComponent` parses;
 *   - an inline element becomes the `html` source atom the Markdown pipeline
 *     already uses for inline JSX in exactly these positions;
 *   - an inline `{ … }` stays TEXT. It has to: `{width=480}` is how an image
 *     says its size, and both the image-dimension pass and the author read it as
 *     text next to the image. `mdxTextExpression` exists to say where the run
 *     ends, and the runs scanner (`runs.ts`) is what keeps it unescaped — a
 *     block atom cannot live inside a paragraph, so an atom is not an option
 *     here, and inventing an inline one would be the second mechanism.
 *
 * A block of MDX inside a LIST ITEM is the exception, and it is the schema's:
 * a list item's content is `paragraph block*`, so a block atom cannot be its
 * first child and ProseMirror inserts an empty paragraph in front of it — which
 * serializes as the `<br />` empty-paragraph marker and leaves the file changed
 * by the mere act of opening it. The element is a paragraph holding the source
 * atom instead, which is the same answer the Markdown pipeline reaches for the
 * same reason (`TEXT_BLOCK` in `remark.ts`).
 *
 * `source` is the document the offsets belong to — the MASKED one during a
 * parse, hence `unmask`, which puts the inline `<br>` markers back.
 */
export function normalizeMdxTree(
  tree: MdxNode,
  source: string,
  unmask?: (text: string) => string,
): void {
  fold(tree, source, 0, unmask)
}

function fold(
  parent: MdxNode,
  source: string,
  indent: number,
  unmask: ((text: string) => string) | undefined,
): void {
  const children = parent.children
  if (!children) return
  for (let i = 0; i < children.length; i++) {
    const child = children[i]
    const type = child.type ?? ''
    if (BLOCK.has(type)) {
      // One token to its author, so one node here: the element's children are
      // inside `value` and must not be walked into.
      const value = raw(child, source, indent, unmask)
      delete child.children
      if (parent.type === 'listItem') {
        children[i] = { type: 'paragraph', children: [{ type: 'html', value }] }
        continue
      }
      child.value = value
      continue
    }
    if (type === 'mdxJsxTextElement') {
      children[i] = { type: 'html', value: raw(child, source, indent, unmask) }
      continue
    }
    if (type === 'mdxTextExpression') {
      children[i] = { type: 'text', value: raw(child, source, indent, unmask) }
      continue
    }
    fold(child, source, contentIndent(child, indent, source), unmask)
  }
}

function raw(
  node: MdxNode,
  source: string,
  indent: number,
  unmask: ((text: string) => string) | undefined,
): string {
  const text = sourceOf(node, source, indent)
  return unmask ? unmask(text) : text
}
