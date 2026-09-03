<script setup lang="ts">
import { computed, markRaw, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { UnlistenFn } from '@tauri-apps/api/event'
import { ChevronRight, FilePlus2, FileText, Folder, FolderOpen, FolderPlus, PencilLine, Trash2 } from 'lucide-vue-next'
import { fsService } from '../services/fs'
import type { FileEntry, FsChangeEvent } from '../services/fs'
import { decideConflict, notifyError } from '../services/errors'
import { useTabsStore } from '../stores/tabs'
import ContextMenu from './ContextMenu.vue'
import type { ContextMenuItem } from './ContextMenu.vue'

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
}

const props = defineProps<{ vault: string }>()
const emit = defineEmits<{
  (e: 'conflict', req: { tabId: string; path: string }): void
}>()

const tabs = useTabsStore()
const root = ref<TreeNode | null>(null)
const unlisten = ref<UnlistenFn | null>(null)
const confirmPath = ref<string | null>(null)
const activePath = computed(() => tabs.activeTab?.path ?? null)
const selectedDirPath = ref<string | null>(null)
const menu = ref<{ x: number; y: number; node: TreeNode | null } | null>(null)
const pendingEdit = ref<TreeEdit | null>(null)
const editName = ref('')
const editError = ref('')
const editInput = ref<HTMLInputElement | null>(null)
let confirming = false

const MENU_ICONS = {
  filePlus: markRaw(FilePlus2),
  folderPlus: markRaw(FolderPlus),
  pencil: markRaw(PencilLine),
  trash: markRaw(Trash2),
}

const menuItems = computed<ContextMenuItem[]>(() => {
  const node = menu.value?.node ?? null
  const items: ContextMenuItem[] = [
    { id: 'new-file', label: '新建文件', icon: MENU_ICONS.filePlus },
    { id: 'new-dir', label: '新建文件夹', icon: MENU_ICONS.folderPlus },
  ]
  if (node && root.value && node.path !== root.value.path) {
    items.push(
      { id: 'rename', label: '重命名', icon: MENU_ICONS.pencil, separator: true },
      { id: 'delete', label: '删除', icon: MENU_ICONS.trash, danger: true },
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
    notifyError('删除失败，请重试')
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
    notifyError(`无法读取目录：${node.path}`)
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
  const i = path.lastIndexOf('/')
  return i <= 0 ? path : path.slice(0, i)
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
  pendingEdit.value = { kind: 'rename', parentPath: parent.path, nodePath: node.path }
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

async function confirmEdit(): Promise<void> {
  const p = pendingEdit.value
  if (!p || confirming) return
  const name = editName.value.trim()
  if (!name) {
    editError.value = '名称不能为空'
    return
  }
  if (name.includes('/')) {
    editError.value = '名称不能包含 /'
    return
  }
  if (name.startsWith('.')) {
    editError.value = '名称不能以 . 开头'
    return
  }
  const parent = findDirNode(p.parentPath)
  const dup = parent?.children.some((c) => c.name === name && c.path !== p.nodePath) ?? false
  if (dup) {
    editError.value = '已存在同名文件或文件夹'
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
      const to = `${dirOf(from)}/${name}`
      if (to !== from) {
        await fsService.renameEntry(props.vault, from, to)
        tabs.renamePathInTabs(from, to)
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
    notifyError(p.kind === 'rename' ? '重命名失败，请重试' : '创建失败，请重试')
    return
  }
  pendingEdit.value = null
  editError.value = ''
}

async function handleFsChange(e: FsChangeEvent): Promise<void> {
  // The watcher also reports the app's own writes; don't treat those as an
  // external modification (they would produce spurious conflict dialogs).
  const selfWrite = tabs.isSelfWrite(e.path)
  if (!selfWrite) {
    const active = tabs.activeTab
    if (active && active.path === e.path) {
      const decision = decideConflict({ dirty: active.dirty, hasDiskChange: true })
      if (decision === 'reload') {
        await tabs.reloadFromDisk(active.id)
      } else if (decision === 'ask') {
        emit('conflict', { tabId: active.id, path: e.path })
      }
    }
  }
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
  await fsService.watch(props.vault)
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
    await fsService.watch(props.vault)
    unlisten.value = await fsService.onFsChange(handleFsChange)
  },
)
</script>

<template>
  <div class="file-tree">
    <div class="tree-toolbar">
      <button
        class="tree-tool"
        title="新建文件"
        @click="startCreate('file', currentDirPath)"
      >
        <FilePlus2
          :size="14"
          :stroke-width="1.8"
        />
      </button>
      <button
        class="tree-tool"
        title="新建文件夹"
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
          :class="{ active: row.node.path === activePath }"
          :style="{ paddingLeft: `${6 + row.depth * 14}px` }"
          @contextmenu.stop.prevent="openMenu(row.node, $event)"
        >
          <button
            class="caret"
            :class="{ hidden: !row.node.is_dir }"
            :tabindex="row.node.is_dir ? 0 : -1"
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
            @keydown.enter.prevent="confirmEdit"
            @keydown.esc.prevent="cancelEdit"
            @keydown.stop
            @blur="cancelEdit"
          >
          <span
            v-else
            class="tree-name"
            :class="{ dir: row.node.is_dir }"
            :title="row.node.path"
            @click="row.node.is_dir ? toggle(row.node) : openFile(row.node)"
          >
            {{ row.node.name }}
          </span>
          <button
            v-if="row.node !== root && confirmPath !== row.node.path"
            class="tree-del"
            title="移入回收站"
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
              确认
            </button>
            <button
              class="btn btn-ghost btn-sm"
              @click.stop="cancelDelete"
            >
              取消
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
            :placeholder="inlineEdit.kind === 'file' ? '文件名.md' : '文件夹名称'"
            @click.stop
            @keydown.enter.prevent="confirmEdit"
            @keydown.esc.prevent="cancelEdit"
            @keydown.stop
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
