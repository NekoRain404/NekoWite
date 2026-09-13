<script setup lang="ts">
/**
 * One turn: the bubble (images, storage notice, token count, text) and, for an
 * answer, the actions that go with it - stop while it streams, insert into the
 * document or copy once it is done.
 *
 * The row renders what it is handed and emits what was clicked: whether the
 * document can take an insert, and what inserting or copying means, belong to
 * the panel's commands (§10.2). `message.streaming` is what a row shows, never
 * what it decides - the request that fills the text is not this component's.
 */
import { Copy, FilePlus2, Square } from 'lucide-vue-next'
import { t } from '../../../i18n'
import type { PanelMessage } from '../types'

defineProps<{
  message: PanelMessage
  /** A document is open, so "insert into the document" can act. */
  canInsert: boolean
}>()

defineEmits<{
  stop: []
  insert: []
  copy: []
}>()
</script>

<template>
  <div
    class="chat-row"
    :class="message.role"
  >
    <div class="chat-bubble">
      <div
        v-if="message.images && message.images.length"
        class="chat-msg-images"
      >
        <img
          v-for="img in message.images"
          :key="img.id"
          :src="img.dataUrl"
          :alt="img.name"
          draggable="false"
        >
      </div>
      <div
        v-if="message.imageNotice"
        class="chat-image-notice"
      >
        {{ message.imageNotice }}
      </div>
      <div
        v-if="message.usageTotal"
        class="chat-usage"
      >
        {{ t('chat.usage', { count: message.usageTotal }) }}
      </div>
      <div class="chat-content">
        {{ message.content }}
        <span
          v-if="message.streaming"
          class="chat-caret"
          aria-hidden="true"
        />
      </div>
    </div>
    <div
      v-if="message.role === 'assistant'"
      class="chat-actions"
    >
      <span
        v-if="message.interrupted"
        class="chat-interrupted"
        :title="t('chat.interruptedHint')"
      >{{ t('chat.interrupted') }}</span>
      <button
        v-if="message.streaming"
        class="chat-action chat-stop"
        :title="t('chat.stop')"
        @click="$emit('stop')"
      >
        <Square
          :size="12"
          :stroke-width="1.8"
        />
        <span>{{ t('chat.stop') }}</span>
      </button>
      <template v-else>
        <button
          class="chat-action"
          :title="t('chat.insertToDoc')"
          :disabled="!canInsert"
          @click="$emit('insert')"
        >
          <FilePlus2
            :size="12"
            :stroke-width="1.8"
          />
          <span>{{ t('chat.insertDoc') }}</span>
        </button>
        <button
          class="chat-action"
          :title="t('chat.copyContent')"
          @click="$emit('copy')"
        >
          <Copy
            :size="12"
            :stroke-width="1.8"
          />
          <span>{{ t('chat.copy') }}</span>
        </button>
      </template>
    </div>
  </div>
</template>

<style scoped>
.chat-row {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 4px;
}
.chat-row.user {
  align-items: flex-end;
}
.chat-bubble {
  max-width: 100%;
  padding: 8px 10px;
  border-radius: var(--app-radius-lg);
  background: var(--app-elevated);
  color: var(--app-text);
  font-size: 12px;
  line-height: 1.7;
  word-break: break-word;
  white-space: pre-wrap;
}
.chat-row.user .chat-bubble {
  background: color-mix(in srgb, var(--app-accent-soft) 82%, var(--app-elevated));
}
.chat-content {
  margin: 0;
}
.chat-caret {
  display: inline-block;
  width: 2px;
  height: 1em;
  margin-left: 2px;
  vertical-align: text-bottom;
  background: var(--app-accent);
  animation: chat-caret-blink var(--app-motion-blink) steps(2, start) infinite;
}
@keyframes chat-caret-blink {
  0%, 50% { opacity: 1; }
  50.01%, 100% { opacity: 0; }
}
.chat-msg-images {
  display: flex;
  gap: 4px;
  flex-wrap: wrap;
  margin-bottom: 4px;
}
.chat-msg-images img {
  width: 48px;
  height: 48px;
  object-fit: cover;
  border-radius: var(--app-radius-sm);
  border: 1px solid color-mix(in srgb, var(--app-border) 70%, transparent);
}
.chat-actions {
  display: flex;
  align-items: center;
  gap: 2px;
}
.chat-image-notice {
  margin-bottom: 4px;
  font-size: 11px;
  color: var(--app-text-muted);
  font-style: italic;
}

.chat-interrupted {
  display: inline-flex;
  align-items: center;
  height: 20px;
  margin-right: 2px;
  padding: 0 7px;
  border: 1px dashed color-mix(in srgb, var(--app-muted) 55%, transparent);
  border-radius: 999px;
  background: color-mix(in srgb, var(--app-elevated) 55%, transparent);
  color: var(--app-muted);
  font-size: 10.5px;
  font-weight: 550;
  letter-spacing: -0.01em;
}
.chat-action {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 24px;
  padding: 0 8px;
  border: none;
  border-radius: var(--app-radius-sm);
  background: transparent;
  color: var(--app-muted);
  font-family: var(--app-font);
  font-size: 10.5px;
  font-weight: 550;
  letter-spacing: -0.01em;
  cursor: pointer;
  transition: background var(--app-motion-fast) var(--app-ease),
              color var(--app-motion-fast) var(--app-ease);
}
.chat-action:hover:not(:disabled) {
  color: var(--app-text);
  background: color-mix(in srgb, var(--app-elevated) 66%, transparent);
}
.chat-action:disabled {
  cursor: default;
  opacity: 0.45;
}
.chat-action:focus-visible {
  outline: 2px solid var(--app-accent);
  outline-offset: 1px;
}
.chat-stop {
  color: var(--app-danger);
}
.chat-stop:hover {
  color: var(--app-danger);
  background: color-mix(in srgb, var(--app-danger) 10%, transparent);
}
.chat-usage {
  margin-top: 2px;
  font-size: 10px;
  color: var(--app-muted);
  font-variant-numeric: tabular-nums;
}
</style>
