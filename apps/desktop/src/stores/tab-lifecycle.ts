/**
 * Tab lifecycle: open, focus, close and remove — plus the bulk closes
 * (`closeAll`, `closeOthers`, `removeAllTabs`) that decide what happens to
 * unsaved work before a tab disappears.
 *
 * This module NEVER imports `app/recoveryClosedLoop`: the app imports this
 * store, so a store-side module reaching up to it would recreate the
 * store→app cycle the split removes. The close-all prompt therefore arrives as
 * the injected `requestUntitledClose` callback, and the fs/notification ports
 * arrive through `deps` like every other dependency.
 */

import type { Ref } from 'vue'
import { emitLifecycle } from '@nekowite/plugin-host'
import { pruneSuppressReapply } from '../services/suppress-reapply'
import type { HistoryEntry } from '../platform/gateways/contracts'
import type { RecoveryPrompt } from '../services/errors'
import type { OpenTab } from './tabs'

/** What the user chose for the untitled dirty tabs blocking a bulk close. */
export type UntitledCloseChoice = 'save' | 'discard'

/** The slice of the fs gateway opening a tab needs. */
export interface TabOpenFilePort {
  read(vault: string, path: string): Promise<string>
}

export interface TabLifecycleDeps {
  tabs: Ref<OpenTab[]>
  activeId: Ref<string | null>
  vault: Ref<string | null>
  files: TabOpenFilePort
  t: (key: string, params?: Record<string, unknown>) => string
  notifyError(message: string): void
  notifyRecovery(prompt: RecoveryPrompt): void
  /** Persistence commands the close flows call. */
  saveTab(id: string): Promise<boolean>
  flushDirty(): Promise<boolean>
  /** Record one edit of `id`'s text, at the keystroke rather than at the
   *  publish. A save reads the revision before its write and clears the tab's
   *  `dirty` flag only if it has not moved — see `tab-save.ts`'s
   *  `editRevisions`. */
  noteEdit(id: string): void
  untitledDirtyTabs(): OpenTab[]
  captureSession(): void
  cancelAutosave(id: string): void
  resetSaveBookkeeping(): void
  /** Recovery flows `openTab` runs after the tab is live. */
  checkCrashRecovery(id: string): Promise<HistoryEntry | null>
  restoreHistoryToActive(id: string, versionId: string): Promise<string | null>
  /** Ask the user what to do with `count` untitled dirty tabs before a bulk
   *  close. Injected because the app-layer prompt lives in
   *  `app/recoveryClosedLoop` — see the module header. Resolves `'save'` to
   *  save them through Save-As first, `'discard'` to drop them. */
  requestUntitledClose(count: number): Promise<UntitledCloseChoice>
}

export function createTabLifecycle(deps: TabLifecycleDeps) {
  const {
    tabs,
    activeId,
    vault,
    files,
    t,
    notifyError,
    notifyRecovery,
    saveTab,
    flushDirty,
    noteEdit,
    untitledDirtyTabs,
    captureSession,
    cancelAutosave,
    resetSaveBookkeeping,
    checkCrashRecovery,
    restoreHistoryToActive,
    requestUntitledClose,
  } = deps

  let seq = 0
  const nextId = () => `tab-${++seq}`

  /**
   * Make `id` the active tab and drop the suppress-reapply arms of every other
   * tab (see services/suppressReapply): only the ACTIVE tab's content watcher
   * runs, so an arm left behind by a tab the user switched away from could never
   * be consumed — it would just sit there until it swallowed an unrelated content
   * change (typically the one belonging to the tab that is now on screen).
   */
  function focusTab(id: string | null): void {
    activeId.value = id
    pruneSuppressReapply(id)
  }

  function setActive(id: string): void {
    focusTab(id)
  }

  /** The tab's text changed: it is unsaved, and the edit is counted.
   *
   *  Both halves matter and both belong here rather than at the publish: a save
   *  decides whether it may call the tab saved by comparing the revision it saw
   *  before its write against the revision now, and `dirty` is what every
   *  protection for unsaved text reads. A publish, by contrast, happens up to a
   *  debounce window later and must not be the thing that records the edit. */
  function markDirty(id: string): void {
    const tab = tabs.value.find((x) => x.id === id)
    if (!tab) return
    tab.dirty = true
    noteEdit(id)
  }

  async function openTab(path: string | null, initial = ''): Promise<void> {
    if (path && !vault.value) {
      notifyError(t('tabs.openVaultFirst'))
      return
    }
    if (path) {
      // Synchronous critical section: the duplicate check and the placeholder
      // push happen in the same tick, before any await. Two quick clicks on
      // one path are therefore serialized — the second finds the placeholder
      // (or the fully loaded tab) and focuses it instead of spawning a second
      // tab after the pending read resolves.
      const existing = tabs.value.find((x) => x.path === path)
      if (existing) {
        focusTab(existing.id)
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
      focusTab(tab.id)
      emitLifecycle('onOpenDocument', { id: tab.id, path: tab.path })
      try {
        const content = await files.read(vault.value!, path)
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
        notifyError(t('tabs.readFileFailed', { path }))
        return
      }
      // Crash-recovery probe must never block opening the file: the prompt is
      // fired after the tab is live, and the user can dismiss or restore it.
      void (async () => {
        const entry = await checkCrashRecovery(tab.id)
        if (entry) {
          notifyRecovery({
            message: t('tabs.crashRecoveryMsg', { time: new Date(entry.mtime).toLocaleString() }),
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
    focusTab(tab.id)
    emitLifecycle('onOpenDocument', { id: tab.id, path: tab.path })
    captureSession()
  }

  /** Remove a tab without flushing anything (used after the file is gone). */
  function removeTab(id: string): void {
    cancelAutosave(id)
    const i = tabs.value.findIndex((x) => x.id === id)
    if (i < 0) return
    const removing = tabs.value[i]
    emitLifecycle('onCloseTab', { id, path: removing.path })
    tabs.value.splice(i, 1)
    if (activeId.value === id) {
      focusTab(tabs.value[i]?.id ?? tabs.value[i - 1]?.id ?? null)
    }
  }

  async function closeTab(id: string): Promise<void> {
    const tab = tabs.value.find((x) => x.id === id)
    // Unsaved work is flushed, not discarded: the pending autosave timer is
    // cancelled on removal, so without this the edits would be unrecoverable.
    if (tab?.dirty) {
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
    // Leave no tab-scoped state behind: removeTab only cancels autosave
    // timers, but a closed tab's in-flight save, saving flag and self-write
    // window must also be reset or a later open/switch would inherit the stale
    // remnants.
    resetSaveBookkeeping()
    for (const tab of [...tabs.value]) removeTab(tab.id)
    focusTab(null)
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
      notifyError(t('tabs.unsavedWorkBlocker'))
      return false
    }
    const untitled = untitledDirtyTabs()
    if (untitled.length > 0) {
      const choice = await requestUntitledClose(untitled.length)
      if (choice === 'save') {
        for (const tab of untitled) {
          if (!(await saveTab(tab.id))) {
            notifyError(t('tabs.unsavedWorkBlocker'))
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
    for (const tab of [...tabs.value]) {
      if (tab.id !== id) await closeTab(tab.id)
    }
    if (tabs.value.some((x) => x.id === id)) focusTab(id)
  }

  return {
    focusTab,
    setActive,
    markDirty,
    openTab,
    removeTab,
    closeTab,
    removeAllTabs,
    closeAll,
    closeOthers,
  }
}

export type TabLifecycle = ReturnType<typeof createTabLifecycle>
