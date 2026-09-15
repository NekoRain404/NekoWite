/**
 * A window close must not go ahead over text its flush did not carry.
 *
 * `onCloseRequested` prevents the native close, `flushDirty()`s the dirty tabs
 * and only then calls `win.close()` — so the flush's `true` is the permission to
 * end the process. That `true` used to mean "one write per dirty tab landed",
 * not "the tabs are clean": a keystroke during the write leaves the tab dirty
 * while the write carries the older text, and the window closed over it. The
 * `preventDefault()` above exists precisely so this flush can run, which is why
 * the race is reachable at all — the editor stays interactive for its whole
 * length.
 *
 * The store is the REAL one here; only the window, the appearance store and the
 * notification channels are mocked. The keystroke is delivered through the
 * rendered pane's real persistence layer (the harness of
 * `tab-save-unsaved-keystroke.test.ts`).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { setRenderedFlush } from '../services/editor-ownership'
import { setSourceViewHandle } from '../services/source-view'
import { documentKey } from '../features/editor/model/document-session'

const h = vi.hoisted(() => {
  const windowMock = { onCloseRequested: vi.fn(), close: vi.fn(), destroy: vi.fn() }
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
  }
  return {
    windowMock,
    fs,
    appearanceMock: { autosaveOnBlur: false, touchSystem: vi.fn() },
    windowTracking: { restore: vi.fn(), start: vi.fn(), flush: vi.fn(), dispose: vi.fn() },
    requestUntitledVaultSwitch: vi.fn(),
    notifyError: vi.fn(),
    notifyRecovery: vi.fn(),
  }
})

vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => h.windowMock,
  CloseRequestedEvent: class {},
}))

vi.mock('../platform/gateways/fs', () => ({ fsService: h.fs }))

vi.mock('../stores/appearance', () => ({ useAppearanceStore: () => h.appearanceMock }))

vi.mock('./recovery-closed-loop', () => ({
  requestUntitledVaultSwitch: h.requestUntitledVaultSwitch,
}))

vi.mock('../services/errors', () => ({
  notifyError: h.notifyError,
  notifyRecovery: h.notifyRecovery,
}))

vi.mock('../i18n', () => ({ t: (key: string): string => key }))

import { createAppLifecycle } from './app-lifecycle'
import { useTabsStore } from '../stores/tabs'
import { READ_ONLY_PREFIX } from '../stores/write-refusal'

const RO = '/vault/ro.md'
const COPY = '/vault/ro (copy).md'

/** The refusal the backend returns for a protected file, token and all. */
function readOnlyRefusal(path: string): Error {
  return new Error(`${READ_ONLY_PREFIX}could not replace ${path}: the file is read-only`)
}

/** The fs as the backend behaves for a protected note: the note's own file
 *  refuses every write, a copy under another name takes it, and the FIRST
 *  accepted write is held open — the interleaving is controllable rather than
 *  timed. */
function protectedNote(protectedPath: string) {
  const accepted: Array<{ path: string; content: string }> = []
  let parked: Array<(fail: boolean) => void> = []
  let holdNext = true
  h.fs.write.mockImplementation((_v: string, path: string, content: string) => {
    if (path === protectedPath) return Promise.reject(readOnlyRefusal(path))
    accepted.push({ path, content })
    if (!holdNext) return Promise.resolve(null)
    holdNext = false
    return new Promise<string | null>((resolve, reject) =>
      parked.push((fail) => (fail ? reject(new Error('disk full')) : resolve(null))),
    )
  })
  return {
    accepted,
    get started() {
      return accepted.length > 0
    },
    release: () => {
      holdNext = false
      const waiting = parked
      parked = []
      waiting.forEach((go) => go(false))
    },
  }
}

type CloseHandler = (e: { preventDefault: () => void }) => Promise<void>

function registeredCloseHandler(): CloseHandler {
  const calls = h.windowMock.onCloseRequested.mock.calls
  expect(calls.length).toBeGreaterThan(0)
  return calls[calls.length - 1][0] as CloseHandler
}

/** One `type()` is one keystroke: it changes the document and fires its change
 *  handlers synchronously, as a doc-changing ProseMirror transaction does. */
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

describe('a window close whose flush is overtaken by a keystroke', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.resetAllMocks()
    // mount() only registers the native close-requested listener under a Tauri
    // runtime; expose the flag so the close path is exercised.
    ;(window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {}
    h.windowMock.onCloseRequested.mockResolvedValue(() => {})
    h.windowMock.close.mockResolvedValue(undefined)
    h.windowMock.destroy.mockResolvedValue(undefined)
    h.fs.read.mockResolvedValue('v1')
    h.fs.write.mockResolvedValue(null)
    h.requestUntitledVaultSwitch.mockResolvedValue('save')
    // The close path's rescue question: by default the user says no, so a test
    // that is not about the rescue never has to answer it.
    h.notifyRecovery.mockImplementation((p: { onDismiss: () => void }) => p.onDismiss())
    setSourceViewHandle(null)
    localStorage.clear()
  })

  afterEach(() => {
    vi.useRealTimers()
    setRenderedFlush(null)
    delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__
  })

  it('writes the newer text before the window is closed', async () => {
    const tabs = useTabsStore()
    tabs.setVault('/vault')
    await tabs.openTab('/vault/a.md')
    const tab = tabs.tabs[0]
    const editor = fakeEditor('v1')
    await attachPane(editor, 'v1', '/vault', tab.id)

    const write = parkedWrite()
    // The disk a save reads before it writes (`tab-write-preconditions.ts`):
    // frozen at the original text, the second write would look like somebody
    // else's edit and be refused — a different mechanism than the race here.
    h.fs.read.mockImplementation(async () => write.written[write.written.length - 1] ?? 'v1')
    tabs.markDirty(tab.id)
    vi.useFakeTimers()

    // `win.close()` ends the process, so whether anything was still dirty when
    // it was issued is the whole question.
    const closedWhileDirty: boolean[] = []
    h.windowMock.close.mockImplementation(() => {
      closedWhileDirty.push(tabs.tabs.some((t) => t.dirty))
      return Promise.resolve()
    })

    const lifecycle = createAppLifecycle({ windowTracking: h.windowTracking })
    await lifecycle.mount()

    const preventDefault = vi.fn()
    const closing = registeredCloseHandler()({ preventDefault })
    await vi.waitFor(() => expect(write.started).toBe(true))

    // The user types while the close's own flush is writing. The doc change fires
    // synchronously; the publish is 120 ms behind.
    editor.type(' NEW TEXT')
    expect(editor.doc).toBe('v1 NEW TEXT')
    expect(tab.dirty).toBe(true)
    expect(tab.content).toBe('v1')

    vi.advanceTimersByTime(50)
    write.release()
    write.landFromNowOn()
    await closing

    expect(preventDefault).toHaveBeenCalled()
    expect(write.written).toEqual(['v1', 'v1 NEW TEXT'])
    expect(closedWhileDirty).toEqual([false])
    expect(h.notifyError).not.toHaveBeenCalled()
  })

  it('keeps the window open when a tab cannot be settled', async () => {
    const tabs = useTabsStore()
    tabs.setVault('/vault')
    await tabs.openTab('/vault/a.md')
    const tab = tabs.tabs[0]
    const editor = fakeEditor('v1')
    await attachPane(editor, 'v1', '/vault', tab.id)

    // A keystroke during every write: each one lands, and each is out of date by
    // the time it does. Nothing can be settled, so the X must not be honoured.
    const written: string[] = []
    h.fs.write.mockImplementation((_v: string, _p: string, content: string) => {
      written.push(content)
      editor.type('!')
      return Promise.resolve(null)
    })
    h.fs.read.mockImplementation(async () => written[written.length - 1] ?? 'v1')
    tabs.markDirty(tab.id)
    vi.useFakeTimers()

    const lifecycle = createAppLifecycle({ windowTracking: h.windowTracking })
    await lifecycle.mount()

    const preventDefault = vi.fn()
    await registeredCloseHandler()({ preventDefault })

    expect(preventDefault).toHaveBeenCalled()
    expect(h.windowMock.close).not.toHaveBeenCalled()
    expect(h.notifyError).toHaveBeenCalledWith('tabs.unsavedWorkBlockerClose')
    // The text is still in the tab the user can see, and still known unsaved:
    // the tab holds what the last landed write carried, and the keystroke that
    // write missed is still in the editor in front of them.
    expect(tabs.tabs).toHaveLength(1)
    expect(tabs.tabs[0].content).toBe(written[written.length - 1])
    expect(editor.doc).toBe(`${tabs.tabs[0].content}!`)
    expect(tabs.tabs[0].dirty).toBe(true)
    expect(written).toHaveLength(3)
  })

  it('carries a keystroke typed during the rescue copy, before the window closes', async () => {
    const tabs = useTabsStore()
    tabs.setVault('/vault')
    await tabs.openTab(RO)
    const tab = tabs.tabs[0]
    const editor = fakeEditor('v1')
    await attachPane(editor, 'v1', '/vault', tab.id)

    // The file refuses every write, so `flushDirty()` can never settle this tab
    // and the close has to take the copy route the user is offered.
    const write = protectedNote(RO)
    h.fs.read.mockImplementation(
      async () => write.accepted[write.accepted.length - 1]?.content ?? 'v1',
    )
    h.fs.saveFileDialog.mockResolvedValue(COPY)
    h.notifyRecovery.mockImplementation((p: { onRestore: () => void }) => p.onRestore())
    tabs.markDirty(tab.id)
    vi.useFakeTimers()

    const closedWhileDirty: boolean[] = []
    h.windowMock.close.mockImplementation(() => {
      closedWhileDirty.push(tabs.tabs.some((t) => t.dirty))
      return Promise.resolve()
    })

    const lifecycle = createAppLifecycle({ windowTracking: h.windowTracking })
    await lifecycle.mount()

    const preventDefault = vi.fn()
    const closing = registeredCloseHandler()({ preventDefault })
    await vi.waitFor(() => expect(write.started).toBe(true))

    // The keystroke lands while the COPY is being written. The copy carries the
    // text as it was when the write started; the tab keeps the newer text and
    // stays dirty, so the close that follows is the only thing that can still
    // lose it.
    editor.type(' NEW TEXT')
    await vi.advanceTimersByTimeAsync(150)
    expect(tab.dirty).toBe(true)
    expect(tab.content).toBe('v1 NEW TEXT')

    write.release()
    await closing

    expect(preventDefault).toHaveBeenCalled()
    expect(closedWhileDirty).toEqual([false])
    // The copy, and then the newer text under the copy's own name: the close
    // cancelled the autosave timer the keystroke armed, so this route is the
    // only one that could have carried it.
    expect(write.accepted.map((w) => w.content)).toEqual(['v1', 'v1 NEW TEXT'])
    expect(write.accepted.map((w) => w.path)).toEqual([COPY, COPY])
  })

  it('takes the copy route in ONE write when nobody types during it', async () => {
    const tabs = useTabsStore()
    tabs.setVault('/vault')
    await tabs.openTab(RO)
    const tab = tabs.tabs[0]
    tabs.markDirty(tab.id)
    vi.useFakeTimers()

    const write = protectedNote(RO)
    write.release()
    h.fs.read.mockResolvedValue('v1')
    h.fs.saveFileDialog.mockResolvedValue(COPY)
    h.notifyRecovery.mockImplementation((p: { onRestore: () => void }) => p.onRestore())

    const lifecycle = createAppLifecycle({ windowTracking: h.windowTracking })
    await lifecycle.mount()

    await registeredCloseHandler()({ preventDefault: vi.fn() })

    // A settled tab needs no second (or third) write of the same bytes — one
    // history snapshot per attempt is what a settle loop that always retries
    // would cost every ordinary close.
    expect(write.accepted.map((w) => w.content)).toEqual(['v1'])
    expect(h.windowMock.close).toHaveBeenCalled()
  })

  it('writes an untitled tab\'s newer text before closing over it', async () => {
    const tabs = useTabsStore()
    tabs.setVault('/vault')
    await tabs.openTab(null, 'untitled body')
    const tab = tabs.tabs[0]
    const editor = fakeEditor('untitled body')
    await attachPane(editor, 'untitled body', '/vault', tab.id)

    const write = parkedWrite()
    // The disk a save reads before it writes, as the landed write leaves it.
    h.fs.read.mockImplementation(
      async () => write.written[write.written.length - 1] ?? 'untitled body',
    )
    h.fs.saveFileDialog.mockResolvedValue('/vault/picked.md')
    h.requestUntitledVaultSwitch.mockResolvedValue('save')
    tabs.markDirty(tab.id)
    vi.useFakeTimers()

    const closedWhileDirty: boolean[] = []
    h.windowMock.close.mockImplementation(() => {
      closedWhileDirty.push(tabs.tabs.some((t) => t.dirty))
      return Promise.resolve()
    })

    const lifecycle = createAppLifecycle({ windowTracking: h.windowTracking })
    await lifecycle.mount()

    const preventDefault = vi.fn()
    const closing = registeredCloseHandler()({ preventDefault })
    await vi.waitFor(() => expect(write.started).toBe(true))

    // Typed while the picked file is being written: the tab has a path by now,
    // so the newer text needs no second dialog — only a second write.
    editor.type(' MORE')
    await vi.advanceTimersByTimeAsync(150)
    expect(tab.dirty).toBe(true)
    expect(tab.content).toBe('untitled body MORE')

    write.release()
    write.landFromNowOn()
    await closing

    expect(preventDefault).toHaveBeenCalled()
    expect(closedWhileDirty).toEqual([false])
    expect(write.written).toEqual(['untitled body', 'untitled body MORE'])
  })

  it('settles an untitled tab nobody typed into in ONE write', async () => {
    const tabs = useTabsStore()
    tabs.setVault('/vault')
    await tabs.openTab(null, 'untitled body')
    const tab = tabs.tabs[0]

    const write = parkedWrite()
    write.release()
    write.landFromNowOn()
    h.fs.saveFileDialog.mockResolvedValue('/vault/picked.md')
    h.requestUntitledVaultSwitch.mockResolvedValue('save')
    tabs.markDirty(tab.id)
    vi.useFakeTimers()

    const lifecycle = createAppLifecycle({ windowTracking: h.windowTracking })
    await lifecycle.mount()

    await registeredCloseHandler()({ preventDefault: vi.fn() })

    // The gate the close now asks retries on `dirty`, not on principle: a tab
    // that was clean when the write landed is settled, and asking again would
    // write the same bytes a second and third time.
    expect(write.written).toEqual(['untitled body'])
    expect(h.windowMock.close).toHaveBeenCalled()
  })

  it('keeps the window open when an untitled tab\'s save fails', async () => {
    const tabs = useTabsStore()
    tabs.setVault('/vault')
    await tabs.openTab(null, 'untitled body')
    const tab = tabs.tabs[0]

    h.fs.write.mockRejectedValue(new Error('disk full'))
    h.fs.saveFileDialog.mockResolvedValue('/vault/picked.md')
    h.requestUntitledVaultSwitch.mockResolvedValue('save')
    tabs.markDirty(tab.id)
    vi.useFakeTimers()

    const lifecycle = createAppLifecycle({ windowTracking: h.windowTracking })
    await lifecycle.mount()

    await registeredCloseHandler()({ preventDefault: vi.fn() })

    expect(h.windowMock.close).not.toHaveBeenCalled()
    expect(h.notifyError).toHaveBeenCalledWith('tabs.unsavedWorkBlockerClose')
    expect(tab.dirty).toBe(true)
  })
})
