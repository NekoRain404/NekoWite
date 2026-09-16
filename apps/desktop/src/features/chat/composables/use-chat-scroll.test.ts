/**
 * The chat transcript's scroll policy (§5.2): follow the newest turn while the
 * reader is at the end, stop following the moment they leave it, and resume when
 * they come back or ask. The second half of the same sentence — 「提供新内容提示」 —
 * is the hint the last block here covers: what makes it appear, what number it is
 * allowed to carry, and what clears it.
 *
 * The one this is accepted on is the first: an answer that streams into a
 * transcript the reader has scrolled up in must not drag them back down. The
 * panel used to write `scrollTop = scrollHeight` on every chunk, which is a
 * container that holds the reader at the bottom for the length of the answer.
 *
 * happy-dom lays nothing out — every container reports a range of zero — so the
 * fake below gives the element the two measurements a browser would report and a
 * `scrollTop` that stays where it is written. It also delivers scroll events the
 * way a browser does: the reader's by hand, and the one our own write causes a
 * frame later.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { createApp, defineComponent, h, nextTick, ref, type App as VueApp } from 'vue'
import { useChatScroll, type ChatScroll } from './use-chat-scroll'

/** The container's height. */
const VIEWPORT = 400

interface Harness {
  /** Where the container is scrolled to, as the browser reports it. */
  top: () => number
  /** More content arrived below: the container's own height grew. */
  growContent: (by: number) => void
  /** The scroll event a programmatic write causes, delivered a frame later. */
  echo: () => Promise<void>
  /** The reader's hand: the container moves, then reports it. */
  userScroll: (top: number) => Promise<void>
  /** `n` turns appended to the list, as the transcript's watcher sees them. */
  arrive: (n: number) => Promise<void>
  /** `n` turns taken out of it: a cleared conversation, a retracted answer. */
  lose: (n: number) => Promise<void>
  scroll: ChatScroll
}

let mounted: VueApp[] = []

afterEach(() => {
  mounted.forEach((app) => app.unmount())
  mounted = []
})

function mount(): Harness {
  const host = document.createElement('div')
  document.body.appendChild(host)
  let content = VIEWPORT
  let top = 0
  let scroll: ChatScroll | null = null
  const count = ref(0)

  function stub(el: HTMLElement): void {
    Object.defineProperty(el, 'clientHeight', { configurable: true, get: () => VIEWPORT })
    Object.defineProperty(el, 'scrollHeight', { configurable: true, get: () => content })
    Object.defineProperty(el, 'scrollTop', {
      configurable: true,
      get: () => top,
      // No clamping: the composable clamps its own writes, and the test wants to
      // see exactly what it asked for.
      set: (value: number) => {
        top = value
      },
    })
  }

  const app = createApp(
    defineComponent({
      setup() {
        const container = ref<HTMLElement | null>(null)
        scroll = useChatScroll({ container, messageCount: () => count.value })
        return () =>
          h('div', {
            class: 'chat-scroll',
            onScroll: () => scroll!.onScroll(),
            ref: (el: unknown) => {
              const node = (el ?? null) as HTMLElement | null
              container.value = node
              if (node !== null) stub(node)
            },
          })
      },
    }),
  )
  app.mount(host)
  mounted.push(app)

  const el = host.querySelector<HTMLElement>('.chat-scroll')!

  return {
    top: () => el.scrollTop,
    growContent: (by) => {
      content += by
    },
    echo: async () => {
      el.dispatchEvent(new Event('scroll'))
      await nextTick()
    },
    userScroll: async (next) => {
      el.scrollTop = next
      el.dispatchEvent(new Event('scroll'))
      await nextTick()
    },
    arrive: async (n) => {
      count.value += n
      await nextTick()
    },
    lose: async (n) => {
      count.value -= n
      await nextTick()
    },
    get scroll() {
      return scroll!
    },
  }
}

/** Let the write `follow` / `jumpToEnd` staged for the next tick land. */
async function flush(): Promise<void> {
  await nextTick()
}

describe('useChatScroll — following the newest turn', () => {
  it('follows while the reader is at the end', async () => {
    const h = mount()
    h.growContent(200)

    h.scroll.follow()
    await flush()

    expect(h.top()).toBe(200)
    expect(h.scroll.suspended.value).toBe(false)
  })

  it('leaves a reader who scrolled up where they are', async () => {
    const h = mount()
    h.growContent(1000)
    h.scroll.follow()
    await flush()

    // They scroll up to re-read an earlier answer...
    await h.userScroll(100)
    expect(h.scroll.suspended.value).toBe(true)

    // ...and the answer streams on: three chunks, three following attempts.
    for (let i = 0; i < 3; i += 1) {
      h.growContent(40)
      h.scroll.follow()
      await flush()
      expect(h.top(), `after chunk ${i + 1}`).toBe(100)
    }
    expect(h.scroll.suspended.value).toBe(true)
  })

  it('follows again once they scroll back to the end', async () => {
    const h = mount()
    h.growContent(1000)
    h.scroll.follow()
    await flush()
    await h.userScroll(100)
    expect(h.scroll.suspended.value).toBe(true)

    // Their own scroll to the bottom is the explicit act the rule asks for.
    await h.userScroll(1000)
    expect(h.scroll.suspended.value).toBe(false)

    h.growContent(50)
    h.scroll.follow()
    await flush()
    expect(h.top()).toBe(1050)
  })

  it('does not read the scroll its own write causes as the reader leaving', async () => {
    const h = mount()
    h.growContent(200)
    h.scroll.follow()
    await flush()

    // Content arrived between the write and its echo, so the offset we wrote is
    // no longer the end: read as the reader's own move it would suspend a
    // transcript nobody touched, and the rest of the answer would stream off
    // screen.
    h.growContent(500)
    await h.echo()

    expect(h.scroll.suspended.value).toBe(false)
  })

  it('takes a suspended reader to the end when the conversation is replaced', async () => {
    const h = mount()
    h.growContent(1000)
    h.scroll.follow()
    await flush()
    await h.userScroll(0)
    expect(h.scroll.suspended.value).toBe(true)

    h.growContent(300)
    h.scroll.jumpToEnd()
    await flush()

    expect(h.top()).toBe(1300)
    expect(h.scroll.suspended.value).toBe(false)

    // And it is following again, not merely parked at the end.
    h.growContent(20)
    h.scroll.follow()
    await flush()
    expect(h.top()).toBe(1320)
  })
})

/**
 * The other half of the ruling (§5.2 「提供新内容提示」). Pausing for the reader is
 * only half of it: a reader who left the end while the answer was still being
 * written has no way to learn that it arrived, and no way back that does not
 * involve hunting for the bottom.
 *
 * Two things are asserted over and over below, because they are the two ways
 * this can be wrong: the hint appears only when the reader is away AND something
 * arrived, and its number is only ever whole messages they have not seen.
 */
describe('useChatScroll — the new-content hint', () => {
  /** A reader who scrolled up into an earlier answer, with more below them. */
  async function away(h: Harness): Promise<void> {
    h.growContent(1000)
    h.scroll.follow()
    await flush()
    await h.userScroll(100)
    expect(h.scroll.suspended.value).toBe(true)
  }

  it('says nothing while the reader is at the end', async () => {
    const h = mount()
    h.growContent(400)

    // The list grows under a reader who is watching it grow - the case where
    // there is nothing to announce, because they are looking at it.
    await h.arrive(2)

    expect(h.scroll.arrived.value).toBe(false)
    expect(h.scroll.pending.value).toBe(0)
  })

  it('counts the whole messages that arrived while they were away', async () => {
    const h = mount()
    await away(h)

    // A question and its answer arrived below the reader's place.
    await h.arrive(2)
    expect(h.scroll.arrived.value).toBe(true)
    expect(h.scroll.pending.value).toBe(2)

    // And it accumulates, within the same absence.
    await h.arrive(1)
    expect(h.scroll.pending.value).toBe(3)
  })

  it('announces content it cannot count, and adds no number', async () => {
    const h = mount()
    await away(h)

    // The answer the reader had already started reading grows: three chunks,
    // three arrivals, and not one message they have not seen.
    for (let i = 0; i < 3; i += 1) {
      h.growContent(40)
      h.scroll.follow()
      await flush()
    }

    expect(h.scroll.arrived.value).toBe(true)
    expect(h.scroll.pending.value, 'an inflated count is worse than none').toBe(0)
  })

  it('does not count a message twice while its answer streams in', async () => {
    const h = mount()
    await away(h)
    await h.arrive(1)
    expect(h.scroll.pending.value).toBe(1)

    // The turn it counted then streams: each chunk is content, none is a message.
    for (let i = 0; i < 4; i += 1) {
      h.growContent(30)
      h.scroll.follow()
      await flush()
    }
    expect(h.scroll.pending.value).toBe(1)
  })

  it('forgets the hint as soon as they are back at the end', async () => {
    const h = mount()
    await away(h)
    await h.arrive(2)

    // Their own scroll to the bottom, which is the act that resumes following.
    await h.userScroll(1000)
    expect(h.scroll.suspended.value).toBe(false)
    expect(h.scroll.arrived.value).toBe(false)
    expect(h.scroll.pending.value).toBe(0)

    // A stale count must not be waiting for them if they leave again: nothing
    // has arrived since, so there is nothing to say.
    await h.userScroll(100)
    expect(h.scroll.arrived.value).toBe(false)
  })

  it('clears on the move the hint itself makes', async () => {
    const h = mount()
    await away(h)
    await h.arrive(1)

    h.scroll.jumpToEnd()
    await flush()

    expect(h.scroll.suspended.value).toBe(false)
    expect(h.scroll.arrived.value).toBe(false)
    expect(h.scroll.pending.value).toBe(0)
  })

  it('does not count the list losing a turn', async () => {
    const h = mount()
    await away(h)

    // An answer that came back empty is retracted, and a cleared conversation
    // is emptied: neither is content arriving below anyone.
    await h.lose(2)
    expect(h.scroll.arrived.value).toBe(false)
    expect(h.scroll.pending.value).toBe(0)
  })
})
