/**
 * The panel with the permission prompt in it: the authorization a run is waiting on is
 * reachable from the panel, and answering it there is the answer that reaches the engine.
 *
 * It exists because everything around this state was green apart and nothing held the state
 * itself: T7 tests the prompt as a component, T5 tests the store, and the seam between them —
 * a run suspended on a request, rendered by the panel, answered by the reader — is the one the
 * user's next action depends on. So this file goes in through the panel's own composer and out
 * through the gateway's `answerPermission`, and it asserts the *turn finished*: the half that
 * cannot be true unless the answer really arrived, and the half a user notices.
 *
 * The runtime is T1's memory double, driven by hand, so the turn genuinely suspends on the
 * request rather than the test asserting against a canned state.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createApp, nextTick, type App as VueApp } from 'vue'
import { createPinia, setActivePinia, type Pinia } from 'pinia'
import AgentPanel, { type AgentPanelLabels } from './AgentPanel.vue'
import {
  createMemoryAgentGateway,
  type MemoryAgentGateway,
  type MemoryRunScript,
} from '../../../platform/gateways/memory-agent'
import type {
  AgentPermissionOption,
  AgentSession,
} from '../../../platform/gateways/agent-contracts'
import { useAgentSessionStore } from '../stores/agent-session'
import { setLocale } from '../../../i18n'

/**
 * The copy the caller supplies, which is the whole of the panel's words: the components have
 * none of their own (the catalogue has no keys for them yet — see `AgentPanelLabels`). Typed as
 * the interface, so a missing sentence is a compile error rather than a blank line.
 */
const LABELS: AgentPanelLabels = {
  // Pre-substituted, because the caller builds these with `t`: the engine's own name arrives
  // from the registry, and the catalogue's `{engine}` slot is filled where the sentence is.
  empty: {
    line: 'Message Memory — / for commands',
  },
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
    hint: 'Enter sends, Shift+Enter starts a new line',
    hintBusy: 'A run is in flight — the text waits here',
  },
  notice: {
    gap: 'Part of this session’s record was never received',
    resync: 'Resync',
  },
}

/** The two answers the engine offers in these tests, in ACP's own kinds: a lasting allow and a
 *  plain refusal, which is the pair P0 measured on the pinned build minus the "once" one. */
const OPTIONS: readonly AgentPermissionOption[] = [
  { optionId: 'always', name: 'Always allow', kind: 'allow_always' },
  { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
]

interface Harness {
  /** Every answer the panel handed the gateway, as `[requestId, optionId]`. */
  answers: Array<[string, string]>
  /** Every prompt it handed over, so "nothing was sent" is an assertion about a call. */
  prompts: string[]
  el: (selector: string) => HTMLElement | null
  text: (selector: string) => string
  /** The options the prompt is offering, as the engine labelled them. */
  options: () => string[]
  /** Type a message and press send, through the panel's own field and button. */
  send: (text: string) => Promise<void>
  /** Put text in the field without sending it, the way a reader typing a `/token` would. */
  type: (text: string) => Promise<void>
  click: (selector: string) => Promise<void>
  settle: () => Promise<void>
  /** The store's word for the session's state. */
  state: () => string
  /** The request the store is holding, or null. */
  pendingId: () => string | null
}

let pinia: Pinia
let gateway: MemoryAgentGateway
let session: AgentSession
let mounted: VueApp[] = []

/** The whole async settle these component tests use: the gateway's turn runs in microtasks and
 *  the store commits what they produce in Vue's queue. */
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

beforeEach(async () => {
  pinia = createPinia()
  setActivePinia(pinia)
  gateway = createMemoryAgentGateway({ agentId: 'memory', profileId: 'test' })
  await gateway.start()
  session = await gateway.openSession({ vaultId: 'vault', cwd: '/vault' })
})

afterEach(() => {
  mounted.forEach((app) => app.unmount())
  mounted = []
  document.body.innerHTML = ''
})

async function mountPanel(script: MemoryRunScript): Promise<Harness> {
  gateway.script(script)
  const host = document.createElement('div')
  document.body.appendChild(host)

  const answers: Array<[string, string]> = []
  const prompts: string[] = []
  const answer = gateway.answerPermission.bind(gateway)
  gateway.answerPermission = async (target, requestId, optionId) => {
    answers.push([requestId, optionId])
    return answer(target, requestId, optionId)
  }
  const prompt = gateway.prompt.bind(gateway)
  gateway.prompt = (target, text) => {
    prompts.push(text)
    return prompt(target, text)
  }

  const app = createApp(AgentPanel, { gateway, session, labels: LABELS })
  app.use(pinia)
  app.mount(host)
  mounted.push(app)

  const store = useAgentSessionStore()
  const record = () => store.recordFor(store.activeKey)
  const el = (selector: string): HTMLElement | null => host.querySelector(selector)
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 4; i += 1) {
      await nextTick()
      await flush()
    }
  }

  const harness: Harness = {
    answers,
    prompts,
    el,
    text: (selector) => el(selector)?.textContent?.trim() ?? '',
    options: () =>
      Array.from(host.querySelectorAll<HTMLElement>('.agent-perm-options button')).map(
        (button) => button.textContent?.trim() ?? '',
      ),
    type: async (text) => {
      const field = host.querySelector<HTMLTextAreaElement>('.agent-composer-field')
      if (field === null) throw new Error('the panel has no composer field')
      field.value = text
      field.dispatchEvent(new Event('input'))
      await settle()
    },
    send: async (text) => {
      await harness.type(text)
      await nextTick()
      const button = host.querySelector<HTMLButtonElement>('.agent-composer [data-action="send"]')
      if (button === null) throw new Error('the composer is not offering a send')
      button.click()
      await settle()
    },
    click: async (selector) => {
      const target = el(selector)
      if (target === null) throw new Error(`nothing matches ${selector}`)
      target.click()
      await settle()
    },
    settle,
    state: () => record()?.view.state ?? 'none',
    pendingId: () => record()?.view.permissions[0]?.payload.requestId ?? null,
  }
  await settle()
  return harness
}

describe('AgentPanel — the authorization a run waits on', () => {
  it('offers the engine’s options and, answered, finishes the turn', async () => {
    const harness = await mountPanel({
      chunks: ['Reading the plan. '],
      permission: {
        title: 'Read notes/plan.md',
        options: [...OPTIONS],
        input: { state: 'text', json: '{"path":"notes/plan.md"}' },
      },
    })

    await harness.send('read the plan')

    // Panel in: the panel is showing the request, and it is answerable. Before this file's
    // wiring, the only reachable state was the status word and a stop button.
    expect(harness.el('.agent-perm')).not.toBeNull()
    expect(harness.text('.agent-perm-title')).toContain('Read notes/plan.md')
    expect(harness.options()).toEqual(['Always allow', 'Reject'])
    expect(harness.text('.agent-bar-state')).toContain('Waiting for approval')
    // One action while a run is in flight — and it is stop, not send.
    expect(harness.el('.agent-composer [data-action="stop"]')).not.toBeNull()
    expect(harness.el('.agent-composer [data-action="send"]')).toBeNull()
    expect(harness.state()).toBe('waiting-permission')
    expect(harness.answers).toEqual([])

    // Decision out: the engine's own option id, under the request it belongs to.
    const requestId = harness.pendingId()
    expect(requestId).not.toBeNull()
    await harness.click('.agent-perm-options button')

    expect(harness.answers).toEqual([[requestId, 'always']])
    // …and the turn ran to its own end because of that answer, which is the half a user sees.
    expect(harness.state()).toBe('completed')
    expect(harness.text('.agent-row-reply')).toContain('Reading the plan.')
    // The request is gone with its turn, so no button is left to press twice.
    expect(harness.el('.agent-perm')).toBeNull()
  })

  it('stops the suspended turn from the prompt without answering it', async () => {
    const harness = await mountPanel({
      chunks: [],
      permission: { title: 'Read notes/plan.md', options: [...OPTIONS] },
    })

    await harness.send('read the plan')
    expect(harness.state()).toBe('waiting-permission')

    await harness.click('[data-action="cancel-run"]')

    // A stop is not an answer: the protocol has exactly two outcomes and a refusal is one of
    // them, so nothing may be sent as if the reader had chosen an option.
    expect(harness.answers).toEqual([])
    expect(harness.state()).toBe('cancelled')
    expect(harness.el('.agent-perm')).toBeNull()
  })

  it('offers stop rather than send while a run is in flight, and refuses a second prompt', async () => {
    const harness = await mountPanel({ chunks: ['done. '], hang: true })

    await harness.send('first')
    expect(harness.prompts).toEqual(['first'])
    expect(harness.el('.agent-composer [data-action="send"]')).toBeNull()

    // The store keeps one active generation per session (§6.2): there is no send control to
    // press, and the text waits in the field rather than being sent beside the running turn.
    expect(harness.state()).toBe('running')
    expect(harness.prompts).toEqual(['first'])
  })
})

describe('AgentPanel — the transcript before it has a row', () => {
  it('draws the engine’s own line while nothing has happened, and drops it on the first row', async () => {
    const harness = await mountPanel({ chunks: ['Reading. '] })

    // The engine's name is in the sentence rather than the word "session": the line says who is
    // being addressed, and the panel gets the name from the registry (see `AgentRailState`).
    expect(harness.text('[data-agent-empty]')).toBe('Message Memory — / for commands')

    await harness.send('hello')

    // The first row is the reader's own; the line belongs to an empty transcript and goes with
    // it, rather than sitting above the conversation for the rest of the session.
    expect(harness.el('[data-agent-empty]')).toBeNull()
  })

  it('fills the `/` menu from the engine’s frames, which is what makes `/ for commands` true', async () => {
    const harness = await mountPanel({ chunks: ['ok. '] })

    // What the engine publishes after a session opens (P0 §2.2). It reaches the menu through
    // the store's own feed, not through the reduced view: the view cannot tell "nothing
    // published yet" from "published an empty list", and the menu says different things for the
    // two.
    gateway.emit(session, {
      kind: 'commands-changed',
      payload: { commands: [{ name: 'review', description: 'Review what changed' }] },
    })
    await harness.settle()

    await harness.type('/rev')

    expect(harness.el('.agent-command-menu')?.getAttribute('data-view')).toBe('rows')
    expect(harness.text('.agent-command-item')).toContain('/review')
  })

  it('says it is still waiting when the engine has published nothing, rather than showing a stale list', async () => {
    const harness = await mountPanel({ chunks: ['ok. '] })

    await harness.type('/')

    // The fourth state of the menu, and the reason the feed could not simply be the view's list:
    // an empty list here means "not yet", which is worth waiting for and does not look the same
    // as an engine that has nothing to offer.
    expect(harness.el('.agent-command-menu')?.getAttribute('data-view')).toBe('waiting')
  })
})

/**
 * The panel mounting on a session the host has **reopened** — 「重开会话，看见那段对话」.
 *
 * This is the layer the shipped feature was false at, and no test in this tree stood on it. The
 * Rust tests stop at the host's own answer; the frontend tests drive the memory double, which
 * replays in its own book-keeping rather than in the shape a load produces; and the panel was
 * covered only for the states a *new* session passes through. So a snapshot carrying a restored
 * conversation, read by the panel that mounts on it, went unchecked — and what the reader saw was
 * the empty-transcript line over a conversation the engine had just handed back.
 *
 * The shape is the host's, not the double's, and it is the shape `agent_session_ipc_test.rs` reads
 * back out of `SessionSnapshots` for a load: `state: 'ready'` — the engine admitted the session and
 * nothing has been asked of it — `runId: null`, because a load is not a turn and there is no turn
 * to point at, and the conversation carried by frames stamped with the load's own run (the only run
 * id a replayed frame can carry: the engine's notifications name no run and the host stamps them).
 *
 * Frames are put into the double through its own `emit`, so that its buffer, its subscription and
 * everything downstream stay real; the two fields overridden are exactly the two that are the
 * host's reading of a load rather than the double's of a turn.
 */
describe('AgentPanel — a session that was reopened', () => {
  it('draws the restored conversation and leaves the session able to be asked again', async () => {
    gateway.emit(session, { kind: 'user-delta', payload: { text: 'ping' }, runId: 'load-0' })
    gateway.emit(session, { kind: 'thought-delta', payload: { text: 'thinking' }, runId: 'load-0' })
    gateway.emit(session, { kind: 'text-delta', payload: { text: 'pong' }, runId: 'load-0' })
    const snapshot = gateway.snapshot.bind(gateway)
    gateway.snapshot = async (target) => ({
      ...(await snapshot(target)),
      state: 'ready',
      runId: null,
    })

    const harness = await mountPanel({ chunks: [] })

    // The conversation, both halves, on the panel's own rows.
    expect(harness.el('[data-agent-empty]')).toBeNull()
    expect(harness.text('.agent-row-user')).toContain('ping')
    expect(harness.text('.agent-row-reply')).toContain('pong')
    // And the session is not drawn as a generation in flight: the badge says what the host says,
    // and the composer offers send rather than stop — a reopened session nobody is answering is
    // one the reader can talk to.
    expect(harness.text('.agent-bar-state')).toContain('Ready')
    expect(harness.el('.agent-composer [data-action="send"]')).not.toBeNull()
    expect(harness.el('.agent-composer [data-action="stop"]')).toBeNull()
    expect(harness.state()).toBe('ready')
  })
})

/**
 * Frames the window refused. The store has counted them since it was written — "a window that is
 * dropping frames should be able to say so rather than look merely quiet" — and nothing drew the
 * count. What is asserted here is the whole of the render's claim: drawn above zero, absent at
 * zero, and *what it says* is the truth for the commonest refusal rather than the alarming
 * sentence a slightly different reading of the counter would have produced.
 */
describe('AgentPanel — the frames this window refused', () => {
  it('says so when frames were refused, names the reason, and says nothing at zero', async () => {
    setLocale('en')
    const harness = await mountPanel({ chunks: ['done. '] })

    // The ordinary state is a naught, and a naught gets no line: a badge reading "0" is a state
    // that says nothing.
    expect(harness.el('[data-agent-dropped]')).toBeNull()

    const store = useAgentSessionStore()
    const key = store.activeKey
    if (key === null) throw new Error('the panel is not bound to a session')
    gateway.emit(session, { kind: 'commands-changed', payload: { commands: [] } })
    await harness.settle()
    const applied = store.records[key].view.sequence

    // The same frame a second time, which is what a re-subscription and a reload both produce:
    // the transport re-sends what the view already has. It is refused — that is the duplicate
    // guard working — and the panel says so without claiming the transcript lost anything.
    gateway.emit(session, {
      kind: 'commands-changed',
      payload: { commands: [] },
      sequence: applied,
    })
    await harness.settle()

    expect(store.records[key].dropped).toBe(1)
    expect(harness.text('[data-agent-dropped]')).toBe(
      'Frames this window refused for this session: 1 (last: duplicate-sequence).',
    )
    // A refusal is not a hole, and the two notices are two different facts: the sequence was
    // continuous, so nothing about this session's record is missing and the reload button that
    // belongs to a gap is not offered for it.
    expect(store.records[key].view.gap).toBeNull()
    expect(harness.el('.agent-panel-resync')).toBeNull()
  })

  it('counts the refusals rather than showing the last one alone', async () => {
    setLocale('en')
    const harness = await mountPanel({ chunks: ['done. '] })

    const store = useAgentSessionStore()
    const key = store.activeKey
    if (key === null) throw new Error('the panel is not bound to a session')
    gateway.emit(session, { kind: 'commands-changed', payload: { commands: [] } })
    await harness.settle()
    const applied = store.records[key].view.sequence
    for (let i = 0; i < 3; i += 1) {
      gateway.emit(session, {
        kind: 'commands-changed',
        payload: { commands: [] },
        sequence: applied,
      })
    }
    await harness.settle()

    expect(store.records[key].dropped).toBe(3)
    expect(harness.text('[data-agent-dropped]')).toContain('3')
  })
})
