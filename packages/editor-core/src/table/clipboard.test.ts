import { afterEach, describe, expect, it } from 'vitest'
import { undoDepth } from '@milkdown/prose/history'
import { TextSelection } from '@milkdown/prose/state'
import type { Node } from '@milkdown/prose/model'
import type { EditorView } from '@milkdown/prose/view'
import { CellSelection, selectedRect } from '@milkdown/prose/tables'
import { Fragment } from '@milkdown/prose/model'

import { basicPlugins, createEditor } from '../editor'
import {
  cellSelectionToTsv,
  copyCells,
  cutCells,
  getTableClipboard,
  hasCellSelection,
  pasteCells,
  setTableClipboard,
} from './clipboard'
import { tableClipboardKeymap } from './keymap'

afterEach(() => {
  document.body.innerHTML = ''
  setTableClipboard('')
})

interface Harness {
  view: EditorView
}

/** Build a table with specific cell texts (grid[row][col], rows after header). */
async function makeTable(
  rows: number,
  cols: number,
  data: string[][],
): Promise<Harness> {
  const el = document.createElement('div')
  document.body.appendChild(el)
  const editor = createEditor(el, { plugins: basicPlugins })
  await editor.open('')
  const view = editor.getView()
  const mkCell = (text: string, header: boolean): Node => {
    const schema = view.state.schema
    const para = schema.nodes.paragraph.create(
      null,
      text ? schema.text(text) : undefined,
    )
    const type = header ? schema.nodes.table_header : schema.nodes.table_cell
    return type.create(null, Fragment.from(para))
  }
  const rowNodes: Node[] = []
  for (let r = 0; r < rows; r++) {
    const isHeader = r === 0
    const cells: Node[] = []
    for (let c = 0; c < cols; c++) {
      cells.push(mkCell(data[r]?.[c] ?? '', isHeader))
    }
    const rowType = isHeader
      ? view.state.schema.nodes.table_header_row
      : view.state.schema.nodes.table_row
    rowNodes.push(rowType.create(null, Fragment.from(cells)))
  }
  const table = view.state.schema.nodes.table.create(null, Fragment.from(rowNodes))
  // Setup is not a user edit: keep it out of undo history so each op is an
  // isolated single undo step.
  view.dispatch(view.state.tr.replaceSelectionWith(table).setMeta('addToHistory', false))
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
  return { view }
}

function placeCursor(view: EditorView, row: number, col: number): void {
  const rect = selectedRect(view.state)
  const cellPos = rect.tableStart + rect.map.positionAt(row, col, rect.table)
  // `+2` lands inside the cell's paragraph (inline content) so TextSelection
  // does not warn about a non-inline endpoint.
  view.dispatch(
    view.state.tr.setSelection(TextSelection.create(view.state.doc, cellPos + 2)),
  )
}

function selectCells(view: EditorView, r1: number, c1: number, r2: number, c2: number): void {
  const rect = selectedRect(view.state)
  const anchor = rect.tableStart + rect.map.positionAt(r1, c1, rect.table)
  const head = rect.tableStart + rect.map.positionAt(r2, c2, rect.table)
  view.dispatch(
    view.state.tr.setSelection(CellSelection.create(view.state.doc, anchor, head)),
  )
}

function dispatchClipboardKey(view: EditorView, key: string, mod: boolean): boolean {
  const event = new KeyboardEvent('keydown', { key, ctrlKey: mod, metaKey: mod, bubbles: true })
  // `spec.props` is a loose EditorProps map; the keymap's handleKeyDown is the
  // only prop we need here.
  const handler = (tableClipboardKeymap.spec.props as {
    handleKeyDown?: (v: EditorView, e: KeyboardEvent) => boolean | void
  }).handleKeyDown
  if (!handler) return false
  return Boolean(handler(view, event))
}

function cellTextAt(view: EditorView, row: number, col: number): string {
  const rect = selectedRect(view.state)
  const cellPos = rect.tableStart + rect.map.positionAt(row, col, rect.table)
  const cell = view.state.doc.nodeAt(cellPos) as Node
  return cell.textContent
}

describe('table copy / cut / paste', () => {
  it('cellSelectionToTsv serializes a 2-cell selection as a tab fragment', async () => {
    const { view } = await makeTable(3, 2, [
      ['H1', 'H2'],
      ['a', 'b'],
      ['c', 'd'],
    ])
    // Select the two data cells of row 1.
    selectCells(view, 1, 0, 1, 1)
    expect(cellSelectionToTsv(view)).toBe('a\tb')

    // A 2x2 block (rows 1-2) serializes as two rows.
    selectCells(view, 1, 0, 2, 1)
    expect(cellSelectionToTsv(view)).toBe('a\tb\nc\td')
  })

  it('cellSelectionToTsv returns null outside a cell selection', async () => {
    const { view } = await makeTable(3, 2, [
      ['H1', 'H2'],
      ['a', 'b'],
      ['c', 'd'],
    ])
    placeCursor(view, 1, 0) // TextSelection, not CellSelection
    expect(cellSelectionToTsv(view)).toBeNull()
    expect(hasCellSelection(view)).toBe(false)
  })

  it('copyCells writes the selection to the clipboard and is a no-op outside it', async () => {
    const { view } = await makeTable(3, 2, [
      ['H1', 'H2'],
      ['a', 'b'],
      ['c', 'd'],
    ])
    selectCells(view, 1, 0, 1, 1)
    expect(copyCells(view)).toBe(true)
    expect(getTableClipboard()).toBe('a\tb')

    // Outside a cell selection copy falls through (returns false, writes nothing).
    placeCursor(view, 1, 0)
    expect(copyCells(view)).toBe(false)
    expect(getTableClipboard()).toBe('a\tb')
  })

  it('cutCells copies then clears the cells in a single undo step', async () => {
    const { view } = await makeTable(3, 2, [
      ['H1', 'H2'],
      ['a', 'b'],
      ['c', 'd'],
    ])
    selectCells(view, 1, 0, 1, 1)
    const before = undoDepth(view.state)
    expect(cutCells(view)).toBe(true)
    expect(getTableClipboard()).toBe('a\tb')
    // Both data cells are cleared to an empty paragraph.
    expect(cellTextAt(view, 1, 0)).toBe('')
    expect(cellTextAt(view, 1, 1)).toBe('')
    // One cut = one undo step.
    expect(undoDepth(view.state)).toBe(before + 1)
  })

  it('pasteCells fills a matching cell-selection region', async () => {
    const { view } = await makeTable(3, 2, [
      ['H1', 'H2'],
      ['', ''],
      ['', ''],
    ])
    selectCells(view, 1, 0, 2, 1)
    expect(pasteCells(view, 'a\tb\nc\td')).toBe(true)
    expect(cellTextAt(view, 1, 0)).toBe('a')
    expect(cellTextAt(view, 1, 1)).toBe('b')
    expect(cellTextAt(view, 2, 0)).toBe('c')
    expect(cellTextAt(view, 2, 1)).toBe('d')
  })

  it('pasting into the header row keeps header cells (schema stays valid)', async () => {
    const { view } = await makeTable(3, 2, [
      ['H1', 'H2'],
      ['a', 'b'],
      ['c', 'd'],
    ])
    selectCells(view, 0, 0, 0, 1)
    expect(pasteCells(view, 'X\tY')).toBe(true)
    expect(cellTextAt(view, 0, 0)).toBe('X')
    expect(cellTextAt(view, 0, 1)).toBe('Y')
    const rect = selectedRect(view.state)
    const header = view.state.doc.nodeAt(
      rect.tableStart + rect.map.positionAt(0, 0, rect.table),
    ) as Node
    expect(header.type.name).toBe('table_header')
  })

  it('pasteCells does not fire outside a table', async () => {
    const el = document.createElement('div')
    document.body.appendChild(el)
    const editor = createEditor(el, { plugins: basicPlugins })
    await editor.open('hello world')
    const view = editor.getView()
    // Caret in plain paragraph, not a table.
    expect(pasteCells(view, 'a\tb')).toBe(false)
    editor.destroy()
  })

  it('keymap copy/cut/paste only fire on a table selection and never outside', async () => {
    const el = document.createElement('div')
    document.body.appendChild(el)
    const editor = createEditor(el, { plugins: basicPlugins })
    await editor.open('plain text outside a table')
    const view = editor.getView()

    // Copy/cut outside a table -> fall through (return false).
    expect(dispatchClipboardKey(view, 'c', true)).toBe(false)
    expect(dispatchClipboardKey(view, 'x', true)).toBe(false)
    expect(dispatchClipboardKey(view, 'v', true)).toBe(false)
    editor.destroy()
  })

  it('keymap copy + paste with a cell selection round-trips a cell block', async () => {
    const { view } = await makeTable(3, 2, [
      ['H1', 'H2'],
      ['a', 'b'],
      ['', ''],
    ])
    // Copy the non-empty data row.
    selectCells(view, 1, 0, 1, 1)
    expect(dispatchClipboardKey(view, 'c', true)).toBe(true)
    expect(getTableClipboard()).toBe('a\tb')

    // Paste the copied block into the empty row below (matching 1x2 region).
    selectCells(view, 2, 0, 2, 1)
    expect(dispatchClipboardKey(view, 'v', true)).toBe(true)
    expect(cellTextAt(view, 2, 0)).toBe('a')
    expect(cellTextAt(view, 2, 1)).toBe('b')
  })
})
