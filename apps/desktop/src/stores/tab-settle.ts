/**
 * The gate a caller goes through before it destroys a tab set: write until the
 * tab holds nothing that is not on disk.
 *
 * `saveTab` answering `true` means ONE write landed, not that the tab is saved.
 * It reads the tab's edit revision before its write and clears `dirty` only when
 * that revision has not moved and the tab still holds what it wrote (see
 * `tab-save.ts`); a keystroke during the write moves the revision, so the tab
 * stays dirty. Both callers that go on to destroy a tab set — the vault switch
 * (`app-bootstrap.ts`) and the window close (`app-lifecycle.ts`) — read that
 * answer as final and removed the only copy of the newer text.
 *
 * So the question they need answered is "is the newest revision on disk?", and
 * `dirty` is exactly that answer: false only when a landed write carried the
 * revision current at its end. Asking again is also what carries the keystroke,
 * because the next attempt flushes the panes before it writes. A tab that is gone
 * is not a failure: another close already removed it, and its own gate settled it.
 *
 * This is its own module rather than a helper beside either user: `flushDirty` is
 * the bulk form of the same gate, `tab-save.ts` owns neither the tab state nor a
 * second loop, and `tab-lifecycle.ts` sits on top of the save path — so the loop
 * lives below both and is instantiated once, in `tab-save.ts`.
 */

import type { Ref } from 'vue'
import { flushEdits } from '../services/editor-ownership'
import type { OpenTab } from './tabs'

/** How many writes one tab gets in pursuit of being settled.
 *
 *  Each attempt carries the text as of its start and clears `dirty` only if
 *  nothing was typed while it ran, so the loop ends as soon as the typing does.
 *  This bound is what stops a document that keeps changing under a close from
 *  writing round and round; reaching it leaves the tab dirty, which is the
 *  answer that loses nothing. */
const SETTLE_ATTEMPTS = 3

export function createTabSettler(deps: {
  tabs: Ref<OpenTab[]>
  saveTab(id: string): Promise<boolean>
}) {
  const { tabs, saveTab } = deps

  async function saveUntilSettled(id: string): Promise<boolean> {
    for (let attempt = 0; attempt < SETTLE_ATTEMPTS; attempt++) {
      // A failed write is not retried: the reasons a save returns false (a
      // refusal, an unwritable document, the vault changed under it) are not
      // reasons a second identical write would fare any better.
      if (!(await saveTab(id))) return false
      const tab = tabs.value.find((x) => x.id === id)
      if (!tab) return true
      if (!tab.dirty) return true
    }
    return false
  }

  /** Save every dirty tab that has a real path, each one until it is settled —
   *  used before a vault switch or an app close, where a pending autosave timer
   *  may never fire. Untitled tabs are skipped: with no path they would need a
   *  save-as dialog, which a background/bulk flush must not open — and for the
   *  same reason a tab whose file refuses the write is left to the caller that
   *  owns the moment (the close offers the copy route itself; see
   *  `app-lifecycle`).
   *
   *  The flush comes first, and it is NOT behind `dirty` — that is the whole
   *  fix. `dirty` is set at the PUBLISH, and only the rendered pane publishes at
   *  the keystroke: the source pane coalesces a burst for
   *  `SOURCE_SNAPSHOT_DEBOUNCE_MS` and marks the tab from the publish that
   *  follows (`services/code-mirror-host.ts`). So a user typing into a path'd
   *  tab in source or split mode has `dirty === false` for the length of the
   *  burst, and the loop below read that as "nothing typed here" — the destroy
   *  that came after it (`removeAllTabs`, or the process ending) took the
   *  typing with no disk holding it. It is the rule `closePlaceholder` states
   *  (`tab-close.ts`) and the one `saveTab` already applies before its own write
   *  (`tab-save.ts:207`); this gate was the one reader that asked the flag
   *  before anything had published. With nothing pending it is a no-op per
   *  pane, so an ordinary clean-vs-dirty close is unchanged.
   *
   *  HERE, inside the gate, rather than in each route that calls it: "Close
   *  all", the window close and a vault switch already share this one function,
   *  so no caller can reach the loop without the flush. A flush placed beside a
   *  caller is a rule the next caller has to remember, and that is exactly the
   *  shape that produced this bug — one reader asking the flag for itself before
   *  the gate (see `closeTab`, which now flushes on the same rule).
   *
   *  The placement also carries the untitled half of the same callers' work: the
   *  flush marks a burst into a path-less tab dirty before the untitled prompt
   *  reads `untitledDirtyTabs()`, which is what offers that text back instead of
   *  destroying it.
   *
   *  Returns false when a path'd tab could not be settled, so the caller can
   *  block the potentially-lossy action. Every tab is attempted before that
   *  answer is given: one tab's failure must not leave the others unwritten. */
  async function flushDirty(): Promise<boolean> {
    await flushEdits()
    let ok = true
    for (const tab of tabs.value) {
      if (!tab.dirty || !tab.path) continue
      if (!(await saveUntilSettled(tab.id))) ok = false
    }
    return ok
  }

  return { saveUntilSettled, flushDirty }
}
