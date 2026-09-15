import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { nextTick, ref } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { useTabsStore } from '../../../stores/tabs'
import { useViewStore } from '../../../stores/view'
import { resetReadingLines } from '../model/reading-position'
import { useReadingPosition, type RenderedReadingPane } from './use-reading-position'

vi.mock('../../../platform/gateways/fs', () => ({
  fsService: {
    read: vi.fn(async (): Promise<string> => ''),
    write: vi.fn(async (): Promise<void> => undefined),
    list: vi.fn(async (): Promise<never[]> => []),
    stat: vi.fn(async (): Promise<{ size: number; mtimeMs: number }> => ({ size: 0, mtimeMs: 0 })),
    listHistory: vi.fn(async (): Promise<never[]> => []),
  },
}))

/**
 * A note with nothing remembered must open at its own top.
 *
 * The rendered pane is kept alive by `v-show` and is the app's own scroll
 * container, so nothing remounts it and nothing resets it when the document
 * behind it changes: measured in Chromium and in WebKitGTK 2.52.6, the offset
 * survives the content swap intact and no program writes it at all. So a note
 * opened for the first time in a session is left at the PREVIOUS note's offset —
 * a place in a document the reader has not seen. The same measurement shows the
 * source pane is not affected (CodeMirror resets its own scroller when its
 * document is replaced), which is why the pane that needs this is the one the
 * app scrolls itself.
 *
 * The restore for a note that HAS a remembered line is the deliberate opposite
 * of this, and it must keep winning: the reader's own position is a fact about
 * them, and the top is only the honest answer when there is no such fact.
 */

/** A two-note session: `a` is read and left, `b` is opened for the first time. */
const NOTE_A = Array.from({ length: 120 }, (_, i) => `alpha ${i + 1}`).join('\n\n') + '\n'
const NOTE_B = Array.from({ length: 200 }, (_, i) => `beta ${i + 1}`).join('\n\n') + '\n'

/** Where the reader left note A, in the rendered pane's own offsets. */
const LEFT_AT = 900

interface RenderedDouble {
  pane: RenderedReadingPane
  /** The pane's live offset — written by the program, moved by the "user". */
  scrollTop: number
  /** Every program write, in order: which kind, and what it was given. */
  writes: Array<{ kind: 'top'; top: number } | { kind: 'line'; line: number }>
  /** The pane has been handed a document (the parse resolved). */
  givenADocument(): void
}

/**
 * The rendered pane's reading-position surface.
 *
 * The scroll extent is a fixed number rather than a measurement: this module
 * never reads it except to hand it to the line↔offset mapping, which is a pure
 * function of the geometry (its own tests own the arithmetic). What matters
 * here is which write the pane was handed.
 */
function makeRenderedPane(): RenderedDouble {
  // A `ref`, as the pane publishes it (`RenderedPane.vue` exposes
  // `documentVersion.value`). A plain number would leave the watcher with no
  // dependency to re-run on, and every assertion below would pass vacuously.
  const documentVersion = ref(0)
  const writes: RenderedDouble['writes'] = []
  const double: RenderedDouble = {
    scrollTop: 0,
    writes,
    givenADocument: () => {
      documentVersion.value += 1
    },
    pane: {
      getDocumentVersion: () => documentVersion.value,
      getHeadingTops: () => [],
      getScrollRange: () => 4000,
      getScrollTop: () => double.scrollTop,
      setScrollTop: (top) => {
        writes.push({ kind: 'top', top })
        double.scrollTop = top
      },
      setScrollToLine: (line) => {
        writes.push({ kind: 'line', line })
      },
    },
  }
  return double
}

interface Session {
  rendered: RenderedDouble
  open(path: string, content: string): Promise<string>
  activate(tabId: string): Promise<void>
}

/** Mount the composable the way the pane does, then drive activations through
 *  the real tab store — the activeId watcher is the thing under test. */
function mountSession(): Session {
  const tabs = useTabsStore()
  const rendered = makeRenderedPane()
  let token = 0
  useReadingPosition({
    // Rendered mode, so the position is read from the pane on screen.
    getSourcePane: () => null,
    getRenderedPane: () => rendered.pane,
    nextToken: () => (token += 1),
  })

  return {
    rendered,
    async open(path, content) {
      await tabs.openTab(path)
      const tab = tabs.tabs.find((t) => t.path?.endsWith(path))
      if (!tab) throw new Error(`no tab for ${path}`)
      // The tab's text arrives with the read; the store is where this module
      // reads the outline and the line count from.
      tab.content = content
      return tab.id
    },
    async activate(tabId) {
      tabs.setActive(tabId)
      await nextTick()
    },
  }
}

let session: Session
let tabA: string

describe('useReadingPosition across a note switch', () => {
  beforeEach(async () => {
    setActivePinia(createPinia())
    resetReadingLines()
    const tabs = useTabsStore()
    const view = useViewStore()
    tabs.setVault('/vault')
    view.setMode('rendered')
    session = mountSession()
    // ONE note is open. The second is opened by each test, because "a note this
    // session has never shown" is the state under test and opening it up front
    // would leave it a memory of its own first line.
    tabA = await session.open('notes/a.md', NOTE_A)
  })

  afterEach(() => {
    resetReadingLines()
  })

  it('puts a note it has never shown at its own top, not at the glass the last one left', async () => {
    // The reader is on note A and has scrolled well down it. The pane keeps
    // this offset across the switch — that is the defect, and it is why the
    // write below has to exist at all.
    session.rendered.givenADocument()
    await nextTick()
    session.rendered.scrollTop = LEFT_AT

    // Click note B in the tree. Nothing about B is known: it has never been
    // shown, so there is no line to restore.
    await session.open('notes/b.md', NOTE_B)

    session.rendered.writes.length = 0
    session.rendered.givenADocument()
    await nextTick()

    // One write, and it is the pane's own top. Before this, NO write landed
    // here at all and the pane stayed at 900 — the middle of a note the reader
    // had just opened.
    expect(session.rendered.writes).toEqual([{ kind: 'top', top: 0 }])
    expect(session.rendered.scrollTop).toBe(0)
  })

  it('still restores the note that HAS a remembered position, and does not overwrite it with the top', async () => {
    session.rendered.givenADocument()
    await nextTick()
    session.rendered.scrollTop = LEFT_AT

    // Read B (a first visit, so it opens at its own top), then leave it further
    // down than A was left.
    await session.open('notes/b.md', NOTE_B)
    session.rendered.givenADocument()
    await nextTick()
    session.rendered.scrollTop = 2500

    // Back to A. A has a line, so the restore is what A must get — and the
    // value carried from B (2500px) must not be it.
    await session.activate(tabA)
    session.rendered.writes.length = 0
    session.rendered.givenADocument()
    await nextTick()

    expect(session.rendered.writes).toHaveLength(1)
    expect(session.rendered.writes[0].kind).toBe('line')
    // A line, not the top by another name: 900px into a 120-paragraph note is
    // 1 + (900/4000) * 238 ≈ 54.5, and line 1 would be the pane's top.
    const line = (session.rendered.writes[0] as { kind: 'line'; line: number }).line
    expect(line).toBeGreaterThan(50)
  })

  it('leaves the pane alone when the same document is merely handed over again', async () => {
    await session.open('notes/b.md', NOTE_B)
    session.rendered.givenADocument()
    await nextTick()
    // The reader scrolls B; nothing about that is an activation.
    session.rendered.scrollTop = 1200
    session.rendered.writes.length = 0

    // A re-apply that is not a note switch (a disk reload, a history restore):
    // `model/reading-position`'s own rule is that only an activation re-places
    // a pane, and the top is a placement like any other.
    session.rendered.givenADocument()
    await nextTick()

    expect(session.rendered.writes).toEqual([])
    expect(session.rendered.scrollTop).toBe(1200)
  })

  it('does not re-place a RESTORED note either when its document is handed over again', async () => {
    session.rendered.givenADocument()
    await nextTick()
    session.rendered.scrollTop = LEFT_AT

    await session.open('notes/b.md', NOTE_B)
    session.rendered.givenADocument()
    await nextTick()

    // Back to A: the restore runs, and it is the whole of what A gets.
    session.rendered.writes.length = 0
    await session.activate(tabA)
    session.rendered.givenADocument()
    await nextTick()
    expect(session.rendered.writes.map((w) => w.kind)).toEqual(['line'])

    // Re-applied with no activation in between. The line was already claimed,
    // so the restore has nothing left to say — and the top must not be what
    // fills the silence: this is the note the reader is reading.
    session.rendered.writes.length = 0
    session.rendered.givenADocument()
    await nextTick()

    expect(session.rendered.writes).toEqual([])
  })
})
