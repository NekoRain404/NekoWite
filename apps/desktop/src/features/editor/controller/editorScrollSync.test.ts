import { describe, expect, it, beforeEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useTabsStore } from '../../../stores/tabs'
import { useViewStore } from '../../../stores/view'
import { createDocumentSession, type DocumentSession } from '../model/documentSession'
import { createEditorScrollSync } from './editorScrollSync'

vi.mock('../../../services/fs', () => ({
  fsService: {
    read: vi.fn().mockResolvedValue('# Welcome\n\nbody'),
    write: vi.fn().mockResolvedValue(undefined),
    saveFileDialog: vi.fn().mockResolvedValue(null),
  },
}))

function makeScrollEl() {
  return {
    scrollTop: 0,
    scrollHeight: 1000,
    clientHeight: 200,
    getBoundingClientRect: () => ({ top: 0, left: 0, width: 0, height: 0 }),
  }
}

describe('editorScrollSync', () => {
  let session: DocumentSession
  let tabs: ReturnType<typeof useTabsStore>
  let view: ReturnType<typeof useViewStore>

  beforeEach(async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    tabs = useTabsStore()
    view = useViewStore()
    session = createDocumentSession()
    tabs.setVault('/vault')
    await tabs.openTab('welcome.md')
  })

  it('computes a ratio and sets the scroll position, arming suppression', () => {
    const el = makeScrollEl()
    const scrollSync = createEditorScrollSync({
      session,
      getScrollEl: () => el as unknown as HTMLElement,
      getEditorEl: () => null,
    })
    expect(scrollSync.getRatio()).toBe(0)
    scrollSync.setRatio(0.5)
    expect(el.scrollTop).toBe(400)
    expect(session.suppressScroll).toBe(true)
  })

  it('swallows the programmatic scroll echo then syncs the next real scroll', () => {
    const el = makeScrollEl()
    const scrollSync = createEditorScrollSync({
      session,
      getScrollEl: () => el as unknown as HTMLElement,
      getEditorEl: () => null,
    })
    scrollSync.setRatio(0.5)
    scrollSync.onScroll()
    // the async echo is swallowed: suppression clears, store is untouched
    expect(session.suppressScroll).toBe(false)
    expect(view.renderedScroll).toBe(0)
    scrollSync.onScroll()
    expect(view.renderedScroll).toBe(400)
  })

  it('setRatio is a no-op when the position barely changes', () => {
    const el = makeScrollEl()
    el.scrollTop = 400
    const scrollSync = createEditorScrollSync({
      session,
      getScrollEl: () => el as unknown as HTMLElement,
      getEditorEl: () => null,
    })
    scrollSync.setRatio(0.5)
    expect(session.suppressScroll).toBe(false)
  })

  it('cancel() clears an armed suppression without scrolling', () => {
    const el = makeScrollEl()
    const scrollSync = createEditorScrollSync({
      session,
      getScrollEl: () => el as unknown as HTMLElement,
      getEditorEl: () => null,
    })
    scrollSync.setRatio(0.5)
    scrollSync.cancel()
    expect(session.suppressScroll).toBe(false)
    expect(el.scrollTop).toBe(400)
  })
})
