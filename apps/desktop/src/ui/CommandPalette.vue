<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { Component } from 'vue'
import { BUILTIN_COMMAND_IDS, getToolbar, listCommands } from '@nekowite/editor-core'
import { runEditorCommand } from '../services/runEditorCommand'
import { FileText, Search } from 'lucide-vue-next'
import { useTabsStore } from '../stores/tabs'
import { fsService } from '../platform/gateways/fs'
import { vaultFileIndex } from '../services/vaultFiles'
import { catalogOf, COMMAND_KEYS } from './commandCatalog'
import {
  fileEntryOf,
  filterEntries,
  groupEntries,
  type PaletteEntry,
} from './commandPaletteLogic'
import { t } from '../i18n'

const MOTION_MS = 160
const FILE_RESULT_LIMIT = 20

interface PaletteRow {
  entry: PaletteEntry
  index: number
}

interface PaletteGroupRows {
  key: 'command' | 'file'
  label: string
  entries: PaletteRow[]
}

const LIST_ID = 'nekowite-command-palette-list'

const tabs = useTabsStore()

// Every command the palette offers is an editor command: it runs against the
// live rendered/source model (see runEditorCommand). With no document open there
// is no model, so nothing below can be offered honestly.
const hasDocument = computed(() => tabs.activeTab !== null)

const open = ref(false)
const visible = ref(false)
/** True from the moment a close begins until the fade-out finishes. */
const closing = ref(false)
const query = ref('')
const activeIndex = ref(0)
const inputRef = ref<HTMLInputElement | null>(null)
const listRef = ref<HTMLElement | null>(null)
const files = ref<string[]>([])
let hideTimer: ReturnType<typeof setTimeout> | null = null
// The deferred paint that turns the fade-in on. It has to be cancellable: a
// close that lands inside those two frames would otherwise let the stale paint
// re-set `visible` after `hide()` cleared it, leaving the palette flagged as
// on-screen while closed.
let paintRaf = 0
let prevFocus: HTMLElement | null = null
let fsUnlisten: Promise<() => void> | null = null

// Registry reads are not reactive; bump on every open so freshly loaded
// plugins contribute their toolbar commands.
const registryRevision = ref(0)

const commandEntries = computed<PaletteEntry[]>(() => {
  void registryRevision.value
  // The formatting/insert commands are ProseMirror commands (or plugin commands
  // resolving the rendered view): with no document open `runEditorCommand`
  // reports "nothing handled it" and the row would be a silent no-op — no toast,
  // no disabled state, nothing. Rather than offering ~20 dead rows, offer none
  // until a document exists (the Files group still opens one) and say why in the
  // note above the list.
  if (!hasDocument.value) return []
  const byId = new Map<string, PaletteEntry>()
  const add = (rawId: string, run: () => void, fallbackLabel?: string): void => {
    if (byId.has(rawId)) return
    const meta = catalogOf(rawId)
    byId.set(rawId, {
      id: rawId,
      kind: 'command',
      label: COMMAND_KEYS[rawId] ? t(COMMAND_KEYS[rawId]) : (meta.label === rawId && fallbackLabel ? fallbackLabel : meta.label),
      keywords: meta.keywords ?? rawId,
      run,
    })
  }
  // Every command goes through the mode-aware runner: these are ProseMirror
  // commands (or plugin commands resolving the rendered view), so in source
  // mode they would otherwise edit the hidden model and appear to do nothing.
  for (const id of BUILTIN_COMMAND_IDS) add(id, () => runEditorCommand(id))
  for (const cmd of listCommands()) add(cmd.id, () => runEditorCommand(cmd.id))
  for (const item of getToolbar()) add(item.id, () => runEditorCommand(item.id), item.label)
  return [...byId.values()]
})

const recentEntries = computed<PaletteEntry[]>(() => {
  const withPath = tabs.tabs.filter((t) => t.path !== null)
  const active = tabs.activeTab
  const ordered = active?.path
    ? [active, ...withPath.filter((t) => t.id !== active.id)]
    : withPath
  const seen = new Set<string>()
  const out: PaletteEntry[] = []
  for (const t of ordered) {
    const path = t.path
    if (!path || seen.has(path)) continue
    seen.add(path)
    out.push(fileEntryOf(path, tabs.vault, () => void tabs.openTab(path)))
  }
  return out
})

const fileSearchEntries = computed<PaletteEntry[]>(() =>
  files.value.map((path) => fileEntryOf(path, tabs.vault, () => void tabs.openTab(path))),
)

const trimmed = computed(() => query.value.trim())

const commandResults = computed(() => filterEntries(commandEntries.value, trimmed.value))
const fileResults = computed(() => {
  const q = trimmed.value
  if (!q) return recentEntries.value
  return filterEntries(fileSearchEntries.value, q, FILE_RESULT_LIMIT)
})

const groups = computed(() => groupEntries([...commandResults.value, ...fileResults.value]))

const rows = computed<PaletteGroupRows[]>(() => {
  let index = 0
  return groups.value.map((group) => ({
    key: group.key,
    label: group.key === 'command' ? t('palette.groupCommand') : t('palette.groupFile'),
    entries: group.entries.map((entry) => ({ entry, index: index++ })),
  }))
})

const flatRows = computed<PaletteRow[]>(() => rows.value.flatMap((group) => group.entries))

const activeId = computed(() =>
  activeIndex.value < flatRows.value.length ? `${LIST_ID}-item-${activeIndex.value}` : undefined,
)

function iconFor(entry: PaletteEntry): Component {
  return entry.kind === 'file' ? FileText : catalogOf(entry.id).icon
}

function prefersReducedMotion(): boolean {
  return typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

async function loadFiles(): Promise<void> {
  const vault = tabs.vault
  if (!vault) {
    files.value = []
    return
  }
  files.value = await vaultFileIndex.get(vault)
}

function show(): void {
  if (hideTimer) {
    clearTimeout(hideTimer)
    hideTimer = null
  }
  open.value = true
  closing.value = false
  query.value = ''
  activeIndex.value = 0
  registryRevision.value += 1
  prevFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
  void loadFiles()
  const paint = (): void => {
    paintRaf = 0
    visible.value = true
  }
  cancelPaint()
  if (prefersReducedMotion()) paint()
  else {
    // Two frames: the overlay must be laid out at opacity 0 for the CSS
    // transition to have a starting value to animate from.
    paintRaf = requestAnimationFrame(() => {
      paintRaf = requestAnimationFrame(paint)
    })
  }
  void nextTick(() => inputRef.value?.focus())
}

function cancelPaint(): void {
  if (paintRaf === 0) return
  cancelAnimationFrame(paintRaf)
  paintRaf = 0
}

function hide(): void {
  if (!open.value) return
  cancelPaint()
  visible.value = false
  closing.value = true
  if (hideTimer) clearTimeout(hideTimer)
  hideTimer = setTimeout(() => {
    open.value = false
    closing.value = false
    hideTimer = null
  }, MOTION_MS)
  const el = prevFocus
  prevFocus = null
  if (el && el.isConnected) el.focus()
}

function execute(entry: PaletteEntry): void {
  hide()
  entry.run()
}

function move(delta: number): void {
  const len = flatRows.value.length
  if (!len) return
  activeIndex.value = (activeIndex.value + delta + len) % len
}

function scrollActiveIntoView(): void {
  const el = listRef.value?.querySelector<HTMLElement>(`[data-index="${activeIndex.value}"]`)
  el?.scrollIntoView({ block: 'nearest' })
}

function onInputKeydown(e: KeyboardEvent): void {
  if (e.isComposing || e.key === 'Process') return
  if (e.key === 'ArrowDown') {
    e.preventDefault()
    move(1)
    return
  }
  if (e.key === 'ArrowUp') {
    e.preventDefault()
    move(-1)
    return
  }
  if (e.key === 'Enter') {
    e.preventDefault()
    const row = flatRows.value[activeIndex.value]
    if (row) execute(row.entry)
  }
}

function onGlobalKeydown(e: KeyboardEvent): void {
  if (e.isComposing) return
  if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'k') {
    e.preventDefault()
    e.stopPropagation()
    // Gated on the logical state, not on `visible`: the fade-in is deferred by
    // two frames, so just after opening `visible` is still false and keying off
    // it would make the first Ctrl+K press open rather than close.
    //
    // A palette that is mid fade-out counts as closed here so the press
    // revives it — otherwise a quick Escape-then-Ctrl+K would be swallowed by
    // `hide()` and the palette would look like it refused to reopen.
    if (open.value && !closing.value) hide()
    else show()
    return
  }
  // `open` again: Escape must work the instant the palette appears, which is
  // before the deferred fade-in has painted.
  if (open.value && e.key === 'Escape') {
    e.preventDefault()
    e.stopPropagation()
    hide()
  }
}

watch(query, () => {
  activeIndex.value = 0
})

watch(
  () => flatRows.value.length,
  (len) => {
    if (activeIndex.value >= len) activeIndex.value = Math.max(0, len - 1)
  },
)

watch(activeIndex, () => {
  void nextTick(scrollActiveIntoView)
})

onMounted(() => {
  window.addEventListener('keydown', onGlobalKeydown, true)
  fsUnlisten = fsService.onFsChange(() => {
    vaultFileIndex.invalidate()
    if (open.value) void loadFiles()
  })
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onGlobalKeydown, true)
  void fsUnlisten?.then((unlisten) => unlisten())
  if (hideTimer) clearTimeout(hideTimer)
  cancelPaint()
})
</script>

<template>
  <Teleport to="body">
    <div
      v-if="open"
      class="palette-overlay"
      :class="{ 'is-open': visible }"
      role="presentation"
      @pointerdown.self="hide"
    >
      <div
        class="palette"
        role="dialog"
        aria-modal="true"
        :aria-label="t('palette.aria')"
      >
        <div class="palette-search">
          <Search
            class="palette-search-icon"
            :size="15"
            :stroke-width="1.8"
          />
          <input
            ref="inputRef"
            v-model="query"
            class="palette-input"
            type="text"
            :placeholder="t('palette.placeholder')"
            role="combobox"
            aria-autocomplete="list"
            aria-expanded="true"
            :aria-controls="LIST_ID"
            :aria-activedescendant="activeId"
            autocomplete="off"
            spellcheck="false"
            @keydown="onInputKeydown"
          >
        </div>
        <p
          v-if="!hasDocument"
          class="palette-note"
        >
          {{ t('chat.emptyDocHint') }}
        </p>
        <div
          :id="LIST_ID"
          ref="listRef"
          class="palette-list"
          role="listbox"
          :aria-label="t('palette.aria')"
        >
          <template
            v-for="group in rows"
            :key="group.key"
          >
            <div class="palette-group-label">
              {{ group.label }}
            </div>
            <button
              v-for="row in group.entries"
              :id="`${LIST_ID}-item-${row.index}`"
              :key="row.entry.id"
              class="palette-item"
              :class="{ 'is-active': row.index === activeIndex }"
              type="button"
              role="option"
              :aria-selected="row.index === activeIndex"
              :data-index="row.index"
              tabindex="-1"
              @mousedown.prevent
              @mouseenter="activeIndex = row.index"
              @click="execute(row.entry)"
            >
              <span class="palette-item-icon">
                <component
                  :is="iconFor(row.entry)"
                  :size="14"
                  :stroke-width="1.8"
                />
              </span>
              <span class="palette-item-label">{{ row.entry.label }}</span>
              <span
                v-if="row.entry.hint"
                class="palette-item-hint"
              >{{ row.entry.hint }}</span>
            </button>
          </template>
          <div
            v-if="!flatRows.length && hasDocument"
            class="palette-empty"
          >
            {{ t('palette.empty') }}
          </div>
        </div>
        <div class="palette-footer">
          <span><kbd>↑</kbd><kbd>↓</kbd> {{ t('palette.footerSelect') }}</span>
          <span><kbd>Enter</kbd> {{ t('palette.footerExecute') }}</span>
          <span><kbd>Esc</kbd> {{ t('palette.footerClose') }}</span>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.palette-overlay {
  position: fixed;
  inset: 0;
  z-index: 10000;
  display: flex;
  align-items: flex-start;
  justify-content: center;
  padding: 12vh 16px 16px;
  background: color-mix(in srgb, var(--app-canvas) 45%, transparent);
  backdrop-filter: blur(2px);
  opacity: 0;
  transition: opacity var(--app-motion) var(--app-ease);
}
.palette-overlay.is-open {
  opacity: 1;
}
.palette {
  display: flex;
  flex-direction: column;
  width: min(560px, 100%);
  overflow: hidden;
  border: 1px solid color-mix(in srgb, var(--app-border) 86%, transparent);
  border-radius: var(--app-radius-xl);
  background: color-mix(in srgb, var(--app-elevated) 97%, var(--app-panel));
  box-shadow: var(--app-shadow-dialog);
  transform: translateY(6px) scale(0.985);
  transition: transform var(--app-motion) var(--app-ease);
}
.palette-overlay.is-open .palette {
  transform: none;
}
.palette-search {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 14px;
  border-bottom: 1px solid color-mix(in srgb, var(--app-border) 60%, transparent);
  color: var(--app-muted);
}
.palette-search-icon {
  flex: none;
}
.palette-input {
  flex: 1;
  min-width: 0;
  border: none;
  outline: none;
  background: transparent;
  color: var(--app-text);
  font-family: var(--app-font);
  font-size: 13px;
}
.palette-input::placeholder {
  color: var(--app-muted);
}
/* Why the command group is empty (no document open). The copy is the existing
   "open a document first" hint (chat.emptyDocHint): a palette-specific key would
   have to be added to both locales, which is outside this change. */
.palette-note {
  padding: 10px 14px 0;
  font-size: 11px;
  color: var(--app-muted);
}
.palette-list {
  max-height: min(420px, 56vh);
  overflow-y: auto;
  padding: 6px;
}
.palette-group-label {
  padding: 8px 8px 4px;
  font-size: 10px;
  font-weight: 650;
  letter-spacing: 0.06em;
  color: var(--app-muted);
}
.palette-item {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  height: 32px;
  padding: 0 8px;
  border: none;
  border-radius: var(--app-radius-sm);
  background: transparent;
  color: var(--app-text);
  font-family: var(--app-font);
  font-size: 12px;
  letter-spacing: -0.01em;
  text-align: left;
  cursor: pointer;
  transition: background var(--app-motion-fast) var(--app-ease),
              color var(--app-motion-fast) var(--app-ease);
}
.palette-item.is-active {
  background: color-mix(in srgb, var(--app-accent-soft) 82%, var(--app-elevated));
}
.palette-item-icon {
  display: grid;
  place-items: center;
  width: 16px;
  flex: none;
  color: var(--app-muted);
}
.palette-item.is-active .palette-item-icon {
  color: var(--app-accent);
}
.palette-item-label {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 500;
}
.palette-item-hint {
  flex: none;
  max-width: 45%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 11px;
  color: var(--app-muted);
}
.palette-empty {
  padding: 24px 0;
  font-size: 12px;
  color: var(--app-muted);
  text-align: center;
}
.palette-footer {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 14px;
  border-top: 1px solid color-mix(in srgb, var(--app-border) 60%, transparent);
  font-size: 11px;
  color: var(--app-muted);
}
.palette-footer kbd {
  display: inline-block;
  min-width: 14px;
  margin-right: 2px;
  padding: 1px 5px;
  border: 1px solid color-mix(in srgb, var(--app-border) 70%, transparent);
  border-radius: var(--app-radius-xs);
  background: color-mix(in srgb, var(--app-panel) 70%, transparent);
  font-family: var(--app-font);
  font-size: 10px;
  line-height: 1.4;
  text-align: center;
  color: var(--app-muted);
}
</style>
