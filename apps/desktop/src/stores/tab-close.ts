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
 * silent for as long as the read took, forever if it never landed.
 */

import type { Ref } from 'vue'
import { flushEdits } from '../services/editor-ownership'
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
    requestUntitledClose,
    untitledDirtyTabs,
    captureSession,
    rescuePlaceholderTyping,
    removeTab,
    removeAllTabs,
    focusTab,
  } = deps

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
   * The flush comes first for the reason `commitRead` takes it: `dirty` is set
   * at the KEYSTROKE, and `tab.content` holds the typing only once the pane has
   * published it (the rendered pane is a 120 ms debounce behind — see
   * `editor-persistence.ts`). The rescue is a one-shot read of that field, so
   * without this it hands the user an empty tab under a message saying their
   * text is in it.
   */
  async function closePlaceholder(id: string): Promise<boolean> {
    const tab = tabs.value.find((x) => x.id === id)
    if (tab?.dirty) {
      await flushEdits()
      // Everything above is stale after that await — it is where the read
      // lands, and where a `closeAll` or a vault switch removes the tab.
      const current = tabs.value.find((x) => x.id === id)
      if (!current) return true
      // The read landed during the flush: the tab holds the note again, with
      // text of its own to save, and the typing `commitRead` just rescued is
      // already in a tab of its own (that rescue announces itself). So this
      // close is an ordinary one after all.
      if (!current.loading) return false
      // The flags are re-read after the await, and `dirty` is the one that
      // gates the rescue: a clean placeholder has nothing of the user's in it,
      // and copying its empty document into a new tab would hand them an empty
      // tab under a message saying their text is safe — the defect `commitRead`
      // was just fixed for. `closePlaceholder` is only reached for a dirty tab,
      // so this is the interval between the keystroke and here.
      if (current.dirty) rescuePlaceholderTyping(current, t('tabs.closeWhileLoading'))
    }
    removeTab(id)
    captureSession()
    return true
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
          if (!(await saveUntilSettled(tab.id))) {
            notifyError(t('tabs.unsavedWorkBlocker'))
            return false
          }
        }
      }
    }
    // `flushDirty` settles what it touched, so a tab that is dirty HERE is one
    // that became dirty after that flush — the prompt above is user time, with
    // the editor still live behind it, and a keystroke typed into it is in no
    // write yet. The bulk close therefore asks the same question the single
    // close does, at the last moment it can be asked: `removeAllTabs` would
    // otherwise discard exactly that text. Untitled tabs are not revisited: the
    // prompt owns them, and one the user chose to discard has no path to save
    // to.
    for (const tab of [...tabs.value]) {
      if (!tab.path || !tab.dirty) continue
      if (!(await saveUntilSettled(tab.id))) {
        notifyError(t('tabs.unsavedWorkBlocker'))
        return false
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

  return { closeTab, closeAll, closeOthers }
}

export type TabClose = ReturnType<typeof createTabClose>
