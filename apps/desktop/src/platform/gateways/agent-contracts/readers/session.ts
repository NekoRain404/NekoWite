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
  AgentRunResult,
  AgentUsage,
} from '../payloads'
import { AGENT_STOP_REASONS } from '../payloads'
import type {
  AgentCapabilityDeclaration,
  AgentCapabilityFeature,
  AgentCapabilityFinding,
  AgentCapabilityReport,
} from '../gateway'
import { AGENT_CAPABILITY_FEATURES } from '../gateway'
import { isAgentFailureCode } from '../failure'
import { asRecord, count, maybeStr, member, str } from './fields'

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

function readUsage(raw: unknown): AgentUsage | null {
  const record = asRecord(raw)
  if (!record) return null
  const inputTokens = count(record.inputTokens)
  const outputTokens = count(record.outputTokens)
  const totalTokens = count(record.totalTokens)
  if (inputTokens === null || outputTokens === null || totalTokens === null) return null
  return { inputTokens, outputTokens, totalTokens }
}

/**
 * A finished turn. The stop reason is one of the protocol's five, and four of them
 * are ordinary endings rather than errors — the kind is `run-finished` for all five,
 * because a token ceiling or a refusal is how the turn ended, not a failure of the
 * runtime to run it.
 *
 * `usage` has to be present — numbers or an explicit null — for the same reason as
 * the cost above.
 */
export function readRunResult(raw: unknown): AgentRunResult | null {
  const record = asRecord(raw)
  if (!record) return null
  const stopReason = member(AGENT_STOP_REASONS, record.stopReason)
  if (!stopReason) return null
  if (record.usage === null) return { stopReason, usage: null }
  const usage = readUsage(record.usage)
  return usage ? { stopReason, usage } : null
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
