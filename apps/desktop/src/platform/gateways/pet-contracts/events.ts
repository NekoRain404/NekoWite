/**
 * What an ACP fact means for a task: §6.2's table, as a total mapping.
 *
 * Every table here is total over the ACP vocabulary it keys — the event kinds, the five
 * stop reasons, the failure codes — so a value added to the ACP contract is a compile
 * error in this file rather than a case that falls through to a default. That is what
 * lets the ACP owner widen their contract without this one drifting from it silently.
 *
 * The rows are also where §6.2's prohibitions live: no percentage is guessed from a
 * lull, a ceiling is not a success, a refusal is not a success, a cancellation is
 * neither a success nor a failure, and a lost runtime is never read as done.
 */
import type {
  AgentEvent,
  AgentEventKind,
  AgentFailureCode,
  AgentPayloads,
  AgentRunEnding,
  AgentSessionSnapshot,
  AgentSessionState,
} from '../agent-contracts'
import type { PetTaskOutcome, PetTaskState } from './task'

/**
 * The failure codes that mean the runtime carrying the task is gone, rather than that
 * the turn failed.
 *
 * §6.2 keeps these apart: `run-failed` from a runtime that is still there is `failed`
 * with its detail in the main panel, while a runtime that exited is `interrupted` —
 * there is no panel left to hold the detail, and §6.2 forbids both reading it as done
 * and re-sending a task that may already have had side effects. Exported so this one
 * judgement sits in one reviewable place rather than inside a match arm.
 */
export function isRuntimeLoss(code: AgentFailureCode): boolean {
  return code === 'process-exited' || code === 'runtime-unavailable'
}

/** §6.2's failure rows: a cancellation is not a failure, and a lost runtime is not one either. */
export function petStateFromFailure(code: AgentFailureCode): PetTaskState {
  if (code === 'cancelled') return 'cancelled'
  if (isRuntimeLoss(code)) return 'interrupted'
  return 'failed'
}

/**
 * §6.2's stop-reason table, total over every ending the contract can report — the five reasons,
 * and the one arm for an ending whose reason this version does not know.
 *
 * That arm is `unknown`, never `turn-finished`: §6.2 forbids asserting a normal ending for a turn
 * whose ending is not known. The host's own projection makes the same call on the same frame
 * (`desktop_pet::task_projection::outcomes`, `state_from_stop_reason`), and `unknown` is
 * deliberately not settled, so a later frame that does know can still replace it.
 */
const PET_STATE_BY_STOP_REASON: { [S in AgentRunEnding]: PetTaskState } = {
  'end-turn': 'turn-finished',
  'max-tokens': 'stopped',
  'max-turn-requests': 'stopped',
  refusal: 'refused',
  cancelled: 'cancelled',
  unrecognised: 'unknown',
}

/**
 * §6.2's snapshot row: only a snapshot that is *carrying a run* produces a pet state.
 *
 * `running` is the row the plan spells out — `working`, with no percentage guessed
 * from anything and no completion read into a lull. The three `null` entries are the
 * point of the function: `idle`/`ready` describe a runtime with no turn going, and
 * `completed` says a turn ended without saying *how* it ended. The stop reason lives
 * only in `run-finished`, so a projection that turned `completed` into
 * `turn-finished` would be asserting a normal ending for a turn that may have hit a
 * ceiling — which is the guess §6.2 forbids. `cancelled` and `failed` do say how, so
 * they project.
 */
const PET_STATE_BY_SESSION_STATE: { [S in AgentSessionState]: PetTaskState | null } = {
  idle: null,
  starting: null,
  ready: null,
  running: 'working',
  'waiting-permission': 'waiting-input',
  completed: null,
  cancelled: 'cancelled',
  failed: 'failed',
}

/**
 * The pet state a session snapshot reports, or `null` when the snapshot does not
 * determine one.
 *
 * §6.1 is why a snapshot is an input at all: a run's start and a permission's release
 * are not events in the ACP vocabulary, so they come from the host's own view of the
 * session rather than from guessing that a text token means one of them.
 */
export function petOutcomeFromSessionState(
  state: AgentSessionState,
  pendingRequestId: string | null = null,
): PetTaskOutcome | null {
  const projected = PET_STATE_BY_SESSION_STATE[state]
  if (projected === null) return null
  return {
    state: projected,
    permissionRequestId: projected === 'waiting-input' ? pendingRequestId : null,
  }
}

/**
 * The same, for a caller holding a snapshot: the request to route to is the snapshot's
 * oldest unanswered one, which is the one the user has to deal with first. Snapshots
 * never evict unanswered requests (§6.1 「背压不能丢权限请求」), so this is the whole
 * set of them and not a window onto it.
 */
export function petOutcomeFromSnapshot(snapshot: AgentSessionSnapshot): PetTaskOutcome | null {
  return petOutcomeFromSessionState(
    snapshot.state,
    snapshot.permissions[0]?.payload.requestId ?? null,
  )
}

/**
 * The pet state a host reports when it loses the runtime (§6.2's last row).
 *
 * Two conditions rather than one because they do not say the same thing:
 * `runtime-crashed` is knowledge — a run was in flight and was cut off —
 * while `connection-lost` is the absence of it, since a host it cannot reach cannot
 * say what any task is doing. Neither may ever be shown as done, and neither is a
 * reason to re-send the task: a run that was cut off may already have written files.
 */
export type PetRuntimeLoss = 'runtime-crashed' | 'connection-lost'

export function petOutcomeFromRuntimeLoss(loss: PetRuntimeLoss): PetTaskOutcome {
  return {
    state: loss === 'runtime-crashed' ? 'interrupted' : 'unknown',
    permissionRequestId: null,
  }
}

/** A kind the pet holds no state for. Takes its payload and ignores it. */
function noPetFact(): null {
  return null
}

/**
 * Every ACP kind, and what it means for the pet. Most kinds mean nothing: a streamed
 * chunk is not a start signal and a pause in one is not a completion, so only three
 * kinds are facts about a task's state.
 *
 * The table is written out in full, with the no-op repeated, for the reason
 * `agent-contracts/validation.ts` writes its reader table in full: a kind added to the
 * ACP contract has to appear here, and the report of its absence is a missing property
 * rather than a payload that silently reaches nothing.
 */
const PET_REACTIONS: {
  [K in AgentEventKind]: (payload: AgentPayloads[K]) => PetTaskOutcome | null
} = {
  'text-delta': noPetFact,
  'user-delta': noPetFact,
  'thought-delta': noPetFact,
  'tool-update': noPetFact,
  'permission-request': (payload) => ({
    state: 'waiting-input',
    permissionRequestId: payload.requestId,
  }),
  'commands-changed': noPetFact,
  'plan-changed': noPetFact,
  'mode-changed': noPetFact,
  'config-changed': noPetFact,
  'session-changed': noPetFact,
  'usage-changed': noPetFact,
  'files-changed': noPetFact,
  'run-finished': (payload) => ({
    state: PET_STATE_BY_STOP_REASON[payload.stopReason],
    permissionRequestId: null,
  }),
  'run-failed': (payload) => ({
    state: petStateFromFailure(payload.code),
    permissionRequestId: null,
  }),
}

/**
 * What one event means for the pet, or `null` when it means nothing about a task.
 *
 * Payload only: the event's identity, its run and its place in the stream are not read
 * here. That is deliberate and matches the ACP validator's own boundary — ordering,
 * duplication and staleness are properties of a *sequence*, so they belong to whatever
 * holds the sequence, not to a per-frame translation.
 */
export function petOutcomeFromEvent(event: AgentEvent): PetTaskOutcome | null {
  // The reader map is what correlates kind with payload, and TypeScript cannot follow
  // a lookup through it; this is the module's one cast, made for the same reason and
  // in the same shape as `agent-contracts/validation.ts`.
  const react = PET_REACTIONS[event.kind] as (
    payload: AgentPayloads[AgentEventKind],
  ) => PetTaskOutcome | null
  return react(event.payload)
}
