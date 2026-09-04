import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { createApp, type App as VueApp } from 'vue'
import { createPinia, setActivePinia, type Pinia } from 'pinia'
import { useTabsStore } from '../stores/tabs'

const saveAttachmentMock = vi.hoisted(() => vi.fn())

vi.mock('../services/fs', () => ({
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
    resolveMediaPath: vi.fn(),
  },
}))

import RenderedPane from './RenderedPane.vue'
import { editorBridge } from '../services/editorBridge'
import { fsService } from '../services/fs'

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

let pinia: Pinia
let mounted: VueApp[] = []

function pasteEvent(dataTransfer: { files: File[]; items: unknown[] }): Event {
  const event = new Event('paste', { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'clipboardData', { value: dataTransfer })
  return event
}

describe('RenderedPane image paste pipeline', () => {
  beforeEach(() => {
    pinia = createPinia()
    setActivePinia(pinia)
    saveAttachmentMock.mockReset()
    saveAttachmentMock.mockResolvedValue('attachments/2026-09/paste-x.png')
    document.body.innerHTML = ''
    mounted = []
  })

  afterEach(() => {
    mounted.forEach((app) => app.unmount())
    mounted = []
    document.body.innerHTML = ''
  })

  async function mountPane(withVault = true): Promise<{ host: HTMLElement; pane: HTMLElement }> {
    const tabs = useTabsStore()
    if (withVault) tabs.setVault('/vault')
    await tabs.openTab('notes/a.md')
    const host = document.createElement('div')
    document.body.appendChild(host)
    const app = createApp(RenderedPane)
    app.use(pinia)
    app.mount(host)
    mounted.push(app)
    await flush()
    const pane = host.querySelector('.rendered-pane')
    expect(pane).toBeTruthy()
    return { host, pane: pane as HTMLElement }
  }

  it('prompts for a rename, saves the image into the note assets dir and inserts a markdown block', async () => {
    const { pane } = await mountPane()
    const png = new File([new Uint8Array([137, 80])], 'image.png', { type: 'image/png' })
    pane.dispatchEvent(pasteEvent({ files: [png], items: [] }))
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
    const { pane } = await mountPane()
    const png = new File([new Uint8Array([137, 80])], 'image.png', { type: 'image/png' })
    pane.dispatchEvent(pasteEvent({ files: [png], items: [] }))
    await flush()

    ;(document.body.querySelector('.rename-dialog .btn-ghost') as HTMLElement).click()
    await flush()
    expect(saveAttachmentMock).not.toHaveBeenCalled()
    // No image block was inserted — the document keeps its original content.
    expect(await editorBridge.getEditor()?.save()).not.toContain('![')
  })

  it('does not intercept plain-text pastes', async () => {
    const { pane } = await mountPane()
    const event = pasteEvent({ files: [], items: [] })
    pane.dispatchEvent(event)
    await flush()
    expect(saveAttachmentMock).not.toHaveBeenCalled()
  })

  it('reports a missing vault instead of saving', async () => {
    const { pane } = await mountPane(false)
    const png = new File([new Uint8Array([137])], 'image.png', { type: 'image/png' })
    pane.dispatchEvent(pasteEvent({ files: [png], items: [] }))
    await flush()
    expect(saveAttachmentMock).not.toHaveBeenCalled()
  })
})

describe('RenderedPane content injection', () => {
  beforeEach(() => {
    pinia = createPinia()
    setActivePinia(pinia)
    saveAttachmentMock.mockReset()
    saveAttachmentMock.mockResolvedValue('attachments/2026-09/paste-x.png')
    document.body.innerHTML = ''
    mounted = []
  })

  afterEach(() => {
    mounted.forEach((app) => app.unmount())
    mounted = []
    document.body.innerHTML = ''
  })

  it('renders the loaded markdown when the tab opens AFTER the pane mounts (E2E order)', async () => {
    const tabs = useTabsStore()
    tabs.setVault('/vault')
    const host = document.createElement('div')
    document.body.appendChild(host)
    const app = createApp(RenderedPane)
    app.use(pinia)
    app.mount(host)
    mounted.push(app)
    await flush()

    // The file read is async and resolved AFTER the placeholder tab exists —
    // the disk content must reach the editor (it was previously lost because
    // the read mutated the raw placeholder object, which bypasses Vue
    // reactivity so the content watcher never re-fired).
    vi.mocked(fsService.read).mockResolvedValue('# Welcome\n\nbody')
    await tabs.openTab('notes/welcome.md')
    await flush()
    await flush()

    const h1 = document.querySelector('.rendered-pane .ProseMirror h1')
    expect(h1?.textContent).toBe('Welcome')
    const md = await editorBridge.getEditor()?.save()
    expect(md).toContain('# Welcome')
  })
})
