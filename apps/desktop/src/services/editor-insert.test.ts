import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { EditorSelection, EditorState } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'
import { insertMarkdownAtCursor, sourcePaneOwnsInput } from './editor-insert'
import { releaseSourceViewHandle, setSourceViewHandle } from './source-view'
import { editorSessionManager } from '../features/editor'
import { useViewStore } from '../stores/view'

/**
 * A CodeMirror stand-in with a genuine `EditorState`, so the source-mode route
 * exercises real change/selection semantics without a DOM.
 */
function makeSourceView(doc: string, options: { focused?: boolean } = {}) {
  let state = EditorState.create({ doc, selection: EditorSelection.single(doc.length) })
  const view = {
    hasFocus: options.focused ?? false,
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

const insertSpy = vi.fn(async () => undefined)

function registerEditor(): void {
  editorSessionManager.createSession('t1', () => ({
    insertMarkdownAtCursor: insertSpy,
    getView: () => ({}) as never,
    destroy: () => undefined,
  }) as never)
}

describe('insertMarkdownAtCursor', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    setSourceViewHandle(null)
    insertSpy.mockClear()
    editorSessionManager.destroyAll()
  })

  afterEach(() => {
    setSourceViewHandle(null)
    editorSessionManager.destroyAll()
  })

  it('routes to the rendered editor in rendered mode', async () => {
    registerEditor()
    const source = makeSourceView('keep raw')
    setSourceViewHandle({ getView: () => source.view, flush: () => undefined })

    expect(await insertMarkdownAtCursor('![a](b.png)')).toBe(true)
    expect(insertSpy).toHaveBeenCalledWith('![a](b.png)')
    // The source pane is a mirror in rendered mode; it must be left alone.
    expect(source.doc()).toBe('keep raw')
  })

  it('routes to the CodeMirror text in source mode', async () => {
    registerEditor()
    const source = makeSourceView('alpha\n')
    setSourceViewHandle({ getView: () => source.view, flush: () => undefined })
    useViewStore().setMode('source')

    expect(await insertMarkdownAtCursor('![a](b.png)')).toBe(true)
    expect(source.doc()).toBe('alpha\n![a](b.png)')
    // The rendered model is stale in source mode; touching it would replace the
    // raw Markdown with the serializer's canonical form.
    expect(insertSpy).not.toHaveBeenCalled()
  })

  it('reports failure in source mode when no source view is mounted', async () => {
    registerEditor()
    useViewStore().setMode('source')

    expect(await insertMarkdownAtCursor('x')).toBe(false)
    expect(insertSpy).not.toHaveBeenCalled()
  })

  it('follows keyboard focus in split mode', async () => {
    registerEditor()
    const focused = makeSourceView('text', { focused: true })
    setSourceViewHandle({ getView: () => focused.view, flush: () => undefined })
    useViewStore().setMode('split')
    expect(sourcePaneOwnsInput()).toBe(true)
    await insertMarkdownAtCursor('S')
    expect(focused.doc()).toBe('textS')
    expect(insertSpy).not.toHaveBeenCalled()

    insertSpy.mockClear()
    const unfocused = makeSourceView('text', { focused: false })
    setSourceViewHandle({ getView: () => unfocused.view, flush: () => undefined })
    expect(sourcePaneOwnsInput()).toBe(false)
    await insertMarkdownAtCursor('R')
    expect(insertSpy).toHaveBeenCalledWith('R')
    expect(unfocused.doc()).toBe('text')
  })

  it('reports failure when nothing can accept the insert', async () => {
    expect(await insertMarkdownAtCursor('x')).toBe(false)
  })

  it('picks up the current source view at call time', async () => {
    registerEditor()
    const first = makeSourceView('one')
    setSourceViewHandle({ getView: () => first.view, flush: () => undefined })
    useViewStore().setMode('source')
    await insertMarkdownAtCursor('-')
    expect(first.doc()).toBe('one-')

    // A remount replaces the provider; the next insert must target the new one.
    const second = makeSourceView('two')
    setSourceViewHandle({ getView: () => second.view, flush: () => undefined })
    await insertMarkdownAtCursor('+')
    expect(second.doc()).toBe('two+')
    expect(first.doc()).toBe('one-')
  })

  it('survives a destroyed view and reports failure instead of throwing', async () => {
    registerEditor()
    useViewStore().setMode('source')
    setSourceViewHandle({
      getView: () => {
        throw new Error('view destroyed')
      },
      flush: () => undefined,
    })
    await expect(insertMarkdownAtCursor('x')).resolves.toBe(false)
  })

  it('leaves the registry alone when a non-owner releases it', async () => {
    registerEditor()
    const live = makeSourceView('live')
    const handle = { getView: () => live.view, flush: () => undefined }
    setSourceViewHandle(handle)
    useViewStore().setMode('source')
    releaseSourceViewHandle({ getView: () => null, flush: () => undefined })
    expect(await insertMarkdownAtCursor('!')).toBe(true)
    expect(live.doc()).toBe('live!')
  })
})
