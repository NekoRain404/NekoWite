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
    saveFileDialog: vi.fn(async () => null),
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
})
