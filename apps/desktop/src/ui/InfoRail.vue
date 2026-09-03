<script setup lang="ts">
import { ref } from 'vue'
import { X } from 'lucide-vue-next'
import ReferencesPanel from './ReferencesPanel.vue'
import HistoryPanel from './HistoryPanel.vue'
import OutlinePanel from './OutlinePanel.vue'
import FileTree from './FileTree.vue'
import ChatPanel from './ChatPanel.vue'
import ConflictDialog from '../components/ConflictDialog.vue'
import { useTabsStore } from '../stores/tabs'

const emit = defineEmits<{ (e: 'close'): void }>()
const tabs = useTabsStore()

const activeTab = ref<'ai' | 'outline' | 'refs' | 'history' | 'folders'>('ai')
const conflict = ref<{ tabId: string; path: string } | null>(null)

const TABS = [
  { id: 'ai', label: 'AI' },
  { id: 'outline', label: '大纲' },
  { id: 'refs', label: '引用' },
  { id: 'history', label: '历史' },
  { id: 'folders', label: '文件夹' },
] as const
</script>

<template>
  <aside class="info-rail">
    <div class="rail-header">
      <div class="rail-tabs">
        <button
          v-for="t in TABS"
          :key="t.id"
          class="rail-tab"
          :class="{ 'is-active': activeTab === t.id }"
          @click="activeTab = t.id"
        >
          {{ t.label }}
        </button>
      </div>
      <button
        class="rail-close"
        title="关闭"
        @click="emit('close')"
      >
        <X
          :size="14"
          :stroke-width="1.8"
        />
      </button>
    </div>
    <div class="rail-body">
      <ChatPanel v-show="activeTab === 'ai'" />
      <OutlinePanel v-show="activeTab === 'outline'" />
      <ReferencesPanel v-show="activeTab === 'refs'" />
      <HistoryPanel v-show="activeTab === 'history'" />
      <div
        v-show="activeTab === 'folders'"
        class="rail-folders"
      >
        <FileTree
          v-if="tabs.vault"
          :vault="tabs.vault"
          @conflict="conflict = $event"
        />
        <p
          v-else
          class="rail-empty"
        >
          打开文件夹后查看
        </p>
      </div>
      <ConflictDialog
        v-if="conflict"
        :tab-id="conflict.tabId"
        :path="conflict.path"
        @close="conflict = null"
      />
    </div>
  </aside>
</template>

<style scoped>
.info-rail {
  width: var(--app-rail-width);
  min-width: var(--app-rail-width);
  height: 100%;
  display: flex;
  flex-direction: column;
  background: var(--app-panel);
  border-left: 1px solid var(--app-border);
  overflow: hidden;
}
.rail-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 4px;
  height: 38px;
  flex: none;
  padding: 0 8px 0 8px;
  border-bottom: 1px solid var(--app-border);
  user-select: none;
}
.rail-tabs {
  display: flex;
  align-items: center;
  gap: 2px;
  min-width: 0;
}
.rail-tab {
  height: 26px;
  padding: 0 10px;
  border: none;
  border-radius: var(--app-radius-sm);
  background: transparent;
  color: var(--app-muted);
  font-family: var(--app-font);
  font-size: 12px;
  font-weight: 550;
  letter-spacing: -0.01em;
  cursor: pointer;
  transition: background var(--app-motion-fast) var(--app-ease),
              color var(--app-motion-fast) var(--app-ease);
}
.rail-tab:hover {
  color: var(--app-text);
  background: color-mix(in srgb, var(--app-elevated) 66%, transparent);
}
.rail-tab.is-active {
  color: var(--app-accent);
  background: color-mix(in srgb, var(--app-accent-soft) 72%, var(--app-elevated));
}
.rail-tab:focus-visible {
  outline: 2px solid var(--app-accent);
  outline-offset: 1px;
}
.rail-close {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border: none;
  border-radius: var(--app-radius-sm);
  background: transparent;
  color: var(--app-muted);
  cursor: pointer;
  transition: background var(--app-motion-fast) var(--app-ease),
              color var(--app-motion-fast) var(--app-ease);
}
.rail-close:hover {
  color: var(--app-text);
  background: color-mix(in srgb, var(--app-elevated) 66%, transparent);
}
.rail-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
}
.rail-folders {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
.rail-folders :deep(.file-tree) {
  flex: 1;
  min-height: 0;
  width: 100%;
  border-right: none;
  background: transparent;
}
.rail-empty {
  margin: 12px 14px;
  font-size: 11px;
  color: var(--app-muted);
}
</style>
