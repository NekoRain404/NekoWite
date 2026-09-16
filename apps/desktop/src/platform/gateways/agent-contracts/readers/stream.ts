/**
 * Readers for the message stream: the text channels, the command list and the plan.
 *
 * Grouped because they share the shape "the engine published a complete list" —
 * commands and plan entries are replaced wholesale, so a reader that let a malformed
 * entry through would either have to drop it (silently shortening the list the user
 * sees) or pass it on (handing the UI something that is not what the contract says).
 */

import type { AgentCommand, AgentPayloads, AgentPlanEntry } from '../payloads'
import { asRecord, member, str } from './fields'

/**
 * A chunk of streamed text, for all three of the engine's text channels (agent
 * message, user message, thought): they carry the same content block, and only the
 * kind says whose words they are.
 *
 * An empty chunk is legal — an engine may send one — so only the type is checked.
 */
export function readText(raw: unknown): { text: string } | null {
  const record = asRecord(raw)
  return record && typeof record.text === 'string' ? { text: record.text } : null
}

function readCommand(raw: unknown): AgentCommand | null {
  const record = asRecord(raw)
  const name = record && str(record, 'name')
  if (!record || !name) return null
  const description = record.description
  if (description !== undefined && (typeof description !== 'string' || !description)) {
    return null
  }
  return { name, description: typeof description === 'string' ? description : undefined }
}

export function readCommands(raw: unknown): AgentPayloads['commands-changed'] | null {
  const record = asRecord(raw)
  if (!record || !Array.isArray(record.commands)) return null
  const commands: AgentCommand[] = []
  for (const entry of record.commands) {
    const command = readCommand(entry)
    if (!command) return null
    commands.push(command)
  }
  return { commands }
}

const PLAN_STATUSES = ['pending', 'in_progress', 'completed'] as const
const PLAN_PRIORITIES = ['high', 'medium', 'low'] as const

function readPlanEntry(raw: unknown): AgentPlanEntry | null {
  const record = asRecord(raw)
  if (!record) return null
  const content = str(record, 'content')
  const status = member(PLAN_STATUSES, record.status)
  const priority = member(PLAN_PRIORITIES, record.priority)
  if (!content || !status || !priority) return null
  return { content, status, priority }
}

/**
 * The engine's plan. An empty entry list is a valid plan (a task with nothing left
 * to do), so the list itself is only required to be a list.
 */
export function readPlan(raw: unknown): AgentPayloads['plan-changed'] | null {
  const record = asRecord(raw)
  if (!record || !Array.isArray(record.entries)) return null
  const entries: AgentPlanEntry[] = []
  for (const entry of record.entries) {
    const parsed = readPlanEntry(entry)
    if (!parsed) return null
    entries.push(parsed)
  }
  return { entries }
}
