/**
 * A vault switch must not destroy a tab set that still holds text its flush did
 * not carry.
 *
 * `applyVault` flushes the dirty tabs, then commits the new vault and calls
 * `tabs.removeAllTabs()` — the point of no return for every open tab. It used to
 * read `flushDirty()`'s answer as "everything is on disk", and that answer only
 * ever meant "one write per dirty tab landed": a keystroke arriving during the
 * write leaves the tab dirty while the write carries the older text, so the
 * switch removed the only copy of the keystroke.
 *
 * The store is the REAL one here — only the gateways are mocked — so the race is
 * the store's own. The keystroke is delivered through the rendered pane's real
 * persistence layer (the harness of `tab-save-unsaved-keystroke.test.ts`), and
 * `attachPane` registers the flush hook a save reaches for before it writes.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { setRenderedFlush } from '../services/editor-ownership'
import { setSourceViewHandle } from '../services/source-view'
import { documentKey } from '../features/editor/model/document-session'

const h = vi.hoisted(() => {
  const fs = {
    read: vi.fn(),
    write: vi.fn(),
    list: vi.fn(async () => []),
    watch: vi.fn(async () => () => {}),
    deleteFile: vi.fn(async () => ''),
    stat: vi.fn(async () => ({ size: 0, mtime: 0 })),
    listHistory: vi.fn(async () => []),
    readHistory: vi.fn(async () => ''),
    restoreHistory: vi.fn(async () => ''),
    createDir: vi.fn(async () => ''),
    renameEntry: vi.fn(async () => ''),
    saveFileDialog: vi.fn(async (): Promise<string | null> => null),
    registerVault: vi.fn(async () => undefined),
    onFsChange: vi.fn(async () => () => {}),
  }
  return {
    fs,
    gateways: {
      fs,
      dialogs: { openFolderDialog: vi.fn(async () => null), saveFileDialog: fs.saveFileDialog },
      events: { on: vi.fn(), emit: vi.fn() },
      ai: { complete: vi.fn(), cancel: vi.fn(), listModels: vi.fn() },
      keys: { storeAiKey: vi.fn(), loadAiKey: vi.fn() },
    },
    settingsMock: { maxHistory: 10, autosaveInterval: 'off' as const, loadKey: vi.fn(async () => undefined) },
    vaultSessionMock: {
      indexVault: vi.fn(async () => undefined),
      detachVault: vi.fn(),
      cancelSearchIndexBuild: vi.fn(),
    },
    refsMock: { loadVault: vi.fn(async () => undefined), clear: vi.fn() },
    loadVaultPlugins: vi.fn(async () => undefined),
    deactivateVaultPlugins: vi.fn(),
    vaultFileIndex: {
      get: vi.fn(async () => []),
      isTruncated: vi.fn(() => false),
      isIncomplete: vi.fn(() => false),
    },
    tmpRecovery: { scan: vi.fn(async () => undefined), gc: vi.fn(async () => undefined), cancel: vi.fn() },
    createTmpRecovery: vi.fn(),
    windowTracking: { restore: vi.fn(), start: vi.fn(), flush: vi.fn(), dispose: vi.fn() },
    requestUntitledVaultSwitch: vi.fn(async () => 'save' as const),
    notifyError: vi.fn(),
    notifyRecovery: vi.fn(),
  }
})

vi.mock('../platform/gateways/fs', () => ({ fsService: h.fs }))

vi.mock('../platform/runtime/gateway-runtime', () => ({
  getSharedGateways: () => h.gateways,
  initSharedGateways: vi.fn(),
  resetSharedGateways: vi.fn(),
}))

vi.mock('./window-state', () => ({ setupWindowTracking: () => h.windowTracking }))

vi.mock('./recovery-closed-loop', () => ({
  createTmpRecovery: h.createTmpRecovery,
  requestUntitledVaultSwitch: h.requestUntitledVaultSwitch,
}))

vi.mock('../services/vault-files', () => ({ vaultFileIndex: h.vaultFileIndex }))

vi.mock('../services/plugins', () => ({
  loadVaultPlugins: h.loadVaultPlugins,
  deactivateVaultPlugins: h.deactivateVaultPlugins,
}))

vi.mock('../services/editor-bridge', () => ({
  editorBridge: { setEditor: vi.fn(), getEditor: vi.fn(), getView: vi.fn(), onEditorChange: vi.fn() },
}))

vi.mock('../features/editor/session-manager', () => ({
  editorSessionManager: { destroyAll: vi.fn(), destroySession: vi.fn() },
}))

vi.mock('../stores/settings', () => ({ useSettingsStore: () => h.settingsMock }))
vi.mock('../stores/vault-session', () => ({ useVaultSessionStore: () => h.vaultSessionMock }))
vi.mock('../stores/refs', () => ({ useRefsStore: () => h.refsMock }))

vi.mock('../services/errors', () => ({
  notifyError: h.notifyError,
  notifyRecovery: h.notifyRecovery,
}))

vi.mock('../i18n', () => ({ t: (key: string): string => key }))

import { createDesktopRuntime } from './app-bootstrap'
import { useTabsStore } from '../stores/tabs'

/** The editor, as far as the persistence layer is concerned: one `type()` is one
 *  keystroke — it changes the document and fires its change handlers
 *  synchronously, which is what a doc-changing ProseMirror transaction does. */
function fakeEditor(initial: string) {
  const handlers = new Set<() => void>()
  let doc = initial
  return {
    get doc() {
      return doc
    },
    type(text: string) {
      doc += text
      handlers.forEach((x) => x())
    },
    async save() {
      return doc
    },
    onContentChange(cb: () => void) {
      handlers.add(cb)
      return () => handlers.delete(cb)
    },
  }
}

/** The writes the save path asked for, in order, with the ability to hold one
 *  open — the interleaving is controllable rather than timed. */
function parkedWrite() {
  const written: string[] = []
  let parked: Array<(fail: boolean) => void> = []
  h.fs.write.mockImplementation((_v: string, _p: string, content: string) => {
    written.push(content)
    return new Promise<string | null>((resolve, reject) =>
      parked.push((fail) => (fail ? reject(new Error('disk full')) : resolve(null))),
    )
  })
  return {
    written,
    get started() {
      return written.length > 0
    },
    release: (fail = false) => {
      const waiting = parked
      parked = []
      waiting.forEach((go) => go(fail))
    },
    landFromNowOn: () => {
      h.fs.write.mockImplementation((_v: string, _p: string, content: string) => {
        written.push(content)
        return Promise.resolve(null)
      })
    },
  }
}

/** The rendered pane's persistence layer for `editor`, publishing into the open
 *  tab through the real 120 ms debounce — and registered as the pane's flush
 *  hook, which is what a save reaches for before it writes. */
async function attachPane(
  editor: ReturnType<typeof fakeEditor>,
  content: string,
  vault: string,
  tabId: string,
) {
  const { createEditorPersistence } = await import(
    '../features/editor/controller/editor-persistence'
  )
  const persistence = createEditorPersistence({
    session: {
      editor: editor as never,
      gen: 0,
      appliedContent: content,
      appliedKey: documentKey(vault, tabId),
      lastLocalMarkdown: content,
      lastDoc: content,
      docChangeTimer: null,
      applyingExternal: false,
      pendingExternal: null,
      parseFailed: false,
      calloutViewSet: true,
    },
  })
  persistence.attachChangeListener()
  setRenderedFlush(() => persistence.flush())
  return persistence
}

describe('a vault switch whose flush is overtaken by a keystroke', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.resetAllMocks()
    h.fs.read.mockResolvedValue('v1')
    h.fs.write.mockResolvedValue(null)
    h.fs.registerVault.mockResolvedValue(undefined)
    h.fs.watch.mockResolvedValue(() => {})
    h.fs.onFsChange.mockResolvedValue(() => {})
    h.createTmpRecovery.mockReturnValue(h.tmpRecovery)
    h.settingsMock.loadKey.mockResolvedValue(undefined)
    h.vaultSessionMock.indexVault.mockResolvedValue(undefined)
    h.vaultSessionMock.detachVault.mockImplementation(() => {})
    h.vaultSessionMock.cancelSearchIndexBuild.mockImplementation(() => {})
    h.refsMock.loadVault.mockResolvedValue(undefined)
    h.refsMock.clear.mockImplementation(() => {})
    h.loadVaultPlugins.mockResolvedValue(undefined)
    h.deactivateVaultPlugins.mockImplementation(() => {})
    h.requestUntitledVaultSwitch.mockResolvedValue('save')
    h.notifyRecovery.mockImplementation((p: { onDismiss: () => void }) => p.onDismiss())
    setSourceViewHandle(null)
    localStorage.clear()
  })

  afterEach(() => {
    vi.useRealTimers()
    setRenderedFlush(null)
  })

  it('puts the newer text on disk before removing the tab set', async () => {
    const tabs = useTabsStore()
    const runtime = createDesktopRuntime()
    tabs.setVault('/vaultA')
    await tabs.openTab('/vaultA/a.md')
    const tab = tabs.tabs[0]
    const editor = fakeEditor('v1')
    await attachPane(editor, 'v1', '/vaultA', tab.id)

    const write = parkedWrite()
    // The disk a save reads before it writes (`tab-write-preconditions.ts`):
    // frozen at the original text, the second write would look like somebody
    // else's edit and be refused — a different mechanism than the race here.
    h.fs.read.mockImplementation(async () => write.written[write.written.length - 1] ?? 'v1')
    tabs.markDirty(tab.id)
    vi.useFakeTimers()

    // What the switch is about to destroy: `removeAllTabs()` is the point of no
    // return for every open tab, so whether anything was still dirty at that
    // moment is the whole question.
    const dirtyAtRemoval: number[] = []
    const removeAllTabs = tabs.removeAllTabs
    vi.spyOn(tabs, 'removeAllTabs').mockImplementation(() => {
      dirtyAtRemoval.push(tabs.tabs.filter((t) => t.dirty).length)
      removeAllTabs()
    })

    const switching = runtime.applyVault('/vaultB')
    await vi.waitFor(() => expect(write.started).toBe(true))

    // The user types while the switch's own flush is writing. The doc change
    // fires synchronously (as ProseMirror's does); the publish is 120 ms behind.
    editor.type(' NEW TEXT')
    expect(editor.doc).toBe('v1 NEW TEXT')
    expect(tab.dirty).toBe(true)
    expect(tab.content).toBe('v1')

    vi.advanceTimersByTime(50)
    write.release()
    write.landFromNowOn()
    await switching

    // The claim: the typing reached the disk, so the switch that dropped the tab
    // set did not drop it with it.
    expect(write.written).toEqual(['v1', 'v1 NEW TEXT'])
    expect(dirtyAtRemoval).toEqual([0])
    expect(runtime.vaultPath.value).toBe('/vaultB')
  })

  it('blocks the switch when a tab cannot be settled', async () => {
    const tabs = useTabsStore()
    const runtime = createDesktopRuntime()
    tabs.setVault('/vaultA')
    await tabs.openTab('/vaultA/a.md')
    const tab = tabs.tabs[0]
    const editor = fakeEditor('v1')
    await attachPane(editor, 'v1', '/vaultA', tab.id)

    // A keystroke during every write: each one lands, and each is out of date by
    // the time it does. There is no answer that saves this tab, so the switch has
    // to be the one that gives way.
    const written: string[] = []
    h.fs.write.mockImplementation((_v: string, _p: string, content: string) => {
      written.push(content)
      editor.type('!')
      return Promise.resolve(null)
    })
    h.fs.read.mockImplementation(async () => written[written.length - 1] ?? 'v1')
    tabs.markDirty(tab.id)
    vi.useFakeTimers()

    await runtime.applyVault('/vaultB')

    expect(runtime.vaultPath.value).toBeNull()
    expect(tabs.tabs).toHaveLength(1)
    expect(tabs.tabs[0].dirty).toBe(true)
    expect(tabs.vault).toBe('/vaultA')
    expect(h.notifyError).toHaveBeenCalledWith('tabs.unsavedWorkBlocker')
    expect(written).toHaveLength(3)
  })

  it('writes an untitled tab\'s newer text before the switch drops the tab set', async () => {
    const tabs = useTabsStore()
    const runtime = createDesktopRuntime()
    tabs.setVault('/vaultA')
    await tabs.openTab(null, 'untitled body')
    const tab = tabs.tabs[0]
    const editor = fakeEditor('untitled body')
    await attachPane(editor, 'untitled body', '/vaultA', tab.id)

    // An untitled tab never reaches `flushDirty` (it would need a Save-As dialog
    // a bulk flush must not open), so it is saved by the prompt's own loop.
    const write = parkedWrite()
    h.fs.read.mockImplementation(
      async () => write.written[write.written.length - 1] ?? 'untitled body',
    )
    h.fs.saveFileDialog.mockResolvedValue('/vaultA/picked.md')
    h.requestUntitledVaultSwitch.mockResolvedValue('save')
    tabs.markDirty(tab.id)
    vi.useFakeTimers()

    const dirtyAtRemoval: number[] = []
    const removeAllTabs = tabs.removeAllTabs
    vi.spyOn(tabs, 'removeAllTabs').mockImplementation(() => {
      dirtyAtRemoval.push(tabs.tabs.filter((t) => t.dirty).length)
      removeAllTabs()
    })

    const switching = runtime.applyVault('/vaultB')
    await vi.waitFor(() => expect(write.started).toBe(true))

    // Typed while the picked file is being written: the tab has a path by now,
    // so the newer text needs no second dialog — only a second write.
    editor.type(' MORE')
    await vi.advanceTimersByTimeAsync(150)
    expect(tab.dirty).toBe(true)
    expect(tab.content).toBe('untitled body MORE')

    write.release()
    write.landFromNowOn()
    await switching

    expect(dirtyAtRemoval).toEqual([0])
    expect(write.written).toEqual(['untitled body', 'untitled body MORE'])
    expect(runtime.vaultPath.value).toBe('/vaultB')
  })
})
