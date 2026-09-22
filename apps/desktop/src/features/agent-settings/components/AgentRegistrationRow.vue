<script setup lang="ts">
import { Trash2 } from 'lucide-vue-next'
import { fillTemplate, readEnvForDisplay, updateStanding, type AgentRegistryEntry } from '../services/agent-registry-policy'
import type { AgentRegistryLabels } from './agent-registry-labels'
defineProps<{ entry: AgentRegistryEntry; labels: AgentRegistryLabels; blocked: string | null; refusal: string; version: string; busy: string | null }>()
const emit = defineEmits<{ toggle: [event: Event]; delete: [] }>()
</script>
<template>
  <li
    class="registry-row"
    :data-test="`registry-row-${entry.agentId}`"
  >
    <div class="registry-head">
      <span class="registry-name">{{ entry.displayName || entry.agentId }}</span>
      <span class="registry-badge registry-source">{{ labels.provenance[entry.source] }}</span>
    </div>
    <span class="registry-program">{{ entry.program }}</span>
    <span
      v-if="entry.args.length > 0"
      class="registry-args"
    >
      <code
        v-for="(arg, index) in entry.args"
        :key="index"
      >{{ arg }}</code>
    </span>
    <span
      v-if="entry.envExtra.length > 0"
      class="registry-args registry-env"
    >
      <code
        v-for="variable in readEnvForDisplay(entry.envExtra)"
        :key="variable.name"
      >{{ variable.name }}={{ variable.value }}</code>
    </span>
    <span class="settings-note registry-adapter">{{ labels.list.adapter }}: {{ entry.adapterId }}</span>
    <span class="settings-note registry-version">{{ version }}</span>
    <span class="settings-note registry-update">{{ labels.update[updateStanding(entry.source)] }}</span>
    <span
      class="settings-note registry-state"
      :class="{ 'is-warn': entry.programState !== 'launchable' }"
    >
      {{ fillTemplate(labels.programState[entry.programState], { path: entry.program }) }}
    </span>
          
    <span class="settings-note registry-standing">{{ labels.standing[entry.source] }}</span>
    <span
      v-if="refusal"
      class="settings-note is-error registry-refusal"
    >{{ refusal }}</span>
    <label class="settings-field settings-toggle">
      <span>{{ entry.enabled ? labels.control.disable : labels.control.enable }}</span>
      <input
        type="checkbox"
        class="checkbox"
        :checked="entry.enabled"
        :disabled="busy !== null || blocked !== null"
        :data-test="`registry-toggle-${entry.agentId}`"
        @change="emit('toggle', $event)"
      >
    </label>
    <button
      type="button"
      class="registry-delete"
      :title="labels.deletion.title"
      :aria-label="labels.deletion.title"
      :data-test="`registry-delete-${entry.agentId}`"
      :disabled="busy !== null || blocked !== null"
      @click="emit('delete')"
    >
      <Trash2
        :size="15"
        aria-hidden="true"
      />
    </button>
    <span
      v-if="blocked"
      class="settings-note registry-blocked"
    >{{ blocked }}</span>
  </li>
</template>
<style scoped>
/* The `.settings-*` classes are restated here, as they are in every section that renders them: a
   scoped block belongs to the component that renders the element, and these are too small to
   belong in the shared stylesheet. */
.settings-section { display: flex; flex-direction: column; gap: 8px; }
.settings-label { margin-top: 6px; font-size: 10px; font-weight: 600; letter-spacing: 0.04em; color: var(--app-muted); }
.settings-note { font-size: 11px; line-height: 1.5; color: var(--app-muted); }
.settings-note.is-warn { color: var(--app-warn); }
.settings-note.is-error { color: var(--app-danger); }
.settings-field { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: var(--app-text); }
.settings-field > span:first-child { color: var(--app-muted); font-size: 11px; }
.settings-toggle { flex-direction: row; align-items: center; justify-content: space-between; gap: 8px; }
.registry-rows { display: flex; flex-direction: column; gap: 10px; margin: 0; padding: 0; list-style: none; }
/* One row per registration: a card, because a definition is several facts that belong together and
   the switch at its foot is about the entry above it. */
.registry-row {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 8px 10px;
  border: 1px solid var(--app-border);
  border-radius: var(--app-radius-sm);
  background: var(--app-elevated);
}
.registry-head { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
.registry-name { font-size: 12px; font-weight: 600; color: var(--app-text); }
.registry-badge { font-size: 10px; padding: 1px 6px; border-radius: 999px; border: 1px solid var(--app-border); color: var(--app-muted); white-space: nowrap; }
.registry-program { font-family: var(--app-mono-font); font-size: 11px; color: var(--app-text); overflow-wrap: anywhere; }
/* Chips, not a joined line: an argument is one element of an array, and a space inside it is part
   of it — the row must not draw what §3.4.3 forbids ever being built. */
.registry-args { display: flex; flex-wrap: wrap; gap: 4px; }
.registry-args code { font-family: var(--app-mono-font); font-size: 11px; padding: 1px 5px; border-radius: var(--app-radius-sm); background: var(--app-panel); color: var(--app-text); }
.registry-form, .registry-engine { display: flex; flex-direction: column; gap: 6px; padding-top: 8px; border-top: 1px solid var(--app-border); }
.registry-input { font: inherit; font-size: 12px; padding: 4px 6px; border: 1px solid var(--app-border); border-radius: var(--app-radius-sm); background: var(--app-elevated); color: var(--app-text); }
.registry-textarea { font-family: var(--app-mono-font); resize: vertical; }
.registry-actions { display: flex; align-items: center; gap: 8px; }
.registry-button { align-self: flex-start; font: inherit; font-size: 11px; padding: 4px 10px; border: 1px solid var(--app-border); border-radius: var(--app-radius-sm); background: var(--app-accent); color: var(--app-accent-contrast); cursor: pointer; }
.registry-button:disabled { opacity: 0.5; cursor: default; }
.registry-delete { align-self: flex-end; display: grid; place-items: center; width: 28px; height: 28px; border: 0; background: transparent; color: var(--app-danger); cursor: pointer; }
.registry-delete:disabled { opacity: 0.4; cursor: default; }
.registry-confirm { display: flex; flex-direction: column; gap: 8px; padding: 10px; border: 1px solid var(--app-danger); border-radius: var(--app-radius-sm); }
</style>
