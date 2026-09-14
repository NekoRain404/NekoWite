import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useTabsStore } from '../stores/tabs'

vi.mock('../platform/gateways/fs', () => ({
  fsService: {
    read: vi.fn().mockResolvedValue('Hello world\n'),
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
    listTrash: vi.fn(),
    restoreFromTrash: vi.fn(),
    saveAttachment: vi.fn(),
    resolveMediaPath: vi.fn(),
  },
}))

import { createEditor, basicPlugins } from '@nekowite/editor-core'
import { editorBridge } from '../services/editor-bridge'
import {
  applySpellReplacement,
  closePanel,
  findMisspellingsInDoc,
  findRangesInDoc,
  openPanel,
  refreshOverlays,
  replaceAll,
  replaceCurrent,
  renderSearchState,
  setQuery,
  setRenderSearchState,
  suggestionsFromAttr,
} from '../services/render-search'

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

let host: HTMLDivElement | null = null

async function mountEditor(content: string): Promise<void> {
  setActivePinia(createPinia())
  const tabs = useTabsStore()
  tabs.setVault('/vault')
  await tabs.openTab('notes/a.md')
  tabs.activeTab!.content = content

  host = document.createElement('div')
  host.className = 'rendered-pane'
  document.body.appendChild(host)
  const editor = createEditor(host, { plugins: basicPlugins })
  editorBridge.setEditor(editor)
  await editor.open(content)
  await flush()
}

beforeEach(() => {
  document.body.innerHTML = ''
})

afterEach(() => {
  editorBridge.setEditor(null)
  renderSearchState.open = false
  renderSearchState.query = ''
  renderSearchState.replace = ''
  renderSearchState.caseSensitive = false
  renderSearchState.ranges = []
  renderSearchState.active = 0
  host?.remove()
  host = null
  document.body.innerHTML = ''
})

describe('findRangesInDoc', () => {
  it('locates all occurrences with absolute positions', async () => {
    await mountEditor('the quick fox and the dog')
    const view = editorBridge.getView()!
    const ranges = findRangesInDoc(view, 'the', false)
    expect(ranges.length).toBe(2)
    expect(ranges[0]!.from).toBeLessThan(ranges[1]!.from)
  })

  it('respects case sensitivity', async () => {
    await mountEditor('The quick fox and the dog')
    const view = editorBridge.getView()!
    expect(findRangesInDoc(view, 'the', false).length).toBe(2)
    expect(findRangesInDoc(view, 'the', true).length).toBe(1)
  })

  it('returns empty for a missing query', async () => {
    await mountEditor('hello')
    const view = editorBridge.getView()!
    expect(findRangesInDoc(view, '', false)).toEqual([])
  })
})

describe('findMisspellingsInDoc', () => {
  it('flags misspelled words and skips inline code', async () => {
    await mountEditor('this helo is fine and `helo` is code')
    const view = editorBridge.getView()!
    const miss = findMisspellingsInDoc(view)
    const words = miss.map((m) => m.word)
    expect(words).toContain('helo')
    expect(words.filter((w) => w === 'helo').length).toBe(1)
  })
})

describe('refreshOverlays + DOM wrapping', () => {
  it('wraps find matches and keeps the document text intact', async () => {
    await mountEditor('hello hello world')
    const view = editorBridge.getView()!
    openPanel()
    setQuery('hello')
    refreshOverlays()

    const marks = view.dom.querySelectorAll('.nw-find-hit')
    expect(marks.length).toBe(2)
    expect(marks[0]!.textContent).toBe('hello')

    const md = await editorBridge.getEditor()!.save()
    expect(md).toContain('hello hello world')
  })

  it('marks only the active match with the active class', async () => {
    await mountEditor('hello hello')
    const view = editorBridge.getView()!
    openPanel()
    setQuery('hello')
    refreshOverlays()
    expect(view.dom.querySelectorAll('.nw-find-active').length).toBe(1)
  })
})

describe('replace via ProseMirror model', () => {
  it('replaces the current match through tr.insertText', async () => {
    await mountEditor('hello world')
    openPanel()
    setQuery('hello')
    renderSearchState.replace = 'hi'
    refreshOverlays()
    replaceCurrent()
    const md = await editorBridge.getEditor()!.save()
    expect(md).toContain('hi world')
  })

  it('replaces all occurrences back-to-front', async () => {
    await mountEditor('hello hello hello')
    openPanel()
    setQuery('hello')
    renderSearchState.replace = 'bye'
    refreshOverlays()
    replaceAll()
    const md = await editorBridge.getEditor()!.save()
    expect(md).toContain('bye bye bye')
  })
})

describe('stale ranges never rewrite the wrong text', () => {
  it('does not replace at offsets left over from another document', async () => {
    // renderSearchState.ranges is refreshed on a debounce, and the document can
    // be replaced wholesale in between (switching notes, an external reload).
    // The replace actions used the cached ranges unconditionally, so replacing in
    // note B used note A's offsets: unrelated text in B was overwritten and then
    // autosaved, with nothing on screen to explain it.
    await mountEditor('1234567890123456789012345')
    setQuery('123')
    setRenderSearchState({ open: true, replace: 'XX' })
    // The offsets as they were computed for note A.
    const rangesForA = findRangesInDoc(editorBridge.getView()!, '123', false)
    expect(rangesForA.length).toBeGreaterThan(0)

    const beforeB = 'abcdefghijklmnopqrstuvwxyz'
    await mountEditor(beforeB)
    // The overlay refresh runs on a debounce, so a replace issued inside that
    // window sees exactly this: the previous document's offsets. Assign them
    // directly to model the cache the user's click would find.
    renderSearchState.ranges = rangesForA

    replaceAll()
    expect(editorBridge.getView()!.state.doc.textContent).toBe(beforeB)
  })

  it('does not throw when the new document is shorter than the cached offsets', async () => {
    // The uncaught RangeError from tr.insertText looked like the button doing
    // nothing at all, with an error only in the console.
    await mountEditor('1234567890123456789012345')
    setQuery('123')
    setRenderSearchState({ open: true, replace: 'XX' })
    const rangesForA = findRangesInDoc(editorBridge.getView()!, '123', false)

    await mountEditor('short')
    renderSearchState.ranges = rangesForA

    expect(() => replaceAll()).not.toThrow()
    expect(() => replaceCurrent()).not.toThrow()
    expect(editorBridge.getView()!.state.doc.textContent).toBe('short')
  })

  it('matches a very long query instead of throwing', async () => {
    // A long query makes V8 reject the compiled regex ("Regular expression too
    // large"). Escaping metacharacters does not help — the limit is the pattern
    // length — so the panel threw on every keystroke and kept the PREVIOUS
    // query's ranges; "Replace all" then replaced matches of a search the user
    // had already moved on from.
    const long = 'z'.repeat(50000)
    await mountEditor('before ' + long + ' after')
    expect(() => findRangesInDoc(editorBridge.getView()!, long, false)).not.toThrow()
    setQuery(long)
    setRenderSearchState({ open: true, replace: 'Q' })
    renderSearchState.ranges = findRangesInDoc(editorBridge.getView()!, long, false)

    replaceAll()

    expect(editorBridge.getView()!.state.doc.textContent).toBe('before Q after')
  })
})

describe('spell replacement', () => {
  it('replaces a clicked misspelling via the model', async () => {
    await mountEditor('helo world')
    const view = editorBridge.getView()!
    const miss = findMisspellingsInDoc(view)[0]!
    applySpellReplacement(view, miss.from, miss.to, 'hello')
    const md = await editorBridge.getEditor()!.save()
    expect(md).toContain('hello world')
  })
})

describe('suggestionsFromAttr', () => {
  it('parses the pipe-joined attribute', () => {
    expect(suggestionsFromAttr('hello|hallo')).toEqual(['hello', 'hallo'])
    expect(suggestionsFromAttr(null)).toEqual([])
  })
})

describe('panel open/close lifecycle', () => {
  it('clears ranges on close', async () => {
    await mountEditor('hello')
    openPanel()
    setQuery('hello')
    expect(renderSearchState.ranges.length).toBe(1)
    closePanel()
    expect(renderSearchState.ranges).toEqual([])
    expect(renderSearchState.open).toBe(false)
  })
})

describe('overlay decorations do not duplicate the plugins own', () => {
  it('renders the AI suggestion ghost exactly once', async () => {
    // ProseMirror gathers decorations from EVERY source it can find:
    // `viewDecorations()` runs `someProp('decorations', ...)`, which visits the
    // view's top-level prop AND each plugin's own prop. The overlay provider
    // also folded the plugins' decorations into its own set, so anything
    // non-idempotent was painted twice - the ghost suggestion showed up as two
    // identical spans, and so did the task-checkbox marker.
    await mountEditor('hello world')
    const editor = editorBridge.getEditor()!
    openPanel()
    setQuery('hello')

    editor.setSuggestion(' and more')

    expect(document.querySelectorAll('.ghost-text')).toHaveLength(1)
    expect(document.querySelector('.ghost-text')?.textContent).toBe(' and more')
  })
})
