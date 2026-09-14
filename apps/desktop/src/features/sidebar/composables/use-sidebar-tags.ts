/**
 * The tag section: the counts the document list derives, which tag is filtering
 * the list, and the one command a row offers — dropping a tag from the note
 * that is open right now (§13.4).
 *
 * The store reads (documentList, tabs) live here rather than in the component:
 * §10.2 keeps a feature component off the stores, and every read here is this
 * section's own business — the tags the vault holds, the filter they set, and
 * the document the removal acts on.
 */

import { computed } from 'vue'
import { parseFrontmatterForPanel, splitFrontmatterRaw } from '../../../services/note-meta'
import { removeTagFromContent } from '../../../services/tags'
import { flushSourceEdits } from '../../../services/source-view'
import { useDocumentListStore } from '../../../stores/document-list'
import { useTabsStore } from '../../../stores/tabs'

export function useSidebarTags() {
  const documentList = useDocumentListStore()
  const tabs = useTabsStore()

  const tagCounts = computed(() => documentList.tagCounts)

  /** The tag currently filtering the list, or null. `filter` carries the
   *  `tag:` prefix the list query reads; the rows compare against the bare tag. */
  const activeTag = computed(() =>
    documentList.filter.startsWith('tag:') ? documentList.filter.slice('tag:'.length) : null,
  )

  function selectTag(tag: string): void {
    documentList.setFilter(`tag:${tag}`)
  }

  const activeDocTags = computed(() => {
    const tab = tabs.activeTab
    if (!tab) return new Set<string>()
    const { front } = splitFrontmatterRaw(tab.content)
    return new Set(parseFrontmatterForPanel(front).tags)
  })

  /** Remove `tag` from the CURRENTLY OPEN document's frontmatter. The library
   *  wide rename/remove is intentionally out of scope: it would need to rewrite
   *  every note's file (riskier, deferred). The index refreshes after the save. */
  function removeCurrentTag(tag: string, e: MouseEvent): void {
    e.stopPropagation()
    const tab = tabs.activeTab
    if (!tab) return
    // Whole-document read-modify-write: publish the source pane's pending
    // keystrokes first, or this would transform (and then mirror back) text that
    // is a debounce window out of date.
    flushSourceEdits()
    const next = removeTagFromContent(tab.content, tag)
    if (next === tab.content) return
    tab.content = next
    tabs.markDirty(tab.id)
    tabs.scheduleAutosave(tab.id)
  }

  return { tagCounts, activeTag, selectTag, activeDocTags, removeCurrentTag }
}
