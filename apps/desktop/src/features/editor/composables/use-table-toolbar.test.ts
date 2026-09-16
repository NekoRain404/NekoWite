/* eslint-disable vue/one-component-per-file -- a test file legitimately mounts
 * two: a bare host that drives the composable directly, so the assertions can
 * read `anchor()`/`stillValid()` themselves, and the real toolbar. */
import { afterEach, describe, expect, it } from 'vitest'
import { createApp, h, nextTick, ref, watch, type App as VueApp } from 'vue'
import { TextSelection } from '@milkdown/prose/state'
import {
  basicPlugins,
  createEditor,
  insertTable,
  onTableCursorChange,
} from '@nekowite/editor-core'
import type { NekoEditor } from '@nekowite/editor-core'
import TableMenu from '../../../ui/TableMenu.vue'
import { t } from '../../../i18n'
import { useTableToolbar, type TableToolbar } from './use-table-toolbar'

/**
 * The toolbar after the caret has been away, which is the report this file
 * exists for.
 *
 * The user's reproduction — add a row, click into the source area, click back
 * into the SAME cell, add another row — ended with the toolbar back on screen
 * and refusing everything it offered. The bookmark of the table it acts on
 * (`anchor()`) was released by the outside press and taken again only on the
 * pane's in-table signal's false→true edge, which a press back into the same
 * cell never crosses: the caret never left the table, so no transaction calls
 * the signal. Positioning, meanwhile, reads the DOM live, so the toolbar
 * returned visible holding nothing to act on.
 *
 * Two harnesses, because the defect has two faces and each needs its own
 * instrument. `useTableToolbar` driven directly answers what `anchor()` and
 * `stillValid()` SAY — the contract every button acts through, and the answer
 * the report has to quote. `TableMenu.vue`, the toolbar's own entrance, answers
 * what happens when a button is really clicked, which is how the user met it.
 */

/** happy-dom lays nothing out, so every rect is zero and a toolbar placed from
 *  rects would compute a position that is invisible for a reason that has
 *  nothing to do with the code under test. The rects below are the shape these
 *  assertions are written against: a panel, a table inside it, a cell inside
 *  that, and the toolbar's own box (which `measure` reads). */
type RectFixture = Pick<DOMRect, 'top' | 'left' | 'right' | 'bottom' | 'width' | 'height'>

const RECTS: Record<string, RectFixture> = {
  '.rendered-pane': { top: 100, left: 500, right: 1280, bottom: 820, width: 780, height: 720 },
  table: { top: 300, left: 600, right: 1000, bottom: 500, width: 400, height: 200 },
  cell: { top: 320, left: 620, right: 720, bottom: 350, width: 100, height: 30 },
  '.neko-table-menu': { top: 0, left: 0, right: 240, bottom: 32, width: 240, height: 32 },
}

function installRects(): void {
  Element.prototype.getBoundingClientRect = function (this: Element): DOMRect {
    const cls = typeof this.className === 'string' ? this.className : ''
    const tag = this.tagName.toLowerCase()
    const key = cls.includes('rendered-pane')
      ? '.rendered-pane'
      : cls.includes('neko-table-menu')
        ? '.neko-table-menu'
        : tag === 'table'
          ? 'table'
          : tag === 'td' || tag === 'th'
            ? 'cell'
            : null
    const r = key ? RECTS[key] : null
    const zero: RectFixture = { top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }
    return (r ?? zero) as DOMRect
  }
}

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))
/** A frame for the rAF-coalesced re-place, which does not run on microtasks. */
const frame = (): Promise<void> => new Promise((r) => setTimeout(r, 40))

let mounted: VueApp[] = []
let editors: NekoEditor[] = []
let stops: Array<() => void> = []

afterEach(() => {
  // Order matters: unmounting removes the composable's document-level press
  // listener, and the plugin's own move off this view (editor destroy) must not
  // reach a component that is gone.
  mounted.forEach((app) => app.unmount())
  mounted = []
  stops.forEach((stop) => stop())
  stops = []
  editors.forEach((ed) => ed.destroy())
  editors = []
  document.body.innerHTML = ''
})

interface PaneFixture {
  editor: NekoEditor
  pane: HTMLElement
  mountPoint: HTMLElement
  /** The source area's stand-in: outside the rendered pane, which is where the
   *  press that dismissed the toolbar lands. */
  source: HTMLElement
}

async function paneWithEditor(markdown = ''): Promise<PaneFixture> {
  installRects()
  const el = document.createElement('div')
  document.body.appendChild(el)
  const editor = createEditor(el, { plugins: basicPlugins })
  await editor.open(markdown)
  editors.push(editor)

  const pane = document.createElement('div')
  pane.className = 'rendered-pane pane rendered'
  const mountPoint = document.createElement('div')
  pane.appendChild(mountPoint)
  document.body.appendChild(pane)
  pane.appendChild(editor.getView().dom)

  const source = document.createElement('div')
  source.className = 'source-pane'
  document.body.appendChild(source)

  return { editor, pane, mountPoint, source }
}

/** The press that leaves the pane. The handler keys on the event TYPE and the
 *  target, so a `MouseEvent` carries it where happy-dom has no `PointerEvent`. */
function pressOutside(target: HTMLElement): void {
  target.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }))
}

/** What a press inside the pane sends: ProseMirror moves the caret and this
 *  bubbles to the panel, which re-places the toolbar. */
function pressInPane(target: Element): void {
  target.dispatchEvent(new MouseEvent('click', { bubbles: true }))
}

function cellEls(editor: NekoEditor): HTMLElement[] {
  return Array.from(editor.getView().dom.querySelectorAll<HTMLElement>('td, th'))
}

/** Put the caret in the Nth cell of the document, in document order — what a
 *  click in the pane does, minus the click. */
function caretIntoCell(editor: NekoEditor, index: number): void {
  const view = editor.getView()
  const cells: number[] = []
  view.state.doc.descendants((n, p) => {
    if (n.type.name === 'table_cell' || n.type.name === 'table_header') cells.push(p)
    return true
  })
  view.dispatch(
    view.state.tr
      .setSelection(TextSelection.create(view.state.doc, cells[index] + 1))
      .setMeta('addToHistory', false),
  )
}

/** The caret into the leading paragraph: outside every table. A document opened
 *  from markdown starts wherever the parse left the selection, and the pane's
 *  in-table signal only speaks on a CHANGE — so a test about entering a table
 *  has to start from a careted position that is not in one. */
function caretOutsideTable(editor: NekoEditor): void {
  const view = editor.getView()
  view.dispatch(
    view.state.tr.setSelection(TextSelection.create(view.state.doc, 1)).setMeta('addToHistory', false),
  )
}

/** The first data cell, the one `insertTable`'s caret is nearest to. */
function caretIntoFirstDataCell(editor: NekoEditor): void {
  const view = editor.getView()
  let pos: number | null = null
  view.state.doc.descendants((n, p) => {
    if (n.type.name === 'table_cell') {
      pos = p
      return false
    }
    return true
  })
  view.dispatch(
    view.state.tr
      .setSelection(TextSelection.create(view.state.doc, (pos ?? 0) + 1))
      .setMeta('addToHistory', false),
  )
}

/** Rows in the document's table, header row included. */
function rowCount(editor: NekoEditor): number {
  let rows = 0
  editor.getView().state.doc.descendants((n) => {
    if (n.type.name === 'table_row' || n.type.name === 'table_header_row') rows += 1
    return true
  })
  return rows
}

/** An edit from elsewhere — the source pane, another window, an undo — that
 *  pushes the table to a new document position without touching the caret. */
function displaceTable(editor: NekoEditor): void {
  const view = editor.getView()
  const { schema } = view.state
  view.dispatch(view.state.tr.insert(0, schema.nodes.paragraph.create(null, schema.text('lead'))))
}

/* --------------------- the contract the buttons act through -------------------- */

interface Probe extends PaneFixture {
  toolbar: TableToolbar
}

/**
 * `useTableToolbar` driven directly, with the pane's in-table ref fed the way
 * `TableMenu.vue` feeds it (from the plugin's own signal) — so a press back into
 * the same cell is heard as the user's engine hears it: not at all.
 */
async function probeToolbar(markdown = ''): Promise<Probe> {
  const { editor, pane, mountPoint, source } = await paneWithEditor(markdown)
  const inTable = ref(false)
  stops.push(onTableCursorChange((on) => { inTable.value = on }))

  let toolbar: TableToolbar | null = null
  // A bare host, in the shape `useTableToolbar` is mounted by: a component whose
  // only job is to give the composable a scope to live in. What it renders is
  // the toolbar's own box, which `measure` reads (see the file header's note on
  // the two components this file mounts).
  const app = createApp({
    setup() {
      const own = useTableToolbar({ getEditor: () => editor, inTable })
      toolbar = own
      const el = ref<HTMLElement | null>(null)
      // The entrance's own measurement, as `TableMenu.vue` does it: the toolbar
      // is placed from its own box, which exists only after a first paint.
      watch(() => own.visible.value, async (on) => {
        if (!on) return
        await nextTick()
        own.measure(el.value)
      })
      watch(el, (node) => own.measure(node))
      return () => h('div', { class: 'neko-table-menu', ref: el })
    },
  })
  app.mount(mountPoint)
  mounted.push(app)
  await nextTick()

  if (!toolbar) throw new Error('the probe never called useTableToolbar')
  return { editor, pane, mountPoint, source, toolbar }
}

describe('the toolbar keeps a target across a dismissal', () => {
  it('re-derives it from the caret when the caret comes back to the same cell', async () => {
    const h = await probeToolbar()
    insertTable(h.editor.getView(), 3, 2)
    caretIntoFirstDataCell(h.editor)
    await flush()
    await frame()

    const raised = h.toolbar.anchor()
    expect(h.toolbar.visible.value, 'the toolbar is up in the cell it was raised in').toBe(true)
    expect(raised, 'raised with a bookmark').not.toBeNull()
    expect(h.toolbar.stillValid(), 'and the bookmark names a table').toBe(true)

    // Into the source area. The caret does not move: the rendered pane loses the
    // focus, not the selection, so no transaction is dispatched and the pane's
    // in-table signal never crosses a false→true edge on the way back.
    pressOutside(h.source)
    expect(h.toolbar.visible.value, 'the outside press takes it off screen').toBe(false)

    // Back into the SAME cell.
    pressInPane(cellEls(h.editor)[2])
    await frame()

    // The three answers together, because together they are the report: the
    // toolbar came back on screen, holding nothing, and refused every button it
    // was offering. The message spells the answers out because the diff of an
    // object holding a null instead of a pair is one a reader has to reconstruct.
    const answer = (): string =>
      `visible=${h.toolbar.visible.value} anchor=${JSON.stringify(h.toolbar.anchor())}` +
      ` stillValid=${h.toolbar.stillValid()}`
    expect(
      {
        visible: h.toolbar.visible.value,
        anchor: h.toolbar.anchor(),
        actionable: h.toolbar.stillValid(),
      },
      `what the toolbar answers after the caret comes back (${answer()})`,
    ).toEqual({ visible: true, anchor: raised, actionable: true })
  })

  it('shows nothing it cannot act on, across repeated dismiss/raise cycles', async () => {
    const h = await probeToolbar()
    insertTable(h.editor.getView(), 3, 2)
    caretIntoFirstDataCell(h.editor)
    await flush()
    await frame()

    const cell = cellEls(h.editor)[2]
    const seen: string[] = []
    const record = (): void => {
      seen.push(
        h.toolbar.visible.value
          ? h.toolbar.stillValid()
            ? 'on screen, and it acts'
            : 'on screen with nothing to act on'
          : 'off screen',
      )
    }

    record()
    pressOutside(h.source)
    record()
    pressInPane(cell)
    await frame()
    record()
    pressOutside(h.source)
    record()
    pressInPane(cell)
    await frame()
    record()

    // The pair is the assertion: "on screen" and "will act" are one fact to the
    // user, and the entries after a return are the ones that used to read
    // "on screen with nothing to act on". The message carries the whole
    // sequence, which the diff of two five-element arrays does not.
    expect(seen, `after each press (${seen.join(' → ')})`).toEqual([
      'on screen, and it acts',
      'off screen',
      'on screen, and it acts',
      'off screen',
      'on screen, and it acts',
    ])
  })

  it('follows the caret to another cell, and to another table', async () => {
    // Two tables, with the caret opening outside both of them.
    const h = await probeToolbar(
      'lead\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n\nmid\n\n| c | d |\n| --- | --- |\n| 3 | 4 |\n',
    )
    const tablePositions: number[] = []
    h.editor.getView().state.doc.descendants((n, p) => {
      if (n.type.name === 'table') tablePositions.push(p)
      return true
    })
    expect(tablePositions, 'the fixture has two tables').toHaveLength(2)

    caretOutsideTable(h.editor)
    await flush()
    caretIntoCell(h.editor, 2)
    await flush()
    await frame()
    const first = h.toolbar.anchor()
    expect(first?.tableFrom, 'bookmarked in the first table').toBe(tablePositions[0])

    pressOutside(h.source)
    expect(h.toolbar.visible.value).toBe(false)

    // A click into the OTHER table: its own transaction moves the caret, and the
    // in-table signal stays true across it, so nothing but the caret can say
    // which table the toolbar is now for.
    caretIntoCell(h.editor, 6)
    pressInPane(cellEls(h.editor)[6])
    await frame()

    const second = h.toolbar.anchor()
    expect(h.toolbar.visible.value, 'the toolbar is back').toBe(true)
    expect(second?.tableFrom, 're-targeted to the table the caret came back to').toBe(tablePositions[1])
    expect(h.toolbar.stillValid()).toBe(true)
  })

  it('refuses a table that moved after the bookmark was taken', async () => {
    const h = await probeToolbar()
    insertTable(h.editor.getView(), 3, 2)
    caretIntoFirstDataCell(h.editor)
    await flush()
    await frame()
    expect(h.toolbar.anchor(), 'raised with a bookmark').not.toBeNull()

    // Displaced with no re-placement in between: the bookmark is what the action
    // is checked against, and it no longer names a table.
    displaceTable(h.editor)

    expect(h.toolbar.stillValid(), 'the bookmark points at a paragraph now').toBe(false)
  })
})

/* ------------------------------ the toolbar itself ----------------------------- */

interface MenuFixture extends PaneFixture {
  button: (label: string) => HTMLButtonElement
}

async function menuWithEditor(markdown = ''): Promise<MenuFixture> {
  const fixture = await paneWithEditor(markdown)
  const app = createApp(TableMenu, { editor: fixture.editor })
  app.mount(fixture.mountPoint)
  mounted.push(app)
  await nextTick()
  return {
    ...fixture,
    button(label: string): HTMLButtonElement {
      const found = Array.from(
        document.querySelectorAll<HTMLButtonElement>('.neko-table-menu button'),
      ).find((b) => b.textContent?.trim() === label)
      if (!found) throw new Error(`no button labelled ${label}`)
      return found
    },
  }
}

describe('what the toolbar shows is what it can do', () => {
  it('inserts a row again after the source area was visited in between', async () => {
    const h = await menuWithEditor()
    insertTable(h.editor.getView(), 3, 2)
    caretIntoFirstDataCell(h.editor)
    await flush()
    await frame()
    expect(rowCount(h.editor), 'three rows to start with').toBe(3)

    h.button(t('tableMenu.addRowAfter')).click()
    await flush()
    expect(rowCount(h.editor), 'the first insert lands').toBe(4)

    pressOutside(h.source)
    await flush()
    expect(
      document.querySelector('.neko-table-menu'),
      'the outside press takes the toolbar off screen',
    ).toBeNull()

    pressInPane(cellEls(h.editor)[2])
    await frame()
    expect(document.querySelector('.neko-table-menu'), 'and it is back').not.toBeNull()

    h.button(t('tableMenu.addRowAfter')).click()
    await flush()
    expect(rowCount(h.editor), 'and the second insert lands too').toBe(5)
  })

  it('acts on nothing when the table it was raised for has moved', async () => {
    const h = await menuWithEditor()
    insertTable(h.editor.getView(), 3, 2)
    caretIntoFirstDataCell(h.editor)
    await flush()
    await frame()
    const button = h.button(t('tableMenu.addRowAfter'))

    displaceTable(h.editor)
    const before = rowCount(h.editor)
    button.click()
    await flush()

    expect(rowCount(h.editor), 'the refused action inserted nothing').toBe(before)
  })
})
