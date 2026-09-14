<script lang="ts">
import type { Component } from 'vue'

/** One entry of the notes / outline / links switch. */
export interface NoteListMode {
  id: 'notes' | 'outline' | 'links'
  label: string
  icon: Component
}
</script>

<script setup lang="ts">
/**
 * The note list's header: the mode switch (or the placeholder title of a column
 * the app does not fill yet), the search box, the count and index state, the
 * sort control with its menu, and the truncation notice.
 *
 * Its parts render as siblings of the panel, not inside a wrapper element: the
 * panel is a flex column whose children are laid out in order, so a wrapper
 * would change where the list and the search box sit on screen. The component
 * only reports what the user picked — which mode, which sort key — and the list
 * decides what that means.
 */
import { computed, ref } from 'vue'
import { ArrowDownWideNarrow, BookOpen, Link2, ListTree } from 'lucide-vue-next'
import ContextMenu from '../../../ui/ContextMenu.vue'
import type { ContextMenuItem } from '../../../ui/ContextMenu.vue'
import NoteSearch from './NoteSearch.vue'
import { t } from '../../../i18n'
import type { ListView, PanelMode } from '../../../stores/document-list'
import type { IndexState } from '../../search'
import type { SortBy } from '../services/note-query'

const props = defineProps<{
  listView: ListView
  panelMode: PanelMode
  query: string
  contentEnabled: boolean
  indexing: boolean
  /** How many notes the query matches. */
  noteCount: number
  /** How many content matches the last run found. */
  contentCount: number
  indexState: IndexState
  indexStatusLabel: string
  showIndexStatus: boolean
  sortOrder: SortBy
  vaultTruncated: boolean
}>()

const emit = defineEmits<{
  (e: 'set-mode', mode: PanelMode): void
  (e: 'search', value: string): void
  (e: 'toggle-content'): void
  (e: 'rebuild-index'): void
  (e: 'set-sort', sortBy: SortBy): void
}>()

const MODES: readonly NoteListMode[] = [
  { id: 'notes', label: t('notelist.notes'), icon: BookOpen },
  { id: 'outline', label: t('notelist.outline'), icon: ListTree },
  { id: 'links', label: t('notelist.links'), icon: Link2 },
]

const PLACEHOLDER_TITLES: Record<string, string> = {
  graph: 'graph',
  attachments: 'attachments',
  index: 'index',
  cloud: 'cloud',
}

/** The column headings that exist even when the app has nothing to put under
 *  them yet (the folders panel is a real view and has none). */
const placeholder = computed(() => PLACEHOLDER_TITLES[props.listView] ?? '')
const headerVisible = computed(() => props.listView === 'notes' || placeholder.value !== '')

/** Search, count, index state and sort belong to the notes list itself; the
 *  embeds (graph, attachments, folders) have their own chrome. */
const notesVisible = computed(() => props.listView === 'notes' && props.panelMode === 'notes')

const countText = computed(() => {
  if (props.indexing) return t('notelist.indexing')
  if (props.contentEnabled) return t('notelist.contentCount', { n: props.contentCount })
  return t('notelist.count', { n: props.noteCount })
})

const sortMenu = ref<{ x: number; y: number } | null>(null)

const sortMenuItems = computed<ContextMenuItem[]>(() => [
  { id: 'mtime', label: t('notelist.sortMtime') },
  { id: 'title', label: t('notelist.sortTitleField') },
  { id: 'name', label: t('notelist.sortName') },
])

const sortLabel = computed(() => {
  switch (props.sortOrder) {
    case 'mtime': return t('notelist.sortMtimeLabel')
    case 'title': return t('notelist.sortTitleLabel')
    case 'name': return t('notelist.sortNameLabel')
    default: return ''
  }
})

function openSortMenu(e: MouseEvent): void {
  const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
  sortMenu.value = { x: rect.left, y: rect.bottom + 4 }
}

function onSortSelect(id: string): void {
  if (id === 'mtime' || id === 'title' || id === 'name') emit('set-sort', id)
}
</script>

<template>
  <header
    v-if="headerVisible"
    class="nl-header"
  >
    <div
      v-if="props.listView === 'notes'"
      class="nl-switch"
      role="tablist"
    >
      <button
        v-for="m in MODES"
        :key="m.id"
        class="switch-option nl-mode-btn"
        :class="{ 'is-active': props.panelMode === m.id }"
        role="tab"
        :aria-selected="props.panelMode === m.id"
        @click="emit('set-mode', m.id)"
      >
        <component
          :is="m.icon"
          :size="13"
          :stroke-width="1.8"
        />
        <span>{{ m.label }}</span>
      </button>
    </div>
    <h2
      v-else
      class="nl-placeholder-title"
    >
      {{ t(`notelist.${placeholder}`) }}
    </h2>
  </header>

  <NoteSearch
    v-if="notesVisible"
    :query="props.query"
    :content-enabled="props.contentEnabled"
    @search="emit('search', $event)"
    @toggle-content="emit('toggle-content')"
  />

  <div
    v-if="notesVisible"
    class="nl-meta"
  >
    <span class="nl-count">{{ countText }}</span>
    <span
      v-if="props.showIndexStatus"
      class="nl-index"
      :class="`is-${props.indexState}`"
      :title="t('notelist.indexStateTitle', { state: props.indexStatusLabel })"
    >
      {{ props.indexStatusLabel }}
    </span>
    <button
      v-if="props.indexState === 'stale' || props.indexState === 'needs-rebuild'"
      class="nl-index-rebuild"
      :title="t('notelist.rebuildIndexTitle')"
      @click="emit('rebuild-index')"
    >
      {{ t('notelist.rebuildIndex') }}
    </button>
    <button
      class="nl-sort"
      :title="t('notelist.sortTitle', { label: sortLabel })"
      aria-haspopup="menu"
      @click="openSortMenu"
    >
      <ArrowDownWideNarrow
        :size="13"
        :stroke-width="1.8"
      />
      <span>{{ sortLabel }}</span>
    </button>
  </div>

  <p
    v-if="notesVisible && props.vaultTruncated && !props.indexing"
    class="nl-truncated"
    role="status"
    :title="t('notelist.vaultTruncated')"
  >
    {{ t('notelist.vaultTruncated') }}
  </p>

  <!-- The exit. A context menu is mounted with `v-if` in every host, so its
       own leave rule never ran and it was gone in the frame the user acted;
       `<Transition>` keeps the node mounted for that rule and nothing else
       changes. See `ui/ContextMenu.vue` for the selectors that had to
       out-specify its own `.is-open`. -->
  <Transition name="ctx">
    <ContextMenu
      v-if="sortMenu"
      :x="sortMenu.x"
      :y="sortMenu.y"
      :items="sortMenuItems"
      @select="onSortSelect"
      @close="sortMenu = null"
    />
  </Transition>
</template>

<style scoped>
.nl-header {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 10px 10px 6px;
  min-height: 40px;
}
.nl-switch {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  padding: 3px;
  border-radius: var(--app-radius-lg);
  background: color-mix(in srgb, var(--app-elevated) 55%, var(--app-panel));
  border: 1px solid color-mix(in srgb, var(--app-border) 48%, transparent);
}
.nl-mode-btn {
  height: 26px;
  padding: 0 10px;
  gap: 5px;
  font-size: 11.5px;
  border-radius: var(--app-radius);
}
.nl-mode-btn :deep(svg) {
  flex: none;
}
.nl-placeholder-title {
  margin: 0;
  font-size: 13px;
  font-weight: 650;
  letter-spacing: -0.01em;
  color: var(--app-text);
}

.nl-meta {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 14px 6px;
}
.nl-count {
  font-size: 11px;
  font-weight: 500;
  color: var(--app-muted);
  font-variant-numeric: tabular-nums;
}
.nl-index {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 7px;
  border-radius: 999px;
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.01em;
  color: color-mix(in srgb, var(--app-accent) 88%, var(--app-muted));
  background: color-mix(in srgb, var(--app-accent-soft) 60%, transparent);
}
.nl-index.is-building {
  color: var(--app-muted);
  background: color-mix(in srgb, var(--app-elevated) 70%, transparent);
}
.nl-index.is-stale,
.nl-index.is-needs-rebuild {
  color: color-mix(in srgb, #d97706 80%, var(--app-text));
  background: color-mix(in srgb, #d97706 14%, transparent);
}
.nl-index-rebuild {
  flex: none;
  height: 22px;
  padding: 0 8px;
  border: 1px solid color-mix(in srgb, var(--app-border) 80%, transparent);
  border-radius: var(--app-radius-sm);
  background: transparent;
  color: var(--app-muted);
  font-family: var(--app-font);
  font-size: 10.5px;
  font-weight: 550;
  cursor: pointer;
  transition: background var(--app-motion-fast) var(--app-ease),
              color var(--app-motion-fast) var(--app-ease);
}
.nl-index-rebuild:hover {
  color: var(--app-text);
  background: color-mix(in srgb, var(--app-elevated) 66%, transparent);
}
.nl-truncated {
  margin: 0 12px 4px;
  padding: 5px 9px;
  border: 1px solid color-mix(in srgb, #d97706 45%, transparent);
  border-radius: var(--app-radius-sm);
  background: color-mix(in srgb, #d97706 12%, transparent);
  color: color-mix(in srgb, #d97706 82%, var(--app-text));
  font-size: 10.5px;
  font-weight: 550;
  line-height: 1.4;
}
.nl-sort {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 24px;
  padding: 0 8px;
  border: none;
  border-radius: var(--app-radius-sm);
  background: transparent;
  color: var(--app-muted);
  font-family: var(--app-font);
  font-size: 11px;
  font-weight: 550;
  letter-spacing: -0.01em;
  cursor: pointer;
  transition: background var(--app-motion-fast) var(--app-ease),
              color var(--app-motion-fast) var(--app-ease);
}
.nl-sort:hover {
  color: var(--app-text);
  background: color-mix(in srgb, var(--app-elevated) 66%, transparent);
}
.nl-sort:focus-visible {
  outline: 2px solid var(--app-accent);
  outline-offset: 1px;
}
</style>
