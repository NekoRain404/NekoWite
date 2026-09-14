import remarkMdx from 'remark-mdx'

import { isMaskName, maskMdxSource } from './mask'
import { restoreImageAlts, type AltNode } from './image-alt'
import { contentIndent, sourceOf } from './source'

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
 * A `.mdx` file is not expected to be valid MDX either, though: it is a file the
 * user has, and a construct the parser cannot read must cost that construct
 * rather than the document. `mask.ts` holds that rule and the parser is what
 * applies it — the document goes through the MDX parser, whatever it rejects is
 * masked, and it goes through again. The registration below is therefore where
 * the two meet, and the reason the masking is invisible to every caller: the
 * masked text is exactly as long as the original, so the tree's offsets keep
 * addressing the original source and `source.ts` reads the author's bytes back
 * out with no restore step of its own.
 *
 * The second half exists because a parse is not a source file. micromark's
 * `html` value drops the indentation of a tag's continuation lines, and a node
 * inside a blockquote or a list item is offset by its container, so what a node
 * is *made of* and what the file *says* are different strings. That reading now
 * lives in `source.ts`, shared with the CommonMark parse (`remark.ts`) and with
 * the masker.
 */

export * from './source'

export function isMdxDocument(path: string | null | undefined): boolean {
  return typeof path === 'string' && /\.mdx$/i.test(path.trim())
}

/**
 * Add MDX syntax to a processor, and read documents the MDX parser refuses.
 *
 * The processor has to be a copy that `use()` accepts (see `plugins/remark.ts`
 * and `serialize.ts`, which copy the frozen one), and the result reads
 * `mdxjsEsm`, `mdxFlowExpression`, `mdxTextExpression` and the two JSX element
 * types as mdast nodes of their own instead of text that happens to contain
 * braces or angle brackets.
 *
 * The `parse` it returns masks first — see `mask.ts` — which needs a SECOND
 * parser: the same one without the MDX extension, whose answers about code spans
 * and about elements that never close cannot be got from the MDX parser itself.
 * It is taken as a copy made BEFORE the extension goes on, because `use()`
 * mutates the processor it is called on and a bound reference to this one's
 * `parse` would have grown the extension too. A processor that cannot be copied
 * is returned unmasked rather than not returned: the reader is worth more than
 * the recovering.
 */
export function withMdxSyntax<T>(processor: T): T {
  const use = (processor as { use?: unknown } | null | undefined)?.use
  if (typeof use !== 'function') return processor
  const plain = plainParser(processor)
  const mdx = (use as (plugin: unknown) => T).call(processor, remarkMdx)
  return masking(mdx, plain)
}

/** A parser for the same documents WITHOUT the MDX extension, or null when the
 *  processor has no independent copy to make one from. */
function plainParser<T>(processor: T): ((text: string) => unknown) | null {
  const copy = (processor as { copy?: () => unknown } | null | undefined)?.copy
  if (typeof copy !== 'function') return null
  const source = copy.call(processor) as { parse?: (text: string) => unknown } | null
  return typeof source?.parse === 'function' ? source.parse.bind(source) : null
}

function masking<T>(processor: T, plain: ((text: string) => unknown) | null): T {
  const target = processor as { parse?: (text: string) => unknown }
  if (typeof target.parse !== 'function') return processor
  const parse = target.parse.bind(processor)
  try {
    target.parse = (markdown: string) => {
      const masked = maskMdxSource(markdown, parse, plain)
      const tree = parse(masked) as MdxNode
      // The UNMASKED source: `masked` may hold placeholders, which are exactly
      // as long as what they replace (that is `mask.ts`'s rule), so the tree's
      // offsets address both — and a placeholder must never reach a value that
      // is written back.
      restoreImageAlts(tree, markdown, plain)
      return tree
    }
  } catch {
    // A frozen processor keeps the stock parse. A document it refuses then
    // falls back to Markdown, which is the behaviour this replaced.
    return processor
  }
  return processor
}

// ---------------------------------------------------------------------------
// The parsed tree, in the shapes the schema knows
// ---------------------------------------------------------------------------

interface MdxNode extends AltNode {
  /** The element's name; `null` for a fragment, which is what `mdast`'s own
   *  `MdxJsxFlowElement` says about it once `remark-mdx` is in the program. */
  name?: string | null
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
 * A masked element is the other exception, and it takes the inline answer even
 * at flow level: what the name stands for is source the MDX parser could not
 * read, so it is carried as source. Folding it to a component instead would put
 * a component in the tree that the author never wrote — and for a name that is
 * NOT a mask, the fold is a no-op, because a component node writes its source
 * back verbatim too. The node kind changes; the bytes never do.
 *
 * `source` is the document the offsets belong to — the MASKED one during a
 * parse, which is byte-aligned with the original on purpose, hence `unmask`,
 * which puts the inline `<br>` markers back.
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
      if (parent.type === 'listItem' || (type === 'mdxJsxFlowElement' && isMaskName(child.name))) {
        children[i] = { type: 'html', value }
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
