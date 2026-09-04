import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createApp, type App as VueApp } from 'vue'
import { createPinia, setActivePinia, type Pinia } from 'pinia'
import NoteListPanel from './NoteListPanel.vue'
import { useFileTreeStore } from '../stores/fileTree'
import { useDocumentListStore } from '../stores/documentList'

let pinia: Pinia
let host: HTMLElement | null = null
let mounted: VueApp[] = []

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

function mountPanel(): void {
  host = document.createElement('div')
  document.body.appendChild(host)
  const app = createApp(NoteListPanel)
  app.use(pinia)
  app.mount(host)
  mounted.push(app)
}

describe('NoteListPanel truncation notice', () => {
  beforeEach(() => {
    pinia = createPinia()
    setActivePinia(pinia)
  })

  afterEach(() => {
    for (const app of mounted) app.unmount()
    mounted = []
    host?.remove()
    host = null
  })

  it('does not show the notice when the vault is not truncated', async () => {
    useFileTreeStore().vaultTruncated = false
    mountPanel()
    await flush()
    expect(host!.textContent).not.toContain('截断')
    expect(host!.textContent).not.toContain('listing truncated')
  })

  it('surfaces the truncation signal to the user when the vault walk was capped', async () => {
    useFileTreeStore().vaultTruncated = true
    useDocumentListStore().indexing = false
    mountPanel()
    await flush()
    // The default test locale is zh, so the notice resolves to the zh string.
    expect(host!.textContent).toContain('笔记库过大')
  })
})
