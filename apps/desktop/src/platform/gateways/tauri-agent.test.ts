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

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  AGENT_CAPABILITY_FEATURES,
  AGENT_CAPABILITY_HOST_OFFERS,
  AGENT_PROMPT_ATTACHMENT_KINDS,
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

/** The engine's option list as the runtime forwards it: `agent_runtime::events::normalize_update`
 *  maps the schema's flattened `type`/`currentValue` (and a select's possibly grouped choices)
 *  into this payload, which is the one `readConfigChanged` reads.
 *
 *  The *same* JSON is asserted on the other side
 *  (`tests/agent_runtime_test.rs`, `a_config_option_update_is_mapped_into_the_contracts_payload`),
 *  which is what makes these one shape rather than two readings of one fact — the failure this
 *  suite exists for. */
const CONFIG_CHANGED = {
  options: [
    {
      id: 'model',
      name: 'Model',
      description: 'Which model answers',
      value: {
        kind: 'select',
        current: 'fake/model-b',
        choices: [
          { value: 'fake/model-a', name: 'Model A' },
          { value: 'fake/model-b', name: 'Model B', description: 'the fast one' },
        ],
      },
    },
    { id: 'fast', name: 'Fast mode', value: { kind: 'toggle', current: true } },
  ],
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
      content: [],
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
      // The measured frame's own `content`, in the one arm this contract draws no shape for: it
      // is the wire's standard content block (`{type: 'content', content: {type: 'text', …}}`),
      // a sibling of `Diff`, and a read of a note is exactly the kind of call that carries one.
      // Folding it into `unrecognised` is the point — a call whose content this version cannot
      // draw is not a call that produced none — and it is also what keeps the block from being
      // refused: `readToolContent` treats an arm it has no shape for as a stated fact, so this
      // frame is still a frame the validator accepts.
      content: [{ type: 'unrecognised' }],
      input: { state: 'text', json: '{"filePath":"/vault/note.md"}' },
      output: { state: 'text', json: '{"output":"<path>…</path>"}' },
    })
  })

  it('carries a proposed edit’s diff block through, in the contract’s own two arms', () => {
    // The wire shape the block actually has: `ToolCallContent` is internally tagged with a
    // snake_case `type` (`agent-client-protocol-schema` 1.7.0, `src/v1/tool_call.rs:569-583`), and
    // the `Diff` arm carries the file's text before and after. This is the frame the whole
    // projection exists for — a call the user is asked to allow.
    const tools = new ToolProjection()
    const edit = mappedEvent(
      'tool-update',
      {
        update: {
          toolCallId: 'call_diff',
          title: 'Editing note.md',
          kind: 'edit',
          status: 'pending',
          locations: [{ path: '/vault/note.md' }],
          content: [
            { type: 'diff', path: '/vault/note.md', oldText: 'one\ntwo\n', newText: 'one\nthree\n' },
          ],
        },
      },
      tools,
    )
    expect((edit.payload as { content: unknown }).content).toEqual([
      { type: 'diff', path: '/vault/note.md', oldText: 'one\ntwo\n', newText: 'one\nthree\n' },
    ])

    // The schema's own gloss for an absent `oldText` is a new file, and the projection carries
    // the absence rather than inventing an empty baseline: `null` is "the engine stated none",
    // which is what the contract says and the only thing this layer can honestly report — the
    // field deserializes default-on-error, so an unreadable original arrives the same way.
    const created = mappedEvent(
      'tool-update',
      {
        update: {
          toolCallId: 'call_new',
          title: 'Writing new.md',
          kind: 'edit',
          status: 'pending',
          content: [{ type: 'diff', path: '/vault/new.md', newText: 'hello\n' }],
        },
      },
      tools,
    )
    expect((created.payload as { content: unknown }).content).toEqual([
      { type: 'diff', path: '/vault/new.md', oldText: null, newText: 'hello\n' },
    ])

    // And a later frame that says nothing about content keeps the diff the first one established
    // — the schema's rule for the collection ("overwritten, not extended", `tool_call.rs:262-265`)
    // read the way `locations` already is: absent means "not mentioned", present means "replace".
    const settled = mappedEvent(
      'tool-update',
      { update: { toolCallId: 'call_diff', status: 'completed' } },
      tools,
    )
    expect((settled.payload as { content: unknown }).content).toEqual([
      { type: 'diff', path: '/vault/note.md', oldText: 'one\ntwo\n', newText: 'one\nthree\n' },
    ])
  })

  it('names a block it cannot draw instead of dropping it or refusing the frame', () => {
    // Every arm of the wire's union that is not a diff — the standard content block, the terminal
    // reference, and any type a later schema adds — arrives as one arm, and the frame is still a
    // frame the validator accepts. A reader that refused them would turn one unknown block into a
    // dropped tool call, and one that dropped them would report a call as having produced less
    // than it did.
    const event = mappedEvent('tool-update', {
      update: {
        toolCallId: 'call_mixed',
        title: 'Editing note.md',
        kind: 'edit',
        status: 'completed',
        content: [
          { type: 'terminal', terminalId: 'term-1' },
          { type: 'diff', path: '/vault/note.md', oldText: '', newText: 'x\n' },
          { type: 'diff', path: '/vault/note.md', newText: 7 },
          { type: 'something_new' },
        ],
      },
    })
    expect((event.payload as { content: unknown }).content).toEqual([
      { type: 'unrecognised' },
      { type: 'diff', path: '/vault/note.md', oldText: '', newText: 'x\n' },
      { type: 'unrecognised' },
      { type: 'unrecognised' },
    ])
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

  it('accepts an ending whose reason this version has never heard of, rather than failing the turn', () => {
    // The protocol's `StopReason` is `#[non_exhaustive]` and the engine's surface is not fixed
    // (P0 §6.3 measured the usage field set moving between two identical turns), so a reason this
    // version does not know is a frame to read rather than one to refuse. Refusing it is the
    // expensive direction: this frame is a *completed turn's* ending, `mapHostFrame` turns an
    // unreadable payload into `run-failed` on the run it names, and the user is then told that a
    // turn the engine finished failed. So the reading degrades instead — the ending arrives as
    // `unrecognised`, carrying the engine's own word, which is neither a success nor a failure.
    const event = mappedEvent('run-finished', { stopReason: 'budget_exceeded', usage: null })

    expect(event.kind).toBe('run-finished')
    expect(event.payload).toEqual({
      stopReason: 'unrecognised',
      // The word the frame reached the contract under: `mapRunResult` respells the engine's `_`
      // before the validator sees the value (the same mechanical transform that turns `end_turn`
      // into `end-turn`), so what is kept is the reason's own wording and not an invented one.
      unrecognisedReason: 'budget-exceeded',
      usage: null,
    })
  })

  it('still refuses an ending that states no reason at all', () => {
    // The line the tolerance above must not cross, and the reason it is drawn at the *type* of
    // the value rather than at membership of a list: a reason that is missing, empty or not a
    // string is a producer that did not answer the question, not a word this version has yet to
    // learn. Reading it as an ending would invent one, and a frame whose damaged part could be
    // restored here is exactly what `invalid-response` is for.
    for (const stopReason of [undefined, null, '', 7, ['end-turn'], { reason: 'end-turn' }]) {
      const refused = eventOf(
        mapHostFrame(frame('run-finished', { stopReason, usage: null }), new ToolProjection()),
      )
      expect(refused.kind, `stopReason: ${JSON.stringify(stopReason)}`).toBe('run-failed')
      expect((refused.payload as { code: string }).code).toBe('invalid-response')
    }
  })

  it('carries every counter the engine reported, the optional ones included', () => {
    // P0 §2.3's measured turn: `thoughtTokens` is there and `cachedReadTokens` is not, which is
    // half of §6.3's point. A host that keeps only three numbers loses counters the engine did
    // send, and the contract carries them per field for exactly that reason.
    const event = mappedEvent('run-finished', RUN_FINISHED)
    expect(event.payload).toEqual({
      stopReason: 'end-turn',
      usage: { inputTokens: 11, outputTokens: 2, totalTokens: 13, thoughtTokens: 1 },
    })
  })

  it('keeps the numbers a partial usage did send and leaves the missing field out', () => {
    // §6.3's warning as a case: `totalTokens` is simply absent, and neither of the two numbers
    // that did arrive may become a default, a sum, or a zero. An absent field is "not provided",
    // which is a different thing from a reported `0` — see the test below.
    const event = mappedEvent('run-finished', {
      stopReason: 'end_turn',
      usage: { inputTokens: 1721, outputTokens: 6 },
    })
    expect(event.payload).toEqual({
      stopReason: 'end-turn',
      usage: { inputTokens: 1721, outputTokens: 6 },
    })
  })

  it('passes the second measured field set through unchanged, `cachedReadTokens` and all', () => {
    // The same engine, model and script as the turn above, one turn later: `thoughtTokens` is
    // gone, `cachedReadTokens` has appeared, and `totalTokens` (8895) is not the sum of the two
    // it sits beside (1721 + 6 = 1727). A host that computed the total would show 1727 as fact.
    const event = mappedEvent('run-finished', {
      stopReason: 'end_turn',
      usage: { inputTokens: 1721, outputTokens: 6, totalTokens: 8895, cachedReadTokens: 7168 },
    })
    expect((event.payload as { usage: unknown }).usage).toEqual({
      inputTokens: 1721,
      outputTokens: 6,
      totalTokens: 8895,
      cachedReadTokens: 7168,
    })
  })

  it('keeps a reported zero apart from a field nobody reported', () => {
    // Why the fields are optional rather than defaulted: `0` is a fact the engine stated and an
    // absent field is not, and §5.1 forbids one rendering as the other.
    const event = mappedEvent('run-finished', {
      stopReason: 'end_turn',
      usage: { inputTokens: 0, outputTokens: 3 },
    })
    expect((event.payload as { usage: Record<string, unknown> }).usage).toEqual({
      inputTokens: 0,
      outputTokens: 3,
    })
    expect('totalTokens' in (event.payload as { usage: object }).usage).toBe(false)
  })

  it('drops a counter that is not a count rather than failing the turn that finished', () => {
    // A count this window cannot read is one it cannot show. Refusing the whole frame would turn
    // a completed turn into a failed one over a decorative number — `run-finished` names a run,
    // so an unreadable payload becomes `run-failed` on the turn that just succeeded.
    const event = mappedEvent('run-finished', {
      stopReason: 'end_turn',
      usage: { inputTokens: 'many', outputTokens: -1, totalTokens: 13 },
    })
    expect((event.payload as { usage: unknown }).usage).toEqual({ totalTokens: 13 })
  })

  it('answers null — not a number — when the engine reported no usage at all', () => {
    for (const payload of [
      { stopReason: 'end_turn' },
      { stopReason: 'end_turn', usage: null },
      { stopReason: 'end_turn', usage: {} },
    ]) {
      const event = mappedEvent('run-finished', payload)
      expect((event.payload as { usage: unknown }).usage).toBeNull()
    }
    // A `usage` that is not an object is the one container this refuses: reading it as "no
    // usage" would be the silent repair, and the run's ending is where that would hurt most.
    // The frame names a run, so the refusal arrives as that run's ending (`mapHostFrame`).
    const refused = eventOf(
      mapHostFrame(frame('run-finished', { stopReason: 'end_turn', usage: 'lots' }), new ToolProjection()),
    )
    expect(refused.kind).toBe('run-failed')
    expect((refused.payload as { code: string }).code).toBe('invalid-response')
  })

  it('passes through the kinds the runtime already speaks in the contract’s shape', () => {
    const text = mappedEvent('text-delta', { text: 'PONG' })
    expect(text.payload).toEqual({ text: 'PONG' })
    // The runtime's copy of the *user's* half, which `session/load` replays and whose producer
    // `normalize_update` now is. Nothing in this adapter translates it — its payload reader is
    // the contract's own `readText` — and what the host stamps it with is the load's run rather
    // than null, because the reducer refuses a turn-scoped kind that names no turn. Pinned here
    // with the other unmapped kinds, which are exactly where a silent drift between the two
    // gateways would show.
    const mine = mappedEvent('user-delta', { text: 'Reply with exactly: PONG' })
    expect(mine.payload).toEqual({ text: 'Reply with exactly: PONG' })
    expect(mine.runId).toBe('run-0')
    const commands = mappedEvent('commands-changed', { commands: [{ name: 'init', description: 'Start' }] })
    expect((commands.payload as { commands: unknown[] }).commands).toHaveLength(1)
    const failed = mappedEvent('run-failed', { code: 'certificate-untrusted', message: 'no CA' })
    expect((failed.payload as { code: string }).code).toBe('certificate-untrusted')
  })

  it('reads the engine’s own option list, which the runtime now forwards', () => {
    // `config-changed` is the kind the panel's config state is built from, and until the runtime
    // produced one the reader below had never been fed a frame by anything but a test. `runId` is
    // null because a config change is a fact about the *session*: the host stamps it that way and
    // the reducer refuses a turn-scoped kind with no turn, so the two must agree here.
    const event = eventOf(
      mapHostFrame(frame('config-changed', CONFIG_CHANGED, { runId: null }), new ToolProjection()),
    )
    expect(event.kind).toBe('config-changed')
    expect(event.runId).toBeNull()
    expect(event.payload).toEqual(CONFIG_CHANGED)

    // And the shape the engine itself sends is *not* this one — which is why the runtime maps
    // it. Passed through, the schema's flattened `type`/`currentValue` is refused here rather
    // than drawn as an option with no choices and no current value.
    const wire = failureOf(
      mapHostFrame(
        frame(
          'config-changed',
          { options: [{ id: 'model', name: 'Model', type: 'select', currentValue: 'fake/model-b' }] },
          { runId: null },
        ),
        new ToolProjection(),
      ),
    )
    expect(wire.code).toBe('invalid-response')
  })

  it('reports a frame it cannot read as a failure of the run, never as silence', () => {
    // The failure this adapter exists to prevent. The envelope is good, the payload is not,
    // and the frame belongs to a run: the run's ending arrives as an event, so a frame
    // dropped quietly would leave `prompt` waiting forever with nothing on screen.
    //
    // The example is a payload that states no ending at all rather than one with an unfamiliar
    // reason: a reason this version does not know is read as its own arm now (the test above),
    // and what stays refused is what cannot be read *as* an ending — the line the two tests
    // together draw.
    const event = eventOf(mapHostFrame(frame('run-finished', { stopReason: '', usage: null }), new ToolProjection()))
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
    await ipc.prompt('ses_fake_1', 'hello', [])
    await ipc.snapshot('ses_fake_1')
    expect(invokeMock.mock.calls.map((call) => call[0])).toEqual([
      'agent_start',
      'agent_stop',
      'agent_open_session',
      'agent_set_config_option',
      'agent_prompt',
      'agent_session_snapshot',
    ])
    // `null` rather than an absent key, and that is the Rust command's own signature: its
    // `attachments` parameter is `Option<Vec<PromptAttachment>>`, so a turn with nothing attached
    // is stated rather than left out — and the assertion has to say which of the two it is, or it
    // would pass on both.
    expect(invokeMock).toHaveBeenCalledWith('agent_prompt', {
      sessionId: 'ses_fake_1',
      text: 'hello',
      attachments: null,
    })
  })

  it('carries an attachment to the command as the window described it', async () => {
    invokeMock.mockResolvedValue('run-0')
    const ipc = createTauriAgentIpc()
    await ipc.prompt('ses_fake_1', 'look', [
      { kind: 'image', name: 'shot.png', mediaType: 'image/png', data: 'QUJD' },
    ])
    expect(invokeMock).toHaveBeenCalledWith('agent_prompt', {
      sessionId: 'ses_fake_1',
      text: 'look',
      attachments: [{ kind: 'image', name: 'shot.png', mediaType: 'image/png', data: 'QUJD' }],
    })
  })

  it('spells the attachment the way the Rust enum does', () => {
    // The Rust half is a serde internally-tagged enum: `#[serde(tag = "kind", rename_all =
    // "camelCase")]` over variants `Resource`/`Image` carrying `path`/`text`/`mediaType` and
    // `name`/`mediaType`/`data`. Read off the source rather than restated, because a field that
    // drifted would deserialize to a default and the block would reach the engine empty.
    const rust = readFileSync(
      resolve(__dirname, '../../../src-tauri/src/agent_runtime/attachments.rs'),
      'utf8',
    )
    const enumStart = rust.indexOf('pub enum PromptAttachment {')
    expect(enumStart, 'PromptAttachment is not declared in attachments.rs').toBeGreaterThan(-1)
    const body = rust.slice(enumStart, rust.indexOf('\n}', enumStart))
    expect(rust.slice(0, enumStart)).toContain('#[serde(tag = "kind", rename_all = "camelCase")]')
    expect(body).toContain('Resource {')
    expect(body).toContain('Image {')
    for (const field of ['path: String', 'text: String', 'name: String', 'data: String']) {
      expect(body, `the Rust enum has no field ${field}`).toContain(field)
    }
    // The two `media_type` fields, each renamed to the wire's spelling — one per arm.
    expect(body.match(/#\[serde\(rename = "mediaType"\)\]/g)).toHaveLength(2)
    expect(AGENT_PROMPT_ATTACHMENT_KINDS).toEqual(['resource', 'image'])
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

/**
 * The rejected-call half of the same boundary, in a describe of its own.
 *
 * **Why it does not share the describe above.** That one resets `invoke` in a `beforeEach`, and a
 * mock whose *result* is a rejection does not survive it in this vitest version: the raw rejection
 * is then reported as an unhandled error — which this project's config turns into a red run
 * (`vitest.unhandled-reporter.ts` states the ruling) — even though the assertion that awaited it
 * passed. Nothing here calls `mockReset` or `mockClear` for that reason, and every test sets the
 * implementation it needs before it calls. The failure that constraint costs is a test that cannot
 * see leftover implementations; the one it buys is a test that can see a rejection at all.
 */
describe('a call the host refused', () => {
  it('turns a rejected call into the contract’s failure, code and all', async () => {
    // The Rust commands reject with `commands::agent::AgentFailure` — `{code, message}`, the same
    // pair a `run-failed` frame carries — and this is the one place that knows the wire, so it is
    // the one place that can turn it into the contract's own `AgentFailure`. Before this existed
    // the rejection was the *sentence alone*: `SessionError::failure_code` was computed, tested and
    // reached by nothing, and a caller here had to match on wording to learn the condition.
    invokeMock.mockRejectedValue({
      code: 'load-in-flight',
      message: 'session ses_fake_1 is still being reopened; wait for it to finish',
    })
    const ipc = createTauriAgentIpc()
    const rejection = await ipc.loadSession('vault-1', '/vault', 'ses_fake_1').catch((e: unknown) => e)
    expect(rejection).toBeInstanceOf(AgentFailure)
    expect((rejection as AgentFailure).code).toBe('load-in-flight')
    expect((rejection as AgentFailure).message).toBe(
      'session ses_fake_1 is still being reopened; wait for it to finish',
    )
  })

  it('never invents a code for a rejection it cannot read, and never drops the sentence', async () => {
    // Two arms, and both have to stay honest. A rejection that is still a bare string is what two
    // commands answer today — the permission-grant pair, whose failures are the engine's HTTP
    // surface rather than the ACP pipe this vocabulary classifies — and Tauri's own "command not
    // found" is a string too. What a caller must not receive is a *code*, because a code is a
    // claim about a condition nobody stated: `invalid-response` is this list's word for "the answer
    // could not be read", which is exactly what happened.
    invokeMock.mockRejectedValue('the runtime is not started')
    const ipc = createTauriAgentIpc()
    const rejection = await ipc.stop().catch((e: unknown) => e)
    expect(rejection).toBeInstanceOf(AgentFailure)
    expect((rejection as AgentFailure).code).toBe('invalid-response')
    expect((rejection as AgentFailure).message).toBe('the runtime is not started')

    // And a code this window does not know is not one it passes through: a newer backend's
    // vocabulary arriving here would otherwise reach a feature whose switch has no arm for it.
    invokeMock.mockRejectedValue({ code: 'a-code-from-the-future', message: 'something new' })
    const unknown = await ipc.stop().catch((e: unknown) => e)
    expect((unknown as AgentFailure).code).toBe('invalid-response')
    expect((unknown as AgentFailure).message).toBe('something new')
  })

})

// ---------------------------------------------------------------------------
// The gateway: a fake IPC in place of the window's
// ---------------------------------------------------------------------------

/**
 * What `agent_session_capabilities` answers, in the shape `commands/agent_capabilities.rs` returns:
 * `CapabilityReport` with `#[serde(rename_all = "camelCase")]` on the struct and a `status`-tagged
 * finding. One row per feature, which is what the host's own `HostFeature::ALL` drives.
 */
function capabilityAnswer(
  finding: (feature: string) => unknown = (feature) =>
    feature === 'image-attachments'
      ? { status: 'available' }
      : { status: 'unverified', detail: `${feature} has not been negotiated` },
): unknown[] {
  return AGENT_CAPABILITY_FEATURES.map((feature) => ({
    feature,
    declared: 'unverified',
    finding: finding(feature),
    // The host's third subject, from the contract's table — which is itself held to the Rust source
    // by the `host_offer` case below, so a fixture that read it here cannot drift from the host.
    host: AGENT_CAPABILITY_HOST_OFFERS[feature],
  }))
}

interface FakeIpc extends AgentIpc {
  /** Push a frame at the gateway as the host would. */
  push(frame: unknown): void
  /** How many listeners are currently registered. */
  readonly listeners: number
  /** How many of those have been removed by their own unsubscribe. */
  readonly unlistened: number
  calls: string[]
}

/**
 * The name the fake host's `session/list` gives its one session.
 *
 * Named rather than inlined because two tests are about the same string travelling: the list
 * answers it, and a reopen of that session has to reach the panel carrying it (the load response
 * itself has no title field — see `AgentSession.title`).
 */
const LISTED_TITLE = 'New session - 2026-01-01T00:00:01Z'

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
    // The three session-management calls. Defaults that *work* rather than throw, because the
    // fake has to stand for a host that answers: a default that refused would make every test
    // that merely touches the gateway report a broken host. What each one answers is the smallest
    // thing the reader accepts — one listed session, one loaded session, a close that returns —
    // and a test that wants a refusal uses `overrides`, which is why the port takes a `Partial`.
    async listSessions() {
      calls.push('listSessions')
      return {
        sessions: [
          {
            sessionId: 'ses_fake_1',
            cwd: '/vault',
            title: LISTED_TITLE,
            updatedAt: '2026-01-01T00:00:01Z',
            // The host's half of the row, and the one field the engine cannot answer: this host
            // holds the session, so a free action on this row is one it will carry out. Required
            // by the reader — a row without it is a host this window does not understand.
            held: true,
          },
        ],
        nextCursor: null,
      }
    },
    async loadSession() {
      calls.push('loadSession')
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
    async closeSession() {
      calls.push('closeSession')
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
    // The host's default answer here is a refusal, unlike the session-management calls above, and
    // it is the one every real host gives for a file it did not write: the double and the pinned
    // engine's own-tool writes both land on `no-baseline`. A test that wants a recovery uses
    // `overrides` — what matters for the default is that the *reader* is exercised.
    async recoverChange(_sessionId: string, path: string) {
      calls.push('recoverChange')
      return { kind: 'refused', path, code: 'no-baseline' }
    },
    async answerPermission() {
      calls.push('answerPermission')
    },
    async snapshot(): Promise<AgentHostSnapshot> {
      calls.push('snapshot')
      return { identity: IDENTITY, state: 'ready', runId: null, sequence: 0, events: [], permissions: [] }
    },
    async capabilities() {
      calls.push('capabilities')
      return capabilityAnswer()
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

  it('answers a config set with the engine’s refreshed list, read out of the schema shape', async () => {
    // `agent_set_config_option` returns `serde_json::Value` holding the full option set with its
    // current values, in the same schema shape `agent_open_session` answers — and it used to be
    // dropped on the floor (`Promise<void>` on the port), so a caller that shows the option had
    // nothing to show unless the engine *also* announced the change as `config-changed`. The
    // pinned engine does; an engine that answered without notifying would have left the row
    // showing the value the reader had just left.
    const ipc = fakeIpc({
      selectModel: async () => [
        {
          id: 'model',
          name: 'Model',
          type: 'select',
          currentValue: 'fake/model-b',
          options: [
            { value: 'fake/model-a', name: 'Model A' },
            { value: 'fake/model-b', name: 'Model B' },
          ],
        },
      ],
    })
    const gateway = createTauriAgentGateway({ vaultId: 'vault-1', ipc })
    const session = await openSessionOn(gateway)

    expect(await gateway.setConfigOption(session, 'model', 'fake/model-b')).toEqual([
      {
        id: 'model',
        name: 'Model',
        value: {
          kind: 'select',
          current: 'fake/model-b',
          choices: [
            { value: 'fake/model-a', name: 'Model A' },
            { value: 'fake/model-b', name: 'Model B' },
          ],
        },
      },
    ])
  })

  it('answers null rather than an empty list when the set’s answer cannot be read', async () => {
    // The two arms are two different statements. An answer this window cannot read must leave the
    // caller's list alone: `[]` would be read as the engine withdrawing every option, which is a
    // change it never stated — and it would clear the row on a bad answer rather than on a fact.
    const ipc = fakeIpc({ selectModel: async () => ({ not: 'a list' }) })
    const gateway = createTauriAgentGateway({ vaultId: 'vault-1', ipc })
    const session = await openSessionOn(gateway)

    expect(await gateway.setConfigOption(session, 'model', 'fake/model-b')).toBeNull()
  })

  it('carries the name the engine gave a session onto the handle a reopen answers with', async () => {
    // A reopened session is one the engine has already named, and the only answer this window is
    // ever given that name in is `session/list` — the load response carries no title, and the
    // frame that would state one (`SessionInfoUpdate`) is not mapped on the host side. So the row
    // the reader picked from is the one place the string exists, and it is this adapter that read
    // it: the pick arrives here as a `loadSession` for the same id.
    const gateway = createTauriAgentGateway({ vaultId: 'vault-1', ipc: fakeIpc() })
    // The list needs a live runtime: `agent_list_sessions` reaches the engine through the session
    // slot, so a gateway that was never started refuses the call itself and no list is read.
    await gateway.start()

    const listed = await gateway.listSessions()
    expect(listed.sessions[0]?.title).toBe(LISTED_TITLE)
    expect(listed.sessions[0]?.held).toBe(true)

    const reopened = await gateway.loadSession('ses_fake_1', { vaultId: 'vault-1', cwd: '/vault' })
    expect(reopened.title).toBe(LISTED_TITLE)
  })

  it('leaves a session it was never told a name for without one, rather than inventing a name', async () => {
    // A new session has no name in any answer yet, and a reopen the window never listed has none
    // either. Both are `null`, which is the bar's own sentence ('New {engine} session') — a name
    // this app wrote would be a fact the engine never stated.
    const gateway = createTauriAgentGateway({ vaultId: 'vault-1', ipc: fakeIpc() })

    const opened = await openSessionOn(gateway)
    expect(opened.title).toBeNull()
    const reopened = await gateway.loadSession('ses_fake_1', { vaultId: 'vault-1', cwd: '/vault' })
    expect(reopened.title).toBeNull()
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
      usage: { inputTokens: 11, outputTokens: 2, totalTokens: 13, thoughtTokens: 1 },
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
    // The refusal is the point of the test and it is unchanged — §6.2 allows one generation per
    // session, and this is the boundary that holds it. Only the code moved: `turn-in-flight`
    // names the condition, where `buffer-conflict` named a stream that cannot be continued
    // (`channel.ts`) or a view larger than the host will hold (`agent-event-reducer.ts`). How the
    // latch is *released* is what `tauri-agent/turn-liveness.test.ts` covers.
    const gateway = createTauriAgentGateway({ vaultId: 'vault-1', ipc: fakeIpc() })
    const session = await openSessionOn(gateway)
    const first = gateway.prompt(session, 'one')
    await expect(gateway.prompt(session, 'two')).rejects.toMatchObject({ code: 'turn-in-flight' })
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

// ---------------------------------------------------------------------------
// The capability report
// ---------------------------------------------------------------------------

describe('the capability report', () => {
  it('asks the host for the session’s report and hands every row on, declared beside finding', async () => {
    const ipc = fakeIpc()
    const gateway = createTauriAgentGateway({ vaultId: 'vault-1', ipc })
    const session = await openSessionOn(gateway)

    const reports = await gateway.capabilities(session)

    expect(ipc.calls).toContain('capabilities')
    expect(reports.map((report) => report.feature)).toEqual([...AGENT_CAPABILITY_FEATURES])
    expect(reports.find((report) => report.feature === 'image-attachments')).toEqual({
      feature: 'image-attachments',
      declared: 'unverified',
      finding: { status: 'available' },
      host: { status: 'control' },
    })
    // The three halves stay three fields: a report that merged the finding with the host's own half
    // could not show the case the third one exists for — an engine that advertises something
    // nothing in this build can ask it for.
    expect(reports.find((report) => report.feature === 'slash-commands')).toEqual({
      feature: 'slash-commands',
      declared: 'unverified',
      finding: { status: 'unverified', detail: 'slash-commands has not been negotiated' },
      host: { status: 'control' },
    })
  })

  it('refuses a report it cannot read, rather than showing a shorter one', async () => {
    // Every arm below is a way the host could answer something this contract does not describe, and
    // each one would reach a page as a *fact* if it were repaired on the way through: a row with no
    // reason, a feature the window cannot render, and a report that simply left one out.
    const unreadable: unknown[] = [
      capabilityAnswer(() => ({ status: 'unavailable' })),
      [{ feature: 'telepathy', declared: 'advertised', finding: { status: 'available' } }],
      capabilityAnswer().slice(1),
    ]
    for (const answer of unreadable) {
      const ipc = fakeIpc({ capabilities: async () => answer })
      const gateway = createTauriAgentGateway({ vaultId: 'vault-1', ipc })
      const session = await openSessionOn(gateway)
      await expect(gateway.capabilities(session)).rejects.toMatchObject({
        code: 'invalid-response',
      })
    }
  })

  it('refuses a report about a session this gateway did not open', async () => {
    // The same boundary every session-scoped call passes: rows are state about a session, and a
    // handle the book does not know is not one to answer about.
    const ipc = fakeIpc()
    const gateway = createTauriAgentGateway({ vaultId: 'vault-1', ipc })
    const session = await openSessionOn(gateway)
    // A second runtime instance: the handles of the first are stale rather than merely unknown
    // (§6.2), and the report is refused before any call leaves the window.
    await gateway.stop()
    await gateway.start()

    await expect(gateway.capabilities(session)).rejects.toMatchObject({ code: 'session-stale' })
    expect(ipc.calls).not.toContain('capabilities')
  })

  it('names the features the host names, read off both sides', () => {
    // The list is data: a page renders `feature` as it arrived rather than translating it, so a
    // rename on either side is a page showing a name nothing produces. The Rust half is the
    // authority (`HostFeature::ALL`) and this test reads its source, because a TypeScript test
    // cannot import a Rust enum — the same guard `tauri-pet.test.ts` keeps over the care ledger.
    const rust = readFileSync(
      resolve(__dirname, '../../../src-tauri/src/agent_runtime/adapters/mod.rs'),
      'utf8',
    )
    const start = rust.indexOf('pub const ALL: [HostFeature;')
    expect(start, 'HostFeature::ALL is not declared in adapters/mod.rs').toBeGreaterThan(-1)
    const list = rust.slice(start, rust.indexOf('];', start))
    const variants = [...list.matchAll(/HostFeature::(\w+)/g)].map(([, variant]) => variant)
    expect(variants.length, 'HostFeature::ALL lists no features').toBeGreaterThan(0)

    // The spellings, from `as_str`, which is where the host decides what it calls them.
    const asStr = rust.slice(rust.indexOf('pub fn as_str(&self)'))
    const spelling = new Map(
      [...asStr.matchAll(/HostFeature::(\w+) => "([a-z-]+)"/g)].map(([, variant, name]) => [
        variant,
        name,
      ]),
    )
    expect(
      variants.map((variant) => spelling.get(variant)),
      'the contract’s feature list no longer matches the host’s',
    ).toEqual([...AGENT_CAPABILITY_FEATURES])
  })

  it('offers what the host offers, read off both sides', () => {
    // `AGENT_CAPABILITY_HOST_OFFERS` is a copy of `host_offer` in `agent_runtime/capabilities.rs`,
    // and this is what keeps it one: the host decides what this app offers, the window only renders
    // it, and the arm that matters — `nothing` — is the one a stale copy would quietly get wrong,
    // telling a reader that a feature the engine advertises is reachable here.
    //
    // The variant-to-feature spelling comes from `adapters/mod.rs`, the same authority the case
    // above reads, because `capabilities.rs` matches on the Rust enum rather than on the wire name.
    const directory = resolve(__dirname, '../../../src-tauri/src/agent_runtime')
    const adapters = readFileSync(resolve(directory, 'adapters/mod.rs'), 'utf8')
    const asStr = adapters.slice(adapters.indexOf('pub fn as_str(&self)'))
    const spelling = new Map(
      [...asStr.matchAll(/HostFeature::(\w+) => "([a-z-]+)"/g)].map(([, variant, name]) => [
        variant,
        name,
      ]),
    )

    const source = readFileSync(resolve(directory, 'capabilities.rs'), 'utf8')
    const start = source.indexOf('fn host_offer(')
    expect(start, 'host_offer is not declared in capabilities.rs').toBeGreaterThan(-1)
    const body = source.slice(start, source.indexOf('\n}', start))
    // One arm per line group: `HostFeature::A | HostFeature::B => HostOffer::Control,`, and the
    // `Command` arm carries its name in a braced field on the lines after the arrow.
    const arms = [
      ...body.matchAll(
        /((?:HostFeature::\w+\s*(?:\|\s*)?)+)=>\s*HostOffer::(\w+)\s*,?\s*(?:\{\s*command:\s*"([^"]+)",?\s*\})?/g,
      ),
    ]
    expect(arms.length, 'host_offer matched no arms').toBeGreaterThan(0)
    const offered = new Map<string, unknown>()
    for (const [, variants, arm, command] of arms) {
      for (const [, variant] of variants!.matchAll(/HostFeature::(\w+)/g)) {
        const feature = spelling.get(variant!)
        expect(feature, `${variant} has no wire spelling`).toBeDefined()
        expect(offered.has(feature!), `${feature} is matched twice`).toBe(false)
        offered.set(
          feature!,
          arm === 'Command'
            ? { status: 'command', command }
            : { status: arm === 'Control' ? 'control' : 'nothing' },
        )
      }
    }
    // Every feature, or the parse quietly matched fewer arms than the function has and the
    // equality below would be comparing a short table against a full one.
    expect([...offered.keys()].sort()).toEqual([...AGENT_CAPABILITY_FEATURES].sort())

    expect(Object.fromEntries(offered)).toEqual({ ...AGENT_CAPABILITY_HOST_OFFERS })
  })
})
