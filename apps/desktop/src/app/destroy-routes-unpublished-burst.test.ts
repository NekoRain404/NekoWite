/**
 * The two app-level routes that destroy a tab set read the same gate the tab's
 * X does, and dropped the same source burst.
 *
 * `flushDirty` (`stores/tab-settle.ts`) is the bulk gate: "Close all", the
 * window close (`onCloseRequested`) and a vault switch all pass through it, and
 * it skipped every `!tab.dirty` tab. `dirty` is set at the PUBLISH, and the
 * source pane coalesces a burst for `SOURCE_SNAPSHOT_DEBOUNCE_MS`
 * (`services/code-mirror-host.ts`) — so a tab the user is still typing into is
 * `dirty === false` for the length of the window, the gate was never asked about
 * it, and the route that followed (`removeAllTabs()`, or the process ending)
 * took the typing with no disk holding it.
 *
 * The store here is the REAL one and so are both routes; only the gateways, the
 * window, the appearance store and the two prompts are mocked. The pane is the
 * REAL `code-mirror-host`, mounted and registered the way `SourcePane.vue` does
 * it, with its `emitChange` reproduced line for line — so the 50 ms window under
 * test is the product's own. The clock is stopped, so the burst is provably
 * still inside it when the destroy runs. "Disk" is a Map the fs mock reads and
 * writes, so the assertion is about the bytes a file would hold afterwards.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { ref } from 'vue'
import type { FsPort } from '../platform/gateways/contracts'
import { markSourceAuthored } from '../services/editor-ownership'
import { setSourceViewHandle } from '../services/source-view'
import {
  createCodeMirrorHost,
  type CodeMirrorHostHandle,
} from '../services/code-mirror-host'
import { sourceExtensions } from '../services/cm-source-view'

const h = vi.hoisted(() => {
  const disk = new Map<string, string>()
  // The signatures are stated rather than inferred: the fs mock answers
  // differently per test, and an inferred mock only ever answers the value it
  // was built with.
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
    fs,
    read,
    write,
    // The two calls a vault switch makes of its port, and nothing else: the
    // switch is handed this rather than the whole gateway.
    registerVault: vi.fn(async (): Promise<void> => undefined),
    watchVault: vi.fn(async (): Promise<void> => undefined),
    background: { arm: vi.fn(), stop: vi.fn() },
    windowMock: { onCloseRequested: vi.fn(), close: vi.fn(), destroy: vi.fn() },
    appearanceMock: { autosaveOnBlur: false, touchSystem: vi.fn() },
    windowTracking: { restore: vi.fn(), start: vi.fn(), flush: vi.fn(), dispose: vi.fn() },
    // Stated against the real type: an inferred `'discard'` would narrow the
    // mock to that one literal, which only a typecheck sees.
    requestUntitledVaultSwitch: vi.fn(async (): Promise<'save' | 'discard'> => 'discard'),
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
import { createVaultSwitch } from './vault-switch'
import { useTabsStore } from '../stores/tabs'

const NOTE = '/vault/a.md'
const OTHER = '/vault/b.md'
const ORIGINAL = 'original\n'
const OTHER_TEXT = 'other\n'

type Tabs = ReturnType<typeof useTabsStore>

/**
 * The source pane, as the store sees it: the real CodeMirror host, the handle
 * registration from `SourcePane.vue`'s `onMounted` (including its `setText` of
 * the live tab's content, which is what mirrors the open note into the pane),
 * and its `emitChange` — the one function that decides when a keystroke becomes
 * the tab's text and a `dirty` flag.
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

/** The vault-switch port: what `createVaultSwitch` touches of it, named rather
 *  than the whole `FsPort` — this route's question is about the flush, and a
 *  gateway that also models trash, history and dialogs would say nothing more. */
const fsPort = {
  registerVault: (vault: string) => h.registerVault(vault),
  watch: (vault: string) => h.watchVault(vault),
} as unknown as FsPort

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
  h.disk.set(OTHER, OTHER_TEXT)
  h.read.mockImplementation(async (_vault: string, path: string): Promise<string> => {
    const text = h.disk.get(path)
    if (text === undefined) throw new Error(`no such file: ${path}`)
    return text
  })
  h.write.mockImplementation(
    async (_vault: string, path: string, content: string): Promise<null> => {
      h.disk.set(path, content)
      return null
    },
  )
  // `mount()` only registers the native close-requested listener under a Tauri
  // runtime; expose the flag so that path is the one exercised.
  ;(window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {}
  h.windowMock.onCloseRequested.mockResolvedValue(() => {})
  h.windowMock.close.mockResolvedValue(undefined)
  h.windowMock.destroy.mockResolvedValue(undefined)
  h.registerVault.mockResolvedValue(undefined)
  h.watchVault.mockResolvedValue(undefined)
  h.notifyRecovery.mockImplementation((p: { onDismiss: () => void }) => p.onDismiss())
  vi.useFakeTimers()
  localStorage.clear()
})

afterEach(() => {
  mountedPanes.splice(0).forEach((p) => p.destroy())
  vi.useRealTimers()
  setSourceViewHandle(null)
  delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__
  document.body.innerHTML = ''
})

describe('the window close and a burst the source pane has not published', () => {
  it('puts the burst on disk before the window is closed over it', async () => {
    const tabs = useTabsStore()
    tabs.setVault('/vault')
    await tabs.openTab(NOTE)
    await tabs.openTab(null, 'scratch')
    const burst = tabs.tabs[0]
    const scratch = tabs.tabs[1]
    // What keeps this route alive is the UNTITLED dirty tab, and it has to be
    // that: `onCloseRequested` returns early on `hasUnsavedWork()`, which reads
    // this same `dirty` gate one level up (`stores/tab-persistence.ts`, outside
    // what this fix may touch — reported), so a burst on its own is not "unsaved
    // work" there and the window goes without any flush at all. And a path'd
    // companion tab would not do either: its own save flushes both panes on the
    // way past, which marks the burst's tab dirty in time for the untitled
    // rescue's late pass (`stores/untitled-rescue.ts`) to write it — the flush
    // never runs for it, and the burst survives by a route that exists for
    // something else.
    tabs.markDirty(scratch.id)
    tabs.setActive(burst.id)
    const pane = mountSourcePane(tabs)

    pane.type('LATEST ')
    // The burst is in the pane and nothing else, and the clock is stopped, so
    // the 50 ms timer is provably still pending.
    expect(pane.hasPendingEdit()).toBe(true)
    expect(burst.dirty).toBe(false)
    expect(burst.content).toBe(ORIGINAL)
    // The close's own precondition, which is why this route runs at all.
    expect(tabs.hasUnsavedWork()).toBe(true)

    const lifecycle = createAppLifecycle({ windowTracking: h.windowTracking })
    await lifecycle.mount()
    await registeredCloseHandler()({ preventDefault: vi.fn() })

    // Pre-fix the flush skipped the burst's tab (nothing in the set was dirty
    // AND path'd, so no save ran and no pane was ever flushed), the untitled
    // prompt discarded the scratch tab, and the window was closed over a file
    // that still read `original\n`.
    expect(h.disk.get(NOTE)).toBe('original\nLATEST ')
    expect(h.windowMock.close).toHaveBeenCalled()
    expect(h.notifyError).not.toHaveBeenCalled()
  })

  it('writes a tab that is already known unsaved exactly once', async () => {
    const tabs = useTabsStore()
    tabs.setVault('/vault')
    await tabs.openTab(OTHER)
    const tab = tabs.tabs[0]
    mountSourcePane(tabs)
    tabs.markDirty(tab.id)
    // `saveTab` flushes before its own write and this gate now flushes before
    // the loop: the same bytes must not go to disk twice, and a second write is
    // a second history snapshot on an ordinary close.
    const written: string[] = []
    h.write.mockImplementation(
      async (_vault: string, path: string, content: string): Promise<null> => {
        written.push(content)
        h.disk.set(path, content)
        return null
      },
    )

    const lifecycle = createAppLifecycle({ windowTracking: h.windowTracking })
    await lifecycle.mount()
    await registeredCloseHandler()({ preventDefault: vi.fn() })

    expect(written).toEqual([OTHER_TEXT])
    expect(h.windowMock.close).toHaveBeenCalled()
  })

  it('writes nothing, and asks nothing, for a set with nothing unsaved in it', async () => {
    const tabs = useTabsStore()
    tabs.setVault('/vault')
    await tabs.openTab(NOTE)
    mountSourcePane(tabs)

    const lifecycle = createAppLifecycle({ windowTracking: h.windowTracking })
    await lifecycle.mount()
    const preventDefault = vi.fn()
    await registeredCloseHandler()({ preventDefault })

    expect(h.write).not.toHaveBeenCalled()
    expect(preventDefault).not.toHaveBeenCalled()
    expect(h.notifyError).not.toHaveBeenCalled()
  })
})

describe('a vault switch and a burst the source pane has not published', () => {
  it('puts the burst on disk before it takes the tab set away', async () => {
    const tabs = useTabsStore()
    const vaultPath = ref<string | null>('/vault')
    const vaultSwitch = createVaultSwitch({
      tabs,
      fs: fsPort,
      vaultPath,
      isDisposed: () => false,
      background: h.background,
    })
    tabs.setVault('/vault')
    await tabs.openTab(NOTE)
    const tab = tabs.tabs[0]
    const pane = mountSourcePane(tabs)

    pane.type('LATEST ')
    expect(pane.hasPendingEdit()).toBe(true)
    expect(tab.dirty).toBe(false)
    expect(tab.content).toBe(ORIGINAL)

    await vaultSwitch.apply('/vault2')

    // `removeAllTabs()` is the point of no return for every open tab, and the
    // old vault's root is not authorized any more once the switch commits — so
    // the text has to be at the file before either happens.
    expect(h.disk.get(NOTE)).toBe('original\nLATEST ')
    expect(vaultPath.value).toBe('/vault2')
    expect(tabs.tabs).toHaveLength(0)
    expect(h.notifyError).not.toHaveBeenCalled()
  })

  it('writes nothing extra for a vault with nothing unsaved in it', async () => {
    const tabs = useTabsStore()
    const vaultPath = ref<string | null>('/vault')
    const vaultSwitch = createVaultSwitch({
      tabs,
      fs: fsPort,
      vaultPath,
      isDisposed: () => false,
      background: h.background,
    })
    tabs.setVault('/vault')
    await tabs.openTab(NOTE)
    mountSourcePane(tabs)

    await vaultSwitch.apply('/vault2')

    expect(h.write).not.toHaveBeenCalled()
    expect(vaultPath.value).toBe('/vault2')
    expect(tabs.tabs).toHaveLength(0)
  })
})
