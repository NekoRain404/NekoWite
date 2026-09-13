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

    await guarded.open('# doc')
    await guarded.save()
    guarded.getView()
    guarded.onContentChange(() => undefined)
    guarded.setSuggestion('x')
    guarded.acceptSuggestion()
    guarded.rejectSuggestion()
    guarded.hasSuggestion()
    guarded.onSuggestionChange(() => undefined)
    guarded.destroy()

    expect(editor.open).toHaveBeenCalledWith('# doc')
    expect(editor.save).toHaveBeenCalled()
    expect(editor.getView).toHaveBeenCalled()
    expect(editor.setSuggestion).toHaveBeenCalledWith('x')
    expect(editor.destroy).toHaveBeenCalled()
  })

  it('passes the write through under the permissive policy', async () => {
    const editor = fakeEditor()
    const guarded = guardEditorForPlugins(editor as never, { pluginName: 'demo' })
    useAiPermissionStore().setPolicy('auto')

    await guarded.insertMarkdownAtCursor('hello')
    expect(editor.insertMarkdownAtCursor).toHaveBeenCalledWith('hello')
  })
})
