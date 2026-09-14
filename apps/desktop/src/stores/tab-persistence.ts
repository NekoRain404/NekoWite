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

/**
 * How long a tab may hold unsaved edits, however continuously the user types.
 *
 * `autosaveInterval` is a TRAILING timer, re-armed on every keystroke: it says
 * "save 15 s after they stop", and for someone who does not stop it says "never
 * save at all". Nothing else holds the text — the session in `localStorage` is
 * a list of paths, so a kill or a power loss takes everything typed since the
 * last pause, with no limit and no sign that anything is missing. For a notes
 * app that is not a defensible default, so the timer says one more thing: never
 * more than this, measured from the first keystroke of the run.
 *
 * 30 s is a judgement, and this is the reasoning. It is twice the default
 * interval, so it never fires in the ordinary write-pause-write rhythm and
 * binds only on the case it exists for. It bounds the loss to half a minute of
 * typing rather than to a session. And at two versions a minute it still leaves
 * the ten-slot history covering five minutes of continuous writing, where a
 * ceiling set to the interval itself would halve that coverage and double the
 * writes to buy nothing a user asked for.
 *
 * The user can feel this one: with a slower interval chosen (60 s), a run of
 * continuous typing is now saved every 30 s instead of never, and the
 * unsaved-changes mark in the tab clears while they are still typing.
 */
export const AUTOSAVE_CEILING_MS = 30_000

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

  /** When each tab's CURRENT run of unsaved edits must be saved by, at the
   *  latest. The run begins with the first schedule after a save and ends when
   *  the timer fires or the run is cancelled; re-arming — every keystroke —
   *  deliberately does NOT reset it, because that is what a trailing timer
   *  already does and the whole finding is that it is not enough. */
  const autoDeadlines = new Map<string, number>()

  function scheduleAutosave(id: string): void {
    // Cancel the pending timer first so re-arming with a new interval (or
    // turning autosave off) replaces it instead of leaving a stale one behind.
    // Only the timer: the deadline belongs to the run of edits, not to the
    // arming, and clearing it here is exactly the reset this is not allowed to
    // do.
    clearTimer(id)
    if (settings.autosaveInterval === 'off') {
      autoDeadlines.delete(id)
      return
    }
    const now = Date.now()
    const deadline = autoDeadlines.get(id) ?? now + AUTOSAVE_CEILING_MS
    autoDeadlines.set(id, deadline)
    autoTimers.set(
      id,
      setTimeout(
        () => {
          autoTimers.delete(id)
          autoDeadlines.delete(id)
          // Dirty guard lives here, not in saveTab/saveActive: a clean tab must
          // never produce a no-op write (and a spurious history snapshot).
          const tab = tabs.value.find((x) => x.id === id)
          if (tab && tab.dirty) void saveTab(id)
        },
        // The sooner of the two: the idle delay the user chose, and what is
        // left of the ceiling. Past the ceiling this is 0, which is a save now
        // rather than a negative delay.
        Math.max(0, Math.min(settings.autosaveInterval, deadline - now)),
      ),
    )
  }

  function clearTimer(id: string): void {
    const timer = autoTimers.get(id)
    if (timer) {
      clearTimeout(timer)
      autoTimers.delete(id)
    }
  }

  /** Drop everything this tab had pending. Called when the tab is closing or
   *  the vault is switching, where the run of edits ends rather than restarts —
   *  unlike [`scheduleAutosave`], which keeps the deadline. */
  function cancelAutosave(id: string): void {
    clearTimer(id)
    autoDeadlines.delete(id)
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
