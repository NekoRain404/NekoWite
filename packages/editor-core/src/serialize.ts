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