import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { EditorSelection, EditorState } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'
import {
  getMarkdownCommand,
  registerMarkdownCommand,
  unregisterMarkdownCommand,
} from '@nekowite/editor-core'
import { getTextSelection, replaceTextSelection } from './editorTextSelection'
import { setSourceViewHandle } from './sourceView'
import { noteFocusedPane, resetFocusedPane } from './editorOwnership'
import { editorSessionManager } from '../features/editor/sessionManager'
import { useViewStore } from '../stores/view'

/** A real `EditorState` behind a minimal view, so dispatch semantics are real. */
function makeSourceView(doc: string, anchor: number, head = anchor) {
  let state = EditorState.create({ doc, selection: EditorSelection.single(anchor, head) })
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

const insertSpy = vi.fn()
const dispatchSpy = vi.fn()

function registerRenderedEditor(): void {
  editorSessionManager.createSession('t1', () => ({
    getView: () => ({
      state: {
        selection: { from: 2, to: 7, empty: false },
        doc: { textBetween: () => 'rendered' },
        tr: { insertText: insertSpy },
      },
      dispatch: dispatchSpy,
      focus: () => undefined,
    }),
    destroy: () => undefined,
  }) as never)
}

describe('editorTextSelection', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    setSourceViewHandle(null)
    resetFocusedPane()
    insertSpy.mockClear()
    dispatchSpy.mockClear()
    editorSessionManager.destroyAll()
  })

  afterEach(() => {
    setSourceViewHandle(null)
    resetFocusedPane()
    editorSessionManager.destroyAll()
  })

  it('reads the CodeMirror selection in source mode', () => {
    setSourceViewHandle({ getView: () => makeSourceView('alpha beta', 0, 5).view, flush: () => undefined })
    useViewStore().setMode('source')
    expect(getTextSelection()).toEqual({ from: 0, to: 5, text: 'alpha' })
  })

  it('reads the rendered selection when the rendered pane owns the text', () => {
    registerRenderedEditor()
    useViewStore().setMode('rendered')
    expect(getTextSelection()).toEqual({ from: 2, to: 7, text: 'rendered' })
  })

  it('returns null for an empty source selection rather than the whole line', () => {
    const source = makeSourceView('alpha', 2)
    setSourceViewHandle({ getView: () => source.view, flush: () => undefined })
    useViewStore().setMode('source')
    expect(getTextSelection()).toBeNull()
  })

  it('replaces the CodeMirror selection in source mode', () => {
    const source = makeSourceView('alpha beta', 0, 5)
    setSourceViewHandle({ getView: () => source.view, flush: () => undefined })
    useViewStore().setMode('source')

    expect(replaceTextSelection('ALPHA')).toBe(true)
    expect(source.doc()).toBe('ALPHA beta')
    // The rendered model must not be touched: it is stale in source mode.
    expect(insertSpy).not.toHaveBeenCalled()
  })

  it('replaces the rendered selection when the rendered pane owns the text', () => {
    registerRenderedEditor()
    useViewStore().setMode('rendered')
    expect(replaceTextSelection('X')).toBe(true)
    expect(insertSpy).toHaveBeenCalledWith('X', 2, 7)
    expect(dispatchSpy).toHaveBeenCalled()
  })

  it('reports failure when the owning pane is not available', () => {
    useViewStore().setMode('source')
    expect(replaceTextSelection('X')).toBe(false)
    useViewStore().setMode('rendered')
    expect(replaceTextSelection('X')).toBe(false)
  })

  it('survives a destroyed source view', () => {
    useViewStore().setMode('source')
    setSourceViewHandle({
      getView: () => {
        throw new Error('destroyed')
      },
      flush: () => undefined,
    })
    expect(getTextSelection()).toBeNull()
    expect(replaceTextSelection('X')).toBe(false)
  })

  it('follows the pane the user last worked in during split mode', () => {
    registerRenderedEditor()
    const source = makeSourceView('split text', 0, 5)
    setSourceViewHandle({ getView: () => source.view, flush: () => undefined })
    useViewStore().setMode('split')

    noteFocusedPane('source')
    expect(getTextSelection()).toEqual({ from: 0, to: 5, text: 'split' })

    // Working in the preview hands the document back to it. The remembered
    // pane is what decides: a command invoked from the palette has already
    // moved DOM focus away from both editors.
    noteFocusedPane('rendered')
    expect(getTextSelection()).toEqual({ from: 2, to: 7, text: 'rendered' })
  })
})

describe('markdown command registry', () => {
  afterEach(() => {
    unregisterMarkdownCommand('test.md')
  })

  it('stores and returns a producer', () => {
    registerMarkdownCommand('test.md', () => 'plain')
    expect(getMarkdownCommand('test.md')?.()).toBe('plain')
  })
})
