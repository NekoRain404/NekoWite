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

export type SaveState = 'saved' | 'dirty' | 'saving'

export function createTabSaveState(deps: { tabs: Ref<OpenTab[]> }) {
  const { tabs } = deps

  /** Tabs whose write has not settled yet. */
  const savingIds = ref<Set<string>>(new Set())

  function markSaving(id: string): void {
    const next = new Set(savingIds.value)
    next.add(id)
    savingIds.value = next
  }

  function markSaved(id: string): void {
    const next = new Set(savingIds.value)
    next.delete(id)
    savingIds.value = next
  }

  /** The state the tab strip's dot and the status line render. */
  function stateOf(id: string): SaveState {
    if (savingIds.value.has(id)) return 'saving'
    const tab = tabs.value.find((x) => x.id === id)
    if (tab?.dirty) return 'dirty'
    return 'saved'
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
   *  after, to tell a landed write from one the user typed across. */
  function revisionOf(id: string): number {
    return editRevisions.get(id) ?? 0
  }

  /** Drop every record a removed tab left behind (the tab set was replaced):
   *  a saving flag and a revision belong to the tab that raised them. */
  function reset(): void {
    savingIds.value = new Set()
    editRevisions.clear()
  }

  return { markSaving, markSaved, stateOf, noteEdit, revisionOf, reset }
}

export type TabSaveState = ReturnType<typeof createTabSaveState>
