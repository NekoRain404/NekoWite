/**
 * What a save holds to be true before it writes.
 *
 * Every check here stops a write, and they all share one shape: nothing is
 * written, the tab keeps its text and stays dirty, and the user is told why.
 * `refused-save.ts` answers the refusals the DISK issues — a read-only file,
 * whose retry is refused again — and these are the ones the APP issues.
 *
 * The changed file is the reason this module exists (L05's save-time half). A
 * save never looked at the disk: whatever was at the path was replaced by this
 * tab's text, so an edit made in another program — another machine's sync, a git
 * checkout, a script, the user's own hand in another editor — was gone, with
 * nothing on screen to say so. The check costs one read per write and asks the
 * only question that answers it: are the bytes about to be replaced the bytes
 * this tab last read, or last wrote?
 *
 * What follows the read is the design, and it is not a dialog. The question is
 * remembered ON THE TAB, because the save path is where the overwrite happens
 * and it is reached by callers that have no user in front of them — an autosave
 * timer, a bulk flush, a window close. So: refuse, keep the text, tell the user
 * once, and remember the answer. Without the memory, every later save re-asks a
 * question the user has already answered (the event-time half's prompt has
 * exactly this defect) and the save overwrites anyway, which is a prompt that
 * costs attention and buys nothing.
 *
 * The other two checks moved here out of the save's transaction for the budget
 * (§13.1): they were inline in the same stretch of it, they are the same kind of
 * thing, and a tab-save.ts that kept them and grew the disk policy would have
 * crossed 400 having made room for nothing.
 */

import type { Ref } from 'vue'
import { isRefusedDocument, isSourceAuthored } from '../services/editor-ownership'

/** The slice of the fs gateway these checks use. */
export interface WritePreconditionFilePort {
  read(vault: string, path: string): Promise<string>
}

export interface WritePreconditionDeps {
  files: WritePreconditionFilePort
  /**
   * Read live rather than captured. The read below is an await, so a vault
   * switch can land inside it, and this module's whole subject is not writing
   * one vault's bytes into another's.
   */
  vault: Ref<string | null>
  t: (key: string, params?: Record<string, unknown>) => string
  notifyError(message: string): void
}

/**
 * The file changed under this tab, and what the user has said about it.
 *
 * Kept on the tab rather than in a table beside it: the question is about this
 * document, and a closed tab's conflict has no subject. The bytes are part of
 * the record because they ARE the question — "the file holds these, not yours" —
 * and an answer belongs to the bytes it was given about: a further external
 * write is a question the user has not answered, so it is asked rather than
 * covered by the earlier answer.
 */
export interface ExternalConflict {
  /** What was found at the tab's path where its own text was expected. */
  disk: string
  /**
   * `pending` — the user has been told, and has not answered: a save refuses,
   * and does not ask again.
   * `keep-local` — the user has answered that their text is what belongs on the
   * file: the write goes through and replaces the disk version. Two routes set
   * it, and they are one answer — the user's own save asked a second time,
   * having been told, and the conflict prompt's "Keep local" (`keepLocal`).
   */
  answer: 'pending' | 'keep-local'
}

/** One open document, as these checks need it. Structural on purpose: the tab
 *  store's `OpenTab` satisfies it, and nothing here imports the store. */
export interface PreconditionTab {
  /** The file this tab is written to, or null while it has none. */
  path: string | null
  /** The bytes this tab last read or last wrote — what the disk is compared
   *  against, and the tab's own record of what is on the file. */
  savedContent: string
  /** True while the tab is a placeholder waiting on its first read. */
  loading?: boolean
  /** Absent means "nothing outstanding about the file". Optional so fixtures
   *  built beside the store need not name it. */
  externalConflict?: ExternalConflict | null
}

/** What the caller knows about the save that is asking. */
export interface WriteConditions {
  /**
   * This save is the one that picked the path (Save-As on an untitled tab).
   * There are no "bytes this tab last read or wrote" at it to compare against,
   * and the dialog that chose the name already asked about replacing what is
   * there — refusing here would be a second question about a decision the user
   * has just made.
   */
  pickedPath?: boolean
  /**
   * The user asked for this save. Ctrl+S only — see `TabSaveOptions.userAsked`
   * for why the close path's rescue may not set it.
   */
  userAsked?: boolean
}

export function createWritePreconditions(deps: WritePreconditionDeps) {
  const { files, vault, t, notifyError } = deps

  /**
   * Whether the editor can vouch for the text a save would write.
   *
   * A document the rendered model could not load must not be written. The flush
   * before a save published nothing for it (`editorPersistence` refuses while
   * the model is refused), so the tab still holds exactly the text that failed —
   * and writing that is writing a document the editor could not read, on the
   * strength of a model that holds something else. Refused, and said out loud: a
   * save that did not happen must not come back as one. Returning false is what
   * blocks the callers that act on the answer — the autosave, the close, the
   * vault switch — instead of letting them treat the file as safe.
   *
   * Text the source pane authored is the one thing here that is the user's own
   * writing over this file rather than the model's output, so it is theirs to
   * save. Refusing it would strand the edits they typed to fix the document: the
   * tab stays dirty, and a dirty tab whose save fails cannot be closed or closed
   * over (`tab-lifecycle` keeps it; `app-lifecycle` refuses to close the window)
   * — the user would have to make the document render again to be allowed to put
   * their own text on disk.
   */
  function documentIsWritable(content: string): boolean {
    if (!isRefusedDocument(content)) return true
    if (isSourceAuthored(content)) return true
    notifyError(t('tabs.saveBlockedUnrenderable'))
    return false
  }

  /**
   * Return the observed bytes to check again at commit, or null to refuse.
   *
   * `savedContent` is what this tab last READ or last WROTE, so the comparison
   * answers exactly one question: has anybody else touched this file since? The
   * answer decides, and the user is told once per question:
   *
   *   - the file holds this tab's bytes → write, and any earlier conflict is
   *     over (the other program undid its change, or the user did);
   *   - it holds others', and the user has not been told → refuse, remember what
   *     was found, and say so;
   *   - it holds others', the user has been told, and this is a save they asked
   *     for → the answer is theirs: write over the file's version;
   *   - it holds others', the user has been told, and this save is not theirs
   *     (a timer, a flush, a close) → refuse, and do not ask again. A recorded
   *     "Keep local" outranks that: the user answered the prompt, so any save
   *     carries their answer.
   *
   * A failed read is unknown disk state, never permission to overwrite. Even
   * absence must not silently resurrect a deleted file before its watcher event
   * arrives. Explicit Save-As is separate consent; ordinary saves retain their
   * buffer and conflict evidence until the file can be checked or detached.
   */
  async function fileHoldsOurBytes(
    tab: PreconditionTab,
    vaultAtStart: string,
    path: string,
    conds: WriteConditions = {},
  ): Promise<{ expectedContent?: string } | null> {
    if (conds.pickedPath) return {}
    // A tab whose first read has not landed holds an empty placeholder wearing
    // the note's path, so it has no text of its own to write and the file's text
    // is not it: saving here (Ctrl+S before the note arrives) would put the
    // placeholder over the note. Nothing is said or recorded, because nothing
    // has been decided — the read that is still running settles it, and a
    // keystroke in the meantime is `commitRead`'s to rescue, which announces
    // itself.
    if (tab.loading) return null
    let disk: string
    try {
      disk = await files.read(vaultAtStart, path)
    } catch {
      if (vault.value === vaultAtStart && tab.path === path) {
        notifyError(t('tabs.saveBlockedUnreadable', { path }))
      }
      return null
    }
    // The read was an await. The caller checks the vault before it starts the
    // write for the same reason; this one covers the window the read adds.
    if (vault.value !== vaultAtStart || tab.path !== path) return null
    if (disk === tab.savedContent) {
      tab.externalConflict = null
      return { expectedContent: disk }
    }
    const known = tab.externalConflict
    if (known && known.disk === disk) {
      if (known.answer === 'keep-local') return { expectedContent: disk }
      if (conds.userAsked) {
        known.answer = 'keep-local'
        return { expectedContent: disk }
      }
      return null
    }
    tab.externalConflict = { disk, answer: 'pending' }
    // The reason is the point: a sentence that only said "not saved" would send
    // the user back to a save that refuses again for a cause they cannot see.
    notifyError(t('tabs.saveBlockedExternalChange', { path }))
    return null
  }

  /** The tab's bytes are the file's again: nothing about it is outstanding. The
   *  landed write replaces the disk version, so the question is spent. */
  function clearConflict(tab: PreconditionTab): void {
    tab.externalConflict = null
  }

  /**
   * The conflict prompt's "Keep local": the user has seen what the file holds and
   * decided their own text is what belongs there, so a save may replace it.
   *
   * The bytes are read NOW, at the answer, rather than carried over from the
   * read that raised the prompt. The answer is about the file as it stands, and
   * that is exactly what `fileHoldsOurBytes` compares it against later: a write
   * that lands after the answer is a question the user has not answered, and it
   * gets asked. A read that fails records nothing — there is no file to have
   * answered about, and the next save decides from scratch.
   */
  async function keepLocal(tab: PreconditionTab): Promise<void> {
    const path = tab.path
    const vaultPath = vault.value
    if (!path || !vaultPath) return
    let disk: string
    try {
      disk = await files.read(vaultPath, path)
    } catch {
      return
    }
    tab.externalConflict = { disk, answer: 'keep-local' }
  }

  return { documentIsWritable, fileHoldsOurBytes, clearConflict, keepLocal }
}

export type WritePreconditions = ReturnType<typeof createWritePreconditions>
