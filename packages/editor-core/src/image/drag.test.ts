import { afterEach, describe, expect, it } from 'vitest'
import { undoDepth } from '@milkdown/prose/history'
import { NodeSelection } from '@milkdown/prose/state'
import type { EditorView } from '@milkdown/prose/view'

import { advanceResizeDrag, beginResizeDrag, commitResizeDrag } from './drag'
import { KEY_STEP } from './resize'
import { createEditor, basicPlugins } from '../editor'

/** The image's attrs at `pos`, as a resize left them. */
type ImageAttrs = { width: unknown; height: unknown }

/**
 * A drag of the handle or the image's corner: pointerdown on the element, the
 * moves on the window (where the node view listens), then pointerup.
 *
 * `shift` is the aspect lock. The node view reads it from the pointerdown and
 * re-reads it on every move, so a real Shift-drag reports it on all three — and
 * a drag that loses it mid-gesture commits an unlocked width.
 */
function simulateDrag(img: HTMLElement, xs: number[], shift = false): void {
  const at = (type: string, clientX: number): MouseEvent =>
    new MouseEvent(type, { clientX, clientY: 0, shiftKey: shift, bubbles: true })
  img.dispatchEvent(at('pointerdown', 0))
  for (const x of xs) window.dispatchEvent(at('pointermove', x))
  window.dispatchEvent(at('pointerup', xs[xs.length - 1]))
}

describe('resize drag coalescing (pure)', () => {
  it('many moves produce exactly one commit per drag', () => {
    let drag = beginResizeDrag(300)
    drag = advanceResizeDrag(drag, 10, 310)
    drag = advanceResizeDrag(drag, 10, 322)
    drag = advanceResizeDrag(drag, 10, 334)
    expect(commitResizeDrag(drag)).toEqual({ pos: 10, width: 334 })
  })

  it('a drag that never moves commits nothing', () => {
    const drag = beginResizeDrag(300)
    expect(commitResizeDrag(drag)).toBeNull()
  })

  it('records the latest width, not the first', () => {
    let drag = beginResizeDrag(300)
    drag = advanceResizeDrag(drag, 10, 320)
    drag = advanceResizeDrag(drag, 10, 280)
    expect(commitResizeDrag(drag)).toEqual({ pos: 10, width: 280 })
  })

  it('one move commits exactly that width', () => {
    let drag = beginResizeDrag(300)
    drag = advanceResizeDrag(drag, 5, 312)
    expect(commitResizeDrag(drag)).toEqual({ pos: 5, width: 312 })
  })
})

describe('resize drag undo coalescing (editor)', () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('a whole resize drag lands as exactly one undo step', async () => {
    const el = document.createElement('div')
    document.body.appendChild(el)
    const editor = createEditor(el, { plugins: basicPlugins })
    await editor.open('![a](attachments/a.png)')

    const view = editor.getView()
    const img = el.querySelector('img') as HTMLImageElement
    expect(img).toBeTruthy()
    // The drag must have a real size to commit one: an unmeasurable image now
    // refuses (as the keymap does), so happy-dom's 0/0 element is given the
    // pixels the browser would have decoded.
    Object.defineProperty(img, 'naturalWidth', { value: 1200, configurable: true })
    Object.defineProperty(img, 'naturalHeight', { value: 300, configurable: true })

    // open() is excluded from undo history, so the drag must be the first step.
    const before = undoDepth(view.state)
    expect(before).toBe(0)

    simulateDrag(img, [5, 10, 15, 20])

    // Every pointermove in the drag coalesces into ONE commit — a resize drag
    // is a single undo step, not one per pixel.
    expect(undoDepth(view.state)).toBe(before + 1)
    const after = undoDepth(view.state)
    expect(after).toBe(1)
  })

  it('a click with no move does not create an undo step', async () => {
    const el = document.createElement('div')
    document.body.appendChild(el)
    const editor = createEditor(el, { plugins: basicPlugins })
    await editor.open('![a](attachments/a.png)')

    const img = el.querySelector('img') as HTMLImageElement
    const view = editor.getView()
    const before = undoDepth(view.state)
    expect(before).toBe(0)

    img.dispatchEvent(new MouseEvent('pointerdown', { clientX: 0, clientY: 0, bubbles: true }))
    window.dispatchEvent(new MouseEvent('pointerup', { clientX: 0, clientY: 0, bubbles: true }))

    expect(undoDepth(view.state)).toBe(before)
  })

  it('a drag without Shift clears the height it finds', async () => {
    // The commit is the drag's whole output, and `height = null` is what "the
    // file draws it" means: the pair the reader sees is gone, so a later
    // keyboard resize has to re-derive the ratio from the file's own pixels.
    const el = document.createElement('div')
    document.body.appendChild(el)
    const editor = createEditor(el, { plugins: basicPlugins })
    await editor.open('![a](attachments/a.png){width=400 height=300}')

    const img = el.querySelector('img') as HTMLImageElement
    const view = editor.getView()
    let pos: number | null = null
    view.state.doc.descendants((n, p) => {
      if (n.type.name === 'image') {
        pos = p
        return false
      }
      return true
    })
    if (pos === null) throw new Error('no image node')

    simulateDrag(img, [5, 30])

    const node = view.state.doc.nodeAt(pos)
    expect(node?.attrs.width).toBe(430) // 400 + 30px of travel
    expect(node?.attrs.height).toBeNull()
  })

  it('a drag leaves the image selected, so the next arrow key still steps it', async () => {
    // The drag commits with the same `setNodeMarkup` the keyboard uses, so it
    // ended the image selection the same way — the panel closed on the resize
    // it came from, and the reader who reached for → after a drag (the natural
    // way to fine-tune one) found nothing selected and had to click first.
    const el = document.createElement('div')
    document.body.appendChild(el)
    const editor = createEditor(el, { plugins: basicPlugins })
    await editor.open('![a](attachments/a.png){width=300}')

    const img = el.querySelector('img') as HTMLImageElement
    const figure = el.querySelector('.neko-image') as HTMLElement
    const view = editor.getView()
    const pos = view.posAtDOM(figure, 0)
    view.dispatch(view.state.tr.setSelection(NodeSelection.create(view.state.doc, pos)))

    simulateDrag(img, [5, 30])

    expect(view.state.doc.nodeAt(pos)?.attrs.width).toBe(330)
    expect(view.state.selection instanceof NodeSelection).toBe(true)

    const event = new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })
    view.someProp('handleKeyDown', (f) => f(view, event))
    expect(view.state.doc.nodeAt(pos)?.attrs.width).toBe(340)
  })
})

/**
 * A Shift drag on an image whose size cannot be established AT ALL.
 *
 * `resizeBasis` answers "no ratio" when the document states neither dimension
 * and the element reports no pixels (0/0 — not loaded, failed, CSP-blocked, or
 * a source-less image), or when it states one dimension and the element reports
 * none. The drag used to answer that with a stand-in pair — `{1, 1}`, or
 * `{width, round(width * 0.75)}` — and pointer-up wrote the size that came out
 * of it: `{1,1}` squares the picture, the 0.75 writes a 4:3, and both belong to
 * no image. The gesture may run (it is not the document), but the COMMIT is
 * where such a size reached the note, and that is where it must not.
 */
describe('a Shift drag with no ratio to hold', () => {
  /** An editor holding `md`, with the node view's `<img>` reporting 0/0 — an
   *  element that never loaded, which is what "no size" means. */
  async function openUnmeasurable(md: string): Promise<{
    editor: ReturnType<typeof createEditor>
    view: EditorView
    img: HTMLImageElement
    pos: number
  }> {
    const el = document.createElement('div')
    document.body.appendChild(el)
    const editor = createEditor(el, { plugins: basicPlugins })
    await editor.open(md)
    const img = el.querySelector('img') as HTMLImageElement
    const view = editor.getView()
    let pos: number | null = null
    view.state.doc.descendants((n, p) => {
      if (pos === null && n.type.name === 'image') pos = p
      return true
    })
    if (pos === null) throw new Error('no image node')
    return { editor, view, img, pos }
  }

  it('writes nothing when nothing states a size, instead of squaring the picture', async () => {
    const { editor, view, img, pos } = await openUnmeasurable('![a](attachments/a.png)')
    const before = undoDepth(view.state)

    simulateDrag(img, [5, 30], true)

    // Before: the stand-in pair was { width: 1, height: 1 }, so the commit was
    // proportionalSize(1, 1, 31) -> { width: 31, height: 31 }, saved as
    // `![a](attachments/a.png){width=31 height=31}`.
    const node = view.state.doc.nodeAt(pos)
    expect({ width: node?.attrs.width, height: node?.attrs.height }).toEqual({
      width: null,
      height: null,
    })
    expect(undoDepth(view.state)).toBe(before)
    expect(await editor.save()).not.toContain('{width')
    // The preview declines too: the element is left exactly as the document
    // renders it, which is what keeps it from showing a square that nothing
    // committed.
    expect(img.style.width).toBe('')
    expect(img.style.height).toBe('')
    editor.destroy()
  })

  it('writes nothing when only the width is stored, instead of inventing a 4:3', async () => {
    const { editor, view, img, pos } = await openUnmeasurable('![a](attachments/a.png){width=300}')

    simulateDrag(img, [5, 30], true)

    // Before: a stored width paired with the stand-in height made { 300, 225 },
    // so the commit was proportionalSize(300, 225, 330) -> { width: 330,
    // height: 248 } — a 4:3 belonging to no image. One stored dimension is not
    // a ratio.
    const node = view.state.doc.nodeAt(pos)
    expect({ width: node?.attrs.width, height: node?.attrs.height }).toEqual({
      width: 300,
      height: null,
    })
    expect(await editor.save()).not.toContain('height=')
    // The element still shows the size the document states for it — the drag
    // does not preview a pair it is not going to write.
    expect(img.style.width).toBe('300px')
    editor.destroy()
  })

  it('puts the element back when Shift arrives only at the end of the drag', async () => {
    // Shift is read per move, so it can be held for the last one only: the
    // moves before it previewed a plain width, and the mode at pointer-up is
    // what decides the commit. With no ratio to hold the document keeps its
    // size — and a preview the drag will not commit must not outlive it.
    const { editor, view, img, pos } = await openUnmeasurable('![a](attachments/a.png){width=300}')
    const at = (type: string, clientX: number, shiftKey: boolean): MouseEvent =>
      new MouseEvent(type, { clientX, clientY: 0, shiftKey, bubbles: true })

    img.dispatchEvent(at('pointerdown', 0, false))
    window.dispatchEvent(at('pointermove', 40, false))
    expect(img.style.width).toBe('340px') // the plain step from 300, previewed

    window.dispatchEvent(at('pointermove', 40, true))
    window.dispatchEvent(at('pointerup', 40, true))

    expect(img.style.width).toBe('300px')
    const node = view.state.doc.nodeAt(pos)
    expect({ width: node?.attrs.width, height: node?.attrs.height }).toEqual({
      width: 300,
      height: null,
    })
    editor.destroy()
  })
})

/**
 * A plain drag on an image whose size cannot be established AT ALL.
 *
 * `resizeBasis` answers "no start width" when the document states no width,
 * the element reports no pixels (0/0 — not loaded, failed, CSP-blocked) and
 * nothing draws it. The drag used to answer that by stepping from an invented
 * `1` — `baseWidth ?? 1` — so a 30px plain drag wrote `{width: 31,
 * height: null}`: a size derived from the same `1` the keymap refuses. The
 * gesture may run (it is not the document), but the COMMIT is where such a
 * size reached the note, and that is where it must not. The preview declines
 * too, for the same reason as the Shift refusal: an element showing a width the
 * note does not have is a size on screen that no commit will write.
 */
describe('a plain drag with no width to step from', () => {
  /** An editor holding `md`, with the node view's `<img>` reporting 0/0. */
  async function openUnmeasurable(md: string): Promise<{
    editor: ReturnType<typeof createEditor>
    view: EditorView
    img: HTMLImageElement
    pos: number
  }> {
    const el = document.createElement('div')
    document.body.appendChild(el)
    const editor = createEditor(el, { plugins: basicPlugins })
    await editor.open(md)
    const img = el.querySelector('img') as HTMLImageElement
    const view = editor.getView()
    let pos: number | null = null
    view.state.doc.descendants((n, p) => {
      if (pos === null && n.type.name === 'image') pos = p
      return true
    })
    if (pos === null) throw new Error('no image node')
    return { editor, view, img, pos }
  }

  it('writes nothing when nothing states a size, instead of stepping from 1', async () => {
    const { editor, view, img, pos } = await openUnmeasurable('![a](attachments/a.png)')
    const before = undoDepth(view.state)

    simulateDrag(img, [5, 30])

    // Before: startWidth was the invented 1, so a 30px travel committed
    // `{ width: 31, height: null }`, saved as `![a](attachments/a.png){width=31}`.
    const node = view.state.doc.nodeAt(pos)
    expect({ width: node?.attrs.width, height: node?.attrs.height }).toEqual({
      width: null,
      height: null,
    })
    expect(undoDepth(view.state)).toBe(before)
    expect(await editor.save()).not.toContain('{width')
    // The preview declines too: the element keeps exactly what the document
    // renders, which is what keeps an invented width from sitting on screen.
    expect(img.style.width).toBe('')
    expect(img.style.height).toBe('')
    editor.destroy()
  })

  it('writes nothing when only a height is stored — a height is not a width', async () => {
    const { editor, view, img, pos } = await openUnmeasurable('![a](attachments/a.png){height=300}')
    const before = undoDepth(view.state)

    simulateDrag(img, [5, 30])

    // Before: no stored width and no pixels meant baseWidth was null, so the
    // drag stepped from 1 and wrote `{ width: 31, height: null }` — dropping
    // the height the note actually had. The stored height gives the plain drag
    // no width to step from.
    const node = view.state.doc.nodeAt(pos)
    expect({ width: node?.attrs.width, height: node?.attrs.height }).toEqual({
      width: null,
      height: 300,
    })
    expect(undoDepth(view.state)).toBe(before)
    expect(await editor.save()).not.toContain('{width')
    // The node view renders the stored height; the refused drag must not touch
    // the element the note's own dims drew.
    expect(img.style.width).toBe('')
    expect(img.style.height).toBe('300px')
    editor.destroy()
  })
})

/**
 * The drag's ratio has to be the FILE's, exactly as the keymap's is.
 *
 * With a width stored and no height, the drag formed its ratio from the stored
 * (CSS) width over the file's PIXEL height — `300/300` for a 1200x300 file
 * stored as `{width=300}`, a ratio belonging to no image — while the keymap,
 * fixed in `f59be41`, formed `1200/300` for the very same state. One operation,
 * two ratios; and the drag writes `attrs.height` on pointer-up, so the square
 * reached the note.
 *
 * The acceptance is one sentence — the two paths agree — so the test is one
 * sentence too: the same image, the same starting attrs, one gesture from each
 * path to the same width, and the resulting attrs must be equal. The two cases
 * that already worked are here as regression pins; `{width=300}` is the one
 * that did not.
 */
describe('a Shift resize, dragged or pressed, lands on the same picture', () => {
  /** The image's attrs at `pos`. */
  function attrsOf(view: EditorView, pos: number): ImageAttrs {
    const node = view.state.doc.nodeAt(pos)
    if (!node) throw new Error('no image node')
    return { width: node.attrs.width, height: node.attrs.height }
  }

  /**
   * An editor holding `md`, with the node view's own `<img>` reporting
   * `pixels`. happy-dom decodes nothing and lays nothing out, so the numbers
   * the browser would have read — the file's pixels, and `drawn` for a picture
   * the column has capped — are handed to the element.
   */
  async function openImage(
    md: string,
    pixels: [number, number],
    drawn?: number,
  ): Promise<{ view: EditorView; img: HTMLImageElement; pos: number }> {
    const el = document.createElement('div')
    document.body.appendChild(el)
    const editor = createEditor(el, { plugins: basicPlugins })
    await editor.open(md)

    const img = el.querySelector('img') as HTMLImageElement
    for (const [key, value] of [
      ['naturalWidth', pixels[0]],
      ['naturalHeight', pixels[1]],
    ] as const) {
      Object.defineProperty(img, key, { value, configurable: true })
    }
    if (drawn !== undefined) {
      Object.defineProperty(img, 'clientWidth', { value: drawn, configurable: true })
    }

    const view = editor.getView()
    let pos: number | null = null
    view.state.doc.descendants((n, p) => {
      if (pos === null && n.type.name === 'image') pos = p
      return true
    })
    if (pos === null) throw new Error('no image node')
    return { view, img, pos }
  }

  /** One Shift+→: the width the drag below has to land on. */
  function shiftStep(view: EditorView, pos: number): void {
    view.dispatch(view.state.tr.setSelection(NodeSelection.create(view.state.doc, pos)))
    const event = new KeyboardEvent('keydown', { key: 'ArrowRight', shiftKey: true, bubbles: true })
    view.someProp('handleKeyDown', (f) => f(view, event))
  }

  /**
   * The same image through both paths. Both start from the same attrs, and one
   * `KEY_STEP` of drag is the width one Shift+→ reaches, so W is the same on
   * both sides without being named: the difference the test is looking for is
   * in the height each path derives.
   */
  async function resizeBothWays(
    md: string,
    pixels: [number, number],
    drawn?: number,
  ): Promise<{ dragged: ImageAttrs; pressed: ImageAttrs }> {
    const drag = await openImage(md, pixels, drawn)
    simulateDrag(drag.img, [5, KEY_STEP], true)

    const press = await openImage(md, pixels, drawn)
    shiftStep(press.view, press.pos)

    return { dragged: attrsOf(drag.view, drag.pos), pressed: attrsOf(press.view, press.pos) }
  }

  it('agrees when only the width is stored', async () => {
    const md = '![a](attachments/a.png){width=300}'
    const { dragged, pressed } = await resizeBothWays(md, [1200, 300])

    // Before: the drag locked 300/300 = 1 and committed { width: 310,
    // height: 310 } — a 1200x300 screenshot squared, and written to the note —
    // where Shift+→ committed { width: 310, height: 78 } (1200/300 = 4,
    // 310 / 4 = 77.5).
    expect(dragged).toEqual(pressed)
    expect(dragged).toEqual({ width: 310, height: 78 })
  })

  it('agrees when both dimensions are stored', async () => {
    // The ordinary case, and the regression to watch: the pair the document
    // states is the ratio, on both paths.
    const md = '![a](attachments/a.png){width=400 height=300}'
    const { dragged, pressed } = await resizeBothWays(md, [1200, 300])

    expect(dragged).toEqual(pressed)
    expect(dragged).toEqual({ width: 410, height: 308 })
  })

  it('agrees when neither dimension is stored', async () => {
    // Both paths start from the file's own width here, and both lock the file's
    // ratio: 1210 / 4 = 302.5.
    const { dragged, pressed } = await resizeBothWays('![a](attachments/a.png)', [1200, 300])

    expect(dragged).toEqual(pressed)
    expect(dragged).toEqual({ width: 1210, height: 303 })
  })

  it('agrees when only the height is stored', async () => {
    // The defect's mirror, and reachable: the panel can write a height on its
    // own, and the remark parser accepts `{height=300}`. Neither half may be
    // paired with a pixel dimension of the other kind.
    const { dragged, pressed } = await resizeBothWays(
      '![a](attachments/a.png){height=300}',
      [1200, 300],
    )

    expect(dragged).toEqual(pressed)
    expect(dragged).toEqual({ width: 1210, height: 303 })
  })

  it('agrees when the column draws the picture narrower than the file', async () => {
    // No stored size, and the pane draws the 1200x300 file at 600: the start
    // width is the drawn one (a drag steps from what the reader sees), but the
    // ratio is the file's on both paths. Locking 600/300 = 2 here — the drawn
    // width over the PIXEL height — is the same defect wearing a different hat,
    // and it is why the number moved with the pane's width. Before: the drag
    // committed { width: 610, height: 305 }, the keymap { width: 610,
    // height: 153 }; 610 / 4 = 152.5.
    const { dragged, pressed } = await resizeBothWays('![a](attachments/a.png)', [1200, 300], 600)

    expect(dragged).toEqual(pressed)
    expect(dragged).toEqual({ width: 610, height: 153 })
  })

  it('agrees when no size is stored and the picture reports no pixels', async () => {
    // The case every test above excludes by its own fixture: `pixels: [1200,
    // 300]` means `lock` is never null, so the drag's stand-in pair — the exact
    // thing the agreement exists to remove — was never entered. `[0, 0]` is an
    // element that never loaded: neither path has a ratio, so both must leave
    // the document alone. Before: the drag committed { width: 11, height: 11 },
    // the invented {1,1} squared, where Shift+→ changed nothing.
    const { dragged, pressed } = await resizeBothWays('![a](attachments/a.png)', [0, 0])

    expect(dragged).toEqual(pressed)
    expect(dragged).toEqual({ width: null, height: null })
  })

  it('agrees when only the width is stored and the picture reports no pixels', async () => {
    // Before: the drag committed { width: 310, height: 233 } — the 0.75
    // stand-in's 4:3 — where Shift+→ refused. A stored width on its own is not
    // a ratio for either path to hold.
    const { dragged, pressed } = await resizeBothWays('![a](attachments/a.png){width=300}', [0, 0])

    expect(dragged).toEqual(pressed)
    expect(dragged).toEqual({ width: 300, height: null })
  })
})
