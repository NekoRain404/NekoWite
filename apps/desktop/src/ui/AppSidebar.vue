<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import {
  ChevronDown,
  ChevronRight,
  Clock,
  Cloud,
  Database,
  FileText,
  FolderOpen,
  Hash,
  Inbox,
  Library,
  Moon,
  Network,
  Paperclip,
  RotateCcw,
  Settings,
  Star,
  Sun,
  Tag as TagIcon,
} from 'lucide-vue-next'
import { fsService } from '../services/fs'
import type { TrashEntry } from '../services/gateways/contracts'
import { notifyError } from '../services/errors'
import { useLibraryStore } from '../stores/library'
import { useAppearanceStore } from '../stores/appearance'
import { insertCiteAtCursor } from '../services/editorBridge'
import { useRefsStore } from '../stores/refs'

const props = defineProps<{ vault: string }>()
const emit = defineEmits<{
  (e: 'open-folder', path: string): void
  (e: 'conflict', req: { tabId: string; path: string }): void
  (e: 'open-settings'): void
}>()

const library = useLibraryStore()
const refs = useRefsStore()
const appearance = useAppearanceStore()

const refsOpen = ref(false)
const refQuery = ref('')
const refResults = computed(() => refs.search(refQuery.value).slice(0, 30))

const trashOpen = ref(false)
const trashEntries = ref<TrashEntry[]>([])

const vaultName = computed(() => {
  const p = props.vault.replace(/\/+$/, '')
  return p.split('/').pop() || p
})

const theme = computed<'light' | 'dark'>(() => {
  void appearance.systemRevision
  return appearance.effectiveTheme()
})

function toggleTheme(): void {
  appearance.setTheme(theme.value === 'dark' ? 'light' : 'dark')
}

interface NavEntry {
  id: string
  label: string
  icon: typeof FileText
  count?: number
  active: boolean
  onClick: () => void
}

const navEntries = computed<NavEntry[]>(() => {
  const counts = library.counts
  const inNotes = library.listView === 'notes'
  const isFilter = (f: string): boolean => inNotes && library.filter === f
  return [
    {
      id: 'all', label: '全部笔记', icon: FileText, count: counts.all,
      active: isFilter('all'), onClick: () => library.setFilter('all'),
    },
    {
      id: 'recent', label: '最近', icon: Clock, count: counts.recent,
      active: isFilter('recent'), onClick: () => library.setFilter('recent'),
    },
    {
      id: 'favorites', label: '收藏', icon: Star, count: counts.favorites,
      active: isFilter('favorites'), onClick: () => library.setFilter('favorites'),
    },
    {
      id: 'uncategorized', label: '未分类', icon: Inbox, count: counts.uncategorized,
      active: isFilter('uncategorized'), onClick: () => library.setFilter('uncategorized'),
    },
    {
      id: 'graph', label: '图谱', icon: Network,
      active: library.listView === 'graph', onClick: () => library.setListView('graph'),
    },
    {
      id: 'attachments', label: '附件', icon: Paperclip, count: library.attachmentCount,
      active: library.listView === 'attachments', onClick: () => library.setListView('attachments'),
    },
    {
      id: 'index', label: '索引', icon: Database,
      active: library.listView === 'index', onClick: () => library.setListView('index'),
    },
    {
      id: 'cloud', label: '云同步', icon: Cloud,
      active: library.listView === 'cloud', onClick: () => library.setListView('cloud'),
    },
  ]
})

async function refreshTrash(): Promise<void> {
  try {
    trashEntries.value = await fsService.listTrash(props.vault)
  } catch {
    trashEntries.value = []
  }
}

async function restore(entry: TrashEntry): Promise<void> {
  try {
    await fsService.restoreFromTrash(props.vault, entry.trash_path)
    await refreshTrash()
  } catch {
    notifyError('恢复失败，请重试')
  }
}

watch(trashOpen, (open) => {
  if (open) void refreshTrash()
})

async function pickFolder(): Promise<void> {
  const picked = await fsService.openFolderDialog()
  if (picked) emit('open-folder', picked)
}

function insertRef(key: string): void {
  insertCiteAtCursor(key)
  refQuery.value = ''
}

watch(
  () => props.vault,
  () => {
    refsOpen.value = false
    trashOpen.value = false
  },
)
</script>

<template>
  <aside class="sidebar">
    <div class="sidebar-scroll">
      <button
        class="nav-item vault-item"
        title="打开其他文件夹"
        @click="pickFolder"
      >
        <FolderOpen
          class="nav-icon"
          :size="16"
          :stroke-width="1.8"
        />
        <span class="nav-label">{{ vaultName }}</span>
        <FolderOpen
          class="nav-hint"
          :size="13"
          :stroke-width="1.8"
        />
      </button>

      <nav class="nav-group">
        <button
          v-for="entry in navEntries"
          :key="entry.id"
          class="nav-item"
          :class="{ active: entry.active }"
          @click="entry.onClick"
        >
          <component
            :is="entry.icon"
            class="nav-icon"
            :size="16"
            :stroke-width="1.8"
          />
          <span class="nav-label">{{ entry.label }}</span>
          <span
            v-if="typeof entry.count === 'number'"
            class="nav-count"
          >{{ entry.count }}</span>
        </button>
      </nav>

      <section
        v-if="library.tagCounts.length"
        class="sidebar-section"
      >
        <div class="section-title">
          <TagIcon
            :size="12"
            :stroke-width="1.8"
          />
          <span>标签</span>
        </div>
        <div class="tag-list">
          <button
            v-for="tc in library.tagCounts"
            :key="tc.tag"
            class="nav-item tag-item"
            :class="{ active: library.filter === `tag:${tc.tag}` }"
            :title="`${tc.count} 篇笔记`"
            @click="library.setFilter(`tag:${tc.tag}`)"
          >
            <Hash
              class="nav-icon"
              :size="16"
              :stroke-width="1.8"
            />
            <span class="nav-label">{{ tc.tag }}</span>
            <span class="nav-count">{{ tc.count }}</span>
          </button>
        </div>
      </section>

      <section class="sidebar-section">
        <button
          class="group-header"
          @click="refsOpen = !refsOpen"
        >
          <ChevronDown
            v-if="refsOpen"
            class="group-caret"
            :size="12"
            :stroke-width="1.8"
          />
          <ChevronRight
            v-else
            class="group-caret"
            :size="12"
            :stroke-width="1.8"
          />
          <span class="group-title">引用文献</span>
          <span
            v-if="refs.refs.size"
            class="group-count"
          >{{ refs.refs.size }}</span>
        </button>
        <div
          v-if="refsOpen"
          class="group-body"
        >
          <input
            v-model="refQuery"
            class="search-input ref-search"
            type="text"
            placeholder="搜索 key / 标题 / 作者 / 年份"
          >
          <button
            v-for="r in refResults"
            :key="r.key"
            class="ref-item"
            :title="`插入引用 [@${r.key}]`"
            @click="insertRef(r.key)"
          >
            <span class="ref-key">{{ r.key }}</span>
            <span class="ref-title">{{ r.title }}</span>
            <span class="ref-meta">{{ r.authors.join(', ') }}{{ r.year ? ` · ${r.year}` : '' }}</span>
          </button>
          <p
            v-if="refResults.length === 0"
            class="group-empty"
          >
            将 .bib / .ris / .json(CSL) 文件放入 vault 根目录
          </p>
        </div>
      </section>

      <section class="sidebar-section">
        <button
          class="group-header"
          @click="trashOpen = !trashOpen"
        >
          <ChevronDown
            v-if="trashOpen"
            class="group-caret"
            :size="12"
            :stroke-width="1.8"
          />
          <ChevronRight
            v-else
            class="group-caret"
            :size="12"
            :stroke-width="1.8"
          />
          <span class="group-title">回收站</span>
          <span
            v-if="trashEntries.length"
            class="group-count"
          >{{ trashEntries.length }}</span>
        </button>
        <div
          v-if="trashOpen"
          class="group-body"
        >
          <div
            v-for="entry in trashEntries"
            :key="entry.trash_path"
            class="trash-item"
          >
            <span
              class="trash-name"
              :title="entry.original_path"
            >{{ entry.name }}</span>
            <button
              class="trash-restore"
              title="恢复"
              @click="restore(entry)"
            >
              <RotateCcw
                :size="12"
                :stroke-width="1.8"
              />
            </button>
          </div>
          <p
            v-if="trashEntries.length === 0"
            class="group-empty"
          >
            回收站是空的
          </p>
        </div>
      </section>
    </div>

    <div class="sidebar-footer">
      <span
        class="footer-vault"
        :title="props.vault"
      >
        <Library
          :size="12"
          :stroke-width="1.8"
        />
        {{ vaultName }}
      </span>
      <span class="footer-spacer" />
      <button
        class="footer-btn"
        :title="theme === 'dark' ? '切换到浅色' : '切换到深色'"
        @click="toggleTheme"
      >
        <Sun
          v-if="theme === 'dark'"
          :size="15"
          :stroke-width="1.8"
        />
        <Moon
          v-else
          :size="15"
          :stroke-width="1.8"
        />
      </button>
      <button
        class="footer-btn"
        title="设置"
        @click="emit('open-settings')"
      >
        <Settings
          :size="15"
          :stroke-width="1.8"
        />
      </button>
    </div>
  </aside>
</template>

<style scoped>
.sidebar {
  width: var(--app-sidebar-width);
  min-width: var(--app-sidebar-width);
  height: 100%;
  display: flex;
  flex-direction: column;
  background: var(--app-panel);
  border-right: 1px solid var(--app-border);
  overflow: hidden;
  user-select: none;
}
.sidebar-scroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 8px 8px 12px;
  display: flex;
  flex-direction: column;
}

.nav-group {
  display: flex;
  flex-direction: column;
  gap: 1px;
  padding-top: 6px;
}

.nav-item {
  display: grid;
  grid-template-columns: 16px minmax(0, 1fr) auto;
  align-items: center;
  gap: 8px;
  width: 100%;
  height: 34px;
  padding: 0 10px;
  border: none;
  border-radius: var(--app-radius-lg);
  background: transparent;
  color: color-mix(in srgb, var(--app-text) 72%, var(--app-muted));
  font-family: var(--app-font);
  font-size: 12px;
  font-weight: 500;
  letter-spacing: -0.01em;
  cursor: pointer;
  transition: background var(--app-motion-fast) var(--app-ease),
              color var(--app-motion-fast) var(--app-ease),
              box-shadow var(--app-motion-fast) var(--app-ease);
}
.nav-item:hover {
  color: var(--app-text);
  background: color-mix(in srgb, var(--app-elevated) 62%, transparent);
}
.nav-item:focus-visible {
  outline: 2px solid var(--app-accent);
  outline-offset: 1px;
}
.nav-item.active {
  background: color-mix(in srgb, var(--app-accent-soft) 76%, var(--app-panel));
  color: var(--app-text);
  font-weight: 600;
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--app-accent) 9%, transparent);
}
.nav-item.active .nav-icon {
  color: var(--app-accent);
}
.nav-icon {
  color: color-mix(in srgb, var(--app-accent) 82%, var(--app-text));
}
.nav-hint {
  opacity: 0;
  color: var(--app-muted);
  transition: opacity var(--app-motion-fast) var(--app-ease);
}
.nav-item:hover .nav-hint { opacity: 1; }
.nav-label {
  text-align: left;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.nav-count {
  font-size: 10px;
  font-weight: 400;
  color: color-mix(in srgb, var(--app-muted) 78%, transparent);
  font-variant-numeric: tabular-nums;
}
.nav-item.active .nav-count {
  color: color-mix(in srgb, var(--app-text) 54%, var(--app-muted));
}

.sidebar-section {
  margin-top: 6px;
  padding-top: 8px;
  border-top: 1px solid color-mix(in srgb, var(--app-border) 44%, transparent);
}
.section-title {
  display: flex;
  align-items: center;
  gap: 5px;
  height: 24px;
  padding: 0 8px;
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.04em;
  color: color-mix(in srgb, var(--app-muted) 82%, transparent);
}

.tag-list {
  display: flex;
  flex-direction: column;
  gap: 1px;
  padding: 2px 0 4px;
}
.tag-item .nav-label::before {
  content: '#';
  margin-right: 1px;
  color: color-mix(in srgb, var(--app-accent) 70%, var(--app-muted));
}

.group-header {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  height: 28px;
  padding: 0 8px;
  border: none;
  border-radius: var(--app-radius-sm);
  background: transparent;
  color: color-mix(in srgb, var(--app-muted) 82%, transparent);
  font-family: var(--app-font);
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.04em;
  cursor: pointer;
  transition: background var(--app-motion-fast) var(--app-ease),
              color var(--app-motion-fast) var(--app-ease);
}
.group-header:hover {
  color: var(--app-text);
  background: color-mix(in srgb, var(--app-elevated) 54%, transparent);
}
.group-caret { flex: none; }
.group-title { flex: 1; text-align: left; }
.group-count {
  font-size: 10px;
  font-weight: 400;
  color: color-mix(in srgb, var(--app-muted) 78%, transparent);
  font-variant-numeric: tabular-nums;
}
.group-body {
  display: flex;
  flex-direction: column;
  gap: 1px;
  padding: 2px 2px 4px;
}
.ref-search {
  height: 30px;
  padding: 0 10px;
  margin: 2px 4px 4px;
  font-family: var(--app-font);
  font-size: 12px;
  color: var(--app-text);
  background: color-mix(in srgb, var(--app-elevated) 42%, var(--app-panel));
  border: 1px solid color-mix(in srgb, var(--app-border) 54%, transparent);
  border-radius: var(--app-radius-lg);
  outline: none;
}
.ref-search::placeholder { color: color-mix(in srgb, var(--app-muted) 82%, transparent); }
.ref-search:focus {
  border-color: color-mix(in srgb, var(--app-accent) 55%, var(--app-border));
}
.ref-item {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 1px;
  padding: 5px 8px;
  border: none;
  border-radius: var(--app-radius-sm);
  background: transparent;
  color: var(--app-text);
  text-align: left;
  cursor: pointer;
  transition: background var(--app-motion-fast) var(--app-ease);
}
.ref-item:hover {
  background: color-mix(in srgb, var(--app-accent-soft) 70%, var(--app-elevated));
}
.ref-key {
  font-size: 11px;
  font-weight: 650;
  letter-spacing: -0.01em;
}
.ref-title {
  font-size: 11px;
  color: color-mix(in srgb, var(--app-text) 80%, var(--app-muted));
  max-width: 100%;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.ref-meta {
  font-size: 10px;
  color: var(--app-muted);
  max-width: 100%;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.trash-item {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 8px;
  border-radius: var(--app-radius-sm);
  transition: background var(--app-motion-fast) var(--app-ease);
}
.trash-item:hover {
  background: color-mix(in srgb, var(--app-elevated) 66%, transparent);
}
.trash-name {
  flex: 1;
  font-size: 11px;
  color: color-mix(in srgb, var(--app-text) 76%, var(--app-muted));
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.trash-restore {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: var(--app-muted);
  cursor: pointer;
  transition: background var(--app-motion-fast) var(--app-ease),
              color var(--app-motion-fast) var(--app-ease);
}
.trash-restore:hover {
  color: var(--app-text);
  background: color-mix(in srgb, var(--app-panel) 72%, transparent);
}
.group-empty {
  margin: 0;
  padding: 6px 8px;
  font-size: 10.5px;
  line-height: 1.5;
  color: color-mix(in srgb, var(--app-muted) 82%, transparent);
}

.sidebar-footer {
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 6px 8px;
  border-top: 1px solid color-mix(in srgb, var(--app-border) 72%, transparent);
  background: color-mix(in srgb, var(--app-panel) 92%, var(--app-elevated));
}
.footer-vault {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  min-width: 0;
  font-size: 11px;
  font-weight: 550;
  letter-spacing: -0.01em;
  color: color-mix(in srgb, var(--app-text) 76%, var(--app-muted));
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.footer-spacer { flex: 1; }
.footer-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  flex: none;
  border: none;
  border-radius: var(--app-radius-sm);
  background: transparent;
  color: var(--app-muted);
  cursor: pointer;
  transition: background var(--app-motion-fast) var(--app-ease),
              color var(--app-motion-fast) var(--app-ease);
}
.footer-btn:hover {
  color: var(--app-text);
  background: color-mix(in srgb, var(--app-elevated) 66%, transparent);
}
</style>
