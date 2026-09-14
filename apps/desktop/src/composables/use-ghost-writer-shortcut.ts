import { onBeforeUnmount, onMounted } from 'vue'
import { aiService } from '../services/ai'
import { editorSessionManager } from '../features/editor/session-manager'
import { isComposingKey } from '../services/key-guard'
import { isAiConfigured } from '../services/ai-readiness'
import { useSettingsStore } from '../stores/settings'
import { useAiPermissionStore } from '../stores/ai-permission'
import { decideAiWrite } from '../services/ai-permissions'

/**
 * The Tab/Escape shortcut around the ghost writer's suggestion.
 *
 * This is the shortcut's state, query and command in one place (§13.4): the two
 * store reads are its business (is there a model to ask, do the user's AI
 * permissions allow the write), the editor session tells it whether a
 * suggestion is live and focused, and `aiService` performs the three commands.
 * §10.2 keeps that out of `components`, so the marker component that mounts the
 * shortcut composes this composable instead of reaching into the stores.
 *
 * The listeners exist for exactly as long as the mounting component is alive.
 */

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

/** Whether the user's AI permission settings leave anything to offer. The
 *  suggestion only exists to be accepted into the document, and asking for one
 *  also sends the text around the cursor to the provider: with AI switched off,
 *  or writes forbidden outright, Tab keeps its browser meaning and nothing is
 *  requested. Same quiet treatment as an unconfigured install, because a toast
 *  on every Tab press explains a setting the user chose deliberately. */
function aiPermitted(): boolean {
  try {
    const permissions = useAiPermissionStore()
    if (!permissions.enabled) return false
    return decideAiWrite(permissions.state, { kind: 'insert', summary: '' }) !== 'deny'
  } catch {
    return true
  }
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

/** Whether a suggestion is on screen right now. `hasSuggestion` is a plugin
 *  read and must never take the shortcut handler down with it. */
function hasLiveSuggestion(): boolean {
  try {
    return editorSessionManager.getActiveEditor()?.hasSuggestion() ?? false
  } catch {
    return false
  }
}

export function useGhostWriterShortcut(): void {
  /**
   * Escape, handled in the CAPTURE phase.
   *
   * The bubble-phase handler below never saw a real Escape press. Measured on the
   * packaged build: the editor's own keymap eats Escape first (ProseMirror's base
   * keymap binds it to selectParentNode) and calls preventDefault, and the
   * handler deliberately ignores keys that were already handled - so "Escape
   * discards the suggestion" did nothing at all, and the only ways out of ghost
   * text were typing over it or accepting it. Capture runs before the editor's
   * handlers, and only when a suggestion is actually on screen, so Escape keeps
   * every other meaning it has in the app.
   */
  function onKeydownCapture(e: KeyboardEvent): void {
    if (e.key !== 'Escape') return
    if (isComposingKey(e)) return
    if (!focusInsideEditor()) return
    if (!hasLiveSuggestion()) return
    // The suggestion is the newest transient thing on screen, and the user just
    // asked for it to go away; the editor may still see the key (we do not stop
    // propagation) but the text is discarded either way.
    e.preventDefault()
    aiService.reject()
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
    if (!editorSessionManager.getActiveEditor()) return
    const has = hasLiveSuggestion()
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
    if (aiUsable() && aiPermitted()) void aiService.triggerSuggestion()
  }

  onMounted(() => {
    document.addEventListener('keydown', onKeydown)
    document.addEventListener('keydown', onKeydownCapture, true)
  })
  onBeforeUnmount(() => {
    document.removeEventListener('keydown', onKeydown)
    document.removeEventListener('keydown', onKeydownCapture, true)
  })
}
