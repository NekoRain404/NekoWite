/**
 * Claiming a file name for a new note, not just choosing one.
 *
 * "New from template" lists the vault, picks the first free `<base>.md` /
 * `<base>-<n>.md`, and writes it. Between the listing and the write another
 * writer - a second instance, a sync client, the user in Explorer - can put a
 * file under that exact name, and `fsService.write` replaces what it finds. The
 * "new" note landed on someone else's note and destroyed it.
 *
 * `platform/createNewFile` asks the backend for the atomic version, so the name
 * check and the write are one step and "taken" comes back as an ordinary
 * outcome. This module turns that outcome into the retry the user expects: the
 * next candidate in the `nextAvailableName` sequence, a bounded number of times
 * (each further attempt means a collision inside the same instant), and then an
 * honest failure the caller reports - never a write on top of an existing file.
 */

import { createNewFile } from '../platform/createNewFile'
import { fsService } from '../platform/gateways/fs'
import { nextAvailableName } from './noteTemplates'

/** Candidate names one "new note" action may try before giving up. Every retry
 *  past the first is a name claimed by another writer inside the same instant,
 *  so reaching this bound means the vault is being written to continuously -
 *  better to tell the user than to spin. */
export const MAX_CREATE_ATTEMPTS = 5

export interface CreatedNote {
  /** Absolute path of the note that was created. */
  path: string
  /** The file name it was created under (the last path segment). */
  fileName: string
}

/**
 * Creates `content` under the first free `<base>.md` / `<base>-<n>.md` name,
 * avoiding every name in `existing`.
 *
 * Returns null when all `MAX_CREATE_ATTEMPTS` names were claimed by other
 * writers meanwhile: nothing was written and the caller reports it. Real
 * failures (permissions, unwritable vault) propagate from the write.
 */
export async function createNoteWithFreeName(
  vault: string,
  base: string,
  content: string,
  existing: Iterable<string>,
): Promise<CreatedNote | null> {
  const taken = new Set(existing)
  const root = vault.replace(/\/+$/, '')
  for (let attempt = 0; attempt < MAX_CREATE_ATTEMPTS; attempt += 1) {
    const fileName = nextAvailableName(base, taken)
    const path = `${root}/${fileName}`
    const outcome = await createNewFile(vault, path, content)
    if (outcome === 'created') return { path, fileName }
    if (outcome === 'unsupported') {
      // No create-only command behind this build (browser demo, older backend).
      // Check-then-write is all that is available, so at worst this replaces a
      // file that appeared in the same instant - what the app did before.
      await fsService.write(vault, path, content)
      return { path, fileName }
    }
    // "exists": another writer claimed this name first. Remember it so the next
    // iteration picks the following candidate, and leave their file alone.
    taken.add(fileName)
  }
  return null
}
