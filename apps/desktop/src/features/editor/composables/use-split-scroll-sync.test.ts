import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { createApp, defineComponent, nextTick, type App as VueApp } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { useAppearanceStore } from '../../../stores/appearance'
import { useTabsStore } from '../../../stores/tabs'
import { useViewStore } from '../../../stores/view'
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
 * A document whose headings are far enough apart that a jump cannot land on the
 * right one by accident, with the source line of each heading known:
 * `# One` at 0, `## Two` at 2, `## Three` at 4 — the 0-based lines
 * `parseOutline` reports, which is also what the outline publishes to the view
 * store when the user picks one.
 */
const DOC = '# One\n\n## Two\n\n## Three\n\nbody\n'
const HEADING_LINES_0B = [0, 2, 4]

function makeRenderedPane() {
  const writes: Array<{ line: number; token: number }> = []
  const pane: RenderedPaneHandoff = {
    getHeadingTops: () => [0, 400, 900],
    getScrollRange: () => 2000,
    getScrollTop: () => 0,
    setScrollTop: () => {},
    setScrollToLine: (line, token) => {
      writes.push({ line, token })
    },
    focus: () => {},
  }
  return { pane, writes }
}

/** Eight source lines. A real `EditorState`, so `doc.lines` and `doc.line(n)`
 *  are CodeMirror's own answers rather than a hand-rolled shape that could agree
 *  with a wrong assumption about them. */
const SOURCE_DOC = Array.from({ length: 8 }, (_, i) => `source ${i + 1}`).join('\n')

/** What CodeMirror measures a text line at when the DOM around it has no layout
 *  (`ui/EditorPane.handoff.test.ts` relies on the same number). */
const LINE_PX = 14

/**
 * A complete `SourcePaneExpose` — what the pane's `defineExpose` actually
 * offers, not only the part the outline jump reads. Declared as the interface,
 * so a member that drifts out of it is a compile error here rather than a
 * surprise at the one call site that uses it.
 *
 * The view is a real `EditorView` over a real `EditorState`: only the two
 * scroll metrics happy-dom reports as 0 (it performs no layout) are supplied,
 * which is the same thing `EditorPane.handoff.test.ts` does to the source
 * pane's own scroller.
 */
function makeSourcePane() {
  const view = new EditorView({ state: EditorState.create({ doc: SOURCE_DOC }) })
  Object.defineProperty(view.scrollDOM, 'clientHeight', { configurable: true, value: SOURCE_VIEWPORT_PX })
  Object.defineProperty(view.scrollDOM, 'scrollHeight', { configurable: true, value: 1000 })
  const pane: SourcePaneExpose = {
    getVisibleLine: () => 1,
    getVisibleUnit: () => 1,
    scrollTopForLine: (line) => (line - 1) * LINE_PX,
    getScrollTop: () => view.scrollDOM.scrollTop,
    getScrollRange: () => view.scrollDOM.scrollHeight - view.scrollDOM.clientHeight,
    setScrollTop: (top: number) => {
      view.scrollDOM.scrollTop = top
    },
    setCaretLine: () => {},
    focus: () => {},
    getText: () => SOURCE_DOC,
    getSourceView: () => view,
    setMeasureSuppressed: () => {},
  }
  return { pane, scroller: view.scrollDOM }
}

/** 90px, so a third of the viewport (30px) is smaller than the offset of the
 *  lines this file jumps to and the assertions are not all clamped to 0. */
const SOURCE_VIEWPORT_PX = 90

let mounted: VueApp[] = []

describe('useSplitScrollSync outline jumps', () => {
  beforeEach(async () => {
    setActivePinia(createPinia())
    mounted = []
    const tabs = useTabsStore()
    tabs.setVault('/vault')
    await tabs.openTab('notes/a.md')
    tabs.activeTab!.content = DOC
    useAppearanceStore().setAutoSyncScroll(true)
  })

  afterEach(() => {
    mounted.forEach((app) => app.unmount())
    mounted = []
    document.body.innerHTML = ''
  })

  /** Mount the composable the way the pane does — inside a component — and hand
   *  back the fakes it was wired to. */
  function mount(mode: 'rendered' | 'source') {
    const rendered = makeRenderedPane()
    const source = makeSourcePane()
    const view = useViewStore()
    view.setMode(mode)

    // The composable hands its API back from `setup`, so the harness carries it
    // out in a holder rather than widening it back through a cast.
    const harness: { api: ReturnType<typeof useSplitScrollSync> | null } = { api: null }
    const Harness = defineComponent({
      setup() {
        harness.api = useSplitScrollSync({
          getSourcePane: () => source.pane,
          getRenderedPane: () => rendered.pane,
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
    return { api: harness.api, rendered, source }
  }

  it('jumps the rendered pane to the heading that was picked, not the one above it', async () => {
    const { rendered } = mount('rendered')
    const view = useViewStore()

    // "## Three" — the outline's own numbering: line 4 of the document, i.e. the
    // fifth line. Read as a 1-based line this names the block that starts at the
    // fourth line, which is still Three's, but read against the wrong heading it
    // landed a whole section early (measured in a browser: picking Section B put
    // Section A at the top of the pane).
    view.requestOutlineTarget({ line: HEADING_LINES_0B[2], index: 2 })
    await nextTick()
    await nextTick()

    expect(rendered.writes).toHaveLength(1)
    expect(rendered.writes[0].line).toBe(5)
  })

  it('jumps to the first heading for a pick on the document’s first line', async () => {
    const { rendered } = mount('rendered')
    useViewStore().requestOutlineTarget({ line: HEADING_LINES_0B[0], index: 0 })
    await nextTick()
    await nextTick()

    expect(rendered.writes[0].line).toBe(1)
  })

  it('scrolls the source pane to the picked heading’s own line — unchanged', async () => {
    const { source } = mount('source')
    useViewStore().requestOutlineTarget({ line: HEADING_LINES_0B[2], index: 2 })
    await nextTick()
    await nextTick()

    // "## Three" is line 5 of 8. The source path was never off by one: it read
    // the store's index as an offset (`doc.line(index + 1)`) and its own clamp
    // made that the same line a 1-based argument names, so this is a regression
    // guard on a position that must not move when the rendered path is
    // corrected. Line 5 sits at 4 * 14px, lifted by a third of the viewport (30).
    expect(source.scroller.scrollTop).toBe(26)
  })
})
