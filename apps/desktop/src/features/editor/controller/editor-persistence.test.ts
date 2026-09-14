import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useTabsStore } from '../../../stores/tabs'
import { useSettingsStore } from '../../../stores/settings'
import { createDocumentSession, type DocumentSession } from '../model/document-session'
import { createEditorPersistence } from './editor-persistence'
import { clearRefusedDocument, markRefusedDocument } from '../../../services/editor-ownership'
import { NoDocumentLoadedError, type NekoEditor } from '@nekowite/editor-core'

vi.mock('../../../platform/gateways/fs', () => ({
  fsService: {
    read: vi.fn().mockResolvedValue('# Title\n\nbody'),
    write: vi.fn().mockResolvedValue(undefined),
    saveFileDialog: vi.fn().mockResolvedValue(null),
  },
}))

function makeFakeEditor(saveResult: string) {
  const callbacks: Array<() => void> = []
  const editor = {
    save: vi.fn().mockResolvedValue(saveResult),
    onContentChange: vi.fn((cb: () => void) => {
      callbacks.push(cb)
      return () => {
        const i = callbacks.indexOf(cb)
        if (i >= 0) callbacks.splice(i, 1)
      }
    }),
    getView: vi.fn(() => null),
  }
  return { editor, callbacks }
}

describe('editorPersistence', () => {
  let session: DocumentSession
  let tabs: ReturnType<typeof useTabsStore>
  let settings: ReturnType<typeof useSettingsStore>

  beforeEach(async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    tabs = useTabsStore()
    settings = useSettingsStore()
    settings.autosaveInterval = 5000
    tabs.setVault('/vault')
    await tabs.openTab('notes/a.md')
    session = createDocumentSession()
  })

  afterEach(() => {
    vi.useRealTimers()
    // The refusal is module state (the write path has no way to reach this
    // session); a case that arms it must not leave it armed for the next one.
    clearRefusedDocument()
  })

  it('marks the tab dirty and schedules autosave on a model change', () => {
    const { editor, callbacks } = makeFakeEditor('# Edited\n')
    session.editor = editor as unknown as NekoEditor
    const persistence = createEditorPersistence({ session })
    const unsub = persistence.attachChangeListener()
    callbacks[0]()
    expect(tabs.activeTab?.dirty).toBe(true)
    unsub()
  })

  it('debounces serialization and adopts the saved markdown into the tab', async () => {
    vi.useFakeTimers()
    const { editor, callbacks } = makeFakeEditor('# Canonical\n')
    session.editor = editor as unknown as NekoEditor
    const persistence = createEditorPersistence({ session })
    const unsub = persistence.attachChangeListener()
    // A burst of keystrokes coalesces into one serialization.
    callbacks[0]()
    callbacks[0]()
    callbacks[0]()
    await vi.advanceTimersByTimeAsync(120)
    expect(editor.save).toHaveBeenCalledTimes(1)
    expect(tabs.activeTab?.content).toBe('# Canonical\n')
    expect(session.lastLocalMarkdown).toBe('# Canonical\n')
    unsub()
  })

  // C1: the model holds the PREVIOUS document when open() throws — nothing at
  // all in a fresh session — so its serialization is not this file's text.
  // Publishing it put that text into the tab, and the next save wrote the tab.
  it('publishes nothing while the model refused this document', async () => {
    vi.useFakeTimers()
    const { editor } = makeFakeEditor('')
    session.editor = editor as unknown as NekoEditor
    markRefusedDocument('# Raw source of the file that failed\n')
    tabs.activeTab!.content = '# Raw source of the file that failed\n'
    const persistence = createEditorPersistence({ session })

    persistence.scheduleSerialize()
    await vi.advanceTimersByTimeAsync(200)

    // Not even serialized: the whole-document round trip has no purpose while
    // the answer would be thrown away.
    expect(editor.save).not.toHaveBeenCalled()
    expect(tabs.activeTab?.content).toBe('# Raw source of the file that failed\n')
  })

  it('publishes again once the model holds a document', async () => {
    vi.useFakeTimers()
    const { editor } = makeFakeEditor('# Canonical\n')
    session.editor = editor as unknown as NekoEditor
    markRefusedDocument('# Raw source of the file that failed\n')
    tabs.activeTab!.content = '# Raw source of the file that failed\n'
    const persistence = createEditorPersistence({ session })

    // The user switched back to a rendered view and the re-parse succeeded.
    clearRefusedDocument()
    persistence.scheduleSerialize()
    await vi.advanceTimersByTimeAsync(200)

    expect(tabs.activeTab?.content).toBe('# Canonical\n')
  })

  // `save()` refuses with `NoDocumentLoadedError` when the editor is holding no
  // document of the open tab, instead of resolving to `""` (which the app wrote
  // over a real note). The refusal is the same fact as the C1 guard above, so it
  // takes the same exit: publish nothing. It must be caught here — the debounced
  // path runs from a timer, so an escaping rejection is unhandled by
  // construction, and the flush's several awaiters get it instead of a document.
  it('publishes nothing when the editor refuses to serialize a document it does not hold', async () => {
    vi.useFakeTimers()
    const { editor } = makeFakeEditor('')
    editor.save = vi.fn().mockRejectedValue(new NoDocumentLoadedError())
    session.editor = editor as unknown as NekoEditor
    tabs.activeTab!.content = '# The text the tab is holding\n'
    const persistence = createEditorPersistence({ session })

    persistence.scheduleSerialize()
    await vi.advanceTimersByTimeAsync(200)

    // The call was made — the refusal is the answer, not a skipped read — and
    // the tab is exactly as it was: `""` here is the blank note this replaced.
    expect(editor.save).toHaveBeenCalledTimes(1)
    expect(tabs.activeTab?.content).toBe('# The text the tab is holding\n')
    expect(session.lastLocalMarkdown).toBeNull()
  })

  it('does not swallow a serialization failure that is not a refusal', async () => {
    const { editor } = makeFakeEditor('')
    editor.save = vi.fn().mockRejectedValue(new Error('serializer exploded'))
    session.editor = editor as unknown as NekoEditor
    const persistence = createEditorPersistence({ session })

    // Narrow by construction: only the named refusal is an answer to "there is
    // nothing to publish", and a real failure still has to reach its caller.
    await expect(persistence.flush()).rejects.toThrow('serializer exploded')
  })

  it('cancel() drops a pending serialization before it fires', async () => {
    vi.useFakeTimers()
    const { editor } = makeFakeEditor('# Canonical\n')
    session.editor = editor as unknown as NekoEditor
    const persistence = createEditorPersistence({ session })
    persistence.scheduleSerialize()
    persistence.cancel()
    await vi.advanceTimersByTimeAsync(200)
    expect(editor.save).not.toHaveBeenCalled()
  })

  it('does not rewrite the tab when the model is unchanged (source-mode echo)', async () => {
    vi.useFakeTimers()
    const { editor } = makeFakeEditor('# Canonical\n')
    session.editor = editor as unknown as NekoEditor
    // The editor model already holds the text the tab stores (a re-open or an
    // external apply). Serializing it again must NOT push anything into the
    // tab: in source mode that write replaces the raw Markdown the user is
    // typing in and resets the CodeMirror caret to the document start.
    session.lastLocalMarkdown = '# Canonical\n'
    tabs.activeTab!.content = '# Raw source\n'
    const persistence = createEditorPersistence({ session })
    tabs.markDirty(tabs.activeTab!.id)
    persistence.scheduleSerialize()
    await vi.advanceTimersByTimeAsync(200)

    expect(editor.save).toHaveBeenCalledTimes(1)
    expect(tabs.activeTab?.content).toBe('# Raw source\n')
  })
})
