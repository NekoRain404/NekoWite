/**
 * The snapshot handshake: taking the host's word for what the window cannot see.
 *
 * §6.2 requires the UI to fetch a snapshot before it subscribes (「先获取宿主快照再接事件，
 * 避免订阅空窗」). That handshake is two calls and, between them, a view that has to agree
 * with the snapshot about *where it is* — a subscription continues at `snapshot.sequence + 1`,
 * so a view whose position disagrees with the snapshot either misses events or replays them.
 * This module is where the two are reconciled, and it is apart from the reducer because
 * it is about the handshake rather than about any one event.
 *
 * Both entry points replay the snapshot's own tail through the *same* reducer the live
 * stream uses, in `replay` mode. That is what keeps the two paths from diverging: a frame
 * means the same thing whether it was pushed at the window or read back out of the host's
 * buffer, and the only difference is that a replay may bind a run the live path would not.
 */

import type { AgentSessionSnapshot, AgentSessionState } from '../../../platform/gateways/agent-contracts'
import { reduceAgentEvent } from './agent-event-reducer'
import {
  identityMismatch,
  initialAgentSessionView,
  markRunClosed,
  TERMINAL_STATES,
  type AgentIdentityField,
  type AgentSessionView,
} from './agent-session-view'

/** What adopting or repairing from a snapshot did. Each refusal is a different reason
 *  the snapshot cannot be continued from, and the caller acts on them differently: an
 *  identity mismatch means this is not the session the view is bound to, a rewind means
 *  the snapshot is behind the view, and an unreachable state means the host is telling
 *  us something the panel cannot render. */
export type AgentSnapshotOutcome =
  | { status: 'adopted' }
  | { status: 'refused'; reason: 'identity-mismatch'; field: AgentIdentityField }
  | { status: 'refused'; reason: 'unreachable-state'; state: AgentSessionState }
  | { status: 'refused'; reason: 'rewind'; held: number; offered: number }

/**
 * A refusal, on its own.
 *
 * The three are one answer to the handshake — it cannot continue from this snapshot — but
 * each carries which refusal it was, and a caller that reports the outcome rather than
 * collapsing it to "no" passes this through rather than restating the reasons.
 */
export type AgentSnapshotRefusal = Extract<AgentSnapshotOutcome, { status: 'refused' }>

export interface AgentSnapshotResult {
  view: AgentSessionView
  outcome: AgentSnapshotOutcome
}

/**
 * The three ways a snapshot may not be continued from.
 *
 * The identity check is the same composite boundary events and permission answers are
 * held to (§6.2: 「权限响应、快照和持久化索引使用相同的复合身份边界」) — a snapshot is a
 * value, so it may have been stored and read back, and the one that no longer matches is
 * exactly the case the boundary exists for.
 */
function judgeSnapshot(view: AgentSessionView, snapshot: AgentSessionSnapshot): AgentSnapshotOutcome | null {
  const field = identityMismatch(view.identity, snapshot.identity)
  if (field !== null) return { status: 'refused', reason: 'identity-mismatch', field }
  if (snapshot.state === 'idle' || snapshot.state === 'starting') {
    // The contract says an open session's snapshot never reports these: they describe the
    // runtime before `openSession` returned. Accepting one would put the view in a state it
    // has no way to render or leave.
    return { status: 'refused', reason: 'unreachable-state', state: snapshot.state }
  }
  if (snapshot.sequence < view.sequence) {
    // A snapshot behind the view would rewind a conversation the user has already read and
    // re-open runs whose ends were seen. The caller takes a fresh one instead.
    return { status: 'refused', reason: 'rewind', held: view.sequence, offered: snapshot.sequence }
  }
  return null
}

/** Reduce a snapshot's replay tail. */
function replayInto(base: AgentSessionView, snapshot: AgentSessionSnapshot, fresh: boolean): AgentSessionView {
  // A fresh view's position starts where the host's record starts. The tail is bounded by
  // the replay limit, so its beginning is not a hole in the stream — counting it as one
  // would mark every restored long session as damaged. A view that already has a position
  // keeps it, and a jump between the two is a real hole, recorded as one.
  const start =
    fresh && snapshot.events.length > 0 ? { ...base, sequence: snapshot.events[0].sequence - 1 } : base
  let view = start
  for (const event of snapshot.events) {
    // A repair continues a view that already has a position, and the frames it has already
    // applied are stepped over rather than reduced-and-refused: reducing them would work, but
    // every one would be counted as a frame the stream lost, and a repair is not a loss.
    if (!fresh && event.sequence <= view.sequence) continue
    view = reduceAgentEvent(view, event, 'replay').view
  }
  return view
}

/** Take the host's word for the parts of the state only it can see. */
function overlay(view: AgentSessionView, snapshot: AgentSessionSnapshot): AgentSessionView {
  const closed =
    TERMINAL_STATES.includes(snapshot.state) && snapshot.runId !== null
      ? markRunClosed(view, snapshot.runId)
      : view
  return {
    ...closed,
    state: snapshot.state,
    runId: snapshot.runId,
    sequence: snapshot.sequence,
    // The host is the one that takes permission answers, so its list of what is still
    // pending is the authority: a request it no longer holds is one whose button must go.
    permissions: [...snapshot.permissions],
  }
}

/**
 * Adopt a snapshot into a view that has nothing: the handshake a remount starts with.
 *
 * The view is rebuilt from the snapshot's own tail through the same reducer the live
 * stream uses, and then the host's state, run binding and pending requests are laid over
 * it. The caller then subscribes *from that snapshot*, so nothing between it and the
 * first live event is missed and nothing is applied twice.
 */
export function adoptSnapshot(view: AgentSessionView, snapshot: AgentSessionSnapshot): AgentSnapshotResult {
  const refusal = judgeSnapshot(view, snapshot)
  if (refusal !== null) return { view, outcome: refusal }
  const fresh = initialAgentSessionView(snapshot.identity, { timelineLimit: view.timelineLimit })
  return { view: overlay(replayInto(fresh, snapshot, true), snapshot), outcome: { status: 'adopted' } }
}

/**
 * Repair a live view from a fresh snapshot: the remedy for a hole in the stream, and for
 * state that has drifted from the host's.
 *
 * The timeline is kept — it is what the user is reading, and the hole in it is already
 * recorded — while the state machine, the run binding and the pending requests are taken
 * from the host. That split is the point: a view that thinks a run is live when the host
 * says it ended is the failure this repairs, and it is repaired without taking the
 * conversation off the screen.
 *
 * The snapshot's tail is reduced first, because a subscription continues at
 * `snapshot.sequence + 1`: anything between the view's position and the snapshot exists
 * only in that tail, and skipping it would lose those events for good.
 */
export function repairFromSnapshot(view: AgentSessionView, snapshot: AgentSessionSnapshot): AgentSnapshotResult {
  const refusal = judgeSnapshot(view, snapshot)
  if (refusal !== null) return { view, outcome: refusal }
  return { view: overlay(replayInto(view, snapshot, false), snapshot), outcome: { status: 'adopted' } }
}
