import { afterEach, describe, expect, it } from 'vitest'
import { basicPlugins, createEditor } from '@nekowite/editor-core'
import type { NekoEditor } from '@nekowite/editor-core'
import { leafTextOf, selectionTextOf } from './selection-text'

/**
 * Payload correctness — the half of the clipboard fix that is ENGINE-FREE.
 *
 * These run against a REAL ProseMirror document built by `editor-core` itself,
 * with the app's own plugins, so the node types are the app's (`math_inline`,
 * fenced code, tables, wiki-links) rather than a fixture that agrees with my
 * assumptions about them. `textBetween` and the node schema are engine-free:
 * the result is the same in Chromium, in WebKitGTK and in an engine nobody has
 * written. **Delivery** (does the payload reach the OS clipboard) is a different
 * half, verified separately in the browser — neither is evidence for the other.
 */

let editors: NekoEditor[] = []

afterEach(() => {
  editors.forEach((ed) => ed.destroy())
  editors = []
  document.body.innerHTML = ''
})

async function editorWith(markdown: string): Promise<NekoEditor> {
  const el = document.createElement('div')
  document.body.appendChild(el)
  const editor = createEditor(el, { plugins: basicPlugins })
  await editor.open(markdown)
  editors.push(editor)
  return editor
}

/** The document positions spanning the whole document. */
function wholeDoc(editor: NekoEditor): { from: number; to: number } {
  const doc = editor.getView().state.doc
  return { from: 0, to: doc.content.size }
}

describe('selectionTextOf over a real document', () => {
  it('carries a formula the DOM serialiser drops', async () => {
    // The measured defect: the rendered DOM is
    // `<span class="math-node math-inline" contenteditable="false">…</span>`
    // and the engine's copy of this paragraph produced "Inline maths  sits here."
    const editor = await editorWith('Inline maths $E = mc^2$ sits here.\n')
    const { from, to } = wholeDoc(editor)
    const text = selectionTextOf(editor.getView().state.doc, from, to)
    expect(text).toContain('E = mc^2')
    expect(text).not.toBe('Inline maths  sits here.')
  })

  it('carries a fenced code block', async () => {
    const editor = await editorWith('```js\nconst answer = 42\n```\n')
    const { from, to } = wholeDoc(editor)
    expect(selectionTextOf(editor.getView().state.doc, from, to)).toContain('const answer = 42')
  })

  it('carries a TABLE’s text — the case the browser harness could not select', async () => {
    const editor = await editorWith('| left | right |\n| --- | --- |\n| a | b |\n')
    const { from, to } = wholeDoc(editor)
    const text = selectionTextOf(editor.getView().state.doc, from, to)
    for (const cell of ['left', 'right', 'a', 'b']) {
      expect(text, `the table's "${cell}" cell`).toContain(cell)
    }
  })

  it('gives every atom something rather than vanishing it', () => {
    expect(leafTextOf({ type: { name: 'whatever' }, textContent: 'drawn text' } as never)).toBe(
      'drawn text',
    )
  })

  it('selects a range, not just the whole document', async () => {
    const editor = await editorWith('First paragraph.\n\nSecond paragraph.\n')
    const doc = editor.getView().state.doc
    const second = doc.child(1)
    const pos = doc.child(0).nodeSize
    const from = pos + 1
    const to = from + second.textContent.length
    const text = selectionTextOf(doc, from, to)
    expect(text).toContain('Second paragraph.')
    expect(text).not.toContain('First paragraph.')
  })
})
