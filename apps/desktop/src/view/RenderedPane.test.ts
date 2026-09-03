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

  it('saves a pasted image and inserts a note-relative markdown block', async () => {
    const { pane } = await mountPane()
    const png = new File([new Uint8Array([137, 80])], 'image.png', { type: 'image/png' })
    pane.dispatchEvent(pasteEvent({ files: [png], items: [] }))
    await flush()

    expect(saveAttachmentMock).toHaveBeenCalledWith(
      '/vault',
      expect.stringMatching(/^paste-\d{8}-\d{6}\.png$/),
      expect.any(String),
    )
    const md = await editorBridge.getEditor()?.save()
    // Note lives at notes/a.md, the attachment at the vault root's
    // attachments dir — the reference must climb one level.
    expect(md).toMatch(
      /!\[paste-\d{8}-\d{6}\.png\]\(\.\.\/attachments\/2026-09\/paste-x\.png\)/,
    )
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
