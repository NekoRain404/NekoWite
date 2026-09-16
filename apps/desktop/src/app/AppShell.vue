<script setup lang="ts">
import { computed, ref } from 'vue'
import { FolderOpen, PanelRightClose, PanelRightOpen, Settings } from 'lucide-vue-next'
import TitleBar from '../ui/TitleBar.vue'
import { AppSidebar } from '../features/sidebar'
import { NoteListPanel } from '../features/notes'
import InfoRail, { type RailTab } from '../ui/InfoRail.vue'
import TabBar from '../ui/TabBar.vue'
import StatusBar from '../ui/StatusBar.vue'
import { markArrived, markLeaving } from '../composables/surface-leave'
import AppDialogs from './AppDialogs.vue'
import EditorPane from '../ui/EditorPane.vue'
import LayoutResizeHandle from '../ui/LayoutResizeHandle.vue'
import ViewSwitch from '../view/ViewSwitch.vue'
import Toast from '../components/AppToast.vue'
import type { PendingAiWrite } from '../stores/ai-permission'
import GhostWriter from '../components/GhostWriter.vue'
import CommandPalette from '../ui/CommandPalette.vue'
import {
  NOTELIST_WIDTH_DEFAULT,
  NOTELIST_WIDTH_MAX,
  NOTELIST_WIDTH_MIN,
  RAIL_WIDTH_DEFAULT,
  RAIL_WIDTH_MAX,
  RAIL_WIDTH_MIN,
  SIDEBAR_WIDTH_DEFAULT,
  SIDEBAR_WIDTH_MAX,
  SIDEBAR_WIDTH_MIN,
} from '../stores/appearance-schema'
import { useAppearanceStore } from '../stores/appearance'
import type { PluginIntegrityRequest, PluginPermissionRequest } from '../services/plugins'
import { getLocale, t } from '../i18n'

// AppShell is the presentational root layout only. It owns no Tauri calls, no
// file-path walking and no business logic. Appearance-driven layout (theme,
// accent, widths, typography) is read from the appearance store; the app-level
// state (vault, pane visibility, active-tab title/subtitle, dialogs) is props,
// and every interaction is an event for the parent (App.vue) to route. The main
// editor region is a default slot so the shell stays composable, with the
// standard TabBar+EditorPane as the fallback.

// Not assigned to a local: nothing in this script reads a prop any more (the
// template reads them by name, which `<script setup>` exposes without it), and
// the only reader used to be the content glide's `props.sidebarVisible`.
defineProps<{
  sidebarVisible: boolean
  vaultPath: string | null
  railOpen: boolean
  showSettings: boolean
  activeTitle: string
  activeSubtitle: string
  conflict: { tabId: string; path: string } | null
  pluginPermission: PluginPermissionRequest | null
  pluginIntegrity: PluginIntegrityRequest | null
  /** A write the AI is waiting to be allowed to perform. */
  aiWrite: PendingAiWrite | null
}>()

const emit = defineEmits<{
  (e: 'toggle-sidebar'): void
  (e: 'open-folder', path: string): void
  (e: 'pick-folder'): void
  (e: 'open-settings'): void
  (e: 'close-settings'): void
  (e: 'close-conflict'): void
  (e: 'reload-conflict-disk', tabId: string): void
  (e: 'keep-local-conflict', tabId: string): void
  (e: 'respond-ai-write', approved: boolean, remember: boolean): void
  (e: 'resolve-permission', allowed: boolean): void
  (e: 'resolve-integrity', reapprove: boolean): void
  (e: 'toggle-rail'): void
  (e: 'toggle-settings'): void
}>()

const appearance = useAppearanceStore()

// The rail is mounted only while it is open, so which panel it shows has to
// outlive it: held here, closing the rail and reopening it puts the user back on
// the panel they were reading instead of resetting to the chat (D1).
const railTab = ref<RailTab>('ai')

// The left cluster's toggle does NOT animate the content, deliberately. It used
// to: a compensating translate was written to `.main` on every toggle, because
// the collapsing columns move the content's origin and the layout collapse is
// visible. The cost was the whole editor — the largest subtree in the app —
// carried through a 300ms transform, with two forced synchronous layouts of it
// per toggle to measure and commit the compensation. The user reported what
// that looks like from the outside: 点击左上角的抽屉图标,整个页面都会被改动,
// 而点击右下角的抽屉就不会这样 — jank and flicker on a control whose motion
// should be the panel's alone. The rail is the control that already behaves:
// it fades and translates itself (styles/appShell.css) while the content takes
// the space in the click frame, one reflow, nothing animated. Both toggles now
// do that, so the two halves of the same gesture feel the same.

const theme = computed<string>(() => {
  void appearance.systemRevision
  return appearance.effectiveTheme()
})
const accent = computed<string>(() => appearance.effectiveAccent())
const colorScheme = computed<string>(() => appearance.colorScheme)
const locale = computed<string>(() => getLocale())
const shellStyle = computed<Record<string, string>>(() => ({
  '--app-sidebar-width': `${appearance.sidebarWidth}px`,
  '--app-rail-width': `${appearance.railWidth}px`,
  '--app-notelist-width': `${appearance.notelistWidth}px`,
  '--app-body-size': `${appearance.bodyFontSize}px`,
  '--app-line-height': String(appearance.lineHeight),
  '--app-font': appearance.uiFontFamily(),
  '--app-mono-font': appearance.monoFontFamily(),
  '--app-editor-font': appearance.editorFontFamily(),
}))
</script>

<template>
  <div
    class="shell"
    :style="shellStyle"
    :data-theme="theme"
    :data-color-scheme="colorScheme"
    :data-accent="accent"
    :data-contrast="appearance.highContrast ? 'high' : 'normal'"
    :data-locale="locale"
  >
    <TitleBar
      :sidebar-visible="sidebarVisible"
      :title="activeTitle"
      :subtitle="activeSubtitle"
      @toggle-sidebar="emit('toggle-sidebar')"
    />

    <div class="shell-body">
      <!-- Having a vault open and having the sidebar shown are two different
           things, and only the first builds the columns: sharing one `v-if` once
           meant collapsing the sidebar unmounted it and the note list, losing
           the list's scroll and the open groups. Mounted once per vault, the
           toggle only hides them — and the `<Transition>` is what gives it an
           *exit*, because `v-show` alone writes `display: none` in the frame the
           state flips. What the leave does with the layout is in `appShell.css`. -->
      <template v-if="vaultPath">
        <Transition
          name="col"
          @leave="markLeaving"
          @enter="markArrived"
        >
          <AppSidebar
            v-show="sidebarVisible"
            class="layout-col"
            :vault="vaultPath"
            @open-folder="(p: string) => emit('open-folder', p)"
            @open-settings="emit('open-settings')"
          />
        </Transition>
        <LayoutResizeHandle
          v-if="sidebarVisible"
          :label="t('layout.resizeSidebar')"
          :min="SIDEBAR_WIDTH_MIN"
          :max="SIDEBAR_WIDTH_MAX"
          :value="appearance.sidebarWidth"
          :default-value="SIDEBAR_WIDTH_DEFAULT"
          @change="appearance.setSidebarWidth"
        />
        <Transition
          name="col"
          @leave="markLeaving"
          @enter="markArrived"
        >
          <NoteListPanel
            v-show="sidebarVisible"
            class="note-list-col layout-col"
          />
        </Transition>
        <LayoutResizeHandle
          v-if="sidebarVisible"
          :label="t('layout.resizeNotelist')"
          :min="NOTELIST_WIDTH_MIN"
          :max="NOTELIST_WIDTH_MAX"
          :value="appearance.notelistWidth"
          :default-value="NOTELIST_WIDTH_DEFAULT"
          @change="appearance.setNotelistWidth"
        />
      </template>
      <div
        v-else
        class="onboard"
      >
        <div class="onboard-card">
          <div class="onboard-icon">
            <FolderOpen
              :size="26"
              :stroke-width="1.5"
            />
          </div>
          <p class="onboard-title">
            {{ t('app.welcome') }}
          </p>
          <p class="onboard-hint">
            {{ t('app.welcomeHint') }}
          </p>
          <button
            class="btn btn-primary"
            @click="emit('pick-folder')"
          >
            {{ t('app.openFolder') }}
          </button>
        </div>
      </div>

      <section class="main">
        <div class="main-content">
          <slot>
            <TabBar />
            <EditorPane />
          </slot>
        </div>
        <LayoutResizeHandle
          v-if="railOpen"
          side="end"
          :label="t('layout.resizeRail')"
          :min="RAIL_WIDTH_MIN"
          :max="RAIL_WIDTH_MAX"
          :value="appearance.railWidth"
          :default-value="RAIL_WIDTH_DEFAULT"
          @change="appearance.setRailWidth"
        />
        <!-- `v-if`, not `v-show`, and the difference is a cost worth naming: the
             rail holds a chat session and a file-watch subscription, so keeping
             it alive for the app's whole life is not what a fade is worth. The
             `<Transition>` gives it an exit without that — the element stays in
             the tree for its own leave, then is destroyed. -->
        <Transition
          name="rail"
          @leave="markLeaving"
          @enter="markArrived"
        >
          <InfoRail
            v-if="railOpen"
            v-model:tab="railTab"
            @close="emit('toggle-rail')"
          />
        </Transition>
      </section>
    </div>

    <StatusBar>
      <template #actions>
        <ViewSwitch />
        <button
          class="status-btn"
          :class="{ 'is-active': railOpen }"
          :title="railOpen ? t('rail.collapse') : t('rail.expand')"
          @click="emit('toggle-rail')"
        >
          <PanelRightClose
            v-if="railOpen"
            :size="14"
            :stroke-width="1.8"
          />
          <PanelRightOpen
            v-else
            :size="14"
            :stroke-width="1.8"
          />
        </button>
        <button
          class="status-btn"
          :title="t('common.settings')"
          @click="emit('toggle-settings')"
        >
          <Settings
            :size="14"
            :stroke-width="1.8"
          />
        </button>
      </template>
    </StatusBar>
    <GhostWriter />
    <CommandPalette />
    <Toast />
    <!-- The shell's own modals, and the only place their exit is declared; see
         the component for why they moved out of this template together. -->
    <AppDialogs
      :show-settings="showSettings"
      :conflict="conflict"
      :plugin-permission="pluginPermission"
      :plugin-integrity="pluginIntegrity"
      :ai-write="aiWrite"
      @close-settings="emit('close-settings')"
      @open-folder="(p: string) => emit('open-folder', p)"
      @close-conflict="emit('close-conflict')"
      @reload-conflict-disk="(tabId: string) => emit('reload-conflict-disk', tabId)"
      @keep-local-conflict="(tabId: string) => emit('keep-local-conflict', tabId)"
      @respond-ai-write="(approved: boolean, remember: boolean) => emit('respond-ai-write', approved, remember)"
      @resolve-permission="(allowed: boolean) => emit('resolve-permission', allowed)"
      @resolve-integrity="(reapprove: boolean) => emit('resolve-integrity', reapprove)"
    />
  </div>
</template>

<style>
* { box-sizing: border-box; }
html, body, #app { margin: 0; padding: 0; height: 100%; width: 100%; }
#app { max-width: none; padding: 0; text-align: left; }
.shell {
  display: flex;
  flex-direction: column;
  height: 100vh;
  min-height: 0;
  overflow: hidden;
  background: var(--app-canvas);
}
.shell-body {
  flex: 1;
  display: flex;
  flex-direction: row;
  min-height: 0;
  overflow: hidden;
}
.main {
  flex: 1;
  display: flex;
  flex-direction: row;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  background: var(--app-canvas);
}
.main-content {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
}

.status-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 22px;
  padding: 0;
  border: none;
  border-radius: var(--app-radius-sm);
  background: transparent;
  color: var(--app-muted);
  cursor: pointer;
  transition: background var(--app-motion-fast) var(--app-ease),
              color var(--app-motion-fast) var(--app-ease);
}
.status-btn:hover {
  color: var(--app-text);
  background: color-mix(in srgb, var(--app-elevated) 66%, transparent);
}
.status-btn.is-active {
  color: var(--app-text);
  background: color-mix(in srgb, var(--app-accent-soft) 72%, var(--app-elevated));
}

.onboard {
  width: 240px;
  min-width: 240px;
  border-right: 1px solid var(--app-border);
  background: var(--app-panel);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 16px;
}
.onboard-card {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  text-align: center;
}
.onboard-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 56px;
  height: 56px;
  margin-bottom: 4px;
  border-radius: 16px;
  background: color-mix(in srgb, var(--app-elevated) 80%, var(--app-canvas));
  border: 1px solid var(--app-border);
  color: var(--app-muted);
}
.onboard-title {
  margin: 0;
  font-size: 13px;
  font-weight: 650;
  letter-spacing: -0.01em;
  color: var(--app-text);
}
.onboard-hint {
  margin: 0 0 6px;
  font-size: 11px;
  line-height: 1.6;
  color: var(--app-muted);
}
</style>

<style src="./appShell.css"></style>

