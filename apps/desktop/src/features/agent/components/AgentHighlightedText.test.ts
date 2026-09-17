/**
 * The one thing a row's text must survive being highlighted: itself.
 *
 * The transcript is the panel's body (§5.3), and every row already renders as one text node. What
 * this component does is put elements inside that text, which is exactly the kind of change that
 * silently rewrites what the reader is reading — a collapsed space, a stripped newline, a
 * re-joined line. So the assertions below are about the text being byte-for-byte what it was,
 * with the marks on the ranges and nowhere else.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { createApp, defineComponent, h, type App as VueApp } from 'vue'
import AgentHighlightedText from './AgentHighlightedText.vue'

let mounted: VueApp[] = []

function render(text: string, hits: readonly { start: number; end: number }[], active = -1): HTMLElement {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const app = createApp(
    defineComponent({ setup: () => () => h(AgentHighlightedText, { text, hits, active }) }),
  )
  app.mount(host)
  mounted.push(app)
  return host
}

function clean(): void {
  mounted.forEach((app) => app.unmount())
  mounted = []
  document.body.innerHTML = ''
}

describe('a row’s text with its hits marked', () => {  it('draws the text exactly as it was, with a mark over each hit', () => {
    const host = render('the needle and the needle', [
      { start: 4, end: 10 },
      { start: 19, end: 25 },
    ])
    const marks = [...host.querySelectorAll('mark')]

    expect(marks.map((mark) => mark.textContent)).toEqual(['needle', 'needle'])
    // The whole thing, re-joined: no space collapsed away, none invented.
    expect(host.textContent).toBe('the needle and the needle')
  })

  it('keeps the whitespace a row’s own layout depends on', () => {
    // Rows are `white-space: pre-wrap`, so the spaces around a hit are content — a mark that
    // swallowed one would move the words it is highlighting.
    const host = render('  a NEEDLE  b  ', [{ start: 4, end: 10 }])

    expect(host.textContent).toBe('  a NEEDLE  b  ')
    expect(host.querySelector('mark')?.textContent).toBe('NEEDLE')
  })

  it('marks the hit the reader is on, and only that one', () => {
    // The active hit is what the arrows move between and what the container scrolls to, so it has
    // to be findable in the DOM — and findable *once*: two elements claiming to be the active hit
    // would make "scroll to the hit" ambiguous.
    const host = render('one two one', [
      { start: 0, end: 3 },
      { start: 8, end: 11 },
    ], 1)

    const active = [...host.querySelectorAll('[data-agent-hit="active"]')]
    expect(active.length).toBe(1)
    expect(active[0].textContent).toBe('one')
    expect(active[0]).toBe(host.querySelectorAll('mark')[1])
  })

  it('draws a plain text node when there is nothing to mark', () => {
    // The overwhelmingly common case, and the one a stray empty `<mark>` would show up in: a row
    // nobody searched must render the way it always rendered.
    const host = render('nothing to find here', [])

    expect(host.querySelectorAll('mark').length).toBe(0)
    expect(host.textContent).toBe('nothing to find here')
  })
})

afterEach(clean)