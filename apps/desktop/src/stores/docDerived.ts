/**
 * The shared readings of the active document.
 *
 * Why this exists: every reading here is a full-document scan, and all the
 * consumers are mounted at the same time — the info rail keeps its sections
 * mounted and hides them with `v-show`, so a hidden panel still re-renders and
 * still runs its computeds on every edit. A typing pause publishes one new text
 * and that used to cost one scan per panel (four in a row with the rail open,
 * plus a `listHistory` IPC read), each one re-deriving numbers another panel had
 * already derived.
 *
 * The memo is Vue's own computed cache, and it is deliberately kept that way:
 * it holds ONE entry per reading, keyed on the active tab (id + path) and the
 * text it published. Vue re-runs a getter only when one of those actually
 * changes — publishing the same string again, which the save path does, does not
 * invalidate it — so nothing accumulates and no key is built from anything whose
 * identity changes per keystroke.
 *
 * Each reading is a separate computed: a consumer pays only for what it reads,
 * and consumers that read the same reading share one scan.
 */

import { computed } from 'vue'
import { defineStore } from 'pinia'
import { useTabsStore } from './tabs'
import { computeDocStats, type DocStats } from '../services/docStats'
import { parseOutline, type OutlineItem } from '../services/outline'

export const useDocDerivedStore = defineStore('docDerived', () => {
  const tabs = useTabsStore()

  /** The published text of the active tab; the one dependency every reading
   *  below is keyed on. */
  const text = computed(() => tabs.activeTab?.content ?? '')

  /**
   * The whole reading of the document: words, characters, paragraphs, images,
   * citations, read time and tasks. The status bar's numbers and the stats
   * panel's grid are the same numbers, so they come from here rather than from
   * separate implementations that could drift apart.
   */
  const stats = computed<DocStats>(() => computeDocStats(text.value))

  /**
   * The headings, for the outline section.
   *
   * Deliberately separate from `stats`: the rail can show either section
   * without the other, and an unread computed is never evaluated.
   */
  const outline = computed<OutlineItem[]>(() => parseOutline(text.value))

  return { stats, outline }
})
