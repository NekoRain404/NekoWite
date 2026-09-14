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

export { useSettingsDialog } from './composables/use-settings-dialog'
export type { SettingsDialogModel, UseSettingsDialogOptions } from './composables/use-settings-dialog'

export { useGeneralSettings } from './composables/use-general-settings'
export type { GeneralSettingsModel } from './composables/use-general-settings'

export { useAppearanceSettings } from './composables/use-appearance-settings'
export type { AppearanceSettingsModel } from './composables/use-appearance-settings'

export { useEditorSettings } from './composables/use-editor-settings'
export type { EditorSettingsModel } from './composables/use-editor-settings'

export { useExportSettings } from './composables/use-export-settings'
export type { ExportSettingsModel } from './composables/use-export-settings'

export { useAiSettings } from './composables/use-ai-settings'
export type { AiSettingsModel } from './composables/use-ai-settings'

export { useAiPermissionSettings } from './composables/use-ai-permission-settings'
export type { AiPermissionSettingsModel } from './composables/use-ai-permission-settings'

export { usePluginSettings } from './composables/use-plugin-settings'
export type { PluginSettingsModel } from './composables/use-plugin-settings'

export type { SettingsSectionId } from './types'
