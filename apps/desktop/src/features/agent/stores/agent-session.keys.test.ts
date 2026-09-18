/**
 * The key: which session a frame or a call belongs to.
 *
 * The store's job is the part the reducer cannot see — the handshake that opens a window, the
 * calls, and which of several sessions a frame belongs to — and this is the boundary half of it.
 * A frame carries a composite identity, and one that names another vault or a runtime instance
 * that is over is refused and reported rather than applied; a call is addressed by the key its
 * caller holds, and a key no window holds answers with the typed refusal rather than with nothing.
 * The draft and the scroll position are the key's too, so two sessions on screen stay two
 * sessions (§5.1's 「每会话独立」).
 *
 * The double produced every frame here, and the ones a session must not be polluted by are ones
 * it was asked to deliver late — from a vault the window left, from a runtime instance that is
 * over.
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

describe('the key a frame or a call belongs to', () => {
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

  it('hands the frames it applied to a listener, and nothing else', async () => {
    const { store, gateway, session, record } = await attached()
    const seen: string[] = []
    const stop = store.observeEvents((event) => seen.push(event.kind))
    // The drop's report: a frame for a session this window is not holding is dropped rather than
    // applied, and said out loud because nothing in this window can draw it.
    const reported: string[] = []
    vi.spyOn(console, 'warn').mockImplementation((message: unknown) => {
      reported.push(String(message))
    })

    // T8's `/` menu is the caller: it distinguishes "nothing published yet" from "published an
    // empty list", which the reduced view reports as the same empty array. Feeding it the frames
    // keeps the two callers reading one stream rather than two that could disagree.
    gateway.emit(session, { kind: 'commands-changed', payload: { commands: [{ name: 'review' }] } })
    expect(seen).toEqual(['commands-changed'])

    // A frame this store refuses is not one anybody downstream hears: an event that was not applied
    // to the view is not one a menu may draw a row from.
    gateway.emit(session, {
      kind: 'commands-changed',
      payload: { commands: [{ name: 'elsewhere' }] },
      identity: { vaultId: 'vault-elsewhere' },
    })
    expect(seen).toEqual(['commands-changed'])
    // Reported where a bug report can read it, and counted nowhere: no surface can draw "a frame
    // arrived for a session you are not holding", so the fact goes to the console rather than into
    // a store member only tests would read.
    expect(reported).toHaveLength(1)
    expect(reported[0]).toContain('vault-elsewhere')

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

    // The runtime goes away and a new instance comes up: anything still queued from the old one
    // is addressed to a session that no longer exists under that identity.
    await gateway.crash()
    await gateway.start()
    const reopened = await gateway.openSession({ vaultId: 'vault-1', cwd: '/tmp/vault' })
    expect(reopened.runtimeEpoch).not.toBe(staleEpoch)
    await store.attach(gateway, reopened)
    const key = sessionKey(reopened)
    const before = store.records[key].view.sequence
    const reported: string[] = []
    vi.spyOn(console, 'warn').mockImplementation((message: unknown) => {
      reported.push(String(message))
    })

    gateway.emit(reopened, {
      kind: 'text-delta',
      payload: { text: 'from the last runtime' },
      runId: 'run-1',
      identity: { runtimeEpoch: staleEpoch },
    })

    gateway.emit(reopened, {
      kind: 'text-delta',
      payload: { text: 'from the other vault' },
      runId: 'run-1',
      identity: { vaultId: 'vault-2' },
    })
    // Neither frame was placed: the composite key is the boundary, so they never reached the
    // session on screen, and neither was dropped in silence.
    expect(reported).toHaveLength(2)
    expect(reported[1]).toContain('vault-2')
    expect(store.records[key].view.sequence).toBe(before)
    expect(store.records[key].dropped).toBe(0)
    expect(store.records[key].view.timeline.some((entry) => 'text' in entry)).toBe(false)
  })

  it('puts a change back through the host the session is attached to', async () => {
    // The store is where the gateway lives — it arrives as an argument to `attach`, and the
    // subscription is the only thing holding it — so this is the door a surface uses to reach the
    // host's own recovery. The call goes out with the *session's* handle and the caller's path,
    // and the host's answer comes back unchanged: a refusal is the port's return value and not an
    // exception, and a store that turned one into the other would leave the caller unable to tell
    // "the file cannot be put back" from "the call did not happen".
    const { store, gateway, key } = await attached()
    const recoverChange = vi.fn(async (_session: AgentSession, path: string) => ({
      kind: 'refused' as const,
      path,
      code: 'changed-since-recorded' as const,
    }))
    gateway.recoverChange = recoverChange

    await expect(store.recoverChange(key, '/vault/notes/a.md')).resolves.toEqual({
      kind: 'refused',
      path: '/vault/notes/a.md',
      code: 'changed-since-recorded',
    })
    expect(recoverChange).toHaveBeenCalledTimes(1)
    expect(recoverChange.mock.calls[0][1]).toBe('/vault/notes/a.md')
  })

  it('refuses to recover for a session that is not attached', async () => {
    // `runtime-unavailable`, the word the adapter uses when it refuses before reaching the
    // backend, so a caller sees one code for "nothing is running" whichever layer said it.
    setActivePinia(createPinia())
    const store = useAgentSessionStore()

    await expect(store.recoverChange('nobody', '/vault/notes/a.md')).rejects.toMatchObject({
      code: 'runtime-unavailable',
    })
  })

  it('keeps two sessions apart, including their drafts and positions', async () => {
    const store = useAgentSessionStore()
    const first = await opened()
    const second = await opened({ vaultId: 'vault-2' })
    await store.attach(first.gateway, first.session)
    const firstKey = sessionKey(first.session)
    const secondKey = sessionKey(second.session)
    await store.attach(second.gateway, second.session)
    store.setDraft(secondKey, 'half-written over there')
    store.setScroll(secondKey, 120)

    // Something happens in the second session.
    second.gateway.emit(second.session, {
      kind: 'usage-changed',
      payload: { usedTokens: 42, contextTokens: 100, cost: null },
    })

    // It is applied to its own record, by the composite key the frame carries — and the first
    // session's record is untouched. §5.1's 「每会话独立」 is the key's: the draft and the scroll
    // position as much as the view, and nothing here is "the session" rather than "a session".
    expect(store.records[secondKey].view.usage?.usedTokens).toBe(42)
    expect(store.records[firstKey].view.usage).toBeNull()
    expect(store.records[firstKey].view.sequence).toBe(0)
    expect(store.records[secondKey].draft).toBe('half-written over there')
    expect(store.records[secondKey].scrollTop).toBe(120)
    expect(store.records[firstKey].draft).toBe('')
  })

  it('refuses to send or answer for a session this window does not hold', async () => {
    const store = useAgentSessionStore()
    // A key nothing answers to: both calls are addressed by one, so the arm is the caller
    // naming a session the window has no subscription or record for.
    expect(await store.send('no-such-session', 'hello')).toEqual({ accepted: false, reason: 'no-session' })
    expect(await store.answer('no-such-session', 'req-1', 'yes')).toEqual({
      accepted: false,
      reason: 'no-session',
    })
    await store.resync('no-such-session')
  })

  it('sends to the key it is given, and refuses one whose panel is gone', async () => {
    const { store, gateway, session, key, record } = await attached()
    const elsewhere = await gateway.openSession({ vaultId: 'vault-1', cwd: '/tmp/vault' })
    await store.attach(gateway, elsewhere)
    const elsewhereKey = sessionKey(elsewhere)
    // The rail moves past that session and its panel unmounts, taking its subscription with it.
    // This is the state the pet's task link used to reach from the other side: it moved the store
    // *pointer* to a key like this one, and a control that then addressed "the session in front"
    // sent into a key with no subscription at all. The pointer is gone, so there is no "in front"
    // to address by accident: a call goes to the key its caller holds, and the key that is no
    // window's any more answers with the typed refusal rather than with nothing.
    store.detach(elsewhereKey)
    const prompt = vi.spyOn(gateway, 'prompt')

    await store.send(key, 'the message')

    // Addressed by the key the caller holds, the turn went to that session's engine.
    expect(prompt).toHaveBeenCalledTimes(1)
    expect(prompt.mock.calls[0][0]).toMatchObject({ sessionId: session.sessionId })
    expect(record().view.timeline.filter((entry) => entry.kind === 'user')).toHaveLength(1)
    expect(await store.send(elsewhereKey, 'and another')).toEqual({
      accepted: false,
      reason: 'no-session',
    })
    expect(prompt).toHaveBeenCalledTimes(1)
  })
})
