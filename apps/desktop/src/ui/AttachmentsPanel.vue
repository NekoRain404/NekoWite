<script setup lang="ts">
import { computed, markRaw, onMounted, ref, watch } from 'vue'
import { Copy, FileImage, ImagePlus, Paperclip, RefreshCw, Trash2 } from 'lucide-vue-next'
import { fsService } from '../platform/gateways/fs'
import {
  deleteAttachment,
  formatBytes,
  formatRelativeTime,
  loadAttachmentLibrary,
  type AttachmentItem,
} from '../services/attachmentLibrary'
import { markdownImageBlock, relativePathFromNoteVault } from '../services/attachments'
import { insertMarkdownAtCursor } from '../services/editorInsert'
import { notifyError } from '../services/errors'
import { useTabsStore } from '../stores/tabs'
import ContextMenu from './ContextMenu.vue'
import type { ContextMenuItem } from './ContextMenu.vue'
import { isComposingKey } from '../services/keyGuard'
import { t } from '../i18n'

/**
 * 附件库面板：双列缩略图网格浏览 vault 的 attachments/ 目录。
 * 点击插入到当前文档光标处，右键提供插入 / 复制相对路径 / 删除（二段式确认）。
 * 无 props，自读 tabs store；父组件可通过 ref 调用 reload()。
 */

const tabs = useTabsStore()

const items = ref<AttachmentItem[]>([])
const srcs = ref<Record<string, string>>({})
const broken = ref<Record<string, boolean>>({})
const loading = ref(false)
const loaded = ref(false)

let runSeq = 0

async function resolveSrcs(vault: string, list: AttachmentItem[], run: number): Promise<void> {
  const next: Record<string, string> = {}
  await Promise.all(
    list.map(async (item) => {
      try {
        next[item.path] = await fsService.resolveMediaPath(vault, item.path)
      } catch {
        // resolve 失败时交给 <img> 的占位图标分支。
      }
    }),
  )
  // Resolution is async and a vault switch reloads this panel: by the time the
  // first path comes back, `run` can already be stale. Committing here would
  // overwrite the new vault's thumbnails with the old vault's URLs and wipe the
  // broken marks the newer run just set - the reason `reload` checks its own
  // sequence before touching `items`.
  if (run !== runSeq) return
  srcs.value = next
  broken.value = {}
}

async function reload(): Promise<void> {
  const run = ++runSeq
  const vault = tabs.vault
  loading.value = true
  try {
    if (!vault) {
      items.value = []
      srcs.value = {}
      broken.value = {}
    } else {
      const list = await loadAttachmentLibrary(vault)
      if (run !== runSeq) return
      items.value = list
      await resolveSrcs(vault, list, run)
    }
  } finally {
    if (run === runSeq) {
      loading.value = false
      loaded.value = true
    }
  }
}

/** Enter/Space on a card insert the image. While an IME candidate list is open
 *  those keys belong to the IME; the card is focusable during composition too,
 *  so the composing Enter must not insert an unrelated attachment. */
function onCardKeydown(e: KeyboardEvent, item: AttachmentItem): void {
  if (isComposingKey(e)) return
  if (e.key !== 'Enter' && e.key !== ' ') return
  e.preventDefault()
  void insertItem(item)
}

function markBroken(path: string): void {
  broken.value = { ...broken.value, [path]: true }
}

/** Markdown 侧的引用路径：以笔记自身所在目录为基准，`../attachments/…`。 */
function referencePathFor(item: AttachmentItem): string {
  const tab = tabs.activeTab
  return relativePathFromNoteVault(tab?.path ?? '', tabs.vault ?? '', item.path)
}

async function insertItem(item: AttachmentItem): Promise<void> {
  if (!tabs.activeTab) {
    notifyError(t('attachments.openDocFirst'))
    return
  }
  const alt = item.name.replace(/\.[^.]+$/, '') || 'image'
  try {
    // Routed by view mode: in source mode the image has to land in the
    // CodeMirror text, not in the hidden rendered model.
    const inserted = await insertMarkdownAtCursor(markdownImageBlock(alt, referencePathFor(item)))
    if (inserted === false) notifyError(t('attachments.editorNotReady'))
  } catch {
    notifyError(t('attachments.insertFailed'))
  }
}

async function copyReference(item: AttachmentItem): Promise<void> {
  const rel = referencePathFor(item)
  try {
    await navigator.clipboard.writeText(rel)
  } catch {
    notifyError(t('attachments.copyFailed'))
  }
}

async function removeItem(item: AttachmentItem): Promise<void> {
  const vault = tabs.vault
  if (!vault) return
  try {
    await deleteAttachment(vault, item.path)
  } catch {
    notifyError(t('attachments.deleteFailed'))
    return
  }
  await reload()
}

const MENU_ICONS = {
  insert: markRaw(ImagePlus),
  copy: markRaw(Copy),
  trash: markRaw(Trash2),
}

interface MenuTarget {
  x: number
  y: number
  item: AttachmentItem
  confirming: boolean
}

const menu = ref<MenuTarget | null>(null)
let holdOpen = false

const menuItems = computed<ContextMenuItem[]>(() => {
  const m = menu.value
  if (!m) return []
  return [
    { id: 'insert', label: t('attachments.insert'), icon: MENU_ICONS.insert },
    { id: 'copy', label: t('attachments.copyPath'), icon: MENU_ICONS.copy },
    { id: 'sep-delete', separator: true },
    {
      id: 'delete',
      label: m.confirming ? t('attachments.deleteConfirm') : t('common.delete'),
      icon: MENU_ICONS.trash,
      danger: true,
    },
  ]
})

function openMenu(item: AttachmentItem, e: MouseEvent): void {
  menu.value = { x: e.clientX, y: e.clientY, item, confirming: false }
  holdOpen = false
}

function onMenuSelect(id: string): void {
  const m = menu.value
  if (!m) return
  if (id === 'insert') void insertItem(m.item)
  else if (id === 'copy') void copyReference(m.item)
  else if (id === 'delete') {
    // 二段式确认：第一次点「删除」只切换菜单项为「确认删除」，菜单保持打开。
    if (!m.confirming) {
      menu.value = { ...m, confirming: true }
      holdOpen = true
      return
    }
    void removeItem(m.item)
  }
}

function onMenuClose(): void {
  if (holdOpen) {
    holdOpen = false
    return
  }
  menu.value = null
}

onMounted(() => {
  void reload()
})

watch(
  () => tabs.vault,
  () => {
    void reload()
  },
)

defineExpose({ reload })
</script>

<template>
  <section class="attachments-panel">
    <div class="att-toolbar">
      <h3 class="att-title">
        {{ t('attachments.title') }}
        <span
          v-if="items.length"
          class="att-count"
        >{{ items.length }}</span>
      </h3>
      <button
        class="att-refresh"
        :title="t('attachments.refresh')"
        :disabled="loading"
        @click="reload"
      >
        <RefreshCw
          :size="13"
          :stroke-width="1.8"
          class="att-refresh-icon"
          :class="{ spin: loading }"
        />
      </button>
    </div>

    <div
      v-if="!loaded"
      class="att-empty"
    >
      <Paperclip
        :size="20"
        :stroke-width="1.6"
      />
      <p class="att-empty-hint">
        {{ t('attachments.loading') }}
      </p>
    </div>

    <div
      v-else-if="!items.length"
      class="att-empty"
    >
      <Paperclip
        :size="20"
        :stroke-width="1.6"
      />
      <p class="att-empty-title">
        {{ t('attachments.emptyTitle') }}
      </p>
      <p class="att-empty-hint">
        {{ t('attachments.emptyHint') }}
      </p>
    </div>

    <div
      v-else
      class="att-grid"
    >
      <div
        v-for="item in items"
        :key="item.path"
        class="att-card"
        role="button"
        tabindex="0"
        :aria-label="t('attachments.insertImage', { name: item.name })"
        aria-haspopup="menu"
        @click="insertItem(item)"
        @keydown="onCardKeydown($event, item)"
        @contextmenu.stop.prevent="openMenu(item, $event)"
      >
        <div class="att-thumb">
          <img
            v-if="srcs[item.path] && !broken[item.path]"
            :src="srcs[item.path]"
            :alt="item.name"
            loading="lazy"
            draggable="false"
            @error="markBroken(item.path)"
          >
          <FileImage
            v-else
            :size="22"
            :stroke-width="1.6"
          />
        </div>
        <div class="att-meta">
          <p
            class="att-name"
            :title="item.path"
          >
            {{ item.name }}
          </p>
          <p class="att-sub">
            {{ formatBytes(item.size) }} · {{ formatRelativeTime(item.mtime) }}
          </p>
        </div>
      </div>
    </div>

    <ContextMenu
      v-if="menu"
      :x="menu.x"
      :y="menu.y"
      :items="menuItems"
      @select="onMenuSelect"
      @close="onMenuClose"
    />
  </section>
</template>

<style scoped>
.attachments-panel {
  display: flex;
  flex-direction: column;
  min-height: 0;
  height: 100%;
  padding: 12px 14px 4px;
}
.att-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  flex: none;
  margin-bottom: 10px;
}
.att-title {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 0;
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.04em;
  color: color-mix(in srgb, var(--app-muted) 82%, transparent);
}
.att-count {
  font-weight: 400;
  letter-spacing: 0;
  font-variant-numeric: tabular-nums;
}
.att-refresh {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border: none;
  border-radius: var(--app-radius-sm);
  background: transparent;
  color: var(--app-muted);
  cursor: pointer;
  transition: background var(--app-motion-fast) var(--app-ease),
              color var(--app-motion-fast) var(--app-ease);
}
.att-refresh:hover:not(:disabled) {
  color: var(--app-text);
  background: color-mix(in srgb, var(--app-elevated) 66%, transparent);
}
.att-refresh:focus-visible {
  outline: 2px solid var(--app-accent);
  outline-offset: 1px;
}
.att-refresh:disabled {
  cursor: default;
  opacity: 0.6;
}
.att-refresh-icon.spin {
  animation: att-spin var(--app-motion-spin) linear infinite;
}
@keyframes att-spin {
  to { transform: rotate(360deg); }
}
.att-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  align-content: start;
  gap: 6px;
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding-bottom: 10px;
}
.att-card {
  min-width: 0;
  padding: 6px;
  border-radius: var(--app-radius);
  background: transparent;
  cursor: pointer;
  user-select: none;
  transition: background var(--app-motion-fast) var(--app-ease);
}
.att-card:hover {
  background: color-mix(in srgb, var(--app-elevated) 66%, transparent);
}
.att-card:focus-visible {
  outline: 2px solid var(--app-accent);
  outline-offset: 1px;
}
.att-thumb {
  display: grid;
  place-items: center;
  aspect-ratio: 4 / 3;
  overflow: hidden;
  border-radius: var(--app-radius-sm);
  background: color-mix(in srgb, var(--app-elevated) 70%, var(--app-panel));
  color: var(--app-muted);
}
.att-thumb img {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.att-meta {
  min-width: 0;
  margin-top: 6px;
}
.att-name {
  margin: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
  font-weight: 600;
  color: var(--app-text);
}
.att-sub {
  margin: 2px 0 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 10px;
  color: var(--app-muted);
  font-variant-numeric: tabular-nums;
}
.att-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 4px;
  flex: 1;
  min-height: 0;
  padding: 24px 16px;
  text-align: center;
  color: var(--app-muted);
}
.att-empty-title {
  margin: 4px 0 0;
  font-size: 12px;
  font-weight: 600;
  color: var(--app-text);
}
.att-empty-hint {
  margin: 0;
  max-width: 220px;
  font-size: 11px;
  line-height: 1.7;
  color: var(--app-muted);
}
</style>
