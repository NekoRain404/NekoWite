/**
 * The timeline: the conversation's rows, and the two ways one grows.
 *
 * It is its own module because the timeline is the one part of the session view
 * that is a *shape* rather than a state — what a row is, which rows merge into
 * each other, and how a row is numbered. The view module holds the state that
 * refers to it, and the reducer decides when a row may be written.
 *
 * The four kinds mirror what the engine discloses, with one collapse: a tool call
 * and its later updates are one row, because `tool-update` is one event kind for
 * both and a consumer wants the latest state of a call it identifies by
 * `toolCallId` (the contract's own reason for folding the wire's two frames
 * together). Text and thought stay apart so a renderer can collapse reasoning
 * without touching the answer.
 *
 * `runId` is nullable on every row, and the null case is only ever the host's own
 * message: it is written when the user sends, which is before the contract tells
 * the host which run that prompt started. No other row is created without a run —
 * the reducer refuses any turn-scoped frame that names none — so a null here means
 * "the host's message, whose run is not known yet".
 */

import type {
  AgentPayloads,
  AgentPromptAttachment,
  AgentToolContent,
  AgentToolInput,
  AgentToolKind,
  AgentToolStatus,
} from '../../../platform/gateways/agent-contracts'
import { promptAttachmentLabel } from '../../../platform/gateways/agent-contracts'
import type { AgentSessionView } from './agent-session-view'

/**
 * What a turn carried beside its words, as the transcript remembers it.
 *
 * A name and which of the two arms it was — **not the attachment**. An image's `data` is base64
 * of up to ten megabytes and this view keeps every row of the session, so a row holding blocks
 * would hold the conversation's image bytes for as long as the tab is open. What the row has to be
 * able to say is *that* something went with this message and *which* file it was; the bytes were
 * for the engine.
 */
export interface AgentUserAttachment {
  readonly kind: AgentPromptAttachment['kind']
  /** The label the reader saw on the chip — a resource's path, an image's name. */
  readonly name: string
}

/** The attachments of one send, as the row records them. */
export function userAttachments(
  attachments: readonly AgentPromptAttachment[],
): AgentUserAttachment[] {
  return attachments.map((attachment) => ({
    kind: attachment.kind,
    name: promptAttachmentLabel(attachment),
  }))
}

export interface AgentUserEntry {
  kind: 'user'
  /** Stable across updates: a list keyed by array index would re-key every row
   *  below a tool call whose status changed. */
  id: number
  runId: string | null
  text: string
  /** Who wrote this row. The host's own send and the engine's copy of the user's
   *  half are two different statements about the conversation, and merging them
   *  would show the user's words twice in one row or invent a message neither side
   *  sent. */
  origin: 'host' | 'engine'
  /**
   * What went with this message, in the order the reader attached it.
   *
   * Empty on the engine's own copy of the user's half, which says nothing about attachments, and
   * on a row written by a build that predates this field — never absent, so a reader of the row
   * cannot mistake "this turn carried nothing" for "this row does not know". Only the host's row
   * is written where the answer exists: the composer's strip is cleared with the draft, so this is
   * the one record a reader can go back to.
   */
  attachments: readonly AgentUserAttachment[]
}

export interface AgentTextEntry {
  kind: 'text'
  id: number
  runId: string | null
  text: string
}

export interface AgentThoughtEntry {
  kind: 'thought'
  id: number
  runId: string | null
  text: string
}

export interface AgentToolEntry {
  kind: 'tool'
  id: number
  runId: string | null
  toolCallId: string
  title: string
  name?: string
  toolKind: AgentToolKind
  status: AgentToolStatus
  paths: string[]
  /**
   * The blocks the call reported. Carried on the row rather than read at render time because
   * there is no second read to make: the projection is the only layer that sees the frame, and
   * a `diff` block's text is in it.
   */
  content: AgentToolContent[]
  input: AgentToolInput
  output: AgentToolInput
}

export type AgentTimelineEntry = AgentUserEntry | AgentTextEntry | AgentThoughtEntry | AgentToolEntry

/**
 * A row before the view has numbered it.
 *
 * Spelled out per member rather than as `Omit<AgentTimelineEntry, 'id'>`: `Omit`
 * does not distribute over a union — it would leave `kind` and `runId` and drop
 * everything the members do not share, so a caller could hand the view a row with
 * no text and no tool call and the type would not say so.
 */
export type AgentTimelineEntryInput =
  | Omit<AgentUserEntry, 'id'>
  | Omit<AgentTextEntry, 'id'>
  | Omit<AgentThoughtEntry, 'id'>
  | Omit<AgentToolEntry, 'id'>

/** The rows whose content is text: what coalescing may merge, and what the text
 *  ceiling applies to. */
export type AgentTextEntryInput =
  | Omit<AgentUserEntry, 'id'>
  | Omit<AgentTextEntry, 'id'>
  | Omit<AgentThoughtEntry, 'id'>

/** One tool row, from the payload that carries it. Built with an explicit `kind`
 *  so the type checks the correlation the payload map states statically. */
export function toolRow(runId: string | null, call: AgentPayloads['tool-update']): Omit<AgentToolEntry, 'id'> {
  return {
    kind: 'tool',
    runId,
    toolCallId: call.toolCallId,
    title: call.title,
    name: call.name,
    toolKind: call.kind,
    status: call.status,
    paths: [...call.paths],
    // Copied, like the paths: the row is what the view renders, and a payload that is later
    // reused must not be able to change a row the reader has already read.
    content: call.content.map((block) => ({ ...block })),
    input: call.input,
    output: call.output,
  }
}

/**
 * Append one row, and say whether it crossed the view's entry bound. The caller
 * decides what crossing means; the row is never withheld.
 */
export function appendTimelineEntry(
  view: AgentSessionView,
  entry: AgentTimelineEntryInput,
): { view: AgentSessionView; overLimit: boolean } {
  // The one cast in this module: `entry` is a union and a spread is not, so
  // TypeScript cannot carry the correlation between `kind` and the rest through
  // it. The input type above is what keeps the shapes honest.
  const row = { ...entry, id: view.entrySeq } as AgentTimelineEntry
  const timeline = [...view.timeline, row]
  return {
    view: { ...view, entrySeq: view.entrySeq + 1, timeline },
    overLimit: timeline.length > view.timelineLimit,
  }
}

/**
 * Whether a chunk continues the row before it.
 *
 * Two rows merge only when they are the same writer's continuation: same kind,
 * same run, and — for the user's half — the same origin. A replayed user turn and
 * the host's own message are two different statements about the conversation, and
 * concatenating them would invent a message neither side sent.
 */
export function continuesLast(view: AgentSessionView, entry: AgentTextEntryInput): boolean {
  const last = view.timeline[view.timeline.length - 1]
  if (last === undefined || last.kind !== entry.kind || last.runId !== entry.runId) return false
  if (last.kind === 'user' && entry.kind === 'user') return last.origin === entry.origin
  return true
}

/**
 * Merge a chunk into the row it continues.
 *
 * §6.2's "text may be coalesced": the engine streams one answer as many chunks, and
 * a timeline with a row per chunk would be a timeline of tokens. It is the caller's
 * business whether the row continues anything — this only rewrites the last row,
 * and only when the last row holds text at all.
 */
export function mergeLastText(view: AgentSessionView, text: string): AgentSessionView {
  const last = view.timeline[view.timeline.length - 1]
  if (last === undefined || !('text' in last)) return view
  return {
    ...view,
    timeline: [...view.timeline.slice(0, -1), { ...last, text: last.text + text }],
  }
}

/** Replace the row a tool call already has, keeping its id so the panel's list key
 *  does not change under the user.
 *
 *  The row keeps its own run rather than taking one from the update: a tool call
 *  belongs to the turn that started it, and only that turn's frames are ever
 *  allowed to settle it, so re-tagging here could only ever be a mistake. */
export function replaceToolEntry(
  view: AgentSessionView,
  index: number,
  call: AgentPayloads['tool-update'],
): AgentSessionView {
  const timeline = [...view.timeline]
  timeline[index] = { ...toolRow(view.timeline[index].runId, call), id: view.timeline[index].id }
  return { ...view, timeline }
}

/** The index of the row a tool call already has, or -1. A tool call and its
 *  updates share one id, which is what the contract says to join them by. */
export function toolEntryIndex(view: AgentSessionView, toolCallId: string): number {
  return view.timeline.findIndex((entry) => entry.kind === 'tool' && entry.toolCallId === toolCallId)
}
