/**
 * Readers for the session's own state: mode, configuration, metadata, context usage,
 * the capability report and how a run ended.
 *
 * Grouped because these are the payloads that describe the session rather than one
 * turn's output, and because they are the ones the protocol marks lenient on the
 * wire (`x-deserialize-default-on-error`, `x-deserialize-skip-invalid-items`): by the
 * time a frame reaches here the Rust layer has already defaulted or skipped whatever
 * it could, so this strict reading is the last place a dropped field can be noticed
 * at all.
 */

import type {
  AgentConfigChoice,
  AgentConfigOption,
  AgentConfigValue,
  AgentContextUsage,
  AgentCost,
  AgentPayloads,
  AgentRunEnding,
  AgentRunResult,
  AgentUsage,
} from '../payloads'
import { AGENT_STOP_REASONS } from '../payloads'
import type {
  AgentCapabilityDeclaration,
  AgentCapabilityFeature,
  AgentCapabilityFinding,
  AgentCapabilityReport,
  AgentSessionHistory,
  AgentSessionSummary,
} from '../gateway'
import { AGENT_CAPABILITY_FEATURES } from '../gateway'
import { isAgentFailureCode } from '../failure'
import { asRecord, count, maybeStr, member, nonEmpty, str } from './fields'

export function readModeChanged(raw: unknown): AgentPayloads['mode-changed'] | null {
  const record = asRecord(raw)
  const modeId = record && str(record, 'modeId')
  return modeId ? { modeId } : null
}

function readChoice(raw: unknown): AgentConfigChoice | null {
  const record = asRecord(raw)
  if (!record) return null
  const value = str(record, 'value')
  const name = str(record, 'name')
  const description = record.description
  if (!value || !name) return null
  if (description !== undefined && typeof description !== 'string') return null
  return { value, name, description: typeof description === 'string' ? description : undefined }
}

function readConfigValue(raw: unknown): AgentConfigValue | null {
  const record = asRecord(raw)
  if (!record) return null
  if (record.kind === 'toggle') {
    return typeof record.current === 'boolean' ? { kind: 'toggle', current: record.current } : null
  }
  if (record.kind !== 'select' || !Array.isArray(record.choices)) return null
  const current = str(record, 'current')
  if (!current) return null
  const choices: AgentConfigChoice[] = []
  for (const entry of record.choices) {
    const choice = readChoice(entry)
    if (!choice) return null
    choices.push(choice)
  }
  return { kind: 'select', current, choices }
}

function readConfigOption(raw: unknown): AgentConfigOption | null {
  const record = asRecord(raw)
  if (!record) return null
  const id = str(record, 'id')
  const name = str(record, 'name')
  const value = readConfigValue(record.value)
  const description = record.description
  if (!id || !name || !value) return null
  if (description !== undefined && typeof description !== 'string') return null
  return {
    id,
    name,
    description: typeof description === 'string' ? description : undefined,
    value,
  }
}

/**
 * The full option set, replaced wholesale — the schema calls it "the full set of
 * configuration options and their current values", so a consumer replaces what it
 * had rather than merging. An empty set is valid: an engine may withdraw every
 * option it had offered.
 */
export function readConfigChanged(raw: unknown): AgentPayloads['config-changed'] | null {
  const record = asRecord(raw)
  if (!record || !Array.isArray(record.options)) return null
  const options: AgentConfigOption[] = []
  for (const entry of record.options) {
    const option = readConfigOption(entry)
    if (!option) return null
    options.push(option)
  }
  return { options }
}

export function readSessionChanged(raw: unknown): AgentPayloads['session-changed'] | null {
  const record = asRecord(raw)
  if (!record) return null
  const title = maybeStr(record, 'title')
  const updatedAt = maybeStr(record, 'updatedAt')
  if (!title || !updatedAt) return null
  return {
    title: title.seen ? title.value : undefined,
    updatedAt: updatedAt.seen ? updatedAt.value : undefined,
  }
}

function readCost(raw: unknown): AgentCost | null {
  const record = asRecord(raw)
  if (!record) return null
  const currency = str(record, 'currency')
  const amount = record.amount
  if (!currency || typeof amount !== 'number' || !Number.isFinite(amount)) return null
  return { amount, currency }
}

/** The context window and cost. `cost` must be present as numbers or as an explicit
 *  null, so a producer cannot leave a consumer guessing between "no cost" and
 *  "forgot to say" — §5.1 allows only the first to be shown. */
export function readContextUsage(raw: unknown): AgentContextUsage | null {
  const record = asRecord(raw)
  if (!record) return null
  const usedTokens = count(record.usedTokens)
  const contextTokens = count(record.contextTokens)
  if (usedTokens === null || contextTokens === null) return null
  if (record.cost === null) return { usedTokens, contextTokens, cost: null }
  const cost = readCost(record.cost)
  return cost ? { usedTokens, contextTokens, cost } : null
}

/** The counters a usage object can carry, in the schema's own order. Listed rather than written
 *  out per field so the reader below cannot read five of six and look complete. */
const USAGE_FIELDS: readonly (keyof AgentUsage)[] = [
  'inputTokens',
  'outputTokens',
  'totalTokens',
  'thoughtTokens',
  'cachedReadTokens',
  'cachedWriteTokens',
]

/**
 * A turn's usage, field by field — the one shape P0 §6.3 leaves open.
 *
 * The measured field sets differ between two identical turns, so **every field stands alone**:
 * one that is not there stays absent (a surface renders "not provided"), and one that is there
 * is kept as the engine's own number, zero included. Nothing is summed and nothing is defaulted
 * (§5.1: an unknown cost is not zero).
 *
 * A field that is present but is not a plausible count — a string, a negative, a fraction — is
 * left out rather than refused. It is the same thing an absent field means, and refusing the
 * whole payload would be worse than that: `run-finished` names a run, so a frame this window
 * cannot read becomes a `run-failed` on the turn it just completed, which is a decorative count
 * deciding that a finished turn failed. An object with no readable count at all is `null`: it
 * reported no usage this window can show, which is what `null` already means.
 */
function readUsage(record: Record<string, unknown>): AgentUsage | null {
  const usage: AgentUsage = {}
  for (const field of USAGE_FIELDS) {
    const value = count(record[field])
    if (value !== null) usage[field] = value
  }
  return Object.keys(usage).length > 0 ? usage : null
}

/**
 * A finished turn. The stop reason is one of the protocol's five, and four of them
 * are ordinary endings rather than errors — the kind is `run-finished` for all five,
 * because a token ceiling or a refusal is how the turn ended, not a failure of the
 * runtime to run it.
 *
 * The stop reason is read by {@link readEnding}: a word this version has never seen is an ending
 * it reports as unrecognised rather than one it refuses, because the alternative is a completed
 * turn shown as a failure. Everything else about the payload is strict.
 *
 * `usage` is absent, explicitly null, or an object, and all three are things the engine can say:
 * the schema makes the field optional, so requiring the key would refuse a legitimate ending,
 * and `null` is the contract's own spelling for "reported nothing". A `usage` that is neither
 * object nor null is the one case refused — that is a producer sending something this window
 * cannot read at all, and reading it as "no usage" would be the silent repair the container rule
 * exists to prevent. Inside the object, the rule is {@link readUsage}'s.
 */
export function readRunResult(raw: unknown): AgentRunResult | null {
  const record = asRecord(raw)
  if (!record) return null
  const ending = readEnding(record.stopReason)
  if (!ending) return null
  if (record.usage === null || record.usage === undefined) return { ...ending, usage: null }
  const reported = asRecord(record.usage)
  if (!reported) return null
  return { ...ending, usage: readUsage(reported) }
}

/**
 * Why the turn ended, in the two shapes the contract has for it — or null for a frame that did
 * not answer the question.
 *
 * The boundary is between *not saying* and *saying something new*, and it is drawn at the type
 * of the value rather than at its membership: a reason that is missing, empty or not a string is
 * a producer which did not answer, and stays a malformed frame (an engine that sends no reason
 * has not reported an ending this window may invent). A present non-empty string that is not one
 * of the five is an answer in a word this version has never seen — a case the protocol itself
 * allows, since its `StopReason` is `#[non_exhaustive]` — so it is read as
 * {@link AgentRunEnding}'s own arm and the engine's word is kept with it.
 *
 * This is the one place that line is drawn, and drawing it further out — accepting any JSON, or
 * repairing a missing reason into an ordinary one — is the trade §6.2 forbids: a catch-all read
 * as a fact. Drawing it tighter is the failure that made this arm necessary: `run-finished` names
 * a run, so a refusal here becomes a failure on the turn the engine just finished.
 */
function readEnding(
  raw: unknown,
): { stopReason: AgentRunEnding; unrecognisedReason?: string } | null {
  const known = member(AGENT_STOP_REASONS, raw)
  if (known) return { stopReason: known }
  const word = nonEmpty(raw)
  return word ? { stopReason: 'unrecognised', unrecognisedReason: word } : null
}

/**
 * The capability report, row for row.
 *
 * `null` when the answer is not one this contract allows — and never a repaired or shortened
 * version of it. A row dropped on the way in would be a capability the page never learns about,
 * which §3.4's row and §7.2 both forbid (「不宣称…」 cuts both ways: a host may not claim what it did
 * not measure, and may not leave out what it did); a row whose `feature` is not one this contract
 * knows is the same failure seen from the other side, because nothing here could render it. Both
 * are rejections, and the caller shows "unreadable" rather than a shorter list that reads as
 * complete.
 */
export function readCapabilityReports(raw: unknown): AgentCapabilityReport[] | null {
  if (!Array.isArray(raw)) return null
  const reports: AgentCapabilityReport[] = []
  const seen = new Set<AgentCapabilityFeature>()
  for (const entry of raw) {
    const record = asRecord(entry)
    if (!record) return null
    const feature: AgentCapabilityFeature | null = member(AGENT_CAPABILITY_FEATURES, record.feature)
    const declared: AgentCapabilityDeclaration | null = member(
      AGENT_CAPABILITY_DECLARATIONS,
      record.declared,
    )
    const finding = readCapabilityFinding(record.finding)
    if (!feature || !declared || !finding) return null
    // Twice for one feature is two answers to one question, and there is no rule here for which
    // one a page should believe.
    if (seen.has(feature)) return null
    seen.add(feature)
    reports.push({ feature, declared, finding })
  }
  // The report is one row per feature the contract knows, or it is not a report this window can
  // read. A short one would reach a page as "these are the features", which is the omission §3.4's
  // row and §7.2 forbid — and a rejection is the one outcome a page can render as "unreadable"
  // instead of as a fact about the engine.
  return AGENT_CAPABILITY_FEATURES.every((feature) => seen.has(feature)) ? reports : null
}

/**
 * One page of the engine's session table, or `null` when the answer is not one this
 * contract allows.
 *
 * Strict in both directions, for the reason {@link readCapabilityReports} is: a row
 * silently dropped on the way in is a session the user never learns they can reopen,
 * and there is no way to show that absence — a shorter list reads as a shorter history.
 * A row missing `sessionId` or `cwd` is therefore a rejection rather than a skip, and
 * so is a page that is not an object at all.
 *
 * `title` and `updatedAt` are read with `maybeStr`, which distinguishes *absent* from
 * *null* from *a string*: ACP makes both fields optional, so absent is a legitimate
 * answer, and a row that presented one as `''` would be a title the engine never gave.
 * The contract's own type keeps them `string | null` for the same reason.
 *
 * `held` is not one of those: it is the host's own answer and it is always there, so a
 * row without it is a row from a host this window does not understand. Guessing it —
 * `false` hides a control that works, `true` draws one that cannot — would be this
 * window answering for the host, which is the one thing every field on this row is
 * read strictly to avoid.
 */
export function readSessionHistory(raw: unknown): AgentSessionHistory | null {
  const record = asRecord(raw)
  if (!record) return null
  if (!Array.isArray(record.sessions)) return null
  const sessions: AgentSessionSummary[] = []
  for (const entry of record.sessions) {
    const row = asRecord(entry)
    if (!row) return null
    const sessionId = nonEmpty(row.sessionId)
    const cwd = nonEmpty(row.cwd)
    if (!sessionId || !cwd) return null
    const title = maybeStr(row, 'title')
    const updatedAt = maybeStr(row, 'updatedAt')
    if (!title || !updatedAt) return null
    if (typeof row.held !== 'boolean') return null
    sessions.push({
      sessionId,
      cwd,
      held: row.held,
      title: title.value,
      updatedAt: updatedAt.value,
    })
  }
  // The cursor travels with the page whether or not it is present: `undefined` and
  // `null` both mean "the engine named no further page", and the contract collapses
  // them into one `null` so a caller has one thing to test.
  const cursor = maybeStr(record, 'nextCursor')
  if (!cursor) return null
  return { sessions, nextCursor: cursor.value }
}

/** Every arm of {@link AgentCapabilityDeclaration}, listed once so a new one is a change here. */
const AGENT_CAPABILITY_DECLARATIONS: readonly AgentCapabilityDeclaration[] = [
  'advertised',
  'not-advertised',
  'unverified',
]

/**
 * One finding. The non-available arms require their detail, because that is the whole of what they
 * say: `unavailable` without a reason is a capability reported missing with nothing to act on, and
 * the contract's own type makes the field non-optional.
 */
function readCapabilityFinding(raw: unknown): AgentCapabilityFinding | null {
  const record = asRecord(raw)
  if (!record) return null
  if (record.status === 'available') return { status: 'available' }
  if (record.status === 'unavailable' || record.status === 'unverified') {
    const detail = str(record, 'detail')
    return detail ? { status: record.status, detail } : null
  }
  return null
}

export function readRunFailure(raw: unknown): AgentPayloads['run-failed'] | null {
  const record = asRecord(raw)
  if (!record) return null
  const message = str(record, 'message')
  if (!message || !isAgentFailureCode(record.code)) return null
  return { code: record.code, message }
}
