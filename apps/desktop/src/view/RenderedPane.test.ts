import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { createApp, type App as VueApp } from 'vue'
import { createPinia, setActivePinia, type Pinia } from 'pinia'
import { useTabsStore } from '../stores/tabs'

const saveAttachmentMock = vi.hoisted(() => vi.fn())

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
    resolveMediaPath: vi.fn(),
  },
}))

import RenderedPane from './RenderedPane.vue'
import { editorBridge } from '../services/editorBridge'
import { fsService } from '../platform/gateways/fs'

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

let pinia: Pinia
let mounted: VueApp[] = []

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
