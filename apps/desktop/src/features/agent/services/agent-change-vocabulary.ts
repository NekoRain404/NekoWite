/**
 * The change review's vocabulary: the shapes it hands out and the shapes it is handed.
 *
 * These declarations were the first half of `agent-change-review.ts`, and they are a module of their
 * own because they change for a different reason than the rules beside them do.
 *
 * This file is the review's *interface*, and four modules speak it: `AgentChangesView.vue` renders
 * {@link AgentChangeRow}, `AgentChangedFiles.vue` reads the rows back and answers with
 * {@link AgentChangeAnswer}, `agent-note-proposals.ts` asks {@link AGENT_WRITE_TOOLS} which tool
 * kinds mean a file was written, and the e2e fixture hands the review service a value of
 * {@link AgentChangeReview}. A field added for the view's sake moves this file and no rule —
 * `recoverVia` is one, and it exists so that a component cannot re-derive the route and disagree
 * with the judgement it was given. The rules move without this file too: the order the judgement
 * asks its questions in was corrected once, and not a line here changed (the note at the `record`
 * arm of that judgement says what the old order cost).
 *
 * The arrangement is this repository's for exactly this case: `agent_runtime/permissions.rs`
 * declares `PermissionPrompt` in `permissions/payload.rs` beside its caller, and
 * `agent-panel-labels.ts` holds `AgentPanelLabels` beside `AgentPanel.vue`. `agent-change-review.ts`
 * re-exports every name below, so no existing import path changes.
 */

import type {
  AgentChangeRecovery,
  AgentIdentity,
  AgentToolKind,
  AgentToolStatus,
} from '../../../platform/gateways/agent-contracts'
import type { AgentEditBaseline, AgentEditWriteOutcome } from './agent-edit-apply'

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
