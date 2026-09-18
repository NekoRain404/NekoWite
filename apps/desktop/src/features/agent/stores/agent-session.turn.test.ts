/**
 * The turn: what a send starts, what refuses a second one, and what ends one.
 *
 * They drive the memory double rather than a hand-built stream, because the store's job is the
 * part the reducer cannot see, and what a turn leaves on the record is that part: the calls that
 * reach the host, the draft, and the run's ending. Every frame here is one the double actually
 * produced, including the late ones a cancelled run keeps sending — the protocol says a client
 * SHOULD keep accepting a cancelled run's final frames, so what must not happen is that run
 * coming back to life.
 *
 * The second describe is the versions the request went out with: the store's half of the
 * edit-apply rule (`services/agent-edit-apply.ts`), read at the same `send` as everything here.
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

describe('the turn', () => {
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

  it('opens a window on a session and reduces what the engine sends', async () => {
    const { store, key, record } = await attached()
    expect(record().view.state).toBe('ready')

    await store.send(key, 'hello')

    expect(record().view.state).toBe('completed')
    expect(record().view.timeline.map((entry) => entry.kind)).toEqual(['user', 'text'])
    expect(record().view.lastResult?.stopReason).toBe('end-turn')
    expect(key).toContain(sessionKey(store.records[key].identity))
  })

  it('refuses a second turn while one is live, keeps the text, and calls the engine once', async () => {
    const { store, gateway, key, record } = await attached()
    gateway.script({ hang: true })
    const spy = vi.spyOn(gateway, 'prompt')

    const sending = store.send(key, 'the first question')
    // The view's state is the fact §6.2's one-generation rule is read off: the panel's composer
    // computes its own answer from the same record, and the store keeps no second copy of it.
    expect(record().view.state).toBe('running')
    const refused = await store.send(key, 'and a second one')

    expect(refused).toEqual({ accepted: false, reason: 'run-in-flight' })
    expect(spy).toHaveBeenCalledTimes(1)
    // §6.2: the later input waits in the draft rather than being sent beside the run in flight.
    expect(record().draft).toBe('and a second one')
    expect(record().view.timeline.filter((entry) => entry.kind === 'user')).toHaveLength(1)

    await store.cancel(sessionKey(record().identity))
    await sending
  })

  it("does not revive a run the user cancelled, even after the engine keeps talking", async () => {
    const { store, gateway, session, key, record } = await attached()
    gateway.script({ hang: true })

    const sending = store.send(key, 'start something long')
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
    const { store, gateway, session, key, record } = await attached()
    gateway.script({ hang: true })
    const sending = store.send(key, 'start something long')
    await store.cancel(sessionKey(session))
    await sending

    // The "finer line": a command list or a cost the engine reports is true about the
    // session, not about the run that ended.
    gateway.emit(session, { kind: 'commands-changed', payload: { commands: [{ name: '/review' }] }, runId: 'run-1' })

    expect(record().view.commands).toEqual([{ name: '/review' }])
    expect(record().view.state).toBe('cancelled')
  })

  it('keeps the draft when a run fails', async () => {
    const store = useAgentSessionStore()
    const { gateway, session } = await opened()
    await store.attach(gateway, session)
    const key = sessionKey(session)
    store.setDraft(key, 'the question I was typing')

    // The runtime dies under the turn.
    await gateway.crash()
    await store.send(key, 'the question I was typing')

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

    const sending = store.send(key, 'do something risky')
    expect(record().view.state).toBe('waiting-permission')
    const request = record().view.permissions[0]
    expect(request.payload.title).toBe('Run a command?')

    const answered = await store.answer(key, request.payload.requestId, 'yes')
    expect(answered).toEqual({ accepted: true })
    await sending

    expect(record().view.permissions).toHaveLength(0)
    expect(record().view.state).toBe('completed')
    // A second click on a request that is gone never reaches the gateway.
    expect(await store.answer(key, request.payload.requestId, 'yes')).toEqual({ accepted: false, reason: 'not-pending' })
    expect(key).toBe(sessionKey(session))
  })

  it('stops the engine when a bound is crossed, rather than only labelling the run', async () => {
    const { store, gateway, session, key, record } = await attached()
    const cancel = vi.spyOn(gateway, 'cancel')

    await store.send(key, 'x'.repeat(AGENT_TEXT_LIMIT + 1))

    expect(record().view.state).toBe('failed')
    expect(record().view.failure?.code).toBe('buffer-conflict')
    // The abort stops the run on the engine as well: §6.2's overrun is an abort *and* a
    // report, not a label on a run that is still producing frames.
    expect(cancel).toHaveBeenCalledTimes(1)
    expect(session.sessionId).toBe(record().identity.sessionId)
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
    const outcome = await store.send(key, 'rewrite this', [], [target])
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
    await store.send(key, 'rewrite this', [], [target])
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

    const sending = store.send(key, 'the first question', [], [note()])
    const refused = await store.send(key, 'a second question', [], [note({ revision: 'r9' })])

    expect(refused).toEqual({ accepted: false, reason: 'run-in-flight' })
    expect(store.editBaseline(key, 'notes/a.md')?.revision).toBe('r1')

    await store.cancel(key)
    await sending
  })

  it('refuses a note from another vault, and says which one, without holding up the prompt', async () => {
    const { store, key, record } = await attached()

    const outcome = await store.send(key, 'rewrite all of these', [], [
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
    await store.send(key, 'rewrite this', [], [note()])

    // Null is a refusal the apply path reads as one: a proposal for a note no request named has
    // nothing to be checked against, and writing on that is the guess this whole path refuses.
    expect(store.editBaseline(key, 'notes/never-mentioned.md')).toBeNull()
    expect(store.editBaseline('another-session', 'notes/a.md')).toBeNull()
  })

  it('keeps the request’s versions across a cancel, so a late answer is still checked against the right text', async () => {
    const { store, gateway, key, record } = await attached()
    gateway.script({ hang: true })

    const sending = store.send(key, 'rewrite this', [], [note()])
    await store.cancel(key)
    await sending

    expect(record().view.state).toBe('cancelled')
    expect(store.editBaseline(key, 'notes/a.md')).toMatchObject({ revision: 'r1', text: 'as the user left it' })
  })

  it('keeps them across a detach and re-attach, so a reconnect is not a new request', async () => {
    const { store, gateway, session, key } = await attached()
    await store.send(key, 'rewrite this', [], [note()])

    // The rail closes and reopens, the runtime is resynced — the run this request started is
    // still the one whose answer may arrive, and its version is still the one to check against.
    store.detach(key)
    await store.attach(gateway, session)
    await store.resync(key)

    expect(store.editBaseline(key, 'notes/a.md')).toMatchObject({ revision: 'r1', text: 'as the user left it' })
  })
})
