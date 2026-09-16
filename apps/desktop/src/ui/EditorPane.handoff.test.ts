import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { createApp, defineComponent, h, nextTick, watch, type App as VueApp } from 'vue'
import { createPinia, setActivePinia, type Pinia } from 'pinia'
import { EditorView } from '@codemirror/view'
import { TextSelection } from '@milkdown/prose/state'
import { useAppearanceStore } from '../stores/appearance'
import { useTabsStore } from '../stores/tabs'
import { useViewStore } from '../stores/view'
import { parseOutline } from '../services/outline'
import { countDocumentLines } from '../services/scroll-sync-anchors'
import { editorSessionManager } from '../features/editor'
import { renderedTopFor } from '../features/editor/controller/pane-scroll-mapping'

// `vi.mock` is hoisted above every top-level binding, so the note the mocked fs
// hands back has to be reachable from inside the factory.
const note = vi.hoisted(() => ({ content: '' }))

vi.mock('../platform/gateways/fs', () => ({
  fsService: {
    read: vi.fn(() => Promise.resolve(note.content)),
    write: vi.fn(),
    list: vi.fn(),
    watch: vi.fn(),
    deleteFile: vi.fn(),
    stat: vi.fn(),
    listHistory: vi.fn().mockResolvedValue([]),
    readHistory: vi.fn(),
    restoreHistory: vi.fn(),
    openFolderDialog: vi.fn(),
    saveFileDialog: vi.fn(),
    onFsChange: vi.fn(),
    listTrash: vi.fn(),
    restoreFromTrash: vi.fn(),
    saveAttachment: vi.fn(),
    importAttachment: vi.fn(),
    resolveMediaPath: vi.fn(),
  },
}))

import EditorPane from './EditorPane.vue'

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

/** 63 lines with headings at 1, 22 and 43 (same shape as the split-scroll
 *  tests): the two panes lay it out at very different heights, so "where you
 *  were" cannot be carried across by proportion. */
const HEADED =
  ['# One', '', ...body(), '', '## Two', '', ...body(), '', '## Three', '', ...body()].join('\n') +
  '\n'
function body(): string[] {
  return Array.from({ length: 18 }, (_, i) => `body ${i + 1}`)
}
/** Source line of each heading, 1-based. */
const HEADING_LINES = [1, 22, 43]

// CodeMirror measures text lines at a fixed 14px when the DOM around it has no
// layout (happy-dom performs none), so the source pane's geometry is exactly
// (line - 1) * 14 — the same convention the split-scroll tests use.
const LINE_PX = 14
/** Content-space tops the rendered headings would have. */
const HEADING_TOPS = [100, 700, 1300]
const SOURCE_RANGE = 954 // 63 lines * 14px, in a 400px viewport
const RENDERED_RANGE = 1600
const METRICS = {
  source: { scrollHeight: SOURCE_RANGE + 400, clientHeight: 400 },
  rendered: { scrollHeight: RENDERED_RANGE + 400, clientHeight: 400 },
}

const sourceTopOfLine = (line: number): number => (line - 1) * LINE_PX

/** The rendered pane's ProseMirror view, named so a stubbed member can be typed
 *  as the real thing rather than asserted into place. */
type PmView = NonNullable<ReturnType<typeof editorSessionManager.getView>>

let pinia: Pinia
let mounted: VueApp[] = []

function fakeScrollMetrics(el: HTMLElement, scrollHeight: number, clientHeight: number): void {
  Object.defineProperty(el, 'scrollHeight', { configurable: true, value: scrollHeight })
  Object.defineProperty(el, 'clientHeight', { configurable: true, value: clientHeight })
}

/**
 * happy-dom performs no layout, so every scroll container reports a zero range
 * — and a restore would be clamped to 0 for a reason that has nothing to do
 * with the handoff. The rendered pane's element can be patched per test, but
 * the source pane's scroller is created by CodeMirror inside an async component
 * at a moment no test can hook, so the range is supplied by class for the whole
 * file. Same numbers the split-scroll tests use.
 */
function installScrollerMetrics(): void {
  const proto = HTMLElement.prototype
  for (const [name, value] of [
    ['scrollHeight', SOURCE_RANGE + 400],
    ['clientHeight', 400],
  ] as const) {
    Object.defineProperty(proto, name, {
      configurable: true,
      get(this: HTMLElement) {
        return this.classList?.contains('cm-scroller') ? value : 0
      },
    })
  }
}

function restoreScrollerMetrics(): void {
  for (const name of ['scrollHeight', 'clientHeight'] as const) {
    delete (HTMLElement.prototype as unknown as Record<string, unknown>)[name]
  }
}

/** The rendered headings get the content-space offsets the browser would give
 *  them, reported the way getBoundingClientRect does — relative to the viewport,
 *  so they travel with the pane's scroll. */
function fakeHeadingTops(rendered: HTMLElement, tops: number[]): void {
  const headings = rendered.querySelectorAll('h1, h2, h3, h4, h5, h6')
  expect(headings.length).toBe(tops.length)
  headings.forEach((heading, index) => {
    heading.getBoundingClientRect = () =>
      ({
        x: 0,
        y: tops[index] - rendered.scrollTop,
        width: 0,
        height: 0,
        top: tops[index] - rendered.scrollTop,
        right: 0,
        bottom: 0,
        left: 0,
        toJSON: () => ({}),
      }) as DOMRect
  })
}

/** A scroll the user made: the element moves, then reports it. */
function userScroll(el: HTMLElement, top: number): void {
  el.scrollTop = top
  el.dispatchEvent(new Event('scroll'))
}

function sourceViewOf(host: HTMLElement): EditorView {
  const scroller = host.querySelector<HTMLElement>('.pane.source .cm-scroller')
  if (!scroller) throw new Error('the source pane is not mounted')
  const cm = EditorView.findFromDOM(scroller)
  if (!cm) throw new Error('the source pane has no CodeMirror view')
  return cm
}

/** The 1-based line the CodeMirror caret sits on. */
function caretLineOf(cm: EditorView): number {
  return cm.state.doc.lineAt(cm.state.selection.main.head).number
}

const focusIn = (selector: string): boolean => {
  const active = document.activeElement
  return active !== null && active.closest(selector) !== null
}

describe('EditorPane mode handoff', () => {
  beforeEach(() => {
    pinia = createPinia()
    setActivePinia(pinia)
    // The split-scroll tests' defaults: scrolling the source pane in split mode
    // syncs the rendered pane, which would mask what the handoff itself does.
    useAppearanceStore().setAutoSyncScroll(true)
    installScrollerMetrics()
    document.body.innerHTML = ''
    mounted = []
  })

  afterEach(() => {
    mounted.forEach((app) => app.unmount())
    mounted = []
    restoreScrollerMetrics()
    document.body.innerHTML = ''
  })

  async function mountPane(
    mode: 'rendered' | 'source' | 'split',
    /** The document to open. The caret cases need their own: `HEADED` joins its
     *  paragraphs with hard breaks, so eighteen of its lines are one model
     *  block, and a test that names a block has to know which line it came from. */
    doc: string = HEADED,
  ): Promise<HTMLElement> {
    const tabs = useTabsStore()
    tabs.setVault('/vault')
    note.content = doc
    await tabs.openTab('notes/a.md')
    const host = document.createElement('div')
    document.body.appendChild(host)
    await import('../view/SourcePane.vue')
    const app = createApp(EditorPane)
    app.use(pinia)
    app.mount(host)
    mounted.push(app)
    await flush()

    const view = useViewStore()
    if (mode !== 'rendered') view.setMode(mode)
    if (mode !== 'rendered') {
      for (let i = 0; i < 40; i += 1) {
        await flush()
        if (host.querySelector('.pane.source .cm-scroller')) break
      }
    }
    await nextTick()

    const rendered = host.querySelector<HTMLElement>('.pane.rendered')
    expect(rendered).not.toBeNull()
    fakeScrollMetrics(rendered!, METRICS.rendered.scrollHeight, METRICS.rendered.clientHeight)
    fakeHeadingTops(rendered!, HEADING_TOPS)
    if (mode !== 'rendered') {
      const scroller = host.querySelector<HTMLElement>('.pane.source .cm-scroller')
      expect(scroller).not.toBeNull()
      fakeScrollMetrics(scroller!, METRICS.source.scrollHeight, METRICS.source.clientHeight)
    }
    await nextTick()
    return host
  }

  it('渲染 → 源码 lands on the line the rendered pane was showing, with the caret there', async () => {
    const host = await mountPane('rendered')
    const rendered = host.querySelector<HTMLElement>('.pane.rendered')!
    // The user scrolls to the top of the second heading (rendered offset 700).
    userScroll(rendered, HEADING_TOPS[1])
    await nextTick()

    // …and clicks 源码.
    const view = useViewStore()
    view.setMode('source')
    for (let i = 0; i < 40; i += 1) {
      await flush()
      if (host.querySelector('.pane.source .cm-scroller')) break
    }
    await nextTick()

    const cm = sourceViewOf(host)
    expect(caretLineOf(cm)).toBe(HEADING_LINES[1])
    expect(cm.scrollDOM.scrollTop).toBeCloseTo(sourceTopOfLine(HEADING_LINES[1]), 3)
  })

  it('源码 → 渲染 lands on the rendered block of the source line', async () => {
    const host = await mountPane('source')
    const cm = sourceViewOf(host)
    // The user scrolls the source pane to the top of the second heading.
    userScroll(cm.scrollDOM, sourceTopOfLine(HEADING_LINES[1]))
    await nextTick()

    useViewStore().setMode('rendered')
    await nextTick()
    await flush()

    const rendered = host.querySelector<HTMLElement>('.pane.rendered')!
    // Within a few pixels rather than exact: the source pane reports the line
    // its viewport starts on one pixel in (see `getVisibleLine`), and that
    // fraction of a source line is a couple of rendered pixels.
    expect(Math.abs(rendered.scrollTop - HEADING_TOPS[1])).toBeLessThan(5)
  })

  it('hands the keyboard to the pane the switch opened', async () => {
    const host = await mountPane('rendered')
    // A real click focuses the switch button first — that is the state the
    // defect leaves the app in (measured in a browser: `activeElement` is the
    // `.switch-option` button after the click).
    const button = document.createElement('button')
    button.className = 'switch-option'
    const switchEl = document.createElement('div')
    switchEl.className = 'view-switch'
    switchEl.setAttribute('data-view-switch', '')
    switchEl.appendChild(button)
    document.body.appendChild(switchEl)
    button.focus()
    expect(document.activeElement).toBe(button)

    useViewStore().setMode('source')
    for (let i = 0; i < 40; i += 1) {
      await flush()
      if (host.querySelector('.pane.source .cm-scroller')) break
    }
    await nextTick()

    expect(focusIn('[data-testid="source-pane"]')).toBe(true)

    // …and back to the rendered pane.
    useViewStore().setMode('rendered')
    await nextTick()
    await flush()
    expect(focusIn('.pane.rendered')).toBe(true)
  })

  it('leaves the keyboard alone when the mode changes from somewhere else', async () => {
    const host = await mountPane('rendered')
    const elsewhere = document.createElement('input')
    document.body.appendChild(elsewhere)
    elsewhere.focus()

    useViewStore().setMode('source')
    for (let i = 0; i < 40; i += 1) {
      await flush()
      if (host.querySelector('.pane.source .cm-scroller')) break
    }
    await nextTick()

    // Focus was in the sidebar search box, the palette, a dialog: the editor
    // must not take it.
    expect(document.activeElement).toBe(elsewhere)
  })

  it('does not re-place the source pane when the split view is left for it', async () => {
    const host = await mountPane('split')
    const cm = sourceViewOf(host)
    userScroll(cm.scrollDOM, sourceTopOfLine(HEADING_LINES[2]))
    await nextTick()
    const before = cm.scrollDOM.scrollTop
    expect(before).toBeGreaterThan(0)

    useViewStore().setMode('source')
    await nextTick()
    await flush()

    // The pane was already on screen and is the place the user was working:
    // nothing about it may move.
    expect(sourceViewOf(host).scrollDOM.scrollTop).toBeCloseTo(before, 3)
  })

  it('does not carry a position into a document that just opened', async () => {
    useAppearanceStore().setAutoSyncScroll(true)
    const host = await mountPane('source')
    const cm = sourceViewOf(host)
    userScroll(cm.scrollDOM, sourceTopOfLine(HEADING_LINES[2]))
    await nextTick()

    // Another note is opened. App.vue puts the live mode back to its default
    // from a watcher on the active tab, i.e. in the same flush as the switch —
    // a mode change too, but not a pane switch.
    const tabs = useTabsStore()
    note.content = '# Another note\n\nshort\n'
    const host2 = document.createElement('div')
    document.body.appendChild(host2)
    const app = createApp(
      defineComponent({
        setup() {
          watch(() => useTabsStore().activeId, () => useViewStore().resetToDefault())
          return () => h('div')
        },
      }),
    )
    app.use(pinia)
    app.mount(host2)
    mounted.push(app)
    await tabs.openTab('notes/b.md')
    await nextTick()
    await flush()

    const rendered = host.querySelector<HTMLElement>('.pane.rendered')!
    expect(rendered.scrollTop).toBe(0)
  })

  // The caret is the other half of "where the user was", and it travels
  // independently of the viewport: the two questions ("what am I looking at" and
  // "where would my next keystroke go") have two different answers, and a switch
  // that answers the first by overwriting the second puts the user's text
  // somewhere they were not. Measured in a browser before this: caret on
  // paragraph 6, switch to source, type `QQ`, and the note began `QQ# Welcome`.
  describe('the caret', () => {
    /** `count` single-line paragraphs, blank-line separated, as source lines. */
    function spaced(name: string, count: number): string[] {
      const out: string[] = []
      for (let i = 0; i < count; i += 1) {
        if (i > 0) out.push('')
        out.push(`${name} ${i + 1}`)
      }
      return out
    }

    /**
     * The same shape as `HEADED` but with blank lines between the paragraphs —
     * `HEADED` joins them with hard breaks, so its eighteen lines are ONE model
     * block. Here every block is one source line, which is what lets a test name
     * a block and a line for the same paragraph.
     */
    const CARET_DOC =
      [
        '# One',
        '',
        ...spaced('one', 18),
        '',
        '## Two',
        '',
        ...spaced('two', 18),
        '',
        '## Three',
        '',
        ...spaced('three', 18),
        '',
      ].join('\n')

    /** The source line each top-level block came from, in document order — the
     *  k-th non-blank line is the k-th block, for this fixture. */
    const BLOCK_LINES = CARET_DOC.split('\n')
      .map((text, index) => ({ text, line: index + 1 }))
      .filter(({ text }) => text.trim() !== '')
      .map(({ line }) => line)

    /**
     * Model the rendered pane's layout, which happy-dom does not perform.
     *
     * The model IS the line→offset mapping applied to the view, anchored on the
     * same heading tops this file already fakes: block k measures at the offset
     * `renderedTopFor` gives for the source line block k came from. That makes
     * the round trip exact by construction, which is what this level is for —
     * it proves the WIRING (the pane reads its caret, the handoff carries it,
     * the other pane plants it), while `pane-scroll-mapping.test.ts` owns the
     * arithmetic and the browser checks the arithmetic against a real layout.
     */
    /**
     * The rendered pane's live view and scroll box, or a loud failure.
     *
     * The layout below is installed on both, so a test that reached here without
     * them would be measuring nothing — which is why they are established by a
     * throw rather than by an assertion: `expect(...).not.toBeNull()` tells the
     * reader but not the compiler, and what the compiler cannot see here is the
     * same thing the test cannot actually rely on. The sibling `sourceViewOf`
     * throws for the same reason.
     */
    function renderedView(): PmView {
      const view = editorSessionManager.getView()
      if (!view) throw new Error('the rendered pane has no editor')
      return view
    }

    function renderedPaneOf(host: HTMLElement): { view: PmView; pane: HTMLElement } {
      const pane = host.querySelector<HTMLElement>('.pane.rendered')
      if (!pane) throw new Error('the rendered pane is not mounted')
      return { view: renderedView(), pane }
    }

    function installRenderedLayout(host: HTMLElement): void {
      const { view, pane } = renderedPaneOf(host)
      const items = parseOutline(CARET_DOC)
      const totalLines = countDocumentLines(CARET_DOC)
      expect(items).toHaveLength(HEADING_TOPS.length)
      view.coordsAtPos = (pos: number) => {
        const block = view.state.doc.resolve(pos).index(0)
        // `coordsAtPos` reports VIEWPORT coordinates — the content offset less
        // wherever the pane is scrolled — which is what makes the pane's own
        // conversion back to content space (`+ scrollTop`) meaningful, and what
        // the real one does. Read per call: the cases below scroll the pane
        // between placing the caret and reading it.
        const top =
          renderedTopFor(BLOCK_LINES[block] ?? 1, items, HEADING_TOPS, totalLines, RENDERED_RANGE) -
          pane.scrollTop
        return { left: 0, right: 0, top, bottom: top + 10 }
      }
    }

    /** Put the rendered caret inside the block at `index`, the way a click does,
     *  and hand back the source line that block came from. */
    async function caretIntoRenderedBlock(index: number): Promise<number> {
      const view = renderedView()
      expect(view.state.doc.childCount).toBe(BLOCK_LINES.length)
      let pos = 0
      for (let i = 0; i < index; i += 1) pos += view.state.doc.child(i).nodeSize
      view.dispatch(
        view.state.tr.setSelection(
          TextSelection.create(view.state.doc, Math.min(pos + 1, view.state.doc.content.size)),
        ),
      )
      await nextTick()
      return BLOCK_LINES[index]
    }

    /** The text the block at `index` was made from. */
    function blockText(index: number): string {
      return CARET_DOC.split('\n')[BLOCK_LINES[index] - 1]
    }

    /** The text of the rendered block the caret is in. */
    function renderedCaretBlock(): string {
      const view = renderedView()
      return view.state.doc.resolve(view.state.selection.head).parent.textContent
    }

    it('渲染 → 源码 puts the caret where the user was typing, not at the top', async () => {
      const host = await mountPane('rendered', CARET_DOC)
      installRenderedLayout(host)
      // `one 12` — the twelfth paragraph of the first section.
      const line = await caretIntoRenderedBlock(12)
      expect(blockText(12)).toBe('one 12')

      useViewStore().setMode('source')
      for (let i = 0; i < 40; i += 1) {
        await flush()
        if (host.querySelector('.pane.source .cm-scroller')) break
      }
      await nextTick()

      // On the line the caret was on. Before this the source caret was planted
      // on whatever line the VIEWPORT started at, which is the same thing only
      // when the user happens to be looking at the top of the pane.
      expect(caretLineOf(sourceViewOf(host))).toBe(line)
      expect(line).not.toBe(1)
    })

    it('carries the caret and the viewport as two different positions', async () => {
      const host = await mountPane('rendered', CARET_DOC)
      installRenderedLayout(host)
      // The user is typing at the top of the note but has scrolled down to read
      // the third section — which is exactly the state one position cannot
      // describe, and the one an implementation that follows the scroll alone
      // silently rewrites.
      const line = await caretIntoRenderedBlock(1)
      const rendered = host.querySelector<HTMLElement>('.pane.rendered')!
      userScroll(rendered, HEADING_TOPS[2])
      await nextTick()

      useViewStore().setMode('source')
      for (let i = 0; i < 40; i += 1) {
        await flush()
        if (host.querySelector('.pane.source .cm-scroller')) break
      }
      await nextTick()

      const cm = sourceViewOf(host)
      expect(caretLineOf(cm)).toBe(line)
      // …and the viewport is still showing the third section, so the reading
      // position survives the switch too.
      expect(cm.scrollDOM.scrollTop).toBeGreaterThan(sourceTopOfLine(HEADING_LINES[2]))
    })

    /**
     * The source line of `## Two`, the block `HEADING_TOPS[1]` anchors.
     *
     * Read from `BLOCK_LINES` rather than `HEADING_LINES`, which belongs to
     * `HEADED`: that fixture joins its paragraphs with hard breaks and this one
     * separates them with blank lines, so the two documents put their headings
     * on different lines and only the derived list names this one's.
     */
    const SECOND_HEADING = 19

    it('a document nobody has clicked into carries no caret', async () => {
      const host = await mountPane('rendered', CARET_DOC)
      installRenderedLayout(host)
      // The user scrolls down to read and never puts the caret anywhere: the
      // model's selection is still the one ProseMirror chose on load, which is
      // the end of the document and not a place the user was. The switch has to
      // hand over the reading position and nothing else.
      const rendered = host.querySelector<HTMLElement>('.pane.rendered')!
      userScroll(rendered, HEADING_TOPS[1])
      await nextTick()

      useViewStore().setMode('source')
      for (let i = 0; i < 40; i += 1) {
        await flush()
        if (host.querySelector('.pane.source .cm-scroller')) break
      }
      await nextTick()

      expect(caretLineOf(sourceViewOf(host))).toBe(BLOCK_LINES[SECOND_HEADING])
    })

    it('源码 → 渲染 puts the caret back on the line the source caret left', async () => {
      const host = await mountPane('source', CARET_DOC)
      installRenderedLayout(host)
      const cm = sourceViewOf(host)
      const target = BLOCK_LINES[27]
      // The user puts the caret on a line in the second section, well away from
      // the document's start, then switches to the rendered pane.
      cm.dispatch({ selection: { anchor: cm.state.doc.line(target).from } })
      await nextTick()

      useViewStore().setMode('rendered')
      await nextTick()
      await flush()

      // The rendered pane carries its model across the switch, so the caret it
      // shows is the one that was carried INTO it rather than wherever it
      // happened to be left.
      expect(renderedCaretBlock()).toBe(blockText(27))
    })
  })

  /**
   * The reported defect, in the user's own shape: three unheaded short
   * paragraphs, the caret in the third, switch to rendered, type — and the text
   * landed in the FIRST paragraph.
   *
   * Both things that made it a short-note defect are here and nowhere else in
   * this file: the note has no headings, so the line↔offset mapping has no
   * anchors and falls back to the pane's SCROLLABLE extent, and the note is
   * shorter than the pane, so that extent is 0. Every line then maps to the top
   * of the pane, and the caret's own paragraph is discarded by the conversion
   * meant to carry it.
   *
   * No rendered layout is installed, and that is the point of the fix rather than
   * an omission: the caret's route through the note's own blocks reads positions
   * and the note's text, so it needs no measurement — which is also the state the
   * handoff reads a caret in, its own flush being what hides the pane.
   */
  describe('the caret on a note shorter than its pane', () => {
    /** The user's note: three short paragraphs, no headings anywhere. */
    const SHORT = 'first paragraph\n\nsecond paragraph\n\nthird paragraph\n'
    /** Its paragraphs, in document order, and the source line each is on. */
    const PARAGRAPHS = ['first paragraph', 'second paragraph', 'third paragraph']
    const PARAGRAPH_LINES = [1, 3, 5]
    /** Taller than the note, so the rendered pane has nothing to scroll. */
    const PANE_PX = 600
    /** What one top-level block measures in the layout installed below. */
    const BLOCK_PX = 140

    async function mountShortNote(mode: 'source' | 'rendered'): Promise<HTMLElement> {
      const tabs = useTabsStore()
      tabs.setVault('/vault')
      note.content = SHORT
      await tabs.openTab('notes/short.md')
      const host = document.createElement('div')
      document.body.appendChild(host)
      await import('../view/SourcePane.vue')
      const app = createApp(EditorPane)
      app.use(pinia)
      app.mount(host)
      mounted.push(app)
      await flush()

      const view = useViewStore()
      if (mode !== 'rendered') view.setMode(mode)
      if (mode !== 'rendered') {
        for (let i = 0; i < 40; i += 1) {
          await flush()
          if (host.querySelector('.pane.source .cm-scroller')) break
        }
      }
      await nextTick()

      const rendered = host.querySelector<HTMLElement>('.pane.rendered')
      expect(rendered).not.toBeNull()
      // Nothing to scroll: the extent the fallback ratio divides by is 0.
      fakeScrollMetrics(rendered!, PANE_PX, PANE_PX)
      // …and there are no headings to anchor on either.
      fakeHeadingTops(rendered!, [])
      if (mode !== 'rendered') {
        const scroller = host.querySelector<HTMLElement>('.pane.source .cm-scroller')
        expect(scroller).not.toBeNull()
        fakeScrollMetrics(scroller!, METRICS.source.scrollHeight, METRICS.source.clientHeight)
      }
      await nextTick()
      return host
    }

    function renderedView(): PmView {
      const view = editorSessionManager.getView()
      if (!view) throw new Error('the rendered pane has no editor')
      return view
    }

    /**
     * Positions laid out the way a document of one-line paragraphs is: one
     * `BLOCK_PX` per top-level block, reported the way the browser reports them
     * — relative to the viewport, so they travel with the pane's scroll.
     *
     * Installed for the PRE-FIX half of these cases as much as for the fixed one.
     * happy-dom performs no layout, and a mapping that reads zeroes for every
     * block happens to land in the LAST one — which is the paragraph these cases
     * expect — so without a layout they would "pass" against the code they
     * indict. With it, the pre-fix ratio (offset 0, for a pane with nothing to
     * scroll) puts the caret in the first block, which is the reported defect.
     */
    function installShortLayout(host: HTMLElement): void {
      const view = renderedView()
      const pane = host.querySelector<HTMLElement>('.pane.rendered')!
      const blockTop = (pos: number): number =>
        view.state.doc
          .resolve(Math.max(0, Math.min(pos, view.state.doc.content.size)))
          .index(0) * BLOCK_PX
      view.coordsAtPos = ((pos: number) => ({
        left: 0,
        right: 0,
        top: blockTop(pos) - pane.scrollTop,
        bottom: blockTop(pos) + BLOCK_PX - pane.scrollTop,
      })) as typeof view.coordsAtPos
    }

    /** The text of the rendered block the caret is in. */
    function caretBlock(): string {
      const view = renderedView()
      return view.state.doc.resolve(view.state.selection.head).parent.textContent
    }

    /** Put the rendered caret inside the block at `index`, the way a click does. */
    async function caretInto(index: number): Promise<void> {
      const view = renderedView()
      let pos = 0
      for (let i = 0; i < index; i += 1) pos += view.state.doc.child(i).nodeSize
      view.dispatch(
        view.state.tr.setSelection(
          TextSelection.create(view.state.doc, Math.min(pos + 1, view.state.doc.content.size)),
        ),
      )
      await nextTick()
    }

    it('源码 → 渲染 types where the source caret was, not in the first paragraph', async () => {
      const host = await mountShortNote('source')
      installShortLayout(host)
      const cm = sourceViewOf(host)
      // The user's caret: the third paragraph, source line 5.
      cm.dispatch({ selection: { anchor: cm.state.doc.line(PARAGRAPH_LINES[2]).from } })
      await nextTick()

      useViewStore().setMode('rendered')
      await nextTick()
      await flush()

      expect(caretBlock()).toBe(PARAGRAPHS[2])
      // …and the next keystroke lands there, which is the thing the user saw go
      // wrong: the text arrived in the first paragraph instead.
      const view = renderedView()
      view.dispatch(view.state.tr.insertText('!', view.state.selection.head))
      expect(caretBlock()).toContain(PARAGRAPHS[2])
      expect(view.state.doc.child(0).textContent).toBe(PARAGRAPHS[0])
    })

    it('渲染 → 源码 carries the caret back to the paragraph it was in', async () => {
      const host = await mountShortNote('rendered')
      installShortLayout(host)
      await caretInto(2)
      expect(caretBlock()).toBe(PARAGRAPHS[2])

      useViewStore().setMode('source')
      for (let i = 0; i < 40; i += 1) {
        await flush()
        if (host.querySelector('.pane.source .cm-scroller')) break
      }
      await nextTick()

      expect(caretLineOf(sourceViewOf(host))).toBe(PARAGRAPH_LINES[2])
    })
  })
})
