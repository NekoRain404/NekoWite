/**
 * Readers for tool calls, permission requests and the files a turn touched.
 *
 * Grouped because they are the payloads a user acts on: a tool row, the prompt that
 * asks for consent, and the list of files that changed behind their back. They are
 * also the three that carry engine-defined JSON — the tool arguments, and the
 * permission request's copy of them — which is why the `AgentToolInput` three-state
 * reading lives here.
 */

import type {
  AgentPermissionOption,
  AgentPermissionRequest,
  AgentPayloads,
  AgentToolKind,
} from '../payloads'
import { asRecord, member, str, strings } from './fields'

const TOOL_STATUSES = ['pending', 'in_progress', 'completed', 'failed', 'cancelled'] as const
const TOOL_KINDS = [
  'read',
  'edit',
  'delete',
  'move',
  'search',
  'execute',
  'think',
  'fetch',
  'switch_mode',
  'other',
] as const

/**
 * The tool's category, where an unrecognised one lands in `other`: that is the
 * schema's own `#[serde(other)]` behaviour, so a kind this host has not learned yet
 * is not a malformed frame. Absent is still malformed — the adapter always has one
 * after deserialization.
 */
function readToolKind(raw: unknown): AgentToolKind | null {
  if (raw === undefined) return null
  return member(TOOL_KINDS, raw) ?? 'other'
}

/**
 * The raw arguments, in the three states the host keeps apart.
 *
 * The wire gives one nullable JSON value for both "absent" and "did not parse"
 * (acp-spec #1979, via `x-deserialize-default-on-error`), so the host value carries
 * the distinction explicitly: `absent` when the field is missing, `text` when it
 * arrived as a serialized value, `unreadable` when the producer reports input that
 * could not be read. Anything else is malformed.
 */
function readToolInput(raw: unknown): AgentPayloads['tool-update']['input'] | null {
  const record = asRecord(raw)
  if (!record) return null
  const state = member(['absent', 'text', 'unreadable'] as const, record.state)
  if (state === 'absent' || state === 'unreadable') return { state }
  if (state === 'text' && typeof record.json === 'string') return { state, json: record.json }
  return null
}

export function readToolUpdate(raw: unknown): AgentPayloads['tool-update'] | null {
  const record = asRecord(raw)
  if (!record) return null
  const toolCallId = str(record, 'toolCallId')
  const title = str(record, 'title')
  const status = member(TOOL_STATUSES, record.status)
  const kind = readToolKind(record.kind)
  const paths = strings(record.paths)
  const input = readToolInput(record.input)
  const output = readToolInput(record.output)
  const name = record.name
  if (name !== undefined && typeof name !== 'string') return null
  if (!toolCallId || !title || !status || !kind || !paths || !input || !output) return null
  return {
    toolCallId,
    title,
    name: typeof name === 'string' ? name : undefined,
    kind,
    status,
    paths,
    input,
    output,
  }
}

/**
 * The engine's own four kinds (`PermissionOptionKind` in the v1 schema).
 *
 * All four, not a collapsed allow/reject pair: `allow_always` remembers the
 * choice where `allow_once` does not, and a validator that accepted only the
 * collapsed pair would refuse every real frame the engine sends.
 */
const PERMISSION_KINDS = [
  'allow_once',
  'allow_always',
  'reject_once',
  'reject_always',
] as const

function readOptions(raw: unknown): AgentPermissionOption[] | null {
  if (!Array.isArray(raw) || raw.length === 0) return null
  const options: AgentPermissionOption[] = []
  for (const entry of raw) {
    const record = asRecord(entry)
    const optionId = record && str(record, 'optionId')
    const name = record && str(record, 'name')
    const kind = record && member(PERMISSION_KINDS, record.kind)
    if (!optionId || !name || !kind) return null
    options.push({ optionId, name, kind })
  }
  return options
}

/**
 * A permission request whose option list is non-empty: an empty list is refused
 * rather than passed on, because it would leave the user a prompt with nothing to
 * answer and a turn waiting on it forever.
 */
export function readPermissionRequest(raw: unknown): AgentPermissionRequest | null {
  const record = asRecord(raw)
  if (!record) return null
  const requestId = str(record, 'requestId')
  const toolCallId = str(record, 'toolCallId')
  const title = str(record, 'title')
  const input = readToolInput(record.input)
  const options = readOptions(record.options)
  return requestId && toolCallId && title && input && options
    ? { requestId, toolCallId, title, input, options }
    : null
}

export function readFilesChanged(raw: unknown): AgentPayloads['files-changed'] | null {
  const record = asRecord(raw)
  const paths = record && strings(record.paths)
  return paths ? { paths } : null
}
