/**
 * The settings store — and the compatibility surface for everything that used
 * to be declared beside it.
 *
 * `useSettingsStore` is still one store with one id, because that is what all
 * twenty-eight files importing this path call, and a split that made each
 * subject its own store would have edited every one of them to no one's
 * benefit. What changed is where the
 * declarations live: each subject now has a slice under `stores/` that owns it
 * end to end —
 *
 *   settings-ai.ts      provider, endpoints, credential, request shape
 *   settings-agent.ts   which panel the right rail shows (agent vs chat)
 *   settings-chat.ts    the note-context budget, the prompt shelf
 *   settings-editor.ts  autosave interval, undo history
 *   settings-export.ts  frontmatter, page size, orientation, margin,
 *                       image format and quality
 *   settings-persist.ts the storage codec the five share (no keys of its own)
 *   provider-urls.ts    the per-provider endpoint maps, extracted earlier
 *
 * — so the next setting is added to the slice that owns its subject instead of
 * to the one file every round was reading. The slices do not import each other,
 * and none of them imports this one.
 *
 * This file re-exports what it used to declare, which is the programme's
 * compatibility-surface rule: an import of `stores/settings` keeps resolving,
 * unchanged. The one thing the star exports add is the four `createXSettings`
 * factories, which are internals — calling one outside the store gives a second
 * set of refs writing the same keys. `stores/settings-boundary.test.ts` is what
 * holds that shut: it fails if any other file in the tree names one.
 */

import { defineStore } from 'pinia'
import { createAgentSettings } from './settings-agent'
import { createAiSettings } from './settings-ai'
import { createChatSettings } from './settings-chat'
import { createEditorSettings } from './settings-editor'
import { createExportSettings } from './settings-export'

export * from './settings-agent'
export * from './settings-ai'
export * from './settings-chat'
export * from './settings-editor'
export * from './settings-export'

export const useSettingsStore = defineStore('settings', () => ({
  ...createAgentSettings(),
  ...createAiSettings(),
  ...createChatSettings(),
  ...createEditorSettings(),
  ...createExportSettings(),
}))
