<script setup lang="ts">
import SettingsPanel from '../features/settings/components/SettingsPanel.vue'
import type { SettingsOpenTarget } from '../features/settings'
import ConflictDialog from '../components/ConflictDialog.vue'
import AiWriteDialog from '../components/AiWriteDialog.vue'
import PermissionDialog from '../components/PermissionDialog.vue'
import PluginIntegrityDialog from '../components/PluginIntegrityDialog.vue'
import type { PendingAiWrite } from '../stores/ai-permission'
import type { PluginIntegrityRequest, PluginPermissionRequest } from '../services/plugins'

/**
 * The dialogs the shell mounts, and the one thing they have in common that the
 * shell does not: how they leave.
 *
 * These five are the app's modals. Each is rendered by a `v-if` on a piece of
 * app-level state, and every one of them wore the shared surface arrival
 * (`.dialog` / `.dialog-overlay`, out of styles/motion.css) — 460ms of fade and
 * a 1.5% scale on the way in, and then the node was gone in the frame the state
 * flipped. A `<Transition>` is what turns that removal into a departure, and it
 * has to sit where the `v-if` is, which is why these five moved into one file
 * together: five identical wrappers in the shell's template buried the layout
 * they were interleaved with, and the shell was already over §13.1's rung.
 *
 * `name="dialog"` names the shared leave rules in motion.css. The entrance is
 * *not* restated here — the keyframe arrival is the arrival — so the transition
 * contributes the exit and the reversal, and nothing else.
 *
 * `type="transition"` is not decoration either. These surfaces arrive on a
 * keyframe and leave on a transition, and Vue's own detection takes the longer
 * of the two when nothing is declared: measured, the node was held for 460ms
 * (the arrival animation's duration, read off the element long after it had
 * finished) while its fade was over at 280ms — an invisible full-screen overlay
 * still holding the modal stack and the focus trap for another 180ms. Naming
 * the type is what makes the element's lifetime match the motion the user saw.
 *
 * The settings panel is in this group because it is the same object even though
 * its chrome belongs to another feature: it is the app's largest surface and it
 * had the same one-frame disappearance. Wrapping it here rather than editing
 * `features/settings` keeps this change on the shell's side of the seam, and
 * all it needs from the panel is a single root element, which it has.
 */
defineProps<{
  showSettings: boolean
  /**
   * Where the dialog should open, or `null` for where it always opened. Carried through this
   * file, not read by it: it is the shell's value and the settings panel's prop, and the only
   * thing between them is the one component per modal this file exists to be.
   */
  settingsTarget: SettingsOpenTarget | null
  conflict: { tabId: string; path: string } | null
  pluginPermission: PluginPermissionRequest | null
  pluginIntegrity: PluginIntegrityRequest | null
  /** A write the AI is waiting to be allowed to perform. */
  aiWrite: PendingAiWrite | null
}>()

const emit = defineEmits<{
  (e: 'close-settings'): void
  (e: 'open-folder', path: string): void
  (e: 'close-conflict'): void
  (e: 'reload-conflict-disk', tabId: string): void
  (e: 'keep-local-conflict', tabId: string): void
  (e: 'respond-ai-write', approved: boolean, remember: boolean): void
  (e: 'resolve-permission', allowed: boolean): void
  (e: 'resolve-integrity', reapprove: boolean): void
}>()
</script>

<template>
  <Transition
    name="dialog"
    type="transition"
  >
    <SettingsPanel
      v-if="showSettings"
      :target="settingsTarget"
      @close="emit('close-settings')"
      @saved="(p: string) => emit('open-folder', p)"
    />
  </Transition>

  <Transition
    name="dialog"
    type="transition"
  >
    <AiWriteDialog
      v-if="aiWrite"
      :pending="aiWrite"
      @respond="(approved: boolean, remember: boolean) => emit('respond-ai-write', approved, remember)"
    />
  </Transition>

  <Transition
    name="dialog"
    type="transition"
  >
    <ConflictDialog
      v-if="conflict"
      :tab-id="conflict.tabId"
      :path="conflict.path"
      @close="emit('close-conflict')"
      @reload-disk="emit('reload-conflict-disk', conflict.tabId)"
      @keep-local="emit('keep-local-conflict', conflict.tabId)"
    />
  </Transition>

  <Transition
    name="dialog"
    type="transition"
  >
    <PermissionDialog
      v-if="pluginPermission"
      :meta="pluginPermission.meta"
      :permissions="pluginPermission.permissions"
      @allow="emit('resolve-permission', true)"
      @deny="emit('resolve-permission', false)"
    />
  </Transition>

  <Transition
    name="dialog"
    type="transition"
  >
    <PluginIntegrityDialog
      v-if="pluginIntegrity"
      :meta="pluginIntegrity.meta"
      :expected-digest="pluginIntegrity.expectedDigest"
      :actual-digest="pluginIntegrity.actualDigest"
      @allow="emit('resolve-integrity', true)"
      @deny="emit('resolve-integrity', false)"
    />
  </Transition>
</template>
