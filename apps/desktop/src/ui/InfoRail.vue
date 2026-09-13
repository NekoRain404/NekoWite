<script setup lang="ts">
import { computed, ref } from 'vue'
import { X } from 'lucide-vue-next'
import ReferencesPanel from './ReferencesPanel.vue'
import HistoryPanel from './HistoryPanel.vue'
import OutlinePanel from './OutlinePanel.vue'
import { ChatPanel } from '../features/chat'
import FrontmatterPanel from './FrontmatterPanel.vue'
import DocStatsPanel from './DocStatsPanel.vue'
import { t } from '../i18n'

const emit = defineEmits<{ (e: 'close'): void }>()

const activeTab = ref<'ai' | 'outline' | 'refs' | 'history' | 'meta' | 'stats'>('ai')

const TABS = computed(() => [
  { id: 'ai', label: t('rail.ai') },
  { id: 'outline', label: t('rail.outline') },
  { id: 'refs', label: t('rail.refs') },
  { id: 'history', label: t('rail.history') },
  { id: 'meta', label: t('rail.meta') },
  { id: 'stats', label: 'Stats' },
] as const)
</script>

<template>
  <aside class="info-rail">
    <div class="rail-header">
      <div
        class="rail-tabs"
        role="tablist"
        :aria-label="t('rail.bodyAria')"
      >
        <button
          v-for="tab in TABS"
          :key="tab.id"
          class="rail-tab"
          role="tab"
          :class="{ 'is-active': activeTab === tab.id }"
          :aria-selected="activeTab === tab.id"
          @click="activeTab = tab.id"
        >
          {{ tab.label }}
        </button>
      </div>
      <button
        class="rail-close"
        :title="t('rail.close')"
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
      <FrontmatterPanel v-show="activeTab === 'meta'" />
      <DocStatsPanel v-show="activeTab === 'stats'" />
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
</style>
