<script setup lang="ts">
import { onMounted, ref } from 'vue'
import FileTree from './ui/FileTree.vue'
import RefSidebar from './ui/RefSidebar.vue'
import ReferencesPanel from './ui/ReferencesPanel.vue'
import TabBar from './ui/TabBar.vue'
import StatusBar from './ui/StatusBar.vue'
import SettingsPanel from './ui/SettingsPanel.vue'
import EditorPane from './ui/EditorPane.vue'
import Toast from './components/AppToast.vue'
import ConflictDialog from './components/ConflictDialog.vue'
import { useTabsStore } from './stores/tabs'
import { useRefsStore } from './stores/refs'
import { loadVaultPlugins } from './services/plugins'

const tabs = useTabsStore()
const refs = useRefsStore()
const vaultPath = ref<string | null>(null)
const showSettings = ref(false)
const conflict = ref<{ tabId: string; path: string } | null>(null)

function applyVault(path: string): void {
  vaultPath.value = path
  tabs.setVault(path)
  void loadVaultPlugins(path)
  void refs.loadVault(path)
}

onMounted(() => {
  const saved = localStorage.getItem('nekowite.vault')
  if (saved) applyVault(saved)
})

function onOpenFolder(path: string): void {
  localStorage.setItem('nekowite.vault', path)
  applyVault(path)
}

function onConflict(req: { tabId: string; path: string }): void {
  conflict.value = req
}
</script>

<template>
  <div class="shell">
    <header class="shell-header">
      <span class="app-title">NekoWite</span>
      <button
        class="header-btn"
        title="Settings"
        @click="showSettings = !showSettings"
      >
        Settings
      </button>
    </header>
    <div class="shell-body">
      <FileTree
        v-if="vaultPath"
        :vault="vaultPath"
        @open-folder="onOpenFolder"
        @conflict="onConflict"
      />
      <RefSidebar />
      <section class="main">
        <TabBar />
        <EditorPane />
        <ReferencesPanel />
      </section>
    </div>
    <StatusBar />
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
}
.shell-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 12px;
  border-bottom: 1px solid #e0e0e0;
  background: #fafafa;
}
.app-title { font-weight: 700; font-size: 14px; }
.header-btn {
  border: 1px solid #ccc;
  background: #fff;
  padding: 4px 10px;
  border-radius: 4px;
  cursor: pointer;
  font-size: 12px;
}
.header-btn:hover { background: #f0f0f0; }
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
  flex-direction: column;
  min-height: 0;
  overflow: hidden;
}
</style>