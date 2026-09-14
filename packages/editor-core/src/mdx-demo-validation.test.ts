import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createEditor } from './editor'
import { renderDocumentAsync } from './export'

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

/**
 * Each case builds a real editor, opens a real document, saves it and renders
 * the whole thing to standalone HTML with KaTeX — far more work than a unit
 * test, and it has been observed exceeding vitest's 5 s default on a loaded
 * machine. The budget is stated rather than left implicit, so the number
 * reflects what the case does instead of how fast the machine happened to be.
 */
const PER_DOCUMENT_TIMEOUT_MS = 30_000

describe('MDX demo validation', () => {
  for (const relative of files) {
    it(
      `${relative}: opens, round-trips and renders`,
      async () => {
        const source = readFileSync(resolve(root, relative), 'utf8')
        const el = document.createElement('div')
        document.body.appendChild(el)
        const editor = createEditor(el)
        try {
          // The path, because the document's kind decides how it is read: the
          // four `.mdx` files go through the MDX parser and the two `.md` notes
          // through the Markdown one. A showcase corpus that is never opened as
          // what it claims to be is not a corpus.
          await editor.open(source, relative)
          const saved = await editor.save()
          expect(saved.length).toBeGreaterThan(0)
          expect(saved.length).toBeGreaterThan(50)
          // A component that came back as `\<Callout …` is not source any more —
          // it is literal text, and the file no longer compiles as MDX.
          expect(saved).not.toContain('\\<')
          const html = await renderDocumentAsync(source, {
            componentRenderers: {},
            math: 'text',
          })
          expect(html).toContain('<html')
        } finally {
          editor.destroy()
        }
      },
      PER_DOCUMENT_TIMEOUT_MS,
    )
  }
})
