<script setup lang="ts">
/**
 * The settings dialog: the shell, the navigation rail and one section at a time.
 *
 * Orchestration only (§13.3). Each section renders itself and reads its own
 * state through `composables/*`, so this file holds no store reads at all
 * (§10.2) — what is left is the modal chrome, which section is visible, and the
 * export commands the export section deliberately does not own (§10.3-C).
 */
import { ref, watch } from 'vue'
import { X } from 'lucide-vue-next'
import { t } from '../../../i18n'
import AiSettings from './AiSettings.vue'
import AppearanceSettings from './AppearanceSettings.vue'
import EditorSettings from './EditorSettings.vue'
import ExportSettings from './ExportSettings.vue'
import GeneralSettings from './GeneralSettings.vue'
import PluginSettings from './PluginSettings.vue'
import SettingsNavigation from './SettingsNavigation.vue'
import { useExportSettings } from '../composables/use-export-settings'
import { useSettingsDialog } from '../composables/use-settings-dialog'
import type { SettingsSectionId } from '../types'

const emit = defineEmits<{ (e: 'close'): void; (e: 'saved', path: string): void }>()

const activeSection = ref<SettingsSectionId>('general')

const dialogRef = ref<HTMLElement | null>(null)

const { appVersion, onOverlayPointerDown, focusDialog } = useSettingsDialog({
  dialogRef,
  onClose: () => emit('close'),
})

const {
  hasActiveTab,
  frontmatter,
  pageSize,
  orientation,
  exportHtmlFile,
  exportPdfFile,
} = useExportSettings()

// The keyboard follows the eye: changing section moves focus back to the panel
// container, so Tab starts from the top of the new section.
watch(activeSection, () => {
  focusDialog()
})
</script>

<template>
  <Teleport to="body">
    <div
      class="settings-overlay"
      role="presentation"
      @pointerdown="onOverlayPointerDown"
    >
      <div
        ref="dialogRef"
        class="settings-dialog"
        role="dialog"
        aria-modal="true"
        :aria-label="t('settings.dialogTitle')"
        tabindex="-1"
      >
        <div class="dialog-header">
          <span class="dialog-title">{{ t('settings.dialogTitle') }}</span>
          <span class="dialog-spacer" />
          <button
            class="settings-close"
            :title="t('common.close')"
            @click="emit('close')"
          >
            <X
              :size="15"
              :stroke-width="1.8"
            />
          </button>
        </div>
        <div class="dialog-body">
          <SettingsNavigation v-model:active-section="activeSection" />
          <div class="dialog-content">
            <!-- One section at a time, swapped whole, so each wears the shared
                 nudge (`arrives`) and comes down out of the dialog's own header
                 rather than being cut in. Every section's root is a single
                 element, so the class falls through onto it and nothing about
                 the markup or the focus watch changes. -->
            <GeneralSettings
              v-if="activeSection === 'general'"
              class="arrives"
              :app-version="appVersion"
              @saved="(p: string) => emit('saved', p)"
            />
            <AppearanceSettings
              v-else-if="activeSection === 'appearance'"
              class="arrives"
            />
            <EditorSettings
              v-else-if="activeSection === 'editor'"
              class="arrives"
            />
            <ExportSettings
              v-else-if="activeSection === 'export'"
              v-model:frontmatter="frontmatter"
              v-model:page-size="pageSize"
              v-model:orientation="orientation"
              class="arrives"
              :has-active-tab="hasActiveTab"
              @export-html="exportHtmlFile"
              @export-pdf="exportPdfFile"
            />
            <PluginSettings
              v-else-if="activeSection === 'plugins'"
              class="arrives"
            />
            <AiSettings
              v-else-if="activeSection === 'ai'"
              class="arrives"
            />
          </div>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.settings-overlay {
  position: fixed;
  inset: 0;
  z-index: 10000;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  background: color-mix(in srgb, var(--app-canvas) 45%, transparent);
  backdrop-filter: blur(2px);
}

.settings-dialog {
  display: flex;
  flex-direction: column;
  width: min(720px, 100%);
  height: min(520px, 100%);
  overflow: hidden;
  border: 1px solid color-mix(in srgb, var(--app-border) 86%, transparent);
  border-radius: var(--app-radius-xl);
  background: color-mix(in srgb, var(--app-elevated) 97%, var(--app-panel));
  box-shadow: var(--app-shadow-dialog);
  color: var(--app-text);
  outline: none;
}

.dialog-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 14px;
  border-bottom: 1px solid color-mix(in srgb, var(--app-border) 60%, transparent);
  user-select: none;
}
.dialog-title {
  font-size: 13px;
  font-weight: 650;
  letter-spacing: -0.01em;
  color: var(--app-text);
}
.dialog-spacer { flex: 1; }
.settings-close {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  border: none;
  background: transparent;
  cursor: pointer;
  padding: 0;
  color: var(--app-muted);
  border-radius: var(--app-radius-sm);
  transition: background var(--app-motion-fast) var(--app-ease),
              color var(--app-motion-fast) var(--app-ease);
}
.settings-close:hover {
  color: var(--app-text);
  background: color-mix(in srgb, var(--app-panel) 70%, transparent);
}
.settings-close:focus-visible {
  outline: 2px solid var(--app-accent);
  outline-offset: 1px;
}

.dialog-body {
  flex: 1;
  min-height: 0;
  display: flex;
}

.dialog-content {
  flex: 1;
  min-width: 0;
  overflow-y: auto;
  padding: 16px 20px 20px;
}
</style>
