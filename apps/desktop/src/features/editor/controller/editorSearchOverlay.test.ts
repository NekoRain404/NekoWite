import { nextTick } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderSearchState, setRenderSearchState } from '../../../services/renderSearch'
import { createDocumentSession } from '../model/documentSession'
import { createEditorSearchOverlay } from './editorSearchOverlay'
import { t } from '../../../i18n'

vi.mock('../../../services/announcer', () => ({
  announce: vi.fn(),
}))
import { announce } from '../../../services/announcer'

let overlays: ReturnType<typeof createEditorSearchOverlay>[] = []

const makeOverlay = (): ReturnType<typeof createEditorSearchOverlay> => {
  const overlay = createEditorSearchOverlay({
    session: createDocumentSession(),
    getEditor: () => null,
  })
  overlays.push(overlay)
  return overlay
}

afterEach(() => {
  for (const o of overlays) o.dispose()
  overlays = []
})

beforeEach(() => {
  vi.clearAllMocks()
  // Reset the shared reactive search state so a prior test cannot leak.
  setRenderSearchState({ open: false, query: '', active: 0, ranges: [], replace: '' })
})

describe('editorSearchOverlay live-region announcements', () => {
  it('announces the match count while the find panel is open', async () => {
    const overlay = makeOverlay()
    overlay.searchOpen.value = true
    setRenderSearchState({ query: 'abc', ranges: [{ from: 0, to: 3 }, { from: 5, to: 8 }] })
    await nextTick()
    expect(announce).toHaveBeenCalledWith(t('recovery.searchCount', { count: 2 }))
  })

  it('announces no matches while the find panel is open', async () => {
    const overlay = makeOverlay()
    overlay.searchOpen.value = true
    // Drive a real match→no-match transition (0→0 does not re-fire a watcher on
    // `.length`), which is the case a live-region should report.
    setRenderSearchState({ query: 'xyz', ranges: [{ from: 0, to: 3 }] })
    await nextTick()
    expect(announce).toHaveBeenCalledWith(t('recovery.searchCount', { count: 1 }))
    setRenderSearchState({ query: 'xyz', ranges: [] })
    await nextTick()
    expect(announce).toHaveBeenCalledWith(t('find.notFound'), { assertive: true })
  })

  it('does not announce when the find panel is closed', async () => {
    const overlay = makeOverlay()
    overlay.searchOpen.value = false
    setRenderSearchState({ query: 'abc', ranges: [{ from: 0, to: 3 }] })
    await nextTick()
    expect(announce).not.toHaveBeenCalled()
  })

  it('keeps scroll-state refs reactive and exposes the panel surface', () => {
    const overlay = makeOverlay()
    expect(overlay.searchOpen.value).toBe(false)
    expect(overlay.spellPopup.value).toBeNull()
    overlay.closeSearch()
    expect(overlay.searchOpen.value).toBe(false)
    // renderSearchState still lives in the service; the overlay just owns the open flag.
    expect(renderSearchState.open).toBe(false)
  })
})
