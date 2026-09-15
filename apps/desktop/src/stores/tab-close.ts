/**
 * Closing tabs: what a close owes the user's text before the tab goes away.
 *
 * Split out of `tab-lifecycle.ts` when the placeholder close arrived (§13.1's
 * budget, and §13.3: this is the vertical slice — every route that takes a tab
 * away, and the work each one does first). That module is about a document
 * ARRIVING: the placeholder, its first read, the reconciliation of whatever the
 * user typed into it. This one is about it LEAVING. Both directions need the
 * placeholder rescue, so it arrives through `deps` from the module that owns the
 * read, and the closures that take a tab out of the set arrive the same way.
 *
 * The closes never remove a tab holding text no disk has: a path'd tab is
 * written until it is settled, an untitled one is prompted for, and a tab whose
 * first read has not landed has what was typed into it moved to a tab of its
 * own first. That last state is the one a close must not hand to the save gate
 * — the gate's `loading` refusal is about WRITING (the read that is still
 * running settles it), and reading it as a refusal to CLOSE left the X inert and
 * silent for as long as the read took, forever if it never landed. The closes
 * that take the WHOLE set away run that move for every tab that needs it before
 * anything else (`reconcilePlaceholders`), because the flush and the untitled
 * prompt both come after it and both depend on it.
 */

import type { Ref } from 'vue'
import { flushEdits } from '../services/editor-ownership'
import { createUntitledRescue } from './untitled-rescue'
import type { OpenTab } from './tabs'

/** What the user chose for the untitled dirty tabs blocking a bulk close. */
export type UntitledCloseChoice = 'save' | 'discard'

export interface TabCloseDeps {
  tabs: Ref<OpenTab[]>
  t: (key: string, params?: Record<string, unknown>) => string
  notifyError(message: string): void
  /** Persistence commands the close flows call. `saveUntilSettled` is the gate
   *  a close asks, not `saveTab`: one landed write is not a saved tab
   *  (`tab-settle.ts`), and a close that reads it as one drops the text the
   *  write could not carry. */
  saveUntilSettled(id: string): Promise<boolean>
  flushDirty(): Promise<boolean>
  /** The route out of a flush that a refused write blocked: a copy of the text
   *  under a name the user picks, for a file that will refuse every retry. The
   *  loop is `unflushable-rescue.ts` and the window close asks the same factory
   *  for the same route — the two controls differ, the question a refusal asks
   *  does not, and a second copy of it is how they came to differ. */
  rescueUnflushableTabs(): Promise<boolean>
  /** Ask the user what to do with `count` untitled dirty tabs before a bulk
   *  close. Injected because the app-layer prompt lives in
   *  `app/recoveryClosedLoop` — see `tab-lifecycle.ts`'s module header.
   *  Resolves `'save'` to save them through Save-As first, `'discard'` to drop
   *  them. */
  requestUntitledClose(count: number): Promise<UntitledCloseChoice>
  untitledDirtyTabs(): OpenTab[]
  captureSession(): void
  /** Give a placeholder's typing a document of its own — the state it is
   *  actually in — and tell the user where it went. Owned by the read commit,
   *  which needs the same thing when a read lands on a tab that was typed into
   *  (see `tab-lifecycle.ts`). */
  rescuePlaceholderTyping(from: OpenTab, notice: string): void
  /** Take one tab out of the set, and drop every tab of it. */
  removeTab(id: string): void
  removeAllTabs(): void
  focusTab(id: string | null): void
}

export function createTabClose(deps: TabCloseDeps) {
  const {
    tabs,
    t,
    notifyError,
    saveUntilSettled,
    flushDirty,
    rescueUnflushableTabs,
    requestUntitledClose,
    untitledDirtyTabs,
    captureSession,
    rescuePlaceholderTyping,
    removeTab,
    removeAllTabs,
    focusTab,
  } = deps

  /**
   * The question this close asks about untitled dirty tabs, asked at the moment
   * it takes the set away rather than at the moment it first looked
   * (`untitled-rescue.ts`, where the loop lives — the window's X and a vault
   * switch ask the same factory for it).
   *
   * A discard needs no step of its own on this route, which is why `onDiscard` is
   * empty: `removeAllTabs()` below takes the set whether the user discarded a tab
   * or not, and removing it as the answer arrives would move the moment it
   * disappears above the pass that is still looking for late typing.
   */
  const rescueUntitledTabs = createUntitledRescue({
    listUntitledDirty: untitledDirtyTabs,
    listTabs: () => tabs.value,
    ask: requestUntitledClose,
    settle: saveUntilSettled,
    onDiscard: () => {},
  })

  /**
   * Close a tab whose first read has not landed, taking whatever was typed into
   * it out of it first. Returns false when the read landed while the pane was
   * being flushed — the tab is a note again, and the caller's ordinary close is
   * the right one for it.
   *
   * The placeholder holds an EMPTY document wearing the note's path, so it has
   * no text of its own: saving it is exactly what the write path refuses, and
   * rightly — writing the placeholder is how it would go over the note. Closing
   * it needs no write at all, and asking for one is what made the X inert on the
   * state a user reaches by typing into a note that has not finished opening.
   * Their typing is not the note's and cannot be sent to the note's file: it is
   * text with no file of its own, which is the state `rescuePlaceholderTyping`
   * exists for. So it moves there, the user is told where it went, and the note
   * they asked to close closes — file untouched, which is all the read was ever
   * going to say about it. A read that never lands no longer holds the tab
   * hostage either: nothing here waits on it.
   *
   * The flush comes first — unconditionally, NOT behind `dirty`. `dirty` is set
   * at the PUBLISH and only the rendered pane publishes at the keystroke (the
   * source pane coalesces for `SOURCE_SNAPSHOT_DEBOUNCE_MS` and marks dirty from
   * the publish that follows — `services/code-mirror-host.ts`), so a user typing
   * into this placeholder in source or split mode has `dirty === false` for the
   * length of the burst: a `dirty` gate read the tab as untouched and `removeTab`
   * dropped the typing without a word. The flush publishes what the pane is
   * still holding, which is what makes `dirty` and `content` describe it; with
   * nothing pending it is a no-op per pane.
   */
  async function closePlaceholder(id: string): Promise<boolean> {
    await flushEdits()
    // Everything above is stale after that await — it is where the read lands,
    // and where a `closeAll` or a vault switch removes the tab.
    const current = tabs.value.find((x) => x.id === id)
    if (!current) return true
    // The read landed during the flush: the tab holds the note again, with
    // text of its own to save, and the typing `commitRead` just rescued is
    // already in a tab of its own (that rescue announces itself). So this
    // close is an ordinary one after all.
    if (!current.loading) return false
    // `dirty` is read AFTER the flush and not before it — that is the whole
    // reason the flush is not gated on it. A placeholder the flush left clean
    // has nothing of the user's in it, and copying its empty document into a
    // new tab would hand them an empty tab under a message saying their text is
    // safe — the defect `commitRead` was just fixed for.
    if (current.dirty) rescuePlaceholderTyping(current, t('tabs.closeWhileLoading'))
    removeTab(id)
    captureSession()
    return true
  }

  /**
   * Do what `closePlaceholder` does for one tab, for every tab that needs it:
   * move what was typed into a tab whose first read has not landed into a tab of
   * its own. The two bulk closes owe this step BEFORE their flush, and it is one
   * function rather than a line in each of them because the second copy is the
   * bug — neither route called the rescue at all, so a placeholder's `loading`
   * refusal (a refusal about WRITING) read as "unsafe to close" and blocked both
   * forever.
   *
   * Order matters both ways round. Before the flush, because `flushDirty` asks
   * the save gate about every dirty tab with a path and a placeholder can never
   * answer it; before the untitled prompt, because the tabs this creates are
   * untitled and dirty, and the prompt is what offers the user their text back
   * (save it under a name, or discard it) instead of the close taking it.
   *
   * The notice is the close's own (`tabs.closeWhileLoading`): the note is on its
   * way out, so the read-commit sentence — which says the note now shows the
   * file — would describe a tab the user will not see.
   */
  async function reconcilePlaceholders(): Promise<void> {
    // Nothing to do is the common case, and it must stay cheap: this runs in
    // front of every bulk close, and the pane flush below is global work. The
    // scan asks whether a placeholder is OPEN, not whether one is dirty: a
    // source burst is 50 ms behind marking its tab, so a `dirty` test here is
    // the same gate `closePlaceholder` cannot use — it would skip the flush and
    // let `removeAllTabs` drop the burst.
    if (!tabs.value.some((tab) => tab.loading)) return
    // The flush comes first for the reason `closePlaceholder` and `commitRead`
    // take it: a pane publishes only once its own debounce has run, so
    // `tab.content` holds the typing — and the tab is marked dirty — only after
    // this, while the rescue is a one-shot read of that field.
    await flushEdits()
    // The flush is an await, and it is where the read lands — a tab that has
    // become a note again holds text of its own to save and belongs to the
    // flush, not here. Both flags are re-read for that reason, and `dirty` after
    // the flush is what the burst above set.
    for (const tab of [...tabs.value]) {
      if (tab.loading && tab.dirty) rescuePlaceholderTyping(tab, t('tabs.closeWhileLoading'))
    }
  }

  async function closeTab(id: string): Promise<void> {
    const tab = tabs.value.find((x) => x.id === id)
    // A placeholder is not the save gate's to settle — see `closePlaceholder`.
    if (tab?.loading && (await closePlaceholder(id))) return
    // Unsaved work is flushed, not discarded: the pending autosave timer is
    // cancelled on removal, so without this the edits would be unrecoverable.
    // The gate is `saveUntilSettled` and not "one save succeeded" — see
    // `tab-settle.ts` for the keystroke that makes those two different answers.
    //
    // A refusal from it needs no sentence of its own here: every refusal the
    // gate can give a user — the read-only file, the document the editor cannot
    // vouch for, the file that changed under the tab — is issued by the write
    // path with its own reason attached
    // (`tab-write-preconditions.ts`), and a second, vaguer one on top of it
    // would be noise.
    const current = tabs.value.find((x) => x.id === id)
    if (current?.dirty && !(await saveUntilSettled(id))) return
    removeTab(id)
    captureSession()
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
   *
   * The steps are the window close's, in the window close's order —
   * `reconcilePlaceholders`, `flushDirty`, and, when the flush was refused rather
   * than failed, `rescueUnflushableTabs`, which offers the text a copy under a
   * name the user picks (`unflushable-rescue.ts`: one loop, both controls). A
   * file that refuses the write refuses every retry of it, so without that step
   * a read-only note — a note restored from the trash carries the bit, and the
   * user need never have set it — left "Close all" with no move at all while the
   * window's X offered one.
   *
   * The question is asked until no tab in the set is left unasked, because that
   * is what `removeAllTabs` needs: it takes the set as it stands THEN, while
   * everything above it is user time. `rescueUntitledTabs` is that loop and
   * carries the reasoning for it — the + button and a read landing on a
   * placeholder both produce an untitled dirty tab the snapshot this used to
   * take before the prompt could not contain, and `removeAllTabs` took them:
   * autosave timer cancelled, text in no file and in no prompt.
   */
  async function closeAll(): Promise<boolean> {
    if (tabs.value.length === 0) return true
    // The placeholder step, before the flush and before the prompt: see
    // `reconcilePlaceholders`. Without it a tab whose read had not landed held
    // this whole close — `flushDirty` can never settle one, and the sentence the
    // user got for it was about a vault switch.
    await reconcilePlaceholders()
    const flushed = await flushDirty()
    if (!flushed && !(await rescueUnflushableTabs())) {
      // A close, not a vault switch: `unsavedWorkBlocker` says the vault was not
      // switched, which is an action a user closing every tab never took. This
      // path has wording of its own for the same reason the window close has
      // its: `unsavedWorkBlockerClose` names the WINDOW, and what stays open
      // here is the tabs.
      notifyError(t('tabs.unsavedWorkBlockerCloseAll'))
      return false
    }
    // The last moment the question can be asked — `removeAllTabs` takes the set
    // on the next line, and everything above here is user time with the editor
    // still live behind it. A refusal is a save the copy route did not settle
    // either, and it leaves the close where it was, with the text in the editor.
    if (!(await rescueUntitledTabs())) {
      notifyError(t('tabs.unsavedWorkBlockerCloseAll'))
      return false
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

  return { closeTab, closeAll, closeOthers, reconcilePlaceholders }
}

export type TabClose = ReturnType<typeof createTabClose>
