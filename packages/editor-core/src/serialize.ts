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
      // Un-escape brackets so [@key] citations round-trip byte-faithfully:
      // remark-stringify escapes the opening '[' as '\['. Trade-off: a user's
      // intentional \[bracket\] escape also loses the backslash on save.
      //
      // Cite escape hatch: in the editor, an escaped `\[@foo]` is kept literal
      // (cite/remark.ts consults the raw source so remark's escape consumption
      // cannot turn it into a real cite). Residual consequence on this round
      // trip: the now-literal backslash may be dropped here, so a saved+reopened
      // `\[@foo]` degrades to a real `[@foo]` citation.
      text: (node, _parent, state, info) =>
        state.safe(node.value, info)
          .replace(/\\\[/g, '[')
          .replace(/\\\]/g, ']'),
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
  return text.replace(/</g, '&lt;').replace(/\{/g, '&#123;')
}