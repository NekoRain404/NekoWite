import { describe, expect, it } from 'vitest'
import {
  AGENT_FAILURE_CODES,
  AgentFailure,
  readAgentEvent,
  type AgentEvent,
  type AgentEventKind,
  type AgentPermissionKind,
} from './agent-contracts'

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
        content: [],
        input: { state: 'text', json: '{"path":"src/main.rs"}' },
        output: { state: 'absent' },
      },
      'permission-request': {
        requestId: 'req-1',
        toolCallId: 'call-1',
        title: 'Write to the vault?',
        input: { state: 'unreadable' },
        content: [{ type: 'diff', path: 'notes/a.md', oldText: null, newText: 'written\n' }],
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
          content: [],
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
