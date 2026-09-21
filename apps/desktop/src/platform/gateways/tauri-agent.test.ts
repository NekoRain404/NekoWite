/**
 * The mapping from the frames the Rust runtime actually produces to the contract.
 *
 * This half is the reason the file existed. T3 read both sides and found that the Rust runtime and
 * the TypeScript contract disagree about the shape of three things — a wrapped `tool-update`, a
 * snake_case `stopReason`, and a usage object whose field set the engine varies between turns —
 * with *both* suites green, because each side was tested against its own reading. The failure mode
 * of that is silence: a frame fails validation, the panel renders nothing, and no error says why.
 * So every frame in the mapping suite below is the measured shape — P0 §2.3 and §6.1's captures,
 * and the fixture's `stopReason` and usage object verbatim — passed through the adapter and
 * asserted as a *contract* event.
 *
 * The rest of what used to be this one file is split by behaviour domain beside it:
 * `tauri-agent-ipc.test.ts` (the window's own IPC and the calls the host refused),
 * `tauri-agent-gateway.test.ts` (the session handle, the model catalogue and the turn latch),
 * `tauri-agent-subscription.test.ts` (the snapshot-then-subscribe handshake, and permissions),
 * `tauri-agent-session-state.test.ts` (the host's state at the boundary) and
 * `tauri-agent-capabilities.test.ts` (the capability report, with the two cross-language pins).
 * What more than one of them feeds through the adapter lives in `tauri-agent-frames.ts`.
 */

import { describe, expect, it, vi } from 'vitest'

const invokeMock = vi.hoisted(() => vi.fn())
const listenMock = vi.hoisted(() => vi.fn())
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }))
vi.mock('@tauri-apps/api/event', () => ({ listen: listenMock }))

import { AgentFailure, readAgentEvent, type AgentEvent } from './agent-contracts'
import { mapHostFrame, ToolProjection } from './tauri-agent'
import { RUN_FINISHED, frame } from './tauri-agent-frames'

// ---------------------------------------------------------------------------
// The measured frames this suite alone reads
// ---------------------------------------------------------------------------

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
