<script setup lang="ts">
import { onMounted, ref, watch } from 'vue'
import { fsService } from '../services/fs'
import { notifyError } from '../services/errors'
import { useTabsStore } from '../stores/tabs'
import type { HistoryEntry } from '../services/gateways/contracts'

const tabs = useTabsStore()
const entries = ref<HistoryEntry[]>([])

function hasDoc(): boolean {
  return Boolean(tabs.vault && tabs.activeTab?.path)
}

async function load(): Promise<void> {
  const tab = tabs.activeTab
  if (!tab?.path || !tabs.vault) {
    entries.value = []
    return
  }
  try {
    entries.value = await fsService.listHistory(tabs.vault, tab.path)
  } catch {
    notifyError('无法读取历史版本')
    entries.value = []
  }
}

watch(
  [() => tabs.activeId, () => tabs.activeTab?.path, () => tabs.activeTab?.content],
  () => {
    void load()
  },
)

async function restore(entry: HistoryEntry): Promise<void> {
  const tab = tabs.activeTab
  if (!tab?.path) return
  const content = await tabs.restoreHistoryToActive(tab.id, entry.id)
  if (content === null) {
    notifyError('恢复历史版本失败')
    return
  }
  // The content watcher also refreshes the list on restore; the explicit
  // reload below keeps the panel in sync even if the restored content equals
  // the current content (no reactive change).
  await load()
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

onMounted(() => {
  void load()
})
</script>

<template>
  <section class="history-panel">
    <div class="history-header">
      <h3>历史版本</h3>
      <button
        class="btn btn-secondary btn-sm btn-refresh"
        title="Refresh history"
        @click="load"
      >
        刷新
      </button>
    </div>
    <template v-if="hasDoc()">
      <ul
        v-if="entries.length"
        class="history-list"
      >
        <li
          v-for="e in entries"
          :key="e.id"
          class="history-item"
        >
          <span class="history-meta">
            <span class="history-time">{{ new Date(e.mtime).toLocaleString() }}</span>
            <span class="history-size">{{ formatSize(e.size) }}</span>
          </span>
          <code class="history-id">{{ e.id }}</code>
          <button
            class="btn btn-secondary btn-sm"
            @click="restore(e)"
          >
            恢复
          </button>
        </li>
      </ul>
      <p
        v-else
        class="history-empty"
      >
        暂无历史版本
      </p>
    </template>
    <p
      v-else
      class="history-empty"
    >
      打开文档以查看历史版本
    </p>
  </section>
</template>

<style scoped>
.history-panel {
  border-top: 1px solid var(--app-border);
  padding: 10px;
  max-height: 220px;
  overflow: auto;
  background: var(--app-elevated);
}
.history-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 6px;
}
.history-panel h3 {
  color: var(--app-text);
  font-size: 13px;
  margin: 0;
}
.history-list {
  margin: 0;
  padding: 0;
  list-style: none;
  font-size: 12px;
  color: var(--app-text);
}
.history-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 0;
  border-bottom: 1px solid var(--app-border);
}
.history-item:last-child {
  border-bottom: none;
}
.history-meta {
  display: flex;
  flex-direction: column;
  min-width: 0;
}
.history-time {
  font-size: 12px;
  color: var(--app-text);
}
.history-size {
  font-size: 11px;
  color: var(--app-muted);
}
.history-id {
  margin-left: auto;
  font-size: 11px;
  color: var(--app-muted);
  font-family: ui-monospace, monospace;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.history-empty {
  color: var(--app-muted);
  font-size: 12px;
}
</style>
