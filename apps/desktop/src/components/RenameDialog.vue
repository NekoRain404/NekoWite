<script setup lang="ts">
import { nextTick, onMounted, ref } from 'vue'
import { validateRenameName } from '../services/renameAsset'
import { useFocusTrap } from '../composables/useFocusTrap'
import { t } from '../i18n'

const props = defineProps<{ initial: string }>()
const emit = defineEmits<{
  (e: 'confirm', name: string): void
  (e: 'cancel'): void
}>()

const name = ref(props.initial)
const error = ref<string | null>(null)
const inputEl = ref<HTMLInputElement | null>(null)
const dialogEl = ref<HTMLElement | null>(null)
const active = ref(true)
useFocusTrap(dialogEl, active, { initialFocus: false })

function check(): void {
  error.value = validateRenameName(name.value)
}

function confirm(): void {
  if (error.value) return
  emit('confirm', name.value.trim())
}

function cancel(): void {
  emit('cancel')
}

function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape') {
    e.preventDefault()
    cancel()
  } else if (e.key === 'Enter') {
    e.preventDefault()
    confirm()
  }
}

onMounted(() => {
  nextTick(() => inputEl.value?.focus())
})
</script>

<template>
  <div
    class="dialog-overlay"
    @click.self="cancel"
    @keydown="onKeydown"
  >
    <div
      ref="dialogEl"
      class="dialog rename-dialog"
      role="dialog"
      aria-modal="true"
      aria-labelledby="rename-title"
    >
      <div
        id="rename-title"
        class="rename-title"
      >
        {{ t('renameDialog.title') }}
      </div>
      <div class="rename-hint">
        {{ t('renameDialog.hint') }}
      </div>
      <input
        ref="inputEl"
        v-model="name"
        class="input"
        :class="{ 'is-invalid': error }"
        :placeholder="t('renameDialog.placeholder')"
        @input="check"
      >
      <div
        v-if="error"
        class="rename-error"
      >
        {{ error }}
      </div>
      <div class="dialog-actions">
        <button
          class="btn btn-ghost"
          @click="cancel"
        >
          {{ t('common.cancel') }}
        </button>
        <button
          class="btn btn-primary"
          :disabled="!!error"
          @click="confirm"
        >
          {{ t('common.confirm') }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.rename-dialog {
  position: fixed;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  width: min(380px, 90vw);
  padding: 16px;
}
.rename-title {
  font-weight: 600;
  margin-bottom: 6px;
  color: var(--app-text);
}
.rename-hint {
  color: var(--app-muted);
  font-size: 12px;
  margin-bottom: 12px;
}
.rename-error {
  color: var(--app-danger);
  font-size: 12px;
  margin-top: 6px;
}
.input.is-invalid {
  border-color: var(--app-danger);
}
.dialog-actions {
  margin-top: 12px;
}
</style>
