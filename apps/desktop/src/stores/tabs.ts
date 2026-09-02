import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { emitLifecycle, getActiveEditor } from '@nekowite/plugin-host'
import { armSuppressReapply } from '../services/suppressReapply'
import { fsService } from '../services/fs'
import type { HistoryEntry } from '../services/gateways/contracts'
import { notifyError, notifyRecovery } from '../services/errors'
import { useSettingsStore } from './settings'

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
  const savingIds = ref<Set<string>>(new Set())
  const activeTab = computed(
    () => tabs.value.find((t) => t.id === activeId.value) ?? null,
  )
  const settings = useSettingsStore()
  const autoTimers = new Map<string, ReturnType<typeof setTimeout>>()

  function scheduleAutosave(id: string): void {
    if (settings.autosaveInterval === 'off') return
    cancelAutosave(id)
    autoTimers.set(
      id,
      setTimeout(() => {
        autoTimers.delete(id)
        // Dirty guard lives here, not in saveTab/saveActive: a clean tab must
        // never produce a no-op write (and a spurious history snapshot).
        const t = tabs.value.find((x) => x.id === id)
        if (t && t.dirty) void saveTab(id)
      }, settings.autosaveInterval),
    )
  }

  function cancelAutosave(id: string): void {
    const timer = autoTimers.get(id)
    if (timer) {
      clearTimeout(timer)
      autoTimers.delete(id)
    }
  }

  function markSaving(id: string): void {
    const next = new Set(savingIds.value)
    next.add(id)
    savingIds.value = next
  }

  function markSaved(id: string): void {
    const next = new Set(savingIds.value)
    next.delete(id)
    savingIds.value = next
  }

  function saveStateOf(id: string): 'saved' | 'dirty' | 'saving' {
    if (savingIds.value.has(id)) return 'saving'
    const t = tabs.value.find((x) => x.id === id)
    if (t?.dirty) return 'dirty'
    return 'saved'
  }

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
    if (tab.path) {
      // Crash-recovery probe must never block opening the file: the prompt is
      // fired after the tab is live, and the user can dismiss or restore it.
      void (async () => {
        const entry = await checkCrashRecovery(tab.id)
        if (entry) {
          notifyRecovery({
            message: `检测到上次程序中断，检测到未保存的更改（${new Date(entry.mtime).toLocaleString()}），恢复最近版本？`,
            onRestore: () => {
              void restoreHistoryToActive(tab.id, entry.id)
            },
            onDismiss: () => {},
          })
        }
      })()
    }
  }

  function closeTab(id: string): void {
    cancelAutosave(id)
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

  async function saveTab(id: string): Promise<void> {
    const t = tabs.value.find((x) => x.id === id)
    if (!t || !t.path || !vault.value) return
    const editor = getActiveEditor()
    const next = emitLifecycle('onSave', editor, t.content)
    const content = typeof next === 'string' ? next : t.content
    markSaving(t.id)
    try {
      await fsService.write(vault.value, t.path, content, settings.maxHistory)
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
    } finally {
      markSaved(t.id)
    }
  }

  async function saveActive(): Promise<void> {
    const t = activeTab.value
    if (t) await saveTab(t.id)
  }

  async function deleteTabFile(id: string): Promise<void> {
    const t = tabs.value.find((x) => x.id === id)
    if (!t || !t.path || !vault.value) return
    try {
      await fsService.deleteFile(vault.value, t.path)
    } catch {
      notifyError('删除失败')
      return
    }
    closeTab(id)
  }

  async function restoreHistoryToActive(id: string, versionId: string): Promise<string | null> {
    const t = tabs.value.find((x) => x.id === id)
    if (!t || !t.path || !vault.value) return null
    try {
      const content = await fsService.restoreHistory(vault.value, t.path, versionId)
      t.content = content
      t.savedContent = content
      t.dirty = false
      cancelAutosave(id)
      return content
    } catch {
      notifyError('恢复历史版本失败')
      return null
    }
  }

  async function checkCrashRecovery(id: string): Promise<HistoryEntry | null> {
    const t = tabs.value.find((x) => x.id === id)
    if (!t || !t.path || !vault.value) return null
    try {
      const [entries, s] = await Promise.all([
        fsService.listHistory(vault.value, t.path),
        fsService.stat(vault.value, t.path),
      ])
      const newest = entries[0] ?? null
      return newest && newest.mtime > s.mtime ? newest : null
    } catch {
      return null
    }
  }

  async function reloadFromDisk(id: string): Promise<void> {
    const t = tabs.value.find((x) => x.id === id)
    if (!t || !t.path || !vault.value) return
    cancelAutosave(id)
    try {
      t.content = await fsService.read(vault.value, t.path)
      t.savedContent = t.content
      t.dirty = false
    } catch {
      notifyError(`无法重新加载文件：${t.path}，已保留当前内容`)
    }
  }

  return { tabs, activeId, activeTab, vault, setVault, openTab, closeTab, setActive, markDirty, markSaving, markSaved, saveStateOf, saveActive, reloadFromDisk, scheduleAutosave, cancelAutosave, saveTab, deleteTabFile, restoreHistoryToActive, checkCrashRecovery }
})