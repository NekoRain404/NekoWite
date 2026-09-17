/**
 * The store's tests.
 *
 * They drive the memory double rather than a hand-built stream, because the store's job is
 * the part the reducer cannot see: the handshake that opens a window, the calls, and which
 * of several sessions a frame belongs to. Every frame here is one the double actually
 * produced, and the events that must not pollute a session are ones it was asked to deliver
 * late — from a run that ended, from a vault the window left, from a runtime instance that
 * is over.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import type { AgentSession } from '../../../platform/gateways/agent-contracts'
import { createMemoryAgentGateway, type MemoryAgentGateway } from '../../../platform/gateways/memory-agent'
import { AGENT_TEXT_LIMIT } from '../services/agent-event-reducer'
import { sessionKey } from '../services/agent-session-view'
import type { AgentLiveNote } from '../services/agent-context-snapshot'
import { useAgentSessionStore } from './agent-session'

const AGENT_ID = 'agent-1'
const PROFILE_ID = 'profile-1'

/** A started gateway with one open session, the way the composition site hands them over. */
async function opened(
  options: { vaultId?: string; replayLimit?: number } = {},
): Promise<{ gateway: MemoryAgentGateway; session: AgentSession }> {
  const gateway = createMemoryAgentGateway({
    agentId: AGENT_ID,
    profileId: PROFILE_ID,
    replayLimit: options.replayLimit,
  })
  await gateway.start()
  const session = await gateway.openSession({ vaultId: options.vaultId ?? 'vault-1', cwd: '/tmp/vault' })
  return { gateway, session }
}

/**
 * Hold every snapshot until the test lets that one go, in the order the calls were made.
 *
 * The handshake's races are about what happens between the host reading out its record and
 * the subscription that continues from it, and nothing can be asserted about that window
 * unless a test can open it. Each snapshot is taken when its call is made — the way a host
 * that answers slowly still answered about the moment it was asked — so what the test does
 * while one is held is *newer* than the snapshot on its way back. Releasing them out of
 * order is how a slow answer lands after a fast one, which is the interleaving that makes a
 * superseded attempt dangerous.
 */
function holdSnapshots(gateway: MemoryAgentGateway): Array<() => void> {
  const take = gateway.snapshot.bind(gateway)
  const releases: Array<() => void> = []
  gateway.snapshot = async (session) => {
    const taken = take(session)
    let release!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    releases.push(release)
    const snapshot = await taken
    await held
    return snapshot
  }
  return releases
}

/**
 * Hold the answer to the next `subscribe`: `called` resolves when the host has been asked,
 * and the listener it hands over is counted when it is released.
 */
function holdNextSubscribe(gateway: MemoryAgentGateway): {
  called: Promise<void>
  release: () => void
  released: () => number
} {
  const subscribe = gateway.subscribe.bind(gateway)
  let release!: () => void
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  let called!: () => void
  const calledPromise = new Promise<void>((resolve) => {
    called = resolve
  })
  let released = 0
  gateway.subscribe = async (from, onEvent) => {
    const unsubscribe = await subscribe(from, onEvent)
    called()
    await held
    return () => {
      released += 1
      unsubscribe()
    }
  }
  return { called: calledPromise, release, released: () => released }
}

describe('the session store', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  async function attached() {
    const store = useAgentSessionStore()
    const { gateway, session } = await opened()
    await store.attach(gateway, session)
    store.focus(sessionKey(session))
    const key = sessionKey(session)
    return { store, gateway, session, key, record: () => store.records[key] }
  }

  it('opens a window on a session and reduces what the engine sends', async () => {
    const { store, key, record } = await attached()
    expect(store.activeView?.state).toBe('ready')

    await store.send('hello')

    expect(record().view.state).toBe('completed')
    expect(record().view.timeline.map((entry) => entry.kind)).toEqual(['user', 'text'])
    expect(record().view.lastResult?.stopReason).toBe('end-turn')
    expect(store.activeState).toBe('completed')
    expect(key).toContain(sessionKey(store.records[key].identity))
  })

  it('refuses a second turn while one is live, keeps the text, and calls the engine once', async () => {
    const { store, gateway, record } = await attached()
    gateway.script({ hang: true })
    const spy = vi.spyOn(gateway, 'prompt')

    const sending = store.send('the first question')
    expect(store.canSend).toBe(false)
    const refused = await store.send('and a second one')

    expect(refused).toEqual({ accepted: false, reason: 'run-in-flight' })
    expect(spy).toHaveBeenCalledTimes(1)
    // §6.2: the later input waits in the draft rather than being sent beside the run in
    // flight.
    expect(record().draft).toBe('and a second one')
    expect(record().view.timeline.filter((entry) => entry.kind === 'user')).toHaveLength(1)

    await store.cancel(sessionKey(record().identity))
    await sending
  })

  it("does not revive a run the user cancelled, even after the engine keeps talking", async () => {
    const { store, gateway, session, record } = await attached()
    gateway.script({ hang: true })

    const sending = store.send('start something long')
    await store.cancel(sessionKey(session))
    await sending
    expect(record().view.state).toBe('cancelled')

    const before = record().view.timeline.length
    // The protocol says a client SHOULD keep accepting a cancelled run's final frames, so the
    // double delivers one, tagged with the dead run's id.
    gateway.emit(session, { kind: 'text-delta', payload: { text: ' still typing' }, runId: 'run-1' })

    expect(record().view.state).toBe('cancelled')
    expect(record().view.timeline).toHaveLength(before)
    expect(record().dropped).toBe(1)
    expect(record().lastDrop).toBe('closed-run')
  })

  it('applies what describes the session even after a cancel', async () => {
    const { store, gateway, session, record } = await attached()
    gateway.script({ hang: true })
    const sending = store.send('start something long')
    await store.cancel(sessionKey(session))
    await sending

    // The "finer line": a command list or a cost the engine reports is true about the
    // session, not about the run that ended.
    gateway.emit(session, { kind: 'commands-changed', payload: { commands: [{ name: '/review' }] }, runId: 'run-1' })

    expect(record().view.commands).toEqual([{ name: '/review' }])
    expect(record().view.state).toBe('cancelled')
  })

  it('hands the frames it applied to a listener, and nothing else', async () => {
    const { store, gateway, session, record } = await attached()
    const seen: string[] = []
    const stop = store.observeEvents((event) => seen.push(event.kind))

    // T8's `/` menu is the caller: it distinguishes "nothing published yet" from "published an
    // empty list", which the reduced view reports as the same empty array. Feeding it the frames
    // keeps the two callers reading one stream rather than two that could disagree.
    gateway.emit(session, { kind: 'commands-changed', payload: { commands: [{ name: 'review' }] } })
    expect(seen).toEqual(['commands-changed'])

    // A frame this store refuses is not a frame anybody downstream hears: an event that was not
    // applied to the view is not one a menu may draw a row from.
    gateway.emit(session, {
      kind: 'commands-changed',
      payload: { commands: [{ name: 'elsewhere' }] },
      identity: { vaultId: 'vault-elsewhere' },
    })
    expect(seen).toEqual(['commands-changed'])
    expect(store.unattributed).toBe(1)

    stop()
    gateway.emit(session, { kind: 'commands-changed', payload: { commands: [] } })
    // The listener was released; the session was not. The store keeps reducing what it is sent.
    expect(seen).toEqual(['commands-changed'])
    expect(record().view.commands).toEqual([])
  })

  it('refuses a frame from a runtime instance that is over, and one from another vault', async () => {
    const store = useAgentSessionStore()
    const { gateway, session } = await opened()
    const staleEpoch = session.runtimeEpoch

    // The runtime goes away and a new instance comes up: anything still queued from the old
    // one is addressed to a session that no longer exists under that identity.
    await gateway.crash()
    await gateway.start()
    const reopened = await gateway.openSession({ vaultId: 'vault-1', cwd: '/tmp/vault' })
    expect(reopened.runtimeEpoch).not.toBe(staleEpoch)
    await store.attach(gateway, reopened)
    const key = sessionKey(reopened)
    store.focus(key)
    const before = store.records[key].view.sequence

    gateway.emit(reopened, {
      kind: 'text-delta',
      payload: { text: 'from the last runtime' },
      runId: 'run-1',
      identity: { runtimeEpoch: staleEpoch },
    })
    expect(store.unattributed).toBe(1)

    gateway.emit(reopened, {
      kind: 'text-delta',
      payload: { text: 'from the other vault' },
      runId: 'run-1',
      identity: { vaultId: 'vault-2' },
    })
    // Neither frame was placed: the composite key is the boundary, so they never reached the
    // session on screen — and they were counted rather than dropped in silence.
    expect(store.unattributed).toBe(2)
    expect(store.records[key].view.sequence).toBe(before)
    expect(store.records[key].dropped).toBe(0)
    expect(store.records[key].view.timeline.some((entry) => 'text' in entry)).toBe(false)
  })

  it('keeps two sessions apart, including their unread flags and drafts', async () => {
    const store = useAgentSessionStore()
    const first = await opened()
    const second = await opened({ vaultId: 'vault-2' })
    await store.attach(first.gateway, first.session)
    const firstKey = sessionKey(first.session)
    const secondKey = sessionKey(second.session)
    await store.attach(second.gateway, second.session)
    store.focus(firstKey)
    store.setDraft(secondKey, 'half-written over there')
    store.setScroll(secondKey, 120)

    // Something happens in the session that is not on screen.
    second.gateway.emit(second.session, {
      kind: 'usage-changed',
      payload: { usedTokens: 42, contextTokens: 100, cost: null },
    })

    expect(store.records[secondKey].unread).toBe(true)
    expect(store.records[firstKey].unread).toBe(false)
    expect(store.records[secondKey].view.usage?.usedTokens).toBe(42)
    // The session on screen heard nothing of it.
    expect(store.records[firstKey].view.usage).toBeNull()
    expect(store.records[firstKey].view.sequence).toBe(0)
    expect(store.records[secondKey].draft).toBe('half-written over there')
    expect(store.records[secondKey].scrollTop).toBe(120)

    store.focus(secondKey)
    expect(store.records[secondKey].unread).toBe(false)
  })

  it('keeps the draft when a run fails', async () => {
    const store = useAgentSessionStore()
    const { gateway, session } = await opened()
    await store.attach(gateway, session)
    const key = sessionKey(session)
    store.focus(key)
    store.setDraft(key, 'the question I was typing')

    // The runtime dies under the turn.
    await gateway.crash()
    await store.send('the question I was typing')

    expect(store.records[key].view.state).toBe('failed')
    expect(store.records[key].view.failure?.code).toBe('process-exited')
    // §5.1: an error does not clear the draft. The text the user typed is still theirs.
    expect(store.records[key].draft).toBe('the question I was typing')
  })

  it('resumes a run suspended on a permission, and takes the request away', async () => {
    const { store, gateway, session, key, record } = await attached()
    gateway.script({
      permission: {
        title: 'Run a command?',
        options: [
          { optionId: 'yes', name: 'Allow', kind: 'allow_once' },
          { optionId: 'no', name: 'Reject', kind: 'reject_once' },
        ],
      },
    })

    const sending = store.send('do something risky')
    expect(record().view.state).toBe('waiting-permission')
    const request = record().view.permissions[0]
    expect(request.payload.title).toBe('Run a command?')

    const answered = await store.answer(request.payload.requestId, 'yes')
    expect(answered).toEqual({ accepted: true })
    await sending

    expect(record().view.permissions).toHaveLength(0)
    expect(record().view.state).toBe('completed')
    // A second click on a request that is gone never reaches the gateway.
    expect(await store.answer(request.payload.requestId, 'yes')).toEqual({ accepted: false, reason: 'not-pending' })
    expect(key).toBe(sessionKey(session))
  })

  it('stops the engine when a bound is crossed, rather than only labelling the run', async () => {
    const { store, gateway, session, record } = await attached()
    const cancel = vi.spyOn(gateway, 'cancel')

    await store.send('x'.repeat(AGENT_TEXT_LIMIT + 1))

    expect(record().view.state).toBe('failed')
    expect(record().view.failure?.code).toBe('buffer-conflict')
    // The abort stops the run on the engine as well: §6.2's overrun is an abort *and* a
    // report, not a label on a run that is still producing frames.
    expect(cancel).toHaveBeenCalledTimes(1)
    expect(session.sessionId).toBe(record().identity.sessionId)
  })

  it('records a hole in the stream and repairs the state without losing the conversation', async () => {
    const { store, gateway, session, key, record } = await attached()
    await store.send('hello')
    const before = record().view.timeline.length

    // A frame that skips ahead: everything in between never arrived.
    gateway.emit(session, {
      kind: 'usage-changed',
      payload: { usedTokens: 7, contextTokens: 100, cost: null },
      sequence: 9,
    })
    expect(record().view.gap).toEqual({ expected: 3, received: 9 })

    await store.resync(key)

    // The timeline the user is reading is kept; the host's word on the state replaces the
    // view's own, and the subscription continues from where the snapshot ends.
    expect(record().view.timeline.length).toBeGreaterThanOrEqual(before)
    expect(record().view.sequence).toBe(9)
    // And it is live again.
    gateway.emit(session, { kind: 'usage-changed', payload: { usedTokens: 8, contextTokens: 100, cost: null } })
    expect(record().view.sequence).toBe(10)
    expect(record().view.usage?.usedTokens).toBe(8)
    expect(store.records[key].dropped).toBe(0)
  })

  it('adopts an open session without replaying what the snapshot already covers', async () => {
    const store = useAgentSessionStore()
    const { gateway, session } = await opened()
    await gateway.start()
    gateway.script({ chunks: ['already said'] })
    await gateway.prompt(session, 'earlier')

    // A window that mounts after the turn: the snapshot carries the tail, and the
    // subscription continues from the sequence it reports.
    await store.attach(gateway, session)
    const key = sessionKey(session)
    store.focus(key)
    expect(store.records[key].view.sequence).toBeGreaterThan(0)
    expect(store.records[key].view.state).toBe('completed')

    const after = store.records[key].view.timeline.length
    await store.send('and now')
    expect(store.records[key].view.timeline.length).toBeGreaterThan(after)
  })

  it('shows the user’s turn of a restored conversation, not only the agent’s answer', async () => {
    // The whole path a reopened session takes, driven through the double: a turn is taken, the
    // runtime goes away and comes back, and the session is loaded again. What the panel has to
    // end up reading is the *conversation* — and until this was fixed the runtime's mapping had
    // no arm for `user_message_chunk`, so this timeline held the agent's half and nothing else:
    // an event kind declared, reduced and drawn, with no producer, and a restore that failed
    // silently rather than loudly.
    const store = useAgentSessionStore()
    const { gateway, session } = await opened()
    await gateway.start()
    gateway.script({ chunks: ['PONG'] })
    await gateway.prompt(session, 'Reply with exactly: PONG')

    await gateway.stop()
    await gateway.start()
    const revived = await gateway.loadSession(session.sessionId, {
      vaultId: 'vault-1',
      cwd: '/tmp/vault',
    })
    await store.attach(gateway, revived)
    const key = sessionKey(revived)
    store.focus(key)

    expect(
      store.records[key].view.timeline.map(
        (entry) => `${entry.kind}:${'text' in entry ? entry.text : ''}`,
      ),
    ).toEqual(['user:Reply with exactly: PONG', 'text:PONG'])
    // And the row is the engine's copy rather than a second host message: the two are different
    // statements about the conversation, and the timeline keeps them apart by `origin` (a user
    // row must never be silently repainted as the host's own send).
    const first = store.records[key].view.timeline[0]
    expect(first.kind === 'user' && first.origin).toBe('engine')
  })

  it('detaches idempotently, and stops hearing the session once it has', async () => {
    const store = useAgentSessionStore()
    const { gateway, session } = await opened()
    await store.attach(gateway, session)
    const key = sessionKey(session)
    store.focus(key)

    store.detach(key)
    store.detach(key)
    const before = store.records[key].view.sequence
    gateway.emit(session, { kind: 'text-delta', payload: { text: 'nobody is listening' }, runId: 'run-1' })
    expect(store.records[key].view.sequence).toBe(before)
    // The record stays: the panel can still show what it last knew.
    expect(store.records[key]).toBeDefined()
  })

  it('keeps the messages the user sent when the panel comes back to a live session', async () => {
    const { store, gateway, session, key, record } = await attached()
    gateway.script({ chunks: ['working on it'], hang: true })
    const sending = store.send('the question I typed')

    // The run is suspended and the panel goes away and comes back — the ordinary collapse,
    // not an error path.
    store.detach(key)
    await store.attach(gateway, session)

    // §11.1's remount case: the user's own turn is not an engine event, so the host's bounded
    // replay cannot reconstruct it. A handshake that rebuilds the view from that replay takes
    // the message off the screen while the conversation is still live.
    expect(record().view.timeline.map((entry) => `${entry.kind}:${'text' in entry ? entry.text : ''}`)).toEqual([
      'user:the question I typed',
      'text:working on it',
    ])
    expect(record().view.state).toBe('running')

    await store.cancel(key)
    await sending
  })

  it('does not let a resync put an older snapshot back over frames the view already applied', async () => {
    const { store, gateway, session, key, record } = await attached()
    await store.send('hello')
    const before = record().view.sequence

    const holds = holdSnapshots(gateway)
    const resyncing = store.resync(key)
    // The session was live the whole time: the frame is applied to the view while the host
    // is still reading out the record the resync asked for.
    gateway.emit(session, { kind: 'commands-changed', payload: { commands: [{ name: '/issued-during-the-resync' }] } })
    holds[0]()
    await resyncing

    // A snapshot older than the view is not repair material: applying it moves the sequence
    // back and the command that arrived meanwhile is gone for good — the frames it covered
    // were already delivered and will never be delivered again.
    expect(record().view.sequence).toBe(before + 1)
    expect(record().view.commands).toEqual([{ name: '/issued-during-the-resync' }])
  })

  it('commits a snapshot before the frames the subscription hands over', async () => {
    const { store, gateway, session, key, record } = await attached()
    await store.send('hello')
    const before = record().view.sequence
    store.detach(key)

    const holds = holdSnapshots(gateway)
    const attaching = store.attach(gateway, session)
    // While the window is re-establishing itself the host keeps working: this frame is in
    // its record, and the snapshot on its way back was taken before it arrived.
    gateway.emit(session, { kind: 'commands-changed', payload: { commands: [{ name: '/issued-while-away' }] } })
    holds[0]()
    await attaching

    // The subscription replays that frame into the record. The snapshot belongs *under* it,
    // not over it: a handshake that commits after subscribing overwrites what the replay
    // just delivered, and this is the interleaving where that happens.
    expect(record().view.sequence).toBe(before + 1)
    expect(record().view.commands).toEqual([{ name: '/issued-while-away' }])
  })

  it('does not install a subscription for a session detached while it waited', async () => {
    const { store, gateway, session, key, record } = await attached()
    store.detach(key)

    const holds = holdSnapshots(gateway)
    const attaching = store.attach(gateway, session)
    // The panel closes while the host is still answering the snapshot request.
    store.detach(key)
    holds[0]()
    await attaching

    const before = record().view.sequence
    gateway.emit(session, { kind: 'commands-changed', payload: { commands: [{ name: '/nobody-is-listening' }] } })
    // Detached means detached: an attempt nobody is making any more installs nothing, so a
    // frame that arrives for it reaches no view.
    expect(record().view.sequence).toBe(before)
    expect(record().view.commands).toEqual([])
  })

  it('supersedes a handshake still waiting when the panel comes straight back', async () => {
    const { store, gateway, session, key, record } = await attached()
    await store.send('hello')
    const before = record().view.sequence
    store.detach(key)

    const installs = vi.spyOn(gateway, 'subscribe')
    const holds = holdSnapshots(gateway)
    const first = store.attach(gateway, session)
    // The fast switch: the panel is mounted again before the first handshake has been
    // answered, and the frame arrives in between. Only the second snapshot includes it.
    gateway.emit(session, { kind: 'commands-changed', payload: { commands: [{ name: '/issued-while-switching' }] } })
    const second = store.attach(gateway, session)
    expect(holds).toHaveLength(2)

    // The slow answer lands *last* — the interleaving a host under load produces, and the one
    // where an unguarded handshake publishes its older snapshot over the newer attempt.
    holds[1]()
    await second
    holds[0]()
    await first

    // One listener for one session, and the record still where the newest snapshot left it.
    expect(installs).toHaveBeenCalledTimes(1)
    expect(record().view.sequence).toBe(before + 1)
    expect(record().view.commands).toEqual([{ name: '/issued-while-switching' }])
  })

  it('releases the subscription the host hands over after the attempt was abandoned', async () => {
    const { store, gateway, session, key, record } = await attached()
    store.detach(key)

    const held = holdNextSubscribe(gateway)
    const attaching = store.attach(gateway, session)
    await held.called
    // The host is answering the subscribe call — a listener is on its way — and the panel
    // goes away before it lands.
    store.detach(key)
    held.release()
    await attaching

    // Nobody owns that listener: the store's map no longer names it, so the handshake that
    // asked for it is the only place it can ever be released.
    expect(held.released()).toBe(1)
    const before = record().view.sequence
    gateway.emit(session, { kind: 'commands-changed', payload: { commands: [{ name: '/nobody-is-listening' }] } })
    expect(record().view.sequence).toBe(before)
  })

  it('records a handshake that cannot be made instead of rejecting under the panel', async () => {
    const store = useAgentSessionStore()
    const { gateway, session } = await opened()
    await gateway.stop()

    // The panel mounts with a floating promise (`useAgentSession`), so a rejection here is
    // an unhandled exception with no reader: the handshake reports what went wrong on the
    // view, where the panel can say it.
    await expect(store.attach(gateway, session)).resolves.toBeUndefined()
    expect(store.records[sessionKey(session)].view.failure?.code).toBe('runtime-unavailable')
  })

  it('refuses to send or answer with no session attached', async () => {
    const store = useAgentSessionStore()
    expect(await store.send('hello')).toEqual({ accepted: false, reason: 'no-session' })
    expect(await store.answer('req-1', 'yes')).toEqual({ accepted: false, reason: 'no-session' })
    await store.resync('no-such-session')
  })
})

/**
 * The document versions a request is submitted with.
 *
 * The store's half of the edit-apply rule (`services/agent-edit-apply.ts`): the version of each
 * note a prompt names is read *at the send*, and kept for the run that was dispatched. What is
 * asserted here is the timing and the ownership — a version captured later, or one captured for
 * a run that never started, is a check that would pass over text the user had already typed.
 */
describe('the versions a request is submitted with', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  async function attached(vaultId = 'vault-1') {
    const store = useAgentSessionStore()
    const { gateway, session } = await opened({ vaultId })
    await store.attach(gateway, session)
    store.focus(sessionKey(session))
    const key = sessionKey(session)
    return { store, gateway, session, key, record: () => store.records[key] }
  }

  function note(overrides: Partial<AgentLiveNote> = {}): AgentLiveNote {
    return {
      vaultId: 'vault-1',
      path: 'notes/a.md',
      revision: 'r1',
      buffer: { state: 'clean', text: 'as the user left it' },
      ...overrides,
    }
  }

  it('reads the note at the send, and keeps that version for the run it dispatched', async () => {
    const { store, key, record } = await attached()

    const target = note()
    const outcome = await store.send('rewrite this', [target])
    expect(outcome).toEqual({ accepted: true, refusedEdits: [] })
    expect(store.editBaseline(key, 'notes/a.md')).toMatchObject({
      path: 'notes/a.md',
      revision: 'r1',
      text: 'as the user left it',
    })
    // The five identity fields, copied out of the session handle rather than referenced: an
    // apply is checked against the session that asked, and a handle's other fields have no
    // business travelling into a value read back later.
    expect(store.editBaseline(key, 'notes/a.md')?.identity).toMatchObject({
      agentId: AGENT_ID,
      profileId: PROFILE_ID,
      vaultId: 'vault-1',
    })
    expect(record().edits).toHaveLength(1)

    // The run is over and the baseline is still there: a finished run is one whose result may be
    // applied minutes later, and the version it was made against is what that apply is checked
    // against.
    expect(record().view.state).toBe('completed')
    expect(store.editBaseline(key, 'notes/a.md')?.revision).toBe('r1')
  })

  it('captures a value, so a note that moves afterwards does not move the baseline', async () => {
    const { store, key } = await attached()

    // The caller's own object is mutated after the send — the same live-note object an editor
    // would keep handing out. The baseline is a copy, which is what makes "the version at the
    // request" a fact rather than a reference that keeps up.
    const target = note()
    await store.send('rewrite this', [target])
    target.revision = 'r9'
    target.buffer = { state: 'clean', text: 'what I typed while it thought' }

    expect(store.editBaseline(key, 'notes/a.md')).toMatchObject({
      revision: 'r1',
      text: 'as the user left it',
    })
  })

  it('captures nothing for a send that was refused, so the run in flight keeps its own versions', async () => {
    const { store, gateway, key } = await attached()
    gateway.script({ hang: true })

    const sending = store.send('the first question', [note()])
    const refused = await store.send('a second question', [note({ revision: 'r9' })])

    expect(refused).toEqual({ accepted: false, reason: 'run-in-flight' })
    expect(store.editBaseline(key, 'notes/a.md')?.revision).toBe('r1')

    await store.cancel(key)
    await sending
  })

  it('refuses a note from another vault, and says which one, without holding up the prompt', async () => {
    const { store, key, record } = await attached()

    const outcome = await store.send('rewrite all of these', [
      note(),
      note({ path: 'notes/b.md', vaultId: 'vault-2', revision: 'r5' }),
    ])

    expect(outcome).toEqual({
      accepted: true,
      refusedEdits: [
        { reason: 'vault-mismatch', path: 'notes/b.md', noteVaultId: 'vault-2', contextVaultId: 'vault-1' },
      ],
    })
    // The prompt is the user's and goes out either way; the note that could not be read is not
    // in the record, so an answer for it has no baseline to be written on.
    expect(record().edits.map((baseline) => baseline.path)).toEqual(['notes/a.md'])
    expect(store.editBaseline(key, 'notes/b.md')).toBeNull()
  })

  it('answers null for a note the request never named, and for a session it does not hold', async () => {
    const { store, key } = await attached()
    await store.send('rewrite this', [note()])

    // Null is a refusal the apply path reads as one: a proposal for a note no request named has
    // nothing to be checked against, and writing on that is the guess this whole path refuses.
    expect(store.editBaseline(key, 'notes/never-mentioned.md')).toBeNull()
    expect(store.editBaseline('another-session', 'notes/a.md')).toBeNull()
  })

  it('keeps the request’s versions across a cancel, so a late answer is still checked against the right text', async () => {
    const { store, gateway, key, record } = await attached()
    gateway.script({ hang: true })

    const sending = store.send('rewrite this', [note()])
    await store.cancel(key)
    await sending

    expect(record().view.state).toBe('cancelled')
    expect(store.editBaseline(key, 'notes/a.md')).toMatchObject({ revision: 'r1', text: 'as the user left it' })
  })

  it('keeps them across a detach and re-attach, so a reconnect is not a new request', async () => {
    const { store, gateway, session, key } = await attached()
    await store.send('rewrite this', [note()])

    // The rail closes and reopens, the runtime is resynced — the run this request started is
    // still the one whose answer may arrive, and its version is still the one to check against.
    store.detach(key)
    await store.attach(gateway, session)
    await store.resync(key)

    expect(store.editBaseline(key, 'notes/a.md')).toMatchObject({ revision: 'r1', text: 'as the user left it' })
  })
})
