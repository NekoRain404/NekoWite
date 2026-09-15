import { describe, expect, it } from 'vitest'
import { nextTick } from 'vue'
import { TextSelection } from '@milkdown/prose/state'
import { basicPlugins, createEditor } from '../editor'
import { docCheck, editor, placeCursor, tableCount, withTable } from '../testkit'
import { openTableDialog } from './dialog'

/** Press 确定 in the open dialog, stepping rows/cols up from the 3x3 default. */
function confirm(rows = 3, cols = 3): void {
  const steps = [...document.querySelectorAll('.table-dialog-stepper button')] as HTMLButtonElement[]
  // [rows-, rows+, cols-, cols+]
  for (let i = 0; i < rows - 3; i++) steps[1].click()
  for (let i = 0; i < cols - 3; i++) steps[3].click()
  const ok = [...document.querySelectorAll('.table-dialog-actions button')].find(
    (b) => b.textContent?.trim() === '确定',
  ) as HTMLButtonElement
  ok.click()
}

async function makeEditor(md: string) {
  const el = document.createElement('div')
  document.body.appendChild(el)
  const editor = createEditor(el, { plugins: basicPlugins })
  await editor.open(md)
  await new Promise((r) => setTimeout(r, 0))
  return { editor, el }
}

describe('openTableDialog', () => {
  it('inserts a table for a collapsed caret and closes the overlay', async () => {
    const { editor, el } = await makeEditor('# T\n\nbody\n')
    const view = editor.getView()
    expect(view.state.selection.empty).toBe(true)

    openTableDialog(view, {})
    expect(document.querySelector('.table-dialog')).not.toBeNull()
    confirm()
    expect(document.querySelector('.table-dialog')).toBeNull()

    const md = await editor.save()
    const tableRows = md.split('\n').filter((l) => l.includes('|'))
    expect(tableRows.length).toBeGreaterThanOrEqual(4) // header + separator + 2 body rows

    editor.destroy()
    el.remove()
  })

  it('still inserts when 确定 is pressed with a NON-collapsed selection', async () => {
    // Reported from a real session: select a line, then 表格 -> 确定. The dialog
    // closed and nothing was inserted, because the handler required an empty
    // selection. `insertTable` replaces the selection, like every other
    // "insert" in the editor.
    const { editor, el } = await makeEditor('# T\n\nalpha beta\n')
    const view = editor.getView()
    const doc = view.state.doc
    // Select the paragraph's text, so the selection is NOT collapsed.
    const from = doc.resolve(doc.content.size - 1).start()
    const to = doc.content.size - 1
    view.dispatch(view.state.tr.setSelection(TextSelection.create(doc, from, to)))
    expect(view.state.selection.empty).toBe(false)

    openTableDialog(view, {})
    confirm()
    expect(document.querySelector('.table-dialog')).toBeNull()

    const md = await editor.save()
    expect(md.split('\n').filter((l) => l.includes('|')).length).toBeGreaterThanOrEqual(4)

    editor.destroy()
    el.remove()
  })
})

/**
 * `insertTable` refuses inside a table cell — the new table is a block, and the
 * fitter would lift it out and split the host table in two. The refusal is right;
 * what was wrong is that the dialog discarded it and closed anyway, so 确定 read
 * as a success while the document stayed exactly as it was.
 */
describe('openTableDialog: a refused insert keeps the dialog and says why', () => {
  it('keeps the dialog open when the caret is inside a table cell', async () => {
    const h = await withTable([
      ['H1', 'H2'],
      ['a', 'b'],
    ])
    try {
      placeCursor(h.view, 1, 0)
      const before = await h.ed.save()

      openTableDialog(h.view, {})
      expect(document.querySelector('.table-dialog')).not.toBeNull()
      confirm()
      // The message is state, so it reaches the DOM on Vue's next flush.
      await nextTick()

      // Before the fix the dialog was already gone here, the document was
      // unchanged, and the user had been told nothing.
      const dialog = document.querySelector('.table-dialog')
      expect(dialog, 'the dialog must survive a refused insert').not.toBeNull()
      expect(
        (dialog?.querySelector('.table-dialog-refusal')?.textContent ?? '').trim(),
        'a silent no-op is the defect, not the fix',
      ).not.toBe('')
      expect(tableCount(h.view)).toBe(1)
      expect(await h.ed.save()).toBe(before)
      expect(() => docCheck(h.view), 'document must stay valid').not.toThrow()
    } finally {
      document.querySelector('.table-overlay')?.remove()
      h.destroy()
    }
  })

  it('still inserts the 3×3 and disposes outside a table (the success path is unchanged)', async () => {
    const h = await editor('hello\n')
    try {
      openTableDialog(h.view, {})
      confirm()

      expect(document.querySelector('.table-dialog')).toBeNull()
      expect(tableCount(h.view)).toBe(1)
      expect(() => docCheck(h.view), 'document must stay valid').not.toThrow()
    } finally {
      h.destroy()
    }
  })
})
