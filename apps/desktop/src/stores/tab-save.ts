/**
 * The tab write path: the save transaction and the save-state the status line
 * reads.
 *
 * Split out of `tab-persistence.ts` (which keeps session + autosave) because
 * the transaction and its overlapping-save serialization do not fit under the
 * 400-line budget next to the session code. Two more slices left this file for
 * the same reason: the staged-asset relocation a first save performs
 * (`tab-assets.ts`) and the claim that tells our own writes apart from external
 * edits (`self-writes.ts`). This module is a leaf: it depends on no other tab
 * module, and the fs port, the clock and the notification ports all arrive
 * through `deps`.
 */

import { ref } from 'vue'
import type { ComputedRef, Ref } from 'vue'
import { emitLifecycle, getActiveEditor } from '@nekowite/plugin-host'
import { armSuppressReapply } from '../services/suppress-reapply'
import { flushEdits, isRefusedDocument, isSourceAuthored } from '../services/editor-ownership'
import { createRefusedSaveAnswer } from './refused-save'
import { createSelfWrites } from './self-writes'
import { createTabAssets } from './tab-assets'
import type { OpenTab } from './tabs'

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
  /** Injectable clock: a self-write claim with no bytes to name is a wall-clock
   *  comparison, and tests must be able to move it without waiting two real
   *  seconds. A save's own claim is decided by content, not by this. */
  now?: () => number
}

export interface TabSaveOptions {
  /**
   * Offer another name for the text when the target file refuses the write.
   *
   * Only a save the user asked for may set this. A read-only file refuses every
   * retry, so its refusal is not a failure to report and repeat — but `saveTab`
   * is also the autosave's, the window-blur save's and the bulk flush's entry
   * point, and none of those may put a file dialog in front of the user
   * mid-keystroke or behind a vault switch. Callers that speak for the user
   * (Ctrl+S, and the close path's rescue) are the ones that set it.
   */
  offerCopy?: boolean
}

export function createTabSave(deps: TabSaveDeps) {
  const { tabs, activeTab, vault, settings, files, t, notifyError, announce } = deps
  const now = deps.now ?? (() => Date.now())
  // Which writes are ours (see `self-writes.ts`).
  const selfWrites = createSelfWrites(now)
  // What a rejected write tells the user, and the route out of a refusal: the
  // text goes to a name they pick, and the tab follows it there.
  const refusedSave = createRefusedSaveAnswer({
    files,
    settings,
    t,
    notifyError,
    announce,
    noteSelfWrite: (path) => selfWrites.note(path),
  })

  // The staged-asset half of a first save (`tab-assets.ts`): it edits
  // `tab.content` in place, so it is handed the tab rather than a snapshot.
  const assets = createTabAssets({ files, t, notifyError })

  const savingIds = ref<Set<string>>(new Set())

  /**
   * Per-tab edit revision: one bump for every `markDirty`, which the editor
   * panes fire on every doc-changing keystroke
   * (`editorPersistence`'s `onContentChange`, `SourcePane`'s publish).
   *
   * This is the evidence a save uses to decide whether it may call a tab saved,
   * and it exists because `tab.content` cannot answer that question. The
   * rendered pane publishes through a 120 ms debounce, so a keystroke sets
   * `dirty` and bumps this revision IMMEDIATELY while `tab.content` still holds
   * the previous text — for the whole length of a write, `tab.content` is
   * exactly what the save already wrote, and a save that compared only that
   * text cleared `dirty` over keystrokes that were in neither the tab nor the
   * file. A revision cannot be fooled that way: it moves at the keystroke, not
   * at the publish.
   *
   * Keyed by tab id, and ids are never reused within a session (`tab-${++seq}`
   * in `tab-lifecycle.ts`), so a recycled id cannot inherit a dead tab's
   * revision; `resetSaveBookkeeping` still clears it with the rest.
   */
  const editRevisions = new Map<string, number>()

  /** Record that `id`'s text changed (the caller is the text, not the publish). */
  function noteEdit(id: string): void {
    editRevisions.set(id, (editRevisions.get(id) ?? 0) + 1)
  }

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

  /** Returns true when the file is on disk with the intended content. */
  async function saveTab(id: string, opts: TabSaveOptions = {}): Promise<boolean> {
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
    const run = runSaveTab(id, opts).finally(() => {
      if (inFlightSaves.get(id) === run) inFlightSaves.delete(id)
    })
    inFlightSaves.set(id, run)
    return run
  }

  async function runSaveTab(id: string, opts: TabSaveOptions): Promise<boolean> {
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
    // Save-As binds the tab to the picked name BEFORE the write, because
    // everything below (the asset relocation, the save itself) needs the
    // destination. A write that then FAILS leaves that binding standing — the
    // tab naming a file it never wrote to, with `savedContent` still holding the
    // untitled '' — so the catch below puts such a tab back to untitled, which
    // is the state that is actually true. Nothing is lost by that: the Save-As
    // dialog proposes `untitled.md` from the tab's state, not from this pick.
    let pickedInThisSave = false
    if (!path) {
      // Untitled tab: an explicit save means "save as", not a silent no-op.
      const picked = await files.saveFileDialog('untitled.md', vault.value)
      if (!picked) return false
      tab.path = picked
      path = picked
      pickedInThisSave = true
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
      await assets.relocate(tab, vault.value, path)
    }
    // The flush and the asset relocation are both awaits, so the world can have
    // changed under us. Writing now would put this note into a vault it does not
    // belong to; leaving the tab dirty is the honest outcome (the user can save
    // it again in whichever vault is open).
    if (vault.value !== vaultAtStart) return false
    const editor = getActiveEditor()
    const contentAtStart = tab.content
    // The evidence that decides whether this save may call the tab saved, read
    // BEFORE the write (see `editRevisions`): the revision moves at the
    // keystroke, and the write spans an await the user can type across.
    const revisionAtStart = editRevisions.get(tab.id) ?? 0
    const next = emitLifecycle('onSave', editor, tab.content)
    const content = typeof next === 'string' ? next : tab.content
    try {
      // Claim the path as ours BEFORE the disk write, naming the bytes we are
      // about to put there: Tauri's recursive fs watcher may report the
      // modified path while the write is still in flight. If we only claimed it
      // after the await returned, the watcher's "external change" would reload
      // the very file we just saved, replacing the live editor content and
      // resetting the caret (the "input jumps" symptom). The claim is the
      // content rather than a stopwatch, so it lasts exactly as long as the
      // write does — see `isSelfWrite`.
      selfWrites.note(path, content)
      // A non-null result is a warning, not a failure: the text is on disk, but
      // something optional around it was not. Most often "the previous version
      // could not be kept in history" — which the user has to hear about, because
      // the thing they trust for undo-after-the-fact is now missing.
      const writeWarning = await files.write(vaultAtStart, path, content, settings.maxHistory)
      if (writeWarning) notifyError(writeWarning)
      // `savedContent` is what this tab believes is ON DISK, and after a landed
      // write that is exactly `content` — true whatever the user typed in the
      // meantime, because those keystrokes are not on disk yet.
      tab.savedContent = content
      // Whether the tab may be called SAVED is a separate question, and it is
      // answered by evidence rather than by the write having completed. A
      // completed write only proves it wrote the text it captured; it says
      // nothing about the keystrokes the user took while it ran. The revision
      // is the evidence: it moves at the keystroke while `tab.content` moves
      // only when the pane's 120ms publish debounce fires, so for the whole
      // length of a write `tab.content === content` even though the user has
      // typed. Clearing `dirty` on that comparison is how this used to report
      // "saved" over text that was in neither the tab nor the file — and
      // `dirty` is the only record that such text exists: the autosave timer,
      // `hasUnsavedWork()`, the window-close flush and the close-tab save all
      // read it and all skipped the work.
      const editedDuringWrite = (editRevisions.get(tab.id) ?? 0) !== revisionAtStart
      const pluginRewrote = content !== contentAtStart
      if (!editedDuringWrite) {
        if (pluginRewrote) {
          // Adopt the onSave rewrite; suppress the re-open its content change
          // would trigger (the model syncs, the live text/caret stay put). The
          // arm carries THIS tab's id, so a background save cannot swallow the
          // re-apply of the content change belonging to another (active) tab.
          armSuppressReapply(tab.id)
          tab.content = content
        }
        // Only when the tab holds exactly what was written is there nothing
        // left to save. Anything else — an external apply that replaced the
        // document mid-write — leaves `dirty` alone rather than guessing.
        if (tab.content === content) tab.dirty = false
      }
      // Otherwise: dirty stays true, and the autosave timer the keystroke armed
      // is still pending, so the newer text gets its own save.
      // The write did land in the right vault (guarded above), but the tab set
      // may have been replaced wholesale while it was in flight — a vault
      // switch removes every tab. Touching a removed tab is harmless, touching
      // a REUSED id would not be, so the lifecycle event is skipped too.
      if (vault.value !== vaultAtStart) return true
      emitLifecycle('onSaved', editor, content)
      // Screen-reader status: a save round-trip landed (dirty → saved).
      announce(t('recovery.saved'))
      return true
    } catch (e) {
      // The write did not land, so a path this save was the one to pick names a
      // file the tab never wrote and has never read: give the tab back its
      // untitled state rather than leave it asserting an association that does
      // not hold. Nothing is lost by that — the Save-As dialog proposes
      // `untitled.md` from the tab's state, not from this pick.
      if (pickedInThisSave) tab.path = null
      // What the user is told, and the way out, belong to the refusal itself:
      // see `refused-save.ts`. A refusal is not a failure, and `saveFailed`'s
      // "please retry" is advice a read-only file never lets them carry out.
      return await refusedSave.answer(
        e,
        tab,
        { vaultPath: vaultAtStart, path, content, contentAtStart, editor },
        opts.offerCopy === true,
      )
    } finally {
      markSaved(tab.id)
      // The write is over, landed or not: the claim must not outlive it, or a
      // later genuine external edit to this path would be read as our echo.
      selfWrites.settle(path)
    }
  }

  /** Ctrl+S. An explicit save, so it may ask where the text should go when the
   *  file it was aimed at refuses to take it — the same latitude an untitled
   *  tab already has. */
  async function saveActive(): Promise<void> {
    const tab = activeTab.value
    if (tab) await saveTab(tab.id, { offerCopy: true })
  }

  /** Best-effort save of every dirty tab that has a real path (used before a
   *  vault switch or an app close, where a pending autosave timer may never
   *  fire). Untitled tabs are skipped: with no path they would need a save-as
   *  dialog, which a background/bulk flush must not open — and for the same
   *  reason a tab whose file refuses the write is left to the caller that owns
   *  the moment (the close offers the copy route itself; see `app-lifecycle`).
   *  Returns false when a path'd save failed so the caller can block the
   *  potentially-lossy action. */
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
   *  save, saving flag, edit revision and self-write claim must not outlive the
   *  tab set, or a later open (or a reused id) would inherit the stale
   *  remnants. */
  function resetSaveBookkeeping(): void {
    inFlightSaves.clear()
    savingIds.value = new Set()
    selfWrites.clear()
    editRevisions.clear()
  }

  return {
    markSaving,
    markSaved,
    stateOf,
    noteEdit,
    noteSelfWrite: selfWrites.note,
    isSelfWrite: selfWrites.isSelfWrite,
    saveTab,
    saveActive,
    flushDirty,
    resetSaveBookkeeping,
  }
}

export type TabSave = ReturnType<typeof createTabSave>
