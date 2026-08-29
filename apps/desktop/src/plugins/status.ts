import { definePlugin } from '@nekowite/plugin-host'
import { useTabsStore } from '../stores/tabs'

function emitWordCount(): void {
  const tabs = useTabsStore()
  const tab = tabs.activeTab
  if (!tab) {
    console.warn('[status.wordCount] no active tab')
    return
  }
  const count = tab.content.trim() === '' ? 0 : tab.content.trim().split(/\s+/).length
  console.log(`[status.wordCount] ${count}`)
  window.dispatchEvent(new CustomEvent('nekowite:word-count', { detail: count }))
}

export const statusPlugin = definePlugin({
  name: 'Status',
  commands: [{ id: 'status.wordCount', run: emitWordCount }],
})