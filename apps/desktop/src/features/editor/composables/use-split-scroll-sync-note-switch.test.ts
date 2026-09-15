import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { createApp, defineComponent, nextTick, watch, type App as VueApp } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { useTabsStore } from '../../../stores/tabs'
import { useViewStore } from '../../../stores/view'
import { noteFocusedPane, resetFocusedPane } from '../../../services/editor-ownership'
import { resetReadingLines } from '../model/reading-position'
import { useSplitScrollSync } from './use-split-scroll-sync'
import type { RenderedPaneHandoff } from './use-pane-handoff'
import type { SourcePaneExpose } from './use-source-pane-slot'

vi.mock('../../../platform/gateways/fs', () => ({
  fsService: {
    read: vi.fn().mockResolvedValue(''),
    write: vi.fn().mockResolvedValue(undefined),
    list: vi.fn().mockResolvedValue([]),
    stat: vi.fn().mockResolvedValue({ size: 0, mtimeMs: 0 }),
    listHistory: vi.fn().mockResolvedValue([]),
  },
}))

/**
 * A note switch with the default view set to `split` must not move the panes.
 *
 * `App.vue:58-63` puts the live mode back to the stored default on EVERY
 * `activeId` change, so a reader who had switched the live view to 渲染 gets a
 * `rendered → split` transition they never asked for. The split sync reads that
 * as an entry into split and aligns the panes — and the geometry it aligns from
 * is two documents at once: `outlineForSync()` reads `tabs.activeTab.content`
 * (the note ARRIVING) while the offsets it maps through are still the note
 * being LEFT's, which is what the rendered pane's DOM holds until its parse
 * resolves. The resulting offset is a place in neither note.
 *
 * The position is not merely wrong, it is also LOST: the reading-position
 * restore for the arriving note runs one tick earlier (its `activeId` watcher is
 * registered before the mode watcher, and both act after the flush), so the
 * correct position is written first and then overwritten here.
 *
 * The sibling watcher in the same flush already guards exactly this — see
 * `use-pane-handoff.ts`'s `documentSwitched` — and this file drives that
 * sequence through the real watchers rather than re-creating it: the app's own
 * `activeId → resetToDefault` line, the flag, the reading restore, and
 * `alignSplitPanes`.
 */

/** What CodeMirror measures a text line at when the DOM around it has no layout
 *  (`ui/EditorPane.handoff.test.ts` relies on the same number). */
const LINE_PX = 14

/** The source pane's own extent: 200 lines in a 400px viewport, so the range
 *  the mapping writes into is 2400px. */
const SOURCE_VIEWPORT_PX = 400
const SOURCE_CONTENT_PX = 200 * LINE_PX

/** Where the rendered pane sat in the note being LEFT, and where that note's
 *  headings are in rendered space. The rendered pane keeps this geometry across
 *  a note switch: its model is rebuilt only when the new note's parse resolves,
 *  which is later than the flush the align runs in. */
const LEFT_RENDERED_TOP = 1200
const LEFT_RENDERED_RANGE = 3000
const LEFT_NOTE_TOPS = [0, 400, 900]

/** The line the reader left the note being switched TO on, and the source
 *  offset that line sits at — the position the restore writes and the align
 *  must not overwrite. */
const LEFT_LINE = 5
const RESTORED_TOP = (LEFT_LINE - 1) * LINE_PX

/**
 * A 200-line note whose headings sit at the 0-based lines given — the numbering
 * `parseOutline` reports. Two notes with DIFFERENT heading lines and the SAME
 * heading count is what lets the align's mixed geometry land somewhere a
 * reader would never be, rather than being refused as mid-render.
 */
function note(label: string, headingLines0b: number[]): string {
  const lines = Array.from({ length: 200 }, (_, i) => `${label} body text on line ${i + 1}`)
  headingLines0b.forEach((at, index) => {
    lines[at] = `${'#'.repeat(index + 1)} ${label} section ${index + 1}`
  })
  return lines.join('\n')
}

/** The note being left. */
const NOTE_LEAVING = note('leaving', [0, 60, 140])
/** The note being switched to — its headings are at different lines, so the
 *  align's answer is derived from both documents at once. */
const NOTE_ARRIVING = note('arriving', [0, 80, 160])

interface SourcePaneDouble {
  pane: SourcePaneExpose
  scroller: HTMLElement
  /** Every program write the pane was handed, in order: the restore writes a
   *  LINE, the split align writes an offset (`kind: 'top'`). */
  writes: Array<{ kind: 'top'; top: number } | { kind: 'line'; line: number; top: number }>
}

/**
 * The source pane's own surface, holding the note ARRIVING.
 *
 * The text is set the moment the tab changes (that is what the reading restore
 * relies on), so this double is handed the arriving note — and the line-to-offset
 * measurement is the pane's own answer, modelled at a fixed line height because
 * happy-dom lays nothing out. A real `EditorView` is still created and published
 * through `getSourceView`, so the pane's contract is satisfied by the real type
 * rather than by a shape that happens to look like it.
 */
function makeSourcePane(): SourcePaneDouble {
  const view = new EditorView({ state: EditorState.create({ doc: NOTE_ARRIVING }) })
  Object.defineProperty(view.scrollDOM, 'clientHeight', { configurable: true, value: SOURCE_VIEWPORT_PX })
  Object.defineProperty(view.scrollDOM, 'scrollHeight', { configurable: true, value: SOURCE_CONTENT_PX })
  const writes: SourcePaneDouble['writes'] = []
  const write = (top: number): void => {
    // The pane clamps what it is handed into its own range, as the real one does.
    view.scrollDOM.scrollTop = Math.max(0, Math.min(top, SOURCE_CONTENT_PX - SOURCE_VIEWPORT_PX))
  }
  const pane: SourcePaneExpose = {
    // 1-based, fractional: the pane's visible line for the offset it holds.
    getVisibleLine: () => 1 + view.scrollDOM.scrollTop / LINE_PX,
    getVisibleUnit: () => 1,
    scrollTopForLine: (line) => (line - 1) * LINE_PX,
    getScrollTop: () => view.scrollDOM.scrollTop,
    getScrollRange: () => SOURCE_CONTENT_PX - SOURCE_VIEWPORT_PX,
    // The pane's ordinary program write: recorded here, because which write the
    // pane was handed LAST is the whole question this file asks.
    setScrollTop: (top) => {
      writes.push({ kind: 'top', top })
      write(top)
    },
    // The pane's measured write. happy-dom lays nothing out, so there is no
    // measure cycle to wait for: the double's offset is already final.
    setScrollTopForLine: (line) => {
      writes.push({ kind: 'line', line, top: (line - 1) * LINE_PX })
      write((line - 1) * LINE_PX)
    },
    setCaretLine: () => {},
    focus: () => {},
    getText: () => NOTE_ARRIVING,
    getSourceView: () => view,
    setMeasureSuppressed: () => {},
  }
  return { pane, scroller: view.scrollDOM, writes }
}

/** The rendered pane's handoff surface, holding the note being LEFT. Its model
 *  is not rebuilt until the arriving note's parse resolves, so the offsets it
 *  reports are that note's — which is what the align maps through. */
function makeRenderedPane(): RenderedPaneHandoff {
  return {
    getDocumentVersion: () => 0,
    getHeadingTops: () => LEFT_NOTE_TOPS,
    getScrollRange: () => LEFT_RENDERED_RANGE,
    getScrollTop: () => LEFT_RENDERED_TOP,
    setScrollTop: () => {},
    setScrollToLine: () => {},
    getCaretLine: () => null,
    setCaretLine: () => {},
    focus: () => {},
  }
}

let mounted: VueApp[] = []

describe('useSplitScrollSync across a note switch', () => {
  beforeEach(async () => {
    setActivePinia(createPinia())
    mounted = []
    resetReadingLines()
    // The user was reading in the source pane; in split mode that is what names
    // the pane the reading position is read from when a note is left.
    noteFocusedPane('source')

    const tabs = useTabsStore()
    tabs.setVault('/vault')
    await tabs.openTab('notes/leaving.md')
    await tabs.openTab('notes/arriving.md')
    for (const tab of tabs.tabs) {
      // `OpenTab.path` is `string | null` — an untitled tab has none — so the
      // test asks optionally and lets a pathless tab fall to the falsy branch,
      // rather than asserting a path this fixture happens to have.
      tab.content = tab.path?.endsWith('leaving.md') ? NOTE_LEAVING : NOTE_ARRIVING
    }
    // Start on the note being left.
    tabs.setActive(tabs.tabs.find((tab) => tab.path?.endsWith('leaving.md'))!.id)

    // Settings → Editor → default view on open = split (persisted), and the
    // live mode starts there.
    const view = useViewStore()
    view.setDefaultMode('split')
    view.setMode('split')
  })

  afterEach(() => {
    mounted.forEach((app) => app.unmount())
    mounted = []
    document.body.innerHTML = ''
    resetFocusedPane()
    resetReadingLines()
  })

  /** Mount the composable the way the pane does, with the app's own
   *  `activeId → resetToDefault` watcher (`App.vue:58-63`, three lines) ahead of
   *  it in registration order, exactly as the app shell registers it before the
   *  editor pane mounts. */
  function mount() {
    const rendered = makeRenderedPane()
    const source = makeSourcePane()
    const view = useViewStore()
    const tabs = useTabsStore()

    const harness: { api: ReturnType<typeof useSplitScrollSync> | null } = { api: null }
    const Harness = defineComponent({
      setup() {
        // App.vue: "A newly focused/open document starts in the configured
        // default view mode". This is what makes the mode change arrive with a
        // document switch.
        watch(
          () => tabs.activeId,
          () => {
            view.resetToDefault()
          },
        )
        harness.api = useSplitScrollSync({
          getSourcePane: () => source.pane,
          getRenderedPane: () => rendered,
          getPanesEl: () => document.body,
        })
        return () => null
      },
    })
    const host = document.createElement('div')
    document.body.appendChild(host)
    const app = createApp(Harness)
    app.mount(host)
    mounted.push(app)
    if (!harness.api) throw new Error('the pane did not mount')
    return { source, rendered, api: harness.api }
  }

  function tabId(path: string): string {
    const tabs = useTabsStore()
    return tabs.tabs.find((tab) => tab.path?.endsWith(path))!.id
  }

  it('keeps the reading position of the note being switched to, instead of aligning from the note being left', async () => {
    const { source } = mount()
    const tabs = useTabsStore()
    const view = useViewStore()

    // The reader visits the arriving note and leaves it on line 5 — the memory
    // the restore is armed from. Real path: the pane's own measurement is what
    // `leavingLine` records.
    tabs.setActive(tabId('arriving.md'))
    await nextTick()
    source.scroller.scrollTop = RESTORED_TOP
    expect(source.pane.getVisibleLine()).toBe(LEFT_LINE)

    tabs.setActive(tabId('leaving.md'))
    await nextTick()
    await nextTick()

    // …and the live view is switched to 渲染 by hand, so the note switch below
    // is the one that trips `App.vue`'s reset.
    view.setMode('rendered')
    await nextTick()

    const before = source.writes.length
    // Click the other note in the list.
    tabs.setActive(tabId('arriving.md'))
    await nextTick()
    await nextTick()

    // One write, and it is the restore: the reader is put back on the line they
    // left, and the align that came with the (unasked-for) mode change does not
    // overwrite it. Before the guard, a SECOND write landed here — an offset
    // derived from the note being left's 1200px rendered position through the
    // arriving note's own outline, i.e. 2320px, the middle of a note the reader
    // had left at its 5th line.
    expect(source.writes.slice(before)).toEqual([{ kind: 'line', line: LEFT_LINE, top: RESTORED_TOP }])
    expect(source.scroller.scrollTop).toBe(RESTORED_TOP)
    expect(source.pane.getVisibleLine()).toBe(LEFT_LINE)
  })

  it('still aligns the panes when the reader switches to 分栏 by hand', async () => {
    const { source } = mount()
    const view = useViewStore()

    // The reader is in 渲染 and clicks 分栏. No note switch: the geometry the
    // align reads belongs to the document on screen, which is the case the
    // align exists for.
    view.setMode('rendered')
    await nextTick()
    view.setMode('split')
    // Two ticks: the watcher arms the align, and the align itself runs after the
    // flush (`alignSplitPanes` is a layout move, not a scroll).
    await nextTick()
    await nextTick()

    // The rendered pane is 1200px into the note; its headings sit at 0/400/900
    // rendered and at lines 1/61/141 of the 200-line document. 300px into the
    // third heading's block (900 → 3000 rendered, lines 141 → 201) is 8.57
    // lines of it, i.e. source line 149.57 — whose own offset in the source
    // pane is 148 * 14 + 0.57 * 14 = 2080px.
    expect(source.writes).toEqual([{ kind: 'top', top: 2080 }])
    expect(source.scroller.scrollTop).toBe(2080)
  })

  it('writes nothing for a note that has no remembered position', async () => {
    const { source } = mount()
    const tabs = useTabsStore()
    const view = useViewStore()

    // A first visit in this session: nothing armed, nothing to restore.
    view.setMode('rendered')
    await nextTick()

    const before = source.writes.length
    tabs.setActive(tabId('arriving.md'))
    await nextTick()
    await nextTick()

    // The panes are left exactly as they were. An offset nobody asked for is
    // still a position the user has to undo.
    expect(source.writes.slice(before)).toEqual([])
    expect(source.scroller.scrollTop).toBe(0)
  })
})
