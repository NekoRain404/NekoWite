<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { validateRenameName } from '../services/renameAsset'
import { useFocusTrap } from '../composables/useFocusTrap'
import { isComposingKey } from '../services/keyGuard'
import { modalStack } from '../services/modalStack'
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

// Only the dialog the user is looking at may answer Escape, or one press
// closes this prompt together with whatever is stacked on top of it.
const modalToken = modalStack.claimModal('rename-dialog')

function onKeydown(e: KeyboardEvent): void {
  // Enter/Escape belong to the IME while a candidate list is open: Enter picks
  // the candidate (it must not commit the raw pinyin as the new name) and
  // Escape dismisses the list (it must not throw the typed name away).
  if (isComposingKey(e)) return
  if (e.key === 'Escape') {
    if (!modalStack.isTopModal(modalToken)) return
    e.preventDefault()
    cancel()
  } else if (e.key === 'Enter') {
    e.preventDefault()
    confirm()
  }
}

onBeforeUnmount(() => {
  modalStack.releaseModal(modalToken)
})

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
  /* Centred with `translate`, not `transform: translate(...)`. The shared
     arrival animates `scale`, and a `transform` is multiplied by it rather than
     merely preserved — so centring written there is scaled too, and the dialog
     would enter two per cent of its own width off-centre and slide home. The
     `translate` property sits outside the scale in the chain and is measured
     from the box, so it holds the dialog still while it grows. */
  translate: -50% -50%;
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
