/**
 * The three tree actions that change disk state: create, rename and delete.
 *
 * They are COMMANDS in the §13.4 sense — each takes its target and its
 * dependencies explicitly and answers with a value. None of them throws: an
 * expected failure comes back as a discriminated union so the UI layer can word
 * its own message (§13.9), and a caller never has to guess whether a rejection
 * means "the name was refused" or "the disk refused".
 *
 * The move itself is NOT reimplemented here. `rename` drives the shared
 * `services/noteMoveFlow`, which owns the `noteSelfWrite(from/to)` and
 * `beginMove`/`endMove` claims that stop the app's own move being read back as
 * an external change; the note pair-delete is the shared `services/noteDelete`.
 * A second implementation of either would drift from that bookkeeping and
 * detach the open tab.
 *
 * Dependencies arrive as an explicit port object (the `createTabSave` /
 * `createVaultIndexCoordinator` shape used across the app), so this module
 * never constructs a Pinia store or reaches for Tauri itself.
 */

import { deleteNoteWithAssets } from '../../../services/noteDelete'
import { dirName, joinPath } from '../../../services/paths'

/** The three name rules the tree has always applied to a new entry name. */
export type VaultNameError = 'name-required' | 'name-slash' | 'name-dot'

/**
 * Check a candidate name (the caller trims it first), returning why it is
 * refused or null when it may be used.
 *
 * Deliberately NOT `services/noteActions.noteRenameNameError`: that helper also
 * refuses a backslash, which the tree never did. Reusing it here would turn a
 * name the tree used to accept — a legal file name on Linux — into a refusal,
 * and a move must not change which names are legal.
 */
export function validateEntryName(name: string): VaultNameError | null {
  if (!name) return 'name-required'
  if (name.includes('/')) return 'name-slash'
  if (name.startsWith('.')) return 'name-dot'
  return null
}

/** An action that reached the disk and did not complete. `cause` is carried for
 *  diagnostics only — the UI shows its own wording, never this value. */
export interface VaultActionFailure {
  kind: 'io'
  cause: unknown
}

export type VaultActionResult =
  | { ok: true; path: string }
  | { ok: false; error: VaultActionFailure }

/**
 * Deleting a note is a PAIR — the note plus its sibling `<name>_assets` folder —
 * and the second half can fail on its own. That is a partial success, not a
 * failure: the note the user asked to delete is gone, and calling the whole
 * action failed would invite a second attempt and a second trash entry for the
 * note. `assetsFailed` is the "the images stayed behind" signal, which the
 * caller reports separately.
 */
export type VaultDeleteResult =
  | { ok: true; assetsFailed: boolean }
  | { ok: false; error: VaultActionFailure }

/** The disk half of the flows. */
export interface VaultFileIo {
  /** Create or overwrite a file. */
  write(vault: string, path: string, content: string): Promise<void>
  createDir(vault: string, path: string): Promise<void>
  /** Move a path into the trash; resolves with the trash entry's path. */
  deleteFile(vault: string, path: string): Promise<string>
  /** True when the path exists. Must not throw for a missing path. */
  exists(vault: string, path: string): Promise<boolean>
}

/** The tab bookkeeping a delete performs. Wired to the tabs store by the
 *  caller; injected so the flow runs without Pinia in a test. */
export interface VaultDeleteTabPort {
  /** The id of the tab open on exactly `path`, or null. */
  tabIdAt(path: string): string | null
  /** The store's own delete-a-file flow: it trashes the file and drops the tab
   *  with the same bookkeeping a manual close uses. */
  deleteTabFile(tabId: string): Promise<void>
  /** Forget every tab inside `path` — that subtree no longer exists. */
  forgetTabsUnder(path: string): void
}

export interface VaultFileActionPorts {
  io: VaultFileIo
  /** The shared move flow — `services/noteMoveFlow.moveOrRepair`, which also
   *  repairs the tabs when a move fails after its rename landed. */
  move(vault: string, from: string, to: string, isDir: boolean): Promise<void>
  tabs: VaultDeleteTabPort
  /** True when the tree row at `path` is a folder (the vault root counts). */
  isDir(path: string): boolean
}

export interface VaultFileActions {
  create(
    vault: string,
    parentPath: string,
    name: string,
    kind: 'file' | 'dir',
  ): Promise<VaultActionResult>
  /**
   * Rename `from` to `name` inside its own directory. A rename that resolves to
   * the path it already has is a no-op success — the disk is not touched.
   */
  rename(vault: string, from: string, name: string, isDir: boolean): Promise<VaultActionResult>
  /** Delete `path`: the open tab's file, a folder subtree, or a note with its
   *  `_assets` folder. */
  delete(vault: string, path: string): Promise<VaultDeleteResult>
}

/** Wire the flows to their dependencies. See the module header for why the
 *  ports are explicit rather than imported here. */
export function createVaultFileActions(ports: VaultFileActionPorts): VaultFileActions {
  /** Create an empty note or a directory under `parentPath`. */
  async function create(
    vault: string,
    parentPath: string,
    name: string,
    kind: 'file' | 'dir',
  ): Promise<VaultActionResult> {
    // Joined with a plain `/`, exactly as the inline editor this came out of
    // did. NOT `services/paths.joinPath`, which matches the separator style
    // already present in the parent path: on Linux — the target platform — the
    // two agree, while on Windows the native `\\?\C:\...` spelling would come
    // back mixed. Preserved verbatim because this change is a move; the Windows
    // spelling is a separate fix.
    const path = `${parentPath}/${name}`
    try {
      if (kind === 'file') await ports.io.write(vault, path, '')
      else await ports.io.createDir(vault, path)
      return { ok: true, path }
    } catch (cause) {
      return { ok: false, error: { kind: 'io', cause } }
    }
  }

  async function rename(
    vault: string,
    from: string,
    name: string,
    isDir: boolean,
  ): Promise<VaultActionResult> {
    const to = joinPath(dirName(from), name)
    if (to === from) return { ok: true, path: from }
    try {
      await ports.move(vault, from, to, isDir)
      return { ok: true, path: to }
    } catch (cause) {
      return { ok: false, error: { kind: 'io', cause } }
    }
  }

  /**
   * Delete a tree row.
   *
   * The three branches are ordered, and the order matters: a tab open on the
   * exact path goes through the store's own file-delete (it must also close the
   * tab, and only the store knows how). A folder is a plain subtree delete —
   * it carries everything below it, so a nested `_assets` folder needs no
   * special handling. Anything else is a note, which owns a sibling
   * `<basename>_assets` folder that has to go to the trash with it (see
   * `services/noteDelete`).
   */
  async function deleteEntry(vault: string, path: string): Promise<VaultDeleteResult> {
    const tabId = ports.tabs.tabIdAt(path)
    try {
      if (tabId !== null) {
        await ports.tabs.deleteTabFile(tabId)
        return { ok: true, assetsFailed: false }
      }
      if (ports.isDir(path)) {
        await ports.io.deleteFile(vault, path)
        ports.tabs.forgetTabsUnder(path)
        return { ok: true, assetsFailed: false }
      }
      // The same pair-delete the store performs for an open note: a note with
      // no tab still owns a `<basename>_assets` folder, and leaving that behind
      // kept its images invisible and unreclaimable forever.
      const del = await deleteNoteWithAssets(
        {
          deleteFile: (v, p) => ports.io.deleteFile(v, p),
          exists: (v, p) => ports.io.exists(v, p),
        },
        vault,
        path,
      )
      ports.tabs.forgetTabsUnder(path)
      return { ok: true, assetsFailed: del.assetsFailed }
    } catch (cause) {
      return { ok: false, error: { kind: 'io', cause } }
    }
  }

  return { create, rename, delete: deleteEntry }
}
