<script setup lang="ts">
import { nextTick, onMounted, ref } from 'vue'
import { FilePlus2, X } from 'lucide-vue-next'
import { useFocusTrap } from '../composables/useFocusTrap'
import { useModalEscape } from '../composables/useModalEscape'
import { t } from '../i18n'
import { isBuiltinTemplate, type TemplateEntry } from '../services/noteTemplates'

const props = defineProps<{ templates: TemplateEntry[] }>()
const emit = defineEmits<{
  (e: 'select', entry: TemplateEntry): void
  (e: 'close'): void
}>()

const dialogEl = ref<HTMLElement | null>(null)
const active = ref(true)
// The dialog is opened from a sidebar button, so focus arrives from outside:
// the trap has to pull it in, or Escape (and the first helpful Tab) stays on
// the button that opened this. The container is focused rather than the first
// template so Enter does not immediately create a note the user never chose.
useFocusTrap(dialogEl, active, { initialFocus: false })

useModalEscape('template-picker', () => close())

function pick(entry: TemplateEntry): void {
  emit('select', entry)
}

function close(): void {
  emit('close')
}

onMounted(() => {
  void nextTick(() => dialogEl.value?.focus())
})
</script>

<template>
  <div
    class="dialog-overlay"
    @click.self="close"
  >
    <div
      ref="dialogEl"
      class="dialog template-dialog"
      role="dialog"
      aria-modal="true"
      aria-labelledby="template-title"
      tabindex="-1"
    >
      <div class="template-head">
        <div
          id="template-title"
          class="template-title"
        >
          <FilePlus2
            :size="14"
            :stroke-width="1.8"
          />
          <span>{{ t('template.pickTitle') }}</span>
        </div>
        <button
          class="template-close"
          :aria-label="t('common.close')"
          @click="close"
        >
          <X
            :size="15"
            :stroke-width="1.8"
          />
        </button>
      </div>

      <div class="template-list">
        <button
          v-for="entry in props.templates"
          :key="entry.path"
          class="template-option"
          @click="pick(entry)"
        >
          <span class="template-name">{{ entry.name }}</span>
          <span class="template-path">{{ isBuiltinTemplate(entry) ? t('template.builtin') : entry.path }}</span>
        </button>
        <p
          v-if="props.templates.length === 0"
          class="template-empty"
        >
          {{ t('template.empty') }}
        </p>
      </div>
    </div>
  </div>
</template>

<style scoped>
.template-dialog {
  position: fixed;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  width: min(420px, 90vw);
  max-height: 70vh;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.template-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 14px 16px 10px;
  border-bottom: 1px solid color-mix(in srgb, var(--app-border) 44%, transparent);
}
.template-title {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  font-weight: 600;
  color: var(--app-text);
}
.template-close {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  padding: 0;
  border: none;
  border-radius: var(--app-radius-sm);
  background: transparent;
  color: var(--app-muted);
  cursor: pointer;
  transition: background var(--app-motion-fast) var(--app-ease),
              color var(--app-motion-fast) var(--app-ease);
}
.template-close:hover {
  color: var(--app-text);
  background: color-mix(in srgb, var(--app-elevated) 66%, transparent);
}
.template-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 8px;
  overflow-y: auto;
  min-height: 0;
}
.template-option {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 2px;
  padding: 8px 10px;
  border: none;
  border-radius: var(--app-radius-sm);
  background: transparent;
  color: var(--app-text);
  text-align: left;
  cursor: pointer;
  transition: background var(--app-motion-fast) var(--app-ease);
}
.template-option:hover {
  background: color-mix(in srgb, var(--app-accent-soft) 70%, var(--app-elevated));
}
.template-name {
  font-size: 12.5px;
  font-weight: 600;
  letter-spacing: -0.01em;
}
.template-path {
  font-size: 10.5px;
  color: var(--app-muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 100%;
}
.template-empty {
  margin: 0;
  padding: 16px 10px;
  font-size: 12px;
  color: var(--app-muted);
}
</style>
