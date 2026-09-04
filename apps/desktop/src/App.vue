<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { LogicalPosition, LogicalSize } from '@tauri-apps/api/dpi'
import { FolderOpen, PanelRightClose, PanelRightOpen, Settings } from 'lucide-vue-next'
import TitleBar from './ui/TitleBar.vue'
import Sidebar from './ui/AppSidebar.vue'
import NoteListPanel from './ui/NoteListPanel.vue'
import InfoRail from './ui/InfoRail.vue'
import TabBar from './ui/TabBar.vue'
import StatusBar from './ui/StatusBar.vue'
import SettingsPanel from './ui/SettingsPanel.vue'
import EditorPane from './ui/EditorPane.vue'
import LayoutResizeHandle from './ui/LayoutResizeHandle.vue'
import ViewSwitch from './view/ViewSwitch.vue'
import Toast from './components/AppToast.vue'
import ConflictDialog from './components/ConflictDialog.vue'
import PermissionDialog from './components/PermissionDialog.vue'
import GhostWriter from './components/GhostWriter.vue'
import CommandPalette from './ui/CommandPalette.vue'
import { useViewStore } from './stores/view'
import { useTabsStore } from './stores/tabs'
import { useRefsStore } from './stores/refs'
import { useSettingsStore } from './stores/settings'
import { useAppearanceStore } from './stores/appearance'
import { useLibraryStore } from './stores/library'
import { getLocale, t } from './i18n'
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
} from './stores/appearance'
import { loadVaultPlugins, setPluginPermissionDecider } from './services/plugins'
import type { PluginPermissionRequest } from './services/plugins'
import {
  clampForDisplay,
  loadWindowState,
  saveWindowState,
  type WindowState,
} from './stores/windowState'

const tabs = useTabsStore()
const view = useViewStore()
const refs = useRefsStore()
const settings = useSettingsStore()
const appearance = useAppearanceStore()
const library = useLibraryStore()
const vaultPath = ref<string | null>(null)
const showSettings = ref(false)
const sidebarVisible = ref(true)
const railOpen = ref(false)
const conflict = ref<{ tabId: string; path: string } | null>(null)
const pluginPermission = ref<PluginPermissionRequest | null>(null)

const theme = computed<string>(() => {
  void appearance.systemRevision
  return appearance.effectiveTheme()
})

// Honors "follow system accent": when on, the accent ignores the user pick and
// adapts to the effective light/dark theme (browsers expose no OS accent API).
const accent = computed<string>(() => appearance.effectiveAccent())

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

const activeTab = computed(() => tabs.activeTab)
const activeTitle = computed(() => {
  const path = activeTab.value?.path
  if (!activeTab.value) return t('app.defaultTitle')
  return path ? path.split('/').pop() ?? path : t('tabs.untitled')
})
const activeSubtitle = computed(() => {
  const tab = activeTab.value
  if (!tab) return ''
  if (!tab.path || !tabs.vault) return tab.path ?? ''
  const dir = tab.path.slice(0, Math.max(0, tab.path.lastIndexOf('/')))
  const vault = tabs.vault.replace(/\/+$/, '')
  return dir.startsWith(vault) ? dir.slice(vault.length + 1) : dir
})

watch(
  () => tabs.activeId,
  () => {
    const path = tabs.activeTab?.path
    if (path) library.touchRecent(path)
  },
)

// A newly focused/open document starts in the configured default view mode,
// so "default view on open" stays meaningful even though the live mode is a
// single window-wide value the user can still change per session.
watch(
  () => tabs.activeId,
  () => {
    view.resetToDefault()
  },
)

// --- Window geometry persistence -------------------------------
// Window state is captured to localStorage and applied on the next launch. It
// runs before the vault is opened so the restored layout is visible while the
// editor initializes, and never blocks startup if Tauri is unavailable.

const inTauri =
  typeof (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ !== 'undefined'
const WINDOW_TRACK_MS = 300
let unlistenResized: (() => void) | null = null
let unlistenMoved: (() => void) | null = null
let windowSaveTimer: ReturnType<typeof setTimeout> | null = null
let lastWindowState: WindowState | null = null

function persistWindowGeometry(state: WindowState | null): void {
  if (!state) return
  lastWindowState = state
  saveWindowState(state)
}

async function captureWindowGeometry(): Promise<void> {
  if (!inTauri) return
  try {
    const win = getCurrentWindow()
    const [size, position, maximized] = await Promise.all([
      win.innerSize(),
      win.innerPosition(),
      win.isMaximized(),
    ])
    persistWindowGeometry({
      width: size.width,
      height: size.height,
      x: position.x,
      y: position.y,
      maximized,
    })
  } catch {
    // Geometry read is best-effort; never surface it.
  }
}

async function restoreWindowState(): Promise<void> {
  if (!inTauri) return
  const stored = loadWindowState()
  if (!stored) return
  try {
    const win = getCurrentWindow()
    if (stored.maximized) {
      await win.maximize()
    } else {
      // Clamp against the current desktop so a monitor that was unplugged (or
      // a resolution that shrank) cannot leave the window off screen.
      const clamped = clampForDisplay(stored, {
        availWidth: window.screen?.availWidth ?? stored.width,
        availHeight: window.screen?.availHeight ?? stored.height,
      })
      await win.setSize(new LogicalSize(clamped.width, clamped.height))
      await win.setPosition(new LogicalPosition(clamped.x, clamped.y))
    }
  } catch {
    // A failed restore (e.g. minimal environment) must not break startup.
  }
}

async function setupWindowTracking(): Promise<void> {
  if (!inTauri) return
  const scheduleSave = (): void => {
    if (windowSaveTimer) clearTimeout(windowSaveTimer)
    windowSaveTimer = setTimeout(() => {
      windowSaveTimer = null
      void captureWindowGeometry()
    }, WINDOW_TRACK_MS)
  }
  // Track geometry eagerly from the event payloads too, so an unload that
  // fires before the debounce still has the freshest values to flush.
  const patch = (prev: WindowState | null, next: Partial<WindowState>): WindowState => ({
    width: 0,
    height: 0,
    x: 0,
    y: 0,
    maximized: false,
    ...(prev ?? {}),
    ...next,
  })
  try {
    const win = getCurrentWindow()
    unlistenResized = await win.onResized(({ payload }) => {
      lastWindowState = patch(lastWindowState, { width: payload.width, height: payload.height })
      scheduleSave()
    })
    unlistenMoved = await win.onMoved(({ payload }) => {
      lastWindowState = patch(lastWindowState, { x: payload.x, y: payload.y })
      scheduleSave()
    })
  } catch {
    unlistenResized = null
    unlistenMoved = null
  }
  void captureWindowGeometry()
}

function flushWindowState(): void {
  if (windowSaveTimer) {
    clearTimeout(windowSaveTimer)
    windowSaveTimer = null
  }
  persistWindowGeometry(lastWindowState)
}

let unlistenMedia: (() => void) | null = null
let blurSaving = false

// Save on window blur when enabled, but only for tabs with unsaved work so a
// mere focus change never produces a no-op write or a spurious history entry.
function onWindowBlur(): void {
  if (!appearance.autosaveOnBlur) return
  const tab = tabs.activeTab
  if (!tab?.dirty || blurSaving) return
  blurSaving = true
  void tabs.saveActive().finally(() => {
    blurSaving = false
  })
}

function applyVault(path: string): void {
  vaultPath.value = path
  // Open tabs keep absolute paths from the previous vault — leaving them open
  // would route every save to "path escapes vault" errors. Start fresh.
  tabs.closeAll()
  tabs.setVault(path)
  void library.indexVault(path)
  void loadVaultPlugins(path)
  void refs.loadVault(path).catch(() => {
    // A stale vault path (deleted/renamed folder) must not crash startup;
    // the tree shows the failure and the user can pick another folder.
  })
}

onMounted(() => {
  // Restore window geometry before the vault is opened so the layout is in
  // place while the editor initializes.
  void restoreWindowState()
  // Vault plugins run in the same process as the app (no sandbox). When one
  // declares dangerous capabilities, ask the user before activating it.
  setPluginPermissionDecider((meta, permissions) => {
    return new Promise<boolean>((resolve) => {
      pluginPermission.value = {
        meta,
        permissions,
        resolve: (allowed) => {
          pluginPermission.value = null
          resolve(allowed)
        },
      }
    })
  })
  if (typeof window.matchMedia === 'function') {
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const onChange = (): void => {
      appearance.touchSystem()
    }
    if (typeof mq.addEventListener === 'function') {
      mq.addEventListener('change', onChange)
      unlistenMedia = (): void => mq.removeEventListener('change', onChange)
    }
  }
  window.addEventListener('blur', onWindowBlur)
  window.addEventListener('beforeunload', onBeforeUnload)
  void settings.loadKey().catch(() => {
    // stronghold init/key-file errors are surfaced by the settings panel; a
    // failed background load on startup should not reject the mount
  })
  const saved = localStorage.getItem('nekowite.vault')
  if (saved) applyVault(saved)
  // Reopen the tabs that were open at the last capture (no-op when there is no
  // matching session). Runs after the vault is applied so restoreSession sees
  // the correct vault and its duplicate guard can focus existing tabs.
  void tabs.restoreSession()
  void setupWindowTracking()
})

function onBeforeUnload(): void {
  tabs.captureSession()
  flushWindowState()
}

onBeforeUnmount(() => {
  onBeforeUnload()
  unlistenMedia?.()
  window.removeEventListener('blur', onWindowBlur)
  window.removeEventListener('beforeunload', onBeforeUnload)
  unlistenResized?.()
  unlistenMoved?.()
  unlistenResized = null
  unlistenMoved = null
})

function onOpenFolder(path: string): void {
  localStorage.setItem('nekowite.vault', path)
  applyVault(path)
}

function onConflict(req: { tabId: string; path: string }): void {
  conflict.value = req
}

async function pickFolder(): Promise<void> {
  const { fsService } = await import('./services/fs')
  const picked = await fsService.openFolderDialog()
  if (picked) onOpenFolder(picked)
}
</script>

<template>
  <div
    class="shell"
    :style="shellStyle"
    :data-theme="theme"
    :data-accent="accent"
    :data-locale="locale"
  >
    <TitleBar
      :sidebar-visible="sidebarVisible"
      :title="activeTitle"
      :subtitle="activeSubtitle"
      @toggle-sidebar="sidebarVisible = !sidebarVisible"
    />

    <div class="shell-body">
      <Sidebar
        v-if="vaultPath && sidebarVisible"
        :vault="vaultPath"
        @open-folder="onOpenFolder"
        @conflict="onConflict"
        @open-settings="showSettings = true"
      />
      <LayoutResizeHandle
        v-if="vaultPath && sidebarVisible"
        :label="t('layout.resizeSidebar')"
        :min="SIDEBAR_WIDTH_MIN"
        :max="SIDEBAR_WIDTH_MAX"
        :value="appearance.sidebarWidth"
        :default-value="SIDEBAR_WIDTH_DEFAULT"
        @change="appearance.setSidebarWidth"
      />
      <NoteListPanel
        v-if="vaultPath && sidebarVisible"
        class="note-list-col"
      />
      <LayoutResizeHandle
        v-if="vaultPath && sidebarVisible"
        :label="t('layout.resizeNotelist')"
        :min="NOTELIST_WIDTH_MIN"
        :max="NOTELIST_WIDTH_MAX"
        :value="appearance.notelistWidth"
        :default-value="NOTELIST_WIDTH_DEFAULT"
        @change="appearance.setNotelistWidth"
      />
      <div
        v-else-if="!vaultPath"
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
            @click="pickFolder"
          >
            {{ t('app.openFolder') }}
          </button>
        </div>
      </div>

      <section class="main">
        <div class="main-content">
          <TabBar />
          <EditorPane />
        </div>
        <LayoutResizeHandle
          v-if="railOpen"
          :label="t('layout.resizeRail')"
          :min="RAIL_WIDTH_MIN"
          :max="RAIL_WIDTH_MAX"
          :value="appearance.railWidth"
          :default-value="RAIL_WIDTH_DEFAULT"
          @change="appearance.setRailWidth"
        />
        <InfoRail
          v-if="railOpen"
          @close="railOpen = false"
        />
      </section>
    </div>

    <StatusBar>
      <template #actions>
        <ViewSwitch />
        <button
          class="status-btn"
          :class="{ 'is-active': railOpen }"
          :title="railOpen ? t('rail.collapse') : t('rail.expand')"
          @click="railOpen = !railOpen"
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
          @click="showSettings = !showSettings"
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
    <SettingsPanel
      v-if="showSettings"
      @close="showSettings = false"
      @saved="onOpenFolder"
    />
    <Toast />
    <ConflictDialog
      v-if="conflict"
      :tab-id="conflict.tabId"
      :path="conflict.path"
      @close="conflict = null"
    />
    <PermissionDialog
      v-if="pluginPermission"
      :meta="pluginPermission.meta"
      :permissions="pluginPermission.permissions"
      @allow="pluginPermission.resolve(true)"
      @deny="pluginPermission.resolve(false)"
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
