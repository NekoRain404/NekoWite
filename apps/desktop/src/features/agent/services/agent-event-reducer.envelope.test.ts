/**
 * The envelope: which session a frame belongs to, and where it takes its place in the record.
 *
 * These are the reducer's first two judgements about a frame, and the two a test can only make by
 * hand: the reducer's job is to judge an envelope, and arranging a gateway to produce a frame with
 * a foreign `runtimeEpoch` would be testing the arrangement rather than the judgement.
 *
 * The identity is five fields rather than one, and each answers a different question, so the cases
 * drive one at a time; the sequence is judged against what the view has already read, in both
 * directions, and a jump is a hole the record keeps rather than a gap this window stitches over.
 */

import { describe, expect, it } from 'vitest'
import {
  type AgentEvent,
  type AgentEventKind,
  type AgentIdentity,
  type AgentPayloads,
} from '../../../platform/gateways/agent-contracts'
import { reduceAgentEvent, type AgentDropReason } from './agent-event-reducer'
import {
  IDENTITY_FIELDS,
  initialAgentSessionView,
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
