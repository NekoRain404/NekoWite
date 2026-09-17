<script lang="ts">
import type { AgentIdentity } from '../../../platform/gateways/agent-contracts'
import type { AgentSvgInsertionBinding } from '../../../app/agent-composition'

/**
 * Where an SVG insertion is bound, as this surface needs it.
 *
 * Structural rather than the composition's own type: the feature declares the one method it calls,
 * and `agent-composition.ts` — which is this surface's assembly site, not its dependency — happens
 * to satisfy it. A feature that imported the composition's type would be the arrow pointing the
 * wrong way (see the note in `live-note-responder.ts` that this copies).
 */
export interface AgentInsertionSource {
  connectSvgInsertion(identity: AgentIdentity): AgentSvgInsertionBinding
}
</script>

<script setup lang="ts">
/**
 * What the agent produced for the note the editor has open, and the decision about it.
 *
 * This is the surface `agent-edit-apply.ts` names in its own doc — 「whoever holds the editor pane
 * and can mount the conflict surface」 — and the reason the feature's two finished halves had never
 * met. It is mounted by `ui/EditorPane.vue`, it reads the note from the tab store and the session
 * from the agent store, and it owns the one thing neither the service nor the conflict view can:
 * the question, on screen, with a control that answers it.
 *
 * ## What it draws, and what it refuses to draw
 *
 *  - **A proposal, only while there is one.** `services/agent-note-proposals.ts` decides that, and
 *    it decides it against the session's own baselines: a run that never named this note offers
 *    nothing, because `applyAgentEdit` refuses without a version to check against and a control
 *    whose only outcome is a refusal is worse than no control.
 *  - **The two texts, when the note moved.** `AgentEditConflictView` draws them and emits the
 *    choice; who owns the editor is what answers `host.ask`, and that is this component. The
 *    promise the service is holding open is settled by those two buttons and by nothing else — a
 *    component that unmounts with a question open settles it as `discard`, which is the state the
 *    note is really in.
 *  - **What happened, after the write.** Three outcomes, three sentences, none of them folded into
 *    another: a write that reached the file, a write that reached the note and not the file, and a
 *    decision not to write. The second is the one a surface is tempted to round up, and rounding it
 *    up is how a paragraph that only ever existed in this window is discovered on the next restart.
 *
 * ## What it deliberately does not do
 *
 * It never touches a document. The write goes through `useAgentNoteHost` → `applyAgentEdit` → the
 * note's own save transaction, so the judgement and the write are one step and the disk is checked
 * by the code that already knows how. This file has no `fs` import and no editor import: it renders
 * values and calls two functions, which is what keeps "may this write land" in one place.
 */
import { computed, ref } from 'vue'
import { FileWarning } from 'lucide-vue-next'
import { t } from '../../../i18n'
import { useTabsStore } from '../../../stores/tabs'
import { useAgentSessionStore } from '../stores/agent-session'
import { noteProposalsFor } from '../services/agent-note-proposals'
import { sessionKey } from '../services/agent-session-view'
import { useAgentNoteHost } from '../composables/use-agent-note-host'
import type { AgentEditOutcome } from '../services/agent-edit-apply'
import AgentEditConflictView from './AgentEditConflictView.vue'
import type { AgentEditConflictLabels } from './AgentEditConflictView.vue'

const props = defineProps<{
  /**
   * The session the runtime on screen is serving, or null when none is up.
   *
   * A prop rather than a store read, because it is the shell's own value: the rail decides when an
   * engine runs, and a surface that asked the store for "the session" would be answering a question
   * about a runtime it cannot see.
   */
  identity: AgentIdentity | null
  /**
   * Where an SVG insertion is bound, or null.
   *
   * The composition's own `connectSvgInsertion`, handed down rather than reached for: the identity
   * a plan is made under is the session's, and the object that can mint one is the assembly site's.
   */
  insertions: AgentInsertionSource | null
}>()

const tabs = useTabsStore()
const sessions = useAgentSessionStore()
const host = useAgentNoteHost()

/** The note the editor has in front. The surface is about this one and says so by being here. */
const path = computed<string | null>(() => tabs.activeTab?.path ?? null)
const record = computed(() =>
  props.identity === null ? null : sessions.recordFor(sessionKey(props.identity)),
)

/** The tool calls the user has already decided about, by id: a decision is not re-offered. */
const decided = ref<readonly string[]>([])

const proposals = computed(() => {
  const at = path.value
  const session = record.value
  if (at === null || session === null) return []
  return noteProposalsFor({
    entries: session.view.timeline,
    path: at,
    baseline: session.edits.find((baseline) => baseline.path === at) ?? null,
  }).filter((proposal) => !decided.value.includes(proposal.toolCallId))
})

/** The edit proposal, which is the one kind this component can decide. */
const edit = computed(() => proposals.value.find((proposal) => proposal.kind === 'edit') ?? null)

const outcome = ref<AgentEditOutcome | null>(null)

const conflictLabels = computed<AgentEditConflictLabels>(() => ({
  title: t('agent.note.conflict.title'),
  moved: t('agent.note.conflict.moved'),
  agentText: t('agent.note.conflict.agentText'),
  noteText: t('agent.note.conflict.noteText'),
  apply: t('agent.note.conflict.apply'),
  discard: t('agent.note.conflict.discard'),
  kept: t('agent.note.conflict.kept'),
}))

/**
 * What became of the last decision, in the catalogue's own words.
 *
 * Every arm is answered, including the refusals: a code the user cannot read would leave them
 * believing the write happened, and the one thing a refusal is for is telling them it did not.
 */
const outcomeSentence = computed<string | null>(() => {
  const last = outcome.value
  if (last === null) return null
  if (last.status === 'applied') return t('agent.note.outcome.saved')
  if (last.status === 'save-failed') return t('agent.note.outcome.saveFailed')
  if (last.status === 'discarded') return t('agent.note.outcome.discarded')
  const reason = last.refusal.reason
  if (reason === 'note-not-open') return t('agent.note.refused.noteNotOpen')
  if (reason === 'target-changed') return t('agent.note.refused.targetChanged')
  if (reason === 'vault-mismatch') return t('agent.note.refused.vaultMismatch')
  if (reason === 'write-unavailable') return t('agent.note.refused.writeUnavailable')
  return t('agent.note.refused.identityChanged')
})

/** Run the apply and remember which call it was about, so the row does not come back. */
async function applyProposal(toolCallId: string, run: () => Promise<AgentEditOutcome>): Promise<void> {
  outcome.value = await run()
  decided.value = [...decided.value, toolCallId]
}

function discardProposal(toolCallId: string): void {
  outcome.value = { status: 'discarded', path: path.value ?? '' }
  decided.value = [...decided.value, toolCallId]
}

/** The conflict view answers with a path; the row is decided by the same path. */
function onConflictAnswer(choice: 'apply' | 'discard'): void {
  outcome.value = choice === 'discard' ? { status: 'discarded', path: path.value ?? '' } : outcome.value
  host.answer(choice)
}
</script>

<template>
  <section
    v-if="proposals.length > 0 || host.conflict.value !== null || outcomeSentence !== null"
    class="agent-note"
    data-agent-note
    :aria-label="t('agent.note.title')"
  >
    <h2
      v-if="proposals.length > 0 || host.conflict.value !== null"
      class="agent-note-title"
    >
      {{ t('agent.note.title') }}
    </h2>

    <div
      v-if="edit !== null"
      class="agent-note-proposal"
      data-agent-note-proposal
      :data-path="edit.proposal.baseline.path"
    >
      <p class="agent-note-line">
        <FileWarning
          :size="13"
          :stroke-width="1.8"
          aria-hidden="true"
        />
        {{ t('agent.note.edit.row', { path: edit.proposal.baseline.path }) }}
      </p>
      <p class="agent-note-hint">
        {{ t('agent.note.unwritten') }}
      </p>
      <div class="agent-note-actions">
        <!-- The safe answer first in reading order, as the conflict view does: the control a
             keyboard reaches first is the one that cannot take anything away. -->
        <button
          type="button"
          class="btn btn-ghost btn-sm"
          data-action="agent-edit-discard"
          @click="discardProposal(edit.toolCallId)"
        >
          {{ t('agent.note.edit.discard') }}
        </button>
        <button
          type="button"
          class="btn btn-secondary btn-sm"
          data-action="agent-edit-apply"
          @click="applyProposal(edit.toolCallId, () => host.apply(edit!.proposal))"
        >
          {{ t('agent.note.edit.apply') }}
        </button>
      </div>
    </div>

    <AgentEditConflictView
      :conflicts="host.conflict.value === null ? [] : [host.conflict.value]"
      :labels="conflictLabels"
      @apply="onConflictAnswer('apply')"
      @discard="onConflictAnswer('discard')"
    />

    <p
      v-if="outcomeSentence !== null"
      class="agent-note-outcome"
      data-agent-note-outcome
      role="status"
    >
      {{ outcomeSentence }}
    </p>
  </section>
</template>

<style scoped>
.agent-note {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px 12px;
  border-bottom: 1px solid var(--app-border);
  background: color-mix(in srgb, var(--app-panel) 88%, var(--app-canvas));
  color: var(--app-text);
  font-size: 13px;
}
.agent-note-title {
  margin: 0;
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.01em;
  text-transform: uppercase;
  color: var(--app-muted);
}
.agent-note-proposal {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 8px 10px;
  background: var(--app-elevated);
  border: 1px solid var(--app-border);
  border-radius: var(--app-radius);
}
.agent-note-line {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  align-items: center;
  margin: 0;
  /* The path has no spaces to break at. */
  overflow-wrap: anywhere;
}
.agent-note-hint {
  margin: 0;
  color: var(--app-muted);
  font-size: 11px;
  line-height: 1.35;
}
.agent-note-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  align-items: center;
  margin-top: 2px;
}
.agent-note-outcome {
  margin: 0;
  color: var(--app-muted);
  font-size: 11px;
  line-height: 1.35;
}
</style>
