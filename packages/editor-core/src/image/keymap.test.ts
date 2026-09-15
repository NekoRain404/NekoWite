import { afterEach, describe, expect, it } from 'vitest'
import { undoDepth } from '@milkdown/prose/history'
import { NodeSelection } from '@milkdown/prose/state'
import type { EditorView } from '@milkdown/prose/view'

import { basicPlugins, createEditor } from '../editor'

function findImagePos(doc: unknown): number {
  let pos: number | null = null
  ;(doc as import('@milkdown/prose/model').Node).descendants((n, p) => {
    if (n.type.name === 'image') {
      pos = p
      return false
    }
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
    // One press per selection: a resize replaces the node's markup, so
    // ProseMirror maps the NodeSelection away (sameMarkup is false) and falls
    // back to a text selection at the image's edge. A second press therefore
    // needs a fresh click on the image — pre-existing, not this fix's doing.
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
