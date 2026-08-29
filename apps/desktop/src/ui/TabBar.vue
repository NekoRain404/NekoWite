<script setup lang="ts">
import { useTabsStore } from '../stores/tabs'

const tabs = useTabsStore()
</script>

<template>
  <div class="tab-bar">
    <div
      v-for="tab in tabs.tabs"
      :key="tab.id"
      class="tab"
      :class="{ active: tab.id === tabs.activeId }"
      @click="tabs.setActive(tab.id)"
    >
      <span class="tab-name">{{ tab.path ? tab.path.split('/').pop() : 'untitled' }}</span>
      <span
        v-if="tab.dirty"
        class="tab-dirty"
      >●</span>
      <button
        class="tab-close"
        title="Close tab"
        @click.stop="tabs.closeTab(tab.id)"
      >
        ×
      </button>
    </div>
    <button
      class="new-tab"
      title="New file"
      @click="tabs.openTab(null)"
    >
      +
    </button>
  </div>
</template>

<style scoped>
.tab-bar {
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 4px 6px;
  border-bottom: 1px solid #e0e0e0;
  background: #f5f5f5;
  overflow-x: auto;
}
.tab {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 8px;
  border: 1px solid transparent;
  border-radius: 4px;
  cursor: pointer;
  font-size: 13px;
  background: transparent;
  color: #333;
}
.tab:hover { background: #ececec; }
.tab.active { background: #fff; border-color: #d0d0d0; font-weight: 600; }
.tab-name { white-space: nowrap; }
.tab-dirty { color: #e67e22; font-size: 10px; }
.tab-close {
  border: none;
  background: transparent;
  cursor: pointer;
  font-size: 14px;
  line-height: 1;
  color: #999;
  padding: 0 2px;
}
.tab-close:hover { color: #333; }
.new-tab {
  margin-left: 4px;
  border: 1px solid #ccc;
  background: #fff;
  border-radius: 4px;
  cursor: pointer;
  font-size: 14px;
  padding: 2px 8px;
}
.new-tab:hover { background: #ececec; }
</style>