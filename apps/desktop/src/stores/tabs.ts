import { defineStore } from 'pinia'
import { computed, ref, watch } from 'vue'
import { emitLifecycle, getActiveEditor } from '@nekowite/plugin-host'
import { armSuppressReapply } from '../services/suppressReapply'
import { fsService } from '../services/fs'
import type { HistoryEntry } from '../services/gateways/contracts'
import { notifyError, notifyRecovery } from '../services/errors'
import { t as i18nT } from '../i18n'
import { assetsDirForNote, moveAttachments, rewireTempRefsInContent } from '../services/renameAsset'
import { useSettingsStore } from './settings'
import { parseSession, SESSION_KEY, serializeSession } from '../services/session'

export interface OpenTab {
  id: string
  path: string | null
  content: string
  savedContent: string
  dirty: boolean
  /** Vault-relative asset paths still staged in `.tmp` that must move into the
   * note's assets dir once the note gets a real path on first save. */
  pendingAssetPaths: string[]
}

let seq = 0
const nextId = () => `tab-${++seq}`

/** Window during which an fs-change for a path is attributed to our own save. */
const SELF_WRITE_MS = 2000

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
  const selfWrites = new Map<string, number>()

  function scheduleAutosave(id: string): void {
    // Cancel first so re-arming with a new interval (or turning autosave off)
    // always replaces a pending timer instead of leaving a stale one behind.
    cancelAutosave(id)
    if (settings.autosaveInterval === 'off') return
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

  // Interval changed (or autosave toggled): drop every pending timer, then
  // re-arm only the tabs that actually have unsaved work.
  watch(
    () => settings.autosaveInterval,
    () => {
      for (const t of tabs.value) {
        if (t.dirty) scheduleAutosave(t.id)
        else cancelAutosave(t.id)
      }
    },
  )

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

  function noteSelfWrite(path: string): void {
    selfWrites.set(path, Date.now())
  }

  function isSelfWrite(path: string): boolean {
    const ts = selfWrites.get(path)
    if (ts === undefined) return false
    if (Date.now() - ts > SELF_WRITE_MS) {
      selfWrites.delete(path)
      return false
    }
    return true
  }

  function setVault(v: string): void {
    vault.value = v
  }

  /** Persist the current tab layout (paths only) to localStorage so a later
   * launch can restore them. Tabs with a null path (unsaved untitled docs)
   * cannot be restored by path and are skipped. When there are genuinely no
   * tabs left the key is cleared so an empty editor is not resurrected. */
  function captureSession(): void {
    try {
      const raw = serializeSession({
        vault: vault.value,
        activeId: activeTab.value?.path ?? null,
        tabs: tabs.value,
      })
      if (raw === null) {
        if (tabs.value.length === 0) localStorage.removeItem(SESSION_KEY)
        return
      }
      localStorage.setItem(SESSION_KEY, raw)
    } catch {
      // localStorage can be unavailable (some webviews); session restore is
      // best-effort and must never break tab operations.
    }
  }

  /** Replay the stored session through `openTab`, which already handles the
   * duplicate guard and the async content refill. No-op when there is no
   * session for the currently-open vault. */
  async function restoreSession(): Promise<void> {
    const session = parseSession(localStorage.getItem(SESSION_KEY))
    if (!session || session.vault !== vault.value) return
    for (const path of session.paths) {
      await openTab(path)
    }
    // Reactivate the defaulted active tab via its path: ids are regenerated
    // on open, so the stored reference must be a path. Fall back to the last
    // opened tab (already active) when it no longer exists.
    if (session.activeId) {
      const active = tabs.value.find((t) => t.path === session.activeId)
      if (active) activeId.value = active.id
    }
    // Nothing could be restored (e.g. every file read failed) — surface a
    // hint. Only when the restore ran on a fresh, empty tab set.
    if (session.paths.length > 0 && tabs.value.every((t) => !t.path)) {
      notifyError(i18nT('session.restoreFailed'))
    }
  }

  async function openTab(path: string | null, initial = ''): Promise<void> {
    if (path && !vault.value) {
      notifyError(i18nT('tabs.openVaultFirst'))
      return
    }
    if (path) {
      // Synchronous critical section: the duplicate check and the placeholder
      // push happen in the same tick, before any await. Two quick clicks on
      // one path are therefore serialized — the second finds the placeholder
      // (or the fully loaded tab) and focuses it instead of spawning a second
      // tab after the pending read resolves.
      const existing = tabs.value.find((t) => t.path === path)
      if (existing) {
        activeId.value = existing.id
        return
      }
      const tab: OpenTab = {
        id: nextId(),
        path,
        content: initial,
        savedContent: initial,
        dirty: false,
        pendingAssetPaths: [],
      }
      tabs.value.push(tab)
      activeId.value = tab.id
      emitLifecycle('onOpenDocument', { id: tab.id, path: tab.path })
      try {
        const content = await fsService.read(vault.value!, path)
        // The tab may have been closed (or closeAll run) while the read was
        // pending; never refill a tab that no longer exists.
        if (tabs.value.some((x) => x.id === tab.id)) {
          tab.content = content
          tab.savedContent = content
        }
      } catch {
        removeTab(tab.id)
        notifyError(i18nT('tabs.readFileFailed', { path }))
        return
      }
      // Crash-recovery probe must never block opening the file: the prompt is
      // fired after the tab is live, and the user can dismiss or restore it.
      void (async () => {
        const entry = await checkCrashRecovery(tab.id)
        if (entry) {
          notifyRecovery({
            message: i18nT('tabs.crashRecoveryMsg', { time: new Date(entry.mtime).toLocaleString() }),
            onRestore: () => {
              void restoreHistoryToActive(tab.id, entry.id)
            },
            onDismiss: () => {},
          })
        }
      })()
      captureSession()
      return
    }
    const tab: OpenTab = {
      id: nextId(),
      path: null,
      content: initial,
      savedContent: initial,
      dirty: false,
      pendingAssetPaths: [],
    }
    tabs.value.push(tab)
    activeId.value = tab.id
    emitLifecycle('onOpenDocument', { id: tab.id, path: tab.path })
    captureSession()
  }

  /** Remove a tab without flushing anything (used after the file is gone). */
  function removeTab(id: string): void {
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

  async function closeTab(id: string): Promise<void> {
    const t = tabs.value.find((x) => x.id === id)
    // Unsaved work is flushed, not discarded: the pending autosave timer is
    // cancelled on removal, so without this the edits would be unrecoverable.
    if (t?.dirty) {
      const ok = await saveTab(id)
      if (!ok) return // save failed — keep the tab so nothing is lost
    }
    removeTab(id)
    captureSession()
  }

  function closeAll(): void {
    for (const t of [...tabs.value]) removeTab(t.id)
    // Leave no tab-scoped state behind: removeTab only cancels autosave
    // timers, but a closed tab's saving-flag and self-write window must also
    // be reset or a later open/switch would inherit the stale remnants.
    savingIds.value = new Set()
    selfWrites.clear()
    activeId.value = null
  }

  async function closeOthers(id: string): Promise<void> {
    for (const t of [...tabs.value]) {
      if (t.id !== id) await closeTab(t.id)
    }
    if (tabs.value.some((t) => t.id === id)) activeId.value = id
  }

  /** Rewrites tab paths after a file/directory rename on disk. Content is
   * untouched; tabs keep their dirty state and autosave timers. */
  function renamePathInTabs(from: string, to: string): void {
    for (const t of tabs.value) {
      if (!t.path) continue
      if (t.path === from) {
        t.path = to
        noteSelfWrite(to)
      } else if (t.path.startsWith(from + '/')) {
        t.path = to + t.path.slice(from.length)
        noteSelfWrite(t.path)
      }
    }
  }

  function setActive(id: string): void {
    activeId.value = id
  }

  function markDirty(id: string): void {
    const t = tabs.value.find((x) => x.id === id)
    if (t) t.dirty = true
  }

  /** Move `.tmp`-staged assets into the note's assets dir on first save and
   * rewrite the note body to reference them relatively. Returns true when the
   * content was rewritten. Best-effort: a failure leaves the staged paths for
   * a later retry rather than blocking the save. */
  async function relocatePendingAssets(t: OpenTab, vault: string, notePath: string): Promise<boolean> {
    if (t.pendingAssetPaths.length === 0) return false
    const assetsDir = assetsDirForNote(notePath, vault)
    if (!assetsDir || assetsDir === '.tmp') return false
    const moves = moveAttachments('.tmp', assetsDir, t.pendingAssetPaths)
    try {
      await fsService.createDir(vault, assetsDir).catch(() => undefined)
      for (const m of moves) {
        await fsService.renameEntry(vault, m.from, m.to)
      }
      // Rewire against the editor's LIVE content (the source of user typing)
      // rather than the stale snapshot, so a keystroke that landed during the
      // async relocation cannot be clobbered.
      const next = rewireTempRefsInContent(t.content, moves, notePath, vault)
      t.pendingAssetPaths = []
      if (next !== t.content) {
        t.content = next
        return true
      }
      return false
    } catch {
      notifyError(i18nT('tabs.saveAttachmentFailed'))
      return false
    }
  }

  /** Returns true when the file is on disk with the intended content. */
  async function saveTab(id: string): Promise<boolean> {
    const t = tabs.value.find((x) => x.id === id)
    if (!t || !vault.value) return false
    let path = t.path
    if (!path) {
      // Untitled tab: an explicit save means "save as", not a silent no-op.
      const picked = await fsService.saveFileDialog('untitled.md', vault.value)
      if (!picked) return false
      t.path = picked
      path = picked
    }
    markSaving(t.id)
    if (t.pendingAssetPaths.length > 0) {
      await relocatePendingAssets(t, vault.value, path)
    }
    const editor = getActiveEditor()
    const contentAtStart = t.content
    const next = emitLifecycle('onSave', editor, t.content)
    const content = typeof next === 'string' ? next : t.content
    try {
      await fsService.write(vault.value, path, content, settings.maxHistory)
      noteSelfWrite(path)
      // The write round-trip is a window in which the user can keep typing.
      // Never clobber newer editor content with the captured text.
      const userTyped = t.content !== contentAtStart
      const pluginRewrote = content !== contentAtStart
      if (!userTyped && pluginRewrote) {
        // Adopt the onSave rewrite; suppress the re-open its content change
        // would trigger (the model syncs, the live text/caret stay put).
        armSuppressReapply()
        t.content = content
        t.savedContent = content
        t.dirty = false
      } else if (userTyped) {
        t.savedContent = content
        // dirty stays true; the newer text still needs a save.
      } else {
        t.savedContent = content
        t.dirty = false
      }
      emitLifecycle('onSaved', editor, content)
      return true
    } catch {
      notifyError(i18nT('tabs.saveFailed'))
      return false
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
    const path = t.path
    try {
      await fsService.deleteFile(vault.value, path)
    } catch {
      notifyError(i18nT('tabs.deleteFailed'))
      return
    }
    // Close every tab on that path: autosave from a leftover tab would
    // resurrect the deleted file from stale content.
    for (const tab of [...tabs.value]) {
      if (tab.path === path) removeTab(tab.id)
    }
  }

  async function restoreHistoryToActive(id: string, versionId: string): Promise<string | null> {
    const t = tabs.value.find((x) => x.id === id)
    if (!t || !t.path || !vault.value) return null
    // Cancel a pending autosave BEFORE the await: a timer firing mid-restore
    // could rename stale editor content over the freshly restored version.
    cancelAutosave(id)
    try {
      const content = await fsService.restoreHistory(vault.value, t.path, versionId)
      noteSelfWrite(t.path)
      t.content = content
      t.savedContent = content
      t.dirty = false
      return content
    } catch {
      notifyError(i18nT('tabs.restoreHistoryFailed'))
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
      if (!newest || newest.mtime <= s.mtime) return null
      // An interrupted atomic write leaves a newest snapshot that is
      // byte-identical to the file on disk — recovering it is a no-op, and
      // offering the prompt would only confuse. Only a genuinely different
      // snapshot is worth restoring.
      const [snapshot, disk] = await Promise.all([
        fsService.readHistory(vault.value, t.path, newest.id),
        fsService.read(vault.value, t.path),
      ])
      return snapshot === disk ? null : newest
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
      notifyError(i18nT('tabs.reloadFailed', { path: t.path }))
    }
  }

  return { tabs, activeId, activeTab, vault, setVault, openTab, closeTab, closeAll, closeOthers, renamePathInTabs, removeTab, setActive, markDirty, markSaving, markSaved, saveStateOf, noteSelfWrite, isSelfWrite, saveActive, reloadFromDisk, scheduleAutosave, cancelAutosave, saveTab, deleteTabFile, restoreHistoryToActive, checkCrashRecovery, captureSession, restoreSession }
})
