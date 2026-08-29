import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { fsService } from '../services/fs'
import { notifyError } from '../services/errors'

export interface OpenTab {
  id: string
  path: string | null
  content: string
  savedContent: string
  dirty: boolean
}

let seq = 0
const nextId = () => `tab-${++seq}`

export const useTabsStore = defineStore('tabs', () => {
  const tabs = ref<OpenTab[]>([])
  const activeId = ref<string | null>(null)
  const activeTab = computed(
    () => tabs.value.find((t) => t.id === activeId.value) ?? null,
  )

  async function openTab(path: string | null, initial = ''): Promise<void> {
    let content = initial
    if (path) {
      try {
        content = await fsService.read(path)
      } catch {
        notifyError(`无法读取文件：${path}`)
        return
      }
    }
    const tab: OpenTab = { id: nextId(), path, content, savedContent: content, dirty: false }
    tabs.value.push(tab)
    activeId.value = tab.id
  }

  function closeTab(id: string): void {
    const i = tabs.value.findIndex((t) => t.id === id)
    if (i < 0) return
    tabs.value.splice(i, 1)
    if (activeId.value === id) {
      activeId.value = tabs.value[i]?.id ?? tabs.value[i - 1]?.id ?? null
    }
  }

  function setActive(id: string): void {
    activeId.value = id
  }

  function markDirty(id: string): void {
    const t = tabs.value.find((x) => x.id === id)
    if (t) t.dirty = true
  }

  async function saveActive(): Promise<void> {
    const t = activeTab.value
    if (!t || !t.path) return
    try {
      await fsService.write(t.path, t.content)
      t.savedContent = t.content
      t.dirty = false
    } catch {
      notifyError('保存失败，内容已保留在编辑器中，请重试')
    }
  }

  async function reloadFromDisk(id: string): Promise<void> {
    const t = tabs.value.find((x) => x.id === id)
    if (!t || !t.path) return
    try {
      t.content = await fsService.read(t.path)
      t.savedContent = t.content
      t.dirty = false
    } catch {
      notifyError(`无法重新加载文件：${t.path}，已保留当前内容`)
    }
  }

  return { tabs, activeId, activeTab, openTab, closeTab, setActive, markDirty, saveActive, reloadFromDisk }
})