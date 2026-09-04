import { afterEach, describe, expect, it } from 'vitest'
import { createApp, type App as VueApp } from 'vue'
import { NodeSelection } from '@milkdown/prose/state'
import { createEditor, basicPlugins } from '@nekowite/editor-core'
import type { NekoEditor } from '@nekowite/editor-core'
import ImagePanel from './ImagePanel.vue'

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

async function makeImageEditor(): Promise<{ editor: NekoEditor; pos: number }> {
  const el = document.createElement('div')
  document.body.appendChild(el)
  const editor = createEditor(el, { plugins: basicPlugins })
  await editor.open('![img](attachments/a.png)')
  editors.push(editor)
  const view = editor.getView()
  let pos: number | null = null
  view.state.doc.descendants((n, p) => {
    if (n.type.name === 'image') {
      pos = p
      return false
    }
    return true
  })
  if (pos === null) throw new Error('no image node')
  return { editor, pos }
}

function mountPanel(editor: NekoEditor): void {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const app = createApp(ImagePanel, { editor })
  app.mount(host)
  mounted.push(app)
}

describe('ImagePanel accessibility', () => {
  it('renders a labelled non-modal dialog with for/id-wired labels', async () => {
    const { editor, pos } = await makeImageEditor()
    mountPanel(editor)
    // Select the image → the panel becomes visible.
    editor.getView().dispatch(
      editor.getView().state.tr.setSelection(NodeSelection.create(editor.getView().state.doc, pos)),
    )
    await flush()

    const panel = document.querySelector<HTMLElement>('.neko-image-panel')!
    expect(panel).toBeTruthy()
    expect(panel.getAttribute('role')).toBe('dialog')
    expect(panel.getAttribute('aria-modal')).toBe('false')
    expect(panel.getAttribute('aria-label')).toBeTruthy()

    // Every field is a real label + control pair with a matching for/id.
    for (const id of ['neko-image-alt', 'neko-image-title', 'neko-image-link', 'neko-image-width', 'neko-image-align']) {
      const control = document.getElementById(id)
      expect(control, `#${id} control`).toBeTruthy()
      const label = control?.closest('label')
      expect(label?.getAttribute('for'), `label[for=${id}]`).toBe(id)
    }
    // The action buttons are native, keyboard-operable buttons.
    const buttons = Array.from(document.querySelectorAll('.neko-image-actions button'))
    expect(buttons.length).toBeGreaterThanOrEqual(3)
    for (const b of buttons) {
      expect(b.tagName).toBe('BUTTON')
      expect(b.getAttribute('type')).toBe('button')
      expect((b as HTMLElement).textContent?.trim().length).toBeGreaterThan(0)
    }
  })

  it('moves focus to the first field when the panel opens', async () => {
    const { editor, pos } = await makeImageEditor()
    mountPanel(editor)
    editor.getView().dispatch(
      editor.getView().state.tr.setSelection(NodeSelection.create(editor.getView().state.doc, pos)),
    )
    await flush()

    const altInput = document.getElementById('neko-image-alt') as HTMLInputElement
    expect(altInput).toBeTruthy()
    expect(document.activeElement).toBe(altInput)
  })

  it('clears the selection and hides the panel on Escape', async () => {
    const { editor, pos } = await makeImageEditor()
    mountPanel(editor)
    editor.getView().dispatch(
      editor.getView().state.tr.setSelection(NodeSelection.create(editor.getView().state.doc, pos)),
    )
    await flush()
    expect(document.querySelector('.neko-image-panel')).toBeTruthy()

    const panel = document.querySelector<HTMLElement>('.neko-image-panel')!
    panel.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await flush()

    expect(document.querySelector('.neko-image-panel')).toBeNull()
  })
})
