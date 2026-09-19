

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
 * It never touches a document itself. Both writes go through code that already knows how: the edit
 * through `useAgentNoteHost` → `applyAgentEdit` → the note's own save transaction, and the image
 * through `connectSvgInsertion` → the insertion service's plan and commit. What this file supplies
 * is the two things neither can have — the disk read of the staged artifact, and an answer to the
 * question — and it renders what came back rather than deciding anything about the note.
 *
 *  - **An artifact, only after the checks.** §7.3 clause 3's rule, enforced by the type: nothing
 *    here can draw a preview that `inspectStagedSvg` did not mint, and a document it refused is
 *    reported by name instead of being rendered anyway.
 */
import { computed, ref, watchEffect } from 'vue'
import { FileWarning } from 'lucide-vue-next'
import type { AgentIdentity } from '../../../platform/gateways/agent-contracts'
import { t } from '../../../i18n'
import { useTabsStore } from '../../../stores/tabs'
import { useAgentSessionStore } from '../stores/agent-session'
import { noteProposalsFor } from '../services/agent-note-proposals'
import { sessionKey } from '../services/agent-session-view'
import { useAgentNoteHost } from '../composables/use-agent-note-host'
import { useAgentNoteArtifact } from '../composables/use-agent-note-artifact'
import type { AgentInsertionSource } from '../services/agent-insertion-source'
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
/**
 * The edit port, told the session this surface belongs to.
 *
 * `props.identity` is the shell's own reading — the session the rail has on screen — and it is the
 * same identity the proposals below are assembled from, so the apply and the proposal it applies
 * cannot be about two different sessions. Handed in as a reader rather than captured here for the
 * reason `useAgentNoteHost` gives: the session can change under a mounted surface, and the identity
 * that matters is the one in front at the moment of the apply.
 */
const host = useAgentNoteHost({ identity: () => props.identity })

/** The note the editor has in front. The surface is about this one and says so by being here. */
const path = computed<string | null>(() => tabs.activeTab?.path ?? null)
const key = computed<string | null>(() =>
  props.identity === null ? null : sessionKey(props.identity),
)
const record = computed(() => (key.value === null ? null : sessions.recordFor(key.value)))

/** The tool calls the user has already decided about, by id: a decision is not re-offered. */
const decided = ref<readonly string[]>([])

const proposals = computed(() => {
  const at = path.value
  const session = record.value
  const id = key.value
  if (at === null || session === null || id === null) return []
  return noteProposalsFor({
    entries: session.view.timeline,
    path: at,
    // The store's own lookup, not a second copy of it. This line used to spell
    // `session.edits.find(…)` itself, which is the whole body of
    // `stores/agent-session.ts`'s `editBaseline` — so the rule about which baseline a note has
    // existed twice, and the store's copy had no caller at all. Reading it back through the store
    // keeps one answer, and the store's version is the one that also answers null for a session
    // it does not hold.
    baseline: sessions.editBaseline(id, at),
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

// ---- The SVG the run staged for this note (N9) ------------------------------------------------
//
// The other half of the same join, and its production caller: `connectSvgInsertion` is asked here
// and nowhere else. The whole of the flow — reading the artifact, the checks, the attachment save,
// the commit and the note edit — is `use-agent-note-artifact.ts`, which is where the order §7.3
// asks for is stated and held; this file supplies the session, the note and the decision.

const svg = computed(() => proposals.value.find((proposal) => proposal.kind === 'svg') ?? null)

const artifact = useAgentNoteArtifact({
  proposal: () => (svg.value?.kind === 'svg' ? svg.value : null),
  identity: props.identity,
  insertions: props.insertions,
  path: () => path.value,
  onDecided: (toolCallId: string) => {
    decided.value = [...decided.value, toolCallId]
  },
})

/**
 * The box the verified preview is drawn in.
 *
 * Filled by parsing the serialiser's output as **XML** — the format it was written in, and the one
 * whose parser refuses to invent anything — and importing the root node, rather than by handing the
 * string to `v-html`. The brand on `AgentSvgPreview` is what makes the string trustworthy; this is
 * what keeps the render from being a second place a string could arrive from.
 */
const previewEl = ref<HTMLElement | null>(null)

watchEffect(() => {
  const el = previewEl.value
  const markup = artifact.preview.value?.markup ?? null
  if (el === null) return
  el.replaceChildren()
  if (markup === null) return
  const parsed = new DOMParser().parseFromString(markup, 'image/svg+xml')
  const root = parsed.documentElement
  // A parser that failed reports its own error element; drawing that instead of the picture would
  // be the surface claiming a document it did not get.
  if (root === null || root.nodeName.toLowerCase() !== 'svg') return
  el.append(document.importNode(root, true))
})
</script>

<template>
  <section
    v-if="proposals.length > 0 || host.conflict.value !== null || outcomeSentence !== null || artifact.sentence.value !== null"
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

    <div
      v-if="svg !== null"
      class="agent-note-proposal"
      data-agent-note-artifact
      :data-path="svg.path"
    >
      <p class="agent-note-line">
        <FileWarning
          :size="13"
          :stroke-width="1.8"
          aria-hidden="true"
        />
        {{ t('agent.note.svg.row', { name: artifact.fileName.value || artifact.stem(svg.path) }) }}
      </p>

      <p
        v-if="artifact.artifact.value !== null && artifact.artifact.value.status === 'unreadable'"
        class="agent-note-hint"
        data-artifact-refused
      >
        {{ t('agent.note.svg.unreadable') }}
      </p>

      <template v-else-if="artifact.preview.value !== null">
        <!-- The verified preview, and never the raw text: `markup` is the platform serialiser's
             output for the tree the checks allowed, and `AgentSvgPreview`'s brand is what makes
             this the only string a caller can reach. It is parsed as XML and imported as a node —
             `previewEl` below — rather than handed to `v-html`, because §7.3 clause 3 is about the
             RENDER and not only about the checks: a surface that injected markup would be one
             string away from drawing something no check ever saw. -->
        <div
          ref="previewEl"
          class="agent-note-preview"
          data-artifact-preview
          role="img"
          :aria-label="t('agent.note.svg.previewAlt', { name: artifact.fileName.value })"
        />
        <p class="agent-note-hint">
          {{ t('agent.note.svg.verified') }}
        </p>
        <p class="agent-note-hint">
          {{ t('agent.note.svg.where') }}
        </p>
        <label class="agent-note-name">
          <span>{{ t('agent.note.svg.name') }}</span>
          <input
            v-model="artifact.fileName.value"
            type="text"
            data-artifact-name
          >
        </label>
        <div class="agent-note-actions">
          <button
            type="button"
            class="btn btn-ghost btn-sm"
            data-action="agent-artifact-discard"
            @click="artifact.discard()"
          >
            {{ t('agent.note.svg.discard') }}
          </button>
          <button
            type="button"
            class="btn btn-secondary btn-sm"
            data-action="agent-artifact-insert"
            @click="artifact.insert()"
          >
            {{ t('agent.note.svg.insert') }}
          </button>
        </div>
      </template>

      <p
        v-else-if="artifact.previewRefusal.value !== null"
        class="agent-note-refusal"
        data-artifact-refused
      >
        {{ artifact.refusalSentence.value }}
      </p>
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

    <p
      v-if="artifact.sentence.value !== null"
      class="agent-note-outcome"
      data-agent-artifact-outcome
      role="status"
    >
      {{ artifact.sentence.value }}
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
.agent-note-refusal {
  margin: 0;
  color: var(--app-warn);
  font-size: 11px;
  line-height: 1.35;
}
/* The preview is the verified tree, drawn at a bounded size: a diagram that fills the rail would
   push the note it is about off the screen. */
.agent-note-preview {
  display: flex;
  align-items: center;
  justify-content: center;
  max-height: 180px;
  padding: 6px;
  overflow: hidden;
  background: color-mix(in srgb, var(--app-panel) 55%, var(--app-canvas));
  border-radius: var(--app-radius-sm);
}
.agent-note-preview :deep(svg) {
  max-width: 100%;
  max-height: 168px;
}
.agent-note-name {
  display: flex;
  gap: 6px;
  align-items: center;
  color: var(--app-muted);
  font-size: 11px;
}
.agent-note-name input {
  flex: 1;
  min-width: 0;
  padding: 3px 6px;
  font: inherit;
  font-size: 12px;
  color: var(--app-text);
  background: var(--app-panel);
  border: 1px solid var(--app-border);
  border-radius: var(--app-radius-sm);
}
</style>
