<script setup lang="ts">
import { GitCompareArrows } from 'lucide-vue-next'
import { useHistoryPanel } from './use-history-panel'
import DiffView from './DiffView.vue'
import { t } from '../i18n'
import { useTabsStore } from '../stores/tabs'

// The data layer lives in the composable (see useHistoryPanel.ts); this file is
// the markup, the styles and the wiring.
const {
  sectionRef,
  entries,
  loadFailed,
  comparing,
  historyText,
  hasDoc,
  load,
  restore,
  openCompare,
  closeCompare,
  restoreFromDiff,
  formatSize,
} = useHistoryPanel()

// The diff shows the CURRENT text against one old version, so it reads the live
// content of the note it belongs to.
const tabs = useTabsStore()
</script>

<template>
  <section
    :ref="sectionRef"
    class="history-panel"
  >
    <div class="history-header">
      <h3 class="rail-section-title">
        {{ t('history.title') }}
        <span
          v-if="entries.length"
          class="rail-section-count"
        >{{ entries.length }}</span>
      </h3>
      <button
        class="btn btn-ghost btn-sm btn-refresh"
        :title="t('history.refreshTitle')"
        @click="load"
      >
        {{ t('history.refresh') }}
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
          :title="e.id"
        >
          <span class="history-meta">
            <span class="history-time">{{ new Date(e.mtime).toLocaleString() }}</span>
            <span class="history-size">{{ formatSize(e.size) }}</span>
          </span>
          <code class="history-id">{{ e.id }}</code>
          <button
            class="btn btn-ghost btn-sm btn-compare"
            :title="t('history.compare')"
            @click="openCompare(e)"
          >
            <GitCompareArrows
              :size="12"
              :stroke-width="1.8"
            />
            {{ t('history.compare') }}
          </button>
          <button
            class="btn btn-secondary btn-sm btn-restore"
            @click="restore(e)"
          >
            {{ t('history.restore') }}
          </button>
        </li>
      </ul>
      <DiffView
        v-if="comparing && historyText"
        :current="tabs.activeTab?.content ?? ''"
        :history="historyText"
        :history-time="new Date(comparing.mtime).toLocaleString()"
        @restore="restoreFromDiff"
        @close="closeCompare"
      />
      <!-- Chained to the LIST's condition, not to the DiffView's: the v-else
           used to hang off the diff, so "no history yet" was printed under
           every populated history list. -->
      <p
        v-if="!entries.length && !(comparing && historyText)"
        class="rail-empty"
      >
        {{ loadFailed ? t('history.unreadable') : t('history.empty') }}
      </p>
    </template>
    <p
      v-else
      class="rail-empty"
    >
      {{ t('history.openDoc') }}
    </p>
  </section>
</template>

<style scoped>
.history-panel {
  padding: 12px 14px;
}
.history-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 8px;
}
.rail-section-title {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 0;
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.04em;
  color: var(--app-muted);
}
.rail-section-count {
  font-weight: 400;
  letter-spacing: 0;
  font-variant-numeric: tabular-nums;
}
.history-list {
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.history-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  border-radius: var(--app-radius-sm);
  transition: background var(--app-motion-fast) var(--app-ease);
}
.history-item:hover {
  background: color-mix(in srgb, var(--app-elevated) 66%, transparent);
}
.history-meta {
  display: flex;
  flex-direction: column;
  min-width: 0;
  flex: 1;
}
.history-time {
  font-size: 11px;
  color: var(--app-text);
  letter-spacing: -0.01em;
}
.history-size {
  font-size: 10px;
  color: var(--app-muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.history-id {
  display: none;
  font-size: 10px;
  color: var(--app-muted);
  font-family: var(--app-mono-font);
}
.rail-empty {
  margin: 0;
  font-size: 11px;
  color: var(--app-muted);
}
</style>
