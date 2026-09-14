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
            <!-- One page at a time, and the swap is a *cross-fade*: the page
                 leaving is still arriving's equal, not a thing to be waited on.
                 Vue's `<Transition>` default mode runs the two together, which
                 is what the earlier "switch categories quickly and it must go
                 straight to the latest state, not queue" asks for — `out-in`
                 would blank the destination for the whole exit. The leaving
                 page is taken out of flow so the scroll container never briefly
                 holds both (see the stylesheet), which is the same reason its
                 number is the same as the panels': the box has to stay put even
                 while the thing inside it changes.
                 Every section's root is a single element, so the transition
                 classes land on it and nothing about the markup or the focus
                 watch changes. -->
            <Transition name="page">
              <GeneralSettings
                v-if="activeSection === 'general'"
                :app-version="appVersion"
                @saved="(p: string) => emit('saved', p)"
              />
              <AppearanceSettings
                v-else-if="activeSection === 'appearance'"
              />
              <EditorSettings
                v-else-if="activeSection === 'editor'"
              />
              <ExportSettings
                v-else-if="activeSection === 'export'"
                v-model:frontmatter="frontmatter"
                v-model:page-size="pageSize"
                v-model:orientation="orientation"
                :has-active-tab="hasActiveTab"
                @export-html="exportHtmlFile"
                @export-pdf="exportPdfFile"
              />
              <PluginSettings
                v-else-if="activeSection === 'plugins'"
              />
              <AiSettings
                v-else-if="activeSection === 'ai'"
              />
            </Transition>
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
  /* The containing block for a page on its way out. */
  position: relative;
}

/* ---- The page swap ------------------------------------------------------
   The shape the design asked for: 460ms in, scale 0.985 -> 1.002 -> 1 and a
   6px rise that crosses to -0.5px, with the fade finished in the first 200ms;
   280ms out, scale 1 -> 0.992, drifting 2px down, and *no* rebound on the way
   out — 退出不回弹. One overshoot, once, on the scale, which is what the spring
   curve in tokens.css is sampled to give: 8.4% of 1.5% is the 1.002, and 8.4%
   of 6px is the -0.5px, so both fall out of the same token.

   The fade is a *separate* transition from the movement, not the same one
   slowed down. On the arrival curve an opacity is finished a third of the way
   into a 460ms timeline and then sits clamped at 1 while the surface is still
   moving; 200ms on the state-change curve is the fade the design asked for and
   the movement gets the whole 460ms to settle.

   The page is a *page*: it replaces the content area rather than landing on a
   scrim, so its exit is the handover to whatever comes next. Two of them cross
   in one transition, and the one leaving is taken out of flow — otherwise the
   scroll container would hold both for 280ms and the page would jump by the
   other's height on every switch. Out of flow at its own top and full width, so
   it fades and shrinks exactly where it was standing. */
.page-enter-active {
  transition: opacity var(--app-motion-fade) var(--app-ease),
              scale var(--app-motion-slow) var(--app-ease-surface),
              translate var(--app-motion-slow) var(--app-ease-surface);
}
.page-enter-from {
  opacity: 0;
  scale: var(--app-motion-scale-surface);
  translate: 0 var(--app-motion-travel);
}
.page-leave-active {
  position: absolute;
  top: 16px;
  left: 20px;
  right: 20px;
  transition: opacity var(--app-motion-exit-slow) var(--app-ease-exit),
              scale var(--app-motion-exit-slow) var(--app-ease-exit),
              translate var(--app-motion-exit-slow) var(--app-ease-exit);
}
.page-leave-to {
  opacity: 0;
  scale: var(--app-motion-scale-exit);
  translate: 0 calc(var(--app-motion-travel) / 3);
}
</style>
