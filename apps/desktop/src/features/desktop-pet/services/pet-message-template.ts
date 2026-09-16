/**
 * The words a task row shows: which line, whose line, and what a line may never do.
 *
 * Ported from `windows/src/bubble.ts` (`messageFor` 263-278, `bubbleLine` and `bubbleLines` in
 * `activity.ts` 199-217) and `windows/src/activity.ts`'s per-mood pools, with the storage keys
 * dropped: upstream reads `ap_msg_*` out of `localStorage` on the render path, and §5.3 gives the
 * settings one writer instead. The lines arrive as a value here, so nothing in this file knows
 * where a phrase came from.
 *
 * Two behaviours are ports and worth naming, because both are the reason the file exists rather
 * than a template string in a component:
 *
 *  - **A task keeps its line.** Upstream picks with a djb2 hash of the session id so the phrase
 *    does not re-roll under the user's cursor between two renders (`state.ts` 1-4, `activity.ts`
 *    212-218). The same pick is kept here, seeded with the contract's own injective
 *    {@link petKeyToken} of the session rather than with a joined string — §6.1's rule about
 *    business keys applies to the seed too, where two agents sharing a session id would otherwise
 *    pick the same line for no reason anybody could see.
 *  - **The label is not the line.** §5.2's 「状态标签不可被自定义文案伪装成另一种结果」 is the reason
 *    {@link petStateLabel} is a separate function over the state and reads no phrase at all: the
 *    state label is what the row is, and a written line is what the pet says about it. A phrase
 *    can say anything; it cannot say which state the task is in.
 *
 * What it deliberately does not do is escape, sanitise or strip markup. These strings are handed
 * to Vue as text, which renders them as characters — the one place escaping belongs. A second
 * escape here would produce `&lt;b&gt;` in a bubble, and a service that both escapes and is escaped
 * is a bug that only shows up with text nobody tested.
 */
import { petKeyToken, type PetTaskState } from '../../../platform/gateways/pet-contracts'

/**
 * The built-in lines, one pool per state, keyed by the contract's own union.
 *
 * Total on purpose: a state added to `PET_TASK_STATES` fails to compile here rather than rendering
 * a blank row, which is the failure that would be noticed last. The wording keeps §6.2's
 * distinctions visible — the line for a turn that hit a limit does not read like the line for one
 * that finished, and neither of them claims the user's goal was achieved.
 */
export const PET_MESSAGE_PHRASES: { [S in PetTaskState]: readonly string[] } = {
  working: ['Working on it…', 'On it…', 'Still going…'],
  'waiting-input': ['Waiting for your answer', 'This one needs you', 'Your turn — over to you'],
  // §6.2: 本轮执行结束, and nothing beyond it — the turn is what finished, not the user's goal.
  'turn-finished': ['This turn is done', 'The turn finished', 'That turn is complete'],
  stopped: ['Stopped at a limit', 'A limit ended this turn'],
  refused: ['The engine declined to continue', 'Refused — this one cannot go on'],
  cancelled: ['Cancelled', 'Stopped by you'],
  failed: ['Something went wrong', 'This turn failed'],
  interrupted: ['The runtime went away', 'Lost the runtime mid-turn'],
  unknown: ["Can't tell what this one is doing", 'The host cannot say'],
}

/**
 * What a task is, as opposed to what the pet says about it (§6.2).
 *
 * Six of these are six different ways for a turn to end — finished, limited, refused, cancelled,
 * failed, interrupted — and §6.2 requires that a user can tell them apart. That is the reason they
 * are six strings and not one "Done".
 */
export const PET_STATE_LABELS: { [S in PetTaskState]: string } = {
  working: 'Working',
  'waiting-input': 'Needs you',
  'turn-finished': 'Turn finished',
  stopped: 'Limit reached',
  refused: 'Refused',
  cancelled: 'Cancelled',
  failed: 'Failed',
  interrupted: 'Interrupted',
  unknown: 'Unknown',
}

/** The state's own name; `overrides` is the i18n path (§10.1), still keyed by state. */
export function petStateLabel(
  state: PetTaskState,
  overrides?: Partial<Record<PetTaskState, string>>,
): string {
  const written = overrides?.[state]
  return written && written.trim() ? written : PET_STATE_LABELS[state]
}

/**
 * Custom lines, keyed by agent id and then by state.
 *
 * A per-agent key is an arbitrary string rather than an enum: §5.2 requires the list to come from
 * the current agent registry and to work for an engine nobody has heard of, so an unknown key is a
 * line for an engine this build does not know — not a value to reject.
 */
export type PetMessagePhrases = Readonly<
  Record<string, Partial<Record<PetTaskState, readonly string[]>>>
>

/** The key every agent matches, for a line the user wrote once and wants everywhere. */
export const PET_MESSAGE_ANY_AGENT = '*'

/** The placeholders a phrase may carry. Deliberately not including the state: see the header. */
export interface PetPhraseFields {
  agent: string
  session: string
}

const PLACEHOLDER = /\{(\w+)\}/g

/**
 * A sentence with its `{name}` placeholders filled in.
 *
 * A name this does not know is left as written rather than erased: a mistyped placeholder is a
 * thing the user can see and fix, while a silently dropped one leaves a sentence that reads as if
 * it had always been written that way.
 */
export function fillPetLabel(text: string, fields: Readonly<Record<string, string>>): string {
  return text.replace(PLACEHOLDER, (whole, name: string) => fields[name] ?? whole)
}

/** {@link fillPetLabel} for the two fields a task phrase may carry. */
export function renderPetPhrase(phrase: string, fields: PetPhraseFields): string {
  return fillPetLabel(phrase, { agent: fields.agent, session: fields.session })
}

/**
 * Upstream's pick, kept exactly (`activity.ts` 213-217): djb2 over the seed, modulo the pool.
 *
 * Not a random source and not indexed by time: the point of a hash is that the same task gets the
 * same line on every render, on every window, and after a reload.
 */
export function pickPetPhrase(pool: readonly string[], seed: string): string {
  if (pool.length === 0) return ''
  let hash = 5381
  for (const character of seed) hash = (Math.imul(hash, 33) + character.charCodeAt(0)) | 0
  return pool[Math.abs(hash) % pool.length] ?? ''
}

/** The user's lines for one agent and state, blanks dropped the way upstream drops them. */
function writtenLines(
  phrases: PetMessagePhrases | undefined,
  agentId: string,
  state: PetTaskState,
): readonly string[] {
  return (phrases?.[agentId]?.[state] ?? []).map((line) => line.trim()).filter(Boolean)
}

/**
 * Which pool answers for this agent and state: its own lines, then the ones written for every
 * agent, then the built-in pool (upstream's `bubbleLines`, `activity.ts` 199-210).
 */
export function petPhrasePool(
  phrases: PetMessagePhrases | undefined,
  agentId: string,
  state: PetTaskState,
): readonly string[] {
  const own = writtenLines(phrases, agentId, state)
  if (own.length > 0) return own
  const shared = writtenLines(phrases, PET_MESSAGE_ANY_AGENT, state)
  if (shared.length > 0) return shared
  return PET_MESSAGE_PHRASES[state]
}

export interface PetTaskMessageInput {
  state: PetTaskState
  /** Part of the seed, so a task keeps its line across renders. */
  agentId: string
  /** The other half of the seed. */
  sessionId: string
  /** What `{agent}` resolves to — the display name where a registry has one, the id otherwise. */
  agentLabel?: string
  phrases?: PetMessagePhrases
}

/** The line one task shows, stable for that task. */
export function petTaskMessage(input: PetTaskMessageInput): string {
  const pool = petPhrasePool(input.phrases, input.agentId, input.state)
  const seed = petKeyToken([input.agentId, input.sessionId])
  return renderPetPhrase(pickPetPhrase(pool, seed), {
    agent: input.agentLabel ?? input.agentId,
    session: input.sessionId,
  })
}

/**
 * A duration as the mac style upstream formats it: `5s`, `3m`, `1h 4m` (`bubble.ts` 285-291).
 *
 * Two guards are added to the port. A clock that moved is not a negative age — `updatedAt` is the
 * host's clock (§6.1) and `now` is the caller's, so a second of skew between them is normal and a
 * row reading `-1s` is a row the user reads as a broken app. And a value that is not a time at all
 * yields nothing, which the row renders as no elapsed field rather than as `NaNs`.
 */
export function petElapsed(updatedAt: number, now: number): string {
  if (!Number.isFinite(updatedAt) || !Number.isFinite(now)) return ''
  const seconds = Math.max(0, Math.floor((now - updatedAt) / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

/**
 * The words the bubble's own chrome shows — the sentences that are not about a task at all.
 *
 * They live beside the phrases for the reason the phrases are here: this window does not import
 * the application's dictionary (§7.1, asserted by `app/desktop-pet-entry.test.ts`), so every
 * sentence it shows arrives from the caller. §10.1 gives the pet its own namespace to the
 * integrator, and these are its keys: the defaults below are what the pet says until that
 * namespace lands, and an override is how it says something else.
 *
 * Types rather than a values object, because these are *defaults* the components fall back to one
 * field at a time: a caller that has translated four strings should not have to supply the fifth.
 */
export interface PetTaskListLabels {
  /** Shown when the filter excludes every task, so the surface is never a box with nothing in it. */
  empty: string
  /** The rows the cap left out. `{count}`. */
  more: string
  /**
   * The name of the box the rows scroll in, which is focusable for exactly that reason: it is what
   * a keyboard user hears when focus lands on it, and it is how they reach a row below the fold.
   */
  rows: string
  /** A row's accessible name — the state is always in it, whatever the token layout hides. */
  row: string
  /** The heading over one engine's rows. `{agent}`, `{count}`. */
  group: string
  /** The pager's own name. */
  pages: string
  /** One dot. `{page}`, `{total}`. */
  page: string
  /** Compact mode's fold, closed. `{count}`. */
  foldOpen: string
  /** Compact mode's fold, open. */
  foldClose: string
  /** Compact mode's heading. `{count}`. */
  summary: string
  /** Compact mode's heading when more than one engine is in the list. `{count}`, `{agents}`. */
  summaryAgents: string
}

export const PET_TASK_LIST_LABELS: PetTaskListLabels = {
  empty: 'Nothing running right now.',
  more: '+{count} more',
  rows: 'Task rows',
  row: '{agent} {state}: {message}',
  group: '{agent} {count}',
  pages: 'Task pages',
  page: 'Page {page} of {total}',
  foldOpen: '+{count} more',
  foldClose: 'Show fewer',
  summary: '{count} running',
  summaryAgents: '{count} running · {agents} engines',
}

/** The words the right-click menu shows. */
export interface PetContextMenuLabels {
  /** The menu's own name, for the keyboard and the screen reader. */
  menu: string
  tasks: string
  settings: string
  hide: string
  /** Why "show tasks" cannot be picked: §7.2 says a capability that is not there is stated. */
  noTasks: string
}

export const PET_CONTEXT_MENU_LABELS: PetContextMenuLabels = {
  menu: 'Pet menu',
  tasks: 'Show tasks',
  settings: 'Settings…',
  hide: 'Hide',
  noTasks: 'Nothing is running',
}
