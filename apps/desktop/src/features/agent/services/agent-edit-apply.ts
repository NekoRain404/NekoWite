/**
 * Putting what a run produced into the note, against the version the note held when the user
 * asked.
 *
 * §7.2 gives an unwritten proposal the two verbs *apply* and *discard*, and a proposal is the
 * one kind of change that is decided over time: the request goes out, a model thinks for
 * seconds or minutes, and the note stays editable in front of the user the whole while — a slow
 * model must not freeze the editor. So the note an answer arrives for is not necessarily the
 * note the answer was produced for: the user kept typing in the same paragraph, or closed the
 * tab and reopened the file, or switched vaults. The failure this module exists to prevent is
 * the silent one — the write lands over what they typed during the wait, nothing on screen says
 * it happened, and there is nothing left to recover it from.
 *
 * Three rules, each forbidding a different way of getting that wrong:
 *
 *  - **The version is read when the user asks, not when the answer arrives.** A baseline is
 *    captured at the moment the prompt is submitted (`agent-session.ts`'s `send`) and travels
 *    with the run. An answer is only ever written over the document that version describes.
 *  - **A moved document is a question, not a write.** {@link judgeAgentEdit} answers `conflict`
 *    with both texts — what the agent produced and what the note holds now — and the user
 *    decides. Nothing here writes on their behalf.
 *  - **There is no fourth outcome.** A write happens only after a judgement that found the
 *    document where the request left it, or after the user answered a conflict with "apply".
 *    Everything else is a refusal (nothing was written) or a discard (nothing was written), and
 *    the two are different facts: a refusal has a cause the user may be able to fix, a discard
 *    is their own decision.
 *
 * ## The version this reuses
 *
 * It is `AgentLiveNote.revision` — the field the editor already fills for this feature
 * (`agent-context-snapshot.ts`), and the one `agent-svg-insertion.ts` already refuses a stale
 * insert by. Nothing here adds a second counter next to it: the editor's own per-tab edit
 * revision is the number that moves at the keystroke, and this module never sees the tab, the
 * path it is spelt with, or the counter behind it.
 *
 * Two properties of that string are load-bearing, and they are the editor's to keep:
 *
 *  - it changes when the document's text changes, including edits that never reached the disk;
 *  - it changes when the document *instance* changes. A note closed and reopened at the same
 *    path is a different document even when its bytes came back identical, so a revision that
 *    is a digest of the text alone cannot tell the two apart, and a write that trusted it would
 *    land in a document the user had just opened. (The editor's own identity for a document is
 *    the vault and the tab, not its text — `documentKey` in `features/editor/model/`.)
 *
 * The judgement reads that revision **and** the text, which is one rule with two witnesses
 * rather than two mechanisms (the same pairing `anchorHolds` uses for an insertion). They catch
 * different edits: the revision is the editor's own claim about the document — the instance
 * included — while the text is what the user sees. The second one is not redundant, because the
 * revision this feature is handed is the one the buffer was last synced with, so a buffer with
 * unsaved edits can sit at an unchanged revision while its text moves under it — and unsaved
 * edits are precisely the text this module exists to keep.
 *
 * The shape is this feature's: plain frozen values, a discriminated result instead of an
 * exception, no clock, no store, and no way to write that does not go through the host that
 * owns the editor.
 */

import type { AgentIdentity } from '../../../platform/gateways/agent-contracts'
import type { AgentLiveNote } from './agent-context-snapshot'
import { identityMismatch, type AgentIdentityField } from './agent-session-view'

/**
 * A note as it was when the prompt was submitted: what a later answer is judged against.
 *
 * The identity travels with it because a run is bound to one (agent, profile, runtime, vault,
 * session) — a runtime that was restarted looks the same on the wire, and an answer produced
 * under a session that is over must not be written under the next one.
 *
 * `text` is the note's text at that instant, and it is kept rather than re-read: it is the text
 * the model was given, and it is the second witness the judgement reads (see the header), so
 * nothing here can be reconstructed later from the note itself — by then the note is the thing
 * that moved.
 */
export interface AgentEditBaseline {
  readonly identity: AgentIdentity
  readonly path: string
  readonly revision: string
  readonly text: string
}

/**
 * What a run produced, bound to the note version it was produced against.
 *
 * `text` is the note's text after the write, not a patch: ACP's own diff content carries the
 * same pair (`oldText` / `newText`), so nothing here has to reconstruct a document from a
 * hunk — and the unit this module judges is the version of the whole document, which a
 * fragment cannot be checked against.
 *
 * The baseline travels *in* the proposal rather than being looked up when the apply runs. That
 * is what binds the two together: the store keeps the baselines of its current request, so a
 * caller that read one fresh while applying an earlier run's answer would be pairing that
 * answer with a newer request's version — a mismatch nothing in this module can see, because
 * both halves are well-formed. The caller that has the answer is the caller that held the
 * request, and it is the one that can keep the right baseline with it.
 */
export interface AgentEditProposal {
  readonly baseline: AgentEditBaseline
  readonly text: string
}

/** The note's text a write takes off the screen, with the version it was at. Both are needed:
 *  the text is what the user gets back, the revision is what a later check compares with. */
export interface DisplacedNote {
  readonly path: string
  readonly revision: string
  readonly text: string
}

/**
 * Why nothing was written — a code, not a sentence, because the UI owns the wording and a
 * service that returned text would have to invent it in two languages.
 *
 * Every arm means the same thing about the note: it is exactly as the user left it. They differ
 * in what the user can do next, which is why they are not one refusal.
 */
export type AgentEditRefusal =
  /** No tab holds the note: there is no buffer to write into and none to lose. */
  | { readonly reason: 'note-not-open'; readonly path: string }
  /** The lookup answered about a different note than the one asked for — the caller's own bug,
   *  refused rather than written into the note it answered with. */
  | { readonly reason: 'target-changed'; readonly path: string; readonly plannedPath: string }
  | { readonly reason: 'vault-mismatch'; readonly path: string; readonly noteVaultId: string; readonly contextVaultId: string }
  /** The proposal was made under another session (another agent, another runtime instance,
   *  another vault) than the write is happening under. */
  | { readonly reason: 'identity-changed'; readonly field: AgentIdentityField }
  /** Nothing can take the text: the pane that owned the note is gone. */
  | { readonly reason: 'write-unavailable'; readonly path: string }

/**
 * What the comparison found, and what may be done about it.
 *
 * `conflict` carries *both* texts rather than a boolean: the user is being asked to choose, and
 * a question whose answers cannot be seen is not one anybody can answer. The revisions are
 * carried too, because "this note changed" is a claim the user can check against what they did.
 */
export type AgentEditConflict = {
  readonly status: 'conflict'
  readonly path: string
  /** What the agent produced. */
  readonly agentText: string
  /** What the note holds now — including whatever was typed while the run was in flight. */
  readonly noteText: string
  readonly baselineRevision: string
  readonly currentRevision: string
}

export type AgentEditJudgement =
  /** The document is where the request left it: the write may go ahead. */
  | { readonly status: 'apply'; readonly path: string; readonly text: string }
  | AgentEditConflict
  | { readonly status: 'refused'; readonly refusal: AgentEditRefusal }

/** The user's answer to a conflict. `apply` means "write the agent's version anyway", and it is
 *  the only thing that turns a conflict into a write. */
export type AgentEditChoice = 'apply' | 'discard'

/** What the note did with the text. A truth rather than a flag, because "it is in the note and
 *  the file has it", "it is in the note and the file does not" and "nothing took it" are three
 *  different things to tell the user, and only the first is a success. */
export type AgentEditWriteOutcome =
  | { readonly status: 'saved' }
  | { readonly status: 'save-failed' }
  | { readonly status: 'unavailable' }

/**
 * The host the write needs: the editor's account of a note, the write itself, and the user.
 *
 * They arrive as one object because they are one act — an apply that could ask without writing,
 * or write without asking, would be the defect this module is about. The port is the seam a
 * test replaces; in the app the caller is whoever holds the editor pane and can mount the
 * conflict surface.
 */
export interface AgentEditHost {
  /** The editor's account of `path` right now, or null when no tab holds it. Asked by path, so
   *  no implementation of it can answer with "whatever is open". */
  live(path: string): AgentLiveNote | null
  /** Put `text` into the note and save it. */
  write(path: string, text: string): Promise<AgentEditWriteOutcome>
  /** Show the conflict and answer with the user's choice. */
  ask(conflict: AgentEditConflict): Promise<AgentEditChoice>
}

/**
 * What became of the apply.
 *
 * `displaced` is the note's text this write took off the screen, and it is null exactly when
 * that text is the text the request was made against — which the baseline still holds. On a
 * conflict it is the user's own typing, which nothing else keeps, so the caller is handed it:
 * an "apply anyway" that dropped it would be the silent overwrite one step later.
 *
 * `save-failed` is a status of its own rather than a quieter `applied`: the text is in the
 * note and the file does not have it, which the user has to be told — and it carries the same
 * displaced text, because a failed save is not a reason to lose it.
 */
export type AgentEditOutcome =
  | { readonly status: 'applied'; readonly path: string; readonly displaced: DisplacedNote | null }
  | { readonly status: 'save-failed'; readonly path: string; readonly displaced: DisplacedNote | null }
  | { readonly status: 'discarded'; readonly path: string }
  | { readonly status: 'refused'; readonly refusal: AgentEditRefusal }

/** The five identity fields, copied into a plain frozen object. Nothing else rides along. */
function copyIdentity(identity: AgentIdentity): AgentIdentity {
  return Object.freeze({
    agentId: identity.agentId,
    profileId: identity.profileId,
    runtimeEpoch: identity.runtimeEpoch,
    vaultId: identity.vaultId,
    sessionId: identity.sessionId,
  })
}

/** What the write takes off the note, as plain data. */
function displacedOf(live: AgentLiveNote): DisplacedNote {
  return Object.freeze({ path: live.path, revision: live.revision, text: live.buffer.text })
}

/**
 * Capture the version of each note the request names, at the moment it is submitted.
 *
 * A note captured under another vault is refused rather than carried: the run is bound to one
 * vault (§6.2), so an item from another one is context this session cannot see, arriving
 * because the user switched mid-compose. It is refused rather than dropped for the reason the
 * context snapshot refuses one — a silent drop leaves the user believing the request covered
 * that note, and here that belief would be the difference between a checked write and a
 * refused one.
 *
 * The refusals come back beside the baselines rather than throwing, because the caller is
 * mid-send: the prompt itself is the user's and goes out either way.
 */
export function captureEditBaselines(
  targets: readonly AgentLiveNote[],
  identity: AgentIdentity,
): { readonly baselines: readonly AgentEditBaseline[]; readonly refused: readonly AgentEditRefusal[] } {
  const baselines: AgentEditBaseline[] = []
  const refused: AgentEditRefusal[] = []
  for (const live of targets) {
    if (live.vaultId !== identity.vaultId) {
      refused.push({
        reason: 'vault-mismatch',
        path: live.path,
        noteVaultId: live.vaultId,
        contextVaultId: identity.vaultId,
      })
      continue
    }
    baselines.push(
      Object.freeze({
        identity: copyIdentity(identity),
        path: live.path,
        revision: live.revision,
        text: live.buffer.text,
      }),
    )
  }
  return Object.freeze({ baselines: Object.freeze(baselines), refused: Object.freeze(refused) })
}

/**
 * The comparison: is the note the one the request was made against?
 *
 * The order is the order of the questions, and each is asked before the one that would be
 * meaningless without it: is this still the session that asked, is the note still open, is it
 * the note that was asked about, is it in this vault, and only then — has it moved. "Moved" is
 * the revision *or* the text, so either witness is enough to withhold the write.
 *
 * `live` is read by the caller and handed in rather than looked up here, because the caller is
 * the side that owns the editor and because the read has to happen at a moment this function
 * cannot choose. `null` is "no tab holds this note", which is not "the note is empty".
 */
export function judgeAgentEdit(
  proposal: AgentEditProposal,
  live: AgentLiveNote | null,
  identity: AgentIdentity,
): AgentEditJudgement {
  const refuse = (refusal: AgentEditRefusal): AgentEditJudgement => ({ status: 'refused', refusal })
  const { baseline } = proposal

  const mismatch = identityMismatch(baseline.identity, identity)
  if (mismatch !== null) return refuse({ reason: 'identity-changed', field: mismatch })
  if (live === null) return refuse({ reason: 'note-not-open', path: baseline.path })
  if (live.path !== baseline.path) {
    return refuse({ reason: 'target-changed', path: live.path, plannedPath: baseline.path })
  }
  if (live.vaultId !== identity.vaultId) {
    return refuse({
      reason: 'vault-mismatch',
      path: live.path,
      noteVaultId: live.vaultId,
      contextVaultId: identity.vaultId,
    })
  }
  if (live.revision === baseline.revision && live.buffer.text === baseline.text) {
    return { status: 'apply', path: live.path, text: proposal.text }
  }
  return Object.freeze({
    status: 'conflict',
    path: live.path,
    agentText: proposal.text,
    noteText: live.buffer.text,
    baselineRevision: baseline.revision,
    currentRevision: live.revision,
  })
}

/**
 * The write itself, and what the host's answer to it means.
 *
 * Every caller reaches this in the same turn as the judgement that allowed it: `host.live` and
 * `judgeAgentEdit` are synchronous, and `host.write(...)` is *called* before this function
 * yields — the await is on its result, not on the call. So no keystroke can land between the
 * version that was checked and the text that is written; the check and the write are one step.
 * What the host does with the text afterwards (its own save transaction, and the editor's own
 * rules about typing during a save) is the editor's business, not a second version check here.
 *
 * The three answers are three different things to tell the user, and none of them is folded
 * into another: the text is in the note and on the file, the text is in the note and the file
 * write did not land, and there was nothing to put the text into.
 */
async function commit(
  proposal: AgentEditProposal,
  displaced: DisplacedNote | null,
  host: AgentEditHost,
): Promise<AgentEditOutcome> {
  const path = proposal.baseline.path
  const written = await host.write(path, proposal.text)
  if (written.status === 'unavailable') {
    return { status: 'refused', refusal: { reason: 'write-unavailable', path } }
  }
  if (written.status === 'save-failed') return { status: 'save-failed', path, displaced }
  return { status: 'applied', path, displaced }
}

/**
 * Apply the proposal, or do not.
 *
 * The two ways a write is reached are the whole of the rule:
 *
 *  1. The judge found the document where the request left it, and the write follows in the same
 *     turn. This is the arm with nothing to ask.
 *  2. The judge found a conflict and the user answered `apply`. What the user answered about is
 *     the conflict they were shown, and the note can move again while the question is on screen
 *     — so the read that the write is judged by is taken *after* the answer, and the text it
 *     displaces is the text found there. That is what makes the recovery exact: the outcome
 *     names what the write really took, not what the dialog happened to be showing.
 *
 * A note that closed while the question was open is refused rather than written: there is
 * nothing left to write over, and re-opening the file to do it would put the answer in a
 * document the user has not seen. `discard` writes nothing and says so — the note is untouched,
 * not "restored", because nothing was ever taken.
 */
export async function applyAgentEdit(
  proposal: AgentEditProposal,
  identity: AgentIdentity,
  host: AgentEditHost,
): Promise<AgentEditOutcome> {
  const path = proposal.baseline.path
  const opened = judgeAgentEdit(proposal, host.live(path), identity)
  if (opened.status === 'refused') return { status: 'refused', refusal: opened.refusal }
  if (opened.status === 'apply') return commit(proposal, null, host)

  const choice = await host.ask(opened)
  if (choice !== 'apply') return { status: 'discarded', path }

  const live = host.live(path)
  const answered = judgeAgentEdit(proposal, live, identity)
  if (answered.status === 'refused') return { status: 'refused', refusal: answered.refusal }
  // `answered` is a conflict unless the note came back to the revision the request was made
  // against (an undo, under an editor whose revision is derived from the text): then the text
  // being replaced is the one the baseline holds, and nothing of the user's is displaced.
  const displaced = answered.status === 'conflict' && live !== null ? displacedOf(live) : null
  return commit(proposal, displaced, host)
}
