import { computed } from 'vue'
import type { NekoEditor } from '@nekowite/editor-core'
import { useAppearanceStore } from '../../../stores/appearance'
import { useTabsStore } from '../../../stores/tabs'
import {
  countWords,
  isWordGoalMet,
  shouldCenterScroll,
  wordProgress,
} from '../../../services/editorBehaviors'

export interface UseEditorFocusOptions {
  /** Returns the live editor (may be null before/after mount). */
  getEditor: () => NekoEditor | null
  /** Returns the pane's scroll container (used for typewriter centering). */
  getScrollEl: () => HTMLElement | null
}

/**
 * Editor focus UX for the rendered pane: the word-count goal widget and the
 * focus / typewriter center-cursor behavior.
 *
 * - Word goal: a slim top progress reading is shown while `wordGoal > 0`,
 *   flipping to the accent color once the goal is reached. Count is derived
 *   from the live tab content with the same CJK/latin algorithm the status bar
 *   uses.
 * - Typewriter mode: keep the cursor block vertically centered while it drifts,
 *   scrolling only the viewport (never the document). Driven by a rAF so we
 *   re-frame after ProseMirror has synced the DOM for this interaction.
 *
 * Returns the reactive word-goal values for the template plus the focus event
 * handlers and lifecycle hooks the orchestrator wires up.
 */
export function useEditorFocus(options: UseEditorFocusOptions) {
  const appearance = useAppearanceStore()
  const tabs = useTabsStore()

  let focusRaf = 0

  function centerCursor(): void {
    const scroller = options.getScrollEl()
    const v = options.getEditor()?.getView()
    if (!scroller || !v) return
    if (!appearance.focusMode) return
    const head = v.state.selection.head
    const coords = v.coordsAtPos(head)
    if (!coords) return
    const rect = scroller.getBoundingClientRect()
    const cursorTop = coords.top - rect.top
    // Leave the scroll alone while the caret sits near the middle, so an
    // already-centered caret does not chase itself on every keystroke.
    if (!shouldCenterScroll(cursorTop, scroller.clientHeight)) return
    const target = scroller.scrollTop + (cursorTop - scroller.clientHeight / 2)
    const clamped = Math.max(0, Math.min(target, scroller.scrollHeight - scroller.clientHeight))
    if (Math.abs(scroller.scrollTop - clamped) < 0.5) return
    scroller.scrollTop = clamped
  }

  function queueCenterCursor(): void {
    if (!appearance.focusMode) return
    if (focusRaf) return
    focusRaf = requestAnimationFrame(() => {
      focusRaf = 0
      centerCursor()
    })
  }

  function onFocusKeydown(): void {
    queueCenterCursor()
  }

  function onFocusPointerdown(): void {
    queueCenterCursor()
  }

  /** Cancel a pending rAF — call on unmount so no frame fires after teardown. */
  function cancelFocusRaf(): void {
    if (focusRaf) {
      cancelAnimationFrame(focusRaf)
      focusRaf = 0
    }
  }

  const wordCount = computed(() => countWords(tabs.activeTab?.content ?? ''))
  const wordGoalMet = computed(() => isWordGoalMet(wordCount.value, appearance.wordGoal))
  const wordProgressPct = computed(() =>
    Math.round(wordProgress(wordCount.value, appearance.wordGoal) * 100),
  )

  return {
    wordCount,
    wordGoalMet,
    wordProgressPct,
    queueCenterCursor,
    onFocusKeydown,
    onFocusPointerdown,
    cancelFocusRaf,
  }
}
