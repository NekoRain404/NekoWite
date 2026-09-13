/**
 * Tab persistence: session capture/restore, the autosave timer and the
 * read-only queries over the open tab set.
 *
 * The write path itself lives in `tab-save.ts`; this module calls into it
 * through the injected `saveTab`, so the dependency only ever runs one way.
 * Everything else it touches from outside arrives through `deps`: the store's
 * reactive state, the settings port and the notification ports. The module
 * never constructs a Pinia store and never reaches for a Tauri gateway itself,
 * so a test can drive it with a memory adapter.
 */

import { watch } from 'vue'
import type { ComputedRef, Ref } from 'vue'
import { persistence } from '../services/persistence'
import { parseSession, SESSION_KEY, serializeSession } from '../services/session'
import { samePath } from '../services/paths'
import type { OpenTab } from './tabs'

/** The slice of the settings store the autosave timer reads. */
export interface TabAutosaveSettingsPort {
  autosaveInterval: number | 'off'
}

export interface TabPersistenceDeps {
  tabs: Ref<OpenTab[]>
  activeTab: ComputedRef<OpenTab | null>
  vault: Ref<string | null>
  settings: TabAutosaveSettingsPort
  t: (key: string, params?: Record<string, unknown>) => string
  notifyError(message: string): void
  /** The write path (`tab-save.ts`): the timer must never write on its own. */
  saveTab(id: string): Promise<boolean>
}

/** The lifecycle operations `restoreSession` replays the stored paths through.
 *  Injected at CALL time, not construction time: this module is built before
 *  the lifecycle module (which depends on it), so this back-edge travels as a
 *  parameter instead of a module-import cycle. */
export interface SessionRestoreHost {
  openTab(path: string): Promise<void>
  focusTab(id: string): void
}

export function createTabPersistence(deps: TabPersistenceDeps) {
  const { tabs, activeTab, vault, settings, t, notifyError, saveTab } = deps

  const autoTimers = new Map<string, ReturnType<typeof setTimeout>>()

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
        const tab = tabs.value.find((x) => x.id === id)
        if (tab && tab.dirty) void saveTab(id)
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
      for (const tab of tabs.value) {
        if (tab.dirty) scheduleAutosave(tab.id)
        else cancelAutosave(tab.id)
      }
    },
  )

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

  /** Replay the stored session through `host.openTab`, which already handles
   * the duplicate guard and the async content refill. No-op when there is no
   * session for the currently-open vault. */
  async function restoreSession(host: SessionRestoreHost): Promise<void> {
    const session = parseSession(persistence.get(SESSION_KEY))
    // `samePath`, not `!==`: the stored spelling and the open vault can differ
    // in case or separators for the SAME folder (Windows), and a raw string
    // comparison threw the whole session away — the tabs were silently not
    // restored, and the next capture wrote the new spelling over them.
    if (!session || !vault.value || !samePath(session.vault, vault.value)) return
    for (const path of session.paths) {
      await host.openTab(path)
    }
    // Reactivate the defaulted active tab via its path: ids are regenerated
    // on open, so the stored reference must be a path. Fall back to the last
    // opened tab (already active) when it no longer exists.
    if (session.activeId) {
      const active = tabs.value.find((t) => t.path === session.activeId)
      if (active) host.focusTab(active.id)
    }
    // Nothing could be restored (e.g. every file read failed) — surface a
    // hint. Only when the restore ran on a fresh, empty tab set.
    if (session.paths.length > 0 && tabs.value.every((t) => !t.path)) {
      notifyError(t('session.restoreFailed'))
    }
  }

  /** True when any open tab holds unsaved edits. The app uses this to decide
   *  whether closing the window should prompt the user rather than silently
   *  dropping the work. */
  function hasUnsavedWork(): boolean {
    return tabs.value.some((t) => t.dirty)
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

  return {
    scheduleAutosave,
    cancelAutosave,
    captureSession,
    restoreSession,
    hasUnsavedWork,
    untitledDirtyTabs,
    referencedTmpPaths,
  }
}

export type TabPersistence = ReturnType<typeof createTabPersistence>
