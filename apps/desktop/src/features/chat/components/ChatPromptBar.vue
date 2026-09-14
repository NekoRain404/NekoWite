<script setup lang="ts">
/**
 * The writing-prompt shortcuts, as a row under the composer.
 *
 * Split out of `ChatComposer` when the composer crossed the line budget, and it
 * is a vertical slice rather than a line-count dodge: this is the shelf's only
 * surface — what the user picks from, and nothing about the question being
 * written. The composer forwards the pick; which prompts exist, and which are
 * switched on, comes from the catalog and the settings store (see
 * `features/ai/prompts`).
 *
 * **A row and not a menu**: they are eight short phrases, and a menu would add a
 * click and a popup to the one place the user is already typing. It scrolls
 * sideways rather than wrapping, so a translation that runs long cannot grow the
 * composer and push the transcript off the top of a 300px rail.
 *
 * **A pick fills the composer, it does not send.** The question a shortcut opens
 * with is rarely the whole question — "summarise this note" is followed by
 * "…focusing on section 3" more often than not — and a shortcut that fired a
 * request on the click would take that decision away from the person about to
 * make it.
 */
import { t } from '../../../i18n'
import type { ChatPrompt } from '../../ai'

defineProps<{
  /** Already filtered by the user's switches, and in shelf order. */
  prompts: readonly ChatPrompt[]
}>()

const emit = defineEmits<{
  pick: [id: string]
}>()
</script>

<template>
  <div
    v-if="prompts.length"
    class="chat-prompts"
    role="group"
    :aria-label="t('aiSettings.promptTitle')"
  >
    <button
      v-for="shortcut in prompts"
      :key="shortcut.id"
      type="button"
      class="chat-prompt"
      :title="t(shortcut.instructionKey)"
      @click="emit('pick', shortcut.id)"
    >
      {{ t(shortcut.labelKey) }}
    </button>
  </div>
</template>

<style scoped>
.chat-prompts {
  display: flex;
  gap: 4px;
  overflow-x: auto;
  padding: 1px 2px 2px;
  scrollbar-width: thin;
}
.chat-prompt {
  flex: none;
  height: 22px;
  padding: 0 8px;
  border: 1px solid color-mix(in srgb, var(--app-border) 70%, transparent);
  border-radius: 999px;
  background: transparent;
  color: var(--app-muted);
  font-family: var(--app-font);
  font-size: 11px;
  line-height: 1;
  white-space: nowrap;
  cursor: pointer;
  transition: background var(--app-motion-fast) var(--app-ease),
              color var(--app-motion-fast) var(--app-ease);
}
.chat-prompt:hover {
  color: var(--app-text);
  background: color-mix(in srgb, var(--app-accent-soft) 60%, var(--app-elevated));
}
.chat-prompt:focus-visible {
  outline: 2px solid var(--app-accent);
  outline-offset: 1px;
}
</style>
