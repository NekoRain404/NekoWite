/**
 * Table cell copy / cut / paste.
 *
 * GFM has no multi-cell clipboard concept of its own, so these helpers
 * serialize a `CellSelection` (from prosemirror-tables `tableEditing`) to a
 * tab-separated fragment and rebuild a table slice from TSV on paste. The
 * grid-aware insertion is delegated to prosemirror-tables' own `handlePaste`,
 * which clips/repeats the pasted cells to the selected rectangle.
 *
 * Cut clears the selected cells' content in a single transaction (one undo
 * step — the same single-undo-per-gesture contract as the structural ops and
 * the image resize). The clipboard is kept both in `navigator.clipboard`
 * (best-effort, for the native OS clipboard) and in a module-level buffer so a
 * copy+paste within the same editor session works even where the async
 * clipboard API is unavailable (tests, non-secure contexts).
 */

import type { EditorView } from '@milkdown/prose/view'
import type { Node, Schema } from '@milkdown/prose/model'
import { Fragment, Slice } from '@milkdown/prose/model'
import {
  CellSelection,
  handlePaste,
  isInTable,
  selectedRect,
} from '@milkdown/prose/tables'

/**
 * The in-session buffer a copy/cut writes, with the document it was copied from.
 *
 * `doc` is the ProseMirror document the copy saw. Documents are immutable and a
 * new reference means the document changed, so a buffer whose `doc` is not the
 * current one is STALE: pasting it would write text from an older state of the
 * note (or from a different note entirely, since this buffer is module-level and
 * outlives any single editor) over what the user is looking at. Stale buffers are
 * never used — see `isTableClipboardValid`.
 */
let clipboardBuffer: string | null = null
let clipboardDoc: unknown = null

/**
 * Overwrite the in-session table clipboard buffer.
 *
 * The optional `doc` binds the buffer to a document state; pass the live
 * ProseMirror document to make it valid, or nothing to write a buffer that is
 * deliberately invalid (which is what the tests' reset does).
 */
export function setTableClipboard(text: string, doc?: unknown): void {
  clipboardBuffer = text === '' ? null : text
  clipboardDoc = doc ?? null
}

/** Read the in-session table clipboard buffer (empty string when none). */
export function getTableClipboard(): string {
  return clipboardBuffer ?? ''
}

/**
 * Drop the buffer.
 *
 * Called when a new editor instance is created: the buffer is module-level, so
 * without this a copy in one note stayed live in the next one.
 */
export function invalidateTableClipboard(): void {
  clipboardBuffer = null
  clipboardDoc = null
}

/**
 * True when the buffer belongs to the document the caller is editing.
 *
 * This is what makes a paste safe to intercept: the in-session buffer is only a
 * substitute for the OS clipboard while it still describes the document on
 * screen.
 */
export function isTableClipboardValid(view: EditorView): boolean {
  return clipboardBuffer !== null && clipboardDoc === view.state.doc
}

/** Concatenate a cell's block text; multi-block cells become a single field. */
function cellText(cell: Node): string {
  const parts: string[] = []
  cell.forEach((child) => {
    if (child.isTextblock) {
      parts.push(child.textContent)
    } else {
      child.forEach((n) => {
        if (n.textContent) parts.push(n.textContent)
      })
    }
  })
  // Collapse internal newlines so a multi-block cell stays one tab field.
  return parts.join(' ').replace(/\n/g, ' ')
}

/**
 * Serialize the current `CellSelection` (if any) to a tab-separated fragment.
 * `null` when the selection is not a cell selection, so callers can fall
 * through to the normal text copy path.
 */
export function cellSelectionToTsv(view: EditorView): string | null {
  const sel = view.state.selection
  if (!(sel instanceof CellSelection)) return null
  const rect = selectedRect(view.state)
  const { map, table, tableStart } = rect
  const rows: string[] = []
  for (let row = rect.top; row < rect.bottom; row++) {
    const fields: string[] = []
    for (let col = rect.left; col < rect.right; col++) {
      const cellPos = tableStart + map.positionAt(row, col, table)
      const cell = view.state.doc.nodeAt(cellPos)
      fields.push(cell ? cellText(cell) : '')
    }
    rows.push(fields.join('\t'))
  }
  return rows.join('\n')
}

/** True when a `CellSelection` is active (copy/cut only apply to it). */
export function hasCellSelection(view: EditorView): boolean {
  return view.state.selection instanceof CellSelection
}

/**
 * Copy the selected cells to the clipboard. Returns false (and writes
 * nothing) when the selection is not a `CellSelection`, so keyboard copy
 * falls through to normal text copy outside a table.
 */
export function copyCells(view: EditorView): boolean {
  const tsv = cellSelectionToTsv(view)
  if (tsv === null) return false
  clipboardBuffer = tsv
  clipboardDoc = view.state.doc
  try {
    void navigator.clipboard?.writeText(tsv)
  } catch {
    // Clipboard write is best-effort; the in-memory buffer still round-trips.
  }
  return true
}

/**
 * Cut the selected cells: copy them to the clipboard, then clear the selected
 * cells' content in one transaction (one undo step). Returns false when the
 * selection is not a `CellSelection`.
 */
export function cutCells(view: EditorView): boolean {
  const tsv = cellSelectionToTsv(view)
  if (tsv === null) return false
  clipboardBuffer = tsv
  clipboardDoc = view.state.doc
  try {
    void navigator.clipboard?.writeText(tsv)
  } catch {
    // Best-effort.
  }
  const sel = view.state.selection
  if (!(sel instanceof CellSelection)) return false
  const tr = view.state.tr
  const para = view.state.schema.nodes.paragraph.createAndFill()
  if (!para) return false
  const empty = new Slice(Fragment.from(para), 0, 0)
  let changed = false
  sel.forEachCell((cell, pos) => {
    if (cell.content.size === 0) return
    // Replace the cell's inner content (pos+1 .. pos+nodeSize-1) with one empty
    // paragraph, keeping the cell node itself. One transaction = one undo step.
    tr.replace(tr.mapping.map(pos + 1), tr.mapping.map(pos + cell.nodeSize - 1), empty)
    changed = true
  })
  if (!changed) return false
  view.dispatch(tr.scrollIntoView())
  return true
}

/** A cell's node type name for a row type name (header row -> header cell). */
function cellTypeName(rowTypeName: string): string {
  return rowTypeName === 'table_header_row' ? 'table_header' : 'table_cell'
}

/**
 * Build a table fragment slice from TSV text, using the destination rows' cell
 * types so pasting into the GFM header row keeps the schema valid (a header row
 * must contain `table_header` cells, a data row `table_cell`). The slice matches
 * the selected rectangle's dimensions; the destination row for TSV line `i` is
 * `rect.top + i`, so extra lines repeat via the destination's own row type.
 */
function cellsSlice(
  schema: Schema,
  text: string,
  rect: { top: number; bottom: number; left: number; right: number },
  table: Node,
): Slice | null {
  const lines = text.split('\n').filter((l) => l !== '')
  if (lines.length === 0) return null
  const height = rect.bottom - rect.top
  const width = Math.max(1, rect.right - rect.left)
  const rows: Node[] = []
  for (let r = 0; r < height; r++) {
    const destRow = table.child(rect.top + r) as Node
    const rowTypeName = destRow.type.name
    const cellName = cellTypeName(rowTypeName)
    const fields = (lines[r % lines.length] ?? '').split('\t')
    const cells: Node[] = []
    for (let c = 0; c < width; c++) {
      const field = fields[c] ?? ''
      const content = field ? schema.text(field) : undefined
      const para = schema.nodes.paragraph.create(null, content)
      cells.push(schema.nodes[cellName].create(null, Fragment.from(para)))
    }
    rows.push(schema.nodes[rowTypeName].create(null, Fragment.from(cells)))
  }
  return new Slice(Fragment.from(rows), 0, 0)
}

/**
 * Paste TSV (or any tab-separated text) into the current table region. Uses
 * prosemirror-tables' `handlePaste` so an active `CellSelection` clips/repeats
 * the pasted cells to the selected rectangle and a plain in-cell caret fills
 * from the current cell (growing the table if needed). Returns false when the
 * caret is outside a table.
 */
export function pasteCells(view: EditorView, text: string): boolean {
  if (!isInTable(view.state)) return false
  const rect = selectedRect(view.state)
  const slice = cellsSlice(view.state.schema, text, rect, rect.table)
  if (!slice) return false
  return handlePaste(view, {} as ClipboardEvent, slice)
}
