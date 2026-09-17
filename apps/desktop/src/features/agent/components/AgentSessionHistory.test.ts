/**
 * The session history surface, from the panel's own bar: whether the control exists at all, what
 * the engine's answer draws, and what picking a row does.
 *
 * What this file is for: the capability gate and the rows. Both are claims about an engine — "it
 * answers `session/list`" and "this is what it holds" — and every wrong version of either is a
 * sentence the user would read as the engine's. So the panel is mounted for a real session of the
 * memory double (T1), which is driven into the state a history list exists for: one session the
 * runtime has *stopped* serving and one it is serving now, in two different folders.
 *
 * The reopen itself is not here. Picking a row leaves the panel as an event, and the call belongs
 * to the rail, which owns the vault the load is made for — `agent-rail.test.ts` drives that half,
 * `AppShell.agent-rail.test.ts` drives the whole chain from a click. The *free* action is here
 * with the list, because the panel is where its two calls and its question are; the list's own
 * rendering is `AgentSessionHistoryMenu.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, type App as VueApp } from 'vue'
import { createPinia, setActivePinia, type Pinia } from 'pinia'
import AgentPanel, { type AgentPanelLabels } from './AgentPanel.vue'
import { createMemoryAgentGateway, type MemoryAgentGateway } from '../../../platform/gateways/memory-agent'
import type { AgentSession } from '../../../platform/gateways/agent-contracts'
import { useAgentSessionStore } from '../stores/agent-session'
import { setLocale } from '../../../i18n'

/** The panel's words, as its caller supplies them (`src/app/AgentRailBody.vue` builds the same
 *  tree from the catalogue). `history` is left out on purpose: it is the one field of the bar's
 *  labels with a catalogue default, and the case below asserts that default reaches the control. */
const LABELS: AgentPanelLabels = {
  empty: { line: 'Message Memory — / for commands' },
  bar: {
    untitled: 'New Memory session',
    state: {
      idle: 'Idle',
      starting: 'Starting',
      ready: 'Ready',
      running: 'Running',
      'waiting-permission': 'Waiting for approval',
      completed: 'Completed',
      cancelled: 'Stopped',
      failed: 'Failed',
    },
    result: {
      'end-turn': 'Finished',
      'max-tokens': 'Token limit',
      'max-turn-requests': 'Request limit',
      refusal: 'Refused',
      cancelled: 'Stopped',
      unrecognised: 'Unrecognised ending',
    },
  },
  timeline: {
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
      expand: 'Show arguments and output',
      collapse: 'Hide arguments and output',
      args: 'Arguments',
      output: 'Output',
      argsAbsent: 'The engine sent no arguments',
      argsUnreadable: 'The engine sent arguments this app could not read',
      outputAbsent: 'No output reported',
      outputUnreadable: 'The engine sent output this app could not read',
    },
  },
  composer: {
    placeholder: 'Ask the agent',
    send: 'Send',
    stop: 'Stop',
    hint: 'Enter sends',
    hintBusy: 'A run is in flight',
  },
  notice: {
    gap: 'Part of this session’s record was never received',
    resync: 'Resync',
  },
}

/**
 * The two sessions a history list exists for, on one gateway:
 *
 *  - `earlier` was opened in **another folder** and the runtime that held it was stopped, so the
 *    engine still lists it while this gateway no longer serves its handle — the shape the
 *    contract describes for a session a user can reopen;
 *  - `current` is what the running runtime opened, in the folder the panel is told about.
 */
interface Harness {
  earlier: AgentSession
  current: AgentSession
  /**
   * A third session, opened in the runtime that is up *now* and not the one the panel is on.
   *
   * Only the cases that press the free action ask for it (`spare: true`), because it is the shape
   * that action exists for — a session this runtime serves, which the window is not showing — and
   * the shape the host will actually act on. `earlier` is the other side of that line and stays
   * out of the free cases' way: the engine lists it, this host never received an answer about it,
   * and `agent_close_session` refuses ids like it before the engine is asked (§6.1).
   */
  spare: AgentSession | null
  gateway: MemoryAgentGateway
  /** Let the held `session/list` answer through. Only present with `holdList`. */
  releaseList: () => Promise<void>
  /** Every session id the panel asked to reopen. */
  resumes: string[]
  el: (selector: string) => HTMLElement | null
  click: (selector: string) => Promise<void>
  /** Type into the find box the way a reader does, and let the list redraw. */
  type: (text: string) => Promise<void>
  settle: () => Promise<void>
  /** What the open list says, as the engine titled its rows. */
  titles: () => string[]
  /** The rows the list is marking as the one on screen. */
  currentRows: () => string[]
  /** The rows the list marks as recorded in another folder. */
  elsewhere: () => string[]
}

let pinia: Pinia
let mounted: VueApp[] = []

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

beforeEach(() => {
  setLocale('en')
  pinia = createPinia()
  setActivePinia(pinia)
})

afterEach(() => {
  mounted.forEach((app) => app.unmount())
  mounted = []
  document.body.innerHTML = ''
})

/**
 * The boxes this environment does not have.
 *
 * jsdom lays nothing out, so every rect is a zero and every width is a zero — which is why the
 * defect this file now covers could not be seen from here before: a popup placed for a 0px box in
 * a 0px window is trivially "inside" it. The numbers below are the ones the real window produced
 * (measured at 1400×900 for the history list: a 219px box while the answer was in flight, 290px
 * once the rows were in it, a control 32px tall at the top of the bar), and they are installed on
 * the prototypes for the duration of one test.
 */
const VIEWPORT = { width: 1400, height: 900 }
const TRIGGER = { top: 58, left: 1140, width: 28, height: 28 }
/** The box the popup has before its list arrives, and the one it has after. */
const POPUP_NARROW = { width: 219, height: 64 }
const POPUP_WIDE = { width: 290, height: 260 }

function installBoxes(): () => void {
  const rect = (box: { top: number; left: number; width: number; height: number }): DOMRect =>
    ({
      top: box.top,
      left: box.left,
      right: box.left + box.width,
      bottom: box.top + box.height,
      width: box.width,
      height: box.height,
    }) as DOMRect

  Element.prototype.getBoundingClientRect = function (this: Element): DOMRect {
    const cls = typeof this.className === 'string' ? this.className : ''
    return cls.includes('agent-history-trigger') || cls.includes('agent-bar-history')
      ? rect({ ...TRIGGER })
      : rect({ top: 0, left: 0, width: 0, height: 0 })
  }
  // The popup's own box, which is the one that grows: it is measured before its content exists
  // (the list is `session/list`, asked for as the box appears) and again once the rows are in it.
  // Keyed off the rows rather than off a timer, so the growth is the content's — which is what
  // the composable's own resize watch is about.
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
    configurable: true,
    get(this: HTMLElement) {
      if (!(this.classList?.contains('agent-history-popup') ?? false)) return 0
      return this.querySelector('.agent-history-row') === null ? POPUP_NARROW.width : POPUP_WIDE.width
    },
  })
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
    configurable: true,
    get(this: HTMLElement) {
      if (!(this.classList?.contains('agent-history-popup') ?? false)) return 0
      return this.querySelector('.agent-history-row') === null ? POPUP_NARROW.height : POPUP_WIDE.height
    },
  })
  const width = Object.getOwnPropertyDescriptor(window, 'innerWidth')
  const height = Object.getOwnPropertyDescriptor(window, 'innerHeight')
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: VIEWPORT.width })
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: VIEWPORT.height })

  const elementRect = Element.prototype.getBoundingClientRect
  const wide = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetWidth')
  const tall = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight')
  return () => {
    Element.prototype.getBoundingClientRect = elementRect
    for (const [name, descriptor] of [
      ['offsetWidth', wide],
      ['offsetHeight', tall],
    ] as const) {
      if (descriptor === undefined) delete (HTMLElement.prototype as unknown as Record<string, unknown>)[name]
      else Object.defineProperty(HTMLElement.prototype, name, descriptor)
    }
    if (width !== undefined) Object.defineProperty(window, 'innerWidth', width)
    if (height !== undefined) Object.defineProperty(window, 'innerHeight', height)
  }
}

/**
 * A `ResizeObserver` that delivers when the test says the boxes changed.
 *
 * Neither happy-dom nor jsdom lays anything out, so nothing can tell the popup that its own box
 * grew — which is the event this test is about. What the fake does not stand in for is the
 * browser's own decision to fire (it is a layout notification, and its delivery is the engine's);
 * what it does hold is the composable's half: that a size change is answered with a re-place, and
 * that the arithmetic of that re-place keeps the list inside the window.
 */
class FakeResizeObserver {
  static live: FakeResizeObserver[] = []
  private readonly deliver: () => void
  constructor(deliver: () => void) {
    this.deliver = deliver
    FakeResizeObserver.live.push(this)
  }
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {
    FakeResizeObserver.live = FakeResizeObserver.live.filter((observer) => observer !== this)
  }
  static changed(): void {
    for (const observer of [...FakeResizeObserver.live]) observer.deliver()
  }
}

/** Frames the test runs by hand: the composable coalesces a burst of size changes into one. */
function installFrames(): () => void {
  const queued: FrameRequestCallback[] = []
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback): number => {
    queued.push(callback)
    return queued.length
  })
  vi.stubGlobal('cancelAnimationFrame', (handle: number): void => {
    if (handle > 0 && handle <= queued.length) queued[handle - 1] = () => {}
  })
  return () => {
    for (const frame of queued.splice(0)) frame(0)
  }
}

async function mountPanel(options: {
  available: boolean
  closeable?: boolean
  spare?: boolean
  /** Hold the engine's list until the answer is released: the window the popup is measured in. */
  holdList?: boolean
}): Promise<Harness> {
  const capabilities: Partial<Record<'session-list' | 'session-close', { status: 'available' }>> = {}
  // What the engine reported about itself. Anything a case does not name stays `unverified` — a
  // double has measured nothing — which is the arm the "no control" cases below are about.
  if (options.available) capabilities['session-list'] = { status: 'available' }
  if (options.closeable === true) capabilities['session-close'] = { status: 'available' }
  const gateway = createMemoryAgentGateway({
    agentId: 'memory',
    profileId: 'test',
    capabilities,
  })
  await gateway.start()
  const earlier = await gateway.openSession({ vaultId: 'vault', cwd: '/notes/elsewhere' })
  // A runtime instance is replaced, not extended: the sessions of the one that went away stay in
  // the engine's table — which is exactly the history this surface exists for, and the state the
  // panel has to be able to draw.
  await gateway.stop()
  await gateway.start()
  const current = await gateway.openSession({ vaultId: 'vault', cwd: '/notes/vault' })
  // The runtime that is up holds every session it opened, so a second one here is a row the host
  // will act on: same epoch, same folder, and not the session the panel is mounted on.
  const spare = options.spare === true
    ? await gateway.openSession({ vaultId: 'vault', cwd: '/notes/vault' })
    : null

  const host = document.createElement('div')
  document.body.appendChild(host)

  // The engine's answer, held until the test lets it go: the popup is opened while it is in
  // flight, which is the only instant at which the box is measured without its rows.
  let releaseList: (() => void) | null = null
  if (options.holdList === true) {
    const list = gateway.listSessions.bind(gateway)
    gateway.listSessions = async () => {
      const answer = await list()
      await new Promise<void>((resolve) => {
        releaseList = resolve
      })
      return answer
    }
  }

  const resumes: string[] = []
  const app = createApp(AgentPanel, {
    gateway,
    session: current,
    cwd: '/notes/vault',
    labels: LABELS,
    onResume: (sessionId: string) => resumes.push(sessionId),
  })
  app.use(pinia)
  app.mount(host)
  mounted.push(app)

  const el = (selector: string): HTMLElement | null => document.querySelector(selector)
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 4; i += 1) {
      await nextTick()
      await flush()
    }
  }
  const harness: Harness = {
    earlier,
    current,
    spare,
    gateway,
    releaseList: async () => {
      releaseList?.()
      // The answer is settled by the caller's own await, and the panel draws it on the next tick.
      await settle()
    },
    resumes,
    el,
    settle,
    click: async (selector) => {
      const target = el(selector)
      if (target === null) throw new Error(`nothing matches ${selector}`)
      target.click()
      await settle()
    },
    type: async (text) => {
      const field = document.querySelector<HTMLInputElement>('[data-history-search]')
      if (field === null) throw new Error('the list is not drawing a find box')
      // The value and the event the browser would fire with it, rather than a simulated
      // keystroke: what is under test is the filter, and the field is what the popup reads.
      field.value = text
      field.dispatchEvent(new Event('input'))
      await settle()
    },
    titles: () =>
      Array.from(document.querySelectorAll<HTMLElement>('.agent-history-option-title')).map(
        (node) => node.textContent?.trim() ?? '',
      ),
    currentRows: () =>
      Array.from(document.querySelectorAll<HTMLElement>('.agent-history-option')).flatMap((row) =>
        row.getAttribute('aria-current') === 'true'
          ? [row.getAttribute('data-session') ?? '']
          : [],
      ),
    elsewhere: () =>
      Array.from(document.querySelectorAll<HTMLElement>('.agent-history-option[data-elsewhere]')).map(
        (row) => row.getAttribute('data-session') ?? '',
      ),
  }
  // The store is what makes the panel draw at all (its view is the store's record), so mount and
  // settle before anything is asserted.
  useAgentSessionStore()
  await settle()
  return harness
}

describe('the history control, and the capability behind it', () => {
  it('is not drawn when the engine has not reported session/list as available', async () => {
    const harness = await mountPanel({ available: false })

    // Not a disabled control and not an empty list: nothing the reader can press, because the
    // engine never said it answers the call behind it. The panel is otherwise the panel.
    expect(harness.el('[data-agent-history]')).toBeNull()
    expect(harness.el('[data-agent-panel]')).not.toBeNull()
    expect(harness.el('.agent-bar-title')?.textContent?.trim()).toBe('New Memory session')
  })

  it('is drawn, named and expandable when the engine reported it available', async () => {
    const harness = await mountPanel({ available: true })

    const trigger = harness.el('[data-agent-history]')
    expect(trigger).not.toBeNull()
    // The name comes from the catalogue (`agent.panel.bar.history`) because this caller passes no
    // override of its own.
    expect(trigger?.getAttribute('aria-label')).toBe('Sessions this engine holds')
    expect(trigger?.getAttribute('aria-expanded')).toBe('false')

    await harness.click('[data-agent-history]')
    expect(harness.el('[data-agent-history]')?.getAttribute('aria-expanded')).toBe('true')
  })
})

describe('the sessions the engine holds', () => {
  it('lists them under the engine’s own titles, in its order, with the open one marked', async () => {
    const harness = await mountPanel({ available: true })
    await harness.click('[data-agent-history]')

    expect(harness.el('[role="listbox"]')).not.toBeNull()
    // The titles are the engine's — the double generates them the way the pinned engine does —
    // and the row the panel is mounted on is the one marked as open.
    expect(harness.titles()).toEqual([
      'New session - 2026-01-01T00:00:01Z',
      'New session - 2026-01-01T00:00:02Z',
    ])
    expect(harness.currentRows()).toEqual([harness.current.sessionId])
    // `session-1` was opened in /notes/elsewhere and this runtime works in /notes/vault: the row
    // says so, because that is the one fact that changes what pressing it means.
    expect(harness.elsewhere()).toEqual([harness.earlier.sessionId])
  })

  it('asks to reopen the row that was picked, and closes the list', async () => {
    const harness = await mountPanel({ available: true })
    await harness.click('[data-agent-history]')

    await harness.click(`[data-session="${harness.earlier.sessionId}"]`)

    expect(harness.resumes).toEqual([harness.earlier.sessionId])
    expect(harness.el('[role="listbox"]')).toBeNull()
    // Nothing is called from here: the panel does not own the vault the load has to be made for.
    expect(harness.el('[data-agent-history]')?.getAttribute('aria-expanded')).toBe('false')
  })

  it('does not call for the row already on screen, which the engine would refuse', async () => {
    const harness = await mountPanel({ available: true })
    await harness.click('[data-agent-history]')

    await harness.click(`[data-session="${harness.current.sessionId}"]`)

    // The list closes and nothing is asked for: `loadSession` refuses a session this gateway is
    // serving, and "show me this one" about the one showing has no work in it.
    expect(harness.resumes).toEqual([])
    expect(harness.el('[role="listbox"]')).toBeNull()
  })

  /**
   * The find box, from the control the reader actually has: the bar's history button, the popup it
   * opens, and the box in it.
   *
   * What the box may match is `filterSessionRows`' rule and is asserted there. What is asserted
   * here is the half only the whole chain can show — that typing in the popup the panel mounts
   * narrows the engine's answer *without asking the engine again*, that a query which matches
   * nothing says so instead of leaving the popup blank, and that emptying the box gives back
   * exactly the rows the engine sent.
   */
  it('narrows the engine’s own rows as the reader types, without asking the engine again', async () => {
    const harness = await mountPanel({ available: true })
    let listed = 0
    const list = harness.gateway.listSessions.bind(harness.gateway)
    harness.gateway.listSessions = async () => {
      listed += 1
      return list()
    }

    await harness.click('[data-agent-history]')
    expect(listed).toBe(1)
    expect(harness.titles()).toEqual([
      'New session - 2026-01-01T00:00:01Z',
      'New session - 2026-01-01T00:00:02Z',
    ])

    // One row left: the one the engine recorded in /notes/elsewhere, which is the fact the query
    // matched — the row keeps the engine's own title either way.
    await harness.type('elsewhere')
    expect(harness.titles()).toEqual(['New session - 2026-01-01T00:00:01Z'])

    // The answer already in hand was narrowed, not re-asked for: this is a filter over what
    // `session/list` sent, and a second round trip per keystroke would be a call nobody asked for.
    expect(listed).toBe(1)

    await harness.type('nothing says this')
    expect(harness.el('[data-history-nomatch]')).not.toBeNull()
    expect(harness.el('.agent-history-option')).toBeNull()

    await harness.click('[data-history-clear]')
    expect(harness.titles()).toEqual([
      'New session - 2026-01-01T00:00:01Z',
      'New session - 2026-01-01T00:00:02Z',
    ])
    expect(listed).toBe(1)
  })

  /**
   * The action on a row's engine record — the one gesture that reaches `AgentGateway.closeSession`.
   *
   * Two of its rules are capability and one is a sentence. The action is offered only where the
   * engine reported `session-close`, only on a row that is not the session on screen, and — since
   * the engine was measured *keeping* a closed session in its list — the answer says so, because
   * a reader who presses this and sees the row still there must not conclude it failed.
   */
  describe('freeing a session on the engine', () => {
    /**
     * Spy on the calls the action makes, after the panel has mounted.
     *
     * `loads` is watched as well as `closes`, and it is asserted to stay **empty**: the action
     * used to adopt a row before freeing it, because the contract's close took a handle. It takes
     * an id now, and a load here would mean the unreachable state had come back — a session the
     * runtime already serves answers "already open" to a load, so a row that needs one to be
     * freed is a row that can never be freed.
     */
    function watch(harness: Harness) {
      const closes: string[] = []
      const loads: string[] = []
      const close = harness.gateway.closeSession.bind(harness.gateway)
      harness.gateway.closeSession = async (sessionId) => {
        closes.push(sessionId)
        return close(sessionId)
      }
      const load = harness.gateway.loadSession.bind(harness.gateway)
      harness.gateway.loadSession = async (sessionId, request) => {
        loads.push(sessionId)
        return load(sessionId, request)
      }
      const list = harness.gateway.listSessions.bind(harness.gateway)
      let reads = 0
      harness.gateway.listSessions = async () => {
        reads += 1
        return list()
      }
      return { closes, loads, reads: () => reads }
    }

    it('is not drawn at all when the engine has not reported session-close', async () => {
      const harness = await mountPanel({ available: true, closeable: false })
      await harness.click('[data-agent-history]')

      // The list is there — `session-list` is available — and no row offers the free action.
      expect(harness.el('.agent-history-option')).not.toBeNull()
      expect(harness.el('[data-free]')).toBeNull()
    })

    it('is not drawn on the session the reader is in', async () => {
      const harness = await mountPanel({ available: true, closeable: true, spare: true })
      await harness.click('[data-agent-history]')

      // The other row has it, the open one does not: closing the session on screen from a list
      // that is about the others is a trap, and the engine would refuse the load behind it too.
      expect(harness.el(`[data-free="${harness.spare!.sessionId}"]`)).not.toBeNull()
      expect(harness.el(`[data-free="${harness.current.sessionId}"]`)).toBeNull()
    })

    it('is not drawn on a row this host does not hold, which the call would be refused for', async () => {
      const harness = await mountPanel({ available: true, closeable: true, spare: true })
      await harness.click('[data-agent-history]')

      // The engine's table outlives the run that wrote it, so a fresh window's list is mostly
      // rows like `earlier` — sessions it lists and this host never received an answer about.
      // `agent_close_session` refuses those itself, before the engine is asked (§6.1), so a
      // button there could only produce the host's refusal, which the panel then reported as the
      // engine's. §5.2: an option that cannot act is not drawn.
      expect(harness.el(`[data-free="${harness.earlier.sessionId}"]`)).toBeNull()
      // The session this runtime *does* hold, and is not showing, is the case the action exists
      // for, and it keeps its button: this is one fact added to the gate, not the control removed.
      expect(harness.el(`[data-free="${harness.spare!.sessionId}"]`)).not.toBeNull()
      expect(harness.el(`[data-free="${harness.current.sessionId}"]`)).toBeNull()
    })

    it('asks before it acts, and the question says the row stays', async () => {
      const harness = await mountPanel({ available: true, closeable: true, spare: true })
      const calls = watch(harness)
      await harness.click('[data-agent-history]')

      await harness.click(`[data-free="${harness.spare!.sessionId}"]`)

      // Nothing has been called: the engine's record is not this app's to drop on one press.
      expect(calls.closes).toEqual([])
      expect(calls.loads).toEqual([])
      const footer = harness.el('[data-footer="confirm"]')
      expect(footer?.textContent).toContain('Free this session on the engine?')
      expect(footer?.textContent).toContain('keeps the session in its list')

      await harness.click('[data-free-cancel]')
      expect(harness.el('.agent-history-footer')).toBeNull()
      expect(calls.closes).toEqual([])
    })

    it('frees the row the reader chose, and re-reads the engine’s list', async () => {
      const harness = await mountPanel({ available: true, closeable: true, spare: true })
      const calls = watch(harness)
      await harness.click('[data-agent-history]')
      expect(calls.reads()).toBe(1)

      await harness.click(`[data-free="${harness.spare!.sessionId}"]`)
      await harness.click('[data-free-confirm]')

      // `closeSession` is called with the row's own **id**, and `loadSession` is not called at
      // all. That empty `loads` is the regression guard rather than a detail: while the contract
      // took a handle, freeing a row meant adopting it first, and a session the runtime was
      // already serving but not showing could then be neither loaded (the engine answers "already
      // open") nor freed (no handle exists) — a state with no way out. One call, one id.
      expect(calls.closes).toEqual([harness.spare!.sessionId])
      expect(calls.loads).toEqual([])
      // The list was asked again rather than edited, and the engine's answer is unchanged: the
      // session it let go is still in it.
      expect(calls.reads()).toBe(2)
      expect(
        Array.from(document.querySelectorAll<HTMLElement>('.agent-history-option')).map((row) =>
          row.getAttribute('data-session'),
        ),
      ).toContain(harness.spare!.sessionId)
      expect(harness.el('[data-footer="freed"]')?.textContent).toContain(
        'The row is still in this list — that is the engine’s answer, not a failure.',
      )
    })

    it('reports a refusal in the engine’s own words', async () => {
      const harness = await mountPanel({ available: true, closeable: true, spare: true })
      await harness.click('[data-agent-history]')
      harness.gateway.closeSession = async () => {
        throw new Error('the engine refused to free that session')
      }

      await harness.click(`[data-free="${harness.spare!.sessionId}"]`)
      await harness.click('[data-free-confirm]')

      const footer = harness.el('[data-footer="failed"]')
      expect(footer?.textContent).toContain('the engine refused to free that session')
      // And the lead-in does not name a refuser for it. It used to read 「The engine would not free
      // it:」 — false for the one refusal on this path that is this app's own (§6.1's guard, and
      // the sentence the host now words itself in `commands/agent_sessions.rs`), and a reader who
      // acted on it would be looking at the wrong party.
      expect(footer?.textContent).toContain('It was not freed:')
      expect(footer?.textContent).not.toContain('The engine would not free it')
    })
  })

  it('says why there is nothing to show when the engine’s answer could not be read', async () => {
    const harness = await mountPanel({ available: true })
    harness.gateway.listSessions = async () => {
      throw new Error('the engine answered something this window could not read')
    }

    await harness.click('[data-agent-history]')

    // The gateway's own sentence, in the list, where the reader asked: a control that asked the
    // engine something and got nothing back owes them the reason rather than an empty box.
    const notice = harness.el('.agent-history-notice')
    expect(notice?.textContent).toContain(
      'The engine’s sessions could not be read: the agent gateway rejected the call: Error: the engine answered something this window could not read',
    )
    expect(harness.el('.agent-history-option')).toBeNull()
  })
})

/**
 * Where the list is put — which is not a fixed answer, because the popup is opened before its rows
 * exist.
 *
 * The control opens the box first and asks the engine in the same breath: the reader sees
 * 「reading…」 immediately, and the box is *measured* at that instant, with the size a loading
 * message has. The rows arrive a moment later and the box grows — its width is its content's, up
 * to the popup's own cap. Everything about the placement was decided from the first measurement
 * and nothing re-decided it, so the list kept an anchor chosen for a box it no longer was.
 *
 * Measured in the real window (1400×900, the app's own bar): placed for 219px, grown to 290px, and
 * the popup's right edge 63px past the window — with the ✕, which is the rightmost thing in a row,
 * entirely outside it. Resizing the window re-placed it and every ✕ came back, which is what said
 * the cause was timing rather than arithmetic.
 */
describe('the box the list is given', () => {
  let restore: (() => void) | null = null

  afterEach(() => {
    restore?.()
    restore = null
    FakeResizeObserver.live = []
    vi.unstubAllGlobals()
  })

  it('is re-measured when the rows arrive, so the list and its ✕ stay inside the window', async () => {
    restore = installBoxes()
    const runFrames = installFrames()
    vi.stubGlobal('ResizeObserver', FakeResizeObserver)

    const harness = await mountPanel({ available: true, holdList: true })
    await harness.click('[data-agent-history]')

    const popup = (): HTMLElement | null => harness.el('.agent-history-popup')
    const left = (): number => Number.parseFloat(popup()?.style.left ?? '')
    // The list is up and the rows are not: this is the box the placement was made for.
    expect(popup()).not.toBeNull()
    expect(harness.el('.agent-history-row')).toBeNull()

    await harness.releaseList()

    // The rows are in the box now, and in a browser that is a size change: the observer delivers,
    // the composable re-places, and the box moves to where a list of *this* size belongs.
    expect(harness.el('.agent-history-row')).not.toBeNull()
    FakeResizeObserver.changed()
    runFrames()
    await harness.settle()

    const width = popup()?.offsetWidth ?? 0
    expect(width).toBe(POPUP_WIDE.width)
    expect(left() + width).toBeLessThanOrEqual(VIEWPORT.width - 8)
    // The property rather than the number: the list's right edge is inside the window, which is
    // the whole of what the ✕ needs — it is drawn at the row's right edge, and a row is as wide as
    // the box. Before the re-place this was 1430 against a 1400px window.
    expect(left() + POPUP_WIDE.width).toBeLessThanOrEqual(VIEWPORT.width - 8)
  })
})
