/**
 * The change review: what a run changed on disk, which changes are its own, and what this window
 * may do about them.
 *
 * §7.2 is the specification, and it is three rules that each forbid a different lie:
 *
 *  - **Attribution is a claim about cause, so it is made from evidence and from nothing else.** A
 *    file is an agent change only when a tool call of *this session*, of a kind that means "this
 *    file is what the call changes", named it (「只有有可靠工具关联的变化标记为智能体修改」). A file
 *    the watcher saw change is external when nothing in the session's record claims the path, and
 *    the engine's own `files-changed` list — a hint, in the contract's words, not a diff — makes a
 *    row without attributing it (「仅 watcher 发现的变化标记为外部变化，避免归因给错误会话」). The wrong
 *    answer is worse than no answer: it tells the user to accept a change nobody proposed.
 *  - **A written change and an unwritten proposal are not the same thing.** This module reads the
 *    first and deliberately ignores `permission-request`: a request is a proposal the engine has
 *    not written yet, and §7.2 gives the two different verbs (apply/discard for the proposal,
 *    view/recover/merge for the file). One list holding both would let "the agent changed this" be
 *    read off a file nothing has touched.
 *  - **The buffer is the user's, and this module is a guest in it.** The editor is reached through
 *    a lookup that returns a note's own account and has no setter, so no operation here can write,
 *    clear or reload a buffer — the failure this file cannot have is a review that tidied an
 *    unsaved edit away. A dirty buffer and a changed file are both kept: the row names both texts
 *    and offers a merge, while *recovery* of the file is withheld until the buffer is settled,
 *    because recovering under an unsaved edit produces an outcome nothing on screen would show and
 *    §7.2 refuses a fabricated undo.
 *
 * The shape is the one the rest of this feature uses: a review is a plain frozen value, every
 * function returns a new one or the one it was given, and nothing throws, reads a clock or touches
 * a store. The judgement lands in {@link AgentChangeRow}, which is a value too, so what the view
 * renders and what was decided cannot be two different things.
 */

import type {
  AgentEvent,
  AgentIdentity,
  AgentToolKind,
  AgentToolStatus,
} from '../../../platform/gateways/agent-contracts'
import type { AgentLiveNote } from './agent-context-snapshot'
import { identityMismatch } from './agent-session-view'

/**
 * The tool kinds whose meaning is that the named file *is what the call changes*.
 *
 * ACP's kinds are read from the engine, and the two that write are the two that say so. `execute`
 * is deliberately not here even though a shell command can write anything: the paths such a call
 * reports are the ones it touches, which includes arguments and targets it only reads, so treating
 * them as writes would be inventing an association the engine never made. A file a shell command
 * wrote and no write-kind call named is exactly the "only the watcher saw it" case §7.2 gives its
 * own answer to.
 */
export const AGENT_WRITE_TOOLS: readonly AgentToolKind[] = ['edit', 'delete', 'move']

/**
 * What a file's change is attributed to.
 *
 * Two of these are §7.2's attributions and the third is the absence of one, kept as a state rather
 * than as an empty field because "we do not know who changed this" is a different fact from
 * "nothing here claims to have changed this" — and the user is owed the difference.
 *
 *  - `agent` — a write-kind tool call of this session named the path. The call is the evidence.
 *  - `external` — the file changed on disk and nothing in this session's record names the path.
 *  - `reported` — the engine named the path in `files-changed`, and no write-kind call did. A
 *    lead: the engine says it touched this file, and this host did not see a change at it. It is
 *    never enough on its own to call a change the agent's.
 */
export type AgentChangeAttribution = 'agent' | 'external' | 'reported'

/** One write-kind tool call, as the review keeps it: the evidence an `agent` row rests on. */
export interface AgentWriteCall {
  readonly toolCallId: string
  readonly tool: AgentToolKind
  readonly paths: readonly string[]
  /**
   * Carried, not filtered on. A call that reported `failed` still named the file, and the host
   * cannot rule out that it wrote before it failed; dropping the row would hand the change to
   * `external` and blame the user's other programs for it. The status is shown instead, which is
   * the only one of the two that is true.
   */
  readonly status: AgentToolStatus
}

/**
 * What one run's stream has said about the files it touched.
 *
 * Three lists rather than one map of attributed paths, because they are three kinds of evidence
 * and the attribution is the *result* of weighing them — decided in {@link changeRows} rather than
 * at the moment each frame arrives, so a watcher observation that lands before the tool call it
 * belongs to still ends up attributed to the call.
 */
export interface AgentChangeReview {
  readonly identity: AgentIdentity
  /** Write-kind calls, in arrival order, one entry per `toolCallId`. */
  readonly writes: readonly AgentWriteCall[]
  /** Paths the engine reported touching (a hint). */
  readonly reported: readonly string[]
  /** Paths the watcher saw change on disk. */
  readonly observed: readonly string[]
}

/**
 * What this window holds for one path, and what may be done about it.
 *
 * The three arms are §7.2's second clause as a decision about the *editor*: a file no tab holds is
 * a record, a clean buffer is one the editor's own external sync follows (the same path every
 * other external write takes), and a dirty buffer is a conflict in which both texts are the user's
 * to reconcile.
 */
export type AgentChangeVerdict =
  /** No tab holds this path: there is no buffer here to protect or to lose. */
  | { readonly kind: 'record' }
  /** A tab holds it with no unsaved edits, so the disk is the whole of its text. */
  | { readonly kind: 'follows-disk' }
  /**
   * A tab holds it with unsaved edits: the buffer and the file are two texts, and neither replaces
   * the other. `diskText` is null when the file's text was not read — "not read" and "empty" are
   * the two states the editor's own account keeps apart, and this row keeps them apart too.
   */
  | {
      readonly kind: 'unsaved-edits'
      readonly bufferText: string
      readonly diskText: string | null
    }

/** One thing the review offers for a row. */
export type AgentChangeOffer = 'view' | 'merge' | 'recover'

/**
 * Why an offer this row could otherwise have is not made — a code, not a sentence, because the UI
 * owns the wording and a service that returned text would have to invent it in two languages.
 *
 * The two clauses of §7.2 that a *recovery* has to answer before it is offered, and the one thing
 * the review itself must never do: put a file back while the engine is still writing it. Each arm
 * names a different thing for the user to do, which is why they are not one refusal.
 */
export type AgentChangeRefusal =
  | { readonly reason: 'not-agent-change'; readonly attribution: AgentChangeAttribution }
  | { readonly reason: 'write-in-flight'; readonly toolCallId: string }
  | { readonly reason: 'unsaved-edits'; readonly path: string }

/** One file, as the review sees it. Plain frozen data: the view renders this and decides nothing. */
export interface AgentChangeRow {
  readonly path: string
  readonly attribution: AgentChangeAttribution
  /** The call that named this path, when one did — what an `agent` row's claim rests on. */
  readonly toolCallId: string | null
  readonly tool: AgentToolKind | null
  readonly status: AgentToolStatus | null
  readonly verdict: AgentChangeVerdict
  /** The offers that survive the judgement, in the order the view shows them. */
  readonly offers: readonly AgentChangeOffer[]
  /** The one offer that was withheld, if one was. */
  readonly refused: AgentChangeRefusal | null
}

/** A review with nothing in it yet. A session that has touched nothing has an empty record, not a
 *  missing one — the same choice the context draft makes, so there is no null case to handle. */
export function createChangeReview(identity: AgentIdentity): AgentChangeReview {
  return Object.freeze({
    identity: Object.freeze({ ...identity }),
    writes: Object.freeze([]),
    reported: Object.freeze([]),
    observed: Object.freeze([]),
  })
}

function withWrites(review: AgentChangeReview, writes: readonly AgentWriteCall[]): AgentChangeReview {
  return { ...review, writes: Object.freeze(writes) }
}

function appendPaths(paths: readonly string[], more: readonly string[]): readonly string[] {
  const known = new Set(paths)
  const added = more.filter((path) => !known.has(path))
  return added.length === 0 ? paths : Object.freeze([...paths, ...added])
}

/**
 * One `tool-update`, folded in.
 *
 * The call's row is replaced rather than appended: the wire sends `tool_call` and then any number
 * of `tool_call_update` frames for one id, and a review holding both would count one call twice —
 * the same fold the timeline does for its tool rows.
 *
 * Kinds that are not writes are *not stored at all*, not stored-and-ignored: a `read` call names
 * the file it read, and keeping that as evidence would leave a later bug one comparison away from
 * showing the user "the agent changed this note" about a note the agent only opened.
 */
export function applyChangeEvent(review: AgentChangeReview, event: AgentEvent): AgentChangeReview {
  // A foreign frame does not become ours by arriving: the composite identity is what keeps an
  // event from another agent, runtime instance, vault or session out of this review (§6.2). A
  // frame from the previous runtime epoch is the same shape as a live one and is refused here
  // for the same reason the reducer refuses it.
  if (identityMismatch(review.identity, event) !== null) return review

  switch (event.kind) {
    case 'tool-update': {
      const call = event.payload
      if (!AGENT_WRITE_TOOLS.includes(call.kind) || call.paths.length === 0) return review
      const entry: AgentWriteCall = Object.freeze({
        toolCallId: call.toolCallId,
        tool: call.kind,
        paths: Object.freeze([...call.paths]),
        status: call.status,
      })
      const index = review.writes.findIndex((held) => held.toolCallId === call.toolCallId)
      if (index === -1) return withWrites(review, [...review.writes, entry])
      return withWrites(
        review,
        review.writes.map((held, at) => (at === index ? entry : held)),
      )
    }
    case 'files-changed':
      return { ...review, reported: appendPaths(review.reported, event.payload.paths) }
    default:
      // Every other kind describes the session rather than a file. A `permission-request` is the
      // one worth naming: it carries the diff the engine *proposes* to write, which §7.2 gives the
      // verbs apply/discard — not the view/recover/merge of a file that has already changed.
      return review
  }
}

/**
 * Note that a path changed on disk without the engine telling us so.
 *
 * This is the watcher's report and nothing more: it says the file is not what this window last saw,
 * and it says nothing about who wrote it. The attribution is decided in {@link changeRows} against
 * the session's own record, which is what keeps a change made in another program from being
 * presented as the agent's work.
 */
export function observeDiskChange(review: AgentChangeReview, path: string): AgentChangeReview {
  const observed = appendPaths(review.observed, [path])
  return observed === review.observed ? review : { ...review, observed }
}

/** The last write-kind call that named `path`, which is the one a row shows. */
function writeFor(review: AgentChangeReview, path: string): AgentWriteCall | null {
  let found: AgentWriteCall | null = null
  for (const call of review.writes) {
    if (call.paths.includes(path)) found = call
  }
  return found
}

/**
 * What this window holds for the path, from the editor's own account of it.
 *
 * The dirty arm keeps *both* texts, and the file's is nullable: the editor may not have read the
 * file, and "not read" must not be rendered as "empty" — a merge view built on that would show the
 * user an empty file the agent had in fact changed.
 */
function verdictFor(live: AgentLiveNote | null): AgentChangeVerdict {
  if (live === null) return Object.freeze({ kind: 'record' })
  if (live.buffer.state === 'clean') return Object.freeze({ kind: 'follows-disk' })
  return Object.freeze({
    kind: 'unsaved-edits',
    bufferText: live.buffer.text,
    diskText: live.buffer.diskText,
  })
}

/**
 * The offers for one row, and the one that was withheld.
 *
 * Three questions in order, because each is about a different subject and the answer to a later one
 * is meaningless when an earlier one failed:
 *
 *  1. *Is this change the agent's?* Only an `agent` row can be put back: recovery restores a
 *     baseline this host recorded for a write this host performed, and a path the engine merely
 *     reported or the watcher merely saw has no such baseline (§7.2 「没有基线时标记不可直接恢复，
 *     不伪造「撤销成功」」).
 *  2. *Has the engine finished writing it?* A call still `pending` or `in_progress` is a write in
 *     flight, and a recovery started now would be a race between the two writers that only one of
 *     them knows about. The refusal is the review's own, not the host's, because it is the review
 *     that can see the call.
 *  3. *Would anything on screen show the outcome?* With an unsaved buffer the answer is no: the
 *     file would go back to its baseline while the user's own text still sits ahead of it, so the
 *     next save would put the buffer's version back over the recovery and the "undo" the user was
 *     shown would not be what happened. Resolving that note is the tab's own conflict flow — the
 *     one that already exists for an external write — and this row offers the merge until it is.
 */
function judge(
  path: string,
  attribution: AgentChangeAttribution,
  call: AgentWriteCall | null,
  verdict: AgentChangeVerdict,
): { offers: readonly AgentChangeOffer[]; refused: AgentChangeRefusal | null } {
  const offers: AgentChangeOffer[] = ['view']
  if (attribution !== 'agent' || call === null) {
    return { offers: Object.freeze(offers), refused: { reason: 'not-agent-change', attribution } }
  }
  if (call.status === 'pending' || call.status === 'in_progress') {
    return { offers: Object.freeze(offers), refused: { reason: 'write-in-flight', toolCallId: call.toolCallId } }
  }
  if (verdict.kind === 'unsaved-edits') {
    offers.push('merge')
    return { offers: Object.freeze(offers), refused: { reason: 'unsaved-edits', path } }
  }
  offers.push('recover')
  return { offers: Object.freeze(offers), refused: null }
}

/**
 * The rows, in the order the evidence arrived.
 *
 * `live` is asked about the path it is given and returns the editor's account of that note, or null
 * when no tab holds it. It is a lookup rather than a captured map because the rows are built for
 * the moment they are shown, and the editor's answer changes as the user types; what must *not*
 * change afterwards is the row, which copies the texts it decided on into itself.
 */
export function changeRows(
  review: AgentChangeReview,
  live: (path: string) => AgentLiveNote | null,
): readonly AgentChangeRow[] {
  const paths = appendPaths(appendPaths(
    review.writes.flatMap((call) => [...call.paths]),
    review.reported,
  ), review.observed)

  const rows = paths.map((path): AgentChangeRow => {
    const call = writeFor(review, path)
    const attribution: AgentChangeAttribution =
      call !== null ? 'agent' : review.reported.includes(path) ? 'reported' : 'external'
    const verdict = verdictFor(live(path))
    const { offers, refused } = judge(path, attribution, call, verdict)
    return Object.freeze({
      path,
      attribution,
      toolCallId: call?.toolCallId ?? null,
      tool: call?.tool ?? null,
      status: call?.status ?? null,
      verdict,
      offers,
      refused,
    })
  })
  return Object.freeze(rows)
}
