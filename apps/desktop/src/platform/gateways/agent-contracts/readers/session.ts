/**
 * Readers for the session's own state: mode, configuration, metadata, context usage
 * and how a run ended.
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

export function readRunFailure(raw: unknown): AgentPayloads['run-failed'] | null {
  const record = asRecord(raw)
  if (!record) return null
  const message = str(record, 'message')
  if (!message || !isAgentFailureCode(record.code)) return null
  return { code: record.code, message }
}
