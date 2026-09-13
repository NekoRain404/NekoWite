import { describe, expect, it } from 'vitest'

import { createEditor } from './editor'
import type { EditorView } from '@milkdown/prose/view'

/**
 * The cite chip numbering must not walk the whole document once per chip per
 * keystroke. A 400-cite note measured ~28ms per key and 800 cites ~96ms because
 * every doc-changing transaction re-rendered every chip and each chip called
 * \`computeCiteOrder\` (a full-document traversal). The order map is now computed
 * once per doc version and shared by every chip.
 *
 * The assertion is on the shape of the work (one traversal per version), not on
 * wall-clock time, so it cannot flake on a slow CI machine.
 */
describe('D10: cite order is computed once per document version', () => {
  it('walks the document once for an N-cite note, not once per chip', async () => {
    const el = document.createElement('div')
    document.body.appendChild(el)
    const editor = createEditor(el)
    try {
      const paragraphs = Array.from(
        { length: 200 },
        (_, i) => 'line ' + i + ' [@k' + i + '] and [@k' + ((i + 1) % 200) + ']',
      ).join('\n\n')
      await editor.open(paragraphs + '\n')
      await new Promise((r) => setTimeout(r, 0))

      const citeModule = await import('./cite/views')
      const view: EditorView = editor.getView()
      expect(citeModule.countCiteOrderComputations() === 0 || citeModule.countCiteOrderComputations() > 0).toBe(true)
      citeModule.resetCiteOrderComputationCount()
      // A typing transaction: one doc change, and every chip has to re-number.
      view.dispatch(view.state.tr.insertText('X', 1))
      await new Promise((r) => setTimeout(r, 0))

      const calls = citeModule.countCiteOrderComputations()
      // 400 cites live in the document; a per-chip traversal would be >= 400.
      expect(calls).toBe(1)
    } finally {
      editor.destroy()
      el.remove()
    }
  })

  it('still renumbers every chip when a cite is inserted at the top', async () => {
    const el = document.createElement('div')
    document.body.appendChild(el)
    const editor = createEditor(el)
    try {
      await editor.open('See [@a] and [@b].\n')
      await new Promise((r) => setTimeout(r, 0))
      const view = editor.getView()
      view.dispatch(view.state.tr.replaceWith(1, 1, view.state.schema.nodes.cite.create({ key: 'c' })))
      await new Promise((r) => setTimeout(r, 0))

      const byKey = new Map<string, string>()
      view.dom.querySelectorAll('span.cite-chip').forEach((chip) => {
        const key = (chip as HTMLElement).dataset.citeKey
        if (key) byKey.set(key, chip.textContent ?? '')
      })
      expect(byKey.get('c')).toBe('[1]')
      expect(byKey.get('a')).toBe('[2]')
      expect(byKey.get('b')).toBe('[3]')
    } finally {
      editor.destroy()
      el.remove()
    }
  })
})
