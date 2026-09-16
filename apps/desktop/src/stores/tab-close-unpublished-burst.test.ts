/**
 * The ordinary destroy of a path'd tab reads `dirty` before anything has
 * published — and drops the burst that was still in the pane.
 *
 * `tab-unpublished-burst.test.ts` pins the mechanism on the two routes that were
 * fixed with it: the read landing on a placeholder (`commitRead`) and the close
 * of that PLACEHOLDER. The ordinary close of a path'd tab, and the bulk gate the
 * other destroy routes share, are the same mechanism one step over — the user
 * typed into a normal note, not a placeholder, and the same 50 ms window ate it.
 *
 * `dirty` is set at the PUBLISH, and the source pane coalesces a burst for
 * `SOURCE_SNAPSHOT_DEBOUNCE_MS` (`services/code-mirror-host.ts`). So while the
 * user is typing:
 *
 *   - `closeTab` — the tab's X and "Close others" — read `current.dirty` as
 *     false, never asked `saveUntilSettled`, and `removeTab` took the typing;
 *   - `flushDirty` — "Close all", the window close and a vault switch — skipped
 *     every `!tab.dirty` tab, so the same window ate the same burst.
 *
 * Both now flush BEFORE the gate, which is `closePlaceholder`'s rule stated two
 * functions down in `tab-close.ts`: the flush publishes what the pane is still
 * holding, which is what makes `dirty` and `content` describe the text. The fix
 * is not to mark dirty at the keystroke (the 50 ms debounce is the source pane's
 * publish contract) and not to stop the pane from coalescing.
 *
 * The pane here is the REAL `code-mirror-host` — so the window under test is the
 * product's own and not a stub's — mounted and registered the way
 * `SourcePane.vue` does it, with its `emitChange` reproduced line for line. The
 * clock is stopped, so the burst is provably still inside the window when the
 * destroy runs: the timer cannot have fired, and no test here is a race it won.
 * The "disk" is a Map the fs mock reads and writes, so the assertion is about
 * what a file would hold afterwards and not about which function was called.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { onNotify } from '../services/errors'
import { markSourceAuthored } from '../services/editor-ownership'
import { setSourceViewHandle } from '../services/source-view'
import {
  createCodeMirrorHost,
  SOURCE_SNAPSHOT_DEBOUNCE_MS,
  type CodeMirrorHostHandle,
} from '../services/code-mirror-host'
import { sourceExtensions } from '../services/cm-source-view'
import { useTabsStore } from './tabs'

/** The file a save would land in: read and written by the fs gateway below, so
 *  "the disk holds the newest text" is a statement about bytes. */
const disk = vi.hoisted(() => new Map<string, string>())
const readMock = vi.hoisted(() => vi.fn())
const writeMock = vi.hoisted(() => vi.fn())

vi.mock('../platform/gateways/fs', () => ({
  fsService: {
    read: (vault: string, path: string) => readMock(vault, path),
    write: (vault: string, path: string, content: string) => writeMock(vault, path, content),
    list: vi.fn(async (): Promise<string[]> => []),
    watch: vi.fn(async (): Promise<() => void> => () => {}),
    deleteFile: vi.fn(async (): Promise<void> => undefined),
    stat: vi.fn(async (): Promise<{ size: number; mtime: number }> => ({ size: 0, mtime: 0 })),
    listHistory: vi.fn(async (): Promise<never[]> => []),
    readHistory: vi.fn(async (): Promise<string> => ''),
    restoreHistory: vi.fn(async (): Promise<string | null> => null),
    createDir: vi.fn(async (): Promise<void> => undefined),
    renameEntry: vi.fn(async (): Promise<void> => undefined),
    saveFileDialog: vi.fn(async (): Promise<string | null> => null),
  },
}))

const NOTE = '/vault/a.md'
const ORIGINAL = 'original\n'

/** The writes the save path asked for, in order, with the ability to hold one
 *  open — the interleaving is controllable rather than timed. */
function parkedWrite() {
  const written: string[] = []
  let parked: Array<(fail: boolean) => void> = []
  writeMock.mockImplementation((_vault: string, path: string, content: string) => {
    written.push(content)
    return new Promise<string | null>((resolve, reject) =>
      parked.push((fail) => (fail ? reject(new Error('disk full')) : resolve(null))),
    ).then((result) => {
      disk.set(path, content)
      return result
    })
  })
  return {
    written,
    get started() {
      return written.length > 0
    },
    /** Let the write in flight finish — successfully, or as a failure. */
    release: (fail = false) => {
      const waiting = parked
      parked = []
      waiting.forEach((go) => go(fail))
    },
    /** Every later write lands on its own — for the follow-up save, whose
     *  interleaving is not what a test here is controlling. */
    landFromNowOn: () => {
      writeMock.mockImplementation((_vault: string, path: string, content: string) => {
        written.push(content)
        disk.set(path, content)
        return Promise.resolve(null)
      })
    },
  }
}

type Tabs = ReturnType<typeof useTabsStore>

/**
 * The source pane, as the store sees it: the real CodeMirror host, the handle
 * registration from `SourcePane.vue`'s `onMounted` (including its `setText` of
 * the live tab's content), and its `emitChange` — the one function that decides
 * when a keystroke becomes the tab's text and a `dirty` flag.
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

/** Every notice the app put in front of the user. */
let notices: string[] = []
let offNotify: (() => void) | null = null
const mountedPanes: Array<{ destroy(): void }> = []

beforeEach(() => {
  setActivePinia(createPinia())
  readMock.mockReset()
  writeMock.mockReset()
  disk.clear()
  disk.set(NOTE, ORIGINAL)
  readMock.mockImplementation(async (_vault: string, path: string): Promise<string> => {
    const text = disk.get(path)
    if (text === undefined) throw new Error(`no such file: ${path}`)
    return text
  })
  writeMock.mockImplementation(
    async (_vault: string, path: string, content: string): Promise<null> => {
      disk.set(path, content)
      return null
    },
  )
  vi.useFakeTimers()
  notices = []
  offNotify = onNotify((m) => notices.push(m))
})

afterEach(() => {
  offNotify?.()
  offNotify = null
  mountedPanes.splice(0).forEach((p) => p.destroy())
  vi.useRealTimers()
  setSourceViewHandle(null)
  document.body.innerHTML = ''
})

describe('a burst the source pane has not published, then the tab is destroyed', () => {
  it("the tab's X puts it on disk instead of taking it away", async () => {
    const tabs = useTabsStore()
    tabs.setVault('/vault')
    await tabs.openTab(NOTE)
    const tab = tabs.tabs[0]
    const pane = mountSourcePane(tabs)

    pane.type('LATEST ')
    // The pre-fix state, and the reason the gate cannot be read as it stood:
    // the keystroke is in the pane and NOTHING else. The clock is stopped, so
    // the 50 ms timer is provably still pending.
    expect(pane.hasPendingEdit()).toBe(true)
    expect(tab.dirty).toBe(false)
    expect(tab.content).toBe(ORIGINAL)

    await tabs.closeTab(tab.id)

    // Pre-fix this read `original\n` — the close skipped the save the tab
    // looked not to need, and `removeTab` took the only copy of the typing.
    expect(disk.get(NOTE)).toBe('original\nLATEST ')
    expect(tabs.tabs).toHaveLength(0)
  })

  it('Close all puts it on disk before it takes the set away', async () => {
    const tabs = useTabsStore()
    tabs.setVault('/vault')
    await tabs.openTab(NOTE)
    const tab = tabs.tabs[0]
    const pane = mountSourcePane(tabs)

    pane.type('LATEST ')
    expect(pane.hasPendingEdit()).toBe(true)
    expect(tab.dirty).toBe(false)

    await expect(tabs.closeAll()).resolves.toBe(true)

    expect(disk.get(NOTE)).toBe('original\nLATEST ')
    expect(tabs.tabs).toHaveLength(0)
  })

  it('Close others puts it on disk too — it closes through the same X', async () => {
    const tabs = useTabsStore()
    tabs.setVault('/vault')
    await tabs.openTab(NOTE)
    const tab = tabs.tabs[0]
    const pane = mountSourcePane(tabs)

    pane.type('LATEST ')
    expect(pane.hasPendingEdit()).toBe(true)
    expect(tab.dirty).toBe(false)

    await tabs.closeOthers('some-other-tab')

    expect(disk.get(NOTE)).toBe('original\nLATEST ')
  })

  it('a keystroke during the close\'s own save settles with the newer text', async () => {
    const tabs = useTabsStore()
    tabs.setVault('/vault')
    await tabs.openTab(NOTE)
    const tab = tabs.tabs[0]
    const pane = mountSourcePane(tabs)

    const write = parkedWrite()
    pane.type('LATEST ')
    expect(tab.dirty).toBe(false)

    const closing = tabs.closeTab(tab.id)
    await vi.waitFor(() => expect(write.started).toBe(true))

    // The user types again while the close's own write is in flight: the burst
    // is in the pane, the 50 ms publish is behind it, and the write in flight
    // carries the older text.
    pane.type('MORE')
    expect(pane.hasPendingEdit()).toBe(true)
    expect(tab.content).toBe('original\nLATEST ')

    vi.advanceTimersByTime(SOURCE_SNAPSHOT_DEBOUNCE_MS)
    expect(tab.content).toBe('original\nLATEST MORE')
    write.release()
    write.landFromNowOn()
    await closing

    // The claim: the second burst went to disk instead of going away with the
    // tab. `saveUntilSettled`'s revision guard is what carries it — the tab is
    // still dirty when the first write lands, so the loop asks again.
    expect(write.written).toEqual(['original\nLATEST ', 'original\nLATEST MORE'])
    expect(disk.get(NOTE)).toBe('original\nLATEST MORE')
    expect(tabs.tabs).toHaveLength(0)
    expect(tabs.hasUnsavedWork()).toBe(false)
  })
})

describe('the ordinary closes the flush must not change', () => {
  it('writes nothing for a clean tab, and says nothing', async () => {
    const tabs = useTabsStore()
    tabs.setVault('/vault')
    await tabs.openTab(NOTE)
    const tab = tabs.tabs[0]
    mountSourcePane(tabs)

    // The pane is mounted over the tab and nobody has typed: the flush in front
    // of the gate has nothing to publish, so the clean close stays a close.
    expect(tab.dirty).toBe(false)
    await tabs.closeTab(tab.id)

    expect(writeMock).not.toHaveBeenCalled()
    expect(disk.get(NOTE)).toBe(ORIGINAL)
    expect(tabs.tabs).toHaveLength(0)
    expect(notices).toHaveLength(0)
  })

  it('writes exactly once for a burst that has already published', async () => {
    const tabs = useTabsStore()
    tabs.setVault('/vault')
    await tabs.openTab(NOTE)
    const tab = tabs.tabs[0]
    const pane = mountSourcePane(tabs)

    const written: string[] = []
    writeMock.mockImplementation(async (_vault: string, path: string, content: string) => {
      written.push(content)
      disk.set(path, content)
      return null
    })
    pane.type('LATEST ')
    // The case that already worked, kept as the guard on the fix: the debounce
    // fired first, so the tab is dirty before the close looks.
    await vi.advanceTimersByTimeAsync(SOURCE_SNAPSHOT_DEBOUNCE_MS)
    expect(tab.dirty).toBe(true)
    expect(tab.content).toBe('original\nLATEST ')

    await tabs.closeTab(tab.id)

    // One write, not two: a flush that always saved would add a history
    // snapshot per close for an ordinary dirty tab.
    expect(written).toEqual(['original\nLATEST '])
    expect(disk.get(NOTE)).toBe('original\nLATEST ')
    expect(tabs.tabs).toHaveLength(0)
  })
})
