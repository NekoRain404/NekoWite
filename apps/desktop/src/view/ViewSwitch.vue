<script setup lang="ts">
import { useViewStore } from '../stores/view'
import type { ViewMode } from '../stores/view'

const view = useViewStore()

interface ModeItem {
  key: ViewMode
  label: string
}

const modes: ModeItem[] = [
  { key: 'source', label: '源码' },
  { key: 'rendered', label: '渲染' },
  { key: 'split', label: '对照' },
]
</script>

<template>
  <div class="view-switch">
    <button
      v-for="m in modes"
      :key="m.key"
      class="vs-btn"
      :class="{ active: view.mode === m.key }"
      @click="view.setMode(m.key)"
    >
      {{ m.label }}
    </button>
  </div>
</template>

<style scoped>
.view-switch {
  display: flex;
  gap: 4px;
  padding: 4px 8px;
  border-bottom: 1px solid #e0e0e0;
  background: #fbfbfb;
}
.vs-btn {
  padding: 3px 12px;
  border: 1px solid #d0d0d0;
  background: #fff;
  border-radius: 4px;
  cursor: pointer;
  font-size: 12px;
  color: #444;
}
.vs-btn:hover { background: #f0f0f0; }
.vs-btn.active {
  background: #2563eb;
  border-color: #2563eb;
  color: #fff;
}
</style>