/**
 * The session view: the state one session's stream reduces to, and the state
 * machine that says which transitions are legal.
 *
 * The module set answers different questions, and this is the one that says what
 * the state *is*:
 *
 *  - `agent-timeline.ts`  what a conversation row is, and how one grows
 *  - this file            the state, its composite identity, and its transitions
 *  - `agent-event-reducer.ts`   which incoming events may change it
 *  - `agent-session-snapshot.ts` the snapshot handshake that re-establishes it
 *
 * Every function here takes a view and returns a view. Nothing throws, nothing
 * reads a clock, a random number or a locale, and a refused transition returns the
 * view it was given rather than a mutated one — which is what lets a test assert
 * both that a dropped event left the state untouched and that the *same object*
 * came back.
 *
 * Three transitions are not events. The contract has no `run-started`,
 * `permission-answered` or `host-failed` kind, so the three moments where the host
 * knows something the stream cannot say — {@link startAgentRun},
 * {@link resolvePermission}, {@link failAgentRun} — are modelled here rather than
 * bent into an event that would have to pretend a frame arrived.
 *
 * `idle` and `starting` describe the runtime before a session exists — the contract
 * says the same of the snapshot — so a view, which is always bound to one open
 * session, never reports them. A snapshot claiming one is refused in the reducer
 * rather than accepted into a state the panel cannot render.
 */

import type {
  AgentCommand,
  AgentConfigOption,
  AgentContextUsage,
  AgentEvent,
  AgentFailureCode,
  AgentIdentity,
  AgentPlanEntry,
  AgentRunResult,
  AgentSessionState,
} from '../../../platform/gateways/agent-contracts'
import type { AgentTimelineEntry, AgentUserEntry } from './agent-timeline'

/**
 * A hole in the stream: `expected` never arrived and `received` did.
 *
 * It is a fact about the record rather than about any one event, and it is
 * deliberately *not* cleared when the view's position moves past it — a position
 * that has already stepped over a hole can never fill it, so forgetting the hole
 * would turn a partial record into one that looks complete. Only
 * {@link initialAgentSessionView} clears it, because only a rebuilt view starts
 * from the host's own record again.
 */
export interface AgentSequenceGap {
  expected: number
  received: number
}

/** The default number of timeline entries a session view holds before the run
 *  producing them is aborted. Exported so a test can drive the abort without
 *  building the default's worth of entries. */
export const AGENT_TIMELINE_LIMIT = 2000

export interface AgentSessionViewOptions {
  /**
   * The entry count the view will not exceed. It is checked on what a run adds to
   * the timeline: a run that crosses it is aborted and reported rather than
   * trimmed, because §6.2 forbids dropping data to stay inside a bound. The one
   * entry that crosses the line is *kept* — the abort is the report, not a second
   * loss.
   */
  timelineLimit?: number
}

/** A pending permission request, kept as the whole event rather than its payload.
 *
 *  The payload carries no run id, so a request stored as a payload alone could not
 *  be matched to the turn that asked for it — and an answer bound to the wrong turn
 *  is what §6.3 forbids. The snapshot keeps them as events for the same reason, and
 *  this holds them the same way so the two agree. */
export type AgentPermissionEvent = Extract<AgentEvent, { kind: 'permission-request' }>

/**
 * What one session's stream has reduced to.
 *
 * The composite identity is `readonly` because the view is *bound* to one session:
 * an event, a snapshot and a permission answer are each checked against these five
 * fields before they may change anything, and a view that could re-point itself at
 * another session would make that check meaningless.
 */
export interface AgentSessionView {
  readonly identity: AgentIdentity
  state: AgentSessionState
  /** The run this view is bound to: the one in flight, or the one that just ended.
   *  `null` between `startAgentRun` and the run's first frame — the host's only
   *  window in which a run has started but is not yet named. */
  runId: string | null
  /** Run ids whose end this view has seen.
   *
   *  This is what keeps a cancelled run's late frame from coming back through a
   *  window the bound run alone cannot close: after a cancel, the next prompt
   *  clears `runId` for its own run, and without this list the first late frame of
   *  the dead run would bind it and be applied. Bounded, because it is bookkeeping
   *  about runs rather than the runs themselves. */
  closedRuns: string[]
  /** The sequence of the last event applied or adopted; a subscription continues
   *  at `sequence + 1`. */
  sequence: number
  gap: AgentSequenceGap | null
  timeline: AgentTimelineEntry[]
  permissions: AgentPermissionEvent[]
  commands: AgentCommand[]
  plan: AgentPlanEntry[]
  modeId: string | null
  config: AgentConfigOption[]
  usage: AgentContextUsage | null
  /** Vault paths the session's turns touched, in the order each was first
   *  reported. A path the engine names twice is named once here. */
  changedFiles: string[]
  /** The engine's title for the session, or null before it sends one. `null` is
   *  also what a *cleared* title means — an update that does not mention the title
   *  at all carries `undefined`, and leaves this alone. */
  title: string | null
  updatedAt: string | null
  /** How the last run ended, with the usage it reported. Kept apart from `state`
   *  because four of the five stop reasons are ordinary endings: a token ceiling is
   *  not a failure, and folding them together would lose the reason. */
  lastResult: AgentRunResult | null
  /** Why a run did not run to its own end. Cleared when a new run starts, because
   *  it describes the run the view is bound to and not a history of the session. */
  failure: { code: AgentFailureCode; message: string } | null
  /** The counter behind the timeline's row ids. */
  entrySeq: number
  /** The entry count at which this view aborts the run producing them. */
  timelineLimit: number
}

/** The states in which a run is in flight. */
export const LIVE_STATES: readonly AgentSessionState[] = ['running', 'waiting-permission']

/** The states that say how the last run ended; they stay until the next prompt. */
export const TERMINAL_STATES: readonly AgentSessionState[] = ['completed', 'cancelled', 'failed']

export function isRunLive(view: AgentSessionView): boolean {
  return LIVE_STATES.includes(view.state)
}

/** Every field that makes up the composite identity, in the order they are
 *  checked. Exported so a test can hold the reducer to each of them rather than to
 *  the one that happened to be checked first. */
export const IDENTITY_FIELDS = [
  'agentId',
  'profileId',
  'runtimeEpoch',
  'vaultId',
  'sessionId',
] as const

export type AgentIdentityField = (typeof IDENTITY_FIELDS)[number]

/**
 * The first identity field on which `claimed` disagrees with `held`, or null.
 *
 * The five defend against different things, and their order is the order of how
 * wrong the frame is: a different agent or session is a frame that was never ours,
 * a different epoch is ours but from a runtime instance that is over, and a
 * different vault is ours from a vault this window no longer shows. The reducer
 * reports which field failed, so a test names the defence it exercised instead of
 * asserting a generic refusal.
 */
export function identityMismatch(
  held: AgentIdentity,
  claimed: AgentIdentity,
): AgentIdentityField | null {
  for (const field of IDENTITY_FIELDS) {
    if (held[field] !== claimed[field]) return field
  }
  return null
}

/**
 * The key a session's view, draft, scroll position and unread flag are stored
 * under.
 *
 * All five identity fields, because two agents can use the same session id and a
 * restarted runtime's session is not the one the window was showing. NUL as the
 * separator because the ids are opaque strings from two different engines, so any
 * printable separator could also be part of one.
 */
export function sessionKey(identity: AgentIdentity): string {
  return IDENTITY_FIELDS.map((field) => identity[field]).join('\x00')
}

/** The bound on ended run ids. A run that ended long ago must not be bound by a
 *  frame that arrives now; a frame claiming a run from before this window is
 *  refused as foreign rather than silently bound. */
const MAX_CLOSED_RUNS = 16

/** The tool statuses that mean the call is still running — what a run's end turns
 *  into `cancelled`. */
const NOT_SETTLED = ['pending', 'in_progress']

export function initialAgentSessionView(
  identity: AgentIdentity,
  options: AgentSessionViewOptions = {},
): AgentSessionView {
  return {
    identity,
    // A session that exists is ready: `idle` and `starting` belong to the runtime
    // before `openSession` returned, and this view is created after it.
    state: 'ready',
    runId: null,
    closedRuns: [],
    sequence: 0,
    gap: null,
    timeline: [],
    permissions: [],
    commands: [],
    plan: [],
    modeId: null,
    config: [],
    usage: null,
    changedFiles: [],
    title: null,
    updatedAt: null,
    lastResult: null,
    failure: null,
    entrySeq: 0,
    timelineLimit: options.timelineLimit ?? AGENT_TIMELINE_LIMIT,
  }
}

/**
 * Remember that a run has ended.
 *
 * The list is capped and the newest id is first, because the frames that arrive
 * late are the frames of the run that just ended, not of a run from an hour ago.
 */
export function markRunClosed(view: AgentSessionView, runId: string): AgentSessionView {
  return {
    ...view,
    closedRuns: [runId, ...view.closedRuns.filter((id) => id !== runId)].slice(0, MAX_CLOSED_RUNS),
  }
}

/**
 * Name the run the host has already started.
 *
 * The user's own row was written before the run had an id — the contract does not
 * tell the host which run a prompt started — so it is given the id here. That is
 * the only place a `null` run id is ever rewritten, which is why a row can carry
 * the null case without a second flag to say which null it is.
 */
export function bindRun(view: AgentSessionView, runId: string): AgentSessionView {
  return {
    ...view,
    runId,
    timeline: view.timeline.map((entry) =>
      entry.kind === 'user' && entry.runId === null ? { ...entry, runId } : entry,
    ),
  }
}

/**
 * Close a run.
 *
 * Every ending goes through here — a `run-finished`, a `run-failed`, a prompt the
 * gateway refused, the host's own abort — so the three things an ended run owes the
 * view happen once rather than once per ending:
 *
 *  - the run id is remembered as ended, which is what refuses its late frames;
 *  - its unanswered permission requests are dropped, because the buttons they would
 *    render have nothing left to answer (§6.2: a process exit ends every hanging
 *    request, and the requests a finished turn left behind are dead);
 *  - its tool calls still `pending` or `in_progress` become `cancelled`. The
 *    contract says the host derives that status and must derive it rather than
 *    invent it, and this is the only moment it can: whatever ended the run, nothing
 *    is executing those calls any more, and leaving them spinning would show work
 *    in progress on a run that is over.
 */
export function endRun(
  view: AgentSessionView,
  runId: string | null,
  state: AgentSessionState,
): AgentSessionView {
  // No run to close: the state still moves, but there is nothing whose requests or
  // calls could be abandoned, and filtering by a null id would filter by a value no
  // request and no call ever carries.
  if (runId === null) return { ...view, state, runId: null }
  return {
    ...markRunClosed(view, runId),
    state,
    runId,
    permissions: view.permissions.filter((request) => request.runId !== runId),
    timeline: view.timeline.map((entry) =>
      entry.kind === 'tool' && entry.runId === runId && NOT_SETTLED.includes(entry.status)
        ? { ...entry, status: 'cancelled' }
        : entry,
    ),
  }
}

/**
 * The transition a `prompt` call is: the run begins and the user's message joins
 * the timeline.
 *
 * Refused while a run is live — §6.2 allows one active generation per session, and
 * a second input waits in the composer's draft rather than being sent quietly
 * beside the first. The refusal is a return value rather than a throw, because the
 * caller (the store) has something to do with it: keep the text.
 */
export function startAgentRun(
  view: AgentSessionView,
  text: string,
): { view: AgentSessionView; accepted: boolean } {
  if (isRunLive(view)) return { view, accepted: false }
  const row: AgentUserEntry = {
    kind: 'user',
    id: view.entrySeq,
    runId: null,
    text,
    origin: 'host',
  }
  return {
    view: {
      ...view,
      state: 'running',
      runId: null,
      failure: null,
      entrySeq: view.entrySeq + 1,
      timeline: [...view.timeline, row],
    },
    accepted: true,
  }
}

/**
 * The transition an answered permission is: the request leaves the view and the run
 * it suspended resumes.
 *
 * It is not an event because the engine never sends one — the host's answer is what
 * moves the turn, and the engine's reaction to it arrives as ordinary output.
 * Refused when the request is unknown, when the run it belongs to is not the live
 * one (§6.3 binds a request to its turn and not to its id alone), or when the view
 * is not waiting on anything.
 */
export function resolvePermission(
  view: AgentSessionView,
  requestId: string,
): { view: AgentSessionView; accepted: boolean } {
  const request = view.permissions.find((entry) => entry.payload.requestId === requestId)
  if (request === undefined || !isRunLive(view) || request.runId !== view.runId) {
    return { view, accepted: false }
  }
  const permissions = view.permissions.filter((entry) => entry !== request)
  // Back to running only when nothing else is pending: a turn can ask about several
  // calls, and resuming on the first answer would offer a send button for a run that
  // is still suspended on the second.
  const waiting = permissions.some((entry) => entry.runId === view.runId)
  return {
    view: { ...view, permissions, state: waiting ? view.state : 'running' },
    accepted: true,
  }
}

/**
 * The transition a refused gateway call is: the run the host started could not be
 * delivered at all.
 *
 * Without it a rejected `prompt` would leave the view saying `running` with nothing
 * behind it — the failure the lifecycle spec found in Zed, where a dead agent leaves
 * a thread marked as running. The failure is recorded even when no run is live, so
 * the reason is not lost; the state only moves to `failed` from a run that was
 * actually in flight.
 */
export function failAgentRun(
  view: AgentSessionView,
  code: AgentFailureCode,
  message: string,
): AgentSessionView {
  const failure = { code, message }
  if (!isRunLive(view)) return { ...view, failure }
  return { ...endRun(view, view.runId, 'failed'), failure }
}
