<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import {
  Calendar,
  ChevronDown,
  ChevronRight,
  FolderOpen,
  Hash,
  LayoutTemplate,
  Library,
  Moon,
  RotateCcw,
  Settings,
  Sun,
  Tag as TagIcon,
  Trash2,
  X,
} from 'lucide-vue-next'
import {
  useSidebarNavigation,
  useSidebarReferences,
  useSidebarTags,
  useSidebarTemplates,
  useSidebarTheme,
  useSidebarTrash,
} from '../features/sidebar'
import TemplatePicker from './TemplatePicker.vue'
import { t } from '../i18n'
import { baseName } from '../services/paths'

const props = defineProps<{ vault: string }>()
const emit = defineEmits<{
  (e: 'open-folder', path: string): void
  (e: 'open-settings'): void
}>()

const { navEntries, pickVaultFolder } = useSidebarNavigation()
const { tagCounts, activeTag, selectTag, activeDocTags, removeCurrentTag } = useSidebarTags()
const { refQuery, refCount, refResults, insertRef } = useSidebarReferences()
const { theme, toggleTheme } = useSidebarTheme()
const {
  trashEntries,
  trashUnreadable,
  clearingTrash,
  refreshTrash,
  restore,
  trashLabel,
  clearTrash,
} = useSidebarTrash({ vault: () => props.vault })
const {
  templatePickerOpen,
  templateTemplates,
  createDailyNote,
  openTemplatePicker,
  closeTemplatePicker,
  createFromTemplate,
} = useSidebarTemplates({ vault: () => props.vault })

const refsOpen = ref(false)
const trashOpen = ref(false)

const vaultName = computed(() => {
  // Windows vault paths end with a backslash-separated folder name, so a
  // `/`-split returned the whole path.
  return baseName(props.vault) || props.vault
})

async function pickFolder(): Promise<void> {
  const picked = await pickVaultFolder()
  if (picked) emit('open-folder', picked)
}

watch(trashOpen, (open) => {
  if (open) void refreshTrash()
})

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
        :title="t('nav.openOther')"
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

      <div class="quick-actions">
        <button
          class="nav-item quick-action"
          :title="t('daily.new')"
          @click="createDailyNote"
        >
          <Calendar
            class="nav-icon"
            :size="16"
            :stroke-width="1.8"
          />
          <span class="nav-label">{{ t('daily.new') }}</span>
        </button>
        <button
          class="nav-item quick-action"
          :title="t('template.pickTitle')"
          @click="openTemplatePicker"
        >
          <LayoutTemplate
            class="nav-icon"
            :size="16"
            :stroke-width="1.8"
          />
          <span class="nav-label">{{ t('template.pickTitle') }}</span>
        </button>
      </div>

      <nav class="nav-group">
        <button
          v-for="entry in navEntries"
          :key="entry.id"
          class="nav-item"
          :class="{ active: entry.active }"
          :aria-current="entry.active ? 'page' : undefined"
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
        v-if="tagCounts.length"
        class="sidebar-section"
      >
        <div class="section-title">
          <TagIcon
            :size="12"
            :stroke-width="1.8"
          />
          <span>{{ t('nav.tags') }}</span>
        </div>
        <div class="tag-list">
          <div
            v-for="tc in tagCounts"
            :key="tc.tag"
            class="tag-row"
          >
            <button
              class="nav-item tag-item"
              :class="{ active: activeTag === tc.tag }"
              :title="t('nav.noteCount', { n: tc.count })"
              @click="selectTag(tc.tag)"
            >
              <Hash
                class="nav-icon"
                :size="16"
                :stroke-width="1.8"
              />
              <span class="nav-label">{{ tc.tag }}</span>
              <span class="nav-count">{{ tc.count }}</span>
            </button>
            <button
              v-if="activeDocTags.has(tc.tag)"
              class="tag-remove"
              :title="t('tag.removeFromDoc')"
              @click="removeCurrentTag(tc.tag, $event)"
            >
              <X
                :size="11"
                :stroke-width="2"
              />
            </button>
          </div>
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
          <span class="group-title">{{ t('nav.references') }}</span>
          <span
            v-if="refCount"
            class="group-count"
          >{{ refCount }}</span>
        </button>
        <div
          v-if="refsOpen"
          class="group-body"
        >
          <input
            v-model="refQuery"
            class="search-input ref-search"
            type="text"
            :placeholder="t('nav.searchRefs')"
          >
          <button
            v-for="r in refResults"
            :key="r.key"
            class="ref-item"
            :title="t('nav.insertRef', { key: r.key })"
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
            {{ t('nav.refEmpty') }}
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
          <span class="group-title">{{ t('nav.trash') }}</span>
          <span
            v-if="trashEntries.length"
            class="group-count"
          >{{ trashEntries.length }}</span>
        </button>
        <div
          v-if="trashOpen"
          class="group-body"
        >
          <button
            v-if="trashEntries.length"
            class="trash-clear"
            :class="{ armed: clearingTrash }"
            @click="clearTrash"
          >
            <Trash2
              :size="12"
              :stroke-width="1.8"
            />
            <span>{{ clearingTrash ? t('trash.clearConfirm') : t('trash.clear') }}</span>
          </button>
          <div
            v-for="entry in trashEntries"
            :key="entry.trash_path"
            class="trash-item"
          >
            <span
              class="trash-name"
              :title="entry.original_path || entry.name"
            >{{ trashLabel(entry) }}</span>
            <button
              class="trash-restore"
              :title="t('nav.restore')"
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
            {{ trashUnreadable ? t('nav.trashUnreadable') : t('nav.trashEmpty') }}
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
        :title="theme === 'dark' ? t('nav.switchLight') : t('nav.switchDark')"
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
        :title="t('nav.settings')"
        @click="emit('open-settings')"
      >
        <Settings
          :size="15"
          :stroke-width="1.8"
        />
      </button>
    </div>

    <TemplatePicker
      v-if="templatePickerOpen"
      :templates="templateTemplates"
      @select="createFromTemplate"
      @close="closeTemplatePicker"
    />
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

.quick-actions {
  display: flex;
  flex-direction: column;
  gap: 1px;
  padding-top: 8px;
  padding-bottom: 2px;
  border-top: 1px solid color-mix(in srgb, var(--app-border) 44%, transparent);
}
.quick-action {
  height: 30px;
  font-size: 11.5px;
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
  color: var(--app-muted);
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
  color: var(--app-muted);
}

.tag-list {
  display: flex;
  flex-direction: column;
  gap: 1px;
  padding: 2px 0 4px;
}
.tag-row {
  position: relative;
  display: flex;
  align-items: center;
  min-height: 34px;
}
.tag-row .tag-item {
  flex: 1;
  min-width: 0;
}
.tag-remove {
  position: absolute;
  right: 6px;
  top: 50%;
  transform: translateY(-50%);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  padding: 0;
  border: none;
  border-radius: var(--app-radius-xs);
  background: color-mix(in srgb, var(--app-elevated) 82%, var(--app-panel));
  color: var(--app-muted);
  cursor: pointer;
  opacity: 0;
  transition: opacity var(--app-motion-fast) var(--app-ease),
              background var(--app-motion-fast) var(--app-ease),
              color var(--app-motion-fast) var(--app-ease);
}
.tag-row:hover .tag-remove {
  opacity: 1;
}
.tag-remove:hover {
  color: var(--app-danger);
  background: color-mix(in srgb, var(--app-danger) 14%, transparent);
}
.tag-remove:focus-visible {
  outline: 2px solid var(--app-accent);
  outline-offset: 1px;
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
  color: var(--app-muted);
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
  color: var(--app-muted);
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
.ref-search::placeholder { color: var(--app-muted); }
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
.trash-clear {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 26px;
  padding: 0 8px;
  margin: 0 2px 3px;
  border: none;
  border-radius: var(--app-radius-sm);
  background: transparent;
  color: var(--app-muted);
  font-family: var(--app-font);
  font-size: 10.5px;
  font-weight: 500;
  cursor: pointer;
  transition: background var(--app-motion-fast) var(--app-ease),
              color var(--app-motion-fast) var(--app-ease);
}
.trash-clear:hover {
  color: var(--app-text);
  background: color-mix(in srgb, var(--app-elevated) 66%, transparent);
}
.trash-clear.armed {
  color: var(--app-danger);
  background: color-mix(in srgb, var(--app-danger) 10%, transparent);
}
.group-empty {
  margin: 0;
  padding: 6px 8px;
  font-size: 10.5px;
  line-height: 1.5;
  color: var(--app-muted);
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
