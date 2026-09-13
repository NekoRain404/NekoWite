<script setup lang="ts">
/**
 * The graph panel's two toolbar rows: the count, the render cap and the three
 * filters, then the legend and the orphan/broken toggles.
 *
 * The rows render as siblings of the panel's other children - the panel is a
 * flex column, so a wrapper element would move the canvas - and the toolbar
 * holds no graph state of its own: every control it shows arrives as a `v-model`
 * the panel owns, and its two buttons only report what the user asked for
 * (§13.3: a section renders, the panel decides).
 */
import { t } from '../../../i18n'
import type { LinkKindFilter } from '../composables/useGraphFilters'

defineProps<{
  loading: boolean
  failed: boolean
  noteCount: number
  edgeCount: number
  /** Orphan (degree-0) nodes in the full graph. */
  orphanCount: number
  /** Unresolved link targets in the full graph. */
  brokenCount: number
  /** Distinct directories across the graph's nodes. */
  directories: string[]
  /** Distinct tags across the graph's notes. */
  tagOptions: string[]
}>()

const emit = defineEmits<{
  (e: 'reset-view'): void;
  (e: 'relayout'): void
}>()

/** Active node cap. 0 means "full vault" (render all). */
const capValue = defineModel<number>('capValue', { required: true })
const filterDir = defineModel<string>('filterDir', { required: true })
const filterTag = defineModel<string>('filterTag', { required: true })
const filterLink = defineModel<LinkKindFilter>('filterLink', { required: true })
const showOrphans = defineModel<boolean>('showOrphans', { required: true })
const showBroken = defineModel<boolean>('showBroken', { required: true })
</script>

<template>
  <div class="graph-toolbar">
    <span
      class="graph-count"
      :class="{ 'is-loading': loading }"
    >{{ loading ? t('graph.reading') : failed ? t('graph.readFailed') : t('graph.count', { n: noteCount, m: edgeCount }) }}</span>
    <label
      class="graph-filter"
      :title="t('graph.capLabel')"
    >
      <select
        v-model="capValue"
        class="graph-select"
        :aria-label="t('graph.capLabel')"
      >
        <option :value="0">{{ t('graph.showFull') }}</option>
        <option :value="200">200</option>
        <option :value="500">500</option>
      </select>
    </label>
    <label
      class="graph-filter"
      :title="t('graph.filterDir')"
    >
      <select
        v-model="filterDir"
        class="graph-select"
        :aria-label="t('graph.filterDir')"
      >
        <option value="">{{ t('graph.allDirs') }}</option>
        <option
          v-for="d in directories"
          :key="d"
          :value="d"
        >{{ d || t('notelist.rootDir') }}</option>
      </select>
    </label>
    <label
      class="graph-filter"
      :title="t('graph.filterTag')"
    >
      <select
        v-model="filterTag"
        class="graph-select"
        :aria-label="t('graph.filterTag')"
      >
        <option value="">{{ t('graph.allTags') }}</option>
        <option
          v-for="tag in tagOptions"
          :key="tag"
          :value="tag"
        >{{ tag }}</option>
      </select>
    </label>
    <label
      class="graph-filter"
      :title="t('graph.filterLink')"
    >
      <select
        v-model="filterLink"
        class="graph-select"
        :aria-label="t('graph.filterLink')"
      >
        <option value="all">{{ t('graph.allLinks') }}</option>
        <option value="wiki">{{ t('graph.wikiLinks') }}</option>
        <option value="markdown">{{ t('graph.markdownLinks') }}</option>
      </select>
    </label>
    <button
      class="graph-btn"
      :disabled="noteCount === 0"
      :title="t('graph.resetViewTitle')"
      @click="emit('reset-view')"
    >
      {{ t('graph.resetView') }}
    </button>
  </div>
  <div class="graph-toolbar graph-toolbar-alt">
    <span
      class="graph-legend"
      :title="t('graph.legend')"
    >
      <span class="legend-dot legend-orphan" />{{ t('graph.orphansCount', { n: orphanCount }) }}
    </span>
    <span
      class="graph-legend"
      :title="t('graph.legend')"
    >
      <span class="legend-dot legend-broken" />{{ t('graph.brokenLinksCount', { n: brokenCount }) }}
    </span>
    <label class="graph-toggle">
      <input
        v-model="showOrphans"
        type="checkbox"
      >{{ t('graph.showOrphans') }}
    </label>
    <label class="graph-toggle">
      <input
        v-model="showBroken"
        type="checkbox"
      >{{ t('graph.showBroken') }}
    </label>
    <button
      class="graph-btn"
      :disabled="loading || noteCount === 0"
      :title="t('graph.relayoutTitle')"
      @click="emit('relayout')"
    >
      {{ t('graph.relayout') }}
    </button>
  </div>
</template>

<style scoped>
.graph-toolbar {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}
.graph-toolbar-alt {
  margin-top: -4px;
}
.graph-count {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.04em;
  color: var(--app-muted);
  font-variant-numeric: tabular-nums;
}
.graph-count.is-loading {
  color: var(--app-muted);
}
.graph-btn {
  flex: none;
  padding: 3px 9px;
  border: 1px solid var(--app-border);
  border-radius: var(--app-radius-sm);
  background: transparent;
  color: var(--app-text);
  font-family: var(--app-font);
  font-size: 11px;
  line-height: 1.5;
  cursor: pointer;
  transition: background var(--app-motion-fast) var(--app-ease),
              border-color var(--app-motion-fast) var(--app-ease);
}
.graph-btn:hover:not(:disabled) {
  background: color-mix(in srgb, var(--app-elevated) 66%, transparent);
  border-color: color-mix(in srgb, var(--app-muted) 55%, var(--app-border));
}
.graph-btn:disabled {
  opacity: 0.55;
  cursor: default;
}
.graph-btn:focus-visible {
  outline: 2px solid var(--app-accent);
  outline-offset: 1px;
}
.graph-filter {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
.graph-select {
  height: 24px;
  max-width: 130px;
  padding: 0 6px;
  border: 1px solid var(--app-border);
  border-radius: var(--app-radius-sm);
  background: color-mix(in srgb, var(--app-elevated) 60%, var(--app-panel));
  color: var(--app-text);
  font-family: var(--app-font);
  font-size: 11px;
  line-height: 1.5;
  cursor: pointer;
}
.graph-select:focus-visible {
  outline: 2px solid var(--app-accent);
  outline-offset: 1px;
}
.graph-legend {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.03em;
  color: var(--app-muted);
  font-variant-numeric: tabular-nums;
}
.legend-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  display: inline-block;
}
.legend-orphan {
  background: var(--app-muted);
}
.legend-broken {
  background: color-mix(in srgb, var(--app-accent) 60%, transparent);
  box-shadow: 0 0 0 1px var(--app-border);
}
.graph-toggle {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 10px;
  font-weight: 550;
  color: var(--app-muted);
  cursor: pointer;
}
.graph-toggle input {
  margin: 0;
  accent-color: var(--app-accent);
  cursor: pointer;
}
</style>
