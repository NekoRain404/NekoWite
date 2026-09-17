/**
 * Putting text into a note the editor holds, through the editor's own save transaction.
 *
 * This is the write half of `agent-edit-apply.ts`'s `AgentEditHost`, and it is deliberately a
 * *save* rather than a `fs.write`: a save is the app's one path into a note's file, and the three
 * things it brings with it are all things an apply must not skip.
 *
 *  - **The precondition.** A save reads the file first and refuses when it no longer holds the
 *    bytes this tab last read or wrote (`tab-write-preconditions.ts`), which is the app's answer to
 *    another program having replaced the note. The agent's apply does not get a private road past
 *    it, and §7.2's 「普通"读取后检查再写入"不是跨进程原子比较替换」 is exactly why that matters here:
 *    the judgement above decided about the *buffer*, and this is the only check that can see the
 *    disk.
 *  - **The vault.** A save commits to the vault that is open now and refuses if it changed while
 *    the write was in flight, so an apply cannot land a note in a vault it does not belong to.
 *  - **The editor.** The tab's content is what the panes publish to and read from, so the text
 *    arrives on screen through the same content watcher every other document change uses — and the
 *    pane that owns the text is asked before anything is written, because in source mode the tab is
 *    a debounce window behind the caret and this write would be replaced by the pane's next publish.
 *
 * Nothing here decides *whether* the write may happen: that is `judgeAgentEdit`'s answer, taken in
 * the same turn as this call. This module is only the writing.
 */

import type { AgentEditWriteOutcome } from './agent-edit-apply'
import { sourcePaneOwnsInput } from '../../../services/editor-insert'
import { useTabsStore } from '../../../stores/tabs'

/**
 * Put `text` into the note at `path` and save it.
 *
 * The text is assigned to the tab *before* the save rather than passed to it, because the tab's
 * content is the document: every other reader of it (the status line, `hasUnsavedWork`, the close
 * path) has to see the same text the file is about to hold, and a save that took the text as an
 * argument would leave those readers describing a document that no longer exists.
 */
export async function writeNoteText(path: string, text: string): Promise<AgentEditWriteOutcome> {
  const tabs = useTabsStore()
  const tab = tabs.tabs.find((candidate) => candidate.path === path)
  // No tab, no buffer: there is nothing to put the text into, and writing the file anyway would be
  // a document the user never opened holding text they never saw.
  if (!tab) return { status: 'unavailable' }
  // The one case where a write through the tab is not the same as a write into the document: while
  // the source pane owns the text, the tab is a debounce window behind the CodeMirror document, and
  // the pane's next publish would replace this write with the text it is still holding. `unavailable`
  // rather than a best effort — an apply that silently reverted a keystroke later is the failure
  // this whole area exists to remove.
  if (tabs.activeTab?.id === tab.id && sourcePaneOwnsInput()) return { status: 'unavailable' }
  tab.content = text
  // Marked dirty before the save so the tab's own readers agree that the file is behind the text —
  // and so a save that is refused leaves the difference visible rather than reported as saved.
  tabs.markDirty(tab.id)
  const saved = await tabs.saveTab(tab.id)
  // `saved` is the tab store's answer about the FILE, and it is false for a refusal, a failed
  // write and a save that raced newer typing. All of them mean the same thing to the caller: the
  // text is in the note and the file does not have it, which is a fact the user has to be told.
  return saved ? { status: 'saved' } : { status: 'save-failed' }
}
