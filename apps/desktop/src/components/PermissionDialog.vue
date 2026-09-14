<script setup lang="ts">
import { computed, nextTick, ref } from 'vue'
import { t, getLocale } from '../i18n'
import { useFocusTrap } from '../composables/use-focus-trap'
import { useModalEscape } from '../composables/use-modal-escape'
import type { PluginMeta, PluginPermission } from '@nekowite/plugin-host'

const props = defineProps<{ meta: PluginMeta; permissions: PluginPermission[] }>()
const emit = defineEmits<{ (e: 'allow'): void; (e: 'deny'): void }>()

const active = ref(true)
const dialogEl = ref<HTMLElement | null>(null)
// Every other prompt in the app is a labelled modal with a trap and an Escape
// route; these two were the exception, so a keyboard user could not answer
// them and Tab walked out into the UI they were blocking. Focus lands on the
// container (not "Allow") so answering is a deliberate act.
useFocusTrap(dialogEl, active, { initialFocus: false })

// Escape means "no". A plugin asking for filesystem or network access must
// never be granted by the key the user pressed to make the prompt go away.
useModalEscape('plugin-permission', () => emit('deny'))

nextTick(() => dialogEl.value?.focus())

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
  <div
    class="dialog-overlay"
    @click.self="emit('deny')"
  >
    <div
      ref="dialogEl"
      class="dialog plugin-dialog"
      role="dialog"
      aria-modal="true"
      aria-labelledby="plugin-permission-title"
      tabindex="-1"
    >
      <div
        id="plugin-permission-title"
        class="plugin-title"
      >
        {{ t('plugin.permissionTitle') }}
      </div>
      <div class="plugin-body">
        {{ t('plugin.permissionBody', { name: meta.name, perms: permLabel }) }}
      </div>
      <!-- Shared action-row convention (styles/surfaces.css, .dialog-actions):
           the refusal sits leftmost — where Escape lands too — and the grant
           owns the rightmost/confirm slot. -->
      <div class="dialog-actions">
        <button
          class="btn btn-ghost"
          @click="emit('deny')"
        >
          {{ t('plugin.permissionDeny') }}
        </button>
        <button
          class="btn btn-primary"
          @click="emit('allow')"
        >
          {{ t('plugin.permissionAllow') }}
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
  /* `translate`, not `transform`: the shared arrival animates `scale`, which
     multiplies a `transform` rather than merely preserving it — see the note on
     the arrival in styles/motion.css. */
  translate: -50% -50%;
  width: min(440px, 90vw);
  padding: 18px 20px;
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
