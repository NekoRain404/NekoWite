<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
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
import GhostWriter from './components/GhostWriter.vue'
import CommandPalette from './ui/CommandPalette.vue'
import { useTabsStore } from './stores/tabs'
import { useRefsStore } from './stores/refs'
import { useSettingsStore } from './stores/settings'
import { useAppearanceStore } from './stores/appearance'
import { useLibraryStore } from './stores/library'
import {
  RAIL_WIDTH_DEFAULT,
  RAIL_WIDTH_MAX,
  RAIL_WIDTH_MIN,
  SIDEBAR_WIDTH_DEFAULT,
  SIDEBAR_WIDTH_MAX,
  SIDEBAR_WIDTH_MIN,
} from './stores/appearance'
import { loadVaultPlugins } from './services/plugins'

const tabs = useTabsStore()
const refs = useRefsStore()
const settings = useSettingsStore()
const appearance = useAppearanceStore()
const library = useLibraryStore()
const vaultPath = ref<string | null>(null)
const showSettings = ref(false)
const sidebarVisible = ref(true)
const railOpen = ref(false)
const conflict = ref<{ tabId: string; path: string } | null>(null)

const theme = computed<string>(() => {
  void appearance.systemRevision
  return appearance.effectiveTheme()
})

const shellStyle = computed<Record<string, string>>(() => ({
  '--app-sidebar-width': `${appearance.sidebarWidth}px`,
  '--app-rail-width': `${appearance.railWidth}px`,
  '--app-notelist-width': '280px',
  '--app-body-size': `${appearance.bodyFontSize}px`,
  '--app-line-height': String(appearance.lineHeight),
}))

const activeTab = computed(() => tabs.activeTab)
const activeTitle = computed(() => {
  const path = activeTab.value?.path
  if (!activeTab.value) return '开始写作'
  return path ? path.split('/').pop() ?? path : '未命名'
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

let unlistenMedia: (() => void) | null = null

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
  void settings.loadKey().catch(() => {
    // stronghold init/key-file errors are surfaced by the settings panel; a
    // failed background load on startup should not reject the mount
  })
  const saved = localStorage.getItem('nekowite.vault')
  if (saved) applyVault(saved)
})

onBeforeUnmount(() => {
  unlistenMedia?.()
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
    :data-accent="appearance.accent"
  >
    <TitleBar
      :sidebar-visible="sidebarVisible"
      :title="activeTitle"
      :subtitle="activeSubtitle"
      @toggle-sidebar="sidebarVisible = !sidebarVisible"
    >
      <template #actions>
        <ViewSwitch />
        <button
          class="tb-action"
          :class="{ 'is-active': railOpen }"
          :title="railOpen ? '收起文档信息' : '文档信息（引用 / 历史）'"
          @click="railOpen = !railOpen"
        >
          <PanelRightClose
            v-if="railOpen"
            :size="16"
            :stroke-width="1.8"
          />
          <PanelRightOpen
            v-else
            :size="16"
            :stroke-width="1.8"
          />
        </button>
        <button
          class="tb-action"
          title="设置"
          @click="showSettings = !showSettings"
        >
          <Settings
            :size="16"
            :stroke-width="1.8"
          />
        </button>
      </template>
    </TitleBar>

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
        label="调整侧栏宽度"
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
            欢迎使用 NekoWite
          </p>
          <p class="onboard-hint">
            选择一个文件夹作为你的知识库，支持 Markdown、数学公式与文献引用。
          </p>
          <button
            class="btn btn-primary"
            @click="pickFolder"
          >
            打开文件夹
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
          label="调整文档信息栏宽度"
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

    <StatusBar />
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

.tb-action {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  padding: 0;
  border: none;
  border-radius: var(--app-radius-sm);
  background: transparent;
  color: var(--app-muted);
  cursor: pointer;
  transition: background var(--app-motion-fast) var(--app-ease),
              color var(--app-motion-fast) var(--app-ease);
}
.tb-action:hover {
  color: var(--app-text);
  background: color-mix(in srgb, var(--app-elevated) 62%, transparent);
}
.tb-action.is-active {
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
