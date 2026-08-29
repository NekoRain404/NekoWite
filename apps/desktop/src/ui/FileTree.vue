<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { UnlistenFn } from '@tauri-apps/api/event'
import { fsService } from '../services/fs'
import type { FileEntry, FsChangeEvent } from '../services/fs'
import { decideConflict, notifyError } from '../services/errors'
import { useTabsStore } from '../stores/tabs'

interface TreeNode {
  name: string
  path: string
  is_dir: boolean
  is_mdx: boolean
  expanded: boolean
  loading: boolean
  children: TreeNode[]
}

const props = defineProps<{ vault: string }>()
const emit = defineEmits<{
  (e: 'open-folder', path: string): void
  (e: 'conflict', req: { tabId: string; path: string }): void
}>()

const tabs = useTabsStore()
const root = ref<TreeNode | null>(null)
const unlisten = ref<UnlistenFn | null>(null)

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

async function toggle(node: TreeNode): Promise<void> {
  if (!node.is_dir) return
  if (!node.expanded) await listChildren(node)
  node.expanded = !node.expanded
}

async function openFile(node: TreeNode): Promise<void> {
  if (node.is_dir) return
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

async function handleFsChange(e: FsChangeEvent): Promise<void> {
  const active = tabs.activeTab
  if (active && active.path === e.path) {
    const decision = decideConflict({ dirty: active.dirty, hasDiskChange: true })
    if (decision === 'reload') {
      await tabs.reloadFromDisk(active.id)
    } else if (decision === 'ask') {
      emit('conflict', { tabId: active.id, path: e.path })
    }
  }
  await refreshAncestors(e.path)
}

async function pickFolder(): Promise<void> {
  const picked = await fsService.openFolderDialog()
  if (picked) emit('open-folder', picked)
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
    resetRoot()
    await listChildren(root.value!)
    await fsService.watch(props.vault)
    unlisten.value = await fsService.onFsChange(handleFsChange)
  },
)
</script>

<template>
  <aside class="file-tree">
    <div class="tree-header">
      <span class="tree-title">Explorer</span>
      <button
        class="tree-btn"
        title="Open folder"
        @click="pickFolder"
      >
        Open Folder
      </button>
    </div>
    <div class="tree-body">
      <template v-if="root">
        <div
          v-for="row in flat"
          :key="row.node.path"
          class="tree-row"
          :style="{ paddingLeft: `${8 + row.depth * 14}px` }"
        >
          <span
            class="caret"
            :class="{ open: row.node.expanded, hidden: !row.node.is_dir }"
          >
            {{ row.node.is_dir ? '▸' : '' }}
          </span>
          <span
            class="tree-name"
            :class="{ dir: row.node.is_dir, mdx: row.node.is_mdx }"
            @click="row.node.is_dir ? toggle(row.node) : openFile(row.node)"
          >
            {{ row.node.name }}
          </span>
        </div>
      </template>
    </div>
  </aside>
</template>

<style scoped>
.file-tree {
  width: 260px;
  min-width: 260px;
  border-right: 1px solid #e0e0e0;
  display: flex;
  flex-direction: column;
  background: #fafafa;
  height: 100%;
  overflow: hidden;
}
.tree-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px;
  border-bottom: 1px solid #e0e0e0;
}
.tree-title { font-weight: 600; font-size: 13px; }
.tree-btn {
  font-size: 12px;
  padding: 3px 8px;
  border: 1px solid #ccc;
  background: #fff;
  border-radius: 4px;
  cursor: pointer;
}
.tree-body { flex: 1; overflow: auto; padding: 4px 0; }
.tree-row {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 2px 8px;
  font-size: 13px;
  white-space: nowrap;
}
.tree-row:hover { background: #f0f0f0; }
.tree-name { cursor: pointer; overflow: hidden; text-overflow: ellipsis; }
.tree-name.dir { font-weight: 500; }
.tree-name.mdx::after { content: ''; }
.caret {
  width: 12px;
  display: inline-block;
  font-size: 10px;
  color: #888;
  transition: transform 0.1s;
}
.caret.open { transform: rotate(90deg); }
.caret.hidden { visibility: hidden; }
</style>