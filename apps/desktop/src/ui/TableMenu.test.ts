import { afterEach, describe, expect, it } from 'vitest'
import { createApp, type App as VueApp } from 'vue'
import { TextSelection } from '@milkdown/prose/state'
import { createEditor, basicPlugins, insertTable } from '@nekowite/editor-core'
import type { NekoEditor } from '@nekowite/editor-core'
import TableMenu from './TableMenu.vue'
import { t } from '../i18n'

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

let mounted: VueApp[] = []
let editors: NekoEditor[] = []

afterEach(() => {
  mounted.forEach((app) => app.unmount())
  mounted = []
  editors.forEach((ed) => ed.destroy())
  editors = []
  document.body.innerHTML = ''
})

async function makeEmptyEditor(): Promise<NekoEditor> {
  const el = document.createElement('div')
  document.body.appendChild(el)
  const editor = createEditor(el, { plugins: basicPlugins })
  await editor.open('')
  editors.push(editor)
  return editor
}

/**
 * happy-dom lays nothing out, so every rect is zero — and a floating toolbar
 * placed from rects would compute a position that is invisible for a reason
 * that has nothing to do with the component. The rects below are the shape this
 * file's assertions are written against: a panel, a table inside it, and a cell
 * inside that. The toolbar's own rect is what `measure` reads.
 *
 * The panel is created here because the toolbar is anchored to its editing
 * column (`.pane.rendered`), which the real app renders around it.
 */
/**
 * Only the six box fields are read on this path — `placeTableToolbar` and the
 * composable's `rectOf` hand a rect straight to arithmetic on top/left/right/
 * bottom/width/height, and nothing serialises one. `x`/`y`/`toJSON` are not
 * stubbed to satisfy `DOMRect`: the fixture's type is what narrows, and the one
 * place the DOM lib demands a whole `DOMRect` (the prototype override below)
 * says so.
 */
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
    // The DOM lib's signature asks for a DOMRect; the three fields it has beyond
    // the six above are read by nothing in the path under test, which is why the
    // fixture is typed by what IS read.
    return (r ?? zero) as DOMRect
  }
}

function mountMenu(editor: NekoEditor): void {
  installRects()
  // The pane's own scroll container, which is what the toolbar is clamped to
  // and what it watches for scrolls. The component mounts into a child of it,
  // and the editor's DOM is moved inside it too (a component mount replaces its
  // container's children, so the editor cannot be appended to the same node).
  const pane = document.createElement('div')
  pane.className = 'rendered-pane pane rendered'
  const mountPoint = document.createElement('div')
  pane.appendChild(mountPoint)
  document.body.appendChild(pane)
  pane.appendChild(editor.getView().dom)
  const app = createApp(TableMenu, { editor })
  app.mount(mountPoint)
  mounted.push(app)
}

// The table cursor plugin only notifies its subscribers when the "in table"
// boolean actually FLIPS. insertTable leaves the cursor inside the table, so
// the menu must be mounted while the cursor is still outside (current=false),
// then a cursor-into-table dispatch drives the false→true transition.
function placeCursorInDataCell(editor: NekoEditor): void {
  const view = editor.getView()
  let cellPos: number | null = null
  view.state.doc.descendants((n, p) => {
    if (n.type.name === 'table_cell') {
      cellPos = p
      return false
    }
    return true
  })
  view.dispatch(
    view.state.tr
      .setSelection(TextSelection.create(view.state.doc, (cellPos ?? 0) + 1))
      .setMeta('addToHistory', false),
  )
}

/**
 * The toolbar's refusal surface, exercised in BOTH directions.
 *
 * The first version of this feature annotated the operations as `() => void`,
 * which erased the commands' `boolean` refusal: `if (!op.run())` tested
 * `!undefined` and EVERY button rendered struck-through after any click,
 * including the ones that had just worked. A test that only checked "a refusal
 * is shown" would have passed against that. So both cases are asserted, and the
 * header-cell case is the one the commands really refuse
 * (`packages/editor-core/src/table/ops.ts`: `rect.top === 0`).
 */
describe('TableMenu refusal surface', () => {
  /** The button whose label matches, and what it currently claims about itself. */
  function rowDeleteButton(): HTMLButtonElement {
    const button = Array.from(document.querySelectorAll<HTMLButtonElement>('.neko-table-menu button')).find(
      (b) => b.textContent?.trim() === t('tableMenu.deleteRow'),
    )
    if (!button) throw new Error('the row-delete button is not there')
    return button
  }
  const claims = (button: HTMLButtonElement) => ({
    refused: button.classList.contains('is-refused'),
    ariaDisabled: button.getAttribute('aria-disabled'),
    label: button.getAttribute('aria-label') ?? '',
  })

  /** The caret into the header row (the row the command refuses). */
  function placeCursorInHeaderCell(editor: NekoEditor): void {
    const view = editor.getView()
    let pos: number | null = null
    view.state.doc.descendants((n, p) => {
      if (n.type.name === 'table_header') {
        pos = p
        return false
      }
      return true
    })
    view.dispatch(
      view.state.tr
        .setSelection(TextSelection.create(view.state.doc, (pos ?? 0) + 2))
        .setMeta('addToHistory', false),
    )
  }

  it('says nothing after an operation that worked', async () => {
    const editor = await makeEmptyEditor()
    mountMenu(editor)
    insertTable(editor.getView(), 3, 2)
    placeCursorInDataCell(editor)
    await flush()

    const before = editor.getView().state.doc.childCount
    rowDeleteButton().click()
    await flush()
    // The command acted (a row is gone) …
    expect(editor.getView().state.doc.childCount).toBe(before)
    expect(claims(rowDeleteButton())).toEqual({ refused: false, ariaDisabled: null, label: t('tableMenu.deleteRow') })
  })

  it('says so when the command refuses, and the label explains it', async () => {
    const editor = await makeEmptyEditor()
    mountMenu(editor)
    insertTable(editor.getView(), 2, 2)
    placeCursorInHeaderCell(editor)
    await flush()

    rowDeleteButton().click()
    await flush()
    const state = claims(rowDeleteButton())
    expect(state.refused).toBe(true)
    expect(state.ariaDisabled).toBe('true')
    // The struck-through state is unexplained without this: a rare refusal with
    // no label reads as a broken button.
    expect(state.label).toContain(t('tableMenu.refused'))
  })
})

describe('TableMenu accessibility', () => {
  it('renders a labelled toolbar of keyboard-operable buttons when inside a table', async () => {
    const editor = await makeEmptyEditor()
    mountMenu(editor)
    // Insert the table at the cursor → the cursor lands inside it → the menu
    // toolbar renders.
    insertTable(editor.getView(), 2, 2)
    placeCursorInDataCell(editor)
    await flush()

    const toolbar = document.querySelector<HTMLElement>('.neko-table-menu')!
    expect(toolbar).toBeTruthy()
    expect(toolbar.getAttribute('role')).toBe('toolbar')
    expect(toolbar.getAttribute('aria-label')).toBeTruthy()

    const buttons = Array.from(toolbar.querySelectorAll('button'))
    expect(buttons.length).toBeGreaterThanOrEqual(9)
    for (const b of buttons) {
      expect(b.tagName).toBe('BUTTON')
      expect(b.getAttribute('type')).toBe('button')
      // Every control is labelled by its text content (and a tooltip title).
      expect((b as HTMLElement).textContent?.trim().length).toBeGreaterThan(0)
      expect((b as HTMLElement).getAttribute('title')).toBeTruthy()
    }
  })

  it('is hidden while the cursor is outside a table', async () => {
    const editor = await makeEmptyEditor()
    mountMenu(editor)
    insertTable(editor.getView(), 2, 2)
    placeCursorInDataCell(editor)
    await flush()
    expect(document.querySelector('.neko-table-menu')).toBeTruthy()

    // Move the cursor out of the table (to the start of the document).
    const view = editor.getView()
    view.dispatch(
      view.state.tr.setSelection(TextSelection.create(view.state.doc, 0)).setMeta('addToHistory', false),
    )
    await flush()
    expect(document.querySelector('.neko-table-menu')).toBeNull()
  })

  it('navigates between buttons with ArrowRight/ArrowLeft', async () => {
    const editor = await makeEmptyEditor()
    mountMenu(editor)
    insertTable(editor.getView(), 2, 2)
    placeCursorInDataCell(editor)
    await flush()

    const toolbar = document.querySelector<HTMLElement>('.neko-table-menu')!
    const buttons = Array.from(toolbar.querySelectorAll<HTMLButtonElement>('button'))
    buttons[0].focus()

    // ArrowRight moves to the next button and wraps to the first at the end.
    toolbar.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
    expect(document.activeElement).toBe(buttons[1])
    toolbar.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }))
    expect(document.activeElement).toBe(buttons[0])
  })

  it('traps Tab focus inside the toolbar while focused', async () => {
    const editor = await makeEmptyEditor()
    mountMenu(editor)
    insertTable(editor.getView(), 2, 2)
    placeCursorInDataCell(editor)
    await flush()

    const toolbar = document.querySelector<HTMLElement>('.neko-table-menu')!
    const buttons = Array.from(toolbar.querySelectorAll<HTMLButtonElement>('button'))
    buttons[0].focus()

    // Forward Tab from the last button wraps back to the first.
    buttons[buttons.length - 1].focus()
    toolbar.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }))
    expect(document.activeElement).toBe(buttons[0])

    // Shift+Tab from the first wraps to the last.
    buttons[0].focus()
    toolbar.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true }))
    expect(document.activeElement).toBe(buttons[buttons.length - 1])
  })

  it('restores focus to the previously focused element on Escape', async () => {
    const editor = await makeEmptyEditor()
    mountMenu(editor)
    insertTable(editor.getView(), 2, 2)
    placeCursorInDataCell(editor)
    await flush()

    const toolbar = document.querySelector<HTMLElement>('.neko-table-menu')!
    const outside = document.createElement('button')
    document.body.appendChild(outside)
    outside.focus()

    const firstBtn = toolbar.querySelector<HTMLButtonElement>('button')!
    firstBtn.focus()
    // Focus entering the toolbar: capture the prior element.
    firstBtn.dispatchEvent(new FocusEvent('focusin', { relatedTarget: outside, bubbles: true }))

    toolbar.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(document.activeElement).toBe(outside)
  })
})
