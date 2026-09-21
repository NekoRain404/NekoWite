/**
 * The host's session state, at the boundary the panel draws it from.
 *
 * The state is what the panel draws the session as, and the contract's union is the only vocabulary
 * it has, so a state this build cannot name is refused. What that refusal costs is measured here
 * rather than argued: the answer's own replayable tail goes with it, while a stream a subscriber is
 * already being handed does not — the state is read by the snapshot path and by nothing else.
 */

import { describe, expect, it, vi } from 'vitest'

const invokeMock = vi.hoisted(() => vi.fn())
const listenMock = vi.hoisted(() => vi.fn())
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }))
vi.mock('@tauri-apps/api/event', () => ({ listen: listenMock }))

import { AgentFailure, type AgentEvent } from './agent-contracts'
import { createTauriAgentGateway } from './tauri-agent'
import { fakeIpc, openSessionOn } from './tauri-agent-fake-host'
import { IDENTITY, frame } from './tauri-agent-frames'
import type { AgentHostSnapshot } from './tauri-agent/ipc'

// ---------------------------------------------------------------------------
// The host's state, at the boundary the panel draws it from
// ---------------------------------------------------------------------------

/** One host answer under a chosen state name, everything else equal.
 *
 *  The two tests below differ in the state alone, so what a refusal costs is measured rather
 *  than argued: the same answer, the same events, one state name the contract knows and one it
 *  does not. */
function snapshotSaying(state: string, events: unknown[] = []): AgentHostSnapshot {
  return { identity: IDENTITY, state, runId: 'run-0', sequence: 7, events, permissions: [] }
}

describe('the host’s session state', () => {
  it('refuses a state this build cannot name, and the refusal costs the whole snapshot', async () => {
    // The refusal exists because the state is what the panel draws the session as, and the
    // contract's union is the only vocabulary it has: a name outside the eight cannot be cast
    // into it (`channel.ts`: "a state the panel cannot draw has to be refused at the boundary").
    // What that costs was known only by reading the call — the Rust runtime's own comment says so
    // ("the refusal costs the whole snapshot rather than one field", `snapshot.rs`) and nothing
    // exercised it. This is the measurement: the answer carries a replayable tail, and none of it
    // arrives, because `snapshot()` rejects before it returns anything.
    const tail = [frame('text-delta', { text: 'the tail' }, { sequence: 7 })]
    const ipc = fakeIpc({ snapshot: async () => snapshotSaying('paused', tail) })
    const gateway = createTauriAgentGateway({ vaultId: 'vault-1', ipc })
    const session = await openSessionOn(gateway)

    const refused: unknown = await gateway.snapshot(session).catch((error: unknown) => error)
    // A refusal the caller has to act on is the contract's failure, not a bare throw — the
    // handshake above turns exactly this shape into the view's failure row.
    expect(refused).toBeInstanceOf(AgentFailure)
    expect(refused).toMatchObject({ code: 'invalid-response' })
    // And it names the state it refused, which is the only thing the host's own word for the
    // situation survives in: a message that said "unreadable snapshot" would leave whoever reads
    // the log with nothing to match against the host's vocabulary.
    expect((refused as AgentFailure).message).toContain('paused')
  })

  it('answers a state the contract names with the whole snapshot, so the refusal is the state’s alone', async () => {
    // The mirror case, and the same answer as above but for the state: a test that could pass by
    // refusing every snapshot would prove nothing about the refusal. Here the state is one the
    // contract names, and everything the answer carried comes through.
    const tail = [frame('text-delta', { text: 'the tail' }, { sequence: 7 })]
    const ipc = fakeIpc({ snapshot: async () => snapshotSaying('running', tail) })
    const gateway = createTauriAgentGateway({ vaultId: 'vault-1', ipc })
    const session = await openSessionOn(gateway)

    const snapshot = await gateway.snapshot(session)
    expect(snapshot.state).toBe('running')
    expect(snapshot.sequence).toBe(7)
    expect(snapshot.events).toHaveLength(1)
    expect((snapshot.events[0].payload as { text: string }).text).toBe('the tail')
  })

  it('costs the snapshot and not the stream: a subscription continues while the state is refused', async () => {
    // The blast radius, measured rather than assumed. `channel.subscribe` reads the host's
    // identity, its sequence and its events, and never its state — so a window that is already
    // mounted keeps receiving frames while a fresh snapshot of the same session is refused. That
    // is narrower than "the whole session is unreadable": what an unknown state costs is the
    // mount and every resync from it, not the stream a subscriber is already being handed.
    let state = 'running'
    const ipc = fakeIpc({ snapshot: async () => snapshotSaying(state) })
    const gateway = createTauriAgentGateway({ vaultId: 'vault-1', ipc })
    const session = await openSessionOn(gateway)
    const held = await gateway.snapshot(session)
    state = 'paused'

    await expect(gateway.snapshot(session)).rejects.toMatchObject({ code: 'invalid-response' })

    const received: AgentEvent[] = []
    const unsubscribe = await gateway.subscribe(held, (event) => received.push(event))
    ipc.push(frame('text-delta', { text: 'still delivered' }, { sequence: 8 }))
    expect(received.map((event) => (event.payload as { text: string }).text)).toEqual([
      'still delivered',
    ])
    unsubscribe()
  })
})
