import { afterEach, describe, expect, it } from 'vitest'
import { undoDepth } from '@milkdown/prose/history'
import { NodeSelection, TextSelection } from '@milkdown/prose/state'
import type { EditorView } from '@milkdown/prose/view'

import { basicPlugins, createEditor } from '../editor'
import { clearImageSelection, getSelectedImage, onImageSelectionChange } from './selection'

/** The FIRST image's position. (`descendants`'s `false` prunes a node's
 *  children, it does not stop the walk — returning it here kept looking and
 *  handed back the LAST image, which is invisible until a doc holds two.) */
function findImagePos(doc: unknown): number {
  let pos: number | null = null
  ;(doc as import('@milkdown/prose/model').Node).descendants((n, p) => {
    if (pos === null && n.type.name === 'image') pos = p
    return true
  })
  if (pos === null) throw new Error('no image found')
  return pos
}

function selectImage(view: EditorView, pos: number): void {
  view.dispatch(view.state.tr.setSelection(NodeSelection.create(view.state.doc, pos)))
}

type ArrowKey = 'ArrowLeft' | 'ArrowRight' | 'ArrowUp' | 'ArrowDown'

/** Dispatch the keymap's own handler, the way ProseMirror would on a keydown. */
function pressArrow(view: EditorView, key: ArrowKey, shift = false): boolean {
  const event = new KeyboardEvent('keydown', { key, shiftKey: shift, bubbles: true })
  return Boolean(view.someProp('handleKeyDown', (f) => f(view, event)))
}

/** The image's attrs at `pos`, as the resize left them. */
function imageAttrs(view: EditorView, pos: number): { width: unknown; height: unknown } {
  const node = view.state.doc.nodeAt(pos)
  if (!node) throw new Error('no image node')
  return { width: node.attrs.width, height: node.attrs.height }
}

/** The node view's own `<img>`; the element that knows what the file measures. */
function imgOf(host: HTMLElement): HTMLImageElement {
  const img = host.querySelector('img')
  if (!img) throw new Error('the node view rendered no <img>')
  return img
}

/**
 * The file's own pixels, as the node view's `<img>` reports them once loaded.
 * happy-dom requests nothing, so the element is handed the numbers the browser
 * would have decoded.
 */
function paintImage(host: HTMLElement, width: number, height: number): void {
  const img = imgOf(host)
  for (const [key, value] of [['naturalWidth', width], ['naturalHeight', height]] as const) {
    Object.defineProperty(img, key, { value, configurable: true })
  }
}

afterEach(() => {
  document.body.innerHTML = ''
})

async function makeEditor(
  md: string,
  pixels?: [number, number],
): Promise<{ editor: ReturnType<typeof createEditor>; view: EditorView; host: HTMLElement }> {
  const el = document.createElement('div')
  document.body.appendChild(el)
  const editor = createEditor(el, { plugins: basicPlugins })
  await editor.open(md)
  if (pixels) paintImage(el, pixels[0], pixels[1])
  return { editor, view: editor.getView(), host: el }
}

describe('image keyboard width adjust', () => {
  it('arrow-right grows width by KEY_STEP in a single undo step', async () => {
    const { editor, view } = await makeEditor('![a](attachments/a.png){width=300}')
    const pos = findImagePos(view.state.doc)
    selectImage(view, pos)
    const before = undoDepth(view.state)

    const event = new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })
    const handled = view.someProp('handleKeyDown', (f) => f(view, event))
    expect(handled).toBe(true)

    const node = view.state.doc.nodeAt(pos) as import('@milkdown/prose/model').Node
    expect(node.attrs.width).toBe(310)
    expect(undoDepth(view.state)).toBe(before + 1)
    expect(await editor.save()).toContain('{width=310}')
    editor.destroy()
  })

  it('shift+arrow-right locks aspect and stores both width and height', async () => {
    const { editor, view } = await makeEditor('![a](attachments/a.png){width=400 height=300}')
    const pos = findImagePos(view.state.doc)
    selectImage(view, pos)

    const event = new KeyboardEvent('keydown', { key: 'ArrowRight', shiftKey: true, bubbles: true })
    view.someProp('handleKeyDown', (f) => f(view, event))

    const node = view.state.doc.nodeAt(pos) as import('@milkdown/prose/model').Node
    expect(node.attrs.width).toBe(410)
    expect(node.attrs.height).toBe(308) // 410 / (400/300)
    expect(await editor.save()).toContain('{width=410 height=308}')
    editor.destroy()
  })

  it('arrow-left shrinks width and clamps above 1px', async () => {
    const { view } = await makeEditor('![a](attachments/a.png){width=15}')
    const pos = findImagePos(view.state.doc)
    selectImage(view, pos)
    const event = new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true })
    view.someProp('handleKeyDown', (f) => f(view, event))
    const node = view.state.doc.nodeAt(pos) as import('@milkdown/prose/model').Node
    expect(node.attrs.width).toBeGreaterThanOrEqual(1)
  })

  it('reads ↓ and ↑ on a stored width as grow and shrink', async () => {
    const down = await makeEditor('![a](attachments/a.png){width=300}')
    const downPos = findImagePos(down.view.state.doc)
    selectImage(down.view, downPos)

    pressArrow(down.view, 'ArrowDown')
    expect(imageAttrs(down.view, downPos)).toEqual({ width: 310, height: null })

    const up = await makeEditor('![a](attachments/a.png){width=300}')
    const upPos = findImagePos(up.view.state.doc)
    selectImage(up.view, upPos)

    pressArrow(up.view, 'ArrowUp')
    expect(imageAttrs(up.view, upPos)).toEqual({ width: 290, height: null })
  })

  it('does nothing when the selection is not an image node', async () => {
    const { view } = await makeEditor('# Heading\n')
    const event = new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })
    const handled = view.someProp('handleKeyDown', (f) => f(view, event))
    expect(handled ?? false).toBe(false)
  })
})

/**
 * An image with no stored width is drawn at the file's own size, so `1` is not
 * "its size": the old code gave `→` an 11px sliver (1 + KEY_STEP) and `←` a 1px
 * one, and the next save recorded whichever it produced. Every case here reads
 * the file's pixels first, the way the resize drag does.
 */
describe('image keyboard resize of an image with no stored size', () => {
  it('steps → up from the file’s own width', async () => {
    // Before: {width: null, height: null} -> {width: 11}; the file would carry
    // `![a](attachments/a.png){width=11}`.
    const { editor, view } = await makeEditor('![a](attachments/a.png)', [1200, 300])
    const pos = findImagePos(view.state.doc)
    selectImage(view, pos)

    pressArrow(view, 'ArrowRight')

    expect(imageAttrs(view, pos)).toEqual({ width: 1210, height: null })
    expect(await editor.save()).toContain('{width=1210}')
    editor.destroy()
  })

  it('steps ← down from the file’s own width, not to 1px', async () => {
    // Before: {width: null} -> {width: 1} — both directions shrank it.
    const { editor, view } = await makeEditor('![a](attachments/a.png)', [1200, 300])
    const pos = findImagePos(view.state.doc)
    selectImage(view, pos)

    pressArrow(view, 'ArrowLeft')

    expect(imageAttrs(view, pos)).toEqual({ width: 1190, height: null })
    expect(await editor.save()).toContain('{width=1190}')
    editor.destroy()
  })

  it('reads ↓ as the grow direction on the same basis as →', async () => {
    // Before: {width: null} -> {width: 11}.
    const { view } = await makeEditor('![a](attachments/a.png)', [1200, 300])
    const pos = findImagePos(view.state.doc)
    selectImage(view, pos)

    pressArrow(view, 'ArrowDown')

    expect(imageAttrs(view, pos)).toEqual({ width: 1210, height: null })
  })

  it('reads ↑ as the shrink direction on the same basis as ←', async () => {
    // Before: {width: null} -> {width: 1}.
    const { view } = await makeEditor('![a](attachments/a.png)', [1200, 300])
    const pos = findImagePos(view.state.doc)
    selectImage(view, pos)

    pressArrow(view, 'ArrowUp')

    expect(imageAttrs(view, pos)).toEqual({ width: 1190, height: null })
  })

  it('steps from the width the browser draws when the column caps the image', async () => {
    // The same basis the drag's start width uses: a reader stepping a picture
    // drawn at 700px expects 710, not the file's 1210.
    const { view, host } = await makeEditor('![a](attachments/a.png)', [1200, 300])
    const pos = findImagePos(view.state.doc)
    selectImage(view, pos)
    const before = imageAttrs(view, pos)
    Object.defineProperty(imgOf(host), 'clientWidth', { value: 700, configurable: true })

    pressArrow(view, 'ArrowRight')

    expect(before).toEqual({ width: null, height: null })
    expect(imageAttrs(view, pos)).toEqual({ width: 710, height: null })
  })

  it('locks Shift+→ to the file’s ratio when only the width is stored', async () => {
    // A drag without Shift leaves exactly this state (node-view writes
    // `attrs.height = null`). Before: baseWidth 300 with a baseHeight
    // substituted as 400 -> ratio 300/400 -> {width: 310, height: 413}, and the
    // file would carry `{width=310 height=413}`: a 1200x300 screenshot drawn
    // 310x413.
    const { editor, view } = await makeEditor('![a](attachments/a.png){width=300}', [1200, 300])
    const pos = findImagePos(view.state.doc)
    selectImage(view, pos)
    expect(imageAttrs(view, pos)).toEqual({ width: 300, height: null })

    pressArrow(view, 'ArrowRight', true)

    // 1200/300 = 4; 310 / 4 = 77.5 -> 78.
    expect(imageAttrs(view, pos)).toEqual({ width: 310, height: 78 })
    expect(await editor.save()).toContain('{width=310 height=78}')
    editor.destroy()
  })

  it('refuses the step when the size cannot be established at all', async () => {
    // An <img> that has not loaded (or failed) reports 0/0: there is no size to
    // step from, so nothing is written. Before: {width: 11} and the file gained
    // `{width=11}`.
    const { editor, view } = await makeEditor('![a](attachments/a.png)')
    const pos = findImagePos(view.state.doc)
    selectImage(view, pos)
    const before = undoDepth(view.state)

    const handled = pressArrow(view, 'ArrowRight')

    expect(handled).toBe(true)
    expect(imageAttrs(view, pos)).toEqual({ width: null, height: null })
    expect(undoDepth(view.state)).toBe(before)
    expect(await editor.save()).not.toContain('{width')
    editor.destroy()
  })

  it('refuses a Shift step with no ratio to hold, instead of inventing one', async () => {
    // Before: baseWidth 1, baseHeight 400 -> ratio 1/400 -> {width: 11,
    // height: 4400} — the file gained `{width=11 height=4400}`.
    const { editor, view } = await makeEditor('![a](attachments/a.png)')
    const pos = findImagePos(view.state.doc)
    selectImage(view, pos)

    const handled = pressArrow(view, 'ArrowRight', true)

    expect(handled).toBe(true)
    expect(imageAttrs(view, pos)).toEqual({ width: null, height: null })
    expect(await editor.save()).not.toContain('height=')
    editor.destroy()
  })

  it('refuses a Shift step with no ratio to hold, but still steps the width', async () => {
    // A stored width with no stored height and no loaded element: the plain step
    // has a basis (300), the ratio does not exist — so Shift must write nothing
    // rather than pair 300 with an invented 400. Before: {width: 310,
    // height: 413}.
    const { view } = await makeEditor('![a](attachments/a.png){width=300}')
    const pos = findImagePos(view.state.doc)
    selectImage(view, pos)

    pressArrow(view, 'ArrowRight', true)
    expect(imageAttrs(view, pos)).toEqual({ width: 300, height: null })

    pressArrow(view, 'ArrowRight')
    expect(imageAttrs(view, pos)).toEqual({ width: 310, height: null })
  })
})

/**
 * The resize is the app's own change to the image the reader selected, and it
 * must not be what ends that selection.
 *
 * `setNodeMarkup` on a leaf is a ReplaceStep at the selection's anchor, which
 * ProseMirror maps as deleted: the NodeSelection came back as `Selection.near()`
 * — a text caret beside the picture. The first press therefore CONSUMED the
 * selection it acted on: every further press found a caret, the keymap declined,
 * and the reader had to click the image again for each step. The property panel
 * was told null on the same transition and closed.
 */
describe('the image stays selected across a resize', () => {
  it('presses → twice and the second press steps again', async () => {
    const { view } = await makeEditor('![a](attachments/a.png){width=300}')
    const pos = findImagePos(view.state.doc)
    selectImage(view, pos)

    pressArrow(view, 'ArrowRight')
    const afterFirst = view.state.selection
    expect(
      afterFirst instanceof NodeSelection,
      `after the first press the selection was ${afterFirst.constructor.name}(${afterFirst.from},${afterFirst.to})`,
    ).toBe(true)
    expect(imageAttrs(view, pos)).toEqual({ width: 310, height: null })

    pressArrow(view, 'ArrowRight')
    expect(imageAttrs(view, pos)).toEqual({ width: 320, height: null })
  })

  it('presses shift+→ twice and the second press steps again', async () => {
    const { view } = await makeEditor('![a](attachments/a.png){width=400 height=300}')
    const pos = findImagePos(view.state.doc)
    selectImage(view, pos)

    pressArrow(view, 'ArrowRight', true)
    expect(imageAttrs(view, pos)).toEqual({ width: 410, height: 308 })

    // The second step holds the ratio the first one wrote: 420 / (410/308).
    pressArrow(view, 'ArrowRight', true)
    expect(imageAttrs(view, pos)).toEqual({ width: 420, height: 316 })
  })

  it('keeps the property panel open: the selection never leaves the image', async () => {
    const { view } = await makeEditor('![a](attachments/a.png){width=300}')
    const pos = findImagePos(view.state.doc)
    clearImageSelection()
    const seen: Array<number | null> = []
    const stop = onImageSelectionChange((s) => seen.push(s ? s.pos : null))
    selectImage(view, pos)

    pressArrow(view, 'ArrowRight')

    stop()
    expect(seen).not.toContain(null)
    expect(getSelectedImage()?.pos).toBe(pos)
  })

  it('commits the resize in one transaction, so it stays one undo step', async () => {
    const { view } = await makeEditor('![a](attachments/a.png){width=300}')
    const pos = findImagePos(view.state.doc)
    selectImage(view, pos)
    let dispatches = 0
    const dispatch = view.dispatch.bind(view)
    view.dispatch = (tr) => {
      dispatches += 1
      dispatch(tr)
    }
    const before = undoDepth(view.state)

    pressArrow(view, 'ArrowRight')

    // A selection put back by a SECOND transaction would pass every other test
    // here and double the work (and the state updates) of every keypress.
    expect(dispatches).toBe(1)
    expect(undoDepth(view.state)).toBe(before + 1)
    expect(imageAttrs(view, pos)).toEqual({ width: 310, height: null })
  })

  it('leaves the selection on the image it resized, not on the next one', async () => {
    const { editor, view } = await makeEditor(
      '![a](attachments/a.png){width=300}\n\n![b](attachments/b.png){width=500}\n',
    )
    const pos = findImagePos(view.state.doc)
    selectImage(view, pos)

    pressArrow(view, 'ArrowRight')
    pressArrow(view, 'ArrowRight')

    const sel = view.state.selection
    expect(sel instanceof NodeSelection).toBe(true)
    expect(sel.from).toBe(pos)
    expect(await editor.save()).toContain('{width=320}')
    expect(await editor.save()).toContain('{width=500}')
    editor.destroy()
  })

  it('never acts on a caret the reader moved off the image', async () => {
    const { view } = await makeEditor('![a](attachments/a.png){width=300}')
    const pos = findImagePos(view.state.doc)
    selectImage(view, pos)
    pressArrow(view, 'ArrowRight')
    expect(imageAttrs(view, pos)).toEqual({ width: 310, height: null })

    // The caret beside the picture — the very position the old remap left the
    // selection at. It must be the browser's key again, not the image's.
    const caret = TextSelection.create(view.state.doc, view.state.doc.content.size - 1)
    view.dispatch(view.state.tr.setSelection(caret))

    const handled = pressArrow(view, 'ArrowRight')

    // The image is not re-selected on the strength of an earlier press: the key
    // belongs to the caret again, nothing was resized, and the panel is told to
    // close — the selection survives the resize, it does not become sticky.
    expect(handled).toBe(false)
    expect(view.state.selection instanceof NodeSelection).toBe(false)
    expect(view.state.selection.from).toBe(caret.from)
    expect(getSelectedImage()).toBeNull()
    expect(imageAttrs(view, pos)).toEqual({ width: 310, height: null })
  })

  it('cannot carry the selection into the note that replaced it', async () => {
    const { editor, view } = await makeEditor('![a](attachments/a.png){width=300}')
    const pos = findImagePos(view.state.doc)
    selectImage(view, pos)
    pressArrow(view, 'ArrowRight')

    await editor.open('# a note with no picture\n')

    const handled = pressArrow(view, 'ArrowRight')

    expect(handled).toBe(false)
    expect(view.state.selection instanceof NodeSelection).toBe(false)
    expect(await editor.save()).not.toContain('{width')
    editor.destroy()
  })
})
