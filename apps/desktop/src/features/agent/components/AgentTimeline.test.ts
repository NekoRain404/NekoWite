/**
 * The transcript's keyboard contract: the container is a tab stop, it says what it is, and the
 * stop does not swallow a key.
 *
 * This is the DOM half of what the WebKit probe measures behaviourally. The probe is the
 * authority on whether a real engine scrolls a focused container with PageDown; what a unit
 * test can hold — cheaply, in every run — is the contract a future edit would break silently:
 * `tabindex` removed from the container (the defect this file exists for), the `role`/label
 * dropped, or a key handler added to the container that turns a tab stop into a trap.
 *
 * A scroll container the keyboard cannot reach is a log a keyboard-only reader can only read
 * forwards: the panel's hint gets them to the end, and nothing gets them back up. The same
 * argument, and the same assertion shape, as `pet-task-list.test.ts`'s scroll box.
 *
 * The third test is the trap guard, and it is the reason this is not three attribute
 * assertions. `tabindex="0"` is cheap to add and easy to make harmful: a container that
 * intercepts Tab, or `preventDefault`s the keys it does not use, traps focus in the log and
 * makes the composer behind it unreachable. Nothing on the container is supposed to be
 * cancellable, so that is what is asserted — with the same key the panel's own hint is reached
 * by, and with the two the transcript is scrolled by.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, nextTick, ref, type App as VueApp } from 'vue'
import AgentTimeline, { type AgentTimelineLabels } from './AgentTimeline.vue'
import type { AgentTimelineEntry } from '../services/agent-timeline'

const LABELS: AgentTimelineLabels = {
  aria: 'Agent transcript',
  you: 'You',
  attached: 'Files attached to this message',
  thoughtOpen: 'Hide reasoning',
  thoughtClosed: 'Reasoning',
  controls: {
    jump: 'New content',
    follow: 'Follow the newest output',
    followStop: 'Stop following the newest output',
    copy: 'Copy the newest answer',
    copied: 'Copied',
    copyFailed: 'The clipboard refused it',
    toUser: 'Go to your last message',
    toTop: 'Go to the beginning',
  },
  tool: {
    status: {
      pending: 'Queued',
      in_progress: 'Running',
      completed: 'Done',
      failed: 'Failed',
      cancelled: 'Stopped',
    },
    expand: 'Show details',
    collapse: 'Hide details',
    args: 'Arguments',
    output: 'Output',
    argsAbsent: 'No arguments',
    argsUnreadable: 'Arguments could not be read',
    outputAbsent: 'No output',
    outputUnreadable: 'Output could not be read',
  },
}

/** Three kinds of row, so the container has both a plain row and a focusable one inside it:
 *  the disclosure on the tool row is what a Tab out of the container visits next. */
const ROWS: readonly AgentTimelineEntry[] = [
  { kind: 'user', id: 1, runId: null, text: 'Summarise the note', origin: 'host', attachments: [] },
  { kind: 'text', id: 2, runId: 'run-1', text: 'Reading it now.' },
  {
    kind: 'tool',
    id: 3,
    runId: 'run-1',
    toolCallId: 'call-1',
    title: 'Read notes/2026-09/a.md',
    toolKind: 'read',
    status: 'completed',
    paths: ['notes/2026-09/a.md'],
    content: [],
    input: { state: 'absent' },
    output: { state: 'absent' },
  },
]

let mounted: VueApp[] = []

afterEach(() => {
  mounted.forEach((app) => app.unmount())
  mounted = []
  document.body.innerHTML = ''
})

function mountTimeline(
  rows: readonly AgentTimelineEntry[] = ROWS,
): {
  host: HTMLElement
  scroll: HTMLElement
  /** One more row arrived. Reactive, so the panels' own watcher sees it: an arrival is what the
   *  controls' two states are about, and a static list could only ever show the first one. */
  append: (row: AgentTimelineEntry) => Promise<void>
} {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const live = ref<readonly AgentTimelineEntry[]>([...rows])
  const app = createApp(
    defineComponent({
      setup: () => () => h(AgentTimeline, { rows: live.value, labels: LABELS }),
    }),
  )
  app.mount(host)
  mounted.push(app)
  const scroll = host.querySelector<HTMLElement>('.agent-timeline')
  if (scroll === null) throw new Error('the transcript container did not render')
  return {
    host,
    scroll,
    append: async (row) => {
      live.value = [...live.value, row]
      for (let i = 0; i < 3; i += 1) await nextTick()
    },
  }
}

describe('the transcript and the keyboard', () => {
  it('puts the scroll container in the tab order', () => {
    const { scroll } = mountTimeline()

    // FAILS IF: the container is a plain scroll box — which is what a `div` with
    // `overflow-y: auto` and no attribute is, and what WebKitGTK leaves out of the tab order
    // entirely. A keyboard-only reader then has no route to the rows above the fold.
    expect(scroll.getAttribute('tabindex')).toBe('0')
  })

  it('names the region and keeps it out of the live-region business', () => {
    const { scroll } = mountTimeline()

    // The role and the label are what a screen reader announces when focus lands on the new
    // tab stop, and `aria-live="off"` is the ruling against reading a streaming answer one
    // token at a time (§5.2 「不能每 token 都触发朗读」) — the container is reachable now, so
    // both halves of what it says about itself are part of this contract.
    expect(scroll.getAttribute('role')).toBe('log')
    expect(scroll.getAttribute('aria-label')).toBe(LABELS.aria)
    expect(scroll.getAttribute('aria-live')).toBe('off')
  })

  it('draws the engine’s copy of the user’s turn as the user’s own row', () => {
    // The replayed half of a restored conversation: `session/load` hands the user's turns back
    // as `user-delta` (`agent_runtime::events::normalize_update`), the reducer writes them as a
    // `user` row with `origin: 'engine'`, and this is the layer where that row either becomes
    // pixels or becomes the eighth "built but unreachable". The engine's copy carries the same
    // label as the host's own message — it *is* the user speaking — and `data-origin` is what
    // keeps the two statements apart in the DOM for anything that wants to tell them apart.
    const { host } = mountTimeline([
      { kind: 'user', id: 1, runId: 'load-0', text: 'Reply with exactly: PONG', origin: 'engine', attachments: [] },
    ])

    const row = host.querySelector<HTMLElement>('.agent-row-user')
    expect(row).not.toBeNull()
    expect(row?.dataset.origin).toBe('engine')
    expect(row?.querySelector('.agent-row-who')?.textContent).toBe(LABELS.you)
    expect(row?.querySelector('.agent-row-text')?.textContent).toBe('Reply with exactly: PONG')
  })

  it('does not intercept a key, so the crop is a tab stop and not a trap', () => {
    const { scroll } = mountTimeline()

    // FAILS IF: a key listener on the container cancels the event. Nothing here uses a key —
    // the browser's own default action is the whole of what a focused scroll container does —
    // and a `preventDefault` would be the difference between a reader passing through the
    // transcript on the way to the composer and a reader stuck in it.
    for (const key of ['Tab', 'PageDown', 'End', 'Escape']) {
      const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })
      scroll.dispatchEvent(event)
      expect({ key, defaultPrevented: event.defaultPrevented }).toEqual({ key, defaultPrevented: false })
    }
  })
})

/**
 * The reader's switch over following, driven through the transcript's own control row.
 *
 * The composable's own tests hold the policy; what this holds is that the policy reaches a
 * *control* — the failure this project keeps catching is a behaviour with no gesture, and a
 * switch that renders the state but is not wired to it looks identical in a snapshot.
 */
describe('the transcript’s follow switch', () => {
  const reply: AgentTimelineEntry = { kind: 'text', id: 9, runId: 'run-1', text: 'More.' }

  function switches(host: HTMLElement): {
    follow: HTMLButtonElement | null
    jump: HTMLButtonElement | null
  } {
    return {
      follow: host.querySelector<HTMLButtonElement>('[data-timeline-control="follow"]'),
      jump: host.querySelector<HTMLButtonElement>('[data-timeline-control="jump"]'),
    }
  }

  it('is on screen, and says it is following, on a transcript the reader has not touched', () => {
    const { host } = mountTimeline()
    const { follow, jump } = switches(host)

    // FAILS IF: the switch is not drawn — which is the row this closes (Zed draws one,
    // `render_follow_toggle`, and this panel drew the behaviour with nothing to press).
    expect(follow).not.toBeNull()
    expect(follow?.getAttribute('aria-pressed')).toBe('true')
    // …and the way back to the end is not offered while the reader is already at the end.
    expect(jump).toBeNull()
  })

  it('parks the log and counts what arrives, then goes back on one press', async () => {
    const { host, append } = mountTimeline()
    const { follow } = switches(host)

    follow!.click()
    await nextTick()
    // The state is the composable's, and this is the DOM reading of it: off means off.
    expect(switches(host).follow?.getAttribute('aria-pressed')).toBe('false')

    await append(reply)
    const afterArrival = switches(host)
    expect(afterArrival.follow?.getAttribute('aria-pressed')).toBe('false')
    // The arrival a reader who turned the switch off did not follow is offered, with its count.
    expect(afterArrival.jump).not.toBeNull()
    expect(afterArrival.jump?.querySelector('.agent-jump-count')?.textContent).toBe('1')

    afterArrival.jump!.click()
    await nextTick()
    const afterJump = switches(host)
    expect(afterJump.follow?.getAttribute('aria-pressed')).toBe('true')
    expect(afterJump.jump).toBeNull()
  })

  it('names the action, not the state, on the switch itself', () => {
    const { host } = mountTimeline()

    // A tooltip reading "Following" would be the same fact as `aria-pressed`, twice, and would
    // leave a reader who has never used the control with no answer to what it does.
    expect(switches(host).follow?.getAttribute('title')).toBe(LABELS.controls.followStop)
  })
})

/**
 * The transcript's copy control, driven the way a reader drives it.
 *
 * The clipboard is the one thing here that cannot be measured in this environment — WebKitGTK
 * under Tauri is not measured for `navigator.clipboard` at all — so what is held is the half a
 * unit test can hold honestly: the press reaches the writer, it reaches it with the answer
 * rather than with something else, and the reader is told the press landed.
 */
describe('the transcript’s copy control', () => {
  function copyButton(host: HTMLElement): HTMLButtonElement | null {
    return host.querySelector<HTMLButtonElement>('[data-timeline-control="copy"]')
  }

  afterEach(() => {
    Object.defineProperty(window.navigator, 'clipboard', { configurable: true, value: undefined })
  })

  it('hands the newest answer over, and shows that it landed', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(window.navigator, 'clipboard', { configurable: true, value: { writeText } })
    const { host } = mountTimeline()

    const button = copyButton(host)
    expect(button).not.toBeNull()
    expect(button?.getAttribute('aria-label')).toBe(LABELS.controls.copy)
    button!.click()
    // The write is a promise and the notice lands after it resolves, so the reading is taken
    // once the DOM says so rather than after a guessed number of ticks.
    await vi.waitFor(() => expect(copyButton(host)?.dataset.copy).toBe('copied'))

    // The answer, and not the user's own turn that sits above it — the mistake this control's
    // label would hide.
    expect(writeText).toHaveBeenCalledWith('Reading it now.')
    expect(copyButton(host)?.getAttribute('title')).toBe(LABELS.controls.copied)
  })

  it('is not drawn when there is no answer to copy yet', () => {
    const { host } = mountTimeline([
      { kind: 'user', id: 1, runId: null, text: 'hello', origin: 'host', attachments: [] },
    ])
    expect(copyButton(host)).toBeNull()
  })
})

describe('the transcript’s way to the reader’s own message', () => {
  it('is drawn only once the reader has said something', () => {
    const { host } = mountTimeline([{ kind: 'text', id: 1, runId: 'r', text: 'unprompted' }])
    expect(host.querySelector('[data-timeline-control="to-user"]')).toBeNull()

    const withUser = mountTimeline()
    expect(withUser.host.querySelector('[data-timeline-control="to-user"]')).not.toBeNull()
  })
})

describe('what a turn carried', () => {
  it('is drawn on the reader’s own row, named as the chip named it', () => {
    // The composer's strip goes with the draft, so this row is the only place left that says the
    // model was given a file. Drawn per name rather than as a count: "2 files" tells a reader who
    // is looking for the diagram they sent nothing about whether it is the one that arrived.
    const { host } = mountTimeline([
      {
        kind: 'user',
        id: 1,
        runId: null,
        text: 'what is this?',
        origin: 'host',
        attachments: [
          { kind: 'image', name: 'diagram.png' },
          { kind: 'resource', name: 'notes/a.md' },
        ],
      },
    ])

    const list = host.querySelector('[data-row-files="1"]')
    expect(list).not.toBeNull()
    expect(list?.getAttribute('aria-label')).toBe(LABELS.attached)
    expect([...(list?.querySelectorAll('li') ?? [])].map((li) => li.textContent?.trim())).toEqual([
      'diagram.png',
      'notes/a.md',
    ])
  })

  it('is not drawn at all for a turn that carried nothing', () => {
    // The same rule the composer's strip keeps: an empty frame is a surface with nothing to show,
    // and every turn before this feature existed would draw one.
    const { host } = mountTimeline([
      { kind: 'user', id: 1, runId: null, text: 'hello', origin: 'host', attachments: [] },
    ])

    expect(host.querySelector('[data-row-files]')).toBeNull()
  })
})
