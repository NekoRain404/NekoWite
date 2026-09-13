import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { guardEditorForPlugins } from './pluginEditorGuard'
import { useAiPermissionStore } from '../stores/aiPermission'

const notifyMock = vi.hoisted(() => vi.fn())
vi.mock('./errors', () => ({ notifyError: notifyMock }))

/** A stand-in for the real editor handle: only the write is interesting. */
function fakeEditor() {
  return {
    open: vi.fn(),
    save: vi.fn(),
    getView: vi.fn(),
    onContentChange: vi.fn(),
    insertMarkdownAtCursor: vi.fn(async () => undefined),
    setSuggestion: vi.fn(),
    acceptSuggestion: vi.fn(),
    rejectSuggestion: vi.fn(),
    hasSuggestion: vi.fn(),
    onSuggestionChange: vi.fn(),
    destroy: vi.fn(),
  }
}

beforeEach(() => {
  setActivePinia(createPinia())
  notifyMock.mockClear()
})

describe('plugin editor guard', () => {
  it('refuses a plugin write when the policy forbids document writes', async () => {
    // The host hands plugins a real NekoEditor. A plugin that declares NO
    // permissions could therefore rewrite the document, which made both the
    // write policy and the permission dialog false in the place that matters
    // most: a plugin nobody vetted for document access.
    const editor = fakeEditor()
    const guarded = guardEditorForPlugins(editor as never, { pluginName: 'demo' })
    useAiPermissionStore().setPolicy('readonly')

    await expect(guarded.insertMarkdownAtCursor('hello')).rejects.toThrow()
    expect(editor.insertMarkdownAtCursor).not.toHaveBeenCalled()
    // A blocked write is reported, not silent: the plugin must not look like a
    // button that did nothing.
    expect(notifyMock).toHaveBeenCalled()
  })

  it('asks the user under the default policy, and writes only after a yes', async () => {
    const editor = fakeEditor()
    const guarded = guardEditorForPlugins(editor as never, { pluginName: 'demo' })
    const permissions = useAiPermissionStore()
    permissions.setPolicy('ask')

    const pending = guarded.insertMarkdownAtCursor('hello')
    await Promise.resolve()
    // Nothing has been written while the question is on screen.
    expect(editor.insertMarkdownAtCursor).not.toHaveBeenCalled()
    expect(permissions.pending).not.toBeNull()

    permissions.respond(true)
    await pending
    expect(editor.insertMarkdownAtCursor).toHaveBeenCalledWith('hello')
  })

  it('does not write when the user declines', async () => {
    const editor = fakeEditor()
    const guarded = guardEditorForPlugins(editor as never, { pluginName: 'demo' })
    const permissions = useAiPermissionStore()
    permissions.setPolicy('ask')

    const pending = guarded.insertMarkdownAtCursor('hello')
    await Promise.resolve()
    permissions.respond(false)

    await expect(pending).rejects.toThrow()
    expect(editor.insertMarkdownAtCursor).not.toHaveBeenCalled()
  })

  it('leaves the read-only surface alone', async () => {
    // A formatting helper legitimately needs to READ the document; gating that
    // would break every plugin for no security gain.
    const editor = fakeEditor()
    const guarded = guardEditorForPlugins(editor as never, { pluginName: 'demo' })
    useAiPermissionStore().setPolicy('readonly')

    await guarded.save()
    guarded.getView()
    guarded.onContentChange(() => undefined)
    guarded.rejectSuggestion()
    guarded.hasSuggestion()
    guarded.onSuggestionChange(() => undefined)
    guarded.destroy()
    // Clearing a staged suggestion is not a write either: a plugin must always
    // be able to take its own proposal back.
    guarded.setSuggestion(null)

    expect(editor.save).toHaveBeenCalled()
    expect(editor.getView).toHaveBeenCalled()
    expect(editor.setSuggestion).toHaveBeenCalledWith(null)
    expect(editor.destroy).toHaveBeenCalled()
  })

  it('does not let a plugin replace the document without asking', async () => {
    // `open` swaps the whole buffer: it destroys more than a selection, so it
    // is its own kind of write and cannot ride on a selection grant.
    const editor = fakeEditor()
    const guarded = guardEditorForPlugins(editor as never, { pluginName: 'demo' })
    const permissions = useAiPermissionStore()
    permissions.setPolicy('ask')

    const pending = guarded.open('# rewritten')
    await Promise.resolve()
    expect(editor.open).not.toHaveBeenCalled()
    expect(permissions.pending?.request.kind).toBe('replace-document')

    permissions.respond(true)
    await pending
    expect(editor.open).toHaveBeenCalledWith('# rewritten')
  })

  it('refuses a whole-document replacement when the user says no', async () => {
    const editor = fakeEditor()
    const guarded = guardEditorForPlugins(editor as never, { pluginName: 'demo' })
    const permissions = useAiPermissionStore()
    permissions.setPolicy('ask')

    const pending = guarded.open('# rewritten')
    await Promise.resolve()
    permissions.respond(false)

    await expect(pending).rejects.toThrow()
    expect(editor.open).not.toHaveBeenCalled()
    expect(notifyMock).toHaveBeenCalled()
  })

  it('refuses the synchronous write surfaces while nothing is granted', async () => {
    // `acceptSuggestion` returns the inserted text, so it cannot await a
    // question. Writing anyway would be a write the policy never approved, so
    // it is refused and the plugin is pointed at the API that can ask.
    const editor = fakeEditor()
    const guarded = guardEditorForPlugins(editor as never, { pluginName: 'demo' })
    useAiPermissionStore().setPolicy('ask')

    expect(() => guarded.setSuggestion('ghost')).toThrow()
    expect(editor.setSuggestion).toHaveBeenCalledWith(null)
    expect(() => guarded.acceptSuggestion()).toThrow()
    expect(editor.acceptSuggestion).not.toHaveBeenCalled()
    expect(notifyMock).toHaveBeenCalled()
  })

  it('lets the synchronous write surfaces through once the kind is granted', async () => {
    const editor = fakeEditor()
    const guarded = guardEditorForPlugins(editor as never, { pluginName: 'demo' })
    const permissions = useAiPermissionStore()
    permissions.setPolicy('ask')
    // A grant for `insert` is a standing approval for this kind of write.
    // "Allow once" deliberately is NOT: it approves the write in front of the
    // user, not a kind of write, so the synchronous surfaces stay refused.
    const insert = guarded.insertMarkdownAtCursor('hello')
    await Promise.resolve()
    expect(permissions.pending).not.toBeNull()
    permissions.respond(true, false)
    await insert
    expect(() => guarded.setSuggestion('ghost')).toThrow()

    const second = guarded.insertMarkdownAtCursor('hello again')
    await Promise.resolve()
    permissions.respond(true, true)
    await second
    guarded.setSuggestion('ghost')
    guarded.acceptSuggestion()
    expect(editor.setSuggestion).toHaveBeenCalledWith('ghost')
    expect(editor.acceptSuggestion).toHaveBeenCalled()
  })

  it('refuses the synchronous write surfaces while AI is switched off', () => {
    const editor = fakeEditor()
    const guarded = guardEditorForPlugins(editor as never, { pluginName: 'demo' })
    const permissions = useAiPermissionStore()
    permissions.setPolicy('auto')
    permissions.setEnabled(false)

    expect(() => guarded.setSuggestion('ghost')).toThrow()
    expect(() => guarded.acceptSuggestion()).toThrow()
    expect(editor.acceptSuggestion).not.toHaveBeenCalled()
  })

  it('passes the write through under the permissive policy', async () => {
    const editor = fakeEditor()
    const guarded = guardEditorForPlugins(editor as never, { pluginName: 'demo' })
    useAiPermissionStore().setPolicy('auto')

    await guarded.insertMarkdownAtCursor('hello')
    expect(editor.insertMarkdownAtCursor).toHaveBeenCalledWith('hello')
  })
})
