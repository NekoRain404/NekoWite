import { describe, expect, it } from 'vitest'
import { TextSelection } from '@milkdown/prose/state'
import type { EditorView } from '@milkdown/prose/view'

import { runBuiltinCommandOn } from './commands'
import { insertMath } from './math/feature'
import { insertTable } from './table/plugin'
import {
  countNodes,
  editor,
  docCheck,
  gridText,
  placeCursor,
  tableCount,
  typeText,
  withTable,
} from './testkit'

/**
 * A block node cannot live inside a GFM cell: the cell's content is a single
 * \`paragraph\`. ProseMirror's fitter therefore lifts the block out of the cell
 * and splits the table in two, leaving a phantom row behind — with
 * \`doc.check()\` still passing, so nothing warned the user before the next save
 * wrote the split to disk. Every block-producing entry point below now checks
 * \`isInTableCell\` first and either keeps the change inline (images, inline math,
 * the inline part of a markdown snippet) or refuses outright.
 *
 * Refusing (rather than inserting after the table) is deliberate: the caret is
 * inside a cell, so a block inserted "after the table" would land somewhere the
 * user did not point at and would need a second edit to move. A refusal leaves
 * the document exactly as it was, which is the only outcome that cannot lose
 * data.
 */

/** The caret's cell paragraph bounds, for the input-rule tests. */
function caretParagraph(view: EditorView): { from: number; to: number } {
  const { $from } = view.state.selection
  return { from: $from.start(), to: $from.end() }
}

describe('block inserts inside a table cell never split the table', () => {
  it('the hr toolbar command is refused', async () => {
    const h = await withTable([
      ['H1', 'H2'],
      ['a', 'b'],
    ])
    try {
      placeCursor(h.view, 1, 0)
      const before = gridText(h.view)
      runBuiltinCommandOn('hr', h.view)

      expect(tableCount(h.view)).toBe(1)
      expect(countNodes(h.view, 'hr')).toBe(0)
      expect(gridText(h.view)).toEqual(before)
      expect(() => docCheck(h.view), 'document must stay valid').not.toThrow()
    } finally {
      h.destroy()
    }
  })

  it('the component toolbar command is refused', async () => {
    const h = await withTable([
      ['H1', 'H2'],
      ['a', 'b'],
    ])
    try {
      placeCursor(h.view, 1, 1)
      const before = gridText(h.view)
      runBuiltinCommandOn('insert-component', h.view)

      expect(tableCount(h.view)).toBe(1)
      expect(countNodes(h.view, 'mdxComponent')).toBe(0)
      expect(gridText(h.view)).toEqual(before)
      expect(() => docCheck(h.view), 'document must stay valid').not.toThrow()
    } finally {
      h.destroy()
    }
  })

  it('the table insert command is refused', async () => {
    const h = await withTable([
      ['H1', 'H2'],
      ['a', 'b'],
    ])
    try {
      placeCursor(h.view, 1, 0)
      const before = gridText(h.view)
      expect(insertTable(h.view, 2, 2)).toBe(false)
      expect(tableCount(h.view)).toBe(1)
      expect(gridText(h.view)).toEqual(before)
      expect(() => docCheck(h.view), 'document must stay valid').not.toThrow()
    } finally {
      h.destroy()
    }
  })

  it('display math is refused (it is a block node)', async () => {
    const h = await withTable([
      ['H1', 'H2'],
      ['a', 'b'],
    ])
    try {
      placeCursor(h.view, 1, 0)
      const before = gridText(h.view)
      expect(insertMath(h.view, 'x^2', 'display')).toBe(false)
      expect(tableCount(h.view)).toBe(1)
      expect(countNodes(h.view, 'math_display')).toBe(0)
      expect(gridText(h.view)).toEqual(before)
      expect(() => docCheck(h.view), 'document must stay valid').not.toThrow()
    } finally {
      h.destroy()
    }
  })

  it('inline math still lands in the cell', async () => {
    const h = await withTable([
      ['H1', 'H2'],
      ['a', 'b'],
    ])
    try {
      placeCursor(h.view, 1, 0)
      expect(insertMath(h.view, 'x^2', 'inline')).toBe(true)
      expect(tableCount(h.view)).toBe(1)
      expect(countNodes(h.view, 'math_inline')).toBe(1)
      // The formula lands in the caret's cell (which already held "a"), and the
      // cell still reports both: the math node's text is "x^2".
      expect(gridText(h.view)[2]).toContain('a')
      expect(gridText(h.view)[2]).toContain('x^2')
      expect(() => docCheck(h.view), 'document must stay valid').not.toThrow()
    } finally {
      h.destroy()
    }
  })
})

describe('insertMarkdownAtCursor inside a cell keeps the markdown that survives', () => {
  it('an image snippet lands in the cell instead of splitting the table', async () => {
    const h = await withTable([
      ['H1', 'H2'],
      ['a', 'b'],
    ])
    try {
      placeCursor(h.view, 1, 0)
      await h.ed.insertMarkdownAtCursor('\n\n![pic](attachments/2026-09/a.png)\n\n')
      const md = await h.ed.save()

      expect(tableCount(h.view)).toBe(1)
      expect(countNodes(h.view, 'image')).toBe(1)
      expect(md).toContain('attachments/2026-09/a.png')
      expect(md).toContain('H1')
      expect(md).toContain('b')
      expect(() => docCheck(h.view), 'document must stay valid').not.toThrow()
    } finally {
      h.destroy()
    }
  })

  it('a plain-text paragraph replaces the cell content (AI insert at cursor)', async () => {
    const h = await withTable([
      ['H1', 'H2'],
      ['old', 'b'],
    ])
    try {
      placeCursor(h.view, 1, 0)
      await h.ed.insertMarkdownAtCursor('brand new text\n')
      expect(tableCount(h.view)).toBe(1)
      expect(gridText(h.view)[2]).toBe('brand new text')
      expect(() => docCheck(h.view), 'document must stay valid').not.toThrow()
    } finally {
      h.destroy()
    }
  })

  it('block-only markdown is refused so the table survives', async () => {
    const h = await withTable([
      ['H1', 'H2'],
      ['a', 'b'],
    ])
    try {
      placeCursor(h.view, 1, 0)
      const before = gridText(h.view)
      await h.ed.insertMarkdownAtCursor('---\n')
      expect(tableCount(h.view)).toBe(1)
      expect(countNodes(h.view, 'hr')).toBe(0)
      expect(gridText(h.view)).toEqual(before)
      expect(() => docCheck(h.view), 'document must stay valid').not.toThrow()
    } finally {
      h.destroy()
    }
  })

  it('the empty-paragraph marker does not become cell text', async () => {
    const h = await withTable([
      ['H1', 'H2'],
      ['a', 'b'],
    ])
    try {
      placeCursor(h.view, 1, 0)
      await h.ed.insertMarkdownAtCursor('\n\n<br />\n\n')
      expect(tableCount(h.view)).toBe(1)
      expect(gridText(h.view)[2]).toBe('')
      expect(() => docCheck(h.view), 'document must stay valid').not.toThrow()
    } finally {
      h.destroy()
    }
  })
})

/**
 * D4: the \`---\` input rule is the only block rule with no schema guard. Milkdown
 * replaces \`start - 1 .. end\` (the whole cell paragraph) with an \`hr\`, and the
 * fitter lifts it out of the cell — splitting the table with no button press.
 * The rule now checks \`canReplaceWith\` for the same range, which is false inside
 * a cell, so the dashes stay literal text.
 */
describe('block input rules are inert inside a cell', () => {
  it('typing --- in a cell produces no hr and does not split the table', async () => {
    const h = await withTable([
      ['H1', 'H2'],
      ['', 'b'],
    ])
    try {
      placeCursor(h.view, 1, 0)
      const { from } = caretParagraph(h.view)
      typeText(h.view, '---', from)

      expect(tableCount(h.view)).toBe(1)
      expect(countNodes(h.view, 'hr')).toBe(0)
      expect(h.view.state.doc.textContent).toContain('---')
      expect(() => docCheck(h.view), 'document must stay valid').not.toThrow()
    } finally {
      h.destroy()
    }
  })

  it('typing ___ and *** in a cell are inert too', async () => {
    for (const seq of ['___ ', '*** ']) {
      const h = await withTable([
        ['H1', 'H2'],
        ['', 'b'],
      ])
      try {
        placeCursor(h.view, 1, 0)
        const { from } = caretParagraph(h.view)
        typeText(h.view, seq, from)
        expect(tableCount(h.view), seq).toBe(1)
        expect(countNodes(h.view, 'hr'), seq).toBe(0)
        expect(() => docCheck(h.view), 'document must stay valid').not.toThrow()
      } finally {
        h.destroy()
      }
    }
  })

  it('typing --- in a plain paragraph still makes a thematic break', async () => {
    const h = await editor('x\n')
    try {
      // The rule's match spans the whole paragraph content, so the paragraph is
      // cleared first and the dashes are the only thing in it.
      h.view.dispatch(
        h.view.state.tr.setSelection(
          TextSelection.create(h.view.state.doc, 1, h.view.state.doc.content.size - 1),
        ),
      )
      h.view.dispatch(h.view.state.tr.deleteSelection())
      const { from } = caretParagraph(h.view)
      typeText(h.view, '---', from)
      expect(countNodes(h.view, 'hr')).toBe(1)
      expect(() => docCheck(h.view), 'document must stay valid').not.toThrow()
    } finally {
      h.destroy()
    }
  })
})

describe('the same commands still work outside a table (no regression)', () => {
  it('hr and component insert normally in a paragraph', async () => {
    const h = await editor('hello\n')
    try {
      runBuiltinCommandOn('hr', h.view)
      expect(countNodes(h.view, 'hr')).toBe(1)
      runBuiltinCommandOn('insert-component', h.view)
      expect(countNodes(h.view, 'mdxComponent')).toBe(1)
      expect(() => docCheck(h.view), 'document must stay valid').not.toThrow()
    } finally {
      h.destroy()
    }
  })

  it('insertTable inserts at a plain caret', async () => {
    const h = await editor('hello\n')
    try {
      expect(insertTable(h.view, 3, 3)).toBe(true)
      expect(tableCount(h.view)).toBe(1)
      expect(() => docCheck(h.view), 'document must stay valid').not.toThrow()
    } finally {
      h.destroy()
    }
  })

  it('insertMarkdownAtCursor keeps inserting blocks outside a table', async () => {
    const h = await editor('hello\n')
    try {
      await h.ed.insertMarkdownAtCursor('\n\n---\n\n')
      expect(countNodes(h.view, 'hr')).toBe(1)
      expect(tableCount(h.view)).toBe(0)
      expect(() => docCheck(h.view), 'document must stay valid').not.toThrow()
    } finally {
      h.destroy()
    }
  })
})
