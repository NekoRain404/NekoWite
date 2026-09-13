/**
 * Tab recovery: the crash-recovery probe that runs when a note is opened, and
 * the history restore it offers.
 *
 * This module deliberately does NOT import `app/recoveryClosedLoop`. That
 * module is app-layer and the app imports this store, so reaching up to it
 * would recreate the store→app edge the split removes; the flows here only
 * need the fs port, the notification ports and the persistence hooks, all
 * injected through `deps`.
 */

import type { Ref } from 'vue'
import type { HistoryEntry } from '../platform/gateways/contracts'
import type { OpenTab } from './tabs'

/** The slice of the fs gateway the recovery flows use. */
export interface TabRecoveryFilePort {
  read(vault: string, path: string): Promise<string>
  stat(vault: string, path: string): Promise<{ size: number; mtime: number }>
  listHistory(vault: string, path: string): Promise<HistoryEntry[]>
  readHistory(vault: string, path: string, id: string): Promise<string>
  restoreHistory(vault: string, path: string, id: string): Promise<string>
}

export interface TabRecoveryDeps {
  tabs: Ref<OpenTab[]>
  vault: Ref<string | null>
  files: TabRecoveryFilePort
  t: (key: string, params?: Record<string, unknown>) => string
  notifyError(message: string): void
  /** Screen-reader status channel ("a version was restored"). */
  announce(message: string): void
  /** Persistence hooks the restore must call AROUND its await — a pending
   *  autosave firing mid-restore could rename stale editor content over the
   *  freshly restored version. */
  cancelAutosave(id: string): void
  noteSelfWrite(path: string): void
}

export function createTabRecovery(deps: TabRecoveryDeps) {
  const { tabs, vault, files, t, notifyError, announce, cancelAutosave, noteSelfWrite } = deps

  async function restoreHistoryToActive(id: string, versionId: string): Promise<string | null> {
    const tab = tabs.value.find((x) => x.id === id)
    if (!tab || !tab.path || !vault.value) return null
    // Cancel a pending autosave BEFORE the await: a timer firing mid-restore
    // could rename stale editor content over the freshly restored version.
    cancelAutosave(id)
    try {
      // Arm before the native restore: its atomic write can surface an
      // fs-change before the invoke resolves. Marking after would let the
      // watcher reload the restored file and interrupt the editor.
      noteSelfWrite(tab.path)
      const content = await files.restoreHistory(vault.value, tab.path, versionId)
      tab.content = content
      tab.savedContent = content
      tab.dirty = false
      announce(t('recovery.restored'))
      return content
    } catch {
      notifyError(t('tabs.restoreHistoryFailed'))
      return null
    }
  }

  async function checkCrashRecovery(id: string): Promise<HistoryEntry | null> {
    const tab = tabs.value.find((x) => x.id === id)
    if (!tab || !tab.path || !vault.value) return null
    try {
      const [entries, s] = await Promise.all([
        files.listHistory(vault.value, tab.path),
        files.stat(vault.value, tab.path),
      ])
      const newest = entries[0] ?? null
      if (!newest || newest.mtime <= s.mtime) return null
      // An interrupted atomic write leaves a newest snapshot that is
      // byte-identical to the file on disk — recovering it is a no-op, and
      // offering the prompt would only confuse. Only a genuinely different
      // snapshot is worth restoring.
      const [snapshot, disk] = await Promise.all([
        files.readHistory(vault.value, tab.path, newest.id),
        files.read(vault.value, tab.path),
      ])
      return snapshot === disk ? null : newest
    } catch {
      return null
    }
  }

  return { restoreHistoryToActive, checkCrashRecovery }
}

export type TabRecovery = ReturnType<typeof createTabRecovery>
