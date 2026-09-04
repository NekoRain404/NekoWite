import { afterEach, describe, expect, it } from 'vitest'
import { undoDepth } from '@milkdown/prose/history'

import { advanceResizeDrag, beginResizeDrag, commitResizeDrag } from './drag'
import { createEditor, basicPlugins } from '../editor'

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

  function simulateDrag(img: HTMLElement, xs: number[]): void {
    img.dispatchEvent(new MouseEvent('pointerdown', { clientX: 0, clientY: 0, bubbles: true }))
    for (const x of xs) {
      window.dispatchEvent(new MouseEvent('pointermove', { clientX: x, clientY: 0, bubbles: true }))
    }
    window.dispatchEvent(new MouseEvent('pointerup', { clientX: xs[xs.length - 1], clientY: 0, bubbles: true }))
  }

  it('a whole resize drag lands as exactly one undo step', async () => {
    const el = document.createElement('div')
    document.body.appendChild(el)
    const editor = createEditor(el, { plugins: basicPlugins })
    await editor.open('![a](attachments/a.png)')

    const view = editor.getView()
    const img = el.querySelector('img') as HTMLImageElement
    expect(img).toBeTruthy()

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
})
