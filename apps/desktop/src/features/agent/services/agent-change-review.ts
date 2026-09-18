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
 *    unsaved edit away. A dirty buffer and a changed file are both kept: the row names both texts,
 *    and *recovery* of the file is withheld until the buffer is settled, because recovering under
 *    an unsaved edit produces an outcome nothing on screen would show and §7.2 refuses a fabricated
 *    undo. §7.2's third verb for a written change, 合并, is the note's own keep-or-reload prompt —
 *    and it is not a button here, because nothing a component can reach raises it
 *    (`app/app-dialogs.ts` is per-window state owned by `App.vue`).
 *
 * ## What a recovery needs, and where a review comes from
 *
 * A recovery is a write, so it is offered only when the window can make one honestly, out of two
 * things this value holds. The **baseline** is the text the note held when the request that named
 * it was submitted (`stores/agent-session.ts` captures it at the send, `captureEditBaselines`), and
 * §7.2's 「没有基线时标记不可直接恢复」 is why a change nothing captured a version for is marked
 * rather than offered. The **text the call said it left** is its own `diff` block, the field
 * `agent-edit-apply.ts` writes from, and §7.2's 「恢复前检查当前内容是否仍等于已记录结果」 is asked
 * against it — so a note edited since the agent wrote it is refused, not overwritten.
 *
 * {@link reviewOfSession} builds a review from the session's own record — the timeline the
 * transcript draws and the engine's `files-changed` list — rather than from a listener over the
 * event stream: a surface that subscribed on mount would be empty for every frame that arrived
 * before it, and a review folded beside the timeline is free to disagree with what the user has
 * just read.
 *
 * The shape is the one the rest of this feature uses: a review is a plain frozen value, every
 * function returns a new one or the one it was given, and nothing throws, reads a clock or touches
 * a store. The judgement lands in {@link AgentChangeRow}, which is a value too, so what the view
 * renders and what was decided cannot be two different things.
 *
 * The vocabulary these rules fill lives in `agent-change-vocabulary.ts` and is re-exported from
 * here in full: the shape the view renders changes for a different reason than the rules that fill
 * it, so the two are separate modules and no import path moves.
 */

import type {
  AgentEvent,
  AgentIdentity,
  AgentToolContent,
  AgentToolKind,
  AgentToolStatus,
} from '../../../platform/gateways/agent-contracts'
import type { AgentLiveNote } from './agent-context-snapshot'
import type { AgentEditBaseline } from './agent-edit-apply'
import type { AgentTimelineEntry } from './agent-timeline'
import { identityMismatch } from './agent-session-view'
import {
  AGENT_WRITE_TOOLS,
  type AgentChangeAnswer,
  type AgentChangeAttribution,
  type AgentChangeOffer,
  type AgentChangeRefusal,
  type AgentChangeReview,
  type AgentChangeRoute,
  type AgentChangeRow,
  type AgentChangeVerdict,
  type AgentWriteCall,
  type AgentWriteResult,
} from './agent-change-vocabulary'

/**
 * Every name this module exported before the vocabulary moved, still importable from here.
 *
 * The specifier a caller already names is *this file* — `agent-note-proposals.ts` takes
 * `AGENT_WRITE_TOOLS`, `AgentChangesView.vue` and `AgentChangedFiles.vue` take the row and the
 * answer, and this service's own test takes the review — so moving the vocabulary is a change to
 * where those names live and not to where a caller imports them from.
 */
export {
  AGENT_WRITE_TOOLS,
  type AgentChangeAnswer,
  type AgentChangeAttribution,
  type AgentChangeDecision,
  type AgentChangeOffer,
  type AgentChangeRefusal,
  type AgentChangeRejection,
  type AgentChangeReview,
  type AgentChangeRoute,
  type AgentChangeRow,
  type AgentChangeVerdict,
  type AgentWriteCall,
  type AgentWriteResult,
} from './agent-change-vocabulary'

/** The facts of one tool call, as the wire's payload and the timeline's row both carry them. They
 *  differ in one name only (`kind` against `toolKind`), which is why the kind is an argument.
 *
 *  It lives here rather than in the vocabulary beside its neighbours because it is not part of what
 *  this module hands out: one private function reads it, and a type a single caller names is not a
 *  name to export. */
interface AgentToolCallFacts {
  readonly toolCallId: string
  readonly paths: readonly string[]
  readonly status: AgentToolStatus
  readonly content: readonly AgentToolContent[]
}

/** A review with nothing in it yet. A session that has touched nothing has an empty record, not a
 *  missing one — the same choice the context draft makes, so there is no null case to handle. */
export function createChangeReview(identity: AgentIdentity): AgentChangeReview {
  return Object.freeze({
    identity: Object.freeze({ ...identity }),
    writes: Object.freeze([]),
    reported: Object.freeze([]),
    observed: Object.freeze([]),
    baselines: Object.freeze([]),
    decisions: Object.freeze([]),
  })
}

function withWrites(review: AgentChangeReview, writes: readonly AgentWriteCall[]): AgentChangeReview {
  return { ...review, writes: Object.freeze(writes) }
}

/** The texts a call's own `diff` blocks say they left, in the engine's order. A block with no path
 *  is dropped: a row is addressed by a path, and a text with nothing to attach it to is not
 *  evidence about any file. */
function resultsOf(content: readonly AgentToolContent[]): readonly AgentWriteResult[] {
  const results: AgentWriteResult[] = []
  for (const block of content) {
    if (block.type !== 'diff' || block.path === '') continue
    results.push(Object.freeze({ path: block.path, text: block.newText }))
  }
  return Object.freeze(results)
}

/**
 * One tool call as the review keeps it, or null when it is not evidence about a file.
 *
 * The single place the rule lives, and both producers go through it: the event fold and
 * {@link reviewOfSession} see the same four facts under two spellings, and a review that classified
 * them twice could attribute a file by one path and not by the other.
 *
 * Kinds that are not writes are *not stored at all*, not stored-and-ignored: a `read` call names
 * the file it read, and keeping that as evidence would leave a later bug one comparison away from
 * showing the user "the agent changed this note" about a note the agent only opened.
 */
function writeCallOf(call: AgentToolCallFacts, kind: AgentToolKind): AgentWriteCall | null {
  if (!AGENT_WRITE_TOOLS.includes(kind) || call.paths.length === 0) return null
  return Object.freeze({
    toolCallId: call.toolCallId,
    tool: kind,
    paths: Object.freeze([...call.paths]),
    status: call.status,
    results: resultsOf(call.content),
  })
}

/** What one session's record holds, as a review needs it: the transcript's rows, and the engine's
 *  own list of the paths it touched (`AgentSessionView` satisfies this structurally). */
export interface AgentChangeSource {
  readonly timeline: readonly AgentTimelineEntry[]
  readonly changedFiles: readonly string[]
}

/**
 * The review the session's own record supports — the producer the app uses.
 *
 * `baselines` is the record's `edits`, and it is an argument rather than a lookup because a value
 * that could ask a store a question later would be a second answer to "which version was this
 * request made against" — the mismatch the whole feature exists to prevent. Nothing is decided
 * here: the rows are built by {@link changeRows} from this value and the live buffer, so a surface
 * cannot show one account and act on another.
 */
export function reviewOfSession(
  identity: AgentIdentity,
  source: AgentChangeSource,
  baselines: readonly AgentEditBaseline[],
): AgentChangeReview {
  const held = createChangeReview(identity)
  const writes: AgentWriteCall[] = []
  for (const entry of source.timeline) {
    if (entry.kind !== 'tool') continue
    const call = writeCallOf(entry, entry.toolKind)
    if (call === null) continue
    // The transcript folds the wire's `tool_call` and its updates into one row per id; this is the
    // same fold one level up, so a record that somehow holds two rows for one call still produces
    // one row here.
    const at = writes.findIndex((candidate) => candidate.toolCallId === call.toolCallId)
    if (at === -1) writes.push(call)
    else writes[at] = call
  }
  return Object.freeze({
    identity: held.identity,
    writes: Object.freeze(writes),
    reported: appendPaths(Object.freeze([]), source.changedFiles),
    observed: held.observed,
    baselines: Object.freeze([...baselines]),
    decisions: held.decisions,
  })
}

/**
 * Record the user's answer about one change.
 *
 * A second answer for the same change replaces the first — the row is a decision, and keeping both
 * would leave the view choosing which of two decisions to draw. The answer is copied, so nothing
 * the caller keeps a handle on can change what a row already shows.
 */
export function decideChange(review: AgentChangeReview, answer: AgentChangeAnswer): AgentChangeReview {
  const held = review.decisions.filter(
    (entry) => !(entry.path === answer.path && entry.toolCallId === answer.toolCallId),
  )
  return { ...review, decisions: Object.freeze([...held, Object.freeze({ ...answer })]) }
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
 * the same fold the timeline does for its tool rows, and the same one {@link writeCallOf} states.
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
      const entry = writeCallOf(call, call.kind)
      if (entry === null) return review
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

/** The baseline this window holds for `path`, if it holds one. The last one wins: a path named by
 *  two requests at different moments is judged against the newest version that was captured. */
function baselineFor(review: AgentChangeReview, path: string): AgentEditBaseline | null {
  let found: AgentEditBaseline | null = null
  for (const held of review.baselines) {
    if (held.path === path) found = held
  }
  return found
}

/** What the call said it left in `path`. The last block naming the path wins, as the last update
 *  to a call wins: a call that stated two texts for one file is judged against the newest. */
function resultFor(call: AgentWriteCall | null, path: string): string | null {
  let found: string | null = null
  for (const result of call?.results ?? []) {
    if (result.path === path) found = result.text
  }
  return found
}

/** The answer already given about one change, if one was. */
function decisionFor(
  review: AgentChangeReview,
  path: string,
  toolCallId: string | null,
): AgentChangeAnswer | null {
  if (toolCallId === null) return null
  return (
    review.decisions.find((entry) => entry.path === path && entry.toolCallId === toolCallId) ?? null
  )
}

/** Everything a row's judgement is made of, read once from the review and the live buffer. */
interface AgentChangeFacts {
  readonly path: string
  readonly attribution: AgentChangeAttribution
  readonly call: AgentWriteCall | null
  readonly note: AgentLiveNote | null
  readonly verdict: AgentChangeVerdict
  readonly result: string | null
}

/**
 * The offers for one row, and the one that was withheld.
 *
 * Eight questions in the order that makes a later answer meaningful, each about a different subject
 * — which is why each refusal is its own code rather than one "recovery failed":
 *
 *  *Answered?* An answered row offers nothing but looking: the answer was given about this change,
 *  and a row that kept offering the write would be asking again. *The agent's?* A path the engine
 *  merely reported or the watcher merely saw has no tool association with this session
 *  (§7.2「只有有可靠工具关联的变化标记为智能体修改」). *Finished writing?* A call still `pending` or
 *  `in_progress` would make the recovery a race between two writers that only one of them knows
 *  about. *A version to put back?* Without a baseline there is nothing to restore
 *  (§7.2「没有基线时标记不可直接恢复，不伪造「撤销成功」」). *The session's note?* A path is only a
 *  path inside one vault, and the baseline is the other vault's text (§6.2, which `judgeAgentEdit`
 *  asks the same way). *Anything to write into?* The window's one way into a note's file is the
 *  tab's own save transaction, and `view` is how the user opens the note it needs. *Would anything
 *  on screen show the outcome?* Not with an unsaved buffer: the file would go back to its baseline
 *  while the user's own text still sits ahead of it, so the next save would undo the "undo".
 *  *Still what the change left?* §7.2「恢复前检查当前内容是否仍等于已记录结果；不一致则三方比较/
 *  人工合并，不能覆盖用户后续编辑」 — the text the call stated is the witness, and a call that
 *  stated none leaves the question unanswerable, which is a refusal and not a guess.
 */
function judge(
  review: AgentChangeReview,
  facts: AgentChangeFacts,
): {
  offers: readonly AgentChangeOffer[]
  recoverVia: AgentChangeRoute | null
  refused: AgentChangeRefusal | null
} {
  const { path, attribution, call, note, verdict, result } = facts
  const offers: AgentChangeOffer[] = ['view']
  /** The refusal arms, in one place, so every early return says the same three fields. */
  const refuse = (
    refusal: AgentChangeRefusal,
  ): {
    offers: readonly AgentChangeOffer[]
    recoverVia: AgentChangeRoute | null
    refused: AgentChangeRefusal | null
  } => ({ offers: Object.freeze(offers), recoverVia: null, refused: refusal })
  const through = (
    route: AgentChangeRoute,
  ): {
    offers: readonly AgentChangeOffer[]
    recoverVia: AgentChangeRoute | null
    refused: AgentChangeRefusal | null
  } => {
    offers.push('recover')
    return { offers: Object.freeze(offers), recoverVia: route, refused: null }
  }

  if (call !== null && decisionFor(review, path, call.toolCallId) !== null) {
    return { offers: Object.freeze(offers), recoverVia: null, refused: null }
  }
  if (attribution !== 'agent' || call === null) {
    return refuse({ reason: 'not-agent-change', attribution })
  }
  if (call.status === 'pending' || call.status === 'in_progress') {
    return refuse({ reason: 'write-in-flight', toolCallId: call.toolCallId })
  }
  if (note !== null && note.vaultId !== review.identity.vaultId) {
    return refuse({
      reason: 'vault-mismatch',
      path,
      noteVaultId: note.vaultId,
      sessionVaultId: review.identity.vaultId,
    })
  }
  // **No tab holds the file, so the host is the writer.** This comes before the baseline question
  // rather than after it, and the order is the point: the window's baseline is a note the *tab*
  // captured at the send, so a file no tab holds is precisely the one whose window baseline is
  // missing — asking about it first made every closed note answer 「no request named this file」
  // and offer nothing, which is the dead end `AgentGateway.recoverChange` removed. The host judges
  // its own record, against the file's hash, and answers `no-baseline` itself when it has none.
  //
  // Nothing is skipped by going through the host: the vault check above still applies, and the
  // checks below — the call's stated result, the buffer's text — are about a *buffer*, which is
  // what there is none of here.
  if (verdict.kind === 'record') {
    return through('host')
  }
  const baseline = baselineFor(review, path)
  if (baseline === null) {
    return refuse({ reason: 'no-baseline', path })
  }
  if (verdict.kind === 'unsaved-edits') {
    return refuse({ reason: 'unsaved-edits', path })
  }
  if (result === null) {
    return refuse({ reason: 'result-unstated', path })
  }
  // The buffer is clean here, so its text is the file's — which is the comparison §7.2 asks for.
  if (note === null || note.buffer.text !== result) {
    return refuse({ reason: 'changed-since', path })
  }
  return through('editor')
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
    const note = live(path)
    const verdict = verdictFor(note)
    const result = resultFor(call, path)
    const { offers, recoverVia, refused } = judge(review, {
      path,
      attribution,
      call,
      note,
      verdict,
      result,
    })
    return Object.freeze({
      path,
      attribution,
      toolCallId: call?.toolCallId ?? null,
      tool: call?.tool ?? null,
      status: call?.status ?? null,
      verdict,
      result,
      baseline: baselineFor(review, path)?.text ?? null,
      offers,
      recoverVia,
      refused,
      decision: decisionFor(review, path, call?.toolCallId ?? null),
    })
  })
  return Object.freeze(rows)
}
