import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { onNotify, onRecovery } from '../services/errors'
import type { RecoveryPrompt } from '../services/errors'
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

describe('useTabsStore', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    resetFsMocks()
  })

  it('opens a tab and marks dirty on edit', async () => {
    readMock.mockResolvedValue('# hello')
    const s = useTabsStore()
    s.setVault('/vault')
    await s.openTab('/vault/a.md')
    expect(s.tabs.length).toBe(1)
    expect(s.activeId).toBe(s.tabs[0].id)
    expect(readMock).toHaveBeenCalledWith('/vault', '/vault/a.md')
    s.tabs[0].content = '# changed'
    s.markDirty(s.tabs[0].id)
    expect(s.tabs[0].dirty).toBe(true)
  })

  it('does not read without a vault set', async () => {
    const s = useTabsStore()
    await s.openTab('/vault/a.md')
    expect(readMock).not.toHaveBeenCalled()
    expect(s.tabs.length).toBe(0)
  })
})

describe('closeOthers', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    resetFsMocks()
  })

  it('closes every tab except the given one, flushing dirty content first', async () => {
    writeMock.mockResolvedValue(undefined)
    readMock.mockResolvedValue('abc')
    const s = useTabsStore()
    s.setVault('/vault')
    await s.openTab('/vault/a.md')
    await s.openTab('/vault/b.md')
    await s.openTab('/vault/c.md')
    const keep = s.tabs[1]
    s.tabs[0].dirty = true
    await s.closeOthers(keep.id)
    expect(s.tabs).toHaveLength(1)
    expect(s.tabs[0].id).toBe(keep.id)
    expect(s.activeId).toBe(keep.id)
    expect(writeMock).toHaveBeenCalledWith('/vault', '/vault/a.md', 'abc', 10)
  })
})

describe('openTab duplicate guard', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    resetFsMocks()
  })

  it('opens a single tab when the same path is requested while the first read is pending', async () => {
    let resolveRead: (content: string) => void = () => {}
    readMock.mockImplementation(() => new Promise<string>((r) => { resolveRead = r }))
    const s = useTabsStore()
    s.setVault('/vault')
    const first = s.openTab('/vault/a.md')
    // The placeholder push is synchronous, so the duplicate request finds it
    // and focuses it rather than spawning a second tab once the read resolves.
    const second = s.openTab('/vault/a.md')
    expect(s.tabs).toHaveLength(1)
    expect(s.activeId).toBe(s.tabs[0].id)
    resolveRead('# loaded')
    await first
    await second
    expect(s.tabs).toHaveLength(1)
    expect(s.tabs[0].path).toBe('/vault/a.md')
    expect(s.tabs[0].content).toBe('# loaded')
    expect(readMock).toHaveBeenCalledTimes(1)
  })

  it('removes the placeholder tab when the read fails', async () => {
    readMock.mockRejectedValue(new Error('io'))
    const s = useTabsStore()
    s.setVault('/vault')
    await s.openTab('/vault/a.md')
    expect(s.tabs).toHaveLength(0)
    expect(s.activeId).toBeNull()
  })
})

describe('closeAll cleanup', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    resetFsMocks()
  })

  it('clears the saving flag and self-write windows for closed tabs', async () => {
    readMock.mockResolvedValue('abc')
    const s = useTabsStore()
    s.setVault('/vault')
    await s.openTab('/vault/a.md')
    const tab = s.tabs[0]
    // The two remnants removeTab alone cannot clear: a save that reported
    // "saving" and the self-write window of the file being written. Neither may
    // outlive the tab, or a later open/switch inherits them.
    s.markSaving(tab.id)
    s.noteSelfWrite('/vault/a.md')
    expect(s.saveStateOf(tab.id)).toBe('saving')
    expect(s.isSelfWrite('/vault/a.md')).toBe(true)

    await s.closeAll()

    expect(s.saveStateOf(tab.id)).toBe('saved')
    expect(s.isSelfWrite('/vault/a.md')).toBe(false)
    expect(s.tabs).toHaveLength(0)
    expect(s.activeId).toBeNull()
  })

  it('claims a path for an app-initiated move until the move ends', async () => {
    // The external-change service asks this question while the watcher reports a
    // rename: a tab whose file is momentarily absent because WE are moving it
    // must not be read as "deleted behind the user's back". The claim covers the
    // notes inside a folder being moved, too (a folder rename carries them).
    const s = useTabsStore()
    s.setVault('/vault')

    expect(s.isPendingMove('/vault/docs/note.md')).toBe(false)

    s.beginMove('/vault/docs')
    expect(s.isPendingMove('/vault/docs')).toBe(true)
    expect(s.isPendingMove('/vault/docs/note.md')).toBe(true)
    expect(s.isPendingMove('/vault/other/note.md')).toBe(false)
    // A sibling whose name merely starts with the same characters is NOT inside.
    expect(s.isPendingMove('/vault/docs-archive/note.md')).toBe(false)

    s.endMove('/vault/docs')
    expect(s.isPendingMove('/vault/docs/note.md')).toBe(false)
  })

  it('accepts Windows separators in a claimed path', async () => {
    // The claim comes from the file tree, which passes native paths, while the
    // tabs hold whatever spelling the vault used.
    const s = useTabsStore()
    s.setVault('C:\\vault')
    s.beginMove('C:\\vault\\docs')
    expect(s.isPendingMove('C:\\vault\\docs\\note.md')).toBe(true)
    s.endMove('C:\\vault\\docs')
  })

  it('cancels the pending autosave timer, leaving the close-time flush as the only write', async () => {
    vi.useFakeTimers()
    readMock.mockResolvedValue('abc')
    const s = useTabsStore()
    s.setVault('/vault')
    await s.openTab('/vault/a.md')
    const tab = s.tabs[0]
    tab.content = 'changed'
    s.markDirty(tab.id)
    s.scheduleAutosave(tab.id)

    await s.closeAll()

    // Exactly one write — the flush that closing does on purpose. The timer armed
    // before the close must not fire a second one afterwards.
    expect(writeMock).toHaveBeenCalledTimes(1)
    expect(writeMock).toHaveBeenCalledWith('/vault', '/vault/a.md', 'changed', expect.anything())
    await vi.advanceTimersByTimeAsync(30000)
    expect(writeMock).toHaveBeenCalledTimes(1)
    vi.useRealTimers()
  })
})

describe('closeAll never silently discards unsaved work', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    resetFsMocks()
  })

  it('flushes dirty tabs with a path instead of dropping them', async () => {
    readMock.mockResolvedValue('on disk')
    writeMock.mockResolvedValue(undefined)
    const s = useTabsStore()
    s.setVault('/vault')
    await s.openTab('/vault/a.md')
    s.tabs[0].content = 'edited but never saved'
    s.markDirty(s.tabs[0].id)

    await expect(s.closeAll()).resolves.toBe(true)

    expect(writeMock).toHaveBeenCalledWith('/vault', '/vault/a.md', 'edited but never saved', expect.anything())
    expect(s.tabs).toHaveLength(0)
  })

  it('aborts the close when a flush fails, keeping the tab', async () => {
    readMock.mockResolvedValue('on disk')
    writeMock.mockRejectedValue(new Error('disk full'))
    const s = useTabsStore()
    s.setVault('/vault')
    await s.openTab('/vault/a.md')
    s.tabs[0].content = 'precious'
    s.markDirty(s.tabs[0].id)
    const seen: string[] = []
    const off = onRecovery((p) => seen.push(p.message))
    onNotify((m) => seen.push(m))

    await expect(s.closeAll()).resolves.toBe(false)

    expect(s.tabs).toHaveLength(1)
    expect(s.tabs[0].content).toBe('precious')
    expect(seen.length).toBeGreaterThan(0)
    off()
  })

  it('asks about untitled dirty documents and saves them when the user says so', async () => {
    saveFileDialogMock.mockResolvedValue('/vault/picked.md')
    writeMock.mockResolvedValue(undefined)
    const s = useTabsStore()
    s.setVault('/vault')
    await s.openTab(null, 'never named')
    s.markDirty(s.activeId!)
    let prompt: RecoveryPrompt | null = null
    const off = onRecovery((p) => { prompt = p })
    expect(s.untitledDirtyTabs()).toHaveLength(1)

    const closing = s.closeAll()
    await Promise.resolve()
    expect(prompt).not.toBeNull()
    prompt!.onRestore()
    await expect(closing).resolves.toBe(true)

    expect(writeMock).toHaveBeenCalledWith('/vault', '/vault/picked.md', 'never named', expect.anything())
    expect(s.tabs).toHaveLength(0)
    off()
  })

  it('discards untitled documents only after the user explicitly chooses to', async () => {
    const s = useTabsStore()
    s.setVault('/vault')
    await s.openTab(null, 'throwaway')
    s.markDirty(s.activeId!)
    let prompt: RecoveryPrompt | null = null
    const off = onRecovery((p) => { prompt = p })

    const closing = s.closeAll()
    await Promise.resolve()
    prompt!.onDismiss()
    await expect(closing).resolves.toBe(true)

    expect(s.tabs).toHaveLength(0)
    off()
  })
})
