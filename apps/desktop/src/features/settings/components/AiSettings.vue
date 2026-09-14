<script setup lang="ts">
/**
 * The AI section: which provider the app talks to, how, and with what budget.
 *
 * The write permission and its audit trail are a child component — a different
 * question ("what may come back") with its own composable — and the provider
 * block is everything here.
 */
import { computed } from 'vue'
import { RefreshCw } from 'lucide-vue-next'
import SelectMenu, { type SelectOption } from '../../../components/SelectMenu.vue'
import { t } from '../../../i18n'
// Type-only, so the effort dropdown's cast is checked against the union the
// composable's writable computed accepts.
import type { ReasoningEffort } from '../../../stores/settings'
import { useAiSettings } from '../composables/useAiSettings'
import AiPermissionSettings from './AiPermissionSettings.vue'

const {
  providers,
  showBaseUrl,
  provider,
  model,
  baseUrl,
  modelsUrl,
  apiKey,
  allowPrivate,
  systemPromptOn,
  systemPrompt,
  temperature,
  maxTokens,
  reasoningEffort,
  effortOptions,
  contextChars,
  contextCharsMin,
  contextCharsMax,
  contextCharsDefault,
  modelOptions,
  modelLoading,
  refreshModels,
  saveAiKey,
} = useAiSettings()

// A provider is named by its id; the effort list carries translation keys, so
// the labels are resolved here (§13.3).
const providerChoices = computed<SelectOption[]>(() =>
  providers.map((name) => ({ value: name, label: name })),
)
const effortChoices = computed<SelectOption[]>(() =>
  effortOptions.map((option) => ({ value: option.value, label: t(option.labelKey) })),
)
</script>

<template>
  <section class="settings-section">
    <span class="settings-label">{{ t('settings.section.ai') }}</span>
    <label
      class="settings-field"
      for="settings-ai-provider"
    >
      <span>{{ t('aiSettings.provider') }}</span>
      <SelectMenu
        id="settings-ai-provider"
        class="input"
        :model-value="provider"
        :options="providerChoices"
        @update:model-value="provider = $event as string"
      />
    </label>
    <label class="settings-field">
      <span>{{ t('aiSettings.model') }}</span>
      <div class="model-row">
        <input
          v-model="model"
          class="input"
          type="text"
          list="model-list"
          placeholder="qwen2.5-coder:3b"
        >
        <datalist id="model-list">
          <option
            v-for="m in modelOptions"
            :key="m"
            :value="m"
          >
            {{ m }}
          </option>
        </datalist>
        <button
          class="btn btn-secondary btn-sm model-refresh"
          :disabled="modelLoading"
          :title="t('aiSettings.refreshModels')"
          @click="refreshModels"
        >
          <RefreshCw
            :size="13"
            :stroke-width="1.8"
            class="model-refresh-icon"
            :class="{ spin: modelLoading }"
          />
          <span>{{ t('aiSettings.refresh') }}</span>
        </button>
      </div>
    </label>
    <label
      v-if="showBaseUrl"
      class="settings-field"
    >
      <span>{{ t('aiSettings.baseUrl') }}</span>
      <input
        v-model="baseUrl"
        class="input"
        type="text"
        placeholder="http://localhost:1234/v1"
      >
      <span class="settings-note">{{ t('aiSettings.baseUrlHint') }}</span>
    </label>
    <label
      v-if="showBaseUrl"
      class="settings-field"
    >
      <span>{{ t('aiSettings.modelsUrl') }}</span>
      <input
        v-model="modelsUrl"
        class="input"
        type="text"
        spellcheck="false"
        placeholder="https://tokenflux.dev/v1/models"
      >
      <span class="settings-note">{{ t('aiSettings.modelsUrlHint') }}</span>
    </label>
    <label
      v-if="showBaseUrl"
      class="settings-field settings-toggle"
    >
      <span>{{ t('aiSettings.allowPrivate') }}</span>
      <input
        v-model="allowPrivate"
        type="checkbox"
        class="checkbox"
      >
    </label>
    <span
      v-if="showBaseUrl"
      class="settings-note"
    >{{ t('aiSettings.allowPrivateHint') }}</span>
    <label class="settings-field">
      <span>{{ t('aiSettings.apiKey') }}</span>
      <input
        v-model="apiKey"
        class="input"
        type="password"
        autocomplete="off"
        spellcheck="false"
        placeholder="sk-..."
      >
    </label>
    <button
      class="btn btn-secondary settings-save"
      @click="saveAiKey"
    >
      {{ t('aiSettings.saveKey') }}
    </button>
    <span class="settings-note">{{ t('aiSettings.keyNote') }}</span>
    <label class="settings-field settings-toggle">
      <span>{{ t('aiSettings.systemPrompt') }}</span>
      <input
        v-model="systemPromptOn"
        type="checkbox"
        class="checkbox"
      >
    </label>
    <label
      v-if="systemPromptOn"
      class="settings-field"
    >
      <span>{{ t('aiSettings.systemPromptHint') }}</span>
      <textarea
        v-model="systemPrompt"
        class="input textarea"
        rows="3"
        :placeholder="t('aiSettings.systemPromptPlaceholder')"
      />
    </label>
    <label class="settings-field">
      <span>{{ t('aiSettings.temperature') }}</span>
      <input
        class="input"
        :value="temperature"
        type="number"
        min="0"
        max="2"
        step="0.1"
        @change="temperature = Math.min(2, Math.max(0, Number(($event.target as HTMLInputElement).value) || 0.7))"
      >
    </label>
    <label
      class="settings-field"
      for="settings-ai-effort"
    >
      <span>{{ t('aiSettings.effort') }}</span>
      <SelectMenu
        id="settings-ai-effort"
        class="input"
        :model-value="reasoningEffort"
        :options="effortChoices"
        @update:model-value="reasoningEffort = $event as ReasoningEffort"
      />
      <span class="settings-note">{{ t('aiSettings.effortHint') }}</span>
    </label>
    <label class="settings-field">
      <span>{{ t('aiSettings.contextChars') }}</span>
      <input
        class="input"
        :value="contextChars"
        type="number"
        :min="contextCharsMin"
        :max="contextCharsMax"
        step="1000"
        @change="contextChars = Math.min(contextCharsMax, Math.max(contextCharsMin, Math.round(Number(($event.target as HTMLInputElement).value) || contextCharsDefault)))"
      >
      <span class="settings-note">{{ t('aiSettings.contextCharsHint', { min: contextCharsMin, max: contextCharsMax }) }}</span>
    </label>
    <AiPermissionSettings />
    <label class="settings-field">
      <span>{{ t('aiSettings.maxTokens') }}</span>
      <input
        class="input"
        :value="maxTokens"
        type="number"
        min="128"
        max="8192"
        step="64"
        @change="maxTokens = Math.min(8192, Math.max(128, Math.round(Number(($event.target as HTMLInputElement).value) || 1024)))"
      >
    </label>
  </section>
</template>

<style scoped>
/* `.settings-section`, `.settings-field`, `.settings-note`, `.settings-label`,
   `.settings-toggle`, `.checkbox`, `.textarea` and `.model-row` are restated in
   the sections that render them: a scoped block belongs to the component that
   renders the element, and the classes are too small to belong in the shared
   stylesheet. */
.settings-section {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.settings-field { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: var(--app-text); }
.settings-field > span { color: var(--app-muted); font-size: 11px; }
.settings-note { font-size: 11px; line-height: 1.5; color: var(--app-muted); }
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
.textarea {
  resize: vertical;
  min-height: 64px;
  font-family: var(--app-font);
  line-height: 1.5;
}
.settings-save { align-self: flex-start; }
.model-row { display: flex; gap: 6px; }
.model-row .input { flex: 1; min-width: 0; }
.model-refresh { flex: none; padding: 0 10px; }
.model-refresh:disabled { cursor: default; opacity: 0.6; }
.model-refresh-icon.spin {
  animation: model-spin 0.9s linear infinite;
}
@keyframes model-spin {
  to { transform: rotate(360deg); }
}
</style>
