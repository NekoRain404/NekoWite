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
import { afterEach, describe, expect, it } from 'vitest'
import { createApp, type App as VueApp } from 'vue'
import AgentTimeline, { type AgentTimelineLabels } from './AgentTimeline.vue'
import type { AgentTimelineEntry } from '../services/agent-timeline'

const LABELS: AgentTimelineLabels = {
  aria: 'Agent transcript',
  you: 'You',
  thoughtOpen: 'Hide reasoning',
  thoughtClosed: 'Reasoning',
  jump: 'New content',
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
  { kind: 'user', id: 1, runId: null, text: 'Summarise the note', origin: 'host' },
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
): { host: HTMLElement; scroll: HTMLElement } {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const app = createApp(AgentTimeline, { rows, labels: LABELS })
  mounted.push(app)
  app.mount(host)
  const scroll = host.querySelector<HTMLElement>('.agent-timeline')
  if (scroll === null) throw new Error('the transcript container did not render')
  return { host, scroll }
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
      { kind: 'user', id: 1, runId: 'load-0', text: 'Reply with exactly: PONG', origin: 'engine' },
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
