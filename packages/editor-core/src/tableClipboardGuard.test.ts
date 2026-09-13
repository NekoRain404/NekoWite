import { afterEach, describe, expect, it } from 'vitest'
import type { Node } from '@milkdown/prose/model'
import { TextSelection } from '@milkdown/prose/state'
import { CellSelection } from '@milkdown/prose/tables'

import { gridText, placeCursor, pasteRecorder, selectCells, withTable } from './testkit'
import { getTableClipboard, setTableClipboard } from './table/clipboard'
import { tableClipboardKeymap } from './table/keymap'

afterEach(() => {
  document.body.innerHTML = ''
  setTableClipboard('')
})

function pressClipboardKey(view: Parameters<typeof placeCursor>[0], key: string): { handled: boolean; prevented: boolean } {
  const event = new KeyboardEvent('keydown', { key, ctrlKey: true, bubbles: true, cancelable: true })
  const handled = Boolean(
    view.someProp('handleKeyDown', (f) => f(view, event)),
  )
  return { handled, prevented: event.defaultPrevented }
}

/**
 * A table copy must not hijack Ctrl+V anywhere else.
 *
 * The module-level buffer used to be intercepted for ANY paste inside ANY table
 * (and any later paste in the session, even in another document): the caret's
 * cell was overwritten with the old copy and the user's real clipboard content
 * was dropped. Worse, `preventDefault()` suppressed the native paste event, so
 * pasting an IMAGE into a cell stopped working at all.
 *
 * Paste now only intercepts when a CellSelection is active AND the buffer still
 * belongs to the current document state. Otherwise it returns false and lets the
 * native paste event through.
 */
describe('the table clipboard does not hijack Ctrl+V outside a cell selection', () => {
  it('leaves a plain caret in another table to the native paste path', async () => {
    const h = await withTable([
      ['H1', 'H2'],
      ['copied', 'buffer'],
      ['t1', 't2'],
    ])
    try {
      // Copy a real cell selection first, so the in-session buffer is populated.
      selectCells(h.view, 1, 0, 1, 1)
      expect(pressClipboardKey(h.view, 'c')).toEqual({ handled: true, prevented: true })
      expect(getTableClipboard()).toBe('copied\tbuffer')

      // A SECOND table in the same document, caret inside a cell (TextSelection).
      const schema = h.view.state.schema
      const header = schema.nodes.table_header.createAndFill()
      const cell = schema.nodes.table_cell.createAndFill()
      expect(header).not.toBeNull()
      expect(cell).not.toBeNull()
      h.view.dispatch(
        h.view.state.tr.insert(
          h.view.state.doc.content.size,
          schema.nodes.table.create(null, [
            schema.nodes.table_header_row.create(null, [header as Node]),
            schema.nodes.table_row.create(null, [cell as Node]),
          ]),
        ),
      )
      const before = gridText(h.view)
      const second = h.view.state.doc.lastChild
      expect(second?.type.name).toBe('table')
      // Caret in the second table's header cell (inside the first paragraph).
      const pos = h.view.state.doc.content.size - (second?.nodeSize ?? 0) + 4
      h.view.dispatch(h.view.state.tr.setSelection(TextSelection.create(h.view.state.doc, pos)))
      expect(h.view.state.selection).not.toBeInstanceOf(CellSelection)

      const result = pressClipboardKey(h.view, 'v')
      expect(result.handled).toBe(false)
      // The defect: preventDefault() made the browser's own paste never fire.
      expect(result.prevented).toBe(false)
      expect(gridText(h.view)).toEqual(before)
    } finally {
      h.destroy()
    }
  })

  it('drops a stale buffer instead of pasting it into a new document', async () => {
    const h = await withTable([
      ['H1', 'H2'],
      ['stale-a', 'stale-b'],
    ])
    try {
      selectCells(h.view, 1, 0, 1, 1)
      expect(pressClipboardKey(h.view, 'c').handled).toBe(true)

      // Any edit after the copy means the buffer no longer describes the document
      // the user is looking at — an old copy must never be pasted blind.
      h.view.dispatch(h.view.state.tr.insertText('x', 1))
      placeCursor(h.view, 1, 0)
      selectCells(h.view, 1, 0, 1, 1)
      const before = gridText(h.view)
      const result = pressClipboardKey(h.view, 'v')
      expect(result.handled).toBe(false)
      expect(result.prevented).toBe(false)
      expect(gridText(h.view)).toEqual(before)
    } finally {
      h.destroy()
    }
  })

  it('does not leak the buffer into a second editor instance', async () => {
    const first = await withTable([
      ['H1', 'H2'],
      ['leaked', 'value'],
    ])
    selectCells(first.view, 1, 0, 1, 1)
    expect(pressClipboardKey(first.view, 'c').handled).toBe(true)
    expect(getTableClipboard()).toBe('leaked\tvalue')
    first.destroy()

    // Opening another note builds a new editor over the same module state.
    const second = await withTable([
      ['H1', 'H2'],
      ['keep', 'me'],
    ])
    try {
      selectCells(second.view, 1, 0, 1, 1)
      const before = gridText(second.view)
      const result = pressClipboardKey(second.view, 'v')
      expect(result.handled).toBe(false)
      expect(gridText(second.view)).toEqual(before)
    } finally {
      second.destroy()
    }
  })

  it('still pastes the buffer into the cell selection it was copied from', async () => {
    // The behavior that must be preserved: an immediate copy→paste in the same
    // document keeps working without the OS clipboard.
    const h = await withTable([
      ['H1', 'H2'],
      ['a', 'b'],
      ['', ''],
    ])
    try {
      selectCells(h.view, 1, 0, 1, 1)
      expect(pressClipboardKey(h.view, 'c').handled).toBe(true)
      selectCells(h.view, 2, 0, 2, 1)
      expect(pressClipboardKey(h.view, 'v')).toEqual({ handled: true, prevented: true })
      expect(gridText(h.view)).toEqual(['H1', 'H2', 'a', 'b', 'a', 'b'])
    } finally {
      h.destroy()
    }
  })

  it('lets an image paste event reach the view (no preventDefault in the table keymap)', async () => {
    const { plugin, events } = pasteRecorder()
    const h = await withTable(
      [
        ['H1', 'H2'],
        ['cell', 'body'],
      ],
      { plugins: [plugin] },
    )
    try {
      selectCells(h.view, 1, 0, 1, 1)
      expect(pressClipboardKey(h.view, 'c').handled).toBe(true)
      placeCursor(h.view, 1, 1)

      const result = pressClipboardKey(h.view, 'v')
      expect(result.handled).toBe(false)
      expect(result.prevented).toBe(false)

      // With the keymap out of the way the DOM paste event reaches the view, so
      // the host's capture-phase image intake (useImageIntake) can run.
      const file = new File([new Uint8Array([1, 2, 3])], 'pic.png', { type: 'image/png' })
      const pasteEvent = new Event('paste', { bubbles: true, cancelable: true })
      Object.defineProperty(pasteEvent, 'clipboardData', {
        value: { files: [file], types: ['Files'], getData: () => '' },
      })
      h.view.dom.dispatchEvent(pasteEvent)
      expect(events.length).toBe(1)
    } finally {
      h.destroy()
    }
  })

  it('does not fill only the first field when a multi-cell copy meets a plain caret', async () => {
    // D9: the slice used to be sized from the caret's 1x1 rect, so only the first
    // field of a 2x2 copy was written. Now the keymap stays out of the way.
    const h = await withTable([
      ['H1', 'H2'],
      ['a', 'b'],
      ['c', 'd'],
      ['keep', 'row'],
    ])
    try {
      selectCells(h.view, 1, 0, 2, 1)
      expect(pressClipboardKey(h.view, 'c').handled).toBe(true)
      placeCursor(h.view, 3, 0)
      const before = gridText(h.view)
      const result = pressClipboardKey(h.view, 'v')
      expect(result.handled).toBe(false)
      expect(result.prevented).toBe(false)
      expect(gridText(h.view)).toEqual(before)
    } finally {
      h.destroy()
    }
  })
})

void tableClipboardKeymap
