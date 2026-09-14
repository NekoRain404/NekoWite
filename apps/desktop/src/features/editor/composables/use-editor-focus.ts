import { computed, watch } from 'vue'
import type { NekoEditor } from '@nekowite/editor-core'
import { storeToRefs } from 'pinia'
import { useAppearanceStore } from '../../../stores/appearance'
import { useDocDerivedStore } from '../../../stores/doc-derived'
import {
  isWordGoalMet,
  shouldCenterScroll,
  wordProgress,
} from '../../../services/editor-behaviors'
import { announce } from '../../../services/announcer'
import { t } from '../../../i18n'

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
 *   flipping to the accent color once the goal is reached. Count comes from the
 *   shared document reading (`stores/docDerived.ts`), so it is the same number
 *   the status bar shows and it is scanned once per published text instead of
 *   once per consumer.
 * - Typewriter mode: keep the cursor block vertically centered while it drifts,
 *   scrolling only the viewport (never the document). Driven by a rAF so we
 *   re-frame after ProseMirror has synced the DOM for this interaction.
 *
 * Returns the reactive word-goal values for the template plus the focus event
 * handlers and lifecycle hooks the orchestrator wires up.
 */
export function useEditorFocus(options: UseEditorFocusOptions) {
  const appearance = useAppearanceStore()
  const { stats } = storeToRefs(useDocDerivedStore())

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

  /**
   * Zero while no goal is set, and not merely "unused": the live-region watch
   * below reads this computed on every edit, so counting unconditionally made
   * every typing pause scan the whole document for a widget that is not on
   * screen (the goal is off by default). The goal is read first, so `stats` is
   * not touched at all — and turning a goal on re-reads it, since the goal is
   * reactive. Nothing renders this value while the goal is 0 (the progress
   * reading is behind `v-if="appearance.wordGoal > 0"`), and `isWordGoalMet` /
   * `wordProgress` both already answer 0/false for a goal of 0.
   */
  const wordCount = computed(() => (appearance.wordGoal > 0 ? stats.value.words : 0))
  const wordGoalMet = computed(() => isWordGoalMet(wordCount.value, appearance.wordGoal))
  const wordProgressPct = computed(() =>
    Math.round(wordProgress(wordCount.value, appearance.wordGoal) * 100),
  )

  // Live-region: annonce when the word goal is reached (or the user crosses back
  // below it while the goal is set) so a screen-reader user hears the milestone
  // without re-reading the whole status line.
  watch(wordGoalMet, (met) => {
    // Only announce when a goal is actually set (goal=0 disables the widget).
    if (appearance.wordGoal === 0) return
    announce(
      met
        ? t('recovery.wordGoalReached', { goal: appearance.wordGoal })
        : t('recovery.wordGoalProgress', { current: wordCount.value, goal: appearance.wordGoal }),
    )
  })

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
