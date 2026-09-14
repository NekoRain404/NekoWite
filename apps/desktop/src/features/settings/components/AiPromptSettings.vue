<script setup lang="ts">
/**
 * The shelf of writing prompts, as switches.
 *
 * Split out of the AI section for the same reason the permission block was: it
 * answers a different question ("which shortcuts does the composer show") from
 * the provider block ("where do the requests go"), and the AI section was
 * already at the line budget before this existed.
 *
 * It reads nothing itself: `useAiPromptSettings` owns the store and the
 * inversion (§10.2). The labels come from the catalog's keys, so a prompt added
 * to the shelf appears here without this file changing.
 */
import { t } from '../../../i18n'
import { useAiPromptSettings } from '../composables/use-ai-prompt-settings'

const { prompts, isOn, setOn } = useAiPromptSettings()
</script>

<template>
  <div class="settings-field">
    <span class="settings-label">{{ t('aiSettings.promptTitle') }}</span>
    <div class="prompt-switches">
      <label
        v-for="prompt in prompts"
        :key="prompt.id"
        class="prompt-switch"
      >
        <input
          class="checkbox"
          type="checkbox"
          :checked="isOn(prompt.id)"
          @change="setOn(prompt.id, ($event.target as HTMLInputElement).checked)"
        >
        <span>{{ t(prompt.labelKey) }}</span>
      </label>
    </div>
    <span class="settings-note">{{ t('aiSettings.promptHint') }}</span>
  </div>
</template>

<style scoped>
/* The same shape as the settings toggles around it — a checkbox, then its
   label — but wrapping in two columns rather than one per row: eight prompts as
   full-width rows would be most of the section's height, and every one of them
   is a single short word. */
.prompt-switches {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(96px, 1fr));
  gap: 4px 10px;
  margin-top: 2px;
}
.prompt-switch {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--app-text);
  cursor: pointer;
}
.checkbox {
  width: 14px;
  height: 14px;
  flex: none;
  accent-color: var(--app-accent);
  cursor: pointer;
}
</style>
