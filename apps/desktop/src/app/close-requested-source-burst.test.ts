/**
 * A burst in the source pane is the whole of the session's unsaved work, and
 * the window close answered "nothing to save" about it.
 *
 * `onCloseRequested` asks `hasUnsavedWork()` BEFORE anything has flushed, and
 * returns early when it answers false — capture session/geometry, allow the
 * native close. That answer is about `dirty`, which the source pane sets at the
 * PUBLISH: it coalesces a burst for `SOURCE_SNAPSHOT_DEBOUNCE_MS`
 * (`services/code-mirror-host.ts`), so for the length of the burst every tab
 * reads clean while the pane holds what the user typed. The process then ends
 * over text no disk has. `flushDirty()` — taught by 136 to flush before its own
 * gate — is never reached: this read is in FRONT of it. The same read is what
 * `onBeforeUnload` uses to decide whether the browser-Demo confirm is raised, so
 * neither route asked about the burst.
 *
 * Both routes now flush the SOURCE pane before asking. The pane that matters is
 * the source one: the rendered pane marks its tab dirty at the keystroke
 * (`features/editor/controller/editor-persistence.ts`), so a tab it holds text
 * in is already dirty here and the save that follows flushes it before its own
 * write. The flush is not inside `hasUnsavedWork()` — that is a query, and a
 * predicate that publishes a pane is the coupling §10.3 keeps out of the store —
 * and it is not an await: `flushSourceEdits()` is synchronous, which is what
 * lets the `beforeunload` route, which cannot await anything, have it at all.
 *
 * The store here is the REAL one and so is the pane: the real
 * `code-mirror-host`, with the product's own 50 ms debounce, mounted and
 * registered the way `SourcePane.vue` does it, `emitChange` reproduced line for
 * line. The clock is stopped, so the burst is provably still inside the window
 * rather than a race this won. "Disk" is a Map the fs mock reads and writes, so
 * the assertion is about the bytes a file would hold afterwards.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { markSourceAuthored } from '../services/editor-ownership'
import { setSourceViewHandle } from '../services/source-view'
import { createCodeMirrorHost, type CodeMirrorHostHandle } from '../services/code-mirror-host'
import { sourceExtensions } from '../services/cm-source-view'

const h = vi.hoisted(() => {
  const disk = new Map<string, string>()
  const written: string[] = []
  // The signatures are stated rather than inferred: these answer per test, and
  // an inferred mock only ever answers the value it was built with.
  const read = vi.fn<(_vault: string, _path: string) => Promise<string>>()
  const write = vi.fn<
    (
      _vault: string,
      _path: string,
      _content: string,
      _maxHistory?: number,
    ) => Promise<string | null>
  >()
  const fs = {
    read,
    write,
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
    disk,
    written,
    fs,
    read,
    write,
    windowMock: { onCloseRequested: vi.fn(), close: vi.fn(), destroy: vi.fn() },
    appearanceMock: { autosaveOnBlur: false, touchSystem: vi.fn() },
    windowTracking: { restore: vi.fn(), start: vi.fn(), flush: vi.fn(), dispose: vi.fn() },
    // Stated against the real type: an inferred `'save'` would narrow the mock
    // to that one literal, which only a typecheck sees.
    requestUntitledVaultSwitch: vi.fn(async (): Promise<'save' | 'discard'> => 'save'),
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

const VAULT = '/vault'
const NOTE = '/vault/a.md'
const ORIGINAL = 'original\n'

type Tabs = ReturnType<typeof useTabsStore>

/**
 * The source pane, as the store sees it: the real CodeMirror host, the handle
 * registration from `SourcePane.vue`'s `onMounted` (including the `setText` that
 * mirrors the live tab into the pane), and its `emitChange` — the one function
 * that decides when a keystroke becomes the tab's text and a `dirty` flag.
 */
function mountSourcePane(tabs: Tabs) {
  let host: CodeMirrorHostHandle | null = null
  let mirroredTabId: string | null = null
  const parent = document.createElement('div')
  document.body.appendChild(parent)

  function emitChange(text: string): void {
    const tab = mirroredTabId ? tabs.tabs.find((t) => t.id === mirroredTabId) : null
    if (!tab) return
    markSourceAuthored(text)
    tab.content = text
    tabs.markDirty(tab.id)
    tabs.scheduleAutosave(tab.id)
  }

  host = createCodeMirrorHost({ doc: '', extensions: sourceExtensions(), onChange: emitChange })
  host.mount(parent)
  mountedPanes.push(host)
  mirroredTabId = tabs.activeId
  const mounted = host
  mounted.setText(tabs.activeTab?.content ?? '')
  setSourceViewHandle({
    getView: () => mounted.getView() ?? null,
    flush: () => {
      mounted.flush()
    },
  })
  return {
    /** One keystroke burst, typed into the pane and nowhere else. */
    type(text: string): void {
      const view = mounted.getView()
      if (!view) throw new Error('the source pane did not mount')
      view.dispatch({ changes: { from: view.state.doc.length, insert: text } })
    },
    /** True while the burst is still inside the host's debounce window. */
    hasPendingEdit: (): boolean => mounted.hasPendingEdit(),
  }
}

const mountedPanes: Array<{ destroy(): void }> = []

/** Every lifecycle this file mounted, so none of them outlives its test. A
 *  `beforeunload` listener left registered by an earlier test answers THIS
 *  test's dispatch too — from the tab set of a store nobody is looking at — and
 *  the prompt assertion below is exactly the kind that reads as a defect. */
const mountedLifecycles: Array<{ unmount(): void }> = []

/** Mount the app lifecycle, tracked for teardown. */
async function mountLifecycle(): Promise<void> {
  const lifecycle = createAppLifecycle({ windowTracking: h.windowTracking })
  await lifecycle.mount()
  mountedLifecycles.push(lifecycle)
}

/** Whether anything was still unsaved at the instant the window was closed —
 *  `win.close()` ends the process, so this is the whole question. */
let closedWhileDirty: boolean[] = []

/** How many times this route issued a `win.close()`, which is not the same claim
 *  as "the app went ahead": the early-return path never issues one. */
let closeCount = 0

type CloseHandler = (e: { preventDefault: () => void }) => Promise<void>

/** The handler `mount()` registered with the native window. */
function registeredCloseHandler(): CloseHandler {
  const calls = h.windowMock.onCloseRequested.mock.calls
  expect(calls.length).toBeGreaterThan(0)
  return calls[calls.length - 1][0] as CloseHandler
}

beforeEach(() => {
  setActivePinia(createPinia())
  vi.resetAllMocks()
  h.disk.clear()
  h.disk.set(NOTE, ORIGINAL)
  h.written.length = 0
  closedWhileDirty = []
  closeCount = 0
  h.read.mockImplementation(async (_vault: string, path: string): Promise<string> => {
    const text = h.disk.get(path)
    if (text === undefined) throw new Error(`no such file: ${path}`)
    return text
  })
  h.write.mockImplementation(
    async (_vault: string, path: string, content: string): Promise<null> => {
      h.written.push(content)
      h.disk.set(path, content)
      return null
    },
  )
  // `mount()` only registers the native close-requested listener under a Tauri
  // runtime; expose the flag so that path is the one exercised.
  ;(window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {}
  h.windowMock.onCloseRequested.mockResolvedValue(() => {})
  h.windowMock.destroy.mockResolvedValue(undefined)
  h.windowMock.close.mockImplementation(() => {
    closeCount += 1
    closedWhileDirty.push(useTabsStore().tabs.some((t) => t.dirty))
    return Promise.resolve()
  })
  h.notifyRecovery.mockImplementation((p: { onDismiss: () => void }) => p.onDismiss())
  vi.useFakeTimers()
  localStorage.clear()
})

afterEach(() => {
  // Listeners first, then the panes: a destroyed host flushes its pending burst
  // into the tab it mirrored (`code-mirror-host.ts#destroy`), which is the last
  // thing that should happen while a close handler is still reachable.
  mountedLifecycles.splice(0).forEach((l) => l.unmount())
  mountedPanes.splice(0).forEach((p) => p.destroy())
  vi.useRealTimers()
  setSourceViewHandle(null)
  delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__
  document.body.innerHTML = ''
})

describe('the window close and a burst the source pane has not published', () => {
  it('saves it when it is the session\'s only unsaved work', async () => {
    const tabs = useTabsStore()
    tabs.setVault(VAULT)
    await tabs.openTab(NOTE)
    const tab = tabs.tabs[0]
    const pane = mountSourcePane(tabs)

    pane.type(' TYPED')
    // The burst is in the pane and nowhere else, and the clock is stopped, so
    // the 50 ms timer is provably still pending.
    expect(pane.hasPendingEdit()).toBe(true)
    expect(tab.dirty).toBe(false)
    expect(tab.content).toBe(ORIGINAL)

    // What the close is about to read, with the disk behind it: this is the ONE
    // tab, so `dirty === false` on it is "nothing to save" for the whole
    // session. This is the state the close returned on, and the whole defect.
    const ask = vi.spyOn(tabs, 'hasUnsavedWork')
    expect(`hasUnsavedWork=${ask()} disk=${JSON.stringify(h.disk.get(NOTE))}`).toBe(
      'hasUnsavedWork=false disk="original\\n"',
    )

    await mountLifecycle()
    const preventDefault = vi.fn()
    await registeredCloseHandler()({ preventDefault })

    // One line, so the pre-fix run quotes all of it: the predicate answered
    // "nothing", the disk never heard about the sentence, and no `win.close()`
    // was ever issued — the early return simply let the native close through.
    const opened = ask.mock.results[1]?.value
    expect(
      `hasUnsavedWork=${opened} disk=${JSON.stringify(h.disk.get(NOTE))} ` +
        `writes=${JSON.stringify(h.written)} closedWhileDirty=${JSON.stringify(closedWhileDirty)}`,
    ).toBe(
      'hasUnsavedWork=true disk="original\\n TYPED" ' +
        'writes=["original\\n TYPED"] closedWhileDirty=[false]',
    )
    expect(preventDefault).toHaveBeenCalled()
    expect(h.notifyError).not.toHaveBeenCalled()
  })

  it('prompts for the same burst on the browser-Demo route', async () => {
    const tabs = useTabsStore()
    tabs.setVault(VAULT)
    await tabs.openTab(NOTE)
    const tab = tabs.tabs[0]
    const pane = mountSourcePane(tabs)

    pane.type(' TYPED')
    expect(pane.hasPendingEdit()).toBe(true)
    expect(tab.dirty).toBe(false)

    await mountLifecycle()

    // This route cannot await a flush, so the prompt is all it has: the burst
    // must at least reach the tab the prompt is about, and the user must be
    // asked before the page goes.
    const e = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(e)

    expect(`prompted=${e.defaultPrevented} content=${JSON.stringify(tab.content)}`).toBe(
      'prompted=true content="original\\n TYPED"',
    )
  })

  it('raises no prompt for a session nobody has typed into', async () => {
    const tabs = useTabsStore()
    tabs.setVault(VAULT)
    await tabs.openTab(NOTE)
    const tab = tabs.tabs[0]
    mountSourcePane(tabs)

    await mountLifecycle()

    // The flush in front of the predicate must not manufacture dirt: an empty
    // pane publishes nothing, so an ordinary leave is not turned into a
    // question by the fix.
    const e = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(e)

    expect(`prompted=${e.defaultPrevented} content=${JSON.stringify(tab.content)}`).toBe(
      'prompted=false content="original\\n"',
    )
  })

  it('leaves the ordinary close of a settled session alone', async () => {
    const tabs = useTabsStore()
    tabs.setVault(VAULT)
    await tabs.openTab(NOTE)
    mountSourcePane(tabs)

    await mountLifecycle()
    const preventDefault = vi.fn()
    await registeredCloseHandler()({ preventDefault })

    // No prompt, no write, no delay on a settled set — the close this route
    // always was.
    expect(preventDefault).not.toHaveBeenCalled()
    expect(h.write).not.toHaveBeenCalled()
    expect(closeCount).toBe(0)
    expect(h.notifyError).not.toHaveBeenCalled()
  })
})
