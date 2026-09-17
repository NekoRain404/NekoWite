/**
 * The transcript's find bar, as a field with a keyboard and three answers.
 *
 * What it decides is which of three things it says about the query it was handed — nothing (no
 * query), a count (hits), or the sentence that stands for no match — and what every key does. The
 * rows it searches, the count itself and the scrolling to a hit are the timeline's and the
 * service's; this file is the box the reader actually types into.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createApp, defineComponent, h, nextTick, ref, type App as VueApp } from 'vue'
import { setLocale, t } from '../../../i18n'
import AgentTimelineSearch from './AgentTimelineSearch.vue'

let mounted: VueApp[] = []

beforeEach(() => {
  setLocale('en')
})

afterEach(() => {
  mounted.forEach((app) => app.unmount())
  mounted = []
  document.body.innerHTML = ''
})

interface Harness {
  readonly host: HTMLElement
  readonly field: HTMLInputElement
  readonly events: string[]
}

function open(initial = { query: '', index: -1, total: 0 }): Harness {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const state = ref(initial)
  const events: string[] = []
  const app = createApp(
    defineComponent({
      setup: () => () =>
        h(AgentTimelineSearch, {
          query: state.value.query,
          index: state.value.index,
          total: state.value.total,
          'onUpdate:query': (value: string) => {
            events.push(`query:${value}`)
            state.value = { ...state.value, query: value }
          },
          onNext: () => events.push('next'),
          onPrev: () => events.push('prev'),
          onClose: () => events.push('close'),
        }),
    }),
  )
  app.mount(host)
  mounted.push(app)
  const field = host.querySelector<HTMLInputElement>('[data-conversation-search]')
  if (field === null) throw new Error('the find bar did not render a field')
  return { host, field, events }
}

function press(field: HTMLInputElement, key: string, shift = false): void {
  field.dispatchEvent(new KeyboardEvent('keydown', { key, shiftKey: shift, bubbles: true, cancelable: true }))
}

describe('the transcript’s find bar', () => {
  it('is a named field the reader can type into', () => {
    const { field } = open()

    // The name and the placeholder are the catalogue's own, so the box the panel draws and the
    // box a translation describes cannot drift apart.
    expect(field.getAttribute('aria-label')).toBe(t('agent.panel.timeline.search.label'))
    expect(field.getAttribute('placeholder')).toBe(t('agent.panel.timeline.search.placeholder'))
  })

  it('hands every keystroke up as the query', () => {
    const { field, events } = open()

    field.value = 'needle'
    field.dispatchEvent(new Event('input'))

    expect(events).toEqual(['query:needle'])
  })

  it('says nothing about a query nobody has typed', () => {
    const { host } = open({ query: '', index: -1, total: 0 })

    expect(host.querySelector('[data-search-count]')).toBeNull()
    expect(host.textContent).not.toContain(t('agent.panel.timeline.search.noMatch'))
  })

  it('counts the hits, one-based, while the reader walks them', () => {
    const { host } = open({ query: 'needle', index: 2, total: 5 })

    expect(host.querySelector('[data-search-count]')?.textContent?.trim()).toBe('3/5')
    // …and the count is the control's own name for what it is: "3/5" read aloud is two numbers.
    expect(host.querySelector('[data-search-count]')?.getAttribute('aria-label')).toBe(
      t('agent.panel.timeline.search.count', { index: 3, total: 5 }),
    )
  })

  it('answers a query that matched nothing with its own sentence, not with a zero', () => {
    // The distinction the whole row turns on, and the one the history list's box keeps too
    // (`agent-session-history.ts`): "no match" is a sentence about what the reader typed, and a
    // counter reading "0/0" is a number that says the same thing less clearly — or worse, a
    // number a reader could read as a count of something else.
    const { host } = open({ query: 'nowhere', index: -1, total: 0 })

    expect(host.textContent).toContain(t('agent.panel.timeline.search.noMatch'))
    expect(host.querySelector('[data-search-count]')).toBeNull()
  })

  it('steps forward on Enter and back on Shift+Enter', () => {
    // Zed's own bindings inside its bar (`assets/keymaps/default-linux.json`, the
    // `AcpThreadSearchBar` context), and the reason both keys exist: a reader keeps their hands on
    // the field and walks the hits without reaching for the mouse.
    const { field, events } = open({ query: 'needle', index: 0, total: 4 })

    press(field, 'Enter')
    press(field, 'Enter', true)

    expect(events).toEqual(['next', 'prev'])
  })

  it('gives the query up on Escape before it gives up the bar', () => {
    // The app's other find box empties before it closes
    // (`AgentSessionHistoryMenu.vue`: "a query is cleared first, and only an empty box closes the
    // list"), and one Escape press losing a query the reader typed is a bigger loss than one
    // Escape press closing a bar they can reopen with one click.
    const { field, events } = open({ query: 'needle', index: 0, total: 4 })

    press(field, 'Escape')

    expect(events).toEqual(['query:'])
  })

  it('closes on Escape when there is nothing to give up', () => {
    const { field, events } = open({ query: '', index: -1, total: 0 })

    press(field, 'Escape')

    expect(events).toEqual(['close'])
  })

  it('offers the two arrows only while there is something to walk', () => {
    const empty = open({ query: 'nowhere', index: -1, total: 0 })
    const arrows = (host: HTMLElement): (HTMLButtonElement | null)[] => [
      host.querySelector<HTMLButtonElement>('[data-search-step="prev"]'),
      host.querySelector<HTMLButtonElement>('[data-search-step="next"]'),
    ]

    expect(arrows(empty.host).map((button) => button?.disabled)).toEqual([true, true])

    const withHits = open({ query: 'needle', index: 0, total: 2 })
    expect(arrows(withHits.host).map((button) => button?.disabled)).toEqual([false, false])
    arrows(withHits.host)[1]!.click()
    expect(withHits.events).toEqual(['next'])
  })

  it('offers to clear the query only while there is one', () => {
    const empty = open()
    expect(empty.host.querySelector('[data-search-clear]')).toBeNull()

    const typed = open({ query: 'needle', index: 0, total: 2 })
    typed.host.querySelector<HTMLButtonElement>('[data-search-clear]')!.click()
    expect(typed.events).toEqual(['query:'])
  })

  it('can be focused by whoever draws it', async () => {
    // Opening the bar has to put the reader in it: a find box that needs a second press before
    // it can be typed into is a box that has not opened.
    const host = document.createElement('div')
    document.body.appendChild(host)
    const bar = ref<InstanceType<typeof AgentTimelineSearch> | null>(null)
    const app = createApp(
      defineComponent({
        setup: () => () => h(AgentTimelineSearch, { ref: bar, query: '', index: -1, total: 0 }),
      }),
    )
    app.mount(host)
    mounted.push(app)
    await nextTick()

    bar.value?.focus()

    expect(document.activeElement).toBe(host.querySelector('[data-conversation-search]'))
  })
})
