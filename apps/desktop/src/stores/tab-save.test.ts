import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { registerLifecycleHook, setActiveEditor } from '@nekowite/plugin-host'
import type { PluginContext } from '@nekowite/plugin-host'
import { consumeSuppressReapply, pruneSuppressReapply, shouldSuppressReapply } from '../services/suppress-reapply'
import { useTabsStore } from './tabs'
import { setSourceViewHandle } from '../services/source-view'

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

  it('reports a failed write as failed, not as merely unsaved', async () => {
    writeMock.mockRejectedValueOnce(new Error('disk full'))
    readMock.mockResolvedValue('abc')
    const s = useTabsStore()
    s.setVault('/vault')
    await s.openTab('/vault/a.md')
    const tab = s.tabs[0]
    s.markDirty(tab.id)
    await s.saveActive()
    // Not `saving` (the write came down), and not `dirty` either: `dirty` is the
    // state of a tab nothing has tried to save yet. This one was offered to the
    // disk and did not get there, and after the toast that said so has gone the
    // status line is the only thing left that can tell the two apart.
    expect(s.saveStateOf(tab.id)).toBe('failed')
    // The text is still the user's, whatever the state is called.
    expect(tab.dirty).toBe(true)
  })

  it('reports the retry as saving, then the landed write as saved', async () => {
    // The failure is not sticky: a state that outlived the attempt replacing it
    // would say "the save failed" over a save that is being made — or over one
    // that has landed.
    writeMock.mockRejectedValueOnce(new Error('disk full'))
    readMock.mockResolvedValue('abc')
    const s = useTabsStore()
    s.setVault('/vault')
    await s.openTab('/vault/a.md')
    const tab = s.tabs[0]
    s.markDirty(tab.id)
    await s.saveActive()
    expect(s.saveStateOf(tab.id)).toBe('failed')

    let resolveWrite: () => void = () => {}
    writeMock.mockImplementation(() => new Promise<void>((r) => { resolveWrite = r }))
    const pending = s.saveActive()
    expect(s.saveStateOf(tab.id)).toBe('saving')
    await vi.waitFor(() => expect(writeMock).toHaveBeenCalledTimes(2))
    resolveWrite()
    await pending
    expect(s.saveStateOf(tab.id)).toBe('saved')
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
    pruneSuppressReapply(null)
  })

  it('onSave rewrite changes what is written to disk', async () => {
    unregister.push(registerLifecycleHook('test', 'onSave', () => 'abc!', ctx))
    const s = useTabsStore()
    s.setVault('/vault')
    readMock.mockResolvedValue('abc')
    await s.openTab('/vault/a.md')
    const tab = s.tabs[0]
    await s.saveActive()
    expect(writeMock).toHaveBeenCalledWith('/vault', '/vault/a.md', 'abc!', 10, 'abc')
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
    expect(writeMock).toHaveBeenCalledWith('/vault', '/vault/a.md', 'abc', 10, 'abc')
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
    const tab = s.tabs[0]
    expect(shouldSuppressReapply(tab.id)).toBe(true)
    expect(consumeSuppressReapply(tab.id)).toBe(true)
    expect(shouldSuppressReapply(tab.id)).toBe(false)
  })

  // C1: a background save (autosave timer / flushDirty / closing a tab) used to
  // arm a module-wide flag that only the ACTIVE tab's next content change could
  // consume, so it swallowed the switch-to-another-tab content change instead:
  // the editor kept the previous note's text for the new note, and the next
  // keystroke published that text into the new tab and autosaved it over the new
  // note's file.
  it('keeps the arm on the saved tab so a background save cannot swallow the active tab', async () => {
    unregister.push(registerLifecycleHook('test', 'onSave', (_c, _e, content) => `${content}!`, ctx))
    const s = useTabsStore()
    s.setVault('/vault')
    readMock.mockResolvedValue('aaa')
    await s.openTab('/vault/a.md')
    const tabA = s.tabs[0]
    readMock.mockResolvedValue('bbb')
    await s.openTab('/vault/b.md')
    const tabB = s.tabs[1]
    expect(s.activeId).toBe(tabB.id)

    // A save reads the file before it writes (L05's save-time half), so the
    // fixture has to keep the vault per path: one answer for every path would
    // hand A's save B's bytes and call that an external edit.
    readMock.mockImplementation(async (_vault: string, path: string) =>
      path === '/vault/a.md' ? 'aaa' : 'bbb',
    )
    // The background tab A is saved (its autosave timer fired, or a vault switch
    // flushed it) and the onSave plugin rewrote its text.
    await s.saveTab(tabA.id)
    expect(tabA.content).toBe('aaa!')
    expect(shouldSuppressReapply(tabA.id)).toBe(true)
    // B is the tab the user is looking at: its content change must still re-apply
    // or the editor would keep showing A's text under B's tab.
    expect(shouldSuppressReapply(tabB.id)).toBe(false)
    expect(consumeSuppressReapply(tabB.id)).toBe(false)
  })

  it('drops an arm left behind by a tab the user switched away from', async () => {
    unregister.push(registerLifecycleHook('test', 'onSave', (_c, _e, content) => `${content}!`, ctx))
    const s = useTabsStore()
    s.setVault('/vault')
    readMock.mockResolvedValue('aaa')
    await s.openTab('/vault/a.md')
    const tabA = s.tabs[0]
    await s.saveActive()
    expect(shouldSuppressReapply(tabA.id)).toBe(true)
    readMock.mockResolvedValue('bbb')
    await s.openTab('/vault/b.md')
    // Only the active tab's content watcher runs, so an arm left on A could never
    // be consumed — it would just wait to swallow B's next content change.
    expect(consumeSuppressReapply(tabA.id)).toBe(false)
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
    expect(writeMock).toHaveBeenCalledWith('/vault', '/vault/a.md', 'abc!', 10, 'abc')
    expect(tab.content).toBe('abc')
    expect(tab.savedContent).toBe('abc')
    expect(tab.dirty).toBe(true)
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
      'start',
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

describe('saveTab relocates staged .tmp assets', () => {
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
})

describe('overlapping saves and vault switches', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    resetFsMocks()
  })

  afterEach(() => {
    setSourceViewHandle(null)
  })

  it('writes once when the same tab is saved twice in a row', async () => {
    // Ctrl+S twice (or autosave firing during a manual save) must be one write,
    // not two: the second would add a history snapshot of an identical edit, and
    // whichever finished LAST used to win the tab state — so a save that started
    // earlier and finished later left savedContent pointing at older text while
    // the tab showed "saved".
    readMock.mockResolvedValue('start')
    const s = useTabsStore()
    s.setVault('/vault')
    await s.openTab('/vault/a.md')
    s.markDirty(s.activeId!)
    let release: () => void = () => {}
    writeMock.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          release = resolve
        }),
    )

    const first = s.saveTab(s.activeId!)
    const second = s.saveTab(s.activeId!)
    await vi.waitFor(() => expect(writeMock).toHaveBeenCalledTimes(1))
    release()
    await expect(first).resolves.toBe(true)
    await expect(second).resolves.toBe(true)

    expect(writeMock).toHaveBeenCalledTimes(1)
    expect(s.tabs[0].dirty).toBe(false)
    expect(s.tabs[0].savedContent).toBe('start')
  })

  it('writes again when the user typed while the first save was in flight', async () => {
    readMock.mockResolvedValue('start')
    const s = useTabsStore()
    s.setVault('/vault')
    await s.openTab('/vault/a.md')
    s.markDirty(s.activeId!)
    let releaseFirst: () => void = () => {}
    writeMock.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          releaseFirst = resolve
        }),
    )
    writeMock.mockResolvedValue(undefined)

    const first = s.saveTab(s.activeId!)
    await vi.waitFor(() => expect(writeMock).toHaveBeenCalledTimes(1))
    s.tabs[0].content = 'typed during the save'
    s.markDirty(s.activeId!)
    const second = s.saveTab(s.activeId!)
    releaseFirst()
    await first
    await second

    expect(writeMock).toHaveBeenCalledTimes(2)
    expect(writeMock.mock.calls[1][2]).toBe('typed during the save')
    expect(s.tabs[0].dirty).toBe(false)
    expect(s.tabs[0].savedContent).toBe('typed during the save')
  })

  it('never writes the old vault content into the new vault', async () => {
    // A save is several awaits long. Switching vaults mid-save used to land the
    // old vault's note at the new vault's root: the user would find a note they
    // never created, containing another vault's text.
    readMock.mockResolvedValue('old vault text')
    const s = useTabsStore()
    s.setVault('/v1')
    await s.openTab('/v1/notes/a.md')
    s.markDirty(s.activeId!)
    let releaseFlush: () => void = () => {}
    setSourceViewHandle({
      getView: () => null,
      flush: () =>
        new Promise<void>((resolve) => {
          releaseFlush = resolve
        }),
    })
    writeMock.mockResolvedValue(undefined)

    const saving = s.saveTab(s.activeId!)
    await vi.waitFor(() => expect(releaseFlush).toBeDefined())
    // The switch: the same order applyVault uses.
    s.removeAllTabs()
    s.setVault('/v2')
    releaseFlush()

    await expect(saving).resolves.toBe(false)
    expect(writeMock).not.toHaveBeenCalled()
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
    expect(writeMock).toHaveBeenCalledWith('/vault', '/vault/a.md', 'changed a', 10, 'abc')
    expect(writeMock).toHaveBeenCalledWith('/vault', '/vault/b.md', 'changed b', 10, 'abc')
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
