import { definePlugin } from '@nekowite/plugin-host'
import { useTabsStore } from '../stores/tabs'

function countWords(text: string): number {
  return text.trim() === '' ? 0 : text.trim().split(/\s+/).length
}

function dispatchWordCount(count: number): void {
  console.log(`[status.wordCount] ${count}`)
  window.dispatchEvent(new CustomEvent('nekowite:word-count', { detail: count }))
}

function runWordCount(): void {
  const tabs = useTabsStore()
  const tab = tabs.activeTab
  if (!tab) {
    console.warn('[status.wordCount] no active tab')
    return
  }
  dispatchWordCount(countWords(tab.content))
}

export const statusPlugin = definePlugin({
  name: 'Status',
  commands: [{ id: 'status.wordCount', run: runWordCount }],
  onEditorReady(ctx, editor) {
    console.log(`[status.onEditorReady] ${ctx.id} ready=${editor ? 'yes' : 'no'}`)
  },
  onDocChange(_ctx, e) {
    dispatchWordCount(countWords(e.doc))
  },
  onSave(ctx, editor, content) {
    console.log(`[status.onSave] ${ctx.id} editor=${editor ? 'yes' : 'no'} bytes=${content.length}`)
  },
  onSaved(ctx, editor, content) {
    console.log(`[status.onSaved] ${ctx.id} editor=${editor ? 'yes' : 'no'} bytes=${content.length}`)
  },
  onOpenDocument(ctx, tab) {
    console.log(`[status.onOpenDocument] ${ctx.id}`, tab)
  },
  onCloseTab(ctx, tab) {
    console.log(`[status.onCloseTab] ${ctx.id}`, tab)
  },
  onViewModeChange(ctx, mode) {
    console.log(`[status.onViewModeChange] ${ctx.id} mode=${String(mode)}`)
  },
})
