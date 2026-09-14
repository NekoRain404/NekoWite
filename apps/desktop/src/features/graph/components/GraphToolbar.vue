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
import { computed } from 'vue'
import SelectMenu, { type SelectOption } from '../../../components/SelectMenu.vue'
import { t } from '../../../i18n'
import type { LinkKindFilter } from '../composables/useGraphFilters'

const props = defineProps<{
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

// Each filter's first row is "no filter", which is the empty value the panel
// compares against — so it is a row like any other rather than a null state.
const capChoices = computed<SelectOption[]>(() => [
  { value: 0, label: t('graph.showFull') },
  { value: 200, label: '200' },
  { value: 500, label: '500' },
])
const dirChoices = computed<SelectOption[]>(() => [
  { value: '', label: t('graph.allDirs') },
  ...props.directories.map((dir) => ({ value: dir, label: dir || t('notelist.rootDir') })),
])
const tagChoices = computed<SelectOption[]>(() => [
  { value: '', label: t('graph.allTags') },
  ...props.tagOptions.map((tag) => ({ value: tag, label: tag })),
])
const linkChoices = computed<SelectOption[]>(() => [
  { value: 'all', label: t('graph.allLinks') },
  { value: 'wiki', label: t('graph.wikiLinks') },
  { value: 'markdown', label: t('graph.markdownLinks') },
])</script>

<template>
  <div class="graph-toolbar">
    <span
      class="graph-count"
      :class="{ 'is-loading': loading }"
    >{{ loading ? t('graph.reading') : failed ? t('graph.readFailed') : t('graph.count', { n: noteCount, m: edgeCount }) }}</span>
    <label
      class="graph-filter"
      :title="t('graph.capLabel')"
      for="graph-cap"
    >
      <SelectMenu
        id="graph-cap"
        class="graph-select"
        :model-value="capValue"
        :aria-label="t('graph.capLabel')"
        :options="capChoices"
        @update:model-value="capValue = $event as number"
      />
    </label>
    <label
      class="graph-filter"
      :title="t('graph.filterDir')"
      for="graph-filter-dir"
    >
      <SelectMenu
        id="graph-filter-dir"
        class="graph-select"
        :model-value="filterDir"
        :aria-label="t('graph.filterDir')"
        :options="dirChoices"
        @update:model-value="filterDir = $event as string"
      />
    </label>
    <label
      class="graph-filter"
      :title="t('graph.filterTag')"
      for="graph-filter-tag"
    >
      <SelectMenu
        id="graph-filter-tag"
        class="graph-select"
        :model-value="filterTag"
        :aria-label="t('graph.filterTag')"
        :options="tagChoices"
        @update:model-value="filterTag = $event as string"
      />
    </label>
    <label
      class="graph-filter"
      :title="t('graph.filterLink')"
      for="graph-filter-link"
    >
      <SelectMenu
        id="graph-filter-link"
        class="graph-select"
        :model-value="filterLink"
        :aria-label="t('graph.filterLink')"
        :options="linkChoices"
        @update:model-value="filterLink = $event as LinkKindFilter"
      />
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
