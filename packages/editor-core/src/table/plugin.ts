import type { MilkdownPlugin } from '@milkdown/ctx'
import { editorViewCtx } from '@milkdown/core'
import type { Node, Schema } from '@milkdown/prose/model'
import type { EditorView } from '@milkdown/prose/view'

import { registerCommand, registerToolbar } from '../registry'

export const TABLE_COMMAND_ID = 'table.insert'

let activeView: EditorView | null = null

export function tableMarkdown(rows: number, cols: number): string {
  const header = `| ${Array.from({ length: cols }, (_, c) => String.fromCharCode(97 + c)).join(' | ')} |`
  const sep = `| ${Array.from({ length: cols }, () => '-').join(' | ')} |`
  const body = Array.from({ length: rows - 1 }, (_, r) =>
    `| ${Array.from({ length: cols }, (_, c) => String(r + 1 + c)).join(' | ')} |`
  ).join('\n')
  return body ? `${header}\n${sep}\n${body}` : `${header}\n${sep}`
}

export function createTableNode(schema: Schema, rows: number, cols: number): Node {
  const ns = schema.nodes
  const cells = Array.from({ length: cols }, () => ns.table_cell.createAndFill()).filter(
    (n): n is Node => n !== null
  )
  const headerCells = Array.from({ length: cols }, () => ns.table_header.createAndFill()).filter(
    (n): n is Node => n !== null
  )
  const rowNodes = Array.from({ length: rows }, (_, i) =>
    i === 0
      ? ns.table_header_row.create(null, headerCells)
      : ns.table_row.create(null, cells)
  )
  return ns.table.create(null, rowNodes)
}

export function insertTable(view: EditorView, rows: number, cols: number): void {
  const node = createTableNode(view.state.schema, rows, cols)
  view.dispatch(view.state.tr.replaceSelectionWith(node))
}

function insertTableAtCursor(): void {
  if (activeView) {
    insertTable(activeView, 3, 3)
  }
}

export function tableFeature(): void {
  registerCommand({ id: TABLE_COMMAND_ID, run: insertTableAtCursor })
  registerToolbar({ id: TABLE_COMMAND_ID, label: 'Table', run: insertTableAtCursor })
}

export const tableFeaturePlugin: MilkdownPlugin = (ctx) => {
  return () => {
    activeView = ctx.get(editorViewCtx)
  }
}

tableFeature()