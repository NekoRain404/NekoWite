import { describe, expect, it, vi } from 'vitest'
import { createEditorSessionManager, EDITOR_BRIDGE_LEGACY_TAB } from './sessionManager'
import type { NekoEditor } from '@nekowite/editor-core'

interface FakeEditor extends NekoEditor {
  getTag(): string
  destroyed: ReturnType<typeof vi.fn>
}

function fakeEditor(tag: string, withDestroy = true): FakeEditor {
  const destroyed = vi.fn()
  const editor = {
    open: vi.fn(),
    save: vi.fn(async () => tag),
    getView: vi.fn(() => ({ tag })),
    onContentChange: vi.fn(() => () => undefined),
    insertMarkdownAtCursor: vi.fn(async () => undefined),
    setSuggestion: vi.fn(),
    acceptSuggestion: vi.fn(),
    rejectSuggestion: vi.fn(),
    hasSuggestion: vi.fn(() => false),
    onSuggestionChange: vi.fn(() => () => undefined),
    getTag: () => tag,
    destroyed,
  } as unknown as FakeEditor
  if (withDestroy) editor.destroy = destroyed
  return editor
}

describe('editorSessionManager', () => {
  it('createSession/getSession isolates instances by tabId', () => {
    const sm = createEditorSessionManager()
    const tabA = fakeEditor('A')
    const tabB = fakeEditor('B')

    const createdA = sm.createSession('tab-a', () => tabA)
    expect(createdA).toBe(tabA)
    const createdB = sm.createSession('tab-b', () => tabB)
    expect(createdB).toBe(tabB)

    // Each tab resolves to its own editor, never the sibling's.
    expect(sm.getSession('tab-a')).toBe(tabA)
    expect(sm.getSession('tab-b')).toBe(tabB)
    expect(sm.getSession('tab-missing')).toBeNull()

    // Isolation in the other direction: mutating the map state for one tab does
    // not leak into the other.
    sm.destroySession('tab-a')
    expect(sm.getSession('tab-a')).toBeNull()
    expect(sm.getSession('tab-b')).toBe(tabB)
  })

  it('activating a tab makes its editor the active one', () => {
    const sm = createEditorSessionManager()
    const tabA = fakeEditor('A')
    const tabB = fakeEditor('B')

    sm.createSession('tab-a', () => tabA)
    expect(sm.getActiveEditor()).toBe(tabA)

    sm.createSession('tab-b', () => tabB)
    expect(sm.getActiveEditor()).toBe(tabB)

    // Explicit activation promotes a not-currently-active session.
    sm.createSession('tab-a', () => tabA)
    sm.activateSession('tab-b')
    expect(sm.getActiveEditor()).toBe(tabB)
    // The promoted session's view is resolvable.
    expect(sm.getView()).toEqual({ tag: 'B' })
  })

  it('destroying one session leaves the other intact and clears the active slot', () => {
    const sm = createEditorSessionManager()
    const tabA = fakeEditor('A')
    const tabB = fakeEditor('B')
    sm.createSession('tab-a', () => tabA)
    sm.createSession('tab-b', () => tabB)
    sm.activateSession('tab-a')

    sm.destroySession('tab-a')

    // The destroyed tab's editor is gone and its destroy was invoked.
    expect(sm.getSession('tab-a')).toBeNull()
    expect(tabA.destroyed).toHaveBeenCalledTimes(1)
    // The other session is untouched.
    expect(sm.getSession('tab-b')).toBe(tabB)
    expect(tabB.destroyed).not.toHaveBeenCalled()

    // Active slot was the destroyed tab -> cleared, so no active editor.
    expect(sm.getActiveEditor()).toBeNull()

    // Re-activate the surviving session and confirm its editor is active.
    sm.activateSession('tab-b')
    expect(sm.getActiveEditor()).toBe(tabB)
  })

  it('a side-panel that got a session by tabId uses the right editor', () => {
    const sm = createEditorSessionManager()
    const tabA = fakeEditor('A')
    const tabB = fakeEditor('B')
    sm.createSession('tab-a', () => tabA)
    sm.createSession('tab-b', () => tabB)

    // A panel bound to tab B resolves its own editor even while A is active.
    sm.activateSession('tab-a')
    const panelEditor = sm.getSession('tab-b')
    expect(panelEditor).toBe(tabB)
    expect(panelEditor?.getView()).toEqual({ tag: 'B' })
  })

  it('notifies subscribers when the active editor changes and unsubscribes cleanly', () => {
    const sm = createEditorSessionManager()
    const cb = vi.fn()
    const off = sm.subscribe(cb)

    const tabA = fakeEditor('A')
    const tabB = fakeEditor('B')
    sm.createSession('tab-a', () => tabA)
    expect(cb).toHaveBeenLastCalledWith(tabA)

    sm.createSession('tab-b', () => tabB)
    expect(cb).toHaveBeenLastCalledWith(tabB)

    sm.destroySession('tab-b')
    expect(cb).toHaveBeenLastCalledWith(null)

    // Unsubscribe stops future notifications.
    off()
    sm.createSession('tab-a', () => tabA)
    const count = cb.mock.calls.length
    sm.activateSession('tab-a')
    expect(cb.mock.calls.length).toBe(count)
  })

  it('destroyAll tears down every editor and clears the active slot', () => {
    const sm = createEditorSessionManager()
    const tabA = fakeEditor('A')
    const tabB = fakeEditor('B')
    sm.createSession('tab-a', () => tabA)
    sm.createSession('tab-b', () => tabB)

    sm.destroyAll()

    expect(sm.getSession('tab-a')).toBeNull()
    expect(sm.getSession('tab-b')).toBeNull()
    expect(sm.getActiveEditor()).toBeNull()
    expect(tabA.destroyed).toHaveBeenCalled()
    expect(tabB.destroyed).toHaveBeenCalled()
  })

  it('survives an editor whose destroy is missing (test stubs / compat path)', () => {
    const sm = createEditorSessionManager()
    const noDestroy = fakeEditor('X', false)
    sm.createSession(EDITOR_BRIDGE_LEGACY_TAB, () => noDestroy)
    expect(() => sm.destroyAll()).not.toThrow()
  })
})
