/**
 * The tab write path: the save transaction and the save-state the status line
 * reads.
 *
 * Split out of `tab-persistence.ts` (which keeps session + autosave) because
 * the transaction and its overlapping-save serialization do not fit under the
 * 400-line budget next to the session code. Five more slices left this file for
 * the same reason: the staged-asset relocation a first save performs
 * (`tab-assets.ts`), the claim that tells our own writes apart from external
 * edits (`self-writes.ts`), what a write must hold to be allowed at all
 * (`tab-write-preconditions.ts` — the read the save now takes before it writes,
 * which is L05's save-time half), the per-tab records this file keeps about
 * those writes (`tab-save-state.ts`), and the gate that keeps writing until a
 * tab is actually settled (`tab-settle.ts`). This module is a leaf: no other
 * tab module imports it except the store that wires them, and the fs port, the
 * clock and the notification ports all arrive through `deps`.
 */

import type { ComputedRef, Ref } from 'vue'
import { emitLifecycle, getActiveEditor } from '@nekowite/plugin-host'
import { armSuppressReapply } from '../services/suppress-reapply'
import { flushEdits } from '../services/editor-ownership'
import { createRefusedSaveAnswer } from './refused-save'
import { createSelfWrites } from './self-writes'
import { createTabAssets } from './tab-assets'
import { createTabSaveState } from './tab-save-state'
import { createTabSettler } from './tab-settle'
import { createWritePreconditions } from './tab-write-preconditions'
import type { OpenTab } from './tabs'

/** The slice of the settings store the write reads. */
export interface TabSaveSettingsPort {
  maxHistory: number
}

/** The slice of the fs gateway the write path uses. */
export interface TabSaveFilePort {
  /** Read the bytes a save is about to replace. Not optional: the save does not
   *  write without looking first (see `tab-write-preconditions.ts`). */
  read(vault: string, path: string): Promise<string>
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
  /**
   * The user asked for this save — and it is the only thing that can answer a
   * conflict. A file that changed on disk is refused once and the user is told;
   * a save they then ask for is their answer, so that write goes through (see
   * `tab-write-preconditions.ts`).
   *
   * Set in exactly ONE place — `saveActive`, which is the Ctrl+S route. The
   * close path's rescue also sets `offerCopy` and must not set this: the user
   * answered "save my text as copies", and that is not consent to replace an
   * edit somebody else made. A second caller appearing is the change to be
   * suspicious of.
   */
  userAsked?: boolean
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

  // Whether a write may happen at all, including the read that tells an edit
  // somebody else made from our own saved text; see the module note.
  const preconditions = createWritePreconditions({ files, vault, t, notifyError })

  // What this path remembers about each tab — a write in flight, its edit
  // revision, the state the status line reads (see `tab-save-state.ts`).
  const saveState = createTabSaveState({ tabs })
  const { markSaving, markSaved, stateOf, noteEdit, revisionOf } = saveState

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
    // A document the rendered model could not load must not be written — the
    // refusal, and the reason it is refused, are in
    // `tab-write-preconditions.ts`. The `markSaved` is this module's: the refusal
    // returns before the `finally` below, and a flag left set pins the status
    // line on "Saving…" forever.
    if (!preconditions.documentIsWritable(tab.content)) {
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
    // BEFORE the write (see `tab-save-state.ts`): the revision moves at the
    // keystroke, and the write spans an await the user can type across.
    const revisionAtStart = revisionOf(tab.id)
    // What is at the path is somebody else's edit unless it still holds the bytes
    // this tab last read or wrote (L05's save-time half; the read and the policy
    // are in `tab-write-preconditions.ts`). A save that writes without looking is
    // how another program's version disappears with nobody told, and this is the
    // last moment the question can be asked — the flush and the relocation above
    // are both whole-document work of their own.
    if (
      !(await preconditions.fileHoldsOurBytes(tab, vaultAtStart, path, {
        pickedPath: pickedInThisSave,
        userAsked: opts.userAsked === true,
      }))
    ) {
      // Nothing was written, so nothing about a write happens: no `onSave` for a
      // save the app refused (the unrenderable refusal above is refused the same
      // way, for the same reason), and the flag this save raised comes back down
      // or the status line stays pinned on "Saving…".
      markSaved(tab.id)
      return false
    }
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
      // The file holds this tab's bytes again: whatever was in conflict is spent
      // by the write that replaced it, and the next save is an ordinary one.
      preconditions.clearConflict(tab)
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
      const editedDuringWrite = revisionOf(tab.id) !== revisionAtStart
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
   *  tab already has. And it is the ONE caller that speaks for the user: a save
   *  they ask for again, having been told the file changed under them, is their
   *  answer to that question (see `TabSaveOptions.userAsked`). */
  async function saveActive(): Promise<void> {
    const tab = activeTab.value
    if (tab) await saveTab(tab.id, { offerCopy: true, userAsked: true })
  }

  /** The conflict prompt's "Keep local", recorded where the next save reads it
   *  (see `tab-write-preconditions.ts`'s `keepLocal`). The prompt reports the
   *  answer instead of acting on it (§10.2), and this is the app's side of that:
   *  the same command the reload beside it takes, for the other answer. */
  async function keepLocalConflict(id: string): Promise<void> {
    const tab = tabs.value.find((x) => x.id === id)
    if (tab) await preconditions.keepLocal(tab)
  }

  /** The bulk flush and the per-tab gate behind it (see `tab-settle.ts`). Both
   *  are created here because both need this module's `saveTab`: the store wires
   *  the flush to the vault switch and the close, and hands the per-tab form to
   *  `tab-lifecycle` for the closes it runs itself. */
  const { saveUntilSettled, flushDirty } = createTabSettler({ tabs, saveTab })

  /** Drop every fragment of save bookkeeping a removed tab could leave behind.
   *  Removing a tab only cancels its autosave timer; a closed tab's in-flight
   *  save, saving flag, edit revision and self-write claim must not outlive the
   *  tab set, or a later open (or a reused id) would inherit the stale
   *  remnants. */
  function resetSaveBookkeeping(): void {
    inFlightSaves.clear()
    selfWrites.clear()
    saveState.reset()
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
    keepLocalConflict,
    flushDirty,
    saveUntilSettled,
    resetSaveBookkeeping,
  }
}

export type TabSave = ReturnType<typeof createTabSave>
