<script setup lang="ts">
import { onBeforeUnmount, ref } from 'vue'
import { onNotify } from '../services/errors'

interface ToastMsg {
  id: number
  message: string
}

let seq = 0
const toasts = ref<ToastMsg[]>([])

function dismiss(id: number): void {
  toasts.value = toasts.value.filter((t) => t.id !== id)
}

function show(message: string): void {
  const id = ++seq
  toasts.value.push({ id, message })
  window.setTimeout(() => dismiss(id), 3000)
}

const off = onNotify(show)

onBeforeUnmount(() => off())
</script>

<template>
  <div class="toast-stack">
    <TransitionGroup name="toast">
      <div
        v-for="t in toasts"
        :key="t.id"
        class="toast"
        role="alert"
        @click="dismiss(t.id)"
      >
        {{ t.message }}
      </div>
    </TransitionGroup>
  </div>
</template>

<style scoped>
.toast-stack {
  position: fixed;
  top: 40px;
  right: 12px;
  z-index: 2000;
  display: flex;
  flex-direction: column;
  gap: 8px;
  max-width: 320px;
}
.toast {
  background: #fff3f0;
  color: #b3261e;
  border: 1px solid #f0c4bf;
  border-radius: 6px;
  padding: 8px 12px;
  font-size: 13px;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.12);
  cursor: pointer;
  word-break: break-word;
}
.toast-enter-active,
.toast-leave-active {
  transition: opacity 0.2s, transform 0.2s;
}
.toast-enter-from,
.toast-leave-to {
  opacity: 0;
  transform: translateY(-6px);
}
</style>
