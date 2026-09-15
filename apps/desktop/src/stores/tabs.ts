/**
 * The open-tab store.
 *
 * This file owns the tab state (`tabs`, `activeId`, `activeTab`, `vault`) and
 * composes the tab services that hold the behaviour:
 *
 *   tab-lifecycle.ts         open / close / activate / remove
 *   tab-save.ts              the save transaction and its bookkeeping
 *   tab-persistence.ts       session, autosave, tab-set queries
 *   tab-file-operations.ts   rename / delete / reload
 *   tab-recovery.ts          crash recovery, history restore
 *
 * The wiring below is also the module graph: save → persistence → { recovery,
 * lifecycle } → file operations, with no edge pointing back up.
 *
 * The public API is unchanged — every consumer keeps importing
 * `useTabsStore` (and `OpenTab`) from here.
 */

import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { notifyError, notifyRecovery } from '../services/errors'
import { announce } from '../services/announcer'
import { t as i18nT } from '../i18n'
import { fsService } from '../platform/gateways/fs'
import { useSettingsStore } from './settings'
import { createTabSave } from './tab-save'
import { createTabPersistence } from './tab-persistence'
import { createTabRecovery } from './tab-recovery'
import { createTabLifecycle } from './tab-lifecycle'
import type { UntitledCloseChoice } from './tab-lifecycle'
import { createTabFileOperations } from './tab-file-operations'
import type { ExternalConflict } from './tab-write-preconditions'

export interface OpenTab {
  id: string
  path: string | null
  content: string
  savedContent: string
  dirty: boolean
  /**
   * The tab is waiting on its first read: true from the placeholder push until
   * the file's text has been committed into it, false from then on.
   *
   * The pending read is the difference between "this tab holds the note" and
   * "this tab holds a placeholder wearing the note's path" — for the length of
   * that read an editor is mounted on an empty document the user can type into,
   * and the read used to write its text straight over what they had typed
   * (`tab-lifecycle`'s `commitRead` is what reconciles the two). Optional so
   * that fixtures built beside this store need not name it; undefined means
   * "not loading".
   */
  loading?: boolean
  /**
   * The file changed on disk under this tab, and what the user has been told
   * about it.
   *
   * The save path is where an external edit is actually overwritten, and it is
   * reached by callers with no user in front of them (the autosave timer, a bulk
   * flush, a window close) — so the answer to "the file holds somebody else's
   * bytes, do you want to replace them?" has to live somewhere the next save
   * reads. Absent means nothing is outstanding; see
   * `tab-write-preconditions.ts` for the two answers and what clears them.
   *
   * Optional so that fixtures built beside this store need not name it.
   */
  externalConflict?: ExternalConflict | null
  /** Vault-relative asset paths still staged in `.tmp` that must move into the
   * note's assets dir once the note gets a real path on first save. */
  pendingAssetPaths: string[]
}

export const useTabsStore = defineStore('tabs', () => {
  const tabs = ref<OpenTab[]>([])
  const activeId = ref<string | null>(null)
  const vault = ref<string | null>(null)
  const activeTab = computed(
    () => tabs.value.find((t) => t.id === activeId.value) ?? null,
  )
  const settings = useSettingsStore()

  /**
   * Ask the user what to do with untitled dirty tabs before `closeAll` drops
   * them.
   *
   * Built here from the shared notification channel instead of importing
   * `app/recoveryClosedLoop`: the app imports this store, so a store→app import
   * closes a cycle. The wording and the channel are the close-all ones
   * (`tabs.untitledCloseAllMsg`); the vault-switch wording lives on in
   * `requestUntitledVaultSwitch`, which only the app's own switch path calls.
   * Resolves `'save'` to flush them through Save-As first, `'discard'` to drop
   * them.
   */
  function requestUntitledClose(count: number): Promise<UntitledCloseChoice> {
    return new Promise((resolve) => {
      notifyRecovery({
        message: i18nT('tabs.untitledCloseAllMsg', { count }),
        onRestore: () => resolve('save'),
        onDismiss: () => resolve('discard'),
      })
    })
  }

  const save = createTabSave({
    tabs,
    activeTab,
    vault,
    settings,
    files: fsService,
    t: i18nT,
    notifyError,
    announce,
  })

  const persistence = createTabPersistence({
    tabs,
    activeTab,
    vault,
    settings,
    t: i18nT,
    notifyError,
    saveTab: save.saveTab,
  })

  const recovery = createTabRecovery({
    tabs,
    vault,
    files: fsService,
    t: i18nT,
    notifyError,
    announce,
    cancelAutosave: persistence.cancelAutosave,
    noteSelfWrite: save.noteSelfWrite,
  })

  const lifecycle = createTabLifecycle({
    tabs,
    activeId,
    vault,
    files: fsService,
    t: i18nT,
    notifyError,
    notifyRecovery,
    saveUntilSettled: save.saveUntilSettled,
    flushDirty: save.flushDirty,
    noteEdit: save.noteEdit,
    untitledDirtyTabs: persistence.untitledDirtyTabs,
    captureSession: persistence.captureSession,
    cancelAutosave: persistence.cancelAutosave,
    resetSaveBookkeeping: save.resetSaveBookkeeping,
    checkCrashRecovery: recovery.checkCrashRecovery,
    restoreHistoryToActive: recovery.restoreHistoryToActive,
    requestUntitledClose,
  })

  const fileOperations = createTabFileOperations({
    tabs,
    vault,
    files: fsService,
    t: i18nT,
    notifyError,
    cancelAutosave: persistence.cancelAutosave,
    noteSelfWrite: save.noteSelfWrite,
    removeTab: lifecycle.removeTab,
  })

  /** The vault every operation reads and writes through. */
  function setVault(v: string): void {
    vault.value = v
  }

  /** Restore the stored session. The paths are replayed through the lifecycle
   *  `openTab` (duplicate guard + async content refill), so the two modules are
   *  joined here rather than one importing the other. */
  async function restoreSession(): Promise<void> {
    await persistence.restoreSession({ openTab: lifecycle.openTab, focusTab: lifecycle.focusTab })
  }

  return {
    // state
    tabs,
    activeId,
    activeTab,
    vault,
    setVault,
    // lifecycle
    openTab: lifecycle.openTab,
    closeTab: lifecycle.closeTab,
    closeAll: lifecycle.closeAll,
    removeAllTabs: lifecycle.removeAllTabs,
    closeOthers: lifecycle.closeOthers,
    /** The close's placeholder step, for the bulk route that is not `closeAll`:
     *  the window close reconciles what was typed into a still-loading tab
     *  before its own flush and untitled prompt (see `tab-close.ts`). */
    reconcilePlaceholders: lifecycle.reconcilePlaceholders,
    removeTab: lifecycle.removeTab,
    setActive: lifecycle.setActive,
    markDirty: lifecycle.markDirty,
    // save transaction
    markSaving: save.markSaving,
    markSaved: save.markSaved,
    saveStateOf: save.stateOf,
    noteSelfWrite: save.noteSelfWrite,
    isSelfWrite: save.isSelfWrite,
    saveActive: save.saveActive,
    saveTab: save.saveTab,
    /** The conflict prompt's "Keep local": the user's answer, recorded on the
     *  tab where the next save reads it (see `tab-write-preconditions.ts`). */
    keepLocalConflict: save.keepLocalConflict,
    /** The per-tab gate the closes ask, and the app's own close/vault-switch
     *  routes with them: write until the tab holds nothing that is not on disk
     *  (`tab-settle.ts`). One landed write is not a saved tab. */
    saveUntilSettled: save.saveUntilSettled,
    flushDirty: save.flushDirty,
    // persistence
    scheduleAutosave: persistence.scheduleAutosave,
    cancelAutosave: persistence.cancelAutosave,
    captureSession: persistence.captureSession,
    restoreSession,
    hasUnsavedWork: persistence.hasUnsavedWork,
    untitledDirtyTabs: persistence.untitledDirtyTabs,
    referencedTmpPaths: persistence.referencedTmpPaths,
    // file operations
    renamePathInTabs: fileOperations.retargetAfterRename,
    beginMove: fileOperations.beginMove,
    endMove: fileOperations.endMove,
    isPendingMove: fileOperations.isPendingMove,
    deleteTabFile: fileOperations.deleteTabFile,
    reloadFromDisk: fileOperations.reloadFromDisk,
    detachMissingPath: fileOperations.detachMissingPath,
    // recovery
    restoreHistoryToActive: recovery.restoreHistoryToActive,
    checkCrashRecovery: recovery.checkCrashRecovery,
  }
})
