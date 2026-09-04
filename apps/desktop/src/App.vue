<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import AppShell from './app/AppShell.vue'
import { createDesktopRuntime } from './app/appBootstrap'
import { createAppLifecycle } from './app/appLifecycle'
import { useAppDialogs } from './app/appDialogs'
import { activeTabSubtitle, activeTabTitle } from './app/tabMeta'
import { useViewStore } from './stores/view'
import { useTabsStore } from './stores/tabs'
import { useDocumentListStore } from './stores/documentList'

const tabs = useTabsStore()
const view = useViewStore()
const documentList = useDocumentListStore()

// App shell is a thin orchestrator: it owns the app sub-objects (runtime,
// dialogs, lifecycle) and the small local UI state, then lets <AppShell> render
// them. No Tauri `invoke`/`listen`, no file-path walking and no index traversal
// lives here — those moved into the app/ modules.
const runtime = createDesktopRuntime()
const dialogs = useAppDialogs()
// The lifecycle owns app teardown: its `unmount()` disposes the runtime first
// (cancels in-flight vault switch/recovery, detaches index + fs-watcher,
// deactivates plugins, destroys the editor session, releases window tracking),
// then removes its own window listeners. So onBeforeUnmount is the one place the
// composition root tears everything down.
const lifecycle = createAppLifecycle({
  windowTracking: runtime.windowTracking,
  disposeRuntime: () => runtime.dispose(),
})

const dialogState = dialogs.state

const showSettings = ref(false)
const sidebarVisible = ref(true)
const railOpen = ref(false)

const activeTitle = computed(() => activeTabTitle(tabs.activeTab))
const activeSubtitle = computed(() => activeTabSubtitle(tabs.activeTab, tabs.vault))

watch(
  () => tabs.activeId,
  () => {
    const path = tabs.activeTab?.path
    if (path) documentList.touchRecent(path)
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

function onOpenFolder(path: string): void {
  runtime.onOpenFolder(path)
}

function onConflict(req: { tabId: string; path: string }): void {
  dialogs.showConflict(req.tabId, req.path)
}

onMounted(() => {
  runtime.start()
  lifecycle.mount()
  dialogs.installPluginDeciders()
})

onBeforeUnmount(() => {
  // Single app teardown: lifecycle.unmount() disposes the runtime AND removes the
  // window listeners, so nothing (vault switch, recovery scan, fs watcher, plugins,
  // editor session) outlives the app.
  lifecycle.unmount()
})
</script>

<template>
  <AppShell
    :sidebar-visible="sidebarVisible"
    :vault-path="runtime.vaultPath.value"
    :rail-open="railOpen"
    :show-settings="showSettings"
    :active-title="activeTitle"
    :active-subtitle="activeSubtitle"
    :conflict="dialogState.kind === 'conflict' ? { tabId: dialogState.tabId, path: dialogState.path } : null"
    :plugin-permission="dialogState.kind === 'permission' ? dialogState.request : null"
    :plugin-integrity="dialogState.kind === 'integrity' ? dialogState.request : null"
    @toggle-sidebar="sidebarVisible = !sidebarVisible"
    @open-folder="onOpenFolder"
    @conflict="onConflict"
    @pick-folder="runtime.pickFolder"
    @open-settings="showSettings = true"
    @close-settings="showSettings = false"
    @close-conflict="dialogs.close"
    @resolve-permission="dialogs.resolvePermission"
    @resolve-integrity="dialogs.resolveIntegrity"
    @toggle-rail="railOpen = !railOpen"
    @toggle-settings="showSettings = !showSettings"
  />
</template>
