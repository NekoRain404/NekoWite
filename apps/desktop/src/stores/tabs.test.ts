import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { registerLifecycleHook, setActiveEditor } from '@nekowite/plugin-host'
import type { PluginContext } from '@nekowite/plugin-host'
import { consumeSuppressReapply, shouldSuppressReapply } from '../services/suppressReapply'
import { onNotify, onRecovery } from '../services/errors'
import type { RecoveryPrompt } from '../services/errors'
import { useTabsStore } from './tabs'
import { useSettingsStore } from './settings'
import { SESSION_KEY } from '../services/session'
import { setSourceViewHandle } from '../services/sourceView'

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
    // The dirty flag flips synchronously, before any await.
    expect(s.saveStateOf(tab.id)).toBe('saving')
    // The write is dispatched after the editor flush, so release it only once
    // the call has actually been made.
    await vi.waitFor(() => expect(writeMock).toHaveBeenCalled())
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

describe('hasUnsavedWork and flushDirty', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    resetFsMocks()
  })

  it('hasUnsavedWork is false when every tab is clean', async () => {
    readMock.mockResolvedValue('abc')
    const s = useTabsStore()
    s.setVault('/vault')
    await s.openTab('/vault/a.md')
    expect(s.hasUnsavedWork()).toBe(false)
  })

  it('hasUnsavedWork is true when any tab is dirty', async () => {
    readMock.mockResolvedValue('abc')
    const s = useTabsStore()
    s.setVault('/vault')
    await s.openTab('/vault/a.md')
    const tab = s.tabs[0]
    tab.content = 'edited'
    s.markDirty(tab.id)
    expect(s.hasUnsavedWork()).toBe(true)
  })

  it('flushDirty saves every path&#39;d dirty tab and clears dirty', async () => {
    writeMock.mockResolvedValue(undefined)
    readMock.mockResolvedValue('abc')
    const s = useTabsStore()
    s.setVault('/vault')
    await s.openTab('/vault/a.md')
    await s.openTab('/vault/b.md')
    const [a, b] = s.tabs
    a.content = 'changed a'
    a.dirty = true
    b.content = 'changed b'
    b.dirty = true

    const ok = await s.flushDirty()
    expect(ok).toBe(true)
    expect(writeMock).toHaveBeenCalledWith('/vault', '/vault/a.md', 'changed a', 10)
    expect(writeMock).toHaveBeenCalledWith('/vault', '/vault/b.md', 'changed b', 10)
    expect(a.dirty).toBe(false)
    expect(b.dirty).toBe(false)
  })

  it('flushDirty skips untitled tabs (no save-as dialog in a bulk flush)', async () => {
    writeMock.mockResolvedValue(undefined)
    const s = useTabsStore()
    s.setVault('/vault')
    await s.openTab(null, 'untitled body')
    const t = s.tabs[0]
    t.dirty = true
    const ok = await s.flushDirty()
    expect(ok).toBe(true)
    expect(writeMock).not.toHaveBeenCalled()
    // The untitled tab stays dirty; the beforeunload prompt (hasUnsavedWork)
    // still guards it on close.
    expect(t.dirty).toBe(true)
  })

  it('flushDirty returns false when a save fails so the caller can block a lossy action', async () => {
    writeMock.mockRejectedValueOnce(new Error('disk full'))
    readMock.mockResolvedValue('abc')
    const s = useTabsStore()
    s.setVault('/vault')
    await s.openTab('/vault/a.md')
    s.tabs[0].dirty = true
    const ok = await s.flushDirty()
    expect(ok).toBe(false)
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

describe('saveTab flushes the source pane first', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    resetFsMocks()
  })

  afterEach(() => {
    setSourceViewHandle(null)
  })

  it('persists edits still inside the source pane debounce window', async () => {
    readMock.mockResolvedValue('start')
    const s = useTabsStore()
    s.setVault('/vault')
    await s.openTab('/vault/a.md')
    s.markDirty(s.activeId!)

    // The source pane coalesces keystrokes: the tab still holds the old text
    // while the editor already has the new text. Saving must publish the
    // pending edit first, or the last keystrokes are lost on disk.
    setSourceViewHandle({
      getView: () => null,
      flush: () => {
        s.tabs[0].content = 'start plus the pending keystrokes'
      },
    })
    s.tabs[0].content = 'start'

    await s.saveTab(s.activeId!)

    expect(writeMock).toHaveBeenCalledWith(
      '/vault',
      '/vault/a.md',
      'start plus the pending keystrokes',
      expect.anything(),
    )
  })

  it('survives a source pane whose flush throws', async () => {
    readMock.mockResolvedValue('start')
    const s = useTabsStore()
    s.setVault('/vault')
    await s.openTab('/vault/a.md')
    s.markDirty(s.activeId!)
    setSourceViewHandle({
      getView: () => null,
      flush: () => {
        throw new Error('host torn down')
      },
    })

    await expect(s.saveTab(s.activeId!)).resolves.toBe(true)
    expect(writeMock).toHaveBeenCalled()
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
