/**
 * The tab write path: the save transaction, the save-state the status line
 * reads, and the self-write window that tells our own writes apart from
 * external edits.
 *
 * Split out of `tab-persistence.ts` (which keeps session + autosave) because
 * the transaction, its overlapping-save serialization and its window
 * bookkeeping do not fit under the 400-line budget next to the session code.
 * This module is a leaf: it depends on no other tab module, and the fs port,
 * the clock and the notification ports all arrive through `deps`.
 */

import { ref } from 'vue'
import type { ComputedRef, Ref } from 'vue'
import { emitLifecycle, getActiveEditor } from '@nekowite/plugin-host'
import { armSuppressReapply } from '../services/suppress-reapply'
import { flushEdits, isRefusedDocument, isSourceAuthored } from '../services/editor-ownership'
import {
  assetsDirForNote,
  moveAttachments,
  rewireTempRefsInContent,
} from '../services/rename-asset'
import type { OpenTab } from './tabs'

/** Window during which an fs-change for a path is attributed to our own save. */
const SELF_WRITE_MS = 2000

/** The slice of the settings store the write reads. */
export interface TabSaveSettingsPort {
  maxHistory: number
}

/** The slice of the fs gateway the write path uses. */
export interface TabSaveFilePort {
  write(vault: string, path: string, content: string, maxHistory?: number): Promise<string | null>
  saveFileDialog(defaultName: string, startDir?: string): Promise<string | null>
  createDir(vault: string, path: string): Promise<string>
  renameEntry(vault: string, from: string, to: string): Promise<string>
}

export interface TabSaveDeps {
  tabs: Ref<OpenTab[]>
  activeTab: ComputedRef<OpenTab | null>
  vault: Ref<string | null>
  settings: TabSaveSettingsPort
  files: TabSaveFilePort
  t: (key: string, params?: Record<string, unknown>) => string
  notifyError(message: string): void
  /** Screen-reader status channel ("a save round-trip landed"). */
  announce(message: string): void
  /** Injectable clock: the self-write window is a wall-clock comparison, and
   *  tests must be able to move it without waiting two real seconds. */
  now?: () => number
}

export function createTabSave(deps: TabSaveDeps) {
  const { tabs, activeTab, vault, settings, files, t, notifyError, announce } = deps
  const now = deps.now ?? (() => Date.now())

  const savingIds = ref<Set<string>>(new Set())
  const selfWrites = new Map<string, number>()

  /**
   * Saves that have not settled yet, keyed by tab id.
   *
   * Saving was not serialized, and three things went wrong at once when two
   * saves of one tab overlapped (Ctrl+S pressed twice, or the autosave timer
   * firing while a manual save was still writing):
   *
   * - the file was written twice, which on the backend means two history
   *   snapshots of the same edit;
   * - `markSaved` is a set, so the first save to finish cleared the "saving"
   *   state while the other was still in flight — the status line said "saved"
   *   over an unfinished write;
   * - the LAST one to finish won the state, not the last one started. A save
   *   that began earlier but completed later wrote its older `savedContent`
   *   and `dirty = false` over the newer one, so the tab looked saved while the
   *   window's idea of the disk content was stale — and the next watcher event
   *   (disk != savedContent) was then treated as an external edit.
   *
   * A second save now waits for the running one and only writes again if
   * something new was typed in the meantime.
   */
  const inFlightSaves = new Map<string, Promise<boolean>>()

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

  function stateOf(id: string): 'saved' | 'dirty' | 'saving' {
    if (savingIds.value.has(id)) return 'saving'
    const tab = tabs.value.find((x) => x.id === id)
    if (tab?.dirty) return 'dirty'
    return 'saved'
  }

  function pruneSelfWrites(at = now()): void {
    for (const [path, ts] of selfWrites) {
      if (at - ts > SELF_WRITE_MS) selfWrites.delete(path)
    }
  }

  function noteSelfWrite(path: string): void {
    pruneSelfWrites()
    selfWrites.set(path, now())
  }

  function isSelfWrite(path: string): boolean {
    pruneSelfWrites()
    const ts = selfWrites.get(path)
    if (ts === undefined) return false
    return now() - ts <= SELF_WRITE_MS
  }

  /** Move `.tmp`-staged assets into the note's assets dir on first save and
   * rewrite the note body to reference them relatively. Returns true when the
   * content was rewritten. Best-effort: a failure leaves the staged paths for
   * a later retry rather than blocking the save. */
  async function relocatePendingAssets(tab: OpenTab, vaultPath: string, notePath: string): Promise<boolean> {
    if (tab.pendingAssetPaths.length === 0) return false
    const assetsDir = assetsDirForNote(notePath, vaultPath)
    if (!assetsDir || assetsDir === '.tmp') return false
    const moves = moveAttachments('.tmp', assetsDir, tab.pendingAssetPaths)
    try {
      await files.createDir(vaultPath, assetsDir).catch(() => undefined)
      for (const m of moves) {
        await files.renameEntry(vaultPath, m.from, m.to)
      }
      // Rewire against the editor's LIVE content (the source of user typing)
      // rather than the stale snapshot, so a keystroke that landed during the
      // async relocation cannot be clobbered.
      const next = rewireTempRefsInContent(tab.content, moves, notePath, vaultPath)
      tab.pendingAssetPaths = []
      if (next !== tab.content) {
        tab.content = next
        return true
      }
      return false
    } catch {
      notifyError(t('tabs.saveAttachmentFailed'))
      return false
    }
  }

  /** Returns true when the file is on disk with the intended content. */
  async function saveTab(id: string): Promise<boolean> {
    const running = inFlightSaves.get(id)
    if (running) {
      const ok = await running.catch(() => false)
      const current = tabs.value.find((x) => x.id === id)
      // Gone (closed/removed) or the running save failed: nothing more to do
      // here, and reporting success would be a lie.
      if (!current || !ok) return false
      // The running save wrote the text as it was when it started. If the user
      // has not typed since, that IS this save — writing identical bytes again
      // would only add a history snapshot.
      if (!current.dirty) return true
    }
    const run = runSaveTab(id).finally(() => {
      if (inFlightSaves.get(id) === run) inFlightSaves.delete(id)
    })
    inFlightSaves.set(id, run)
    return run
  }

  async function runSaveTab(id: string): Promise<boolean> {
    const tab = tabs.value.find((x) => x.id === id)
    if (!tab || !vault.value) return false
    // The vault a save commits to is decided when the write happens, which is
    // several awaits after the user pressed the key. A vault switch in that
    // window (the switch flushes what it can, but an autosave or a window-blur
    // save is not part of that flush) used to land the OLD vault's note in the
    // NEW vault: the user would find a note they never created, with someone
    // else's content. Every write checks the vault it started in is still the
    // vault it is writing to.
    const vaultAtStart = vault.value
    let path = tab.path
    if (!path) {
      // Untitled tab: an explicit save means "save as", not a silent no-op.
      const picked = await files.saveFileDialog('untitled.md', vault.value)
      if (!picked) return false
      tab.path = picked
      path = picked
    }
    markSaving(tab.id)
    // Both panes coalesce keystrokes before publishing them to the tab, so
    // flush before ANYTHING reads tab.content below. This has to precede the
    // asset relocation, not just the write: relocation is a whole-document
    // read-modify-write, so running it against a stale snapshot would both
    // rewire the wrong text and clobber the keystrokes still in flight.
    //
    // The rendered pane needs the same treatment as the source pane. Saving
    // within its debounce window used to persist the previous text and then
    // re-apply it to the model, losing the keystrokes outright.
    await flushEdits()
    // A document the rendered model could not load must not be written. The
    // flush above published nothing for it (editorPersistence refuses while the
    // model is refused), so the tab still holds exactly the text that failed —
    // and writing that is writing a document the editor could not read, on the
    // strength of a model that holds something else. Refused, and said out
    // loud: a save that did not happen must not come back as one. Returning
    // false is what blocks the callers that act on the answer — the autosave,
    // the close, the vault switch — instead of letting them treat the file as
    // safe.
    //
    // Text the source pane authored is the one thing here that is the user's
    // own writing over this file rather than the model's output, so it is
    // theirs to save. Refusing it would strand the edits they typed to fix the
    // document: the tab stays dirty, and a dirty tab whose save fails cannot be
    // closed or closed over (tab-lifecycle keeps it; app-lifecycle refuses to
    // close the window) — the user would have to make the document render
    // again to be allowed to put their own text on disk.
    if (isRefusedDocument(tab.content) && !isSourceAuthored(tab.content)) {
      notifyError(t('tabs.saveBlockedUnrenderable'))
      // The same unwinding the `finally` below does for a failed write: this
      // refusal returns before it, and a flag left set pins the status line on
      // "Saving…" forever.
      markSaved(tab.id)
      return false
    }
    if (tab.pendingAssetPaths.length > 0) {
      await relocatePendingAssets(tab, vault.value, path)
    }
    // The flush and the asset relocation are both awaits, so the world can have
    // changed under us. Writing now would put this note into a vault it does not
    // belong to; leaving the tab dirty is the honest outcome (the user can save
    // it again in whichever vault is open).
    if (vault.value !== vaultAtStart) return false
    const editor = getActiveEditor()
    const contentAtStart = tab.content
    const next = emitLifecycle('onSave', editor, tab.content)
    const content = typeof next === 'string' ? next : tab.content
    try {
      // Arm the self-write window BEFORE the disk write: Tauri's recursive fs
      // watcher may report the modified path while the write is still in
      // flight. If we only marked it after the await returned, the watcher's
      // "external change" would reload the very file we just saved, replacing
      // the live editor content and resetting the caret (the "input jumps"
      // symptom). The existing 2s expiration keeps normal external edits
      // observable.
      noteSelfWrite(path)
      // A non-null result is a warning, not a failure: the text is on disk, but
      // something optional around it was not. Most often "the previous version
      // could not be kept in history" — which the user has to hear about, because
      // the thing they trust for undo-after-the-fact is now missing.
      const writeWarning = await files.write(vaultAtStart, path, content, settings.maxHistory)
      if (writeWarning) notifyError(writeWarning)
      // The write round-trip is a window in which the user can keep typing.
      // Never clobber newer editor content with the captured text.
      const userTyped = tab.content !== contentAtStart
      const pluginRewrote = content !== contentAtStart
      if (!userTyped && pluginRewrote) {
        // Adopt the onSave rewrite; suppress the re-open its content change
        // would trigger (the model syncs, the live text/caret stay put). The arm
        // carries THIS tab's id, so a background save cannot swallow the
        // re-apply of the content change belonging to another (active) tab.
        armSuppressReapply(tab.id)
        tab.content = content
        tab.savedContent = content
        tab.dirty = false
      } else if (userTyped) {
        tab.savedContent = content
        // dirty stays true; the newer text still needs a save.
      } else {
        tab.savedContent = content
        tab.dirty = false
      }
      // The write did land in the right vault (guarded above), but the tab set
      // may have been replaced wholesale while it was in flight — a vault
      // switch removes every tab. Touching a removed tab is harmless, touching
      // a REUSED id would not be, so the lifecycle event is skipped too.
      if (vault.value !== vaultAtStart) return true
      emitLifecycle('onSaved', editor, content)
      // Screen-reader status: a save round-trip landed (dirty → saved).
      announce(t('recovery.saved'))
      return true
    } catch {
      notifyError(t('tabs.saveFailed'))
      return false
    } finally {
      markSaved(tab.id)
    }
  }

  async function saveActive(): Promise<void> {
    const tab = activeTab.value
    if (tab) await saveTab(tab.id)
  }

  /** Best-effort save of every dirty tab that has a real path (used before a
   *  vault switch or an app close, where a pending autosave timer may never
   *  fire). Untitled tabs are skipped: with no path they would need a save-as
   *  dialog, which a background/bulk flush must not open. Returns false when a
   *  path'd save failed so the caller can block the potentially-lossy action. */
  async function flushDirty(): Promise<boolean> {
    let ok = true
    for (const tab of tabs.value) {
      if (!tab.dirty || !tab.path) continue
      const saved = await saveTab(tab.id)
      if (!saved) ok = false
    }
    return ok
  }

  /** Drop every fragment of save bookkeeping a removed tab could leave behind.
   *  Removing a tab only cancels its autosave timer; a closed tab's in-flight
   *  save, saving flag and self-write window must not outlive the tab set, or a
   *  later open (or a reused id) would inherit the stale remnants. */
  function resetSaveBookkeeping(): void {
    inFlightSaves.clear()
    savingIds.value = new Set()
    selfWrites.clear()
  }

  return {
    markSaving,
    markSaved,
    stateOf,
    noteSelfWrite,
    isSelfWrite,
    saveTab,
    saveActive,
    flushDirty,
    resetSaveBookkeeping,
  }
}

export type TabSave = ReturnType<typeof createTabSave>
