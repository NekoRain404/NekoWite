<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import AppShell from './app/AppShell.vue'
import { createDesktopRuntime } from './app/app-bootstrap'
import { createAppLifecycle } from './app/app-lifecycle'
import { useAppDialogs } from './app/app-dialogs'
import { activeTabSubtitle, activeTabTitle } from './app/tab-meta'
import { useViewStore } from './stores/view'
import { useTabsStore } from './stores/tabs'
import { useDocumentListStore } from './stores/document-list'
import { useAiPermissionStore } from './stores/ai-permission'
import { createExternalDocSync } from './services/external-doc-sync'
import { fsService } from './platform/gateways/fs'
import { notifyError } from './services/errors'
import { t } from './i18n'

const tabs = useTabsStore()
const view = useViewStore()
const documentList = useDocumentListStore()
const aiPermission = useAiPermissionStore()

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

// Raised by the app-level external-change service below (and by nothing else
// since the tree stopped forwarding conflicts).
function onConflict(req: { tabId: string; path: string }): void {
  dialogs.showConflict(req.tabId, req.path)
}

// The conflict prompt asks for the reload instead of performing it (§10.2), so
// the command lives here, next to the tab store it commands.
async function onReloadConflictFromDisk(tabId: string): Promise<void> {
  // Explicit: the user chose the disk version over their own edits, so this one
  // wins even though the tab is dirty. The automatic reload after an external
  // change must not, because its read takes time and the user may start typing
  // during it.
  await tabs.reloadFromDisk(tabId, { explicit: true })
  dialogs.close()
}

// External-edit detection lives at the app level, NOT in the file tree: the
// tree only exists while the Folders panel is shown, so a note opened from the
// Notes panel (the default view) had nobody watching the disk. An external edit
// then went unnoticed and the next save overwrote it.
const externalDocSync = createExternalDocSync({
  read: (vault, path) => fsService.read(vault, path),
  onFsChange: (cb) => fsService.onFsChange(cb),
  getVault: () => tabs.vault,
  getActiveTab: () => tabs.activeTab,
  getOpenTabs: () => tabs.tabs.map((t) => ({ id: t.id, path: t.path })),
  onMissing: (tabId, path) => {
    // Detach first, then tell the user: the order matters because the detach is
    // what stops the next save from silently recreating the vanished path.
    if (tabs.detachMissingPath(tabId)) notifyError(t('tabs.missingOnDisk', { path }))
  },
  isSelfWrite: (path, disk) => tabs.isSelfWrite(path, disk),
  isPendingMove: (path) => tabs.isPendingMove(path),
  reload: (tabId) => tabs.reloadFromDisk(tabId),
  onConflict,
})

onMounted(() => {
  runtime.start()
  lifecycle.mount()
  dialogs.installPluginDeciders()
  void externalDocSync.start()
})

onBeforeUnmount(() => {
  externalDocSync.stop()
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
    :ai-write="aiPermission.pending"
    @toggle-sidebar="sidebarVisible = !sidebarVisible"
    @open-folder="onOpenFolder"
    @pick-folder="runtime.pickFolder"
    @open-settings="showSettings = true"
    @close-settings="showSettings = false"
    @close-conflict="dialogs.close"
    @reload-conflict-disk="onReloadConflictFromDisk"
    @respond-ai-write="(approved: boolean, remember: boolean) => aiPermission.respond(approved, remember)"
    @resolve-permission="dialogs.resolvePermission"
    @resolve-integrity="dialogs.resolveIntegrity"
    @toggle-rail="railOpen = !railOpen"
    @toggle-settings="showSettings = !showSettings"
  />
</template>
