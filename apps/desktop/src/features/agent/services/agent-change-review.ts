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
 */

import type {
  AgentChangeRecovery,
  AgentEvent,
  AgentIdentity,
  AgentToolContent,
  AgentToolKind,
  AgentToolStatus,
} from '../../../platform/gateways/agent-contracts'
import type { AgentLiveNote } from './agent-context-snapshot'
import type { AgentEditBaseline, AgentEditWriteOutcome } from './agent-edit-apply'
import type { AgentTimelineEntry } from './agent-timeline'
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

/** The text one `diff` block of a call says the file holds afterwards, by the path it names. */
export interface AgentWriteResult {
  readonly path: string
  readonly text: string
}

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
  /**
   * What the call's own `diff` blocks said they left, keyed by the path in the block — the second
   * witness a recovery is judged against (§7.2's 「恢复前检查当前内容是否仍等于已记录结果」).
   *
   * Empty for a call that carried no block, which is a fact and not a placeholder: the engine named
   * a path and said nothing about the text, and the row refuses recovery rather than guessing which
   * text is the agent's.
   */
  readonly results: readonly AgentWriteResult[]
}

/** The facts of one tool call, as the wire's payload and the timeline's row both carry them. They
 *  differ in one name only (`kind` against `toolKind`), which is why the kind is an argument. */
interface AgentToolCallFacts {
  readonly toolCallId: string
  readonly paths: readonly string[]
  readonly status: AgentToolStatus
  readonly content: readonly AgentToolContent[]
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
  /** The text each path held when the request that named it was submitted — §7.2's baseline, and
   *  the whole of what a recovery restores. Captured at the send (`stores/agent-session.ts`). */
  readonly baselines: readonly AgentEditBaseline[]
  /** What the user has answered about the changes on this list, one entry per change. */
  readonly decisions: readonly AgentChangeAnswer[]
}

/** What the user answered about one change. */
export type AgentChangeDecision = 'kept' | 'rejected'

/**
 * What a rejection did, in the three ways one can end — and they are three because they are made
 * by two different writers plus the case where neither ran.
 *
 * `editor` is the note's own save transaction while a tab holds it (`agent-edit-apply.ts`'s write
 * outcome, reused rather than respelled: "the note and the file have it", "the note has it and the
 * file does not" and "nothing took it" are the same three facts here as there). `host` is the
 * app's own recovery, and its answer is the host's — a file put back, or one of the six reasons it
 * would not be. `unreachable` is the call that never happened: no runtime, a session this host
 * does not hold, an engine that went away mid-call. Its `message` is the host's own sentence,
 * which is the part the reader acts on, and it is *not* folded into a refusal code because nobody
 * refused anything — the request was never answered.
 */
export type AgentChangeRejection =
  | { readonly via: 'editor'; readonly written: AgentEditWriteOutcome }
  | { readonly via: 'host'; readonly answered: AgentChangeRecovery }
  | { readonly via: 'unreachable'; readonly message: string }

/**
 * One answer, and it is about *a change* rather than about a path.
 *
 * `toolCallId` is part of the key on purpose: the engine writing the same note again is a change
 * nobody has looked at, and a row that read "kept" there would be hiding work the user has not
 * seen. `rejection` is what a rejection did and is `null` for a keep, which writes nothing.
 */
export interface AgentChangeAnswer {
  readonly path: string
  readonly toolCallId: string
  readonly decision: AgentChangeDecision
  readonly rejection: AgentChangeRejection | null
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
export type AgentChangeOffer = 'view' | 'recover'

/**
 * Which of the app's two writers a recovery would go through.
 *
 * There are two because a note is reachable in two ways, and which one applies is a fact about
 * the *file*, not a preference:
 *
 *  - `editor` — a tab holds the note. The write is the note's own save transaction
 *    (`agent-note-write.ts`): the buffer, the vault check and the external write precondition all
 *    apply, and the pane that owns the text is asked first. That is the app's one path into an open
 *    file, and nothing here may go around it.
 *  - `host` — no tab holds it. The host that *performed* the vetted write holds the bytes it
 *    replaced, and `AgentGateway.recoverChange` puts them back through the app's own save path
 *    without a buffer involved. Before that call existed this case was a dead end: a row could say
 *    the note had no tab and offer nothing, which is exactly the note a reader is least likely to
 *    have open — the one the agent went and changed.
 */
export type AgentChangeRoute = 'editor' | 'host'

/**
 * Why an offer this row could otherwise have is not made — a code, not a sentence, because the UI
 * owns the wording and a service that returned text would have to invent it in two languages.
 *
 * Every clause of §7.2's recovery rule, plus the one thing the review itself must never do — put a
 * file back while the engine is still writing it. Each arm names a different thing for the user to
 * do, which is why they are not one refusal: a file the engine only reported, a write still in
 * flight, a version nothing kept, a note in the wrong vault, a note with no tab to write into, a
 * note the user is editing, and a note that is no longer what the agent left are seven different
 * situations, and folding them into one "recovery failed" would tell the user nothing about which.
 */
export type AgentChangeRefusal =
  | { readonly reason: 'not-agent-change'; readonly attribution: AgentChangeAttribution }
  | { readonly reason: 'write-in-flight'; readonly toolCallId: string }
  /** §7.2's 「没有基线时标记不可直接恢复」: no request named this path, so no version of it was
   *  kept, and there is nothing a recovery could put back. */
  | { readonly reason: 'no-baseline'; readonly path: string }
  /** The note the lookup answered with belongs to another vault than the session's. A path is only
   *  a path inside one vault, and the baseline is the other vault's text. */
  | {
      readonly reason: 'vault-mismatch'
      readonly path: string
      readonly noteVaultId: string
      readonly sessionVaultId: string
    }
  | { readonly reason: 'unsaved-edits'; readonly path: string }
  /** The call stated no text for this path, so the app cannot tell the agent's text from the
   *  user's own later edit — and overwriting on a guess is the silent loss §7.2 rules out. */
  | { readonly reason: 'result-unstated'; readonly path: string }
  /** The note is no longer what the call left: somebody edited it after the agent wrote it, and a
   *  recovery would take that edit away. §7.2's 「不一致则三方比较/人工合并，不能覆盖用户后续编辑」. */
  | { readonly reason: 'changed-since'; readonly path: string }

/** One file, as the review sees it. Plain frozen data: the view renders this and decides nothing. */
export interface AgentChangeRow {
  readonly path: string
  readonly attribution: AgentChangeAttribution
  /** The call that named this path, when one did — what an `agent` row's claim rests on. */
  readonly toolCallId: string | null
  readonly tool: AgentToolKind | null
  readonly status: AgentToolStatus | null
  readonly verdict: AgentChangeVerdict
  /** The text the call said it left in this path, or null when it stated none. The second witness
   *  a recovery is judged against, and what a merge-shaped row shows beside the user's own. */
  readonly result: string | null
  /** The text this path held when the request that named it was submitted, or null when none did. */
  readonly baseline: string | null
  /** The offers that survive the judgement, in the order the view shows them. */
  readonly offers: readonly AgentChangeOffer[]
  /**
   * Which writer a `recover` would use, or null when the row is not offering one.
   *
   * A property of the row rather than something a view derives from `verdict`, for the reason the
   * whole file exists: the decision about *how* a change may be put back is made where the tool
   * call, the buffer and the host's answer can all be seen at once, and a component that re-derived
   * it from `verdict.kind` would be a second judgement that could disagree with this one.
   */
  readonly recoverVia: AgentChangeRoute | null
  /** The one offer that was withheld, if one was. */
  readonly refused: AgentChangeRefusal | null
  /** What the user answered about this change, or null while it is unanswered. */
  readonly decision: AgentChangeAnswer | null
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
