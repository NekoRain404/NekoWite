import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { nextTick, ref, watch } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { useTabsStore } from '../../../stores/tabs'
import { useViewStore } from '../../../stores/view'
import { resetReadingLines } from '../model/reading-position'
import { usePaneHandoff, type RenderedPaneHandoff } from './use-pane-handoff'
import type { SourcePaneExpose } from './use-source-pane-slot'

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
 * A note opened in the default SOURCE mode must not be thrown to its top later.
 *
 * `useReadingPosition` arms "this note opens at its own top" on every activation
 * and clears it when the rendered pane is handed the note's document. In source
 * mode no document is ever handed over — the source pane owns the text, so the
 * apply path returns before the model is rebuilt and `documentVersion` never
 * moves — so the flag was armed and stayed armed. The next document that pane
 * was given is the one the switch to Rendered hands it, and there the reader's
 * line has already been carried across by the handoff: the stale top is written
 * after that carry and wins, and a reader scrolled to line 101 of a long note is
 * looking at line 1.
 *
 * The rule the fix keeps is the flag's lifetime: a top is armed only for an
 * activation that hands the note over, because an arrival is the only thing that
 * can consume it. What must not change is the other half — a note with a
 * remembered line still gets THAT line, in either mode, and a note nobody has
 * read still opens at its own top.
 */

/** 5 paragraphs — the note the reader is in before and after the long one. */
const OTHER_NOTE = Array.from({ length: 5 }, (_, i) => `other ${i + 1}`).join('\n\n') + '\n'

/**
 * 201 paragraphs, so 401 lines against the double's 4000px range: line 101 sits
 * a quarter of the way down, i.e. at offset 1000. The two numbers the assertions
 * below name are that position and 0 — the top the reader is thrown to.
 */
const LONG_NOTE = Array.from({ length: 201 }, (_, i) => `long ${i + 1}`).join('\n\n') + '\n'
const READER_LINE = 101
const CARRIED_TO = 1000
/** Where the pane sits when the reader has scrolled the RENDERED pane itself. */
const READER_AT = 1200

const RENDERED_RANGE = 4000
const SOURCE_RANGE = 10000

interface RenderedDouble {
  pane: RenderedPaneHandoff
  /** The pane's live offset — written by the program, scrolled by the reader. */
  scrollTop: number
  /** Every program write, in order: which kind, and what it was given. */
  writes: Array<{ kind: 'top'; top: number } | { kind: 'line'; line: number }>
  /** The pane has been handed a document (the parse resolved). */
  givenADocument(): void
}

function makeRenderedPane(): RenderedDouble {
  // A `ref`, as the pane publishes it (`RenderedPane.vue` exposes
  // `documentVersion.value`). A plain number would leave the watcher under test
  // with no dependency to re-run on, and every assertion would pass vacuously.
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
      getScrollRange: () => RENDERED_RANGE,
      getScrollTop: () => double.scrollTop,
      setScrollTop: (top) => {
        writes.push({ kind: 'top', top })
        double.scrollTop = top
      },
      setScrollToLine: (line) => {
        writes.push({ kind: 'line', line })
      },
      getCaretLine: () => null,
      setCaretLine: () => {},
      focus: () => {},
    },
  }
  return double
}

interface SourceDouble {
  pane: SourcePaneExpose
  /** The line the pane is showing: what the reader has scrolled to, and what a
   *  mode switch carries into the rendered pane. */
  visibleLine: number
  /** Every program write, in order: the line the pane was put back on. */
  writes: number[]
}

function makeSourcePane(): SourceDouble {
  const double: SourceDouble = {
    visibleLine: 1,
    writes: [],
    pane: {
      setScrollTop: () => {},
      setScrollTopForLine: (line) => {
        double.writes.push(line)
      },
      getScrollTop: () => 0,
      getScrollRange: () => SOURCE_RANGE,
      scrollTopForLine: (line) => line * 20,
      focus: () => {},
      getText: () => '',
      getSourceView: () => null,
      getVisibleUnit: () => double.visibleLine,
      getVisibleLine: () => double.visibleLine,
      setCaretLine: () => {},
      setMeasureSuppressed: () => {},
    },
  }
  return double
}

interface Session {
  rendered: RenderedDouble
  source: SourceDouble
  open(path: string, content: string): Promise<string>
  activate(tabId: string): Promise<void>
}

/**
 * Two microtask hops: the flush a change is handled in, and the tick a watcher's
 * own `nextTick` lands on. Both the handoff's carry and the source pane's
 * restore are written on that second tick, on purpose — they need the DOM update
 * that has not run yet when their watcher fires — so one `await nextTick()` in a
 * test reads the state just before them and not after.
 */
async function settle(): Promise<void> {
  await nextTick()
  await nextTick()
}

/**
 * Mount the handoff — which is what mounts `useReadingPosition`, and what owns
 * the carry across a mode switch — and drive activations through the real tab
 * store. Both halves are needed: the defect is the reading position's flag
 * writing over the handoff's carry, so the carry has to be the real one.
 */
function mountSession(): Session {
  const tabs = useTabsStore()
  const view = useViewStore()
  const rendered = makeRenderedPane()
  const source = makeSourcePane()
  let token = 0
  // App.vue's own watcher on the active document, registered before anything
  // that reads the mode — which is the order the app has, since App.vue's setup
  // runs before the pane it renders. This is what opens a note in the stored
  // default mode, and it is the premise the fix rests on: the mode the arming
  // reads is already the one the note is being opened in.
  watch(
    () => tabs.activeId,
    () => view.resetToDefault(),
  )
  usePaneHandoff({
    getSourcePane: () => source.pane,
    getRenderedPane: () => rendered.pane,
    getPanesEl: () => null,
    nextToken: () => (token += 1),
    getSourceCaretLine: () => null,
  })

  return {
    rendered,
    source,
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
let view: ReturnType<typeof useViewStore>

describe('useReadingPosition with the default mode set to source', () => {
  beforeEach(async () => {
    setActivePinia(createPinia())
    resetReadingLines()
    const tabs = useTabsStore()
    view = useViewStore()
    tabs.setVault('/vault')
    // The setting this whole file turns on. App.vue puts the live mode back to
    // the stored default for every document it opens — its watcher on `activeId`
    // is created before this feature's — so a note opened in Source is a note
    // the rendered pane is never handed.
    view.setDefaultMode('source')
    view.setMode('source')
    session = mountSession()
    await session.open('notes/other.md', OTHER_NOTE)
  })

  afterEach(() => {
    resetReadingLines()
  })

  it('leaves the reader where they were when a Source note is switched to Rendered', async () => {
    // A note this session has never shown, opened the way the app opens it: in
    // Source. Nothing is handed to the rendered pane, so nothing there is placed.
    await session.open('notes/long.md', LONG_NOTE)
    // The reader reads down the note in the source pane.
    session.source.visibleLine = READER_LINE

    // They switch to Rendered. The handoff carries the line across, so the pane
    // is planted a quarter of the way down the note rather than at its top.
    view.setMode('rendered')
    await settle()
    expect(session.rendered.writes).toEqual([{ kind: 'top', top: CARRIED_TO }])

    // The parse resolves and the pane is given the note. This is where the flag
    // armed at the activation used to be consumed: it wrote the top, after the
    // carry above, so the carry lost.
    session.rendered.givenADocument()
    await settle()

    // The position they were reading, named: line 101 of 401 is offset 1000.
    expect(session.rendered.scrollTop).toBe(CARRIED_TO)
    // And not the top of the note, which is what the stale flag wrote.
    expect(session.rendered.scrollTop).not.toBe(0)
    // Nothing followed the carry. The top is the whole of what was written.
    expect(session.rendered.writes).toEqual([{ kind: 'top', top: CARRIED_TO }])
  })

  it('places nothing when a note opens in Source, and leaves nothing armed for the next document', async () => {
    await session.open('notes/long.md', LONG_NOTE)
    await settle()
    // Two halves of one fact. The open placed nothing — the pane was not given
    // the note, so there was no arrival to place — and so it must have armed
    // nothing either: the flag exists to be consumed by an arrival, and one
    // that never comes is the defect. Armed, it waits for the next document
    // this pane is given.
    expect(session.rendered.writes).toEqual([])

    // Whatever the pane is showing is not this activation's to overwrite.
    session.rendered.scrollTop = READER_AT

    // That next document: one with no activation behind it at all — a reload
    // from disk, or a history restore. Nothing but a flag left over from the
    // Source open could write here.
    session.rendered.givenADocument()
    await settle()

    expect(session.rendered.writes).toEqual([])
    expect(session.rendered.scrollTop).toBe(READER_AT)
    expect(session.rendered.scrollTop).not.toBe(0)
  })

  it('still restores a line the note was left at in Source, into the rendered pane', async () => {
    const tabId = await session.open('notes/long.md', LONG_NOTE)
    // Read down the note, then leave it: the line is recorded from the pane that
    // was showing it.
    session.source.visibleLine = READER_LINE
    await session.open('notes/other.md', OTHER_NOTE)

    // Back to it, still in Source: the source pane is put back on the line.
    session.source.writes.length = 0
    await session.activate(tabId)
    // The restore is written a tick after the flush, when the pane holds the
    // note's text.
    await settle()
    expect(session.source.writes).toEqual([READER_LINE])

    // The switch to Rendered carries the SAME line. The note has a position, so
    // a position is what it gets — the fix must not have turned this note into
    // one that opens at its own top.
    session.rendered.writes.length = 0
    view.setMode('rendered')
    await settle()
    session.rendered.givenADocument()
    await settle()

    expect(session.rendered.writes).toEqual([
      { kind: 'top', top: CARRIED_TO },
      { kind: 'line', line: READER_LINE },
    ])
    expect(session.rendered.scrollTop).toBe(CARRIED_TO)
    expect(session.rendered.scrollTop).not.toBe(0)
  })

  it('still opens a never-shown note at its own top in Rendered, and restores it on the way back', async () => {
    // The other mode, and the other half of what must not change: the stored
    // default is Rendered here, so the activation leaves the live mode there and
    // the pane IS handed the note. The flag is armed exactly as it always was.
    view.setDefaultMode('rendered')

    const tabId = await session.open('notes/long.md', LONG_NOTE)
    session.rendered.givenADocument()
    await settle()
    expect(session.rendered.writes).toEqual([{ kind: 'top', top: 0 }])

    // The reader reads down it.
    session.rendered.scrollTop = CARRIED_TO

    // Away, and back.
    await session.open('notes/other.md', OTHER_NOTE)
    session.rendered.writes.length = 0
    await session.activate(tabId)
    session.rendered.givenADocument()
    await settle()

    // Line 101 of 401 — the position they left, not line 1.
    expect(session.rendered.writes).toEqual([{ kind: 'line', line: READER_LINE }])
  })
})
