<script lang="ts">
/**
 * The conflict surface's copy, handed in rather than reached for.
 *
 * The same arrangement as `AgentChangesViewLabels`, and for the same reason: this component's
 * sentences are its caller's, so a missing one is a compile error at the mounting site instead
 * of an English string shipped in a Chinese window.
 */
export interface AgentEditConflictLabels {
  title: string
  /** What happened, in one sentence: the note moved while the run was in flight. */
  moved: string
  /** The heading over the text the agent produced. */
  agentText: string
  /** The heading over the text the note holds now — which is the user's own. */
  noteText: string
  /** Write the agent's version over the note. */
  apply: string
  /** Leave the note exactly as it is. */
  discard: string
  /** What the user is owed before they choose: their text is not lost either way. */
  kept: string
}
</script>

<script setup lang="ts">
/**
 * The conflict: the note moved while the agent was working, and both texts are shown before
 * anything is decided.
 *
 * Props in, events out (§10.2): no store, no gateway, no editor. The rows are the conflicts
 * `agent-edit-apply.ts` judged, copied into values, and this file renders them — which is what
 * keeps the decision about *whether a write is allowed* in the module that can see both
 * versions, and the decision about *what the user is looking at* here.
 *
 * It is deliberately unable to touch a document, exactly as the change view is: `apply` and
 * `discard` are events, and whoever mounted this owns the editor. A component that wrote the
 * note itself would be a second apply path with no version check in front of it — which is the
 * defect this surface exists to end, not a shortcut past it.
 *
 * Both texts are always shown, and neither is abbreviated. The whole question the user is
 * answering is "what does the agent's version do to mine", and a surface that showed only one
 * of them, or a summary of the difference, would be asking them to decide from something other
 * than the two documents. They are scrollable rather than clipped for the same reason: a
 * truncated paragraph reads as a short one.
 */
import { ArrowRightLeft, FileWarning } from 'lucide-vue-next'
import type { AgentEditConflict } from '../services/agent-edit-apply'

// `AgentEditConflictLabels` needs no import: the plain `<script>` block above is the same
// module, which is how `AgentChangesView.vue` declares its own labels type.
/**
 * "Nothing to decide" is not a state of this component: with no conflicts there is no section at
 * all, rather than an empty box that reads as a conflict whose texts failed to load.
 */
defineProps<{
  /** The conflicts to decide, in the order the applies reached them. */
  conflicts: readonly AgentEditConflict[]
  labels: AgentEditConflictLabels
}>()

const emit = defineEmits<{
  /** Write the agent's version over the note; the user's text is handed back to the caller. */
  (e: 'apply', path: string): void
  /** Leave the note as it is. Nothing was written, so there is nothing to undo. */
  (e: 'discard', path: string): void
}>()

</script>

<template>
  <section
    v-if="conflicts.length > 0"
    class="agent-conflict"
    data-agent-edit-conflict
    :aria-label="labels.title"
  >
    <h2 class="agent-conflict-title">
      {{ labels.title }}
    </h2>

    <ul class="agent-conflict-list">
      <li
        v-for="conflict in conflicts"
        :key="conflict.path"
        class="agent-conflict-row"
        :data-path="conflict.path"
        :data-baseline-revision="conflict.baselineRevision"
        :data-current-revision="conflict.currentRevision"
      >
        <p class="agent-conflict-moved">
          <FileWarning
            :size="13"
            :stroke-width="1.8"
            aria-hidden="true"
          />
          <span class="agent-conflict-path">{{ conflict.path }}</span>
          {{ labels.moved }}
        </p>

        <div class="agent-conflict-texts">
          <div class="agent-conflict-side">
            <p class="agent-conflict-caption">
              {{ labels.agentText }}
            </p>
            <pre
              class="agent-conflict-text"
              data-role="agent"
              tabindex="0"
              :aria-label="labels.agentText"
            >{{ conflict.agentText }}</pre>
          </div>
          <div class="agent-conflict-side">
            <p class="agent-conflict-caption">
              {{ labels.noteText }}
            </p>
            <pre
              class="agent-conflict-text"
              data-role="note"
              tabindex="0"
              :aria-label="labels.noteText"
            >{{ conflict.noteText }}</pre>
          </div>
        </div>

        <p class="agent-conflict-kept">
          {{ labels.kept }}
        </p>

        <div class="agent-conflict-actions">
          <!-- The agent's version is the one that can destroy the user's text, so it is drawn
               as the secondary action and comes second in reading order: the safe answer is the
               one a keyboard reaches first. -->
          <button
            type="button"
            class="btn btn-ghost btn-sm"
            data-action="discard"
            :data-path="conflict.path"
            @click="emit('discard', conflict.path)"
          >
            {{ labels.discard }}
          </button>
          <button
            type="button"
            class="btn btn-secondary btn-sm"
            data-action="apply"
            :data-path="conflict.path"
            @click="emit('apply', conflict.path)"
          >
            <ArrowRightLeft
              :size="14"
              :stroke-width="1.8"
              aria-hidden="true"
            />
            {{ labels.apply }}
          </button>
        </div>
      </li>
    </ul>
  </section>
</template>

<style scoped>
.agent-conflict {
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-width: 0;
  color: var(--app-text);
  font-size: 13px;
}
.agent-conflict-title {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
}
.agent-conflict-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin: 0;
  padding: 0;
  list-style: none;
}
.agent-conflict-row {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px 10px;
  background: var(--app-elevated);
  border: 1px solid color-mix(in srgb, var(--app-warn) 55%, var(--app-border));
  border-radius: var(--app-radius);
}
.agent-conflict-moved {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  align-items: center;
  margin: 0;
  color: var(--app-warn);
  font-size: 12px;
}
.agent-conflict-path {
  font-family: var(--app-mono-font);
  /* A path has no spaces to break at. */
  overflow-wrap: anywhere;
}
.agent-conflict-texts {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
  min-width: 0;
}
/* One column when there is no room for two: a side-by-side pair squeezed into a narrow rail
   would compare two very short lines rather than two documents. */
@media (max-width: 520px) {
  .agent-conflict-texts {
    grid-template-columns: 1fr;
  }
}
.agent-conflict-side {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}
.agent-conflict-caption {
  margin: 0;
  color: var(--app-muted);
  font-size: 11px;
  line-height: 1.3;
}
.agent-conflict-text {
  margin: 0;
  padding: 6px 8px;
  max-height: 220px;
  overflow: auto;
  font-family: var(--app-mono-font);
  font-size: 12px;
  line-height: 1.45;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  background: color-mix(in srgb, var(--app-panel) 55%, var(--app-canvas));
  border-radius: var(--app-radius-sm);
}
.agent-conflict-kept {
  margin: 0;
  color: var(--app-muted);
  font-size: 11px;
  line-height: 1.35;
}
.agent-conflict-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  align-items: center;
}
.agent-conflict-actions .btn {
  display: inline-flex;
  gap: 4px;
  align-items: center;
}
</style>
