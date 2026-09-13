/**
 * The settings feature's public API.
 *
 * Nothing outside this feature imports one of its files by path (§13.11): a
 * caller goes through this entry point, so the internal layout
 * (components / composables / types) can change without touching a call site,
 * and two features cannot reach into each other's internals.
 *
 * The section components (`SettingsNavigation`, `GeneralSettings`,
 * `AppearanceSettings`, `EditorSettings`, `ExportSettings`, `AiSettings`,
 * `AiPermissionSettings`, `PluginSettings`) are deliberately absent: they are
 * parts of `SettingsPanel`, not an API, and their props are wired by the panel
 * that composes them. The composables are here because they are where this
 * feature's state, queries and commands actually live — the panel and its
 * sections are only their first callers.
 */

export { default as SettingsPanel } from './components/SettingsPanel.vue'

export { useSettingsDialog } from './composables/useSettingsDialog'
export type { SettingsDialogModel, UseSettingsDialogOptions } from './composables/useSettingsDialog'

export { useGeneralSettings } from './composables/useGeneralSettings'
export type { GeneralSettingsModel } from './composables/useGeneralSettings'

export { useAppearanceSettings } from './composables/useAppearanceSettings'
export type { AppearanceSettingsModel } from './composables/useAppearanceSettings'

export { useEditorSettings } from './composables/useEditorSettings'
export type { EditorSettingsModel } from './composables/useEditorSettings'

export { useExportSettings } from './composables/useExportSettings'
export type { ExportSettingsModel } from './composables/useExportSettings'

export { useAiSettings } from './composables/useAiSettings'
export type { AiSettingsModel } from './composables/useAiSettings'

export { useAiPermissionSettings } from './composables/useAiPermissionSettings'
export type { AiPermissionSettingsModel } from './composables/useAiPermissionSettings'

export { usePluginSettings } from './composables/usePluginSettings'
export type { PluginSettingsModel } from './composables/usePluginSettings'

export type { SettingsSectionId } from './types'
