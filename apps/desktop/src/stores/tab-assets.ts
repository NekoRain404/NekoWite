/**
 * The staged-asset half of a note's first save: an untitled document's pasted
 * images live in the vault-wide `.tmp/` directory until the note has a path of
 * its own, and this is what moves them into that path's assets directory and
 * rewrites the body to reference them relatively.
 *
 * Split out of `tab-save.ts` for the budget (§13.1), and because it is a
 * vertical slice with its own failure policy: relocation is best-effort. A
 * failure leaves the staged paths in place for a later retry rather than
 * blocking the save — the text is what the user cannot retype, so it goes to
 * disk whether or not its images could follow.
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
   */
  async function relocate(tab: OpenTab, vaultPath: string, notePath: string): Promise<boolean> {
    if (tab.pendingAssetPaths.length === 0) return false
    const assetsDir = assetsDirForNote(notePath, vaultPath)
    if (!assetsDir || assetsDir === '.tmp') return false
    const moves = moveAttachments('.tmp', assetsDir, tab.pendingAssetPaths)
    try {
      await files.createDir(vaultPath, assetsDir).catch(() => undefined)
      for (const m of moves) {
        await files.renameEntry(vaultPath, m.from, m.to)
      }
      const next = rewireTempRefsInContent(tab.content, moves, notePath, vaultPath)
      tab.pendingAssetPaths = []
      if (next !== tab.content) {
        tab.content = next
        return true
      }
      return false
    } catch {
      notifyError(t('tabs.saveAttachmentFailed'))
      return false
    }
  }

  return { relocate }
}

export type TabAssets = ReturnType<typeof createTabAssets>
