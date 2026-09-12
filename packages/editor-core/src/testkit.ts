import { prosePluginsCtx, SchemaReady } from '@milkdown/core'
import type { Ctx, MilkdownPlugin } from '@milkdown/ctx'
import type { Node } from '@milkdown/prose/model'
import { Slice } from '@milkdown/prose/model'
import { Plugin } from '@milkdown/prose/state'
import { TextSelection } from '@milkdown/prose/state'
import type { EditorView } from '@milkdown/prose/view'
import { CellSelection, selectedRect } from '@milkdown/prose/tables'
import { createEditor } from './editor'

/**
 * Shared scaffolding for the editor-core table tests.
 *
 * A plain module (not a suite): the flow tests import it so each one can build a
 * real editor view plus a real GFM table without duplicating the scaffolding.
 */

export interface Harness {
  ed: ReturnType<typeof createEditor>
  view: EditorView
  el: HTMLElement
  destroy(): void
}

export async function editor(
  md = '',
  opts: { plugins?: MilkdownPlugin[] } = {},
): Promise<Harness> {
  const el = document.createElement('div')
  document.body.appendChild(el)
  const ed = opts.plugins ? createEditor(el, { plugins: opts.plugins }) : createEditor(el)
  await ed.open(md)
  const view = ed.getView()
  return {
    ed,
    view,
    el,
    destroy() {
      ed.destroy()
      el.remove()
    },
  }
}

/** Open a document in a fresh editor, run `fn`, then always tear down. */
export async function withEditor<T>(
  md: string,
  fn: (ed: ReturnType<typeof createEditor>) => Promise<T>,
): Promise<T> {
  const h = await editor(md)
  try {
    return await fn(h.ed)
  } finally {
    h.destroy()
  }
}

/**
 * `createEditor`'s default plugin list plus `extras` in front.
 *
 * Passing a bare `plugins` array replaces the whole preset, and an editor without
 * `basicPlugins` is missing the listener plugin `createEditor` configures (it
 * throws while building), so extras are always composed with the defaults.
 */
export async function withBasicPlugins(extras: MilkdownPlugin[]): Promise<MilkdownPlugin[]> {
  const { basicPlugins } = await import('./plugins/basic')
  return [...extras, ...basicPlugins]
}

/**
 * Build a real GFM table from row data, the caret landing in the top-left cell.
 *
 * `data` is the full grid INCLUDING the header row, the way a Markdown table is
 * laid out (`data[0]` is the header row, `data[1]` the first data row). Pass
 * `{ header: false }` for a table whose first row is data too.
 */
export async function withTable(
  data: string[][],
  opts: { header?: boolean; plugins?: MilkdownPlugin[] } = {},
): Promise<Harness & { tablePos: number; table: Node }> {
  const h = opts.plugins
    ? await editor('', { plugins: await withBasicPlugins(opts.plugins) })
    : await editor('')
  const header = opts.header ?? true
  const rows = data.length
  const cols = Math.max(1, data[0]?.length ?? 1)
  const schema = h.view.state.schema
  const mkCell = (text: string, isHeader: boolean): Node => {
    const para = schema.nodes.paragraph.create(null, text ? schema.text(text) : undefined)
    const type = isHeader ? schema.nodes.table_header : schema.nodes.table_cell
    return type.create(null, para)
  }
  const rowNodes: Node[] = []
  for (let r = 0; r < rows; r++) {
    const isHeader = header && r === 0
    const source = data[r] ?? []
    const cells: Node[] = []
    for (let c = 0; c < cols; c++) cells.push(mkCell(source[c] ?? '', isHeader))
    const rowType = isHeader ? schema.nodes.table_header_row : schema.nodes.table_row
    rowNodes.push(rowType.create(null, cells))
  }
  const table = schema.nodes.table.create(null, rowNodes)
  // Setup is not a user edit: keep it out of the undo history so a test that
  // asserts "one op = one undo step" measures only the op under test.
  h.view.dispatch(h.view.state.tr.replaceSelectionWith(table).setMeta('addToHistory', false))
  let tablePos = 0
  h.view.state.doc.descendants((node, pos) => {
    if (node.type.name === 'table') {
      tablePos = pos
      return false
    }
    return true
  })
  return { ...h, tablePos, table }
}

/** Put the caret in a cell's paragraph (row 0 is the header when present). */
export function placeCursor(view: EditorView, row: number, col: number): void {
  const rect = selectedRect(view.state)
  const cellPos = rect.tableStart + rect.map.positionAt(row, col, rect.table)
  view.dispatch(
    view.state.tr
      .setSelection(TextSelection.create(view.state.doc, cellPos + 2))
      .setMeta('addToHistory', false),
  )
}

/** Select a rectangular cell region (inclusive) as a CellSelection. */
export function selectCells(
  view: EditorView,
  r1: number,
  c1: number,
  r2: number,
  c2: number,
): void {
  const rect = selectedRect(view.state)
  const anchor = rect.tableStart + rect.map.positionAt(r1, c1, rect.table)
  const head = rect.tableStart + rect.map.positionAt(r2, c2, rect.table)
  view.dispatch(
    view.state.tr
      .setSelection(CellSelection.create(view.state.doc, anchor, head))
      .setMeta('addToHistory', false),
  )
}

/** Every table in the document, model-side. */
export function tables(view: EditorView): Array<{ node: Node; pos: number }> {
  const found: Array<{ node: Node; pos: number }> = []
  view.state.doc.descendants((node, pos) => {
    if (node.type.name === 'table') found.push({ node, pos })
    return true
  })
  return found
}

export function tableCount(view: EditorView): number {
  return tables(view).length
}

/**
 * Line breaks in the document.
 *
 * Two node shapes count: a `hardbreak` (what a backslash or two trailing spaces
 * becomes in prose, and what Shift+Enter inserts) and an inline `html` node whose
 * value is a `<br>` spelling. Both re-open as a break, and which one a given
 * source spelling produces depends on the context, so a test about "the break
 * survived" should accept either.
 */
export function countLineBreaks(view: EditorView): number {
  let count = 0
  const breakValues = new Set(['<br />', '<br>', '<br/>', '<br >'])
  view.state.doc.descendants((node) => {
    if (node.type.name === 'hardbreak') count += 1
    else if (node.type.name === 'html' && breakValues.has(String(node.attrs.value ?? '').trim())) {
      count += 1
    }
    return true
  })
  return count
}

export function countNodes(view: EditorView, typeName: string): number {
  let count = 0
  view.state.doc.descendants((node) => {
    if (node.type.name === typeName) count += 1
    return true
  })
  return count
}

export function textAt(view: EditorView, row: number, col: number): string {
  const rect = selectedRect(view.state)
  const pos = rect.tableStart + rect.map.positionAt(row, col, rect.table)
  return (view.state.doc.nodeAt(pos) as Node | null)?.textContent ?? ''
}

/** All cell texts row-major, so a test can prove nothing was lost. */
export function gridText(view: EditorView): string[] {
  const out: string[] = []
  for (const { node } of tables(view)) {
    node.descendants((child) => {
      if (child.type.name === 'table_cell' || child.type.name === 'table_header') {
        // `textContent` is empty for an atom (a formula carries its source in an
        // attribute), so atoms contribute their attribute value as well.
        out.push(`${child.textContent}${atomText(child)}`)
      }
      return true
    })
  }
  return out
}

/** The textual content an atom node holds in its attributes. */
function atomText(node: Node): string {
  let text = ''
  node.descendants((child) => {
    if (child.isText) return true
    for (const value of Object.values(child.attrs as Record<string, unknown>)) {
      if (typeof value === 'string') text += value
    }
    return true
  })
  return text
}

/** The document must be structurally valid — the split-table bug passed this. */
/**
 * Fire one character the way the browser does, input rules included.
 *
 * The character is inserted first (that is what the browser hands over as a
 * `beforeinput`), and every `handleTextInput` prop is then asked whether it wants
 * to rewrite the document — which is exactly the order ProseMirror's own
 * `editHandlers` uses and the reason an input rule can see the character it is
 * reacting to. When a rule changes the document its transaction is dispatched and
 * true is returned; otherwise the plain insertion stands.
 */
export function typeChar(view: EditorView, char: string, from: number, to = from): boolean {
  const before = view.state.doc
  const tr = view.state.tr.insertText(char, from, to)
  view.dispatch(tr)
  const after = view.state.selection.to
  const fromAfter = after - char.length
  // The default handler a ProseMirror input rule receives is the plain insertion,
  // built from the position the character was typed at (the same one the view
  // would hand over).
  const handled = view.someProp('handleTextInput', (handler) =>
    Boolean(handler(view, fromAfter, after, char, () => view.state.tr.insertText(char, from, to))),
  )
  return handled || view.state.doc !== before
}

/** Type a string one character at a time (input rules fire as they would live). */
export function typeText(view: EditorView, text: string, from: number): void {
  let at = from
  for (const char of text) {
    typeChar(view, char, at)
    at += char.length
  }
}

/**
 * Dispatch a paste event through the view's paste hooks. `text/html` is passed
 * through so the ProseMirror HTML parser runs exactly as it does in the browser.
 */
export function pasteText(view: EditorView, text: string, html?: string): boolean {
  const event = {
    clipboardData: {
      getData: (type: string) =>
        type === 'text/html' ? html ?? '' : type === 'text/plain' ? text : '',
      types: html ? ['text/plain', 'text/html'] : ['text/plain'],
    },
    preventDefault: () => undefined,
    stopPropagation: () => undefined,
  } as unknown as ClipboardEvent
  const handled = view.someProp('handlePaste', (f) => Boolean(f(view, event, Slice.empty)))
  return Boolean(handled)
}

/**
 * Drive a real paste through the view: dispatch a DOM paste event carrying
 * `text/plain` (and `text/html` when given) and let ProseMirror's own paste
 * handler run. This is the path the browser uses, so a guard that refuses a
 * paste is measured as "the document did not change", not as a mock call.
 */
export function pasteIntoView(view: EditorView, text: string, html?: string): void {
  const event = new Event('paste', { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'clipboardData', {
    value: {
      getData: (type: string) => {
        if (type === 'text/plain') return text
        if (type === 'text/html') return html ?? ''
        return ''
      },
      types: html ? ['text/plain', 'text/html'] : ['text/plain'],
      files: [] as unknown as FileList,
    },
  })
  view.dom.dispatchEvent(event)
}

/** The raw checker call, so a caller can wrap it in its own expectation. */
export function docCheck(view: EditorView): void {
  ;(view.state.doc as unknown as { check(): void }).check()
}

/**
 * A probe plugin that records paste events reaching the DOM handler, so a test
 * can prove the keymap did NOT swallow the event (the image-paste regression).
 */
export function pasteRecorder(): { plugin: MilkdownPlugin; events: ClipboardEvent[] } {
  const events: ClipboardEvent[] = []
  // A milkdown plugin is a factory over the editor context whose return value is
  // the cleanup handler. The ProseMirror plugin has to be appended to
  // `prosePluginsCtx` the way `$prose` does it, so its props (the DOM paste hook)
  // take part in the view's prop lookup.
  const plugin = ((ctx: Ctx) => async () => {
    await ctx.wait(SchemaReady)
    const pro = new Plugin({
      props: {
        handleDOMEvents: {
          paste: (_view, event) => {
            events.push(event as ClipboardEvent)
            return false
          },
        },
      },
    })
    ctx.update(prosePluginsCtx, (plugins) => [...plugins, pro])
    return () => {
      ctx.update(prosePluginsCtx, (plugins) => plugins.filter((entry) => entry !== pro))
    }
  }) as unknown as MilkdownPlugin
  return { plugin, events }
}