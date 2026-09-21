/**
 * The subscription: the snapshot-then-subscribe handshake §6.2 requires, and its removal.
 *
 * The caller snapshots, the host answers with its sequence and its replayable tail, and everything
 * after that point has to be delivered exactly once and in order — a hole here is silent, which is
 * why a snapshot the host can no longer replay from is refused rather than trimmed. The permission
 * prompts a snapshot holds arrive through the same reader and are read here too.
 */

import { describe, expect, it, vi } from 'vitest'

const invokeMock = vi.hoisted(() => vi.fn())
const listenMock = vi.hoisted(() => vi.fn())
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }))
vi.mock('@tauri-apps/api/event', () => ({ listen: listenMock }))

import type { AgentEvent } from './agent-contracts'
import { createTauriAgentGateway } from './tauri-agent'
import { fakeIpc, openSessionOn } from './tauri-agent-fake-host'
import { IDENTITY, frame } from './tauri-agent-frames'
import type { AgentHostSnapshot } from './tauri-agent/ipc'

// ---------------------------------------------------------------------------
// The subscription: the handshake, and the removal
// ---------------------------------------------------------------------------

function snapshotOf(events: unknown[], sequence: number): AgentHostSnapshot {
  return { identity: IDENTITY, state: 'running', runId: 'run-0', sequence, events, permissions: [] }
}

describe('the subscription', () => {
  it('removes the listener when the caller unsubscribes', async () => {
    const ipc = fakeIpc()
    const gateway = createTauriAgentGateway({ vaultId: 'vault-1', ipc })
    const session = await openSessionOn(gateway)
    const received: AgentEvent[] = []
    const unsubscribe = await gateway.subscribe(await gateway.snapshot(session), (event) =>
      received.push(event),
    )
    expect(ipc.listeners).toBe(1)
    ipc.push(frame('text-delta', { text: 'one' }))
    expect(received).toHaveLength(1)

    unsubscribe()
    // The leak the brief names: a listener that cannot be removed survives every remount. What
    // proves removal here is both halves — the backend's own unsubscribe ran, and a frame that
    // arrives afterwards reaches nobody.
    await vi.waitFor(() => expect(ipc.unlistened).toBe(1))
    ipc.push(frame('text-delta', { text: 'two' }))
    expect(received).toHaveLength(1)
    expect(ipc.listeners).toBe(0)
  })

  it('replays what the caller’s snapshot did not include, once each, in order', async () => {
    // §6.2's window: the caller took its snapshot at 6, the host has 7 and 8, and 9 arrives
    // live. Everything after 6 must be delivered exactly once, in sequence order.
    const tail = [frame('text-delta', { text: 'seven' }, { sequence: 7 }), frame('text-delta', { text: 'eight' }, { sequence: 8 })]
    const ipc = fakeIpc({ snapshot: async () => snapshotOf(tail, 8) })
    const gateway = createTauriAgentGateway({ vaultId: 'vault-1', ipc })
    const session = await openSessionOn(gateway)
    const received: AgentEvent[] = []
    const from = { ...(await gateway.snapshot(session)), sequence: 6, events: [] }
    await gateway.subscribe(from, (event) => received.push(event))
    ipc.push(frame('text-delta', { text: 'nine' }, { sequence: 9 }))
    expect(received.map((event) => event.sequence)).toEqual([7, 8, 9])
    expect(received.map((event) => (event.payload as { text: string }).text)).toEqual([
      'seven',
      'eight',
      'nine',
    ])
  })

  it('refuses a snapshot older than the host can replay, so a hole is never silent', async () => {
    const ipc = fakeIpc({ snapshot: async () => snapshotOf([frame('text-delta', { text: 'x' }, { sequence: 20 })], 20) })
    const gateway = createTauriAgentGateway({ vaultId: 'vault-1', ipc })
    const session = await openSessionOn(gateway)
    const from = { ...(await gateway.snapshot(session)), sequence: 6 }
    await expect(gateway.subscribe(from, () => {})).rejects.toMatchObject({ code: 'buffer-conflict' })
    // A refused subscription leaves nothing behind: no listener for a session nobody follows.
    expect(ipc.listeners).toBe(0)
  })

  it('refuses a snapshot of another runtime instance', async () => {
    const ipc = fakeIpc({
      snapshot: async () => ({ ...snapshotOf([], 0), identity: { ...IDENTITY, runtimeEpoch: 'epoch-0' } }),
    })
    const gateway = createTauriAgentGateway({ vaultId: 'vault-1', ipc })
    const session = await openSessionOn(gateway)
    await expect(gateway.snapshot(session)).rejects.toMatchObject({ code: 'session-stale' })
  })

  it('delivers another session’s frames to nobody', async () => {
    const ipc = fakeIpc()
    const gateway = createTauriAgentGateway({ vaultId: 'vault-1', ipc })
    const session = await openSessionOn(gateway)
    const received: AgentEvent[] = []
    await gateway.subscribe(await gateway.snapshot(session), (event) => received.push(event))
    ipc.push(frame('text-delta', { text: 'mine' }))
    ipc.push(frame('text-delta', { text: 'theirs' }, { sessionId: 'ses_other' }))
    expect(received.map((event) => (event.payload as { text: string }).text)).toEqual(['mine'])
  })

  it('carries the permission prompts a snapshot holds as whole events', async () => {
    const prompt = {
      requestId: 'perm-1',
      toolCallId: 'call_0630',
      title: '/vault/note.md',
      input: { state: 'text', json: '{"filepath":"/vault/note.md"}' },
      // The request's own blocks, as the host sends them (`permissions.rs`'s `content_of`): the
      // contract's reader requires the field, and this one's request carried a proposed change.
      content: [{ type: 'diff', path: '/vault/note.md', oldText: 'old\n', newText: 'new\n' }],
      options: [
        { optionId: 'once', name: 'Allow once', kind: 'allow_once' },
        { optionId: 'always', name: 'Always', kind: 'allow_always' },
      ],
    }
    const ipc = fakeIpc({
      snapshot: async () => ({
        identity: IDENTITY,
        state: 'waiting-permission',
        runId: 'run-0',
        sequence: 3,
        events: [],
        permissions: [frame('permission-request', prompt, { sequence: 3 })],
      }),
    })
    const gateway = createTauriAgentGateway({ vaultId: 'vault-1', ipc })
    const session = await openSessionOn(gateway)
    const snapshot = await gateway.snapshot(session)
    expect(snapshot.state).toBe('waiting-permission')
    expect(snapshot.permissions).toHaveLength(1)
    expect(snapshot.permissions[0].payload).toEqual(prompt)
  })

  it('answers a permission through the command the backend has, bound to the session', async () => {
    const ipc = fakeIpc()
    const gateway = createTauriAgentGateway({ vaultId: 'vault-1', ipc })
    const session = await openSessionOn(gateway)
    await gateway.answerPermission(session, 'perm-1', 'once')
    expect(ipc.calls).toContain('answerPermission')
  })

  it('turns the host’s refusal of an answer into the contract’s vocabulary', async () => {
    // The host refuses with a sentence (its five refusals are worded in `refusal_message`), and
    // the sentence is the part the user reads; the code is the contract's word for "this answer
    // did not take effect".
    const ipc = fakeIpc({
      answerPermission: async () => {
        throw new Error('permission request perm-1 is no longer open')
      },
    })
    const gateway = createTauriAgentGateway({ vaultId: 'vault-1', ipc })
    const session = await openSessionOn(gateway)
    await expect(gateway.answerPermission(session, 'perm-1', 'once')).rejects.toMatchObject({
      code: 'permission-denied',
      message: 'permission request perm-1 is no longer open',
    })
  })
})
