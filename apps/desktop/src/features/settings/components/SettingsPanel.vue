<script setup lang="ts">
/**
 * The settings dialog: the shell, the navigation rail and one section at a time.
 *
 * Orchestration only (§13.3). Each section renders itself and reads its own
 * state through `composables/*`, so this file holds no store reads at all
 * (§10.2) — what is left is the modal chrome and which section is visible.
 *
 * **This dialog is not teleported, and that is a decision rather than an
 * omission.** It used to be (`<Teleport to="body">`, carried over from the
 * 1508-line panel this file was split out of), and the cost was the whole
 * dialog, not a corner of it: `.shell` is the element that carries the user's
 * appearance — `data-theme`, `data-color-scheme`, `data-accent`,
 * `data-contrast`, `data-locale` and the seven inline `--app-*` properties
 * `AppShell.vue` writes — and a child of `body` is outside all of it. Measured
 * in Chromium with the dark `forest` scheme and a serif UI font chosen through
 * these very controls, the dialog drew `#fffefb` on `#292a27` in `system-ui`
 * with `--app-body-size: 15px`, while the shell beside it drew `#243020` on
 * `#e8f3e2` in the chosen serif at `17px`. A user picked a theme, a scheme and
 * a font by looking at a dialog that could show none of them.
 *
 * Nothing needs the teleport. The overlay is `position: fixed` — out of the
 * layout's flow wherever it is rendered — so what it needed was to be inside the
 * scope, and `AppDialogs.vue` already renders this component inside `.shell`,
 * beside the four dialogs that were never teleported and have always drawn the
 * user's palette. Anything that moves this element out of `.shell` again gives
 * every control in it a token instead of the setting it is there to show;
 * `e2e/settings-dialog-scope.spec.ts` measures the pair.
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
import { createAgentSettingsClients } from '../../../app/agent-settings-composition'
import { PET_SETTINGS_SECTION, type PetSettingsPage } from '../../../platform/gateways/pet-contracts'
import { useSettingsDialog } from '../composables/use-settings-dialog'
import { DIALOG_WIDTH_MIN, useDialogSize } from '../composables/use-dialog-size'
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

/**
 * The agent settings tree's clients, from the composition site that owns that choice.
 *
 * Built here for the same reason the pet's connection is: the section takes its clients as a prop
 * and never constructs one, so §6.1's "the adapter is chosen at the composition site" holds for
 * these pages too. Unlike the pet's, this is never `null`: there is no double for the registry or
 * the profile (nothing a double could honestly stand in for), so a build without a backend is the
 * pages' own unreadable state rather than a section that says nothing.
 */
const agentClients = createAgentSettingsClients()

const dialogRef = ref<HTMLElement | null>(null)
const overlayRef = ref<HTMLElement | null>(null)

const { appVersion, onOverlayPointerDown, focusDialog } = useSettingsDialog({
  dialogRef,
  onClose: () => emit('close'),
})

/**
 * The dialog's size, from the corner grip the user can drag.
 *
 * The overlay is handed over because the *room* a drag has is the overlay's content box — the same
 * box the stylesheet's `max-width: 100%` resolves against — and not the dialog's own, which is the
 * thing being decided. See `use-dialog-size.ts` for why the stylesheet declares no size at all.
 */
const {
  rendered: dialogSize,
  bounds: sizeBounds,
  dragging: resizing,
  onHandlePointerDown,
  onHandleKeydown,
  onHandleDoubleClick,
} = useDialogSize({ overlayRef })

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
  <div
    ref="overlayRef"
    class="settings-overlay"
    role="presentation"
    @pointerdown="onOverlayPointerDown"
  >
    <!-- The size is inline state and nothing else: the stylesheet declares no width or height for
         this element, because a size that is both a drag and a constant is two answers to one
         question. `max-width`/`max-height: 100%` stay in the stylesheet — that is the *bound*, the
         overlay's content box, which is the same box `use-dialog-size`'s clamp measures. -->
    <div
      ref="dialogRef"
      class="settings-dialog"
      role="dialog"
      aria-modal="true"
      :aria-label="t('settings.dialogTitle')"
      :style="{ width: `${dialogSize.width}px`, height: `${dialogSize.height}px` }"
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
              :clients="agentClients"
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

      <!-- The corner grip. A real control and not a decoration: `role="separator"` with its value
           semantics, `tabindex="0"`, arrows for each axis, Home for the floor and End for the
           window, and a double-click back to the size it opens at — the same vocabulary
           `ui/LayoutResizeHandle.vue` uses for the three columns, so the app has one resize control
           rather than two.
           ARIA's `separator` is one-dimensional and this grip moves two, which is a limit of the
           role rather than a choice made here: `aria-orientation` describes the width axis the
           handle is named for and `aria-valuenow` reports, and `aria-valuetext` carries both
           numbers so a screen reader announces the state rather than half of it. -->
      <div
        class="settings-resize"
        :class="{ 'is-active': resizing }"
        role="separator"
        aria-orientation="vertical"
        :aria-label="t('settings.resize.label')"
        :title="t('settings.resize.hint')"
        :aria-valuemin="DIALOG_WIDTH_MIN"
        :aria-valuemax="Math.round(sizeBounds.width)"
        :aria-valuenow="dialogSize.width"
        :aria-valuetext="
          t('settings.resize.value', { width: dialogSize.width, height: dialogSize.height })
        "
        tabindex="0"
        @pointerdown="onHandlePointerDown"
        @keydown="onHandleKeydown"
        @dblclick="onHandleDoubleClick"
      />
    </div>
  </div>
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

/* **No `width` and no `height` here, and that is the point.** Both used to be declared in this
   rule — `min(720px, 100%)` and `min(520px, 100%)` — which was correct while the size was a
   constant and became the two-answers defect the moment a drag could change it: the drag would
   write an inline width that this `min()` still capped, and the corner grip would then sit
   somewhere the box was not. The value now comes from `use-dialog-size.ts` alone, clean-install
   default included, and what stays here is the **bound** — the overlay's content box, which is the
   same box that file's clamp measures. `position: relative` is the grip's containing block and
   nothing else: it is not a transform, a filter or a `contain`, so it is not a containing block for
   the `position: fixed` popups — those are teleported to `.shell` besides. */
.settings-dialog {
  position: relative;
  display: flex;
  flex-direction: column;
  max-width: 100%;
  max-height: 100%;
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

/* ---- The corner grip ----------------------------------------------------
   The hit area is 16x16 — wider than `LayoutResizeHandle`'s 8px rail, because that one is a full
   column edge a pointer is already travelling along while this one is a corner the user has to
   find. The drawn mark inside it is 10px of two hairlines, so the target is generous without the
   dialog growing a visible block in its corner.

   The mark appears on hover, on focus and while dragging, in the user's own accent — the same rule
   and the same colour mix as the rail handle, so the two read as one family.

   **No `transition` on the dialog's size, here or anywhere.** §7.3's 正文稳定 is strongest at a
   resize: an animated `width` re-flows every line of text in the dialog for the length of a curve
   the user did not ask for and cannot stop. A drag is not an animation — it is one-to-one with the
   pointer and interruptible at any frame — so the size is written straight from the pointer and
   nothing interpolates it. `settings-resize.spec.ts` asserts the absence rather than trusting it. */
.settings-resize {
  position: absolute;
  right: 0;
  bottom: 0;
  width: 16px;
  height: 16px;
  cursor: nwse-resize;
  touch-action: none;
  outline: none;
}
/* The mark is *drawn* at rest, not only on hover. The complaint this whole change answers is that
   the dialog could not be resized at all (「现在窗口无法拖拽变大」), so a grip that stays invisible
   until a pointer happens to find its corner is the wrong default — it makes the fix reachable only
   by someone who already knew it was there. It reads as furniture instead: a muted corner mark in
   the border's own colour, brightening to the user's accent under the pointer, which is when it
   becomes a control. */
.settings-resize::after {
  content: '';
  position: absolute;
  right: 3px;
  bottom: 3px;
  width: 10px;
  height: 10px;
  border-right: 2px solid color-mix(in srgb, var(--app-muted) 55%, transparent);
  border-bottom: 2px solid color-mix(in srgb, var(--app-muted) 55%, transparent);
  border-bottom-right-radius: 2px;
  transition: border-color var(--app-motion-fast) var(--app-ease);
}
.settings-resize:hover::after,
.settings-resize:focus-visible::after,
.settings-resize.is-active::after {
  border-color: color-mix(in srgb, var(--app-accent) 58%, transparent);
}
/* The keyboard's half of the hover mark, at the inset the rest of this dialog uses for
   `:focus-visible`, so a keyboard user sees the same control a pointer user does. */
.settings-resize:focus-visible::after {
  border-color: var(--app-accent);
}
</style>

<style>
/* The pointer keeps the corner cursor for the whole drag, wherever it has travelled to — the same
   rule and the same shape the rail handle uses for `is-layout-resizing`. Scoped styles cannot
   reach `body`, which is why this is a second block. */
body.is-dialog-resizing,
body.is-dialog-resizing * {
  cursor: nwse-resize !important;
  user-select: none !important;
}
</style>
