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

  it('refuses to send or answer with no session attached', async () => {
    const store = useAgentSessionStore()
    expect(await store.send('hello')).toEqual({ accepted: false, reason: 'no-session' })
    expect(await store.answer('req-1', 'yes')).toEqual({ accepted: false, reason: 'no-session' })
    await store.resync('no-such-session')
  })
})
