<script setup lang="ts">
/**
 * The scrolling log of turns, and the empty state that stands in for it.
 *
 * It owns the scroll element, which is why it - not the panel - pins the log to
 * its newest turn: the send path calls `scrollToBottom` through the panel's
 * template ref, so the element it scrolls and the component that renders it
 * cannot drift apart.
 */
import { nextTick, ref } from 'vue'
import { Sparkles } from 'lucide-vue-next'
import { t } from '../../../i18n'
import ChatMessageRow from './ChatMessageRow.vue'
import type { PanelMessage } from '../types'

defineProps<{
  messages: PanelMessage[]
  /** A document is open, so a row's insert action can act. */
  canInsert: boolean
}>()

defineEmits<{
  stop: []
  insert: [message: PanelMessage]
  copy: [message: PanelMessage]
}>()

const scrollEl = ref<HTMLElement | null>(null)

function scrollToBottom(): void {
  void nextTick(() => {
    const el = scrollEl.value
    if (el) el.scrollTop = el.scrollHeight
  })
}

defineExpose({ scrollToBottom })
</script>

<template>
  <div
    ref="scrollEl"
    class="chat-scroll"
    role="log"
    aria-live="polite"
  >
    <div
      v-if="!messages.length"
      class="chat-empty"
    >
      <Sparkles
        class="chat-empty-icon"
        :size="20"
        :stroke-width="1.6"
      />
      <p class="chat-empty-title">
        {{ t('chat.emptyTitle') }}
      </p>
      <p class="chat-empty-hint">
        {{ t('chat.emptyMsg') }}
      </p>
      <p class="chat-empty-hint">
        {{ t('chat.emptyImages') }}
      </p>
    </div>

    <ChatMessageRow
      v-for="(m, index) in messages"
      :key="index"
      :message="m"
      :can-insert="canInsert"
      @stop="$emit('stop')"
      @insert="$emit('insert', m)"
      @copy="$emit('copy', m)"
    />
  </div>
</template>

<style scoped>
.chat-scroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 2px 14px 10px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.chat-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 4px;
  flex: 1;
  min-height: 160px;
  padding: 16px;
  text-align: center;
  color: var(--app-muted);
}
.chat-empty-icon {
  margin-bottom: 4px;
  color: color-mix(in srgb, var(--app-accent) 60%, var(--app-muted));
}
.chat-empty-title {
  margin: 0;
  font-size: 12px;
  font-weight: 600;
  color: var(--app-text);
}
.chat-empty-hint {
  margin: 0;
  max-width: 220px;
  font-size: 11px;
  line-height: 1.7;
  color: var(--app-muted);
}
</style>
