<script setup lang="ts">
import { computed } from 'vue'
import { t, getLocale } from '../i18n'
import type { PluginMeta, PluginPermission } from '@nekowite/plugin-host'

const props = defineProps<{ meta: PluginMeta; permissions: PluginPermission[] }>()
const emit = defineEmits<{ (e: 'allow'): void; (e: 'deny'): void }>()

const LABEL_KEYS: Record<PluginPermission, string> = {
  ai: 'plugin.permissionAi',
  fs: 'plugin.permissionFs',
  network: 'plugin.permissionNetwork',
  clipboard: 'plugin.permissionClipboard',
}

const permLabel = computed(() => {
  const sep = getLocale() === 'zh' ? '、' : ', '
  return props.permissions.map((p) => t(LABEL_KEYS[p])).join(sep)
})
</script>

<template>
  <div class="dialog-overlay">
    <div class="dialog plugin-dialog">
      <div class="plugin-title">
        {{ t('plugin.permissionTitle') }}
      </div>
      <div class="plugin-body">
        {{ t('plugin.permissionBody', { name: meta.name, perms: permLabel }) }}
      </div>
      <div class="dialog-actions">
        <button
          class="btn btn-primary"
          @click="emit('allow')"
        >
          {{ t('plugin.permissionAllow') }}
        </button>
        <button
          class="btn btn-ghost"
          @click="emit('deny')"
        >
          {{ t('plugin.permissionDeny') }}
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
.dialog-actions {
  margin-top: 14px;
}
</style>
