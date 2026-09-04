import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { registerLifecycleHook, setActiveEditor } from '@nekowite/plugin-host'
import type { PluginContext } from '@nekowite/plugin-host'
import { consumeSuppressReapply, shouldSuppressReapply } from '../services/suppressReapply'
import { onRecovery } from '../services/errors'
import type { RecoveryPrompt } from '../services/errors'
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
vi.mock('../services/fs', () => ({
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

const ctx = { id: 'test', name: 'Test', insertComponent: () => {} } as PluginContext

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

describe('save state indicator', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    resetFsMocks()
  })

  it('reports saving while write is pending, then saved', async () => {
    let resolveWrite: () => void = () => {}
    writeMock.mockImplementation(() => new Promise<void>((r) => { resolveWrite = r }))
    readMock.mockResolvedValue('abc')
    const s = useTabsStore()
    s.setVault('/vault')
    await s.openTab('/vault/a.md')
    const tab = s.tabs[0]
    const pending = s.saveActive()
    expect(s.saveStateOf(tab.id)).toBe('saving')
    resolveWrite()
    await pending
    expect(s.saveStateOf(tab.id)).toBe('saved')
  })

  it('returns dirty after markDirty', async () => {
    readMock.mockResolvedValue('abc')
    const s = useTabsStore()
    s.setVault('/vault')
    await s.openTab('/vault/a.md')
    const tab = s.tabs[0]
    s.markDirty(tab.id)
    expect(s.saveStateOf(tab.id)).toBe('dirty')
  })

  it('falls back to dirty (not stuck saving) when the write fails', async () => {
    writeMock.mockRejectedValueOnce(new Error('disk full'))
    readMock.mockResolvedValue('abc')
    const s = useTabsStore()
    s.setVault('/vault')
    await s.openTab('/vault/a.md')
    const tab = s.tabs[0]
    s.markDirty(tab.id)
    await s.saveActive()
    expect(s.saveStateOf(tab.id)).toBe('dirty')
  })
})

describe('lifecycle broadcast from tabs store', () => {
  const unregister: Array<() => void> = []

  beforeEach(() => {
    setActivePinia(createPinia())
    resetFsMocks()
  })

  afterEach(() => {
    for (const un of unregister.splice(0)) un()
    setActiveEditor(null)
    consumeSuppressReapply()
  })

  it('onSave rewrite changes what is written to disk', async () => {
    unregister.push(registerLifecycleHook('test', 'onSave', () => 'abc!', ctx))
    const s = useTabsStore()
    s.setVault('/vault')
    readMock.mockResolvedValue('abc')
    await s.openTab('/vault/a.md')
    const tab = s.tabs[0]
    await s.saveActive()
    expect(writeMock).toHaveBeenCalledWith('/vault', '/vault/a.md', 'abc!', 10)
    expect(tab.content).toBe('abc!')
    expect(tab.savedContent).toBe('abc!')
  })

  it('onOpenDocument and onCloseTab are fired with the tab payload', async () => {
    const openSpy = vi.fn()
    const closeSpy = vi.fn()
    unregister.push(registerLifecycleHook('test', 'onOpenDocument', openSpy, ctx))
    unregister.push(registerLifecycleHook('test', 'onCloseTab', closeSpy, ctx))
    const s = useTabsStore()
    s.setVault('/vault')
    readMock.mockResolvedValue('# hello')
    await s.openTab('/vault/a.md')
    const tab = s.tabs[0]
    expect(openSpy).toHaveBeenCalledWith(ctx, { id: tab.id, path: tab.path })
    s.closeTab(tab.id)
    expect(closeSpy).toHaveBeenCalledWith(ctx, { id: tab.id, path: tab.path })
  })

  it('onSaved is emitted after a successful write', async () => {
    const savedSpy = vi.fn()
    unregister.push(registerLifecycleHook('test', 'onSaved', savedSpy, ctx))
    const s = useTabsStore()
    s.setVault('/vault')
    readMock.mockResolvedValue('abc')
    await s.openTab('/vault/a.md')
    await s.saveActive()
    expect(writeMock).toHaveBeenCalledWith('/vault', '/vault/a.md', 'abc', 10)
    expect(savedSpy).toHaveBeenCalledWith(ctx, null, 'abc')
  })

  it('onSave and onSaved receive the active editor from setActiveEditor', async () => {
    const editor = { kind: 'test-editor' }
    setActiveEditor(editor)
    const saveSpy = vi.fn()
    const savedSpy = vi.fn()
    unregister.push(registerLifecycleHook('test', 'onSave', saveSpy, ctx))
    unregister.push(registerLifecycleHook('test', 'onSaved', savedSpy, ctx))
    const s = useTabsStore()
    s.setVault('/vault')
    readMock.mockResolvedValue('abc')
    await s.openTab('/vault/a.md')
    await s.saveActive()
    expect(saveSpy).toHaveBeenCalledWith(ctx, editor, 'abc')
    expect(savedSpy).toHaveBeenCalledWith(ctx, editor, 'abc')
  })

  it('rewritten save arms the suppress-reapply guard, consume-once clears it', async () => {
    unregister.push(registerLifecycleHook('test', 'onSave', () => 'abc!', ctx))
    const s = useTabsStore()
    s.setVault('/vault')
    readMock.mockResolvedValue('abc')
    await s.openTab('/vault/a.md')
    await s.saveActive()
    expect(shouldSuppressReapply()).toBe(true)
    expect(consumeSuppressReapply()).toBe(true)
    expect(shouldSuppressReapply()).toBe(false)
  })

  it('does not emit onSaved when the write fails', async () => {
    const savedSpy = vi.fn()
    unregister.push(registerLifecycleHook('test', 'onSaved', savedSpy, ctx))
    writeMock.mockRejectedValueOnce(new Error('disk full'))
    const s = useTabsStore()
    s.setVault('/vault')
    readMock.mockResolvedValue('abc')
    await s.openTab('/vault/a.md')
    await s.saveActive()
    expect(savedSpy).not.toHaveBeenCalled()
  })

  it('keeps content and dirty intact when a rewritten save fails', async () => {
    unregister.push(registerLifecycleHook('test', 'onSave', () => 'abc!', ctx))
    writeMock.mockRejectedValueOnce(new Error('disk full'))
    const s = useTabsStore()
    s.setVault('/vault')
    readMock.mockResolvedValue('abc')
    await s.openTab('/vault/a.md')
    const tab = s.tabs[0]
    tab.dirty = true
    await s.saveActive()
    expect(writeMock).toHaveBeenCalledWith('/vault', '/vault/a.md', 'abc!', 10)
    expect(tab.content).toBe('abc')
    expect(tab.savedContent).toBe('abc')
    expect(tab.dirty).toBe(true)
  })
})

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

describe('restoreHistoryToActive', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    resetFsMocks()
  })

  it('restores a version into the tab and clears dirty', async () => {
    readMock.mockResolvedValue('abc')
    restoreHistoryMock.mockResolvedValue('restored')
    const s = useTabsStore()
    s.setVault('/vault')
    await s.openTab('/vault/a.md')
    const tab = s.tabs[0]
    tab.content = 'dirty'
    s.markDirty(tab.id)
    const result = await s.restoreHistoryToActive(tab.id, 'v1')
    expect(result).toBe('restored')
    expect(restoreHistoryMock).toHaveBeenCalledWith('/vault', '/vault/a.md', 'v1')
    expect(tab.content).toBe('restored')
    expect(tab.savedContent).toBe('restored')
    expect(tab.dirty).toBe(false)
  })
})

describe('checkCrashRecovery', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    resetFsMocks()
  })

  it('returns the newest history entry when it is newer than the file', async () => {
    readMock.mockResolvedValue('abc')
    listHistoryMock.mockResolvedValue([{ id: 'snap-1', size: 3, mtime: 200 }])
    statMock.mockResolvedValue({ size: 3, mtime: 100 })
    // A crash snapshot that genuinely differs from the disk content.
    readHistoryMock.mockResolvedValue('abcd')
    const s = useTabsStore()
    s.setVault('/vault')
    await s.openTab('/vault/a.md')
    const tab = s.tabs[0]
    const entry = await s.checkCrashRecovery(tab.id)
    expect(entry).toEqual({ id: 'snap-1', size: 3, mtime: 200 })
  })

  it('returns null when the newest snapshot matches the disk content', async () => {
    // An interrupted atomic write leaves a newest snapshot that is
    // byte-identical to the file — "recovering" it is a no-op and must not
    // surface a prompt.
    readMock.mockResolvedValue('abc')
    listHistoryMock.mockResolvedValue([{ id: 'snap-1', size: 3, mtime: 200 }])
    statMock.mockResolvedValue({ size: 3, mtime: 100 })
    readHistoryMock.mockResolvedValue('abc')
    const s = useTabsStore()
    s.setVault('/vault')
    await s.openTab('/vault/a.md')
    const tab = s.tabs[0]
    expect(await s.checkCrashRecovery(tab.id)).toBeNull()
  })

  it('returns null when the file is at least as new as the newest history', async () => {
    readMock.mockResolvedValue('abc')
    listHistoryMock.mockResolvedValue([{ id: 'snap-1', size: 3, mtime: 100 }])
    statMock.mockResolvedValue({ size: 3, mtime: 200 })
    const s = useTabsStore()
    s.setVault('/vault')
    await s.openTab('/vault/a.md')
    const tab = s.tabs[0]
    expect(await s.checkCrashRecovery(tab.id)).toBeNull()
  })
})

describe('openTab crash-recovery prompt', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    resetFsMocks()
  })

  it('relocates .tmp assets into the note assets dir and rewrites refs on first save', async () => {
    readMock.mockResolvedValue('')
    saveFileDialogMock.mockResolvedValue('/vault/notes/foo.md')
    createDirMock.mockResolvedValue('notes/foo_assets')
    renameEntryMock.mockResolvedValue('notes/foo_assets/pic.png')
    const s = useTabsStore()
    s.setVault('/vault')
    await s.openTab(null, '![pic](.tmp/pic.png)\n\ntext\n')
    const tab = s.tabs[0]
    tab.pendingAssetPaths = ['.tmp/pic.png']

    await s.saveActive()

    expect(tab.path).toBe('/vault/notes/foo.md')
    expect(createDirMock).toHaveBeenCalledWith('/vault', 'notes/foo_assets')
    expect(renameEntryMock).toHaveBeenCalledWith('/vault', '.tmp/pic.png', 'notes/foo_assets/pic.png')
    expect(tab.content).toContain('![pic](foo_assets/pic.png)')
    expect(tab.content).not.toContain('.tmp/pic.png')
    expect(tab.pendingAssetPaths).toEqual([])
    expect(writeMock).toHaveBeenCalledWith(
      '/vault',
      '/vault/notes/foo.md',
      expect.stringContaining('foo_assets/pic.png'),
      10,
    )
  })

  it('surfaces a recovery prompt and restoring rewrites the tab from history', async () => {
    readMock.mockResolvedValue('abc')
    listHistoryMock.mockResolvedValue([{ id: 'snap-1', size: 3, mtime: 500 }])
    statMock.mockResolvedValue({ size: 3, mtime: 200 })
    readHistoryMock.mockResolvedValue('unsaved snapshot content')
    restoreHistoryMock.mockResolvedValue('recovered')

    const prompts: RecoveryPrompt[] = []
    const offRecovery = onRecovery((p) => prompts.push(p))
    const s = useTabsStore()
    s.setVault('/vault')
    await s.openTab('/vault/a.md')
    await vi.waitFor(() => expect(prompts).toHaveLength(1))
    const prompt = prompts[0]
    expect(prompt.message).toContain('未保存的更改')
    expect(prompt.message).toContain('恢复最近版本')
    prompt.onRestore()
    await vi.waitFor(() => expect(s.tabs[0].content).toBe('recovered'))
    expect(restoreHistoryMock).toHaveBeenCalledWith('/vault', '/vault/a.md', 'snap-1')
    expect(s.tabs[0].dirty).toBe(false)
    offRecovery()
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
    let resolveWrite: () => void = () => {}
    writeMock.mockImplementation(() => new Promise<void>((r) => { resolveWrite = r }))
    readMock.mockResolvedValue('abc')
    const s = useTabsStore()
    s.setVault('/vault')
    await s.openTab('/vault/a.md')
    const tab = s.tabs[0]
    s.markDirty(tab.id)
    const pending = s.saveActive()
    expect(s.saveStateOf(tab.id)).toBe('saving')
    s.noteSelfWrite('/vault/a.md')
    expect(s.isSelfWrite('/vault/a.md')).toBe(true)

    s.closeAll()

    // The closed tab's save must not be reported as stuck "saving".
    expect(s.saveStateOf(tab.id)).toBe('saved')
    expect(s.isSelfWrite('/vault/a.md')).toBe(false)
    expect(s.tabs).toHaveLength(0)
    expect(s.activeId).toBeNull()
    resolveWrite()
    await pending
  })

  it('cancels a pending autosave timer so nothing writes after closeAll', async () => {
    vi.useFakeTimers()
    readMock.mockResolvedValue('abc')
    const s = useTabsStore()
    s.setVault('/vault')
    await s.openTab('/vault/a.md')
    const tab = s.tabs[0]
    tab.content = 'changed'
    s.markDirty(tab.id)
    s.scheduleAutosave(tab.id)
    s.closeAll()
    await vi.advanceTimersByTimeAsync(30000)
    expect(writeMock).not.toHaveBeenCalled()
    vi.useRealTimers()
  })
})

describe('session capture and restore', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    resetFsMocks()
  })

  it('captures the open tabs to localStorage and restores them after closeAll', async () => {
    readMock.mockResolvedValue('content')
    const s = useTabsStore()
    s.setVault('/vault')
    await s.openTab('/vault/a.md')
    await s.openTab('/vault/b.md')
    // openTab captures the already-set-path session on each open; the active
    // tab is referenced by path (ids are regenerated on restore).
    expect(JSON.parse(localStorage.getItem(SESSION_KEY) ?? '{}').activeId).toBe('/vault/b.md')

    s.closeAll()
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

    s.closeAll()
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
