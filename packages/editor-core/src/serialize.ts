import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkGfm from 'remark-gfm'
import remarkFrontmatter from 'remark-frontmatter'
import remarkMath from 'remark-math'
import remarkStringify from 'remark-stringify'
import type { Root } from 'mdast'

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
      // Un-escape the opening bracket ONLY when it introduces a citation:
      // remark-stringify escapes '[' as '\[' on output, and the cite remark
      // matcher needs the literal `[@key]` form to round-trip byte-faithfully.
      // Un-escaping every '\[' (the previous behavior) corrupted intentional
      // escapes: `see \[foo\](http://x)` came back as a live link.
      text: (node, _parent, state, info) =>
        state.safe(node.value, info)
          .replace(/\\\[@/g, '[@')
          .replace(/\\\[\\\[/g, '[[')
          .replace(/\\==/g, '=='),
    },
  })

export function parseMarkdown(md: string): Root {
  return processor.parse(md)
}

export function serializeMarkdown(root: Root): string {
  return processor.stringify(root)
}

export function roundTrip(md: string): string {
  return serializeMarkdown(parseMarkdown(md))
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