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
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
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
  gateway: MemoryAgentGateway
  /** Every session id the panel asked to reopen. */
  resumes: string[]
  el: (selector: string) => HTMLElement | null
  click: (selector: string) => Promise<void>
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

async function mountPanel(options: { available: boolean; closeable?: boolean }): Promise<Harness> {
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

  const host = document.createElement('div')
  document.body.appendChild(host)

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
    gateway,
    resumes,
    el,
    settle,
    click: async (selector) => {
      const target = el(selector)
      if (target === null) throw new Error(`nothing matches ${selector}`)
      target.click()
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
      const harness = await mountPanel({ available: true, closeable: true })
      await harness.click('[data-agent-history]')

      // The other row has it, the open one does not: closing the session on screen from a list
      // that is about the others is a trap, and the engine would refuse the load behind it too.
      expect(harness.el(`[data-free="${harness.earlier.sessionId}"]`)).not.toBeNull()
      expect(harness.el(`[data-free="${harness.current.sessionId}"]`)).toBeNull()
    })

    it('asks before it acts, and the question says the row stays', async () => {
      const harness = await mountPanel({ available: true, closeable: true })
      const calls = watch(harness)
      await harness.click('[data-agent-history]')

      await harness.click(`[data-free="${harness.earlier.sessionId}"]`)

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
      const harness = await mountPanel({ available: true, closeable: true })
      const calls = watch(harness)
      await harness.click('[data-agent-history]')
      expect(calls.reads()).toBe(1)

      await harness.click(`[data-free="${harness.earlier.sessionId}"]`)
      await harness.click('[data-free-confirm]')

      // `closeSession` is called with the row's own **id**, and `loadSession` is not called at
      // all. That empty `loads` is the regression guard rather than a detail: while the contract
      // took a handle, freeing a row meant adopting it first, and a session the runtime was
      // already serving but not showing could then be neither loaded (the engine answers "already
      // open") nor freed (no handle exists) — a state with no way out. One call, one id.
      expect(calls.closes).toEqual([harness.earlier.sessionId])
      expect(calls.loads).toEqual([])
      // The list was asked again rather than edited, and the engine's answer is unchanged: the
      // session it let go is still in it.
      expect(calls.reads()).toBe(2)
      expect(
        Array.from(document.querySelectorAll<HTMLElement>('.agent-history-option')).map((row) =>
          row.getAttribute('data-session'),
        ),
      ).toContain(harness.earlier.sessionId)
      expect(harness.el('[data-footer="freed"]')?.textContent).toContain(
        'The row is still in this list — that is the engine’s answer, not a failure.',
      )
    })

    it('reports a refusal in the engine’s own words', async () => {
      const harness = await mountPanel({ available: true, closeable: true })
      await harness.click('[data-agent-history]')
      harness.gateway.closeSession = async () => {
        throw new Error('the engine refused to free that session')
      }

      await harness.click(`[data-free="${harness.earlier.sessionId}"]`)
      await harness.click('[data-free-confirm]')

      const footer = harness.el('[data-footer="failed"]')
      expect(footer?.textContent).toContain('The engine would not free it:')
      expect(footer?.textContent).toContain('the engine refused to free that session')
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
