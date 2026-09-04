import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, type App as VueApp } from 'vue'
import { createPinia, setActivePinia, type Pinia } from 'pinia'
import NoteListPanel from './NoteListPanel.vue'
import FileTree from './FileTree.vue'
import { useFileTreeStore } from '../stores/fileTree'
import { useDocumentListStore } from '../stores/documentList'
import { useTabsStore } from '../stores/tabs'

const fsMocks = vi.hoisted(() => ({
  read: vi.fn(),
  write: vi.fn(),
  stat: vi.fn(),
  list: vi.fn(),
  watch: vi.fn(),
  deleteFile: vi.fn(),
  renameEntry: vi.fn(),
  createDir: vi.fn(),
  openFolderDialog: vi.fn(),
  saveFileDialog: vi.fn(),
  onFsChange: vi.fn(),
  listTrash: vi.fn(),
  restoreFromTrash: vi.fn(),
  clearTrash: vi.fn(),
  listHistory: vi.fn(),
  readHistory: vi.fn(),
  restoreHistory: vi.fn(),
  searchNotes: vi.fn(),
  saveAttachment: vi.fn(),
  resolveMediaPath: vi.fn(),
}))

vi.mock('../platform/gateways/fs', () => ({ fsService: fsMocks }))

let pinia: Pinia
let host: HTMLElement | null = null
let mounted: VueApp[] = []

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

function mountPanel(): void {
  host = document.createElement('div')
  document.body.appendChild(host)
  const app = createApp(NoteListPanel)
  app.use(pinia)
  app.mount(host)
  mounted.push(app)
}

describe('NoteListPanel truncation notice', () => {
  beforeEach(() => {
    pinia = createPinia()
    setActivePinia(pinia)
  })

  afterEach(() => {
    for (const app of mounted) app.unmount()
    mounted = []
    host?.remove()
    host = null
  })

  it('does not show the notice when the vault is not truncated', async () => {
    useFileTreeStore().vaultTruncated = false
    mountPanel()
    await flush()
    expect(host!.textContent).not.toContain('截断')
    expect(host!.textContent).not.toContain('listing truncated')
  })

  it('surfaces the truncation signal to the user when the vault walk was capped', async () => {
    useFileTreeStore().vaultTruncated = true
    useDocumentListStore().indexing = false
    mountPanel()
    await flush()
    // The default test locale is zh, so the notice resolves to the zh string.
    expect(host!.textContent).toContain('笔记库过大')
  })
})

describe('FileTree create/rename/delete flows (A4)', () => {
  beforeEach(() => {
    pinia = createPinia()
    setActivePinia(pinia)
    fsMocks.list.mockReset()
    fsMocks.list.mockResolvedValue([])
    fsMocks.write.mockReset()
    fsMocks.read.mockReset()
    fsMocks.read.mockResolvedValue('# hello')
    fsMocks.watch.mockReset()
    fsMocks.watch.mockResolvedValue(undefined)
    fsMocks.onFsChange.mockReset()
    fsMocks.onFsChange.mockResolvedValue(() => {})
    fsMocks.deleteFile.mockReset()
    fsMocks.deleteFile.mockResolvedValue('trash-key')
    fsMocks.createDir.mockReset()
    fsMocks.createDir.mockResolvedValue('x')
    fsMocks.renameEntry.mockReset()
    fsMocks.renameEntry.mockResolvedValue('x')
    fsMocks.listHistory.mockReset()
    fsMocks.listHistory.mockResolvedValue([])
    fsMocks.stat.mockReset()
    fsMocks.stat.mockResolvedValue({ size: 1, mtime: 1 })
    fsMocks.resolveMediaPath.mockReset()
    fsMocks.saveAttachment.mockReset()
    document.body.innerHTML = ''
    mounted = []
  })

  afterEach(() => {
    mounted.forEach((app) => app.unmount())
    mounted = []
    host?.remove()
    host = null
  })

  function mountTree(): HTMLElement {
    host = document.createElement('div')
    document.body.appendChild(host)
    const app = createApp(FileTree, { vault: '/vault' })
    app.use(pinia)
    app.mount(host)
    mounted.push(app)
    return host
  }

  /** Type `name` into the active inline edit input and press Enter. */
  async function submitInlineEdit(tree: HTMLElement, name: string): Promise<void> {
    const input = tree.querySelector('.tree-inline-input') as HTMLInputElement
    expect(input).not.toBeNull()
    input.value = name
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await flush()
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    await flush()
    await flush()
  }

  function clickMenuLabel(label: string): void {
    const item = [...document.body.querySelectorAll<HTMLButtonElement>('.ctx-menu-item')].find(
      (b) => b.querySelector('.ctx-menu-label')?.textContent === label,
    )
    expect(item, `context menu item ${label}`).toBeDefined()
    item!.click()
  }

  function clickConfirmDelete(tree: HTMLElement): void {
    const btn = [...tree.querySelectorAll<HTMLButtonElement>('.tree-del-confirm button')].find(
      (b) => b.textContent?.trim() === '确认',
    )
    expect(btn).toBeDefined()
    btn!.click()
  }

  it('createDir sends the vault path (root + name) and refreshes the listing', async () => {
    const tree = mountTree()
    await flush()
    // Initial mount listing.
    expect(fsMocks.list.mock.calls.length).toBeGreaterThan(0)

    ;(tree.querySelector('[title="新建文件夹"]') as HTMLButtonElement).click()
    await flush()
    const before = fsMocks.list.mock.calls.length
    await submitInlineEdit(tree, 'notes')

    expect(fsMocks.createDir).toHaveBeenCalledWith('/vault', '/vault/notes')
    // refreshAncestors re-listed the parent after the create.
    expect(fsMocks.list.mock.calls.length).toBeGreaterThan(before)
    // The inline edit row closed on success.
    expect(tree.querySelector('.tree-inline-input')).toBeNull()
  })

  it('createNote writes the file and opens it in a tab', async () => {
    const tabs = useTabsStore()
    tabs.setVault('/vault')
    const tree = mountTree()
    await flush()

    ;(tree.querySelector('[title="新建文件"]') as HTMLButtonElement).click()
    await flush()
    await submitInlineEdit(tree, 'new.md')

    expect(fsMocks.write).toHaveBeenCalledWith('/vault', '/vault/new.md', '')
    expect(tabs.tabs.some((t) => t.path === '/vault/new.md')).toBe(true)
    // The newly created file opened in the editor, so the listing was refreshed.
    expect(fsMocks.list.mock.calls.length).toBeGreaterThan(1)
  })

  it('rename routes through renameEntry and updates the open tab path', async () => {
    const tabs = useTabsStore()
    tabs.setVault('/vault')
    fsMocks.list.mockResolvedValue([
      { name: 'a.md', path: '/vault/a.md', is_dir: false, is_mdx: true },
    ])
    const tree = mountTree()
    await flush()
    await tabs.openTab('/vault/a.md')
    expect(tabs.tabs).toHaveLength(1)

    // Right-click the row -> context menu -> rename. (The first tree row is the
    // vault root, whose menu has no rename item; pick the a.md row instead.)
    const row = [...tree.querySelectorAll<HTMLElement>('.tree-row')].find((r) =>
      r.textContent?.includes('a.md'),
    )!
    expect(row).toBeDefined()
    row.dispatchEvent(
      new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 40 }),
    )
    await flush()
    clickMenuLabel('重命名')
    await flush()

    await submitInlineEdit(tree, 'b.md')
    expect(fsMocks.renameEntry).toHaveBeenCalledWith('/vault', '/vault/a.md', '/vault/b.md')
    expect(tabs.tabs[0].path).toBe('/vault/b.md')
    expect(tree.querySelector('.tree-inline-input')).toBeNull()
  })

  it('delete with an open tab routes through the gateway and closes the tab', async () => {
    const tabs = useTabsStore()
    tabs.setVault('/vault')
    fsMocks.list.mockResolvedValue([
      { name: 'a.md', path: '/vault/a.md', is_dir: false, is_mdx: true },
    ])
    const tree = mountTree()
    await flush()
    await tabs.openTab('/vault/a.md')
    expect(tabs.tabs).toHaveLength(1)

    ;(tree.querySelector('.tree-del') as HTMLButtonElement).click()
    await flush()
    clickConfirmDelete(tree)
    await flush()
    await flush()

    expect(fsMocks.deleteFile).toHaveBeenCalledWith('/vault', '/vault/a.md')
    expect(tabs.tabs).toHaveLength(0)
    expect(tabs.activeId).toBeNull()
    // The parent listing was refreshed after the delete.
    expect(fsMocks.list.mock.calls.length).toBeGreaterThan(1)
  })

  it('deleting a directory closes an open tab under that subtree', async () => {
    const tabs = useTabsStore()
    tabs.setVault('/vault')
    fsMocks.list.mockResolvedValue([
      { name: 'fld', path: '/vault/fld', is_dir: true, is_mdx: false },
    ])
    const tree = mountTree()
    await flush()
    await tabs.openTab('/vault/fld/child.md')
    expect(tabs.tabs).toHaveLength(1)

    ;(tree.querySelector('.tree-del') as HTMLButtonElement).click()
    await flush()
    clickConfirmDelete(tree)
    await flush()

    // No tab exactly on /vault/fld -> the tree's delete path runs directly.
    expect(fsMocks.deleteFile).toHaveBeenCalledWith('/vault', '/vault/fld')
    expect(tabs.tabs).toHaveLength(0)
  })
})
