/**
 * The payloads: what each kind of event does to the view, and the two bounds a run is kept under.
 *
 * The kind table is a `Record` over `AgentEventKind` rather than a list of cases, so a kind the
 * contract adds is a missing entry here — a compile error, not a kind nothing asserts anything
 * about. What each entry asserts is *where* the event's fact landed: the text in the last row that
 * carries any, the tool call, the permission, the title, the cost.
 *
 * The bounds are the second half: consecutive chunks coalesce into the row they continue, and a row
 * past the timeline limit aborts the run rather than trims a transcript the reader is reading.
 *
 * Every frame is hand-built: a bound is crossed by a frame this window can count, not by one a
 * gateway has to be arranged to produce.
 */

import { describe, expect, it } from 'vitest'
import {
  type AgentEvent,
  type AgentEventKind,
  type AgentIdentity,
  type AgentPayloads,
} from '../../../platform/gateways/agent-contracts'
import { AGENT_TEXT_LIMIT, reduceAgentEvent, type AgentDropReason } from './agent-event-reducer'
import {
  initialAgentSessionView,
  startAgentRun,
  type AgentSessionView,
} from './agent-session-view'

const IDENTITY: AgentIdentity = {
  agentId: 'agent-1',
  profileId: 'profile-1',
  runtimeEpoch: 'epoch-1',
  vaultId: 'vault-1',
  sessionId: 'session-1',
}

function fresh(options: { timelineLimit?: number } = {}): AgentSessionView {
  return initialAgentSessionView(IDENTITY, options)
}

/** One frame, as an adapter would deliver it. The assertion is the correlation between
 *  `kind` and `payload` that the generic parameter cannot carry through the spread. */
function frame<K extends AgentEventKind>(
  kind: K,
  payload: AgentPayloads[K],
  options: { sequence: number; runId?: string | null; identity?: Partial<AgentIdentity> },
): AgentEvent {
  return {
    ...IDENTITY,
    ...options.identity,
    runId: options.runId ?? null,
    sequence: options.sequence,
    kind,
    payload,
  } as AgentEvent
}

/** A view with a run started and not yet named: what the store has between `prompt` and
 *  the run's first frame. */
function startingRun(text = 'do the thing'): AgentSessionView {
  const started = startAgentRun(fresh(), text)
  expect(started.accepted).toBe(true)
  return started.view
}

/** A view with run-1 in flight, bound by its first frame. */
function liveRun(): AgentSessionView {
  const reduced = reduceAgentEvent(
    startingRun(),
    frame('text-delta', { text: 'working' }, { sequence: 1, runId: 'run-1' }),
  )
  expect(reduced.outcome.status).toBe('applied')
  return reduced.view
}

/** Cancel the run in a view, the way the engine reports it. */
function cancelled(view: AgentSessionView): AgentSessionView {
  const reduced = reduceAgentEvent(
    view,
    frame('run-finished', { stopReason: 'cancelled', usage: null }, { sequence: 2, runId: 'run-1' }),
  )
  expect(reduced.outcome.status).toBe('applied')
  expect(reduced.view.state).toBe('cancelled')
  return reduced.view
}

function dropReason(view: AgentSessionView, event: AgentEvent): AgentDropReason {
  const reduced = reduceAgentEvent(view, event)
  expect(reduced.outcome.status).toBe('dropped')
  // A refused event changes nothing at all, and the *same object* coming back is the
  // strongest form of that: not a copy that happens to be equal.
  expect(reduced.view).toBe(view)
  return (reduced.outcome as { reason: AgentDropReason }).reason
}

describe('every kind the contract carries', () => {
  /** The text of the last row that holds any. */
  function lastText(view: AgentSessionView): string {
    const rows = view.timeline.filter((entry) => 'text' in entry)
    return rows[rows.length - 1]?.text ?? ''
  }

  // Typed as a Record, so a fifteenth kind in `AgentPayloads` is a missing entry here
  // rather than a kind nothing asserts anything about.
  const effects: Record<AgentEventKind, (view: AgentSessionView) => void> = {
    // The last text row is the run's own answer, which the chunk coalesces into — see the
    // coalescing section below for what happens when it does not.
    'text-delta': (view) => expect(lastText(view)).toContain('chunk'),
    'user-delta': (view) => expect(lastText(view)).toBe('chunk'),
    'thought-delta': (view) => expect(lastText(view)).toBe('chunk'),
    'tool-update': (view) => expect(view.timeline.at(-1)).toMatchObject({ kind: 'tool', toolCallId: 'call-1' }),
    'permission-request': (view) => expect(view.permissions).toHaveLength(1),
    'commands-changed': (view) => expect(view.commands).toEqual([{ name: '/review' }]),
    'plan-changed': (view) => expect(view.plan).toHaveLength(1),
    'mode-changed': (view) => expect(view.modeId).toBe('plan'),
    'config-changed': (view) => expect(view.config[0]?.id).toBe('model'),
    'session-changed': (view) => expect(view.title).toBe('Renamed'),
    'usage-changed': (view) => expect(view.usage?.usedTokens).toBe(10),
    'files-changed': (view) => expect(view.changedFiles).toEqual(['notes/a.md']),
    'run-finished': (view) => expect(view.lastResult?.stopReason).toBe('end-turn'),
    'run-failed': (view) => expect(view.failure?.code).toBe('process-exited'),
  }

  const payloads: { [K in AgentEventKind]: AgentPayloads[K] } = {
    'text-delta': { text: 'chunk' },
    'user-delta': { text: 'chunk' },
    'thought-delta': { text: 'chunk' },
    'tool-update': {
      toolCallId: 'call-1',
      title: 'Reading a.md',
      kind: 'read',
      status: 'in_progress',
      paths: ['a.md'],
      content: [],
      input: { state: 'absent' },
      output: { state: 'absent' },
    },
    'permission-request': {
      requestId: 'req-1',
      toolCallId: 'call-1',
      title: 'Run a command?',
      input: { state: 'absent' },
      content: [],
      options: [{ optionId: 'yes', name: 'Yes', kind: 'allow_once' }],
    },
    'commands-changed': { commands: [{ name: '/review' }] },
    'plan-changed': { entries: [{ content: 'step', status: 'pending', priority: 'low' }] },
    'mode-changed': { modeId: 'plan' },
    'config-changed': {
      options: [{ id: 'model', name: 'Model', value: { kind: 'select', current: 'a', choices: [{ value: 'a', name: 'A' }] } }],
    },
    'session-changed': { title: 'Renamed' },
    'usage-changed': { usedTokens: 10, contextTokens: 100, cost: null },
    'files-changed': { paths: ['notes/a.md'] },
    'run-finished': { stopReason: 'end-turn', usage: null },
    'run-failed': { code: 'process-exited', message: 'the runtime exited' },
  }

  for (const kind of Object.keys(payloads) as AgentEventKind[]) {
    it(`applies ${kind} to the state it is about`, () => {
      const view = liveRun()
      const reduced = reduceAgentEvent(
        view,
        frame(kind, payloads[kind], { sequence: 2, runId: 'run-1' }),
      )
      expect(reduced.outcome).toEqual({ status: 'applied' })
      effects[kind](reduced.view)
    })
  }

  it('keeps a title the update does not mention, and clears one it sends as null', () => {
    const titled = reduceAgentEvent(
      liveRun(),
      frame('session-changed', { title: 'Renamed' }, { sequence: 2, runId: 'run-1' }),
    ).view
    const untouched = reduceAgentEvent(
      { ...titled, sequence: 3 },
      frame('session-changed', { updatedAt: '2026-09-16T00:00:00Z' }, { sequence: 4, runId: 'run-1' }),
    ).view
    expect(untouched.title).toBe('Renamed')
    const cleared = reduceAgentEvent(
      { ...untouched, sequence: 5 },
      frame('session-changed', { title: null }, { sequence: 6, runId: 'run-1' }),
    ).view
    expect(cleared.title).toBeNull()
  })
})

describe('coalescing and the bounds', () => {
  it('merges consecutive chunks into the row they continue', () => {
    let view = liveRun()
    for (const [index, text] of ['one ', 'two ', 'three'].entries()) {
      view = reduceAgentEvent(view, frame('text-delta', { text }, { sequence: 2 + index, runId: 'run-1' })).view
    }
    const texts = view.timeline.filter((entry) => entry.kind === 'text')
    expect(texts).toHaveLength(1)
    expect(texts[0]).toMatchObject({ text: 'workingone two three' })
  })

  it("does not merge a chunk into another run's answer", () => {
    // run-1 has to end before run-2 can begin: the state machine allows one active
    // generation per session, so a second run's frames are refused outright while one is
    // live (that refusal has its own case above).
    const ended = cancelled(liveRun())
    const next = startAgentRun(ended, 'again').view
    const second = reduceAgentEvent(
      next,
      frame('text-delta', { text: 'second' }, { sequence: 3, runId: 'run-2' }),
    ).view
    expect(second.timeline.filter((entry) => entry.kind === 'text')).toHaveLength(2)
  })

  it('aborts the run that crosses the timeline bound, and trims nothing', () => {
    // Two rows already: the user's own message, and the answer's first row.
    const view = liveRun()
    expect(view.timeline).toHaveLength(2)
    const tight: AgentSessionView = { ...view, timelineLimit: 3 }
    const third = reduceAgentEvent(tight, frame('thought-delta', { text: 'think' }, { sequence: 2, runId: 'run-1' }))
    expect(third.outcome).toEqual({ status: 'applied' })
    expect(third.view.timeline).toHaveLength(3)

    const crossed = reduceAgentEvent(
      third.view,
      frame('user-delta', { text: 'and mine' }, { sequence: 3, runId: 'run-1' }),
    )
    expect(crossed.outcome).toEqual({ status: 'aborted', limit: 'timeline', value: 3 })
    expect(crossed.view.state).toBe('failed')
    expect(crossed.view.failure?.code).toBe('buffer-conflict')
    // Nothing was trimmed: the row that crossed the line is kept, because the abort is the
    // report rather than a second loss.
    expect(crossed.view.timeline).toHaveLength(4)
    expect(crossed.view.timeline.at(-1)).toMatchObject({ text: 'and mine' })
    // And the run is closed, so nothing after it can grow the timeline either.
    expect(
      dropReason(crossed.view, frame('text-delta', { text: 'more' }, { sequence: 4, runId: 'run-1' })),
    ).toBe('closed-run')
  })

  it('aborts a message that passes the size the host will hold, and keeps it', () => {
    const huge = 'x'.repeat(AGENT_TEXT_LIMIT + 1)
    const reduced = reduceAgentEvent(liveRun(), frame('text-delta', { text: huge }, { sequence: 2, runId: 'run-1' }))
    expect(reduced.outcome).toEqual({ status: 'aborted', limit: 'text', value: AGENT_TEXT_LIMIT })
    expect(reduced.view.state).toBe('failed')
    expect(reduced.view.timeline.at(-1)).toMatchObject({ text: 'working' + huge })
  })

  it('keeps a permission request when the run is aborted', () => {
    const asked = reduceAgentEvent(
      { ...liveRun(), timelineLimit: 2 },
      frame(
        'permission-request',
        { requestId: 'req-1', toolCallId: 'call-1', title: 'Run a command?', input: { state: 'absent' }, content: [], options: [{ optionId: 'yes', name: 'Yes', kind: 'allow_once' }] },
        { sequence: 2, runId: 'run-1' },
      ),
    ).view
    // A request is never what crosses a bound, and the abort it triggers does not take it
    // away: §6.2 forbids losing a permission request.
    expect(asked.permissions).toHaveLength(1)
  })
})
