/**
 * The attachment badge for the open vault: how many images its attachment tree
 * holds, published to the view layer.
 *
 * The count is a recursive walk of `attachments/`, so it is both debounced (a
 * paste writes several files, and each one would otherwise start its own walk)
 * and generation-guarded: the walk spans several awaits, and a count that
 * belongs to the vault that was left must never land in the new vault's badge.
 */

import type { FileEntry } from '../../../platform/gateways/contracts'
import { ATTACHMENTS_DIR, extensionFromFileName } from '../../attachments'

/** Coalesce a burst of attachment writes into one walk of the tree. */
const ATTACHMENT_REFRESH_DEBOUNCE_MS = 200

export interface VaultAttachmentBadgeDeps {
  /** List one directory (the walk recurses into the month folders). */
  list(vault: string, dir: string): Promise<FileEntry[]>
  /** The vault session generation that is current right now. */
  generation(): number
  /** Publish the badge count. */
  publish(count: number): void
}

export interface VaultAttachmentBadge {
  /** Schedule a debounced refresh after an fs change touched the vault. */
  schedule(vault: string, generation: number): void
  /** Count now and publish while `generation` is still the current one. */
  refresh(vault: string, generation: number): Promise<void>
  /** Cancel a pending refresh (vault switch). */
  cancel(): void
}

export function createVaultAttachmentBadge(deps: VaultAttachmentBadgeDeps): VaultAttachmentBadge {
  let refreshTimer: ReturnType<typeof setTimeout> | null = null

  async function countImages(vault: string, dir = ATTACHMENTS_DIR): Promise<number> {
    let entries: FileEntry[]
    try {
      entries = await deps.list(vault, dir)
    } catch {
      return 0
    }
    let total = 0
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue
      if (entry.is_dir) {
        total += await countImages(vault, entry.path)
      } else if (extensionFromFileName(entry.name)) {
        total += 1
      }
    }
    return total
  }

  /** Publish the badge count for `vault`, but only while `generation` is still
   *  the current vault generation: the read spans several awaits, so a switch
   *  that lands inside it must not write the previous vault's number into the
   *  new badge. */
  async function refresh(vault: string, generation: number): Promise<void> {
    // Images live one level deeper than `attachments/` — in `attachments/<YYYY-MM>/`
    // — so counting the top-level entries reported MONTH FOLDERS while the
    // attachments panel listed IMAGES. The badge and the panel next to it
    // disagreed by construction ("1" beside a panel showing 12 images). Count
    // the images, recursively, the way the panel does.
    const count = await countImages(vault)
    if (generation === deps.generation()) deps.publish(count)
  }

  function schedule(vault: string, generation: number): void {
    if (refreshTimer) clearTimeout(refreshTimer)
    refreshTimer = setTimeout(() => {
      refreshTimer = null
      void refresh(vault, generation)
    }, ATTACHMENT_REFRESH_DEBOUNCE_MS)
  }

  function cancel(): void {
    if (refreshTimer) {
      clearTimeout(refreshTimer)
      refreshTimer = null
    }
  }

  return { schedule, refresh, cancel }
}
