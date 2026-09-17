/**
 * V4 — the timeline's scroll policy: follow while the reader is at the end of the log,
 * suspend when they leave it, resume only when they come back or ask, and hold the reading
 * position when the content above it changes height (§5.2).
 *
 * Two of these tests are the ones the task is accepted on, and they are the two a passing run
 * of everything else would not tell you about:
 *
 *  - the user's scroll is not stolen: a container the user moved keeps its offset while rows
 *    arrive beneath it, and keeps it again for the arrivals after that;
 *  - the anchor holds: a row above the viewport grows and the row the reader is on does not
 *    move on screen — which is the difference between "the correction ran" and "the
 *    correction ran in the right direction".
 *
 * happy-dom lays nothing out: every container reports a range of zero and every row sits at
 * 0, so a stream of arrivals would be indistinguishable from a stream of nothing. The fake
 * below gives the container a viewport and the rows the tops a browser would give them, which
 * is the arrangement `EditorPane.scrollSync.test.ts` already uses for the editor's two panes,
 * and for the same reason.
 *
 * It also reproduces the *ordering* a browser gives, because half of this composable is about
 * ordering: a height change is staged and only committed by the settle, so a captured anchor
 * is measured against the page as it was and the correction against the page as it became —
 * exactly what one Vue flush does with a pre-flush watcher and a post-update tick.
 *
 * The composable is exercised through a real component, not called bare, because it is one:
 * it measures the DOM before an update and corrects after it, and neither half exists outside
 * a render.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { createApp, defineComponent, h, nextTick, ref, type App as VueApp } from 'vue'
import { useAgentScroll, type AgentScroll } from './use-agent-scroll'

/** The container's height. Rows are 50px unless a test resizes one. */
const VIEWPORT = 400
const ROW = 50

interface Harness {
  scroller: HTMLElement
  /** The row elements, in order, as the DOM has them. */
  rows: () => HTMLElement[]
  /** Where the container is scrolled to, as the browser reports it. */
  top: () => number
  /** Where the reader sees row `index`: its top edge, relative to the container's top edge. */
  offsetOf: (index: number) => number
  /** Every offset the composable reported for per-session storage, in order. */
  reported: number[]
  scroll: AgentScroll
  /** One more row of content arrived. */
  appendRow: (height?: number) => Promise<void>
  /** A batch of rows arrived at once — what a snapshot's replay looks like on the way back. */
  appendRows: (count: number, height?: number) => Promise<void>
  /** A row changed height without a row arriving: a tool row's output expanded. Staged until
   *  the next settle, so the announcement can be made against the page as it still is. */
  resizeRow: (index: number, height: number) => void
  /** The reader's hand: the container moves, then reports it. */
  userScroll: (top: number) => Promise<void>
  /** The scroll event a programmatic write causes. A browser delivers it a frame later, and
   *  it is not the reader's hand. */
  echo: () => Promise<void>
  /** The height change a toggle makes, announced the way the timeline announces it. */
  contentChanged: () => Promise<void>
  /** The announcement alone: the capture runs synchronously here, before the settle commits
   *  the height change, which is the one moment a test can move the container underneath it. */
  announce: () => void
  /** The "back to the latest" button. */
  resume: () => Promise<void>
  /** The reader's follow switch, as the control drives it. */
  setFollowing: (on: boolean) => Promise<void>
  /** The transcript's navigation: go to one of the rows it is showing. */
  toRow: (index: number) => Promise<void>
  /** …and to the top of it. */
  toTop: () => Promise<void>
  settle: () => Promise<void>
}

let mounted: VueApp[] = []

/** A DOMRect shaped the way `getBoundingClientRect` reports one. Only the edges the composable
 *  reads are meaningful; the rest are present so nothing has to pretend. */
function rect(top: number, bottom: number): DOMRect {
  return {
    x: 0,
    y: top,
    top,
    bottom,
    left: 0,
    right: 0,
    width: 0,
    height: bottom - top,
    toJSON: () => ({}),
  } as DOMRect
}

function mount(
  options: { heights?: number[]; initialPosition?: number; noContainer?: boolean } = {},
): Harness {
  const host = document.createElement('div')
  document.body.appendChild(host)
  /** What the rows measure like *now*; a staged resize only lands here when a settle commits
   *  it, which is what makes the pre-update capture and the post-update correction two
   *  different readings of the same row. */
  const heights = [...(options.heights ?? [])]
  const staged: Array<[number, number]> = []
  const rowCount = ref(heights.length)
  const reported: number[] = []
  let scroll: AgentScroll | null = null

  const tops = (): number[] => {
    const out: number[] = []
    let at = 0
    for (const height of heights) {
      out.push(at)
      at += height
    }
    return out
  }
  const contentHeight = (): number => heights.reduce((sum, height) => sum + height, 0)

  /** The viewport the browser would report, defined in the ref callback rather than after
   *  mount: `onMounted` runs inside `app.mount()`, and a container that measures zero when it
   *  does would open every session at offset 0. */
  function stubScroller(el: HTMLElement): void {
    Object.defineProperty(el, 'clientHeight', { configurable: true, get: () => VIEWPORT })
    Object.defineProperty(el, 'scrollHeight', {
      configurable: true,
      get: () => Math.max(contentHeight(), VIEWPORT),
    })
    el.getBoundingClientRect = () => rect(0, VIEWPORT)
  }

  const app = createApp(
    defineComponent({
      setup() {
        const scroller = ref<HTMLElement | null>(null)
        scroll = useAgentScroll({
          container: scroller,
          rowCount: () => rowCount.value,
          initialPosition: options.initialPosition,
          onPosition: (top) => reported.push(top),
        })
        return () =>
          h(
            'div',
            {
              class: 'agent-scroll',
              // The binding the timeline makes: `@scroll` on the container.
              onScroll: () => scroll!.onScroll(),
              // `noContainer` leaves the template ref unfilled, which is the state a section
              // is in before its first render commits.
              ref: options.noContainer
                ? undefined
                : (el: unknown) => {
                    const node = (el ?? null) as HTMLElement | null
                    scroller.value = node
                    if (node !== null) stubScroller(node)
                  },
            },
            Array.from({ length: rowCount.value }, (_, index) =>
              h('div', { class: 'agent-row', 'data-index': index }),
            ),
          )
      },
    }),
  )
  app.mount(host)
  mounted.push(app)

  const scrollerEl = host.querySelector<HTMLElement>('.agent-scroll')!

  /** Re-measure the page the way a browser would: the container is pinned at the top of the
   *  viewport, the rows sit at their stacked tops and move with the scroll. */
  function measure(): void {
    scrollerEl.querySelectorAll<HTMLElement>('.agent-row').forEach((row, index) => {
      row.getBoundingClientRect = () => {
        const at = tops()
        return rect(
          at[index] - scrollerEl.scrollTop,
          at[index] + heights[index] - scrollerEl.scrollTop,
        )
      }
    })
  }
  measure()

  const settle = async (): Promise<void> => {
    for (const [index, height] of staged.splice(0)) heights[index] = height
    for (let i = 0; i < 4; i += 1) await nextTick()
    measure()
  }

  return {
    scroller: scrollerEl,
    rows: () => Array.from(scrollerEl.querySelectorAll<HTMLElement>('.agent-row')),
    top: () => scrollerEl.scrollTop,
    offsetOf: (index) => tops()[index] - scrollerEl.scrollTop,
    reported,
    get scroll() {
      return scroll!
    },
    appendRow: async (height = ROW) => {
      heights.push(height)
      rowCount.value = heights.length
      await settle()
    },
    appendRows: async (count, height = ROW) => {
      for (let i = 0; i < count; i += 1) heights.push(height)
      rowCount.value = heights.length
      await settle()
    },
    resizeRow: (index, height) => {
      staged.push([index, height])
    },
    userScroll: async (top) => {
      scrollerEl.scrollTop = top
      scrollerEl.dispatchEvent(new Event('scroll'))
      await settle()
    },
    echo: async () => {
      scrollerEl.dispatchEvent(new Event('scroll'))
      await settle()
    },
    contentChanged: async () => {
      scroll!.contentChanged()
      await settle()
    },
    announce: () => {
      scroll!.contentChanged()
    },
    resume: async () => {
      scroll!.resume()
      await settle()
    },
    setFollowing: async (on) => {
      scroll!.setFollowing(on)
      await settle()
    },
    toRow: async (index) => {
      scroll!.toRow(scrollerEl.querySelectorAll('.agent-row')[index] ?? null)
      await settle()
    },
    toTop: async () => {
      scroll!.toTop()
      await settle()
    },
    settle,
  }
}

/** The end of the log, in the fake's arithmetic. */
const endOf = (harness: Harness): number =>
  Number(harness.scroller.scrollHeight) - VIEWPORT

afterEach(() => {
  mounted.forEach((app) => app.unmount())
  mounted = []
  document.body.innerHTML = ''
})

describe('useAgentScroll — the end of the log', () => {
  it('opens at the end and keeps up while the reader stays there', async () => {
    const harness = mount({ heights: Array.from({ length: 20 }, () => ROW) })
    expect(harness.top()).toBe(600)

    await harness.appendRow()
    expect(harness.top()).toBe(650)
    await harness.appendRow()
    expect(harness.top()).toBe(700)
    expect(harness.scroll.suspended.value).toBe(false)
    expect(harness.scroll.pending.value).toBe(0)
    expect(harness.scroll.atEnd.value).toBe(true)
  })

  it('does not steal the user’s scroll: the offset holds while rows arrive under it', async () => {
    const harness = mount({ heights: Array.from({ length: 20 }, () => ROW) })
    await harness.userScroll(200)
    expect(harness.scroll.suspended.value).toBe(true)

    await harness.appendRow()
    // The naive version of this file pins on every arrival, and this is the assertion it
    // would fail: the reader is at 200 and stays at 200.
    expect(harness.top()).toBe(200)
    expect(harness.scroll.pending.value).toBe(1)

    // …and it still holds for the arrivals after that, which is the case the rule is actually
    // about: one arrival can pass for luck, a second cannot.
    await harness.appendRow()
    await harness.appendRow()
    expect(harness.top()).toBe(200)
    expect(harness.scroll.pending.value).toBe(3)
    expect(harness.scroll.suspended.value).toBe(true)
  })

  it('suspends for a scroll the reader made while content was already arriving', async () => {
    const harness = mount({ heights: Array.from({ length: 20 }, () => ROW) })
    // The arrival lands first: the reader had already dragged, and their scroll event is
    // delivered a frame behind it. The arrival after that must not take them back to the end
    // the first one left behind.
    await harness.appendRow()
    expect(harness.top()).toBe(650)

    await harness.userScroll(300)
    expect(harness.scroll.suspended.value).toBe(true)

    await harness.appendRow()
    expect(harness.top()).toBe(300)
    expect(harness.scroll.pending.value).toBe(1)
  })

  it('reads its own corrections as its own, not as a scroll the user made', async () => {
    const harness = mount({ heights: Array.from({ length: 20 }, () => ROW) })
    await harness.appendRow()
    await harness.echo()
    // A browser delivers a scroll event for the write we just made. Taking it for the reader's
    // hand is how a following session suspends itself for no reason.
    expect(harness.scroll.suspended.value).toBe(false)
    expect(harness.scroll.pending.value).toBe(0)
  })

  it('goes back to the end when asked, and follows again once it is there', async () => {
    const harness = mount({ heights: Array.from({ length: 20 }, () => ROW) })
    await harness.userScroll(150)
    await harness.appendRow()
    expect(harness.scroll.pending.value).toBe(1)

    await harness.resume()
    expect(harness.top()).toBe(endOf(harness))
    expect(harness.scroll.pending.value).toBe(0)
    expect(harness.scroll.suspended.value).toBe(false)

    await harness.appendRow()
    expect(harness.top()).toBe(endOf(harness))
  })

  it('takes the user’s own scroll back to the end as the same explicit action', async () => {
    const harness = mount({ heights: Array.from({ length: 20 }, () => ROW) })
    await harness.userScroll(150)
    await harness.appendRow()
    expect(harness.scroll.pending.value).toBe(1)

    await harness.userScroll(endOf(harness))
    expect(harness.scroll.suspended.value).toBe(false)
    expect(harness.scroll.pending.value).toBe(0)

    await harness.appendRow()
    expect(harness.top()).toBe(endOf(harness))
  })
})

describe('useAgentScroll — the reader’s own switch over following', () => {
  it('parks the log where it is, and holds it there, when the reader turns following off', async () => {
    const harness = mount({ heights: Array.from({ length: 20 }, () => ROW) })
    expect(harness.scroll.following.value).toBe(true)
    expect(harness.top()).toBe(600)

    await harness.setFollowing(false)
    // Turning a follow switch off is not a move: the container is exactly where it was.
    expect(harness.top()).toBe(600)
    expect(harness.scroll.following.value).toBe(false)

    // The discriminating half. With the switch on this arrival pins to 650; with it off the
    // container must not move at all, because the reader asked for the log to stay still while
    // they read the message they are on. This is the case a toggle that merely *looks* like a
    // toggle fails: it suspends the hint and follows anyway.
    await harness.appendRow()
    expect(harness.top()).toBe(600)
    expect(harness.scroll.pending.value).toBe(1)

    await harness.appendRow()
    expect(harness.top()).toBe(600)
    expect(harness.scroll.pending.value).toBe(2)
  })

  it('accounts for the switch, not only for a scroll, when a row above the fold grows', async () => {
    const harness = mount({ heights: Array.from({ length: 20 }, () => ROW) })
    await harness.setFollowing(false)
    // Row 12 is the first the reader sees at the end; rows 0-11 are above the viewport.
    expect(harness.offsetOf(12)).toBe(0)

    harness.resizeRow(2, 250)
    await harness.contentChanged()

    // FAILS IF: the anchor was never recorded when the switch was turned off. A following
    // container has none — there was nothing to hold — and the correction would then be skipped
    // entirely, moving the reader down with everything else by 200px.
    expect(harness.offsetOf(12)).toBe(0)
    expect(harness.top()).toBe(800)
  })

  it('turns itself off for the reader’s own scroll and on again at the end', async () => {
    const harness = mount({ heights: Array.from({ length: 20 }, () => ROW) })
    await harness.userScroll(200)
    // One fact, two polarities: the automatic suspension *is* the switch being off, which is
    // why the control can never contradict the container.
    expect(harness.scroll.following.value).toBe(false)

    await harness.userScroll(endOf(harness))
    expect(harness.scroll.following.value).toBe(true)
    await harness.appendRow()
    expect(harness.top()).toBe(endOf(harness))
  })

  it('goes to the end and follows again when the reader turns it back on', async () => {
    const harness = mount({ heights: Array.from({ length: 20 }, () => ROW) })
    await harness.userScroll(150)
    await harness.appendRow()
    expect(harness.scroll.pending.value).toBe(1)

    await harness.setFollowing(true)
    expect(harness.top()).toBe(endOf(harness))
    expect(harness.scroll.following.value).toBe(true)
    expect(harness.scroll.pending.value).toBe(0)

    await harness.appendRow()
    expect(harness.top()).toBe(endOf(harness))
  })

  it('answers the switch before the container exists', async () => {
    const harness = mount({ heights: Array.from({ length: 3 }, () => ROW), noContainer: true })
    expect(() => harness.scroll.setFollowing(false)).not.toThrow()
    expect(harness.scroll.following.value).toBe(true)
  })
})

describe('useAgentScroll — the transcript’s own navigation', () => {
  it('goes to the row the reader asked for, and stops following from there', async () => {
    const harness = mount({ heights: Array.from({ length: 20 }, () => ROW) })
    expect(harness.top()).toBe(600)

    // Row 6's top edge is at 300px of content, which is where the container has to sit for the
    // reader to be looking at it.
    await harness.toRow(6)
    expect(harness.top()).toBe(300)
    // A row that is not the end is somewhere the reader chose to be, so arrivals must not move
    // them — the same rule their own scroll obeys.
    expect(harness.scroll.following.value).toBe(false)

    await harness.appendRow()
    expect(harness.top()).toBe(300)
    expect(harness.scroll.pending.value).toBe(1)
  })

  it('goes to the top of the log', async () => {
    const harness = mount({ heights: Array.from({ length: 20 }, () => ROW) })
    await harness.toTop()
    expect(harness.top()).toBe(0)
    expect(harness.scroll.following.value).toBe(false)

    await harness.appendRow()
    expect(harness.top()).toBe(0)
  })

  it('follows again when the row it is sent to is the end', async () => {
    const harness = mount({ heights: Array.from({ length: 20 }, () => ROW) })
    await harness.toTop()
    expect(harness.scroll.following.value).toBe(false)

    // The newest row: the reader asking for the end by name is the same explicit act as
    // scrolling there or pressing the way back, and the container has to follow again.
    await harness.toRow(19)
    expect(harness.top()).toBe(endOf(harness))
    expect(harness.scroll.following.value).toBe(true)

    await harness.appendRow()
    expect(harness.top()).toBe(endOf(harness))
  })

  it('refuses a row that is not in the container rather than guessing', async () => {
    const harness = mount({ heights: Array.from({ length: 20 }, () => ROW) })
    const before = harness.top()
    harness.scroll.toRow(null)
    harness.scroll.toRow(document.createElement('div'))
    await harness.settle()
    expect(harness.top()).toBe(before)
  })
})

describe('useAgentScroll — the anchor', () => {
  it('holds the row the reader is on when a row above the viewport grows', async () => {
    const harness = mount({ heights: Array.from({ length: 20 }, () => ROW) })
    await harness.userScroll(300)
    // Row 6 is the first the reader sees; rows 0-5 are above the viewport.
    expect(harness.offsetOf(6)).toBe(0)

    // A tool row four rows above the fold takes 200px more: everything below it moves down,
    // and without a correction the reader is looking at a different message.
    harness.resizeRow(2, 250)
    await harness.contentChanged()

    expect(harness.offsetOf(6)).toBe(0)
    // The container followed the growth rather than staying put: what was kept is the
    // reader's row, not the scroll offset.
    expect(harness.top()).toBe(500)

    // The scroll event that correction causes is our own, and must not read as the reader
    // arriving back at the end (or anywhere else).
    await harness.echo()
    expect(harness.scroll.suspended.value).toBe(true)
  })

  it('stays at the end while following when a row grows', async () => {
    const harness = mount({ heights: Array.from({ length: 20 }, () => ROW) })
    harness.resizeRow(2, 250)
    await harness.contentChanged()
    expect(harness.top()).toBe(endOf(harness))
    expect(harness.scroll.suspended.value).toBe(false)
  })

  it('leaves a container the reader moved mid-change alone', async () => {
    const harness = mount({ heights: Array.from({ length: 20 }, () => ROW) })
    await harness.userScroll(300)
    // The reader moves the container between the capture and the correction — the one frame
    // in which the composable is working from a stale reading. Their hand wins.
    harness.resizeRow(2, 250)
    harness.announce()
    harness.scroller.scrollTop = 250
    await harness.settle()
    expect(harness.top()).toBe(250)
  })

  it('corrects nothing it was not told about', async () => {
    // The row count is what the composable watches, and a growing tool row does not change
    // it: a change with no row of its own only reaches this module through the timeline's own
    // announcement. This is that limitation, stated as a test rather than discovered later.
    const harness = mount({ heights: Array.from({ length: 20 }, () => ROW) })
    await harness.userScroll(300)
    harness.resizeRow(0, 500)
    await harness.settle()
    // 450px of new height above the reader, and nothing moved to answer it: this is the
    // failure the announcement exists to prevent.
    expect(harness.offsetOf(6)).toBe(450)
    expect(harness.top()).toBe(300)
  })

  it('holds for a change that arrives with no row of its own', async () => {
    const harness = mount({ heights: Array.from({ length: 20 }, () => ROW) })
    await harness.userScroll(300)
    harness.resizeRow(0, 500)
    await harness.contentChanged()
    expect(harness.offsetOf(6)).toBe(0)
    expect(harness.top()).toBe(750)
  })
})

describe('useAgentScroll — the session’s own position', () => {
  it('reports where the container ends up, once per offset', async () => {
    const harness = mount({ heights: Array.from({ length: 20 }, () => ROW) })
    expect(harness.reported).toEqual([600])

    await harness.userScroll(200)
    await harness.userScroll(200)
    expect(harness.reported).toEqual([600, 200])

    await harness.appendRow()
    expect(harness.reported).toEqual([600, 200])

    await harness.resume()
    await harness.appendRow()
    expect(harness.reported).toEqual([600, 200, 650, 700])
  })

  it('opens a session where the reader left it', async () => {
    const harness = mount({ heights: Array.from({ length: 20 }, () => ROW), initialPosition: 120 })
    expect(harness.top()).toBe(120)
    expect(harness.scroll.suspended.value).toBe(true)

    await harness.appendRow()
    expect(harness.top()).toBe(120)
  })

  it('holds a remembered position for the rows it is a position in', async () => {
    // What a panel actually does on the way back: it mounts before the snapshot has rebuilt the
    // transcript, so the container is empty and an offset into it would clamp to zero.
    const harness = mount({ heights: [], initialPosition: 120 })
    expect(harness.top()).toBe(0)

    await harness.appendRows(20)
    expect(harness.top()).toBe(120)
    expect(harness.scroll.suspended.value).toBe(true)

    // …and the rows that bring the transcript back are not arrivals under a reader: nothing was
    // counted as unseen.
    expect(harness.scroll.pending.value).toBe(0)
    await harness.appendRow()
    expect(harness.top()).toBe(120)
  })

  it('gives up a remembered position the transcript that came back cannot hold', async () => {
    // A session whose transcript is shorter than the offset remembered for it has nowhere to
    // put the reader; the wait ends rather than holding every later arrival off the end.
    const harness = mount({ heights: [], initialPosition: 900 })
    await harness.appendRows(3)
    expect(harness.top()).toBe(0)
    expect(harness.scroll.suspended.value).toBe(false)

    await harness.appendRow()
    await harness.appendRow()
    expect(harness.top()).toBe(endOf(harness))
  })

  it('opens at the end when the remembered offset is past it', async () => {
    const harness = mount({ heights: Array.from({ length: 20 }, () => ROW), initialPosition: 5000 })
    expect(harness.top()).toBe(600)
    expect(harness.scroll.suspended.value).toBe(false)

    await harness.appendRow()
    expect(harness.top()).toBe(650)
  })

  it('answers every action before the container exists', async () => {
    // The panel drives these from watchers and event handlers, and the container is a template
    // ref: a call can be queued before the element is there.
    const harness = mount({ heights: Array.from({ length: 3 }, () => ROW), noContainer: true })

    expect(() => {
      harness.scroll.onScroll()
      harness.scroll.resume()
      harness.scroll.contentChanged()
      harness.scroll.restore(10)
    }).not.toThrow()
    expect(harness.scroll.suspended.value).toBe(false)
    expect(harness.scroll.pending.value).toBe(0)
  })
})
