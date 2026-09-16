/**
 * The version list of the active note: when it is read, what it holds, and the
 * comparison/restore actions the panel offers.
 *
 * Split out of `HistoryPanel.vue` (the SFC keeps the markup, the styles and the
 * wiring) because the interesting part is the reading policy, and that policy is
 * the whole point here:
 *
 * - The list is a directory read, so it changes when the note does, when a save
 *   lands — a save is what writes a version — or when the user asks. It does NOT
 *   change when the text changes: reacting per keystroke meant a `listHistory`
 *   IPC read per typing pause.
 * - The section is only read while it is actually on screen, and the note list
 *   is what enforces that now: it switches sections with a `v-else-if` chain, so
 *   this panel exists only while its mode is the one showing — mounting IS the
 *   read, and switching away unmounts the watchers with it. Until this panel
 *   moved into that column it lived in the info rail, which kept every section
 *   mounted and hid them with `v-show`; there a hidden panel went on issuing
 *   that IPC read, and `useSectionShown` (a MutationObserver on the section's
 *   inline `display`) was what stopped it. With no host left that hides without
 *   unmounting, that composition had nothing to gate and is gone: a gate that
 *   is always true is a comment pretending to be a mechanism.
 */

import { computed, onMounted, ref, watch, type Ref } from 'vue'
import { fsService } from '../platform/gateways/fs'
import { notifyError } from '../services/errors'
import { useTabsStore } from '../stores/tabs'
import type { HistoryEntry } from '../platform/gateways/contracts'
import { t } from '../i18n'

export interface HistoryPanelModel {
  entries: Ref<HistoryEntry[]>
  /** True when the last read failed (the panel must not say "no history"). */
  loadFailed: Ref<boolean>
  /** The entry being compared, or null when nothing is open. */
  comparing: Ref<HistoryEntry | null>
  /** Historical text of `comparing`, loaded lazily on open. */
  historyText: Ref<string>
  /** The note the comparison belongs to; null when nothing is being compared. */
  comparingPath: Ref<string | null>
  hasDoc: () => boolean
  load: () => Promise<void>
  restore: (entry: HistoryEntry) => Promise<void>
  openCompare: (entry: HistoryEntry) => Promise<void>
  closeCompare: () => void
  restoreFromDiff: () => Promise<void>
  formatSize: (bytes: number) => string
}

export function useHistoryPanel(): HistoryPanelModel {
  const tabs = useTabsStore()

  const entries = ref<HistoryEntry[]>([])
  /**
   * Set when the last read of the history FAILED. The panel must not print "no
   * history yet" underneath an error toast: that sentence says the versions are
   * gone, while the truth is that they could not be read.
   */
  const loadFailed = ref(false)

  /** The entry being compared against the current content, or null to close. */
  const comparing = ref<HistoryEntry | null>(null)
  /** Historical text of `comparing`, loaded lazily on open. */
  const historyText = ref('')
  /**
   * The note `comparing`/`historyText` belong to.
   *
   * The comparison is a snapshot of ONE note's old version and is not
   * self-describing: without this, switching notes left the panel showing "this
   * note's current text vs THAT note's old text" in one diff - two documents
   * mixed together - and the restore button then asked the backend to restore
   * the other note's version id onto this one (a confusing failure, or with a
   * coincidentally equal id, the wrong version pasted into the wrong note).
   */
  const comparingPath = ref<string | null>(null)

  /** Which note the list describes: vault + path, as one comparable value. */
  const docKey = computed(() => {
    const tab = tabs.activeTab
    // JSON rather than a joined string: a separator could be part of a path, and
    // this reads as one value to the watcher below (an array source compares its
    // elements one by one).
    return tab?.path ? JSON.stringify([tabs.vault ?? null, tab.path]) : null
  })

  /** The active tab's save state, so a landed save can refresh the list. */
  const saveState = computed(() => {
    const tab = tabs.activeTab
    return tab ? tabs.saveStateOf(tab.id) : null
  })

  /** Bumped when a save finishes, so the reload happens on the write and not on
   *  every intermediate state ('dirty' → 'saving' → 'saved'). */
  const savedTick = ref(0)
  watch(saveState, (state, previous) => {
    if (state === 'saved' && previous === 'saving') savedTick.value += 1
  })

  function hasDoc(): boolean {
    return Boolean(tabs.vault && tabs.activeTab?.path)
  }

  function dropForeignCompare(): void {
    if (comparingPath.value !== null && comparingPath.value !== (tabs.activeTab?.path ?? null)) {
      closeCompare()
    }
  }

  /**
   * Every read takes a ticket; only the newest one may write.
   *
   * A read is overtaken while it is in flight whenever the note changes, a save
   * lands (`savedTick`) or the user presses Refresh, and the reads do not have
   * to settle in the order they started. Without the ticket the later-RESOLVING
   * list won, so note A's versions could render under note B — every Restore in
   * that list then aimed A's version id at B's file, and the panel looked
   * entirely normal while describing another document.
   *
   * Same policy as `openCompare` below, which re-checks the note it started for
   * after its await; a ticket also covers A → B → A, where re-checking the note
   * alone would let the first A read overwrite the second.
   */
  let loadSeq = 0

  async function load(): Promise<void> {
    const seq = ++loadSeq
    const tab = tabs.activeTab
    // The note changed: any open comparison describes a document that is no longer
    // on screen, so drop it rather than render (and act on) a mixed diff.
    dropForeignCompare()
    if (!tab?.path || !tabs.vault) {
      entries.value = []
      loadFailed.value = false
      return
    }
    const path = tab.path
    const vault = tabs.vault
    try {
      const list = await fsService.listHistory(vault, path)
      if (seq !== loadSeq) return
      entries.value = list
      loadFailed.value = false
    } catch (e) {
      // A read the user has already left behind reports nothing: its failure is
      // about a document that is no longer open, and the newer read says what
      // this note's state actually is.
      if (seq !== loadSeq) return
      // The toast carries the backend reason (which folder, what the OS said);
      // the inline hint below stops the panel from claiming there is no history.
      notifyError(t('history.readFailed', { msg: e instanceof Error ? e.message : String(e) }))
      entries.value = []
      loadFailed.value = true
    }
  }

  // A comparison describes one note; leaving it up while another note is open
  // mixes two documents. Drop it on the switch itself, whether or not this
  // section happens to be on screen.
  watch(docKey, dropForeignCompare)

  // When the list has to be re-read, in one place: the note changed (`docKey`)
  // or a save landed (`savedTick`). Deliberately NOT the content — typing that
  // has not been saved cannot change the answer, and the restore path reloads
  // explicitly.
  watch([docKey, savedTick], () => { void load() })

  async function restore(entry: HistoryEntry): Promise<void> {
    const tab = tabs.activeTab
    if (!tab?.path) return
    // restoreHistoryToActive reports its own failures; null just means
    // "nothing restored" (error toast already shown, or the tab is gone).
    await tabs.restoreHistoryToActive(tab.id, entry.id)
    // The watcher above also refreshes the list once the restore's save lands;
    // this explicit reload keeps the panel in sync even if the restored content
    // equals the current content (no reactive change).
    await load()
  }

  async function openCompare(entry: HistoryEntry): Promise<void> {
    const tab = tabs.activeTab
    if (!tab?.path || !tabs.vault) return
    const path = tab.path
    const vault = tabs.vault
    try {
      const text = await fsService.readHistory(vault, path, entry.id)
      // The read is asynchronous: if the user switched notes while it was in
      // flight, this text belongs to the note that is no longer open.
      if (tabs.activeTab?.path !== path || tabs.vault !== vault) return
      historyText.value = text
      comparing.value = entry
      comparingPath.value = path
    } catch {
      notifyError(t('history.readHistoryFailed'))
    }
  }

  function closeCompare(): void {
    comparing.value = null
    historyText.value = ''
    comparingPath.value = null
  }

  async function restoreFromDiff(): Promise<void> {
    // Only restore what the diff actually shows: the same note, still open.
    if (comparing.value && comparingPath.value === tabs.activeTab?.path) {
      await restore(comparing.value)
    }
    closeCompare()
  }

  function formatSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  }

  // The panel only exists while its mode is the one on screen, so mounting is
  // the section being shown: this reads once, there and not before.
  onMounted(() => { void load() })

  return {
    entries,
    loadFailed,
    comparing,
    historyText,
    comparingPath,
    hasDoc,
    load,
    restore,
    openCompare,
    closeCompare,
    restoreFromDiff,
    formatSize,
  }
}
