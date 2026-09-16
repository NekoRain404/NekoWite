/**
 * What the save path remembers about each open tab: whether a write is in
 * flight, how many edits it has taken, and the state the status line reads.
 *
 * Split out of `tab-save.ts` for the budget (§13.1) when the disk policy
 * arrived — that file was at 394 against 400 and the read, the comparison and
 * the conflict path do not fit in the room that was left. The cut follows a line
 * the file had already drawn rather than taking an arbitrary tail off it: its
 * own header names two halves, "the save transaction and the save-state the
 * status line reads", and this is the second of them.
 *
 * The records are keyed by tab id and belong to the save path, not to the tab:
 * a replaced tab set clears them (`reset`), and ids are never reused within a
 * session (`tab-${++seq}` in `tab-lifecycle.ts`), so a recycled id cannot
 * inherit a dead tab's numbers.
 */

import { ref } from 'vue'
import type { Ref } from 'vue'
import type { OpenTab } from './tabs'

/**
 * The four states the tab strip's dot and the status line render.
 *
 * `failed` is the one a user needs and the app did not have. Every other surface
 * of a save that did not land is transient — the toast is gone in three seconds
 * — and what is left is the tab's own state, which said "unsaved". That is a
 * different claim: "unsaved" says the text has not been written yet, and a user
 * who has just been told a save was refused, by a read-only file or a full disk,
 * needs to know that the attempt already happened and did not get there.
 *
 * It REFINES `dirty` rather than replacing it, and `stateOf` states that in code:
 * a tab is never `failed` and clean. If its text is not on disk the tab is
 * dirty, and `failed` adds that a save already tried and did not land.
 *
 * What it is remembered AGAINST is content, not a clock and not the tab alone —
 * the same rule the self-write claim follows (`self-writes.ts`). A refusal is
 * about the bytes the tab believed were on disk when the write was turned away,
 * and the moment that belief changes the refusal is about text this tab no
 * longer has: a tab that took the file's version and was typed into again has
 * had no save refused for what it now holds, and saying otherwise would be this
 * defect with the opposite sign. Keying the record that way is what makes
 * "forget it when the tab stops being the tab it was" a property rather than a
 * list of places that must remember to clear something.
 */
export type SaveState = 'saved' | 'dirty' | 'saving' | 'failed'

export function createTabSaveState(deps: { tabs: Ref<OpenTab[]> }) {
  const { tabs } = deps

  /** Tabs whose write has not settled yet. */
  const savingIds = ref<Set<string>>(new Set())

  /** Tabs whose most recent completed save attempt did not put their text on
   *  disk — a refused write, a refused document, a file that changed under it —
   *  keyed by the bytes the tab believed were on disk when that happened (see
   *  the type's note). Set where the save gives up; superseded by the next
   *  attempt, and spent as soon as the tab's belief moves. */
  const failedFor = ref<Map<string, string>>(new Map())

  function markSaving(id: string): void {
    const next = new Set(savingIds.value)
    next.add(id)
    savingIds.value = next
    // A fresh attempt supersedes the last one's verdict: what the user is
    // watching now is THIS attempt, and its own outcome replaces the record. The
    // alternative — carrying "failed" into a retry — would leave the status line
    // saying the save failed while it is being made.
    if (failedFor.value.has(id)) {
      const failed = new Map(failedFor.value)
      failed.delete(id)
      failedFor.value = failed
    }
  }

  function markSaved(id: string): void {
    const next = new Set(savingIds.value)
    next.delete(id)
    savingIds.value = next
    // Deliberately NOT touching `failedFor`: this is the write having to come
    // down, not the write having succeeded, and the two refusal paths call it on
    // their way out. The record is superseded by the next attempt
    // (`markSaving`), which every landed write passes through first.
  }

  /** A save attempt for `id` did not land, and the user has been told why (the
   *  sentence is the toast's; this is what outlives it). */
  function markFailed(id: string): void {
    markSaved(id)
    const tab = tabs.value.find((x) => x.id === id)
    const next = new Map(failedFor.value)
    next.set(id, tab?.savedContent ?? '')
    failedFor.value = next
  }

  /** The state the tab strip's dot and the status line render. */
  function stateOf(id: string): SaveState {
    if (savingIds.value.has(id)) return 'saving'
    const tab = tabs.value.find((x) => x.id === id)
    if (!tab?.dirty) return 'saved'
    // The bytes the refusal was about have to be the bytes this tab still
    // believes are on disk. Anything else — a reload that took the file's
    // version, an external change that moved `savedContent` — means the refused
    // write is no longer about what the tab holds, and the honest state for text
    // nobody has tried to save is `dirty`.
    if (failedFor.value.get(id) !== tab.savedContent) return 'dirty'
    return 'failed'
  }

  /**
   * Per-tab edit revision: one bump for every `markDirty`, which the editor
   * panes fire on every doc-changing keystroke
   * (`editorPersistence`'s `onContentChange`, `SourcePane`'s publish).
   *
   * This is the evidence a save uses to decide whether it may call a tab saved,
   * and it exists because `tab.content` cannot answer that question. The
   * rendered pane publishes through a 120 ms debounce, so a keystroke sets
   * `dirty` and bumps this revision IMMEDIATELY while `tab.content` still holds
   * the previous text — for the whole length of a write, `tab.content` is
   * exactly what the save already wrote, and a save that compared only that
   * text cleared `dirty` over keystrokes that were in neither the tab nor the
   * file. A revision cannot be fooled that way: it moves at the keystroke, not
   * at the publish.
   */
  const editRevisions = new Map<string, number>()

  /** Record that `id`'s text changed (the caller is the text, not the publish). */
  function noteEdit(id: string): void {
    editRevisions.set(id, (editRevisions.get(id) ?? 0) + 1)
  }

  /** `id`'s revision now — what a save reads before its write, and compares
   *  after, to tell a landed write from one the user typed across.
   *
   *  Reached from outside this path too, through `createTabSave`'s return: the
   *  tab store's one live-note lookup spells a document identity with it
   *  (`stores/tabs.ts`'s `lookUpLiveNote`), because the agent's read path and
   *  its edit-conflict baseline have to compare one number rather than two. A
   *  second reader of "which edit is this document on" — a copy, a re-count, a
   *  flag beside it — is exactly the parallel-counter shape this file exists to
   *  keep out of the save path. */
  function revisionOf(id: string): number {
    return editRevisions.get(id) ?? 0
  }

  /** Drop every record a removed tab left behind (the tab set was replaced):
   *  a saving flag and a revision belong to the tab that raised them. */
  function reset(): void {
    savingIds.value = new Set()
    failedFor.value = new Map()
    editRevisions.clear()
  }

  return { markSaving, markSaved, markFailed, stateOf, noteEdit, revisionOf, reset }
}

export type TabSaveState = ReturnType<typeof createTabSaveState>
