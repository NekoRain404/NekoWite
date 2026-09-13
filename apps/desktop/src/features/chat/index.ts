/**
 * The chat feature's public API.
 *
 * Nothing outside this feature imports one of its files by path (§13.11): a
 * caller goes through this entry point, so the internal layout
 * (components / composables / services) can change without touching a call
 * site, and two features cannot reach into each other's internals.
 *
 * The composables are deliberately absent. Unlike the notes and settings
 * features - where a second consumer already exists inside the feature and the
 * panel's sections are wired by the panel - the chat panel is this feature's
 * only caller, so its state, context and commands stay internal until
 * something else genuinely needs them (§13.11: shared code needs two real
 * callers).
 */

export { default as ChatPanel } from './components/ChatPanel.vue'

export type { ChatAttachment, PanelMessage } from './types'
