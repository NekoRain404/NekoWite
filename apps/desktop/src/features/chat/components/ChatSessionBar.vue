<script setup lang="ts">
/**
 * The panel's header: pick a conversation, start one, delete one, clear the
 * turns on screen.
 *
 * Presentation and event forwarding only (§10.2): which conversation is active
 * and what deleting it means is the panel's business, so this emits the choice
 * and renders what it is given.
 */
import { computed } from 'vue'
import { Plus, Trash2 } from 'lucide-vue-next'
import SelectMenu, { type SelectOption } from '../../../components/SelectMenu.vue'
import { t } from '../../../i18n'
import type { ChatSession } from '../services/chat-session-model'

const props = defineProps<{
  sessions: ChatSession[]
  activeId: string | null
  /** Nothing to clear yet: the clear button is only for a conversation with turns. */
  hasMessages: boolean
}>()

const sessionChoices = computed<SelectOption[]>(() =>
  props.sessions.map((session) => ({
    value: session.id,
    label: session.title || t('chat.untitled'),
  })),
)

defineEmits<{
  newSession: []
  /** The session id the user picked. The panel ignores it when it names the
   *  conversation already open. */
  selectSession: [id: string]
  deleteSession: []
  clear: []
}>()
</script>

<template>
  <header class="chat-header">
    <div class="chat-session-row">
      <button
        class="chat-tool"
        :title="t('chat.newSession')"
        :aria-label="t('chat.newSession')"
        @click="$emit('newSession')"
      >
        <Plus
          :size="14"
          :stroke-width="1.8"
        />
      </button>
      <SelectMenu
        id="chat-session-picker"
        class="chat-session-select"
        :model-value="activeId ?? ''"
        :title="t('chat.sessions')"
        :aria-label="t('chat.sessions')"
        :options="sessionChoices"
        @update:model-value="$emit('selectSession', $event as string)"
      />
      <button
        class="chat-tool"
        :title="t('chat.deleteSession')"
        :aria-label="t('chat.deleteSession')"
        :disabled="sessions.length <= 1"
        @click="$emit('deleteSession')"
      >
        <Trash2
          :size="13"
          :stroke-width="1.8"
        />
      </button>
    </div>
    <span class="chat-title">
      {{ t('chat.title') }}
    </span>
    <button
      class="chat-clear"
      :title="t('chat.clear')"
      :disabled="!hasMessages"
      @click="$emit('clear')"
    >
      <Trash2
        :size="13"
        :stroke-width="1.8"
      />
    </button>
  </header>
</template>

<style scoped>
.chat-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  flex: none;
  padding: 12px 14px 6px;
}
.chat-session-row {
  display: flex;
  align-items: center;
  gap: 2px;
  min-width: 0;
}
.chat-session-select {
  flex: 1;
  min-width: 0;
  max-width: 130px;
  height: 26px;
  padding: 0 6px;
  border: 1px solid color-mix(in srgb, var(--app-border) 60%, transparent);
  border-radius: var(--app-radius-sm);
  background: color-mix(in srgb, var(--app-elevated) 42%, var(--app-panel));
  color: var(--app-text);
  font-family: var(--app-font);
  font-size: 11px;
  line-height: 1.4;
  outline: none;
  text-overflow: ellipsis;
  white-space: nowrap;
  overflow: hidden;
  transition: border-color var(--app-motion-fast) var(--app-ease),
              box-shadow var(--app-motion-fast) var(--app-ease);
}
.chat-session-select:focus {
  border-color: color-mix(in srgb, var(--app-accent) 55%, var(--app-border));
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--app-accent) 14%, transparent);
}
.chat-session-select:disabled {
  opacity: 0.5;
  cursor: default;
}
.chat-title {
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.04em;
  color: var(--app-muted);
}
.chat-clear {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border: none;
  border-radius: var(--app-radius-sm);
  background: transparent;
  color: var(--app-muted);
  cursor: pointer;
  transition: background var(--app-motion-fast) var(--app-ease),
              color var(--app-motion-fast) var(--app-ease);
}
.chat-clear:hover:not(:disabled) {
  color: var(--app-text);
  background: color-mix(in srgb, var(--app-elevated) 66%, transparent);
}
.chat-clear:disabled {
  cursor: default;
  opacity: 0.5;
}
.chat-clear:focus-visible {
  outline: 2px solid var(--app-accent);
  outline-offset: 1px;
}
/* The session row's two controls wear a class this file shares with the composer's tool row,
   and the ring that goes with it lives in that component's stylesheet — which is scoped, so it
   never reached these. The census found them on the engine's ring for that reason: the class
   name was the composer's, the elements were not. Same rule as its sibling above.
   Their BOX is unstyled for the same reason and is left as it is found: this change is about
   the ring, and inventing a size and a hover for them here would be a redesign, not a repair. */
.chat-tool:focus-visible {
  outline: 2px solid var(--app-accent);
  outline-offset: 1px;
}
</style>
