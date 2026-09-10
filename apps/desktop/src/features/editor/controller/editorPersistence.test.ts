import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useTabsStore } from '../../../stores/tabs'
import { useSettingsStore } from '../../../stores/settings'
import { createDocumentSession, type DocumentSession } from '../model/documentSession'
import { createEditorPersistence } from './editorPersistence'
import type { NekoEditor } from '@nekowite/editor-core'

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
