/**
 * A burst the source pane has not published yet is typing, whoever asks.
 *
 * `dirty` is set at the PUBLISH, and only one of the two panes publishes at the
 * keystroke: the rendered pane serializes per keystroke
 * (`editor-persistence.ts`), while the source pane coalesces a burst for
 * `SOURCE_SNAPSHOT_DEBOUNCE_MS` and marks the tab from the publish that follows
 * (`services/code-mirror-host.ts`). So while the user is typing, `dirty` is
 * false — and it stays false for as long as they keep typing.
 *
 * Two routes read that false as "nothing typed here" and destroy the burst:
 *
 *   - the read landing on a loading placeholder (`commitRead`), which then wrote
 *     the file's text into the tab and — through the pane's content watcher,
 *     `setText` — cancelled the pending publish, so the typing reached neither
 *     the tab nor the model;
 *   - the close of that placeholder, whose flush was behind the same flag.
 *
 * Both now flush BEFORE asking about `dirty`, so the question is asked about the
 * text the pane is actually holding. The gate `dirty` is too late to answer is
 * the defect; the fix is not to make the source pane mark dirty at the keystroke
 * (the 50 ms debounce is its publish contract, and `markDirty` is downstream of
 * publishing), and not to teach `setText` to refuse to cancel a pending burst
 * (that hides the loss in the pane instead of making the reader see it).
 *
 * The pane here is the REAL `code-mirror-host` — so the 50 ms debounce under
 * test is the product's own and not a stub's — mounted and registered the way
 * `SourcePane.vue` does it, with its `emitChange` reproduced line for line. The
 * clock is stopped, so the burst is provably still inside the window when the
 * read lands: the timer cannot have fired, and the test is not a race it won.
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

const readMock = vi.hoisted(() => vi.fn())
vi.mock('../platform/gateways/fs', () => ({
  fsService: {
    read: readMock,
    write: vi.fn(async (): Promise<void> => undefined),
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

/** A read the test decides when to answer, and with what. */
function parkedRead() {
  let answer: ((content: string) => void) | null = null
  let refused: ((e: unknown) => void) | null = null
  readMock.mockImplementation(
    () =>
      new Promise<string>((resolve, reject) => {
        answer = resolve
        refused = reject
      }),
  )
  return {
    resolve: (content: string) => answer?.(content),
    reject: (e: unknown) => refused?.(e),
  }
}

type Tabs = ReturnType<typeof useTabsStore>

/**
 * The source pane, as the store sees it: the real CodeMirror host, the handle
 * registration from `SourcePane.vue`'s `onMounted`, and its `emitChange` — the
 * one function that decides when a keystroke becomes the tab's text and a
 * `dirty` flag.
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
    destroy: (): void => mounted.destroy(),
  }
}

/** Every notice the app put in front of the user. */
let notices: string[] = []
let offNotify: (() => void) | null = null
const mountedPanes: Array<{ destroy(): void }> = []

/** The tab set as the user is left with it: path, dirty, text. */
const snapshot = (tabs: Tabs): string[] =>
  tabs.tabs.map((tab) => `${tab.path ?? 'untitled'}|${tab.dirty}|${tab.content}`)

beforeEach(() => {
  setActivePinia(createPinia())
  readMock.mockReset()
  vi.useFakeTimers()
  notices = []
  offNotify = onNotify((m) => notices.push(m))
})

afterEach(() => {
  offNotify?.()
  mountedPanes.splice(0).forEach((p) => p.destroy())
  vi.useRealTimers()
  setSourceViewHandle(null)
  document.body.innerHTML = ''
})

describe('the read landing on a burst that has not been published', () => {
  it('rescues the typing instead of writing the file over it', async () => {
    const read = parkedRead()
    const tabs = useTabsStore()
    tabs.setVault('/vault')

    const opening = tabs.openTab('/vault/a.md')
    const pane = mountSourcePane(tabs)
    const placeholder = tabs.tabs[0]
    pane.type('USER TYPED')

    // The pre-fix state, and the reason the fix cannot be a `dirty` test: the
    // keystroke is in the pane and NOTHING else. The clock is stopped, so the
    // 50 ms timer is provably still pending — this is not a race won but a
    // window held open.
    expect(pane.hasPendingEdit()).toBe(true)
    expect(placeholder.dirty).toBe(false)
    expect(placeholder.content).toBe('')

    read.resolve('DISK BEFORE')
    await opening

    // What the user is left with, in one line: the note holds the file's text,
    // and the burst is a document of its own — flagged dirty, because no disk
    // has it — with a sentence saying where it went. One string rather than an
    // object so the pre-fix run quotes the whole state: it read
    // `told=false tabs=/vault/a.md|false|DISK BEFORE` — the typing destroyed,
    // and nothing said.
    expect(`told=${notices.length > 0} tabs=${snapshot(tabs).join(' ; ')}`).toBe(
      'told=true tabs=/vault/a.md|false|DISK BEFORE ; untitled|true|USER TYPED',
    )
    const note = tabs.tabs.find((t) => t.path === '/vault/a.md')
    const rescued = tabs.tabs.find((t) => t.path === null)
    // Neither text was written over the other...
    expect(note?.content).toBe('DISK BEFORE')
    expect(note?.savedContent).toBe('DISK BEFORE')
    expect(note?.loading).toBe(false)
    expect(rescued?.content).toBe('USER TYPED')
    // ...and the flush consumed the burst, so no publish is left to fire into
    // the note the read has just committed.
    expect(pane.hasPendingEdit()).toBe(false)
  })

  it('leaves a note nobody typed into alone', async () => {
    const read = parkedRead()
    const tabs = useTabsStore()
    tabs.setVault('/vault')

    const opening = tabs.openTab('/vault/a.md')
    const pane = mountSourcePane(tabs)
    // Nothing typed: the pane is up, mirroring the empty placeholder, and holds
    // no burst at all.
    expect(pane.hasPendingEdit()).toBe(false)

    read.resolve('DISK BEFORE')
    await opening

    // The ordinary case: the flush in front of the `dirty` check must not
    // manufacture a rescue — an untitled tab here would be a document the user
    // never typed.
    expect(tabs.tabs).toHaveLength(1)
    expect(tabs.tabs[0].content).toBe('DISK BEFORE')
    expect(tabs.tabs[0].savedContent).toBe('DISK BEFORE')
    expect(tabs.tabs[0].dirty).toBe(false)
    expect(notices).toHaveLength(0)
  })

  it('still rescues a burst that was paused before the read landed', async () => {
    const read = parkedRead()
    const tabs = useTabsStore()
    tabs.setVault('/vault')

    const opening = tabs.openTab('/vault/a.md')
    const pane = mountSourcePane(tabs)
    const placeholder = tabs.tabs[0]
    pane.type('USER TYPED')
    // The case that worked before this fix, kept as the guard on it: the
    // debounce fires first, so the tab is dirty before the read lands.
    await vi.advanceTimersByTimeAsync(SOURCE_SNAPSHOT_DEBOUNCE_MS)
    expect(placeholder.dirty).toBe(true)
    expect(placeholder.content).toBe('USER TYPED')

    read.resolve('DISK BEFORE')
    await opening

    expect(tabs.tabs.find((t) => t.path === null)?.content).toBe('USER TYPED')
    expect(tabs.tabs.find((t) => t.path === '/vault/a.md')?.content).toBe('DISK BEFORE')
  })
})

describe('closing a placeholder a burst has not been published from', () => {
  it('rescues the typing instead of taking it with the tab', async () => {
    const read = parkedRead()
    const tabs = useTabsStore()
    tabs.setVault('/vault')

    const opening = tabs.openTab('/vault/a.md')
    const pane = mountSourcePane(tabs)
    const placeholder = tabs.tabs[0]
    pane.type('USER TYPED')
    expect(pane.hasPendingEdit()).toBe(true)
    expect(placeholder.dirty).toBe(false)

    await tabs.closeTab(placeholder.id)

    // The note the user asked to close closes, and the text they typed into
    // what looked like it is not discarded with it.
    expect(tabs.tabs.some((t) => t.path === '/vault/a.md')).toBe(false)
    const rescued = tabs.tabs.find((t) => t.path === null)
    expect(rescued?.content).toBe('USER TYPED')
    expect(rescued?.dirty).toBe(true)
    expect(notices.length).toBeGreaterThan(0)

    read.resolve('DISK BEFORE')
    await opening
  })

  it('rescues it for a bulk close too, before anything is removed', async () => {
    const read = parkedRead()
    const tabs = useTabsStore()
    tabs.setVault('/vault')

    const opening = tabs.openTab('/vault/a.md')
    const pane = mountSourcePane(tabs)
    pane.type('USER TYPED')
    expect(pane.hasPendingEdit()).toBe(true)

    await tabs.reconcilePlaceholders()

    // The step the untitled prompt and the flush both come after: without it the
    // burst is already gone by the time either of them looks.
    const rescued = tabs.tabs.find((t) => t.path === null)
    expect(rescued?.content).toBe('USER TYPED')
    expect(rescued?.dirty).toBe(true)

    read.resolve('DISK BEFORE')
    await opening
  })
})
