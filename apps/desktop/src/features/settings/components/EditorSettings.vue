<script setup lang="ts">
/**
 * The Editor section: the composed view and its default, the save cadence and
 * history depth, and the switches that change how the editor behaves.
 *
 * Both view-mode button groups stay here rather than becoming one component:
 * the first writes the live mode, the second the mode a new note opens in, and
 * the two are read-only mirrors of each other, not a shared control.
 */
import { t } from '../../../i18n'
import { useEditorSettings } from '../composables/useEditorSettings'

const {
  viewMode,
  setMode,
  defaultMode,
  setDefaultMode,
  autosaveInterval,
  maxHistory,
  setMaxHistory,
  spellCheckEnabled,
  softWrap,
  lineNumbers,
  renderTaskChecklist,
  autoSyncScroll,
  wordGoal,
  autosaveOnBlur,
  statusBarWords,
  confirmBeforeDelete,
  setSpellCheckEnabled,
  setSoftWrap,
  setLineNumbers,
  setRenderTaskChecklist,
  setAutoSyncScroll,
  setWordGoal,
  setAutosaveOnBlur,
  setStatusBarWords,
  setConfirmBeforeDelete,
} = useEditorSettings()
</script>

<template>
  <section class="settings-section">
    <span class="settings-label">{{ t('settings.editor.view') }}</span>
    <div class="view-modes">
      <button
        class="switch-option"
        :class="{ 'is-active': viewMode === 'source' }"
        @click="setMode('source')"
      >
        {{ t('settings.editor.viewSource') }}
      </button>
      <button
        class="switch-option"
        :class="{ 'is-active': viewMode === 'rendered' }"
        @click="setMode('rendered')"
      >
        {{ t('settings.editor.viewRendered') }}
      </button>
      <button
        class="switch-option"
        :class="{ 'is-active': viewMode === 'split' }"
        @click="setMode('split')"
      >
        {{ t('settings.editor.viewSplit') }}
      </button>
    </div>
    <span class="settings-label">{{ t('settings.editor.defaultView') }}</span>
    <div class="view-modes">
      <button
        class="switch-option"
        :class="{ 'is-active': defaultMode === 'source' }"
        @click="setDefaultMode('source')"
      >
        {{ t('settings.editor.viewSource') }}
      </button>
      <button
        class="switch-option"
        :class="{ 'is-active': defaultMode === 'rendered' }"
        @click="setDefaultMode('rendered')"
      >
        {{ t('settings.editor.viewRendered') }}
      </button>
      <button
        class="switch-option"
        :class="{ 'is-active': defaultMode === 'split' }"
        @click="setDefaultMode('split')"
      >
        {{ t('settings.editor.viewSplit') }}
      </button>
    </div>
    <span class="settings-label">{{ t('settings.editor.save') }}</span>
    <label class="settings-field">
      <span>{{ t('settings.editor.autosaveInterval') }}</span>
      <select
        v-model="autosaveInterval"
        class="input"
      >
        <option :value="'off'">
          {{ t('settings.editor.autosaveOff') }}
        </option>
        <option :value="5000">
          {{ t('settings.editor.autosave5s') }}
        </option>
        <option :value="15000">
          {{ t('settings.editor.autosave15s') }}
        </option>
        <option :value="30000">
          {{ t('settings.editor.autosave30s') }}
        </option>
        <option :value="60000">
          {{ t('settings.editor.autosave60s') }}
        </option>
      </select>
    </label>
    <label class="settings-field">
      <span>{{ t('settings.editor.maxHistory') }}</span>
      <input
        class="input"
        :value="maxHistory"
        type="number"
        min="1"
        max="100"
        @change="setMaxHistory(Math.min(100, Math.max(1, Math.round(Number(($event.target as HTMLInputElement).value) || 10))))"
      >
    </label>
    <span class="settings-label">{{ t('settings.editor.behavior') }}</span>
    <label class="settings-field settings-toggle">
      <span>{{ t('settings.editor.spellCheck') }}</span>
      <input
        :checked="spellCheckEnabled"
        type="checkbox"
        class="checkbox"
        @change="setSpellCheckEnabled(($event.target as HTMLInputElement).checked)"
      >
    </label>
    <label class="settings-field settings-toggle">
      <span>{{ t('settings.editor.softWrap') }}</span>
      <input
        :checked="softWrap"
        type="checkbox"
        class="checkbox"
        @change="setSoftWrap(($event.target as HTMLInputElement).checked)"
      >
    </label>
    <label class="settings-field settings-toggle">
      <span>{{ t('settings.editor.lineNumbers') }}</span>
      <input
        :checked="lineNumbers"
        type="checkbox"
        class="checkbox"
        @change="setLineNumbers(($event.target as HTMLInputElement).checked)"
      >
    </label>
    <label class="settings-field settings-toggle">
      <span>{{ t('settings.editor.renderTaskChecklist') }}</span>
      <input
        :checked="renderTaskChecklist"
        type="checkbox"
        class="checkbox"
        @change="setRenderTaskChecklist(($event.target as HTMLInputElement).checked)"
      >
    </label>
    <label class="settings-field settings-toggle">
      <span>{{ t('settings.editor.autoSyncScroll') }}</span>
      <input
        :checked="autoSyncScroll"
        type="checkbox"
        class="checkbox"
        @change="setAutoSyncScroll(($event.target as HTMLInputElement).checked)"
      >
    </label>
    <label class="settings-field">
      <span>{{ t('settings.editor.wordGoal', { goal: wordGoal }) }}</span>
      <input
        class="input"
        :value="wordGoal"
        type="number"
        min="0"
        max="100000"
        step="100"
        @change="setWordGoal(Number(($event.target as HTMLInputElement).value) || 0)"
      >
    </label>
    <label class="settings-field settings-toggle">
      <span>{{ t('settings.editor.autosaveOnBlur') }}</span>
      <input
        :checked="autosaveOnBlur"
        type="checkbox"
        class="checkbox"
        @change="setAutosaveOnBlur(($event.target as HTMLInputElement).checked)"
      >
    </label>
    <label class="settings-field settings-toggle">
      <span>{{ t('settings.editor.statusBarWords') }}</span>
      <input
        :checked="statusBarWords"
        type="checkbox"
        class="checkbox"
        @change="setStatusBarWords(($event.target as HTMLInputElement).checked)"
      >
    </label>
    <label class="settings-field settings-toggle">
      <span>{{ t('settings.editor.confirmBeforeDelete') }}</span>
      <input
        :checked="confirmBeforeDelete"
        type="checkbox"
        class="checkbox"
        @change="setConfirmBeforeDelete(($event.target as HTMLInputElement).checked)"
      >
    </label>
  </section>
</template>

<style scoped>
/* `.settings-section`, `.settings-field`, `.settings-label`, `.settings-toggle`,
   `.checkbox` and `.view-modes` are restated in the sections that render them:
   a scoped block belongs to the component that renders the element, and the
   classes are too small to belong in the shared stylesheet. */
.settings-section {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.settings-field { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: var(--app-text); }
.settings-field > span { color: var(--app-muted); font-size: 11px; }
.settings-label {
  margin-top: 6px;
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.04em;
  color: var(--app-muted);
}
.settings-section .settings-label:first-child { margin-top: 0; }
.settings-toggle {
  flex-direction: row;
  align-items: center;
  justify-content: space-between;
}
.settings-toggle > span { color: var(--app-text); font-size: 12px; }
.checkbox {
  width: 16px;
  height: 16px;
  accent-color: var(--app-accent);
  cursor: pointer;
}
.view-modes { display: flex; gap: 6px; flex-wrap: wrap; }
.view-modes button:disabled { opacity: 0.5; cursor: not-allowed; }
</style>
