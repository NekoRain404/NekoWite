import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { EditorSelection, EditorState } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'
import {
  registerCommand,
  registerMarkdownCommand,
  registerMarkdownPrompt,
  registerToolbar,
  unregisterCommand,
  unregisterMarkdownCommand,
  unregisterMarkdownPrompt,
  unregisterToolbar,
} from '@nekowite/editor-core'
import { runEditorCommand } from './run-editor-command'
import { setSourceViewHandle } from './source-view'
import { noteFocusedPane, resetFocusedPane } from './editor-ownership'
import { editorSessionManager } from '../features/editor'
import { useViewStore } from '../stores/view'

function makeSourceView(doc: string, anchor = doc.length) {
  let state = EditorState.create({ doc, selection: EditorSelection.single(anchor) })
  const view = {
    hasFocus: true,
    get state() {
      return state
    },
    dispatch: (spec: Parameters<EditorState['update']>[0]) => {
      state = state.update(spec).state
    },
    focus: () => undefined,
  }
  return { view: view as unknown as EditorView, doc: () => state.doc.toString() }
}

const renderedRun = vi.fn()

function registerRenderedEditor(): void {
  editorSessionManager.createSession('t1', () => ({
    getView: () => ({ state: { selection: { from: 0, to: 0, empty: true } }, dispatch: vi.fn() }),
    destroy: () => undefined,
  }) as never)
}

describe('runEditorCommand', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    setSourceViewHandle(null)
    resetFocusedPane()
    renderedRun.mockClear()
    editorSessionManager.destroyAll()
    registerCommand({ id: 'test.registry', run: renderedRun })
  })

  afterEach(() => {
    setSourceViewHandle(null)
    resetFocusedPane()
    editorSessionManager.destroyAll()
    unregisterCommand('test.registry')
    unregisterMarkdownCommand('test.md')
    unregisterMarkdownCommand('test.sized')
    unregisterMarkdownPrompt('test.sized')
    // Registries are process-global: the template registered by one case must
    // not leak into the next.
    unregisterMarkdownCommand('quote')
  })

  it('runs the registry command when the rendered pane owns the text', () => {
    registerRenderedEditor()
    useViewStore().setMode('rendered')
    expect(runEditorCommand('test.registry')).toBe(true)
    expect(renderedRun).toHaveBeenCalledTimes(1)
  })

  it('applies the Markdown transform in source mode instead of the registry command', () => {
    registerRenderedEditor()
    const source = makeSourceView('hello')
    setSourceViewHandle({ getView: () => source.view, flush: () => undefined })
    useViewStore().setMode('source')

    // An empty caret takes the wrap marker pair at the caret.
    expect(runEditorCommand('bold')).toBe(true)
    expect(source.doc()).toBe('hello****')
    // The rendered model is stale in source mode; touching it loses the edit.
    expect(renderedRun).not.toHaveBeenCalled()
  })

  it('inserts a registered Markdown template for a node-inserting command', () => {
    registerRenderedEditor()
    const source = makeSourceView('')
    setSourceViewHandle({ getView: () => source.view, flush: () => undefined })
    useViewStore().setMode('source')
    registerMarkdownCommand('test.md', () => ({ text: '$$\n\n$$', caret: 3 }))

    expect(runEditorCommand('test.md')).toBe(true)
    expect(source.doc()).toBe('$$\n\n$$')
    // The caret was asked for inside the delimiters, ready for the body.
    expect(source.view.state.selection.main.head).toBe(3)
  })

  it('lets a command ASK before it writes, and inserts what the answer produced', () => {
    // The table's source form is not a fixed transform: how many rows and
    // columns is the reader's to choose. The prompt is what carries that answer
    // back into the source pane — without it the command had to guess, and it
    // guessed 3×3 for every reader.
    registerRenderedEditor()
    const source = makeSourceView('')
    setSourceViewHandle({ getView: () => source.view, flush: () => undefined })
    useViewStore().setMode('source')
    let asked = 0
    registerMarkdownPrompt('test.sized', {
      ask: (apply) => {
        asked += 1
        apply({ text: '| a | b |\n| - | - |\n| 1 | 2 |' })
      },
    })

    expect(runEditorCommand('test.sized')).toBe(true)
    expect(asked).toBe(1)
    expect(source.doc()).toBe('| a | b |\n| - | - |\n| 1 | 2 |')
    expect(renderedRun).not.toHaveBeenCalled()
  })

  it('inserts nothing when the prompt is answered with a cancel', () => {
    // A reader who closes the size dialog has not asked for a table. Resolving
    // to a default size instead is what the old fixed template did, and it is
    // the behaviour this contract exists to replace.
    registerRenderedEditor()
    const source = makeSourceView('before')
    setSourceViewHandle({ getView: () => source.view, flush: () => undefined })
    useViewStore().setMode('source')
    registerMarkdownPrompt('test.sized', { ask: () => undefined })

    expect(runEditorCommand('test.sized')).toBe(true)
    expect(source.doc()).toBe('before')
  })

  it('prefers the prompt over a registered Markdown template', () => {
    registerRenderedEditor()
    const source = makeSourceView('')
    setSourceViewHandle({ getView: () => source.view, flush: () => undefined })
    useViewStore().setMode('source')
    registerMarkdownCommand('test.sized', () => 'FALLBACK')
    registerMarkdownPrompt('test.sized', {
      ask: (apply) => apply({ text: 'ANSWERED' }),
    })

    expect(runEditorCommand('test.sized')).toBe(true)
    expect(source.doc()).toBe('ANSWERED')
  })

  it('prefers the Markdown template over the text transforms', () => {
    registerRenderedEditor()
    const source = makeSourceView('')
    setSourceViewHandle({ getView: () => source.view, flush: () => undefined })
    useViewStore().setMode('source')
    // `quote` has a text transform, but a registered template must win.
    registerMarkdownCommand('quote', () => 'TEMPLATE')

    expect(runEditorCommand('quote')).toBe(true)
    expect(source.doc()).toBe('TEMPLATE')
  })

  it('falls through to the registry for an unknown source-mode command', () => {
    registerRenderedEditor()
    const source = makeSourceView('')
    setSourceViewHandle({ getView: () => source.view, flush: () => undefined })
    useViewStore().setMode('source')

    expect(runEditorCommand('test.registry')).toBe(true)
    expect(renderedRun).toHaveBeenCalledTimes(1)
  })

  it('runs a toolbar-only id, which has no command registration', () => {
    registerRenderedEditor()
    useViewStore().setMode('rendered')
    const run = vi.fn()
    registerToolbar({ id: 'test.toolbarOnly', label: 'Only', run })
    try {
      expect(runEditorCommand('test.toolbarOnly')).toBe(true)
      expect(run).toHaveBeenCalledTimes(1)
    } finally {
      unregisterToolbar('test.toolbarOnly')
    }
  })

  it('reports false for an id nothing knows', () => {
    registerRenderedEditor()
    useViewStore().setMode('rendered')
    expect(runEditorCommand('nope.not.a.command')).toBe(false)
  })

  it('follows the pane the user last worked in during split mode', () => {
    registerRenderedEditor()
    const source = makeSourceView('split')
    setSourceViewHandle({ getView: () => source.view, flush: () => undefined })
    useViewStore().setMode('split')

    noteFocusedPane('source')
    runEditorCommand('quote')
    expect(source.doc()).toBe('> split')

    noteFocusedPane('rendered')
    runEditorCommand('test.registry')
    expect(renderedRun).toHaveBeenCalledTimes(1)
  })
})
