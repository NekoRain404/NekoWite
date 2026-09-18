/**
 * The editor pane's half of the edit-apply rule: the host `agent-edit-apply.ts` describes and
 * nothing implemented.
 *
 * `AgentEditHost`'s own doc says where it belongs — 「in the app the caller is whoever holds the
 * editor pane and can mount the conflict surface」 — and this is that caller. It supplies the port's
 * three members from the two places that can supply them honestly:
 *
 *  - **`live(path)`** is the editor's *one* lookup (`stores/tabs.ts`'s `lookUpLiveNote`), projected
 *    through `liveNoteEditorOf` so the read path, the conflict baseline and the insertion anchor
 *    keep reading one value rather than four spellings of it. Nothing here reads a tab for itself.
 *  - **`write(path, text)`** is `writeNoteText`: the note's own save transaction, which is the only
 *    path into a note's file that checks the disk first.
 *  - **`ask(conflict)`** is the one thing only a mounted surface can do, so it is a promise this
 *    composable holds open until {@link AgentNoteHost.answer} is called by the component that drew
 *    the question. It has no default and no deadline: a question answered on the user's behalf is a
 *    decision they did not take. The single exception is the pane going away, and it settles as
 *    `discard` — nothing written — because that is the state the note is really in.
 *
 * The session's identity is the **caller's own** — required, and read at the moment of the apply
 * rather than captured when the surface mounted: a runtime that was restarted between the question
 * and the answer is exactly what `identity-changed` exists to catch, and a captured identity would
 * hide it.
 *
 * It used to have a default that read the agent store's pointer (`activeRecord`), and that default
 * was a defect with teeth: the pointer could name a session the surface was not showing — the pet's
 * task link moved it while the rail kept the session on screen — and the apply would then be judged
 * against a session the proposal was never produced under, refusing a write the reader had every
 * reason to expect to land. The store no longer has a pointer (`stores/agent-session.ts`), and this
 * port no longer has a default: a caller that does not know which session it is editing for cannot
 * build a host at all, which is the honest shape for the one port in this feature that decides
 * *where* a write goes.
 */

import { onBeforeUnmount, ref, type Ref } from 'vue'
import type { AgentIdentity } from '../../../platform/gateways/agent-contracts'
import type { AgentEditRefusal } from '../services/agent-edit-apply'
import type { LiveNoteLookup } from '../services/agent-context-snapshot'
import type { AgentEditChoice, AgentEditConflict, AgentEditHost, AgentEditOutcome, AgentEditProposal, AgentEditWriteOutcome } from '../services/agent-edit-apply'
import { applyAgentEdit } from '../services/agent-edit-apply'
import { liveNoteEditorOf } from '../services/live-note-responder'
import { writeNoteText } from '../services/agent-note-write'
import { useTabsStore } from '../../../stores/tabs'

export interface AgentNoteHostDeps {
  /** The editor's one lookup, for a test that drives this without a tab store. */
  lookup?: (path: string) => LiveNoteLookup
  /** The write, for a test that drives this without a tab store. */
  write?: (path: string, text: string) => Promise<AgentEditWriteOutcome>
  /**
   * The session the proposal is applied under — the surface's own, the one it drew the proposals
   * for. A reader function rather than a value, because the session can change under a mounted
   * surface (the rail reopens another one) and the apply has to be judged against the session that
   * is in front at that instant, not the one the surface started with.
   *
   * Required, and the argument is in this file's header: this port decides where a write lands, and
   * a default read from anywhere else — the store's pointer, most of all — is a second answer to
   * "which session is this" that the caller cannot see.
   */
  identity: () => AgentIdentity | null
}

export interface AgentNoteHost {
  /** The port itself, so an apply can be run through the service's own entry point. */
  readonly host: AgentEditHost
  /** The conflict the user is being asked about, or null. What the surface draws. */
  readonly conflict: Ref<AgentEditConflict | null>
  /** The user's answer. Exactly one call settles the question; a second is ignored. */
  answer(choice: AgentEditChoice): void
  /**
   * Apply `proposal` under the session the surface is showing.
   *
   * The identity is read here rather than passed in, because a caller that read one itself could
   * pair an answer with a session it was never produced under — and both halves would be
   * well-formed, which is precisely the mismatch nothing downstream can see.
   */
  apply(proposal: AgentEditProposal): Promise<AgentEditOutcome>
}

/** Why an apply had no session to run under. `sessionId` names the whole of what is missing. */
const NO_SESSION: AgentEditRefusal = { reason: 'identity-changed', field: 'sessionId' }

export function useAgentNoteHost(deps: AgentNoteHostDeps): AgentNoteHost {
  const tabs = useTabsStore()

  const lookup = deps.lookup ?? ((path: string) => tabs.lookUpLiveNote(path))
  const write = deps.write ?? writeNoteText

  const editor = liveNoteEditorOf({ lookUpLiveNote: lookup })

  const conflict = ref<AgentEditConflict | null>(null)
  /** The open question's only way out. Held as a value rather than in a reactive field: it is a
   *  pending call, not something to draw. */
  let settle: ((choice: AgentEditChoice) => void) | null = null
  /** True once this component is gone, so a question raised during teardown is not left hanging. */
  let gone = false

  onBeforeUnmount(() => {
    gone = true
    // Nothing was written and nothing will be: `discard` is the answer that matches the note's
    // actual state, and it is the only arm of `AgentEditChoice` that cannot lose a paragraph.
    settle?.('discard')
    settle = null
    conflict.value = null
  })

  const host: AgentEditHost = {
    live: (path) => editor.liveNote(path),
    write: (path, text) => write(path, text),
    ask: (asked) =>
      new Promise<AgentEditChoice>((resolve) => {
        // A pane that is already gone cannot ask. Answering here — rather than storing a promise
        // nothing can settle — is what keeps an apply from outliving the surface it needs.
        if (gone) {
          resolve('discard')
          return
        }
        conflict.value = asked
        settle = (choice) => {
          settle = null
          conflict.value = null
          resolve(choice)
        }
      }),
  }

  function answer(choice: AgentEditChoice): void {
    settle?.(choice)
  }

  async function apply(proposal: AgentEditProposal): Promise<AgentEditOutcome> {
    const live = deps.identity()
    if (live === null) return { status: 'refused', refusal: NO_SESSION }
    return applyAgentEdit(proposal, live, host)
  }

  return { host, conflict, answer, apply }
}
