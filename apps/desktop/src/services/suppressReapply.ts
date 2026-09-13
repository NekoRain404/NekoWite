// Consume-once guard for save-time rewrites (I2): tabs.ts arms this for the tab
// it just saved, before syncing tab.content with the onSave-rewritten text, and
// that tab's content watcher consumes it so the editor is NOT re-opened with the
// rewritten content (which would replace the user's live text and reset
// caret/scroll). The model syncs; the live editor content stays untouched until
// the next user edit.
//
// The arm is scoped to ONE TAB, not to the module: a save is not always the
// active tab's — the autosave timer, `flushDirty` (vault switch / window close)
// and `closeTab` all save tabs in the background. A module-wide flag armed by
// such a save was consumed by whatever changed content next, which in practice is
// the tab the user just switched TO: its re-apply was skipped, so the editor kept
// showing the previous note's text for the new note, and the next keystroke
// published that stale text into the new tab and autosaved it over the new note's
// file. Only the saved tab can consume its own arm, and switching documents drops
// the arms of every other tab (see `pruneSuppressReapply`).
/**
 * How long an arm stays valid (ms).
 *
 * The arm is consumed by the very next content change, which arrives within the
 * same tick — the save syncs `tab.content` right after arming. An arm that
 * survives much longer than that has lost its partner: the content change it was
 * waiting for never came, so whatever changes content NEXT gets swallowed
 * instead. That is a real edit — an external program rewriting the file, a
 * conflict resolution reloading it — and swallowing it leaves the editor showing
 * text that is no longer on disk, which the next autosave then writes back over
 * the newer version. A short window keeps the guard's promise (the save's own
 * echo is never re-applied) without letting it eat an unrelated reload.
 */
export const SUPPRESS_REAPPLY_TTL_MS = 2000

const armed = new Map<string, number>()

/** Arm the guard for `tabId`, the tab whose save-time rewrite was just synced. */
export function armSuppressReapply(tabId: string): void {
  armed.set(tabId, Date.now())
}

/** True while `tabId` has an unconsumed, still-valid arm. */
export function shouldSuppressReapply(tabId: string): boolean {
  const at = armed.get(tabId)
  if (at === undefined) return false
  if (Date.now() - at > SUPPRESS_REAPPLY_TTL_MS) {
    armed.delete(tabId)
    return false
  }
  return true
}

/** Consume `tabId`'s arm; true when it was armed and still valid. */
export function consumeSuppressReapply(tabId: string): boolean {
  const at = armed.get(tabId)
  if (at === undefined) return false
  armed.delete(tabId)
  return Date.now() - at <= SUPPRESS_REAPPLY_TTL_MS
}

/**
 * Drop every arm that does not belong to `activeTabId` (`null` drops all).
 *
 * Called when the active document changes. Only the active tab's content watcher
 * runs, so an arm left on any other tab can never be consumed — it would just sit
 * there until it swallowed a later, unrelated content change.
 */
export function pruneSuppressReapply(activeTabId: string | null): void {
  for (const id of [...armed.keys()]) {
    if (id !== activeTabId) armed.delete(id)
  }
}