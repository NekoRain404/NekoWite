<script setup lang="ts">
import { onMounted, ref, watch } from 'vue'
import { GitCompareArrows } from 'lucide-vue-next'
import { fsService } from '../platform/gateways/fs'
import { notifyError } from '../services/errors'
import { useTabsStore } from '../stores/tabs'
import type { HistoryEntry } from '../platform/gateways/contracts'
import DiffView from './DiffView.vue'
import { t } from '../i18n'

const tabs = useTabsStore()
const entries = ref<HistoryEntry[]>([])
/**
 * Set when the last read of the history FAILED. The panel must not print "no
 * history yet" underneath an error toast: that sentence says the versions are
 * gone, while the truth is that they could not be read.
 */
const loadFailed = ref(false)

/** The entry being compared against the current content, or null to close. */
const comparing = ref<HistoryEntry | null>(null)
/** Historical text of `comparing`, loaded lazily on open. */
const historyText = ref('')
/**
 * The note `comparing`/`historyText` belong to.
 *
 * The comparison is a snapshot of ONE note's old version and is not
 * self-describing: without this, switching notes left the panel showing "this
 * note's current text vs THAT note's old text" in one diff - two documents mixed
 * together - and the restore button then asked the backend to restore the other
 * note's version id onto this one (a confusing failure, or with a coincidentally
 * equal id, the wrong version pasted into the wrong note).
 */
const comparingPath = ref<string | null>(null)

function hasDoc(): boolean {
  return Boolean(tabs.vault && tabs.activeTab?.path)
}

async function load(): Promise<void> {
  const tab = tabs.activeTab
  // The note changed: any open comparison describes a document that is no longer
  // on screen, so drop it rather than render (and act on) a mixed diff.
  if (comparingPath.value !== null && comparingPath.value !== (tab?.path ?? null)) {
    closeCompare()
  }
  if (!tab?.path || !tabs.vault) {
    entries.value = []
    loadFailed.value = false
    return
  }
  try {
    entries.value = await fsService.listHistory(tabs.vault, tab.path)
    loadFailed.value = false
  } catch (e) {
    // The toast carries the backend reason (which folder, what the OS said);
    // the inline hint below stops the panel from claiming there is no history.
    notifyError(t('history.readFailed', { msg: e instanceof Error ? e.message : String(e) }))
    entries.value = []
    loadFailed.value = true
  }
}

watch(
  [() => tabs.activeId, () => tabs.activeTab?.path, () => tabs.activeTab?.content],
  () => {
    void load()
  },
)

async function restore(entry: HistoryEntry): Promise<void> {
  const tab = tabs.activeTab
  if (!tab?.path) return
  // restoreHistoryToActive reports its own failures; null just means
  // "nothing restored" (error toast already shown, or the tab is gone).
  await tabs.restoreHistoryToActive(tab.id, entry.id)
  // The content watcher also refreshes the list on restore; the explicit
  // reload below keeps the panel in sync even if the restored content equals
  // the current content (no reactive change).
  await load()
}

async function openCompare(entry: HistoryEntry): Promise<void> {
  const tab = tabs.activeTab
  if (!tab?.path || !tabs.vault) return
  const path = tab.path
  const vault = tabs.vault
  try {
    const text = await fsService.readHistory(vault, path, entry.id)
    // The read is asynchronous: if the user switched notes while it was in
    // flight, this text belongs to the note that is no longer open.
    if (tabs.activeTab?.path !== path || tabs.vault !== vault) return
    historyText.value = text
    comparing.value = entry
    comparingPath.value = path
  } catch {
    notifyError(t('history.readHistoryFailed'))
  }
}

function closeCompare(): void {
  comparing.value = null
  historyText.value = ''
  comparingPath.value = null
}

async function restoreFromDiff(): Promise<void> {
  // Only restore what the diff actually shows: the same note, still open.
  if (comparing.value && comparingPath.value === tabs.activeTab?.path) {
    await restore(comparing.value)
  }
  closeCompare()
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

onMounted(() => {
  void load()
})
</script>

<template>
  <section class="history-panel">
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
