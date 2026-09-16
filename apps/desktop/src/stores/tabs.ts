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
import { createUnflushableRescue } from './unflushable-rescue'
import { createTabFileOperations } from './tab-file-operations'
import type { ExternalConflict } from './tab-write-preconditions'
import type { AgentLiveNote, LiveNoteLookup } from '../features/agent/services/agent-context-snapshot'

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

/**
 * A value that is different every time this module graph is built.
 *
 * `crypto.randomUUID` where the webview has it — the same guarded call
 * `features/chat/services/chat-session-model.ts` makes, and for the same reason: it is a newer
 * API than the oldest engine this app supports, and a fallback that is still unique per page is
 * better than a throw at module load.
 */
function mintPageNonce(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID()
    }
  } catch {
    /* fall through */
  }
  return `page-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

export const useTabsStore = defineStore('tabs', () => {  const tabs = ref<OpenTab[]>([])
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

  /**
   * The route out of a close a refused save would otherwise block: a copy of the
   * stuck tab's text under a name the user picks (`unflushable-rescue.ts`, where
   * the one loop lives). Built here because this is where the save transaction
   * and the notification channel meet — the two things the route asks for — and
   * handed to the closes through the lifecycle below.
   *
   * The window close wires the same factory to the same store for its own route
   * (`app-lifecycle.ts`): one implementation, one place to change, and the two
   * controls cannot drift apart again.
   */
  const rescueUnflushableTabs = createUnflushableRescue({
    listTabs: () => tabs.value,
    t: i18nT,
    notifyRecovery,
    saveTab: (id, opts) => save.saveTab(id, opts),
    saveUntilSettled: save.saveUntilSettled,
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
    rescueUnflushableTabs,
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

  /**
   * The page-load term of a document identity, minted once per module graph.
   *
   * `tab.id` is `tab-${++seq}` from a counter `tab-lifecycle.ts` owns, so it restarts with the
   * page: reload the webview and the counter hands out the same ids again while the host process
   * — and its runtime epoch — survives. Two different documents would then spell the same
   * revision, and a conflict baseline captured before a reload would compare equal against a
   * document it was never taken from. Nothing else in the identity catches that: the epoch did not
   * move and the path is the same. A fresh nonce per page load is the smallest honest term, and
   * making `seq` non-restartable instead would need a source of uniqueness the window does not
   * have.
   *
   * Minted at module load, which is once per window per page: each webview has its own module
   * graph, so two windows cannot mint the same one.
   */
  const pageNonce = mintPageNonce()

  /**
   * One note, as this editor has it — the ONE lookup the agent feature reads a document through.
   *
   * Three callers depend on that word "one": the `fs/read_text_file` answer the host serves, the
   * edit-conflict baseline `send` captures, and the SVG-insertion anchor. They must agree about
   * what "the same version of this note" means, so they read the same value from the same place
   * rather than three spellings of it.
   *
   * `revision` is composed of three terms and each answers a different way for two documents to
   * be the same: the page-load nonce (a reload is not the same editor), the tab id (a reopened
   * note is not the same document), and the editor's own per-tab edit count, which moves at the
   * keystroke rather than at the publish. It is an INSTANCE identity, not a digest of the text: a
   * content hash cannot tell a reopened note from an untouched one, which is the case
   * `judgeAgentEdit` is tested against.
   *
   * `tab.content` lags a keystroke by up to 120ms while that count does not (`tab-save-state.ts`
   * says why), so an answer can pair revision R+1 with the text of R. Both callers are safe
   * against it — the read serves buffer text rather than disk text, and the conflict judgement
   * refuses when EITHER witness moved — so the lag is documented here rather than "fixed" by
   * delaying the count, which would break the save path that reads it.
   *
   * A `loading` tab is `cannot-answer`, not `not-held`: for the length of the first read it holds
   * a placeholder that wears the note's path, and `not-held` would serve the disk text for a note
   * the user is looking at.
   */
  function lookUpLiveNote(path: string): LiveNoteLookup {
    const root = vault.value
    if (root === null) {
      return { kind: 'cannot-answer', reason: 'this window has no vault open' }
    }
    const tab = tabs.value.find((t) => t.path === path)
    if (!tab) return { kind: 'not-held' }
    if (tab.loading) {
      return {
        kind: 'cannot-answer',
        reason: `the tab for ${path} is still reading the file`,
      }
    }
    // The `diskText` arm answers "the file was not read", which is true: this lookup reads the
    // buffer and nothing else, and the file's saved text a tab remembers is what that tab
    // believed was on disk, not a fresh read of it.
    const note: AgentLiveNote = {
      vaultId: root,
      path,
      revision: `${pageNonce}:${tab.id}:${save.revisionOf(tab.id)}`,
      buffer: tab.dirty
        ? { state: 'dirty', text: tab.content, diskText: null }
        : { state: 'clean', text: tab.content },
    }
    return { kind: 'held', note }
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
    /** The agent feature's one lookup of a note by path — see {@link lookUpLiveNote} for what its
     *  three arms mean and why `revision` is spelled the way it is. Not a general-purpose
     *  accessor: it exists so that the read path, the conflict baseline and the insertion anchor
     *  read one value rather than three spellings of it. */
    lookUpLiveNote,
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
