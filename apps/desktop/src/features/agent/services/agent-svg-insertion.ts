/**
 * SVG insertion: the note edit that may follow a preview, and the vocabulary it is asked in.
 *
 * §7.3 is the specification. Its first three clauses are the safety half, and they live beside this
 * file in `agent-svg-inspection.ts` with the code they describe — waiting for the write, parsing
 * rather than pattern-matching, and the preview as a branded value only the judgement can mint. Its
 * last three are the ones this file keeps, and each forbids a different way of pretending an insert
 * succeeded:
 *
 *  4. **After confirmation, the existing path** (「用户确认插入后走现有附件保存和 Markdown 链接能力，处理相对路径、
 *     空格与同名冲突」): the name, the location, the reference and the markdown block come from the
 *     attachments feature; what is added here is the same-name step, reported.
 *  5. **Bound to the document and the spot** (「插入绑定原文档 revision 和锚点；用户已经切换笔记或移动编辑位置时
 *     重新确认，不插到新活动文档」): the commit re-checks identity, path, revision and anchor against
 *     the editor's *current* account of that path — never "the active note" — and refuses instead of
 *     inserting somewhere else. {@link retargetSvgInsertion} is the re-confirmation.
 *  6. **Raw and preview stay apart** (「原始 SVG 与安全预览产物分开管理」): the plan names the staged file
 *     the caller copies and the verified preview, and writes neither. What lands in the vault is the
 *     agent's own artifact, which verification proved holds only allowlisted constructs.
 *
 * The split is by reason to change, which is what makes it a move rather than a trim: a new attack
 * shape changes the judgement and nothing below, and a change to how a note is edited changes
 * everything below and not the judgement. `agent-svg-inspection.ts` is also where the two halves
 * meet — this file holds a preview only as the value a plan carries, and never inspects one.
 *
 * The shape is this feature's: plain frozen values, a discriminated result per operation instead of
 * exceptions, no clock and no store (the month directory's clock is passed in).
 */

import type { AgentIdentity } from '../../../platform/gateways/agent-contracts'
import {
  attachmentRelativePath,
  markdownImageBlock,
  relativePathFromNoteVault,
  sanitizeAttachmentFileName,
} from '../../attachments'
import type { AgentLiveNote } from './agent-context-snapshot'
import type { AgentSvgPreview } from './agent-svg-inspection'
import { identityMismatch, type AgentIdentityField } from './agent-session-view'

// The preview half is declared beside this file — `agent-svg-inspection.ts` — and re-exported whole,
// which is what makes the split a move rather than a relocation of the callers' problem: every path
// that imports `agent-svg-insertion` (the note-svg service, the insertion binding, the composition,
// both suites) keeps resolving `inspectStagedSvg`, the bounds and the staged/preview/refusal
// vocabulary from here, unchanged. `stores/settings.ts` re-exports its slices the same way, and
// `agent_runtime/permissions.rs` the payload it moved beside itself.
export * from './agent-svg-inspection'

/** How much text either side of an anchor is kept as its fingerprint: enough that a caret cannot
 *  resolve elsewhere after an edit, little enough to stay a fingerprint. */
export const ANCHOR_CONTEXT_CHARS = 32

/** How many `-2`, `-3` … suffixes are tried before a name is called unavailable. */
export const MAX_ATTACHMENT_NAME_ATTEMPTS = 100

/**
 * Where in a note the link goes, and what was there when the user pointed at it.
 *
 * Offsets alone are not an anchor: a caret has no text, so an edit before it moves it silently. The
 * three strings are the fingerprint — the replaced text and a little either side — and they are what
 * {@link commitSvgInsertion} compares against the note's current text.
 */
export interface AgentInsertionAnchor {
  readonly from: number
  readonly to: number
  readonly selected: string
  readonly before: string
  readonly after: string
}

/** One note and the spot in it, as the user pointed at them. The session identity travels with the
 *  document facts because §6.2 holds snapshots and indices to one composite boundary, and an insert
 *  planned under one session must not land under another — a restarted runtime looks the same. */
export interface AgentInsertionTarget {
  readonly identity: AgentIdentity
  readonly path: string
  readonly revision: string
  readonly anchor: AgentInsertionAnchor
}

/** Why a capture, a plan or a commit did not happen. */
export type AgentInsertionRefusal =
  | { readonly reason: 'note-not-open'; readonly path: string }
  | { readonly reason: 'vault-mismatch'; readonly path: string; readonly itemVaultId: string; readonly contextVaultId: string }
  | { readonly reason: 'anchor-out-of-range'; readonly path: string; readonly from: number; readonly to: number }
  | { readonly reason: 'identity-changed'; readonly field: AgentIdentityField }
  | { readonly reason: 'target-changed'; readonly path: string; readonly plannedPath: string }
  | { readonly reason: 'revision-changed'; readonly path: string; readonly plannedRevision: string; readonly currentRevision: string }
  | { readonly reason: 'anchor-moved'; readonly path: string }
  | { readonly reason: 'invalid-file-name'; readonly name: string }
  | { readonly reason: 'name-unavailable'; readonly name: string }
  | { readonly reason: 'attachment-not-saved'; readonly path: string }

export type AgentInsertionCapture =
  | { readonly status: 'captured'; readonly target: AgentInsertionTarget }
  | { readonly status: 'refused'; readonly refusal: AgentInsertionRefusal }

/** Where the file goes and what is already there. All three are the caller's to know: this module
 *  reads no clock, lists no directory and resolves no vault. */
export interface AgentInsertionDestination {
  /** The vault root, so an absolute note path (the editor's own spelling) can be rebased. */
  readonly vaultRoot: string
  /** The names already in the destination month directory, for the same-name case. */
  readonly takenNames: readonly string[]
  readonly now: Date
}

export interface AgentInsertionPlanRequest {
  readonly preview: AgentSvgPreview
  readonly target: AgentInsertionTarget
  /** The identity in force now: a target captured under another session is refused, not used. */
  readonly identity: AgentIdentity
  readonly destination: AgentInsertionDestination
  /** The name the user kept or typed for the vault file; sanitised and `.svg`-suffixed. */
  readonly fileName: string
  /** Alt text; the file's stem when absent. */
  readonly alt?: string
}

/**
 * Everything a confirmed insert consists of, decided before anything is written. Both artifacts are
 * named and neither is rewritten: `stagedPath` is the file the caller copies into the vault,
 * `preview` is the verified value the panel draws. `insert` is the exact text the note gains, so the
 * caller applies one edit rather than assembling markdown of its own.
 */
export interface AgentSvgInsertionPlan {
  readonly identity: AgentIdentity
  readonly path: string
  readonly revision: string
  readonly anchor: AgentInsertionAnchor
  readonly stagedPath: string
  readonly preview: AgentSvgPreview
  readonly fileName: string
  readonly vaultPath: string
  readonly markdownSrc: string
  readonly insert: string
  /** The name the artifact arrived with, when the vault's name had to differ from it. */
  readonly renamedFrom: string | null
  /** Kept although the reference is already computed, because placing this insertion again rebuilds
   *  that reference for another note's directory — and must not re-resolve the name. */
  readonly vaultRoot: string
  readonly alt: string
}

export type AgentInsertionPlanResult =
  | { readonly status: 'planned'; readonly plan: AgentSvgInsertionPlan }
  | { readonly status: 'refused'; readonly refusal: AgentInsertionRefusal }

/** What the caller has already written when it asks for the note edit. The order cannot be checked
 *  here — a note that links a file nothing wrote is the outcome this refuses. */
export interface AgentInsertionCommitRequest {
  /** The editor's account of *the planned path*, or null when no tab holds it. */
  readonly live: AgentLiveNote | null
  readonly identity: AgentIdentity
  readonly attachmentSaved: boolean
}

export type AgentInsertionChange = { readonly from: number; readonly to: number; readonly insert: string }

export type AgentInsertionOutcome =
  | { readonly status: 'inserted'; readonly path: string; readonly change: AgentInsertionChange; readonly markdownSrc: string }
  /** `attachmentSaved` is what the caller had already done: what "the note is untouched, the file is
   *  there" has to be told from "nothing happened at all". */
  | { readonly status: 'refused'; readonly refusal: AgentInsertionRefusal; readonly attachmentSaved: boolean }

/**
 * The anchor for a range of a note's text, or null when the range is not in that text.
 *
 * Null rather than a refusal because this is arithmetic: a caller whose offsets do not fit the text
 * it handed over has a bug or a race, and there is no insertion to describe.
 */
export function captureInsertionAnchor(text: string, from: number, to: number): AgentInsertionAnchor | null {
  if (!Number.isInteger(from) || !Number.isInteger(to)) return null
  if (from < 0 || to < from || to > text.length) return null
  return Object.freeze({
    from,
    to,
    selected: text.slice(from, to),
    before: text.slice(Math.max(0, from - ANCHOR_CONTEXT_CHARS), from),
    after: text.slice(to, to + ANCHOR_CONTEXT_CHARS),
  })
}

/** Whether the anchor still describes the same spot: the range is there and the text under and around
 *  it is what was recorded. Both halves matter — the offsets catch an edit before the anchor, the
 *  fingerprint catches one *at* it, which leaves the offsets identical. */
function anchorHolds(text: string, anchor: AgentInsertionAnchor): boolean {
  if (anchor.from < anchor.before.length || anchor.to < anchor.from) return false
  if (anchor.to + anchor.after.length > text.length) return false
  if (text.slice(anchor.from, anchor.to) !== anchor.selected) return false
  if (text.slice(anchor.from - anchor.before.length, anchor.from) !== anchor.before) return false
  return text.slice(anchor.to, anchor.to + anchor.after.length) === anchor.after
}

/** The five identity fields, copied into a plain frozen object. Nothing else rides along — an
 *  `AgentSession` also carries behaviour, and none of it belongs in a value read back later. */
function copyIdentity(identity: AgentIdentity): AgentIdentity {
  return Object.freeze({
    agentId: identity.agentId,
    profileId: identity.profileId,
    runtimeEpoch: identity.runtimeEpoch,
    vaultId: identity.vaultId,
    sessionId: identity.sessionId,
  })
}

/**
 * Capture the note the user is pointing at, or why not.
 *
 * The caller has already looked the note up, so the only answers are the target and the two facts
 * that make an insertion into it wrong: it belongs to another vault, or the editor's range does not
 * describe a spot in the text it handed over. The vault check is §6.2's composite boundary, refused
 * where the user points the way the context snapshot refuses a foreign item, rather than carried to a
 * commit that would notice it late.
 */
export function captureInsertionTarget(
  live: AgentLiveNote,
  identity: AgentIdentity,
  range: { readonly from: number; readonly to: number },
): AgentInsertionCapture {
  if (live.vaultId !== identity.vaultId) {
    const refusal: AgentInsertionRefusal = {
      reason: 'vault-mismatch',
      path: live.path,
      itemVaultId: live.vaultId,
      contextVaultId: identity.vaultId,
    }
    return { status: 'refused', refusal }
  }
  const anchor = captureInsertionAnchor(live.buffer.text, range.from, range.to)
  if (anchor === null) {
    const refusal: AgentInsertionRefusal = {
      reason: 'anchor-out-of-range',
      path: live.path,
      from: range.from,
      to: range.to,
    }
    return { status: 'refused', refusal }
  }
  const target: AgentInsertionTarget = Object.freeze({
    identity: copyIdentity(identity),
    path: live.path,
    revision: live.revision,
    anchor,
  })
  return { status: 'captured', target }
}

type ResolvedName = { readonly fileName: string; readonly renamedFrom: string | null }

/**
 * The vault name: sanitised by the attachments feature's own rule, given `.svg`, and made unique
 * against what the destination already holds.
 *
 * The comparison is case-insensitive even though the vault is Linux-only: two names differing in
 * case are two files that read as one to the user, and a vault that reaches another machine is a
 * vault that will disagree about them.
 */
function resolveAssetName(offered: string, takenNames: readonly string[]): ResolvedName | AgentInsertionRefusal {
  if (!/[\p{Letter}\p{Number}]/u.test(offered)) return { reason: 'invalid-file-name', name: offered }
  const stem = sanitizeAttachmentFileName(offered.replace(/\.svg$/i, ''))
  const taken = new Set(takenNames.map((name) => name.toLowerCase()))
  for (let attempt = 1; attempt <= MAX_ATTACHMENT_NAME_ATTEMPTS; attempt += 1) {
    const candidate = attempt === 1 ? `${stem}.svg` : `${stem}-${attempt}.svg`
    if (!taken.has(candidate.toLowerCase())) {
      return { fileName: candidate, renamedFrom: candidate === offered ? null : offered }
    }
  }
  return { reason: 'name-unavailable', name: offered }
}

/**
 * Decide the whole insertion: the vault name, the reference and the exact text the note gains.
 *
 * Everything here is a decision and nothing here is a write. The caller saves the attachment the plan
 * names and then asks {@link commitSvgInsertion} for the note edit; the plan can be retargeted in
 * between, which is what makes §7.3's re-confirmation a cheap answer instead of a second copy of the
 * picture.
 */
export function planSvgInsertion(request: AgentInsertionPlanRequest): AgentInsertionPlanResult {
  const { target, destination } = request
  const mismatch = identityMismatch(target.identity, request.identity)
  if (mismatch !== null) return { status: 'refused', refusal: { reason: 'identity-changed', field: mismatch } }

  const resolved = resolveAssetName(request.fileName, destination.takenNames)
  if ('reason' in resolved) return { status: 'refused', refusal: resolved }

  const vaultPath = attachmentRelativePath(resolved.fileName, destination.now)
  const markdownSrc = relativePathFromNoteVault(target.path, destination.vaultRoot, vaultPath)
  const alt = request.alt ?? resolved.fileName.replace(/\.svg$/i, '')
  const plan: AgentSvgInsertionPlan = Object.freeze({
    identity: copyIdentity(target.identity),
    path: target.path,
    revision: target.revision,
    anchor: target.anchor,
    stagedPath: request.preview.stagedPath,
    preview: request.preview,
    fileName: resolved.fileName,
    vaultPath,
    markdownSrc,
    insert: markdownImageBlock(alt, markdownSrc),
    renamedFrom: resolved.renamedFrom,
    vaultRoot: destination.vaultRoot,
    alt,
  })
  return { status: 'planned', plan }
}

/**
 * The same insertion, placed again where the user says.
 *
 * The attachment half of the plan is kept exactly: the file may already be on disk under the name the
 * plan chose, so re-resolving it would write a `-2` copy of one picture. Only the target and the
 * reference move — the markdown src is measured from the note's own directory, so re-confirming in
 * another note gets a reference that resolves from there.
 */
export function retargetSvgInsertion(plan: AgentSvgInsertionPlan, target: AgentInsertionTarget): AgentSvgInsertionPlan {
  const markdownSrc = relativePathFromNoteVault(target.path, plan.vaultRoot, plan.vaultPath)
  return Object.freeze({
    ...plan,
    identity: copyIdentity(target.identity),
    path: target.path,
    revision: target.revision,
    anchor: target.anchor,
    markdownSrc,
    insert: markdownImageBlock(plan.alt, markdownSrc),
  })
}

/**
 * The note edit, or why there is not one.
 *
 * Every check that made the plan is taken again here, against the editor's account of *this path* at
 * this instant: the target may be a different note (the user switched), the same note at another
 * revision (it was edited, or an external write landed), or the same text with the spot gone (the
 * text under it changed while the offsets did not). Each refuses rather than inserting somewhere
 * plausible, because "it went in near where you meant" is not an outcome the user can tell from the
 * one they asked for.
 *
 * `attachmentSaved` is the caller's report of what it has already done, and it is required rather
 * than assumed: the note must not link a file nothing wrote. A refusal carries it back, so the caller
 * can say whether anything reached the disk.
 */
export function commitSvgInsertion(
  plan: AgentSvgInsertionPlan,
  request: AgentInsertionCommitRequest,
): AgentInsertionOutcome {
  const refuse = (refusal: AgentInsertionRefusal): AgentInsertionOutcome => ({
    status: 'refused',
    refusal,
    attachmentSaved: request.attachmentSaved,
  })

  const mismatch = identityMismatch(plan.identity, request.identity)
  if (mismatch !== null) return refuse({ reason: 'identity-changed', field: mismatch })
  const live = request.live
  if (live === null) return refuse({ reason: 'note-not-open', path: plan.path })
  if (live.path !== plan.path) return refuse({ reason: 'target-changed', path: live.path, plannedPath: plan.path })
  if (live.vaultId !== plan.identity.vaultId) {
    return refuse({
      reason: 'vault-mismatch',
      path: plan.path,
      itemVaultId: live.vaultId,
      contextVaultId: plan.identity.vaultId,
    })
  }
  if (live.revision !== plan.revision) {
    return refuse({
      reason: 'revision-changed',
      path: plan.path,
      plannedRevision: plan.revision,
      currentRevision: live.revision,
    })
  }
  if (!anchorHolds(live.buffer.text, plan.anchor)) return refuse({ reason: 'anchor-moved', path: plan.path })
  if (!request.attachmentSaved) return refuse({ reason: 'attachment-not-saved', path: plan.vaultPath })

  return {
    status: 'inserted',
    path: plan.path,
    change: { from: plan.anchor.from, to: plan.anchor.to, insert: plan.insert },
    markdownSrc: plan.markdownSrc,
  }
}
