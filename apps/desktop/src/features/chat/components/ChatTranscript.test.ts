/**
 * The transcript's rows are elements the reader is reading, and the fix they are
 * accepted on is that they stay the same elements while the log changes around
 * them.
 *
 * Two behaviours, and only the first is visible on screen today:
 *
 *  - an answer being streamed keeps the element it started in, chunk after chunk.
 *    This holds whatever the key is *while the list only ever grows at its end*,
 *    which is what the chat does today — so this test is the rule's regression
 *    guard rather than evidence of a repair: it is what fails the day a chunk
 *    starts producing a new row per chunk, or the row gains a transition of its
 *    own.
 *  - a turn that is not the one being read keeps its element when another turn is
 *    inserted before it. This one fails outright under an index key: Vue reuses
 *    component instances by position, so the element the reader is on is handed
 *    to the next message down and its own is built again.
 *  - the hint back to the newest turn (§5.2 「提供新内容提示」): it is drawn only for
 *    a reader who is away AND has had something arrive, its number is whole
 *    messages and nothing else, and it is gone the moment they are at the end
 *    again. Its element survives the streaming that raises it, which is what
 *    keeps it from being rebuilt under the reader's cursor on every chunk.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { createApp, defineComponent, h, nextTick, ref, type App as VueApp } from 'vue'
import ChatTranscript from './ChatTranscript.vue'
import { nextMessageId, type PanelMessage } from '../types'
import { t } from '../../../i18n'

let mounted: VueApp[] = []

afterEach(() => {
  mounted.forEach((app) => app.unmount())
  mounted = []
})

function turn(id: string, role: PanelMessage['role'], content: string): PanelMessage {
  return { id, role, content }
}

/** Two turns, enough of them for a reader to have somewhere to scroll back to. */
function first(): PanelMessage[] {
  return [turn('a', 'user', 'an earlier question'), turn('b', 'assistant', 'an earlier answer')]
}

/** The container's height, and the height its content starts at: there has to be
 *  somewhere for the reader to scroll *to* before they can be away from the end. */
const VIEWPORT = 400
const CONTENT = 1600

interface Mounted {
  host: HTMLElement
  /** The list the panel would be holding: mutating it is a re-render. */
  messages: PanelMessage[]
  /** Turns appended the way the send path appends them. */
  append(...turns: PanelMessage[]): void
  /** More text in the log: the container's own content grew. */
  grow(by: number): void
  /** The reader's own scroll, delivered the way a browser delivers it. */
  scrollTo(top: number): Promise<void>
  /** A chunk of the streaming answer, as the send path reports it: the write,
   *  then the `follow` the panel makes through its template ref. */
  chunk(text: string, grewBy: number): Promise<void>
  /** The offset that is the end of the log. */
  end(): number
  /** Where the container is scrolled to. */
  top(): number
}

/** Mount the transcript the way the panel does: one reactive list, and the rows
 *  re-rendered from it whenever it changes. */
function mount(initial: PanelMessage[]): Mounted {
  const list = ref<PanelMessage[]>(initial)
  const host = document.createElement('div')
  document.body.appendChild(host)
  // The template ref the panel holds: what the send path calls `follow` through.
  const transcript = ref<InstanceType<typeof ChatTranscript> | null>(null)
  const app = createApp(
    defineComponent({
      setup: () => () =>
        h(ChatTranscript, { ref: transcript, messages: list.value, canInsert: false }),
    }),
  )
  app.mount(host)
  mounted.push(app)

  const el = host.querySelector<HTMLElement>('.chat-scroll')!
  let content = CONTENT
  let top = 0
  // happy-dom lays nothing out — every element reports a height of zero — so the
  // container is given the two measurements a browser would report, and a
  // `scrollTop` that stays where it is written. The same stub the policy's own
  // test uses: this file is about what the transcript draws for a reader the
  // policy has already suspended.
  Object.defineProperty(el, 'clientHeight', { configurable: true, get: () => VIEWPORT })
  Object.defineProperty(el, 'scrollHeight', { configurable: true, get: () => content })
  Object.defineProperty(el, 'scrollTop', {
    configurable: true,
    get: () => top,
    set: (value: number) => {
      top = value
    },
  })

  return {
    host,
    get messages(): PanelMessage[] {
      return list.value
    },
    append(...turns: PanelMessage[]): void {
      list.value = [...list.value, ...turns]
    },
    grow(by: number): void {
      content += by
    },
    async scrollTo(next: number): Promise<void> {
      el.scrollTop = next
      el.dispatchEvent(new Event('scroll'))
      await nextTick()
    },
    async chunk(text: string, grewBy: number): Promise<void> {
      // The last turn is the one an answer streams into (`use-chat-send` writes
      // through the placeholder it appended) — the same object the transcript
      // holds, so the write reaches the row.
      const last = list.value[list.value.length - 1]!
      last.content += text
      content += grewBy
      transcript.value?.follow()
      await nextTick()
    },
    end: () => content - VIEWPORT,
    top: () => el.scrollTop,
  }
}

/** The row drawing the turn whose text contains `text`. */
function rowShowing(host: HTMLElement, text: string): HTMLElement | undefined {
  return [...host.querySelectorAll<HTMLElement>('.chat-row')].find(
    (row) => row.querySelector('.chat-content')?.textContent?.includes(text) ?? false,
  )
}

describe('ChatTranscript — the elements it draws', () => {
  it('keeps the element of a turn that is inserted before', async () => {
    const { host, messages } = mount([turn('a', 'user', 'first'), turn('b', 'assistant', 'second')])

    const before = rowShowing(host, 'second')
    expect(before, 'the second turn is on screen').toBeTruthy()

    // An earlier turn arrives in front of it. Nothing in the panel does this
    // today; the keys are what decide whether the drawn list survives it when
    // something does.
    messages.unshift(turn('c', 'user', 'inserted at the front'))
    await nextTick()

    expect(rowShowing(host, 'second')).toBe(before)
    expect(host.querySelectorAll('.chat-row')).toHaveLength(3)
  })

  it('keeps the element of the answer being streamed, chunk after chunk', async () => {
    const { host, messages } = mount([turn('a', 'user', 'question'), turn('b', 'assistant', '')])

    const row = rowShowing(host, 'question')!.nextElementSibling as HTMLElement
    expect(row.className).toContain('assistant')

    for (const chunk of ['Hel', 'Hello', 'Hello wor', 'Hello world']) {
      messages[1]!.content = chunk
      await nextTick()
      expect(rowShowing(host, chunk), `the row for "${chunk}"`).toBe(row)
    }
  })

  it('draws two identical turns as two rows', async () => {
    // The other half of a key derived from the content: a repeat of the same
    // question would collide with the first one and take its element.
    const { host } = mount([
      turn(nextMessageId(), 'user', 'same'),
      turn(nextMessageId(), 'user', 'same'),
    ])
    expect(host.querySelectorAll('.chat-row')).toHaveLength(2)
  })

  it('is a log that keeps its role and hands the speaking to the send path', () => {
    const { host } = mount(first())
    const log = host.querySelector<HTMLElement>('.chat-scroll')!

    // The decision, asserted where it is made: `role="log"` is the right
    // semantics for a transcript, and `aria-live="off"` takes back the polite
    // announcement the role implies by default - a container whose text grows
    // per chunk must not be what speaks (§5.2 「不能每 token 都触发朗读」). The
    // other half of the decision, that the finished turn *is* announced, is
    // asserted in `use-chat-commands.test.ts`; neither half is worth anything
    // on its own, which is why both are pinned.
    expect(log.getAttribute('role')).toBe('log')
    expect(log.getAttribute('aria-live')).toBe('off')
    // Labelled, because a reader who is told an answer is ready has to be able
    // to find the log it is in.
    expect(log.getAttribute('aria-label')).toBe(t('chat.transcript'))
  })
})

/** The hint is a button and not a live region, so it is found by being one. */
function pill(host: HTMLElement): HTMLElement | null {
  return host.querySelector<HTMLElement>('[data-chat-jump]')
}

describe('ChatTranscript — the way back to the newest turn', () => {
  it('is not there for a reader who has not left the end', async () => {
    const h = mount(first())
    expect(pill(h.host)).toBeNull()

    // Nor for one who is at the end while turns arrive: there is nothing to
    // announce to someone watching it arrive.
    h.append(turn('c', 'user', 'and another question'))
    await nextTick()
    expect(pill(h.host)).toBeNull()
  })

  it('names the messages that arrived below a reader who left', async () => {
    const h = mount(first())
    await h.scrollTo(0)

    // Their own question and its answer, appended below the place they are
    // reading — two turns they have not seen, and the only thing this is
    // allowed to count.
    h.append(turn('c', 'user', 'a new question'), turn('d', 'assistant', ''))
    await nextTick()

    expect(pill(h.host)?.textContent).toContain(t('chat.newMessages', { count: 2 }))
  })

  it('says content arrived without a number when it cannot count it', async () => {
    const h = mount([turn('a', 'user', 'an earlier question'), turn('b', 'assistant', 'Hel')])
    await h.scrollTo(0)

    // Three chunks of the answer the reader had already started reading:
    // content arrived, and not one message they have not seen did.
    await h.chunk('lo', 40)
    await h.chunk(' wor', 40)
    await h.chunk('ld', 40)

    const text = pill(h.host)?.textContent ?? ''
    expect(text).toContain(t('chat.newContent'))
    expect(text, 'an inflated count is worse than none').not.toMatch(/\d/)
  })

  it('is gone once they are back at the end', async () => {
    const h = mount(first())
    await h.scrollTo(0)
    h.append(turn('c', 'assistant', 'an answer they missed'))
    await nextTick()
    expect(pill(h.host)).toBeTruthy()

    // Their own scroll down. The stale count must go with it: a pill over an
    // empty gap is a lie about content that has already been read.
    await h.scrollTo(h.end())
    expect(pill(h.host)).toBeNull()
  })

  it('does not come back with a spent count when they leave the end again', async () => {
    const h = mount(first())
    await h.scrollTo(0)
    h.append(turn('c', 'assistant', 'an answer they missed'))
    await nextTick()
    expect(pill(h.host)?.textContent).toContain(t('chat.newMessages', { count: 1 }))

    // Down to the end — the count is spent — and up again with nothing having
    // arrived in between. The pill reappearing here would point at content the
    // reader has already read, which is the same lie as an inflated number, one
    // step further out.
    await h.scrollTo(h.end())
    await h.scrollTo(0)
    expect(pill(h.host)).toBeNull()
  })

  it('stays the same element while the answer streams in', async () => {
    const h = mount(first())
    await h.scrollTo(0)
    h.append(turn('c', 'assistant', ''))
    await nextTick()

    const raised = pill(h.host)
    expect(raised).toBeTruthy()

    // Chunk after chunk, all of it landing below them. The pill is raised once
    // and keeps its element: nothing about it is rebuilt per chunk, which is
    // what would make the reader watch it flicker under their cursor instead of
    // the transcript they scrolled up to read.
    for (const chunk of ['a', 'n an', 'swer']) await h.chunk(chunk, 30)
    expect(pill(h.host)).toBe(raised)
  })

  it('takes the reader to the end, and following starts again from there', async () => {
    const h = mount(first())
    await h.scrollTo(0)
    h.append(turn('c', 'assistant', 'the answer they missed'))
    await nextTick()

    pill(h.host)!.click()
    await nextTick()
    await nextTick()

    expect(pill(h.host), 'the hint has nothing left to point at').toBeNull()
    expect(h.top()).toBe(h.end())

    // 「回到最底部才恢复」: the resume condition is arrival at the end, and the
    // click arrived there — so the next chunk follows without being asked.
    await h.chunk(' and more', 60)
    expect(h.top()).toBe(h.end())
  })
})
