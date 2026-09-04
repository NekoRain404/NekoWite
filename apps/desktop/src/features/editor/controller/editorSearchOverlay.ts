import { ref, type Ref } from 'vue'
import type { NekoEditor } from '@nekowite/editor-core'
import {
  applySpellReplacement,
  cancelOverlayRefresh,
  getView,
  scheduleOverlayRefresh,
  setSpellEnabled,
  suggestionsFromAttr,
} from '../../../services/renderSearch'
import type { DocumentSession } from '../model/documentSession'

export interface EditorSearchOverlayDeps {
  session: DocumentSession
  getEditor: () => NekoEditor | null
}

export interface SpellPopup {
  x: number
  y: number
  from: number
  to: number
  word: string
  suggestions: string[]
}

export interface EditorSearchOverlay {
  searchOpen: Ref<boolean>
  spellPopup: Ref<SpellPopup | null>
  /** Coalesced find/spell refresh (used by the change listener / content swap). */
  scheduleRefresh(): void
  /** Drop a scheduled overlay refresh and any pending rAF scan. */
  cancelRefresh(): void
  /** Apply the reactive spell-check toggle to the live overlay. */
  syncSpellEnabled(enabled: boolean): void
  /** Register the overlay change listener; returns an unsubscribe. */
  attachChangeListener(): () => void
  closeSearch(): void
  openSpellPopup(span: HTMLElement, clientX: number, clientY: number): void
  handleSpellSuggestion(text: string): void
}

/**
 * Find/replace and spell overlays for the rendered pane.
 *
 * The heavy lifting (model scan, decoration set, match locate) lives in the
 * `renderSearch` service; this controller owns the pane-local reactive state
 * (panel visibility, spell popup) and the coalescing/teardown surface so the
 * component no longer schedules rAF/debounce work itself.
 */
export function createEditorSearchOverlay(deps: EditorSearchOverlayDeps): EditorSearchOverlay {
  const searchOpen = ref(false)
  const spellPopup = ref<SpellPopup | null>(null)

  function scheduleRefresh(): void {
    scheduleOverlayRefresh()
  }

  function cancelRefresh(): void {
    cancelOverlayRefresh()
  }

  function syncSpellEnabled(enabled: boolean): void {
    setSpellEnabled(enabled)
  }

  function attachChangeListener(): () => void {
    const editor = deps.getEditor()
    if (!editor) return () => {}
    // Keep the find/spell overlays in sync with model changes. Coalesced in
    // renderSearch (rAF + idle debounce) so a typing burst does not re-scan the
    // whole document on every keystroke.
    return editor.onContentChange(() => {
      if (deps.session.applyingExternal) return
      scheduleOverlayRefresh()
    })
  }

  function closeSearch(): void {
    searchOpen.value = false
    spellPopup.value = null
  }

  function openSpellPopup(span: HTMLElement, clientX: number, clientY: number): void {
    const from = Number(span.dataset.from ?? NaN)
    const to = Number(span.dataset.to ?? NaN)
    const word = span.dataset.word ?? ''
    const suggestions = suggestionsFromAttr(span.dataset.suggestions ?? null)
    if (!Number.isFinite(from) || !Number.isFinite(to) || !word) return
    spellPopup.value = { x: clientX, y: clientY, from, to, word, suggestions }
  }

  function handleSpellSuggestion(text: string): void {
    const pop = spellPopup.value
    if (!pop) return
    const view = getView()
    if (view) applySpellReplacement(view, pop.from, pop.to, text)
    spellPopup.value = null
  }

  return {
    searchOpen,
    spellPopup,
    scheduleRefresh,
    cancelRefresh,
    syncSpellEnabled,
    attachChangeListener,
    closeSearch,
    openSpellPopup,
    handleSpellSuggestion,
  }
}
