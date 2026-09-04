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
import { editorSessionManager } from '../sessionManager'
import { useTabsStore } from '../../../stores/tabs'
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
    // Tear down any session a prior case left behind (module singleton).
    editorSessionManager.destroyAll()
    vi.mocked(createEditor).mockClear()
    vi.mocked(configureImageResolver).mockClear()
    vi.mocked(configureHeadingAnchorUrl).mockClear()
    vi.mocked(configureWikilinkHandler).mockClear()
    vi.mocked(clearImageSelection).mockClear()
    vi.mocked(setCalloutView).mockClear()
    // The pane only mounts when a tab is open; give the controller an active
    // tab so its session is registered and promoted.
    useTabsStore().setActive('tab-1')
  })

  it('mount() creates the editor and registers a session for the active tab', () => {
    const host = document.createElement('div')
    const controller = createEditorController({ session, getEditorEl: () => host })
    controller.mount()
    expect(createEditor).toHaveBeenCalledWith(host, { plugins: basicPlugins })
    expect(session.editor).toBeTruthy()
    expect(editorSessionManager.getSession('tab-1')).toBe(session.editor)
    expect(editorSessionManager.getActiveEditor()).toBe(session.editor)
    expect(configureImageResolver).toHaveBeenCalled()
    expect(configureHeadingAnchorUrl).toHaveBeenCalled()
    expect(configureWikilinkHandler).toHaveBeenCalled()
  })

  it('destroy() tears down the view, session and decorators', () => {
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
    expect(editorSessionManager.getSession('tab-1')).toBeNull()
    expect(editorSessionManager.getActiveEditor()).toBeNull()
    expect(editor.destroy).toHaveBeenCalled()
  })
})
