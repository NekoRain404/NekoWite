import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { basicPlugins, createEditor, type NekoEditor } from '@nekowite/editor-core'
import { TextSelection } from '@milkdown/prose/state'
import { useTabsStore } from '../../../stores/tabs'
import { useViewStore } from '../../../stores/view'
import { createEditorScrollSync } from './editor-scroll-sync'

vi.mock('../../../platform/gateways/fs', () => ({
  fsService: {
    read: vi.fn().mockResolvedValue('# Welcome\n\nbody'),
    write: vi.fn().mockResolvedValue(undefined),
    saveFileDialog: vi.fn().mockResolvedValue(null),
  },
}))

function makeScrollEl() {
  return {
    scrollTop: 0,
    scrollHeight: 1000,
    clientHeight: 200,
    getBoundingClientRect: () => ({ top: 0, left: 0, width: 0, height: 0 }),
  }
}

/** An engine that snaps a scroll offset to whole pixels, as browsers do: the
 *  value an assignment asks for is not always the value the engine keeps, so a
 *  write of 500.5 lands on 501. happy-dom stores exactly what it is handed,
 *  which is why this boundary needs a fake of its own. */
function makeSnappingScrollEl() {
  let stored = 0
  const el = {
    scrollHeight: 1000,
    clientHeight: 200,
    get scrollTop(): number {
      return stored
    },
    set scrollTop(next: number) {
      stored = Math.round(next)
    },
    getBoundingClientRect: () => ({ top: 0, left: 0, width: 0, height: 0 }),
  }
  return {
    el,
    /** Move the pane the way the user's own scrolling does: a position nothing
     *  in this code asked for, so nothing may claim it as its echo. */
    userScrollTo: (next: number): void => {
      stored = next
    },
  }
}

/** A rendered heading positioned at `top`, reported the way the browser does it:
 *  relative to the viewport, so it moves with the pane's scroll. */
function makeHeading(top: number): HTMLElement {
  const el = document.createElement('h2')
  el.getBoundingClientRect = () => ({ top, left: 0, width: 0, height: 0 }) as DOMRect
  return el
}

function makeEditorEl(headings: number[]): HTMLElement {
  const root = document.createElement('div')
  headings.forEach((top) => root.appendChild(makeHeading(top)))
  return root
}

describe('editorScrollSync', () => {
  let tabs: ReturnType<typeof useTabsStore>
  let view: ReturnType<typeof useViewStore>

  beforeEach(async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    tabs = useTabsStore()
    view = useViewStore()
    tabs.setVault('/vault')
    await tabs.openTab('welcome.md')
  })

  it('writes a programmatic position and consumes the echo it produces', () => {
    const el = makeScrollEl()
    const scrollSync = createEditorScrollSync({
      getScrollEl: () => el as unknown as HTMLElement,
      getEditorEl: () => null,
    })

    scrollSync.setScrollTop(400, 7)
    expect(el.scrollTop).toBe(400)
    // The write's scroll event reports the position it wrote: the program's own
    // echo, so it is not a user scroll (no sync request either way). It IS where
    // the pane is, though, and that is what the store's memory records — a mode
    // switch has to put the pane back where it ended up, not where the user last
    // left it.
    expect(scrollSync.onScroll()).toBe(false)
    expect(view.renderedScroll.top).toBe(400)
  })

  it('mirrors a scroll the program did not write into the store', () => {
    const el = makeScrollEl()
    const scrollSync = createEditorScrollSync({
      getScrollEl: () => el as unknown as HTMLElement,
      getEditorEl: () => null,
    })

    scrollSync.setScrollTop(400, 1)
    el.scrollTop = 120 // the user grabbed the pane before the echo arrived
    expect(scrollSync.onScroll()).toBe(true)
    expect(view.renderedScroll.top).toBe(120)
  })

  it('does not let a write that never moved the pane swallow the next user scroll', () => {
    const el = makeScrollEl()
    const scrollSync = createEditorScrollSync({
      getScrollEl: () => el as unknown as HTMLElement,
      getEditorEl: () => null,
    })

    // A no-op write fires no scroll event at all, so nothing will ever match
    // its record — the user's next scroll must still count as theirs.
    el.scrollTop = 400
    scrollSync.setScrollTop(400, 1)
    el.scrollTop = 500
    expect(scrollSync.onScroll()).toBe(true)
    expect(view.renderedScroll.top).toBe(500)
  })

  it('consumes the echo of a write the engine snapped to another offset', () => {
    const { el } = makeSnappingScrollEl()
    const scrollSync = createEditorScrollSync({
      getScrollEl: () => el as unknown as HTMLElement,
      getEditorEl: () => null,
    })

    // Half a pixel is exactly the boundary: the engine keeps 501, so an echo
    // reporting 501 is half a pixel away from what the write asked for. Nothing
    // was ever within half a pixel of the write, so the value the engine
    // ACCEPTED is the one the echo has to be recognised by.
    scrollSync.setScrollTop(500.5, 1)
    expect(el.scrollTop).toBe(501)
    expect(scrollSync.onScroll()).toBe(false)
    expect(view.renderedScroll.top).toBe(501)
  })

  it('does not swallow a user scroll that lands beside a recorded write', () => {
    const { el, userScrollTo } = makeSnappingScrollEl()
    const scrollSync = createEditorScrollSync({
      getScrollEl: () => el as unknown as HTMLElement,
      getEditorEl: () => null,
    })

    scrollSync.setScrollTop(500, 1)
    // A fractional offset off a trackpad, and not the one this code wrote:
    // being near the record is not the same as being the record.
    userScrollTo(500.4)
    expect(scrollSync.onScroll()).toBe(true)
    expect(view.renderedScroll.top).toBe(500.4)
  })

  it('clamps a programmatic write into the pane’s range', () => {
    const el = makeScrollEl()
    const scrollSync = createEditorScrollSync({
      getScrollEl: () => el as unknown as HTMLElement,
      getEditorEl: () => null,
    })

    scrollSync.setScrollTop(5000, 1)
    expect(el.scrollTop).toBe(800)
    expect(scrollSync.onScroll()).toBe(false)
  })

  it('reads heading offsets in the pane’s content space', () => {
    const el = makeScrollEl()
    el.scrollTop = 100
    const scrollSync = createEditorScrollSync({
      getScrollEl: () => el as unknown as HTMLElement,
      getEditorEl: () => makeEditorEl([10, 300]),
    })

    // The offsets do not move with the scroll: they are content-space positions.
    expect(scrollSync.getHeadingTops()).toEqual([110, 400])
  })

  it('snaps onto the heading that holds a source line', () => {
    const el = makeScrollEl()
    const scrollSync = createEditorScrollSync({
      getScrollEl: () => el as unknown as HTMLElement,
      getEditorEl: () => makeEditorEl([300]),
    })

    // The note's only heading is on line 1; the heading is left just inside the
    // viewport, by the same 16px margin the editor styles use.
    scrollSync.setScrollToLine(1, 3)
    expect(el.scrollTop).toBe(284)
    expect(scrollSync.onScroll()).toBe(false)
  })

  it('falls back to the source line’s ratio when the document has no headings', () => {
    tabs.activeTab!.content = 'plain text\n\nmore plain text\n'
    const el = makeScrollEl()
    const scrollSync = createEditorScrollSync({
      getScrollEl: () => el as unknown as HTMLElement,
      getEditorEl: () => makeEditorEl([]),
    })

    // Line 3 of 3: the end of the range.
    scrollSync.setScrollToLine(3, 1)
    expect(el.scrollTop).toBe(800)
  })

  it('follows a heading anchor to the heading it names, by index', () => {
    const root = makeEditorEl([100, 700])
    const scrolled: Element[] = []
    root.querySelectorAll('h2').forEach((heading) => {
      heading.scrollIntoView = () => scrolled.push(heading)
    })
    const headings = root.querySelectorAll('h2')
    headings[1]!.textContent = 'Two'
    const scrollSync = createEditorScrollSync({
      getScrollEl: () => makeScrollEl() as unknown as HTMLElement,
      getEditorEl: () => root,
    })

    scrollSync.scrollToHeading('two')
    // The second heading, not the first: slugs are rebuilt document-wide and
    // matched by position, so a duplicated name cannot collapse onto one entry.
    expect(scrolled).toEqual([headings[1]!])
  })

  it('cancel() drops a pending write record without scrolling', () => {
    const el = makeScrollEl()
    const scrollSync = createEditorScrollSync({
      getScrollEl: () => el as unknown as HTMLElement,
      getEditorEl: () => null,
    })

    scrollSync.setScrollTop(400, 1)
    scrollSync.cancel()
    expect(el.scrollTop).toBe(400)
    expect(scrollSync.onScroll()).toBe(true)
  })
})

/**
 * The caret half of the pane: the source line the caret sits on, and putting the
 * caret back on a line.
 *
 * Against a REAL Milkdown model, because a caret is a ProseMirror position and
 * only a real editor has one. What is not real is the layout: happy-dom performs
 * none, so every block measures zero and a linear model is supplied instead —
 * `BLOCK_PX` per top-level block, which is the shape a document of one-line
 * paragraphs lays out to. That is a model of layout and not layout itself, which
 * is the one thing these cases cannot prove; the browser checks the real thing.
 *
 * The sections the assertions use are the ones the line↔offset mapping is exact
 * in: anywhere between two headings it interpolates one heading's offset to the
 * next, and the linear model below agrees with that exactly (one 2-line step per
 * block). The last section has no following heading to interpolate against and
 * is deliberately not used.
 */
const BLOCK_PX = 140
const CARET_DOC = ['# One', '', 'alpha', '', 'beta', '', '# Two', '', 'gamma', '', 'delta', '', '# Three', '', 'epsilon', ''].join(
  '\n',
)
/** Where each heading and each body paragraph sits, in the model below. */
const CARET_BLOCKS = ['One', 'alpha', 'beta', 'Two', 'gamma', 'delta', 'Three', 'epsilon']

describe('editorScrollSync caret', () => {
  let editor: NekoEditor | null = null
  let host: HTMLElement | null = null

  beforeEach(async () => {
    setActivePinia(createPinia())
    const tabs = useTabsStore()
    tabs.setVault('/vault')
    await tabs.openTab('notes/a.md')
    tabs.activeTab!.content = CARET_DOC
    host = document.createElement('div')
    document.body.appendChild(host)
    editor = createEditor(host, { plugins: basicPlugins })
    await editor.open(CARET_DOC)
    await new Promise((resolve) => setTimeout(resolve, 0))
    installLinearLayout(editor!)
  })

  afterEach(() => {
    editor?.destroy()
    editor = null
    document.body.innerHTML = ''
    host = null
  })

  /** A pane whose rect is the origin of content space and whose scrollable
   *  extent is the document's own height (`CLIENT_PX` of it is on screen). */
  function makePaneEl(): HTMLElement {
    const doc = editor!.getView().state.doc
    return {
      scrollTop: 0,
      scrollHeight: doc.childCount * BLOCK_PX,
      clientHeight: 0,
      getBoundingClientRect: () => ({ top: 0, left: 0, width: 0, height: 0 }),
    } as unknown as HTMLElement
  }

  /** Positions and headings measured as the model says they are. */
  function installLinearLayout(from: NekoEditor): void {
    const view = from.getView()
    // `index(0)` — the top-level block this position falls in (`ResolvedPos.index`
    // is a method, and reading it as a property multiplies a function).
    const blockTop = (pos: number): number =>
      view.state.doc
        .resolve(Math.max(0, Math.min(pos, view.state.doc.content.size)))
        .index(0) * BLOCK_PX
    view.coordsAtPos = ((pos: number) => ({
      left: 0,
      right: 0,
      top: blockTop(pos),
      bottom: blockTop(pos) + BLOCK_PX,
    })) as typeof view.coordsAtPos
    const headings = Array.from(host!.querySelectorAll('h1, h2, h3, h4, h5, h6'))
    expect(headings).toHaveLength(3)
    headings.forEach((heading, index) => {
      // `One`, `Two`, `Three` are every third block.
      const top = index * 3 * BLOCK_PX
      heading.getBoundingClientRect = () =>
        ({ top, left: 0, width: 0, height: BLOCK_PX }) as DOMRect
    })
  }

  function makeSync(): ReturnType<typeof createEditorScrollSync> {
    return createEditorScrollSync({
      getScrollEl: () => makePaneEl(),
      getEditorEl: () => host,
      getEditor: () => editor,
    })
  }

  /** Put the caret inside the block at `index`, the way a click does. */
  function caretInto(index: number): void {
    const view = editor!.getView()
    let pos = 0
    for (let i = 0; i < index; i += 1) pos += view.state.doc.child(i).nodeSize
    view.dispatch(
      view.state.tr.setSelection(TextSelection.create(view.state.doc, Math.min(pos + 1, view.state.doc.content.size))),
    )
  }

  /** The text of the block the caret is in. */
  function caretBlock(): string {
    const head = editor!.getView().state.selection.head
    return editor!.getView().state.doc.resolve(head).parent.textContent
  }

  it('puts the caret in the block the source line names', () => {
    const scrollSync = makeSync()
    // Line 3 is `alpha`, line 11 is `delta`: one block per two source lines, so
    // the mapping lands on the block and not merely in its section.
    scrollSync.setCaretLine(3)
    expect(caretBlock()).toBe('alpha')
    scrollSync.setCaretLine(11)
    expect(caretBlock()).toBe('delta')
  })

  it('reads the source line the caret is on', () => {
    const scrollSync = makeSync()
    caretInto(CARET_BLOCKS.indexOf('gamma'))
    expect(scrollSync.getCaretLine()).toBeCloseTo(9, 1)
    caretInto(CARET_BLOCKS.indexOf('beta'))
    expect(scrollSync.getCaretLine()).toBeCloseTo(5, 1)
  })

  it('is the inverse of itself: a caret carried out comes back where it was', () => {
    const scrollSync = makeSync()
    caretInto(CARET_BLOCKS.indexOf('gamma'))
    const line = scrollSync.getCaretLine()!
    // Move it somewhere else first, so the second write has to do the work.
    scrollSync.setCaretLine(3)
    expect(caretBlock()).toBe('alpha')
    scrollSync.setCaretLine(line)
    expect(caretBlock()).toBe('gamma')
  })

  it('places the caret without a history entry', () => {
    const scrollSync = makeSync()
    caretInto(CARET_BLOCKS.indexOf('alpha'))
    const before = editor!.getView().state.doc
    scrollSync.setCaretLine(11)
    // Nothing was edited: the document is byte-identical and the only change is
    // the selection.
    expect(editor!.getView().state.doc.eq(before)).toBe(true)
  })

  it('answers "no line" rather than guessing when there is no editor', () => {
    const scrollSync = createEditorScrollSync({
      getScrollEl: () => makePaneEl(),
      getEditorEl: () => null,
    })
    expect(scrollSync.getCaretLine()).toBeNull()
    // …and placing one is a no-op, not a throw.
    expect(() => scrollSync.setCaretLine(3)).not.toThrow()
  })
})
