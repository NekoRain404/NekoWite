import type { MilkdownPlugin } from '@milkdown/ctx'
import { editorViewCtx, EditorViewReady } from '@milkdown/core'
import type { Node, Schema } from '@milkdown/prose/model'
import type { EditorView } from '@milkdown/prose/view'

import { registerCommand, registerMarkdownCommand, registerToolbar, unregisterCommand } from '../registry'
import { isInTableCell } from './context'
import { openTableDialog } from './dialog'

export const TABLE_COMMAND_ID = 'table.insert'

let activeView: EditorView | null = null

/**
 * Keep the insert command's view reference in sync with the live editor.
 * createEditor sets it when the view is ready and clears it on destroy.
 */
export function setTableFeatureView(view: EditorView | null): void {
  activeView = view
}

export function tableMarkdown(rows: number, cols: number): string {
  const header = `| ${Array.from({ length: cols }, (_, c) => String.fromCharCode(97 + c)).join(' | ')} |`
  const sep = `| ${Array.from({ length: cols }, () => '-').join(' | ')} |`
  const body = Array.from({ length: rows - 1 }, (_, r) =>
    `| ${Array.from({ length: cols }, (_, c) => String(r + 1 + c)).join(' | ')} |`
  ).join('\n')
  return body ? `${header}\n${sep}\n${body}` : `${header}\n${sep}`
}

/**
 * Build the rows of a fresh GFM table.
 *
 * Every cell is created with an EXPLICIT `alignment: null` rather than left to
 * `createAndFill()`. The schema's default for that attribute is `'left'`, which
 * is not the same fact: the delimiter row is derived from these attrs, so a
 * table inserted from the toolbar, the slash command or the size dialog was
 * written `| :--- | :--- | :--- |` — explicit left alignment on every column of
 * a table nobody had aligned. A column the author has not marked parses as
 * `null` and is written `| --- |`, and a new table has to match that, or the
 * app is writing syntax into the file that its own author never chose.
 */
export function createTableNode(schema: Schema, rows: number, cols: number): Node {
  const ns = schema.nodes
  const cells = Array.from({ length: cols }, () => ns.table_cell.createAndFill({ alignment: null })).filter(
    (n): n is Node => n !== null
  )
  const headerCells = Array.from({ length: cols }, () => ns.table_header.createAndFill({ alignment: null })).filter(
    (n): n is Node => n !== null
  )
  const rowNodes = Array.from({ length: rows }, (_, i) =>
    i === 0
      ? ns.table_header_row.create(null, headerCells)
      : ns.table_row.create(null, cells)
  )
  return ns.table.create(null, rowNodes)
}

/**
 * Insert a table at the selection. Returns false (and changes nothing) inside a
 * table cell.
 *
 * A table is a block node and a cell holds one paragraph, so the fitter would
 * lift the new table out and split the host table in two — the command has no
 * sensible meaning there, and refusing keeps the document intact.
 */
export function insertTable(view: EditorView, rows: number, cols: number): boolean {
  if (isInTableCell(view.state)) return false
  const node = createTableNode(view.state.schema, rows, cols)
  view.dispatch(view.state.tr.replaceSelectionWith(node))
  return true
}

function insertTableAtCursor(): void {
  if (activeView) {
    openTableDialog(activeView, { rows: 3, cols: 3 })
  }
}

export function tableFeature(): void {
  // `registerCommand` throws on a duplicate id; `registerToolbar` replaces in
  // place, so only the command needs the pre-clear. Unregistering the toolbar
  // entry first would move the button to the END of the toolbar instead.
  unregisterCommand(TABLE_COMMAND_ID)
  registerCommand({ id: TABLE_COMMAND_ID, run: insertTableAtCursor })
  registerToolbar({ id: TABLE_COMMAND_ID, label: 'Table', run: insertTableAtCursor })
  // Source mode: the dialog steps a table grid, but there is no grid to step
  // without the rendered editor, so a default 3x3 Markdown table is inserted.
  registerMarkdownCommand(TABLE_COMMAND_ID, () => `\n${tableMarkdown(3, 3)}\n`)
}

export const tableFeaturePlugin: MilkdownPlugin = (ctx) => {
  return async () => {
    await ctx.wait(EditorViewReady)
    activeView = ctx.get(editorViewCtx)
  }
}

tableFeature()