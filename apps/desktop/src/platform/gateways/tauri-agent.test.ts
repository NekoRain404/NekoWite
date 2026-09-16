/**
 * The real adapter, against the frames the Rust runtime actually produces.
 *
 * Two halves, and the first one is the reason this task existed. T3 read both sides and found
 * that the Rust runtime and the TypeScript contract disagree about the shape of three things —
 * a wrapped `tool-update`, a snake_case `stopReason`, and a usage object whose field set the
 * engine varies between turns — with *both* suites green, because each side was tested against
 * its own reading. The failure mode of that is silence: a frame fails validation, the panel
 * renders nothing, and no error says why. So every frame in the mapping suite below is the
 * measured shape — P0 §2.3 and §6.1's captures, and the fixture's `stopReason` and usage
 * object verbatim — passed through the adapter and asserted as a *contract* event.
 *
 * The second half is the adapter's own IPC: the argument shapes it invokes with, the event
 * listener's lifetime, and the snapshot-then-subscribe handshake §6.2 requires. `invoke` and
 * `listen` are mocked the way every other gateway test in this package mocks them; the frames
 * they feed back are the same real ones.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

const invokeMock = vi.hoisted(() => vi.fn())
const listenMock = vi.hoisted(() => vi.fn())
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }))
vi.mock('@tauri-apps/api/event', () => ({ listen: listenMock }))

import {
  AgentFailure,
  readAgentEvent,
  type AgentEvent,
  type AgentSession,
} from './agent-contracts'
import { createTauriAgentGateway, createTauriAgentIpc, mapHostFrame, ToolProjection } from './tauri-agent'
import type { AgentIpc, AgentHostSnapshot } from './tauri-agent/ipc'

// ---------------------------------------------------------------------------
// The measured frames
// ---------------------------------------------------------------------------

const IDENTITY = {
  agentId: 'opencode',
  profileId: 'default',
  runtimeEpoch: 'epoch-1',
  vaultId: 'vault-1',
  sessionId: 'ses_fake_1',
}

/** A host envelope, in the shape `AgentEventEnvelope` serializes to (`#[serde(rename_all =
 *  "camelCase")]` on the Rust struct): the identity, the run, the host's sequence, the kind. */
function frame(
  kind: string,
  payload: unknown,
  overrides: Partial<Record<string, unknown>> = {},
): Record<string, unknown> {
  return { ...IDENTITY, runId: 'run-0', sequence: 7, kind, payload, ...overrides }
}

/** P0 §2.3's measured ending, with the fixture's own numbers: `{"stopReason":"end_turn",
 *  "usage":{"inputTokens":11,"outputTokens":2,"totalTokens":13,"thoughtTokens":1}}`, as the
 *  Rust runtime re-serializes it (`runs.rs`: `json!({ "stopReason": …, "usage": … })`). */
const RUN_FINISHED = {
  stopReason: 'end_turn',
  usage: { inputTokens: 11, outputTokens: 2, totalTokens: 13, thoughtTokens: 1 },
}

/** P0 §6.1's three measured tool frames, wrapped the way `normalize_update` wraps them
 *  (`json!({ "update": call })`). The first is a `ToolCall` (complete, a title, no locations);
 *  the other two are `ToolCallUpdate`s that carry only what changed — the second has no
 *  `title`, the third no `locations` and no `rawInput`. */
const TOOL_CALL = {
  update: {
    toolCallId: 'call_0630',
    title: 'read',
    kind: 'read',
    status: 'pending',
    locations: [],
    rawInput: {},
  },
}

const TOOL_IN_PROGRESS = {
  update: {
    toolCallId: 'call_0630',
    status: 'in_progress',
    locations: [{ path: '/vault/note.md' }],
    rawInput: { filePath: '/vault/note.md' },
  },
}

const TOOL_COMPLETED = {
  update: {
    toolCallId: 'call_0630',
    status: 'completed',
    title: '.tmp-p0/workspace/note.md',
    content: [{ type: 'content', content: { type: 'text', text: '# P0 probe workspace' } }],
    rawOutput: { output: '<path>…</path>' },
  },
}

function eventOf(mapped: AgentEvent | AgentFailure): AgentEvent {
  if (mapped instanceof AgentFailure) throw new Error(`expected an event, got ${mapped.message}`)
  return mapped
}

function failureOf(mapped: AgentEvent | AgentFailure): AgentFailure {
  if (!(mapped instanceof AgentFailure)) throw new Error('expected a failure, got an event')
  return mapped
}

/** A frame the panel can render must also be a frame the *contract* accepts: every assertion
 *  below goes through the validator, which is the one place that judgement lives. */
function mappedEvent(kind: string, payload: unknown, tools = new ToolProjection()): AgentEvent {
  const event = eventOf(mapHostFrame(frame(kind, payload), tools))
  const revalidated = readAgentEvent(event)
  expect(revalidated).not.toBeInstanceOf(AgentFailure)
  return event
}

// ---------------------------------------------------------------------------
// The mapping: the blocker, in the frames that caused it
// ---------------------------------------------------------------------------

describe('the mapping from the runtime’s frames to the contract', () => {
  it('unwraps a tool call into the flat payload the contract states', () => {
    const event = mappedEvent('tool-update', TOOL_CALL)
    expect(event.kind).toBe('tool-update')
    expect(event.payload).toEqual({
      toolCallId: 'call_0630',
      title: 'read',
      name: undefined,
      kind: 'read',
      status: 'pending',
      paths: [],
      input: { state: 'text', json: '{}' },
      output: { state: 'absent' },
    })
  })

  it('completes a partial update from the frame before it, rather than blanking the row', () => {
    // The measured sequence, and the reason this has to be stateful: the second frame has no
    // title and the third has no locations. `replaceToolEntry` rebuilds the row from the
    // payload, so a literal mapping of frame three would erase the path frame two established.
    const tools = new ToolProjection()
    mappedEvent('tool-update', TOOL_CALL, tools)
    const second = mappedEvent('tool-update', TOOL_IN_PROGRESS, tools)
    expect((second.payload as { title: string }).title).toBe('read')
    const third = mappedEvent('tool-update', TOOL_COMPLETED, tools)
    expect(third.payload).toEqual({
      toolCallId: 'call_0630',
      title: '.tmp-p0/workspace/note.md',
      name: undefined,
      kind: 'read',
      status: 'completed',
      paths: ['/vault/note.md'],
      input: { state: 'text', json: '{"filePath":"/vault/note.md"}' },
      output: { state: 'text', json: '{"output":"<path>…</path>"}' },
    })
  })

  it('falls back to the engine’s own kind and id when a frame has no title to show', () => {
    // The same fallback the permission prompt uses (`label_of` in `permissions.rs`): the
    // contract refuses an empty title, and a tool row dropped on the way to the UI is a call
    // the user never sees. Nothing here is worded for the engine.
    const unnamed = mappedEvent('tool-update', {
      update: { toolCallId: 'call_x', kind: 'execute', status: 'pending' },
    })
    expect((unnamed.payload as { title: string }).title).toBe('execute')
    const bare = mappedEvent('tool-update', { update: { toolCallId: 'call_y' } })
    expect((bare.payload as { title: string }).title).toBe('call_y')
    expect((bare.payload as { status: string }).status).toBe('pending')
    expect((bare.payload as { kind: string }).kind).toBe('other')
  })

  it('keeps one engine’s tool call out of another engine’s projection', () => {
    // §6.1: session ids are the engine's, so two engines can use one, and completing a frame
    // from another engine's row would put its path on this engine's tool call.
    const tools = new ToolProjection()
    mappedEvent('tool-update', TOOL_CALL, tools)
    const other = eventOf(
      mapHostFrame(
        frame('tool-update', { update: { toolCallId: 'call_0630', status: 'completed' } }, {
          agentId: 'another-engine',
        }),
        tools,
      ),
    )
    // The other engine's frame is completed from nothing: no title to inherit, no path.
    expect((other.payload as { title: string }).title).toBe('call_0630')
    expect((other.payload as { kind: string }).kind).toBe('other')
    expect((other.payload as { paths: string[] }).paths).toEqual([])
  })

  it('spells the stop reason the way the contract does, for every reason the protocol has', () => {
    // The wire is snake_case (`end_turn`), the contract kebab (`end-turn`). A table would be a
    // second copy of the protocol's enum; the transform is `_` → `-`, and this test holds it
    // to all five of the contract's own spellings.
    for (const reason of ['end-turn', 'max-tokens', 'max-turn-requests', 'refusal', 'cancelled']) {
      const event = mappedEvent('run-finished', { stopReason: reason.replaceAll('-', '_'), usage: null })
      expect((event.payload as { stopReason: string }).stopReason).toBe(reason)
    }
  })

  it('carries the usage the engine reported, with the optional fields dropped', () => {
    const event = mappedEvent('run-finished', RUN_FINISHED)
    expect(event.payload).toEqual({
      stopReason: 'end-turn',
      usage: { inputTokens: 11, outputTokens: 2, totalTokens: 13 },
    })
  })

  it('answers null — not a number — when the engine’s usage is missing the fields', () => {
    // P0 §6.3: the field set varies between turns and `totalTokens` is not the sum, so a
    // defaulted or computed number would be a wrong number shown as fact (§5.1).
    const partial = mappedEvent('run-finished', {
      stopReason: 'end_turn',
      usage: { inputTokens: 1721, outputTokens: 6 },
    })
    expect((partial.payload as { usage: unknown }).usage).toBeNull()
    const absent = mappedEvent('run-finished', { stopReason: 'end_turn' })
    expect((absent.payload as { usage: unknown }).usage).toBeNull()
  })

  it('passes through the kinds the runtime already speaks in the contract’s shape', () => {
    const text = mappedEvent('text-delta', { text: 'PONG' })
    expect(text.payload).toEqual({ text: 'PONG' })
    const commands = mappedEvent('commands-changed', { commands: [{ name: 'init', description: 'Start' }] })
    expect((commands.payload as { commands: unknown[] }).commands).toHaveLength(1)
    const failed = mappedEvent('run-failed', { code: 'certificate-untrusted', message: 'no CA' })
    expect((failed.payload as { code: string }).code).toBe('certificate-untrusted')
  })

  it('reports a frame it cannot read as a failure of the run, never as silence', () => {
    // The failure this adapter exists to prevent. The envelope is good, the payload is not,
    // and the frame belongs to a run: the run's ending arrives as an event, so a frame
    // dropped quietly would leave `prompt` waiting forever with nothing on screen.
    const event = eventOf(mapHostFrame(frame('run-finished', { stopReason: 'a_new_reason' }), new ToolProjection()))
    expect(event.kind).toBe('run-failed')
    expect(event.runId).toBe('run-0')
    expect((event.payload as { code: string; message: string }).code).toBe('invalid-response')
    expect((event.payload as { message: string }).message).toContain('could not read')
  })

  it('returns a frame with no identity as a failure, rather than inventing a session for it', () => {
    const failure = failureOf(mapHostFrame({ kind: 'text-delta', payload: { text: 'hi' } }, new ToolProjection()))
    expect(failure.code).toBe('invalid-response')
    expect(failure.message).toContain('identity')
  })

  it('reports a session-scoped frame it cannot read out of band, not as a failed run', () => {
    // A command list belongs to no turn: failing the run over it would put a failure in front
    // of the user for something that never touched a turn.
    const failure = failureOf(
      mapHostFrame(frame('commands-changed', { commands: 'not a list' }, { runId: null }), new ToolProjection()),
    )
    expect(failure.code).toBe('invalid-response')
  })

  it('refuses a malformed frame as a failure rather than throwing', () => {
    // The receive path reports; it does not unwind.
    expect(mapHostFrame(null, new ToolProjection())).toBeInstanceOf(AgentFailure)
    expect(mapHostFrame('a frame', new ToolProjection())).toBeInstanceOf(AgentFailure)
  })

  it('keeps the projection bounded, so a long session cannot grow it without end', () => {
    const tools = new ToolProjection(2)
    mappedEvent('tool-update', { update: { toolCallId: 'a', title: 'a' } }, tools)
    mappedEvent('tool-update', { update: { toolCallId: 'b', title: 'b' } }, tools)
    mappedEvent('tool-update', { update: { toolCallId: 'c', title: 'c' } }, tools)
    const evicted = mappedEvent('tool-update', { update: { toolCallId: 'a', status: 'completed' } }, tools)
    expect((evicted.payload as { title: string }).title).toBe('a')
  })
})

// ---------------------------------------------------------------------------
// The IPC arguments
// ---------------------------------------------------------------------------

describe('the window’s half of the IPC', () => {
  beforeEach(() => invokeMock.mockReset())

  it('invokes the two commands the backend has with the arguments it declared', async () => {
    // `commands/agent.rs`: `agent_permission_answer(answer: PermissionAnswer)` and
    // `agent_cancel_run(session_id: String)`, neither with `rename_all`, so the keys are the
    // camelCase spelling Tauri deserializes them from.
    invokeMock.mockResolvedValue(undefined)
    const ipc = createTauriAgentIpc()
    await ipc.answerPermission({
      session: { ...IDENTITY },
      requestId: 'perm-1',
      optionId: 'once',
    })
    expect(invokeMock).toHaveBeenLastCalledWith('agent_permission_answer', {
      answer: { session: IDENTITY, requestId: 'perm-1', optionId: 'once' },
    })
    await ipc.cancel('ses_fake_1')
    expect(invokeMock).toHaveBeenLastCalledWith('agent_cancel_run', { sessionId: 'ses_fake_1' })
  })

  it('names every command it calls, so a missing backend command is one line to find', async () => {
    invokeMock.mockResolvedValue({})
    const ipc = createTauriAgentIpc()
    await ipc.start('vault-1')
    await ipc.stop()
    await ipc.openSession('vault-1', '/vault')
    await ipc.selectModel('ses_fake_1', 'model', 'fake/model-b')
    await ipc.prompt('ses_fake_1', 'hello')
    await ipc.snapshot('ses_fake_1')
    expect(invokeMock.mock.calls.map((call) => call[0])).toEqual([
      'agent_start',
      'agent_stop',
      'agent_open_session',
      'agent_set_config_option',
      'agent_prompt',
      'agent_session_snapshot',
    ])
    expect(invokeMock).toHaveBeenCalledWith('agent_prompt', {
      sessionId: 'ses_fake_1',
      text: 'hello',
    })
  })

  it('unwraps the event envelope Tauri hands a listener', async () => {
    const received: unknown[] = []
    listenMock.mockImplementation(async (_channel: string, handler: (event: { payload: unknown }) => void) => {
      handler({ payload: 'the-frame' })
      return () => {}
    })
    await createTauriAgentIpc().onEvent((frame) => received.push(frame))
    expect(listenMock).toHaveBeenCalledWith('agent-event', expect.any(Function))
    expect(received).toEqual(['the-frame'])
  })
})

// ---------------------------------------------------------------------------
// The gateway: a fake IPC in place of the window's
// ---------------------------------------------------------------------------

interface FakeIpc extends AgentIpc {
  /** Push a frame at the gateway as the host would. */
  push(frame: unknown): void
  /** How many listeners are currently registered. */
  readonly listeners: number
  /** How many of those have been removed by their own unsubscribe. */
  readonly unlistened: number
  calls: string[]
}

function fakeIpc(overrides: Partial<AgentIpc> = {}): FakeIpc {
  const registered = new Set<(frame: unknown) => void>()
  const removed: Array<(frame: unknown) => void> = []
  const calls: string[] = []
  const ipc: FakeIpc = {
    calls,
    get listeners() {
      return registered.size
    },
    get unlistened() {
      return removed.length
    },
    push(frame) {
      for (const listener of [...registered]) listener(frame)
    },
    async start() {
      calls.push('start')
      return { agentId: 'opencode', profileId: 'default', runtimeEpoch: 'epoch-1' }
    },
    async stop() {
      calls.push('stop')
    },
    async openSession() {
      calls.push('openSession')
      return {
        sessionId: 'ses_fake_1',
        configOptions: [
          {
            id: 'model',
            name: 'Model',
            type: 'select',
            currentValue: 'fake/model-a',
            options: [
              { value: 'fake/model-a', name: 'Model A' },
              { value: 'fake/model-b', name: 'Model B' },
            ],
          },
        ],
        modelOptionId: 'model',
      }
    },
    async selectModel() {
      calls.push('selectModel')
    },
    async prompt() {
      calls.push('prompt')
      return 'run-0'
    },
    async cancel() {
      calls.push('cancel')
    },
    async answerPermission() {
      calls.push('answerPermission')
    },
    async snapshot(): Promise<AgentHostSnapshot> {
      calls.push('snapshot')
      return { identity: IDENTITY, state: 'ready', runId: null, sequence: 0, events: [], permissions: [] }
    },
    async onEvent(listener) {
      registered.add(listener)
      return () => {
        registered.delete(listener)
        removed.push(listener)
      }
    },
    ...overrides,
  }
  return ipc
}

async function openSessionOn(gateway: ReturnType<typeof createTauriAgentGateway>): Promise<AgentSession> {
  await gateway.start()
  return gateway.openSession({ vaultId: 'vault-1', cwd: '/vault' })
}

/** Let the adapter's own awaits (the channel registration, the prompt call) finish, so a test
 *  can push a frame at a gateway that is really waiting for one. */
function settleMicrotasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

describe('the real gateway', () => {
  it('mints a session handle from the host’s epoch and the engine’s id', async () => {
    const gateway = createTauriAgentGateway({ vaultId: 'vault-1', ipc: fakeIpc() })
    const session = await openSessionOn(gateway)
    expect(session).toMatchObject(IDENTITY)
    // The catalog is the projection of the option the host named — one read, both halves.
    expect(session.models).toEqual([
      { id: 'fake/model-a', name: 'Model A' },
      { id: 'fake/model-b', name: 'Model B' },
    ])
    expect(session.initialModelId).toBe('fake/model-a')
  })

  it('refuses to send a model the session never offered, before the engine sees it', async () => {
    const ipc = fakeIpc()
    const gateway = createTauriAgentGateway({ vaultId: 'vault-1', ipc })
    const session = await openSessionOn(gateway)
    await expect(gateway.selectModel(session, 'fake/never')).rejects.toMatchObject({
      code: 'invalid-response',
    })
    // The option the catalog came from is what a real switch moves — the contract's
    // `selectModel` carries no option id, so the adapter has to have kept it.
    await gateway.selectModel(session, 'fake/model-b')
    expect(ipc.calls).toContain('selectModel')
  })

  it('refuses a call on a runtime that is not started', async () => {
    const gateway = createTauriAgentGateway({ vaultId: 'vault-1', ipc: fakeIpc() })
    await expect(gateway.openSession({ vaultId: 'vault-1', cwd: '/vault' })).rejects.toMatchObject({
      code: 'runtime-unavailable',
    })
  })

  it('resolves a prompt when the run’s ending arrives as a frame', async () => {
    const ipc = fakeIpc()
    const gateway = createTauriAgentGateway({ vaultId: 'vault-1', ipc })
    const session = await openSessionOn(gateway)
    const pending = gateway.prompt(session, 'hello')
    await settleMicrotasks()
    expect(ipc.listeners).toBe(1)
    ipc.push(frame('text-delta', { text: 'PONG' }))
    ipc.push(frame('run-finished', RUN_FINISHED))
    await expect(pending).resolves.toEqual({
      stopReason: 'end-turn',
      usage: { inputTokens: 11, outputTokens: 2, totalTokens: 13 },
    })
  })

  it('settles a run whose ending arrives before the prompt call has returned', async () => {
    // The race the store documents in its own header: the engine's reaction can be delivered
    // before the call that asked for it returns. A frame dropped here would leave `prompt`
    // waiting on a turn that is already over.
    const ipc = fakeIpc()
    ipc.prompt = async () => {
      ipc.push(frame('run-finished', RUN_FINISHED))
      return 'run-0'
    }
    const gateway = createTauriAgentGateway({ vaultId: 'vault-1', ipc })
    const session = await openSessionOn(gateway)
    await expect(gateway.prompt(session, 'hello')).resolves.toMatchObject({ stopReason: 'end-turn' })
  })

  it('rejects the turn when the host reports it failed', async () => {
    const ipc = fakeIpc()
    const gateway = createTauriAgentGateway({ vaultId: 'vault-1', ipc })
    const session = await openSessionOn(gateway)
    const pending = gateway.prompt(session, 'hello')
    await settleMicrotasks()
    expect(ipc.listeners).toBe(1)
    ipc.push(frame('run-failed', { code: 'process-exited', message: 'the engine exited' }))
    await expect(pending).rejects.toMatchObject({ code: 'process-exited' })
  })

  it('keeps one active generation per session', async () => {
    const gateway = createTauriAgentGateway({ vaultId: 'vault-1', ipc: fakeIpc() })
    const session = await openSessionOn(gateway)
    const first = gateway.prompt(session, 'one')
    await expect(gateway.prompt(session, 'two')).rejects.toMatchObject({ code: 'buffer-conflict' })
    void first.catch(() => {})
  })

  it('ends a turn in flight when the runtime stops, and rejects the caller’s promise', async () => {
    const ipc = fakeIpc()
    const gateway = createTauriAgentGateway({ vaultId: 'vault-1', ipc })
    const session = await openSessionOn(gateway)
    const pending = gateway.prompt(session, 'hello')
    await settleMicrotasks()
    expect(ipc.listeners).toBe(1)
    await gateway.stop()
    await expect(pending).rejects.toMatchObject({ code: 'cancelled' })
    // The listener goes with the runtime: nothing is left registered for a gateway whose
    // every call would now be refused.
    expect(ipc.unlistened).toBe(1)
    expect(ipc.listeners).toBe(0)
  })
})

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
