/**
 * The note list's inline rename: the edit in progress, the rules a name is
 * judged by, and the move commit.
 *
 * The vault and the index refresh arrive as parameters, so the editor can be
 * driven without a mounted component. The move itself is not reimplemented here:
 * it is the shared `services/noteMoveFlow`, which owns the self-write/move
 * claims and the tab repair that stop the app's own move being read back as an
 * external change.
 */

import { computed, ref, type ComputedRef, type Ref } from 'vue'
import { fsService } from '../../../platform/gateways/fs'
import { t } from '../../../i18n'
import { baseName } from '../../../services/paths'
import {
  isCaseOnlyRename,
  noteRenameNameError,
  noteRenameTargetPath,
} from '../../../services/note-actions'
import { moveOrRepair } from '../../../services/note-move-flow'
import { notifyError } from '../../../services/errors'
import { isComposingKey } from '../../../services/key-guard'

export interface UseNoteRenameOptions {
  /** The vault the target note lives in — the folder the move runs inside.
   *  Null when no vault is open, which leaves the rename nowhere to move to. */
  vault: () => string | null
  /** Re-run the vault index once the note has moved; the note list is a mirror
   *  of that index (see the caller's `refreshNoteIndex`). */
  refreshIndex: () => Promise<void>
}

export interface NoteRenameModel {
  /**
   * The note whose name is being edited in place, and what has been typed.
   *
   * Bound by PATH, never by the active tab: the editor is opened from the card the
   * user right-clicked, which is usually a note that is not open at all.
   */
  target: ComputedRef<{ path: string; name: string } | null>
  name: Ref<string>
  error: ComputedRef<string>
  start(path: string): void
  cancel(): void
  /** Drop the editor and its error because the vault it belonged to is gone —
   *  unlike `cancel` this is NOT gated on a move being in flight. */
  resetForVault(): void
  onKeydown(e: KeyboardEvent): void
  confirm(): Promise<void>
}

export function useNoteRename(options: UseNoteRenameOptions): NoteRenameModel {
  const target = ref<{ path: string; name: string } | null>(null)
  const name = ref('')
  const error = ref('')
  let renameInFlight = false

  function start(path: string): void {
    const basename = baseName(path)
    target.value = { path, name: basename }
    name.value = basename
    error.value = ''
  }

  function cancel(): void {
    // A rename already on its way may not be torn down from under itself; its own
    // completion clears the editor.
    if (renameInFlight) return
    target.value = null
    error.value = ''
  }

  function resetForVault(): void {
    target.value = null
    error.value = ''
  }

  /** Enter commits and Escape cancels — but not while an IME is composing: there
   *  Enter accepts the highlighted candidate and Escape dismisses the candidate
   *  list, and treating those as app actions renames the note to raw pinyin or
   *  throws the typed name away. */
  function onKeydown(e: KeyboardEvent): void {
    if (isComposingKey(e)) return
    if (e.key === 'Enter') {
      e.preventDefault()
      void confirm()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      cancel()
    }
  }

  /** True when `path` already exists. A rejection is the answer "no": the gateway
   *  reports a missing path by failing (`stat`), which is how the delete flow
   *  probes for a note's `_assets` folder too. */
  async function notePathExists(vault: string, path: string): Promise<boolean> {
    try {
      await fsService.stat(vault, path)
      return true
    } catch {
      return false
    }
  }

  async function confirm(): Promise<void> {
    const current = target.value
    if (!current || renameInFlight) return
    const invalid = noteRenameNameError(name.value)
    if (invalid) {
      error.value = t(invalid)
      return
    }
    const to = noteRenameTargetPath(current.path, name.value)
    // The same path is not a move. This must stay a plain comparison: a case-only
    // rename (`note.md` → `Note.md`) IS a real rename the backend runs, and
    // `samePath` would fold it away as "no change".
    if (to === current.path) {
      cancel()
      return
    }
    const vault = options.vault()
    if (!vault) return
    renameInFlight = true
    try {
      // A name that is already taken is refused before anything moves, so a clash
      // cannot leave the note half-renamed — EXCEPT for a case-only rename, whose
      // target IS the source file on a case-insensitive filesystem.
      if (!isCaseOnlyRename(current.path, to) && (await notePathExists(vault, to))) {
        error.value = t('tree.conflict')
        return
      }
      // The shared move: flush pending edits, arm the self-write/move claims,
      // carry `<basename>_assets` and the note-relative references, retarget the
      // open tabs, and repair them if the move fails after its rename landed.
      await moveOrRepair(vault, current.path, to, false)
    } catch {
      notifyError(t('filetree.renameFailed'))
      // The editor stays open on the note it failed to rename: the name is a
      // correction away from working, and closing it would hide which note failed.
      return
    } finally {
      renameInFlight = false
    }
    target.value = null
    error.value = ''
    await options.refreshIndex()
  }

  return {
    target: computed(() => target.value),
    name,
    error: computed(() => error.value),
    start,
    cancel,
    resetForVault,
    onKeydown,
    confirm,
  }
}
