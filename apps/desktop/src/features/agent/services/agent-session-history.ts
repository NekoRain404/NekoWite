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
 * One function for every feature this surface gates on (`session-list` for the history control
 * itself, `session-close` for the free action on a row) rather than one per feature: the rule is
 * §3.4's, and a second copy of it is a second place for `unverified` to be read as a yes.
 */
export function capabilityAvailable(
  reports: readonly AgentCapabilityReport[],
  feature: AgentCapabilityFeature,
): boolean {
  return reports.some(
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
   * on disk. Compared against each row's, and deliberately not against the *vault id*: the id is
   * an identity, and two of them being equal to a path is a fact about the composition site
   * rather than about the contract.
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
    current: session.sessionId === input.currentSessionId,
    elsewhere: session.cwd !== input.cwd,
  }))
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
