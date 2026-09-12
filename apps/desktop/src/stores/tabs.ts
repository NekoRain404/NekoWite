import { defineStore } from 'pinia'
import { computed, ref, watch } from 'vue'
import { emitLifecycle, getActiveEditor } from '@nekowite/plugin-host'
import { armSuppressReapply } from '../services/suppressReapply'
import { fsService } from '../platform/gateways/fs'
import { flushEdits } from '../services/editorOwnership'
import { persistence } from '../services/persistence'
import type { HistoryEntry } from '../platform/gateways/contracts'
import { notifyError, notifyRecovery } from '../services/errors'
import { requestUntitledVaultSwitch } from '../app/recoveryClosedLoop'
import { announce } from '../services/announcer'
import { t as i18nT } from '../i18n'
import { assetsDirForNote, moveAttachments, rewireTempRefsInContent } from '../services/renameAsset'
import { rewriteNoteRefs } from '../services/noteMove'
import type { NoteMoveResult } from '../services/noteMove'
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
        if (tabs.value.length === 0) persistence.remove(SESSION_KEY)
        return
      }
      persistence.set(SESSION_KEY, raw)
    } catch {
      // localStorage can be unavailable (some webviews); session restore is
      // best-effort and must never break tab operations.
    }
  }

  /** Replay the stored session through `openTab`, which already handles the
   * duplicate guard and the async content refill. No-op when there is no
   * session for the currently-open vault. */
  async function restoreSession(): Promise<void> {
    const session = parseSession(persistence.get(SESSION_KEY))
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
        // pending; never refill a tab that no longer exists. Resolve the
        // reactive proxy stored in the store (NOT the raw local `tab`): the
        // read is async, so RenderedPane may already be watch-ing
        // activeTab.content, and a raw-object write bypasses Vue's reactivity
        // and never notifies it — leaving the editor permanently empty.
        const stored = tabs.value.find((x) => x.id === tab.id)
        if (stored) {
          stored.content = content
          stored.savedContent = content
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

  /** Drop every tab WITHOUT touching the filesystem. Only for callers that have
   *  already flushed the dirty tabs and prompted for the untitled ones — see
   *  {@link closeAll} and the vault-switch path in `appBootstrap`. */
  function removeAllTabs(): void {
    for (const t of [...tabs.value]) removeTab(t.id)
    // Leave no tab-scoped state behind: removeTab only cancels autosave
    // timers, but a closed tab's saving-flag and self-write window must also
    // be reset or a later open/switch would inherit the stale remnants.
    savingIds.value = new Set()
    selfWrites.clear()
    activeId.value = null
  }

  /**
   * Close every tab the way the user means it, without losing work.
   *
   * "Close all" used to call `removeTab` in a loop: no flush, no prompt. Tabs
   * with unsaved edits (autosave off, or inside the autosave window) and
   * untitled tabs — which exist nowhere but memory — were destroyed by one menu
   * click, on disk still holding the previous text or holding nothing at all.
   * Closing now follows the same rule as closing a single tab: path-bearing tabs
   * are flushed first, untitled dirty ones get the keep-or-discard prompt, and a
   * failed save aborts the whole thing instead of dropping what it could not
   * write. Returns false when the close did not happen.
   */
  async function closeAll(): Promise<boolean> {
    if (tabs.value.length === 0) return true
    if (!(await flushDirty())) {
      notifyError(i18nT('tabs.unsavedWorkBlocker'))
      return false
    }
    const untitled = untitledDirtyTabs()
    if (untitled.length > 0) {
      const choice = await requestUntitledVaultSwitch({
        count: untitled.length,
        notify: notifyRecovery,
        messageKey: 'tabs.untitledCloseAllMsg',
      })
      if (choice === 'save') {
        for (const tab of untitled) {
          if (!(await saveTab(tab.id))) {
            notifyError(i18nT('tabs.unsavedWorkBlocker'))
            return false
          }
        }
      }
    }
    removeAllTabs()
    captureSession()
    return true
  }

  async function closeOthers(id: string): Promise<void> {
    for (const t of [...tabs.value]) {
      if (t.id !== id) await closeTab(t.id)
    }
    if (tabs.value.some((t) => t.id === id)) activeId.value = id
  }

  /** Adopt the reference rewrite a note move already wrote to disk. A tab that
   *  is keeping up with disk takes the exact text (the `reloadFromDisk`
   *  pattern); a dirty tab's newer text goes through the same pure rewrite
   *  instead of being clobbered — otherwise its next save would resurrect the
   *  references the move just fixed. */
  function applyMovedContent(t: OpenTab, from: string, to: string, moved: NoteMoveResult): void {
    const v = vault.value
    if (t.dirty && v) {
      t.content = rewriteNoteRefs(t.content, { vault: v, from, to })
      t.savedContent = rewriteNoteRefs(t.savedContent, { vault: v, from, to })
      return
    }
    if (moved.content !== null) {
      t.content = moved.content
      t.savedContent = moved.content
    }
  }

  /** Rewrites tab paths after a file/directory rename on disk. Content is left
   *  alone unless `moved` says the move also rewrote the note's file-relative
   *  references (see `services/noteMove.ts`); tabs keep their dirty state and
   *  autosave timers. */
  function renamePathInTabs(from: string, to: string, moved?: NoteMoveResult): void {
    for (const t of tabs.value) {
      if (!t.path) continue
      if (t.path === from) {
        t.path = to
        if (moved) applyMovedContent(t, from, to, moved)
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
    // Both panes coalesce keystrokes before publishing them to the tab, so
    // flush before ANYTHING reads t.content below. This has to precede the
    // asset relocation, not just the write: relocation is a whole-document
    // read-modify-write, so running it against a stale snapshot would both
    // rewire the wrong text and clobber the keystrokes still in flight.
    //
    // The rendered pane needs the same treatment as the source pane. Saving
    // within its debounce window used to persist the previous text and then
    // re-apply it to the model, losing the keystrokes outright.
    await flushEdits()
    if (t.pendingAssetPaths.length > 0) {
      await relocatePendingAssets(t, vault.value, path)
    }
    const editor = getActiveEditor()
    const contentAtStart = t.content
    const next = emitLifecycle('onSave', editor, t.content)
    const content = typeof next === 'string' ? next : t.content
    try {
      // Arm the self-write window BEFORE the disk write: Tauri's recursive fs
      // watcher may report the modified path while the write is still in
      // flight. If we only marked it after the await returned, the watcher's
      // "external change" would reload the very file we just saved, replacing
      // the live editor content and resetting the caret (the "input jumps"
      // symptom). The existing 2s expiration keeps normal external edits
      // observable.
      noteSelfWrite(path)
      await fsService.write(vault.value, path, content, settings.maxHistory)
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
      // Screen-reader status: a save round-trip landed (dirty → saved).
      announce(i18nT('recovery.saved'))
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
      // Suppress the delete's own fs-change so the tab is not reloaded from a
      // missing file before deleteTabFile closes it.
      noteSelfWrite(path)
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
      // Arm before the native restore: its atomic write can surface an
      // fs-change before the invoke resolves. Marking after would let the
      // watcher reload the restored file and interrupt the editor.
      noteSelfWrite(t.path)
      const content = await fsService.restoreHistory(vault.value, t.path, versionId)
      t.content = content
      t.savedContent = content
      t.dirty = false
      announce(i18nT('recovery.restored'))
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

  /**
   * Detach a tab from a path that no longer exists.
   *
   * A note's folder can be renamed or deleted outside the app, and the backend
   * recreates missing parent directories on write — so leaving the stale path in
   * place meant the next save silently recreated the OLD location, leaving the
   * user with two copies of one note holding different text. Clearing the path
   * turns the tab into an untitled one: the content is kept, the next save asks
   * for a destination (the existing Save-As flow), and the tab is visibly no
   * longer attached to the vanished file. Returns the path it was detached from
   * so the caller can tell the user which file is gone.
   */
  function detachMissingPath(id: string): string | null {
    const t = tabs.value.find((x) => x.id === id)
    if (!t || !t.path) return null
    const gone = t.path
    cancelAutosave(id)
    t.path = null
    // The tab now holds text that exists at no path this app knows, so it counts
    // as unsaved work — `content` is the only copy left. Marking it clean (what
    // this did at first) silently disabled every protection that keys off
    // `dirty`: closing the tab, switching vaults, closing the window and the
    // autosave timer all skipped it, so text the user had typed and never
    // written could vanish with no prompt at all. Empty tabs stay clean — there
    // is nothing to protect and prompting over a blank note is pure noise.
    t.dirty = t.content.length > 0
    t.savedContent = t.dirty ? '' : t.content
    return gone
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

  /** True when any open tab holds unsaved edits. The app uses this to decide
   *  whether closing the window should prompt the user rather than silently
   *  dropping the work. */
  function hasUnsavedWork(): boolean {
    return tabs.value.some((t) => t.dirty)
  }

  /** Best-effort save of every dirty tab that has a real path (used before a
   *  vault switch or an app close, where a pending autosave timer may never
   *  fire). Untitled tabs are skipped: with no path they would need a save-as
   *  dialog, which a background/bulk flush must not open. Returns false when a
   *  path'd save failed so the caller can block the potentially-lossy action. */
  async function flushDirty(): Promise<boolean> {
    let ok = true
    for (const t of tabs.value) {
      if (!t.dirty || !t.path) continue
      const saved = await saveTab(t.id)
      if (!saved) ok = false
    }
    return ok
  }

  /** Untitled tabs (no path) holding unsaved edits. These need a Save-As dialog
   *  a background flush must not open, so a vault switch must prompt first —
   *  see {@link untitledDirtyTabs} consumers (vault-switch guard). */
  function untitledDirtyTabs(): OpenTab[] {
    return tabs.value.filter((t) => !t.path && t.dirty)
  }

  /** Vault-relative `.tmp` paths still referenced by any open tab — either a
   *  staged asset awaiting relocation (`pendingAssetPaths`) or a live `![alt](
   *  .tmp/… )` ref in the note body. The recovery closed-loop uses this as the
   *  "not orphaned" predicate so a still-referenced temp file is never GC'd. */
  function referencedTmpPaths(): Set<string> {
    const referenced = new Set<string>()
    for (const tab of tabs.value) {
      for (const path of tab.pendingAssetPaths) referenced.add(path)
      if (tab.content) {
        for (const match of tab.content.matchAll(/\.tmp\/[^\s"')\]>,]+/g)) {
          referenced.add(match[0])
        }
      }
    }
    return referenced
  }

  return { tabs, activeId, activeTab, vault, setVault, openTab, closeTab, closeAll, removeAllTabs, closeOthers, renamePathInTabs, removeTab, setActive, markDirty, markSaving, markSaved, saveStateOf, noteSelfWrite, isSelfWrite, saveActive, reloadFromDisk, detachMissingPath, scheduleAutosave, cancelAutosave, saveTab, deleteTabFile, restoreHistoryToActive, checkCrashRecovery, captureSession, restoreSession, hasUnsavedWork, flushDirty, untitledDirtyTabs, referencedTmpPaths }
})
