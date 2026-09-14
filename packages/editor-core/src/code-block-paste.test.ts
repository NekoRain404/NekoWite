import { describe, expect, it } from 'vitest'
import { TextSelection } from '@milkdown/prose/state'

import { editor, pasteIntoView } from './testkit'

/**
 * A paste into a code block is plain text, whatever the clipboard carries.
 *
 * The schema says a `code_block` holds text, so a pasted `text/html` slice is
 * parsed into block nodes that fit nowhere — the fitter lifts them out of the
 * fence and the code block breaks apart, with the text that followed it turning
 * into ordinary paragraphs. The whitespace of the HTML fallback is also not the
 * code: blank lines between source paragraphs came along and changed the code
 * the next time the file was opened. Code is plain text by definition, so the
 * HTML flavor is dropped and the text flavor is used verbatim.
 */
describe('D11: pasting HTML into a code block', () => {
  it('keeps one code block and inserts plain text, changing nothing else', async () => {
    const h = await editor('~~~js\nconst a = 1\n~~~\n')
    try {
      const codeBlock = h.view.state.doc.child(0)
      expect(codeBlock.type.name).toBe('code_block')
      const before = codeBlock.textContent
      // Caret at the end of the single code line.
      h.view.dispatch(
        h.view.state.tr.setSelection(
          TextSelection.create(h.view.state.doc, codeBlock.nodeSize - 1),
        ),
      )

      // A realistic rich payload: ProseMirror parses this into a paragraph with a
      // styled run, then a second paragraph — block content a code_block cannot
      // hold, which is what used to break the fence apart on the unguarded path.
      pasteIntoView(
        h.view,
        'const b = 2',
        '<p>const <code>b</code> = <b>2</b></p><pre><code>next()</code></pre>',
      )
      const md = await h.ed.save()

      let codeBlocks = 0
      h.view.state.doc.descendants((node) => {
        if (node.type.name === 'code_block') codeBlocks += 1
        return true
      })
      expect(codeBlocks, JSON.stringify(md)).toBe(1)
      // One fenced block in the saved file: the fence was not cut in half.
      expect(md.split('```').length - 1).toBe(2)
      expect(md).toContain('const b = 2')
      expect(md).not.toContain('<b>')
      expect(md).toContain(before)
      // The guarded pasted text is the clipboard TEXT, not the HTML rendering.
      expect(h.view.state.doc.child(0).textContent).toBe(before + 'const b = 2')
    } finally {
      h.destroy()
    }
  })

  it('does not let HTML block breaks become blank lines in the code', async () => {
    const h = await editor('~~~py\nprint(1)\n~~~\n')
    try {
      const codeBlock = h.view.state.doc.child(0)
      h.view.dispatch(
        h.view.state.tr.setSelection(
          TextSelection.create(h.view.state.doc, codeBlock.nodeSize - 1),
        ),
      )
      // The plain-text fallback of two stacked paragraphs carries a blank line,
      // which would survive into the saved fence and change the code on reopen.
      pasteIntoView(h.view, 'print(2)\n\nprint(3)', '<p>print(2)</p><p>print(3)</p>')
      const saved = await h.ed.save()
      expect(saved).toContain('print(1)print(2)')
      expect(saved).not.toMatch(/print\(2\)\n\s*\n/)

      const again = await editor(saved)
      try {
        let codeBlocks = 0
        again.view.state.doc.descendants((node) => {
          if (node.type.name === 'code_block') codeBlocks += 1
          return true
        })
        expect(codeBlocks).toBe(1)
      } finally {
        again.destroy()
      }
    } finally {
      h.destroy()
    }
  })

  it('pastes rich text normally outside a code block', async () => {
    const h = await editor('hello\n')
    try {
      pasteIntoView(h.view, 'world', '<p>world</p>')
      const md = await h.ed.save()
      expect(md).toContain('world')
    } finally {
      h.destroy()
    }
  })
})
