import { computed, type ComputedRef, type WritableComputedRef } from 'vue'
import { useAppearanceStore } from '../../../stores/appearance'
import { useSettingsStore } from '../../../stores/settings'
import type { AutosaveInterval } from '../../../stores/settings'
import { useViewStore } from '../../../stores/view'
import type { ViewMode } from '../../../stores/view'

export interface EditorSettingsModel {
  viewMode: ComputedRef<ViewMode>
  setMode: (m: ViewMode) => void
  defaultMode: ComputedRef<ViewMode>
  setDefaultMode: (m: ViewMode) => void
  /** Writable, so the section binds the select with `v-model` and the write
   *  still lands in the store rather than in a copy. */
  autosaveInterval: WritableComputedRef<AutosaveInterval>
  maxHistory: ComputedRef<number>
  setMaxHistory: (v: number) => void
  spellCheckEnabled: ComputedRef<boolean>
  softWrap: ComputedRef<boolean>
  lineNumbers: ComputedRef<boolean>
  renderTaskChecklist: ComputedRef<boolean>
  autoSyncScroll: ComputedRef<boolean>
  wordGoal: ComputedRef<number>
  autosaveOnBlur: ComputedRef<boolean>
  statusBarWords: ComputedRef<boolean>
  confirmBeforeDelete: ComputedRef<boolean>
  setSpellCheckEnabled: (on: boolean) => void
  setSoftWrap: (on: boolean) => void
  setLineNumbers: (on: boolean) => void
  setRenderTaskChecklist: (on: boolean) => void
  setAutoSyncScroll: (on: boolean) => void
  setWordGoal: (n: number) => void
  setAutosaveOnBlur: (on: boolean) => void
  setStatusBarWords: (on: boolean) => void
  setConfirmBeforeDelete: (on: boolean) => void
}

/**
 * State and commands for the Editor section.
 *
 * Three stores answer this one screen, and that is the existing structure, not
 * something this split introduced: the composed view mode is the view store's,
 * the save cadence and history depth are the settings store's, and the editor
 * behaviour switches have always lived in the appearance store beside the
 * typography they affect. What changed is only that the section component reads
 * them through here instead of importing the stores itself (§10.2).
 */
export function useEditorSettings(): EditorSettingsModel {
  const view = useViewStore()
  const settings = useSettingsStore()
  const appearance = useAppearanceStore()

  return {
    viewMode: computed(() => view.mode),
    setMode: view.setMode,
    defaultMode: computed(() => view.defaultMode),
    setDefaultMode: view.setDefaultMode,
    autosaveInterval: computed({
      get: () => settings.autosaveInterval,
      set: (v) => { settings.autosaveInterval = v },
    }),
    maxHistory: computed(() => settings.maxHistory),
    setMaxHistory: (v) => { settings.maxHistory = v },
    spellCheckEnabled: computed(() => appearance.spellCheckEnabled),
    softWrap: computed(() => appearance.softWrap),
    lineNumbers: computed(() => appearance.lineNumbers),
    renderTaskChecklist: computed(() => appearance.renderTaskChecklist),
    autoSyncScroll: computed(() => appearance.autoSyncScroll),
    wordGoal: computed(() => appearance.wordGoal),
    autosaveOnBlur: computed(() => appearance.autosaveOnBlur),
    statusBarWords: computed(() => appearance.statusBarWords),
    confirmBeforeDelete: computed(() => appearance.confirmBeforeDelete),
    setSpellCheckEnabled: appearance.setSpellCheckEnabled,
    setSoftWrap: appearance.setSoftWrap,
    setLineNumbers: appearance.setLineNumbers,
    setRenderTaskChecklist: appearance.setRenderTaskChecklist,
    setAutoSyncScroll: appearance.setAutoSyncScroll,
    setWordGoal: appearance.setWordGoal,
    setAutosaveOnBlur: appearance.setAutosaveOnBlur,
    setStatusBarWords: appearance.setStatusBarWords,
    setConfirmBeforeDelete: appearance.setConfirmBeforeDelete,
  }
}
