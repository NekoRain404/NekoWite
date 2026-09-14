/**
 * What a rejected write tells the user, and the way out of it.
 *
 * Two things can stop a write, and they need opposite answers. A FAILURE is
 * transient — the disk filled, the vault moved — and "content is kept in the
 * editor, please retry" is honest advice for it. A REFUSAL is a decision: the
 * destination is read-only, the same write will be refused again for as long as
 * that is true, and a retry is an instruction the user cannot carry out. Telling
 * the two apart is `write-refusal.ts`'s job, from the backend's token and never
 * from its sentence; answering them is this module's.
 *
 * A refusal also owes the user a route out, because its consequences are not a
 * sentence's either: `flushDirty()` — the gate the window close goes through —
 * keeps failing while the tab is dirty, so a user who typed into a protected
 * note (a note restored from the trash carries the bit, so they need never have
 * set it) could neither save nor quit. That route is the copy below.
 *
 * Why a copy, and not the alternatives:
 *
 *   * **nothing may be lost.** The text lands on disk verbatim, exactly as the
 *     refused write carried it, under a name the user picks. Discarding the
 *     edits (the other classic way out of a "cannot save" dialog) throws away
 *     the one thing the refusal promised to keep.
 *   * **nothing is written to a file they protected.** Making the file writable
 *     would overrule whoever set the bit — the user in a file manager, or a sync
 *     tool marking a placeholder — and the backend refuses precisely so that
 *     cannot happen by accident. A copy does not need their permission.
 *   * **it is what the refusal already tells them to do.** The backend's own
 *     sentence ends "…or save it under a different name"; this is that, offered
 *     as something the user can act on instead of read.
 *
 * The tab then FOLLOWS the text, so a later save cannot walk back into the file
 * that refused it, and the work stops being unsaved — which is what lets the
 * window close.
 */

import { emitLifecycle } from '@nekowite/plugin-host'
import { armSuppressReapply } from '../services/suppress-reapply'
import { copyNameFor, classifyWriteRefusal } from './write-refusal'
import type { OpenTab } from './tabs'

/** The slice of the fs gateway the copy route uses. */
export interface RefusedSaveCopyFilePort {
  write(vault: string, path: string, content: string, maxHistory?: number): Promise<string | null>
  saveFileDialog(defaultName: string, startDir?: string): Promise<string | null>
}

export interface RefusedSaveCopyDeps {
  files: RefusedSaveCopyFilePort
  settings: { maxHistory: number }
  t: (key: string, params?: Record<string, unknown>) => string
  notifyError(message: string): void
  /** Screen-reader status channel ("the text went to another file"). */
  announce(message: string): void
  /** Arms the self-write window for the copy's path, so the watcher does not
   *  read our own new file back as an external change. */
  noteSelfWrite(path: string): void
}

/** The write that was refused: what it would have carried, and where it was
 *  aimed. `contentAtStart` is the tab's text when the save began — the
 *  difference between it and `content` is what the user typed while the write
 *  was in flight. */
export interface RefusedWrite {
  vaultPath: string
  path: string
  content: string
  contentAtStart: string
  editor: unknown
}

export function createRefusedSaveAnswer(deps: RefusedSaveCopyDeps) {
  const { files, settings, t, notifyError, announce, noteSelfWrite } = deps

  /**
   * Answer a write that did not land. Returns true only once the text is on
   * disk somewhere the user chose — which is what tells the callers that act on
   * the answer (the autosave, the close, the vault switch) the file is safe.
   *
   * `mayOfferCopy` is the caller saying whether it speaks for the user: only a
   * save they asked for may put a file dialog in front of them (see
   * `TabSaveOptions.offerCopy` for why the background paths may not).
   */
  async function answer(
    e: unknown,
    tab: OpenTab,
    where: RefusedWrite,
    mayOfferCopy: boolean,
  ): Promise<boolean> {
    if (classifyWriteRefusal(e) !== 'read-only') {
      // A failure, not a refusal. The retry it names is one the user can
      // actually carry out, and a Save-As dialog here would answer a question
      // nobody asked.
      notifyError(t('tabs.saveFailed'))
      return false
    }
    if (!mayOfferCopy) {
      // The refusal, named. The sentence says what is wrong and that nothing was
      // touched — a background save has no way to ask where else the text should
      // go, and must not pretend otherwise.
      notifyError(t('tabs.saveBlockedReadOnly', { path: where.path }))
      return false
    }
    // The dialog explains itself only if the user has already been told why it
    // is being asked.
    notifyError(t('tabs.saveBlockedReadOnlyCopy', { path: where.path }))
    return await copyUnderAnotherName(tab, where)
  }

  /** Returns true once the text is on disk under the new name. */
  async function copyUnderAnotherName(tab: OpenTab, where: RefusedWrite): Promise<boolean> {
    const copyPath = await files.saveFileDialog(copyNameFor(where.path), where.vaultPath)
    // Cancelled. The text stays in the editor, the tab stays dirty, and the note
    // on disk keeps its own content: saying no loses nothing.
    if (!copyPath) return false
    try {
      noteSelfWrite(copyPath)
      await files.write(where.vaultPath, copyPath, where.content, settings.maxHistory)
    } catch (e) {
      // The copy was refused as well (another protected file, a read-only
      // folder). Report it and stop: answering a refusal with a second dialog
      // would be a loop, and the text is in the editor either way.
      notifyError(
        classifyWriteRefusal(e) === 'read-only'
          ? t('tabs.saveBlockedReadOnly', { path: copyPath })
          : t('tabs.saveFailed'),
      )
      return false
    }
    // Same three cases as an ordinary save, in the same order of precedence: the
    // text on disk is `content`, and the tab is clean only while nothing has
    // moved since that text was captured.
    const userTyped = tab.content !== where.contentAtStart
    tab.path = copyPath
    if (!userTyped) {
      if (where.content !== where.contentAtStart) armSuppressReapply(tab.id)
      tab.content = where.content
      tab.dirty = false
    }
    tab.savedContent = where.content
    announce(t('tabs.savedAsCopy', { path: copyPath }))
    emitLifecycle('onSaved', where.editor, where.content)
    return true
  }

  return { answer, copyUnderAnotherName }
}

export type RefusedSaveAnswer = ReturnType<typeof createRefusedSaveAnswer>
