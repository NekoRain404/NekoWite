/**
 * The caret on a note SHORTER than its pane.
 *
 * The reported defect: a note of three unheaded short paragraphs, the source
 * caret in the third, switch to rendered, type — and the text lands in the
 * FIRST paragraph. The line the caret was on was carried correctly; it was the
 * conversion on arrival that threw it away. With no headings to anchor on, the
 * line↔offset mapping falls back to `lineRatio(line, totalLines) * range`, and
 * `range` is the pane's SCROLLABLE extent — `scrollHeight - clientHeight`, which
 * is 0 for a note that fits its pane. Every line then maps to offset 0, which is
 * the first block, and the caret's own paragraph is discarded by the conversion
 * meant to carry it.
 *
 * Against a REAL Milkdown model, because a caret is a ProseMirror position and
 * only a real editor has one. What is not real is the layout: happy-dom performs
 * none, so a linear model is supplied instead — `BLOCK_PX` per top-level block,
 * the shape one-line paragraphs lay out to. That model is what lets the PRE-FIX
 * code run and land somewhere wrong, rather than refusing to move the caret at
 * all: with nothing measurable it declines to place a caret, and a test that
 * "passed" against that would be asserting that nothing happened.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { basicPlugins, createEditor, type NekoEditor } from '@nekowite/editor-core'
import { TextSelection } from '@milkdown/prose/state'
import { useTabsStore } from '../../../stores/tabs'
import { createEditorScrollSync } from './editor-scroll-sync'

vi.mock('../../../platform/gateways/fs', () => ({
  fsService: {
    read: vi.fn().mockResolvedValue('# Welcome\n\nbody'),
    write: vi.fn().mockResolvedValue(undefined),
    saveFileDialog: vi.fn().mockResolvedValue(null),
  },
}))

/** The user's note: three short paragraphs, no headings anywhere. */
const SHORT = 'first paragraph\n\nsecond paragraph\n\nthird paragraph\n'
/** Its paragraphs, in document order — block k of the note. */
const PARAGRAPHS = ['first paragraph', 'second paragraph', 'third paragraph']
/** …and the source line each one is on. */
const PARAGRAPH_LINES = [1, 3, 5]

/** A table and a paragraph after it: the caret's other two positions. */
const TABLED = ['| a | b |', '| - | - |', '| 1 | 2 |', '', 'after the table'].join('\n') + '\n'

const BLOCK_PX = 140
/** The pane's own height. The content is shorter than this, which is the whole
 *  case: nothing to scroll, so the scroll range is 0. */
const PANE_PX = 600

describe('the caret on a note shorter than its pane', () => {
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
    installLinearLayout(editor)
    return editor
  }

  /** A pane with NOTHING to scroll — `scrollHeight` and `clientHeight` equal,
   *  which is what makes its scrollable extent 0 — whose top is the origin of
   *  content space. */
  function makeShortPaneEl(): HTMLElement {
    return {
      scrollTop: 0,
      scrollHeight: PANE_PX,
      clientHeight: PANE_PX,
      getBoundingClientRect: () => ({ top: 0, left: 0, width: 0, height: 0 }),
    } as unknown as HTMLElement
  }

  /** Positions measured as a document of one-line paragraphs lays out: one
   *  `BLOCK_PX` per top-level block. */
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
  }

  function makeSync(): ReturnType<typeof createEditorScrollSync> {
    return createEditorScrollSync({
      getScrollEl: () => makeShortPaneEl(),
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
      view.state.tr.setSelection(
        TextSelection.create(view.state.doc, Math.min(pos + 1, view.state.doc.content.size)),
      ),
    )
  }

  /** The text of the block the caret is in. */
  function caretBlock(): string {
    const head = editor!.getView().state.selection.head
    return editor!.getView().state.doc.resolve(head).parent.textContent
  }

  it('lands in the paragraph the source line names, not the first one', async () => {
    await openNote(SHORT)
    const scrollSync = makeSync()

    scrollSync.setCaretLine(PARAGRAPH_LINES[2])
    expect(caretBlock()).toBe(PARAGRAPHS[2])
    scrollSync.setCaretLine(PARAGRAPH_LINES[1])
    expect(caretBlock()).toBe(PARAGRAPHS[1])
    scrollSync.setCaretLine(PARAGRAPH_LINES[0])
    expect(caretBlock()).toBe(PARAGRAPHS[0])
  })

  it('reads the source line the caret is on, from the note’s own blocks', async () => {
    await openNote(SHORT)
    const scrollSync = makeSync()

    caretInto(2)
    expect(scrollSync.getCaretLine()).toBeCloseTo(PARAGRAPH_LINES[2], 6)
    caretInto(1)
    expect(scrollSync.getCaretLine()).toBeCloseTo(PARAGRAPH_LINES[1], 6)
  })

  it('puts a caret carried out back where it was', async () => {
    await openNote(SHORT)
    const scrollSync = makeSync()

    caretInto(2)
    const line = scrollSync.getCaretLine()!
    // Somewhere else first, so the write back has to do the work.
    scrollSync.setCaretLine(PARAGRAPH_LINES[0])
    expect(caretBlock()).toBe(PARAGRAPHS[0])
    scrollSync.setCaretLine(line)
    expect(caretBlock()).toBe(PARAGRAPHS[2])
  })

  it('keeps a caret that is inside a table inside the table', async () => {
    await openNote(TABLED)
    const view = editor!.getView()
    expect(view.state.doc.childCount).toBe(2)
    expect(view.state.doc.child(0).type.name).toBe('table')
    const scrollSync = makeSync()

    // Rows of the table are source lines 1..3, and the block they belong to is
    // the table itself: the caret keeps its place in it rather than landing on
    // the pane's top, and it moves down the table's own rows with the line.
    scrollSync.setCaretLine(1)
    expect(caretBlockIndex()).toBe(0)
    expect(caretCell()).toBe('a')
    scrollSync.setCaretLine(3)
    expect(caretBlockIndex()).toBe(0)
    expect(caretCell()).toBe('2')
    // …and the paragraph after the table is still reachable by its own line.
    scrollSync.setCaretLine(5)
    expect(caretBlockIndex()).toBe(1)
    expect(caretBlock()).toBe('after the table')
  })

  /** The top-level block the caret is in. */
  function caretBlockIndex(): number {
    const view = editor!.getView()
    return view.state.doc.resolve(view.state.selection.head).index(0)
  }

  /** The text of the table cell the caret is in. */
  function caretCell(): string {
    return caretBlock()
  }

  it('keeps a caret at the document’s end at the end', async () => {
    await openNote(SHORT)
    const scrollSync = makeSync()

    scrollSync.setCaretAtEnd()
    const line = scrollSync.getCaretLine()
    expect(line).toBeCloseTo(PARAGRAPH_LINES[2], 6)
    // …and the switch back puts it in the last paragraph rather than at the top.
    scrollSync.setCaretLine(PARAGRAPH_LINES[0])
    scrollSync.setCaretLine(line!)
    expect(caretBlock()).toBe(PARAGRAPHS[2])
  })
})
