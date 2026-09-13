import { describe, expect, it, beforeEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useTabsStore } from '../../../stores/tabs'
import { useViewStore } from '../../../stores/view'
import { createEditorScrollSync } from './editorScrollSync'

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
    // echo, so it is not a user scroll and the store is left alone.
    expect(scrollSync.onScroll()).toBe(false)
    expect(view.renderedScroll).toBe(0)
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
    expect(view.renderedScroll).toBe(120)
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
    expect(view.renderedScroll).toBe(500)
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
