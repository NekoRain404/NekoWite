<script setup lang="ts">
/**
 * What one run changed, and the three answers about it — the surface the audit's row 20 had built
 * and mounted nowhere.
 *
 * `agent-change-review.ts` judges each row, `AgentChangesView.vue` draws one, and neither could be
 * reached from the window: the view was mounted by an e2e harness and by nothing else. This is the
 * caller, and it is where the three answers get their meaning:
 *
 *  - **Review** opens the note in the editor. It is the one answer every row has, and it is also
 *    the way a rejection becomes possible for a note no tab holds: the window's only write into a
 *    note's file is the note's own save transaction (`agent-note-write.ts`), which needs a tab.
 *  - **Keep** is the user saying the change is what they want in the note. It writes nothing —
 *    there is nothing to write, the file already holds it — and what it changes is what this window
 *    will still offer: an answered row stops offering the rejection, and the counts move. That is
 *    the shape the reference client gives the same word (`action_log`'s `keep_edits_in_range`
 *    moves the edit out of the unreviewed set and advances the baseline; the file is untouched).
 *  - **Reject** puts the note back, and *which writer does it* is a fact about the file rather
 *    than a preference (`AgentChangeRoute`). A tab holds the note: the note's own save transaction
 *    does the write, so the precondition, the vault and the content watcher all apply — that is the
 *    app's one path into an open file. **No tab holds it**: the host does, through
 *    `AgentGateway.recoverChange`, which is the same request answered by the layer that *performed*
 *    the write and still holds the bytes it replaced. Before that call existed this case was a row
 *    that could only say「no tab holds this note」, for exactly the notes a reader is least likely
 *    to have open. It is offered only where the judge allowed it, and the row says which of the
 *    reasons withheld it otherwise.
 *
 * ## Where the state is, and where it is not
 *
 * The review itself is a value: it is rebuilt from the session's own record on every render, so a
 * frame applied while this surface was on screen cannot be missed and the rows cannot disagree with
 * the transcript. The *answers* are this component's, keyed by session — the same arrangement
 * `AgentNoteProposals.vue` uses for the tool calls it has decided, and cleared when the session
 * under the surface changes, because a call id is the engine's and two sessions can mint the same
 * one.
 *
 * Nothing here touches a document: the one write goes through `writeNoteText`, which is the note's
 * own save, and the diff the user reads is the transcript's.
 */
import { computed, ref, watch } from 'vue'
import { t } from '../../../i18n'
import type { AgentIdentity } from '../../../platform/gateways/agent-contracts'
import { useTabsStore } from '../../../stores/tabs'
import { useAgentSessionStore } from '../stores/agent-session'
import {
  changeRows,
  decideChange,
  reviewOfSession,
  type AgentChangeAnswer,
  type AgentChangeDecision,
  type AgentChangeRejection,
  type AgentChangeRow,
} from '../services/agent-change-review'
import { describeFailure } from '../services/agent-session-subscription'
import { liveNoteEditorOf } from '../services/live-note-responder'
import { writeNoteText } from '../services/agent-note-write'
import { sessionKey } from '../services/agent-session-view'
import AgentChangesView from './AgentChangesView.vue'
import type { AgentChangesLabels } from './AgentChangesView.vue'

const props = defineProps<{
  /**
   * The session the runtime on screen is serving, or null when none is up.
   *
   * A prop rather than a store read, for the reason `AgentNoteProposals` gives: the rail decides
   * when an engine runs, and a surface that asked the store for "the session" would be answering a
   * question about a runtime it cannot see.
   */
  identity: AgentIdentity | null
}>()

const tabs = useTabsStore()
const sessions = useAgentSessionStore()

const key = computed(() => (props.identity === null ? null : sessionKey(props.identity)))
const record = computed(() => sessions.recordFor(key.value))

/** What the user has answered on this screen, and about which session's run. */
const answers = ref<readonly AgentChangeAnswer[]>([])
const open = ref(true)

// A call id is the engine's, and two sessions can mint the same one — `run-1:tool` is the memory
// double's own. An answer that outlived the session it was given in would mark a row of the next
// one as decided, which is the one thing an answer must never do.
watch(key, () => {
  answers.value = []
})

/**
 * The review, rebuilt from the record and the answers as they are now.
 *
 * Built here rather than stored: the record is the one account of the run — the timeline the
 * transcript draws, the engine's hints and the baselines the send captured — and a copy taken at
 * mount would go stale in the frame right after it.
 */
const review = computed(() => {
  const held = record.value
  if (held === null) return null
  let built = reviewOfSession(held.identity, held.view, held.edits)
  for (const answer of answers.value) built = decideChange(built, answer)
  return built
})

const editor = liveNoteEditorOf({ lookUpLiveNote: (path: string) => tabs.lookUpLiveNote(path) })

const rows = computed<readonly AgentChangeRow[]>(() =>
  review.value === null ? [] : changeRows(review.value, (path) => editor.liveNote(path)),
)

const counts = computed(() => {
  const kept = rows.value.filter((row) => row.decision?.decision === 'kept').length
  const putBack = rows.value.filter((row) => row.decision?.decision === 'rejected').length
  return { files: rows.value.length, kept, putBack, toReview: rows.value.length - kept - putBack }
})

/** The copy, from the catalogue the app already has. Rebuilt when the locale or the counts move,
 *  which is why the counting sentence travels in here rather than being assembled in the view. */
const labels = computed<AgentChangesLabels>(() => ({
  title: t('agent.changes.title'),
  empty: t('agent.changes.empty'),
  summary: t('agent.changes.summary', {
    files: String(counts.value.files),
    kept: String(counts.value.kept),
    putBack: String(counts.value.putBack),
    toReview: String(counts.value.toReview),
  }),
  collapse: t('agent.changes.collapse'),
  expand: t('agent.changes.expand'),
  attribution: {
    agent: t('agent.changes.attribution.agent'),
    external: t('agent.changes.attribution.external'),
    reported: t('agent.changes.attribution.reported'),
  },
  verdict: {
    followsDisk: t('agent.changes.verdict.followsDisk'),
    unsavedEdits: t('agent.changes.verdict.unsavedEdits'),
  },
  offer: {
    view: t('agent.changes.offer.view'),
    keep: t('agent.changes.offer.keep'),
    recover: t('agent.changes.offer.recover'),
  },
  refused: {
    notAgentChange: t('agent.changes.refused.notAgentChange'),
    writeInFlight: t('agent.changes.refused.writeInFlight'),
    noBaseline: t('agent.changes.refused.noBaseline'),
    vaultMismatch: t('agent.changes.refused.vaultMismatch'),
    unsavedEdits: t('agent.changes.refused.unsavedEdits'),
    resultUnstated: t('agent.changes.refused.resultUnstated'),
    changedSince: t('agent.changes.refused.changedSince'),
  },
  decision: {
    kept: t('agent.changes.decision.kept'),
    rejected: t('agent.changes.decision.rejected'),
  },
  written: {
    saved: t('agent.changes.written.saved'),
    saveFailed: t('agent.changes.written.saveFailed'),
    unavailable: t('agent.changes.written.unavailable'),
  },
  recovered: {
    recovered: t('agent.changes.recovered.recovered'),
    recoveredWarning: t('agent.changes.recovered.warning'),
    refused: {
      noBaseline: t('agent.changes.recovered.refused.noBaseline'),
      baselineStale: t('agent.changes.recovered.refused.baselineStale'),
      unavailable: t('agent.changes.recovered.refused.unavailable'),
      changedSinceRecorded: t('agent.changes.recovered.refused.changedSinceRecorded'),
      alreadyAtBaseline: t('agent.changes.recovered.refused.alreadyAtBaseline'),
      writeRefused: t('agent.changes.recovered.refused.writeRefused'),
    },
    unreachable: t('agent.changes.recovered.unreachable'),
  },
  unsavedBuffer: t('agent.changes.unsavedBuffer'),
  agentVersion: t('agent.changes.agentVersion'),
  diskUnread: t('agent.changes.diskUnread'),
}))

/**
 * Open the note a row is about.
 *
 * `openTab` is the editor's own door — a tab already holding the path is focused rather than
 * duplicated — and it is also the whole of what "Review" means here: the diff itself is the
 * transcript's row, and what the user is missing is the note.
 */
function view(path: string): void {
  void tabs.openTab(path)
}

/**
 * The row a control belongs to, as it is judged *now*.
 *
 * Read at the press rather than captured when the view rendered it: the note can move between the
 * two moments — the user types in it, the agent writes it again — and what a press acts on has to
 * be the state the window is in, not the state it was drawn in. A path no longer on the list is a
 * row that left between the two, and the press does nothing.
 */
function rowFor(path: string): AgentChangeRow | null {
  return rows.value.find((candidate) => candidate.path === path) ?? null
}

function answer(
  row: AgentChangeRow,
  decision: AgentChangeDecision,
  rejection: AgentChangeRejection | null,
): void {
  if (row.toolCallId === null) return
  answers.value = [
    ...answers.value,
    { path: row.path, toolCallId: row.toolCallId, decision, rejection },
  ]
}

/** Keep. Nothing is written, and that is the answer's whole content. */
function keep(path: string): void {
  const row = rowFor(path)
  if (row === null) return
  answer(row, 'kept', null)
}

/**
 * Reject: the note goes back — through the writer the row named.
 *
 * The `offers` and the route are re-read at the press, and the press is refused here when the row
 * no longer carries one: that is the same judgement the row drew its button from, taken again
 * against the note as it is now, which is the only version of it that matters.
 *
 * **`editor`** is the note's own save: `writeNoteText` assigns the text to the tab and saves it, so
 * the precondition that reads the file, the vault check and the content watcher are the ones every
 * other write takes. What comes back is what actually happened, and the row says which of the
 * three it was rather than claiming the undo worked.
 *
 * **`host`** is the app's own recovery, for a note no tab holds. It is *not* a fallback for a
 * failure: it is the route the judge chose, because the window has no buffer to write through and
 * the host has the bytes. A refusal comes back as the host's own answer and a rejection — no
 * runtime, a session this host does not hold — as the sentence the host gave, because "the file
 * was not put back" and "the call never happened" are different things for the reader to do
 * something about.
 */
async function reject(path: string): Promise<void> {
  const row = rowFor(path)
  if (row === null || !row.offers.includes('recover')) return
  if (row.recoverVia === 'host') {
    // The session's own key, read here rather than captured: the store is keyed by it and the
    // surface re-renders when the session changes under it, so a captured key could name the
    // session the reader just left.
    if (key.value === null) return
    try {
      const answered = await sessions.recoverChange(key.value, row.path)
      answer(row, 'rejected', { via: 'host', answered })
    } catch (error) {
      answer(row, 'rejected', { via: 'unreachable', message: describeFailure(error).message })
    }
    return
  }
  if (row.baseline === null) return
  answer(row, 'rejected', { via: 'editor', written: await writeNoteText(row.path, row.baseline) })
}
</script>

<template>
  <!-- Drawn for as long as a session is live and a note is in front of the user, including while
       the run has changed nothing: the line it draws then is how a reader learns where this
       surface is before they need it, and an empty frame is what it must not draw instead. -->
  <AgentChangesView
    v-if="record !== null"
    :rows="rows"
    :labels="labels"
    :open="open"
    @view="view"
    @keep="keep"
    @recover="reject"
    @toggle="open = !open"
  />
</template>
