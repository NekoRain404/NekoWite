/**
 * Live CodeMirror source view registry.
 *
 * The source pane is created on demand (async chunk) and torn down when the
 * view switches away from it, so any feature that must reach "the Markdown the
 * user is editing right now" cannot hold a reference of its own. The pane
 * publishes its view here on mount and withdraws it on unmount; consumers ask
 * for the current one at call time.
 *
 * Kept in `services` (not the pane) because the callers are services and
 * composables: `platform` must not import back into features, and a component
 * ref would only be reachable from the component tree.
 */

import type { EditorView } from '@codemirror/view'

export interface SourceViewHandle {
  /** The live CodeMirror view, or null when it is not ready / destroyed. */
  getView(): EditorView | null
  /**
   * Publish any edit still inside the host's debounce window to the tab, now.
   *
   * The source pane coalesces keystrokes before writing `tab.content`, so for
   * ~50ms the tab does not yet reflect what the user typed. Anything that reads
   * or writes the tab in that window — most importantly the rendered pane's
   * debounced serialization — must flush first, or it works from text that is
   * already stale.
   */
  flush(): void
}

let handle: SourceViewHandle | null = null

/** Publish the live source pane. Called by the pane on mount. */
export function setSourceViewHandle(next: SourceViewHandle | null): void {
  handle = next
}

/**
 * Withdraw the handle, but only when it is still the caller's — a remount can
 * publish the new pane before the old one's teardown runs, and a blind clear
 * would then leave the pane unregistered.
 */
export function releaseSourceViewHandle(owner: SourceViewHandle): void {
  if (handle === owner) handle = null
}

/** The live source pane handle, or null while it is not mounted. */
export function getSourceViewHandle(): SourceViewHandle | null {
  return handle
}

/** The live source view, or null while the source pane is not mounted. */
export function getSourceView(): EditorView | null {
  if (!handle) return null
  try {
    return handle.getView()
  } catch {
    // A destroyed view throws on access; treat it as "not available" so the
    // caller can fall back instead of failing the whole insert.
    return null
  }
}

/**
 * True when keyboard focus is inside the CodeMirror content.
 *
 * `EditorView.hasFocus` additionally requires `document.hasFocus()`, which is
 * false whenever the window is not the OS-focused one — a second window, or an
 * automated browser driving the page. Split mode routes inserts by this answer,
 * so it falls back to the DOM truth (the editor root owns the active element)
 * rather than silently sending the text to the other pane.
 */
export function sourceViewHasFocus(): boolean {
  const view = getSourceView()
  if (!view) return false
  try {
    if (view.hasFocus) return true
    const root = view.root as Document | ShadowRoot
    const active = root.activeElement ?? null
    return active !== null && view.dom.contains(active)
  } catch {
    return false
  }
}
