import { definePlugin } from '@nekowite/plugin-host'
import type { PluginContext } from '@nekowite/plugin-host'
import { useTabsStore } from '../stores/tabs'

function countWords(text: string): number {
  return text.trim() === '' ? 0 : text.trim().split(/\s+/).length
}

function dispatchWordCount(count: number): void {
  console.log(`[status.wordCount] ${count}`)
  window.dispatchEvent(new CustomEvent('nekowite:word-count', { detail: count }))
}

function emitWordCount(): void {
  const tabs = useTabsStore()
  const tab = tabs.activeTab
  if (!tab) {
    console.warn('[status.wordCount] no active tab')
    return
  }
  dispatchWordCount(countWords(tab.content))
}

function onDocChange(_ctx: PluginContext, e: { doc: string }): void {
  dispatchWordCount(countWords(e.doc))
}

export const statusPlugin = definePlugin({
  name: 'Status',
  commands: [{ id: 'status.wordCount', run: emitWordCount }],
  onDocChange,
})
