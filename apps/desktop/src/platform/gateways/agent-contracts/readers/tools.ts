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
  AgentToolContent,
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

/**
 * One content block, in the two shapes this contract carries.
 *
 * A `diff` needs its path and its new text to be strings and nothing else: the schema makes
 * `newText` required, so a block without one is not a diff, and `oldText` is genuinely optional —
 * absent and `null` are the same statement and both mean the engine stated no original text.
 *
 * **Everything else lands in `unrecognised` rather than being refused.** The wire's third arms
 * (`content`, `terminal`) and any type a later schema adds are blocks this version does not draw,
 * but they are not malformed frames: a reader that refused them would turn one unknown block into
 * a dropped tool call, which is the trade `payloads.ts`'s kind list refuses in the other
 * direction. A non-object item is treated the same way and for the same reason — something was
 * there, and this version cannot say what.
 */
function readToolContent(raw: unknown): AgentToolContent | null {
  const record = asRecord(raw)
  if (!record || typeof record.type !== 'string') return null
  if (record.type !== 'diff') return { type: 'unrecognised' }
  const { path, newText, oldText } = record
  // Strings, not `str`: both of these may legitimately be empty. An empty `newText` is a file the
  // engine proposes to leave empty, and an empty `path` is a blank the engine's own builder
  // produces — `str`'s non-empty rule is for the fields that name something, and neither of these
  // is asked to.
  if (typeof path !== 'string' || typeof newText !== 'string') return { type: 'unrecognised' }
  if (oldText !== undefined && oldText !== null && typeof oldText !== 'string') {
    return { type: 'unrecognised' }
  }
  return { type: 'diff', path, oldText: typeof oldText === 'string' ? oldText : null, newText }
}

/**
 * The content blocks a call reported, or `null` when the field is not a list.
 *
 * An empty list is kept as an empty list rather than refused: "this call reported no content" is a
 * complete answer, and the adapter always sends the field.
 */
function readToolContentList(raw: unknown): AgentToolContent[] | null {
  if (!Array.isArray(raw)) return null
  const content: AgentToolContent[] = []
  for (const entry of raw) {
    const block = readToolContent(entry)
    if (block === null) return null
    content.push(block)
  }
  return content
}

export function readToolUpdate(raw: unknown): AgentPayloads['tool-update'] | null {
  const record = asRecord(raw)
  if (!record) return null
  const toolCallId = str(record, 'toolCallId')
  const title = str(record, 'title')
  const status = member(TOOL_STATUSES, record.status)
  const kind = readToolKind(record.kind)
  const paths = strings(record.paths)
  const content = readToolContentList(record.content)
  const input = readToolInput(record.input)
  const output = readToolInput(record.output)
  const name = record.name
  if (name !== undefined && typeof name !== 'string') return null
  if (!toolCallId || !title || !status || !kind || !paths || !content || !input || !output) {
    return null
  }
  return {
    toolCallId,
    title,
    name: typeof name === 'string' ? name : undefined,
    kind,
    status,
    paths,
    content,
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
 *
 * `content` is required for the reason the tool-update payload's is: the prompt decides on
 * these blocks, and a producer that left the field out would be a prompt drawing no diff
 * with nothing anywhere saying whether that is what the engine asked with. The host sends
 * an empty list for a request that carried no block, which is a stated answer.
 */
export function readPermissionRequest(raw: unknown): AgentPermissionRequest | null {
  const record = asRecord(raw)
  if (!record) return null
  const requestId = str(record, 'requestId')
  const toolCallId = str(record, 'toolCallId')
  const title = str(record, 'title')
  const input = readToolInput(record.input)
  const content = readToolContentList(record.content)
  const options = readOptions(record.options)
  return requestId && toolCallId && title && input && content && options
    ? { requestId, toolCallId, title, input, content, options }
    : null
}

export function readFilesChanged(raw: unknown): AgentPayloads['files-changed'] | null {
  const record = asRecord(raw)
  const paths = record && strings(record.paths)
  return paths ? { paths } : null
}
