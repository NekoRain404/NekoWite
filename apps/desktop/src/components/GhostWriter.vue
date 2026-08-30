<script setup lang="ts">
import { onBeforeUnmount, onMounted } from 'vue'
import { aiService } from '../services/ai'
import { editorBridge } from '../services/editorBridge'

function onKeydown(e: KeyboardEvent): void {
  const editor = editorBridge.getEditor()
  if (!editor) return
  let has = false
  try {
    has = editor.hasSuggestion()
  } catch {
    has = false
  }
  if (!has) return
  if (e.key === 'Tab') {
    e.preventDefault()
    aiService.accept()
  } else if (e.key === 'Escape') {
    e.preventDefault()
    aiService.reject()
  }
}

onMounted(() => {
  document.addEventListener('keydown', onKeydown)
})
onBeforeUnmount(() => {
  document.removeEventListener('keydown', onKeydown)
})
</script>

<template>
  <div
    class="ghost-writer"
    aria-hidden="true"
  />
</template>
