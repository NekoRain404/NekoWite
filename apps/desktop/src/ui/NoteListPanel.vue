<script setup lang="ts">
import { computed, ref } from 'vue'
import {
  ArrowDownWideNarrow,
  BookOpen,
  Link2,
  ListTree,
  Search,
} from 'lucide-vue-next'
import { splitFrontmatter } from '@nekowite/editor-core'
import NoteCard from './NoteCard.vue'
import GraphPanel from './GraphPanel.vue'
import AttachmentsPanel from './AttachmentsPanel.vue'
import FileTree from './FileTree.vue'
import ContextMenu from './ContextMenu.vue'
import type { ContextMenuItem } from './ContextMenu.vue'
import ConflictDialog from '../components/ConflictDialog.vue'
import { useLibraryStore } from '../stores/library'
import { useTabsStore } from '../stores/tabs'
import { useViewStore } from '../stores/view'
import { parseOutline } from '../services/outline'
import { dirRelativeToVault } from '../services/noteMeta'

const library = useLibraryStore()
const tabs = useTabsStore()
const view = useViewStore()

const sortMenu = ref<{ x: number; y: number } | null>(null)
const conflict = ref<{ tabId: string; path: string } | null>(null)

const MODES = [
  { id: 'notes', label: '笔记', icon: BookOpen },
  { id: 'outline', label: '大纲', icon: ListTree },
  { id: 'links', label: '链接', icon: Link2 },
] as const

const PLACEHOLDER_TITLES: Record<string, string> = {
  graph: '知识图谱',
  attachments: '附件',
  index: '索引',
  cloud: '云同步',
}

const activeTab = computed(() => tabs.activeTab)
const activePath = computed(() => activeTab.value?.path ?? null)

const relDir = computed(() => {
  const path = activePath.value
  if (!path || !library.vault) return ''
  return dirRelativeToVault(path, library.vault)
})

const outlineItems = computed(() => {
  const tab = activeTab.value
  if (!tab) return []
  const { body } = splitFrontmatter(tab.content)
  return parseOutline(body)
})

const links = computed(() => {
  const tab = activeTab.value
  if (!tab || !tab.path) return { out: [], back: [] }
  return {
    out: library.outlinksOf(relDir.value, tab.content),
    back: library.inlinksOf(relPath(tab.path)),
  }
})

function relPath(path: string): string | null {
  if (!library.vault) return null
  const dir = dirRelativeToVault(path, library.vault)
  const name = path.split('/').pop() ?? path
  return dir ? `${dir}/${name}` : name
}

const sortMenuItems = computed<ContextMenuItem[]>(() => [
  { id: 'mtime', label: '按修改时间' },
  { id: 'title', label: '按标题' },
  { id: 'name', label: '按文件名' },
])

const sortLabel = computed(() => {
  switch (library.sortBy) {
    case 'mtime': return '修改时间'
    case 'title': return '标题'
    case 'name': return '文件名'
    default: return ''
  }
})

function openSortMenu(e: MouseEvent): void {
  const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
  sortMenu.value = { x: rect.left, y: rect.bottom + 4 }
}

function onSortSelect(id: string): void {
  if (id === 'mtime' || id === 'title' || id === 'name') library.setSortBy(id)
}

function openNote(path: string | null): void {
  if (!path) return
  void tabs.openTab(path)
}

function jumpOutline(line: number, index: number): void {
  view.requestOutlineTarget({ line, index })
}
</script>

<template>
  <section class="note-list">
    <header
      v-if="library.listView === 'notes' || PLACEHOLDER_TITLES[library.listView]"
      class="nl-header"
    >
      <div
        v-if="library.listView === 'notes'"
        class="nl-switch"
        role="tablist"
      >
        <button
          v-for="m in MODES"
          :key="m.id"
          class="switch-option nl-mode-btn"
          :class="{ 'is-active': library.panelMode === m.id }"
          role="tab"
          :aria-selected="library.panelMode === m.id"
          @click="library.setPanelMode(m.id)"
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
        {{ PLACEHOLDER_TITLES[library.listView] }}
      </h2>
    </header>

    <div
      v-if="library.listView === 'graph'"
      class="nl-embed"
    >
      <GraphPanel />
    </div>

    <div
      v-else-if="library.listView === 'attachments'"
      class="nl-embed"
    >
      <AttachmentsPanel />
    </div>

    <div
      v-else-if="library.listView === 'folders'"
      class="nl-embed"
    >
      <FileTree
        v-if="tabs.vault"
        :vault="tabs.vault"
        @conflict="conflict = $event"
      />
      <p
        v-else
        class="empty-hint"
      >
        打开文件夹后查看
      </p>
    </div>

    <div
      v-else-if="library.listView !== 'notes'"
      class="nl-body nl-empty"
    >
      <p class="empty-hint">
        即将支持
      </p>
    </div>

    <template v-else-if="library.panelMode === 'notes'">
      <label class="nl-search">
        <Search
          class="nl-search-icon"
          :size="14"
          :stroke-width="1.8"
        />
        <input
          :value="library.query"
          class="nl-search-input"
          type="text"
          placeholder="搜索笔记…"
          @input="library.setQuery(($event.target as HTMLInputElement).value)"
        >
      </label>
      <div class="nl-meta">
        <span class="nl-count">{{ library.indexing ? '正在建立索引…' : `${library.visibleNotes.length} 篇笔记` }}</span>
        <button
          class="nl-sort"
          :title="`排序：${sortLabel}`"
          @click="openSortMenu"
        >
          <ArrowDownWideNarrow
            :size="13"
            :stroke-width="1.8"
          />
          <span>{{ sortLabel }}</span>
        </button>
      </div>
      <div class="nl-cards">
        <NoteCard
          v-for="note in library.visibleNotes"
          :key="note.path"
          :note="note"
          :active="note.path === activePath"
          :favorite="library.isFavorite(note.path)"
          @open="openNote(note.path)"
          @toggle-favorite="library.toggleFavorite(note.path)"
        />
        <p
          v-if="!library.indexing && library.visibleNotes.length === 0"
          class="nl-empty-hint"
        >
          没有匹配的笔记
        </p>
      </div>
    </template>

    <div
      v-else-if="library.panelMode === 'outline'"
      class="nl-body"
    >
      <template v-if="activeTab">
        <button
          v-for="item in outlineItems"
          :key="item.index"
          class="outline-item"
          :style="{ paddingLeft: `${8 + Math.max(0, item.level - 1) * 12}px` }"
          :title="`跳转到第 ${item.line + 1} 行`"
          @click="jumpOutline(item.line, item.index)"
        >
          <span class="outline-mark" />
          <span class="outline-text">{{ item.text || '（空标题）' }}</span>
        </button>
        <p
          v-if="outlineItems.length === 0"
          class="nl-empty-hint"
        >
          当前文档没有标题
        </p>
      </template>
      <p
        v-else
        class="nl-empty-hint"
      >
        打开一篇笔记后查看大纲
      </p>
    </div>

    <div
      v-else-if="library.panelMode === 'links'"
      class="nl-body"
    >
      <template v-if="activeTab">
        <p class="nl-group-label">
          出链
        </p>
        <button
          v-for="link in links.out"
          :key="`out-${link.target}-${link.text}`"
          class="link-item"
          :class="{ missing: !link.path }"
          :disabled="!link.path"
          @click="openNote(link.path)"
        >
          <span class="link-text">{{ link.text || link.target }}</span>
          <span class="link-target">{{ link.target }}</span>
        </button>
        <p
          v-if="links.out.length === 0"
          class="nl-empty-hint"
        >
          当前文档没有出链
        </p>
        <p class="nl-group-label">
          入链
        </p>
        <button
          v-for="note in links.back"
          :key="`back-${note.path}`"
          class="link-item"
          @click="openNote(note.path)"
        >
          <span class="link-text">{{ note.title }}</span>
          <span class="link-target">{{ note.dir || '根目录' }}</span>
        </button>
        <p
          v-if="links.back.length === 0"
          class="nl-empty-hint"
        >
          暂时没有笔记引用当前文档
        </p>
      </template>
      <p
        v-else
        class="nl-empty-hint"
      >
        打开一篇笔记后查看链接
      </p>
    </div>

    <ContextMenu
      v-if="sortMenu"
      :x="sortMenu.x"
      :y="sortMenu.y"
      :items="sortMenuItems"
      @select="onSortSelect"
      @close="sortMenu = null"
    />

    <ConflictDialog
      v-if="conflict"
      :tab-id="conflict.tabId"
      :path="conflict.path"
      @close="conflict = null"
    />
  </section>
</template>

<style scoped>
.note-list {
  width: var(--app-notelist-width);
  min-width: var(--app-notelist-width);
  height: 100%;
  display: flex;
  flex-direction: column;
  background: var(--app-panel);
  border-right: 1px solid var(--app-border);
  overflow: hidden;
  user-select: none;
}

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

.nl-embed {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.nl-embed :deep(.graph-panel),
.nl-embed :deep(.attachments-panel) {
  height: 100%;
  padding: 6px 8px;
}
.nl-embed :deep(.file-tree) {
  height: 100%;
  flex: 1;
  min-height: 0;
  width: 100%;
  border-right: none;
  background: transparent;
}

.nl-search {
  position: relative;
  display: block;
  margin: 4px 12px 0;
}
.nl-search-icon {
  position: absolute;
  left: 9px;
  top: 50%;
  transform: translateY(-50%);
  color: var(--app-muted);
  pointer-events: none;
}
.nl-search-input {
  width: 100%;
  height: 30px;
  padding: 0 10px 0 28px;
  font-family: var(--app-font);
  font-size: 12px;
  font-weight: 450;
  letter-spacing: -0.01em;
  color: var(--app-text);
  background: color-mix(in srgb, var(--app-elevated) 42%, var(--app-panel));
  border: 1px solid color-mix(in srgb, var(--app-border) 54%, transparent);
  border-radius: var(--app-radius-lg);
  outline: none;
  transition: border-color var(--app-motion-fast) var(--app-ease),
              background var(--app-motion-fast) var(--app-ease),
              box-shadow var(--app-motion-fast) var(--app-ease);
}
.nl-search-input::placeholder { color: color-mix(in srgb, var(--app-muted) 82%, transparent); }
.nl-search-input:hover {
  border-color: color-mix(in srgb, var(--app-border) 88%, transparent);
}
.nl-search-input:focus {
  border-color: color-mix(in srgb, var(--app-accent) 55%, var(--app-border));
  background: color-mix(in srgb, var(--app-elevated) 72%, var(--app-panel));
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--app-accent) 14%, transparent);
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
  color: color-mix(in srgb, var(--app-muted) 88%, transparent);
  font-variant-numeric: tabular-nums;
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

.nl-cards {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 0 8px 12px;
}

.nl-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  padding: 4px 10px 12px;
  align-items: stretch;
}
.nl-empty {
  align-items: center;
  justify-content: center;
}
.empty-hint {
  margin: 0;
  font-size: 12px;
  color: color-mix(in srgb, var(--app-muted) 85%, transparent);
}
.nl-empty-hint {
  margin: 0;
  padding: 10px 6px;
  font-size: 11.5px;
  line-height: 1.6;
  color: color-mix(in srgb, var(--app-muted) 85%, transparent);
  text-align: center;
}

.outline-item {
  display: grid;
  grid-template-columns: 3px minmax(0, 1fr);
  align-items: center;
  gap: 7px;
  min-height: 30px;
  padding: 0 8px 0 8px;
  border: none;
  border-radius: var(--app-radius-sm);
  background: transparent;
  text-align: left;
  cursor: pointer;
  transition: background var(--app-motion-fast) var(--app-ease);
}
.outline-item:hover {
  background: color-mix(in srgb, var(--app-elevated) 66%, transparent);
}
.outline-item:focus-visible {
  outline: 2px solid var(--app-accent);
  outline-offset: 1px;
}
.outline-mark {
  width: 3px;
  height: 12px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--app-accent) 55%, transparent);
}
.outline-text {
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  font-size: 12px;
  color: color-mix(in srgb, var(--app-text) 80%, var(--app-muted));
}
.outline-item:hover .outline-text {
  color: var(--app-text);
}

.nl-group-label {
  margin: 8px 2px 4px;
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.04em;
  color: color-mix(in srgb, var(--app-muted) 82%, transparent);
}
.nl-group-label:first-child {
  margin-top: 2px;
}
.link-item {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 1px;
  padding: 6px 8px;
  border: none;
  border-radius: var(--app-radius-sm);
  background: transparent;
  text-align: left;
  cursor: pointer;
  transition: background var(--app-motion-fast) var(--app-ease);
}
.link-item:hover:not(:disabled) {
  background: color-mix(in srgb, var(--app-accent-soft) 70%, var(--app-elevated));
}
.link-item:focus-visible {
  outline: 2px solid var(--app-accent);
  outline-offset: 1px;
}
.link-item.missing {
  cursor: default;
  opacity: 0.6;
}
.link-text {
  max-width: 100%;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  font-size: 12px;
  font-weight: 550;
  letter-spacing: -0.01em;
  color: var(--app-text);
}
.link-target {
  max-width: 100%;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  font-size: 10px;
  color: var(--app-muted);
}

@media (max-width: 920px) {
  .note-list {
    display: none;
  }
}
</style>
