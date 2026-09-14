/** Reasons already reported to the user in this window. A blocked feature is
 *  worth explaining once; a toast on every Tab press is noise. Cleared when
 *  the AI switch or write policy changes so a later block is announced again. */
const announcedBlocks = new Set<string>()

export function announceAiBlockOnce(reason: string, notify: () => void): void {
  if (announcedBlocks.has(reason)) return
  announcedBlocks.add(reason)
  notify()
}

export function resetAiBlockAnnouncements(): void {
  announcedBlocks.clear()
}
