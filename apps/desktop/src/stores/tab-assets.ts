/**
 * The staged-asset half of a note's first save: an untitled document's pasted
 * images live in the vault-wide `.tmp/` directory until the note has a path of
 * its own, and this is what moves them into that path's assets directory and
 * rewrites the body to reference them relatively.
 *
 * Split out of `tab-save.ts` for the budget (§13.1), and because it is a
 * vertical slice with its own failure policy: relocation is best-effort, and it
 * is best-effort PER PAIR. A pair that fails is left alone — its file where it
 * is, its reference naming it there — rather than blocking the save, because the
 * text is what the user cannot retype and it goes to disk whether or not its
 * images could follow.
 *
 * "Left alone for a later attempt" is what the loop had to be built for and was
 * not (audit L07): it assumed it was starting from nothing, so a second attempt
 * began at the pair that HAD moved, failed on a source that no longer existed,
 * and so never reached the pair that had not — which is how one failed move
 * turned into a note that referenced two `.tmp` paths, one of them moved, with
 * nothing left that would ever repair it. Now each pair is finished on its own
 * and only the pairs that did not move stay pending, so an attempt starts from
 * what is actually outstanding.
 *
 * The two steps of a pair are adjacent on purpose: from the rename resolving to
 * the reference rewrite there is no await, so no keystroke and no second save
 * can land between them, and a pair is never left half-done. A moved file under
 * an old reference is the permanently broken image; a reference to a file that
 * never arrived is the other one.
 *
 * It edits `tab.content` in place, which is why it takes the tab rather than a
 * string: the rewrite has to land on the same object the editor's publish
 * writes to, or the next keystroke would put the `.tmp/` paths back.
 */

import {
  assetsDirForNote,
  moveAttachments,
  rewireTempRefsInContent,
} from '../services/rename-asset'
import type { OpenTab } from './tabs'

/** The two fs operations the relocation performs. */
export interface TabAssetFilePort {
  createDir(vault: string, path: string): Promise<string>
  renameEntry(vault: string, from: string, to: string): Promise<string>
}

export interface TabAssetDeps {
  files: TabAssetFilePort
  t: (key: string, params?: Record<string, unknown>) => string
  notifyError(message: string): void
}

export function createTabAssets(deps: TabAssetDeps) {
  const { files, t, notifyError } = deps

  /**
   * Move the tab's staged assets into `notePath`'s assets dir and rewire the
   * body. Returns true when the content was rewritten.
   *
   * The rewire runs against the tab's LIVE content — the source of user typing
   * — rather than a snapshot captured before the awaits, so a keystroke that
   * landed during the relocation cannot be clobbered by the rewrite.
   *
   * Idempotent by construction: `pendingAssetPaths` is rebuilt here to hold
   * exactly the pairs whose file is still staged, so a pair whose file has
   * moved leaves the list in the same pass that moved it and no later attempt
   * can start from a source that is no longer there. A second call with every
   * file moved therefore finds an empty list and does not touch the filesystem
   * at all, and one that still has work re-attempts only that work.
   */
  async function relocate(tab: OpenTab, vaultPath: string, notePath: string): Promise<boolean> {
    if (tab.pendingAssetPaths.length === 0) return false
    const assetsDir = assetsDirForNote(notePath, vaultPath)
    if (!assetsDir || assetsDir === '.tmp') return false
    const moves = moveAttachments('.tmp', assetsDir, tab.pendingAssetPaths)
    // Best-effort: a backend whose rename creates the parent does not need it,
    // and the directory existing is not an error worth stopping a save for.
    await files.createDir(vaultPath, assetsDir).catch(() => undefined)

    const stillStaged: string[] = []
    let rewritten = false
    for (const m of moves) {
      try {
        await files.renameEntry(vaultPath, m.from, m.to)
      } catch {
        // This pair only. The ones behind it in the list are separate files
        // with separate destinations, and one of them failing used to cancel
        // the rewrite of every pair that had already moved.
        stillStaged.push(m.from)
        continue
      }
      const next = rewireTempRefsInContent(tab.content, [m], notePath, vaultPath)
      if (next !== tab.content) {
        tab.content = next
        rewritten = true
      }
    }
    tab.pendingAssetPaths = stillStaged
    // Once per save, not once per image: ten staged files that all failed is one
    // thing that happened to the user.
    if (stillStaged.length > 0) notifyError(t('tabs.saveAttachmentFailed'))
    return rewritten
  }

  return { relocate }
}

export type TabAssets = ReturnType<typeof createTabAssets>
