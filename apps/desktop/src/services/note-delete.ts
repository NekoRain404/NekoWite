/**
 * Deleting a note takes its own resource folder with it.
 *
 * A note's pasted images live in a sibling `<basename>_assets/` directory
 * (see `renameAsset.assetsDirForNote`). Deleting the note moved only the `.md`
 * file, so the folder stayed behind forever: nothing in the app lists it (the
 * Attachments panel walks the vault-level `attachments/` tree only), nothing
 * references it, and the disk space was never reclaimed. Deleting a note looked
 * like it freed the images and did not.
 *
 * The pair is deleted as one gesture, into the trash, in this order:
 *
 *   1. the note (if this fails, nothing has changed and the caller reports a
 *      plain failure - the images are still referenced by a note that still
 *      exists);
 *   2. then its `_assets` folder.
 *
 * A failure in step 2 is reported as a PARTIAL result rather than a failure:
 * the note is gone, which is the thing the user asked for, and claiming the
 * whole action failed would be a lie that invites a second attempt (and a
 * second trash entry for the note). The caller says what was left behind.
 *
 * A folder delete carries its contents, so deleting a folder needs none of
 * this - the backend already trashes the `_assets` directories nested inside
 * it.
 *
 * `io` is injected so the whole sequence is testable without Tauri, the shape
 * `noteMove` and `externalDocSync` already use.
 */

import { baseName, dirName, joinPath } from './paths'

export interface NoteDeleteIo {
  /** Move a path into the trash. Returns the trash entry's path. */
  deleteFile(vault: string, path: string): Promise<string>
  /** True when the path exists. Must not throw for a missing path. */
  exists(vault: string, path: string): Promise<boolean>
}

export interface NoteDeleteResult {
  /** True when the note's `_assets` folder existed and went to the trash. */
  assetsMoved: boolean
  /** True when the `_assets` folder could not be checked or moved. */
  assetsFailed: boolean
}

/** Adapt stat's missing-path error without hiding permission or IO failures. */
export async function noteAssetDirectoryExists(
  files: { stat(vault: string, path: string): Promise<unknown> },
  vault: string,
  path: string,
): Promise<boolean> {
  try {
    await files.stat(vault, path)
    return true
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    // Match the requested target, not a substring a filename could contain.
    const missing = `could not stat ${path}: no such file or folder`
    if (message === missing || message === `${missing} (os error 2)`
      || message === `No such file in demo vault: ${path}`) return false
    throw error
  }
}

/**
 * The sibling folder that owns `notePath`'s resources, in the SAME spelling as
 * `notePath` (the backend rejects a mixed separators on Windows), or null when
 * the path has no usable name.
 *
 * Mirrors `assetsDirForNote` deliberately: that function answers in
 * vault-relative `/` form because its result is used as an attachment
 * directory and in markdown references, while this one has to go straight back
 * over IPC as an absolute path.
 */
export function siblingAssetsDir(notePath: string): string | null {
  const name = baseName(notePath)
  const dot = name.lastIndexOf('.')
  const base = dot > 0 ? name.slice(0, dot) : name
  if (!base) return null
  const dir = dirName(notePath)
  if (!dir || dir === notePath) return null
  return joinPath(dir, `${base}_assets`)
}

/** Delete `notePath` and the resource folder that belongs to it. Throws only
 *  when the NOTE could not be deleted. */
export async function deleteNoteWithAssets(
  io: NoteDeleteIo,
  vault: string,
  notePath: string,
): Promise<NoteDeleteResult> {
  const assets = siblingAssetsDir(notePath)
  // Ask about the folder BEFORE the note is trashed: afterwards the note is
  // gone and an error here would be indistinguishable from "no assets".
  let probeFailed = false
  const hadAssets = assets ? await io.exists(vault, assets).catch(() => {
    probeFailed = true
    return false
  }) : false

  await io.deleteFile(vault, notePath)

  if (!assets || !hadAssets) return { assetsMoved: false, assetsFailed: probeFailed }
  try {
    await io.deleteFile(vault, assets)
    return { assetsMoved: true, assetsFailed: false }
  } catch {
    return { assetsMoved: false, assetsFailed: true }
  }
}
