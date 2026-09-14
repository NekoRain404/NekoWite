<script setup lang="ts">
import { nextTick, ref } from 'vue'
import { t } from '../i18n'
import { useFocusTrap } from '../composables/useFocusTrap'
import { useModalEscape } from '../composables/useModalEscape'
import type { PluginMeta } from '@nekowite/plugin-host'

const props = defineProps<{
  meta: PluginMeta
  expectedDigest: string
  actualDigest: string
}>()
const emit = defineEmits<{ (e: 'allow'): void; (e: 'deny'): void }>()

const active = ref(true)
const dialogEl = ref<HTMLElement | null>(null)
useFocusTrap(dialogEl, active, { initialFocus: false })

// A digest mismatch is the one prompt where "make it go away" must never be
// read as consent, so Escape is an explicit denial.
useModalEscape('plugin-integrity', () => emit('deny'))

nextTick(() => dialogEl.value?.focus())
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
      aria-labelledby="plugin-integrity-title"
      tabindex="-1"
    >
      <div
        id="plugin-integrity-title"
        class="plugin-title"
      >
        {{ t('plugin.integrityTitle') }}
      </div>
      <div class="plugin-body">
        {{ t('plugin.integrityBody', { name: props.meta.name }) }}
      </div>
      <div class="plugin-meta">
        {{ t('plugin.integrityDigest', { expected: props.expectedDigest, actual: props.actualDigest }) }}
      </div>
      <!-- Shared action-row convention (styles/components.css, .dialog-actions):
           refusing a mismatched digest is the safe answer and Escape's answer,
           so it sits leftmost; re-approving owns the confirm slot. -->
      <div class="dialog-actions">
        <button
          class="btn btn-ghost"
          @click="emit('deny')"
        >
          {{ t('plugin.integrityDeny') }}
        </button>
        <button
          class="btn btn-primary"
          @click="emit('allow')"
        >
          {{ t('plugin.integrityAllow') }}
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
