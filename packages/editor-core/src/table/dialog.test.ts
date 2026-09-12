import { describe, expect, it } from 'vitest'
import { TextSelection } from '@milkdown/prose/state'
import { basicPlugins, createEditor } from '../editor'
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
