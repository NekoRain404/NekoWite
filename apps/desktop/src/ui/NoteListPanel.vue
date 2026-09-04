<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import {
  ArrowDownWideNarrow,
  BookOpen,
  Link2,
  ListTree,
  Search,
  TextSearch,
} from 'lucide-vue-next'
import { splitFrontmatter } from '@nekowite/editor-core'
import NoteCard from './NoteCard.vue'
import GraphPanel from './GraphPanel.vue'
import AttachmentsPanel from './AttachmentsPanel.vue'
import FileTree from './FileTree.vue'
import ContextMenu from './ContextMenu.vue'
import type { ContextMenuItem } from './ContextMenu.vue'
import ConflictDialog from '../components/ConflictDialog.vue'
import { useDocumentListStore } from '../stores/documentList'
import { useVaultSessionStore } from '../stores/vaultSession'
import { useFileTreeStore } from '../stores/fileTree'
import { useTabsStore } from '../stores/tabs'
import { useViewStore } from '../stores/view'
import { parseOutline } from '../services/outline'
import { dirRelativeToVault } from '../services/noteMeta'
import { inlinksOf as queryInlinks, outlinksOf as queryOutlinks } from '../features/vault/services/libraryQueries'
import { searchWithIndex } from '../services/contentSearch'
import type { ContentMatch, ContentSearchCandidate } from '../services/contentSearch'
import { t } from '../i18n'

const documentList = useDocumentListStore()
const vaultSession = useVaultSessionStore()
const fileTree = useFileTreeStore()
const tabs = useTabsStore()
const view = useViewStore()

const sortMenu = ref<{ x: number; y: number } | null>(null)
const conflict = ref<{ tabId: string; path: string } | null>(null)

const CONTENT_SEARCH_CONCURRENCY = 8
const CONTENT_SEARCH_DEBOUNCE_MS = 200

const contentEnabled = ref(false)
const contentResults = ref<ContentMatch[]>([])
const contentSearching = ref(false)
const contentSearched = ref(false)
let contentSearchTimer: ReturnType<typeof setTimeout> | null = null
let contentSearchAbort: AbortController | null = null

function clearContentResults(): void {
  contentSearchAbort?.abort()
  contentSearchAbort = null
  if (contentSearchTimer) {
    clearTimeout(contentSearchTimer)
    contentSearchTimer = null
  }
  contentResults.value = []
  contentSearching.value = false
  contentSearched.value = false
}

/** Short label for the persistent search-index state, shown in the note-list
 *  meta row. While building it shows an incremental progress count. */
const indexStatusLabel = computed(() => {
  const s = documentList.indexState
  const progress = documentList.indexProgress
  if (s === 'building' && progress) {
    return t('notelist.indexBuildingProgress', { done: progress.done, total: progress.total })
  }
  switch (s) {
    case 'building':
      return t('notelist.indexBuilding')
    case 'up-to-date':
      return t('notelist.indexUpToDate')
    case 'stale':
      return t('notelist.indexStale')
    case 'needs-rebuild':
      return t('notelist.indexNeedsRebuild')
    default:
      return ''
  }
})

/** Whether the index state deserves a visible chip (not the idle "no vault"). */
const showIndexStatus = computed(
  () => documentList.indexState !== 'idle' && indexStatusLabel.value !== '',
)

function toggleContentSearch(): void {
  contentEnabled.value = !contentEnabled.value
}

function scheduleContentSearch(): void {
  if (contentSearchTimer) clearTimeout(contentSearchTimer)
  contentSearchTimer = setTimeout(() => {
    contentSearchTimer = null
    void runContentSearch()
  }, CONTENT_SEARCH_DEBOUNCE_MS)
}

async function runContentSearch(): Promise<void> {
  // Supersede any in-flight search, even when the query clears below: a real
  // AbortController stops the previous run's reads/matches instead of only
  // discarding its stale results.
  contentSearchAbort?.abort()
  contentSearchAbort = null
  const vault = vaultSession.vault
  const q = documentList.query.trim()
  if (!vault || !q) {
    contentResults.value = []
    contentSearched.value = false
    contentSearching.value = false
    return
  }
  const controller = new AbortController()
  contentSearchAbort = controller
  contentSearching.value = true
  const candidates: ContentSearchCandidate[] = documentList.notes.map((n) => ({
    path: n.path,
    name: n.name,
    title: n.title,
    tags: n.tags,
    summary: n.summary,
    readContent: () => vaultSession.noteContent(n.path),
  }))
  const hits = await searchWithIndex(
    candidates,
    q,
    (path) => vaultSession.indexEntryFor(path),
    controller.signal,
    CONTENT_SEARCH_CONCURRENCY,
  )
  if (controller.signal.aborted) return
  contentResults.value = hits
  contentSearching.value = false
  contentSearched.value = true
}

watch(() => vaultSession.vault, () => {
  contentEnabled.value = false
  clearContentResults()
})

watch(() => documentList.notes, () => {
  if (contentEnabled.value) scheduleContentSearch()
})

watch([() => documentList.query, contentEnabled], () => {
  if (!contentEnabled.value) {
    clearContentResults()
    return
  }
  scheduleContentSearch()
})

const MODES = [
  { id: 'notes', label: t('notelist.notes'), icon: BookOpen },
  { id: 'outline', label: t('notelist.outline'), icon: ListTree },
  { id: 'links', label: t('notelist.links'), icon: Link2 },
] as const

const PLACEHOLDER_TITLES: Record<string, string> = {
  graph: 'graph',
  attachments: 'attachments',
  index: 'index',
  cloud: 'cloud',
}

const activeTab = computed(() => tabs.activeTab)
const activePath = computed(() => activeTab.value?.path ?? null)

const relDir = computed(() => {
  const path = activePath.value
  if (!path || !vaultSession.vault) return ''
  return dirRelativeToVault(path, vaultSession.vault)
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
    out: queryOutlinks(documentList.notes, vaultSession.vault, relDir.value, tab.content),
    back: queryInlinks(documentList.notes, relPath(tab.path)),
  }
})

function relPath(path: string): string | null {
  if (!vaultSession.vault) return null
  const dir = dirRelativeToVault(path, vaultSession.vault)
  const name = path.split('/').pop() ?? path
  return dir ? `${dir}/${name}` : name
}

const sortMenuItems = computed<ContextMenuItem[]>(() => [
  { id: 'mtime', label: t('notelist.sortMtime') },
  { id: 'title', label: t('notelist.sortTitleField') },
  { id: 'name', label: t('notelist.sortName') },
])

const sortLabel = computed(() => {
  switch (documentList.sortBy) {
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
  if (id === 'mtime' || id === 'title' || id === 'name') documentList.setSortBy(id)
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
      v-if="documentList.listView === 'notes' || PLACEHOLDER_TITLES[documentList.listView]"
      class="nl-header"
    >
      <div
        v-if="documentList.listView === 'notes'"
        class="nl-switch"
        role="tablist"
      >
        <button
          v-for="m in MODES"
          :key="m.id"
          class="switch-option nl-mode-btn"
          :class="{ 'is-active': documentList.panelMode === m.id }"
          role="tab"
          :aria-selected="documentList.panelMode === m.id"
          @click="documentList.setPanelMode(m.id)"
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
        {{ t(`notelist.${PLACEHOLDER_TITLES[documentList.listView]!}`) }}
      </h2>
    </header>

    <div
      v-if="documentList.listView === 'graph'"
      class="nl-embed"
    >
      <GraphPanel />
    </div>

    <div
      v-else-if="documentList.listView === 'attachments'"
      class="nl-embed"
    >
      <AttachmentsPanel />
    </div>

    <div
      v-else-if="documentList.listView === 'folders'"
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
        {{ t('notelist.openFolderAfter') }}
      </p>
    </div>

    <div
      v-else-if="documentList.listView !== 'notes'"
      class="nl-body nl-empty"
    >
      <p class="empty-hint">
        {{ t('notelist.comingSoon') }}
      </p>
    </div>

    <template v-else-if="documentList.panelMode === 'notes'">
      <div class="nl-search">
        <Search
          class="nl-search-icon"
          :size="14"
          :stroke-width="1.8"
        />
        <input
          :value="documentList.query"
          class="nl-search-input"
          type="text"
          :placeholder="t(contentEnabled ? 'notelist.contentSearchHint' : 'notelist.search')"
          @input="documentList.setQuery(($event.target as HTMLInputElement).value)"
        >
        <button
          type="button"
          class="nl-search-toggle"
          :class="{ on: contentEnabled }"
          :title="t('notelist.searchContent')"
          :aria-pressed="contentEnabled"
          @click="toggleContentSearch"
        >
          <TextSearch
            :size="13"
            :stroke-width="1.8"
          />
        </button>
      </div>
      <div class="nl-meta">
        <span class="nl-count">{{ documentList.indexing ? t('notelist.indexing') : contentEnabled ? t('notelist.contentCount', { n: contentResults.length }) : t('notelist.count', { n: documentList.visibleNotes.length }) }}</span>
        <span
          v-if="showIndexStatus"
          class="nl-index"
          :class="`is-${documentList.indexState}`"
          :title="t('notelist.indexStateTitle', { state: indexStatusLabel })"
        >
          {{ indexStatusLabel }}
        </span>
        <button
          v-if="documentList.indexState === 'stale' || documentList.indexState === 'needs-rebuild'"
          class="nl-index-rebuild"
          :title="t('notelist.rebuildIndexTitle')"
          @click="vaultSession.rebuildIndex()"
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
        v-if="fileTree.vaultTruncated && !documentList.indexing"
        class="nl-truncated"
        role="status"
        :title="t('notelist.vaultTruncated')"
      >
        {{ t('notelist.vaultTruncated') }}
      </p>
      <div
        class="nl-cards"
        role="list"
        :aria-label="t('notelist.aria')"
      >
        <template v-if="contentEnabled">
          <p
            v-if="contentSearching"
            class="nl-empty-hint"
          >
            {{ t('notelist.searching') }}
          </p>
          <template v-else-if="contentResults.length > 0">
            <p class="nl-group-label">
              {{ t('notelist.contentResults') }}
            </p>
            <button
              v-for="r in contentResults"
              :key="r.path"
              class="content-result"
              :title="r.path"
              @click="openNote(r.path)"
            >
              <span class="content-result-name">{{ r.name }}</span>
              <span class="content-result-snippet">{{ r.snippet }}</span>
            </button>
          </template>
          <p
            v-else-if="contentSearched"
            class="nl-empty-hint"
          >
            {{ t('notelist.noContentMatch') }}
          </p>
          <p
            v-else
            class="nl-empty-hint"
          >
            {{ t('notelist.contentSearchHint') }}
          </p>
        </template>
        <template v-else>
          <NoteCard
            v-for="note in documentList.visibleNotes"
            :key="note.path"
            :note="note"
            :active="note.path === activePath"
            :favorite="documentList.isFavorite(note.path)"
            @open="openNote(note.path)"
            @toggle-favorite="documentList.toggleFavorite(note.path)"
          />
          <p
            v-if="!documentList.indexing && documentList.visibleNotes.length === 0"
            class="nl-empty-hint"
          >
            {{ t('notelist.empty') }}
          </p>
        </template>
      </div>
    </template>

    <div
      v-else-if="documentList.panelMode === 'outline'"
      class="nl-body"
    >
      <template v-if="activeTab">
        <button
          v-for="item in outlineItems"
          :key="item.index"
          class="outline-item"
          :style="{ paddingLeft: `${8 + Math.max(0, item.level - 1) * 12}px` }"
          :title="t('notelist.jumpLine', { n: item.line + 1 })"
          @click="jumpOutline(item.line, item.index)"
        >
          <span class="outline-mark" />
          <span class="outline-text">{{ item.text || t('notelist.outlineHeading') }}</span>
        </button>
        <p
          v-if="outlineItems.length === 0"
          class="nl-empty-hint"
        >
          {{ t('notelist.outlineEmpty') }}
        </p>
      </template>
      <p
        v-else
        class="nl-empty-hint"
      >
        {{ t('notelist.openNoteOutline') }}
      </p>
    </div>

    <div
      v-else-if="documentList.panelMode === 'links'"
      class="nl-body"
    >
      <template v-if="activeTab">
        <p class="nl-group-label">
          {{ t('notelist.outLinks') }}
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
          {{ t('notelist.outLinksEmpty') }}
        </p>
        <p class="nl-group-label">
          {{ t('notelist.inLinks') }}
        </p>
        <button
          v-for="note in links.back"
          :key="`back-${note.path}`"
          class="link-item"
          @click="openNote(note.path)"
        >
          <span class="link-text">{{ note.title }}</span>
          <span class="link-target">{{ note.dir || t('notelist.rootDir') }}</span>
        </button>
        <p
          v-if="links.back.length === 0"
          class="nl-empty-hint"
        >
          {{ t('notelist.inLinksEmpty') }}
        </p>
      </template>
      <p
        v-else
        class="nl-empty-hint"
      >
        {{ t('notelist.openNoteLinks') }}
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
  padding: 0 30px 0 28px;
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
.nl-search-toggle {
  position: absolute;
  right: 6px;
  top: 50%;
  transform: translateY(-50%);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  padding: 0;
  border: none;
  border-radius: var(--app-radius-sm);
  background: transparent;
  color: var(--app-muted);
  cursor: pointer;
  transition: color var(--app-motion-fast) var(--app-ease),
              background var(--app-motion-fast) var(--app-ease);
}
.nl-search-toggle:hover {
  color: var(--app-text);
  background: color-mix(in srgb, var(--app-elevated) 66%, transparent);
}
.nl-search-toggle.on {
  color: var(--app-accent);
  background: color-mix(in srgb, var(--app-accent-soft) 60%, transparent);
}
.nl-search-toggle:focus-visible {
  outline: 2px solid var(--app-accent);
  outline-offset: 1px;
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

.content-result {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 2px;
  padding: 7px 8px;
  border: none;
  border-radius: var(--app-radius-sm);
  background: transparent;
  text-align: left;
  cursor: pointer;
  transition: background var(--app-motion-fast) var(--app-ease);
}
.content-result:hover {
  background: color-mix(in srgb, var(--app-elevated) 66%, transparent);
}
.content-result:focus-visible {
  outline: 2px solid var(--app-accent);
  outline-offset: 1px;
}
.content-result-name {
  max-width: 100%;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  font-size: 12px;
  font-weight: 600;
  letter-spacing: -0.01em;
  color: var(--app-text);
}
.content-result-snippet {
  max-width: 100%;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  font-size: 10.5px;
  line-height: 1.5;
  color: color-mix(in srgb, var(--app-muted) 88%, transparent);
}

@media (max-width: 920px) {
  .note-list {
    display: none;
  }
}
</style>
