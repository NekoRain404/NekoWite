import { afterEach, describe, expect, it } from 'vitest'
import { undoDepth } from '@milkdown/prose/history'
import { TextSelection } from '@milkdown/prose/state'
import type { Node } from '@milkdown/prose/model'
import type { EditorView } from '@milkdown/prose/view'
import { selectedRect } from '@milkdown/prose/tables'

import { basicPlugins, createEditor } from '../editor'
import {
  addColumnAfter,
  addRowAfter,
  deleteColumnAtCursor,
  deleteRowAtCursor,
  setCellAlignment,
  setColumnWidth,
  tableColCount,
  tableRowCount,
  toggleHeaderRow,
} from './ops'

afterEach(() => {
  document.body.innerHTML = ''
})

interface Harness {
  editor: ReturnType<typeof createEditor>
  view: EditorView
}

async function makeTable(rows = 3, cols = 3): Promise<Harness> {
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
  // Setup is not a user edit: keep it out of undo history so each op below is
  // an isolated single undo step (matching the single-undo-per-gesture policy).
  view.dispatch(view.state.tr.replaceSelectionWith(table).setMeta('addToHistory', false))

  // Drop the cursor into the first header cell so selectedRect() resolves.
  let tablePos: number | null = null
  view.state.doc.descendants((n, p) => {
    if (n.type.name === 'table') {
      tablePos = p
      return false
    }
    return true
  })
  view.dispatch(
    view.state.tr
      .setSelection(TextSelection.create(view.state.doc, tablePos! + 3))
      .setMeta('addToHistory', false),
  )
  return { editor, view }
}

function placeCursor(view: EditorView, row: number, col: number): void {
  const rect = selectedRect(view.state)
  const cellPos = rect.tableStart + rect.map.positionAt(row, col, rect.table)
  view.dispatch(
    view.state.tr.setSelection(TextSelection.create(view.state.doc, cellPos + 1)),
  )
}

function cellType(view: EditorView, row: number, col: number): string | null {
  const rect = selectedRect(view.state)
  const cellPos = rect.tableStart + rect.map.positionAt(row, col, rect.table)
  return view.state.doc.nodeAt(cellPos)?.type.name ?? null
}

describe('table structural ops', () => {
  it('addRowAfter grows the table by one data row, single undo', async () => {
    const { editor, view } = await makeTable(3, 3)
    placeCursor(view, 1, 0)
    expect(tableRowCount(view)).toBe(3)
    const before = undoDepth(view.state)

    const ok = addRowAfter(view)
    expect(ok).toBe(true)
    expect(tableRowCount(view)).toBe(4)
    expect(undoDepth(view.state)).toBe(before + 1)
    expect((await editor.save()).trim().split('\n')).toHaveLength(5)
    editor.destroy()
  })

  it('deleteRowAtCursor only removes a non-header, non-last data row', async () => {
    const { editor, view } = await makeTable(4, 3)
    placeCursor(view, 1, 0)
    let ok = deleteRowAtCursor(view)
    expect(ok).toBe(true)
    expect(tableRowCount(view)).toBe(3)

    // Still 2 data rows left: deletable again -> header + 1 data row.
    placeCursor(view, 1, 0)
    ok = deleteRowAtCursor(view)
    expect(ok).toBe(true)
    expect(tableRowCount(view)).toBe(2)

    // Now only the header + 1 data row remains: the last data row is protected.
    placeCursor(view, 1, 0)
    ok = deleteRowAtCursor(view)
    expect(ok).toBe(false)
    expect(tableRowCount(view)).toBe(2)
    editor.destroy()
  })

  it('deleteRowAtCursor refuses the header row', async () => {
    const { editor, view } = await makeTable(3, 3)
    placeCursor(view, 0, 0)
    const ok = deleteRowAtCursor(view)
    expect(ok).toBe(false)
    expect(tableRowCount(view)).toBe(3)
    editor.destroy()
  })

  it('addColumnAfter inserts a column, single undo', async () => {
    const { editor, view } = await makeTable(3, 2)
    placeCursor(view, 1, 0)
    expect(tableColCount(view)).toBe(2)
    const before = undoDepth(view.state)
    const ok = addColumnAfter(view)
    expect(ok).toBe(true)
    expect(tableColCount(view)).toBe(3)
    expect(undoDepth(view.state)).toBe(before + 1)
    editor.destroy()
  })

  it('deleteColumnAtCursor removes a column but never the last', async () => {
    const { editor, view } = await makeTable(3, 3)
    placeCursor(view, 1, 1)
    let ok = deleteColumnAtCursor(view)
    expect(ok).toBe(true)
    expect(tableColCount(view)).toBe(2)

    placeCursor(view, 1, 0)
    ok = deleteColumnAtCursor(view)
    expect(ok).toBe(true)
    expect(tableColCount(view)).toBe(1)

    placeCursor(view, 1, 0)
    ok = deleteColumnAtCursor(view)
    expect(ok).toBe(false)
    expect(tableColCount(view)).toBe(1)
    editor.destroy()
  })

  it('toggleHeaderRow promotes the selected row to the header', async () => {
    const { editor, view } = await makeTable(4, 3)
    expect(cellType(view, 0, 0)).toBe('table_header')
    expect(cellType(view, 2, 0)).toBe('table_cell')

    placeCursor(view, 2, 0)
    const ok = toggleHeaderRow(view)
    expect(ok).toBe(true)

    // Original header demoted to data, the selected row promoted to header.
    expect(cellType(view, 0, 0)).toBe('table_header')
    expect(cellType(view, 2, 0)).toBe('table_cell')
    expect(await editor.save()).toContain('|')
    editor.destroy()
  })

  it('setCellAlignment writes center colons for the affected column', async () => {
    const { editor, view } = await makeTable(3, 3)
    placeCursor(view, 1, 1)
    const ok = setCellAlignment(view, 'center')
    expect(ok).toBe(true)
    const md = await editor.save()
    expect(md).toMatch(/\| :---: |/)
    editor.destroy()
  })

  it('setCellAlignment is a single undo step', async () => {
    const { editor, view } = await makeTable(3, 3)
    placeCursor(view, 1, 0)
    const before = undoDepth(view.state)
    setCellAlignment(view, 'right')
    expect(undoDepth(view.state)).toBe(before + 1)
    editor.destroy()
  })

  it('setColumnWidth writes colwidth attrs on the column cells', async () => {
    const { view } = await makeTable(3, 3)
    placeCursor(view, 1, 1)
    const ok = setColumnWidth(view, 1, 120)
    expect(ok).toBe(true)
    const rect = selectedRect(view.state)
    const cellPos = rect.tableStart + rect.map.positionAt(0, 1, rect.table)
    const cell = view.state.doc.nodeAt(cellPos) as Node
    expect(cell.attrs.colwidth).toEqual([120])
  })
})
