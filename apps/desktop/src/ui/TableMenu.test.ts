import { afterEach, describe, expect, it } from 'vitest'
import { createApp, type App as VueApp } from 'vue'
import { TextSelection } from '@milkdown/prose/state'
import { createEditor, basicPlugins, insertTable } from '@nekowite/editor-core'
import type { NekoEditor } from '@nekowite/editor-core'
import TableMenu from './TableMenu.vue'

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

function mountMenu(editor: NekoEditor): void {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const app = createApp(TableMenu, { editor })
  app.mount(host)
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
