import { describe, expect, it } from 'vitest'
import {
  AGENT_FAILURE_CODES,
  AGENT_STOP_REASONS,
  AgentFailure,
  readAgentEvent,
  type AgentEvent,
  type AgentEventKind,
  type AgentPermissionKind,
  type AgentSession,
} from './agent-contracts'
import {
  createMemoryAgentGateway,
  MEMORY_MODEL_OPTION,
  type MemoryAgentGateway,
  type MemoryEvent,
} from './memory-agent'

const OPTIONS: readonly { optionId: string; name: string; kind: AgentPermissionKind }[] = [
  { optionId: 'once', name: 'Allow once', kind: 'allow_once' },
  { optionId: 'always', name: 'Always allow', kind: 'allow_always' },
  { optionId: 'no', name: 'Reject', kind: 'reject_once' },
]

const IDENTITY = {
  agentId: 'memory',
  profileId: 'default',
  runtimeEpoch: 'epoch-1',
  vaultId: 'memoir://demo',
  sessionId: 'session-1',
}

/** A well-formed frame, for the validator tests. */
function frame(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...IDENTITY,
    runId: 'run-1',
    sequence: 1,
    kind: 'text-delta',
    payload: { text: 'hi' },
    ...overrides,
  }
}

/** Why a frame was rejected, asserting that it was. */
function rejectionReason(candidate: unknown): string {
  const read = readAgentEvent(candidate)
  expect(read).toBeInstanceOf(AgentFailure)
  return (read as AgentFailure).message
}

/** The failure a call rejected with, so a test can assert on its code. */
async function failureOf(call: Promise<unknown>): Promise<AgentFailure> {
  const error = await call.then(
    () => null,
    (reason: unknown) => reason,
  )
  expect(error).toBeInstanceOf(AgentFailure)
  return error as AgentFailure
}

async function openAgent(
  options: { replayLimit?: number } = {},
): Promise<{ agent: MemoryAgentGateway; session: AgentSession }> {
  const agent = createMemoryAgentGateway({
    agentId: 'memory',
    profileId: 'default',
    ...options,
  })
  await agent.start()
  const session = await agent.openSession({ vaultId: 'memoir://demo', cwd: '/vault' })
  return { agent, session }
}

/** Subscribe the way the app does: snapshot first, then continue from it. */
async function collect(
  agent: MemoryAgentGateway,
  session: AgentSession,
): Promise<{ events: AgentEvent[]; off: () => void }> {
  const events: AgentEvent[] = []
  const off = await agent.subscribe(await agent.snapshot(session), (event) => events.push(event))
  return { events, off }
}

describe('readAgentEvent', () => {
  it('narrows a frame into a typed event and drops fields this host never heard of', () => {
    const read = readAgentEvent(
      frame({ engineFrameId: 'frame-9', payload: { text: 'hello', messageId: 'msg-1' } }),
    )
    expect(read).not.toBeInstanceOf(AgentFailure)
    const event = read as AgentEvent
    expect(event.kind).toBe('text-delta')
    expect(event.payload).toEqual({ text: 'hello' })
    // The engine's own field names must not leak into the contract's payload.
    expect(Object.keys(event.payload)).toEqual(['text'])
  })

  it('rejects a frame whose identity is missing a field', () => {
    expect(rejectionReason(frame({ profileId: undefined }))).toContain('identity is incomplete')
    expect(rejectionReason(frame({ agentId: '' }))).toContain('identity is incomplete')
  })

  it('rejects a frame that is not an object, and a runId that is neither a string nor null', () => {
    expect(rejectionReason(null)).toContain('not an object')
    expect(rejectionReason('a frame')).toContain('not an object')
    expect(rejectionReason(frame({ runId: 7 }))).toContain('runId must be')
  })

  it('rejects an unknown kind rather than inventing a payload for it', () => {
    expect(rejectionReason(frame({ kind: 'agent_message_chunk' }))).toContain('unknown event kind')
  })

  it('rejects a malformed payload and a sequence that is not a count', () => {
    expect(rejectionReason(frame({ kind: 'commands-changed', payload: { commands: 'init' } })))
      .toContain('malformed commands-changed payload')
    expect(rejectionReason(frame({ sequence: -1 }))).toContain('sequence must be')
  })

  it('rejects a permission request that offers nothing to answer', () => {
    expect(
      rejectionReason(
        frame({
          kind: 'permission-request',
          payload: {
            requestId: 'p1',
            title: 'Run?',
            input: { state: 'absent' },
            options: [],
          },
        }),
      ),
    ).toContain('malformed permission-request payload')
  })

  it('rejects a payload whose fields are not the ones the contract names', () => {
    // One case per reader: a reader whose field check is dropped accepts the wrong
    // value silently, and the frame then reaches a component as something it is not.
    const malformed: [string, unknown][] = [
      ['text-delta', { text: 7 }],
      ['thought-delta', { text: null }],
      [
        'tool-update',
        {
          toolCallId: 'call-1',
          title: 'Reading src/main.rs',
          kind: 'read',
          status: 'running',
          paths: [],
          input: { state: 'absent' },
          output: { state: 'absent' },
        },
      ],
      [
        'tool-update',
        {
          toolCallId: 'call-1',
          title: 'Reading src/main.rs',
          kind: 'read',
          status: 'pending',
          paths: [],
          input: { state: 'maybe' },
          output: { state: 'absent' },
        },
      ],
      [
        'tool-update',
        {
          toolCallId: 'call-1',
          title: 'Reading src/main.rs',
          kind: 'read',
          status: 'pending',
          paths: 7,
          input: { state: 'absent' },
          output: { state: 'absent' },
        },
      ],
      [
        'permission-request',
        {
          requestId: 'p1',
          title: 'Run?',
          input: { state: 'absent' },
          options: [{ optionId: 'a', name: 'A', kind: 'maybe' }],
        },
      ],
      ['commands-changed', { commands: [{ description: 'no name' }] }],
      ['commands-changed', { commands: [{ name: 'init', description: 7 }] }],
      ['plan-changed', { entries: [{ content: 'write the test', status: 'doing', priority: 'high' }] }],
      [
        'plan-changed',
        { entries: [{ content: 'write the test', status: 'pending', priority: 'eventually' }] },
      ],
      ['mode-changed', { modeId: '' }],
      [
        'config-changed',
        {
          options: [
            { id: 'model', name: 'Model', value: { kind: 'select', current: 'x', choices: 'none' } },
          ],
        },
      ],
      [
        'config-changed',
        {
          options: [{ id: 'model', name: 'Model', value: { kind: 'select', current: 'x', choices: {} } }],
        },
      ],
      [
        'config-changed',
        {
          options: [
            { id: 'thinking', name: 'Thinking', value: { kind: 'toggle', current: 'yes' } },
          ],
        },
      ],
      ['session-changed', { title: 7 }],
      ['usage-changed', { usedTokens: 1, contextTokens: 'big', cost: null }],
      ['usage-changed', { usedTokens: 1, contextTokens: 10, cost: { amount: 'much', currency: 'USD' } }],
      ['files-changed', { paths: ['ok.md', 7] }],
      // A `run-finished` that states no reason at all. This row used to hold an unfamiliar
      // *value* (`'finished'`), and that is no longer a malformed frame: the protocol's
      // `StopReason` is `#[non_exhaustive]`, so a reason this version does not know is read as
      // its own arm (the test below) rather than refused. What stays refused is a payload that
      // answers nothing, which is what this row is.
      ['run-finished', { usage: null }],
      // A `usage` that is not an object or null. A usage object *missing* fields is not here:
      // P0 §6.3 measured the field set changing between turns, so the fields are optional and a
      // partial one is a well-formed frame.
      ['run-finished', { stopReason: 'end-turn', usage: 'lots' }],
      ['run-failed', { code: 'exploded', message: 'x' }],
    ]

    for (const [kind, payload] of malformed) {
      expect(rejectionReason(frame({ kind, payload }))).toContain(`malformed ${kind} payload`)
    }
  })

  it('reads an ending whose reason it has never seen as unrecognised, not as malformed', () => {
    // The boundary the list above stops at, stated from the other side. A reason the contract
    // does not name is *not* a field it does not name: the protocol's `StopReason` is
    // `#[non_exhaustive]`, and the frame is a completed turn's ending, so refusing it would
    // report a turn the engine finished as a failure of this window's reading. The reading
    // degrades instead — `unrecognised`, with the reason's own wording kept beside it so the
    // condition is diagnosable rather than merely visible.
    const read = readAgentEvent(
      frame({ kind: 'run-finished', payload: { stopReason: 'finished', usage: null } }),
    )

    expect(read).not.toBeInstanceOf(AgentFailure)
    expect((read as AgentEvent).payload).toEqual({
      stopReason: 'unrecognised',
      unrecognisedReason: 'finished',
      usage: null,
    })
  })

  it('accepts one well-formed frame of every kind the contract names', () => {
    // Typed as a Record over the kinds, so a kind added to the payload map is a
    // typecheck failure here until its frame is covered — the widened kind list
    // cannot grow past this test unnoticed.
    const frames: Record<AgentEventKind, unknown> = {
      'text-delta': { text: 'hi' },
      'user-delta': { text: 'do the thing' },
      'thought-delta': { text: 'weighing the options' },
      'tool-update': {
        toolCallId: 'call-1',
        title: 'Reading src/main.rs',
        name: 'read_file',
        kind: 'read',
        status: 'in_progress',
        paths: ['src/main.rs'],
        input: { state: 'text', json: '{"path":"src/main.rs"}' },
        output: { state: 'absent' },
      },
      'permission-request': {
        requestId: 'req-1',
        toolCallId: 'call-1',
        title: 'Write to the vault?',
        input: { state: 'unreadable' },
        options: [...OPTIONS],
      },
      'commands-changed': { commands: [{ name: 'init', description: 'Scaffold the vault' }] },
      'plan-changed': {
        entries: [{ content: 'write the test', status: 'in_progress', priority: 'high' }],
      },
      'mode-changed': { modeId: 'accept-edits' },
      'config-changed': {
        options: [
          {
            id: 'model',
            name: 'Model',
            description: 'Which model answers',
            value: {
              kind: 'select',
              current: 'opencode/big-pickle',
              choices: [{ value: 'opencode/big-pickle', name: 'Big Pickle' }],
            },
          },
          { id: 'thinking', name: 'Thinking', value: { kind: 'toggle', current: false } },
        ],
      },
      'session-changed': { title: 'A renamed session', updatedAt: null },
      'usage-changed': { usedTokens: 8717, contextTokens: 200000, cost: { amount: 0.12, currency: 'USD' } },
      'files-changed': { paths: ['notes/a.md'] },
      'run-finished': { stopReason: 'refusal', usage: null },
      'run-failed': { code: 'certificate-untrusted', message: 'the chain could not be verified' },
    }

    for (const [kind, payload] of Object.entries(frames)) {
      const read = readAgentEvent(frame({ kind, payload }))
      expect(read, `${kind} should be accepted`).not.toBeInstanceOf(AgentFailure)
      expect((read as AgentEvent).kind).toBe(kind)
    }
  })

  it('lands a tool kind this host has not learned yet in `other`', () => {
    // The schema deserializes an unrecognised kind to `other` rather than failing
    // (`#[serde(other)]`), so a newer engine's category is not a malformed frame.
    const read = readAgentEvent(
      frame({
        kind: 'tool-update',
        payload: {
          toolCallId: 'call-1',
          title: 'Teleporting',
          kind: 'teleport',
          status: 'pending',
          paths: [],
          input: { state: 'absent' },
          output: { state: 'absent' },
        },
      }),
    )
    expect(read).not.toBeInstanceOf(AgentFailure)
    expect((read as AgentEvent).payload).toMatchObject({ kind: 'other' })
  })

  it('accepts a frame the engine measured on the wire, thought channel included', () => {
    const read = readAgentEvent(
      frame({ kind: 'thought-delta', payload: { text: 'weighing the options' } }),
    )
    expect(read).not.toBeInstanceOf(AgentFailure)
    expect((read as AgentEvent).kind).toBe('thought-delta')
  })

  it('accepts every failure code the runtime can report, the certificate one included', () => {
    // P0 §2.4: a certificate the runtime cannot verify is its own condition and has to
    // arrive classified. It is an extension beyond the plan's list, so this asserts both
    // that it is in the vocabulary and that the validator accepts every code in it — a
    // code added to the list without reaching the validator would fail here.
    expect(AGENT_FAILURE_CODES).toContain('certificate-untrusted')
    for (const code of AGENT_FAILURE_CODES) {
      const read = readAgentEvent(frame({ kind: 'run-failed', payload: { code, message: 'why' } }))
      expect(read).not.toBeInstanceOf(AgentFailure)
    }
  })

  it('reports usage as unknown rather than as zero when the engine reported none', () => {
    const read = readAgentEvent(
      frame({ kind: 'run-finished', payload: { stopReason: 'end-turn', usage: null } }),
    )
    expect(read).not.toBeInstanceOf(AgentFailure)
    expect((read as AgentEvent).payload).toEqual({ stopReason: 'end-turn', usage: null })
  })
})

describe('memory agent gateway', () => {
  it('answers a turn with its chunks and its end', async () => {
    const { agent, session } = await openAgent()
    const { events } = await collect(agent, session)

    await expect(agent.prompt(session, 'hello')).resolves.toEqual({
      stopReason: 'end-turn',
      usage: null,
    })

    expect(events.map((event) => event.kind)).toEqual(['text-delta', 'run-finished'])
    expect(events[0].payload).toEqual({ text: 'hello' })
    const snapshot = await agent.snapshot(session)
    expect(snapshot).toMatchObject({ state: 'completed', sequence: 2 })
    expect(snapshot.runId).toBe(events[0].runId)
    // Cancelling with nothing in flight is a no-op rather than an error: the user can
    // press stop in the same instant the turn ends.
    await expect(agent.cancel(session)).resolves.toBeUndefined()
  })

  it('carries the identity the runtime was built with, on the handle and on every event', async () => {
    const { agent, session } = await openAgent()
    expect(session).toMatchObject({
      agentId: 'memory',
      profileId: 'default',
      vaultId: 'memoir://demo',
    })
    expect(session.sessionId).toBeTruthy()
    expect(session.initialModelId).toBe(session.models[0].id)

    await expect(agent.selectModel(session, 'memory-quiet')).resolves.toBeUndefined()
    await expect(failureOf(agent.selectModel(session, 'no-such-model'))).resolves.toMatchObject({
      code: 'invalid-response',
    })

    const { events } = await collect(agent, session)
    await agent.prompt(session, 'hello')
    for (const event of events) {
      expect(event).toMatchObject({
        agentId: session.agentId,
        profileId: session.profileId,
        runtimeEpoch: session.runtimeEpoch,
        vaultId: session.vaultId,
        sessionId: session.sessionId,
      })
    }
  })

  it('publishes the session’s model catalog as a projection of its config option', async () => {
    const { session } = await openAgent()
    // One wire value, one source: the catalog is a read-only view of the `model`
    // option, so a second copy edited by hand would fail here rather than drift away
    // from the option the engine actually publishes.
    const option = MEMORY_MODEL_OPTION.value
    expect(option.kind).toBe('select')
    const choices = option.kind === 'select' ? option.choices : []
    expect(session.models).toEqual(choices.map((choice) => ({ id: choice.value, name: choice.name })))
    expect(session.initialModelId).toBe(option.kind === 'select' ? option.current : '')
  })

  it('ends a turn as a refusal, which is a stop reason and not an error', async () => {
    const { agent, session } = await openAgent()
    agent.script({ chunks: ['no'], stopReason: 'refusal' })

    await expect(agent.prompt(session, 'do it')).resolves.toMatchObject({ stopReason: 'refusal' })
    const snapshot = await agent.snapshot(session)
    expect(snapshot.state).toBe('completed')
    expect(snapshot.events.map((event) => event.kind)).toEqual(['text-delta', 'run-finished'])
  })

  it('ends a run through run-finished for every stop reason, none of them a failure', async () => {
    // Four of the protocol's five stop reasons are ordinary endings — a token
    // ceiling, a request limit, a refusal — so a run that hits one is not a failed
    // run, and only the runtime being unable to carry the turn out is `run-failed`.
    for (const stopReason of AGENT_STOP_REASONS) {
      const { agent, session } = await openAgent()
      const { events } = await collect(agent, session)
      agent.script({ stopReason })

      await expect(agent.prompt(session, 'go')).resolves.toMatchObject({ stopReason })
      expect(events.map((event) => event.kind)).toEqual(['text-delta', 'run-finished'])
      expect((await agent.snapshot(session)).state).toBe('completed')
    }
  })

  it('cancels a turn in flight and keeps the cancelled run’s late chunks identifiable', async () => {
    const { agent, session } = await openAgent()
    const { events } = await collect(agent, session)
    agent.script({ chunks: ['partial'], hang: true })

    const turn = agent.prompt(session, 'a long one')
    expect((await agent.snapshot(session)).state).toBe('running')
    await agent.cancel(session)

    await expect(turn).resolves.toEqual({ stopReason: 'cancelled', usage: null })
    const cancelled = events[events.length - 1]
    expect(cancelled.payload).toMatchObject({ stopReason: 'cancelled' })
    expect((await agent.snapshot(session)).state).toBe('cancelled')

    // The chunk a cancelled turn's transport delivers afterwards is representable,
    // still naming the run that must not be revived by it.
    agent.emit(session, {
      kind: 'text-delta',
      payload: { text: 'late' },
      runId: cancelled.runId,
    })
    expect(events[events.length - 1]).toMatchObject({
      kind: 'text-delta',
      runId: cancelled.runId,
      payload: { text: 'late' },
    })

    // The protocol says a client SHOULD keep accepting tool call updates after a
    // cancel, because an agent may send final ones before it answers: so the frame is
    // delivered and stays identifiable by its run. Refusing to let it revive the run
    // is the reducer's job, not the stream's.
    agent.emit(session, {
      kind: 'tool-update',
      payload: {
        toolCallId: 'call-1',
        title: 'Writing src/a.md',
        kind: 'edit',
        status: 'completed',
        paths: ['src/a.md'],
        input: { state: 'text', json: '{"path":"src/a.md"}' },
        output: { state: 'unreadable' },
      },
      runId: cancelled.runId,
    })
    expect(events[events.length - 1]).toMatchObject({
      kind: 'tool-update',
      runId: cancelled.runId,
      payload: { status: 'completed', output: { state: 'unreadable' } },
    })
  })

  it('fails a turn when the runtime dies, and remembers how it ended', async () => {
    const { agent, session } = await openAgent()
    const { events } = await collect(agent, session)
    agent.script({ hang: true })

    const turn = agent.prompt(session, 'a long one')
    // One turn at a time: a second one would interleave two runs into one stream.
    await expect(failureOf(agent.prompt(session, 'and another'))).resolves.toMatchObject({
      code: 'buffer-conflict',
    })

    agent.crash('the engine died')

    await expect(failureOf(turn)).resolves.toMatchObject({ code: 'process-exited' })
    expect(events[events.length - 1]).toMatchObject({
      kind: 'run-failed',
      payload: { code: 'process-exited', message: 'the engine died' },
    })
    // A crashed runtime cannot act, but its session's last state is still readable:
    // that state is what the UI has to render.
    await expect(agent.snapshot(session)).resolves.toMatchObject({ state: 'failed' })
    await expect(failureOf(agent.prompt(session, 'again'))).resolves.toMatchObject({
      code: 'process-exited',
    })
    // Opening a session needs an engine, so a dead one is not a place to open one.
    await expect(
      failureOf(agent.openSession({ vaultId: 'memoir://demo', cwd: '/vault' })),
    ).resolves.toMatchObject({ code: 'process-exited' })
  })

  it('stops a turn as cancelled when the runtime is taken down under it', async () => {
    const { agent, session } = await openAgent()
    const { events } = await collect(agent, session)
    agent.script({ hang: true })

    const turn = agent.prompt(session, 'a long one')
    await agent.stop()

    await expect(failureOf(turn)).resolves.toMatchObject({ code: 'cancelled' })
    expect(events[events.length - 1]).toMatchObject({
      kind: 'run-failed',
      payload: { code: 'cancelled' },
    })
    // Nothing addresses the old handles once the runtime is deliberately down.
    await expect(failureOf(agent.snapshot(session))).resolves.toMatchObject({
      code: 'runtime-unavailable',
    })
  })

  it('makes a handle of the previous runtime instance stale, and a start after a crash a new instance', async () => {
    const { agent, session } = await openAgent()
    const previous = session.runtimeEpoch

    agent.crash('the engine died')
    await agent.start()

    await expect(failureOf(agent.snapshot(session))).resolves.toMatchObject({
      code: 'session-stale',
    })
    const reopened = await agent.openSession({ vaultId: 'memoir://demo', cwd: '/vault' })
    expect(reopened.runtimeEpoch).not.toBe(previous)
  })

  it('replays both halves of a restored conversation, the user’s turn included', async () => {
    // The shape the pinned engine was measured sending, and the one this double therefore owes a
    // panel: a live turn carries no user chunk at all (the replay probe's first engine printed
    // zero), and the `session/load` that restores the conversation replays the user's turn —
    // verbatim, ahead of the run's own content, under the load's own run. A double that published
    // the prompt live would invent a frame no engine sends; one that left it out of the replay
    // would restore a conversation in which the agent talks to itself.
    const { agent, session } = await openAgent()
    const { events: live } = await collect(agent, session)
    await agent.prompt(session, 'summarise the note')

    expect(live.map((event) => event.kind)).toEqual(['text-delta', 'run-finished'])

    await agent.stop()
    await agent.start()
    const revived = await agent.loadSession(session.sessionId, {
      vaultId: 'memoir://demo',
      cwd: '/vault',
    })

    const tail = (await agent.snapshot(revived)).events
    expect(tail.map((event) => event.kind)).toEqual(['user-delta', 'text-delta'])
    expect(tail[0].payload).toEqual({ text: 'summarise the note' })
    // The load's run, and the run the window has to see on the user's frame: a turn-scoped frame
    // naming no turn is `unattributed-run` in the reducer, so a replayed user row stamped `null`
    // would be dropped by the very window this replay exists for.
    expect(tail[0].runId).toMatch(/^load-/)
    expect(tail[1].runId).toBe(tail[0].runId)
  })

  it('leaves a redundant start alone, so it cannot invalidate open sessions', async () => {
    const { agent, session } = await openAgent()
    await agent.start()
    await expect(agent.snapshot(session)).resolves.toMatchObject({
      identity: { runtimeEpoch: session.runtimeEpoch },
    })
  })

  it('delivers a frame from a runtime instance that is already over', async () => {
    const { agent, session } = await openAgent()
    const { events } = await collect(agent, session)
    const previous = session.runtimeEpoch

    agent.crash('the engine died')
    await agent.start()
    agent.emit(session, {
      kind: 'text-delta',
      payload: { text: 'from the last run' },
      identity: { runtimeEpoch: previous },
    })

    expect(events).toHaveLength(1)
    expect(events[0].runtimeEpoch).toBe(previous)
    const reopened = await agent.openSession({ vaultId: 'memoir://demo', cwd: '/vault' })
    expect(reopened.runtimeEpoch).not.toBe(events[0].runtimeEpoch)
  })

  it('delivers a repeated sequence and a vault the session does not belong to, for a reducer to reject', async () => {
    const { agent, session } = await openAgent()
    const { events } = await collect(agent, session)

    const duplicated: MemoryEvent = { kind: 'text-delta', payload: { text: 'one' }, sequence: 7 }
    agent.emit(session, duplicated)
    agent.emit(session, { ...duplicated, payload: { text: 'one again' } })
    agent.emit(session, {
      kind: 'text-delta',
      payload: { text: 'another vault' },
      identity: { vaultId: 'memoir://somewhere-else' },
    })

    expect(events.map((event) => event.sequence)).toEqual([7, 7, 8])
    expect(events[2].vaultId).toBe('memoir://somewhere-else')
    // The counter did not walk backwards over the duplicate: the next real event is
    // still after everything the session has emitted.
    expect((await agent.snapshot(session)).sequence).toBe(8)
  })

  it('closes the window between a snapshot and the subscription taken from it', async () => {
    const { agent, session } = await openAgent()
    const from = await agent.snapshot(session)

    // Exactly the race a re-mounting panel has: something happens after the snapshot
    // was read and before the subscription exists.
    agent.emit(session, { kind: 'text-delta', payload: { text: 'in between' } })

    const events: AgentEvent[] = []
    await agent.subscribe(from, (event) => events.push(event))
    await agent.prompt(session, 'live')

    expect(events.map((event) => event.kind)).toEqual([
      'text-delta',
      'text-delta',
      'run-finished',
    ])
    expect(events[0].payload).toEqual({ text: 'in between' })
    expect(from.sequence).toBe(0)
  })

  it('refuses a subscription the replay buffer can no longer reach back to', async () => {
    const { agent, session } = await openAgent({ replayLimit: 2 })
    const from = await agent.snapshot(session)
    for (const text of ['a', 'b', 'c']) {
      agent.emit(session, { kind: 'text-delta', payload: { text } })
    }

    await expect(failureOf(agent.subscribe(from, () => undefined))).resolves.toMatchObject({
      code: 'buffer-conflict',
    })
    // A fresh snapshot can be continued from, which is the recovery the failure asks
    // the caller to take.
    await expect(agent.subscribe(await agent.snapshot(session), () => undefined)).resolves.toBeTypeOf(
      'function',
    )
  })

  it('refuses a snapshot that claims a point the session never reached', async () => {
    const { agent, session } = await openAgent()
    const from = await agent.snapshot(session)
    await expect(
      failureOf(agent.subscribe({ ...from, sequence: 42 }, () => undefined)),
    ).resolves.toMatchObject({ code: 'invalid-response' })
  })

  it('refuses a snapshot whose identity is no longer the session’s', async () => {
    const { agent, session } = await openAgent()
    const from = await agent.snapshot(session)

    // A snapshot is a value — stored, persisted, read back later — so the identity it
    // was taken under is re-checked rather than trusted (§6.2 「权限响应、快照和持久化索引
    // 使用相同的复合身份边界」). The vault case is §11.1's 「换库后迟到事件」: a window that
    // switched vaults must not continue a stream from the one it left.
    const otherVault = { ...from, identity: { ...from.identity, vaultId: 'memoir://elsewhere' } }
    await expect(failureOf(agent.subscribe(otherVault, () => undefined))).resolves.toMatchObject({
      code: 'session-stale',
    })

    const otherRuntime = {
      ...from,
      identity: { ...from.identity, runtimeEpoch: 'epoch-of-an-earlier-runtime' },
    }
    await expect(failureOf(agent.subscribe(otherRuntime, () => undefined))).resolves.toMatchObject({
      code: 'session-stale',
    })

    // The untouched snapshot still works, so the refusal is about the identity and not
    // about the subscription being refused in general.
    await expect(agent.subscribe(from, () => undefined)).resolves.toBeTypeOf('function')
  })

  it('reports a handle this gateway never opened as stale, and emits nothing for it', async () => {
    const { agent, session } = await openAgent()
    // A caller can only get a handle from openSession, so an id this gateway never
    // minted is what a forged one (§11.1 「IPC 伪造会话 ID」) or a handle persisted from
    // an earlier run looks like.
    const forged = { sessionId: 'session-999' } as AgentSession

    await expect(failureOf(agent.snapshot(forged))).resolves.toMatchObject({ code: 'session-stale' })
    expect(() =>
      agent.emit(forged, { kind: 'text-delta', payload: { text: 'nowhere' } }),
    ).toThrow(AgentFailure)
    // The live session was not disturbed by any of it.
    await expect(agent.prompt(session, 'still works')).resolves.toMatchObject({
      stopReason: 'end-turn',
    })
  })

  it('refuses to emit a frame the contract does not allow', async () => {
    const { agent, session } = await openAgent()
    const { events } = await collect(agent, session)

    // A test author can hand the double anything at all; a subscriber must still only
    // ever see what a real adapter could have produced.
    const malformed = { kind: 'text-delta', payload: { text: 7 } } as unknown as MemoryEvent
    expect(() => agent.emit(session, malformed)).toThrow(AgentFailure)
    expect(events).toHaveLength(0)
  })

  it('keeps the sessions of one runtime apart', async () => {
    const { agent, session } = await openAgent()
    const other = await agent.openSession({ vaultId: 'memoir://other', cwd: '/other' })
    const { events } = await collect(agent, session)

    await agent.prompt(other, 'not for the first session')
    expect(events).toHaveLength(0)
  })

  it('suspends a turn on a permission request and resumes it with the answer', async () => {
    const { agent, session } = await openAgent()
    agent.script({ permission: { title: 'Write to the vault?', options: [...OPTIONS] } })

    const turn = agent.prompt(session, 'edit a note')
    const waiting = await agent.snapshot(session)
    expect(waiting.state).toBe('waiting-permission')
    expect(waiting.permissions).toHaveLength(1)
    const requestId = waiting.permissions[0].payload.requestId

    // An option id the engine never offered is refused — `forever` is not among
    // OPTIONS, where `always` deliberately is, because the engine does offer a
    // lasting grant and the answer path has to accept it.
    await expect(failureOf(agent.answerPermission(session, requestId, 'forever'))).resolves
      .toMatchObject({ code: 'invalid-response' })
    await agent.answerPermission(session, requestId, 'once')

    await expect(turn).resolves.toEqual({ stopReason: 'end-turn', usage: null })
    const answered = await agent.snapshot(session)
    expect(answered.state).toBe('completed')
    expect(answered.permissions).toHaveLength(0)
    await expect(failureOf(agent.answerPermission(session, requestId, 'once'))).resolves
      .toMatchObject({ code: 'invalid-response' })
  })

  it('carries the permission arguments in the state the engine left them', async () => {
    const { agent, session } = await openAgent()
    // The wire gives one nullable value for "no arguments" and "arguments that did
    // not parse" (acp-spec #1979), so the host keeps the two apart and §6.3's prompt
    // can say which one it is looking at.
    agent.script({
      permission: {
        title: 'Run the script?',
        options: [...OPTIONS],
        input: { state: 'unreadable' },
      },
    })

    const turn = agent.prompt(session, 'run it')
    const waiting = await agent.snapshot(session)
    expect(waiting.permissions[0].payload.input).toEqual({ state: 'unreadable' })

    await agent.cancel(session)
    await expect(turn).resolves.toMatchObject({ stopReason: 'cancelled' })
  })

  it('refuses an answer that another session is waiting for', async () => {
    const { agent, session } = await openAgent()
    const other = await agent.openSession({ vaultId: 'memoir://other', cwd: '/other' })
    agent.script({ permission: { title: 'Write to the vault?', options: [...OPTIONS] } })

    const turn = agent.prompt(session, 'edit a note')
    const requestId = (await agent.snapshot(session)).permissions[0].payload.requestId

    await expect(failureOf(agent.answerPermission(other, requestId, 'once'))).resolves
      .toMatchObject({ code: 'permission-denied' })
    await agent.answerPermission(session, requestId, 'once')
    await expect(turn).resolves.toMatchObject({ stopReason: 'end-turn' })
  })

  it('takes a cancelled turn’s unanswered request with it', async () => {
    const { agent, session } = await openAgent()
    agent.script({ permission: { title: 'Write to the vault?', options: [...OPTIONS] } })

    const turn = agent.prompt(session, 'edit a note')
    const requestId = (await agent.snapshot(session)).permissions[0].payload.requestId
    await agent.cancel(session)

    await expect(turn).resolves.toMatchObject({ stopReason: 'cancelled' })
    expect((await agent.snapshot(session)).permissions).toHaveLength(0)
    // The button is dead rather than ignored: a click after the settle must not look
    // like consent for anything.
    await expect(failureOf(agent.answerPermission(session, requestId, 'once'))).resolves
      .toMatchObject({ code: 'invalid-response' })
  })

  it('reports every call on a runtime that was never started', async () => {
    const agent = createMemoryAgentGateway({ agentId: 'memory', profileId: 'default' })
    await expect(failureOf(agent.openSession({ vaultId: 'v', cwd: '/v' }))).resolves.toMatchObject({
      code: 'runtime-unavailable',
    })
  })

  it('answers a capability row for every feature, unverified until a script says otherwise', async () => {
    // The default is the truthful one for a double: nothing here has talked to an engine, so
    // nothing may be `available` (§3.4's row: a capability nobody observed is not one to report as
    // present). What a test can move is the finding, one feature at a time.
    const { agent, session } = await openAgent()
    const reports = await agent.capabilities(session)

    // Spelled out rather than compared against `AGENT_CAPABILITY_FEATURES`, which is what the
    // double maps over: the literal is what catches a *rename* in the contract, and a test that
    // read the same constant it is checking would agree with itself about any name at all. The
    // order is the host's (`HostFeature::ALL`), and `tauri-agent.test.ts` reads that source to
    // hold the contract to it.
    expect(reports.map((report) => report.feature)).toEqual([
      'session-resume',
      'session-list',
      'session-resume-without-history',
      'session-close',
      'session-fork',
      'slash-commands',
      'model-selection',
      'image-attachments',
      'audio-attachments',
      'session-config-options',
      'embedded-context',
    ])
    for (const report of reports) {
      expect(report.declared).toBe('unverified')
      expect(report.finding.status).toBe('unverified')
    }
  })

  it('reports the findings a test declares, and refuses a handle from another runtime', async () => {
    const agent = createMemoryAgentGateway({
      agentId: 'memory',
      profileId: 'default',
      capabilities: {
        'slash-commands': { status: 'available' },
        'audio-attachments': { status: 'unavailable', detail: 'the engine reported no audio' },
      },
    })
    await agent.start()
    const session = await agent.openSession({ vaultId: 'memoir://demo', cwd: '/vault' })

    const reports = await agent.capabilities(session)
    expect(reports.find((report) => report.feature === 'slash-commands')?.finding).toEqual({
      status: 'available',
    })
    expect(reports.find((report) => report.feature === 'audio-attachments')?.finding).toEqual({
      status: 'unavailable',
      detail: 'the engine reported no audio',
    })
    // A handle check, not an engine call: the rows are state about a session, and a session of a
    // previous runtime is refused everywhere else for the same reason. A second runtime is a new
    // epoch, which is what makes the handle stale rather than merely unknown.
    await agent.stop()
    await agent.start()
    await expect(failureOf(agent.capabilities(session))).resolves.toMatchObject({
      code: 'session-stale',
    })
  })
})
