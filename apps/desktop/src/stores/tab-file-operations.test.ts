import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useTabsStore } from './tabs'

const readMock = vi.hoisted(() => vi.fn())
const writeMock = vi.hoisted(() => vi.fn())
const deleteFileMock = vi.hoisted(() => vi.fn())
const statMock = vi.hoisted(() => vi.fn())
const listHistoryMock = vi.hoisted(() => vi.fn())
const restoreHistoryMock = vi.hoisted(() => vi.fn())
const readHistoryMock = vi.hoisted(() => vi.fn())
const createDirMock = vi.hoisted(() => vi.fn())
const renameEntryMock = vi.hoisted(() => vi.fn())
const saveFileDialogMock = vi.hoisted(() => vi.fn())
vi.mock('../platform/gateways/fs', () => ({
  fsService: {
    read: readMock,
    write: writeMock,
    list: vi.fn(),
    watch: vi.fn(),
    deleteFile: deleteFileMock,
    stat: statMock,
    listHistory: listHistoryMock,
    readHistory: readHistoryMock,
    restoreHistory: restoreHistoryMock,
    createDir: createDirMock,
    renameEntry: renameEntryMock,
    saveFileDialog: saveFileDialogMock,
  },
}))

function resetFsMocks(): void {
  readMock.mockReset()
  writeMock.mockReset()
  deleteFileMock.mockReset()
  statMock.mockReset()
  listHistoryMock.mockReset()
  readHistoryMock.mockReset()
  restoreHistoryMock.mockReset()
  createDirMock.mockReset()
  renameEntryMock.mockReset()
  saveFileDialogMock.mockReset()
}

describe('renamePathInTabs', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    resetFsMocks()
  })

  it('rewrites the exact path of a tab and keeps its content', async () => {
    readMock.mockResolvedValue('# hello')
    const s = useTabsStore()
    s.setVault('/vault')
    await s.openTab('/vault/a.md')
    const tab = s.tabs[0]
    tab.content = '# edited'
    s.markDirty(tab.id)
    s.renamePathInTabs('/vault/a.md', '/vault/b.md')
    expect(tab.path).toBe('/vault/b.md')
    expect(tab.content).toBe('# edited')
    expect(tab.dirty).toBe(true)
  })

  it('rewrites nested paths under a renamed directory prefix', async () => {
    readMock.mockResolvedValue('x')
    const s = useTabsStore()
    s.setVault('/vault')
    await s.openTab('/vault/dir/note.md')
    await s.openTab('/vault/dir/sub/deep.md')
    await s.openTab('/vault/other.md')
    const [note, deep, other] = s.tabs
    s.renamePathInTabs('/vault/dir', '/vault/dir2')
    expect(note.path).toBe('/vault/dir2/note.md')
    expect(deep.path).toBe('/vault/dir2/sub/deep.md')
    expect(other.path).toBe('/vault/other.md')
  })

  it('leaves untitled tabs untouched', async () => {
    readMock.mockResolvedValue('x')
    const s = useTabsStore()
    s.setVault('/vault')
    await s.openTab(null)
    const tab = s.tabs[0]
    s.renamePathInTabs('/vault/a.md', '/vault/b.md')
    expect(tab.path).toBeNull()
  })
})

describe('deleteTabFile', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    resetFsMocks()
  })

  it('deletes the file through the gateway and closes its tab', async () => {
    deleteFileMock.mockResolvedValue('trash/name')
    readMock.mockResolvedValue('abc')
    const s = useTabsStore()
    s.setVault('/vault')
    await s.openTab('/vault/a.md')
    const tab = s.tabs[0]
    await s.deleteTabFile(tab.id)
    expect(deleteFileMock).toHaveBeenCalledWith('/vault', '/vault/a.md')
    expect(s.tabs).toHaveLength(0)
    expect(s.activeId).toBeNull()
  })
})

describe('deleteTabFile (FileTree delete route)', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    resetFsMocks()
    readMock.mockResolvedValue('# hello')
    deleteFileMock.mockResolvedValue('trash-key')
    listHistoryMock.mockResolvedValue([])
    statMock.mockResolvedValue({ size: 1, mtime: 1 })
  })

  it('trashes the file through the gateway and closes every tab on that path', async () => {
    const s = useTabsStore()
    s.setVault('/vault')
    await s.openTab('/vault/a.md')
    expect(s.tabs).toHaveLength(1)

    await s.deleteTabFile(s.tabs[0].id)

    expect(deleteFileMock).toHaveBeenCalledWith('/vault', '/vault/a.md')
    expect(s.tabs).toHaveLength(0)
    expect(s.activeId).toBeNull()
  })

  it('is a no-op for a tab without a path or when no vault is set', async () => {
    const s = useTabsStore()
    await s.deleteTabFile('missing')
    expect(deleteFileMock).not.toHaveBeenCalled()

    // An untitled tab (no path) is never trashed through this route.
    await s.openTab(null)
    await s.deleteTabFile(s.tabs[0].id)
    expect(deleteFileMock).not.toHaveBeenCalled()
    expect(s.tabs).toHaveLength(1)
  })
})

describe('detachMissingPath keeps unsaved work protected', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    resetFsMocks()
  })

  it('leaves a detached tab holding text dirty, so no protection skips it', async () => {
    // The tab detached because its file vanished outside the app. Its content now
    // exists nowhere on disk, so `dirty` has to stay true: `hasUnsavedWork`,
    // `flushDirty`, `untitledDirtyTabs` and `closeTab` all key off it, and a
    // detached tab marked clean would be dropped without a prompt by every one of
    // them.
    readMock.mockResolvedValue('text that was never written')
    const s = useTabsStore()
    s.setVault('/vault')
    await s.openTab('/vault/a.md')
    s.markDirty(s.activeId!)

    expect(s.detachMissingPath(s.activeId!)).toBe('/vault/a.md')

    expect(s.tabs[0].path).toBeNull()
    expect(s.tabs[0].content).toBe('text that was never written')
    expect(s.tabs[0].dirty).toBe(true)
    expect(s.hasUnsavedWork()).toBe(true)
    expect(s.untitledDirtyTabs().map((t) => t.id)).toEqual([s.tabs[0].id])
  })

  it('keeps the text reachable through closeTab, which must ask where to put it', async () => {
    readMock.mockResolvedValue('only copy')
    saveFileDialogMock.mockResolvedValue(null) // user cancels the Save-As dialog
    const s = useTabsStore()
    s.setVault('/vault')
    await s.openTab('/vault/a.md')
    s.markDirty(s.activeId!)
    s.detachMissingPath(s.activeId!)

    await s.closeTab(s.tabs[0].id)

    // Cancelling means "do not close": dropping the tab here is how the text
    // would disappear, and it never reached disk.
    expect(writeMock).not.toHaveBeenCalled()
    expect(s.tabs).toHaveLength(1)
  })

  it('leaves a detached empty tab clean so nothing prompts over a blank note', async () => {
    readMock.mockResolvedValue('')
    const s = useTabsStore()
    s.setVault('/vault')
    await s.openTab('/vault/a.md')

    s.detachMissingPath(s.activeId!)

    expect(s.tabs[0].dirty).toBe(false)
    expect(s.hasUnsavedWork()).toBe(false)
  })
})

describe('reloadFromDisk', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    resetFsMocks()
  })

  it.each([false, true])('keeps the latest reload when older bytes arrive last (explicit=%s)', async (explicit) => {
    readMock.mockResolvedValueOnce('current text')
    const s = useTabsStore()
    s.setVault('/vault')
    await s.openTab('/vault/a.md')
    let release!: (text: string) => void
    readMock.mockImplementationOnce(() => new Promise<string>((resolve) => { release = resolve }))
    const old = s.reloadFromDisk(s.activeId!, { explicit })
    readMock.mockResolvedValueOnce('current text')
    await s.reloadFromDisk(s.activeId!, { explicit })
    release('obsolete disk snapshot')
    await old
    expect(s.tabs[0].content).toBe('current text')
    expect(s.tabs[0].savedContent).toBe('current text')
  })

  it.each([false, true])('ignores a read from before an in-app rename (explicit=%s)', async (explicit) => {
    readMock.mockResolvedValueOnce('current text')
    const s = useTabsStore()
    s.setVault('/vault')
    await s.openTab('/vault/a.md')
    let release!: (text: string) => void
    readMock.mockImplementationOnce(() => new Promise<string>((resolve) => { release = resolve }))
    const pending = s.reloadFromDisk(s.activeId!, { explicit })
    s.renamePathInTabs('/vault/a.md', '/vault/b.md')
    release('stale bytes from old path')
    await pending
    expect(s.tabs[0].path).toBe('/vault/b.md')
    expect(s.tabs[0].content).toBe('current text')
    expect(s.tabs[0].savedContent).toBe('current text')
  })

  it('does not apply a reload while its file is being moved', async () => {
    readMock.mockResolvedValueOnce('current text')
    const s = useTabsStore()
    s.setVault('/vault')
    await s.openTab('/vault/a.md')
    let release!: (text: string) => void
    readMock.mockImplementationOnce(() => new Promise<string>((resolve) => { release = resolve }))
    const pending = s.reloadFromDisk(s.activeId!)
    s.beginMove('/vault/a.md')
    release('stale bytes from old path')
    await pending
    expect(s.tabs[0].content).toBe('current text')
    s.endMove('/vault/a.md')
  })

  it('does not throw away keystrokes typed while an external reload is reading', async () => {
    readMock.mockResolvedValueOnce('start')
    const s = useTabsStore()
    s.setVault('/vault')
    await s.openTab('/vault/a.md')
    // The read is started by hand so the sequence is explicit: the tab must NOT
    // be dirty when it begins (that is the situation the reload is for — a clean
    // tab whose file changed externally), and the typing happens mid-read.
    let releaseRead: (text: string) => void = () => {}
    let started: () => void = () => {}
    const reading = new Promise<void>((resolve) => {
      started = resolve
    })
    readMock.mockImplementationOnce(async () => {
      started()
      return await new Promise<string>((resolve) => {
        releaseRead = resolve
      })
    })
    const reloading = s.reloadFromDisk(s.activeId!)
    await reading
    s.tabs[0].content = 'typed while the disk was being read'
    s.markDirty(s.activeId!)
    releaseRead('disk text from another program')
    await reloading

    expect(s.tabs[0].content).toBe('typed while the disk was being read')
    expect(s.tabs[0].dirty).toBe(true)
  })
})
