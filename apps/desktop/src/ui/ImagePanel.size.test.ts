import { afterEach, describe, expect, it } from 'vitest'
import { createApp, type App as VueApp } from 'vue'
import { NodeSelection } from '@milkdown/prose/state'
import { undoDepth } from '@milkdown/prose/history'
import { createEditor, basicPlugins, getImageAttrs } from '@nekowite/editor-core'
import type { NekoEditor } from '@nekowite/editor-core'
import ImagePanel from './ImagePanel.vue'
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

/**
 * The image's own pixels, as the node view's `<img>` reports them once it has
 * loaded. happy-dom requests nothing, so the element is handed the numbers the
 * browser would have decoded — which is also the honest way to say what the
 * panel reads: the element, not the document src.
 */
function paintImage(el: HTMLElement, width: number, height: number): void {
  const img = el.querySelector('img')
  if (!img) throw new Error('the node view rendered no <img>')
  for (const [key, value] of [['naturalWidth', width], ['naturalHeight', height]] as const) {
    Object.defineProperty(img, key, { value, configurable: true })
  }
}

async function open(markdown: string, pixels?: [number, number]): Promise<{ editor: NekoEditor; pos: number }> {
  const el = document.createElement('div')
  document.body.appendChild(el)
  const editor = createEditor(el, { plugins: basicPlugins })
  await editor.open(markdown)
  editors.push(editor)
  if (pixels) {
    const figure = editor.getView().dom.querySelector('.neko-image')
    if (!figure) throw new Error('no image node view')
    paintImage(figure as HTMLElement, pixels[0], pixels[1])
  }
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
  const host = document.createElement('div')
  document.body.appendChild(host)
  const app = createApp(ImagePanel, { editor })
  app.mount(host)
  mounted.push(app)
  view.dispatch(view.state.tr.setSelection(NodeSelection.create(view.state.doc, pos)))
  return { editor, pos }
}

const field = (id: string): HTMLInputElement => document.getElementById(id) as HTMLInputElement

function type(input: HTMLInputElement, value: string): void {
  input.value = value
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

function setChecked(box: HTMLInputElement, checked: boolean): void {
  box.checked = checked
  box.dispatchEvent(new Event('change', { bubbles: true }))
}

/** The read-out under a size row, by its label. */
function sizeRow(label: string): string {
  const line = [...document.querySelectorAll('.neko-image-size-line')].find(
    (row) => row.querySelector('.neko-image-field-label')?.textContent?.trim() === label,
  )
  if (!line) throw new Error(`no size row labelled ${label}`)
  return line.querySelector('.neko-image-size-value')?.textContent?.trim() ?? ''
}

describe('the image panel’s size controls', () => {
  it('writes a height, and the height survives a save', async () => {
    const { editor, pos } = await open('![img](attachments/a.png){width=400}\n')
    await flush()

    type(field('neko-image-height'), '300')
    await flush()

    expect(getImageAttrs(editor.getView(), pos)?.height).toBe(300)
    // The round trip that makes the control honest: height is an attribute the
    // schema stores, the serializer emits and the parser reads back.
    expect(await editor.save()).toContain('![img](attachments/a.png){width=400 height=300}')
  })

  it('is empty — not zero — when the file does not set a height', async () => {
    await open('![img](attachments/a.png)\n')
    await flush()
    expect(field('neko-image-height').value).toBe('')
  })

  it('reads the file’s own pixels off the node view’s image, not the raw src', async () => {
    // The dash in the report's screenshot: the panel used to probe the document
    // src, which is vault-relative and cannot load in the webview, so 原始尺寸
    // was `—` for every real image and the ratio went with it.
    await open('![img](attachments/a.png){width=500}\n', [1000, 500])
    await flush()

    expect(sizeRow(t('imagePanel.originalSize'))).toBe('1000×500')
    // The width-only image the browser draws at the file's ratio — not 500×500,
    // which is what pairing a custom width with the ORIGINAL height printed.
    expect(sizeRow(t('imagePanel.currentSize'))).toBe('500×250')
  })

  it('shows the dash, and explains it, while the image has not loaded', async () => {
    await open('![img](attachments/a.png){width=761}\n')
    await flush()

    expect(sizeRow(t('imagePanel.originalSize'))).toBe('—')
    const value = document.querySelectorAll('.neko-image-size-value')[1]
    expect(value.getAttribute('title')).toBe(t('imagePanel.originalUnknown'))
    // The current size says what it does know and no more.
    expect(sizeRow(t('imagePanel.currentSize'))).toBe(`761×${t('imagePanel.auto')}`)
  })

  it('locks the pair: a width edit writes both halves in ONE undo step', async () => {
    const { editor, pos } = await open('![img](attachments/a.png)\n', [1000, 500])
    await flush()

    setChecked(field('neko-image-lock'), true)
    await flush()
    const before = undoDepth(editor.getView().state)

    type(field('neko-image-width'), '500')
    await flush()

    expect(getImageAttrs(editor.getView(), pos)).toMatchObject({ width: 500, height: 250 })
    // One transaction, not two: the pair is written as one patch.
    expect(undoDepth(editor.getView().state)).toBe(before + 1)
    // The other field shows what was written, so the form never disagrees with
    // the document it is editing.
    expect(field('neko-image-height').value).toBe('250')
    expect(await editor.save()).toContain('{width=500 height=250}')
  })

  it('keeps the ratio from either field', async () => {
    const { editor, pos } = await open('![img](attachments/a.png)\n', [1000, 500])
    await flush()
    setChecked(field('neko-image-lock'), true)
    await flush()

    type(field('neko-image-height'), '250')
    await flush()
    expect(getImageAttrs(editor.getView(), pos)).toMatchObject({ width: 500, height: 250 })
    expect(field('neko-image-width').value).toBe('500')
  })

  it('leaves the halves independent while the lock is off', async () => {
    const { editor, pos } = await open('![img](attachments/a.png)\n', [1000, 500])
    await flush()

    type(field('neko-image-width'), '400')
    await flush()
    const attrs = getImageAttrs(editor.getView(), pos)
    expect(attrs?.width).toBe(400)
    expect(attrs?.height).toBeNull()
    expect(field('neko-image-height').value).toBe('')
  })

  it('disables the lock, and says why, when there is no ratio to hold', async () => {
    await open('![img](attachments/a.png)\n')
    await flush()

    const lock = field('neko-image-lock')
    expect(lock.disabled).toBe(true)
    expect(lock.closest('label')?.getAttribute('title')).toBe(t('imagePanel.lockUnavailable'))
  })

  it('restores the size — both halves — in one undo step', async () => {
    const { editor, pos } = await open('![img](attachments/a.png){width=400 height=300}\n')
    await flush()
    const before = undoDepth(editor.getView().state)

    const restore = [...document.querySelectorAll<HTMLButtonElement>('.neko-image-actions button')].find(
      (b) => b.textContent?.trim() === t('imagePanel.restoreSize'),
    )!
    restore.click()
    await flush()

    const attrs = getImageAttrs(editor.getView(), pos)
    expect(attrs?.width).toBeNull()
    expect(attrs?.height).toBeNull()
    expect(undoDepth(editor.getView().state)).toBe(before + 1)
    expect(field('neko-image-width').value).toBe('')
    expect(field('neko-image-height').value).toBe('')
  })

  it('never writes an attribute the document cannot store: the panel exposes the schema’s own set', async () => {
    // Every control in the panel, and the attribute each one writes. A control
    // for something the schema cannot save is worse than no control, so this is
    // the list the panel is allowed to have.
    const { editor, pos } = await open('![img](attachments/a.png)\n', [1000, 500])
    await flush()
    type(field('neko-image-alt'), 'a')
    type(field('neko-image-title'), 't')
    type(field('neko-image-link'), 'attachments/b.png')
    type(field('neko-image-width'), '300')
    type(field('neko-image-height'), '150')
    await flush()

    const attrs = getImageAttrs(editor.getView(), pos)
    expect(Object.keys(attrs ?? {}).sort()).toEqual(['align', 'alt', 'height', 'src', 'title', 'width'])
  })
})
