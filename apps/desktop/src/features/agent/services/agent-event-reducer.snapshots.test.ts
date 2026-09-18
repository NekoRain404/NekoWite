/**
 * The host's record: adopting a session from a snapshot, and repairing one against a later one.
 *
 * `services/agent-session-snapshot.ts` owns the rules; what is asserted here is that they hold for
 * the reducer's view — the sequence a snapshot carries is where the tail continues from and not a
 * hole, a run the host says is over stays over (its late frames are refused from the first moment
 * the new view exists, which is what survives a remount), and a repair keeps the transcript the
 * reader is reading while taking the host's word for the state.
 *
 * Snapshots are built by hand rather than produced by the double: a snapshot is a record, and
 * arranging a gateway to emit one would be testing the arrangement.
 */

import { describe, expect, it } from 'vitest'
import {
  type AgentEvent,
  type AgentEventKind,
  type AgentIdentity,
  type AgentPayloads,
  type AgentSessionSnapshot,
} from '../../../platform/gateways/agent-contracts'
import { reduceAgentEvent, type AgentDropReason } from './agent-event-reducer'
import { adoptSnapshot, repairFromSnapshot } from './agent-session-snapshot'
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

function dropReason(view: AgentSessionView, event: AgentEvent): AgentDropReason {
  const reduced = reduceAgentEvent(view, event)
  expect(reduced.outcome.status).toBe('dropped')
  // A refused event changes nothing at all, and the *same object* coming back is the
  // strongest form of that: not a copy that happens to be equal.
  expect(reduced.view).toBe(view)
  return (reduced.outcome as { reason: AgentDropReason }).reason
}

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
