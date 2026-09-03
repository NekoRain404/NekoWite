import { defineStore } from 'pinia'
import { ref } from 'vue'
import { emitLifecycle } from '@nekowite/plugin-host'

export type ViewMode = 'source' | 'rendered' | 'split'

export const SPLIT_RATIO_MIN = 0.15
export const SPLIT_RATIO_MAX = 0.85
export const SPLIT_RATIO_DEFAULT = 0.5

export interface OutlineTarget {
  line: number
  index: number
}

export const useViewStore = defineStore('view', () => {
  const mode = ref<ViewMode>('rendered')
  const sourceScroll = ref(0)
  const renderedScroll = ref(0)
  const splitRatio = ref(SPLIT_RATIO_DEFAULT)
  const pendingOutlineTarget = ref<OutlineTarget | null>(null)

  function setMode(m: ViewMode): void {
    mode.value = m
    emitLifecycle('onViewModeChange', m)
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
    sourceScroll,
    renderedScroll,
    splitRatio,
    pendingOutlineTarget,
    setMode,
    syncScroll,
    setSplitRatio,
    requestOutlineTarget,
    consumeOutlineTarget,
  }
})
