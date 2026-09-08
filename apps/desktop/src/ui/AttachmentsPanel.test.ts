import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { createApp, type App as VueApp } from 'vue'
import { createPinia, setActivePinia, type Pinia } from 'pinia'
import AttachmentsPanel from './AttachmentsPanel.vue'
import { useTabsStore } from '../stores/tabs'
import { editorBridge } from '../services/editorBridge'
import { onNotify } from '../services/errors'

const listMock = vi.hoisted(() => vi.fn())
const statMock = vi.hoisted(() => vi.fn())
const deleteFileMock = vi.hoisted(() => vi.fn())
const resolveMediaPathMock = vi.hoisted(() => vi.fn())

vi.mock('../platform/gateways/fs', () => ({
  fsService: {
    read: vi.fn(),
    write: vi.fn(),
    list: listMock,
    stat: statMock,
    deleteFile: deleteFileMock,
    resolveMediaPath: resolveMediaPathMock,
    watch: vi.fn(),
    searchNotes: vi.fn(),
    openFolderDialog: vi.fn(),
    saveFileDialog: vi.fn(),
    onFsChange: vi.fn(),
    listTrash: vi.fn(),
    restoreFromTrash: vi.fn(),
    listHistory: vi.fn(),
    readHistory: vi.fn(),
    restoreHistory: vi.fn(),
    saveAttachment: vi.fn(),
    createDir: vi.fn(),
    renameEntry: vi.fn(),
  },
}))

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

let pinia: Pinia
let mounted: VueApp[] = []
const insertSpy = vi.fn()

function fakeEditor(): { insertMarkdownAtCursor: typeof insertSpy } {
  return { insertMarkdownAtCursor: insertSpy }
}

function mountPanel(): HTMLElement {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const app = createApp(AttachmentsPanel)
  app.use(pinia)
  app.mount(host)
  mounted.push(app)
  return host
}

function mockAttachmentTree(): void {
  listMock.mockImplementation(async (_vault: string, dir: string) => {
    if (dir === 'attachments') {
      return [{ name: '2026-01', path: 'attachments/2026-01', is_dir: true, is_mdx: false }]
    }
    if (dir === 'attachments/2026-01') {
      return [{ name: 'pic.png', path: 'attachments/2026-01/pic.png', is_dir: false, is_mdx: false }]
    }
    return []
  })
  statMock.mockResolvedValue({ size: 2048, mtime: Date.now() - 5 * 60_000 })
  resolveMediaPathMock.mockResolvedValue('data:image/png;base64,QQ==')
}

async function openDoc(path = 'notes/a.md', vault = '/vault'): Promise<void> {
  const s = useTabsStore()
  s.setVault(vault)
  await s.openTab(path)
}

function menuItems(): HTMLButtonElement[] {
  return [...document.body.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
}

describe('AttachmentsPanel', () => {
  beforeEach(() => {
    pinia = createPinia()
    setActivePinia(pinia)
    listMock.mockReset()
    statMock.mockReset()
    deleteFileMock.mockReset()
    resolveMediaPathMock.mockReset()
    insertSpy.mockReset()
    document.body.innerHTML = ''
    mounted = []
    editorBridge.setEditor(fakeEditor() as never)
  })

  afterEach(() => {
    mounted.forEach((app) => app.unmount())
    mounted = []
    document.body.innerHTML = ''
    editorBridge.setEditor(null)
  })

  it('lists attachments newest-first with count, size and relative time', async () => {
    mockAttachmentTree()
    await openDoc()
    mountPanel()
    await flush()
    expect(resolveMediaPathMock).toHaveBeenCalledWith('/vault', 'attachments/2026-01/pic.png')
    const card = document.body.querySelector('.att-card')
    expect(card).toBeTruthy()
    expect(card?.querySelector('.att-name')?.textContent).toBe('pic.png')
    expect(card?.querySelector('.att-sub')?.textContent).toContain('2.0 KB')
    expect(card?.querySelector('.att-sub')?.textContent).toContain('分钟前')
    const img = card?.querySelector('img')
    expect(img?.getAttribute('loading')).toBe('lazy')
  })

  it('inserts a markdown image with a note-relative path on click', async () => {
    mockAttachmentTree()
    await openDoc('notes/a.md')
    mountPanel()
    await flush()
    ;(document.body.querySelector('.att-card') as HTMLElement | null)?.click()
    await flush()
    expect(insertSpy).toHaveBeenCalledTimes(1)
    expect(insertSpy).toHaveBeenCalledWith('\n\n![pic](../attachments/2026-01/pic.png)\n\n')
  })

  it('root-level notes reference the plain vault-relative path', async () => {
    mockAttachmentTree()
    await openDoc('a.md')
    mountPanel()
    await flush()
    ;(document.body.querySelector('.att-card') as HTMLElement | null)?.click()
    await flush()
    expect(insertSpy).toHaveBeenCalledWith('\n\n![pic](attachments/2026-01/pic.png)\n\n')
  })

  it('notifies instead of inserting when no document is active', async () => {
    mockAttachmentTree()
    useTabsStore().setVault('/vault')
    mountPanel()
    await flush()
    const messages: string[] = []
    const off = onNotify((m) => messages.push(m))
    try {
      ;(document.body.querySelector('.att-card') as HTMLElement | null)?.click()
      await flush()
    } finally {
      off()
    }
    expect(insertSpy).not.toHaveBeenCalled()
    expect(messages.some((m) => m.includes('先打开一个文档'))).toBe(true)
  })

  it('shows the empty state when the attachments dir has no images', async () => {
    listMock.mockResolvedValue([])
    await openDoc()
    mountPanel()
    await flush()
    expect(document.body.querySelector('.att-empty-title')?.textContent?.trim()).toBe('附件库为空')
    expect(document.body.querySelector('.att-card')).toBeNull()
  })

  it('falls back to an icon when the thumbnail fails to load', async () => {
    mockAttachmentTree()
    await openDoc()
    mountPanel()
    await flush()
    const img = document.body.querySelector('.att-thumb img') as HTMLImageElement
    expect(img).toBeTruthy()
    img.dispatchEvent(new Event('error'))
    await flush()
    expect(document.body.querySelector('.att-thumb img')).toBeNull()
    expect(document.body.querySelector('.att-thumb svg')).toBeTruthy()
  })

  it('deletes through the two-stage context menu confirm', async () => {
    mockAttachmentTree()
    await openDoc()
    mountPanel()
    await flush()
    const card = document.body.querySelector('.att-card') as HTMLElement
    card.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 40 }))
    await flush()
    const labels = () => menuItems().map((b) => b.textContent?.trim())
    expect(labels()).toContain('删除')
    menuItems().find((b) => b.textContent?.trim() === '删除')!.click()
    await flush()
    expect(deleteFileMock).not.toHaveBeenCalled()
    expect(labels()).toContain('确认删除')
    menuItems().find((b) => b.textContent?.trim() === '确认删除')!.click()
    await flush()
    expect(deleteFileMock).toHaveBeenCalledWith('/vault', 'attachments/2026-01/pic.png')
  })

  it('copies the note-relative path to the clipboard', async () => {
    mockAttachmentTree()
    await openDoc('notes/a.md')
    mountPanel()
    await flush()
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    const card = document.body.querySelector('.att-card') as HTMLElement
    card.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 40 }))
    await flush()
    menuItems().find((b) => b.textContent?.trim() === '复制相对路径')!.click()
    await flush()
    expect(writeText).toHaveBeenCalledWith('../attachments/2026-01/pic.png')
  })
})
