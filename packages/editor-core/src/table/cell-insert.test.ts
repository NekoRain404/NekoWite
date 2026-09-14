import { describe, expect, it } from 'vitest'
import { TextSelection } from '@milkdown/prose/state'
import type { EditorView } from '@milkdown/prose/view'

import {
  countNodes,
  docCheck,
  gridText,
  placeCursor,
  selectCells,
  tableCount,
  withTable,
} from '../testkit'

/**
 * `insertMarkdownAtCursor` is the image intake and the AI insert: it lands the
 * snippet's first text block INLINE AT THE CARET. A table cell used to be the
 * exception — the whole cell's paragraph was replaced, so a caret before
 * "hello" in a cell holding "h hello world" turned the cell into "X" and the
 * save wrote the loss to disk. These cases pin the caret's text surviving, in
 * the cell as well as outside it.
 */

/** Put the caret at `offset` characters into the cell paragraph's text. */
function caretInCell(view: EditorView, row: number, col: number, offset: number): void {
  placeCursor(view, row, col)
  const { $from } = view.state.selection
  const at = Math.min($from.start() + offset, $from.end())
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, at)))
}

describe('insertMarkdownAtCursor inside a table cell inserts at the caret', () => {
  it('keeps the text before and after a mid-cell caret', async () => {
    const h = await withTable([
      ['H1', 'H2'],
      ['h hello world', 'b'],
    ])
    try {
      caretInCell(h.view, 1, 0, 2)
      await h.ed.insertMarkdownAtCursor('X')

      expect(tableCount(h.view)).toBe(1)
      expect(gridText(h.view)[2]).toBe('h Xhello world')
      expect(gridText(h.view)[3]).toBe('b')
      expect(await h.ed.save()).toContain('h Xhello world')
      expect(() => docCheck(h.view), 'document must stay valid').not.toThrow()
    } finally {
      h.destroy()
    }
  })

  it('keeps the whole cell when the caret is at the end', async () => {
    const h = await withTable([
      ['H1', 'H2'],
      ['h hello world', 'b'],
    ])
    try {
      caretInCell(h.view, 1, 0, Number.MAX_SAFE_INTEGER)
      await h.ed.insertMarkdownAtCursor('X')

      expect(tableCount(h.view)).toBe(1)
      expect(gridText(h.view)[2]).toBe('h hello worldX')
      expect(() => docCheck(h.view), 'document must stay valid').not.toThrow()
    } finally {
      h.destroy()
    }
  })

  it('replaces only the selected range', async () => {
    const h = await withTable([
      ['H1', 'H2'],
      ['h hello world', 'b'],
    ])
    try {
      placeCursor(h.view, 1, 0)
      const { $from } = h.view.state.selection
      const from = $from.start() + 2
      const to = from + 5 // "hello"
      h.view.dispatch(h.view.state.tr.setSelection(TextSelection.create(h.view.state.doc, from, to)))
      await h.ed.insertMarkdownAtCursor('X')

      expect(gridText(h.view)[2]).toBe('h X world')
      expect(() => docCheck(h.view), 'document must stay valid').not.toThrow()
    } finally {
      h.destroy()
    }
  })

  it('leaves a rectangular cell selection alone', async () => {
    const h = await withTable([
      ['H1', 'H2'],
      ['a', 'b'],
    ])
    try {
      // A cell selection is not a caret: its range is made of cells, and a
      // cell's single paragraph cannot be handed inline content in place of a
      // range that reaches past it.
      selectCells(h.view, 1, 0, 1, 1)
      await h.ed.insertMarkdownAtCursor('X')
      expect(gridText(h.view)).toEqual(['H1', 'H2', 'a', 'b'])
      expect(() => docCheck(h.view), 'document must stay valid').not.toThrow()
    } finally {
      h.destroy()
    }
  })

  it('an image snippet lands at the caret with the cell text intact', async () => {
    const h = await withTable([
      ['H1', 'H2'],
      ['caption', 'b'],
    ])
    try {
      caretInCell(h.view, 1, 0, Number.MAX_SAFE_INTEGER)
      await h.ed.insertMarkdownAtCursor('\n\n![pic](attachments/2026-09/a.png)\n\n')

      expect(tableCount(h.view)).toBe(1)
      expect(countNodes(h.view, 'image')).toBe(1)
      expect(gridText(h.view)[2]).toContain('caption')
      expect(await h.ed.save()).toContain('attachments/2026-09/a.png')
      expect(() => docCheck(h.view), 'document must stay valid').not.toThrow()
    } finally {
      h.destroy()
    }
  })
})
