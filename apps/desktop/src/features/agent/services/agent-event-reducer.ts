/**
 * The event reducer: which of the stream's frames are still true, and what each one
 * changes.
 *
 * §6.2's whole requirement lives here. {@link reduceAgentEvent} is a pure function from a
 * view and one envelope to the next view, and it refuses far more than it applies: an
 * event is checked against the composite identity, against the host's sequence, and
 * against the run it claims before any of it may change the state. A refusal returns the
 * view it was handed — the same object, not a copy — so a dropped event cannot leave a
 * trace, and a test asserting that is asserting the real thing.
 *
 * The module set, by question:
 *
 *  - `agent-timeline.ts`         what a conversation row is, and how one grows
 *  - `agent-session-view.ts`     the state, its composite identity, its transitions
 *  - this file                   whether an event may change the state, and its outcome
 *  - `agent-event-apply.ts`      what an accepted event changes
 *  - `agent-session-snapshot.ts` the snapshot handshake that re-establishes the state
 *
 * ## The one behaviour worth reading the code for
 *
 * A cancelled run's late text must not revive it. The engine may keep sending a cancelled
 * run's final frames — the protocol says a client SHOULD keep accepting tool-call updates
 * after `session/cancel` — so the frames are not the problem; the *run* is. Two things
 * keep it from coming back:
 *
 *  - a run whose end this view has seen goes into `closedRuns`, and a frame of a closed
 *    run is refused even in the window after the next prompt, when `runId` is not bound
 *    yet and nothing else would stop the dead run from binding;
 *  - "drop everything after a cancel" would be the wrong reading of that, and this reducer
 *    does not do it. Everything describing the *session* — commands, plan, mode, config,
 *    title, usage, touched files — stays true after a cancel and is applied exactly as
 *    before, and the next run's frames are applied normally. What is refused is content a
 *    dead run would add to the transcript, and only that.
 *
 * There is one deliberate exception, and it is the narrower half of the same rule: a late
 * `tool-update` for a call the panel already shows IS applied, when the engine is settling
 * that call (`completed`, `failed` or `cancelled`). The engine's final word about a row
 * the user is looking at is information, not a revival — it cannot start anything, and
 * refusing it would leave a call spinning forever on a run that is over. A late update
 * that would move the row *back* to a running state is refused with everything else.
 */

import type { AgentEvent, AgentEventKind } from '../../../platform/gateways/agent-contracts'
import { applyAgentEvent } from './agent-event-apply'
import {
  bindRun,
  failAgentRun,
  identityMismatch,
  isRunLive,
  type AgentIdentityField,
  type AgentSessionView,
} from './agent-session-view'
import { toolEntryIndex } from './agent-timeline'

/**
 * Why an event was refused. Each one answers a different "how could this frame be wrong",
 * and the reducer reports which, so a test names the defence it exercises rather than
 * asserting a generic refusal.
 */
export type AgentDropReason =
  /** One of the five identity fields disagreed; `field` says which. */
  | 'identity-mismatch'
  /** Turn content for a run whose end this view has already seen. */
  | 'closed-run'
  /** Turn content for a run that is neither the bound one nor a closed one. */
  | 'other-run'
  /** A turn-scoped kind that names no turn. */
  | 'unattributed-run'
  /** A sequence already applied — the same event delivered twice. */
  | 'duplicate-sequence'
  /** A sequence older than the view's position, arriving after its successors. */
  | 'out-of-order-sequence'
  /** A kind the state machine does not accept in the state the view is in. */
  | 'illegal-transition'

export interface AgentDropped {
  status: 'dropped'
  reason: AgentDropReason
  /** Which identity field disagreed — set exactly when `reason` is 'identity-mismatch'. */
  field?: AgentIdentityField
}

/** What the reducer did with the event it was given. `aborted` means the event was applied
 *  *and* it crossed a bound: the run is closed and reported, and the row it carried was
 *  kept rather than trimmed. */
export type AgentOutcome =
  | { status: 'applied' }
  | AgentDropped
  | { status: 'aborted'; limit: 'timeline' | 'text'; value: number }

export interface AgentReduction {
  view: AgentSessionView
  outcome: AgentOutcome
}

/**
 * How the caller's events are being read.
 *
 * `live` is the stream. `replay` is a snapshot's own tail — the host's record of what
 * already happened — and the difference is the run guard: it exists to stop *new* traffic
 * a run could not authorise, and a record has no new traffic. A replayed frame binds the
 * run it names, because the record says it did. The identity and sequence checks are the
 * same in both modes: a foreign frame does not become ours by being replayed, and
 * replaying what the view already applied is still a duplicate.
 */
export type AgentReductionMode = 'live' | 'replay'

/** The kinds whose content belongs to one turn. Their frames are refused once that turn's
 *  end has been seen.
 *
 *  A permission request is one of them even though it is a question rather than output: it
 *  is asked *by* a run, only that run's answer can move it, and a request from a closed run
 *  would put the panel back in `waiting-permission` with a button that goes nowhere. */
const RUN_CONTENT: readonly AgentEventKind[] = [
  'text-delta',
  'user-delta',
  'thought-delta',
  'tool-update',
  'permission-request',
]

/** The kinds that carry the end of a run. They close it, and a second one for the same run
 *  is the same statement twice. */
const RUN_END: readonly AgentEventKind[] = ['run-finished', 'run-failed']

/** The tool statuses that mean the call is over: the only ones a closed run may still be
 *  told about. */
const SETTLED_STATUSES: readonly string[] = ['completed', 'failed', 'cancelled']

/**
 * The size at which one text row is treated as a stream that is not a message.
 *
 * The entry bound alone is not enough: consecutive text chunks coalesce into one row by
 * design (§6.2 allows text to be merged), so a runaway stream would grow a single row
 * without ever crossing a *count*. This ceiling is far above any real answer — a turn's
 * output is capped by the engine's own token limit, orders of magnitude below it — so
 * reaching it means the stream is not producing a message, and the run is aborted and
 * reported rather than allowed to grow the window's memory without bound.
 */
export const AGENT_TEXT_LIMIT = 1_000_000

function dropped(
  view: AgentSessionView,
  reason: AgentDropReason,
  field?: AgentIdentityField,
): AgentReduction {
  return { view, outcome: { status: 'dropped', reason, field } }
}

/** Whether a kind's content belongs to a turn, rather than describing the session. */
function isTurnScoped(kind: AgentEventKind): boolean {
  return RUN_CONTENT.includes(kind) || RUN_END.includes(kind)
}

/**
 * Whether the host's sequence allows this event to be applied, and the hole it leaves if
 * it does.
 *
 * The three cases §6.2 does not spell out, decided here:
 *
 *  - **in sequence** (`last + 1`) applies;
 *  - **a duplicate or an older sequence** is refused. The same event delivered twice must
 *    not apply twice, and an event whose successors have already been applied can no
 *    longer be placed in the record — splicing it in would reorder a conversation the user
 *    has already read. This is also what makes re-subscribing safe: a second subscription
 *    registered against a fresh snapshot replays frames the first one already delivered,
 *    and the sequence is what recognises them (see the store's resync);
 *  - **a jump** (`> last + 1`) applies *and* records the hole. Refusing it would throw away
 *    real output to punish the transport for losing the frames before it, and applying it
 *    silently would stitch two non-adjacent parts of the stream together as if they were
 *    adjacent — which is exactly what the sequence exists to prevent. The frame is kept,
 *    the hole is recorded, and the store can repair its state from a fresh snapshot.
 */
function judgeSequence(
  view: AgentSessionView,
  sequence: number,
): { drop: AgentDropReason } | { view: AgentSessionView } {
  if (sequence <= view.sequence) {
    return { drop: sequence === view.sequence ? 'duplicate-sequence' : 'out-of-order-sequence' }
  }
  // A jump from the very start is not a hole: a view that has applied nothing yet has
  // nothing to compare against, and the first frame of a session is a beginning rather
  // than the end of a lost run.
  const jump = sequence > view.sequence + 1 && view.sequence > 0
  const gap = view.gap ?? (jump ? { expected: view.sequence + 1, received: sequence } : null)
  return { view: { ...view, sequence, gap } }
}

/** Whether the panel is already showing the call this update is about. */
function settlesKnownCall(view: AgentSessionView, toolCallId: string, runId: string): boolean {
  const index = toolEntryIndex(view, toolCallId)
  return index !== -1 && view.timeline[index].runId === runId
}

/**
 * Whether the run this event belongs to still permits it. Only turn-scoped kinds are asked
 * about: a session-scoped frame describes the session and stays true whatever became of a
 * run.
 *
 * Order matters. The "is this run over" questions are asked before the state machine's,
 * because a frame of a closed run is refused for *that* reason, and reporting it as an
 * illegal transition would hide the run guard behind a generic refusal — the guard is the
 * requirement, so the reason names it.
 */
function judgeRun(view: AgentSessionView, event: AgentEvent, runId: string): AgentDropReason | null {
  if (RUN_END.includes(event.kind)) {
    // A run that ended cannot end again. Its second `run-finished` is the same statement
    // twice, not a new event about a new run.
    if (view.closedRuns.includes(runId)) return 'closed-run'
    if (view.runId !== null && view.runId !== runId) return 'other-run'
    // A terminal frame for a run this view never bound is applied: it is the host's word
    // that a run ended, §6.2 forbids dropping a completion, and a terminal frame can only
    // move the view to a terminal state — it cannot revive anything.
    return null
  }

  const closed = view.closedRuns.includes(runId)
  const bound = view.runId === runId
  if (!closed && (view.runId === null || bound)) {
    // The run may be this view's own. Whether it may still accept the frame is the state
    // machine's answer: a run the store started binds on its first frame, and one that was
    // never started is refused — which is what stops a stray frame from beginning a run
    // the user never asked for.
    return isRunLive(view) ? null : 'illegal-transition'
  }

  // The run is over, or another one is in flight. The one exception is the engine's final
  // word on a call the panel already shows.
  if (
    closed &&
    event.kind === 'tool-update' &&
    SETTLED_STATUSES.includes(event.payload.status) &&
    settlesKnownCall(view, event.payload.toolCallId, runId)
  ) {
    return null
  }
  return closed ? 'closed-run' : 'other-run'
}

/**
 * The host's abort: a bound was crossed, so the run is closed as failed and the reason is
 * recorded.
 *
 * Nothing is trimmed — the row that crossed the line stays — because §6.2 forbids a silent
 * drop, and an abort with a reason is the opposite of one. The store cancels the run on the
 * gateway when it sees this outcome, so the engine is stopped as well as the view.
 *
 * The code is `buffer-conflict` because that is the vocabulary's word for "the host cannot
 * hold this": the contract has no code of its own for a capacity abort, which is recorded
 * as a gap in the task's report rather than papered over with an invented one.
 */
function abortRun(view: AgentSessionView, limit: 'timeline' | 'text'): AgentSessionView {
  const what =
    limit === 'timeline'
      ? `the session's timeline reached ${view.timelineLimit} entries`
      : 'one message passed the size this host will hold'
  return failAgentRun(
    view,
    'buffer-conflict',
    `${what}; the run was stopped rather than trimmed, and nothing already received was discarded.`,
  )
}

/** Check both bounds against a view that was just written to. */
function finishWrite(view: AgentSessionView, overLimit: boolean): AgentReduction {
  if (overLimit) {
    return {
      view: abortRun(view, 'timeline'),
      outcome: { status: 'aborted', limit: 'timeline', value: view.timelineLimit },
    }
  }
  const last = view.timeline[view.timeline.length - 1]
  if (last !== undefined && 'text' in last && last.text.length > AGENT_TEXT_LIMIT) {
    return {
      view: abortRun(view, 'text'),
      outcome: { status: 'aborted', limit: 'text', value: AGENT_TEXT_LIMIT },
    }
  }
  return { view, outcome: { status: 'applied' } }
}

/**
 * Reduce one event.
 *
 * `replay` relaxes the run guard and nothing else — see {@link AgentReductionMode}.
 */
export function reduceAgentEvent(
  view: AgentSessionView,
  event: AgentEvent,
  mode: AgentReductionMode = 'live',
): AgentReduction {
  const field = identityMismatch(view.identity, event)
  if (field !== null) return dropped(view, 'identity-mismatch', field)

  const sequence = judgeSequence(view, event.sequence)
  if ('drop' in sequence) return dropped(view, sequence.drop)
  const current = sequence.view

  const runId = event.runId
  const scoped = isTurnScoped(event.kind)
  if (scoped) {
    // A turn-scoped kind that names no turn is a frame nothing can attribute, and an
    // unattributable frame is what the run guard exists to refuse. The check is the same
    // in both modes: a record says the same thing about attribution.
    if (runId === null) return dropped(view, 'unattributed-run')
    if (mode === 'live') {
      const reason = judgeRun(current, event, runId)
      if (reason !== null) return dropped(view, reason)
    }
  }

  // A run the host has started but not yet named takes its id from its first frame. Only
  // turn content binds a run: a session-scoped frame that happened to carry a run id must
  // not re-point the view at a run it is not showing.
  const bound =
    RUN_CONTENT.includes(event.kind) && runId !== null && current.runId === null
      ? bindRun(current, runId)
      : current

  const applied = applyAgentEvent(bound, event)
  return finishWrite(applied.view, applied.overLimit)
}
