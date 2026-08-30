<script setup lang="ts">
import { onBeforeUnmount, onMounted } from 'vue'
import { aiService } from '../services/ai'
import { editorBridge } from '../services/editorBridge'

// Only handle Tab/Esc while the focus is actually inside the editor. A
// window-wide handler would otherwise swallow Tab/Esc in dialogs or the
// settings panel while a suggestion is active.
function focusInsideEditor(): boolean {
  const view = editorBridge.getView()
  if (!view) return false
  const active = document.activeElement
  return !!active && view.dom.contains(active)
}

function onKeydown(e: KeyboardEvent): void {
  if (!focusInsideEditor()) return
  const editor = editorBridge.getEditor()
  if (!editor) return
  let has = false
  try {
    has = editor.hasSuggestion()
  } catch {
    has = false
  }
  if (e.key !== 'Tab' && e.key !== 'Escape') return
  if (e.key === 'Escape' && !has) return
  e.preventDefault()
  if (e.key === 'Tab') {
    if (has) {
      // Second Tab accepts the live ghost text.
      aiService.accept()
    } else {
      // First Tab with no pending suggestion triggers a new completion.
      void aiService.triggerSuggestion()
    }
  } else {
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