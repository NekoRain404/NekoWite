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

export const useViewStore = defineStore('view', () => {
  const defaultMode = ref<ViewMode>(readDefaultMode())
  const mode = ref<ViewMode>(defaultMode.value)
  const sourceScroll = ref(0)
  const renderedScroll = ref(0)
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

  function syncScroll(from: 'source' | 'rendered', pos: number): void {
    if (from === 'source') sourceScroll.value = pos
    else renderedScroll.value = pos
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
  }
})
