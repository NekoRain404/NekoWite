<script setup lang="ts">
import { computed } from 'vue'
import { useTabsStore } from '../stores/tabs'
import { useViewStore } from '../stores/view'

const tabs = useTabsStore()
const view = useViewStore()

const VERSION = 'v0.1.0'

const wordCount = computed(() => {
  const c = tabs.activeTab?.content ?? ''
  return c.trim() ? c.trim().split(/\s+/).length : 0
})

const charCount = computed(() => (tabs.activeTab?.content ?? '').length)

const modeLabel = computed(() => {
  switch (view.mode) {
    case 'source': return 'Source'
    case 'rendered': return 'Rendered'
    case 'split': return 'Split'
    default: return view.mode
  }
})
</script>

<template>
  <footer class="status-bar">
    <span class="status-item">{{ wordCount }} words</span>
    <span class="status-item">{{ charCount }} chars</span>
    <span class="status-item">{{ tabs.activeTab?.dirty ? 'modified' : 'saved' }}</span>
    <span class="status-spacer" />
    <span class="status-item">View: {{ modeLabel }}</span>
    <span class="status-item">NekoWite {{ VERSION }}</span>
  </footer>
</template>

<style scoped>
.status-bar {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 3px 12px;
  border-top: 1px solid #e0e0e0;
  background: #f5f5f5;
  font-size: 12px;
  color: #666;
  min-height: 22px;
}
.status-item { white-space: nowrap; }
.status-spacer { flex: 1; }
</style>