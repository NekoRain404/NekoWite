import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createEditor } from './editor'
import { renderDocumentAsync } from './export/html'

const root = resolve(__dirname, '../../../docs/mdx-demo')
const files = [
  'demo.mdx',
  'image-demo.mdx',
  'components-demo.mdx',
  'math-citation-demo.mdx',
  'mdx-roundtrip-demo.mdx',
  'notes/neko-notes.md',
  'notes/mdx-syntax.md',
]

describe('MDX demo validation', () => {
  for (const relative of files) {
    it(`${relative}: opens, round-trips and renders`, async () => {
      const source = readFileSync(resolve(root, relative), 'utf8')
      const el = document.createElement('div')
      document.body.appendChild(el)
      const editor = createEditor(el)
      try {
        await editor.open(source)
        const saved = await editor.save()
        expect(saved.length).toBeGreaterThan(0)
        expect(saved.length).toBeGreaterThan(50)
        const html = await renderDocumentAsync(source, {
          componentRenderers: {},
          math: 'text',
        })
        expect(html).toContain('<html')
      } finally {
        editor.destroy()
      }
    })
  }
})


