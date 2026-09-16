<script setup lang="ts">
/**
 * The settings dialog: the shell, the navigation rail and one section at a time.
 *
 * Orchestration only (§13.3). Each section renders itself and reads its own
 * state through `composables/*`, so this file holds no store reads at all
 * (§10.2) — what is left is the modal chrome and which section is visible.
 *
 * The export section used to be the exception: the panel held its writable
 * computeds and forwarded its two events, because §10.3-C sends the export
 * *commands* out of the section. They still are — `useExportSettings` owns
 * them — but the section now reads that composable itself, the way the AI
 * prompt shelf does. Forwarding six models and five handlers through a shell
 * that owns none of them was the panel doing the section's job.
 */
import { ref, watch } from 'vue'
import { X } from 'lucide-vue-next'
import { t } from '../../../i18n'
import AgentSettingsSection from './AgentSettingsSection.vue'
import AiSettings from './AiSettings.vue'
import AppearanceSettings from './AppearanceSettings.vue'
import EditorSettings from './EditorSettings.vue'
import ExportSettings from './ExportSettings.vue'
import GeneralSettings from './GeneralSettings.vue'
import PluginSettings from './PluginSettings.vue'
import SettingsNavigation from './SettingsNavigation.vue'
import { DesktopPetSettingsSection } from '../../desktop-pet-settings'
import { createDesktopPetConnection } from '../../../app/desktop-pet-composition'
import { PET_SETTINGS_SECTION, type PetSettingsPage } from '../../../platform/gateways/pet-contracts'
import { useSettingsDialog } from '../composables/use-settings-dialog'
import { markArrived, markLeaving } from '../../../composables/surface-leave'
import type { SettingsOpenTarget, SettingsSectionId } from '../types'

const emit = defineEmits<{ (e: 'close'): void; (e: 'saved', path: string): void }>()

/**
 * Where the dialog was asked to open.
 *
 * `null` — the ordinary case — means "wherever it always opened", which is `general`. The one
 * caller that passes something is the pet window's 设置 (§5.1's 设置定位): it raises the main
 * window and names a section and a page, and the dialog lands there instead.
 *
 * A prop rather than internal state read once, because the request can also arrive while the
 * dialog is already open on another section — the right-click is answered by the panel it is
 * already showing, and a value only read in `setup` would leave that click doing nothing. The
 * watcher below is what makes the two cases one.
 */
const props = withDefaults(
  defineProps<{ target?: SettingsOpenTarget | null }>(),
  { target: null },
)

const activeSection = ref<SettingsSectionId>(props.target?.section ?? 'general')

/**
 * §5.1's sub-page the caller named.
 *
 * Held here rather than inside the pet's section because the *panel* is what outlives a request:
 * the section is remounted whenever the rail moves away and back, and a page the pet named would
 * otherwise be forgotten by the first click on another row.
 */
const petPage = ref<PetSettingsPage>(props.target?.page ?? 'general')

/**
 * The pet's host connection, or `null` where this window has none.
 *
 * The composition (§10.1) is the one place that decides, and it caches: the section is handed
 * this as a prop and never makes a connection of its own, so a remount cannot build a second one.
 * `null` is a state the section renders as a sentence — in a browser build, and in a test.
 */
const petConnection = createDesktopPetConnection()

const dialogRef = ref<HTMLElement | null>(null)

const { appVersion, onOverlayPointerDown, focusDialog } = useSettingsDialog({
  dialogRef,
  onClose: () => emit('close'),
})

// The keyboard follows the eye: changing section moves focus back to the panel
// container, so Tab starts from the top of the new section.
watch(activeSection, () => {
  focusDialog()
})

// The request arriving while the dialog is already open — §5.1's 设置定位 has to answer the
// second right-click as well as the first. The two writes are in the order the user asked for
// them: the section, then the page inside it.
watch(
  () => props.target,
  (target) => {
    if (!target) return
    activeSection.value = target.section
    if (target.page) petPage.value = target.page
  },
)
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
                 watch changes.
                 The two hooks are the other half of taking the leaver out of
                 flow: an out-of-flow page that is still in the tab order is
                 still a place the user can be, and measured it stayed *findable*
                 too — 60ms after a switch the previous section still matched 15
                 controls that now sit under the new one. See surface-leave.ts,
                 and `.page-leave-active` below for the pointer. -->
            <Transition
              name="page"
              @leave="markLeaving"
              @enter="markArrived"
            >
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
              />
              <PluginSettings
                v-else-if="activeSection === 'plugins'"
              />
              <AiSettings
                v-else-if="activeSection === 'ai'"
              />
              <!-- The agents tree's own door (T16). It is one section here and
                   seven pages inside it, which is why this is a section of its
                   own rather than seven rows: the dialog's rail switches
                   sections, and those seven are a tree one level down. What it
                   carries today is stated on the page itself — the switch that
                   reaches this shell, and the parts of the tree whose host half
                   does not exist yet. -->
              <AgentSettingsSection
                v-else-if="activeSection === 'agents'"
              />
              <!-- The pet's settings tree (§5.1), and the one section that is not this
                   feature's: the id is D1's constant (a literal here would be a second spelling
                   of one decision) and the body is one component from
                   `features/desktop-pet-settings`, which fills the container's five slot pages
                   itself. This file is therefore where the pet becomes *reachable* — the pages
                   behind it were built and tested with nowhere to mount — and the connection it
                   is handed comes from the composition, so nothing here decides what the pet
                   talks to. A build with no host connection is a state the section states in
                   words rather than a control that fails when it is used. -->
              <DesktopPetSettingsSection
                v-else-if="activeSection === PET_SETTINGS_SECTION"
                v-model:page="petPage"
                :gateway="petConnection"
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

/* The 720 is a **maximum**, not a fixed width — and in the shipped app it is always the width
   used. The overlay's 24px of padding means the dialog is `min(720, viewport - 48)`, so the clamp
   only engages below a 768px window, while `tauri.conf.json` gives the main window
   `minWidth: 860` / `minHeight: 560`. Every window the product can be in therefore lands on 720,
   which is why a viewport sweep reads the same content width at 1280 and at 860: §12's 860x560 is
   the narrow case, and a narrower viewport (task-183 measured 700 for one) is narrower than this
   app can be. The height is the term that does bind at 560 — `min(520, 100%)` is 512 there. */
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
  /* Out of flow is not out of the way. The page that is leaving sits exactly
     where the incoming one is arriving, so without this a click in the first
     280ms of a section switch lands on the section the user has just left —
     the same defect the shell's panels and the popups carry the same rule for. */
  pointer-events: none;
}
.page-leave-to {
  opacity: 0;
  scale: var(--app-motion-scale-exit);
  translate: 0 calc(var(--app-motion-travel) / 3);
}
</style>
