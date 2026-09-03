<script setup lang="ts">
import { useTabsStore } from '../stores/tabs'
import { t } from '../i18n'

const props = defineProps<{ tabId: string; path: string }>()
const emit = defineEmits<{ (e: 'close'): void }>()

const tabs = useTabsStore()

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
  <div class="dialog-overlay">
    <div class="dialog conflict-dialog">
      <div class="conflict-title">
        {{ t('conflict.title') }}
      </div>
      <div class="conflict-body">
        <span class="conflict-path">
          {{ path }}
        </span>
        {{ t('conflict.body', { path: '' }) }}
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
