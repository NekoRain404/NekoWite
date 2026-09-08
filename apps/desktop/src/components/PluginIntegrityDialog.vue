<script setup lang="ts">
import { t } from '../i18n'
import type { PluginMeta } from '@nekowite/plugin-host'

const props = defineProps<{
  meta: PluginMeta
  expectedDigest: string
  actualDigest: string
}>()
const emit = defineEmits<{ (e: 'allow'): void; (e: 'deny'): void }>()
</script>

<template>
  <div class="dialog-overlay">
    <div class="dialog plugin-dialog">
      <div class="plugin-title">
        {{ t('plugin.integrityTitle') }}
      </div>
      <div class="plugin-body">
        {{ t('plugin.integrityBody', { name: props.meta.name }) }}
      </div>
      <div class="plugin-meta">
        {{ t('plugin.integrityDigest', { expected: props.expectedDigest, actual: props.actualDigest }) }}
      </div>
      <div class="dialog-actions">
        <button
          class="btn btn-primary"
          @click="emit('allow')"
        >
          {{ t('plugin.integrityAllow') }}
        </button>
        <button
          class="btn btn-ghost"
          @click="emit('deny')"
        >
          {{ t('plugin.integrityDeny') }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.plugin-dialog {
  position: fixed;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  width: min(440px, 90vw);
  padding: 18px 20px;
  border-radius: var(--app-radius-xl);
  box-shadow: var(--app-shadow-dialog);
  font-size: 13px;
  color: var(--app-text);
}
.plugin-title {
  font-weight: 600;
  margin-bottom: 8px;
  color: var(--app-text);
}
.plugin-body {
  line-height: 1.7;
  color: var(--app-text);
  white-space: pre-wrap;
  word-break: break-word;
}
.plugin-meta {
  margin-top: 10px;
  font-family: var(--app-mono-font);
  font-size: 11px;
  color: var(--app-muted);
  word-break: break-all;
}
.dialog-actions {
  margin-top: 14px;
}
</style>
