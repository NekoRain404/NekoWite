import type { NekoEditor } from '@nekowite/editor-core'

type EditorView = NonNullable<ReturnType<NekoEditor['getView']>>

/**
 * Editor session manager.
 *
 * Holds the live per-tab editor sessions and tracks which tab is active, so a
 * feature/service that needs the "current" editor can resolve it without
 * holding a module-level singleton `let editor`. The **active** editor is the
 * session for the active tab; a side panel that knows a tab id can also
 * resolve that tab's editor directly with {@link getSession}.
 *
 * Lifecycle contract (drive from the editor controller on mount/unmount):
 *   - `createSession(tabId, createEditor)` builds an editor for a tab and
 *     makes it the active session as a side effect.
 *   - `activateSession(tabId)` promotes an existing session to active without
 *     destroying the others (tab activation / focus).
 *   - `destroySession(tabId)` tears down one tab's editor and never disturbs
 *     another tab's registration.
 *   - `destroyAll()` is the teardown hook (app dispose, last tab closed).
 *
 * `subscribe` notifies listeners whenever the ACTIVE editor changes (created,
 * activated or destroyed). It fires with the resulting editor (or `null` once
 * nothing is active) so a panel can re-bind a per-editor listener.
 */

export interface EditorSessionManager {
  /** Build an editor for `tabId` and make it the active session. If a session
   * already exists for the tab it is replaced (its editor is destroyed first).
   * Returns the editor so the caller can wire it further. */
  createSession(tabId: string, createEditor: () => NekoEditor): NekoEditor
  /** The editor for a specific tab id (their own tab for a hold-a-tab panel). */
  getSession(tabId: string): NekoEditor | null
  /** The active tab's editor. Falls back to the sole live session when the
   * active tab has no dedicated session yet (the pane reuses one editor that is
   * re-keyed on tab activation in the current single-pane architecture). */
  getActiveEditor(): NekoEditor | null
  /** The active editor's ProseMirror view, or null when not ready. */
  getView(): EditorView | null
  /** Mark `tabId`'s session as active. Does not touch other sessions. A no-op
   * when `tabId` has no session. */
  activateSession(tabId: string): void
  /** Tear down a tab's editor. If the destroyed tab was active, the active slot
   * is cleared and subscribers are notified with `null`. Guarded so an editor
   * that lacks a `destroy` (test stubs, compat path) never throws. */
  destroySession(tabId: string): void
  /** Tear down every session and clear the active slot. */
  destroyAll(): void
  /** Subscribe to active-editor changes. Fires with the new editor (or `null`
   * when nothing is active). Returns an unsubscribe. */
  subscribe(listener: (editor: NekoEditor | null) => void): () => void
}

/** Reserved tab id used by the `editorBridge` compat path so a real editor
 * registered by the old `setEditor` surface is still resolvable as active. */
export const EDITOR_BRIDGE_LEGACY_TAB = '__editor-bridge-legacy__'

export function createEditorSessionManager(): EditorSessionManager {
  const sessions = new Map<string, NekoEditor>()
  const listeners = new Set<(editor: NekoEditor | null) => void>()
  let activeTabId: string | null = null

  function currentEditor(): NekoEditor | null {
    if (activeTabId === null) return null
    if (sessions.has(activeTabId)) return sessions.get(activeTabId) ?? null
    // Single-pane reuse: the editor is created once and re-keyed across tabs. If
    // the active tab has no dedicated session but only one session exists, that
    // live editor is the editor shown in the active pane.
    if (sessions.size === 1) return [...sessions.values()][0]
    return null
  }

  function notify(): void {
    const editor = currentEditor()
    for (const cb of [...listeners]) cb(editor)
  }

  function destroyEditor(editor: NekoEditor | null): void {
    if (!editor) return
    try {
      editor.destroy()
    } catch {
      // An editor whose destroy throws (or is absent on a stub) must not abort
      // teardown of the other sessions.
    }
  }

  return {
    createSession(tabId, createEditor) {
      const editor = createEditor()
      // Replacing a live session: tear the old editor down only when it is a
      // DIFFERENT instance. The single reused editor is re-registered under a
      // new tab without being destroyed (the factory returns the same object).
      const existing = sessions.get(tabId)
      if (existing && existing !== editor) destroyEditor(existing)
      sessions.set(tabId, editor)
      activeTabId = tabId
      notify()
      return editor
    },

    getSession(tabId) {
      return sessions.get(tabId) ?? null
    },

    getActiveEditor() {
      return currentEditor()
    },

    getView() {
      const editor = currentEditor()
      if (!editor) return null
      try {
        return editor.getView()
      } catch {
        return null
      }
    },

    activateSession(tabId) {
      if (!sessions.has(tabId) || activeTabId === tabId) return
      activeTabId = tabId
      notify()
    },

    destroySession(tabId) {
      if (!sessions.has(tabId)) return
      const editor = sessions.get(tabId) ?? null
      sessions.delete(tabId)
      if (activeTabId === tabId) {
        activeTabId = null
        notify()
      }
      destroyEditor(editor)
    },

    destroyAll() {
      for (const editor of sessions.values()) destroyEditor(editor)
      sessions.clear()
      activeTabId = null
      notify()
    },

    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}

/** The process-wide manager. Every feature/service resolves the SAME instance
 * so an editor registered by the controller is seen by every panel. */
export const editorSessionManager = createEditorSessionManager()
