<script setup lang="ts">
import { onBeforeUnmount, onMounted } from 'vue'
import { aiService } from '../services/ai'
import { editorSessionManager } from '../features/editor/sessionManager'
import { isComposingKey } from '../services/keyGuard'
import { isAiConfigured } from '../services/aiReadiness'
import { useSettingsStore } from '../stores/settings'

/** The AI settings, or null when there is no Pinia instance (a bare unit test,
 *  a plugin). A null store means "cannot prove it is unconfigured", so the
 *  shortcut keeps working rather than silently dying. */
function aiSettings(): ReturnType<typeof useSettingsStore> | null {
  try {
    return useSettingsStore()
  } catch {
    return null
  }
}

/** Whether pressing Tab would reach a usable model. Reading this costs nothing;
 *  a request to a provider with no credential costs the user a scary toast. */
function aiUsable(): boolean {
  const s = aiSettings()
  if (!s) return true
  return isAiConfigured({
    provider: s.provider,
    baseUrl: s.baseUrl,
    apiKey: s.apiKey,
    keyConfigured: s.apiKey.trim().length > 0,
  })
}

// Only handle Tab/Esc while the focus is actually inside the editor. A
// window-wide handler would otherwise swallow Tab/Esc in dialogs or the
// settings panel while a suggestion is active.
function focusInsideEditor(): boolean {
  const view = editorSessionManager.getView()
  if (!view) return false
  const active = document.activeElement
  return !!active && view.dom.contains(active)
}

function onKeydown(e: KeyboardEvent): void {
  if (isComposingKey(e)) return
  // This listener is on `document`, in the bubble phase, so a handler closer to
  // the caret runs first. ProseMirror consumes Tab itself inside a table (move
  // to the next cell, append a row on the last one) by calling preventDefault;
  // without this check the same keypress also fired an AI completion, so one
  // Tab moved the cursor *and* started generating text.
  if (e.defaultPrevented) return
  if (!focusInsideEditor()) return
  const editor = editorSessionManager.getActiveEditor()
  if (!editor) return
  let has = false
  try {
    has = editor.hasSuggestion()
  } catch {
    has = false
  }
  if (e.key !== 'Tab' && e.key !== 'Escape') return
  if (e.key === 'Escape' && !has) return
  if (e.key === 'Escape') {
    e.preventDefault()
    aiService.reject()
    return
  }
  if (has) {
    // Second Tab accepts the live ghost text; the default has to go, or the
    // browser would also move focus to the next control as the text lands.
    e.preventDefault()
    aiService.accept()
    return
  }
  // No pending suggestion. The default is left in place so Tab keeps its
  // browser meaning and a keyboard-only user can leave the editor for the
  // toolbar, the tab bar or the side panel — swallowing it here was a keyboard
  // trap. The completion is still offered, but only when there is a model to
  // offer it: pressing Tab on an unconfigured install used to raise an
  // "AI generation failed" toast for a feature the user never asked for.
  if (aiUsable()) void aiService.triggerSuggestion()
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