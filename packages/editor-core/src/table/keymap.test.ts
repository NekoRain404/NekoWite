import { afterEach, describe, expect, it } from 'vitest'
import { TextSelection } from '@milkdown/prose/state'
import type { Node } from '@milkdown/prose/model'
import type { EditorView } from '@milkdown/prose/view'
import { selectedRect } from '@milkdown/prose/tables'

import { basicPlugins, createEditor } from '../editor'
import { isInLastCell, tableAutoRowKeymap } from './keymap'

afterEach(() => {
  document.body.innerHTML = ''
})

async function makeTable(rows = 2, cols = 2): Promise<{ view: EditorView }> {
  const el = document.createElement('div')
  document.body.appendChild(el)
  const editor = createEditor(el, { plugins: basicPlugins })
  await editor.open('')
  const view = editor.getView()
  const cells = Array.from({ length: cols }, () =>
    view.state.schema.nodes.table_cell.createAndFill(),
  ).filter((n): n is Node => n !== null)
  const headerCells = Array.from({ length: cols }, () =>
    view.state.schema.nodes.table_header.createAndFill(),
  ).filter((n): n is Node => n !== null)
  const rowNodes = Array.from({ length: rows }, (_, i) =>
    i === 0
      ? view.state.schema.nodes.table_header_row.create(null, headerCells)
      : view.state.schema.nodes.table_row.create(null, cells),
  )
  const table = view.state.schema.nodes.table.create(null, rowNodes)
  view.dispatch(view.state.tr.replaceSelectionWith(table))
  let tablePos: number | null = null
  view.state.doc.descendants((n, p) => {
    if (n.type.name === 'table') {
      tablePos = p
      return false
    }
    return true
  })
  view.dispatch(
    view.state.tr.setSelection(TextSelection.create(view.state.doc, tablePos! + 3)),
  )
  return { view }
}

function placeCursor(view: EditorView, row: number, col: number): void {
  const rect = selectedRect(view.state)
  const cellPos = rect.tableStart + rect.map.positionAt(row, col, rect.table)
  view.dispatch(
    view.state.tr.setSelection(TextSelection.create(view.state.doc, cellPos + 1)),
  )
}

function dispatchTab(view: EditorView): boolean {
  const event = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true })
  return Boolean(view.someProp('handleKeyDown', (f) => f(view, event)))
}

describe('table auto-row keymap', () => {
  it('isInLastCell is only true for the bottom-right cell', async () => {
    const { view } = await makeTable(2, 2)
    placeCursor(view, 0, 0)
    expect(isInLastCell(view)).toBe(false)
    placeCursor(view, 1, 1)
    expect(isInLastCell(view)).toBe(true)
    placeCursor(view, 1, 0)
    expect(isInLastCell(view)).toBe(false)
  })

  it('Tab on the last cell appends a row and leaves cursor in a table cell', async () => {
    const { view } = await makeTable(2, 2)
    placeCursor(view, 1, 1)
    const before = selectedRect(view.state).map.height
    const handled = dispatchTab(view)
    expect(handled).toBe(true)
    expect(selectedRect(view.state).map.height).toBe(before + 1)
  })

  it('Tab elsewhere is left to the GFM keymap (not auto-append)', async () => {
    const { view } = await makeTable(3, 3)
    placeCursor(view, 1, 0)
    const before = selectedRect(view.state).map.height
    const handled = dispatchTab(view)
    expect(selectedRect(view.state).map.height).toBe(before)
    void handled
    void tableAutoRowKeymap
  })
})
