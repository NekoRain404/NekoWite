import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useTabsStore } from '../stores/tabs'

vi.mock('../services/fs', () => ({
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
import { editorBridge } from '../services/editorBridge'
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
  suggestionsFromAttr,
} from '../services/renderSearch'

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