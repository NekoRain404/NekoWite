import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { emitLifecycle, getActiveEditor } from '@nekowite/plugin-host'
import { armSuppressReapply } from '../services/suppressReapply'
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
  const vault = ref<string | null>(null)
  const activeTab = computed(
    () => tabs.value.find((t) => t.id === activeId.value) ?? null,
  )

  function setVault(v: string): void {
    vault.value = v
  }

  async function openTab(path: string | null, initial = ''): Promise<void> {
    let content = initial
    if (path) {
      if (!vault.value) {
        notifyError('尚未打开 vault，无法读取文件')
        return
      }
      try {
        content = await fsService.read(vault.value, path)
      } catch {
        notifyError(`无法读取文件：${path}`)
        return
      }
    }
    const tab: OpenTab = { id: nextId(), path, content, savedContent: content, dirty: false }
    tabs.value.push(tab)
    activeId.value = tab.id
    emitLifecycle('onOpenDocument', { id: tab.id, path: tab.path })
  }

  function closeTab(id: string): void {
    const i = tabs.value.findIndex((t) => t.id === id)
    if (i < 0) return
    const removing = tabs.value[i]
    emitLifecycle('onCloseTab', { id, path: removing.path })
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
    if (!t || !t.path || !vault.value) return
    const editor = getActiveEditor()
    const next = emitLifecycle('onSave', editor, t.content)
    const content = typeof next === 'string' ? next : t.content
    try {
      await fsService.write(vault.value, t.path, content)
      // I2: a save-time rewrite must not re-open the editor — the model syncs,
      // but RenderedPane consumes this flag and skips applyContent so the
      // user's live text and caret/scroll are preserved. Only arm when the
      // written content actually differs (an onSave rewrite); otherwise the
      // flag would linger and wrongly suppress the next legit content change.
      if (content !== t.content) armSuppressReapply()
      t.savedContent = content
      t.content = content
      t.dirty = false
      emitLifecycle('onSaved', editor, content)
    } catch {
      notifyError('保存失败，内容已保留在编辑器中，请重试')
    }
  }

  async function reloadFromDisk(id: string): Promise<void> {
    const t = tabs.value.find((x) => x.id === id)
    if (!t || !t.path || !vault.value) return
    try {
      t.content = await fsService.read(vault.value, t.path)
      t.savedContent = t.content
      t.dirty = false
    } catch {
      notifyError(`无法重新加载文件：${t.path}，已保留当前内容`)
    }
  }

  return { tabs, activeId, activeTab, vault, setVault, openTab, closeTab, setActive, markDirty, saveActive, reloadFromDisk }
})