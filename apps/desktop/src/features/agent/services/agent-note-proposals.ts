/**
 * What the session has proposed for the note the editor is holding, read off its own stream.
 *
 * This is the missing half of a join this feature has had built and unconnected: `agent-edit-apply.ts`
 * decides whether a proposed write may land in the open note and has run in production since
 * `stores/agent-session.ts` began capturing a baseline at the send; what never existed was anything
 * that handed it a proposal. A proposal is not invented here — ACP sends it, and the module that
 * judges it names the shape: a `diff` content block carries `oldText` and `newText`, which are
 * exactly "the version the request was made against" and "the text the agent produced".
 *
 * ## The two kinds, and why each is bound to the note that is open
 *
 *  - **An edit** (`{@link AgentNoteEditProposal}`): the engine read this note, produced new text for
 *    it, and the note the user is looking at is the one that text belongs in. The proposal is not
 *    offered until three things agree — the block names this note's path, the request that carried
 *    it captured a baseline for that path, and the engine's `oldText` is the text that baseline
 *    holds. The third is the one that is easy to leave out and cannot be: the baseline and the
 *    block's original text are two witnesses of "which document was this answer produced against",
 *    and an answer produced against a *different* document must not be written over this one on the
 *    strength of the request having named the same path.
 *  - **An insertion** (`{@link AgentNoteSvgProposal}`): a write-kind call of this session named an
 *    `.svg`, which is the artifact §7.3 has the agent stage for a note. It carries no baseline,
 *    and that is not an omission: an insertion is bound to a *spot* in the document and is checked
 *    against it at the commit (`agent-svg-insertion.ts`), not against the version a request was
 *    made at.
 *
 * ## What is deliberately not here
 *
 * No state, no clock, no store, and no write: this is a projection over rows the view already holds,
 * so what the surface draws and what the judge is handed cannot be two different things. And nothing
 * is offered for a note no tab holds — the caller asks for a path, and the path it asks about is the
 * one the editor has in front.
 */

import type { AgentTimelineEntry } from './agent-timeline'
import { AGENT_WRITE_TOOLS } from './agent-change-review'
import type { AgentEditBaseline, AgentEditProposal } from './agent-edit-apply'

/** The engine's version of the note the editor has open, with the version it was produced against.
 *  `proposal` is the whole of what `applyAgentEdit` needs: nothing is read again at the apply. */
export interface AgentNoteEditProposal {
  readonly kind: 'edit'
  /** The call that carried it, so a decision can be bound to the row the user read. */
  readonly toolCallId: string
  readonly proposal: AgentEditProposal
}

/** A staged artifact a write-kind call of this session produced, for the note that is open. */
export interface AgentNoteSvgProposal {
  readonly kind: 'svg'
  readonly toolCallId: string
  /** The file as the engine named it. Read by the caller; nothing here touches a disk. */
  readonly path: string
}

export type AgentNoteProposal = AgentNoteEditProposal | AgentNoteSvgProposal

export interface AgentNoteProposalQuery {
  /** The rows the session's view holds, in arrival order. */
  readonly entries: readonly AgentTimelineEntry[]
  /** The note the editor has open, as its own tab spells the path. */
  readonly path: string
  /**
   * The version the current request captured for that path, or null when no request named it.
   *
   * Null is a refusal rather than a default, and it is the whole reason this projection takes the
   * baseline as an argument instead of looking one up: `applyAgentEdit` refuses without a baseline,
   * so a row offered without one would be a control whose only outcome is a refusal.
   */
  readonly baseline: AgentEditBaseline | null
}

/** One spelling for path comparison. The engine names absolute paths; so does a tab, and the two
 *  differ only in a separator the engine's own platform may use. Nothing is resolved here — a path
 *  that cannot be compared literally is a path this surface does not offer an answer about. */
function normalized(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+$/u, '')
}

/** Whether a path names an SVG, by the extension `STAGED_SVG_MEDIA_TYPE` is the type of. */
function isSvg(path: string): boolean {
  return path.toLowerCase().endsWith('.svg')
}

export function noteProposalsFor(query: AgentNoteProposalQuery): readonly AgentNoteProposal[] {
  const wanted = normalized(query.path)
  const proposals: AgentNoteProposal[] = []
  /** The newest write of each artifact a call produced, kept by its own path: a file written twice
   *  in one run is one artifact, and the second write is the one that is on disk. */
  const newestArtifact = new Map<string, number>()

  for (const entry of query.entries) {
    if (entry.kind !== 'tool') continue

    for (const block of entry.content) {
      if (block.type !== 'diff') continue
      if (block.path === '' || normalized(block.path) !== wanted) continue
      const baseline = query.baseline
      if (baseline === null) continue
      // The engine stated no original text — which is an absence, not a claim that the file is new
      // (see `AgentToolContent`) — so there is nothing to say this answer was produced against.
      if (block.oldText === null) continue
      // Produced against a different document than the request was made against.
      if (block.oldText !== baseline.text) continue
      // An "apply" that would leave the note exactly as it is is not a decision worth asking for.
      if (block.newText === baseline.text) continue
      proposals.push(
        Object.freeze({
          kind: 'edit',
          toolCallId: entry.toolCallId,
          proposal: Object.freeze({ baseline, text: block.newText }),
        }),
      )
    }

    // Only a write-kind call can have *made* an artifact: a path a read touched is not a file the
    // call changes, which is the same rule the change review attributes from.
    if (!AGENT_WRITE_TOOLS.includes(entry.toolKind)) continue
    for (const path of entry.paths) {
      if (!isSvg(path)) continue
      const key = normalized(path)
      // Supersede an earlier write of the same artifact: `newestArtifact` carries the index the
      // first was pushed at, so the row keeps the position the reader saw it arrive in.
      const at = newestArtifact.get(key)
      const row: AgentNoteSvgProposal = Object.freeze({
        kind: 'svg',
        toolCallId: entry.toolCallId,
        path,
      })
      if (at === undefined) {
        newestArtifact.set(key, proposals.length)
        proposals.push(row)
      } else {
        proposals[at] = row
      }
    }
  }

  return Object.freeze(proposals)
}
