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
        class="save-dot"
        :data-state="tabs.saveStateOf(tab.id)"
        :class="{ 'is-shown': tabs.saveStateOf(tab.id) !== 'saved' }"
        :title="tabs.saveStateOf(tab.id) === 'saving' ? 'Saving…' : ''"
      />
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
  border-bottom: 1px solid var(--app-border);
  background: var(--app-panel);
  overflow-x: auto;
}
.tab {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 8px;
  border: 1px solid transparent;
  border-radius: var(--app-radius);
  cursor: pointer;
  font-size: 13px;
  background: transparent;
  color: var(--app-text);
}
.tab:hover { background: color-mix(in srgb, var(--app-elevated) 54%, transparent); }
.tab.active {
  background: var(--app-elevated);
  border-color: var(--app-border);
  font-weight: 600;
}
.tab-name { white-space: nowrap; }
.tab-close {
  border: none;
  background: transparent;
  cursor: pointer;
  font-size: 14px;
  line-height: 1;
  color: var(--app-muted);
  padding: 0 2px;
}
.tab-close:hover { color: var(--app-text); }
.new-tab {
  margin-left: 4px;
  border: 1px solid var(--app-border);
  background: var(--app-elevated);
  border-radius: var(--app-radius);
  cursor: pointer;
  font-size: 14px;
  padding: 2px 8px;
  color: var(--app-text);
}
.new-tab:hover { background: color-mix(in srgb, var(--app-elevated) 78%, var(--app-canvas)); }
</style>