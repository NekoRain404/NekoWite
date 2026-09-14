/**
 * What the palette offers, and what the query keeps of it (§13.4: query).
 *
 * Three sources, curated in three different orders — the editor's commands
 * (builtin, plugin and toolbar), the recently opened notes and the vault's
 * files — are composed here and handed out already filtered, ranked and
 * grouped, so the panel renders rows it never had to sort.
 *
 * The store read, the command-registry read and the file index live behind
 * this boundary rather than in the component (§10.2). The command catalog
 * itself stays in `ui/`: the word toolbar reads the same labels, so it is
 * shared code with two real callers and not this feature's to move (§13.11).
 */

import { computed, onBeforeUnmount, onMounted, ref, type ComputedRef, type Ref } from 'vue'
import { BUILTIN_COMMAND_IDS, getToolbar, listCommands } from '@nekowite/editor-core'
import { t } from '../../../i18n'
import { fsService } from '../../../platform/gateways/fs'
import { runEditorCommand } from '../../../services/runEditorCommand'
import { vaultFileIndex } from '../../../services/vaultFiles'
import { useTabsStore } from '../../../stores/tabs'
import { catalogOf, COMMAND_KEYS } from '../../../ui/commandCatalog'
import {
  fileEntryOf,
  filterEntries,
  groupEntries,
  type PaletteEntry,
} from '../services/commandPaletteLogic'
import type { PaletteGroupRows, PaletteRow } from '../types'

/** How many file hits a non-empty query keeps. */
const FILE_RESULT_LIMIT = 20

export interface UsePaletteEntriesOptions {
  /** The query the user has typed. */
  query: Ref<string>
  /** Whether the palette is on screen. Read on every fs event — never during
   *  setup — so the two composables can be created in either order. */
  isOpen: () => boolean
}

export interface UsePaletteEntries {
  /** Drives the empty-state note above the list. */
  hasDocument: ComputedRef<boolean>
  rows: ComputedRef<PaletteGroupRows[]>
  flatRows: ComputedRef<PaletteRow[]>
  /** Everything an open has to re-read. */
  refreshForOpen: () => void
}

export function usePaletteEntries(options: UsePaletteEntriesOptions): UsePaletteEntries {
  const tabs = useTabsStore()

  // Every command the palette offers is an editor command: it runs against the
  // live rendered/source model (see runEditorCommand). With no document open there
  // is no model, so nothing below can be offered honestly.
  const hasDocument = computed(() => tabs.activeTab !== null)

  const files = ref<string[]>([])

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

  const trimmed = computed(() => options.query.value.trim())

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

  async function loadFiles(): Promise<void> {
    const vault = tabs.vault
    if (!vault) {
      files.value = []
      return
    }
    files.value = await vaultFileIndex.get(vault)
  }

  /** The registry is not reactive and the vault may have gained or lost files
   *  while the palette was closed, so a fresh open re-reads both. */
  function refreshForOpen(): void {
    registryRevision.value += 1
    void loadFiles()
  }

  // A file appearing or disappearing elsewhere in the app invalidates the
  // cached walk; an open palette shows the new list at once.
  let fsUnlisten: Promise<() => void> | null = null

  onMounted(() => {
    fsUnlisten = fsService.onFsChange(() => {
      vaultFileIndex.invalidate()
      if (options.isOpen()) void loadFiles()
    })
  })

  onBeforeUnmount(() => {
    void fsUnlisten?.then((unlisten) => unlisten())
  })

  return { hasDocument, rows, flatRows, refreshForOpen }
}
