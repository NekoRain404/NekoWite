<script setup lang="ts">
import { nextTick, onMounted, ref } from 'vue'
import { validateRenameName } from '../services/renameAsset'

const props = defineProps<{ initial: string }>()
const emit = defineEmits<{
  (e: 'confirm', name: string): void
  (e: 'cancel'): void
}>()

const name = ref(props.initial)
const error = ref<string | null>(null)
const inputEl = ref<HTMLInputElement | null>(null)

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
    <div class="dialog rename-dialog">
      <div class="rename-title">
        重命名资源
      </div>
      <div class="rename-hint">
        粘贴的图片将存入此笔记的专属资源文件夹，请为其命名。
      </div>
      <input
        ref="inputEl"
        v-model="name"
        class="input"
        :class="{ 'is-invalid': error }"
        placeholder="文件名"
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
          取消
        </button>
        <button
          class="btn btn-primary"
          :disabled="!!error"
          @click="confirm"
        >
          确认
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
