<script setup lang="ts">
import { computed, markRaw, ref, watch } from 'vue'
import {
  ArrowDownWideNarrow,
  BookOpen,
  Download,
  FileDown,
  FolderOpen,
  Link2,
  ListTree,
  PencilLine,
  Search,
  Star,
  StarOff,
  TextSearch,
  Trash2,
} from 'lucide-vue-next'
import { splitFrontmatter } from '@nekowite/editor-core'
import NoteCard from './NoteCard.vue'
import type { NoteCardContextTarget } from './NoteCard.vue'
import GraphPanel from './GraphPanel.vue'
import AttachmentsPanel from './AttachmentsPanel.vue'
import { FileTree } from '../features/vault'
import ContextMenu from './ContextMenu.vue'
import type { ContextMenuItem } from './ContextMenu.vue'
import { useAppearanceStore } from '../stores/appearance'
import { useDocumentListStore } from '../stores/documentList'
import { useRefsStore } from '../stores/refs'
import { useVaultSessionStore } from '../stores/vaultSession'
import { useFileTreeStore } from '../stores/fileTree'
import { useTabsStore } from '../stores/tabs'
import { useViewStore } from '../stores/view'
import { fsService } from '../platform/gateways/fs'
import { parseOutline } from '../services/outline'
import { dirRelativeToVault } from '../services/noteMeta'
import { inlinksOf as queryInlinks, outlinksOf as queryOutlinks } from '../features/vault/services/libraryQueries'
import {
  CONTENT_SEARCH_CONCURRENCY,
  searchWithIndex,
  type ContentMatch,
  type ContentSearchCandidate,
} from '../services/contentSearch'
import { t } from '../i18n'
import { baseName, samePath } from '../services/paths'
import {
  isCaseOnlyRename,
  noteActionTarget,
  noteRenameNameError,
  noteRenameTargetPath,
  readTargetContent,
} from '../services/noteActions'
import type { NoteActionDeps } from '../services/noteActions'
import { moveOrRepair } from '../services/noteMoveFlow'
import { deleteNoteWithAssets } from '../services/noteDelete'
import { describeExportError, notifyError } from '../services/errors'
import { exportHtml, exportToPdf, type ExportUiOptions } from '../services/export'
import { exportBaseName } from '../services/exportName'
import { toExportRefs } from '../services/exportRefs'
import { isPathWithinVault } from '../services/attachments'
import { flushEdits } from '../services/editorOwnership'
import { isComposingKey } from '../services/keyGuard'

const appearance = useAppearanceStore()
const documentList = useDocumentListStore()
const refs = useRefsStore()
const vaultSession = useVaultSessionStore()
const fileTree = useFileTreeStore()
const tabs = useTabsStore()
const view = useViewStore()

const sortMenu = ref<{ x: number; y: number } | null>(null)

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
  // A half-finished rename or delete question belongs to the vault that is
  // being left: the paths it holds are absolute, and the delete would be aimed
  // at a path of the OLD vault while the new one is current.
  renameTarget.value = null
  renameError.value = ''
  deleteConfirmPath.value = null
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
  // The name must be derived with either separator in mind; on Windows this
  // produced the full absolute path and the backlink highlight never matched.
  const name = baseName(path)
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

/**
 * The note the card menu is acting on: the path recorded when the menu opened,
 * plus the click position. Every action reads THIS path — never
 * `tabs.activeTab`, which is a different note whenever the user right-clicks a
 * background card.
 */
const noteMenu = ref<NoteCardContextTarget | null>(null)

const NOTE_MENU_ICONS = {
  open: markRaw(FolderOpen),
  favorite: markRaw(Star),
  unfavorite: markRaw(StarOff),
  rename: markRaw(PencilLine),
  exportHtml: markRaw(Download),
  exportPdf: markRaw(FileDown),
  delete: markRaw(Trash2),
}

const noteMenuItems = computed<ContextMenuItem[]>(() => {
  const target = noteMenu.value
  if (!target) return []
  // Resolved on every render, so the label and icon always describe the action
  // for this note's CURRENT favourite state instead of a cached one.
  const favorite = documentList.isFavorite(target.path)
  return [
    { id: 'open', label: t('notecard.open'), icon: NOTE_MENU_ICONS.open },
    {
      id: 'toggle-favorite',
      label: t(favorite ? 'notecard.unfavorite' : 'notecard.favorite'),
      // The icon matches the label's action: Star = add, StarOff = remove.
      icon: favorite ? NOTE_MENU_ICONS.unfavorite : NOTE_MENU_ICONS.favorite,
    },
    { id: 'rename', label: t('filetree.rename'), icon: NOTE_MENU_ICONS.rename },
    { id: 'export-html', label: t('notecard.exportHtml'), icon: NOTE_MENU_ICONS.exportHtml },
    { id: 'export-pdf', label: t('notecard.exportPdf'), icon: NOTE_MENU_ICONS.exportPdf },
    // A leading divider sets the destructive action apart from the rest.
    {
      id: 'delete',
      label: t('filetree.delete'),
      icon: NOTE_MENU_ICONS.delete,
      separator: true,
      danger: true,
    },
  ]
})

function openNoteMenu(target: NoteCardContextTarget): void {
  noteMenu.value = target
}

function onNoteMenuSelect(id: string): void {
  // ContextMenu emits `select` before `close`, so the target recorded when the
  // menu opened is still here.
  const target = noteMenu.value
  if (!target) return
  switch (id) {
    case 'open':
      openNote(target.path)
      break
    case 'toggle-favorite':
      documentList.toggleFavorite(target.path)
      break
    case 'rename':
      startNoteRename(target.path)
      break
    case 'export-html':
      void exportNoteHtml(target.path)
      break
    case 'export-pdf':
      void exportNotePdf(target.path)
      break
    case 'delete':
      requestNoteDelete(target.path)
      break
  }
}

function openNote(path: string | null): void {
  if (!path) return
  void tabs.openTab(path)
}

/**
 * Re-run the vault index after a note moved or went to the trash. The note list
 * is a mirror of that index, so this is what makes the renamed note appear under
 * its new name (and the deleted one disappear) without waiting for the fs
 * watcher — and the index run is also what prunes favorites/recents pointing at
 * paths that no longer exist (see `vaultIndexCoordinator` →
 * `documentList.setFavoritesRecents`).
 */
async function refreshNoteIndex(): Promise<void> {
  try {
    await vaultSession.rebuildIndex()
  } catch {
    // The rename/delete itself already happened; the refresh is fire-and-forget
    // and must not surface as an unhandled rejection for an action that
    // succeeded. The fs watcher and the index-state chip stay the way back to a
    // fresh list.
  }
}

// --- rename -----------------------------------------------------------------

/**
 * The note whose name is being edited in place, and what has been typed.
 *
 * Bound by PATH, never by the active tab: the editor is opened from the card the
 * user right-clicked, which is usually a note that is not open at all.
 */
const renameTarget = ref<{ path: string; name: string } | null>(null)
const renameName = ref('')
const renameError = ref('')
let renameInFlight = false

/** Focus and pre-select the name as soon as the input renders, so a rename is
 *  type-then-Enter (the tree's inline rename behaves the same way). */
function setRenameInput(el: unknown): void {
  const input = el instanceof HTMLInputElement ? el : null
  if (!input) return
  input.focus()
  input.select()
}

function startNoteRename(path: string): void {
  const name = baseName(path)
  renameTarget.value = { path, name }
  renameName.value = name
  renameError.value = ''
}

function cancelNoteRename(): void {
  // A rename already on its way may not be torn down from under itself; its own
  // completion clears the editor.
  if (renameInFlight) return
  renameTarget.value = null
  renameError.value = ''
}

/** Enter commits and Escape cancels — but not while an IME is composing: there
 *  Enter accepts the highlighted candidate and Escape dismisses the candidate
 *  list, and treating those as app actions renames the note to raw pinyin or
 *  throws the typed name away. */
function onRenameKeydown(e: KeyboardEvent): void {
  if (isComposingKey(e)) return
  if (e.key === 'Enter') {
    e.preventDefault()
    void confirmNoteRename()
  } else if (e.key === 'Escape') {
    e.preventDefault()
    cancelNoteRename()
  }
}

/** True when `path` already exists. A rejection is the answer "no": the gateway
 *  reports a missing path by failing (`stat`), which is how the delete flow
 *  probes for a note's `_assets` folder too. */
async function notePathExists(vault: string, path: string): Promise<boolean> {
  try {
    await fsService.stat(vault, path)
    return true
  } catch {
    return false
  }
}

async function confirmNoteRename(): Promise<void> {
  const target = renameTarget.value
  if (!target || renameInFlight) return
  const invalid = noteRenameNameError(renameName.value)
  if (invalid) {
    renameError.value = t(invalid)
    return
  }
  const to = noteRenameTargetPath(target.path, renameName.value)
  // The same path is not a move. This must stay a plain comparison: a case-only
  // rename (`note.md` → `Note.md`) IS a real rename the backend runs, and
  // `samePath` would fold it away as "no change".
  if (to === target.path) {
    cancelNoteRename()
    return
  }
  const vault = tabs.vault
  if (!vault) return
  renameInFlight = true
  try {
    // A name that is already taken is refused before anything moves, so a clash
    // cannot leave the note half-renamed — EXCEPT for a case-only rename, whose
    // target IS the source file on a case-insensitive filesystem.
    if (!isCaseOnlyRename(target.path, to) && (await notePathExists(vault, to))) {
      renameError.value = t('tree.conflict')
      return
    }
    // The shared move: flush pending edits, arm the self-write/move claims,
    // carry `<basename>_assets` and the note-relative references, retarget the
    // open tabs, and repair them if the move fails after its rename landed.
    await moveOrRepair(vault, target.path, to, false)
  } catch {
    notifyError(t('filetree.renameFailed'))
    // The editor stays open on the note it failed to rename: the name is a
    // correction away from working, and closing it would hide which note failed.
    return
  } finally {
    renameInFlight = false
  }
  renameTarget.value = null
  renameError.value = ''
  await refreshNoteIndex()
}

// --- delete -----------------------------------------------------------------

/**
 * Paths whose delete is already in flight. One deliberate activation deletes
 * once: a second pick from the menu while the first delete is still running, or
 * a second press on the confirm button, must not aim a second trash entry at a
 * path that is already on its way out. The same guard the file tree keeps.
 */
const deleting = new Set<string>()

/** The note the confirmation step is waiting on (never set while the gate is
 *  off — then the menu pick is the whole gesture). */
const deleteConfirmPath = ref<string | null>(null)

/**
 * Ask for `path` to be deleted.
 *
 * Deleting is destructive, so by default the menu item only arms the card and
 * the following confirm button performs the delete; with "confirm before
 * deleting" switched off that button is the whole gesture, exactly as in the
 * file tree.
 */
function requestNoteDelete(path: string): void {
  if (deleting.has(path)) return
  if (!appearance.confirmBeforeDelete) {
    void performNoteDelete(path)
    return
  }
  deleteConfirmPath.value = path
}

function cancelNoteDelete(): void {
  deleteConfirmPath.value = null
}

async function performNoteDelete(path: string): Promise<void> {
  if (deleting.has(path)) return
  deleting.add(path)
  const vault = tabs.vault
  try {
    if (!vault) return
    const tab = tabs.tabs.find((t) => t.path === path)
    if (tab) {
      // The tabs store deletes the note WITH its `_assets` folder and closes
      // every tab on that path, so the open-note branch owns the whole gesture.
      await tabs.deleteTabFile(tab.id)
    } else {
      // A note with no tab still owns a `<basename>_assets` folder; leaving it
      // behind kept its images on disk while nothing in the app could list or
      // reclaim them.
      const result = await deleteNoteWithAssets(
        {
          deleteFile: (v, p) => fsService.deleteFile(v, p),
          exists: async (v, p) => {
            await fsService.stat(v, p)
            return true
          },
        },
        vault,
        path,
      )
      // The note is gone, its images are not: say so rather than report a clean
      // delete — the user has to be able to find them if they want them.
      if (result.assetsFailed) notifyError(t('filetree.deleteAssetsFailed'))
    }
  } catch {
    notifyError(t('filetree.deleteFailed'))
  } finally {
    deleting.delete(path)
    deleteConfirmPath.value = null
    await refreshNoteIndex()
  }
}

// --- export -----------------------------------------------------------------

/**
 * The dependencies {@link readTargetContent} resolves a target's text with,
 * built from the stores this panel already holds. The lookup keys on the path
 * — it is asked for the right-clicked note's tab, not for the active one — and
 * the read is the fs gateway's own vault read.
 */
function noteExportDeps(): NoteActionDeps {
  return {
    read: (vault, path) => fsService.read(vault, path),
    findTab: (path) => tabs.tabs.find((t) => t.path !== null && samePath(t.path, path)) ?? null,
    flushEdits: () => flushEdits(),
    openTab: (path) => tabs.openTab(path),
  }
}

/**
 * The options both exports hand to the pipeline.
 *
 * `notePath` is the load-bearing one: attachments and citations are resolved
 * against it, so leaving it out resolves the target's `![](pic.png)` against
 * whatever note happens to be open — the wrong-note bug this whole menu is
 * built to avoid. `refs` is the same map the settings dialog exports with, so
 * a cited `[@key]` renders identically whichever way the note leaves the app.
 */
function noteExportOptions(path: string): ExportUiOptions {
  return {
    title: exportBaseName(path),
    notePath: path,
    refs: toExportRefs(refs.refs.values()),
  }
}

/**
 * Export the right-clicked note as a self-contained `.html` file.
 *
 * The source is the target's LATEST text ({@link readTargetContent}: its own
 * open tab, flushed first when it is the active one, its file otherwise), and
 * the default name is the target's. Everything happens about `path`; the
 * active tab is not an input.
 */
async function exportNoteHtml(path: string): Promise<void> {
  const vault = tabs.vault
  // The dialog comes first, so a cancelled save is a decision with no side
  // effects at all — nothing is read, nothing is exported, nothing is said.
  const savePath = await fsService.saveFileDialog(exportBaseName(path) + '.html', vault ?? undefined)
  if (!savePath) return
  // The native dialog can aim anywhere (Desktop, Home, …), but the backend's
  // write is vault-confined: an outside path is rejected with "path escapes
  // vault" and the export dies silently behind the closed dialog. Refuse it up
  // front, with the message the settings dialog already shows.
  if (vault && !isPathWithinVault(savePath, vault)) {
    notifyError(t('error.exportOutsideVault'))
    return
  }
  try {
    const source = await readTargetContent(noteExportDeps(), vault, noteActionTarget(path))
    await exportHtml(source, vault ?? '', savePath, noteExportOptions(path))
  } catch (e) {
    // Reported, never swallowed: a rejected read (the note is gone) and a
    // rejected write look exactly like the menu item doing nothing.
    notifyError(describeExportError(e))
  }
}

/** Export the right-clicked note through the app's own print frame. There is
 *  no destination to pick, so only the target matters. */
async function exportNotePdf(path: string): Promise<void> {
  const vault = tabs.vault
  try {
    const source = await readTargetContent(noteExportDeps(), vault, noteActionTarget(path))
    await exportToPdf(source, noteExportOptions(path))
  } catch (e) {
    notifyError(describeExportError(e))
  }
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
          <template
            v-for="note in documentList.visibleNotes"
            :key="note.path"
          >
            <!-- The rename editor takes the card's place: the note being
                 renamed is the card the user right-clicked, so the input sits
                 where they were looking instead of at the top of the list. -->
            <div
              v-if="renameTarget?.path === note.path"
              class="nl-rename-row"
            >
              <input
                :ref="setRenameInput"
                v-model="renameName"
                class="nl-rename-input"
                :class="{ invalid: !!renameError }"
                type="text"
                :aria-label="t('filetree.rename')"
                @click.stop
                @keydown.stop="onRenameKeydown"
                @blur="cancelNoteRename"
              >
              <span
                v-if="renameError"
                class="nl-rename-error"
              >{{ renameError }}</span>
            </div>
            <!-- Same place for the delete question, and the name is shown so
                 the note under it is never in doubt. -->
            <div
              v-else-if="deleteConfirmPath === note.path"
              class="nl-del-confirm"
            >
              <span
                class="nl-del-name"
                :title="note.path"
              >{{ note.name }}</span>
              <button
                type="button"
                class="btn btn-secondary btn-sm nl-del-yes"
                @click.stop="performNoteDelete(note.path)"
              >
                {{ t('filetree.confirm') }}
              </button>
              <button
                type="button"
                class="btn btn-ghost btn-sm nl-del-no"
                @click.stop="cancelNoteDelete"
              >
                {{ t('filetree.cancel') }}
              </button>
            </div>
            <NoteCard
              v-else
              :note="note"
              :active="note.path === activePath"
              :favorite="documentList.isFavorite(note.path)"
              @open="openNote(note.path)"
              @toggle-favorite="documentList.toggleFavorite(note.path)"
              @contextmenu="openNoteMenu"
            />
          </template>
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

    <ContextMenu
      v-if="noteMenu"
      :x="noteMenu.x"
      :y="noteMenu.y"
      :items="noteMenuItems"
      @select="onNoteMenuSelect"
      @close="noteMenu = null"
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

/* Inline rename: the card's own place in the list, so the note being edited
   stays where the user right-clicked it. */
.nl-rename-row {
  display: flex;
  align-items: center;
  gap: 6px;
  min-height: 32px;
  padding: 4px 6px;
}
.nl-rename-input {
  flex: 1;
  min-width: 0;
  height: 26px;
  padding: 0 8px;
  font-family: var(--app-font);
  font-size: 12px;
  letter-spacing: -0.01em;
  color: var(--app-text);
  background: var(--app-canvas);
  border: 1px solid var(--app-accent);
  border-radius: var(--app-radius-sm);
  outline: none;
}
.nl-rename-input.invalid { border-color: var(--app-danger); }
.nl-rename-error {
  flex: none;
  max-width: 55%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 10px;
  color: var(--app-danger);
}

/* Delete question: the card's place, framed in the danger colour so it is not
   mistaken for the card itself. */
.nl-del-confirm {
  display: flex;
  align-items: center;
  gap: 6px;
  min-height: 34px;
  padding: 3px 8px;
  border: 1px solid color-mix(in srgb, var(--app-danger) 42%, transparent);
  border-radius: var(--app-radius-sm);
  background: color-mix(in srgb, var(--app-danger) 10%, transparent);
}
.nl-del-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
  font-weight: 550;
  letter-spacing: -0.01em;
  color: var(--app-text);
}
.nl-del-confirm .btn { flex: none; }

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
