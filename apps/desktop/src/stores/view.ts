import { defineStore } from 'pinia'
import { ref } from 'vue'
import { emitLifecycle } from '@nekowite/plugin-host'
import { persistence } from '../services/persistence'

export type ViewMode = 'source' | 'rendered' | 'split'

const VIEW_MODES: ViewMode[] = ['source', 'rendered', 'split']
const LS_DEFAULT_MODE = 'nekowite.view.defaultMode'

/** Read through the persistence port, never `localStorage` directly: a webview
 *  with storage disabled throws on the GETTER, and a store built at mount time
 *  would take the whole shell down with it (white screen). The port degrades to
 *  its memory backend instead. */
function readDefaultMode(): ViewMode {
  const v = persistence.get(LS_DEFAULT_MODE) ?? undefined
  return VIEW_MODES.includes(v as ViewMode) ? (v as ViewMode) : 'rendered'
}

export const SPLIT_RATIO_MIN = 0.15
export const SPLIT_RATIO_MAX = 0.85
export const SPLIT_RATIO_DEFAULT = 0.5

export interface OutlineTarget {
  line: number
  index: number
}

/**
 * Where one pane was last seen.
 *
 * The panes are the only things that can measure themselves, so they report
 * this on every scroll event they see — the user's and the program's alike
 * (`syncScroll` used to be called for user scrolls only; a pane a mode switch
 * has to put back is wherever it ended up, not wherever the user last left it).
 *
 * `range` travels with `top` because a scroll POSITION means nothing without
 * the extent it was measured against: the two panes lay the same document out
 * at different heights, so an offset can only be carried between them through
 * the document's own coordinates (a line) — and that conversion needs both
 * numbers.
 */
export interface PaneScrollState {
  /** Scroll offset, px. */
  top: number
  /** Scrollable extent at that moment (`scrollHeight - clientHeight`), px. */
  range: number
}

/** A fresh "never seen" state per pane: the two memories must not share a target
 *  (a write through one would move the other, and the handoff places one pane
 *  from the other's position). */
const noScroll = (): PaneScrollState => ({ top: 0, range: 0 })

export const useViewStore = defineStore('view', () => {
  const defaultMode = ref<ViewMode>(readDefaultMode())
  const mode = ref<ViewMode>(defaultMode.value)
  const sourceScroll = ref<PaneScrollState>(noScroll())
  const renderedScroll = ref<PaneScrollState>(noScroll())
  const splitRatio = ref(SPLIT_RATIO_DEFAULT)
  const pendingOutlineTarget = ref<OutlineTarget | null>(null)

  function setMode(m: ViewMode): void {
    mode.value = m
    emitLifecycle('onViewModeChange', m)
  }

  function setDefaultMode(m: ViewMode): void {
    if (!VIEW_MODES.includes(m)) return
    defaultMode.value = m
    // Same reason as readDefaultMode: a full quota makes `setItem` throw, which
    // would surface at the click that toggled the setting.
    persistence.set(LS_DEFAULT_MODE, m)
  }

  /** Reset the live view to the stored default (used when a document opens). */
  function resetToDefault(): void {
    mode.value = defaultMode.value
  }

  /** Record where a pane is. Called by the pane itself, on every scroll event
   *  it handles — the memory is the pane's position, not just the user's. */
  function syncScroll(from: 'source' | 'rendered', top: number, range: number): void {
    const state: PaneScrollState = { top, range }
    if (from === 'source') sourceScroll.value = state
    else renderedScroll.value = state
  }

  /** Forget both panes' positions: a different document's coordinates must not
   *  be carried into the one being opened. */
  function forgetPaneScroll(): void {
    sourceScroll.value = noScroll()
    renderedScroll.value = noScroll()
  }

  function setSplitRatio(r: number): void {
    const numeric = Number.isFinite(r) ? r : SPLIT_RATIO_DEFAULT
    const stepped = Math.round(numeric * 1000) / 1000
    splitRatio.value = Math.min(SPLIT_RATIO_MAX, Math.max(SPLIT_RATIO_MIN, stepped))
  }

  function requestOutlineTarget(target: OutlineTarget): void {
    pendingOutlineTarget.value = { line: target.line, index: target.index }
  }

  function consumeOutlineTarget(): void {
    pendingOutlineTarget.value = null
  }

  return {
    mode,
    defaultMode,
    sourceScroll,
    renderedScroll,
    splitRatio,
    pendingOutlineTarget,
    setMode,
    setDefaultMode,
    resetToDefault,
    syncScroll,
    setSplitRatio,
    requestOutlineTarget,
    consumeOutlineTarget,
    forgetPaneScroll,
  }
})
