import { describe, expect, it } from 'vitest'
import { TextSelection } from '@milkdown/prose/state'
import type { EditorView } from '@milkdown/prose/view'

import { editor, placeCursor, tables, withTable } from '../testkit'
import { insertTable } from './plugin'
import { isTableCursorActive, onTableCursorChange } from './selection'

/**
 * Two editors are live at once in this app (the split view), and the table
 * toolbar's flag used to be one module-level boolean: whichever editor
 * dispatched last owned it, so opening a second editor blanked the first one's
 * table menu, and the two raced on every keystroke. The answer belongs to the
 * view, and the no-argument form answers for the editor the user last edited in.
 */

/** A note with a paragraph and then a table; the insert leaves the caret in it. */
async function withParagraphAndTable(): Promise<ReturnType<typeof editor>> {
  const h = await editor('lead\n')
  insertTable(h.view, 2, 2)
  return h
}

/** A position inside the first header cell of `view`'s table. */
function inTable(view: EditorView): number {
  return tables(view)[0].pos + 4
}

function caretAt(view: EditorView, pos: number): void {
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, pos)))
}

describe('the in-table flag belongs to one editor', () => {
  it("a second editor does not overwrite the first editor's state", async () => {
    const a = await withTable([
      ['H1', 'H2'],
      ['a', 'b'],
    ])
    try {
      placeCursor(a.view, 1, 0)
      expect(isTableCursorActive(a.view), 'A has the caret in a cell').toBe(true)

      const b = await editor('plain text\n')
      try {
        expect(isTableCursorActive(a.view), 'A is unchanged by B opening').toBe(true)
        expect(isTableCursorActive(b.view), 'B is not in a table').toBe(false)
      } finally {
        b.destroy()
      }
    } finally {
      a.destroy()
    }
  })

  it('follows its own caret in and out of the table', async () => {
    const h = await withParagraphAndTable()
    try {
      expect(isTableCursorActive(h.view)).toBe(true)
      caretAt(h.view, 1)
      expect(isTableCursorActive(h.view)).toBe(false)
      caretAt(h.view, inTable(h.view))
      expect(isTableCursorActive(h.view)).toBe(true)
    } finally {
      h.destroy()
    }
  })

  it('tells a listener which view changed', async () => {
    const h = await withParagraphAndTable()
    try {
      caretAt(h.view, 1)
      const seen: Array<{ on: boolean; sameView: boolean }> = []
      const stop = onTableCursorChange((on, changed) => {
        seen.push({ on, sameView: changed === h.view })
      })
      caretAt(h.view, inTable(h.view))
      stop()
      expect(seen).toEqual([{ on: true, sameView: true }])
    } finally {
      h.destroy()
    }
  })

  it('hears only about the view it asked for', async () => {
    const a = await withParagraphAndTable()
    const b = await editor('plain text\n')
    try {
      caretAt(a.view, 1)
      const seen: boolean[] = []
      const stop = onTableCursorChange((on) => seen.push(on), a.view)
      b.view.dispatch(b.view.state.tr.insertText('x'))
      expect(seen, "B's transaction must not reach an A-only listener").toEqual([])
      caretAt(a.view, inTable(a.view))
      expect(seen).toEqual([true])
      stop()
    } finally {
      b.destroy()
      a.destroy()
    }
  })
})
