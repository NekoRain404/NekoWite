import { afterEach, describe, expect, it } from 'vitest'
import { undoDepth } from '@milkdown/prose/history'
import { TextSelection } from '@milkdown/prose/state'
import type { Node } from '@milkdown/prose/model'
import type { EditorView } from '@milkdown/prose/view'
import { columnResizingPluginKey, selectedRect } from '@milkdown/prose/tables'

import { basicPlugins, createEditor } from '../editor'

afterEach(() => {
  document.body.innerHTML = ''
})

async function openMarkdown(md: string): Promise<ReturnType<typeof createEditor>> {
  const el = document.createElement('div')
  document.body.appendChild(el)
  const editor = createEditor(el, { plugins: basicPlugins })
  await editor.open(md)
  return editor
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

/** The `handleDOMEvents.mousedown` handler of the columnResizing plugin. */
function columnResizeMousedown(view: EditorView): (view: EditorView, e: MouseEvent) => void {
  const plugin = view.state.plugins.find((p) =>
    String((p as unknown as { key: unknown }).key).startsWith('tableColumnResizing'),
  )
  if (!plugin) throw new Error('columnResizing plugin not found')
  const handler = (
    plugin as unknown as {
      spec: { props: { handleDOMEvents?: { mousedown: (v: EditorView, e: MouseEvent) => void } } }
    }
  ).spec.props.handleDOMEvents?.mousedown
  if (!handler) throw new Error('columnResizing mousedown handler not found')
  return handler
}

describe('column-width drag', () => {
  it('a column-resize drag writes colwidth and keeps Markdown round-trip identical', async () => {
    const md = '| H1 | H2 |\n| - | - |\n| a | b |\n'
    const editor = await openMarkdown(md)
    const view = editor.getView()
    const before = await editor.save()

    // Hover detection needs real layout (posAtCoords) which happy-dom cannot
    // provide, so seed the handle at the column-edge cell — exactly the position
    // handleMouseMove would arm for a drag on the divider between col 1 and 2.
    placeCursor(view, 1, 1)
    const rect = selectedRect(view.state)
    const cellPos = rect.tableStart + rect.map.positionAt(1, 1, rect.table)
    const cell = view.state.doc.nodeAt(cellPos) as Node
    expect(cell.type.name).toBe('table_cell')
    view.dispatch(view.state.tr.setMeta(columnResizingPluginKey, { setHandle: cellPos }))
    expect(columnResizingPluginKey.getState(view.state)?.activeHandle).toBe(cellPos)

    const beforeDepth = undoDepth(view.state)

    const mousedown = columnResizeMousedown(view)
    mousedown(view, new MouseEvent('mousedown', { clientX: 0, clientY: 0, bubbles: true }))
    expect(columnResizingPluginKey.getState(view.state)?.dragging).toBeTruthy()

    window.dispatchEvent(new MouseEvent('mousemove', { clientX: 50, clientY: 0, bubbles: true }))
    window.dispatchEvent(new MouseEvent('mouseup', { clientX: 50, clientY: 0, bubbles: true }))

    // The column under the handle received a width.
    expect(columnResizingPluginKey.getState(view.state)?.dragging).toBeFalsy()
    const rect2 = selectedRect(view.state)
    const cell2 = view.state.doc.nodeAt(
      rect2.tableStart + rect2.map.positionAt(1, 1, rect2.table),
    ) as Node
    expect(Array.isArray(cell2.attrs.colwidth)).toBe(true)
    expect((cell2.attrs.colwidth as number[])[0]).toBeGreaterThanOrEqual(25)

    // One drag = one undo step (the commit is a single transaction on pointer-up).
    expect(undoDepth(view.state)).toBe(beforeDepth + 1)

    // colwidth is a display-only concern: it is never serialized into Markdown.
    expect(await editor.save()).toBe(before)

    editor.destroy()
  })
})
