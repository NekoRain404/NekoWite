import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { createApp, type App as VueApp } from 'vue'
import { createPinia, setActivePinia, type Pinia } from 'pinia'
import { useTabsStore } from '../stores/tabs'

const saveAttachmentMock = vi.hoisted(() => vi.fn())
const importAttachmentMock = vi.hoisted(() => vi.fn())

vi.mock('../platform/gateways/fs', () => ({
  fsService: {
    read: vi.fn().mockResolvedValue('Hello\n'),
    write: vi.fn(),
    list: vi.fn(),
    watch: vi.fn(),
    deleteFile: vi.fn(),
    stat: vi.fn(),
    listHistory: vi.fn().mockResolvedValue([]),
    readHistory: vi.fn(),
    restoreHistory: vi.fn(),
    openFolderDialog: vi.fn(),
    saveFileDialog: vi.fn(),
    onFsChange: vi.fn(),
    listTrash: vi.fn(),
    restoreFromTrash: vi.fn(),
    saveAttachment: saveAttachmentMock,
    importAttachment: importAttachmentMock,
    resolveMediaPath: vi.fn(),
  },
}))

import EditorPane from './EditorPane.vue'
import { editorBridge } from '../services/editorBridge'
import { t } from '../i18n'
import {
  resetMemoryPickedFiles,
  seedMemoryPickedFiles,
} from '../platform/gateways/memory'


const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

let pinia: Pinia
let mounted: VueApp[] = []

function pasteEvent(dataTransfer: { files: File[]; items: unknown[] }): Event {
  const event = new Event('paste', { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'clipboardData', { value: dataTransfer })
  return event
}

function png(name = 'image.png'): File {
  return new File([new Uint8Array([137, 80])], name, { type: 'image/png' })
}

/**
 * The intake listeners live on the pane container in `EditorPane` (not inside
 * the rendered pane) so a paste lands in either view. These cases drive the
 * real DOM path on that container.
 */
describe('EditorPane image intake', () => {
  beforeEach(() => {
    pinia = createPinia()
    setActivePinia(pinia)
    saveAttachmentMock.mockReset()
    saveAttachmentMock.mockResolvedValue('attachments/2026-09/paste-x.png')
    importAttachmentMock.mockReset()
    importAttachmentMock.mockResolvedValue('attachments/2026-09/cat.png')
    resetMemoryPickedFiles()
    document.body.innerHTML = ''
    mounted = []
  })

  afterEach(() => {
    mounted.forEach((app) => app.unmount())
    mounted = []
    document.body.innerHTML = ''
    resetMemoryPickedFiles()
  })

  async function mountPane(): Promise<HTMLElement> {
    const tabs = useTabsStore()
    tabs.setVault('/vault')
    await tabs.openTab('notes/a.md')
    const host = document.createElement('div')
    document.body.appendChild(host)
    const app = createApp(EditorPane)
    app.use(pinia)
    app.mount(host)
    mounted.push(app)
    await flush()
    const panes = host.querySelector('.panes')
    expect(panes).toBeTruthy()
    return panes as HTMLElement
  }

  it('prompts for a rename, saves the image into the note assets dir and inserts a markdown block', async () => {
    const panes = await mountPane()
    panes.dispatchEvent(pasteEvent({ files: [png()], items: [] }))
    await flush()

    // The rename modal is open, pre-filled with a timestamped default.
    const input = document.body.querySelector<HTMLInputElement>('.rename-dialog .input')
    expect(input).toBeTruthy()
    expect(input?.value).toMatch(/^paste-\d{8}-\d{6}\.png$/)
    input!.value = 'hello.png'
    input!.dispatchEvent(new Event('input'))
    ;(document.body.querySelector('.rename-dialog .btn-primary') as HTMLElement).click()
    await flush()

    expect(saveAttachmentMock).toHaveBeenCalledWith(
      '/vault',
      'hello.png',
      expect.any(String),
      'notes/a_assets',
    )
    const md = await editorBridge.getEditor()?.save()
    expect(md).toMatch(/!\[hello\.png\]\(\.\.\/attachments\/2026-09\/paste-x\.png\)/)
  })

  it('skips a file when the rename is cancelled', async () => {
    const panes = await mountPane()
    panes.dispatchEvent(pasteEvent({ files: [png()], items: [] }))
    await flush()

    ;(document.body.querySelector('.rename-dialog .btn-ghost') as HTMLElement).click()
    await flush()
    expect(saveAttachmentMock).not.toHaveBeenCalled()
    // No image block was inserted — the document keeps its original content.
    expect(await editorBridge.getEditor()?.save()).not.toContain('![')
  })

  it('does not intercept plain-text pastes', async () => {
    const panes = await mountPane()
    panes.dispatchEvent(pasteEvent({ files: [], items: [] }))
    await flush()
    expect(saveAttachmentMock).not.toHaveBeenCalled()
  })

  it('opens the file picker from the image toolbar button and imports the choice', async () => {
    const panes = await mountPane()
    seedMemoryPickedFiles({ 'C:/pics/cat.png': 'QQ==' })
    const button = [...document.querySelectorAll<HTMLButtonElement>('.toolbar-btn')].find(
      (el) => el.getAttribute('aria-label') === t('toolbar.image'),
    )
    expect(button).toBeTruthy()

    button!.click()
    await flush()
    await flush()

    // The button used to insert an image node with an empty src and never ask
    // for a file at all.
    expect(importAttachmentMock).toHaveBeenCalledWith('/vault', 'C:/pics/cat.png', 'notes/a_assets')
    const md = await editorBridge.getEditor()?.save()
    expect(md).toContain('![cat.png](../attachments/2026-09/cat.png)')
    void panes
  })

  it('reports a missing vault instead of saving', async () => {
    // The listeners hang off the pane container, which only exists with a tab
    // open, so the vault is dropped after mount to reach the guard.
    const panes = await mountPane()
    useTabsStore().vault = null
    panes.dispatchEvent(pasteEvent({ files: [png()], items: [] }))
    await flush()
    expect(saveAttachmentMock).not.toHaveBeenCalled()
    expect(document.body.querySelector('.rename-dialog')).toBeNull()
  })
})

describe('EditorPane float selection across modes', () => {
  beforeEach(() => {
    pinia = createPinia()
    setActivePinia(pinia)
    saveAttachmentMock.mockReset()
    importAttachmentMock.mockReset()
    resetMemoryPickedFiles()
    document.body.innerHTML = ''
    mounted = []
  })

  afterEach(() => {
    mounted.forEach((app) => app.unmount())
    mounted = []
    document.body.innerHTML = ''
    resetMemoryPickedFiles()
  })

  it('drops the floating-box selection when the source pane takes over', async () => {
    const tabs = useTabsStore()
    tabs.setVault('/vault')
    await tabs.openTab('notes/a.md')
    const host = document.createElement('div')
    document.body.appendChild(host)
    const app = createApp(EditorPane)
    app.use(pinia)
    app.mount(host)
    mounted.push(app)
    await flush()

    const { useFloatStore } = await import('../stores/float')
    const { useViewStore } = await import('../stores/view')
    useFloatStore().select('float-1')

    // The floating-box toolbar is rendered on the shared pane container, so in
    // source mode it would still be visible while the element it edits is
    // hidden — its buttons would edit the model source mode does not own.
    useViewStore().setMode('source')
    await flush()

    expect(useFloatStore().selectedId).toBeNull()
  })

  it('keeps the selection while the rendered pane is still visible', async () => {
    const tabs = useTabsStore()
    tabs.setVault('/vault')
    await tabs.openTab('notes/a.md')
    const host = document.createElement('div')
    document.body.appendChild(host)
    const app = createApp(EditorPane)
    app.use(pinia)
    app.mount(host)
    mounted.push(app)
    await flush()

    const { useFloatStore } = await import('../stores/float')
    const { useViewStore } = await import('../stores/view')
    useFloatStore().select('float-1')

    // Split mode shows both panes, so the selection is still meaningful.
    useViewStore().setMode('split')
    await flush()
    expect(useFloatStore().selectedId).toBe('float-1')
  })
})
