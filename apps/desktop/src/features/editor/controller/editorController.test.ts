import { describe, expect, it, beforeEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import type { NekoEditor } from '@nekowite/editor-core'
import {
  basicPlugins,
  clearImageSelection,
  configureHeadingAnchorUrl,
  configureImageResolver,
  configureWikilinkHandler,
  createEditor,
} from '@nekowite/editor-core'
import { setCalloutView } from '../../../plugins/callout'
import { editorBridge } from '../../../services/editorBridge'
import { createDocumentSession, type DocumentSession } from '../model/documentSession'
import { createEditorController } from './editorController'

vi.mock('@nekowite/editor-core', () => {
  const makeEditor = () => ({
    getView: () => null,
    save: vi.fn().mockResolvedValue('# x'),
    onContentChange: vi.fn(() => () => {}),
    destroy: vi.fn(),
    open: vi.fn(),
    insertMarkdownAtCursor: vi.fn(),
  })
  return {
    createEditor: vi.fn(() => makeEditor()),
    basicPlugins: [],
    configureImageResolver: vi.fn(),
    configureHeadingAnchorUrl: vi.fn(),
    configureWikilinkHandler: vi.fn(),
    clearImageSelection: vi.fn(),
  }
})

vi.mock('../../../services/attachments', () => ({
  createImageSrcResolver: vi.fn(() => vi.fn()),
}))
vi.mock('../../../plugins/callout', () => ({ setCalloutView: vi.fn() }))

describe('editorController', () => {
  let session: DocumentSession

  beforeEach(() => {
    const pinia = createPinia()
    setActivePinia(pinia)
    session = createDocumentSession()
    vi.mocked(createEditor).mockClear()
    vi.mocked(configureImageResolver).mockClear()
    vi.mocked(configureHeadingAnchorUrl).mockClear()
    vi.mocked(configureWikilinkHandler).mockClear()
    vi.mocked(clearImageSelection).mockClear()
    vi.mocked(setCalloutView).mockClear()
  })

  it('mount() creates the editor and registers it with the bridge', () => {
    const host = document.createElement('div')
    const controller = createEditorController({ session, getEditorEl: () => host })
    controller.mount()
    expect(createEditor).toHaveBeenCalledWith(host, { plugins: basicPlugins })
    expect(session.editor).toBeTruthy()
    expect(editorBridge.getEditor()).toBe(session.editor)
    expect(configureImageResolver).toHaveBeenCalled()
    expect(configureHeadingAnchorUrl).toHaveBeenCalled()
    expect(configureWikilinkHandler).toHaveBeenCalled()
  })

  it('destroy() tears down the view, bridge and decorators', () => {
    const host = document.createElement('div')
    const controller = createEditorController({ session, getEditorEl: () => host })
    controller.mount()
    const editor = session.editor as NekoEditor
    controller.destroy()
    expect(setCalloutView).toHaveBeenCalledWith(null)
    expect(clearImageSelection).toHaveBeenCalled()
    expect(configureImageResolver).toHaveBeenLastCalledWith(null)
    expect(configureHeadingAnchorUrl).toHaveBeenLastCalledWith(null)
    expect(configureWikilinkHandler).toHaveBeenLastCalledWith(null)
    expect(session.editor).toBeNull()
    expect(editorBridge.getEditor()).toBeNull()
    expect(editor.destroy).toHaveBeenCalled()
  })
})
