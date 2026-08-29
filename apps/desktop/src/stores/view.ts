import { defineStore } from 'pinia'
import { ref } from 'vue'

export type ViewMode = 'source' | 'rendered' | 'split'

export const useViewStore = defineStore('view', () => {
  const mode = ref<ViewMode>('rendered')
  const sourceScroll = ref(0)
  const renderedScroll = ref(0)

  function setMode(m: ViewMode): void {
    mode.value = m
  }

  function syncScroll(from: 'source' | 'rendered', pos: number): void {
    if (from === 'source') sourceScroll.value = pos
    else renderedScroll.value = pos
  }

  return { mode, sourceScroll, renderedScroll, setMode, syncScroll }
})