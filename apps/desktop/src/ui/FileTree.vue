<script setup lang="ts">
import { computed, markRaw, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { ChevronRight, FilePlus2, FileText, Folder, FolderOpen, FolderPlus, PencilLine, Trash2 } from 'lucide-vue-next'
import { fsService } from '../platform/gateways/fs'
import type { FileEntry, FsChangeEvent } from '../platform/gateways/fs'
import { resolveDropTarget, type DropRow } from '../services/treeDrop'
import { notifyError } from '../services/errors'
import { useTabsStore } from '../stores/tabs'
import ContextMenu from './ContextMenu.vue'
import type { ContextMenuItem } from './ContextMenu.vue'
import { t } from '../i18n'
import { dirName, joinPath } from '../services/paths'
import { moveNote } from '../services/noteMove'
import type { NoteMoveIo } from '../services/noteMove'
import { flushEdits } from '../services/editorOwnership'
import { isComposingKey } from '../services/keyGuard'

interface TreeNode {
  name: string
  path: string
  is_dir: boolean
  is_mdx: boolean
  expanded: boolean
  loading: boolean
  children: TreeNode[]
}

interface TreeEdit {
  kind: 'file' | 'dir' | 'rename'
  parentPath: string
  nodePath?: string
  /** For `rename`: whether the entry is a directory. Only a renamed note needs
   *  the reference rewrite; a folder carries its contents with it. */
  nodeIsDir?: boolean
}

const props = defineProps<{ vault: string }>()
// The `conflict` emit is gone: the keep-or-reload question is raised by the
// app-level external-change service, so this component no longer needs a
// channel up to the shell for it.

const tabs = useTabsStore()
const root = ref<TreeNode | null>(null)
const unlisten = ref<(() => void) | null>(null)
const confirmPath = ref<string | null>(null)
const activePath = computed(() => tabs.activeTab?.path ?? null)
const selectedDirPath = ref<string | null>(null)
const menu = ref<{ x: number; y: number; node: TreeNode | null } | null>(null)
const pendingEdit = ref<TreeEdit | null>(null)
const editName = ref('')
const editError = ref('')
const editInput = ref<HTMLInputElement | null>(null)
const dragState = ref<{ path: string; isDir: boolean } | null>(null)
const dropTargetPath = ref<string | null>(null)
let confirming = false

/** The four fs operations `moveNote` wants, bound to the shared gateway. The
 *  service takes them as plain functions so it stays testable without Tauri
 *  (the injection shape `externalDocSync` / `recoveryClosedLoop` use). */
const noteMoveIo: NoteMoveIo = {
  read: (vault, path) => fsService.read(vault, path),
  // `moveNote` writes the rewritten body and reports its own failures; the
  // warning channel (a history snapshot that could not be kept) is not its to
  // surface — the tab's save does that.
  write: (vault, path, content) => fsService.write(vault, path, content).then(() => undefined),
  rename: (vault, from, to) => fsService.renameEntry(vault, from, to),
  list: (vault, dir) => fsService.list(vault, dir),
}

const MENU_ICONS = {
  filePlus: markRaw(FilePlus2),
  folderPlus: markRaw(FolderPlus),
  pencil: markRaw(PencilLine),
  trash: markRaw(Trash2),
}

const menuItems = computed<ContextMenuItem[]>(() => {
  const node = menu.value?.node ?? null
  const items: ContextMenuItem[] = [
    { id: 'new-file', label: t('filetree.newFile'), icon: MENU_ICONS.filePlus },
    { id: 'new-dir', label: t('filetree.newFolder'), icon: MENU_ICONS.folderPlus },
  ]
  if (node && root.value && node.path !== root.value.path) {
    items.push(
      { id: 'rename', label: t('filetree.rename'), icon: MENU_ICONS.pencil, separator: true },
      { id: 'delete', label: t('filetree.delete'), icon: MENU_ICONS.trash, danger: true },
    )
  }
  return items
})

function cancelDelete(): void {
  confirmPath.value = null
}

async function confirmDelete(path: string): Promise<void> {
  const tab = tabs.tabs.find((t) => t.path === path)
  try {
    if (tab) await tabs.deleteTabFile(tab.id)
    else {
      await fsService.deleteFile(props.vault, path)
      for (const t of [...tabs.tabs]) {
        if (t.path && (t.path === path || t.path.startsWith(path + '/'))) tabs.removeTab(t.id)
      }
    }
  } catch {
    notifyError(t('filetree.deleteFailed'))
  } finally {
    confirmPath.value = null
    await refreshAncestors(path)
  }
}

function makeNode(e: FileEntry): TreeNode {
  return {
    name: e.name,
    path: e.path,
    is_dir: e.is_dir,
    is_mdx: e.is_mdx,
    expanded: false,
    loading: false,
    children: [],
  }
}

async function listChildren(node: TreeNode): Promise<void> {
  if (node.loading) return
  node.loading = true
  try {
    const entries = await fsService.list(props.vault, node.path)
    node.children = entries.filter((e) => !(e.is_dir && e.name === 'node_modules')).map(makeNode)
  } catch {
    notifyError(t('filetree.listFailed', { path: node.path }))
  } finally {
    node.loading = false
  }
}

function walk(node: TreeNode, depth: number, out: { node: TreeNode; depth: number }[]): void {
  out.push({ node, depth })
  if (node.is_dir && node.expanded) {
    for (const child of node.children) walk(child, depth + 1, out)
  }
}

const flat = computed(() => {
  const out: { node: TreeNode; depth: number }[] = []
  if (root.value) walk(root.value, 0, out)
  return out
})

/** Flattened rows as the pure drop-resolver expects them. */
const rowsForDrop = computed<DropRow[]>(() =>
  flat.value.map((r) => ({ path: r.node.path, isDir: r.node.is_dir })),
)

const currentDirPath = computed(() => {
  const sel = selectedDirPath.value
  if (root.value && sel === root.value.path) return root.value.path
  if (sel && flat.value.some((r) => r.node.path === sel && r.node.is_dir)) return sel
  return root.value?.path ?? props.vault
})

const currentDirLabel = computed(() => {
  const row = flat.value.find((r) => r.node.path === currentDirPath.value)
  return row?.node.name ?? props.vault
})

/** Where the inline creation input should render (after the parent's last
 * visible descendant; the vault root's input sits right below the root row). */
const inlineEdit = computed(() => {
  const p = pendingEdit.value
  if (!p || p.kind === 'rename') return null
  const rows = flat.value
  const idx = rows.findIndex((r) => r.node.path === p.parentPath)
  if (idx < 0) return null
  if (idx === 0) return { afterPath: rows[0].node.path, depth: 1, kind: p.kind }
  const parentDepth = rows[idx].depth
  let end = idx
  while (end + 1 < rows.length && rows[end + 1].depth > parentDepth) end++
  return { afterPath: rows[end].node.path, depth: parentDepth + 1, kind: p.kind }
})

async function toggle(node: TreeNode): Promise<void> {
  if (!node.is_dir) return
  selectedDirPath.value = node.path
  if (!node.expanded) await listChildren(node)
  node.expanded = !node.expanded
}

async function openFile(node: TreeNode): Promise<void> {
  // Only markdown/MDX documents open in a tab; other files (references
  // library, images, ...) are listed for discovery but not editor targets.
  if (node.is_dir || !node.is_mdx) return
  selectedDirPath.value = dirOf(node.path)
  await tabs.openTab(node.path)
}

function dirOf(path: string): string {
  // Tree rows carry absolute paths in the platform's native spelling
  // (`\\?\C:\...\note.md` on Windows). A `/`-only split returned the whole
  // path, so the parent lookup never matched a directory node and RENAME
  // silently did nothing at all.
  return dirName(path)
}

async function refreshAncestors(path: string): Promise<void> {
  const dir = dirOf(path)
  const targets = new Set<TreeNode>()
  if (root.value) targets.add(root.value)
  for (const { node } of flat.value) {
    if (!node.is_dir || !node.expanded) continue
    if (dir === node.path || dir.startsWith(node.path + '/')) targets.add(node)
  }
  for (const t of targets) await listChildren(t)
}

function onDragStart(node: TreeNode, e: DragEvent): void {
  dragState.value = { path: node.path, isDir: node.is_dir }
  if (e.dataTransfer) {
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/nekowite-path', node.path)
    e.dataTransfer.setData('text/plain', node.path)
  }
}

/** Keep the drop target highlighted only where the pure resolver approves;
 * still prevent the (empty, no-op) default drag so the drop event lands here. */
function onDragOver(row: { node: TreeNode }, e: DragEvent): void {
  if (!dragState.value) return
  if (!row.node.is_dir) {
    dropTargetPath.value = null
    return
  }
  e.preventDefault()
  const result = resolveDropTarget(
    rowsForDrop.value,
    dragState.value.path,
    row.node.path,
    root.value?.path,
  )
  if (result.ok && e.dataTransfer) {
    e.dataTransfer.dropEffect = 'move'
    dropTargetPath.value = row.node.path
  } else {
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'none'
    dropTargetPath.value = null
  }
}

function onDragLeave(): void {
  dropTargetPath.value = null
}

function onDragEnd(): void {
  dragState.value = null
  dropTargetPath.value = null
}

function onDrop(row: { node: TreeNode }, e: DragEvent): void {
  e.preventDefault()
  const drag = dragState.value
  if (!drag) {
    dropTargetPath.value = null
    return
  }
  const result = resolveDropTarget(
    rowsForDrop.value,
    drag.path,
    row.node.path,
    root.value?.path,
  )
  dropTargetPath.value = null
  if (!result.ok || !result.to) {
    notifyError(result.reason === 'conflict' ? t('tree.conflict') : t('tree.dropInvalid'))
    dragState.value = null
    return
  }
  void performMove(result.from, result.to, drag.isDir)
}

/** Move a tree entry and keep everything that points at it in step: the note's
 *  file-relative references and sibling `_assets` folder (via `moveNote`), the
 *  open tab's path, and — when the service rewrote the body on disk — the
 *  tab's text. */
async function moveEntry(from: string, to: string, isDir: boolean): Promise<void> {
  // Publish pending keystrokes first: the service is a read-modify-write of the
  // file on disk, while each pane coalesces keystrokes before publishing them
  // to the tab (the same reason `saveTab` flushes before it writes).
  await flushEdits()
  // Arm BOTH spellings before the first mutation. The open tab still points at
  // `from` until `renamePathInTabs` runs, and the fs watcher reports our own
  // rename/rewrite back to the app-level external-change service: without this
  // a dirty tab would raise a bogus keep-or-reload prompt for a file we moved
  // ourselves.
  tabs.noteSelfWrite(from)
  tabs.noteSelfWrite(to)
  // Tell the app-level external-change service that THIS path is being moved by
  // us. The watcher reports a rename as a change to the parent folder, so the
  // service looks at every open tab inside it while the tab still points at the
  // old name - which no longer exists once the rename has landed and
  // `renamePathInTabs` has not run yet. Without the claim the tab would be
  // detached as if the file had been moved behind the user's back.
  tabs.beginMove(from)
  try {
    if (isDir) {
      // A folder carries its contents, so each note's own `_assets` references
      // still resolve and only the tab paths change. References OUT of the folder
      // (the vault-level `attachments/` tree) would need every note inside to be
      // rewritten; that subtree case is deliberately left as a plain rename.
      await fsService.renameEntry(props.vault, from, to)
      tabs.renamePathInTabs(from, to)
      return
    }
    const moved = await moveNote(noteMoveIo, props.vault, from, to)
    tabs.renamePathInTabs(from, to, moved)
  } finally {
    tabs.endMove(from)
  }
}

/**
 * A move can fail AFTER its rename landed: `moveNote` rewrites the body at the
 * new path and its own rollback is best effort. When that happens the tab is
 * left pointing at a name that no longer exists — the app would then report the
 * user's own rename as an external deletion, detach the note and turn Ctrl+S
 * into a native "save as". Point the tabs at whichever file really exists and
 * let the editor adopt its bytes (a dirty tab keeps the user's text; see
 * `reloadFromDisk`).
 */
async function retargetAfterFailedMove(from: string, to: string): Promise<void> {
  const exists = async (path: string): Promise<boolean> => {
    try {
      await fsService.read(props.vault, path)
      return true
    } catch {
      return false
    }
  }
  if (await exists(from)) return
  if (!(await exists(to))) return
  tabs.renamePathInTabs(from, to)
  for (const tab of tabs.tabs) {
    if (tab.path === to) void tabs.reloadFromDisk(tab.id)
  }
}

/**
 * Both ways of moving a note - the inline rename and drag-and-drop - need the
 * same repair, because both can fail after the rename itself landed. Throws the
 * original error so the caller keeps wording its own message.
 */
async function moveOrRepair(from: string, to: string, isDir: boolean): Promise<void> {
  try {
    await moveEntry(from, to, isDir)
  } catch (error) {
    await retargetAfterFailedMove(from, to)
    throw error
  }
}

async function performMove(from: string, to: string, isDir: boolean): Promise<void> {
  try {
    await moveOrRepair(from, to, isDir)
  } catch {
    notifyError(t('tree.moveFailed'))
  } finally {
    // Refresh even after a failure: a move that landed the note but not its
    // references must not leave stale rows on screen.
    await refreshAncestors(from)
    await refreshAncestors(to)
    dragState.value = null
    dropTargetPath.value = null
  }
}

function openMenu(node: TreeNode | null, e: MouseEvent): void {
  menu.value = { x: e.clientX, y: e.clientY, node }
}

function findDirNode(path: string): TreeNode | null {
  if (root.value && root.value.path === path) return root.value
  for (const row of flat.value) {
    if (row.node.is_dir && row.node.path === path) return row.node
  }
  return null
}

async function ensureDirNode(path: string): Promise<TreeNode | null> {
  const node = findDirNode(path)
  if (!node) return null
  if (!node.expanded) {
    await listChildren(node)
    node.expanded = true
  }
  return node
}

async function startCreate(kind: 'file' | 'dir', parentPath: string): Promise<void> {
  const parent = await ensureDirNode(parentPath)
  if (!parent) return
  pendingEdit.value = { kind, parentPath: parent.path }
  editName.value = ''
  editError.value = ''
}

async function startRename(node: TreeNode): Promise<void> {
  const parent = await ensureDirNode(dirOf(node.path))
  if (!parent) return
  pendingEdit.value = {
    kind: 'rename',
    parentPath: parent.path,
    nodePath: node.path,
    nodeIsDir: node.is_dir,
  }
  editName.value = node.name
  editError.value = ''
}

async function onMenuSelect(id: string): Promise<void> {
  const target = menu.value?.node ?? null
  const parentPath = target ? (target.is_dir ? target.path : dirOf(target.path)) : currentDirPath.value
  if (id === 'new-file') await startCreate('file', parentPath)
  else if (id === 'new-dir') await startCreate('dir', parentPath)
  else if (id === 'rename' && target) await startRename(target)
  else if (id === 'delete' && target) confirmPath.value = target.path
}

function setEditInput(el: unknown): void {
  const input = el instanceof HTMLInputElement ? el : null
  editInput.value = input
  if (input) {
    input.focus()
    if (pendingEdit.value?.kind === 'rename') input.select()
  }
}

function cancelEdit(): void {
  if (confirming) return
  pendingEdit.value = null
  editError.value = ''
}

/** Enter commits and Escape cancels the inline create/rename input — but not
 *  while an IME is composing: there Enter accepts the highlighted candidate and
 *  Escape dismisses the candidate list, and treating those as app actions
 *  renamed the note to the raw pinyin string or discarded the typing entirely. */
function onEditKeydown(e: KeyboardEvent): void {
  if (isComposingKey(e)) return
  if (e.key === 'Enter') {
    e.preventDefault()
    void confirmEdit()
  } else if (e.key === 'Escape') {
    e.preventDefault()
    cancelEdit()
  }
}

async function confirmEdit(): Promise<void> {
  const p = pendingEdit.value
  if (!p || confirming) return
  const name = editName.value.trim()
  if (!name) {
    editError.value = t('filetree.nameRequired')
    return
  }
  if (name.includes('/')) {
    editError.value = t('filetree.nameSlash')
    return
  }
  if (name.startsWith('.')) {
    editError.value = t('filetree.nameDot')
    return
  }
  const parent = findDirNode(p.parentPath)
  const dup = parent?.children.some((c) => c.name === name && c.path !== p.nodePath) ?? false
  if (dup) {
    editError.value = t('filetree.nameDup')
    return
  }
  confirming = true
  try {
    await applyEdit(p, name)
  } finally {
    confirming = false
  }
}

async function applyEdit(p: TreeEdit, name: string): Promise<void> {
  try {
    if (p.kind === 'rename') {
      const from = p.nodePath
      if (!from) return
      const to = joinPath(dirOf(from), name)
      if (to !== from) {
        await moveOrRepair(from, to, p.nodeIsDir === true)
        await refreshAncestors(from)
      }
    } else {
      const path = `${p.parentPath}/${name}`
      if (p.kind === 'file') {
        await fsService.write(props.vault, path, '')
        await refreshAncestors(path)
        pendingEdit.value = null
        editError.value = ''
        await tabs.openTab(path)
        return
      }
      await fsService.createDir(props.vault, path)
      await refreshAncestors(path)
    }
  } catch {
    notifyError(p.kind === 'rename' ? t('filetree.renameFailed') : t('filetree.createFailed'))
    return
  }
  pendingEdit.value = null
  editError.value = ''
}

async function handleFsChange(e: FsChangeEvent): Promise<void> {
  // Reloading the OPEN document is handled at the app level (see
  // `services/externalDocSync`), because this component only exists while the
  // Folders panel is shown — the Notes panel (the default view) had no watcher
  // at all, so external edits went unnoticed. What is left here is the tree's
  // own concern: refreshing the rows that changed.
  await refreshAncestors(e.path)
}

function resetRoot(): void {
  root.value = {
    name: props.vault,
    path: props.vault,
    is_dir: true,
    is_mdx: false,
    expanded: true,
    loading: false,
    children: [],
  }
}

onMounted(async () => {
  resetRoot()
  await listChildren(root.value!)
  // The backend watcher itself is armed by the runtime when a vault is opened
  // (appBootstrap), NOT here: this component only exists while the Folders panel
  // is shown, so arming it here left the default Notes panel unwatched. What is
  // left for this component is reacting to the events, to refresh its rows.
  unlisten.value = await fsService.onFsChange(handleFsChange)
})

onBeforeUnmount(() => {
  unlisten.value?.()
})

watch(
  () => props.vault,
  async () => {
    // Drop the previous fs-change subscription before re-subscribing on a
    // vault switch so handlers don't stack across vaults.
    unlisten.value?.()
    unlisten.value = null
    menu.value = null
    pendingEdit.value = null
    confirmPath.value = null
    selectedDirPath.value = null
    resetRoot()
    await listChildren(root.value!)
    unlisten.value = await fsService.onFsChange(handleFsChange)
  },
)
</script>

<template>
  <div class="file-tree">
    <div class="tree-toolbar">
      <button
        class="tree-tool"
        :title="t('filetree.newFile')"
        @click="startCreate('file', currentDirPath)"
      >
        <FilePlus2
          :size="14"
          :stroke-width="1.8"
        />
      </button>
      <button
        class="tree-tool"
        :title="t('filetree.newFolder')"
        @click="startCreate('dir', currentDirPath)"
      >
        <FolderPlus
          :size="14"
          :stroke-width="1.8"
        />
      </button>
      <span
        class="tree-tool-dir"
        :title="currentDirPath"
      >{{ currentDirLabel }}</span>
    </div>
    <div
      v-if="root"
      class="tree-body"
      @contextmenu.prevent="openMenu(null, $event)"
    >
      <template
        v-for="row in flat"
        :key="row.node.path"
      >
        <div
          class="tree-row"
          :class="{ active: row.node.path === activePath, 'is-drop-target': dropTargetPath === row.node.path }"
          :draggable="row.node !== root && !(pendingEdit?.kind === 'rename' && pendingEdit.nodePath === row.node.path)"
          :style="{ paddingLeft: `${6 + row.depth * 14}px` }"
          @contextmenu.stop.prevent="openMenu(row.node, $event)"
          @dragstart="onDragStart(row.node, $event)"
          @dragover="onDragOver(row, $event)"
          @dragleave="onDragLeave"
          @drop="onDrop(row, $event)"
          @dragend="onDragEnd"
        >
          <button
            class="caret"
            :class="{ hidden: !row.node.is_dir }"
            :tabindex="row.node.is_dir ? 0 : -1"
            :aria-label="row.node.is_dir
              ? (row.node.expanded ? t('filetree.collapseFolder', { name: row.node.name }) : t('filetree.expandFolder', { name: row.node.name }))
              : undefined"
            :aria-expanded="row.node.is_dir ? row.node.expanded : undefined"
            @click.stop="row.node.is_dir ? toggle(row.node) : undefined"
          >
            <ChevronRight
              v-if="row.node.is_dir"
              :size="12"
              :stroke-width="1.8"
              class="caret-icon"
              :class="{ open: row.node.expanded }"
            />
          </button>
          <span class="tree-icon">
            <FolderOpen
              v-if="row.node.is_dir && row.node.expanded"
              :size="14"
              :stroke-width="1.8"
              class="icon-folder"
            />
            <Folder
              v-else-if="row.node.is_dir"
              :size="14"
              :stroke-width="1.8"
              class="icon-folder"
            />
            <FileText
              v-else
              :size="13"
              :stroke-width="1.8"
              class="icon-file"
            />
          </span>
          <input
            v-if="pendingEdit?.kind === 'rename' && pendingEdit.nodePath === row.node.path"
            :ref="setEditInput"
            v-model="editName"
            class="tree-inline-input"
            :class="{ invalid: !!editError }"
            type="text"
            @click.stop
            @keydown.stop="onEditKeydown"
            @blur="cancelEdit"
          >
          <button
            v-else
            type="button"
            class="tree-name"
            :class="{ dir: row.node.is_dir }"
            :title="row.node.path"
            @click="row.node.is_dir ? toggle(row.node) : openFile(row.node)"
          >
            {{ row.node.name }}
          </button>
          <button
            v-if="row.node !== root && confirmPath !== row.node.path"
            class="tree-del"
            :title="t('filetree.trash')"
            @click.stop="confirmPath = row.node.path"
          >
            <Trash2
              :size="12"
              :stroke-width="1.8"
            />
          </button>
          <span
            v-else-if="row.node !== root && confirmPath === row.node.path"
            class="tree-del-confirm"
            @click.stop
          >
            <button
              class="btn btn-secondary btn-sm"
              @click.stop="confirmDelete(row.node.path)"
            >
              {{ t('filetree.confirm') }}
            </button>
            <button
              class="btn btn-ghost btn-sm"
              @click.stop="cancelDelete"
            >
              {{ t('filetree.cancel') }}
            </button>
          </span>
        </div>
        <div
          v-if="inlineEdit && row.node.path === inlineEdit.afterPath"
          class="tree-row tree-edit-row"
          :style="{ paddingLeft: `${6 + inlineEdit.depth * 14}px` }"
        >
          <button
            class="caret hidden"
            type="button"
            tabindex="-1"
          />
          <span class="tree-icon">
            <FileText
              v-if="inlineEdit.kind === 'file'"
              :size="13"
              :stroke-width="1.8"
              class="icon-file"
            />
            <Folder
              v-else
              :size="14"
              :stroke-width="1.8"
              class="icon-folder"
            />
          </span>
          <input
            :ref="setEditInput"
            v-model="editName"
            class="tree-inline-input"
            :class="{ invalid: !!editError }"
            type="text"
            :placeholder="inlineEdit.kind === 'file' ? t('filetree.filePlaceholder') : t('filetree.folderPlaceholder')"
            @click.stop
            @keydown.stop="onEditKeydown"
            @blur="cancelEdit"
          >
          <span
            v-if="editError"
            class="tree-edit-error"
          >{{ editError }}</span>
        </div>
      </template>
    </div>
    <ContextMenu
      v-if="menu"
      :x="menu.x"
      :y="menu.y"
      :items="menuItems"
      @select="onMenuSelect"
      @close="menu = null"
    />
  </div>
</template>

<style scoped>
.file-tree {
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow: hidden;
}
.tree-toolbar {
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 4px 6px 6px;
  border-bottom: 1px solid color-mix(in srgb, var(--app-border) 55%, transparent);
}
.tree-tool {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  flex: none;
  border: none;
  border-radius: var(--app-radius-sm);
  background: transparent;
  color: var(--app-muted);
  cursor: pointer;
  transition: background var(--app-motion-fast) var(--app-ease),
              color var(--app-motion-fast) var(--app-ease);
}
.tree-tool:hover {
  color: var(--app-text);
  background: color-mix(in srgb, var(--app-elevated) 66%, transparent);
}
.tree-tool:focus-visible {
  outline: 2px solid var(--app-accent);
  outline-offset: 1px;
}
.tree-tool-dir {
  flex: 1;
  min-width: 0;
  margin-left: 6px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 10px;
  letter-spacing: 0.02em;
  color: color-mix(in srgb, var(--app-muted) 82%, transparent);
  text-align: right;
}
.tree-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  overflow-x: hidden;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 1px;
}
.tree-row {
  display: flex;
  align-items: center;
  gap: 2px;
  height: 30px;
  padding-right: 6px;
  font-size: 12px;
  white-space: nowrap;
  color: color-mix(in srgb, var(--app-text) 72%, var(--app-muted));
  border-radius: var(--app-radius-sm);
  cursor: pointer;
  transition: background var(--app-motion-fast) var(--app-ease),
              color var(--app-motion-fast) var(--app-ease);
}
.tree-row:hover {
  background: color-mix(in srgb, var(--app-elevated) 62%, transparent);
  color: var(--app-text);
}
.tree-row.active {
  background: color-mix(in srgb, var(--app-accent-soft) 76%, var(--app-panel));
  color: var(--app-text);
  font-weight: 550;
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--app-accent) 9%, transparent);
}
.tree-row[draggable="true"] {
  cursor: grab;
}
.tree-row[draggable="true"]:active {
  cursor: grabbing;
}
.tree-row.is-drop-target {
  background: color-mix(in srgb, var(--app-accent-soft) 84%, var(--app-panel));
  box-shadow: inset 0 0 0 1px var(--app-accent);
  color: var(--app-text);
}
.caret {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 14px;
  height: 14px;
  flex: none;
  padding: 0;
  border: none;
  background: transparent;
  color: var(--app-muted);
  cursor: pointer;
}
.caret.hidden { visibility: hidden; }
.caret-icon {
  transition: transform var(--app-motion-fast) var(--app-ease);
}
.caret-icon.open { transform: rotate(90deg); }
.tree-icon {
  display: inline-flex;
  align-items: center;
  flex: none;
  color: var(--app-muted);
}
.tree-row.active .tree-icon { color: var(--app-accent); }
.tree-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  letter-spacing: -0.01em;
  /* A real button (so Tab and Enter reach it) that still reads as a label. */
  padding: 0;
  border: none;
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.tree-name:focus-visible {
  outline: 2px solid var(--app-accent);
  outline-offset: -2px;
  border-radius: var(--app-radius-sm);
}
.tree-name.dir { font-weight: 550; color: color-mix(in srgb, var(--app-text) 84%, var(--app-muted)); }
.tree-inline-input {
  flex: 1;
  min-width: 0;
  height: 22px;
  padding: 0 6px;
  font-family: var(--app-font);
  font-size: 12px;
  color: var(--app-text);
  background: var(--app-canvas);
  border: 1px solid var(--app-accent);
  border-radius: var(--app-radius-sm);
  outline: none;
}
.tree-inline-input::placeholder { color: var(--app-muted); }
.tree-inline-input.invalid { border-color: var(--app-danger); }
.tree-edit-row { cursor: default; }
.tree-edit-error {
  flex: none;
  max-width: 45%;
  overflow: hidden;
  text-overflow: ellipsis;
  margin-left: 6px;
  font-size: 10px;
  color: var(--app-danger);
  white-space: nowrap;
}
.tree-del {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  flex: none;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: var(--app-muted);
  cursor: pointer;
  opacity: 0;
  transition: opacity var(--app-motion-fast) var(--app-ease),
              color var(--app-motion-fast) var(--app-ease),
              background var(--app-motion-fast) var(--app-ease);
}
.tree-row:hover .tree-del { opacity: 1; }
/* Keyboard users never hover: without this the only control in a row is also
   an invisible one, so a Tab stop cannot be seen before it is pressed. */
.tree-del:focus-within,
.tree-row:focus-within .tree-del,
.tree-del:focus-visible { opacity: 1; }
.tree-del:hover {
  color: var(--app-danger);
  background: color-mix(in srgb, var(--app-danger) 10%, transparent);
}
.tree-del-confirm {
  margin-left: auto;
  display: flex;
  gap: 4px;
  align-items: center;
}
</style>
