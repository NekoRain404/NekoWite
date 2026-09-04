<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import AppShell from './app/AppShell.vue'
import { createDesktopRuntime } from './app/appBootstrap'
import { createAppLifecycle } from './app/appLifecycle'
import { useAppDialogs } from './app/appDialogs'
import { activeTabSubtitle, activeTabTitle } from './app/tabMeta'
import { useViewStore } from './stores/view'
import { useTabsStore } from './stores/tabs'
import { useLibraryStore } from './stores/library'

const tabs = useTabsStore()
const view = useViewStore()
const library = useLibraryStore()

// App shell is a thin orchestrator: it owns the app sub-objects (runtime,
// dialogs, lifecycle) and the small local UI state, then lets <AppShell> render
// them. No Tauri `invoke`/`listen`, no file-path walking and no index traversal
// lives here — those moved into the app/ modules.
const runtime = createDesktopRuntime()
const dialogs = useAppDialogs()
const lifecycle = createAppLifecycle({ windowTracking: runtime.windowTracking })

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
