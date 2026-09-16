/**
 * The context snapshot: what a run is given, taken once and frozen where it is taken.
 *
 * §7.1 fixes the note, the range and the attachments before sending and forbids re-reading "the
 * current note" afterwards (「异步阶段不重新读取「当前活动笔记」」) — because the failure is silent: the user
 * attaches a note, sends, and switches tab or vault while the prompt is in flight; a prompt that
 * resolves the active note when it is finally built reads a different one than the row on screen.
 *
 * The answer is structural rather than careful. A capture reads the live values it is handed once
 * and copies the fields it knows into plain data; the committed value holds no function, store,
 * editor object or `File`, so a later read has nothing left to resolve. `commitContext` is the
 * freeze point, and the brand on {@link AgentContextSnapshot} makes its result the only value a
 * dispatch can accept — a hand-made object cannot pass itself off as one that went through the vault
 * and capability checks.
 *
 * The draft is everything before that: items are added, replaced and withdrawn while the user is
 * still composing, and a withdrawal decides what the *next* commit carries. It never reaches into a
 * commit that already happened, so a run in flight keeps what was sent, whatever happens next.
 *
 * Nothing is implicit: no call attaches a vault, a directory or a note's neighbours, which is how
 * 「不自动上传整个笔记库、密钥文件或所有附件」 stays true by construction, and the list is a value the UI can
 * render and take apart (「上下文列表可查看和移除」). A file the model cannot take is refused, never dropped:
 * a silent drop would leave the user believing the model saw it.
 *
 * This describes what a run was given; it is not a boundary around what it may read. §7.1's fourth
 * clause says a prompt cannot make an agent's tools read-only, so nothing here records an execution
 * limit: no field could be rendered as "the agent can only see this", and a UI must not try.
 */

import type { AgentIdentity } from '../../../platform/gateways/agent-contracts'

/**
 * Which of a note's two texts the run is given.
 *
 * The choice is the user's, because only they know whether an unsaved edit was meant to be part of
 * the question. {@link AgentContextNoteItem} carries this label next to `dirty`: the label says what
 * was attached, `dirty` says whether the other text differed, and a list showing only one of the two
 * would be telling the user something they cannot check.
 */
export type AgentNoteTextSource = 'buffer' | 'disk'

/**
 * The editor's own account of one note's text at capture.
 *
 * Two arms, because they are not symmetric: a clean buffer holds exactly what the file holds, so one
 * string is both texts, while a dirty buffer holds unsaved edits and may or may not have the file's
 * text to offer. `diskText: null` is "the file was not read", not "the file is empty" — the
 * distinction the tool-input contract draws between its absent and unreadable arms.
 */
export type AgentLiveNoteBuffer =
  | { state: 'clean'; text: string }
  | { state: 'dirty'; text: string; diskText: string | null }

/** One note as the editor has it, offered to a capture. Copied out of, never kept. */
export interface AgentLiveNote {
  /** The vault the note is open from; checked against the context's own vault. */
  vaultId: string
  path: string
  /**
   * The document-INSTANCE revision as the editor holds it **now** — the live one, not the one the
   * buffer was last synced with.
   *
   * This sentence used to read "the revision the buffer was last synced with — for a dirty buffer,
   * the revision its unsaved edits sit on top of", and the reading was wrong in the one place it
   * mattered: `agent-edit-apply.ts` judges a write against it and leans on it having moved with the
   * user's typing, and a lookup that answered with the synced revision would let an unsaved edit
   * pass for the state the request was made against. The two readings agree for a clean buffer —
   * there, the synced revision IS the live one — and the live one is the reading that makes both
   * consumers correct, so it is the one this field means.
   *
   * Two properties are the editor's to keep, and `stores/tabs.ts`'s `lookUpLiveNote` is where they
   * are kept: it changes when the text changes, including edits that never reached the disk, and it
   * changes when the document INSTANCE changes — a note closed and reopened at the same path is a
   * different document even when its bytes came back identical.
   */
  revision: string
  buffer: AgentLiveNoteBuffer
}

/**
 * What one lookup of a path answers, in full.
 *
 * Three arms rather than `AgentLiveNote | null`, because the two ways of not having a note are not
 * the same fact and only one of them may become disk. `not-held` is "no tab holds this path", and it
 * is the one arm a caller may answer from the file; `cannot-answer` is "a tab holds it and cannot
 * say what is in it yet" — a note still on its first read, whose tab holds a placeholder wearing the
 * note's path — and serving disk for it would serve the text the user is no longer looking at, which
 * is the silent failure this whole area keeps producing.
 *
 * {@link AgentLiveNote} is the `held` arm, not a sibling of this type: the conflict baseline and the
 * SVG insertion both take a note, and neither can act on a refusal.
 */
export type LiveNoteLookup =
  | { readonly kind: 'held'; readonly note: AgentLiveNote }
  | { readonly kind: 'not-held' }
  | { readonly kind: 'cannot-answer'; readonly reason: string }

/**
 * A selection as the editor has it.
 *
 * `from`/`to` are in the editor's own coordinates and are provenance only — what the list names the
 * range with, and what a later insertion re-checks it against. The text is what a run is given.
 */
export interface AgentLiveSelection {
  vaultId: string
  path: string
  revision: string
  from: number
  to: number
  text: string
  /** Whether the buffer it came from has unsaved edits. A selection is always buffer text, so
   *  unlike a note there is no second text to choose between — only this label. */
  dirty: boolean
}

/**
 * A file the user attached, as the picker described it.
 *
 * No vault id, unlike a note: an attachment comes from wherever the user was allowed to pick one,
 * including the staging directory an agent's own output lands in (§7.3), so claiming a vault would
 * be a guess. Nothing here is a handle — never an open `File`, buffer or URL, because those are live
 * references and nothing live may survive into a commit.
 */
export interface AgentLiveAttachment {
  path: string
  /** What to call it in the list: the picker's name, which need not be the path's basename. */
  name: string
  /** The file's media type. Normalized at capture rather than trusted as the caller typed it. */
  mediaType: string
  sizeBytes: number
}

/** What kind of thing an attachment is, in the vocabulary a model's capability list is written in. */
export type AgentAttachmentKind = 'image' | 'text' | 'pdf' | 'other'

/**
 * The attachment kinds the selected model is known to accept.
 *
 * Required, and required to be a list the caller actually has: an empty list means "this model takes
 * none", which is a different statement from "nobody told us", and treating the two alike would be
 * guessing on the user's behalf. A capability the host has not verified has to be refused here
 * (§7.1 「模型能力不足时拒绝不支持的附件」) rather than assumed and discarded down in the engine, where the
 * user cannot see it happen.
 */
export interface AgentModelCapabilities {
  readonly acceptedAttachmentKinds: readonly AgentAttachmentKind[]
}

export interface AgentContextNoteItem {
  readonly kind: 'note'
  /** Derived from kind and path, so re-capturing the same note replaces this row. */
  readonly id: string
  readonly vaultId: string
  readonly path: string
  readonly revision: string
  /** Whether the buffer held unsaved edits at capture. See {@link AgentLiveNoteBuffer}. */
  readonly dirty: boolean
  readonly content: { readonly source: AgentNoteTextSource; readonly text: string }
}

export interface AgentContextSelectionItem {
  readonly kind: 'selection'
  readonly id: string
  readonly vaultId: string
  readonly path: string
  readonly revision: string
  readonly from: number
  readonly to: number
  readonly text: string
  readonly dirty: boolean
}

export interface AgentContextAttachmentItem {
  readonly kind: 'attachment'
  readonly id: string
  readonly path: string
  readonly name: string
  /** Normalized at capture: the form the capability check matched, not the typed one. */
  readonly mediaType: string
  readonly sizeBytes: number
  readonly attachmentKind: AgentAttachmentKind
}

/**
 * One thing a run is given, and where it came from.
 *
 * Every arm carries the provenance the list has to name — path, revision, range, media type, size —
 * because "the agent saw this" is only checkable by the user if the row says which note, which
 * range, which file.
 */
export type AgentContextItem = AgentContextNoteItem | AgentContextSelectionItem | AgentContextAttachmentItem

declare const committedContext: unique symbol

/**
 * A context frozen at the moment of sending: the value a run is dispatched with.
 *
 * The brand is load-bearing rather than decorative, as the session handle's is: `commitContext` is
 * the only producer, so no caller can hand a dispatch an object it built itself and skip the vault
 * and capability checks. `identity` is copied field by field rather than referenced, because an
 * `AgentSession` also carries behavior (in the Tauri adapter, a way back to the host) and none of
 * that belongs in plain data.
 */
export interface AgentContextSnapshot {
  readonly [committedContext]: never
  readonly identity: AgentIdentity
  readonly items: readonly AgentContextItem[]
}

/**
 * The same value before it is committed: what the user is still editing.
 *
 * Structurally identical and deliberately a type of its own, so a call site says which moment it
 * means. Only `commitContext` answers with a snapshot, and only a snapshot can be sent.
 */
export interface AgentContextDraft {
  readonly identity: AgentIdentity
  readonly items: readonly AgentContextItem[]
}

/**
 * Why an item may not be sent — a code, not a sentence: the UI owns the wording and a service that
 * returned text would have to invent it in two languages.
 *
 * One arm per reason, because each is a different thing for the caller to do, and each carries the
 * data needed to name the offender — the vault it came from, the path, or the file.
 */
export type AgentContextRefusal =
  | { reason: 'vault-mismatch'; path: string; itemVaultId: string; contextVaultId: string }
  | { reason: 'disk-text-unavailable'; path: string }
  | { reason: 'empty-selection'; path: string }
  | { reason: 'unsupported-attachment'; path: string; mediaType: string; attachmentKind: AgentAttachmentKind }

/** What an attach or a replace did: the next draft, or why it did not happen. */
export type AgentContextEdit =
  | { status: 'applied'; draft: AgentContextDraft }
  | { status: 'refused'; refusal: AgentContextRefusal }

/**
 * What committing did. A refusal names the item it is about, so the caller can put the message next
 * to the row the user is looking at instead of leaving them to find it.
 */
export type AgentContextCommitResult =
  | { status: 'committed'; snapshot: AgentContextSnapshot }
  | { status: 'refused'; itemId: string; refusal: AgentContextRefusal }

/** A media type is case-insensitive and may carry parameters (`text/plain; charset=utf-8`), and the
 *  form stored has to be the form the capability check matched. */
function normalizeMediaType(mediaType: string): string {
  return mediaType.split(';')[0].trim().toLowerCase()
}

/** Derived here, in one place, because the two facts that must not drift are what the check matched
 *  and what the item claims. An unrecognised type lands in `other`, mirroring the tool-kind
 *  contract's own escape arm: a kind the host has not learned is not a malformed file. */
function attachmentKindOf(mediaType: string): AgentAttachmentKind {
  if (mediaType.startsWith('image/')) return 'image'
  if (mediaType.startsWith('text/')) return 'text'
  if (mediaType === 'application/pdf') return 'pdf'
  return 'other'
}

/** Kind and path: what an item is addressed and replaced by. Derived rather than taken from the
 *  caller, so re-capturing a note updates the row it already has instead of adding a second copy of
 *  one note at a different revision — a contradiction the list would not show. */
function itemId(kind: AgentContextItem['kind'], path: string): string {
  return `${kind}:${path}`
}

/** The five identity fields, copied into a plain frozen object. Nothing else rides along. */
function copyIdentity(identity: AgentIdentity): AgentIdentity {
  const copy: AgentIdentity = {
    agentId: identity.agentId,
    profileId: identity.profileId,
    runtimeEpoch: identity.runtimeEpoch,
    vaultId: identity.vaultId,
    sessionId: identity.sessionId,
  }
  return Object.freeze(copy)
}

/**
 * The captured item as a fresh frozen object of known fields.
 *
 * Rebuilt field by field rather than spread from what it was handed, because a spread would carry
 * whatever else the source carried — a live reference, a getter, a field of a newer shape read back
 * out of storage — into a value meant to be nothing but data. The derived fields are derived *here*
 * again for the same reason: a foreign value must not assert a fact about itself.
 */
function freezeItem(item: AgentContextItem): AgentContextItem {
  switch (item.kind) {
    case 'note': {
      const frozen: AgentContextNoteItem = {
        kind: 'note',
        id: itemId('note', item.path),
        vaultId: item.vaultId,
        path: item.path,
        revision: item.revision,
        dirty: item.dirty,
        content: Object.freeze({ source: item.content.source, text: item.content.text }),
      }
      return Object.freeze(frozen)
    }
    case 'selection': {
      const frozen: AgentContextSelectionItem = {
        kind: 'selection',
        id: itemId('selection', item.path),
        vaultId: item.vaultId,
        path: item.path,
        revision: item.revision,
        from: item.from,
        to: item.to,
        text: item.text,
        dirty: item.dirty,
      }
      return Object.freeze(frozen)
    }
    case 'attachment': {
      const mediaType = normalizeMediaType(item.mediaType)
      const frozen: AgentContextAttachmentItem = {
        kind: 'attachment',
        id: itemId('attachment', item.path),
        path: item.path,
        name: item.name,
        mediaType,
        sizeBytes: item.sizeBytes,
        attachmentKind: attachmentKindOf(mediaType),
      }
      return Object.freeze(frozen)
    }
  }
}

function freezeDraft(identity: AgentIdentity, items: readonly AgentContextItem[]): AgentContextDraft {
  return Object.freeze({ identity: copyIdentity(identity), items: Object.freeze([...items]) })
}

/**
 * Why an item may not be sent, or null when it may.
 *
 * The vault check is §6.2's composite identity boundary applied to a snapshot: a run is bound to the
 * vault it was opened in, so an item captured from another one is context that session cannot see,
 * arriving because the user switched mid-compose. It is refused rather than carried, and refused
 * rather than dropped: the row the user sees and the context the model gets have to be one list.
 *
 * Notes and selections are held to that; attachments have no vault to agree with, and `capabilities`
 * is absent for the kinds it cannot apply to.
 */
function judgeItem(
  draft: AgentContextDraft,
  item: AgentContextItem,
  capabilities: AgentModelCapabilities | undefined,
): AgentContextRefusal | null {
  if (item.kind !== 'attachment') {
    if (item.vaultId !== draft.identity.vaultId) {
      return {
        reason: 'vault-mismatch',
        path: item.path,
        itemVaultId: item.vaultId,
        contextVaultId: draft.identity.vaultId,
      }
    }
    if (item.kind === 'selection' && item.text === '') {
      return { reason: 'empty-selection', path: item.path }
    }
    return null
  }
  if (capabilities !== undefined && !capabilities.acceptedAttachmentKinds.includes(item.attachmentKind)) {
    return {
      reason: 'unsupported-attachment',
      path: item.path,
      mediaType: item.mediaType,
      attachmentKind: item.attachmentKind,
    }
  }
  return null
}

/** Judge an item and, when it passes, put it in the list — replacing the row with the same id, so
 *  the list keeps its order and its position on screen while the user re-captures things. */
function applyItem(
  draft: AgentContextDraft,
  item: AgentContextItem,
  capabilities: AgentModelCapabilities | undefined,
): AgentContextEdit {
  const frozen = freezeItem(item)
  const refusal = judgeItem(draft, frozen, capabilities)
  if (refusal !== null) return { status: 'refused', refusal }
  const items = draft.items.some((existing) => existing.id === frozen.id)
    ? draft.items.map((existing) => (existing.id === frozen.id ? frozen : existing))
    : [...draft.items, frozen]
  return { status: 'applied', draft: freezeDraft(draft.identity, items) }
}

/** Begin a context for one session's vault. Empty, and it stays empty until somebody attaches
 *  something: there is no default context to forget to remove. */
export function createContextDraft(identity: AgentIdentity): AgentContextDraft {
  return freezeDraft(identity, [])
}

/** The text `disk` asks for: the file's when the buffer is dirty and it was read, and for a clean
 *  buffer the buffer's own, which by definition is the file's. Anything else — the buffer's text
 *  under the file's label — is the one thing that must not be attached. */
function diskTextFor(buffer: AgentLiveNoteBuffer): string | null {
  if (buffer.state === 'clean') return buffer.text
  return buffer.diskText
}

/**
 * Attach the note, or its current text, as `content` says.
 *
 * A dirty buffer is not refused — the user may be asking about edits they have not saved — but it is
 * never attached anonymously: `dirty` and the source label travel with the item. That pair is what
 * lets the list offer the choice §7.1 asks for when a disk tool is about to edit this note (save
 * first, or take a suggestion), instead of the model seeing unsaved text it was never told about.
 */
export function attachNote(
  draft: AgentContextDraft,
  live: AgentLiveNote,
  content: AgentNoteTextSource,
): AgentContextEdit {
  const text = content === 'disk' ? diskTextFor(live.buffer) : live.buffer.text
  if (text === null) return { status: 'refused', refusal: { reason: 'disk-text-unavailable', path: live.path } }
  return applyItem(
    draft,
    {
      kind: 'note',
      id: itemId('note', live.path),
      vaultId: live.vaultId,
      path: live.path,
      revision: live.revision,
      dirty: live.buffer.state === 'dirty',
      content: { source: content, text },
    },
    undefined,
  )
}

/** Attach a range of a note as the user selected it. An empty range is refused: a row labelled as a
 *  selection that carries nothing would have the user believe the model was shown a passage. */
export function attachSelection(draft: AgentContextDraft, live: AgentLiveSelection): AgentContextEdit {
  return applyItem(
    draft,
    {
      kind: 'selection',
      id: itemId('selection', live.path),
      vaultId: live.vaultId,
      path: live.path,
      revision: live.revision,
      from: live.from,
      to: live.to,
      text: live.text,
      dirty: live.dirty,
    },
    undefined,
  )
}

/**
 * Attach a file, if the selected model can take it.
 *
 * Refused here, where the user offers it, and again at the freeze point. The second check is not
 * redundant: the model can be switched while the user is still composing, so a file that was fine
 * when attached can be one the current model cannot take by the time the prompt goes out. Accepting
 * it into the list and leaving it out of what is sent is the failure this refuses to have — the list
 * on screen would still show it.
 */
export function attachFile(
  draft: AgentContextDraft,
  live: AgentLiveAttachment,
  capabilities: AgentModelCapabilities,
): AgentContextEdit {
  const mediaType = normalizeMediaType(live.mediaType)
  return applyItem(
    draft,
    {
      kind: 'attachment',
      id: itemId('attachment', live.path),
      path: live.path,
      name: live.name,
      mediaType,
      sizeBytes: live.sizeBytes,
      attachmentKind: attachmentKindOf(mediaType),
    },
    capabilities,
  )
}

/**
 * Take an item off the list.
 *
 * This is the withdrawal the acceptance names, and it is a draft operation: nothing has been sent,
 * so the next commit simply does not carry the item. An item withdrawn *after* a commit does not
 * reach that commit — a run in flight keeps the context it was sent with, and the list being edited
 * belongs to the next one.
 *
 * An id the draft does not have is a no-op rather than a refusal: nothing about what will be sent is
 * wrong because of it.
 */
export function withdrawItem(draft: AgentContextDraft, id: string): AgentContextDraft {
  const items = draft.items.filter((item) => item.id !== id)
  return items.length === draft.items.length ? draft : freezeDraft(draft.identity, items)
}

/**
 * Freeze the context: the point after which the run's view of the user's editor cannot change.
 *
 * Everything the run is given is validated here, once, against the capabilities in force at this
 * instant rather than when items were attached, and the result has nothing live left in it. From
 * here a switch, an edit or a withdrawal changes the *next* context; this one is what was attached.
 */
export function commitContext(
  draft: AgentContextDraft,
  capabilities: AgentModelCapabilities,
): AgentContextCommitResult {
  for (const item of draft.items) {
    const refusal = judgeItem(draft, item, capabilities)
    if (refusal !== null) return { status: 'refused', itemId: item.id, refusal }
  }
  // The cast is the brand's price, the same one the memory adapter pays to mint a session handle:
  // the unique symbol exists only in the type, so the frozen data is a snapshot by construction.
  const frozen = Object.freeze({
    identity: copyIdentity(draft.identity),
    items: Object.freeze(draft.items.map((item) => freezeItem(item))),
  })
  return { status: 'committed', snapshot: frozen as unknown as AgentContextSnapshot }
}
