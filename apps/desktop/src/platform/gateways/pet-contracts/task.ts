/**
 * What a pet task is: the identity that tells it apart from every other task, and the
 * vocabulary of states it can be shown in.
 *
 * One of the parts `../pet-contracts` divides into, along the line §9 draws for this
 * contract. The seam is who changes the module: this one moves when the *product* gains
 * a state or a way of naming a task, while `./events` moves when the *ACP contract*
 * gains an event kind. "What can the pet show?" and "what does this frame mean?" are
 * different questions, and after the split they are different files.
 */
import type { AgentIdentity } from '../agent-contracts'

/**
 * One run, named by every fact that tells it apart from another.
 *
 * The five ACP identity fields plus the run (§6.1). They are a structured tuple and
 * not a joined string because of where the joined string leads: the upstream app keys
 * its store on `` `${agent}:${session}` `` (`windows/src/state.ts:54`) and then finds
 * a session by `endsWith(':${session}')` (`:85-89`), so two agents whose sessions
 * share a name are one entry, and `setApproval`/`clearApproval` (`:92-101`) match on
 * the session field alone. §6.1 forbids exactly this — business keys are tuples or an
 * explicit encoding, never a suffix of a concatenation. {@link petTaskToken} is the
 * only string form, and it is injective.
 */
export interface PetTaskKey extends AgentIdentity {
  /** Non-null: a task *is* a run, while `null` on the envelope means no turn owns the event. */
  runId: string
}

/** The fields a key is made of, named once so the reader below and the type cannot drift. */
const TASK_KEY_FIELDS = [
  'agentId',
  'profileId',
  'runtimeEpoch',
  'vaultId',
  'sessionId',
  'runId',
] as const

/**
 * Whether an answer is one of these keys.
 *
 * The receiving half of §6.2's 点击返回任务 runs this before it does anything with a payload, and
 * it is not a formality: the main window focuses a session by the key it is handed, and the store's
 * `focus` takes any string. A payload with a missing field would stringify into a key no session
 * answers to and quietly make the session actually on screen *unread* for every frame that arrives
 * after it — the one failure a receiver with no check can produce, and one that looks like a
 * feature working. Six non-empty strings is the whole of the check: which session they name is the
 * host's question (it minted the key), and this side only refuses what is not a key at all.
 *
 * It lives in the contract because the key is defined here and both sides of the wire need it —
 * the pet window's adapter builds one, the main window's listener reads one — and `platform/` may
 * not reach into `features/` for it.
 */
export function isPetTaskKey(value: unknown): value is PetTaskKey {
  if (typeof value !== 'object' || value === null) return false
  const key = value as Record<string, unknown>
  return TASK_KEY_FIELDS.every(
    (field) => typeof key[field] === 'string' && (key[field] as string).length > 0,
  )
}

/** Whether two keys name the same run. Compared field by field, never by a suffix. */
export function samePetTask(a: PetTaskKey, b: PetTaskKey): boolean {
  return (
    a.agentId === b.agentId &&
    a.profileId === b.profileId &&
    a.runtimeEpoch === b.runtimeEpoch &&
    a.vaultId === b.vaultId &&
    a.sessionId === b.sessionId &&
    a.runId === b.runId
  )
}

/**
 * The one encoding every key in this contract is written with: each part preceded by
 * its own length, so no two different tuples produce the same string.
 *
 * Joining with bare colons maps `{agentId: 'a:b', profileId: 'c'}` and
 * `{agentId: 'a', profileId: 'b:c'}` onto one string, and that string is what a suffix
 * match then confuses; lengths leave no such pair. Exported because the identity's
 * *session* part, without the run, is a key in its own right — the sequence space
 * belongs to a session (§6.3), and two agents sharing a session id are two sessions.
 */
export function petKeyToken(parts: readonly string[]): string {
  return parts.map((part) => `${part.length}:${part}`).join('')
}

/** The key as one string, for a map, a ledger row or a log line. */
export function petTaskToken(key: PetTaskKey): string {
  return petKeyToken([
    key.agentId,
    key.profileId,
    key.runtimeEpoch,
    key.vaultId,
    key.sessionId,
    key.runId,
  ])
}

/** Every state the pet can show, and the source of {@link PetTaskState}. */
export const PET_TASK_STATES = [
  'working',
  'waiting-input',
  'turn-finished',
  /** A limit ended it (`max-tokens`, `max-turn-requests`): reached, not achieved. */
  'stopped',
  'refused',
  'cancelled',
  'failed',
  /** The runtime went away mid-run. Never a terminal *success*, and not re-sent. */
  'interrupted',
  /**
   * The host cannot say what the task is doing, for either of two reasons: it cannot reach the
   * runtime, or the run ended for a reason this version does not know. Both are the same fact —
   * no ending can be stated — and neither is a success, a failure or an interruption, so the
   * state is one and the notice it produces names both rather than picking one of them.
   */
  'unknown',
] as const

export type PetTaskState = (typeof PET_TASK_STATES)[number]

/**
 * What the pet does about a state, kept apart from what the state *is*.
 *
 * A state is a fact; this is the pet's reaction to it, and the two must not collapse:
 * §6.2 says a run that reached a limit gets attention and no celebration, that a
 * refusal is not a success, and that a cancelled run gets neither a success sound nor
 * a failure reward — three of which are only expressible if "the pet is loud" is a
 * separate axis from "the turn ended".
 */
export type PetTaskAlert =
  /** Animate, do not interrupt. */
  | 'quiet'
  /** The turn ended normally: say "this turn finished" and claim nothing beyond it. */
  | 'turn-finished'
  /** The user is needed: a permission, a limit, a refusal, a failure, a lost runtime. */
  | 'needs-attention'

/**
 * The alert for a state, total over the union so a new state has to decide what the
 * pet does about it instead of inheriting a default (§6.2).
 *
 * The two `quiet` entries are the load-bearing ones. A limit is `needs-attention`
 * because §6.2 asks for the limit to be explained and forbids a celebration; a
 * cancellation is `quiet` because §6.2 asks for neither a success sound nor a failure
 * reward, and "no sound" is the only reaction that is neither.
 */
export const PET_ALERT_BY_STATE: { [S in PetTaskState]: PetTaskAlert } = {
  working: 'quiet',
  'waiting-input': 'needs-attention',
  'turn-finished': 'turn-finished',
  stopped: 'needs-attention',
  refused: 'needs-attention',
  cancelled: 'quiet',
  failed: 'needs-attention',
  interrupted: 'needs-attention',
  unknown: 'needs-attention',
}

/**
 * Whether a state records how a run ended, rather than a belief about one still going.
 *
 * §6.3 requires a terminal state not to be revived by an older work event. The policy
 * that refuses the revival is the notification ledger's job; which states are terminal
 * is the contract's, and `unknown` is deliberately not one — it admits the host does
 * not know, so a later event that *does* know has to be able to replace it.
 */
export function isPetTaskSettled(state: PetTaskState): boolean {
  return (
    state === 'turn-finished' ||
    state === 'stopped' ||
    state === 'refused' ||
    state === 'cancelled' ||
    state === 'failed' ||
    state === 'interrupted'
  )
}

/** What one ACP fact means for the pet (§6.2), independent of which run it concerns. */
export interface PetTaskOutcome {
  state: PetTaskState
  /**
   * The request the *host's* permission UI has to answer, when there is one to route
   * to — a click from the pet goes there and nowhere else (§6.2 「桌宠不自行授权」).
   *
   * The id is all this carries: no options, no title, no arguments, because a
   * component that had nothing to authorise with could not authorise by accident. Null
   * means "the user is needed and this host cannot say where to send them", which the
   * UI must show without an inert button (§7.2) rather than guessing a target.
   */
  permissionRequestId: string | null
}

