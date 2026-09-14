/**
 * Which modal dialog is on top.
 *
 * Several dialogs listen for Escape on `window`/`document` (the settings panel,
 * the command palette, the rename prompt, ...). Keydown listeners on the *same*
 * target form a chain: `stopPropagation()` cannot stop the listeners that are
 * already queued for that node, so one Escape press closed every open dialog at
 * once. Each listener therefore has to decide for itself whether it is allowed
 * to act, and this module is that decision: only the dialog the user is
 * actually looking at responds.
 *
 * "On top" is the claim order: the most recently claimed still-open dialog
 * wins. That matches what the user sees for every path that opens a dialog
 * (open order *is* raise order), and it is the only tie-break that does not
 * depend on how the renderer happens to serialise two dialogs that appear in
 * the same tick — Vue flushes a parent's `onMounted` after its children's, so
 * a DOM-order rule would silently invert for a nested modal.
 */

const openStops: symbol[] = []

export const modalStack = {
  /**
   * Claim the top of the stack. Returns the token to pass back to
   * {@link isTopModal} and {@link releaseModal}. `label` is only for debugging.
   */
  claimModal(label: string): symbol {
    const token = Symbol(label)
    openStops.push(token)
    return token
  },

  /** True when `token` is the modal the user is currently looking at. */
  isTopModal(token: symbol | null | undefined): boolean {
    if (!token) return false
    return openStops.length > 0 && openStops[openStops.length - 1] === token
  },

  /** Give up a slot (idempotent, so a close-then-unmount cannot pop twice). */
  releaseModal(token: symbol | null | undefined): void {
    if (!token) return
    const idx = openStops.indexOf(token)
    if (idx >= 0) openStops.splice(idx, 1)
  },

  /** Test-only: forget every claimed slot so cases cannot leak into each other. */
  resetModalStack(): void {
    openStops.length = 0
  },
}
