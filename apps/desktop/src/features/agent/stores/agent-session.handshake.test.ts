/**
 * The handshake that opens a window on a session, and the interleavings it has to survive.
 *
 * The store's job is the part the reducer cannot see, and the largest of those parts is this one:
 * reading the host's record out, continuing from it with a subscription, and staying correct while
 * the panel is mounted, unmounted and mounted again. The ordering rule itself lives in
 * `services/agent-session-subscription.ts`; what is asserted here is what the window ends up
 * holding — the snapshot committed before the frames that continue from it, one listener for one
 * session, and an attempt nobody is making any more that registers nothing and releases whatever
 * the host handed it.
 *
 * The handshake's races are about what happens between the host reading out its record and the
 * subscription that continues from it, and nothing can be asserted about that window unless a
 * test can open it — which is what the holds below do, on frames the memory double actually
 * produced.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import type { AgentSession } from '../../../platform/gateways/agent-contracts'
import { createMemoryAgentGateway, type MemoryAgentGateway } from '../../../platform/gateways/memory-agent'
import { sessionKey } from '../services/agent-session-view'
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
 * The handshake's races are about what happens between the host reading out its record and the
 * subscription that continues from it, and nothing can be asserted about that window unless a
 * test can open it. Each snapshot is taken when its call is made — the way a host that answers
 * slowly still answered about the moment it was asked — so what the test does while one is held
 * is *newer* than the snapshot on its way back. Releasing them out of order is how a slow answer
 * lands after a fast one, which is the interleaving that makes a superseded attempt dangerous.
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
 * Hold the answer to the next `subscribe`: `called` resolves when the host has been asked, and the
 * listener it hands over is counted when it is released.
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

describe('the handshake that opens a window', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  async function attached() {
    const store = useAgentSessionStore()
    const { gateway, session } = await opened()
    await store.attach(gateway, session)
    const key = sessionKey(session)
    return { store, gateway, session, key, record: () => store.records[key] }
  }

  it('records a hole in the stream and repairs the state without losing the conversation', async () => {
    const { store, gateway, session, key, record } = await attached()
    await store.send(key, 'hello')
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
    expect(store.records[key].view.sequence).toBeGreaterThan(0)
    expect(store.records[key].view.state).toBe('completed')

    const after = store.records[key].view.timeline.length
    await store.send(key, 'and now')
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
    const sending = store.send(key, 'the question I typed')

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
    await store.send(key, 'hello')
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
    await store.send(key, 'hello')
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
    await store.send(key, 'hello')
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
})
