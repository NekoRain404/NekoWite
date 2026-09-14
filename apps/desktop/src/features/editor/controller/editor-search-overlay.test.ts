import { nextTick } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { renderSearchState, setRenderSearchState } from '../../../services/render-search'
import { createDocumentSession } from '../model/document-session'
import { createEditorSearchOverlay } from './editor-search-overlay'
import { t } from '../../../i18n'

vi.mock('../../../services/announcer', () => ({
  announce: vi.fn(),
}))
import { announce } from '../../../services/announcer'

vi.mock('../../../platform/gateways/fs', () => ({
  fsService: {
    read: vi.fn().mockResolvedValue('helo world'),
    write: vi.fn(),
    list: vi.fn(),
    watch: vi.fn(),
    deleteFile: vi.fn(),
    stat: vi.fn(),
    listHistory: vi.fn().mockResolvedValue([]),
    readHistory: vi.fn(),
    restoreHistory: vi.fn(),
    openFolderDialog: vi.fn(),
    saveFileDialog: vi.fn(),
    onFsChange: vi.fn(),
  },
}))

import type { NekoEditor } from '@nekowite/editor-core'
import { basicPlugins, createEditor } from '@nekowite/editor-core'
import { editorBridge } from '../../../services/editor-bridge'
import { findMisspellingsInDoc } from '../../../services/render-search'
import { useTabsStore } from '../../../stores/tabs'

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
  editorBridge.setEditor(null)
  document.body.innerHTML = ''
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

/** A `<span class="nkw-spell">`-shaped element, as the rendered pane builds it. */
function spellSpan(from: number, to: number, word: string, suggestions: string[]): HTMLElement {
  const span = document.createElement('span')
  span.dataset.from = String(from)
  span.dataset.to = String(to)
  span.dataset.word = word
  span.dataset.suggestions = suggestions.join('|')
  return span
}

// C5. The popup captures a model range when it opens and the popup does NOT close
// when the document changes, so a delayed click used to replace whatever now sat
// at those offsets — and once the document had shrunk below `to`,
// `tr.insertText` threw an uncaught RangeError.
describe('spell popup staleness', () => {
  let editor: NekoEditor | null = null
  let overlay: ReturnType<typeof createEditorSearchOverlay> | null = null
  let notifyChange: (() => void) | null = null

  beforeEach(async () => {
    setActivePinia(createPinia())
    const tabs = useTabsStore()
    tabs.setVault('/vault')
    await tabs.openTab('notes/a.md')
    const host = document.createElement('div')
    document.body.appendChild(host)
    editor = createEditor(host, { plugins: basicPlugins })
    editorBridge.setEditor(editor)
    await editor.open('helo world')
    await new Promise((resolve) => setTimeout(resolve, 0))
    overlay = createEditorSearchOverlay({
      session: createDocumentSession(),
      getEditor: () =>
        ({
          onContentChange: (cb: () => void) => {
            notifyChange = cb
            return () => {
              notifyChange = null
            }
          },
        }) as unknown as NekoEditor,
    })
    overlays.push(overlay)
    overlay.attachChangeListener()
  })

  function miss(): { from: number; to: number; word: string } {
    const view = editorBridge.getView()
    if (!view) throw new Error('no editor view')
    return findMisspellingsInDoc(view)[0]!
  }

  it('invalidates the popup when the model changes', () => {
    const target = miss()
    overlay!.openSpellPopup(spellSpan(target.from, target.to, target.word, ['hello']), 10, 10)
    expect(overlay!.spellPopup.value?.word).toBe(target.word)

    // The user keeps typing with the popup open: its offsets describe a document
    // that no longer exists.
    notifyChange?.()
    expect(overlay!.spellPopup.value).toBeNull()
  })

  it('never rewrites an unrelated range when the document moved under the popup', async () => {
    const target = miss()
    overlay!.openSpellPopup(spellSpan(target.from, target.to, target.word, ['hello']), 10, 10)
    // A model change that never reached the overlay's listener (a document swap
    // while the rendered pane was applying external content).
    const view = editorBridge.getView()!
    view.dispatch(view.state.tr.insertText('AAAA ', 0, 0))

    expect(() => overlay!.handleSpellSuggestion('hello')).not.toThrow()
    const markdown = await editorBridge.getEditor()!.save()
    // The captured range now holds a different word, so the replacement must be
    // dropped rather than applied to it.
    expect(markdown).not.toContain('hello')
    expect(overlay!.spellPopup.value).toBeNull()
  })

  it('does not throw when the document shrank past the captured range', async () => {
    const target = miss()
    overlay!.openSpellPopup(spellSpan(target.from, target.to, target.word, ['hello']), 10, 10)
    const view = editorBridge.getView()!
    // Everything from the misspelling on is deleted: `to` is now beyond the end
    // of the document.
    view.dispatch(view.state.tr.delete(target.from, view.state.doc.content.size - 1))

    expect(() => overlay!.handleSpellSuggestion('hello')).not.toThrow()
    expect(overlay!.spellPopup.value).toBeNull()
    const markdown = await editorBridge.getEditor()!.save()
    expect(markdown).not.toContain('hello')
  })

  it('still replaces the captured word when nothing changed', async () => {
    const target = miss()
    overlay!.openSpellPopup(spellSpan(target.from, target.to, target.word, ['hello']), 10, 10)

    overlay!.handleSpellSuggestion('hello')

    const markdown = await editorBridge.getEditor()!.save()
    expect(markdown).toContain('hello world')
    expect(overlay!.spellPopup.value).toBeNull()
  })
})