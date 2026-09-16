/**
 * The caret in the LAST block of a note WITH headings, shorter than its pane.
 *
 * The reported defect, and the residual 137 did not cover: a note with headings
 * takes the anchor route — `hasAnchors` is true, so the note's own blocks are
 * not consulted — and the last block's span is the one the anchors cannot bound.
 * `renderedTopFor` ended it at `range`, the pane's scrollable extent
 * (`scrollHeight - clientHeight`), and a note shorter than its pane has none: 0,
 * which is ABOVE the last heading's own top. The span then runs backwards, and
 * every line from that heading — the whole final section, which is where the
 * user is typing — collapses onto the heading, or (with a preamble) past it
 * into the preamble.
 *
 * The span's end is now the CONTENT's: the last block's own measured bottom, in
 * the same space the heading offsets and the block tops `posForOffset` measures
 * are in (the pane's box, `scrollHeight`, is the fallback for a block with no
 * measurement — and it is the box, not the text, because the pane keeps a tail
 * of empty space below the note). A caret is a point in the document, and
 * `range` is a quantity of scrolling that only happens to equal the content's
 * end while the content overflows the pane.
 *
 * Against a REAL Milkdown model, because a caret is a ProseMirror position and
 * only a real editor has one. What is not real is the layout: happy-dom performs
 * none, so a linear model is supplied instead — `BLOCK_PX` per top-level block,
 * for the blocks AND for the headings' measured offsets. That model is what lets
 * the PRE-FIX code run and land somewhere wrong rather than refusing to move the
 * caret at all: with nothing measurable it declines to place one, and a test that
 * "passed" against that would be asserting that nothing happened.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { basicPlugins, createEditor, type NekoEditor } from '@nekowite/editor-core'
import { useTabsStore } from '../../../stores/tabs'
import { countDocumentLines } from '../../../services/scroll-sync-anchors'
import { parseOutline } from '../../../services/outline'
import { createEditorScrollSync } from './editor-scroll-sync'
import { planPaneSync, renderedTopFor, type PaneGeometry } from './pane-scroll-mapping'

vi.mock('../../../platform/gateways/fs', () => ({
  fsService: {
    read: vi.fn().mockResolvedValue('# Welcome\n\nbody'),
    write: vi.fn().mockResolvedValue(undefined),
    saveFileDialog: vi.fn().mockResolvedValue(null),
  },
}))

/** What one top-level block measures in the model below. */
const BLOCK_PX = 140

/** A note that OPENS WITH A HEADING: four blocks, 560px of content, no preamble.
 *  Its heading is the first block, so `blockTop` measures that one from the
 *  document's own top. */
const HEADING_FIRST = '# Heading\n\npara a\n\npara b\n\npara c\n'
/** Its blocks, in document order — block k is the k-th of these. */
const HEADING_FIRST_BLOCKS = ['Heading', 'para a', 'para b', 'para c']
/** …and the source line each of them starts on. */
const HEADING_FIRST_LINES = [1, 3, 5, 7]

/** The same shape with a PREAMBLE above the heading — `blockTop`'s other case:
 *  lines 1..2 are the heading's own, and the heading anchors a block that starts
 *  at the heading rather than at the document's top. */
const PREAMBLED = 'intro\n\n# Heading\n\npara a\n\npara b\n'
const PREAMBLED_BLOCKS = ['intro', 'Heading', 'para a', 'para b']
const PREAMBLED_LINES = [1, 3, 5, 7]

/** A headed note LONGER than its pane: ten blocks, 1400px of content, and a
 *  heading two fifths of the way down. The last section is where the same span
 *  under-shoots the other way instead of inverting. */
const LONG = [
  '# One',
  '',
  'one a',
  '',
  'one b',
  '',
  'one c',
  '',
  '## Two',
  '',
  'two a',
  '',
  'two b',
  '',
  'two c',
  '',
  'two d',
  '',
  'two e',
  '',
].join('\n')
const LONG_BLOCKS = 10
/** The blocks the two headings are, in the model below. */
const LONG_HEADING_BLOCKS = [0, 4]
/** `one b` is line 5, `two a` line 11, `two e` the note's last line, 19. */
const LONG_LINES = { oneB: 5, twoA: 11, twoE: 19 }

/** The pane the short notes get: its whole travel is 0, because the note's four
 *  blocks (560px) fit inside it. The only position it has is the top. It is
 *  deliberately much taller than the note, which is how the two candidate ends
 *  are told apart: the pane's own box runs to 1200, the note's content stops at
 *  560, and the assertions below land where only 560 puts them. */
const SHORT_PANE_PX = 1200
/** Where both short notes' content stops: four blocks of `BLOCK_PX`. */
const SHORT_CONTENT_PX = HEADING_FIRST_BLOCKS.length * BLOCK_PX
/** The long note's pane: 400px of a 1400px document, so it does scroll. Its box
 *  carries a tail of empty space below the note — the pane's own 80% crutch, so
 *  the last line can be scrolled up — which is why its extent (1500) and its
 *  box (1900) are both different from the content's end (1400). */
const LONG_PANE_PX = 400
const LONG_CONTENT_PX = LONG_BLOCKS * BLOCK_PX
const LONG_TAIL_PX = 500

describe('the caret in the last block of a headed note', () => {
  let editor: NekoEditor | null = null
  let host: HTMLElement | null = null

  beforeEach(async () => {
    setActivePinia(createPinia())
    const tabs = useTabsStore()
    tabs.setVault('/vault')
    await tabs.openTab('notes/a.md')
    host = document.createElement('div')
    document.body.appendChild(host)
  })

  afterEach(() => {
    editor?.destroy()
    editor = null
    document.body.innerHTML = ''
    host = null
  })

  async function openNote(content: string): Promise<NekoEditor> {
    useTabsStore().activeTab!.content = content
    editor = createEditor(host!, { plugins: basicPlugins })
    await editor.open(content)
    await new Promise((resolve) => setTimeout(resolve, 0))
    return editor
  }

  /** The model's layout, installed on every half of the geometry: positions
   *  measure one `BLOCK_PX` per top-level block, each heading measures at the top
   *  of the block it is (which is what `getHeadingTops` reads), and — when
   *  `contentBottom` is given — the last block measures down to it, which is the
   *  content's end the caret route reads off the DOM.
   *
   *  Omit `contentBottom` to leave the last block unmeasurable, the way a pane no
   *  engine has laid out reports it. */
  function installLayout(blocks: number, headingBlocks: number[], contentBottom?: number): void {
    const view = editor!.getView()
    const doc = view.state.doc
    expect(doc.childCount).toBe(blocks)
    const blockTop = (pos: number): number =>
      doc.resolve(Math.max(0, Math.min(pos, doc.content.size))).index(0) * BLOCK_PX
    view.coordsAtPos = ((pos: number) => ({
      left: 0,
      right: 0,
      top: blockTop(pos),
      bottom: blockTop(pos) + BLOCK_PX,
    })) as typeof view.coordsAtPos
    const headings = Array.from(host!.querySelectorAll<HTMLElement>('h1, h2, h3, h4, h5, h6'))
    expect(headings).toHaveLength(headingBlocks.length)
    headings.forEach((heading, index) => {
      const top = headingBlocks[index] * BLOCK_PX
      heading.getBoundingClientRect = () =>
        ({ top, left: 0, width: 0, height: BLOCK_PX }) as DOMRect
    })
    if (contentBottom === undefined) return
    const last = doc.lastChild
    const lastEl = last ? view.nodeDOM(doc.content.size - last.nodeSize) : null
    if (!(lastEl instanceof HTMLElement)) throw new Error('the last block has no DOM element')
    lastEl.getBoundingClientRect = () =>
      ({ top: contentBottom - BLOCK_PX, bottom: contentBottom, height: BLOCK_PX }) as DOMRect
  }

  /** A pane whose rect is the origin of content space, with the two numbers its
   *  extent is made of — `scrollHeight - clientHeight` is 0 when they are equal,
   *  which is a note shorter than its pane. */
  function makeSync(
    scrollHeight: number,
    clientHeight: number,
  ): ReturnType<typeof createEditorScrollSync> {
    const el = {
      scrollTop: 0,
      scrollHeight,
      clientHeight,
      getBoundingClientRect: () => ({ top: 0, left: 0, width: 0, height: 0 }),
    } as unknown as HTMLElement
    return createEditorScrollSync({
      getScrollEl: () => el,
      getEditorEl: () => host,
      getEditor: () => editor,
    })
  }

  /** The text of the block the caret is in. */
  function caretBlock(): string {
    const view = editor!.getView()
    const head = view.state.selection.head
    return view.state.doc.resolve(head).parent.textContent
  }

  it('keeps a caret in the last block of a heading-first note that fits its pane', async () => {
    await openNote(HEADING_FIRST)
    installLayout(HEADING_FIRST_BLOCKS.length, [0], SHORT_CONTENT_PX)
    const sync = makeSync(SHORT_PANE_PX, SHORT_PANE_PX)

    // Every line of the final section, not only the last one: with the span
    // collapsed onto the heading, they all land there together. The pane's box
    // (1200) would put the first two of these a block too far down, so landing
    // on their own blocks is the measured content end doing the work.
    sync.setCaretLine(HEADING_FIRST_LINES[3])
    expect(caretBlock()).toBe(HEADING_FIRST_BLOCKS[3])
    sync.setCaretLine(HEADING_FIRST_LINES[2])
    expect(caretBlock()).toBe(HEADING_FIRST_BLOCKS[2])
    sync.setCaretLine(HEADING_FIRST_LINES[1])
    expect(caretBlock()).toBe(HEADING_FIRST_BLOCKS[1])
  })

  it('keeps a caret in the last block when the note opens with a preamble', async () => {
    await openNote(PREAMBLED)
    installLayout(PREAMBLED_BLOCKS.length, [1], SHORT_CONTENT_PX)
    const sync = makeSync(SHORT_PANE_PX, SHORT_PANE_PX)

    // The heading anchors its own block here, so a span that ends above the
    // heading runs the line back over the preamble — a different wrong block,
    // which is `blockTop`'s other case.
    sync.setCaretLine(PREAMBLED_LINES[3])
    expect(caretBlock()).toBe(PREAMBLED_BLOCKS[3])
    sync.setCaretLine(PREAMBLED_LINES[2])
    expect(caretBlock()).toBe(PREAMBLED_BLOCKS[2])
  })

  it('falls back to the pane’s box when the last block cannot be measured', async () => {
    await openNote(HEADING_FIRST)
    // No content bottom: with nothing measurable, the pane's own box is the end
    // — coarser than the note, but still a position in the document rather than
    // a travel of 0, and the last line lands in its own block either way.
    installLayout(HEADING_FIRST_BLOCKS.length, [0])
    const sync = makeSync(SHORT_PANE_PX, SHORT_PANE_PX)

    sync.setCaretLine(HEADING_FIRST_LINES[3])
    expect(caretBlock()).toBe(HEADING_FIRST_BLOCKS[3])
  })

  it('sends the next keystroke into the last block, not into the heading', async () => {
    await openNote(HEADING_FIRST)
    installLayout(HEADING_FIRST_BLOCKS.length, [0], SHORT_CONTENT_PX)
    const sync = makeSync(SHORT_PANE_PX, SHORT_PANE_PX)

    // What a mode switch does: the line the source pane's caret was on is handed
    // over and re-planted here. The user's next keystroke has to arrive in the
    // block that line names, which is the thing they saw go wrong.
    sync.setCaretLine(HEADING_FIRST_LINES[3])
    expect(caretBlock()).toContain(HEADING_FIRST_BLOCKS[3])

    const view = editor!.getView()
    view.dispatch(view.state.tr.insertText('!', view.state.selection.head))
    expect(view.state.doc.resolve(view.state.selection.head).index(0)).toBe(3)
    expect(view.state.doc.child(3).textContent).toContain('!')
    // …and the heading is untouched, which is where the keystroke used to land.
    expect(view.state.doc.child(0).textContent).toBe(HEADING_FIRST_BLOCKS[0])
  })

  it('keeps the anchored path’s ordinary case: a line between two headings is unmoved', async () => {
    await openNote(LONG)
    installLayout(LONG_BLOCKS, LONG_HEADING_BLOCKS, LONG_CONTENT_PX)
    const sync = makeSync(LONG_CONTENT_PX + LONG_TAIL_PX, LONG_PANE_PX)

    // A line inside the first section, whose span is bounded by the second
    // heading. Nothing about it is the last block's, and it is the case that
    // must not regress: a span between two headings never reaches for an end.
    sync.setCaretLine(LONG_LINES.oneB)
    expect(caretBlock()).toBe('one b')
  })

  it('keeps a long note’s last section on its own line, where the travel already reaches it', async () => {
    await openNote(LONG)
    installLayout(LONG_BLOCKS, LONG_HEADING_BLOCKS, LONG_CONTENT_PX)
    const sync = makeSync(LONG_CONTENT_PX + LONG_TAIL_PX, LONG_PANE_PX)

    // The same span on a pane that DOES scroll, and the reason this case has
    // never shown the defect: the pane's own travel (`scrollHeight -
    // clientHeight` = 1500) already runs to the content's end (1400), because
    // the tail of empty space the pane keeps below the note is inside the box.
    // The content's end is what the span gets here too, which is why this lands
    // the same way — asserted so the ordinary case stays pinned, on the code
    // either side of the fix.
    sync.setCaretLine(LONG_LINES.twoA)
    expect(caretBlock()).toBe('two a')
    sync.setCaretLine(LONG_LINES.twoE)
    expect(caretBlock()).toBe('two e')
  })

  it('measures the last block against the content when the pane has nothing to scroll', () => {
    const items = parseOutline(HEADING_FIRST)
    const tops = [0]
    const totalLines = countDocumentLines(HEADING_FIRST)
    const contentEnd = HEADING_FIRST_BLOCKS.length * BLOCK_PX

    // The pane's whole travel is 0, so a span ended at `range` is ended at the
    // document's own top: every line names offset 0, which is the heading.
    expect(renderedTopFor(HEADING_FIRST_LINES[3], items, tops, totalLines, 0)).toBe(0)
    // Given the content's end instead, the document's end is the content's end
    // and the last section's lines land inside the last block: line 7 of the
    // 1..8 span is 6/7 of the way across it (offset 480, block three's 420..560).
    expect(renderedTopFor(totalLines + 1, items, tops, totalLines, 0, contentEnd)).toBe(contentEnd)
    expect(
      renderedTopFor(HEADING_FIRST_LINES[3], items, tops, totalLines, 0, contentEnd),
    ).toBeCloseTo((6 / 7) * contentEnd, 6)
    expect(
      renderedTopFor(HEADING_FIRST_LINES[2], items, tops, totalLines, 0, contentEnd),
    ).toBeCloseTo((4 / 7) * contentEnd, 6)

    // And the span never ends below the pane's own travel: a pane cannot scroll
    // past its content, so a caller with no content measurement (a hidden pane,
    // or one that has not been laid out) keeps the end it always had.
    expect(renderedTopFor(totalLines + 1, items, tops, totalLines, 300)).toBe(300)
    expect(renderedTopFor(totalLines + 1, items, tops, totalLines, 300, 100)).toBe(300)

    // The content's end is a different quantity from the pane's travel — that is
    // the whole point — and it is deliberately not what the scroll callers get:
    // the same line mapped with it runs past the position the pane can hold.
    expect(
      renderedTopFor(HEADING_FIRST_LINES[2], items, tops, totalLines, 1600, 2000),
    ).toBeGreaterThan(renderedTopFor(HEADING_FIRST_LINES[2], items, tops, totalLines, 1600))
  })

  it('leaves the split sync where it was: a note shorter than both panes has one position', () => {
    const items = parseOutline(HEADING_FIRST)
    const totalLines = countDocumentLines(HEADING_FIRST)
    const tops = [0]
    const sourceTopOfLine = (line: number): number => (line - 1) * 14
    const pane = (overrides: Partial<PaneGeometry> = {}): PaneGeometry => ({
      fromTop: 0,
      fromRange: 0,
      toRange: 0,
      totalLines,
      items,
      tops,
      sourceTopOfLine,
      ...overrides,
    })
    const line = HEADING_FIRST_LINES[2]

    // Both panes are shorter than their boxes, so each has exactly one position
    // and the plan says so from either side. The sync's own mapping is untouched
    // by this fix, which is what these assertions pin.
    expect(planPaneSync('source', pane(), line)).toEqual({ top: 0, atEdge: true })
    expect(planPaneSync('rendered', pane())).toEqual({ top: 0, atEdge: true })

    // Where the panes DO travel, the sync still hands the mapping the
    // counterpart's extent — which is what a pane can be written to, and what
    // keeps a sync write inside the pane it drives. Asserted as the equivalence
    // it is: the plan is the five-argument mapping with the counterpart's
    // extent, and it never exceeds it.
    const scrolling = pane({ fromTop: 60, fromRange: 954, toRange: 1600 })
    const plan = planPaneSync('source', scrolling, line)
    expect(plan.top).toBeCloseTo(renderedTopFor(line, items, tops, totalLines, 1600), 6)
    expect(plan.top).toBeLessThanOrEqual(1600)
  })
})
