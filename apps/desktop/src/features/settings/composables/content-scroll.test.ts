import { describe, expect, it } from 'vitest'
import { contentViewportOf, resetContentScroll } from './content-scroll'

/**
 * A box the engine would let a user scroll: the two `overflow-y` values that make one. Written as
 * an inline style because that is what `getComputedStyle` answers from in a DOM without a
 * stylesheet — the real dialog's value comes from `.dialog-content`'s own rule.
 */
function scrollable(tag = 'div', overflowY = 'auto'): HTMLElement {
  const el = document.createElement(tag)
  el.style.overflowY = overflowY
  return el
}

describe('the settings dialog’s content viewport', () => {
  it('is the nearest scrollable ancestor, not the first ancestor', () => {
    const viewport = scrollable()
    const wrap = document.createElement('div')
    const section = document.createElement('section')
    viewport.append(wrap)
    wrap.append(section)
    document.body.append(viewport)

    // Two ancestors, one scrollable and one not: a walk that stopped at the first would answer the
    // wrapper, and a walk that took the last would answer `body`.
    expect(contentViewportOf(section)).toBe(viewport)
  })

  it('is the element itself when it is the box that scrolls', () => {
    const viewport = scrollable()
    document.body.append(viewport)

    expect(contentViewportOf(viewport)).toBe(viewport)
  })

  it('skips a box that only clips its overflow', () => {
    // `.settings-dialog` is `overflow: hidden` — it rounds its own corners — and it is *outside*
    // `.dialog-content`. `hidden` is not "a box the user scrolls", so a reset aimed at it would be
    // the wrong element even though a script can move it.
    const outer = scrollable('div', 'hidden')
    const viewport = scrollable()
    const section = document.createElement('section')
    outer.append(viewport)
    viewport.append(section)
    document.body.append(outer)

    expect(contentViewportOf(section)).toBe(viewport)
  })

  it('answers nothing — rather than throwing — when nothing above it scrolls', () => {
    const section = document.createElement('section')
    document.body.append(section)

    expect(contentViewportOf(section)).toBeNull()
  })

  it('puts a reader at the top of the box, from wherever the box was left', () => {
    const viewport = scrollable()
    const wrap = document.createElement('div')
    const section = document.createElement('section')
    viewport.append(wrap)
    wrap.append(section)
    document.body.append(viewport)
    viewport.scrollTop = 186

    resetContentScroll(section)

    expect(viewport.scrollTop).toBe(0)
  })

  it('is not an error at a mount site with no box yet', () => {
    expect(() => resetContentScroll(null)).not.toThrow()
    expect(() => resetContentScroll(undefined)).not.toThrow()
  })
})
