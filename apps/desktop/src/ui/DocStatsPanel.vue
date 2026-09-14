<script setup lang="ts">
import { computed } from 'vue'
import { storeToRefs } from 'pinia'
import { computeDocStats, type DocStats } from '../services/doc-stats'
import { useDocDerivedStore } from '../stores/doc-derived'
import { useSectionShown } from './use-section-shown'
import { t } from '../i18n'

const { sectionRef, shown } = useSectionShown()

/** Shared with the status bar and the word-goal widget (stores/docDerived.ts). */
const { stats: derived } = storeToRefs(useDocDerivedStore())

/** The reading of an empty document, shared by every hidden render. */
const NO_STATS: DocStats = computeDocStats('')

/**
 * The grid is only read while the rail shows this section, and this section
 * stays mounted while another one is on screen (the rail switches with
 * `v-show`), so it used to rescan the whole note on every typing pause for a
 * panel nobody was looking at. Becoming visible again reads the current text —
 * the gate caches nothing, it just does not ask.
 */
const stats = computed<DocStats>(() => (shown.value ? derived.value : NO_STATS))

const taskPct = computed(() => {
  if (!stats.value.taskTotal) return 0
  return Math.round((stats.value.taskDone / stats.value.taskTotal) * 100)
})
</script>

<template>
  <section
    :ref="sectionRef"
    class="doc-stats-panel"
  >
    <h3 class="rail-section-title">
      {{ t('docstats.title') }}
    </h3>
    <div class="stats-grid">
      <div class="stat-item">
        <span class="stat-label">{{ t('docstats.words') }}</span>
        <span class="stat-value">{{ stats.words }}</span>
      </div>
      <div class="stat-item">
        <span class="stat-label">{{ t('docstats.chars') }}</span>
        <span class="stat-value">{{ stats.chars }}</span>
      </div>
      <div class="stat-item">
        <span class="stat-label">{{ t('docstats.paragraphs') }}</span>
        <span class="stat-value">{{ stats.paragraphs }}</span>
      </div>
      <div class="stat-item">
        <span class="stat-label">{{ t('docstats.images') }}</span>
        <span class="stat-value">{{ stats.images }}</span>
      </div>
      <div class="stat-item">
        <span class="stat-label">{{ t('docstats.citations') }}</span>
        <span class="stat-value">{{ stats.citations }}</span>
      </div>
      <div class="stat-item">
        <span class="stat-label">{{ t('docstats.readMinutes') }}</span>
        <span class="stat-value">{{ stats.readMinutes }}m</span>
      </div>
    </div>
    <div
      v-if="stats.taskTotal"
      class="task-progress"
    >
      <div class="task-progress-head">
        <span class="stat-label">{{ t('docstats.tasks') }}</span>
        <span class="stat-value">{{ stats.taskDone }}/{{ stats.taskTotal }}</span>
      </div>
      <div class="task-bar">
        <div
          class="task-bar-fill"
          :class="{ 'is-done': taskPct === 100 }"
          :style="{ width: taskPct + '%' }"
        />
      </div>
    </div>
    <p
      v-else
      class="rail-empty"
    >
      {{ t('docstats.noTasks') }}
    </p>
  </section>
</template>

<style scoped>
.doc-stats-panel {
  padding: 12px 14px;
  border-bottom: 1px solid color-mix(in srgb, var(--app-border) 60%, transparent);
}
.rail-section-title {
  display: flex;
  align-items: center;
  gap: 6px;
  /* 8px, like the rail's other section titles: at 10px this panel's title stood
     2px further off its content than the sibling tabs it swaps with. */
  margin: 0 0 8px;
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.04em;
  color: var(--app-muted);
}
.stats-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 6px 12px;
}
.stat-item {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
  min-width: 0;
  font-size: 11px;
  line-height: 1.5;
}
.stat-label {
  color: var(--app-muted);
  white-space: nowrap;
}
.stat-value {
  color: var(--app-text);
  font-variant-numeric: tabular-nums;
  font-weight: 600;
  letter-spacing: -0.01em;
}
.task-progress {
  margin-top: 12px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.task-progress-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  font-size: 11px;
}
.task-bar {
  height: 4px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--app-border) 70%, transparent);
  overflow: hidden;
}
.task-bar-fill {
  height: 100%;
  border-radius: 999px;
  background: var(--app-accent);
  transition: width var(--app-motion-fast) var(--app-ease);
}
.task-bar-fill.is-done { background: var(--app-accent); }
.rail-empty {
  margin: 0;
  font-size: 11px;
  color: var(--app-muted);
}
</style>
