<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref } from 'vue'
import { useFocusTrap } from '../composables/useFocusTrap'
import { modalStack } from '../services/modalStack'
import { t } from '../i18n'
import type { PendingAiWrite } from '../stores/aiPermission'
import type { AiWriteKind } from '../services/aiPermissions'

/**
 * The "the AI wants to change your document" prompt.
 *
 * Rendered by the shell whenever a write is waiting for an answer. The AI's
 * own summary is shown verbatim so the user judges the actual action rather
 * than a generic warning, and "allow for this session" is a distinct button
 * rather than a checkbox that is easy to accept by accident.
 */
const props = defineProps<{ pending: PendingAiWrite }>()
const emit = defineEmits<{
  (e: 'respond', approved: boolean, remember: boolean): void
}>()

const active = ref(true)
const dialogEl = ref<HTMLElement | null>(null)
// `initialFocus: false`: this is a permission gate, and focusing a control that
// approves would let a stray Enter (often the tail of what the user was typing
// when the prompt appeared) approve a write they never read — the affirmative
// used to be the first button in the row. Focus goes to the container so every
// answer is an explicit choice, whichever slot the button sits in.
useFocusTrap(dialogEl, active, { initialFocus: false })

const modalToken = modalStack.claimModal('ai-write-dialog')

nextTick(() => dialogEl.value?.focus())

onBeforeUnmount(() => {
  modalStack.releaseModal(modalToken)
})

function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape') {
    if (!modalStack.isTopModal(modalToken)) return
    e.preventDefault()
    // Escape means "no": dismissing a permission prompt must never be read as
    // approval.
    emit('respond', false, false)
  }
}

/** Label for the kind of write being asked about. A table rather than a
 *  two-branch ternary: a new kind used to fall through to “insert”, which
 *  understated what was about to happen to the document. */
const KIND_KEYS: Record<AiWriteKind, string> = {
  insert: 'aiperm.kind.insert',
  'replace-selection': 'aiperm.kind.replaceSelection',
  'replace-document': 'aiperm.kind.replaceDocument',
}

function kindLabel(): string {
  return t(KIND_KEYS[props.pending.request.kind])
}
</script>

<template>
  <div
    class="dialog-overlay"
    @keydown="onKeydown"
  >
    <div
      ref="dialogEl"
      class="dialog ai-write-dialog"
      role="dialog"
      aria-modal="true"
      aria-labelledby="ai-write-title"
      tabindex="-1"
    >
      <div
        id="ai-write-title"
        class="ai-write-title"
      >
        {{ t('aiperm.title') }}
      </div>
      <div class="ai-write-body">
        <span class="ai-write-kind">{{ kindLabel() }}</span>
        <span class="ai-write-summary">{{ pending.request.summary }}</span>
      </div>
      <div
        v-if="pending.request.target"
        class="ai-write-target"
      >
        {{ pending.request.target }}
      </div>
      <!-- Shared action-row convention (styles/components.css, .dialog-actions):
           refusals and neutral choices on the left, the affirmative in the
           rightmost/confirm slot. Deny is also what Escape means, so the key
           that dismisses lands on the same answer as the leftmost button. -->
      <div class="dialog-actions">
        <button
          class="btn btn-ghost"
          @click="emit('respond', false, false)"
        >
          {{ t('aiperm.deny') }}
        </button>
        <button
          class="btn btn-secondary"
          @click="emit('respond', true, true)"
        >
          {{ t('aiperm.allowSession') }}
        </button>
        <button
          class="btn btn-primary"
          @click="emit('respond', true, false)"
        >
          {{ t('aiperm.allowOnce') }}
        </button>
      </div>
      <div class="ai-write-note">
        {{ t('aiperm.note') }}
      </div>
    </div>
  </div>
</template>

<style scoped>
.ai-write-dialog {
  position: fixed;
  bottom: 32px;
  left: 50%;
  transform: translateX(-50%);
  width: min(460px, 90vw);
  padding: 14px 16px;
  font-size: 13px;
  color: var(--app-text);
}
.ai-write-title {
  font-weight: 600;
  margin-bottom: 6px;
  color: var(--app-text);
}
.ai-write-body {
  display: flex;
  gap: 6px;
  align-items: baseline;
  flex-wrap: wrap;
}
.ai-write-kind {
  flex: none;
  padding: 1px 6px;
  border-radius: 3px;
  background: color-mix(in srgb, var(--app-accent) 18%, transparent);
  color: var(--app-text);
  font-size: 12px;
}
.ai-write-summary {
  word-break: break-word;
}
.ai-write-target {
  margin-top: 6px;
  font-family: var(--app-mono-font, ui-monospace, monospace);
  font-size: 12px;
  color: var(--app-muted);
  word-break: break-all;
}
.dialog-actions {
  margin-top: 10px;
}
.ai-write-note {
  margin-top: 8px;
  color: var(--app-muted);
  font-size: 12px;
}
</style>
