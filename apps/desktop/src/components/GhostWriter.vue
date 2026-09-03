<script setup lang="ts">
import { onBeforeUnmount, onMounted } from 'vue'
import { aiService } from '../services/ai'
import { editorBridge } from '../services/editorBridge'

// While an IME (e.g. Chinese Pinyin) is composing, the candidate-selection
// keys (Tab/Esc) belong to the IME, not to the ghost writer. Swallowing them
// here would break Chinese input, so hand the event back to the IME.
function isComposing(e: KeyboardEvent): boolean {
  return (
    e.isComposing === true || // standard IME composition flag
    e.keyCode === 229 || // legacy IME composing state for some browsers/IMEs
    e.key === 'Process' // some IMEs report key="Process" while isComposing=false
  )
}

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
  if (isComposing(e)) return
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