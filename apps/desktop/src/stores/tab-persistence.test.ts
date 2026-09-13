import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useTabsStore } from './tabs'
import { useSettingsStore } from './settings'
import { SESSION_KEY } from '../services/session'

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

describe('autosave debounce', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    resetFsMocks()
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('writes once after the interval, not before it', async () => {
    readMock.mockResolvedValue('abc')
    const s = useTabsStore()
    s.setVault('/vault')
    await s.openTab('/vault/a.md')
    const tab = s.tabs[0]
    tab.content = 'changed'
    s.markDirty(tab.id)
    s.scheduleAutosave(tab.id)
    await vi.advanceTimersByTimeAsync(14000)
    expect(writeMock).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(2000)
    expect(writeMock).toHaveBeenCalledTimes(1)
    expect(writeMock).toHaveBeenCalledWith('/vault', '/vault/a.md', 'changed', 10)
  })

  it('collapses repeated schedules within the interval to one write', async () => {
    readMock.mockResolvedValue('abc')
    const s = useTabsStore()
    s.setVault('/vault')
    await s.openTab('/vault/a.md')
    const tab = s.tabs[0]
    tab.content = 'changed'
    s.markDirty(tab.id)
    s.scheduleAutosave(tab.id)
    await vi.advanceTimersByTimeAsync(5000)
    s.scheduleAutosave(tab.id)
    await vi.advanceTimersByTimeAsync(5000)
    s.scheduleAutosave(tab.id)
    await vi.advanceTimersByTimeAsync(20000)
    expect(writeMock).toHaveBeenCalledTimes(1)
  })

  it('skips scheduling when autosaveInterval is off', async () => {
    const settings = useSettingsStore()
    settings.autosaveInterval = 'off'
    readMock.mockResolvedValue('abc')
    const s = useTabsStore()
    s.setVault('/vault')
    await s.openTab('/vault/a.md')
    const tab = s.tabs[0]
    tab.content = 'changed'
    s.markDirty(tab.id)
    s.scheduleAutosave(tab.id)
    await vi.advanceTimersByTimeAsync(70000)
    expect(writeMock).not.toHaveBeenCalled()
  })

  it('cancelAutosave prevents a pending write', async () => {
    readMock.mockResolvedValue('abc')
    const s = useTabsStore()
    s.setVault('/vault')
    await s.openTab('/vault/a.md')
    const tab = s.tabs[0]
    tab.content = 'changed'
    s.markDirty(tab.id)
    s.scheduleAutosave(tab.id)
    s.cancelAutosave(tab.id)
    await vi.advanceTimersByTimeAsync(20000)
    expect(writeMock).not.toHaveBeenCalled()
  })

  it('never autosaves a clean tab (dirty guard lives in the timer path)', async () => {
    readMock.mockResolvedValue('abc')
    const s = useTabsStore()
    s.setVault('/vault')
    await s.openTab('/vault/a.md')
    const tab = s.tabs[0]
    s.scheduleAutosave(tab.id)
    await vi.advanceTimersByTimeAsync(20000)
    expect(writeMock).not.toHaveBeenCalled()
  })
})

describe('session capture and restore', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    resetFsMocks()
  })

  it('captures the open tabs to localStorage and restores them after they are removed', async () => {
    readMock.mockResolvedValue('content')
    const s = useTabsStore()
    s.setVault('/vault')
    await s.openTab('/vault/a.md')
    await s.openTab('/vault/b.md')
    // openTab captures the already-set-path session on each open; the active
    // tab is referenced by path (ids are regenerated on restore).
    expect(JSON.parse(localStorage.getItem(SESSION_KEY) ?? '{}').activeId).toBe('/vault/b.md')

    // The reset this test needs, not a user-facing close: no flush, no prompt.
    s.removeAllTabs()
    expect(s.tabs).toHaveLength(0)

    await s.restoreSession()
    expect(s.tabs.map((t) => t.path)).toEqual(['/vault/a.md', '/vault/b.md'])
    expect(s.activeTab?.path).toBe('/vault/b.md')
    expect(s.tabs[0].content).toBe('content')
  })

  it('does nothing when the session vault does not match the current vault', async () => {
    readMock.mockResolvedValue('content')
    const s = useTabsStore()
    s.setVault('/vault')
    await s.openTab('/vault/a.md')

    await s.closeAll()
    s.setVault('/other')
    await s.restoreSession()
    expect(s.tabs).toHaveLength(0)
  })

  it('restoring does not duplicate a tab that is already open', async () => {
    readMock.mockResolvedValue('content')
    const s = useTabsStore()
    s.setVault('/vault')
    await s.openTab('/vault/a.md')
    await s.openTab('/vault/b.md')

    await s.restoreSession()
    expect(s.tabs).toHaveLength(2)
    expect(readMock).toHaveBeenCalledTimes(2)
  })
})

describe('untitledDirtyTabs and referencedTmpPaths', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    resetFsMocks()
  })

  it('untitledDirtyTabs returns only no-path dirty tabs', async () => {
    readMock.mockResolvedValue('abc')
    const s = useTabsStore()
    s.setVault('/vault')
    await s.openTab('/vault/a.md')
    await s.openTab(null, 'untitled')
    const [pathd, untitled] = s.tabs
    expect(s.untitledDirtyTabs()).toEqual([])

    pathd.dirty = true
    untitled.dirty = true
    expect(s.untitledDirtyTabs()).toEqual([untitled])
  })

  it('referencedTmpPaths unions pending staged assets and .tmp refs in the body', async () => {
    readMock.mockResolvedValue('abc')
    const s = useTabsStore()
    s.setVault('/vault')
    await s.openTab(null, '![pic](.tmp/paste-1.png)\n\n![pic](.tmp/paste-2.png)')
    const tab = s.tabs[0]
    tab.pendingAssetPaths = ['.tmp/staged.png']

    const refs = s.referencedTmpPaths()
    expect(refs.has('.tmp/paste-1.png')).toBe(true)
    expect(refs.has('.tmp/paste-2.png')).toBe(true)
    expect(refs.has('.tmp/staged.png')).toBe(true)
    expect(refs.has('.tmp/unrelated.png')).toBe(false)
  })
})
