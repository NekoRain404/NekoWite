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
      class="switch-option"
      :class="{ 'is-active': view.mode === m.key }"
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
  border-bottom: 1px solid var(--app-border);
  background: var(--app-canvas);
}
</style>