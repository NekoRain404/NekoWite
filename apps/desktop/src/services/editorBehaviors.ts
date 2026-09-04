// Pure, framework-agnostic helpers for the editor behavior settings (focus /
// typewriter mode and the word-count goal). Kept as pure functions so they can
// be unit-tested without a DOM or an editor instance, and reused by both the
// rendered pane and the status bar.

// CJK unified ideographs + kana + Hangul syllables: no whitespace between words.
const CJK_RE = /[一-鿿぀-ヿ가-힯]/g

/** Count "words" in markdown text. CJK has no whitespace between words, so each
 *  CJK character counts as one word; whitespace-separated runs in the remainder
 *  (latin / digits / emoji) count as one word each. */
export function countWords(text: string): number {
  const cjk = text.match(CJK_RE)?.length ?? 0
  const rest = text.replace(CJK_RE, ' ').trim()
  const latinWords = rest ? rest.split(/\s+/).filter(Boolean).length : 0
  return cjk + latinWords
}

/** Progress of `words` toward `goal`, clamped to [0, 1]. A `goal` of 0 (off)
 *  yields 0 so consumers can hide the widget entirely. */
export function wordProgress(words: number, goal: number): number {
  if (!Number.isFinite(goal) || goal <= 0) return 0
  const ratio = words / goal
  if (ratio >= 1) return 1
  if (!Number.isFinite(ratio) || ratio < 0) return 0
  return ratio
}

/** Whether the goal has been reached (used to flip the highlight to accent). */
export function isWordGoalMet(words: number, goal: number): boolean {
  return goal > 0 && words >= goal
}

/** Whether the cursor should be re-centered in focus/typewriter mode. The
 *  cursor's `top` is measured from the top of the visible pane; when it drifts
 *  outside the middle band we re-frame it to the vertical center, otherwise we
 *  leave the scroll alone (so a mostly-centered caret does not chase itself). */
export function shouldCenterScroll(cursorTop: number, viewportHeight: number): boolean {
  if (!Number.isFinite(cursorTop) || !Number.isFinite(viewportHeight) || viewportHeight <= 0) {
    return false
  }
  const band = viewportHeight * 0.25
  return cursorTop < band || cursorTop > viewportHeight - band
}
