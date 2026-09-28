<script setup lang="ts">
import { fillTemplate, type DraftField, type RegistryRefusal } from '../services/agent-registry-policy'
import type { AgentRegistryLabels } from './agent-registry-labels'
defineProps<{
  form: Record<DraftField, string>; labels: AgentRegistryLabels; adapterIds: readonly string[]
  busy: string | null; addedAgentId: string | null; actionFailed: boolean; addRefusal: RegistryRefusal | null
  editing: boolean
  problem: (field: DraftField) => RegistryRefusal | null
  refusalText: (refusal: RegistryRefusal | null) => string
}>()
const emit = defineEmits<{ submit: []; cancel: []; update: [field: DraftField, value: string] }>()
function update(field: DraftField, event: Event): void {
  emit('update', field, (event.target as HTMLInputElement).value)
}
</script>
<template>
  <form
    class="registry-form"
    @submit.prevent="emit('submit')"
  >
    <fieldset :disabled="busy !== null">
      <span class="settings-label">{{ editing ? labels.edit.title : labels.add.title }}</span>
      <label class="settings-field">
        <span>{{ labels.fields.agentId }}</span>
        <input
          :value="form.agentId"
          class="registry-input"
          data-test="registry-field-agentId"
          :disabled="editing"
          @input="update('agentId', $event)"
        >
        <span
          v-if="problem('agentId')"
          class="settings-note is-error"
          data-test="registry-problem-agentId"
        >{{ refusalText(problem('agentId')) }}</span>
      </label>
      <label class="settings-field">
        <span>{{ labels.fields.displayName }}</span>
        <input
          :value="form.displayName"
          class="registry-input"
          data-test="registry-field-displayName"
          @input="update('displayName', $event)"
        >
      </label>
      <label class="settings-field">
        <span>{{ labels.fields.program }}</span>
        <input
          :value="form.program"
          class="registry-input"
          data-test="registry-field-program"
          @input="update('program', $event)"
        >
        <span
          v-if="problem('program')"
          class="settings-note is-error"
          data-test="registry-problem-program"
        >{{ refusalText(problem('program')) }}</span>
      </label>
      <label class="settings-field">
        <span>{{ labels.fields.args }}</span>
        <textarea
          :value="form.args"
          class="registry-input registry-textarea"
          rows="3"
          data-test="registry-field-args"
          @input="update('args', $event)"
        />
        <span class="settings-note">{{ labels.fields.argsHint }}</span>
        <span
          v-if="problem('args')"
          class="settings-note is-error"
          data-test="registry-problem-args"
        >{{ refusalText(problem('args')) }}</span>
      </label>
      <label class="settings-field">
        <span>{{ labels.fields.adapter }}</span>
        <select
          :value="form.adapterId"
          class="registry-input"
          data-test="registry-field-adapter"
          @change="update('adapterId', $event)"
        >
          <option value="">
            —
          </option>
          <option
            v-for="adapterId in adapterIds"
            :key="adapterId"
            :value="adapterId"
          >{{ adapterId }}</option>
        </select>
        <span
          v-if="problem('adapterId')"
          class="settings-note is-error"
          data-test="registry-problem-adapterId"
        >{{ refusalText(problem('adapterId')) }}</span>
      </label>
      <div class="registry-actions">
        <button
          type="submit"
          class="registry-button"
          :data-test="editing ? 'registry-update' : 'registry-add'"
          :disabled="busy !== null"
        >
          {{ editing ? labels.edit.submit : labels.add.submit }}
        </button>
        <button
          v-if="editing"
          type="button"
          class="registry-button"
          data-test="registry-cancel-edit"
          @click="emit('cancel')"
        >
          {{ labels.edit.cancel }}
        </button>
        <span
          v-if="addedAgentId"
          class="settings-note registry-added"
          data-test="registry-added"
        >{{ fillTemplate(labels.add.added, { agentId: addedAgentId }) }}</span>
        <span
          v-if="actionFailed"
          class="settings-note is-error registry-failed"
          data-test="registry-action-failed"
        >{{ labels.action.failed }}</span>
      </div>
      <span
        v-if="addRefusal"
        class="settings-note is-error registry-refusal"
        data-test="registry-add-refusal"
      >{{ refusalText(addRefusal) }}</span>
    </fieldset>
  </form>
</template>
<style scoped>
fieldset { display: flex; flex-direction: column; gap: 6px; margin: 0; padding: 0; border: 0; min-width: 0; }
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
