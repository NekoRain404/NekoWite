<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref } from 'vue'
import { useTabsStore } from '../stores/tabs'
import { useFocusTrap } from '../composables/useFocusTrap'
import { modalStack } from '../services/modalStack'
import { t } from '../i18n'

const props = defineProps<{ tabId: string; path: string }>()
const emit = defineEmits<{ (e: 'close'): void }>()

const tabs = useTabsStore()

const active = ref(true)
const dialogEl = ref<HTMLElement | null>(null)
// `initialFocus: false`: the first focusable control in this dialog is "Use
// disk (discard local)", and focusing it made the prompt appear with the
// destructive action already armed — a stray Enter discarded the user's
// unsaved edits. Focus goes to the container, so every answer (including the
// safe ones) is a deliberate move.
useFocusTrap(dialogEl, active, { initialFocus: false })

const modalToken = modalStack.claimModal('conflict-dialog')

nextTick(() => dialogEl.value?.focus())

onBeforeUnmount(() => {
  modalStack.releaseModal(modalToken)
})

function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape') {
    if (!modalStack.isTopModal(modalToken)) return
    e.preventDefault()
    emit('close')
  }
}

async function reloadFromDisk(): Promise<void> {
  await tabs.reloadFromDisk(props.tabId)
  emit('close')
}

function keepLocal(): void {
  emit('close')
}

function later(): void {
  emit('close')
}
</script>

<template>
  <div
    class="dialog-overlay"
    @keydown="onKeydown"
  >
    <div
      ref="dialogEl"
      class="dialog conflict-dialog"
      role="dialog"
      aria-modal="true"
      aria-labelledby="conflict-title"
      tabindex="-1"
    >
      <div
        id="conflict-title"
        class="conflict-title"
      >
        {{ t('conflict.title') }}
      </div>
      <div class="conflict-body">
        <!-- Split around the path on purpose: the path is its own emphasised
             node, and interpolating {path} here produced a sentence with a hole
             in it ("Disk content of  changed") because the placeholder was
             filled with an empty string. -->
        {{ t('conflict.bodyPrefix') }}
        <span class="conflict-path">
          {{ path }}
        </span>
        {{ t('conflict.bodySuffix') }}
      </div>
      <div class="dialog-actions">
        <button
          class="btn btn-primary"
          @click="reloadFromDisk"
        >
          {{ t('conflict.reloadDisk') }}
        </button>
        <button
          class="btn btn-secondary"
          @click="keepLocal"
        >
          {{ t('conflict.keepLocal') }}
        </button>
        <button
          class="btn btn-ghost"
          @click="later"
        >
          {{ t('conflict.later') }}
        </button>
      </div>
      <div class="conflict-note">
        {{ t('conflict.note') }}
      </div>
    </div>
  </div>
</template>

<style scoped>
.conflict-dialog {
  position: fixed;
  bottom: 32px;
  left: 50%;
  transform: translateX(-50%);
  width: min(440px, 90vw);
  padding: 14px 16px;
  border-radius: var(--app-radius-xl);
  box-shadow: var(--app-shadow-dialog);
  font-size: 13px;
  color: var(--app-text);
}
.conflict-title {
  font-weight: 600;
  margin-bottom: 6px;
  color: var(--app-text);
}
.conflict-path {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  background: var(--app-panel);
  padding: 1px 4px;
  border-radius: 3px;
  word-break: break-all;
}
.dialog-actions {
  margin-top: 10px;
}
.conflict-note {
  margin-top: 8px;
  color: var(--app-muted);
  font-size: 12px;
}
</style>
