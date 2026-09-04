/**
 * Table structural operations.
 *
 * Each operation below is a single ProseMirror transaction, so a row/column
 * add or delete is ONE undo step — the same single-undo-per-gesture contract
 * the image resize uses. They operate on the live EditorView and return a
 * boolean success flag so the desktop layer can surface a no-op when the
 * selection is not inside a table (or the edit would violate the GFM schema,
 * which requires exactly one header row and at least one data row).
 */

import type { EditorView } from '@milkdown/prose/view'
import type { Node } from '@milkdown/prose/model'
import {
  addColumnAfter as pmAddColumnAfter,
  addColumnBefore as pmAddColumnBefore,
  addRowAfter as pmAddRowAfter,
  addRowBefore as pmAddRowBefore,
  deleteColumn as pmDeleteColumn,
  deleteRow as pmDeleteRow,
  findTable,
  isInTable,
  selectedRect,
} from '@milkdown/prose/tables'

/** The number of columns in the table under the selection (0 if none). */
export function tableColCount(view: EditorView): number {
  if (!isInTable(view.state)) return 0
  return selectedRect(view.state).map.width
}

/** The number of rows in the table under the selection (0 if none). */
export function tableRowCount(view: EditorView): number {
  const table = findTable(view.state.selection.$from)
  return table ? table.node.childCount : 0
}

/** Add a row below the current row. Single undo. */
export function addRowAfter(view: EditorView): boolean {
  if (!isInTable(view.state)) return false
  return pmAddRowAfter(view.state, view.dispatch)
}

/** Add a row above the current row. Single undo. */
export function addRowBefore(view: EditorView): boolean {
  if (!isInTable(view.state)) return false
  return pmAddRowBefore(view.state, view.dispatch)
}

/**
 * Delete the current row. GFM requires the table to keep a header row plus at
 * least one data row, so deleting the header row (top) or the last data row is
 * refused. Single undo.
 */
export function deleteRowAtCursor(view: EditorView): boolean {
  if (!isInTable(view.state)) return false
  const rect = selectedRect(view.state)
  if (rect.top === 0) return false // never delete the header row
  if (rect.map.height <= 2) return false // header + one data row is the minimum
  return pmDeleteRow(view.state, view.dispatch)
}

/** Add a column to the right of the current column. Single undo. */
export function addColumnAfter(view: EditorView): boolean {
  if (!isInTable(view.state)) return false
  return pmAddColumnAfter(view.state, view.dispatch)
}

/** Add a column to the left of the current column. Single undo. */
export function addColumnBefore(view: EditorView): boolean {
  if (!isInTable(view.state)) return false
  return pmAddColumnBefore(view.state, view.dispatch)
}

/** Delete the current column (refuses to delete the only column). Single undo. */
export function deleteColumnAtCursor(view: EditorView): boolean {
  if (!isInTable(view.state)) return false
  const rect = selectedRect(view.state)
  if (rect.map.width <= 1) return false
  return pmDeleteColumn(view.state, view.dispatch)
}

/** Re-type a row's cells into the target cell type, preserving content/attrs. */
function retypeRow(
  row: Node,
  rowTypeName: string,
  cellTypeName: string,
): Node {
  const cells: Node[] = []
  row.forEach((child) => {
    const cellType = child.type.schema.nodes[cellTypeName]
    cells.push(cellType.create(child.attrs, child.content, child.marks))
  })
  const rowType = row.type.schema.nodes[rowTypeName]
  return rowType.create(row.attrs, cells)
}

/**
 * Toggle which row is the header. GFM always needs a header row at the top, so
 * this promotes the current row to the header (swapping with row 0) — or, when
 * the header itself is selected, demotes it by swapping with the row below.
 * Single undo; schema-safe (always keeps header + >=1 data row).
 */
export function toggleHeaderRow(view: EditorView): boolean {
  if (!isInTable(view.state)) return false
  const rect = selectedRect(view.state)
  const tableNode = rect.table
  const rows: Node[] = []
  tableNode.forEach((r) => rows.push(r))
  if (rows.length < 2) return false
  const headerIndex = 0
  const swapWith = rect.top === headerIndex ? 1 : rect.top
  if (swapWith >= rows.length) return false

  const headerRow = rows[headerIndex]
  const swappedRow = rows[swapWith]
  const nextRows = rows.slice()
  nextRows[headerIndex] = retypeRow(swappedRow, 'table_header_row', 'table_header')
  nextRows[swapWith] = retypeRow(headerRow, 'table_row', 'table_cell')

  const nextTable = tableNode.type.create(tableNode.attrs, nextRows)
  // `rect.tableStart` is not the table node position (it is an offset base for
  // TableMap positions); find the table node position explicitly for replace.
  const found = findTable(view.state.selection.$from)
  if (!found) return false
  const tr = view.state.tr.replaceWith(
    found.pos,
    found.pos + tableNode.nodeSize,
    nextTable,
  )
  view.dispatch(tr.scrollIntoView())
  return true
}

/**
 * Set left/center/right alignment on the affected column(s) of the table under
 * the selection. The markdown `:---:` colons are derived from the header row,
 * so all cells in the selected column(s) (header included) are set, keeping the
 * written markdown in sync with the visible alignment. Single undo.
 */
export function setCellAlignment(
  view: EditorView,
  alignment: 'left' | 'center' | 'right',
): boolean {
  if (!isInTable(view.state)) return false
  const rect = selectedRect(view.state)
  const { map, table, tableStart } = rect
  const tr = view.state.tr
  let changed = false
  // Apply to every cell in the columns spanned by the selection.
  for (let row = 0; row < map.height; row++) {
    for (let col = rect.left; col < rect.right; col++) {
      const cellPos = tableStart + map.positionAt(row, col, table)
      const cell = view.state.doc.nodeAt(cellPos)
      if (cell && (cell.type.name === 'table_cell' || cell.type.name === 'table_header')) {
        if (cell.attrs.alignment !== alignment) {
          tr.setNodeMarkup(cellPos, undefined, { ...cell.attrs, alignment })
          changed = true
        }
      }
    }
  }
  if (!changed) return false
  view.dispatch(tr.scrollIntoView())
  return true
}

/**
 * Set the width (px) of a column by writing the `colwidth` attr on every cell
 * in that column. The headless column-resize drag handle (or the desktop panel)
 * uses this; `colwidth` lives in the doc attrs for the session. GFM has no
 * column-width syntax so it is not serialized to Markdown. Single undo.
 */
export function setColumnWidth(view: EditorView, colIndex: number, width: number): boolean {
  if (!isInTable(view.state) || width <= 0) return false
  const rect = selectedRect(view.state)
  const { map, table, tableStart } = rect
  if (colIndex < 0 || colIndex >= map.width) return false
  const tr = view.state.tr
  let changed = false
  for (let row = 0; row < map.height; row++) {
    const cellPos = tableStart + map.positionAt(row, colIndex, table)
    const cell = view.state.doc.nodeAt(cellPos)
    if (cell && (cell.type.name === 'table_cell' || cell.type.name === 'table_header')) {
      const next = { ...cell.attrs, colwidth: [width] }
      tr.setNodeMarkup(cellPos, undefined, next)
      changed = true
    }
  }
  if (!changed) return false
  view.dispatch(tr.scrollIntoView())
  return true
}
