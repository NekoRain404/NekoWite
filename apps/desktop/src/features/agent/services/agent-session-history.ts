/**
 * What the history surface decides before anything is drawn: whether this engine offers history
 * at all, and what one of its rows says.
 *
 * It is a service rather than a component's `computed` because both answers are rules with a
 * wrong version beside them, and each wrong version is a claim about the engine:
 *
 *  - **The trigger is a capability, not an affordance this app adds.** `session/list` is
 *    `sessionCapabilities.list` in the engine's own handshake, and `AgentGateway.capabilities`
 *    is where that report is read back. Only `available` draws the control: `unavailable` is the
 *    engine saying it does not answer, and `unverified` is nobody having asked — and a button
 *    drawn for either would be this window offering a method the engine never claimed (§3.4's
 *    row, and the reason `AgentCapabilityFinding` has a third arm at all).
 *  - **A row is the engine's facts and nothing else.** The title is the engine's or it is absent;
 *    a name this app made up would be a fact the engine never stated. The order is the engine's
 *    too: ACP's `SessionInfo` carries no creation time, so a client that sorted by one would be
 *    inventing the field, and `updatedAt` is the only ordering the protocol offers.
 *
 * The one thing computed *about* a row rather than read from it is the two comparisons: which
 * session is the one on screen, and whether the engine recorded this session in the folder the
 * runtime is working in now. Both are questions about *here*, and only the caller knows here.
 */

import { t } from '../../../i18n'
import type {
  AgentCapabilityFeature,
  AgentCapabilityReport,
  AgentGateway,
  AgentSessionHistory,
  AgentSessionSummary,
} from '../../../platform/gateways/agent-contracts'

/**
 * Whether the engine's own report says it answers the method behind a feature.
 *
 * `available` and nothing else — see this file's header. A missing row is the same answer as an
 * unverified one: a report this window cannot find the feature in has not reported it available.
 *
 * **`null` — no report at all — is that same answer a third time**, and the collapse is made here
 * rather than by a `?? []` at each call site, so it is one decision with a reason instead of two
 * coincidences. The reason: a control is drawn on an `available` finding and on nothing else, so a
 * report that never arrived cannot license one, and reading "nothing has answered" as a yes is the
 * failure this shape exists to prevent.
 *
 * It is *not* the same answer everywhere — a surface that has to say **why** a reader is being
 * refused owes them a different sentence per state, which is `agent-composer-attachments.ts`'s
 * `attachmentStanding` — so this collapse belongs to the question this function answers, which is a
 * boolean.
 *
 * One function for every feature this surface gates on (`session-list` for the history control
 * itself, `session-close` for the free action on a row) rather than one per feature: the rule is
 * §3.4's, and a second copy of it is a second place for `unverified` to be read as a yes.
 */
export function capabilityAvailable(
  reports: readonly AgentCapabilityReport[] | null,
  feature: AgentCapabilityFeature,
): boolean {
  return (reports ?? []).some(
    (report) => report.feature === feature && report.finding.status === 'available',
  )
}

/**
 * Free a session on the engine — the action §5.3's history list puts on a row the reader is not
 * looking at.
 *
 * **One call.** `AgentGateway.closeSession` takes an id, which is the shape this action needs: a
 * session the engine merely *lists* has no handle, because `listSessions` answers summaries and
 * `loadSession` is the only call that mints one. An earlier version of the contract took a handle
 * and this function therefore adopted the row first (`loadSession`) and closed it after —
 * two round trips, and a state with no way out: a session the runtime was already serving but not
 * showing answered "already open" to the load and had no handle to close, so it could be neither
 * reopened nor freed. Taking the id removed the state rather than working around it.
 *
 * The §6.1 boundary is the host's and is unchanged: `agent_close_session` refuses an id this app
 * never opened, so a renderer cannot free a session id it composed.
 *
 * The failure is the caller's to report: the engine would not free it, in the engine's own
 * sentence, passed through as it was received.
 */
export async function freeAgentSession(
  gateway: AgentGateway,
  sessionId: string,
): Promise<void> {
  await gateway.closeSession(sessionId)
}

/** One session, as a row draws it: the engine's facts, plus the two comparisons about here. */
export interface AgentSessionHistoryRow {
  readonly sessionId: string
  /** The engine's own title, or null when it sent none. Never a name this app wrote. */
  readonly title: string | null
  /** The folder the engine recorded the session in, as it reported it. */
  readonly cwd: string
  /** The engine's last-activity stamp, or null when it sent none. */
  readonly updatedAt: string | null
  /**
   * Whether the host holds the session, from the row's own `held` — the fact the free action is
   * offered against.
   *
   * Read, not derived: the host is the only layer that knows, and the engine cannot be asked.
   * `session/list` answers the engine's table, which outlives the process that wrote it, while the
   * host forwards closes only for ids it received an answer about (§6.1) — so a row the host does
   * not hold has a free action that can only fail, and §5.2's rule is that such a control is not
   * drawn rather than drawn and refused.
   */
  readonly held: boolean
  /** The session the panel is showing: picking it would be a load the engine refuses. */
  readonly current: boolean
  /** Recorded in a folder other than the one this runtime works in. */
  readonly elsewhere: boolean
}

export interface AgentSessionHistoryInput {
  /** The session on screen, as the panel holds it. */
  readonly currentSessionId: string
  /**
   * The directory this runtime works in — `AgentRailState`'s own `cwd`, which is the vault root
   * on disk. **This docblock is the rule's one home**: `AgentPanel.vue`'s `cwd` prop and
   * `use-agent-session-history.ts`'s option carry the value down to here and point back at it,
   * rather than restating it a second and third time.
   *
   * It is here for one comparison: a session the engine recorded in a *different* folder is a
   * different thing to reopen, and each row carries the answer (`elsewhere` below). Deliberately
   * not against the *vault id*: the id is an identity, and two of them being equal to a path is a
   * fact about the composition site rather than about the contract.
   */
  readonly cwd: string
}

/**
 * The engine's page, as rows — in the engine's order, with one comparison per row.
 *
 * No sorting and no filtering. Sorting by `updatedAt` would be this app's opinion about the
 * engine's list, and dropping the row that is already open would be this app hiding an answer the
 * engine gave: it is drawn, marked, and inert (`AgentPanel` reads `current` and does not call).
 */
export function agentSessionHistoryRows(
  page: AgentSessionHistory,
  input: AgentSessionHistoryInput,
): AgentSessionHistoryRow[] {
  return page.sessions.map((session: AgentSessionSummary) => ({
    sessionId: session.sessionId,
    title: session.title,
    cwd: session.cwd,
    updatedAt: session.updatedAt,
    held: session.held,
    current: session.sessionId === input.currentSessionId,
    elsewhere: session.cwd !== input.cwd,
  }))
}

/**
 * The rows a query keeps, in the engine's order.
 *
 * A rule rather than a `computed` inside the popup, for the reason this file exists: each wrong
 * version of it is a claim about the engine, and the claims are the kind a reader cannot check.
 *
 *  - **A row matches on the two facts it carries that the engine stated** — its title, and the
 *    folder the engine recorded it in. That is Zed's pair (`threads_archive_view.rs:294-318`:
 *    the title, else the basename of a worktree path), and it is a pair because they are the two
 *    things a reader looking for a session remembers: its name, or where it was.
 *  - **Nothing this app wrote matches.** The sentence drawn where the engine sent no title
 *    (`agent.panel.history.untitled`) is this app's words, and so is the id the row is keyed by,
 *    which is drawn nowhere. A row returned for either would be a match the row's own visible
 *    facts do not explain — the reader would see a row that contains nothing they typed. That is
 *    also the one place this deliberately differs from Zed: it matches fuzzily
 *    (`fuzzy_match_positions`) and paints the matched characters, so a surprising hit there is
 *    still a visible one; a containment test with no highlighting has to be narrower instead.
 *  - **An empty query is every row, and the same rows.** Whitespace is not a query — a field the
 *    reader has emptied must not filter the list down to nothing — and the engine's own order and
 *    set are returned untouched rather than re-sorted, which is the same rule the rows below are
 *    built under.
 *
 * A plain case-insensitive containment rather than a fuzzy match: `needle` in `haystack` is a
 * sentence a reader can verify by looking at the row, and it is what the copy promises.
 */
export function filterSessionRows(
  rows: readonly AgentSessionHistoryRow[],
  query: string,
): readonly AgentSessionHistoryRow[] {
  const needle = query.trim().toLowerCase()
  if (needle === '') return rows
  return rows.filter(
    (row) =>
      (row.title ?? '').toLowerCase().includes(needle) ||
      // Not `elsewhere` and not the rendered path: the whole string the engine sent, so a
      // component of it — a folder's own name — is a query the row answers.
      row.cwd.toLowerCase().includes(needle),
  )
}

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
/** Past this, a count of days stops being something a reader converts, so the engine's own
 *  stamp is shown instead of a number this app worked out. */
const RECENT = 30 * DAY

/**
 * How long ago the engine last touched a session, or null when it sent no stamp.
 *
 * The thresholds are the only opinion here; every value shown is the engine's stamp read one way
 * or another, and the two ways are both honest:
 *
 *  - within the recent window, a rounded count against the clock the caller passes in;
 *  - outside it — and for a stamp this window cannot parse, or one dated in the future by a
 *    machine whose clock disagrees with this one — the engine's own ISO date, verbatim. That is
 *    the string the engine sent, so it cannot be wrong about the engine, and it says "old" well
 *    enough without this app guessing how old.
 *
 * `now` is a parameter rather than `Date.now()` so the thresholds are testable, and so a list
 * drawn in one tick reads the clock once.
 */
export function describeSessionAge(updatedAt: string | null, now: number): string | null {
  if (updatedAt === null) return null
  const at = Date.parse(updatedAt)
  if (Number.isNaN(at)) return updatedAt
  const elapsed = now - at
  // A stamp in the future is a machine whose clock disagrees with this one, and there is no count
  // of minutes that is true about it — so the engine's own date is shown and nothing is computed.
  if (elapsed < 0) return updatedAt.slice(0, 10)
  if (elapsed < MINUTE) return t('agent.panel.history.age.now')
  if (elapsed >= RECENT) return updatedAt.slice(0, 10)
  if (elapsed < HOUR) return t('agent.panel.history.age.minutes', { n: Math.floor(elapsed / MINUTE) })
  if (elapsed < DAY) return t('agent.panel.history.age.hours', { n: Math.floor(elapsed / HOUR) })
  return t('agent.panel.history.age.days', { n: Math.floor(elapsed / DAY) })
}
