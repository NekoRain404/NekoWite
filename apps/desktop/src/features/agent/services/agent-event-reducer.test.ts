/**
 * The reducer's tests.
 *
 * Most events here are built by hand rather than taken from the double: the reducer's job
 * is to judge an envelope, and a test that has to arrange a gateway to produce a frame with
 * a foreign `runtimeEpoch` would be testing the arrangement. The last section drives the
 * memory double instead, because the one behaviour that matters most — a cancelled run's
 * late text — is only proved by frames a real producer emitted.
 */

import { describe, expect, it } from 'vitest'
import {
  AGENT_STOP_REASONS,
  type AgentEvent,
  type AgentEventKind,
  type AgentIdentity,
  type AgentPayloads,
  type AgentSession,
  type AgentSessionSnapshot,
} from '../../../platform/gateways/agent-contracts'
import {
  createMemoryAgentGateway,
  type MemoryAgentGateway,
  type MemoryRunScript,
} from '../../../platform/gateways/memory-agent'
import { AGENT_TEXT_LIMIT, reduceAgentEvent, type AgentDropReason } from './agent-event-reducer'
import { adoptSnapshot, repairFromSnapshot } from './agent-session-snapshot'
import {
  endRun,
  IDENTITY_FIELDS,
  initialAgentSessionView,
  resolvePermission,
  sessionKey,
  startAgentRun,
  type AgentIdentityField,
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

function withField(field: AgentIdentityField, value: string): Partial<AgentIdentity> {
  // A computed key over a union widens to an index signature, so the assignment needs the
  // assertion back to the shape the caller is building.
  return { [field]: value } as Partial<AgentIdentity>
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

describe('the composite identity', () => {
  // One case per field, because they answer different questions and the reducer reports
  // which one failed: a stale runtime and a foreign vault are not the same mistake.
  for (const field of IDENTITY_FIELDS) {
    it(`drops a frame whose ${field} is not this session's, and says which field`, () => {
      const view = liveRun()
      const result = reduceAgentEvent(
        view,
        frame('text-delta', { text: 'x' }, {
          sequence: 5,
          runId: 'run-1',
          identity: withField(field, 'somewhere-else'),
        }),
      )
      expect(result.outcome).toEqual({ status: 'dropped', reason: 'identity-mismatch', field })
      expect(result.view).toBe(view)
    })
  }

  it('identifies a session by all five fields, including the runtime instance', () => {
    expect(sessionKey(IDENTITY)).not.toBe(sessionKey({ ...IDENTITY, runtimeEpoch: 'epoch-2' }))
    expect(sessionKey(IDENTITY)).not.toBe(sessionKey({ ...IDENTITY, sessionId: 'session-2' }))
  })
})

describe('the host sequence', () => {
  it('applies a frame that follows the last one', () => {
    const view = liveRun()
    const next = reduceAgentEvent(
      view,
      frame('text-delta', { text: ' more' }, { sequence: 2, runId: 'run-1' }),
    )
    expect(next.outcome).toEqual({ status: 'applied' })
    expect(next.view.sequence).toBe(2)
    expect(next.view.gap).toBeNull()
  })

  it('drops a sequence that has already been applied, rather than applying it twice', () => {
    const view = liveRun()
    // The same frame delivered again — the case a re-subscription produces.
    expect(dropReason(view, frame('text-delta', { text: 'working' }, { sequence: 1, runId: 'run-1' }))).toBe(
      'duplicate-sequence',
    )
    expect(view.timeline).toHaveLength(2)
  })

  it('drops a sequence older than the window has already read', () => {
    const view = reduceAgentEvent(
      liveRun(),
      frame('text-delta', { text: ' more' }, { sequence: 4, runId: 'run-1' }),
    ).view
    expect(dropReason(view, frame('text-delta', { text: ' late' }, { sequence: 3, runId: 'run-1' }))).toBe(
      'out-of-order-sequence',
    )
  })

  it('applies a frame after a jump and records the hole instead of stitching it', () => {
    const view = liveRun()
    const jumped = reduceAgentEvent(
      view,
      frame('text-delta', { text: ' after the hole' }, { sequence: 5, runId: 'run-1' }),
    )
    expect(jumped.outcome).toEqual({ status: 'applied' })
    expect(jumped.view.sequence).toBe(5)
    expect(jumped.view.gap).toEqual({ expected: 2, received: 5 })
    // The hole is a fact about the record: the frames after it do not erase it.
    const next = reduceAgentEvent(
      jumped.view,
      frame('text-delta', { text: ' on' }, { sequence: 6, runId: 'run-1' }),
    )
    expect(next.view.gap).toEqual({ expected: 2, received: 5 })
  })

  it('does not call the beginning of a session a hole', () => {
    const started = reduceAgentEvent(
      startingRun(),
      frame('text-delta', { text: 'first' }, { sequence: 7, runId: 'run-1' }),
    )
    expect(started.view.gap).toBeNull()
  })
})

describe("a cancelled run's late frames", () => {
  it("does not revive the run, and does not touch the transcript", () => {
    const after = cancelled(liveRun())
    const before = after.timeline.length
    const late = reduceAgentEvent(after, frame('text-delta', { text: ' still typing' }, { sequence: 3, runId: 'run-1' }))
    expect(late.outcome).toEqual({ status: 'dropped', reason: 'closed-run' })
    expect(late.view).toBe(after)
    expect(late.view.state).toBe('cancelled')
    expect(late.view.timeline).toHaveLength(before)
  })

  it('is refused even after the next prompt has started, when nothing is bound yet', () => {
    // The window the bound run alone cannot close: `startAgentRun` has cleared `runId` for
    // the run it just began, so a late frame of the dead run would be the first to name a
    // run and would bind itself if the closed-run list were not there.
    const next = startAgentRun(cancelled(liveRun()), 'again').view
    expect(next.runId).toBeNull()
    const late = reduceAgentEvent(next, frame('text-delta', { text: ' late' }, { sequence: 3, runId: 'run-1' }))
    expect(late.outcome).toEqual({ status: 'dropped', reason: 'closed-run' })
    expect(late.view).toBe(next)
  })

  it('still applies the frames that describe the session', () => {
    // "Drop everything after a cancel" is the wrong reading: these frames are not the dead
    // run's output, they are true statements about the session, and refusing them would
    // lose the command list, the plan and the cost along with the text.
    const after = cancelled(liveRun())
    const sessionKinds: { event: AgentEvent; assert: (view: AgentSessionView) => void }[] = [
      {
        event: frame('commands-changed', { commands: [{ name: '/review' }] }, { sequence: 3, runId: 'run-1' }),
        assert: (view) => expect(view.commands).toEqual([{ name: '/review' }]),
      },
      {
        event: frame('plan-changed', { entries: [{ content: 'step', status: 'pending', priority: 'low' }] }, { sequence: 3, runId: 'run-1' }),
        assert: (view) => expect(view.plan).toHaveLength(1),
      },
      {
        event: frame('mode-changed', { modeId: 'plan' }, { sequence: 3, runId: 'run-1' }),
        assert: (view) => expect(view.modeId).toBe('plan'),
      },
      {
        event: frame('usage-changed', { usedTokens: 10, contextTokens: 100, cost: null }, { sequence: 3, runId: 'run-1' }),
        assert: (view) => expect(view.usage?.usedTokens).toBe(10),
      },
      {
        event: frame('files-changed', { paths: ['notes/a.md'] }, { sequence: 3, runId: 'run-1' }),
        assert: (view) => expect(view.changedFiles).toEqual(['notes/a.md']),
      },
      {
        event: frame('session-changed', { title: 'Renamed' }, { sequence: 3, runId: 'run-1' }),
        assert: (view) => expect(view.title).toBe('Renamed'),
      },
    ]
    for (const { event, assert } of sessionKinds) {
      const reduced = reduceAgentEvent(after, event)
      expect(reduced.outcome).toEqual({ status: 'applied' })
      assert(reduced.view)
      // Applied, and still not revived.
      expect(reduced.view.state).toBe('cancelled')
    }
  })

  it('accepts the engine settling a call the panel already shows, and nothing else', () => {
    const running = reduceAgentEvent(
      liveRun(),
      frame(
        'tool-update',
        {
          toolCallId: 'call-1',
          title: 'Reading a.md',
          kind: 'read',
          status: 'in_progress',
          paths: [],
          content: [],
          input: { state: 'absent' },
          output: { state: 'absent' },
        },
        { sequence: 2, runId: 'run-1' },
      ),
    ).view

    // The run ends as cancelled: the call it left in progress is the host's to settle.
    const after = reduceAgentEvent(
      running,
      frame('run-finished', { stopReason: 'cancelled', usage: null }, { sequence: 3, runId: 'run-1' }),
    ).view
    const call = after.timeline.find((entry) => entry.kind === 'tool')
    expect(call).toMatchObject({ status: 'cancelled' })

    // The engine's last word about that call is information, not a revival.
    const settled = reduceAgentEvent(
      after,
      frame(
        'tool-update',
        {
          toolCallId: 'call-1',
          title: 'Read a.md',
          kind: 'read',
          status: 'completed',
          paths: [],
          content: [],
          input: { state: 'absent' },
          output: { state: 'text', json: 'ok' },
        },
        { sequence: 4, runId: 'run-1' },
      ),
    )
    expect(settled.outcome).toEqual({ status: 'applied' })
    expect(settled.view.timeline.find((entry) => entry.kind === 'tool')).toMatchObject({ status: 'completed' })
    expect(settled.view.state).toBe('cancelled')

    // An update that would put the call back into progress is the run coming back, and is
    // refused like the text.
    expect(
      dropReason(
        settled.view,
        frame(
          'tool-update',
          {
            toolCallId: 'call-1',
            title: 'Reading a.md',
            kind: 'read',
            status: 'in_progress',
            paths: [],
            content: [],
            input: { state: 'absent' },
            output: { state: 'absent' },
          },
          { sequence: 5, runId: 'run-1' },
        ),
      ),
    ).toBe('closed-run')

    // And a call the panel never showed cannot arrive with the dead run.
    expect(
      dropReason(
        settled.view,
        frame(
          'tool-update',
          {
            toolCallId: 'call-2',
            title: 'Writing b.md',
            kind: 'edit',
            status: 'completed',
            paths: [],
            content: [],
            input: { state: 'absent' },
            output: { state: 'absent' },
          },
          { sequence: 6, runId: 'run-1' },
        ),
      ),
    ).toBe('closed-run')
  })

  it('applies the next run normally after a cancel', () => {
    const next = startAgentRun(cancelled(liveRun()), 'again').view
    const bound = reduceAgentEvent(next, frame('text-delta', { text: 'second answer' }, { sequence: 4, runId: 'run-2' }))
    expect(bound.outcome).toEqual({ status: 'applied' })
    expect(bound.view.state).toBe('running')
    expect(bound.view.runId).toBe('run-2')
    // The user's own row followed the run: it was written before the run had a name.
    expect(bound.view.timeline.filter((entry) => entry.kind === 'user').at(-1)?.runId).toBe('run-2')
  })

  it('refuses the content of a run that is neither bound nor closed', () => {
    const frameOfRun = frame('text-delta', { text: 'x' }, { sequence: 2, runId: 'run-9' })
    expect(dropReason(liveRun(), frameOfRun)).toBe('other-run')
  })

  it('refuses turn content that names no turn', () => {
    const unattributed = frame('text-delta', { text: 'x' }, { sequence: 2, runId: null })
    expect(dropReason(liveRun(), unattributed)).toBe('unattributed-run')
  })

  it('refuses turn content for a run that was never started', () => {
    // A frame arriving while the view is ready has nothing that could have authorised it:
    // only the store opening a run is what lets one bind, which is what stops a stray frame
    // from beginning a run the user never asked for.
    const stray = frame('text-delta', { text: 'x' }, { sequence: 1, runId: 'run-1' })
    expect(dropReason(fresh(), stray)).toBe('illegal-transition')
  })
})

describe('the state machine', () => {
  it('waits on a permission and resumes on the answer', () => {
    const asked = reduceAgentEvent(
      liveRun(),
      frame(
        'permission-request',
        { requestId: 'req-1', toolCallId: 'call-1', title: 'Run a command?', input: { state: 'absent' }, options: [{ optionId: 'yes', name: 'Yes', kind: 'allow_once' }] },
        { sequence: 2, runId: 'run-1' },
      ),
    )
    expect(asked.view.state).toBe('waiting-permission')
    expect(asked.view.permissions).toHaveLength(1)

    const answered = resolvePermission(asked.view, 'req-1')
    expect(answered.accepted).toBe(true)
    expect(answered.view.state).toBe('running')
    expect(answered.view.permissions).toHaveLength(0)
  })

  it('refuses an answer for a request the view does not hold', () => {
    const answered = resolvePermission(liveRun(), 'req-unknown')
    expect(answered.accepted).toBe(false)
    expect(answered.view.runId).toBe('run-1')
  })

  it('refuses an answer for a request whose run is no longer the live one', () => {
    const asked = reduceAgentEvent(
      liveRun(),
      frame(
        'permission-request',
        { requestId: 'req-1', toolCallId: 'call-1', title: 'Run a command?', input: { state: 'absent' }, options: [{ optionId: 'yes', name: 'Yes', kind: 'allow_once' }] },
        { sequence: 2, runId: 'run-1' },
      ),
    ).view
    // The turn ended without an answer, so the request it left is dead — and so is the
    // button that would have answered it.
    const ended = endRun(asked, 'run-1', 'cancelled')
    expect(ended.permissions).toHaveLength(0)
  })

  it('stays waiting while another request of the same run is unanswered', () => {
    const ask = (view: AgentSessionView, requestId: string, sequence: number): AgentSessionView =>
      reduceAgentEvent(
        view,
        frame(
          'permission-request',
          { requestId, toolCallId: 'call-1', title: 'Run a command?', input: { state: 'absent' }, options: [{ optionId: 'yes', name: 'Yes', kind: 'allow_once' }] },
          { sequence, runId: 'run-1' },
        ),
      ).view
    const second = ask(ask(liveRun(), 'req-1', 2), 'req-2', 3)
    expect(second.permissions).toHaveLength(2)
    // A turn can ask about several calls. Resuming on the first answer would offer a send
    // button for a run that is still suspended on the second.
    const answered = resolvePermission(second, 'req-1')
    expect(answered.accepted).toBe(true)
    expect(answered.view.state).toBe('waiting-permission')
    expect(resolvePermission(answered.view, 'req-2').view.state).toBe('running')
  })

  it('refuses a second run while one is live, and allows one after it ended', () => {
    const live = liveRun()
    expect(startAgentRun(live, 'and another thing').accepted).toBe(false)
    expect(startAgentRun(live, 'and another thing').view).toBe(live)
    expect(startAgentRun(cancelled(live), 'again').accepted).toBe(true)
  })

  it("keeps the user's text when a run is refused", () => {
    // The store turns the refusal into the draft; the reducer's job is only that the text
    // is not in the timeline twice and the state did not move.
    const live = liveRun()
    const refused = startAgentRun(live, 'second')
    expect(refused.view.timeline.filter((entry) => entry.kind === 'user')).toHaveLength(1)
  })

  for (const stopReason of AGENT_STOP_REASONS) {
    it(`ends a run through run-finished for '${stopReason}', never as a failure`, () => {
      const ended = reduceAgentEvent(
        liveRun(),
        frame('run-finished', { stopReason, usage: null }, { sequence: 2, runId: 'run-1' }),
      )
      expect(ended.outcome).toEqual({ status: 'applied' })
      expect(ended.view.state).toBe(stopReason === 'cancelled' ? 'cancelled' : 'completed')
      // A token ceiling and a refusal are how a turn ends, not failures — and the reason is
      // kept, so "completed" does not flatten four different endings into one.
      expect(ended.view.state).not.toBe('failed')
      expect(ended.view.lastResult?.stopReason).toBe(stopReason)
      expect(ended.view.failure).toBeNull()
    })
  }

  it('ends the run as completed when the ending’s reason is one this version does not know', () => {
    // The arm `AGENT_STOP_REASONS` deliberately does not contain: the frame is a completed turn's
    // ending with a reason the contract has never seen, and the run is over either way. It is a
    // `completed` run and not a `failed` one — reporting a decode problem as a fault of the turn
    // is the outcome the whole arm exists to prevent — and the reason keeps its own state in
    // `lastResult`, so nothing here reads as an ordinary `end-turn`.
    const ended = reduceAgentEvent(
      liveRun(),
      frame(
        'run-finished',
        { stopReason: 'unrecognised', unrecognisedReason: 'budget_exceeded', usage: null },
        { sequence: 2, runId: 'run-1' },
      ),
    )

    expect(ended.outcome).toEqual({ status: 'applied' })
    expect(ended.view.state).toBe('completed')
    expect(ended.view.failure).toBeNull()
    expect(ended.view.lastResult).toEqual({
      stopReason: 'unrecognised',
      unrecognisedReason: 'budget_exceeded',
      usage: null,
    })
  })

  it('fails the run through run-failed, and drops the questions it left', () => {
    const asked = reduceAgentEvent(
      liveRun(),
      frame(
        'permission-request',
        { requestId: 'req-1', toolCallId: 'call-1', title: 'Run a command?', input: { state: 'absent' }, options: [{ optionId: 'yes', name: 'Yes', kind: 'allow_once' }] },
        { sequence: 2, runId: 'run-1' },
      ),
    ).view
    const failed = reduceAgentEvent(
      asked,
      frame('run-failed', { code: 'process-exited', message: 'the runtime exited' }, { sequence: 3, runId: 'run-1' }),
    )
    expect(failed.view.state).toBe('failed')
    expect(failed.view.failure).toEqual({ code: 'process-exited', message: 'the runtime exited' })
    expect(failed.view.permissions).toHaveLength(0)
  })

  it('refuses a second ending for the same run', () => {
    expect(
      dropReason(
        cancelled(liveRun()),
        frame('run-finished', { stopReason: 'end-turn', usage: null }, { sequence: 3, runId: 'run-1' }),
      ),
    ).toBe('closed-run')
  })

  it('clears the previous failure when the next run starts', () => {
    const failed = reduceAgentEvent(
      liveRun(),
      frame('run-failed', { code: 'timeout', message: 'no answer' }, { sequence: 2, runId: 'run-1' }),
    ).view
    expect(failed.failure).not.toBeNull()
    expect(startAgentRun(failed, 'again').view.failure).toBeNull()
  })
})

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
        { requestId: 'req-1', toolCallId: 'call-1', title: 'Run a command?', input: { state: 'absent' }, options: [{ optionId: 'yes', name: 'Yes', kind: 'allow_once' }] },
        { sequence: 2, runId: 'run-1' },
      ),
    ).view
    // A request is never what crosses a bound, and the abort it triggers does not take it
    // away: §6.2 forbids losing a permission request.
    expect(asked.permissions).toHaveLength(1)
  })
})

describe('snapshots', () => {
  function snapshot(overrides: Partial<AgentSessionSnapshot> = {}): AgentSessionSnapshot {
    return {
      identity: IDENTITY,
      state: 'running',
      runId: 'run-1',
      sequence: 0,
      events: [],
      permissions: [],
      ...overrides,
    }
  }

  it('adopts a snapshot and continues from the sequence it carries', () => {
    const events = [
      frame('text-delta', { text: 'earlier' }, { sequence: 4, runId: 'run-1' }),
      frame('text-delta', { text: ' and later' }, { sequence: 5, runId: 'run-1' }),
    ]
    const adopted = adoptSnapshot(fresh(), snapshot({ sequence: 5, events, runId: 'run-1' }))
    expect(adopted.outcome).toEqual({ status: 'adopted' })
    expect(adopted.view.sequence).toBe(5)
    expect(adopted.view.runId).toBe('run-1')
    // The tail begins where the host's record begins. That is not a hole — counting it as
    // one would mark every restored long session as damaged.
    expect(adopted.view.gap).toBeNull()
    expect(adopted.view.timeline.filter((entry) => entry.kind === 'text')).toHaveLength(1)
  })

  it("adopts the host's ending, so a run that ended while the window was away stays ended", () => {
    const events = [frame('text-delta', { text: 'bye' }, { sequence: 4, runId: 'run-1' })]
    const adopted = adoptSnapshot(fresh(), snapshot({ state: 'cancelled', runId: 'run-1', sequence: 4, events }))
    expect(adopted.view.state).toBe('cancelled')
    // The run it names is closed, so its late frames are refused from the first moment the
    // new view exists — the guard survives a remount.
    const late = frame('text-delta', { text: ' more' }, { sequence: 5, runId: 'run-1' })
    expect(dropReason(adopted.view, late)).toBe('closed-run')
  })

  it('refuses a snapshot taken under another identity, naming the field', () => {
    const refused = adoptSnapshot(fresh(), snapshot({ identity: { ...IDENTITY, vaultId: 'vault-2' } }))
    expect(refused.outcome).toEqual({ status: 'refused', reason: 'identity-mismatch', field: 'vaultId' })
  })

  it('refuses a state an open session cannot be in', () => {
    const refused = adoptSnapshot(fresh(), snapshot({ state: 'starting' }))
    expect(refused.outcome).toEqual({ status: 'refused', reason: 'unreachable-state', state: 'starting' })
  })

  it('refuses to rewind a view that has already read past the snapshot', () => {
    const view = reduceAgentEvent(
      liveRun(),
      frame('text-delta', { text: ' more' }, { sequence: 2, runId: 'run-1' }),
    ).view
    const refused = repairFromSnapshot(view, snapshot({ sequence: 1 }))
    expect(refused.outcome).toEqual({ status: 'refused', reason: 'rewind', held: 2, offered: 1 })
    expect(refused.view).toBe(view)
  })

  it('repairs the state from the host without taking the conversation off the screen', () => {
    // The view believes run-1 is in flight; the host says it ended. The timeline is what the
    // user is reading, so it stays — and the run it belongs to is closed by the repair.
    const view = liveRun()
    const repaired = repairFromSnapshot(view, snapshot({ state: 'cancelled', runId: 'run-1', sequence: 1 }))
    expect(repaired.outcome).toEqual({ status: 'adopted' })
    expect(repaired.view.state).toBe('cancelled')
    expect(repaired.view.timeline).toHaveLength(view.timeline.length)
    const late = frame('text-delta', { text: 'late' }, { sequence: 2, runId: 'run-1' })
    expect(dropReason(repaired.view, late)).toBe('closed-run')
  })

  it("reduces the frames between the view's position and the snapshot, which nothing else would deliver", () => {
    // A subscription continues at `snapshot.sequence + 1`, so an event the view never applied
    // and the snapshot still holds exists only in the snapshot's own tail.
    const events = [frame('usage-changed', { usedTokens: 42, contextTokens: 100, cost: null }, { sequence: 2, runId: 'run-1' })]
    const repaired = repairFromSnapshot(liveRun(), snapshot({ sequence: 2, events }))
    expect(repaired.view.usage?.usedTokens).toBe(42)
    expect(repaired.view.sequence).toBe(2)
  })
})

describe('frames the memory double actually produced', () => {
  /**
   * Everything the double hands a subscriber, reduced in the order it arrived — the whole
   * pipeline the store runs, without the store. The three steps that matter are the store's:
   * snapshot, subscribe from it, and then open the run *before* asking for it, so the
   * turn's opening frames land in a view that already knows a run is in flight.
   */
  async function runThroughDouble(
    text: string,
    script: MemoryRunScript,
    act: (gateway: MemoryAgentGateway, session: AgentSession) => Promise<void>,
  ): Promise<AgentSessionView> {
    const gateway = createMemoryAgentGateway({ agentId: IDENTITY.agentId, profileId: IDENTITY.profileId })
    await gateway.start()
    const session = await gateway.openSession({ vaultId: IDENTITY.vaultId, cwd: '/tmp/vault' })
    gateway.script(script)
    const from = await gateway.snapshot(session)
    const adopted = adoptSnapshot(fresh(), from)
    expect(adopted.outcome).toEqual({ status: 'adopted' })
    let view = startAgentRun(adopted.view, text).view
    const unsubscribe = await gateway.subscribe(from, (event) => {
      view = reduceAgentEvent(view, event).view
    })
    await act(gateway, session)
    unsubscribe()
    return view
  }

  it("does not revive a run the user cancelled, even though its late frames arrive", async () => {
    const view = await runThroughDouble('start something long', { hang: true }, async (gateway, session) => {
      const run = gateway.prompt(session, 'start something long')
      // The double holds the turn open until it is cancelled.
      await gateway.cancel(session)
      await run
      // The protocol says a client SHOULD keep accepting a cancelled run's final frames, and
      // the double delivers one, tagged with the dead run's id.
      gateway.emit(session, { kind: 'text-delta', payload: { text: ' still typing' }, runId: 'run-1' })
    })
    expect(view.state).toBe('cancelled')
    // The late chunk is not in the transcript, and the run did not come back.
    expect(view.timeline.some((entry) => 'text' in entry && entry.text.includes('still typing'))).toBe(false)
  })

  it('drops nothing a running turn legitimately produced', async () => {
    const view = await runThroughDouble('hello', { chunks: ['a', 'b', 'c'] }, async (gateway, session) => {
      await gateway.prompt(session, 'hello')
    })
    expect(view.state).toBe('completed')
    expect(view.timeline.filter((entry) => entry.kind === 'text')).toHaveLength(1)
    expect(view.timeline.filter((entry) => 'text' in entry).at(-1)?.text).toBe('abc')
    expect(view.lastResult?.stopReason).toBe('end-turn')
  })
})
