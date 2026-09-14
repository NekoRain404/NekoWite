import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkGfm from 'remark-gfm'
import remarkFrontmatter from 'remark-frontmatter'
import remarkMath from 'remark-math'
import remarkStringify from 'remark-stringify'
import type { Root } from 'mdast'

import { mdxTextHandler } from './mdx/text'
import { flattenMdxElements, mdxJsxMdast } from './mdx/remark'
import { normalizeMdxTree, withMdxSyntax } from './mdx/document'
import { parseWithTableRepair } from './table/delimiter'
import type { MdastNode } from './table/delimiter'

/**
 * Un-escape the opening bracket ONLY when it introduces a citation:
 * remark-stringify escapes '[' as '\[' on output, and the cite remark
 * matcher needs the literal `[@key]` form to round-trip byte-faithfully.
 * Un-escaping every '\[' (the previous behavior) corrupted intentional
 * escapes: `see \[foo\](http://x)` came back as a live link.
 */
function unescapeCitations(text: string): string {
  return text
    .replace(/\\\[@/g, '[@')
    .replace(/\\\[\\\[/g, '[[')
    .replace(/\\==/g, '==')
}

const processor = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkFrontmatter, ['yaml'])
  .use(remarkMath)
  .use(remarkStringify, {
    bullet: '-',
    emphasis: '*',
    strong: '*',
    fences: true,
    handlers: {
      // `mdxTextHandler` is remark-stringify's own `state.safe` for every text
      // node that holds no MDX (the common case), with the citation un-escaping
      // above; inside an MDX run it writes the source verbatim instead of
      // escaping it (see mdx/text.ts — a save() re-parses its own output through
      // this processor, so `{a * b}` used to come back as `{a \* b}`).
      text: (node, parent, state, info) =>
        unescapeCitations(mdxTextHandler(node, parent, state, info)),
    },
  })

/**
 * Parse `md` with the Markdown processor. The tree's offsets describe `md`
 * itself, which callers rely on to read source slices back out of it
 * (`mdx/mask.ts`), so nothing is repaired here: `roundTrip` and the editor's
 * parser both parse through `parseWithTableRepair`, which answers with the
 * source its offsets describe.
 */
export function parseMarkdown(md: string): Root {
  return processor.parse(md)
}

export function serializeMarkdown(root: Root): string {
  return processor.stringify(root)
}

/** The same pipeline with MDX syntax, built on first use: a Markdown document
 *  never constructs it. */
let mdxProcessor: ReturnType<typeof processor.copy> | null = null

function parseMdx(md: string): Root {
  mdxProcessor ??= withMdxSyntax(processor.copy() as never)
  return mdxProcessor.parse(md) as Root
}

/**
 * Re-parse and re-stringify, which is what every save runs over its own output.
 *
 * The MDX pass is part of it: this re-parse sees the serialized document, not the
 * model, so without the same rules the open path used, a component's source came
 * back escaped (`<Callout {...props} />` as `\<Callout …`) and a tag written across
 * lines came back split into a paragraph, a blockquote and a stray close tag.
 * `mdxJsxMdast` merges each element into one node carrying its source; the
 * flattened `html` node writes that source out verbatim, because remark-stringify
 * has no handler for this pass's own node type.
 *
 * `mdx` says the document was opened as an MDX one, and then this is the SAME
 * parser that opened it — the symmetry the paragraph above is about. It is not
 * an optimisation and it is not optional: the CommonMark pass reads a tag whose
 * `>` sits on a line of its own as three unrelated blocks, and glues a close tag
 * to the element before it (`<Inner />\n</Outer>`), so an element that the MDX
 * parser saw as one node came back out of the re-parse as several — escaped.
 * The MDX parser reads the same bytes back into the same node, which the flatten
 * below then writes out verbatim.
 *
 * MDX the parser rejects is not a failure here: it is a document that fell back
 * to Markdown when it was opened (`plugins/remark.ts`), and it falls back here
 * too, so the two ends of the round trip keep agreeing.
 */
export function roundTrip(md: string, opts: { mdx?: boolean } = {}): string {
  if (opts.mdx) {
    try {
      // The repair is per parse and its result carries the source it was parsed
      // from: every reader below slices THAT text by the offsets in the tree,
      // and a repair shifts every offset after the row it fixed.
      const { tree, source } = parseWithTableRepair(md, (text) => parseMdx(text) as MdastNode)
      const root = tree as unknown as Parameters<typeof normalizeMdxTree>[0]
      normalizeMdxTree(root, source)
      flattenMdxElements(tree as unknown as Parameters<typeof flattenMdxElements>[0])
      return serializeMarkdown(tree as unknown as Root)
    } catch {
      // Fall through to the Markdown pipeline.
    }
  }
  const { tree, source } = parseWithTableRepair(md, (text) => parseMarkdown(text) as MdastNode)
  const root = tree as unknown as Parameters<typeof mdxJsxMdast>[0]
  mdxJsxMdast(root, { value: source })
  flattenMdxElements(root)
  return serializeMarkdown(tree as unknown as Root)
}

/**
 * Replace non-breaking spaces with ordinary ones.
 *
 * A browser inserts U+00A0 for a space typed at the end of a text run, so the
 * character ends up in the ProseMirror model — and, without this, in the saved
 * Markdown. There it is a defect: plain-text search and diff for the phrase no
 * longer match, and other Markdown tools render a stray character. The source
 * pane never produces one (CodeMirror types a literal space), so normalising
 * here also keeps the two panes writing the same bytes.
 *
 * Applied in both directions, so a file that already contains U+00A0 shows
 * ordinary spaces and is repaired the next time it is saved.
 */
export function normalizeNbsp(text: string): string {
  return text.includes('\u00a0') ? text.replace(/\u00a0/g, ' ') : text
}

export function escapeMdxText(text: string): string {
  // `&` first so the entities produced below are not double-encoded, then the
  // characters that would break the `<Tag prop="...">` scanner on re-parse.
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\{/g, '&#123;')
    .replace(/"/g, '&quot;')
}